// Reuse the training notes run1 was trained on: convert each item of a v1 file (answers in the old
// field names, prompts/read_v1.md) to today's answer shape. The notes are untouched; only the labels are
// translated (v1.ts fromV1), and a label is kept only when it passes today's checks with zero issues.
// The v1 file itself is never changed.
//
//   pnpm --filter @underscope/reader reader:upgrade -- --in data/reader/synth-tpl-seed1.local.jsonl --out data/reader/synth-tpl-seed1.v2.local.jsonl

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { cliArgs, readJsonl, targetProblems, type ReaderItem } from "./lib.js";
import { fromV1, type V1Extraction } from "./v1.js";

interface V1Item { id: string; source: string; origin: string; notes: string; target: V1Extraction }

/** The v1 item with today's answer, or why its label does not carry over. */
export function upgradeItem(old: V1Item): { item: ReaderItem } | { dropped: string } {
  const target = fromV1(old.target);
  const problems = targetProblems(old.notes, target);
  if (problems.length > 0) return { dropped: problems[0]! };
  return { item: { id: old.id, source: "synthetic", origin: `${old.origin}; labels upgraded from v1`, notes: old.notes, target } };
}

function main(): number {
  const { values } = parseArgs({ args: cliArgs(), options: { in: { type: "string" }, out: { type: "string" } } });
  if (!values.in || !values.out) {
    console.error("usage: reader:upgrade -- --in v1.local.jsonl --out v2.local.jsonl");
    return 1;
  }
  const src = resolve(values.in), out = resolve(values.out);
  if (src === out || !out.endsWith(".local.jsonl")) {
    console.error("--out must be a different file ending in .local.jsonl");
    return 1;
  }
  const lines: string[] = [];
  const dropped: Record<string, number> = {};
  const olds = readJsonl<V1Item>(src);
  for (const old of olds) {
    const x = upgradeItem(old);
    if ("item" in x) lines.push(JSON.stringify(x.item));
    else {
      const why = x.dropped.split(" (")[0]!;
      dropped[why] = (dropped[why] ?? 0) + 1;
      if (process.env.SYNTH_VERBOSE) console.error(`${old.id}: ${x.dropped}\n${old.notes}\n`);
    }
  }
  writeFileSync(out, lines.map((l) => `${l}\n`).join(""));
  console.error(`upgrade: ${lines.length} of ${olds.length} items -> ${out}`);
  const reasons = Object.entries(dropped).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) console.error(`upgrade: dropped ${reasons.map(([k, v]) => `${v} x ${k}`).join(", ")}`);
  return 0;
}

if (process.argv[1]?.endsWith("upgrade.ts")) process.exit(main());
