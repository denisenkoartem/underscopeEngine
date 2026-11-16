// Score a reader on a test set: run every note through it and compare the assessment field by field
// with the expected one. Per-field accuracy, accuracy on the stated fields, invented and missed values
// per note, p50 latency.
//
//   pnpm --filter @underscope/reader reader:eval -- --gold fixtures/reader/gold.jsonl --reader rules --out data/reader/eval-rules.local.json
//   PARSER_BASE_URL=http://127.0.0.1:8000/v1 PARSER_MODEL=underscope-reader \
//     pnpm --filter @underscope/reader reader:eval -- --gold fixtures/reader/gold.jsonl --reader model \
//     --out data/reader/eval-B.local.json --baseline data/reader/eval-rules.local.json    # prints the gates; exit 1 if any fails
//
//   --reader rules   the keyword rules alone (free)
//   --reader model   the model alone (needs PARSER_BASE_URL; PARSER_SPARSE=1 for a sparse-trained adapter)
//   --reader merged  what read() returns: rules and model merged
//   --v1             the model is the run1 adapter: old prompt and old field names (scripts/reader/v1.ts)
//   --show field     print every note where this field is wrong
//
// Test lines are GoldItem JSON ({ notes, expect }) or training items ({ notes, target }). Never train on a test set.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Assessment } from "../../src/contract.js";
import { loadDotEnv } from "../../src/cli.js";
import { createCompatClient } from "../../src/chatAdapter.js";
import { DEFAULT_MODEL, PACKAGE_ROOT, ReadError, buildRequest, loadPrompt, readModel, stripRoleLines, verifyAnswer, type Answer, type Issue } from "../../src/model.js";
import { callOpenAI, parserTimeoutMs, responseText, type CallContext, type ParserUsage } from "../../src/openaiParse.js";
import { merge } from "../../src/read.js";
import { readRules } from "../../src/rules.js";
import { HIGH_STAKES, UNKNOWN, cliArgs, expectAssessment, gates, metrics, readJsonl, scoreItem, verifyNotes, type GoldItem, type ItemResult, type Metrics, type ReaderItem } from "./lib.js";
import { fromV1, type V1Extraction } from "./v1.js";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function printMetrics(label: string, m: Metrics): void {
  console.log(`\n${label}: ${m.n} notes, ${m.failed} failed`);
  console.log(`  overall field accuracy     ${pct(m.overall_accuracy)}`);
  console.log(`  accuracy on stated fields  ${pct(m.stated_accuracy)}`);
  console.log(`  invented values / note     ${m.invented_rate.toFixed(2)}`);
  console.log(`  missed values / note       ${m.missed_rate.toFixed(2)}`);
  console.log(`  answers removed by checks  ${m.unsupported_rate.toFixed(2)} per note`);
  console.log(`  p50 latency                ${m.latency_p50_ms} ms`);
  console.log("  per field (lowest first; * decides the lane):");
  for (const [f, a] of Object.entries(m.field_accuracy).sort((x, y) => x[1] - y[1]).slice(0, 30)) {
    console.log(`    ${(HIGH_STAKES as readonly string[]).includes(f) ? "*" : " "} ${f.padEnd(30)} ${pct(a)}`);
  }
}

/** The run1 adapter: the old prompt, its answer translated to today's shape, then today's checks. */
async function readV1(notes: string, usage: ParserUsage[]): Promise<{ assessment: Assessment; issues: Issue[] }> {
  const env = process.env;
  if (!env.PARSER_BASE_URL) throw new ReadError("--v1 needs PARSER_BASE_URL");
  const ctx: CallContext = { client: createCompatClient(env.PARSER_BASE_URL, env), log: () => {}, prefix: "read", usage, timeoutMs: parserTimeoutMs(env), server: env.PARSER_BASE_URL };
  const { text, removed } = stripRoleLines(notes.trim());
  const body = { ...buildRequest(env.PARSER_MODEL || DEFAULT_MODEL, text, { prompt: loadPrompt(join(PACKAGE_ROOT, "prompts", "read_v1.md")), sparse: true }) };
  let old: V1Extraction;
  try {
    old = JSON.parse(responseText(await callOpenAI(ctx, "read v1", body))) as V1Extraction;
  } catch (e) {
    throw new ReadError(`no usable v1 answer (${(e as Error).message})`);
  }
  return verifyAnswer(fromV1(old) as Answer, text, removed);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: cliArgs(),
    options: { gold: { type: "string" }, reader: { type: "string", default: "rules" }, v1: { type: "boolean", default: false }, out: { type: "string" }, baseline: { type: "string" }, limit: { type: "string" }, show: { type: "string" } },
  });
  const kind = values.reader;
  if (!values.gold || !["rules", "model", "merged"].includes(kind)) {
    console.error("usage: reader:eval -- --gold test.jsonl [--reader rules|model|merged] [--v1] [--out result.local.json] [--baseline other.local.json] [--limit N] [--show field]");
    return 1;
  }
  loadDotEnv();
  const items = readJsonl<GoldItem | ReaderItem>(resolve(values.gold)).slice(0, values.limit ? Number(values.limit) : undefined);
  const label = kind === "rules" ? "rules" : `${kind}${values.v1 ? " (v1)" : ""}: ${process.env.PARSER_MODEL || DEFAULT_MODEL} at ${process.env.PARSER_BASE_URL ?? "(no PARSER_BASE_URL)"}`;
  console.error(`eval: ${items.length} notes, reader ${label}`);

  const results: ItemResult[] = [];
  for (const item of items) {
    let gold: Assessment;
    if ("expect" in item) gold = expectAssessment(item.expect);
    else {
      const g = verifyNotes(item.notes, item.target);
      if (g.issues.length > 0) {
        console.error(`${item.id}: the label fails the checks (${g.issues[0]!.path}: ${g.issues[0]!.kind}); skipped`);
        continue;
      }
      gold = g.assessment;
    }
    let pred: Assessment | null = null;
    let issues: Issue[] = [];
    let failed: string | null = null;
    const usage: ParserUsage[] = [];
    const started = Date.now();
    try {
      if (kind === "rules") pred = readRules(item.notes);
      else {
        const m = values.v1 ? await readV1(item.notes, usage) : await readModel(item.notes, { log: () => {} });
        issues = m.issues;
        pred = kind === "merged" ? merge(readRules(item.notes), m.assessment) : m.assessment;
      }
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      if (/PARSER_BASE_URL|\b(401|403|404)\b|ECONNREFUSED|request failed/.test(e.message)) throw e;
      failed = e.message;
      console.error(`${item.id}: failed (${e.message})`);
    }
    const r = scoreItem(item.id, gold, pred, issues, { failed, latency_ms: Date.now() - started });
    results.push(r);
    if (values.show && r.gold[values.show] !== r.pred[values.show]) {
      console.log(`${item.id}  ${values.show}: want ${r.gold[values.show] ?? UNKNOWN}, got ${r.pred[values.show] ?? UNKNOWN}\n    ${item.notes.replace(/\n/g, " | ").slice(0, 400)}`);
    }
  }
  if (results.length === 0) {
    console.error("eval: no usable notes");
    return 1;
  }
  const m = metrics(results);
  printMetrics(label, m);
  if (values.out) {
    writeFileSync(resolve(values.out), `${JSON.stringify({ reader: label, metrics: m, items: results }, null, 2)}\n`);
    console.error(`eval: results -> ${resolve(values.out)}`);
  }
  if (values.baseline) {
    const base = JSON.parse(readFileSync(resolve(values.baseline), "utf8")) as { reader: string; metrics: Metrics };
    const table = gates(m, base.metrics);
    console.log(`\nGates vs ${base.reader}:`);
    for (const t of table) console.log(`  ${t.pass ? "PASS" : "FAIL"}  ${t.gate.padEnd(44)} ${t.detail}`);
    const failedGates = table.filter((t) => !t.pass).length;
    console.log(failedGates === 0 ? "\nAll gates pass." : `\n${failedGates} gate(s) fail.`);
    return failedGates === 0 ? 0 : 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`eval: ${(e as Error).message}`);
    process.exit(1);
  },
);
