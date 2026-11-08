// Valuation block (round 4b, user decision "carry prices, don't use them"): the input may carry
// clean wholesale, salvage comps and purchase price. They are validated, echoed in the Decision and
// shown in the explain table, and NOTHING in the decision reads them. Fully offline.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/combine.js";
import { PACKAGE_ROOT, loadConfig } from "../src/config.js";
import { renderExplainTable, valuationLines } from "../src/explain.js";
import { InputError, MAX_SALVAGE_COMPS, normalizeRecord, type ConditionRecordInput } from "../src/input.js";
import type { Decision } from "../src/types.js";

const config = loadConfig();
const AS_OF = 2026;
const MAZDA_VALUATION = { clean_wholesale: 4600, salvage_comps: [475, 600, 725, 1150, 2329], purchase_price: 7000 };

/** The 2014 Mazda3 as the parser mapped it live on 2026-11-07 (run_and_drive from the noise quote), plus its prices. */
const MAZDA: ConditionRecordInput = {
  vin: "3MZBM1U73EM110438",
  decoded: { year: 2014, make: "Mazda", model: "Mazda3", trim: "i Sport" },
  odometer: 115000,
  title: { brand: "clean", state: "NY" },
  runs_drives: "run_and_drive",
  reported_symptoms: [
    { system: "transmission", text: "transmission is generating noise" },
    { system: "body", text: "front bumper has small dents" },
  ],
  valuation: MAZDA_VALUATION,
};

const EXAMPLES_DIR = join(PACKAGE_ROOT, "examples");
const examples: [string, ConditionRecordInput][] = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(EXAMPLES_DIR, f), "utf8")) as ConditionRecordInput]);

const offline = (r: ConditionRecordInput) => decide(normalizeRecord(r), config, { offline: true, asOfYear: AS_OF });
const withoutValuation = ({ valuation: _v, ...rest }: Decision) => rest;

describe("valuation input block", () => {
  it("parses and normalizes; null means absent, like every other field", () => {
    expect(normalizeRecord({}).valuation).toBeNull();
    expect(normalizeRecord({ valuation: null }).valuation).toBeNull();
    expect(normalizeRecord({ valuation: {} }).valuation).toBeNull();
    expect(normalizeRecord({ valuation: { clean_wholesale: null, salvage_comps: null, purchase_price: null } }).valuation).toBeNull();
    expect(normalizeRecord({ valuation: { salvage_comps: [] } }).valuation).toBeNull();
    expect(normalizeRecord({ valuation: MAZDA_VALUATION }).valuation).toEqual(MAZDA_VALUATION);
    expect(normalizeRecord({ valuation: { purchase_price: 7000 } }).valuation).toEqual({
      clean_wholesale: null,
      salvage_comps: [],
      purchase_price: 7000,
    });
    // 0 is a price, not "absent".
    expect(normalizeRecord({ valuation: { clean_wholesale: 0 } }).valuation).toEqual({ clean_wholesale: 0, salvage_comps: [], purchase_price: null });
    // Not a vehicle field: never listed as missing.
    expect(normalizeRecord({}).missing).not.toContain("valuation");
  });

  it("rejects negative prices, more than 50 comps, non-numbers and unknown keys", () => {
    const bad: unknown[] = [
      { clean_wholesale: -1 },
      { purchase_price: -0.01 },
      { salvage_comps: [475, -600] },
      { salvage_comps: Array.from({ length: MAX_SALVAGE_COMPS + 1 }, (_, i) => 100 + i) },
      { clean_wholesale: "$4,600" },
      { salvage_comps: 475 },
      { retail: 9000 },
    ];
    for (const valuation of bad) expect(() => normalizeRecord({ valuation }), JSON.stringify(valuation)).toThrow(InputError);
    expect(() => normalizeRecord({ valuation: { clean_wholesale: -1 } })).toThrow(/valuation\.clean_wholesale/);
    expect(() => normalizeRecord({ valuation: { salvage_comps: Array(51).fill(1) } })).toThrow(/at most 50 salvage comps/);
    expect(normalizeRecord({ valuation: { salvage_comps: Array(MAX_SALVAGE_COMPS).fill(1) } }).valuation?.salvage_comps).toHaveLength(50);
  });

  it("is echoed in the Decision (a copy), and null when the input has none", async () => {
    const d = await offline(MAZDA);
    expect(d.valuation).toEqual(MAZDA_VALUATION);
    expect(d.valuation?.salvage_comps).not.toBe(MAZDA_VALUATION.salvage_comps);
    expect((await offline({ ...MAZDA, valuation: null })).valuation).toBeNull();
    // Unknown title reports the clean branch's record: the prices still come through.
    expect((await offline({ ...MAZDA, title: { brand: "unknown" } })).valuation).toEqual(MAZDA_VALUATION);
    // Both options excluded: still echoed.
    expect((await offline({ ...MAZDA, seller: { lanes_allowed: [] } })).valuation).toEqual(MAZDA_VALUATION);
  });

  it("explain prints a short display-only block (and nothing when there is no valuation)", async () => {
    const text = renderExplainTable(await offline(MAZDA), config);
    expect(text).toContain(
      [
        "Valuation (shown only, not used in the decision):",
        "  Clean wholesale: $4,600",
        "  Salvage comps: 5 (min $475, median $725, max $2,329)",
        "  Purchase price: $7,000",
      ].join("\n"),
    );
    expect(renderExplainTable(await offline({ ...MAZDA, valuation: null }), config)).not.toMatch(/Valuation/);
    expect(valuationLines({ clean_wholesale: null, salvage_comps: [], purchase_price: 1234.5 })).toEqual([
      "Valuation (shown only, not used in the decision):",
      "  Clean wholesale: not given",
      "  Salvage comps: none",
      "  Purchase price: $1,234.5",
    ]);
    // Even count: the median is the mean of the two middle comps.
    expect(valuationLines({ clean_wholesale: 0, salvage_comps: [900, 100, 300, 500], purchase_price: null })[2]).toBe(
      "  Salvage comps: 4 (min $100, median $400, max $900)",
    );
  });
});

describe("valuation never changes the decision", () => {
  // A small deterministic generator, so the "property" runs the same cases every time.
  function* valuations(seed: number, n: number) {
    let x = seed;
    const next = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    yield null;
    yield { clean_wholesale: 0, salvage_comps: [0], purchase_price: 0 };
    yield { salvage_comps: Array(MAX_SALVAGE_COMPS).fill(1e9) };
    for (let i = 0; i < n; i++) {
      const price = () => (next() < 0.25 ? null : Math.round(next() * 1e7) / 100);
      yield {
        clean_wholesale: price(),
        salvage_comps: next() < 0.2 ? null : Array.from({ length: Math.floor(next() * 12) }, () => Math.round(next() * 5e6) / 100),
        purchase_price: price(),
      };
    }
  }

  const records: [string, ConditionRecordInput][] = [
    ...examples,
    ["mazda (dead heat, verify_first by tie order)", MAZDA],
    ["mazda, title unknown", { ...MAZDA, title: { brand: "unknown" } }],
    ["mazda, lanes acv only", { ...MAZDA, seller: { lanes_allowed: ["acv"] } }],
    ["mazda, run status unknown", { ...MAZDA, runs_drives: "unknown" }],
  ];

  it.each(records)("%s: probabilities, confidence, verify_first, reasons and risks do not move", async (_name, raw) => {
    const base = withoutValuation(await offline({ ...raw, valuation: null }));
    for (const valuation of valuations(7, 25)) {
      const d = await offline({ ...raw, valuation });
      expect(withoutValuation(d)).toEqual(base);
    }
  });
});
