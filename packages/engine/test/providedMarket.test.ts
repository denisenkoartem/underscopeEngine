// The input record's own market_fit block (written by the free-text parser): validation, the
// "provided" market-fit path (no Anthropic call, no cache, also offline), the insufficient
// fall-through, and a full parser-shaped record through normalizeRecord + decide --offline.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { decide } from "../src/combine.js";
import { loadConfig } from "../src/config.js";
import { renderExplainTable } from "../src/explain.js";
import {
  InputError,
  MAX_MARKET_SIGNALS,
  MarketFitBlockSchema,
  normalizeRecord,
  type ConditionRecordInput,
  type MarketFitBlockInput,
} from "../src/input.js";
import { scoreMarketFit, type MarketFitOptions, type MessagesClient } from "../src/marketFit.js";

const config = loadConfig();

const BLOCK = {
  acv: 0.6,
  copart: -0.2,
  confidence: 0.8,
  signals: [
    { claim: "Retail listings for 2019 F-150 XLTs ask around $31,500", url: "https://www.example.com/f150" },
    { claim: "A claim the model could not cite", url: "" },
    { claim: "Copart sold similar trucks for about $14,000", url: "https://data.example.org/copart" },
  ],
  insufficient: false,
  provider: "gemini-3.8-flash + Google Search",
  generated_at: "2026-11-07T19:00:00Z",
} satisfies MarketFitBlockInput;

const NO_FLAGS = { frame: "no", airbag: "no", flood: "no", module_no_comm: "no", monitors_incomplete: "no" } as const;
const BASE: ConditionRecordInput = {
  decoded: { year: 2019, make: "Ford", model: "F-150", trim: "XLT" },
  odometer: 88000,
  location_state: "TX",
  title: { brand: "clean" },
  runs_drives: "run_and_drive",
  flags: NO_FLAGS,
  codes: [],
};
const rec = (patch: Partial<ConditionRecordInput> = {}) => normalizeRecord({ ...BASE, ...patch });

let dir: string | undefined;
const tempDir = (): string => (dir = mkdtempSync(join(tmpdir(), "underscope-provided-")));
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A client that fails the test if anything calls it, plus options that would reach the API without a provided block. */
function apiReadyOptions(extra: Partial<MarketFitOptions> = {}) {
  const calls: unknown[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        throw new Error("fake client: the Anthropic API must not be called");
      },
    },
  };
  const lines: string[] = [];
  const cacheDir = join(tempDir(), "cache");
  const opts: MarketFitOptions = {
    client,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    asOfYear: 2026,
    now: new Date("2026-11-07T20:00:00Z"),
    cacheDir,
    log: (l) => lines.push(l),
    ...extra,
  };
  return { opts, calls, lines, cacheDir };
}

const PROVIDED_FACTORS = [
  "Provided market analysis favors ACV (ACV +0.60, Copart -0.20, confidence 0.80; gemini-3.8-flash + Google Search, generated 2026-11-07)",
  "2 cited signal(s): example.com, data.example.org",
];
const KEPT_SIGNALS = [BLOCK.signals[0], BLOCK.signals[2]];

describe("market_fit block: input", () => {
  it("is kept on the normalized record and is not a missing vehicle field", () => {
    const r = rec({ market_fit: BLOCK });
    expect(r.provided_market_fit).toEqual(BLOCK);
    expect(r.missing).not.toContain("market_fit");
    expect(rec().provided_market_fit).toBeNull();
    expect(rec({ market_fit: null }).provided_market_fit).toBeNull();
  });

  it("a signal url of null or no url key means no URL (normalized to \"\"); a date-only generated_at is fine", () => {
    const r = rec({
      market_fit: { ...BLOCK, generated_at: "2026-11-07", signals: [{ claim: "a", url: null }, { claim: "b" }] },
    });
    expect(r.provided_market_fit?.signals).toEqual([
      { claim: "a", url: "" },
      { claim: "b", url: "" },
    ]);
  });

  it("rejects out-of-range values, bad shapes and unknown keys (InputError, never clamped)", () => {
    const sixSignals = Array.from({ length: MAX_MARKET_SIGNALS + 1 }, (_, i) => ({ claim: `c${i}`, url: `https://e.com/${i}` }));
    const { provider: _provider, ...noProvider } = BLOCK;
    const { acv: _acv, ...noAcv } = BLOCK;
    const bad: [unknown, RegExp][] = [
      [{ ...BLOCK, acv: 1.5 }, /market_fit\.acv: /],
      [{ ...BLOCK, copart: -1.01 }, /market_fit\.copart: /],
      [{ ...BLOCK, confidence: 1.2 }, /market_fit\.confidence: /],
      [{ ...BLOCK, confidence: -0.1 }, /market_fit\.confidence: /],
      [{ ...BLOCK, acv: "0.5" }, /market_fit\.acv: /],
      [noAcv, /market_fit\.acv: /],
      [{ ...BLOCK, insufficient: "no" }, /market_fit\.insufficient: /],
      [noProvider, /market_fit\.provider: /],
      [{ ...BLOCK, provider: "  " }, /market_fit\.provider: /],
      [{ ...BLOCK, generated_at: "yesterday" }, /market_fit\.generated_at: expected an ISO 8601 date/],
      [{ ...BLOCK, generated_at: "2026-13-01" }, /market_fit\.generated_at: /],
      [{ ...BLOCK, signals: sixSignals }, /market_fit\.signals: /],
      [{ ...BLOCK, signals: [{ claim: "x", url: "ftp://example.com/a" }] }, /market_fit\.signals\.0\.url: expected an http\(s\) URL/],
      [{ ...BLOCK, signals: [{ claim: "x", url: "example.com/a" }] }, /market_fit\.signals\.0\.url: /],
      [{ ...BLOCK, signals: [{ claim: " ", url: "https://e.com" }] }, /market_fit\.signals\.0\.claim: /],
      [{ ...BLOCK, signals: [{ claim: "x", url: "https://e.com", price: 31500 }] }, /market_fit\.signals\.0: Unrecognized key: "price"/],
      [{ ...BLOCK, price_estimate: 31500 }, /market_fit: Unrecognized key: "price_estimate"/],
      [[BLOCK], /market_fit: /],
    ];
    for (const [block, message] of bad) {
      const raw = { ...BASE, market_fit: block };
      expect(() => normalizeRecord(raw)).toThrow(InputError);
      expect(() => normalizeRecord(raw)).toThrow(message);
    }
  });

  it("the exported block schema is the one the record uses", () => {
    expect(MarketFitBlockSchema.safeParse(BLOCK).success).toBe(true);
    expect(MarketFitBlockSchema.safeParse({ ...BLOCK, acv: -2 }).success).toBe(false);
  });

  it("parser metadata: any object is accepted and ignored; a non-object is an error", () => {
    const parser = { model: "gemini-3.8-flash", anything: { nested: [1, 2] } };
    expect(rec({ parser })).toEqual(rec());
    for (const bad of [[], "gemini", 3]) {
      expect(() => normalizeRecord({ ...BASE, parser: bad })).toThrow(/parser: /);
    }
  });
});

describe("market fit from a provided block", () => {
  it("is used as is: source provided, signals copied without the URL-less one, no API call, no cache", async () => {
    const { opts, calls, lines, cacheDir } = apiReadyOptions();
    const m = await scoreMarketFit(rec({ market_fit: BLOCK }), config, opts);
    expect(m).toEqual({
      acv: 0.6,
      copart: -0.2,
      confidence: 0.8,
      factors: PROVIDED_FACTORS,
      excluded: [],
      source: "provided",
      signals: KEPT_SIGNALS,
    });
    expect(calls).toHaveLength(0);
    expect(existsSync(cacheDir)).toBe(false);
    expect(lines).toEqual(["market_fit: dropped 1 provided signal(s) without a claim or an http(s) URL"]);
  });

  it("factors carry no prices: claim text never enters them", async () => {
    const { opts } = apiReadyOptions();
    const m = await scoreMarketFit(rec({ market_fit: BLOCK }), config, opts);
    expect(m.factors.join(" ")).not.toMatch(/\$|31,500|14,000/);
  });

  it("works offline and without a key", async () => {
    for (const extra of [{ offline: true }, { env: {} }] as Partial<MarketFitOptions>[]) {
      const { opts, calls } = apiReadyOptions(extra);
      const m = await scoreMarketFit(rec({ market_fit: BLOCK }), config, opts);
      expect(m).toMatchObject({ source: "provided", acv: 0.6, copart: -0.2, confidence: 0.8, factors: PROVIDED_FACTORS });
      expect(calls).toHaveLength(0);
    }
  });

  it("leans and signal factors follow the numbers", async () => {
    const { opts } = apiReadyOptions();
    const copart = await scoreMarketFit(rec({ market_fit: { ...BLOCK, acv: -0.3, copart: 0.5, signals: [] } }), config, opts);
    expect(copart.factors).toEqual([
      "Provided market analysis favors Copart (ACV -0.30, Copart +0.50, confidence 0.80; gemini-3.8-flash + Google Search, generated 2026-11-07)",
      "No cited signals with a URL",
    ]);
    const even = await scoreMarketFit(rec({ market_fit: { ...BLOCK, acv: 0.2, copart: 0.2 } }), config, opts);
    expect(even.factors[0]).toMatch(/^Provided market analysis is neutral /);
  });

  it("decide uses it once for every branch and verify_first rescore, never calling the API", async () => {
    const { opts, calls } = apiReadyOptions();
    const d = await decide(
      rec({ title: { brand: "unknown" }, flags: { ...NO_FLAGS, frame: "unknown" }, market_fit: BLOCK }),
      config,
      opts,
    );
    expect(calls).toHaveLength(0);
    expect(d.category_scores.market_fit).toEqual({
      acv: 0.6,
      copart: -0.2,
      confidence: 0.8,
      factors: PROVIDED_FACTORS,
      source: "provided",
    });
    expect(d.market_signals).toEqual(KEPT_SIGNALS);
    expect(renderExplainTable(d, config)).toMatch(/market_fit .* provided\n/);
  });
});

describe("a provided block marked insufficient", () => {
  const INSUFFICIENT = { ...BLOCK, insufficient: true, confidence: 0.1 };

  it("falls through to the fallback table offline, with a note", async () => {
    const { opts, calls } = apiReadyOptions({ offline: true });
    const m = await scoreMarketFit(rec({ market_fit: INSUFFICIENT }), config, opts);
    expect(m).toMatchObject({ source: "fallback", fallback_reason: "offline mode", signals: [], confidence: 0.4 });
    expect(m.factors[0]).toBe('Fallback table row "mid" (age 7 yr, 88,000 mi; rule: otherwise)');
    expect(m.factors.at(-1)).toBe(
      "Provided market fit (gemini-3.8-flash + Google Search, generated 2026-11-07) is marked insufficient: not used",
    );
    expect(calls).toHaveLength(0);
  });

  it("with a key, runs the normal API path (here the fake client fails, so it falls back)", async () => {
    const { opts, calls } = apiReadyOptions();
    const m = await scoreMarketFit(rec({ market_fit: INSUFFICIENT }), config, opts);
    expect(calls).toHaveLength(1);
    expect(m).toMatchObject({ source: "fallback", fallback_reason: "API error: fake client: the Anthropic API must not be called" });
  });

  it("gives the same decision as no block at all, apart from the note", async () => {
    const opts = { offline: true, asOfYear: 2026 };
    const without = await decide(rec(), config, opts);
    const d = await decide(rec({ market_fit: INSUFFICIENT }), config, opts);
    expect(d.probabilities).toEqual(without.probabilities);
    expect(d.category_scores.market_fit.factors.slice(0, -1)).toEqual(without.category_scores.market_fit.factors);
  });
});

// What the free-text parser prints for "2019 Ford F-150 in Texas, clean title, 88k miles,
// transmission is generating noise": every field present, "unknown"/null where the text says nothing.
const PARSER_OUTPUT = {
  vin: null,
  decoded: { year: 2019, make: "Ford", model: "F-150", trim: null },
  odometer: 88000,
  location_state: "TX",
  title: { brand: "clean", state: null },
  runs_drives: "run_and_drive",
  flags: { frame: "unknown", airbag: "unknown", flood: "unknown", module_no_comm: "unknown", monitors_incomplete: "unknown" },
  codes: null,
  seller: { lanes_allowed: null },
  reported_symptoms: [{ system: "transmission", text: "transmission is generating noise" }],
  market_fit: BLOCK,
  parser: {
    model: "gemini-3.8-flash",
    input_text: "2019 Ford F-150 in Texas, clean title, 88k miles, transmission is generating noise",
    field_evidence: { "decoded.year": "2019", runs_drives: "transmission is generating noise" },
    unmapped: [],
    search_queries: ["2019 Ford F-150 XLT auction prices"],
    usage: [{ model: "gemini-3.8-flash", promptTokenCount: 812, candidatesTokenCount: 240 }],
  },
};

describe("a parser-shaped record round-trips through normalizeRecord and decide --offline", () => {
  it("normalizes nulls to missing and keeps symptoms and the market block", () => {
    const r = normalizeRecord(JSON.parse(JSON.stringify(PARSER_OUTPUT)));
    expect(r).toMatchObject({
      vin: null,
      decoded: { year: 2019, make: "Ford", model: "F-150", trim: null },
      title: { brand: "clean", state: null },
      codes: [],
      codes_provided: false,
      lanes_allowed: ["acv", "copart"],
      reported_symptoms: PARSER_OUTPUT.reported_symptoms,
      provided_market_fit: BLOCK,
    });
    expect(r.missing).toEqual(expect.arrayContaining(["vin", "decoded.trim", "title.state", "codes"]));
    expect(r.missing).not.toContain("reported_symptoms");
  });

  it("null anywhere means not stated, exactly like an absent key", () => {
    const nulls = {
      vin: null,
      decoded: null,
      odometer: null,
      location_state: null,
      title: { brand: null, state: null },
      runs_drives: null,
      flags: { frame: null, airbag: null, flood: null, module_no_comm: null, monitors_incomplete: null },
      codes: null,
      seller: null,
      reported_symptoms: null,
      market_fit: null,
      parser: null,
    };
    const r = normalizeRecord(nulls);
    const empty = normalizeRecord({});
    expect(r).toEqual(empty);
    expect(r.runs_drives).toBe("unknown");
    expect(r.missing).toEqual(expect.arrayContaining(["runs_drives", "title.brand", "flags.frame", "codes", "reported_symptoms"]));
  });

  it("decide (offline) uses the provided market fit and the symptom; no API call", async () => {
    const { opts, calls } = apiReadyOptions({ offline: true });
    const d = await decide(normalizeRecord(JSON.parse(JSON.stringify(PARSER_OUTPUT))), config, opts);
    expect(calls).toHaveLength(0);
    expect(d.category_scores.market_fit.source).toBe("provided");
    expect(d.category_scores.drivable).toMatchObject({ acv: 0.4, copart: 0.1 });
    expect(d.category_scores.drivable.factors).toContain('Reported symptom: transmission ("transmission is generating noise")');
    expect(d.category_scores.hidden_risk.factors).toHaveLength(5); // the five unknown flags; the symptom is not one
    expect(d.market_signals).toEqual(KEPT_SIGNALS);
    expect(d.reasons).toHaveLength(3);
    expect(d.risks).toHaveLength(2);
  });

  it("the CLI's decide --offline accepts the saved JSON and prints the same Decision", async () => {
    const path = join(tempDir(), "parsed.json");
    writeFileSync(path, `${JSON.stringify(PARSER_OUTPUT, null, 2)}\n`);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
    expect(await main(["decide", path, "--offline", "--as-of", "2026"])).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    const direct = await decide(normalizeRecord(PARSER_OUTPUT), config, { offline: true, asOfYear: 2026, log: () => {} });
    expect(printed).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(printed.category_scores.market_fit.source).toBe("provided");
    expect(stderr.join("")).toContain("market_fit: dropped 1 provided signal(s) without a claim or an http(s) URL\n");
  });
});
