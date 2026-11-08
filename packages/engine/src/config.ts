// Loads and validates config/*.json at runtime (edit the JSON, no rebuild needed),
// and takes the code sets from RULES.md's `yaml codesets` block when that file exists.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CATEGORIES, FLAG_NAMES, FLAG_VALUES, RUN_STATUSES, TITLE_BRANDS } from "./types.js";

/** packages/engine */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_DIR = join(PACKAGE_ROOT, "config");

const Score = z.number().min(-1).max(1);
const Confidence = z.number().min(0).max(1);
const Row = z.object({ acv: Score, copart: Score, confidence: Confidence.optional() });
const TitleRow = z.object({
  acv: z.union([Score, z.literal("excluded")]),
  copart: z.union([Score, z.literal("excluded")]),
  confidence: Confidence.optional(),
});

/** Variables a market_fit_fallback rule may name (marketFitFallback binds exactly these). */
export const FALLBACK_RULE_VARS: readonly string[] = ["age_years", "odometer"];
/** One comparison, `name op number`: the grammar evaluateRule() in marketFit.ts accepts. */
const RULE_COMPARISON = /^\s*([a-z_][a-z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/i;

/**
 * Why a fallback rule would make evaluateRule() throw, or null when it is fine. Checks every
 * comparison (no short-circuit), so a typo fails at load time rather than only for the vehicles
 * that happen to reach it.
 */
export function fallbackRuleProblem(rule: string): string | null {
  const text = rule.trim();
  if (text === "otherwise") return null;
  for (const conj of text.split(/\s+or\s+/)) {
    for (const cmp of conj.split(/\s+and\s+/)) {
      const m = RULE_COMPARISON.exec(cmp);
      if (!m) return `cannot parse "${cmp.trim()}" (expected e.g. "age_years <= 6 and odometer < 100000" or "otherwise")`;
      if (!FALLBACK_RULE_VARS.includes(m[1]!)) {
        return `unknown variable "${m[1]}" (allowed: ${FALLBACK_RULE_VARS.join(", ")})`;
      }
    }
  }
  return null;
}

const FallbackRow = z.object({ rule: z.string(), acv: Score, copart: Score });
const FallbackTable = z
  .object({ confidence: Confidence })
  .catchall(z.union([FallbackRow, Confidence]))
  .superRefine((table, ctx) => {
    let otherwise = 0;
    for (const [name, row] of Object.entries(table)) {
      if (name === "confidence" || typeof row !== "object") continue;
      if (row.rule.trim() === "otherwise") {
        otherwise++;
        continue;
      }
      const problem = fallbackRuleProblem(row.rule);
      if (problem) ctx.addIssue({ code: "custom", path: [name, "rule"], message: `${problem} in rule "${row.rule}"` });
    }
    if (otherwise !== 1) {
      ctx.addIssue({ code: "custom", path: [], message: `needs exactly one row with rule "otherwise", found ${otherwise}` });
    }
  });

const ScoringSchema = z.object({
  description: z.string(),
  title: z.object(Object.fromEntries(TITLE_BRANDS.map((b) => [b, TitleRow])) as Record<
    (typeof TITLE_BRANDS)[number],
    typeof TitleRow
  >),
  drivable: z.object({
    ...(Object.fromEntries(RUN_STATUSES.map((s) => [s, Row])) as Record<(typeof RUN_STATUSES)[number], typeof Row>),
    severe_code_modifier: z.object({ acv: z.number(), copart: z.number() }),
  }),
  hidden_risk: z.object({
    counts: z.array(z.enum(FLAG_NAMES)),
    count_as_risk: z.array(z.enum(FLAG_VALUES)),
    by_count: z.object({ "0": Row, "1": Row, "2": Row, "3+": Row }),
    yes_means: z.string().optional(),
  }),
  market_fit_fallback: FallbackTable,
});
export type ScoringConfig = z.infer<typeof ScoringSchema>;

const WeightsSchema = z.object({
  version: z.number().int(),
  description: z.string(),
  weights: z.object(
    Object.fromEntries(CATEGORIES.map((c) => [c, z.number().min(0)])) as Record<
      (typeof CATEGORIES)[number],
      z.ZodNumber
    >,
  ),
  temperature: z.number().positive(),
  clear_threshold: z.number().gt(0.5).max(1),
});
export type WeightsConfig = z.infer<typeof WeightsSchema>;

const CodesetsFileSchema = z
  .object({
    severe_when: z.array(z.string().min(1)),
    description: z.string().optional(),
  })
  .catchall(z.array(z.string()));

export interface CodesetsConfig {
  /** Set name -> codes (upper case). */
  sets: Record<string, string[]>;
  /** Each entry is set names joined by "+"; it holds when every named set has a confirmed code. */
  severe_when: string[][];
  /** Where each set's list came from. */
  set_sources: Record<string, string>;
  /** Path of the RULES.md file used, or null when only codesets.json was used. */
  rules_md_path: string | null;
}

export interface EngineConfig {
  scoring: ScoringConfig;
  weights: WeightsConfig;
  codesets: CodesetsConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseWith<T>(raw: unknown, schema: z.ZodType<T>, source: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid ${source}: ${issues}`);
  }
  return parsed.data;
}

/** JSON.parse that ignores a leading UTF-8 byte-order mark (files saved by Windows editors). */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  return parseWith(raw, schema, path);
}

/** Validate an in-memory scoring.json object (e.g. one built from overrides). Throws ConfigError. */
export function parseScoring(raw: unknown, source = "scoring config"): ScoringConfig {
  return parseWith(raw, ScoringSchema, source);
}

/** Validate an in-memory weights.json object (e.g. one built from overrides). Throws ConfigError. */
export function parseWeights(raw: unknown, source = "weights config"): WeightsConfig {
  return parseWith(raw, WeightsSchema, source);
}

/**
 * Where to look for RULES.md, in order: $UNDERSCOPE_RULES_PATH, packages/engine/rules/rules.md
 * (the location the build spec names), then RULES.md / rules.md in packages/engine and each
 * parent directory up to the repo root: the first directory holding pnpm-workspace.yaml or .git
 * (the repo keeps RULES.md there today). Never above the repo root, so a stray RULES.md in an
 * enclosing checkout cannot change the code sets; without a repo root only packages/engine is
 * searched. A relative $UNDERSCOPE_RULES_PATH is read from where pnpm was run ($INIT_CWD), like
 * the CLI's file arguments, then from the current directory. "" or "none" disables RULES.md.
 */
export function findRulesMd(env: NodeJS.ProcessEnv = process.env, packageRoot = PACKAGE_ROOT): string | null {
  const override = env.UNDERSCOPE_RULES_PATH;
  if (override !== undefined) {
    if (override === "" || override === "none") return null;
    const tries = isAbsolute(override)
      ? [override]
      : [...new Set([...(env.INIT_CWD ? [resolve(env.INIT_CWD, override)] : []), resolve(override)])];
    const hit = tries.find((p) => existsSync(p));
    if (!hit) throw new ConfigError(`UNDERSCOPE_RULES_PATH points to a missing file: ${override} (looked for ${tries.join(", ")})`);
    return resolve(hit);
  }
  const dirs: string[] = [];
  let repoRootFound = false;
  for (let dir = packageRoot; ; ) {
    dirs.push(dir);
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git"))) {
      repoRootFound = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const searched = repoRootFound ? dirs : [packageRoot];
  const candidates = [join(packageRoot, "rules", "rules.md"), ...searched.flatMap((d) => [join(d, "RULES.md"), join(d, "rules.md")])];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Parse the fenced ```yaml codesets block of RULES.md. Lines look like
 * `MISFIRE: [P0300, P0301]  # optional comment`. Returns null when there is no such block.
 */
export function parseRulesCodesets(markdown: string, path = "RULES.md"): Record<string, string[]> | null {
  const block = /^```yaml codesets[ \t]*\r?\n([\s\S]*?)^```/m.exec(markdown);
  if (!block) return null;
  const sets: Record<string, string[]> = {};
  for (const rawLine of (block[1] ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*)\]$/.exec(line);
    if (!m) throw new ConfigError(`${path}: cannot parse codesets line: ${rawLine.trim()}`);
    const codes = (m[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/^["']|["']$/g, "").toUpperCase())
      .filter((c) => c !== "");
    sets[m[1]!] = codes;
  }
  return sets;
}

export function loadCodesets(configDir = DEFAULT_CONFIG_DIR, env: NodeJS.ProcessEnv = process.env): CodesetsConfig {
  const file = readJson(join(configDir, "codesets.json"), CodesetsFileSchema);
  const sets: Record<string, string[]> = {};
  const set_sources: Record<string, string> = {};
  for (const [name, value] of Object.entries(file)) {
    if (name === "severe_when" || name === "description" || !Array.isArray(value)) continue;
    sets[name] = value.map((c) => c.toUpperCase());
    set_sources[name] = "config/codesets.json";
  }
  const rulesPath = findRulesMd(env);
  let rules_md_path: string | null = null;
  if (rulesPath) {
    const fromRules = parseRulesCodesets(readFileSync(rulesPath, "utf8"), rulesPath);
    if (fromRules) {
      rules_md_path = rulesPath;
      for (const [name, codes] of Object.entries(fromRules)) {
        sets[name] = codes;
        set_sources[name] = rulesPath;
      }
    }
  }
  const severe_when = file.severe_when.map((entry) => entry.split("+").map((s) => s.trim()));
  for (const entry of severe_when) {
    for (const name of entry) {
      if (!sets[name]) throw new ConfigError(`codesets: severe_when names unknown set "${name}"`);
    }
  }
  return { sets, severe_when, set_sources, rules_md_path };
}

export function loadConfig(configDir = DEFAULT_CONFIG_DIR, env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    scoring: readJson(join(configDir, "scoring.json"), ScoringSchema),
    weights: readJson(join(configDir, "weights.json"), WeightsSchema),
    codesets: loadCodesets(configDir, env),
  };
}
