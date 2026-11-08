// Disk cache for market-fit API results: one JSON file per vehicle profile, 7-day TTL.
// Only results that came back from the API are stored (including "insufficient" ones, so a
// thin-data profile is not re-billed); fallbacks after errors or without a key never are.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "./config.js";
import type { NormalizedRecord } from "./input.js";

export const DEFAULT_CACHE_DIR = join(PACKAGE_ROOT, ".cache", "market");
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ODOMETER_BAND_MILES = 25_000;
const ENTRY_VERSION = 1;

/** The validated model judgment, as stored. Signals are text for explanation only. */
const AnalysisSchema = z.object({
  acv: z.number().min(-1).max(1),
  copart: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.object({ claim: z.string(), url: z.string() })),
  insufficient: z.boolean(),
  model: z.string(),
});
export type MarketAnalysis = z.infer<typeof AnalysisSchema>;

const EntrySchema = z.object({
  version: z.literal(ENTRY_VERSION),
  profile: z.string(),
  created_at: z.string(),
  analysis: AnalysisSchema,
});

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

/** Human-readable cache key: year|make|model|trim|odometer band|title brand|run status, lower-cased. */
export function profileKey(record: NormalizedRecord): string {
  const d = record.decoded;
  return [d.year, d.make, d.model, d.trim, odometerBand(record.odometer), record.title.brand, record.runs_drives]
    .map((v) => (v === null ? "unknown" : String(v).trim()))
    .join("|")
    .toLowerCase();
}

/** opts.cacheDir, else $MARKET_CACHE_DIR (if non-empty), else packages/engine/.cache/market. */
export function resolveCacheDir(cacheDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cacheDir || env.MARKET_CACHE_DIR || DEFAULT_CACHE_DIR;
}

function entryPath(dir: string, profile: string): string {
  return join(dir, `${createHash("sha256").update(profile).digest("hex")}.json`);
}

/** The cached analysis for this profile, or null when missing, expired, or unreadable. */
export function readMarketCache(dir: string, record: NormalizedRecord, now: Date): CacheHit | null {
  const profile = profileKey(record);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(entryPath(dir, profile), "utf8"));
  } catch {
    return null; // missing or corrupt: treat as a miss
  }
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.profile !== profile) return null;
  const created = new Date(parsed.data.created_at);
  const age = now.getTime() - created.getTime();
  if (Number.isNaN(age) || age >= CACHE_TTL_MS) return null;
  return { analysis: parsed.data.analysis, created_at: created };
}

/** Store an analysis. Writes a temp file then renames it, so readers never see half a file. */
export function writeMarketCache(dir: string, record: NormalizedRecord, analysis: MarketAnalysis, now: Date): void {
  const profile = profileKey(record);
  const path = entryPath(dir, profile);
  const entry = { version: ENTRY_VERSION, profile, created_at: now.toISOString(), analysis };
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
