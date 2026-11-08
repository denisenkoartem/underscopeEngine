// OpenAI market-fit provider (OPENAI.md round 4): fully offline, with a fake Responses client.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { normalizeRecord } from "../src/input.js";
import {
  DEFAULT_MARKET_TIMEOUT_MS,
  scoreMarketFit,
  selectMarketProvider,
  usageCostKnown,
  type MarketFitOptions,
  type MessagesClient,
} from "../src/marketFit.js";
import {
  DEFAULT_OPENAI_MARKET_MODEL,
  createOpenAIMarketClient,
  describeOpenAIError,
  openaiCostUsd,
  scrubOpenAIKey,
  type ResponsesClient,
} from "../src/openaiMarket.js";

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
/** Shaped like a real key so the scrub is exercised; not a real key. */
const KEY = "sk-test-NOT-A-REAL-KEY-0123456789";

// ---- fake responses -----------------------------------------------------------------------

type Item = Record<string, unknown>;
const USAGE = {
  input_tokens: 8_000,
  input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 0 },
  output_tokens: 400,
  output_tokens_details: { reasoning_tokens: 100 },
  total_tokens: 8_400,
};

function response(output: Item[], extra: Record<string, unknown> = {}): Response {
  return {
    id: "resp_test",
    object: "response",
    model: "gpt-5.4-mini",
    status: "completed",
    output,
    output_text: "",
    error: null,
    incomplete_details: null,
    usage: USAGE,
    ...extra,
  } as unknown as Response;
}

const search = (urls: string[], status = "completed"): Item => ({
  type: "web_search_call",
  id: "ws_1",
  status,
  action: { type: "search", query: "2022 Ford F-150 XLT listings", sources: urls.map((url) => ({ type: "url", url })) },
});
const openPage = (url: string): Item => ({ type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url } });
const message = (text: string): Item => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const SOURCES = ["https://www.example.com/f150?page=1", "https://data.example.org/dom"];
const goodAnswer = {
  acv: 0.6,
  copart: -0.1,
  confidence: 0.7,
  insufficient: false,
  signals: [
    { claim: "About 1,200 comparable F-150 XLTs listed for retail, asking around $38,000", url: "https://www.example.com/f150" },
    { claim: "Median 32 days on market", url: "https://data.example.org/dom" },
  ],
};
const reply = (answer: unknown, urls = SOURCES) => response([search(urls), message(JSON.stringify(answer))]);

function fakeOpenAI(responses: (Response | Error)[]) {
  const calls: ResponseCreateParamsNonStreaming[] = [];
  const client: ResponsesClient = {
    responses: {
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

/** An Anthropic fake that fails the test if it is ever called. */
function noAnthropic() {
  const calls: unknown[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        throw new Error("fake client: the Anthropic API must not be called");
      },
    },
  };
  return { client, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Options with only an OpenAI key, a private cache dir and a captured log. */
function setup(responses: (Response | Error)[], extra: Partial<MarketFitOptions> = {}) {
  const fake = fakeOpenAI(responses);
  const anthropic = noAnthropic();
  const lines: string[] = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "underscope-oai-"));
  dirs.push(cacheDir);
  const opts: MarketFitOptions = {
    openaiClient: fake.client,
    client: anthropic.client,
    env: { OPENAI_API_KEY: KEY },
    asOfYear: 2026,
    now: new Date("2026-11-07T00:00:00Z"),
    cacheDir,
    log: (l) => lines.push(l),
    ...extra,
  };
  return { ...fake, anthropicCalls: anthropic.calls, lines, opts };
}

// ---- tests --------------------------------------------------------------------------------

describe("OpenAI market fit: a valid response", () => {
  it("parses into scores, signals, usage and provider-named factors", async () => {
    const { opts, calls, lines, anthropicCalls } = setup([reply(goodAnswer)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("web");
    expect([r.acv, r.copart, r.confidence]).toEqual([0.6, -0.1, 0.7]);
    expect(r.signals).toEqual(goodAnswer.signals);
    expect(r.fallback_reason).toBeUndefined();
    expect(r.factors).toEqual([
      "Web market analysis (openai gpt-5.4-mini) favors ACV (ACV +0.60, Copart -0.10, confidence 0.70)",
      "2 cited signal(s): example.com, data.example.org",
    ]);
    expect(r.factors.join(" ")).not.toMatch(/\$/); // prices stay inside signal claims
    expect(r.usage).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      requests: 1,
      input_tokens: 8_000,
      output_tokens: 400,
      cache_read_input_tokens: 1_000,
      web_search_requests: 1,
    });
    // (7,000 x $0.75 + 1,000 x $0.075 + 400 x $4.50) per MTok + 1 search x $0.01
    expect(r.usage?.cost_usd).toBeCloseTo((7_000 * 0.75 + 1_000 * 0.075 + 400 * 4.5) / 1e6 + 0.01, 10);
    expect(anthropicCalls).toHaveLength(0);

    const usageLines = lines.filter((l) => l.startsWith("market_fit api call"));
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).toMatch(
      /^market_fit api call \(attempt 1\): provider=openai model=gpt-5\.4-mini status=completed input=8000 cached=1000 output=400 reasoning=100 web_search_calls=1 searches=1 latency=\d+\.\ds cost=\$0\.0171$/,
    );
  });

  it("sends web search with sources, a strict json_schema answer, low-risk settings and only the profile", async () => {
    const { opts, calls } = setup([reply(goodAnswer)]);
    await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(1);
    const body = calls[0]!;
    expect(body.model).toBe(DEFAULT_OPENAI_MARKET_MODEL);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body.max_output_tokens).toBe(16_000);
    expect(body.max_tool_calls).toBe(5);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("temperature");
    const format = body.text?.format as { type: string; name: string; strict: boolean; schema: Record<string, unknown> };
    expect(format).toMatchObject({ type: "json_schema", name: "market_fit", strict: true });
    expect(format.schema).toMatchObject({
      type: "object",
      required: ["acv", "copart", "confidence", "signals", "insufficient"],
      additionalProperties: false,
    });
    // Only the profile goes out: no VIN, flags, codes, and no Anthropic tool instruction.
    const sent = String(body.input);
    expect(sent).toContain("2022");
    expect(sent).toContain("F-150");
    expect(sent).toContain("40,000 miles");
    expect(sent).toContain("TX");
    expect(sent).toContain("one JSON object");
    expect(sent).not.toContain(VIN);
    expect(sent).not.toMatch(/P0301|suspected|report_market_fit|\{\{|<!--/);
  });

  it("uses MARKET_OPENAI_MODEL when set; a model without a price logs cost n/a and counts as unknown cost", async () => {
    const { opts, calls, lines } = setup([reply(goodAnswer)]);
    opts.env = { OPENAI_API_KEY: KEY, MARKET_OPENAI_MODEL: "gpt-9-test", MARKET_MODEL: "claude-opus-5-5" };
    const r = await scoreMarketFit(record, config, opts);
    expect(calls[0]!.model).toBe("gpt-9-test");
    expect(r.usage).toMatchObject({ provider: "openai", model: "gpt-9-test", cost_usd: 0 });
    expect(usageCostKnown(r.usage!)).toBe(false);
    expect(lines).toContain('market_fit: no OpenAI price for model "gpt-9-test"; cost n/a (pricing not configured)');
    expect(lines.find((l) => l.startsWith("market_fit api call"))).toMatch(/cost=n\/a \(pricing not configured\)$/);
    expect(r.factors[0]).toContain("(openai gpt-9-test)");
  });
});

describe("OpenAI market fit: signals", () => {
  it("drops signals without an http(s) URL", async () => {
    const answer = {
      ...goodAnswer,
      signals: [
        { claim: "kept", url: "https://example.com/kept" },
        { claim: "no url", url: "" },
        { claim: "not a url", url: "example.com/page" },
        { claim: "", url: "https://example.com/empty-claim" },
      ],
    };
    const { opts, lines } = setup([reply(answer)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.signals).toEqual([{ claim: "kept", url: "https://example.com/kept" }]);
    expect(lines).toContain("market_fit: dropped 3 signal(s) without a claim or an http(s) URL");
  });

  it("drops signals whose domain is not among the web search sources (www. and subdomains match)", async () => {
    const answer = {
      ...goodAnswer,
      signals: [
        { claim: "same host without www", url: "https://example.com/other-page" },
        { claim: "subdomain of a source", url: "https://m.data.example.org/x" },
        { claim: "seen through open_page", url: "https://www.cargurus.com/f150" },
        { claim: "never searched", url: "https://made-up.example.net/listing" },
        { claim: "look-alike", url: "https://notexample.com/x" },
      ],
    };
    const res = response([search(SOURCES), openPage("https://cargurus.com/Cars/f150"), message(JSON.stringify(answer))]);
    const { opts, lines } = setup([res]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("web");
    expect(r.signals.map((s) => s.claim)).toEqual(["same host without www", "subdomain of a source", "seen through open_page"]);
    expect(lines).toContain(
      "market_fit: dropped 2 signal(s) whose domain is not among the web search sources: made-up.example.net, notexample.com",
    );
  });

  it("does not check domains when the searches returned no source URLs (says so)", async () => {
    const { opts, lines } = setup([reply(goodAnswer, [])]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.signals).toEqual(goodAnswer.signals);
    expect(lines).toContain("market_fit: the web search returned no source URLs; signal domains not checked");
  });

  it("ignores sources of a search that did not complete", async () => {
    const res = response([search(["https://made-up.example.net/a"], "failed"), search(SOURCES), message(JSON.stringify({
      ...goodAnswer,
      signals: [{ claim: "from the failed search", url: "https://made-up.example.net/a" }, goodAnswer.signals[0]],
    }))]);
    const { opts, lines } = setup([res]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.signals).toEqual([goodAnswer.signals[0]]);
    expect(lines).toContain("market_fit: 1 web search call(s) not completed (failed)");
  });
});

describe("OpenAI market fit: invalid output, retry and fallback", () => {
  it("retries invalid JSON once, then falls back (both requests are reported, nothing cached)", async () => {
    const notJson = response([search(SOURCES), message("Dealers like it.")]);
    const outOfRange = reply({ ...goodAnswer, acv: 1.5 });
    const { opts, calls, lines } = setup([notJson, outOfRange]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toMatch(/^invalid model output twice \(invalid market_fit JSON: acv: /);
    expect(r.usage).toMatchObject({ provider: "openai", requests: 2, input_tokens: 16_000 });
    expect(lines.some((l) => /^market_fit: attempt 1: answer is not valid JSON \(.*\); retrying once$/.test(l))).toBe(true);
    expect(lines).toContain(`market_fit: falling back (${r.fallback_reason})`);
    expect(readdirSync(opts.cacheDir!)).toEqual([]);
  });

  it("succeeds on the retry when the second answer is valid", async () => {
    const { opts, calls } = setup([response([search(SOURCES)]), reply(goodAnswer)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("web");
    expect(r.usage?.requests).toBe(2);
  });

  it("does not accept an answer with no completed web_search_call (retried, then fallback, not cached)", async () => {
    const noSearch = response([message(JSON.stringify(goodAnswer))]);
    const failedSearch = response([search(SOURCES, "failed"), message(JSON.stringify(goodAnswer))]);
    const { opts, calls, lines } = setup([noSearch, failedSearch]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls).toHaveLength(2);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toBe(
      "invalid model output twice (no web search before the answer (1 web_search_call(s), none completed))",
    );
    expect(lines).toContain("market_fit: attempt 1: no web search before the answer (no web_search_call); retrying once");
    expect(r.signals).toEqual([]);
    expect(readdirSync(opts.cacheDir!)).toEqual([]);
  });

  it("falls back on insufficient evidence, and caches that so it is not re-billed", async () => {
    const { opts, calls, lines } = setup([reply({ ...goodAnswer, insufficient: true, confidence: 0.1 })]);
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

  it("retries a response cut off at max_output_tokens with a larger budget; other incomplete reasons keep it", async () => {
    const cut = () => response([search(SOURCES)], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const { opts, calls, lines } = setup([cut(), cut()]);
    const r = await scoreMarketFit(record, config, opts);
    expect(calls.map((c) => c.max_output_tokens)).toEqual([16_000, 32_000]);
    expect(r.fallback_reason).toBe("invalid model output twice (response cut off at max_output_tokens 32000)");
    expect(lines.some((l) => l.endsWith("retrying once with max_output_tokens 32000"))).toBe(true);

    const filtered = response([search(SOURCES)], { status: "incomplete", incomplete_details: { reason: "content_filter" } });
    const other = setup([filtered, reply(goodAnswer)]);
    expect((await scoreMarketFit(record, config, other.opts)).source).toBe("web");
    expect(other.calls.map((c) => c.max_output_tokens)).toEqual([16_000, 16_000]);
    expect(other.lines).toContain("market_fit: attempt 1: response incomplete (content_filter); retrying once");
  });

  it("falls back on a refusal or a failed response without retrying", async () => {
    const refusal = response([
      search(SOURCES),
      { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] },
    ]);
    const a = setup([refusal]);
    const r = await scoreMarketFit(record, config, a.opts);
    expect(a.calls).toHaveLength(1);
    expect(r.fallback_reason).toBe("model refused (I can't help with that.)");

    const failed = response([], { status: "failed", error: { code: "server_error", message: "The server had an error." } });
    const b = setup([failed]);
    const f = await scoreMarketFit(record, config, b.opts);
    expect(b.calls).toHaveLength(1);
    expect(f.fallback_reason).toBe("OpenAI response failed (server_error: The server had an error.)");
    expect(f.usage?.requests).toBe(1);
  });
});

describe("OpenAI market fit: errors and the key", () => {
  it("describes an HTTP error by status, code and message, without the key; the request id goes to the log only", async () => {
    const body = {
      error: {
        message: `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    };
    const err = OpenAI.APIError.generate(401, body, undefined, new Headers({ "x-request-id": "req_123" }));
    const { opts, lines } = setup([err]);
    const r = await scoreMarketFit(record, config, opts);
    expect(r.fallback_reason).toBe(
      "API error: 401 invalid_api_key: Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.",
    );
    expect(r.usage).toBeUndefined();
    expect(lines).toContain("market_fit: API error, request id req_123");
    expect(JSON.stringify(r)).not.toContain("req_123");
    expect(`${lines.join("\n")}\n${JSON.stringify(r)}`).not.toContain(KEY);

    const conn = setup([new OpenAI.APIConnectionError({ message: "Connection error." })]);
    expect((await scoreMarketFit(record, config, conn.opts)).fallback_reason).toBe("API error: Connection error.");
  });

  it("never logs the key on a successful run either, and masked keys are scrubbed", async () => {
    const { opts, lines } = setup([reply(goodAnswer)]);
    const r = await scoreMarketFit(record, config, opts);
    expect(`${lines.join("\n")}\n${JSON.stringify(r)}`).not.toContain(KEY);
    expect(scrubOpenAIKey(`a ${KEY} b`, KEY)).toBe("a [redacted] b");
    expect(scrubOpenAIKey("key sk-proj-********************abcd. Next")).toBe("key [redacted] Next");
    expect(describeOpenAIError(new Error(`boom ${KEY}`), KEY)).toBe("boom [redacted]");
  });

  it("builds the client with the market timeout and one SDK retry; no request is made", () => {
    const c = createOpenAIMarketClient(KEY, DEFAULT_MARKET_TIMEOUT_MS);
    expect(c.timeout).toBe(300_000);
    expect(c.maxRetries).toBe(1);
    expect(createOpenAIMarketClient(KEY, 45_000).timeout).toBe(45_000);
  });
});

describe("provider selection", () => {
  const ANT = "sk-ant-test";
  it.each([
    ["anthropic key only", { ANTHROPIC_API_KEY: ANT }, "anthropic"],
    ["openai key only", { OPENAI_API_KEY: KEY }, "openai"],
    ["both keys (auto prefers anthropic)", { ANTHROPIC_API_KEY: ANT, OPENAI_API_KEY: KEY }, "anthropic"],
    ["empty anthropic key, openai key", { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: KEY }, "openai"],
    ["MARKET_PROVIDER=openai with both keys", { MARKET_PROVIDER: "openai", ANTHROPIC_API_KEY: ANT, OPENAI_API_KEY: KEY }, "openai"],
    ["MARKET_PROVIDER=anthropic with both keys", { MARKET_PROVIDER: "anthropic", ANTHROPIC_API_KEY: ANT, OPENAI_API_KEY: KEY }, "anthropic"],
    ["MARKET_PROVIDER is case-insensitive", { MARKET_PROVIDER: " OpenAI ", OPENAI_API_KEY: KEY }, "openai"],
    ["empty MARKET_PROVIDER means auto", { MARKET_PROVIDER: "", OPENAI_API_KEY: KEY }, "openai"],
  ] as const)("%s -> %s", (_label, env, provider) => {
    expect(selectMarketProvider(env)).toMatchObject({ provider });
  });

  it.each([
    ["neither key", {}, "no API key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)", false],
    ["both keys empty", { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, "no API key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)", false],
    ["MARKET_PROVIDER=openai, only an anthropic key", { MARKET_PROVIDER: "openai", ANTHROPIC_API_KEY: ANT }, "no OPENAI_API_KEY (MARKET_PROVIDER is openai)", true],
    ["MARKET_PROVIDER=anthropic, only an openai key", { MARKET_PROVIDER: "anthropic", OPENAI_API_KEY: KEY }, "no ANTHROPIC_API_KEY (MARKET_PROVIDER is anthropic)", true],
    ["MARKET_PROVIDER=openai, empty key", { MARKET_PROVIDER: "openai", OPENAI_API_KEY: "" }, "no OPENAI_API_KEY (MARKET_PROVIDER is openai)", true],
    ["unknown MARKET_PROVIDER", { MARKET_PROVIDER: "gemini", OPENAI_API_KEY: KEY }, 'MARKET_PROVIDER "gemini" is not one of anthropic, openai', true],
  ] as const)("%s -> fallback", (_label, env, reason, loud) => {
    expect(selectMarketProvider(env)).toEqual({ reason, loud });
  });

  it("picks each provider's model: MARKET_MODEL for anthropic, MARKET_OPENAI_MODEL for openai", () => {
    expect(selectMarketProvider({ ANTHROPIC_API_KEY: ANT })).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(selectMarketProvider({ OPENAI_API_KEY: KEY })).toMatchObject({ model: "gpt-5.4-mini" });
    expect(selectMarketProvider({ OPENAI_API_KEY: KEY, MARKET_MODEL: "claude-opus-5-5" })).toMatchObject({ model: "gpt-5.4-mini" });
    expect(selectMarketProvider({ OPENAI_API_KEY: KEY, MARKET_OPENAI_MODEL: "gpt-5.5" })).toMatchObject({ model: "gpt-5.5" });
  });

  it("an explicit provider without its key falls back with one log line and calls neither client", async () => {
    const { opts, calls, anthropicCalls, lines } = setup([reply(goodAnswer)], {
      env: { MARKET_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    const r = await scoreMarketFit(record, config, opts);
    expect(r.source).toBe("fallback");
    expect(r.fallback_reason).toBe("no OPENAI_API_KEY (MARKET_PROVIDER is openai)");
    expect(lines).toEqual(["market_fit: falling back (no OPENAI_API_KEY (MARKET_PROVIDER is openai))"]);
    expect(calls).toHaveLength(0);
    expect(anthropicCalls).toHaveLength(0);
  });

  it("offline and a provided market_fit block still come first", async () => {
    const off = setup([reply(goodAnswer)], { offline: true });
    expect((await scoreMarketFit(record, config, off.opts)).fallback_reason).toBe("offline mode");
    expect(off.calls).toHaveLength(0);
    const block = {
      acv: 0.1,
      copart: 0.2,
      confidence: 0.5,
      signals: [],
      insufficient: false,
      provider: "gemini-3.8-flash + Google Search",
      generated_at: "2026-11-07",
    };
    const provided = setup([reply(goodAnswer)]);
    const withBlock = { ...record, provided_market_fit: block };
    expect((await scoreMarketFit(withBlock, config, provided.opts)).source).toBe("provided");
    expect(provided.calls).toHaveLength(0);
  });
});

describe("cache keyed by provider and model", () => {
  it("an OpenAI answer is served from the cache to OpenAI only, never to Anthropic", async () => {
    const { opts, calls, lines } = setup([reply(goodAnswer)]);
    expect((await scoreMarketFit(record, config, opts)).source).toBe("web");

    const hit = await scoreMarketFit(record, config, opts);
    expect(hit.source).toBe("cache");
    expect(hit.factors[0]).toBe("Web market analysis (openai gpt-5.4-mini) favors ACV (ACV +0.60, Copart -0.10, confidence 0.70)");
    expect(hit.usage).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("market_fit: cache hit from 2026-11-07"))).toBe(true);

    // Same profile, same cache dir, Anthropic selected: a miss, so the Anthropic client is called.
    const anthropic = noAnthropic();
    const a = await scoreMarketFit(record, config, { ...opts, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, client: anthropic.client });
    expect(anthropic.calls).toHaveLength(1);
    expect(a.source).toBe("fallback"); // the fake Anthropic client throws

    // Another OpenAI model misses too.
    const other = fakeOpenAI([reply({ ...goodAnswer, acv: 0.2 })]);
    const m = await scoreMarketFit(record, config, {
      ...opts,
      openaiClient: other.client,
      env: { OPENAI_API_KEY: KEY, MARKET_OPENAI_MODEL: "gpt-5.5" },
    });
    expect(other.calls).toHaveLength(1);
    expect(m.acv).toBe(0.2);
  });
});

describe("openaiCostUsd", () => {
  const t = { input_tokens: 10_000, cached_input_tokens: 2_000, output_tokens: 1_000, reasoning_tokens: 300, web_search_requests: 3 };
  it("prices known models from the table (snapshot dates ignored); unknown models are null", () => {
    // 8,000 x $0.75 + 2,000 x $0.075 + 1,000 x $4.50 per MTok, plus 3 searches at $0.01.
    expect(openaiCostUsd("gpt-5.4-mini", t)).toBeCloseTo(0.006 + 0.00015 + 0.0045 + 0.03, 10);
    expect(openaiCostUsd("gpt-5.4-mini-2026-03-17", t)).toBeCloseTo(0.04065, 10);
    // 8,000 x $5 + 2,000 x $0.50 + 1,000 x $30 per MTok, plus searches.
    expect(openaiCostUsd("gpt-5.5", t)).toBeCloseTo(0.04 + 0.001 + 0.03 + 0.03, 10);
    expect(openaiCostUsd("gpt-9-test", t)).toBeNull();
  });

  it("usageCostKnown: anthropic always (unknown models are warned and counted at $0 tokens); openai only with a price", () => {
    const base = { requests: 1, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, cost_usd: 0 };
    expect(usageCostKnown({ ...base, model: "claude-sonnet-5-5" })).toBe(true);
    expect(usageCostKnown({ ...base, provider: "anthropic", model: "some-future-model" })).toBe(true);
    expect(usageCostKnown({ ...base, provider: "openai", model: "gpt-5.4-mini" })).toBe(true);
    expect(usageCostKnown({ ...base, provider: "openai", model: "gpt-9-test" })).toBe(false);
  });
});
