// Disk cache for market-fit API results: one JSON file per provider, model and vehicle profile,
// 7-day TTL. Only results that came back from the API are stored (including "insufficient" ones,
// so a thin-data profile is not re-billed); fallbacks after errors or without a key never are.
//
// The provider and model are part of the key and of the stored entry, so an OpenAI answer is never
// served as an Anthropic one (or one model's answer as another's). Entries written before the
// provider existed (version 1, no provider) are legacy: they simply miss.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "./config.js";
import type { NormalizedRecord } from "./input.js";
import { MARKET_PROVIDERS, type MarketProvider } from "./types.js";

export const DEFAULT_CACHE_DIR = join(PACKAGE_ROOT, ".cache", "market");
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ODOMETER_BAND_MILES = 25_000;
/** 2: provider and model in the key and the entry (version 1 entries are legacy and miss). */
const ENTRY_VERSION = 2;

/** The validated model judgment, as stored. Signals are text for explanation only. */
const AnalysisSchema = z.object({
  acv: z.number().min(-1).max(1),
  copart: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.object({ claim: z.string(), url: z.string() })),
  insufficient: z.boolean(),
  provider: z.enum(MARKET_PROVIDERS),
  model: z.string(),
});
export type MarketAnalysis = z.infer<typeof AnalysisSchema>;

const EntrySchema = z.object({
  version: z.literal(ENTRY_VERSION),
  provider: z.enum(MARKET_PROVIDERS),
  model: z.string(),
  profile: z.string(),
  created_at: z.string(),
  analysis: AnalysisSchema,
});

/** Which API and model a cache entry belongs to. */
export interface CacheSource {
  provider: MarketProvider;
  model: string;
}

export interface CacheHit {
  analysis: MarketAnalysis;
  created_at: Date;
}

/** "50000-74999" for 62,000 mi; "unknown" when the odometer is missing. */
export function odometerBand(odometer: number | null): string {
  if (odometer === null) return "unknown";
  const lo = Math.floor(odometer / ODOMETER_BAND_MILES) * ODOMETER_BAND_MILES;
  return `${lo}-${lo + ODOMETER_BAND_MILES - 1}`;
}

/** Human-readable vehicle profile: year|make|model|trim|odometer band|title brand|run status, lower-cased. */
export function profileKey(record: NormalizedRecord): string {
  const d = record.decoded;
  return [d.year, d.make, d.model, d.trim, odometerBand(record.odometer), record.title.brand, record.runs_drives]
    .map((v) => (v === null ? "unknown" : String(v).trim()))
    .join("|")
    .toLowerCase();
}

/** The full cache key: provider|model|profile, e.g. "openai|gpt-5.4-mini|2022|ford|f-150|...". The model id is kept as given. */
export function cacheKey(record: NormalizedRecord, source: CacheSource): string {
  return `${source.provider}|${source.model}|${profileKey(record)}`;
}

/** opts.cacheDir, else $MARKET_CACHE_DIR (if non-empty), else packages/engine/.cache/market. */
export function resolveCacheDir(cacheDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cacheDir || env.MARKET_CACHE_DIR || DEFAULT_CACHE_DIR;
}

function entryPath(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

/**
 * The cached analysis for this provider, model and profile, or null when missing, expired,
 * unreadable, legacy (no provider) or written for another provider or model.
 */
export function readMarketCache(dir: string, record: NormalizedRecord, now: Date, source: CacheSource): CacheHit | null {
  const profile = profileKey(record);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(entryPath(dir, cacheKey(record, source)), "utf8"));
  } catch {
    return null; // missing or corrupt: treat as a miss
  }
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const sameSource = e.provider === source.provider && e.model === source.model;
  if (!sameSource || e.profile !== profile || e.analysis.provider !== e.provider || e.analysis.model !== e.model) {
    return null;
  }
  const created = new Date(e.created_at);
  const age = now.getTime() - created.getTime();
  if (Number.isNaN(age) || age >= CACHE_TTL_MS) return null;
  return { analysis: e.analysis, created_at: created };
}

/**
 * Store an analysis under its own provider and model (analysis.provider, analysis.model). Writes
 * a temp file then renames it, so readers never see half a file.
 */
export function writeMarketCache(dir: string, record: NormalizedRecord, analysis: MarketAnalysis, now: Date): void {
  const source: CacheSource = { provider: analysis.provider, model: analysis.model };
  const path = entryPath(dir, cacheKey(record, source));
  const entry = {
    version: ENTRY_VERSION,
    provider: source.provider,
    model: source.model,
    profile: profileKey(record),
    created_at: now.toISOString(),
    analysis,
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
