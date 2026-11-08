// reported_symptoms: input validation, the drivable severe rule (modifier once in total, with
// and without severe codes), non-severe systems, config validation, and "not hidden risk".

import { describe, expect, it } from "vitest";
import { decide } from "../src/combine.js";
import { ConfigError, loadConfig, parseScoring, type EngineConfig } from "../src/config.js";
import { scoreDrivable, severeCauses } from "../src/drivable.js";
import { countedFlags, scoreHiddenRisk } from "../src/hiddenRisk.js";
import { InputError, ReportedSymptomSchema, normalizeRecord, type ConditionRecordInput } from "../src/input.js";
import { SYMPTOM_SYSTEMS } from "../src/types.js";

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

const TRANSMISSION = { system: "transmission", text: "transmission is generating noise" } as const;
const ENGINE = { system: "engine", text: "engine knocks when cold" } as const;
const BRAKES = { system: "brakes", text: "brakes squeal" } as const;
const MISFIRE_CAT = [
  { code: "P0301", status: "confirmed" },
  { code: "P0420", status: "confirmed" },
] as const;

/** The shipped config with drivable.severe_symptom_systems replaced (in memory, validated). */
function withSevereSystems(systems: unknown): EngineConfig {
  const scoring = structuredClone(config.scoring) as unknown as { drivable: Record<string, unknown> };
  scoring.drivable.severe_symptom_systems = systems;
  return { ...config, scoring: parseScoring(scoring) };
}

describe("reported_symptoms input", () => {
  it("keeps system and the user's words (trimmed); present means not missing", () => {
    const r = rec({ reported_symptoms: [{ system: "transmission", text: "  transmission is generating noise " }, BRAKES] });
    expect(r.reported_symptoms).toEqual([TRANSMISSION, BRAKES]);
    expect(r.missing).not.toContain("reported_symptoms");
  });

  it("absent or null -> [] and listed in missing; [] -> not missing", () => {
    for (const r of [rec(), rec({ reported_symptoms: null })]) {
      expect(r.reported_symptoms).toEqual([]);
      expect(r.missing).toContain("reported_symptoms");
    }
    const empty = rec({ reported_symptoms: [] });
    expect(empty.reported_symptoms).toEqual([]);
    expect(empty.missing).not.toContain("reported_symptoms");
  });

  it("rejects an unknown system, empty words and unknown keys", () => {
    const bad: [unknown, RegExp][] = [
      [[{ system: "gearbox", text: "noise" }], /reported_symptoms\.0\.system: /],
      [[{ system: "transmission", text: "   " }], /reported_symptoms\.0\.text: expected the user's words/],
      [[{ system: "transmission" }], /reported_symptoms\.0\.text: /],
      [[{ system: "engine", text: "knock", severity: "high" }], /reported_symptoms\.0: Unrecognized key: "severity"/],
      [{ system: "engine", text: "knock" }, /reported_symptoms: /],
    ];
    for (const [symptoms, message] of bad) {
      const raw = { ...BASE, reported_symptoms: symptoms };
      expect(() => normalizeRecord(raw)).toThrow(InputError);
      expect(() => normalizeRecord(raw)).toThrow(message);
    }
  });

  it("exports the enum and the symptom schema for the parser", () => {
    expect(SYMPTOM_SYSTEMS).toEqual([
      "transmission",
      "engine",
      "brakes",
      "steering_suspension",
      "electrical",
      "body",
      "interior",
      "other",
    ]);
    expect(ReportedSymptomSchema.safeParse(TRANSMISSION).success).toBe(true);
  });
});

describe("drivable.severe_symptom_systems config", () => {
  it("ships transmission and engine; the existing numbers are unchanged", () => {
    expect(config.scoring.drivable.severe_symptom_systems).toEqual(["transmission", "engine"]);
    expect(config.scoring.drivable.severe_code_modifier).toEqual({ acv: -0.4, copart: 0.1 });
  });

  it("is validated against the symptom systems and is required", () => {
    expect(() => withSevereSystems(["gearbox"])).toThrow(ConfigError);
    expect(() => withSevereSystems(["gearbox"])).toThrow(/drivable\.severe_symptom_systems\.0: /);
    expect(() => withSevereSystems(1)).toThrow(/drivable\.severe_symptom_systems: /);
    expect(() => withSevereSystems(undefined)).toThrow(/drivable\.severe_symptom_systems: /);
  });
});

describe("drivable: reported symptoms", () => {
  it("a transmission symptom makes the record severe: modifier once, factor with the user's words", () => {
    const r = rec({ reported_symptoms: [TRANSMISSION] });
    const s = scoreDrivable(r, config);
    expect(s).toMatchObject({ acv: 0.4, copart: 0.1, confidence: 1, source: "input" }); // 0.8 - 0.4, 0 + 0.1
    expect(severeCauses(r, config)).toEqual(["reported symptom: transmission"]);
    expect(s.factors).toEqual([
      "Run status: run_and_drive",
      "Severe: reported symptom: transmission -> modifier applied once",
      'Reported symptom: transmission ("transmission is generating noise")',
    ]);
  });

  it("an engine symptom is severe too", () => {
    expect(scoreDrivable(rec({ reported_symptoms: [ENGINE] }), config)).toMatchObject({ acv: 0.4, copart: 0.1 });
  });

  it("severe codes plus severe symptoms plus frame/airbag 'yes' still apply the modifier once", () => {
    const r = rec({
      codes: [...MISFIRE_CAT],
      flags: { frame: "yes", airbag: "yes" },
      reported_symptoms: [TRANSMISSION, ENGINE, { system: "transmission", text: "slips into neutral" }],
    });
    const s = scoreDrivable(r, config);
    expect(s).toMatchObject({ acv: 0.4, copart: 0.1 });
    expect(severeCauses(r, config)).toEqual([
      "MISFIRE+CATALYST confirmed (P0301, P0420)",
      "frame: yes",
      "airbag: yes",
      "reported symptom: transmission",
      "reported symptom: engine",
    ]);
    expect(s.factors.filter((f) => f.startsWith("Severe: "))).toHaveLength(1);
    expect(s.factors).toContain('Reported symptom: transmission ("slips into neutral")');
  });

  it("severe codes alone and severe codes plus a severe symptom give the same scores", () => {
    const codesOnly = scoreDrivable(rec({ codes: [...MISFIRE_CAT] }), config);
    const both = scoreDrivable(rec({ codes: [...MISFIRE_CAT], reported_symptoms: [TRANSMISSION] }), config);
    expect([both.acv, both.copart]).toEqual([codesOnly.acv, codesOnly.copart]);
    expect([both.acv, both.copart]).toEqual([0.4, 0.1]);
  });

  it("a symptom of a non-severe system adds a factor but no modifier", () => {
    const s = scoreDrivable(rec({ reported_symptoms: [BRAKES] }), config);
    expect(s).toMatchObject({ acv: 0.8, copart: 0 });
    expect(s.factors).toEqual([
      "Run status: run_and_drive",
      'Reported symptom: brakes ("brakes squeal"), not a severe system: no modifier',
    ]);
  });

  it("the list in scoring.json decides which systems are severe", () => {
    const brakesOnly = withSevereSystems(["brakes"]);
    expect(scoreDrivable(rec({ reported_symptoms: [BRAKES] }), brakesOnly)).toMatchObject({ acv: 0.4, copart: 0.1 });
    expect(scoreDrivable(rec({ reported_symptoms: [TRANSMISSION] }), brakesOnly)).toMatchObject({ acv: 0.8, copart: 0 });
    expect(scoreDrivable(rec({ reported_symptoms: [TRANSMISSION] }), withSevereSystems([]))).toMatchObject({ acv: 0.8 });
  });

  it("clamps after the modifier like any other severe cause", () => {
    const s = scoreDrivable(rec({ runs_drives: "no", reported_symptoms: [ENGINE] }), config);
    expect(s.acv).toBe(-1); // -0.8 - 0.4 = -1.2 -> -1
    expect(s.copart).toBe(0.7);
    expect(s.factors[1]).toBe("Severe: reported symptom: engine -> modifier applied once, clamped to [-1, 1]");
  });

  it("quotes the user's words as a JSON string (quotes inside are escaped)", () => {
    const s = scoreDrivable(rec({ reported_symptoms: [{ system: "engine", text: 'makes a "tick" sound' }] }), config);
    expect(s.factors).toContain('Reported symptom: engine ("makes a \\"tick\\" sound")');
  });
});

describe("symptoms are disclosed, not hidden risk", () => {
  it("do not change the hidden-risk count or score", () => {
    for (const flags of [{}, { frame: "unknown" }, { frame: "unknown", flood: "suspected", airbag: "unknown" }] as const) {
      const without = rec({ flags });
      const withSymptoms = rec({ flags, reported_symptoms: [TRANSMISSION, ENGINE, BRAKES] });
      expect(countedFlags(withSymptoms, config)).toEqual(countedFlags(without, config));
      expect(scoreHiddenRisk(withSymptoms, config)).toEqual(scoreHiddenRisk(without, config));
    }
    expect(scoreHiddenRisk(rec({ reported_symptoms: [TRANSMISSION] }), config).factors).toEqual([
      "No unresolved hidden-risk flags",
    ]);
  });

  it("in a full decision only drivable moves, and verify_first ignores symptoms", async () => {
    const opts = { offline: true, asOfYear: 2026 };
    const base = await decide(rec(), config, opts);
    const d = await decide(rec({ reported_symptoms: [TRANSMISSION] }), config, opts);
    expect(d.category_scores.drivable).toMatchObject({ acv: 0.4, copart: 0.1 });
    for (const c of ["title", "hidden_risk", "market_fit"] as const) expect(d.category_scores[c]).toEqual(base.category_scores[c]);
    expect(d.verify_first).toBeNull();
    expect(d.probabilities.acv).toBeLessThan(base.probabilities.acv);
  });
});
