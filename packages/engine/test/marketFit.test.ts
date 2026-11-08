import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_TTL_MS } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { normalizeRecord, type ConditionRecordInput } from "../src/input.js";
import {
  DEFAULT_MARKET_TIMEOUT_MS,
  buildMarketPrompt,
  computeCostUsd,
  createMarketClient,
  evaluateRule,
  marketFitFallback,
  scoreMarketFit,
  type MarketFitOptions,
  type MessagesClient,
} from "../src/marketFit.js";

const config = loadConfig();
const VIN = "1FTFW1E50NFA00002";
const record = normalizeRecord({
  vin: VIN,
  decoded: { year: 2022, make: "Ford", model: "F-150", trim: "XLT" },
  odometer: 40_000,
  location_state: "tx",
  title: { brand: "clean" },
  runs_drives: "run_and_drive",
  flags: { frame: "suspected", airbag: "no", flood: "no", module_no_comm: "no", monitors_incomplete: "no" },
  codes: [{ code: "P0301", status: "confirmed" }],
});

// ---- fake client --------------------------------------------------------------------------

type Block = Record<string, unknown>;
const USAGE = {
  input_tokens: 10_000,
  output_tokens: 1_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
};

function message(content: Block[], stop_reason: string, searches = 2): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { ...USAGE, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } },
  } as unknown as Anthropic.Message;
}

const search: Block = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "2022 Ford F-150 XLT listings" },
};
const searchResult: Block = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [{ type: "web_search_result", url: "https://www.example.com/f150", title: "F-150 listings" }],
};
const report = (input: Record<string, unknown>): Block => ({
  type: "tool_use",
  id: "toolu_1",
  name: "report_market_fit",
  input,
});
const goodInput = {
  acv: 0.6,
  copart: -0.1,
  confidence: 0.7,
  insufficient: false,
  signals: [
    { claim: "About 1,200 comparable F-150 XLTs listed for retail, asking around $38,000", url: "https://www.example.com/f150" },
    { claim: "Median 32 days on market", url: "https://data.example.org/dom" },
  ],
};
const reply = (input: Record<string, unknown>) => message([search, searchResult, report(input)], "tool_use");

function fakeClient(responses: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        const next = responses.shift();
        if (!next) throw new Error("fake client: unexpected extra call");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Options with a key, a private cache dir and a captured log. */
function setup(responses: (Anthropic.Message | Error)[], extra: Partial<MarketFitOptions> = {}) {
  const fake = fakeClient(responses);
  const lines: string[] = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "underscope-mf-"));
  dirs.push(cacheDir);
  const opts: MarketFitOptions = {
    client: fake.client,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    asOfYear: 2026,
    now: new Date("2026-11-01T00:00:00Z"),
    cacheDir,
    log: (l) => lines.push(l),
    ...extra,
  };
  return { ...fake, lines, opts };
}

const userText = (body: Anthropic.MessageCreateParamsNonStreaming) => JSON.stringify(body.messages[0]);

// ---- tests --------------------------------------------------------------------------------

describe("scoreMarketFit online path", () => {
  it("parses a valid structured report into scores, confidence, signals and usage", async () => {
    const { opts, calls, lines } = setup([reply(goodInput)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("web");
    expect([r.acv, r.copart, r.confidence]).toEqual([0.6, -0.1, 0.7]);
    expect(r.signals).toEqual(goodInput.signals);
    expect(r.excluded).toEqual([]);
    expect(r.fallback_reason).toBeUndefined();
    expect(r.factors[0]).toBe("Web market analysis (anthropic claude-sonnet-5-5) favors ACV (ACV +0.60, Copart -0.10, confidence 0.70)");
    expect(r.factors.join(" ")).not.toMatch(/\$/); // prices stay inside signal claims
    expect(r.usage).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      requests: 1,
      input_tokens: 10_000,
      web_search_requests: 2,
    });
    expect(r.usage?.cost_usd).toBeCloseTo(0.05, 10); // 10k*$2 + 1k*$10 per MTok + 2 searches*$0.01
    expect(lines.filter((l) => l.startsWith("market_fit api call"))).toHaveLength(1);
    expect(lines[0]).toMatch(/input=10000 output=1000 .*searches=2 cost=\$0\.0500/);

    // The request: web search + strict report tool, auto tool choice, no sampling params.
    expect(calls).toHaveLength(1);
    const body = calls[0]!;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body).not.toHaveProperty("temperature");
    expect(body.tools).toContainEqual({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    expect(body.tools).toContainEqual(expect.objectContaining({ name: "report_market_fit", strict: true }));
    // Only the profile goes out: no VIN, flags or codes.
    const sent = userText(body);
    expect(sent).toContain("2022");
    expect(sent).toContain("F-150");
    expect(sent).toContain("40,000 miles");
    expect(sent).toContain("TX");
    expect(sent).not.toContain(VIN);
    expect(sent).not.toMatch(/P0301|suspected|\{\{/);
  });

  it("uses MARKET_MODEL when set", async () => {
    const { opts, calls } = setup([reply(goodInput)]);
    opts.env = { ANTHROPIC_API_KEY: "sk-test", MARKET_MODEL: "claude-opus-5-5" };
    const r = await scoreMarketFit(record, config, opts);
    expect(calls[0]!.model).toBe("claude-opus-5-5");
    expect(r.usage?.model).toBe("claude-opus-5-5");
  });

  it("drops signals without an http(s) URL", async () => {
    const input = {
      ...goodInput,
      signals: [
        { claim: "kept", url: "https://example.com/kept" },
        { claim: "no url", url: "" },
        { claim: "not a url", url: "example.com/page" },
        { claim: "wrong scheme", url: "ftp://example.com/file" },
        { claim: "", url: "https://example.com/empty-claim" },
      ],
    };
    const { opts, lines } = setup([reply(input)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.signals).toEqual([{ claim: "kept", url: "https://example.com/kept" }]);
    expect(lines.some((l) => l.includes("dropped 4 signal(s)"))).toBe(true);
  });

  it("falls back without calling the client when there is no API key (empty counts as missing)", async () => {
    // OPENAI.md design 2 (round 4): with neither key the reason names both (was "no ANTHROPIC_API_KEY").
    for (const env of [{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }]) {
      const { opts, calls } = setup([reply(goodInput)], { env });
      const r = await scoreMarketFit(record, config, opts);
      expect(r.source).toBe("fallback");
      expect(r.fallback_reason).toBe("no API key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)");
      expect(r.signals).toEqual([]);
      expect(r.usage).toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  });

  it("falls back offline without calling the client", async () => {
    const { opts, calls } = setup([reply(goodInput)], { offline: true });
    const r = await scoreMarketFit(record, config, opts);
    expect(r.fallback_reason).toBe("offline mode");
    expect([r.acv, r.copart, r.confidence]).toEqual([0.8, 0, 0.4]); // late_low_miles row
    expect(calls).toHaveLength(0);
  });

  it("retries once on invalid output, then falls back (out-of-range scores are not clamped)", async () => {
    const noTool = message([{ type: "text", text: "Dealers like it." }], "end_turn");
    const outOfRange = reply({ ...goodInput, acv: 1.5 });
    const { opts, calls, lines } = setup([noTool, outOfRange]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toMatch(/^invalid model output twice \(invalid report_market_fit input: acv/);
    expect(r.usage?.input_tokens).toBe(20_000); // both calls are paid for and reported
    expect(r.usage?.requests).toBe(2);
    expect(lines.some((l) => l.includes("retrying once"))).toBe(true);
    expect(lines).toContain(`market_fit: falling back (${r.fallback_reason})`);
  });

  it("succeeds on the retry when the second output is valid", async () => {
    const { opts, calls } = setup([message([], "end_turn"), reply(goodInput)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("web");
  });

  it("falls back on insufficient evidence, and caches that so it is not re-billed", async () => {
    const { opts, calls, lines } = setup([reply({ ...goodInput, insufficient: true, confidence: 0.1 })]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toBe("insufficient web evidence");
    expect(r.signals).toEqual([]);
    expect(r.usage?.cost_usd).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("insufficient") && l.includes("example.com"))).toBe(true);
    const again = await scoreMarketFit(record, config, opts);
    expect(again.fallback_reason).toMatch(/^insufficient web evidence \(cached/);
    expect(calls).toHaveLength(1);
  });

  it("continues a pause_turn by re-sending the paused assistant turn, in the same container", async () => {
    const paused = {
      ...message([search, searchResult], "pause_turn"),
      container: { id: "container_abc", expires_at: "2026-11-01T01:00:00Z", skills: null },
    } as unknown as Anthropic.Message;
    const done = message([report(goodInput)], "tool_use");
    const { opts, calls, lines } = setup([paused, done]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("web");
    expect(calls).toHaveLength(2);
    const second = calls[1]!.messages;
    expect(second).toHaveLength(2);
    expect(second[0]!.role).toBe("user");
    expect(second[1]).toEqual({ role: "assistant", content: [search, searchResult] });
    // Dynamic filtering's code-execution container is reused; the first request had none.
    expect(calls[0]).not.toHaveProperty("container");
    expect(calls[1]!.container).toBe("container_abc");
    // The paused request billed 2 searches, so the continuation may run only the 3 left.
    expect(calls[1]!.tools).toContainEqual({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    expect(r.usage?.input_tokens).toBe(20_000);
    expect(r.usage?.requests).toBe(2);
    expect(lines.filter((l) => l.startsWith("market_fit api call"))).toHaveLength(2);
  });

  it("caps pause_turn continuations, then counts the attempt as invalid", async () => {
    const paused = () => message([search, searchResult], "pause_turn", 1); // 4 requests x 1 search < 5
    const { opts, calls } = setup(Array.from({ length: 8 }, paused));
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(8); // 2 attempts x (1 call + 3 continuations)
    expect(r.fallback_reason).toMatch(/still paused after 3 continuations/);
    expect(r.usage?.requests).toBe(8);
  });

  it("stops continuing once the attempt has billed MAX_SEARCHES searches, and does not retry", async () => {
    // Dynamic filtering searches do not count against max_uses across continuations, so the
    // engine bounds them itself: 5 billed searches and still paused -> fall back.
    const paused = () => message([search, searchResult], "pause_turn", 5);
    const { opts, calls, lines } = setup(Array.from({ length: 8 }, paused));
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(1);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toBe("paused after 5 web searches (limit 5) without a report");
    expect(r.usage).toMatchObject({ requests: 1, web_search_requests: 5 });
    expect(lines).toContain(`market_fit: falling back (${r.fallback_reason})`);
  });

  it("retries output cut off at max_tokens with a larger max_tokens", async () => {
    const cut = () => message([search, searchResult, report({ acv: 0.6 })], "max_tokens");
    const { opts, calls, lines } = setup([cut(), cut()]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls.map((c) => c.max_tokens)).toEqual([16_000, 21_000]);
    expect(r.fallback_reason).toBe("invalid model output twice (tool input cut off at max_tokens 21000)");
    expect(lines.some((l) => l.endsWith("retrying once with max_tokens 21000"))).toBe(true);
    // A cut before the report call is retried the same way; other invalid output keeps 16,000.
    const before = setup([message([search, searchResult], "max_tokens"), reply(goodInput)]);
    expect((await scoreMarketFit(record, config, before.opts)).source).toBe("web");
    expect(before.calls.map((c) => c.max_tokens)).toEqual([16_000, 21_000]);
    const other = setup([message([], "end_turn"), reply(goodInput)]);
    await scoreMarketFit(record, config, other.opts);
    expect(other.calls.map((c) => c.max_tokens)).toEqual([16_000, 16_000]);
  });

  it("does not accept a report with no web search result behind it (retried, then fallback, not cached)", async () => {
    // Report only (no search at all), and a search request whose result never came back.
    const reportOnly = message([report(goodInput)], "tool_use", 0);
    const searchNoResult = message([search, report(goodInput)], "tool_use", 0);
    const { opts, calls, lines } = setup([reportOnly, searchNoResult]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toBe("invalid model output twice (no web search result before the report_market_fit call)");
    expect(r.signals).toEqual([]);
    expect(lines.some((l) => l.includes("attempt 1: no web search result") && l.endsWith("retrying once"))).toBe(true);
    expect(readdirSync(opts.cacheDir!)).toEqual([]);
  });

  it("falls back on a refusal without retrying", async () => {
    const refusal = { ...message([], "refusal"), stop_details: { category: "general_harms" } } as Anthropic.Message;
    const { opts, calls } = setup([refusal]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(1);
    expect(r.fallback_reason).toBe("model refused (general_harms)");
  });

  it("falls back on an API error (after the SDK's own retries), with one stderr line", async () => {
    const { opts, calls, lines } = setup([new Error("socket hang up")]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(1);
    expect(r.fallback_reason).toBe("API error: socket hang up");
    expect(r.usage).toBeUndefined();
    expect(lines).toEqual(["market_fit: falling back (API error: socket hang up)"]);
  });

  it("describes an HTTP error by status, type and message; the request id goes to the log only", async () => {
    const body = {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
      request_id: "req_123",
    };
    const err = Anthropic.APIError.generate(401, body, undefined, new Headers({ "request-id": "req_123" }));
    const { opts, lines } = setup([err]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.fallback_reason).toBe("API error: 401 authentication_error: invalid x-api-key");
    expect(r.factors.join(" ")).not.toContain("req_123");
    expect(lines).toContain("market_fit: API error, request id req_123");

    const conn = setup([new Anthropic.APIConnectionError({ message: "Connection error." })]);
    expect((await scoreMarketFit(record, config, conn.opts)).fallback_reason).toBe("API error: Connection error.");
  });

  it("falls back, uncached, when every web search returned an error result", async () => {
    const failed = { ...searchResult, content: { type: "web_search_tool_result_error", error_code: "unavailable" } };
    const { opts, calls } = setup([message([search, failed, report(goodInput)], "tool_use"), reply(goodInput)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.fallback_reason).toBe("web search failed (unavailable)");
    expect((await scoreMarketFit(record, config, opts)).source).toBe("web"); // not cached: tries again
    expect(calls).toHaveLength(2);
  });

  it("serves a cache hit without a second call, and calls again after 7 days", async () => {
    const { opts, calls } = setup([reply(goodInput), reply({ ...goodInput, acv: 0.2 })]);
    const t0 = opts.now!;
    const first = await scoreMarketFit(record, config, opts);
    expect(first.source).toBe("web");

    const sixDays = new Date(t0.getTime() + 6 * 24 * 3600 * 1000);
    const hit = await scoreMarketFit({ ...record, odometer: 41_500 }, config, { ...opts, now: sixDays });
    expect(hit.source).toBe("cache");
    expect(hit.acv).toBe(0.6);
    expect(hit.signals).toEqual(goodInput.signals);
    expect(hit.usage).toBeUndefined();
    expect(hit.factors.some((f) => f.startsWith("Cached web analysis from 2026-11-01"))).toBe(true);
    expect(calls).toHaveLength(1);

    const expired = await scoreMarketFit(record, config, { ...opts, now: new Date(t0.getTime() + CACHE_TTL_MS) });
    expect(expired.source).toBe("web");
    expect(expired.acv).toBe(0.2);
    expect(calls).toHaveLength(2);
  });
});

describe("computeCostUsd", () => {
  const usage = {
    input_tokens: 12_345,
    output_tokens: 2_000,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 1_000,
    web_search_requests: 3,
  };

  it("prices a known model from the table", () => {
    // 12,345*$2 + 2,000*$10 + 50,000*$0.10 + 1,000*$2.50 per MTok, plus 3 searches at $0.01
    // (Sonnet 5.5 cache hits are 0.05x base input on the live pricing page, 2026-11-07).
    expect(computeCostUsd("claude-sonnet-5-5", usage)).toBeCloseTo(0.02469 + 0.02 + 0.005 + 0.0025 + 0.03, 10);
    // Opus 5.5 cache hits stay $0.20/MTok: 12,345*$4 + 2,000*$20 + 50,000*$0.20 + 1,000*$5.
    expect(computeCostUsd("claude-opus-5-5", usage)).toBeCloseTo(0.04938 + 0.04 + 0.01 + 0.005 + 0.03, 10);
  });

  it("counts tokens as $0 for an unknown model, with a warning", () => {
    const warnings: string[] = [];
    expect(computeCostUsd("some-future-model", usage, (l) => warnings.push(l))).toBeCloseTo(0.03, 10);
    expect(warnings[0]).toMatch(/WARNING no token price for model "some-future-model"/);
  });
});

describe("createMarketClient", () => {
  it("sets an explicit timeout (MARKET_TIMEOUT_MS, else 5 min) and one SDK retry; no request is made", () => {
    const def = createMarketClient("sk-test", {});
    expect(def.timeout).toBe(DEFAULT_MARKET_TIMEOUT_MS);
    expect(DEFAULT_MARKET_TIMEOUT_MS).toBe(300_000);
    expect(def.maxRetries).toBe(1);
    expect(createMarketClient("sk-test", { MARKET_TIMEOUT_MS: "45000" }).timeout).toBe(45_000);
    for (const bad of ["", "abc", "0", "-5"]) {
      expect(createMarketClient("sk-test", { MARKET_TIMEOUT_MS: bad }).timeout).toBe(DEFAULT_MARKET_TIMEOUT_MS);
    }
  });
});

describe("evaluateRule", () => {
  it("'and' binds tighter than 'or'", () => {
    expect(evaluateRule("a <= 6 and b < 100 or a > 10", { a: 12, b: 500 })).toBe(true);
    expect(evaluateRule("a <= 6 and b < 100 or a > 10", { a: 5, b: 50 })).toBe(true);
    expect(evaluateRule("a <= 6 and b < 100 or a > 10", { a: 8, b: 50 })).toBe(false);
    // a > 10 or (b < 100 and a < 0); read as (a > 10 or b < 100) and a < 0 it would be false.
    expect(evaluateRule("a > 10 or b < 100 and a < 0", { a: 12, b: 500 })).toBe(true);
  });

  it("a comparison on an unknown (null) variable is false, whatever the operator", () => {
    // In plain JS `null < 100` is true; the rule must not treat a missing odometer as 0.
    for (const rule of ["a > 1", "a < 100", "a <= 0", "a >= 0", "a == 0", "a != 5"]) {
      expect(evaluateRule(rule, { a: null })).toBe(false);
    }
    expect(evaluateRule("otherwise", { a: null })).toBe(true);
  });

  it("throws on an unparseable rule and on an unknown variable", () => {
    expect(() => evaluateRule("a >> 1", { a: 1 })).toThrow(/Cannot parse/);
    expect(() => evaluateRule("a > one", { a: 1 })).toThrow(/Cannot parse/);
    expect(() => evaluateRule("z > 1", { a: 1 })).toThrow(/Unknown variable "z"/);
  });
});

describe("marketFitFallback rows (as of 2026)", () => {
  const AS_OF = 2026;
  const ROWS = {
    late_low_miles: { acv: 0.8, copart: 0 },
    mid: { acv: 0.3, copart: 0.2 },
    old_or_high: { acv: -0.5, copart: 0.5 },
  } as const;
  // [label, expected row, record]. A missing year is built by omitting decoded.year
  // (input validation rejects an explicit null year); odometer null is allowed.
  const cases: [string, keyof typeof ROWS, ConditionRecordInput][] = [
    ["2020 / 99,999 mi", "late_low_miles", { decoded: { year: 2020 }, odometer: 99_999 }],
    ["2020 / 100,000 mi (odometer < 100000 is strict)", "mid", { decoded: { year: 2020 }, odometer: 100_000 }],
    ["2016 / 120k (age 10 is not > 10)", "mid", { decoded: { year: 2016 }, odometer: 120_000 }],
    ["2015 / 120k (age 11)", "old_or_high", { decoded: { year: 2015 }, odometer: 120_000 }],
    ["2020 / 150,000 mi (odometer > 150000 is strict)", "mid", { decoded: { year: 2020 }, odometer: 150_000 }],
    ["2020 / 150,001 mi", "old_or_high", { decoded: { year: 2020 }, odometer: 150_001 }],
    ["2020 / odometer null", "mid", { decoded: { year: 2020 }, odometer: null }],
    ["2024 / odometer missing (the and-clause on a null odometer is false)", "mid", { decoded: { year: 2024 } }],
    ["2015 / odometer null", "old_or_high", { decoded: { year: 2015 }, odometer: null }],
    ["2010 / odometer null", "old_or_high", { decoded: { year: 2010 }, odometer: null }],
    ["year missing / 99,999 mi", "mid", { decoded: { make: "Ford" }, odometer: 99_999 }],
    ["year missing / 150,001 mi", "old_or_high", { decoded: { make: "Ford" }, odometer: 150_001 }],
  ];

  it.each(cases)("%s -> %s", (_label, row, input) => {
    const r = marketFitFallback(normalizeRecord(input), config, AS_OF, "test");
    expect(r).toMatchObject({ ...ROWS[row], confidence: 0.4, source: "fallback", signals: [], excluded: [] });
    expect(r.factors[0]).toMatch(new RegExp(`^Fallback table row "${row}"`));
  });

  it("an empty record (nothing known) gets the 'otherwise' row, and says why", () => {
    const r = marketFitFallback(normalizeRecord({}), config, AS_OF, "offline mode");
    expect(r).toMatchObject({ acv: 0.3, copart: 0.2, confidence: 0.4, fallback_reason: "offline mode" });
    expect(r.factors[0]).toBe('Fallback table row "mid" (age unknown, odometer unknown; rule: otherwise)');
    expect(r.factors[1]).toBe("Fallback used: offline mode");
  });
});

describe("buildMarketPrompt", () => {
  it("fills every placeholder and writes unknown for missing fields", () => {
    const sparse = normalizeRecord({ decoded: { year: 2012, make: "Ram" }, runs_drives: "no" });
    const p = buildMarketPrompt(sparse);
    expect(p).not.toMatch(/\{\{|<!--/);
    expect(p).toContain("Trim: unknown");
    expect(p).toContain("Odometer: unknown");
    expect(p).toContain("Run status: does not run");
    expect(p).toContain("report_market_fit");
  });

  it("sends Anthropic its own tail (the tool instruction) and OpenAI the JSON tail, with the same shared text and fields", () => {
    const anthropic = buildMarketPrompt(record);
    const openai = buildMarketPrompt(record, undefined, "openai");
    expect(buildMarketPrompt(record, undefined, "anthropic")).toBe(anthropic);
    expect(anthropic).toMatch(/Do not answer in plain text; the tool call\nis the only answer that is read\.\n$/);
    expect(openai).not.toMatch(/report_market_fit|tool call|<!--|\{\{/);
    expect(openai).toContain("one JSON object");
    expect(anthropic).not.toMatch(/<!--|one JSON object/);
    // Shared text up to the tail is the same; so is the field list inside each tail.
    const shared = (p: string) => p.slice(0, p.indexOf("this kind of vehicle.") + 21);
    expect(shared(openai)).toBe(shared(anthropic));
    const fields = (p: string) => p.split("\n").filter((l) => /^(- `|  )/.test(l) && !/^- (Year|Make|Model|Trim|Odometer|Location|Title|Run)/.test(l));
    expect(fields(openai)).toEqual(fields(anthropic));
    expect(fields(openai).filter((l) => l.startsWith("- `"))).toHaveLength(5);
  });

  it("refuses a template without the provider's tail", () => {
    expect(() => buildMarketPrompt(record, "Year {{year}}\n<!-- tail: anthropic -->\nUse the tool.\n", "openai")).toThrow(
      /no "<!-- tail: openai -->" section/,
    );
    expect(buildMarketPrompt(record, "Year {{year}}\n<!-- tail: anthropic -->\nUse the tool.\n\n")).toBe("Year 2022\nUse the tool.\n");
  });
});
