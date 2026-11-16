// Training files for the reader fine-tune (reader/model/train.py reads them). Takes labeled items
// (synth.ts, upgrade.ts), removes anything that overlaps a test set (same normalized text or a shared
// VIN), duplicates and any target that no longer passes the checks, oversamples high-stakes targets in
// train, splits train/dev by id, and writes chat-format lines: system = the production instructions,
// user = the production input, assistant = the target JSON. That is exactly what buildRequest sends, so
// training and serving see the same prompt; manifest.json records the prompt's sha256.
//
//   pnpm --filter @underscope/reader reader:export -- --in data/reader/a.local.jsonl --in data/reader/b.local.jsonl \
//     --gold fixtures/reader/gold.jsonl --out-dir data/reader/sft-B --sparse
//
//   --sparse          targets list only the fields the notes mention (shorter answers)
//   --drop k1,k2      leave these answer keys out of every target (a run with fewer fields)
//   --prompt file.md  train with this prompt instead of prompts/read.md
//   --limit N         use only the first N items of each --in file
//
// No model calls.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRequest, fullAnswer, loadPrompt, sparseAnswer, stripRoleLines, type Answer } from "../../src/model.js";
import { cliArgs, isHighStakes, normText, readJsonl, sha256, splitOf, targetProblems, vinsIn, type GoldItem, type ReaderItem } from "./lib.js";

export interface SftOptions {
  sparse?: boolean;
  /** Answer keys left out of the target. */
  drop?: string[];
  /** Prompt text (default prompts/read.md). */
  prompt?: string;
}

/** The target as trained: the item's answer without the dropped keys, full or sparse. */
export function sftTarget(target: Answer, o: SftOptions = {}): Answer {
  const kept = Object.fromEntries(Object.entries(target).filter(([k]) => !(o.drop ?? []).includes(k))) as Answer;
  if (o.sparse) return sparseAnswer(kept);
  return Object.fromEntries(Object.entries(fullAnswer(kept)).filter(([k]) => !(o.drop ?? []).includes(k))) as Answer;
}

/** The chat example for one item: the production request for its notes, and the target as the answer. */
export function sftLine(item: ReaderItem, o: SftOptions = {}): string {
  const notes = stripRoleLines(item.notes.replace(/^\uFEFF/, "").trim()).text;
  const req = buildRequest("reader", notes, o.prompt !== undefined ? { prompt: o.prompt } : {});
  return JSON.stringify({
    messages: [
      { role: "system", content: req.instructions },
      { role: "user", content: req.input },
      { role: "assistant", content: JSON.stringify(sftTarget(item.target, o)) },
    ],
  });
}

function main(): number {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      in: { type: "string", multiple: true },
      gold: { type: "string", multiple: true },
      "out-dir": { type: "string" },
      "dev-share": { type: "string", default: "0.05" },
      oversample: { type: "string", default: "1" },
      sparse: { type: "boolean", default: false },
      drop: { type: "string" },
      prompt: { type: "string" },
      limit: { type: "string" },
    },
  });
  if (!values.in?.length || !values["out-dir"]) {
    console.error("usage: reader:export -- --in a.local.jsonl [--in b.local.jsonl] --gold fixtures/reader/gold.jsonl --out-dir data/reader/sft-X [--sparse] [--drop k1,k2] [--prompt file.md] [--limit N]");
    return 1;
  }
  // Every test set goes in --gold, so nothing that overlaps it is trained on.
  const goldPaths = values.gold ?? [];
  if (goldPaths.length === 0) console.error("export: WARNING no --gold set given; nothing is checked for overlap with a measurement set");
  const gold = goldPaths.flatMap((p) => readJsonl<GoldItem>(resolve(p)));
  const sft: SftOptions = { sparse: values.sparse, drop: values.drop ? values.drop.split(",").map((k) => k.trim()).filter(Boolean) : [], ...(values.prompt ? { prompt: loadPrompt(resolve(values.prompt)) } : {}) };
  const goldTexts = new Set(gold.map((g) => normText(g.notes)));
  const goldVins = new Set(gold.flatMap((g) => vinsIn(g.notes)));
  const devShare = Number(values["dev-share"]);
  const oversample = Math.max(1, Math.floor(Number(values.oversample)));

  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  const removed = { overlaps_gold: 0, duplicate: 0, is_gold: 0, fails_checks: 0 };
  const train: string[] = [];
  const dev: string[] = [];
  for (const path of values.in) {
    for (const item of readJsonl<ReaderItem>(resolve(path)).slice(0, values.limit ? Number(values.limit) : undefined)) {
      const t = normText(item.notes);
      if (item.source === "gold") removed.is_gold++;
      else if (goldTexts.has(t) || vinsIn(item.notes).some((v) => goldVins.has(v))) removed.overlaps_gold++;
      else if (seen.has(t)) removed.duplicate++;
      else if (targetProblems(item.notes, item.target).length > 0) {
        removed.fails_checks++;
        console.error(`${item.id}: target fails the checks (${targetProblems(item.notes, item.target)[0]}); left out`);
      } else {
        seen.add(t);
        const split = splitOf(item.id, devShare);
        const line = sftLine(item, sft);
        const copies = split === "train" && isHighStakes(item.target) ? oversample : 1;
        for (let k = 0; k < copies; k++) (split === "train" ? train : dev).push(line);
        counts[`${split}:${item.source}`] = (counts[`${split}:${item.source}`] ?? 0) + 1;
      }
    }
  }
  const dir = resolve(values["out-dir"]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "train.jsonl"), train.map((l) => `${l}\n`).join(""));
  writeFileSync(join(dir, "dev.jsonl"), dev.map((l) => `${l}\n`).join(""));
  const instructions = sft.prompt ?? loadPrompt();
  const manifest = {
    created_at: new Date().toISOString(),
    prompt_sha256: sha256(instructions),
    prompt: values.prompt ?? "prompts/read.md",
    sparse: values.sparse,
    dropped_keys: sft.drop,
    inputs: values.in.map((p) => ({ path: p, sha256: sha256(readFileSync(resolve(p), "utf8")) })),
    gold: { paths: goldPaths, items: gold.length },
    dev_share: devShare,
    oversample_high_stakes: oversample,
    items: counts,
    lines: { train: train.length, dev: dev.length },
    removed,
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`export: ${train.length} train / ${dev.length} dev lines -> ${dir} (removed ${JSON.stringify(removed)})`);
  return 0;
}

// Run only when executed directly, not when a test imports sftLine.
if (process.argv[1]?.endsWith("export.ts")) process.exit(main());
