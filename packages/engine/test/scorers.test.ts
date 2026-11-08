import { describe, expect, it } from "vitest";
import { loadConfig, parseScoring, type EngineConfig } from "../src/config.js";
import { scoreDrivable, severeCauses } from "../src/drivable.js";
import { countedFlags, scoreHiddenRisk } from "../src/hiddenRisk.js";
import { InputError, normalizeRecord, type ConditionRecordInput } from "../src/input.js";
import { scoreTitle } from "../src/title.js";

const config = loadConfig();

const NO_FLAGS = { frame: "no", airbag: "no", flood: "no", module_no_comm: "no", monitors_incomplete: "no" } as const;
const BASE: ConditionRecordInput = {
  decoded: { year: 2022, make: "Ford", model: "F-150" },
  odometer: 40000,
  title: { brand: "clean" },
  runs_drives: "run_and_drive",
  flags: NO_FLAGS,
  codes: [],
};
const rec = (patch: Partial<ConditionRecordInput> = {}) =>
  normalizeRecord({ ...BASE, ...patch, flags: { ...NO_FLAGS, ...patch.flags } });

describe("title scorer", () => {
  it("looks up the brand row; confidence defaults to 1.0", () => {
    const s = scoreTitle(rec(), config);
    expect(s).toMatchObject({ acv: 1, copart: -0.3, confidence: 1, excluded: [], source: "input" });
    expect(s.factors[0]).toBe("Title brand: clean");
  });

  it.each(["salvage", "nonrepairable"] as const)("%s excludes ACV (score reported as 0)", (brand) => {
    const s = scoreTitle(rec({ title: { brand } }), config);
    expect(s).toMatchObject({ acv: 0, copart: 1, excluded: ["acv"], exclusion_reason: `${brand} title` });
  });

  it("missing title -> unknown row 0/0/0.3", () => {
    const s = scoreTitle(normalizeRecord({ ...BASE, title: undefined }), config);
    expect(s).toMatchObject({ acv: 0, copart: 0, confidence: 0.3, excluded: [] });
    expect(s.factors[0]).toBe("Title brand: unknown (missing)");
  });
});

describe("drivable scorer", () => {
  it("looks up the run status", () => {
    expect(scoreDrivable(rec(), config)).toMatchObject({ acv: 0.8, copart: 0, confidence: 1 });
    expect(scoreDrivable(rec({ runs_drives: "engine_starts" }), config)).toMatchObject({ acv: 0, copart: 0.3 });
  });

  it("missing run status -> unknown row with its own confidence", () => {
    const s = scoreDrivable(normalizeRecord({ ...BASE, runs_drives: undefined }), config);
    expect(s).toMatchObject({ acv: -0.3, copart: 0.2, confidence: 0.4 });
  });

  it("MISFIRE+CATALYST confirmed applies the severe modifier", () => {
    const r = rec({ codes: [{ code: "P0301", status: "confirmed" }, { code: "p0420", status: "confirmed" }] });
    expect(scoreDrivable(r, config)).toMatchObject({ acv: 0.4, copart: 0.1 });
    expect(severeCauses(r, config)).toEqual(["MISFIRE+CATALYST confirmed (P0301, P0420)"]);
  });

  it("severe codes count only when confirmed (pending misfire + catalyst does not trigger)", () => {
    for (const status of ["pending", "history"] as const) {
      const r = rec({ codes: [{ code: "P0301", status }, { code: "P0420", status: "confirmed" }] });
      expect(severeCauses(r, config)).toEqual([]);
      expect(scoreDrivable(r, config)).toMatchObject({ acv: 0.8, copart: 0 });
    }
    const allPending = rec({ codes: [{ code: "P0301", status: "pending" }, { code: "P0420", status: "pending" }] });
    expect(scoreDrivable(allPending, config).factors.join(" ")).toMatch(/Not counted.*P0301 pending/);
  });

  it("one half of a combination is not enough; a single-set entry is", () => {
    expect(severeCauses(rec({ codes: [{ code: "P0301", status: "confirmed" }] }), config)).toEqual([]);
    expect(severeCauses(rec({ codes: [{ code: "P0700", status: "confirmed" }] }), config)).toHaveLength(1);
  });

  it("uses the code sets from RULES.md (P0312 and B0004 are only listed there)", () => {
    const misfire = rec({ codes: [{ code: "P0312", status: "confirmed" }, { code: "P0430", status: "confirmed" }] });
    expect(severeCauses(misfire, config)).toHaveLength(1);
    expect(severeCauses(rec({ codes: [{ code: "B0004", status: "confirmed" }] }), config)).toHaveLength(1);
  });

  it("frame or airbag 'yes' is severe; the modifier is applied once however many causes hold", () => {
    expect(scoreDrivable(rec({ flags: { frame: "yes" } }), config)).toMatchObject({ acv: 0.4, copart: 0.1 });
    const many = rec({
      flags: { frame: "yes", airbag: "yes" },
      codes: [
        { code: "P0301", status: "confirmed" },
        { code: "P0420", status: "confirmed" },
        { code: "P0700", status: "confirmed" },
      ],
    });
    expect(severeCauses(many, config)).toHaveLength(4);
    expect(scoreDrivable(many, config)).toMatchObject({ acv: 0.4, copart: 0.1 });
    // "suspected"/"unknown" frame is hidden risk, not severe.
    expect(severeCauses(rec({ flags: { frame: "suspected", airbag: "unknown" } }), config)).toEqual([]);
  });

  it("clamps to [-1, 1] after the modifier", () => {
    const s = scoreDrivable(rec({ runs_drives: "no", flags: { frame: "yes" } }), config);
    expect(s.acv).toBe(-1); // -0.8 - 0.4 = -1.2 -> -1
    expect(s.copart).toBe(0.7);
    expect(s.factors.join(" ")).toContain("clamped");
  });

  it("clamps the upper end too (in-memory override; the shipped modifiers cannot reach +1)", () => {
    const scoring = structuredClone(config.scoring);
    scoring.drivable.severe_code_modifier = { acv: -0.4, copart: 0.6 };
    const cfg: EngineConfig = { ...config, scoring: parseScoring(scoring) };
    const s = scoreDrivable(rec({ runs_drives: "no", flags: { frame: "yes" } }), cfg);
    expect(s.copart).toBe(1); // 0.6 + 0.6 = 1.2 -> 1
    expect(s.acv).toBe(-1); // -0.8 - 0.4 = -1.2 -> -1
    expect(s.factors.join(" ")).toContain("clamped to [-1, 1]");
  });
});

describe("hidden-risk scorer", () => {
  it("no unresolved flags -> by_count 0", () => {
    const s = scoreHiddenRisk(rec(), config);
    expect(s).toMatchObject({ acv: 0.6, copart: 0, confidence: 1, factors: ["No unresolved hidden-risk flags"] });
  });

  it("counts unknown and suspected, in FLAG_NAMES order", () => {
    const r = rec({ flags: { monitors_incomplete: "suspected", frame: "unknown" } });
    expect(countedFlags(r, config)).toEqual(["frame", "monitors_incomplete"]);
    const s = scoreHiddenRisk(r, config);
    expect(s).toMatchObject({ acv: -0.5, copart: 0.4, factors: ["frame: unknown", "monitors_incomplete: suspected"] });
  });

  it("'yes' is disclosed, not hidden: it never counts", () => {
    const r = rec({ flags: { frame: "yes", airbag: "yes", flood: "unknown" } });
    expect(countedFlags(r, config)).toEqual(["flood"]);
    expect(scoreHiddenRisk(r, config)).toMatchObject({ acv: 0, copart: 0.2 });
  });

  it("missing flags become unknown and count (3+ row)", () => {
    const r = normalizeRecord({ ...BASE, flags: { frame: "no" } });
    expect(countedFlags(r, config)).toEqual(["airbag", "flood", "module_no_comm", "monitors_incomplete"]);
    expect(scoreHiddenRisk(r, config)).toMatchObject({ acv: -1, copart: 0.6 });
  });
});

describe("input validation", () => {
  it("rejects unknown or misspelled keys at every level instead of scoring them as unknown", () => {
    const bad: [unknown, RegExp][] = [
      [{ ...BASE, runs_drive: "no" }, /\(root\): Unrecognized key: "runs_drive"/],
      [{ ...BASE, flags: { ...NO_FLAGS, flag: "unknown" } }, /flags: Unrecognized key: "flag"/],
      [{ ...BASE, decoded: { year: 2022, mileage: 40000 } }, /decoded: Unrecognized key: "mileage"/],
      [{ ...BASE, title: { brand: "clean", brnad: "salvage" } }, /title: Unrecognized key: "brnad"/],
      [{ ...BASE, codes: [{ code: "P0301", status: "confirmed", note: "x" }] }, /codes\.0: Unrecognized key: "note"/],
      [{ ...BASE, seller: { lanes: ["acv"] } }, /seller: Unrecognized key: "lanes"/],
      // A sample_vehicles.json-shaped object is not a record.
      [{ description: "d", generated: "2026-11-07", config_used: {}, vehicles: [] }, /Unrecognized keys?: /],
    ];
    for (const [raw, message] of bad) {
      expect(() => normalizeRecord(raw)).toThrow(InputError);
      expect(() => normalizeRecord(raw)).toThrow(message);
    }
  });

  it("absent keys are still fine and become unknown", () => {
    const r = normalizeRecord({ decoded: { year: 2012, make: "Ram" } });
    expect(r.runs_drives).toBe("unknown");
    expect(r.missing).toEqual(expect.arrayContaining(["runs_drives", "title.brand", "flags.frame", "odometer"]));
  });
});

describe("an empty record", () => {
  it("scores every category from its unknown row", () => {
    const r = normalizeRecord({});
    expect(scoreTitle(r, config)).toMatchObject({ acv: 0, copart: 0, confidence: 0.3 });
    expect(scoreDrivable(r, config)).toMatchObject({ acv: -0.3, copart: 0.2, confidence: 0.4 });
    expect(scoreHiddenRisk(r, config)).toMatchObject({ acv: -1, copart: 0.6 });
    expect(r.lanes_allowed).toEqual(["acv", "copart"]);
  });
});
