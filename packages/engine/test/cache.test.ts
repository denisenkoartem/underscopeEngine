import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  DEFAULT_CACHE_DIR,
  cacheKey,
  odometerBand,
  profileKey,
  readMarketCache,
  resolveCacheDir,
  writeMarketCache,
  type MarketAnalysis,
} from "../src/cache.js";
import { normalizeRecord } from "../src/input.js";

const record = normalizeRecord({
  vin: "1FTFW1E50NFA00001",
  decoded: { year: 2022, make: "Ford", model: "F-150", trim: "XLT" },
  odometer: 40_000,
  title: { brand: "clean" },
  runs_drives: "run_and_drive",
});

const analysis: MarketAnalysis = {
  acv: 0.6,
  copart: -0.2,
  confidence: 0.7,
  signals: [{ claim: "Many listings", url: "https://example.com/a" }],
  insufficient: false,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
};
/** The provider and model the analysis above was written for. */
const SRC = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "underscope-cache-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cache keys", () => {
  it("buckets the odometer by 25,000 miles", () => {
    expect(odometerBand(0)).toBe("0-24999");
    expect(odometerBand(24_999)).toBe("0-24999");
    expect(odometerBand(25_000)).toBe("25000-49999");
    expect(odometerBand(62_000)).toBe("50000-74999");
    expect(odometerBand(null)).toBe("unknown");
  });

  it("keys on year|make|model|trim|band|title|run status, lower-cased, unknown for missing", () => {
    expect(profileKey(record)).toBe("2022|ford|f-150|xlt|25000-49999|clean|run_and_drive");
    const sparse = normalizeRecord({ decoded: { year: 2012, make: "Ram" } });
    expect(profileKey(sparse)).toBe("2012|ram|unknown|unknown|unknown|unknown|unknown");
  });

  it("the full key adds provider and model in front of the profile", () => {
    expect(cacheKey(record, SRC)).toBe("anthropic|claude-sonnet-5-5|2022|ford|f-150|xlt|25000-49999|clean|run_and_drive");
    expect(cacheKey(record, { provider: "openai", model: "gpt-5.4-mini" })).toBe(
      "openai|gpt-5.4-mini|2022|ford|f-150|xlt|25000-49999|clean|run_and_drive",
    );
  });

  it("resolves the directory: option, then MARKET_CACHE_DIR, then the default", () => {
    expect(resolveCacheDir("/x", { MARKET_CACHE_DIR: "/y" })).toBe("/x");
    expect(resolveCacheDir(undefined, { MARKET_CACHE_DIR: "/y" })).toBe("/y");
    expect(resolveCacheDir(undefined, { MARKET_CACHE_DIR: "" })).toBe(DEFAULT_CACHE_DIR);
  });
});

describe("cache read/write", () => {
  const t0 = new Date("2026-11-01T12:00:00Z");

  it("round-trips within the TTL and leaves no temp files", () => {
    const dir = tempDir();
    writeMarketCache(dir, record, analysis, t0);
    const hit = readMarketCache(dir, record, new Date(t0.getTime() + CACHE_TTL_MS - 1), SRC);
    expect(hit?.analysis).toEqual(analysis);
    expect(hit?.created_at.toISOString()).toBe(t0.toISOString());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("shares an entry within an odometer band and misses across bands", () => {
    const dir = tempDir();
    writeMarketCache(dir, record, analysis, t0);
    expect(readMarketCache(dir, { ...record, odometer: 49_999 }, t0, SRC)).not.toBeNull();
    expect(readMarketCache(dir, { ...record, odometer: 50_000 }, t0, SRC)).toBeNull();
    expect(readMarketCache(dir, { ...record, runs_drives: "no" }, t0, SRC)).toBeNull();
  });

  it("expires after 7 days", () => {
    const dir = tempDir();
    writeMarketCache(dir, record, analysis, t0);
    expect(readMarketCache(dir, record, new Date(t0.getTime() + CACHE_TTL_MS), SRC)).toBeNull();
  });

  it("ignores missing directories and corrupt or foreign files", () => {
    const dir = tempDir();
    expect(readMarketCache(join(dir, "nope"), record, t0, SRC)).toBeNull();
    writeMarketCache(dir, record, analysis, t0);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), "{ not json");
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
    writeFileSync(join(dir, file!), JSON.stringify({ version: 2, ...SRC, profile: profileKey(record), created_at: t0 }));
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
    // Out-of-range scores in a hand-edited file are rejected, not clamped.
    const bad = { version: 2, ...SRC, profile: profileKey(record), created_at: t0, analysis: { ...analysis, acv: 3 } };
    writeFileSync(join(dir, file!), JSON.stringify(bad));
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
  });
});

describe("cache entries are per provider and model", () => {
  const t0 = new Date("2026-11-01T12:00:00Z");

  it("an OpenAI entry is never served to Anthropic (or another model), and both can coexist", () => {
    const dir = tempDir();
    const openai: MarketAnalysis = { ...analysis, acv: -0.4, provider: "openai", model: "gpt-5.4-mini" };
    writeMarketCache(dir, record, openai, t0);
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
    expect(readMarketCache(dir, record, t0, { provider: "openai", model: "gpt-5.5" })).toBeNull();
    expect(readMarketCache(dir, record, t0, { provider: "openai", model: "gpt-5.4-mini" })?.analysis).toEqual(openai);
    writeMarketCache(dir, record, analysis, t0);
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readMarketCache(dir, record, t0, SRC)?.analysis).toEqual(analysis);
    expect(readMarketCache(dir, record, t0, { provider: "openai", model: "gpt-5.4-mini" })?.analysis.acv).toBe(-0.4);
  });

  it("stores provider and model in the entry; a legacy entry (version 1, no provider) misses", () => {
    const dir = tempDir();
    writeMarketCache(dir, record, analysis, t0);
    const [file] = readdirSync(dir);
    const entry = JSON.parse(readFileSync(join(dir, file!), "utf8"));
    expect(entry).toMatchObject({ version: 2, provider: "anthropic", model: "claude-sonnet-5-5", profile: profileKey(record) });
    const { provider: _p, ...legacyAnalysis } = analysis;
    writeFileSync(
      join(dir, file!),
      JSON.stringify({ version: 1, profile: profileKey(record), created_at: t0, analysis: legacyAnalysis }),
    );
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
    // An entry whose stored provider disagrees with the file it sits in is not trusted either.
    writeFileSync(join(dir, file!), JSON.stringify({ ...entry, provider: "openai" }));
    expect(readMarketCache(dir, record, t0, SRC)).toBeNull();
  });
});
