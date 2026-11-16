"""A small OpenAI-compatible server for the trained reader (and its base model), for local use and tests.

    .venv/bin/python reader/model/serve.py --adapter reader/model/out/run1/adapter            # http://127.0.0.1:8000/v1

It serves two model names from one copy of the weights on the GPU:
- `underscope-reader` (--adapter-name): the base model with the LoRA adapter, i.e. the fine-tuned reader.
  The engine sends it the extraction call: PARSER_BASE_URL=http://127.0.0.1:8000/v1 PARSER_MODEL=underscope-reader.
- `qwen3-1.7b` (--base-name): the same base model with the adapter switched off. It is NOT trained for
  anything in the engine; it lets the category scorers and market fit run without API spend
  (SCORING_BASE_URL/SCORING_MODEL, MARKET_PROVIDER=local/MARKET_BASE_URL/MARKET_LOCAL_MODEL).

Endpoints: GET /v1/models, POST /v1/chat/completions (messages, max_tokens, temperature, response_format;
no streaming, no tools). Decoding is greedy. There is no grammar-constrained decoding: the reader learned
the answer format in training, and for the base model a JSON response_format adds one system line with
the schema (vLLM would enforce it instead). A JSON answer with a '+' before a number ("copart": +1, which
prompts that say "-1 to +1" invite) has the sign dropped. One that still does not parse, or lacks a
required key, is generated once more with light sampling (seeded), because the engine's own retry would
get the same greedy answer again. The engine still validates every answer.

It refuses to start on a GPU with less than --min-free-gb free (for example while train.py runs);
use CUDA_VISIBLE_DEVICES= for a slow CPU run instead.

Production serving is vLLM (reader/model/README.md); this server is one request at a time on one GPU.
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FENCE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$")


def clean_json_text(text: str) -> str:
    """Strip a think block and a markdown fence; keep the outermost {...} when there is prose around it."""
    t = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    m = FENCE.match(t)
    if m:
        t = m.group(1).strip()
    if not t.startswith("{") and "{" in t and "}" in t:
        t = t[t.index("{") : t.rindex("}") + 1]
    return t


def drop_plus_signs(text: str) -> str:
    """Remove a '+' before a number outside strings ("copart": +1 is not JSON). Prompts that describe a
    scale as "-1 to +1" make small models write it; strict decoding would never emit it."""
    out, in_str, esc, last = [], False, False, ""
    for i, ch in enumerate(text):
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "+" and last in ":[," and i + 1 < len(text) and (text[i + 1].isdigit() or text[i + 1] == "."):
            continue
        out.append(ch)
        if not ch.isspace():
            last = ch
    return "".join(out)


def json_problem(text: str, schema: dict) -> str | None:
    """Why `text` is not a JSON object with the schema's required top-level keys, or None."""
    try:
        obj = json.loads(text)
    except ValueError as e:
        return f"not JSON ({e})"
    if not isinstance(obj, dict):
        return "not a JSON object"
    missing = [k for k in schema.get("required", []) if k not in obj]
    return f"missing keys {missing}" if missing else None


class Reader:
    def __init__(self, base: str, adapter: str | None, adapter_name: str, base_name: str, max_new_tokens: int, min_free_gb: float, revision: str | None = None):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if self.device.type == "cuda":
            free = torch.cuda.mem_get_info()[0] / 2**30
            if free < min_free_gb:
                raise SystemExit(
                    f"only {free:.1f} GB free on the GPU (need {min_free_gb}); is train.py still running? "
                    "Wait for it, or run on the CPU with CUDA_VISIBLE_DEVICES="
                )
        self.tok = AutoTokenizer.from_pretrained(adapter) if adapter else AutoTokenizer.from_pretrained(base, revision=revision)
        dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32
        model = AutoModelForCausalLM.from_pretrained(base, revision=revision, dtype=dtype)
        model.to(self.device)
        self.has_adapter = adapter is not None
        if adapter:
            from peft import PeftModel

            model = PeftModel.from_pretrained(model, adapter)
        model.eval()
        self.model = model
        self.adapter_name = adapter_name
        self.base_name = base_name
        self.max_new_tokens = max_new_tokens
        self.stop = [self.tok.convert_tokens_to_ids("<|im_end|>"), self.tok.convert_tokens_to_ids("<|endoftext|>")]
        self.lock = threading.Lock()

    def _generate(self, ids, limit: int, use_adapter: bool, sample: bool) -> tuple[list[int], bool, str]:
        """(answer tokens, stopped at end of turn, text). Greedy, or light sampling for the one JSON redo."""
        kwargs = dict(max_new_tokens=limit, eos_token_id=self.stop, pad_token_id=self.stop[-1])
        if sample:
            kwargs.update(do_sample=True, temperature=0.3, top_p=0.9)
        else:
            kwargs.update(do_sample=False, prompt_lookup_num_tokens=10)
        if use_adapter or not self.has_adapter:
            out = self.model.generate(input_ids=ids, **kwargs)
        else:
            with self.model.disable_adapter():
                out = self.model.generate(input_ids=ids, **kwargs)
        new = out[0, ids.shape[1] :].tolist()
        stopped = bool(new) and new[-1] in self.stop
        return new, stopped, self.tok.decode([t for t in new if t not in self.stop], skip_special_tokens=True)

    def names(self) -> list[str]:
        return ([self.adapter_name] if self.has_adapter else []) + [self.base_name]

    def complete(self, body: dict) -> dict:
        name = body.get("model")
        if name not in self.names():
            raise LookupError(f"model {name!r} is not served here (serving {', '.join(self.names())})")
        messages = [{"role": m["role"], "content": m["content"]} for m in body.get("messages", [])]
        fmt = body.get("response_format") or {}
        use_adapter = name == self.adapter_name
        if not use_adapter and fmt.get("type") == "json_schema":
            schema = json.dumps(fmt.get("json_schema", {}).get("schema", {}), separators=(",", ":"))
            messages.insert(0 if messages[0]["role"] != "system" else 1, {
                "role": "system",
                "content": f"Answer with one JSON object only, no other text, matching this JSON schema: {schema}",
            })  # fmt: skip
        prompt = self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = self.tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to(self.device)
        limit = min(int(body.get("max_tokens") or body.get("max_completion_tokens") or 1024), self.max_new_tokens)
        wants_json = fmt.get("type") in ("json_schema", "json_object")
        schema = fmt.get("json_schema", {}).get("schema", {}) if fmt.get("type") == "json_schema" else {}
        queued = time.time()
        with self.lock, self.torch.no_grad():
            started = time.time()  # after the wait for the GPU: one request at a time
            new, stopped, text = self._generate(ids, limit, use_adapter, sample=False)
            if wants_json:
                text = clean_json_text(text)
                problem = json_problem(text, schema)
                if problem and json_problem(drop_plus_signs(text), schema) is None:
                    text, problem = drop_plus_signs(text), None
                if problem:
                    print(f"{name}: answer {problem}; generating once more with sampling", flush=True)
                    self.torch.manual_seed(0)
                    new2, stopped2, text2 = self._generate(ids, limit, use_adapter, sample=True)
                    text2 = clean_json_text(text2)
                    if json_problem(text2, schema) is not None:
                        text2 = drop_plus_signs(text2)
                    if json_problem(text2, schema) is None:
                        new, stopped, text = new2, stopped2, text2
        secs, waited = time.time() - started, started - queued
        wait = f", after {waited:.1f}s waiting for the GPU" if waited >= 0.5 else ""
        print(f"{name}: prompt {ids.shape[1]} + answer {len(new)} tokens in {secs:.1f}s ({len(new) / max(secs, 1e-6):.0f} tok/s){wait}", flush=True)
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": name,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop" if stopped else "length"}],
            "usage": {"prompt_tokens": ids.shape[1], "completion_tokens": len(new), "total_tokens": ids.shape[1] + len(new)},
        }


def make_handler(reader: Reader, api_key: str | None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if api_key is None or self.headers.get("Authorization") == f"Bearer {api_key}":
                return True
            self._send(401, {"error": {"message": "invalid API key", "type": "invalid_request_error"}})
            return False

        def do_GET(self) -> None:
            if not self._authorized():
                return
            if self.path.rstrip("/") == "/v1/models":
                return self._send(200, {"object": "list", "data": [{"id": n, "object": "model", "owned_by": "local"} for n in reader.names()]})
            self._send(404, {"error": {"message": f"no route {self.path}"}})

        def do_POST(self) -> None:
            if not self._authorized():
                return
            if self.path.rstrip("/") != "/v1/chat/completions":
                return self._send(404, {"error": {"message": f"no route {self.path}"}})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if body.get("stream") or body.get("tools"):
                    return self._send(400, {"error": {"message": "streaming and tools are not supported"}})
                self._send(200, reader.complete(body))
            except LookupError as e:
                self._send(404, {"error": {"message": str(e), "type": "invalid_request_error", "code": "model_not_found"}})
            except (ValueError, KeyError, TypeError) as e:
                self._send(400, {"error": {"message": f"bad request: {e}"}})
            except Exception as e:  # report instead of dropping the connection
                self._send(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

        def log_message(self, fmt: str, *args) -> None:  # one line per request is printed by Reader.complete
            pass

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="Qwen/Qwen3-1.7B")
    ap.add_argument("--revision", default=None, help="base model commit on the Hugging Face Hub (pin the one the adapter was trained on)")
    ap.add_argument("--adapter", default=None, help="LoRA adapter folder from train.py (omit to serve the base model only)")
    ap.add_argument("--adapter-name", default="underscope-reader")
    ap.add_argument("--base-name", default="qwen3-1.7b")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--max-new-tokens", type=int, default=1536, help="cap per answer (the reader's answers run ~300-600 tokens)")
    ap.add_argument("--min-free-gb", type=float, default=4.0, help="refuse to start on a GPU with less free memory")
    ap.add_argument("--api-key", default=None, help="require this Bearer key (default: none)")
    args = ap.parse_args()
    reader = Reader(args.base, args.adapter, args.adapter_name, args.base_name, args.max_new_tokens, args.min_free_gb, args.revision)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(reader, args.api_key))
    print(f"serving {', '.join(reader.names())} on http://{args.host}:{args.port}/v1 ({reader.device})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
