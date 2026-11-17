// Synthetic training notes for the reader, free: sampled facts (lib.ts sampleFacts) written out by the
// template writer (templates.ts). A note is kept only when its answer passes the production checks
// (verifyAnswer) with zero issues, so a model trained on them learns only what the checks accept.
//
//   pnpm --filter @underscope/reader reader:synth -- --n 2000 --seed 2 --out data/reader/synth-v2-seed2.local.jsonl
//
// Notes carry the fields added on 2026-11-16 (seller, paperwork, keys, damage areas, part grades, repair
// quote...). `--old-style` writes notes with the v1 facts only, as synth-tpl-seed1 was written.
// Output lines are ReaderItem JSON. The file name must end in .local.jsonl (gitignored).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_ROOT, fullAnswer, type Answer } from "../../src/model.js";
import { cliArgs, extractionFromFacts, rng, sampleFacts, targetProblems, type ReaderItem } from "./lib.js";
import { applyV2, templateNotes } from "./templates.js";
import { fromV1 } from "./v1.js";

/** One note and its answer from a seeded generator, or the reason it was dropped. */
export function synthItem(r: () => number, id: string, withV2: boolean): { item: ReaderItem } | { dropped: string; notes: string } {
  const t = templateNotes(sampleFacts(r, undefined, withV2), r);
  const base = fromV1({ ...extractionFromFacts(t.facts, t), unmapped: t.unmapped });
  const target: Answer = fullAnswer(applyV2(base, t.v2, t.notes));
  const problems = targetProblems(t.notes, target);
  if (problems.length > 0) return { dropped: problems[0]!, notes: t.notes };
  return { item: { id, source: "synthetic", origin: `synth:template:${t.facts.voice}${withV2 ? "" : ":old-style"}`, notes: t.notes, target } };
}

function main(): number {
  const { values } = parseArgs({
    args: cliArgs(),
    options: { n: { type: "string", default: "20" }, seed: { type: "string", default: "2" }, out: { type: "string" }, "old-style": { type: "boolean", default: false } },
  });
  const n = Number(values.n), seed = Number(values.seed), withV2 = !values["old-style"];
  const out = resolve(values.out ?? join(PACKAGE_ROOT, "data", "reader", `synth-v2-seed${seed}.local.jsonl`));
  if (!out.endsWith(".local.jsonl")) {
    console.error("--out must end in .local.jsonl (those files are gitignored)");
    return 1;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  const r = rng(seed);
  let kept = 0;
  const dropped: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const x = synthItem(r, `synth-v2-s${seed}-${i}`, withV2);
    if ("item" in x) {
      appendFileSync(out, `${JSON.stringify(x.item)}\n`);
      kept++;
    } else {
      const why = x.dropped.split(" (")[0]!;
      dropped[why] = (dropped[why] ?? 0) + 1;
      if (process.env.SYNTH_VERBOSE) console.error(`dropped (${x.dropped})\n${x.notes}\n`);
    }
  }
  console.error(`synth: kept ${kept} of ${n} -> ${out}`);
  const reasons = Object.entries(dropped).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) console.error(`synth: dropped ${reasons.map(([k, v]) => `${v} x ${k}`).join(", ")}`);
  return 0;
}

if (process.argv[1]?.endsWith("synth.ts")) process.exit(main());
