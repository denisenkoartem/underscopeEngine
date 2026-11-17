"""LoRA fine-tune of the reader: an open-weights instruct model that does the engine's extraction call
(seller notes -> ConditionRecord JSON). See reader/model/README.md and CLAUDE.md ("reader fine-tune").

Input: the chat-format files from `pnpm --filter @underscope/reader reader:export` (train.jsonl, dev.jsonl,
manifest.json). Each line is {"messages": [system, user, assistant]}: system/user are exactly what
src/parse.ts buildExtractionRequest sends, assistant is the target JSON.

    .venv/bin/python reader/model/train.py --data reader/data/reader/sft --out reader/model/out/run1

A plain PyTorch loop over PEFT (no TRL): the loss is on the answer tokens only, and logits are computed
only for those tokens (`logits_to_keep`). Computing them for the whole ~2k-token prompt over a 151k-token
vocabulary would need ~3 GB more GPU memory, which an 8 GB laptop GPU does not have.
Tested on an RTX 5060 Laptop GPU (8 GB) with Qwen3-1.7B in bf16.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import time
from pathlib import Path

DEFAULT_BASE = "Qwen/Qwen3-1.7B"  # Apache-2.0. Qwen/Qwen3-4B-Instruct-2507 on a 24 GB+ GPU (see README).


def chat_prompt(tok, messages: list[dict]) -> str:
    """The prompt text the reader sees: system + user, then the assistant turn opened (no thinking)."""
    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)


def load_examples(tok, path: Path, max_len: int, limit: int | None) -> list[tuple[list[int], list[int]]]:
    """(prompt ids, answer ids) per line; the answer ends with the end-of-turn token."""
    out, skipped = [], 0
    end = tok.convert_tokens_to_ids("<|im_end|>")
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        msgs = json.loads(line)["messages"]
        prompt = tok(chat_prompt(tok, msgs[:2]), add_special_tokens=False)["input_ids"]
        answer = tok(msgs[2]["content"], add_special_tokens=False)["input_ids"] + [end]
        if len(prompt) + len(answer) > max_len:
            skipped += 1
            continue
        out.append((prompt, answer))
        if limit and len(out) >= limit:
            break
    if skipped:
        print(f"{path.name}: skipped {skipped} example(s) longer than {max_len} tokens")
    return out


def answer_loss(model, prompt: list[int], answer: list[int], device):
    import torch
    import torch.nn.functional as F

    ids = torch.tensor([prompt + answer], device=device)
    # Logits for the last len(answer)+1 positions; position j predicts token j+1, so drop the last one.
    logits = model(input_ids=ids, logits_to_keep=len(answer) + 1).logits[:, :-1]
    target = torch.tensor(answer, device=device)
    return F.cross_entropy(logits.float().reshape(-1, logits.shape[-1]), target)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, type=Path, help="folder with train.jsonl, dev.jsonl, manifest.json")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--accum", type=int, default=8, help="examples per optimizer step")
    ap.add_argument("--max-length", type=int, default=4096)
    ap.add_argument("--eval-every", type=int, default=50, help="optimizer steps between dev-loss checks")
    ap.add_argument("--dev-limit", type=int, default=64, help="dev examples per check")
    ap.add_argument("--limit", type=int, default=None, help="use only the first N train examples (smoke test)")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    manifest = json.loads((args.data / "manifest.json").read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    shutil.copy(args.data / "manifest.json", args.out / "data_manifest.json")
    print(f"data: {manifest['lines']} lines, prompt sha256 {manifest['prompt_sha256'][:12]}...")

    tok = AutoTokenizer.from_pretrained(args.base)
    train = load_examples(tok, args.data / "train.jsonl", args.max_length, args.limit)
    dev = load_examples(tok, args.data / "dev.jsonl", args.max_length, args.dev_limit)
    lens = sorted(len(p) + len(a) for p, a in train)
    print(f"train {len(train)} / dev {len(dev)} examples; tokens per example p50 {lens[len(lens) // 2]}, max {lens[-1]}")

    model = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16, attn_implementation="sdpa").to(device)
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    lora = LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
    total = max(1, math.ceil(len(train) * args.epochs / args.accum))
    warmup = max(1, int(0.03 * total))
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (s + 1) / warmup if s < warmup else 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, total - warmup)))
    )

    def dev_loss() -> float:
        model.eval()
        with torch.no_grad():
            losses = [answer_loss(model, p, a, device).item() for p, a in dev]
        model.train()
        return sum(losses) / max(1, len(losses))

    order = [i for _ in range(math.ceil(args.epochs)) for i in random.sample(range(len(train)), len(train))]
    order = order[: total * args.accum]
    best, step, running, started = float("inf"), 0, 0.0, time.time()
    log = (args.out / "train_log.jsonl").open("w")
    model.train()
    for k, i in enumerate(order, 1):
        loss = answer_loss(model, *train[i], device)
        (loss / args.accum).backward()
        running += loss.item()
        if k % args.accum and k != len(order):
            continue
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        step += 1
        rec = {"step": step, "of": total, "loss": running / args.accum, "lr": sched.get_last_lr()[0], "s": round(time.time() - started)}
        running = 0.0
        if step % args.eval_every == 0 or step == total:
            rec["dev_loss"] = dev_loss()
            if rec["dev_loss"] < best:
                best = rec["dev_loss"]
                model.save_pretrained(str(args.out / "adapter"))
                tok.save_pretrained(str(args.out / "adapter"))
                rec["saved"] = True
        if step % 10 == 0 or "dev_loss" in rec:
            eta = (time.time() - started) / step * (total - step)
            print(json.dumps(rec), f"eta {eta / 60:.0f} min", flush=True)
        log.write(json.dumps(rec) + "\n")
        log.flush()

    (args.out / "run.json").write_text(
        json.dumps(
            {
                "base": args.base,
                "rank": args.rank,
                "epochs": args.epochs,
                "lr": args.lr,
                "accum": args.accum,
                "train_examples": len(train),
                "best_dev_loss": best,
                "prompt_sha256": manifest["prompt_sha256"],
                "chat_template": {"enable_thinking": False},
                "minutes": round((time.time() - started) / 60, 1),
            },
            indent=2,
        )
    )
    print(f"adapter -> {args.out / 'adapter'} (best dev loss {best:.4f})\nserve: .venv/bin/python reader/model/serve.py --adapter {args.out / 'adapter'}")


if __name__ == "__main__":
    main()
