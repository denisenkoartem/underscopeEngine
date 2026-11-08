// Free-text parser (src/parse.ts, src/openaiParse.ts, the CLI parse command). Fully offline: every
// OpenAI call goes to a fake client. No real key is used anywhere in this file.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { decide } from "../src/combine.js";
import { loadConfig } from "../src/config.js";
import { scoreDrivable } from "../src/drivable.js";
import { normalizeRecord } from "../src/input.js";
import type { MessagesClient } from "../src/marketFit.js";
import {
  DEFAULT_PARSER_TIMEOUT_MS,
  MAX_PARSER_TIMEOUT_MS,
  MIN_PARSER_TIMEOUT_MS,
  PARSER_MODEL,
  describeOpenAIError,
  parserCostUsd,
  parserTimeoutMs,
  retryAfterMs,
  scrubKey,
  type ParserClient,
} from "../src/openaiParse.js";
import {
  EXTRACTION_JSON_SCHEMA,
  MARKET_JSON_SCHEMA,
  MARKET_MAX_TOOL_CALLS,
  ParseError,
  buildParseMarketPrompt,
  extractJsonObject,
  marketProfile,
  parseFreeText,
  quoteInText,
  toEngineInput,
  vehicleNameProblem,
  type ParseOptions,
} from "../src/parse.js";
import { FLAG_NAMES } from "../src/types.js";

const config = loadConfig();
/** A made-up key in the OpenAI key shape, so the scrubbing can be tested. Not a real key. */
const FAKE_KEY = "sk-proj-FAKE_test_key_00000000000000000000";
const ENV = { OPENAI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv;
const NOW = new Date("2026-11-07T12:00:00.000Z");

// ---- fake client ---------------------------------------------------------------------------

type Reply = Response | Error;

function fakeClient(...replies: Reply[]) {
  const calls: ResponseCreateParamsNonStreaming[] = [];
  const client: ParserClient = {
    responses: {
      async create(body) {
        calls.push(body);
        const r = replies.shift();
        if (r === undefined) throw new Error("test: unexpected extra OpenAI call");
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { client, calls };
}

interface ReplyExtra {
  /** Completed web searches before the answer: each with its queries and source URLs. */
  searches?: { queries: string[]; sources?: string[] }[];
  status?: "completed" | "incomplete";
  incompleteReason?: string;
  refusal?: string;
}

function reply(text: string, extra: ReplyExtra = {}): Response {
  const searches = (extra.searches ?? []).map((s, i) => ({
    type: "web_search_call",
    id: `ws_${i}`,
    status: "completed",
    action: { type: "search", queries: s.queries, sources: (s.sources ?? []).map((url) => ({ type: "url", url })) },
  }));
  const content = extra.refusal !== undefined ? [{ type: "refusal", refusal: extra.refusal }] : [{ type: "output_text", text, annotations: [] }];
  return {
    id: "resp_test",
    object: "response",
    model: "gpt-4o-mini-2024-07-18",
    status: extra.status ?? "completed",
    incomplete_details: extra.incompleteReason ? { reason: extra.incompleteReason } : null,
    output: [...searches, { type: "message", id: "msg_test", role: "assistant", status: "completed", content }],
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1100,
    },
    ...(searches.length ? { tool_usage: { web_search: { num_requests: searches.length } } } : {}),
  } as unknown as Response;
}

/** An extraction answer: every field the strict schema has, null unless `x` sets it. */
const extraction = (x: Record<string, unknown>) => {
  const nothing = { value: null, evidence: null };
  const flags = Object.fromEntries(FLAG_NAMES.map((f) => [f, nothing]));
  const fields = ["vin", "year", "make", "model", "trim", "odometer", "location_state", "title_brand", "title_state", "runs_drives",
    "scan_done", "lanes_allowed", "clean_wholesale", "salvage_comps", "purchase_price"];
  const base = { ...Object.fromEntries(fields.map((f) => [f, nothing])), flags, codes: [], reported_symptoms: [], unmapped: [] };
  const merged = { ...base, ...x, flags: { ...flags, ...((x.flags as object | undefined) ?? {}) } };
  return reply(JSON.stringify(merged));
};
const ev = (value: unknown, evidence: string) => ({ value, evidence });

/** An OpenAI API error as the SDK builds it from an HTTP error response. */
const apiError = (
  status: number,
  message: string,
  code: string | null = null,
  type = "invalid_request_error",
  headers: Record<string, string> = {},
) =>
  OpenAI.APIError.generate(status, { error: { message, type, code, param: null } }, undefined, new Headers(headers));

const logs: string[] = [];
const opts = (client: ParserClient, extra: Partial<ParseOptions> = {}): ParseOptions => ({
  client,
  env: ENV,
  now: NOW,
  log: (l) => void logs.push(l),
  sleep: async () => {},
  ...extra,
});
const userText = (p: ResponseCreateParamsNonStreaming): string => JSON.stringify(p.input);

afterEach(() => {
  logs.length = 0;
  vi.restoreAllMocks();
});

// ---- extraction ----------------------------------------------------------------------------

const NOISE = "transmission is generating noise";

describe("extraction: one short complaint", () => {
  // Round 4b (OPENAI.md item C): this test used to expect run_and_drive from the NOISE quote. That
  // was the live miss the user reported, so a complaint alone now sets no run status.
  it("maps the symptom with evidence; the complaint alone sets no run status; everything else unknown/null", async () => {
    const { client, calls } = fakeClient(
      extraction({
        runs_drives: ev("run_and_drive", NOISE),
        reported_symptoms: [{ system: "transmission", text: NOISE }],
      }),
    );
    const r = await parseFreeText(NOISE, opts(client));

    expect(r.record).toEqual({
      vin: null,
      decoded: { year: null, make: null, model: null, trim: null },
      odometer: null,
      location_state: null,
      title: { brand: "unknown", state: null },
      runs_drives: "unknown",
      flags: Object.fromEntries(FLAG_NAMES.map((f) => [f, "unknown"])),
      codes: null,
      seller: { lanes_allowed: null },
      reported_symptoms: [{ system: "transmission", text: NOISE }],
      valuation: null,
    });
    expect(r.parser.field_evidence).toEqual({ "reported_symptoms[0]": NOISE });
    expect(r.parser.unknown_fields).toContain("decoded.year");
    expect(r.parser.unknown_fields).toContain("codes");
    expect(r.parser.unknown_fields).toContain("runs_drives");
    expect(r.parser.notes[0]).toBe(
      `runs_drives: quote "${NOISE}" does not say whether it runs, drives or starts (runs, drives, starts, won't start, cranks, towed...); runs_drives reset to unknown`,
    );
    // No year/make/model: no market call.
    expect(r.market_fit).toBeUndefined();
    expect(r.parser.market_model).toBeNull();
    expect(r.parser.notes.join(" ")).toMatch(/market fit skipped: it needs year, make and model.*year, make, model/);
    expect(calls).toHaveLength(1);
    expect(r.parser.input_text).toBe(NOISE);
    expect(r.parser.usage).toEqual([
      expect.objectContaining({
        call: "extraction",
        model: "gpt-4o-mini",
        input_tokens: 900,
        cached_input_tokens: 100,
        output_tokens: 200,
        web_searches: 0,
        status: "completed",
      }),
    ]);
    // 800 uncached x $0.15 + 100 cached x $0.075 + 200 output x $0.60, per million tokens.
    expect(r.parser.usage[0]!.cost_usd).toBeCloseTo((800 * 0.15 + 100 * 0.075 + 200 * 0.6) / 1e6, 12);
  });

  it("sends a strict json_schema request at temperature 0 with no tools; the notes are the input", async () => {
    const { client, calls } = fakeClient(extraction({}));
    await parseFreeText(NOISE, opts(client));
    const p = calls[0]!;
    expect(p.model).toBe("gpt-4o-mini");
    expect(p.text?.format).toEqual({ type: "json_schema", name: "condition_record", strict: true, schema: EXTRACTION_JSON_SCHEMA });
    expect(p.temperature).toBe(0);
    expect(p.store).toBe(false);
    expect(p.tools).toBeUndefined();
    expect(p).not.toHaveProperty("reasoning"); // gpt-4o-mini rejects reasoning settings
    expect(String(p.instructions)).toMatch(/Fill a field ONLY when the notes support it/);
    expect(String(p.instructions)).not.toMatch(/<!--/);
    expect(p.input).toBe(`<notes>\n${NOISE}\n</notes>`);
    // Usage line on the log, with the cost.
    expect(logs.some((l) => /^parse: calling gpt-4o-mini \(extraction\) \.\.\.$/.test(l))).toBe(true);
    expect(logs.find((l) => l.startsWith("parse: openai call (extraction)"))).toMatch(
      /model=gpt-4o-mini status=completed input=900 cached=100 output=200 web_searches=0 latency=\d+\.\ds cost: \$0\.0002$/,
    );
  });

  it("the strict schema requires every property and allows no others, at every level", () => {
    const check = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown };
      if (n.properties) {
        expect(n.required, path).toEqual(Object.keys(n.properties));
        expect(n.additionalProperties, path).toBe(false);
        for (const [k, v] of Object.entries(n.properties)) check(v, `${path}.${k}`);
      }
      if (n.items) check(n.items, `${path}[]`);
    };
    check(EXTRACTION_JSON_SCHEMA, "extraction");
    check(MARKET_JSON_SCHEMA, "market");
  });

  it("always uses gpt-4o-mini: PARSER_MODEL / PARSER_MARKET_MODEL are ignored with a warning", async () => {
    const { client, calls } = fakeClient(extraction({}));
    const r = await parseFreeText(NOISE, opts(client, { env: { ...ENV, PARSER_MODEL: "gemini-3.7-flash", PARSER_MARKET_MODEL: "x" } }));
    expect(PARSER_MODEL).toBe("gpt-4o-mini");
    expect(calls[0]!.model).toBe("gpt-4o-mini");
    expect(r.parser.model).toBe("gpt-4o-mini");
    expect(logs).toContain("parse: WARNING PARSER_MODEL is set but ignored: the parser always uses gpt-4o-mini");
    expect(logs).toContain("parse: WARNING PARSER_MARKET_MODEL is set but ignored: the parser always uses gpt-4o-mini");
  });
});

const RICH =
  "2018 Chevy Silverado 1500 LT, VIN 1GCVKREC5JZ123456, 112,300 miles, located in Ohio. Clean title. " +
  "Runs and drives. Musty smell inside and a water line on the door panels. Airbag light is on. " +
  "Scanned: P0301 and P0420 current, U0100 pending. New tires.";

const richExtraction = () =>
  extraction({
    vin: ev("1GCVKREC5JZ123456", "VIN 1GCVKREC5JZ123456"),
    year: ev(2018, "2018"),
    make: ev("Chevrolet", "Chevy"),
    model: ev("Silverado 1500", "Silverado 1500"),
    trim: ev("LT", "1500 LT"),
    odometer: ev(112300, "112,300 miles"),
    location_state: ev("OH", "located in Ohio"),
    title_brand: ev("clean", "Clean title"),
    runs_drives: ev("run_and_drive", "Runs and drives"),
    flags: {
      flood: ev("suspected", "Musty smell inside and a water line on the door panels"),
      airbag: ev("suspected", "Airbag light is on"),
      frame: ev("unknown", ""),
    },
    codes: [
      { code: "P0301", status: "confirmed", evidence: "P0301 and P0420 current" },
      { code: "p0420", status: "confirmed", evidence: "P0301 and P0420 current" },
      { code: "U0100", status: "pending", evidence: "U0100 pending" },
    ],
    reported_symptoms: [{ system: "electrical", text: "Airbag light is on" }],
    unmapped: ["New tires", "New tires", "  "],
  });

const MARKET_JSON = {
  acv: 0.4,
  copart: 0.2,
  confidence: 0.6,
  insufficient: false,
  signals: [
    { claim: "Retail listings average $27,000", url: "https://www.edmunds.com/chevrolet/silverado-1500/2018/" },
    { claim: "Comparable LTs sell in about 40 days", url: "https://www.kbb.com/chevrolet/silverado-1500/2018/" },
    { claim: "Salvage units draw strong bids" },
    { claim: "Parts demand is high", url: "ftp://parts.example.com/silverado" },
  ],
};
const SEARCHED: ReplyExtra = {
  searches: [
    { queries: ["2018 Chevrolet Silverado 1500 LT retail price Ohio"], sources: ["https://www.kbb.com/chevrolet/silverado-1500/"] },
    { queries: ["2018 Silverado 1500 salvage auction results"], sources: ["https://www.copart.com/lot/123"] },
  ],
};
const marketReply = (json: unknown = MARKET_JSON, extra: ReplyExtra = SEARCHED) => reply(JSON.stringify(json), extra);

describe("extraction: a richer paragraph", () => {
  it("maps every stated field, with evidence, and runs the market call", async () => {
    const { client } = fakeClient(richExtraction(), marketReply());
    const r = await parseFreeText(RICH, opts(client));
    expect(r.record).toEqual({
      vin: "1GCVKREC5JZ123456",
      decoded: { year: 2018, make: "Chevrolet", model: "Silverado 1500", trim: "LT" },
      odometer: 112300,
      location_state: "OH",
      title: { brand: "clean", state: null },
      runs_drives: "run_and_drive",
      flags: { frame: "unknown", airbag: "suspected", flood: "suspected", module_no_comm: "unknown", monitors_incomplete: "unknown" },
      codes: [
        { code: "P0301", status: "confirmed" },
        { code: "P0420", status: "confirmed" },
        { code: "U0100", status: "pending" },
      ],
      seller: { lanes_allowed: null },
      reported_symptoms: [{ system: "electrical", text: "Airbag light is on" }],
      valuation: null, // round 4b: the record always has a valuation key; RICH gives no price
    });
    expect(r.parser.field_evidence).toMatchObject({
      "decoded.make": "Chevy",
      odometer: "112,300 miles",
      location_state: "located in Ohio",
      "title.brand": "Clean title",
      "flags.flood": "Musty smell inside and a water line on the door panels",
      "codes[2]": "U0100 pending",
    });
    expect(r.parser.unmapped).toEqual(["New tires"]);
    expect(r.parser.notes).toEqual(["market fit: dropped 2 signal(s) without a claim or an http(s) URL"]);
  });

  it("market call: only the eight profile fields are sent, with the web_search tool and a strict JSON answer", async () => {
    const { client, calls } = fakeClient(richExtraction(), marketReply());
    await parseFreeText(RICH, opts(client));
    expect(calls).toHaveLength(2);
    const p = calls[1]!;
    expect(p.model).toBe("gpt-4o-mini");
    expect(p.tools).toEqual([{ type: "web_search" }]);
    expect(p.include).toEqual(["web_search_call.action.sources"]);
    expect(p.max_tool_calls).toBe(MARKET_MAX_TOOL_CALLS);
    expect(p.text?.format).toEqual({ type: "json_schema", name: "market_fit", strict: true, schema: MARKET_JSON_SCHEMA });
    expect(p.instructions).toBeUndefined();
    expect(p).not.toHaveProperty("reasoning");
    const sent = userText(p);
    for (const s of ["Year: 2018", "Make: Chevrolet", "Model: Silverado 1500", "Trim: LT", "Odometer: 112,300 miles",
      "Location (US state): OH", "Title brand: clean", "Run status: runs and drives"]) {
      expect(sent).toContain(s);
    }
    for (const s of ["1GCVKREC5JZ123456", "P0301", "U0100", "Musty", "water line", "Airbag light", "tires", "<notes>", "Chevy"]) {
      expect(sent).not.toContain(s);
    }
    expect(sent).not.toMatch(/<!--/);
  });

  it("market block: scores as given, searched-site signals first, URL-less and non-http signals dropped, queries recorded", async () => {
    const { client } = fakeClient(richExtraction(), marketReply());
    const r = await parseFreeText(RICH, opts(client));
    expect(r.market_fit).toEqual({
      acv: 0.4,
      copart: 0.2,
      confidence: 0.6,
      signals: [
        // kbb.com is the host of a web search source, so it comes first.
        { claim: "Comparable LTs sell in about 40 days", url: "https://www.kbb.com/chevrolet/silverado-1500/2018/" },
        { claim: "Retail listings average $27,000", url: "https://www.edmunds.com/chevrolet/silverado-1500/2018/" },
      ],
      insufficient: false,
      provider: "gpt-4o-mini + OpenAI web search",
      generated_at: "2026-11-07T12:00:00.000Z",
    });
    expect(r.parser.market_model).toBe("gpt-4o-mini");
    expect(r.parser.search_queries).toEqual(["2018 Chevrolet Silverado 1500 LT retail price Ohio", "2018 Silverado 1500 salvage auction results"]);
    expect(r.parser.usage.map((u) => [u.call, u.web_searches])).toEqual([
      ["extraction", 0],
      ["market", 2],
    ]);
    // Two searches at $10 per 1,000 on top of the tokens.
    expect(r.parser.usage[1]!.cost_usd).toBeCloseTo((800 * 0.15 + 100 * 0.075 + 200 * 0.6) / 1e6 + 0.02, 12);
    expect(logs.find((l) => l.startsWith("parse: openai call (market)"))).toMatch(/web_searches=2 .* cost: \$0\.0202$/);
  });

  it("parserCostUsd: a dated snapshot id uses the base row; an unknown model has no cost", () => {
    const u = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0, web_searches: 0 };
    expect(parserCostUsd("gpt-4o-mini-2024-07-18", u)).toBeCloseTo(0.15, 12);
    expect(parserCostUsd("some-other-model", u)).toBeNull();
  });

  it("--no-market (market: false) makes no market call", async () => {
    const { client, calls } = fakeClient(richExtraction());
    const r = await parseFreeText(RICH, opts(client, { market: false }));
    expect(calls).toHaveLength(1);
    expect(r.market_fit).toBeUndefined();
    expect(r.parser.notes).toContain("market fit skipped (--no-market)");
  });
});

describe("extraction: evidence rules enforced in code", () => {
  it("drops a code that is not literally in the text, and notes a code in the text that was not extracted", async () => {
    const text = "check engine light on, scan shows p0301 stored and B1234";
    const { client } = fakeClient(
      extraction({
        codes: [
          { code: "P0301", status: "confirmed", evidence: "p0301 stored" },
          { code: "P0420", status: "confirmed", evidence: "check engine light on" },
          { code: "P03O1", status: "confirmed", evidence: "p0301" },
        ],
      }),
    );
    const r = await parseFreeText(text, opts(client));
    expect(r.record.codes).toEqual([{ code: "P0301", status: "confirmed" }]);
    expect(r.parser.field_evidence["codes[0]"]).toBe("p0301 stored");
    expect(r.parser.notes).toEqual([
      "code P0420 is not in the text; dropped",
      'code "P03O1" is not an OBD-II code; dropped',
      "code B1234 is in the text but was not extracted; left out",
      "market fit skipped: it needs year, make and model, and the text does not give year, make, model",
    ]);
    expect(logs).toContain("parse: WARNING code P0420 is not in the text; dropped");
  });

  it("resets a field whose evidence quote is not in the text (with a warning)", async () => {
    const text = "2015 Ram 1500, runs fine, some rust";
    const { client } = fakeClient(
      extraction({
        year: ev(2015, "2015"),
        title_brand: ev("salvage", "salvage title"),
        flags: { frame: ev("yes", "frame is bent") },
        runs_drives: ev("run_and_drive", "Runs Fine"), // case differs: still a match
      }),
    );
    const r = await parseFreeText(text, opts(client, { market: false }));
    expect(r.record.title).toEqual({ brand: "unknown", state: null });
    expect(r.record.flags?.frame).toBe("unknown");
    expect(r.record.decoded?.year).toBe(2015);
    expect(r.record.runs_drives).toBe("run_and_drive");
    expect(r.parser.field_evidence).toEqual({ "decoded.year": "2015", runs_drives: "Runs Fine" });
    expect(r.parser.unknown_fields).toEqual(expect.arrayContaining(["title.brand", "flags.frame"]));
    expect(logs).toContain('parse: WARNING title.brand: evidence "salvage title" is not in the text; title.brand reset to unknown');
    expect(logs).toContain('parse: WARNING flags.frame: evidence "frame is bent" is not in the text; flags.frame reset to unknown');
  });

  it("never keeps an invented VIN, year, make, model, mileage or state, even with a real quote", async () => {
    const text = "Old Ford pickup with low miles, VIN ends 4521, from Indiana";
    const { client, calls } = fakeClient(
      extraction({
        vin: ev("1FTFW1E50NFA04521", "VIN ends 4521"),
        year: ev(2012, "Old Ford pickup"),
        make: ev("Ford", "Ford"),
        model: ev("F-150", "Ford pickup"),
        odometer: ev(50000, "low miles"),
        location_state: ev("IN", "from Indiana"),
      }),
    );
    const r = await parseFreeText(text, opts(client));
    expect(r.record.vin).toBeNull();
    expect(r.record.decoded).toEqual({ year: null, make: "Ford", model: null, trim: null });
    expect(r.record.odometer).toBeNull();
    expect(r.record.location_state).toBe("IN");
    expect(r.parser.notes).toEqual([
      "vin: VIN 1FTFW1E50NFA04521 is not written in the text; vin reset to unknown",
      "decoded.year: year 2012 is not shown by the quote; decoded.year reset to unknown",
      'decoded.model: "F-150" is not shown by the quote; decoded.model reset to unknown',
      "odometer: 50000 miles is not shown by the quote; odometer reset to unknown",
      "market fit skipped: it needs year, make and model, and the text does not give year, model",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("accepts mileage and year in common short forms", async () => {
    const text = "'19 f150 xlt w/ 84.5k mi in tx";
    const { client } = fakeClient(
      extraction({
        year: ev(2019, "'19"),
        make: ev("Ford", "f150"), // a model-only quote does not show the make
        model: ev("F-150", "f150"),
        trim: ev("XLT", "xlt"),
        odometer: ev(84500, "84.5k mi"),
        location_state: ev("TX", "in tx"),
      }),
    );
    const r = await parseFreeText(text, opts(client, { market: false }));
    expect(r.record.decoded).toEqual({ year: 2019, make: null, model: "F-150", trim: "XLT" });
    expect(r.record.odometer).toBe(84500);
    expect(r.record.location_state).toBe("TX");
    expect(r.parser.field_evidence["decoded.year"]).toBe("'19"); // a leading apostrophe is not a wrapping quote
  });

  it("drops a symptom whose words are not in the text and maps an unknown system to other", async () => {
    const text = "brakes squeal and the radio is dead";
    const { client } = fakeClient(
      extraction({
        reported_symptoms: [
          { system: "brakes", text: "brakes squeal" },
          { system: "audio", text: "the radio is dead" },
          { system: "engine", text: "engine knocks" },
          { system: "brakes", text: "Brakes squeal" },
        ],
      }),
    );
    const r = await parseFreeText(text, opts(client));
    expect(r.record.reported_symptoms).toEqual([
      { system: "brakes", text: "brakes squeal" },
      { system: "other", text: "the radio is dead" },
    ]);
    expect(r.parser.notes).toContain('reported symptom "engine knocks" is not in the text; dropped');
  });

  it("an empty scan becomes codes: [] with evidence; an empty lane list is refused", async () => {
    const text = "scanned it, no codes. seller wants it gone anywhere";
    const { client } = fakeClient(
      extraction({ scan_done: ev(true, "scanned it, no codes"), lanes_allowed: ev([], "seller wants it gone anywhere") }),
    );
    const r = await parseFreeText(text, opts(client));
    expect(r.record.codes).toEqual([]);
    expect(r.parser.field_evidence.codes).toBe("scanned it, no codes");
    expect(r.parser.unknown_fields).not.toContain("codes");
    expect(r.record.seller).toEqual({ lanes_allowed: null });
    expect(r.parser.notes[0]).toMatch(/seller\.lanes_allowed: an empty lane list would exclude both options/);
  });

  it("keeps a stated lane limit", async () => {
    const text = "only sell it at Copart please";
    const { client } = fakeClient(extraction({ lanes_allowed: ev(["copart"], "only sell it at Copart") }));
    const r = await parseFreeText(text, opts(client));
    expect(r.record.seller).toEqual({ lanes_allowed: ["copart"] });
  });

  it("quoteInText ignores case, spacing and quote style", () => {
    expect(quoteInText("“Driver’s  door”", "the driver's door sticks")).toBe(true);
    expect(quoteInText("", "anything")).toBe(false);
    expect(quoteInText("passenger door", "the driver's door sticks")).toBe(false);
  });
});

/** One extraction (no market call) of `text`, with the model answering `x`. */
const extractOnly = async (text: string, x: Record<string, unknown>) => {
  const { client } = fakeClient(extraction(x));
  return parseFreeText(text, opts(client, { market: false }));
};
const warnings = (r: { parser: { notes: string[] } }) => r.parser.notes.filter((n) => n !== "market fit skipped (--no-market)");

describe("extraction: code status and evidence", () => {
  it("a code the text calls pending is not kept as confirmed (no severe modifier); a made-up code quote is warned about", async () => {
    const text = "old scan: P0301 pending, P0420 pending; drives fine";
    const r = await extractOnly(text, {
      runs_drives: ev("run_and_drive", "drives fine"),
      codes: [
        { code: "P0301", status: "confirmed", evidence: "made up quote" },
        { code: "P0420", status: "confirmed", evidence: "P0420 pending" },
      ],
    });
    expect(r.record.codes).toEqual([
      { code: "P0301", status: "pending" },
      { code: "P0420", status: "pending" },
    ]);
    expect(r.parser.field_evidence).toMatchObject({ "codes[0]": "P0301", "codes[1]": "P0420 pending" });
    expect(warnings(r)).toEqual([
      'codes[0] P0301: evidence "made up quote" is not in the text; the code is, so it is kept with the code as its evidence',
      'codes[0] P0301: the text says "pending" right after the code; status set to pending, not confirmed',
      'codes[1] P0420: the text says "pending" right after the code; status set to pending, not confirmed',
    ]);
    expect(logs).toContain('parse: WARNING codes[0] P0301: the text says "pending" right after the code; status set to pending, not confirmed');
    // MISFIRE+CATALYST needs confirmed codes, so the severe modifier is not applied.
    const d = scoreDrivable(normalizeRecord(toEngineInput(r)), config);
    expect(d.factors.join(" ")).not.toMatch(/Severe/);
    expect(d.factors).toContain("Not counted (not confirmed): P0301 pending, P0420 pending");
  });

  it("reads only the clause right after each code: cleared/past -> history; 'and P0420 current, U0100 pending' keeps P0301 confirmed", async () => {
    const text = "Scanned: P0301 and P0420 current, U0100 pending. P0171 was cleared last week; P0455 in the past";
    const quote = "P0301 and P0420 current, U0100 pending";
    const r = await extractOnly(text, {
      codes: ["P0301", "P0420", "U0100", "P0171", "P0455"].map((code) => ({ code, status: "confirmed", evidence: quote })),
    });
    expect(r.record.codes).toEqual([
      { code: "P0301", status: "confirmed" },
      { code: "P0420", status: "confirmed" },
      { code: "U0100", status: "pending" },
      { code: "P0171", status: "history" },
      { code: "P0455", status: "history" },
    ]);
    expect(warnings(r)).toHaveLength(3);
    // A pending/history answer is kept as the model gave it.
    const pending = await extractOnly("P0301 current", { codes: [{ code: "P0301", status: "pending", evidence: "P0301 current" }] });
    expect(pending.record.codes).toEqual([{ code: "P0301", status: "pending" }]);
  });

  it("a stated scan whose code was not kept leaves codes unknown, not 'scan found no codes'", async () => {
    const text = "scanned it, P0301 showing";
    const r = await extractOnly(text, {
      scan_done: ev(true, "scanned it"),
      codes: [{ code: "P0310", status: "confirmed", evidence: "P0301 showing" }],
    });
    expect(r.record.codes).toBeNull();
    expect(r.parser.unknown_fields).toContain("codes");
    expect(r.parser.field_evidence).not.toHaveProperty("codes");
    expect(warnings(r)).toEqual([
      "code P0310 is not in the text; dropped",
      "code P0301 is in the text but was not extracted; left out",
      'codes: the text mentions a scan and P0301, but no code was kept; codes left unknown, not "scan found no codes"',
    ]);
    expect(normalizeRecord(toEngineInput(r)).codes_provided).toBe(false);
  });
});

describe("extraction: enum quotes must support the value", () => {
  it("a one-letter quote supports no title brand, run status, flag, lane or symptom", async () => {
    const text = "2019 Ford F-150, frame checked and straight, drives fine";
    const r = await extractOnly(text, {
      title_brand: ev("salvage", "e"),
      runs_drives: ev("no", "d"),
      flags: { flood: ev("suspected", "a"), frame: ev("no", "frame checked and straight") },
      lanes_allowed: ev(["copart"], "r"),
      reported_symptoms: [{ system: "engine", text: "n" }],
    });
    expect(r.record.title?.brand).toBe("unknown");
    expect(r.record.runs_drives).toBe("unknown");
    expect(r.record.flags).toMatchObject({ flood: "unknown", frame: "no" });
    expect(r.record.seller).toEqual({ lanes_allowed: null });
    expect(r.record.reported_symptoms).toEqual([]);
    expect(r.parser.field_evidence).toEqual({ "flags.frame": "frame checked and straight" });
    expect(warnings(r)).toEqual([
      'title.brand: quote "e" does not say "salvage"; title.brand reset to unknown',
      'runs_drives: quote "d" has no word of 3 or more letters; runs_drives reset to unknown',
      'flags.flood: quote "a" has no word of 3 or more letters; flags.flood reset to unknown',
      'seller.lanes_allowed: quote "r" does not name the copart lane ("salvage", "Copart" or "auction"); seller.lanes_allowed reset to unknown',
      'reported symptom "n" has no word of 3 or more letters; dropped',
    ]);
  });

  it("a title brand needs its word: 'insurance totaled it' is no salvage title; Spanish 'salvamento' and 'parts only' are", async () => {
    const totaled = await extractOnly("2016 Honda Civic, insurance totaled it", { title_brand: ev("salvage", "insurance totaled it") });
    expect(totaled.record.title?.brand).toBe("unknown");
    expect(warnings(totaled)).toEqual([
      'title.brand: quote "insurance totaled it" does not say "salvage"; title.brand reset to unknown',
    ]);
    const es = await extractOnly("Título de salvamento.", { title_brand: ev("salvage", "Título de salvamento") });
    expect(es.record.title?.brand).toBe("salvage");
    const parts = await extractOnly("parts only title", { title_brand: ev("nonrepairable", "parts only title") });
    expect(parts.record.title?.brand).toBe("nonrepairable");
    const wrongWord = await extractOnly("rebuilt title", { title_brand: ev("clean", "rebuilt title") });
    expect(wrongWord.record.title?.brand).toBe("unknown");
  });

  it("each allowed lane must be named by the quote", async () => {
    const dealer = await extractOnly("dealer auctions only", { lanes_allowed: ev(["acv"], "dealer auctions only") });
    expect(dealer.record.seller).toEqual({ lanes_allowed: ["acv"] });
    const unnamed = await extractOnly("sell it fast please", { lanes_allowed: ev(["acv"], "sell it fast") });
    expect(unnamed.record.seller).toEqual({ lanes_allowed: null });
    expect(warnings(unnamed)[0]).toMatch(/does not name the acv lane \("dealer" or "ACV"\)/);
  });

  it("a symptom that only repeats a no-start run status is dropped; a real engine complaint stays", async () => {
    const text = "2012 Toyota Camry LE, does not start, engine seized";
    const r = await extractOnly(text, {
      runs_drives: ev("no", "does not start"),
      reported_symptoms: [
        { system: "engine", text: "does not start" },
        { system: "engine", text: "engine seized" },
      ],
    });
    expect(r.record.runs_drives).toBe("no");
    expect(r.record.reported_symptoms).toEqual([{ system: "engine", text: "engine seized" }]);
    expect(r.parser.field_evidence).toMatchObject({ runs_drives: "does not start", "reported_symptoms[0]": "engine seized" });
    expect(warnings(r)).toEqual(['reported symptom "does not start" only restates the run status (no); dropped']);
    // While it drives, one sentence can be both the run-status quote and the symptom.
    // (Round 4b: the quote must say it drives, so NOISE alone no longer serves; see item C tests.)
    const WHINES = "drives fine but the transmission whines";
    const drives = await extractOnly(WHINES, {
      runs_drives: ev("run_and_drive", WHINES),
      reported_symptoms: [{ system: "transmission", text: WHINES }],
    });
    expect(drives.record.runs_drives).toBe("run_and_drive");
    expect(drives.record.reported_symptoms).toEqual([{ system: "transmission", text: WHINES }]);
  });
});

describe("extraction: odometer and year must really be shown", () => {
  const odo = async (text: string, miles: number, quote: string) =>
    (await extractOnly(text, { odometer: ev(miles, quote) })).record.odometer;

  it("rejects kilometres, the model year, the 150 of F-150 and a bare number", async () => {
    expect(await odo("84,000 km, runs fine", 84000, "84,000 km")).toBeNull();
    expect(await odo("84,000 km, runs fine", 84000, "84,000")).toBeNull(); // km right after the quote
    expect(await odo("84k km", 84000, "84k")).toBeNull();
    expect(await odo("2019 Ford F-150", 2019, "2019 Ford")).toBeNull();
    expect(await odo("2019 Ford F-150", 150, "F-150")).toBeNull();
    expect(await odo("asking 18,500 obo", 18500, "18,500")).toBeNull();
  });

  it("accepts mileage with a unit or odometer word in the quote or right next to it", async () => {
    expect(await odo("84,500 miles, clean", 84500, "84,500")).toBe(84500); // unit just after the quote
    expect(await odo("odometer reads 91,200", 91200, "91,200")).toBe(91200);
    expect(await odo("91200 on the odo", 91200, "91200")).toBe(91200);
    expect(await odo("about 120 thousand miles", 120000, "120 thousand")).toBe(120000);
    expect(await odo("high miles (210k)", 210000, "210k")).toBe(210000);
  });

  it("accepts Spanish and European thousands (85 mil millas, 85.000, 85 000) but 85.5 miles stays 85.5", async () => {
    expect(await odo("Troca Ford F-150 XLT 2018, 85 mil millas, está en Texas", 85000, "85 mil millas")).toBe(85000);
    expect(await odo("85.000 millas", 85000, "85.000 millas")).toBe(85000);
    expect(await odo("85 000 miles", 85000, "85 000 miles")).toBe(85000);
    expect(await odo("84.5k mi", 84500, "84.5k mi")).toBe(84500);
    expect(await odo("85.5 miles on the trip meter", 85500, "85.5 miles")).toBeNull();
    expect(await odo("85.5 miles on the trip meter", 85000, "85.5 miles")).toBeNull();
  });

  it("a 2-digit year counts only as '19 or right before the make or model, not as '19 mph'", async () => {
    const mph = await extractOnly("drives fine at 19 mph", { year: ev(2019, "19 mph") });
    expect(mph.record.decoded?.year).toBeNull();
    expect(warnings(mph)).toEqual(["decoded.year: year 2019 is not shown by the quote; decoded.year reset to unknown"]);
    const beforeMake = await extractOnly("19 Ford F-150, runs", { year: ev(2019, "19"), make: ev("Ford", "Ford") });
    expect(beforeMake.record.decoded?.year).toBe(2019);
    const beforeAlias = await extractOnly("19 chevy silverado", { year: ev(2019, "19 chevy"), make: ev("Chevrolet", "chevy") });
    expect(beforeAlias.record.decoded?.year).toBe(2019);
  });
});

describe("extraction: make, model and trim are short plain names (they reach the market prompt)", () => {
  const VIN = "1FTEW1E50KFA12345";
  const LONG_TRIM = `XLT drives but the transmission is generating noise, VIN ${VIN}`;
  const TEXT = `2019 Ford F-150 ${LONG_TRIM}`;
  const SYMPTOM = "the transmission is generating noise";

  it("a trim carrying notes, a symptom or the VIN is reset, and the market prompt never sees them", async () => {
    const { client, calls } = fakeClient(
      extraction({
        year: ev(2019, "2019"),
        make: ev("Ford", "Ford"),
        model: ev("F-150", "F-150"),
        trim: ev(LONG_TRIM, LONG_TRIM),
        vin: ev(VIN, `VIN ${VIN}`),
        runs_drives: ev("run_and_drive", "drives"),
        reported_symptoms: [{ system: "transmission", text: SYMPTOM }],
      }),
      marketReply(),
    );
    const r = await parseFreeText(TEXT, opts(client));
    expect(r.record.decoded).toEqual({ year: 2019, make: "Ford", model: "F-150", trim: null });
    expect(r.record.vin).toBe(VIN);
    expect(r.parser.notes[0]).toMatch(/^decoded\.trim: ".*" is longer than 40 characters, not a vehicle name; decoded\.trim reset to unknown$/);
    const sent = userText(calls[1]!);
    expect(sent).toContain("Trim: unknown");
    for (const s of [VIN, "transmission", "noise", "drives but"]) expect(sent).not.toContain(s);
  });

  it("vehicleNameProblem: length, characters, VIN-shaped token, a contained symptom; real names pass", () => {
    expect(vehicleNameProblem("XLT transmission is generating noise", ["transmission is generating noise"])).toMatch(
      /contains the reported symptom "transmission is generating noise"/,
    );
    expect(vehicleNameProblem("Silverado 1500 1GCVKREC5JZ123456", [])).toMatch(/VIN-shaped token/);
    expect(vehicleNameProblem("XLT, 4WD", [])).toMatch(/characters a vehicle name does not use/);
    for (const name of ["King Ranch SuperCrew 4x4 5.5 ft", "Mercedes-Benz", "Silverado 1500", "F-150", "LT", "Rogue S/SV", "Grand Cherokee"]) {
      expect(vehicleNameProblem(name, ["Grand Cherokee pulls left"])).toBeNull();
    }
  });

  it("a 36-character trim that holds the symptom text is reset too", async () => {
    const text = "2019 Ford F-150 XLT transmission is generating noise";
    const r = await extractOnly(text, {
      trim: ev("XLT transmission is generating noise", "XLT transmission is generating noise"),
      reported_symptoms: [{ system: "transmission", text: "transmission is generating noise" }],
    });
    expect(r.record.decoded?.trim).toBeNull();
    expect(r.record.reported_symptoms).toEqual([{ system: "transmission", text: "transmission is generating noise" }]);
  });

  it("marketProfile drops a trim (or the whole profile) that is not a plain name", () => {
    const base = {
      vin: null, odometer: null, location_state: null, title: { brand: "unknown" as const, state: null },
      runs_drives: "unknown" as const, codes: null, seller: { lanes_allowed: null },
      reported_symptoms: [{ system: "transmission" as const, text: SYMPTOM }],
    };
    expect(marketProfile({ ...base, decoded: { year: 2019, make: "Ford", model: "F-150", trim: `XLT ${SYMPTOM}` } })?.trim).toBeNull();
    expect(marketProfile({ ...base, decoded: { year: 2019, make: "Ford", model: `F-150 ${VIN}`, trim: null } })).toBeNull();
    expect(marketProfile({ ...base, decoded: { year: 2019, make: "Ford", model: "F-150", trim: "XLT" } })?.trim).toBe("XLT");
  });
});

describe("extraction: invalid output", () => {
  it("retries once, then succeeds", async () => {
    const { client, calls } = fakeClient(reply("not json"), extraction({ runs_drives: ev("no", "won't start") }));
    const r = await parseFreeText("won't start", opts(client));
    expect(calls).toHaveLength(2);
    expect(r.record.runs_drives).toBe("no");
    expect(logs).toContain("parse: extraction attempt 1: reply is not valid JSON; retrying once");
  });

  it("invalid twice is a ParseError (a cut-off response counts as invalid)", async () => {
    const { client } = fakeClient(reply('{"codes": "P0301"}'), reply("", { status: "incomplete", incompleteReason: "max_output_tokens" }));
    const err = await parseFreeText("won't start", opts(client)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as Error).message).toBe("OpenAI returned invalid extraction output twice (response incomplete (max_output_tokens))");
    expect(logs.some((l) => /^parse: extraction attempt 1: reply does not match the extraction schema: codes: .*; retrying once$/.test(l))).toBe(true);
  });

  it("a refusal counts as invalid output and gets the one retry", async () => {
    const { client, calls } = fakeClient(reply("", { refusal: "I can't help with that." }), extraction({ runs_drives: ev("no", "won't start") }));
    const r = await parseFreeText("won't start", opts(client));
    expect(calls).toHaveLength(2);
    expect(r.record.runs_drives).toBe("no");
    expect(logs).toContain("parse: extraction attempt 1: model refused (I can't help with that.); retrying once");
  });

  it("a response with status failed is a ParseError, not retried as invalid output", async () => {
    const failed = { ...reply(""), status: "failed", error: { code: "server_error", message: "boom" } } as unknown as Response;
    const { client, calls } = fakeClient(failed);
    await expect(parseFreeText("won't start", opts(client))).rejects.toThrow(new ParseError("OpenAI extraction response failed (server_error: boom)"));
    expect(calls).toHaveLength(1);
  });
});

// ---- market call ---------------------------------------------------------------------------

describe("market call: retries and omissions", () => {
  it("retries once on invalid output, then succeeds", async () => {
    const { client, calls } = fakeClient(richExtraction(), marketReply({ ...MARKET_JSON, acv: 1.5 }), marketReply());
    const r = await parseFreeText(RICH, opts(client));
    expect(calls).toHaveLength(3);
    expect(r.market_fit?.acv).toBe(0.4);
    expect(userText(calls[2]!)).toMatch(/Your previous reply could not be used \(invalid market JSON: acv: /);
  });

  it("invalid twice: market_fit is left out with a note, and the record is still returned", async () => {
    const { client, calls } = fakeClient(richExtraction(), reply("I could not find enough data.", SEARCHED), marketReply({ acv: "high" }));
    const r = await parseFreeText(RICH, opts(client));
    expect(calls).toHaveLength(3);
    expect(r.market_fit).toBeUndefined();
    expect(r.record.decoded?.model).toBe("Silverado 1500");
    expect(logs).toContain("parse: market attempt 1: no JSON object in the reply; retrying once");
    expect(r.parser.notes.at(-1)).toMatch(/^market fit omitted: invalid model output twice \(invalid market JSON: /);
  });

  it("an answer without a completed web search is invalid", async () => {
    const notCompleted = marketReply(MARKET_JSON);
    for (const item of notCompleted.output) if (item.type === "web_search_call") item.status = "failed";
    const { client } = fakeClient(richExtraction(), marketReply(MARKET_JSON, {}), notCompleted);
    const r = await parseFreeText(RICH, opts(client));
    expect(r.market_fit).toBeUndefined();
    expect(r.parser.notes.at(-1)).toBe("market fit omitted: invalid model output twice (no web search before the answer)");
  });

  it("an insufficient answer is kept as an insufficient block (the engine then ignores it)", async () => {
    const { client } = fakeClient(richExtraction(), marketReply({ ...MARKET_JSON, insufficient: true, confidence: 0.1 }));
    const r = await parseFreeText(RICH, opts(client));
    expect(r.market_fit).toMatchObject({ insufficient: true, confidence: 0.1 });
  });

  it("401/403/404 on the market call fail the parse (PARSER.md: exit 1), with the record kept as `partial`", async () => {
    const cases: [number, string, RegExp][] = [
      [404, "model_not_found", /^market call failed: OpenAI API returned 404 for model "gpt-4o-mini": the key's project cannot use it/],
      [403, "unsupported_country_region_territory", /^market call failed: OpenAI API returned 403 \(permission denied\)/],
      [401, "invalid_api_key", /^market call failed: OpenAI API rejected the key \(401\): check OPENAI_API_KEY in \.env/],
    ];
    for (const [status, code, message] of cases) {
      const { client, calls } = fakeClient(richExtraction(), apiError(status, "The request failed.", code));
      const err = await parseFreeText(RICH, opts(client)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParseError);
      expect((err as Error).message).toMatch(message);
      expect(calls).toHaveLength(2); // not retried
      const partial = (err as ParseError).partial!;
      expect(partial.market_fit).toBeUndefined();
      expect(partial.record.decoded?.model).toBe("Silverado 1500");
      expect(partial.parser.market_model).toBe("gpt-4o-mini");
      expect(partial.parser.notes.at(-1)).toBe(`market fit omitted: ${(err as Error).message.replace(/^market call failed: /, "")}`);
      // The partial record is valid engine input.
      expect(() => normalizeRecord(toEngineInput(partial))).not.toThrow();
    }
  });

  it("other API errors on the market call (503, an empty balance) leave market_fit out with a note, exit 0", async () => {
    const overloaded = apiError(503, "The server is overloaded or not ready yet.", null, "server_error");
    const busy = fakeClient(richExtraction(), overloaded, overloaded);
    const r = await parseFreeText(RICH, opts(busy.client));
    expect(busy.calls).toHaveLength(3); // one retry
    expect(r.market_fit).toBeUndefined();
    expect(r.parser.notes.at(-1)).toMatch(/^market fit omitted: OpenAI API error 503 after one retry: the service is failing or overloaded/);

    const broke = fakeClient(richExtraction(), apiError(429, "You exceeded your current quota.", "insufficient_quota"));
    const r2 = await parseFreeText(RICH, opts(broke.client));
    expect(broke.calls).toHaveLength(2); // not retried
    expect(r2.parser.notes.at(-1)).toMatch(/^market fit omitted: OpenAI API quota exhausted \(429\)/);
  });

  it("extractJsonObject reads a fenced block or the outermost braces", () => {
    expect(extractJsonObject('x ```json\n{"a":1}\n``` y')).toEqual({ a: 1 });
    expect(extractJsonObject('Answer: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });

  it("buildParseMarketPrompt fills unknown optional fields with 'unknown'", () => {
    const text = buildParseMarketPrompt({
      year: 2019, make: "Ford", model: "F-150", trim: null, odometer: null, location_state: null,
      title_brand: "unknown", run_status: "engine_starts",
    });
    expect(text).toContain("- Trim: unknown\n- Odometer: unknown\n- Location (US state): unknown\n- Title brand: unknown\n- Run status: engine starts but does not drive");
  });
});

// ---- API errors and the key ------------------------------------------------------------------

describe("API errors and the key", () => {
  it("missing key: clear ParseError, no client is constructed; a Google key alone no longer works", async () => {
    const createClient = vi.fn();
    for (const env of [{}, { OPENAI_API_KEY: "" }, { GOOGLE_API_KEY: "AIzaFAKE_old_key_0000000000000" }]) {
      const err = await parseFreeText(NOISE, { env, createClient, log: () => {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParseError);
      expect((err as Error).message).toBe("OPENAI_API_KEY is not set: add OPENAI_API_KEY=... to .env at the repo root or in packages/engine");
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("the factory gets the key", async () => {
    const { client } = fakeClient(extraction({}));
    const createClient = vi.fn(() => client);
    await parseFreeText(NOISE, { env: ENV, createClient, log: () => {} });
    expect(createClient).toHaveBeenCalledWith(FAKE_KEY, ENV);
  });

  it("401: one-line error naming OPENAI_API_KEY, the echoed key scrubbed, not retried", async () => {
    const { client, calls } = fakeClient(
      apiError(401, "Incorrect API key provided: sk-proj-****0000. You can find your API key at https://platform.openai.com/account/api-keys.", "invalid_api_key"),
    );
    const err = (await parseFreeText(NOISE, opts(client)).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toBe(
      "OpenAI API rejected the key (401): check OPENAI_API_KEY in .env (invalid_api_key: Incorrect API key provided: [redacted] " +
        "You can find your API key at https://platform.openai.com/account/api-keys.)",
    );
    expect(calls).toHaveLength(1);
  });

  it("403 and 404 are clear one-line errors, not retried", async () => {
    const forbidden = fakeClient(apiError(403, "Project proj_x does not have access to model gpt-4o-mini", "model_not_found"));
    await expect(parseFreeText(NOISE, opts(forbidden.client))).rejects.toThrow(
      /^OpenAI API returned 403 \(permission denied\): check that the key's project may use gpt-4o-mini \(model_not_found: Project proj_x/,
    );
    const missing = fakeClient(apiError(404, "The model `gpt-4o-mini` does not exist or you do not have access to it.", "model_not_found"));
    await expect(parseFreeText(NOISE, opts(missing.client))).rejects.toThrow(
      'OpenAI API returned 404 for model "gpt-4o-mini": the key\'s project cannot use it, or OpenAI has shut it down ' +
        "(OpenAI listed its shutdown date as 2027-01-14) (model_not_found: The model `gpt-4o-mini` does not exist or you do not have access to it.)",
    );
    expect(forbidden.calls.length + missing.calls.length).toBe(2);
  });

  it("timeout (the SDK's or an abort): a clear message, not retried", async () => {
    for (const timeout of [new OpenAI.APIConnectionTimeoutError(), Object.assign(new Error("This operation was aborted"), { name: "AbortError" })]) {
      const { client, calls } = fakeClient(timeout);
      await expect(parseFreeText(NOISE, opts(client, { env: { ...ENV, PARSER_TIMEOUT_MS: "5000" } }))).rejects.toThrow(
        "OpenAI call to gpt-4o-mini timed out after 5 s (raise PARSER_TIMEOUT_MS to wait longer)",
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("503 and connection errors are retried once (after a short wait), then reported with their cause", async () => {
    const sleep = vi.fn(async () => {});
    const ok = fakeClient(apiError(503, "The server is overloaded or not ready yet.", null, "server_error"), extraction({}));
    await parseFreeText(NOISE, opts(ok.client, { sleep }));
    expect(ok.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(logs).toContain("parse: extraction failed (503); retrying once in 1 s");

    const refused = () =>
      new OpenAI.APIConnectionError({
        cause: new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) }),
      });
    const bad = fakeClient(refused(), refused());
    await expect(parseFreeText(NOISE, opts(bad.client))).rejects.toThrow(
      new ParseError("OpenAI request failed after one retry: Connection error. (ECONNREFUSED)"),
    );
    expect(bad.calls).toHaveLength(2);
    expect(describeOpenAIError(new TypeError("fetch failed", { cause: new Error("bad port") }), "m", 1000)).toBe(
      "OpenAI request failed after one retry: fetch failed (bad port)",
    );
  });

  it("503 twice: one retry, then an actionable one-line message", async () => {
    const overloaded = () => apiError(503, "The server is overloaded or not ready yet.", null, "server_error");
    const { client, calls } = fakeClient(overloaded(), overloaded());
    await expect(parseFreeText(NOISE, opts(client))).rejects.toThrow(
      new ParseError(
        "OpenAI API error 503 after one retry: the service is failing or overloaded; try again in a few minutes " +
          "(server_error: The server is overloaded or not ready yet.)",
      ),
    );
    expect(calls).toHaveLength(2);
  });

  it("429 rate limit: waits the retry-after delay once (capped at 60 s), then reports", async () => {
    const sleep = vi.fn(async () => {});
    const limited = () => apiError(429, "Rate limit reached for gpt-4o-mini on requests per min (RPM): Limit 3.", "rate_limit_exceeded", "requests", { "retry-after": "7" });
    const twice = fakeClient(limited(), limited());
    await expect(parseFreeText(NOISE, opts(twice.client, { sleep }))).rejects.toThrow(
      new ParseError(
        "OpenAI API rate limit exceeded (429) after one retry: wait a minute and try again " +
          "(rate_limit_exceeded: Rate limit reached for gpt-4o-mini on requests per min (RPM): Limit 3.)",
      ),
    );
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(twice.calls).toHaveLength(2);

    const long = fakeClient(apiError(429, "Slow down.", "rate_limit_exceeded", "requests", { "retry-after": "600" }), extraction({}));
    await parseFreeText(NOISE, opts(long.client, { sleep }));
    expect(sleep).toHaveBeenLastCalledWith(60_000);
    expect(retryAfterMs(apiError(429, "x", null, "requests", { "retry-after-ms": "1500", "retry-after": "2" }))).toBe(1500);
    expect(retryAfterMs(new Error("no headers"))).toBeUndefined();
  });

  it("429 insufficient_quota (an empty balance): 'quota exhausted' with the API's text, not retried", async () => {
    const { client, calls } = fakeClient(
      apiError(429, "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota"),
    );
    const err = (await parseFreeText(NOISE, opts(client)).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toBe(
      "OpenAI API quota exhausted (429): add credits or raise the spend limit in the OpenAI billing settings " +
        "(insufficient_quota: You exceeded your current quota, please check your plan and billing details.)",
    );
    expect(calls).toHaveLength(1);
  });

  it("scrubs the key before cutting the message to one line, so no part of it survives the cut", () => {
    for (let pad = 180; pad <= 260; pad++) {
      const e = apiError(500, `${"x".repeat(pad)} ${FAKE_KEY} tail`, null, "server_error");
      for (const key of [FAKE_KEY, undefined]) {
        const msg = describeOpenAIError(e, "m", 1000, key);
        expect(msg).not.toMatch(/sk-proj/);
        expect(msg).not.toContain("FAKE_test");
      }
    }
    expect(scrubKey("cut sk-proj-FAKE_te")).toBe("cut [redacted]");
  });

  it("PARSER_TIMEOUT_MS is kept in a sane range, with a one-line warning", () => {
    const warn = vi.fn();
    expect(parserTimeoutMs({}, warn)).toBe(DEFAULT_PARSER_TIMEOUT_MS);
    expect(parserTimeoutMs({ PARSER_TIMEOUT_MS: "" }, warn)).toBe(DEFAULT_PARSER_TIMEOUT_MS);
    expect(parserTimeoutMs({ PARSER_TIMEOUT_MS: "5000" }, warn)).toBe(5000);
    expect(warn).not.toHaveBeenCalled();
    expect(parserTimeoutMs({ PARSER_TIMEOUT_MS: "3000000000" }, warn)).toBe(MAX_PARSER_TIMEOUT_MS);
    expect(warn).toHaveBeenLastCalledWith("parse: WARNING PARSER_TIMEOUT_MS=3000000000 is outside 1000..1800000 ms; using 1800000");
    expect(parserTimeoutMs({ PARSER_TIMEOUT_MS: "180" }, warn)).toBe(MIN_PARSER_TIMEOUT_MS);
    expect(parserTimeoutMs({ PARSER_TIMEOUT_MS: "soon" }, warn)).toBe(DEFAULT_PARSER_TIMEOUT_MS);
    expect(warn).toHaveBeenLastCalledWith('parse: WARNING PARSER_TIMEOUT_MS="soon" is not a positive number of milliseconds; using 180000');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("an out-of-range PARSER_TIMEOUT_MS is warned about on the parse log and clamped", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const { client } = fakeClient(abort);
    await expect(parseFreeText(NOISE, opts(client, { env: { ...ENV, PARSER_TIMEOUT_MS: "3000000000" } }))).rejects.toThrow(
      "OpenAI call to gpt-4o-mini timed out after 1800 s",
    );
    expect(logs[0]).toBe("parse: WARNING PARSER_TIMEOUT_MS=3000000000 is outside 1000..1800000 ms; using 1800000");
  });

  it("never puts the key in an error message or the log", async () => {
    const { client } = fakeClient(apiError(401, `Incorrect API key provided: ${FAKE_KEY}.`, "invalid_api_key"));
    const err = (await parseFreeText(NOISE, opts(client)).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).toContain("[redacted]");
    const other = describeOpenAIError(apiError(400, `bad request for ${FAKE_KEY}`), "m", 1000, FAKE_KEY);
    expect(other).toBe("OpenAI API rejected the request (400): invalid_request_error: bad request for [redacted]");
    expect(scrubKey(`x sk-${"b".repeat(48)} y`)).toBe("x [redacted] y");
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("refuses empty or very long text before any call", async () => {
    const { client, calls } = fakeClient();
    await expect(parseFreeText("  \n ", opts(client))).rejects.toThrow(/^parse needs some text/);
    await expect(parseFreeText("x".repeat(20_001), opts(client))).rejects.toThrow(/takes at most 20000/);
    expect(calls).toHaveLength(0);
  });
});

// ---- the output is engine input ----------------------------------------------------------------

describe("parser output as engine input", () => {
  // Round 4b (item C): "drives fine" added, because NOISE alone no longer sets run_and_drive.
  const F150 = "drives fine, transmission is generating noise, 2019 Ford F-150 XLT, 84k miles, Texas";
  const f150Extraction = () =>
    extraction({
      year: ev(2019, "2019"),
      make: ev("Ford", "Ford"),
      model: ev("F-150", "F-150"),
      trim: ev("XLT", "XLT"),
      odometer: ev(84000, "84k miles"),
      location_state: ev("TX", "Texas"),
      runs_drives: ev("run_and_drive", "drives fine"),
      reported_symptoms: [{ system: "transmission", text: NOISE }],
    });
  const f150Market = { acv: 0.5, copart: 0.1, confidence: 0.7, insufficient: false, signals: [{ claim: "F-150s retail fast", url: "https://www.kbb.com/ford/f150/" }] };
  const noAnthropic: MessagesClient = {
    messages: {
      create: () => {
        throw new Error("test: the Anthropic API must not be called when market_fit is provided");
      },
    },
  };

  it("keys come in record order, then market_fit, then parser", async () => {
    const { client } = fakeClient(f150Extraction(), marketReply(f150Market));
    const input = toEngineInput(await parseFreeText(F150, opts(client)));
    expect(Object.keys(input)).toEqual([
      "vin", "decoded", "odometer", "location_state", "title", "runs_drives", "flags", "codes", "seller",
      "reported_symptoms", "valuation", "market_fit", "parser",
    ]);
  });

  it("round-trips through normalizeRecord and decide: provided market fit, symptom modifier once, no Anthropic call", async () => {
    const { client } = fakeClient(f150Extraction(), marketReply(f150Market));
    const input = JSON.parse(JSON.stringify(toEngineInput(await parseFreeText(F150, opts(client)))));
    const record = normalizeRecord(input);
    expect(record.reported_symptoms).toEqual([{ system: "transmission", text: NOISE }]);
    // null fields count as missing in the engine; an explicit "unknown" enum value does not.
    expect(record.missing).toEqual(expect.arrayContaining(["vin", "title.state", "codes"]));
    expect(record.title.brand).toBe("unknown");

    const cacheDir = mkdtempSync(join(tmpdir(), "underscope-parse-"));
    try {
      const decision = await decide(record, config, {
        env: { ANTHROPIC_API_KEY: "test-not-a-key" },
        client: noAnthropic,
        cacheDir,
        asOfYear: 2026,
        log: () => {},
      });
      const m = decision.category_scores.market_fit;
      expect(m).toMatchObject({ acv: 0.5, copart: 0.1, confidence: 0.7, source: "provided" });
      expect(decision.market_signals).toEqual(f150Market.signals);
      // The transmission symptom makes the record severe: the modifier is added once.
      const row = config.scoring.drivable.run_and_drive;
      const mod = config.scoring.drivable.severe_code_modifier;
      const d = decision.category_scores.drivable;
      expect(d.acv).toBeCloseTo(Math.max(-1, Math.min(1, row.acv + mod.acv)), 6);
      expect(d.copart).toBeCloseTo(Math.max(-1, Math.min(1, row.copart + mod.copart)), 6);
      expect(d.factors.join(" ")).toMatch(/transmission/);
      // Offline (as `parse --decide` runs it) gives the same provided market fit.
      const offline = await decide(record, config, { offline: true, asOfYear: 2026 });
      expect(offline.category_scores.market_fit.source).toBe("provided");
      expect(offline.probabilities).toEqual(decision.probabilities);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("the no-market output is also valid engine input (fallback market fit offline)", async () => {
    const { client } = fakeClient(extraction({ reported_symptoms: [{ system: "transmission", text: NOISE }] }));
    const record = normalizeRecord(toEngineInput(await parseFreeText(NOISE, opts(client))));
    const decision = await decide(record, config, { offline: true, asOfYear: 2026 });
    expect(decision.category_scores.market_fit.source).toBe("fallback");
  });
});

// ---- CLI -----------------------------------------------------------------------------------

describe("CLI parse", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return { out, err };
  };
  const noiseExtraction = () =>
    extraction({ runs_drives: ev("run_and_drive", NOISE), reported_symptoms: [{ system: "transmission", text: NOISE }] });

  it("prints only the JSON on stdout; unquoted words are joined; --out writes the same JSON", async () => {
    const { out, err } = capture();
    dir = mkdtempSync(join(tmpdir(), "underscope-parse-cli-"));
    const outPath = join(dir, "parsed.json");
    const { client, calls } = fakeClient(noiseExtraction());
    const code = await main(["parse", "transmission", "is", "generating", "noise", "--out", outPath, "--no-market"], {
      parserClient: client,
      env: ENV,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const printed = JSON.parse(out[0]!);
    expect(printed.reported_symptoms).toEqual([{ system: "transmission", text: NOISE }]);
    expect(printed.parser.notes).toContain("market fit skipped (--no-market)");
    expect(readFileSync(outPath, "utf8")).toBe(`${out[0]}\n`);
    expect(err).toEqual([`parse: wrote ${outPath}`]);
    expect(calls).toHaveLength(1);
  });

  it("--file reads the text; --decide prints the Decision after the JSON", async () => {
    const { out } = capture();
    dir = mkdtempSync(join(tmpdir(), "underscope-parse-cli-"));
    const notes = join(dir, "notes.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(notes, `﻿${NOISE}\n`);
    const { client, calls } = fakeClient(noiseExtraction());
    expect(await main(["parse", "--file", notes, "--decide", "--as-of", "2026"], { parserClient: client, env: ENV })).toBe(0);
    expect(userText(calls[0]!)).toContain(`<notes>\\n${NOISE}\\n</notes>`);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!).runs_drives).toBe("unknown"); // round 4b (item C): a complaint alone is no run status
    const decision = JSON.parse(out[1]!);
    expect(decision).toHaveProperty("recommendation");
    expect(decision.category_scores.market_fit.source).toBe("fallback");
  });

  it("usage errors: --offline, --as-of without --decide, parse flags on other commands, no text", async () => {
    capture();
    const deps = { parserClient: fakeClient().client, env: ENV };
    await expect(main(["parse", NOISE, "--offline"], deps)).rejects.toThrow(/--offline does not apply/);
    await expect(main(["parse", NOISE, "--as-of", "2026"], deps)).rejects.toThrow(/--as-of only applies to parse together with --decide/);
    await expect(main(["decide", "x.json", "--no-market", "--decide"], deps)).rejects.toThrow(/--no-market, --decide only applies to the parse command/);
    await expect(main(["parse"], deps)).rejects.toThrow(/parse needs the text/);
    await expect(main(["parse", NOISE, "--file", "notes.txt"], deps)).rejects.toThrow(/either the text or --file/);
    await expect(main(["parse", NOISE, "--out"], deps)).rejects.toThrow(/--out needs a value/);
  });

  it("404 on the market call: the record is still printed and written (no market_fit), then a ParseError (exit 1)", async () => {
    const { out, err } = capture();
    dir = mkdtempSync(join(tmpdir(), "underscope-parse-cli-"));
    const outPath = join(dir, "parsed.json");
    const { client, calls } = fakeClient(richExtraction(), apiError(404, "The model `gpt-4o-mini` does not exist.", "model_not_found"));
    await expect(main(["parse", RICH, "--out", outPath, "--decide"], { parserClient: client, env: ENV })).rejects.toThrow(
      new ParseError(
        'market call failed: OpenAI API returned 404 for model "gpt-4o-mini": the key\'s project cannot use it, or OpenAI has shut it ' +
          "down (OpenAI listed its shutdown date as 2027-01-14) (model_not_found: The model `gpt-4o-mini` does not exist.) " +
          "(the record above was printed without market_fit; --no-market skips the market call)",
      ),
    );
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(1); // the record only: --decide does not run
    const printed = JSON.parse(out[0]!);
    expect(printed).not.toHaveProperty("market_fit");
    expect(printed.decoded.model).toBe("Silverado 1500");
    expect(printed.parser.notes.at(-1)).toMatch(/^market fit omitted: OpenAI API returned 404/);
    expect(readFileSync(outPath, "utf8")).toBe(`${out[0]}\n`);
    expect(err).toEqual([`parse: wrote ${outPath}`]);
  });

  it("a missing key is a ParseError (exit 1 with a one-line message)", async () => {
    capture();
    await expect(main(["parse", NOISE], { env: {} })).rejects.toThrow(ParseError);
  });
});
