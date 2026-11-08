// CLI: pnpm engine <decide|explain|market|eval> [file.json] [--offline] [--as-of <year>]
//      pnpm engine samples <sample_vehicles.json> [--use-shipped-config]
//
// pnpm passes everything after the script name through to this script (including
// --offline), and runs it with cwd = packages/engine; INIT_CWD is where the user ran pnpm.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decideWithMarket } from "./combine.js";
import { ConfigError, PACKAGE_ROOT, loadConfig, parseJsonText, type EngineConfig } from "./config.js";
import { renderExplainTable } from "./explain.js";
import { compareDecision, parseExpected } from "./expected.js";
import { InputError, normalizeRecord, type NormalizedRecord } from "./input.js";
import { scoreMarketFit, type MarketFitOptions } from "./marketFit.js";
import { buildSampleConfig, formatSampleResults, readSampleFile, runSamples } from "./samples.js";
import type { Decision, MarketFitResult } from "./types.js";

const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const EXAMPLES_DIR = join(PACKAGE_ROOT, "examples");

const USAGE = `Usage: pnpm engine <command> [options]
  decide <file.json>    print the Decision JSON
  explain <file.json>   print each category's scores, weight, confidence and contribution
  market <file.json>    print the market-fit result with its signals and source URLs
  eval                  run every examples/*.json and compare with its .expected.md
  samples <file.json>   run a sample_vehicles.json file offline under its own config_used
                        (config/ plus the file's overrides, in memory) and compare each
                        vehicle with its expected_offline; exit 1 on any FAIL
Options:
  --offline             never call the API; market fit uses the fallback table
  --as-of <year>        year used for vehicle age (default: the current year; eval uses
                        each example's as_of_year; samples always uses the year of the
                        file's "generated" date and rejects --as-of)
  --use-shipped-config  samples only: use config/ as shipped instead of the file's
                        config_used and report the differences (informational, exit 0)
A "*" in the file name is expanded (it must match exactly one file).`;

class UsageError extends Error {}

export interface CliArgs {
  command: string;
  files: string[];
  offline: boolean;
  asOfYear?: number;
  /** samples only. */
  useShippedConfig: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "", files: [], offline: false, useShippedConfig: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue; // pnpm/npm separator, harmless
    if (a === "--offline") args.offline = true;
    else if (a === "--use-shipped-config") args.useShippedConfig = true;
    else if (a === "--as-of" || a.startsWith("--as-of=")) {
      const v = a.includes("=") ? a.slice("--as-of=".length) : argv[++i];
      const year = Number(v);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new UsageError(`--as-of needs a year, got "${v ?? ""}"`);
      args.asOfYear = year;
    } else if (a === "-h" || a === "--help") args.command = "help";
    else if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
    else if (!args.command) args.command = a;
    else args.files.push(a);
  }
  return args;
}

/** Files matching `arg` (a "*" in the basename is a wildcard), in the first base dir with a hit. */
export function resolveInputs(arg: string, bases: string[]): string[] {
  for (const base of bases) {
    const full = resolve(base, arg);
    const name = basename(full);
    if (!name.includes("*")) {
      if (existsSync(full)) return [full];
      continue;
    }
    const dir = dirname(full);
    if (!existsSync(dir)) continue;
    const re = new RegExp(`^${name.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    const hits = readdirSync(dir).filter((f) => re.test(f)).sort();
    if (hits.length > 0) return hits.map((f) => join(dir, f));
  }
  return [];
}

function searchBases(): string[] {
  const bases = [process.env.INIT_CWD, process.cwd(), PACKAGE_ROOT].filter((b): b is string => !!b);
  return [...new Set(bases.map((b) => resolve(b)))];
}

function resolveOne(arg: string | undefined): string {
  if (!arg) throw new UsageError("Missing <file.json>");
  const bases = searchBases();
  const hits = resolveInputs(arg, bases);
  if (hits.length === 0) throw new InputError(`File not found: ${arg} (looked in ${bases.join(", ")})`);
  if (hits.length > 1) throw new InputError(`"${arg}" matches ${hits.length} files; name one:\n  ${hits.join("\n  ")}`);
  return hits[0]!;
}

/** Load .env files. process.loadEnvFile never overrides a variable that is already set, so the
 * shell wins, then packages/engine/.env, then the repo root .env. An empty key counts as missing.
 * A .env that exists but cannot be read is skipped with a warning (Node reports a permission
 * error as ENOENT, so its own message would point at the wrong problem). */
export function loadDotEnv(
  paths: string[] = [join(PACKAGE_ROOT, ".env"), join(REPO_ROOT, ".env")],
  warn: (line: string) => void = (line) => console.error(line),
): void {
  const dropEmptyKey = () => {
    if (process.env.ANTHROPIC_API_KEY === "") delete process.env.ANTHROPIC_API_KEY;
  };
  dropEmptyKey();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
    } catch {
      warn(`Warning: cannot read ${p} (not a readable file); ignoring it`);
      continue;
    }
    dropEmptyKey();
  }
}

function readRecord(path: string): NormalizedRecord {
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InputError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return normalizeRecord(raw);
  } catch (e) {
    if (e instanceof InputError) throw new InputError(`${path}: ${e.message}`);
    throw e;
  }
}

/** Market fit once, then the pure decision (same as combine.decide, but keeps the market result for cost). */
async function run(
  record: NormalizedRecord,
  config: EngineConfig,
  opts: MarketFitOptions,
): Promise<{ market: MarketFitResult; decision: Decision }> {
  const market = await scoreMarketFit(record, config, opts);
  return { market, decision: decideWithMarket(record, config, market) };
}

async function evalExamples(config: EngineConfig, offline: boolean): Promise<boolean> {
  if (!offline) {
    console.error("Note: expected answers assume the offline fallback for market fit; online results may differ (use --offline).");
  }
  const files = existsSync(EXAMPLES_DIR) ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  if (files.length === 0) throw new InputError(`No examples found in ${EXAMPLES_DIR}`);
  let ok = true;
  let cost = 0;
  let requests = 0;
  let billed = 0;
  for (const f of files) {
    const stem = f.replace(/\.json$/, "");
    let problems: string[];
    try {
      const mdPath = join(EXAMPLES_DIR, `${stem}.expected.md`);
      if (!existsSync(mdPath)) throw new InputError(`missing ${stem}.expected.md`);
      const expected = parseExpected(readFileSync(mdPath, "utf8"), `${stem}.expected.md`);
      const { market, decision } = await run(readRecord(join(EXAMPLES_DIR, f)), config, {
        offline,
        asOfYear: expected.as_of_year,
      });
      if (market.usage) {
        cost += market.usage.cost_usd;
        requests += market.usage.requests;
        billed++;
      }
      problems = compareDecision(expected, decision);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      problems = [e.message];
    }
    if (problems.length > 0) ok = false;
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${stem}${problems.map((p) => `\n      ${p}`).join("")}`);
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // Requests, not examples: one example can make several (a retry, pause_turn continuations).
  console.log(
    `\nTotal API cost: $${cost.toFixed(4)} (${plural(requests, "API request")} for ${billed} of ${plural(files.length, "example")})`,
  );
  return ok;
}

/**
 * Run a sample_vehicles.json file offline. Default: under the file's own config_used (built in
 * memory; exit 1 on any FAIL). With useShipped: under config/ as shipped, differences reported
 * for information only (exit 0). Never calls the API.
 */
function evalSamples(path: string, shipped: EngineConfig, useShipped: boolean): boolean {
  const file = readSampleFile(path);
  const sample = buildSampleConfig(shipped, file.config_used); // validates config_used in both modes
  const config = useShipped ? shipped : sample.config;
  const overrides = sample.overrides.length ? sample.overrides.join(", ") : "none";
  console.log(`Sample file: ${path}`);
  console.log(`  ${file.vehicles.length} vehicles; generated ${file.generated} -> as_of_year ${file.as_of_year}; market fit: offline fallback (no API calls)`);
  console.log(
    useShipped
      ? `Config: config/ as shipped (weights v${shipped.weights.version}). NOT applied: the file's config_used ` +
          `(weights v${sample.config.weights.version}; ${overrides}).\n` +
          `  expected_offline was computed with config_used, so differences below are informational.`
      : `Config: config/ + the file's config_used, in memory (weights v${sample.config.weights.version}; overrides: ${overrides})`,
  );
  console.log("");
  const results = runSamples(file, config);
  for (const line of formatSampleResults(results)) console.log(line);
  const passed = results.filter((r) => r.mismatches.length === 0).length;
  const total = results.length;
  console.log(
    useShipped
      ? `\n${passed}/${total} match expected_offline under the shipped config, ${total - passed} differ (informational; exit code 0)`
      : `\n${passed}/${total} PASS${passed < total ? `, ${total - passed} FAIL` : ""}`,
  );
  return useShipped || passed === total;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "") {
    (args.command ? console.log : console.error)(USAGE);
    return args.command ? 0 : 1;
  }
  if (args.useShippedConfig && args.command !== "samples") {
    throw new UsageError("--use-shipped-config only applies to the samples command");
  }
  loadDotEnv();
  const config = loadConfig();
  const opts: MarketFitOptions = { offline: args.offline, asOfYear: args.asOfYear ?? new Date().getFullYear() };

  switch (args.command) {
    case "decide":
    case "explain":
    case "market": {
      if (args.files.length > 1) throw new UsageError(`${args.command} takes one file, got ${args.files.length}`);
      const record = readRecord(resolveOne(args.files[0]));
      if (args.command === "market") {
        console.log(JSON.stringify(await scoreMarketFit(record, config, opts), null, 2));
        return 0;
      }
      const { decision } = await run(record, config, opts);
      console.log(args.command === "decide" ? JSON.stringify(decision, null, 2) : renderExplainTable(decision, config));
      return 0;
    }
    case "eval":
      if (args.files.length > 0) throw new UsageError("eval takes no file arguments");
      return (await evalExamples(config, args.offline)) ? 0 : 1;
    case "samples":
      if (args.files.length > 1) throw new UsageError(`samples takes one file, got ${args.files.length}`);
      if (args.asOfYear !== undefined) {
        throw new UsageError('samples takes its as-of year from the file\'s "generated" date; drop --as-of');
      }
      return evalSamples(resolveOne(args.files[0]), config, args.useShippedConfig) ? 0 : 1;
    default:
      throw new UsageError(`Unknown command "${args.command}"`);
  }
}

// Run only when executed directly (tsx src/cli.ts), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      const known = e instanceof InputError || e instanceof ConfigError || e instanceof UsageError;
      console.error(known ? `Error: ${(e as Error).message}` : e);
      if (e instanceof UsageError) console.error(`\n${USAGE}`);
      process.exitCode = 1;
    },
  );
}
