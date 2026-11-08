// sample_vehicles.json support. The file (written by the user, kept at the repo root) holds
// records with `expected_offline` answers computed under its own `config_used`. This module
// parses it, builds that config IN MEMORY from config/ as shipped plus the overrides (config/
// is never edited), runs every record offline (market-fit fallback table, no API calls) with
// the as-of year taken from the file's "generated" date, and compares with the expectations.
//
// config_used keys:
//   "weights": { version, temperature, clear_threshold, title, drivable, hidden_risk, market_fit }
//       -> weights.json fields (the four category weights go under weights.json's "weights").
//       A top-level "weights.<field>" key works the same way.
//   "a.b.c": value -> replaces that existing path in scoring.json (e.g. "drivable.severe_code_modifier").
//   "note" -> ignored. Anything else -> ConfigError.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { CONFIRM_TITLE, decideWithMarket } from "./combine.js";
import { ConfigError, parseJsonText, parseScoring, parseWeights, type EngineConfig } from "./config.js";
import { InputError, normalizeRecord, type NormalizedRecord } from "./input.js";
import { marketFitFallback } from "./marketFit.js";
import { CATEGORIES, FLAG_NAMES, OPTIONS, type Decision } from "./types.js";

/** Expected probabilities are rounded to 2 decimals in the file. */
export const SAMPLE_P_TOLERANCE = 0.006;

const Probability = z.number().min(0).max(1);

const ExpectedOfflineSchema = z.object({
  recommendation: z.enum(OPTIONS).nullable(),
  probabilities: z.object({ acv: Probability, copart: Probability }),
  confidence: z.enum(["clear", "close_call", "insufficient"]),
  verify_first: z.union([z.enum(FLAG_NAMES), z.literal(CONFIRM_TITLE)]).nullable(),
});
export type ExpectedOffline = z.infer<typeof ExpectedOfflineSchema>;

const SampleFileSchema = z.object({
  description: z.string(),
  generated: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "expected a date such as 2026-11-07"),
  config_used: z.record(z.string(), z.unknown()),
  vehicles: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string(),
        record: z.unknown(),
        expected_offline: ExpectedOfflineSchema,
      }),
    )
    .min(1),
});

export interface SampleVehicle {
  id: string;
  description: string;
  record: NormalizedRecord;
  expected: ExpectedOffline;
}

export interface SampleFile {
  description: string;
  generated: string;
  /** Year of `generated`; every record is run with this as-of year. */
  as_of_year: number;
  config_used: Record<string, unknown>;
  vehicles: SampleVehicle[];
}

/** Validate a parsed sample file and normalize every record. Throws InputError. */
export function parseSampleFile(raw: unknown, source = "sample file"): SampleFile {
  const parsed = SampleFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new InputError(`Invalid ${source}: ${issues}`);
  }
  const f = parsed.data;
  const seen = new Set<string>();
  const vehicles = f.vehicles.map((v, i): SampleVehicle => {
    if (seen.has(v.id)) throw new InputError(`${source}: duplicate vehicle id "${v.id}"`);
    seen.add(v.id);
    let record: NormalizedRecord;
    try {
      record = normalizeRecord(v.record);
    } catch (e) {
      if (e instanceof InputError) throw new InputError(`${source}: vehicles.${i} (${v.id}): ${e.message}`);
      throw e;
    }
    return { id: v.id, description: v.description, record, expected: v.expected_offline };
  });
  return {
    description: f.description,
    generated: f.generated,
    as_of_year: Number(f.generated.slice(0, 4)),
    config_used: f.config_used,
    vehicles,
  };
}

export function readSampleFile(path: string): SampleFile {
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InputError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  return parseSampleFile(raw, path);
}

const WEIGHTS_TOP_LEVEL = ["version", "temperature", "clear_threshold"] as const;
const WEIGHT_KEYS: readonly string[] = [...WEIGHTS_TOP_LEVEL, ...CATEGORIES];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The config a sample file was computed with: a deep copy of `shipped` (config/ as loaded) with
 * `config_used` applied, validated like the JSON files. `shipped` is not modified; code sets
 * stay as shipped. Returns the applied override keys (in file order) for reporting.
 */
export function buildSampleConfig(
  shipped: EngineConfig,
  configUsed: Record<string, unknown>,
): { config: EngineConfig; overrides: string[] } {
  const weights = structuredClone(shipped.weights) as unknown as Record<string, unknown> & {
    weights: Record<string, unknown>;
  };
  const scoring = structuredClone(shipped.scoring) as unknown as Record<string, unknown>;
  const overrides: string[] = [];

  const setWeight = (field: string, value: unknown) => {
    if ((WEIGHTS_TOP_LEVEL as readonly string[]).includes(field)) weights[field] = value;
    else if ((CATEGORIES as readonly string[]).includes(field)) weights.weights[field] = value;
    else throw new ConfigError(`config_used: unknown weights key "weights.${field}" (allowed: ${WEIGHT_KEYS.join(", ")})`);
    overrides.push(`weights.${field}`);
  };

  const setScoringPath = (key: string, value: unknown) => {
    const path = key.split(".");
    let node: Record<string, unknown> = scoring;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      if (seg === "" || !Object.hasOwn(node, seg)) {
        throw new ConfigError(
          `config_used: unknown key "${key}" (not "note", not a weights key, and not an existing path in scoring.json)`,
        );
      }
      if (i === path.length - 1) {
        node[seg] = structuredClone(value);
        break;
      }
      const next = node[seg];
      if (!isObject(next)) throw new ConfigError(`config_used: "${key}": scoring.json ${path.slice(0, i + 1).join(".")} is not an object`);
      node = next;
    }
    overrides.push(key);
  };

  for (const [key, value] of Object.entries(configUsed)) {
    if (key === "note") continue;
    if (key === "weights") {
      if (!isObject(value)) throw new ConfigError(`config_used.weights must be an object`);
      for (const [field, v] of Object.entries(value)) setWeight(field, v);
    } else if (key.startsWith("weights.")) {
      setWeight(key.slice("weights.".length), value);
    } else {
      setScoringPath(key, value);
    }
  }

  return {
    config: {
      scoring: parseScoring(scoring, "scoring config (config/scoring.json + config_used)"),
      weights: parseWeights(weights, "weights config (config/weights.json + config_used)"),
      codesets: shipped.codesets,
    },
    overrides,
  };
}

export interface SampleResult {
  id: string;
  description: string;
  decision: Decision;
  expected: ExpectedOffline;
  /** Human-readable mismatches; [] when the decision matches. */
  mismatches: string[];
}

/** Exact recommendation / confidence / verify_first; probabilities within SAMPLE_P_TOLERANCE. */
export function compareSample(expected: ExpectedOffline, d: Decision): string[] {
  const show = (v: string | null) => v ?? "none";
  const out: string[] = [];
  if (expected.recommendation !== d.recommendation) {
    out.push(`recommendation: expected ${show(expected.recommendation)}, got ${show(d.recommendation)}`);
  }
  if (expected.confidence !== d.confidence) out.push(`confidence: expected ${expected.confidence}, got ${d.confidence}`);
  if (expected.verify_first !== d.verify_first) {
    out.push(`verify_first: expected ${show(expected.verify_first)}, got ${show(d.verify_first)}`);
  }
  for (const o of OPTIONS) {
    if (Math.abs(expected.probabilities[o] - d.probabilities[o]) > SAMPLE_P_TOLERANCE) {
      out.push(`p_${o}: expected ${expected.probabilities[o]} ± ${SAMPLE_P_TOLERANCE}, got ${d.probabilities[o].toFixed(4)}`);
    }
  }
  return out;
}

/** Decide every vehicle offline (fallback market fit, the file's as-of year) and compare. Pure: no API, no I/O. */
export function runSamples(file: SampleFile, config: EngineConfig): SampleResult[] {
  return file.vehicles.map((v) => {
    const market = marketFitFallback(v.record, config, file.as_of_year, "offline mode");
    const decision = decideWithMarket(v.record, config, market);
    return { id: v.id, description: v.description, decision, expected: v.expected, mismatches: compareSample(v.expected, decision) };
  });
}

/** One line per vehicle (id, recommendation, P(ACV), confidence, verify_first, PASS/FAIL) plus mismatch lines. */
export function formatSampleResults(results: SampleResult[]): string[] {
  const idWidth = Math.max(...results.map((r) => r.id.length));
  const lines: string[] = [];
  for (const r of results) {
    const d = r.decision;
    lines.push(
      [
        r.id.padEnd(idWidth),
        (d.recommendation ?? "none").padEnd(6),
        `P(ACV) ${d.probabilities.acv.toFixed(4)}`,
        d.confidence.padEnd(12),
        `verify_first ${d.verify_first ?? "none"}`.padEnd(32),
        r.mismatches.length ? "FAIL" : "PASS",
      ].join("  "),
    );
    for (const m of r.mismatches) lines.push(`${" ".repeat(idWidth + 2)}${m}`);
  }
  return lines;
}
