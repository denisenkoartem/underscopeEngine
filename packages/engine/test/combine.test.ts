import { describe, expect, it } from "vitest";
import { decide, decideWithMarket, softmax, utility } from "../src/combine.js";
import { loadConfig, type EngineConfig } from "../src/config.js";
import { renderExplainTable } from "../src/explain.js";
import { normalizeRecord, type ConditionRecordInput, type NormalizedRecord } from "../src/input.js";
import { marketFitFallback } from "../src/marketFit.js";
import type { MarketFitResult } from "../src/types.js";

const config = loadConfig();
const AS_OF = 2026;

const NO_FLAGS = { frame: "no", airbag: "no", flood: "no", module_no_comm: "no", monitors_incomplete: "no" } as const;
/** Example 2: clean, runs, 2022, 40k, no unknowns, no codes. */
const EX2: ConditionRecordInput = {
  decoded: { year: 2022, make: "Ford", model: "F-150", trim: "XLT" },
  odometer: 40000,
  title: { brand: "clean" },
  runs_drives: "run_and_drive",
  flags: NO_FLAGS,
  codes: [],
};
const rec = (patch: Partial<ConditionRecordInput> = {}) =>
  normalizeRecord({ ...EX2, ...patch, flags: { ...NO_FLAGS, ...patch.flags } });

const EX1 = rec({ title: { brand: "salvage" }, runs_drives: "no", decoded: { year: 2015 }, odometer: 120000 });
const EX3 = rec({
  decoded: { year: 2021, make: "Ram", model: "1500" },
  odometer: 62000,
  flags: { frame: "unknown" },
  codes: [{ code: "P0301", status: "confirmed" }, { code: "P0420", status: "confirmed" }],
});
/** Example 5: clean, does not run, 2012, 190k, frame + module_no_comm unknown. */
const EX5_INPUT: Partial<ConditionRecordInput> = {
  decoded: { year: 2012, make: "Ford", model: "E-350" },
  odometer: 190000,
  runs_drives: "no",
  flags: { frame: "unknown", module_no_comm: "unknown" },
};
const EX5 = rec(EX5_INPUT);
const EX6 = rec({ title: { brand: "unknown" } });

const offline = (r: NormalizedRecord, cfg: EngineConfig = config) =>
  decideWithMarket(r, cfg, marketFitFallback(r, cfg, AS_OF, "test"));

describe("softmax and thresholds", () => {
  it("matches the hand-computed example 2 (U_acv 0.700, U_copart -0.105)", () => {
    expect(softmax({ acv: 0.7, copart: -0.105 }, 0.5).acv).toBeCloseTo(0.8334, 3);
    const d = offline(rec());
    expect(d.recommendation).toBe("acv");
    expect(d.probabilities.acv).toBeCloseTo(0.8334, 3);
    expect(d.probabilities.acv + d.probabilities.copart).toBeCloseTo(1, 9);
    expect(d.confidence).toBe("clear");
    expect(d.verify_first).toBeNull();
    expect(d.excluded).toEqual([]);
    expect(d.weights_version).toBe(config.weights.version);
  });

  it("a hand-built close call: example 5 (U_acv 0.055, U_copart 0.135)", () => {
    const d = offline(EX5);
    expect(d.recommendation).toBe("copart");
    expect(d.probabilities.copart).toBeCloseTo(0.5399, 3);
    expect(d.confidence).toBe("close_call");
  });

  it("clear_threshold decides clear vs close_call", () => {
    expect(offline(EX3).confidence).toBe("clear"); // 0.7427 >= 0.70
    const strict: EngineConfig = { ...config, weights: { ...config.weights, clear_threshold: 0.75 } };
    const d = offline(EX3, strict);
    expect(d.probabilities.acv).toBeCloseTo(0.7427, 3);
    expect(d.confidence).toBe("close_call");
  });

  it("the threshold applies to the reported (4-decimal) probability, so 0.7000 is never a close call", () => {
    // Example 2 with a web/cache market judgment that puts the unrounded P(ACV) just under 0.70.
    const market = (m: number): MarketFitResult => ({
      acv: m,
      copart: -m,
      confidence: 1,
      factors: ["test market"],
      excluded: [],
      source: "cache",
      signals: [],
    });
    const T = config.weights.temperature;
    const rawP = (m: number) => {
      const d = decideWithMarket(rec(), config, market(m));
      const u = { acv: utility(config, d.category_scores, "acv"), copart: utility(config, d.category_scores, "copart") };
      return { d, p: softmax(u, T).acv };
    };
    const at = rawP(-0.60272);
    expect(at.p).toBeGreaterThanOrEqual(0.69995);
    expect(at.p).toBeLessThan(0.7);
    expect(at.d.probabilities).toEqual({ acv: 0.7, copart: 0.3 });
    expect(at.d.confidence).toBe("clear");
    // Reported 0.6999 -> close_call.
    const below = rawP(-0.603);
    expect(below.d.probabilities.acv).toBe(0.6999);
    expect(below.d.confidence).toBe("close_call");
  });

  it("returns exactly 3 reasons and 2 risks, built from the decision's numbers", () => {
    const d = offline(EX3);
    expect(d.reasons).toEqual([
      "title +0.350 for ACV: Title brand: clean",
      expect.stringMatching(/^market_fit \+0\.080 for ACV: Fallback table row "late_low_miles"/),
      "drivable +0.060 for ACV: Run status: run_and_drive",
    ]);
    expect(d.risks).toEqual(["Unresolved: frame (unknown)", "Copart's strongest case: hidden_risk +0.050: frame: unknown"]);
    // Example 2: no category favors Copart, so no "+0.000 ... run_and_drive" pseudo-case is quoted.
    expect(offline(rec()).risks).toEqual([
      "No unresolved hidden-risk flags",
      "No category favors Copart (its best: drivable +0.000)",
    ]);
    for (const r of [rec(), EX1, EX5, EX6]) {
      const x = offline(r);
      expect(x.reasons).toHaveLength(3);
      expect(x.risks).toHaveLength(2);
    }
  });
});

describe("exclusions", () => {
  it("salvage removes ACV: Copart with p = 1, clear, exclusion as the first reason", () => {
    const d = offline(EX1);
    expect(d).toMatchObject({ recommendation: "copart", probabilities: { acv: 0, copart: 1 }, confidence: "clear" });
    expect(d.excluded).toEqual([{ option: "acv", reason: "salvage title (title)" }]);
    expect(d.reasons[0]).toBe("ACV excluded: salvage title (title)");
    expect(d.risks[1]).toBe("ACV not available: salvage title (title)");
    expect(d.verify_first).toBeNull();
  });

  it("an exclusion makes every verify movement 0 -> verify_first null", () => {
    expect(offline(rec({ title: { brand: "salvage" }, flags: { frame: "unknown" } })).verify_first).toBeNull();
  });

  it("lanes_allowed removes an option", () => {
    const d = offline(rec({ ...EX5_INPUT, seller: { lanes_allowed: ["acv"] } }));
    expect(d).toMatchObject({ recommendation: "acv", probabilities: { acv: 1, copart: 0 }, confidence: "clear" });
    expect(d.excluded).toEqual([{ option: "copart", reason: "not in seller.lanes_allowed" }]);
    expect(d.reasons[0]).toBe("Copart excluded: not in seller.lanes_allowed");
  });

  it("lanes_allowed [] removes both options (it is not read as 'no constraint')", () => {
    const d = offline(rec({ seller: { lanes_allowed: [] } }));
    expect(d).toMatchObject({ recommendation: null, probabilities: { acv: 0, copart: 0 }, confidence: "insufficient" });
    expect(d.excluded).toEqual([
      { option: "acv", reason: "not in seller.lanes_allowed" },
      { option: "copart", reason: "not in seller.lanes_allowed" },
    ]);
    expect(d.verify_first).toBeNull();
  });

  it("both options removed -> insufficient with recommendation null", () => {
    const d = offline(rec({ title: { brand: "nonrepairable" }, seller: { lanes_allowed: ["acv"] } }));
    expect(d).toMatchObject({ recommendation: null, probabilities: { acv: 0, copart: 0 }, confidence: "insufficient" });
    expect(d.excluded.map((e) => e.option)).toEqual(["acv", "copart"]);
    expect(d.verify_first).toBeNull();
    expect(d.reasons).toHaveLength(3);
    expect(d.risks).toHaveLength(2);
  });
});

describe("verify_first", () => {
  it("picks frame in example 3", () => {
    const d = offline(EX3);
    expect(d.recommendation).toBe("acv");
    expect(d.probabilities.acv).toBeCloseTo(0.7427, 3);
    expect(d.verify_first).toBe("frame");
  });

  it("ties go to the earlier flag (example 5: frame and module_no_comm both move 0.0873)", () => {
    expect(offline(EX5).verify_first).toBe("frame");
    // flood and module_no_comm also move equally; flood is earlier in FLAG_NAMES.
    const d = offline(rec({ ...EX5_INPUT, flags: { frame: "no", module_no_comm: "unknown", flood: "unknown" } }));
    expect(d.verify_first).toBe("flood");
  });

  it("frame 'yes' applies the modifier once and is not a hidden-risk candidate", () => {
    const d = offline(rec({ flags: { frame: "yes" } }));
    expect(d.category_scores.drivable).toMatchObject({ acv: 0.4, copart: 0.1 });
    expect(d.category_scores.hidden_risk.factors).toEqual(["No unresolved hidden-risk flags"]);
    expect(d.verify_first).toBeNull();
  });

  it("null when nothing is counted", () => {
    expect(offline(rec()).verify_first).toBeNull();
  });
});

describe("unknown title", () => {
  it("example 6: branches disagree -> clean branch, close_call, confirm title brand", () => {
    const d = offline(EX6);
    expect(d.recommendation).toBe("acv");
    expect(d.probabilities.acv).toBeCloseTo(0.8334, 3);
    expect(d.confidence).toBe("close_call");
    expect(d.verify_first).toBe("confirm title brand");
    expect(d.category_scores.title).toMatchObject({ acv: 1, copart: -0.3, confidence: 1, source: "input" });
    expect(d.category_scores.title.factors[0]).toBe(
      "Title brand unknown: clean branch -> acv, salvage branch -> copart; reported the clean branch",
    );
    expect(d.excluded).toEqual([]);
  });

  it("an omitted title branches the same way", () => {
    const d = offline(normalizeRecord({ ...EX2, title: undefined }));
    expect(d.verify_first).toBe("confirm title brand");
  });

  it("branches agree -> the unknown-title (BASE) run is reported, with its own confidence and verify_first", () => {
    // Example 5 with an unknown title. Clean branch: Copart 0.5399 close_call. Salvage branch: Copart
    // (ACV excluded). They agree, so the BASE run is reported: title.unknown row (0 / 0, conf 0.3),
    // U_acv = -0.120 - 0.125 - 0.050 = -0.295, U_copart = 0.090 + 0.100 + 0.050 = 0.240,
    // P(Copart) = 1 / (1 + e^(-0.535 / 0.5)) = 0.7446 -> clear (the clean branch alone was a close call).
    const d = offline(rec({ ...EX5_INPUT, title: { brand: "unknown" } }));
    expect(d.recommendation).toBe("copart");
    expect(d.probabilities.copart).toBeCloseTo(0.7446, 3);
    expect(d.confidence).toBe("clear");
    expect(d.category_scores.title).toMatchObject({ acv: 0, copart: 0, confidence: 0.3, source: "input" });
    expect(d.category_scores.title.factors).toEqual([
      "Title brand unknown: clean branch -> copart, salvage branch -> copart; branches agree, reported the unknown-title run",
      "Title brand: unknown",
    ]);
    // verify_first is rescored with the title still unknown: frame and module_no_comm both move
    // P(Copart) by 0.0720 via ->no (frame->yes moves 0.0525); the tie goes to frame.
    expect(d.verify_first).toBe("frame");
    expect(d.excluded).toEqual([]);
  });

  it("unknown title + lanes ['acv']: salvage branch has no option -> disagree -> clean branch, close_call", () => {
    const d = offline(rec({ title: { brand: "unknown" }, seller: { lanes_allowed: ["acv"] } }));
    expect(d).toMatchObject({ recommendation: "acv", probabilities: { acv: 1, copart: 0 }, confidence: "close_call" });
    expect(d.verify_first).toBe("confirm title brand");
    expect(d.category_scores.title.factors[0]).toBe(
      "Title brand unknown: clean branch -> acv, salvage branch -> none; reported the clean branch",
    );
  });

  it("unknown title + lanes ['copart']: both branches Copart -> the unknown-title run (P = 1, clear, nothing to verify)", () => {
    const d = offline(rec({ title: { brand: "unknown" }, seller: { lanes_allowed: ["copart"] } }));
    expect(d).toMatchObject({ recommendation: "copart", probabilities: { acv: 0, copart: 1 }, confidence: "clear" });
    expect(d.verify_first).toBeNull();
    expect(d.category_scores.title.factors[0]).toBe(
      "Title brand unknown: clean branch -> copart, salvage branch -> copart; branches agree, reported the unknown-title run",
    );
  });

  it("insufficient override: unknown title and 3+ counted flags (answer still reported)", () => {
    // Branches disagree (clean -> ACV, salvage -> Copart): the clean branch is reported, overridden.
    const d = offline(rec({ title: { brand: "unknown" }, flags: { frame: "unknown", airbag: "suspected", flood: "unknown" } }));
    expect(d.confidence).toBe("insufficient");
    expect(d.recommendation).toBe("acv");
    expect(d.verify_first).toBe("confirm title brand");
    expect(d.probabilities.acv + d.probabilities.copart).toBeCloseTo(1, 9);
    // A known title with the same flags is not overridden.
    expect(offline(rec({ flags: { frame: "unknown", airbag: "suspected", flood: "unknown" } })).confidence).not.toBe(
      "insufficient",
    );
  });

  it("insufficient override also applies when the branches agree (BASE reported)", () => {
    // Example 5 with an unknown title and frame/airbag/flood unknown: both branches -> Copart.
    // BASE: U_acv = -0.120 - 0.250 - 0.050 = -0.420, U_copart = 0.090 + 0.150 + 0.050 = 0.290,
    // P(Copart) = 1 / (1 + e^(-0.710 / 0.5)) = 0.8053 (would be clear) -> insufficient.
    const d = offline(
      rec({ ...EX5_INPUT, title: { brand: "unknown" }, flags: { frame: "unknown", airbag: "unknown", flood: "unknown" } }),
    );
    expect(d.recommendation).toBe("copart");
    expect(d.probabilities.copart).toBeCloseTo(0.8053, 3);
    expect(d.confidence).toBe("insufficient");
    expect(d.category_scores.title.confidence).toBe(0.3);
    // frame, airbag and flood ->no each move 0.0607 (frame/airbag ->yes only 0.0440); tie -> frame.
    expect(d.verify_first).toBe("frame");
  });
});

describe("decide()", () => {
  it("offline equals decideWithMarket with the fallback", async () => {
    const d = await decide(EX3, config, { offline: true, asOfYear: AS_OF });
    const { recommendation, probabilities, confidence, verify_first, reasons, risks } = offline(EX3);
    expect(d).toMatchObject({ recommendation, probabilities, confidence, verify_first, reasons, risks });
    expect(d.category_scores.market_fit.source).toBe("fallback");
  });

  it("explain table shows contributions, totals, probabilities and verify_first", () => {
    const text = renderExplainTable(offline(EX3), config);
    expect(text).toMatch(/title\s+1\.000\s+-0\.300\s+0\.35\s+1\.00\s+0\.350\s+-0\.105\s+input/);
    expect(text).toMatch(/Total utility\s+0\.490\s+-0\.040/);
    expect(text).toContain("ACV 0.7427, Copart 0.2573  (softmax of utility / temperature 0.5)");
    expect(text).toContain("Confidence: clear  (clear when the top probability >= 0.7)");
    expect(text).toContain("verify_first: frame");
    expect(text).toContain("Excluded: none");
    expect(text).toContain("RULES.md");
  });
});

describe("explain annotations follow the rule that set each number", () => {
  const lineOf = (text: string, start: string) => text.split("\n").find((l) => l.startsWith(start)) ?? "";

  it("one eligible option (example 1): no softmax; the excluded option keeps its other scores", () => {
    const text = renderExplainTable(offline(EX1), config);
    expect(lineOf(text, "Probabilities:")).toBe(
      "Probabilities: ACV 0.0000, Copart 1.0000  (only Copart eligible: P = 1, softmax not used)",
    );
    expect(lineOf(text, "Confidence:")).toBe("Confidence: clear  (only one option eligible)");
    expect(lineOf(text, "Excluded:")).toBe("Excluded: ACV: salvage title (title)");
    // The title (the excluding category) and the total say "excluded"; the rest show ACV's numbers.
    expect(lineOf(text, "title")).toMatch(/^title\s+excluded\s+1\.000\s+0\.35\s+1\.00\s+excluded\s+0\.350\s+input$/);
    expect(lineOf(text, "drivable")).toMatch(/^drivable\s+-0\.800\s+0\.600\s+0\.15\s+1\.00\s+-0\.120\s+0\.090\s+input$/);
    expect(lineOf(text, "Total utility")).toMatch(/^Total utility\s+excluded\s+0\.490$/); // 0.350 + 0.090 + 0 + 0.050
  });

  it("a lanes_allowed exclusion names no category, so every category cell keeps its number", () => {
    const text = renderExplainTable(offline(rec({ ...EX5_INPUT, seller: { lanes_allowed: ["acv"] } })), config);
    expect(lineOf(text, "title")).toMatch(/^title\s+1\.000\s+-0\.300\s/);
    expect(lineOf(text, "Total utility")).toMatch(/\s+excluded$/);
    expect(lineOf(text, "Excluded:")).toBe("Excluded: Copart: not in seller.lanes_allowed");
  });

  it("no eligible option", () => {
    const text = renderExplainTable(offline(rec({ seller: { lanes_allowed: [] } })), config);
    expect(lineOf(text, "Probabilities:")).toMatch(/\(no option eligible\)$/);
    expect(lineOf(text, "Confidence:")).toBe("Confidence: insufficient  (no option eligible)");
  });

  it("example 6: close_call forced by the unknown title; the title row is the assumed clean brand", () => {
    const text = renderExplainTable(offline(EX6), config);
    expect(lineOf(text, "Probabilities:")).toContain("(softmax of utility / temperature 0.5)");
    expect(lineOf(text, "Confidence:")).toBe(
      "Confidence: close_call  (close_call forced: title unknown and the clean and salvage title branches disagree)",
    );
    expect(lineOf(text, "title")).toMatch(/input, assumed clean \(title unknown\)$/);
  });

  it("the unknown-title insufficient override says so", () => {
    const flags = { frame: "unknown", airbag: "suspected", flood: "unknown" } as const;
    const disagree = renderExplainTable(offline(rec({ title: { brand: "unknown" }, flags })), config);
    expect(lineOf(disagree, "Confidence:")).toBe(
      "Confidence: insufficient  (insufficient: title unknown and 3+ unresolved hidden-risk flags; " +
        "the clean and salvage title branches also disagree)",
    );
    const agree = renderExplainTable(
      offline(rec({ ...EX5_INPUT, title: { brand: "unknown" }, flags: { frame: "unknown", airbag: "unknown", flood: "unknown" } })),
      config,
    );
    expect(lineOf(agree, "Confidence:")).toBe(
      "Confidence: insufficient  (insufficient: title unknown and 3+ unresolved hidden-risk flags)",
    );
    expect(lineOf(agree, "title")).toMatch(/\sinput$/); // the unknown-title run is reported, not an assumed brand
  });
});
