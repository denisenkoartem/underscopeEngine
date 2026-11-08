// sample_vehicles.json (repo root, written by the user): every vehicle must match its
// expected_offline under the file's own config_used, built in memory from config/ + overrides.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { ConfigError, PACKAGE_ROOT, loadConfig } from "../src/config.js";
import { InputError } from "../src/input.js";
import { buildSampleConfig, parseSampleFile, readSampleFile, runSamples } from "../src/samples.js";

const SAMPLE_PATH = join(PACKAGE_ROOT, "..", "..", "sample_vehicles.json");
const shipped = loadConfig();
const file = readSampleFile(SAMPLE_PATH);
const { config: sampleConfig, overrides } = buildSampleConfig(shipped, file.config_used);
const results = runSamples(file, sampleConfig);
const byId = new Map(results.map((r) => [r.id, r]));

describe("sample_vehicles.json under its config_used", () => {
  it("has 15 vehicles and is run as of the year it was generated (2026)", () => {
    expect(file.vehicles).toHaveLength(15);
    expect(file.as_of_year).toBe(2026);
  });

  it.each(file.vehicles.map((v) => v.id))("%s matches expected_offline", (id) => {
    expect(byId.get(id)!.mismatches).toEqual([]);
  });

  it("15/15 pass", () => {
    expect(results.filter((r) => r.mismatches.length === 0)).toHaveLength(15);
  });

  it("v14: branches agree on Copart -> the unknown-title run is reported (0.29, insufficient, frame)", () => {
    const d = byId.get("v14")!.decision;
    expect(d).toMatchObject({ recommendation: "copart", confidence: "insufficient", verify_first: "frame" });
    expect(d.probabilities.acv).toBeCloseTo(0.2923, 3);
    expect(d.category_scores.title).toMatchObject({ acv: 0, copart: 0, confidence: 0.3 });
    expect(d.category_scores.title.factors[0]).toBe(
      "Title brand unknown: clean branch -> copart, salvage branch -> copart; branches agree, reported the unknown-title run",
    );
  });

  it("v09: branches disagree -> the clean branch, close_call, confirm title brand", () => {
    const d = byId.get("v09")!.decision;
    expect(d).toMatchObject({ recommendation: "acv", confidence: "close_call", verify_first: "confirm title brand" });
    expect(d.probabilities.acv).toBeCloseTo(0.8331, 3);
    expect(d.category_scores.title.factors[0]).toContain("reported the clean branch");
  });
});

describe("buildSampleConfig", () => {
  it("maps weights.* to weights.json fields and dotted keys to scoring.json paths; note is ignored", () => {
    expect(overrides).toEqual([
      "weights.version",
      "weights.title",
      "weights.hidden_risk",
      "weights.market_fit",
      "weights.drivable",
      "weights.temperature",
      "weights.clear_threshold",
      "drivable.severe_code_modifier",
    ]);
    expect(sampleConfig.weights).toMatchObject({
      version: 1,
      weights: { title: 0.3, hidden_risk: 0.25, market_fit: 0.2, drivable: 0.25 },
      temperature: 0.5,
      clear_threshold: 0.7,
    });
    expect(sampleConfig.scoring.drivable.severe_code_modifier).toEqual({ acv: -1.0, copart: 0.4 });
    // Every other table as shipped; code sets untouched.
    expect(sampleConfig.scoring.title).toEqual(shipped.scoring.title);
    expect(sampleConfig.scoring.hidden_risk).toEqual(shipped.scoring.hidden_risk);
    expect(sampleConfig.scoring.market_fit_fallback).toEqual(shipped.scoring.market_fit_fallback);
    expect(sampleConfig.scoring.drivable.no).toEqual(shipped.scoring.drivable.no);
    expect(sampleConfig.codesets).toBe(shipped.codesets);
  });

  it("does not modify the shipped config", () => {
    const fresh = loadConfig();
    expect(shipped.weights).toEqual(fresh.weights);
    expect(shipped.scoring).toEqual(fresh.scoring);
    expect(shipped.weights.version).toBe(0);
    expect(shipped.scoring.drivable.severe_code_modifier).toEqual({ acv: -0.4, copart: 0.1 });
  });

  it("accepts a top-level weights.<field> key", () => {
    const { config } = buildSampleConfig(shipped, { "weights.market_fit": 0.1, "weights.version": 7 });
    expect(config.weights.weights.market_fit).toBe(0.1);
    expect(config.weights.version).toBe(7);
  });

  it("rejects unknown keys", () => {
    expect(() => buildSampleConfig(shipped, { foo: 1 })).toThrow(ConfigError);
    expect(() => buildSampleConfig(shipped, { foo: 1 })).toThrow(/unknown key "foo"/);
    expect(() => buildSampleConfig(shipped, { "drivable.nope": { acv: 0, copart: 0 } })).toThrow(/unknown key "drivable.nope"/);
    expect(() => buildSampleConfig(shipped, { weights: { bogus: 1 } })).toThrow(/unknown weights key "weights.bogus"/);
    expect(() => buildSampleConfig(shipped, { "weights.description": "x" })).toThrow(/unknown weights key/);
    expect(() => buildSampleConfig(shipped, { weights: 3 })).toThrow(/config_used.weights must be an object/);
  });

  it("validates the result like the JSON files", () => {
    expect(() => buildSampleConfig(shipped, { "drivable.severe_code_modifier": { acv: "x", copart: 0 } })).toThrow(
      /Invalid scoring config/,
    );
    expect(() => buildSampleConfig(shipped, { weights: { clear_threshold: 0.4 } })).toThrow(/Invalid weights config/);
  });
});

describe("parseSampleFile", () => {
  // Raw JSON, mutated per case (hence untyped).
  const minimal = (): any => ({
    description: "d",
    generated: "2025-03-01",
    config_used: {},
    vehicles: [
      {
        id: "x1",
        description: "a",
        record: { title: { brand: "clean" }, runs_drives: "run_and_drive" },
        expected_offline: { recommendation: "acv", probabilities: { acv: 0.5, copart: 0.5 }, confidence: "clear", verify_first: null },
      },
    ],
  });

  it("takes the as-of year from generated", () => {
    expect(parseSampleFile(minimal()).as_of_year).toBe(2025);
  });

  it("rejects bad structure, bad records, bad expectations and duplicate ids", () => {
    expect(() => parseSampleFile({ ...minimal(), vehicles: undefined })).toThrow(InputError);
    expect(() => parseSampleFile({ ...minimal(), generated: "yesterday" })).toThrow(/generated/);
    const badRecord = minimal();
    badRecord.vehicles[0].record.runs_drives = "sometimes";
    expect(() => parseSampleFile(badRecord)).toThrow(/vehicles\.0 \(x1\): Invalid condition record/);
    const badVerify = minimal();
    badVerify.vehicles[0].expected_offline.verify_first = "brakes";
    expect(() => parseSampleFile(badVerify)).toThrow(/verify_first/);
    const dup = minimal();
    dup.vehicles.push(dup.vehicles[0]);
    expect(() => parseSampleFile(dup)).toThrow(/duplicate vehicle id "x1"/);
  });
});

describe("pnpm engine samples", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const capture = () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    return lines;
  };

  it("default mode: 15/15 PASS, exit 0", async () => {
    const lines = capture();
    expect(await main(["samples", SAMPLE_PATH])).toBe(0);
    expect(lines.join("\n")).toContain("15/15 PASS");
    expect(lines.find((l) => l.startsWith("v14"))).toMatch(/^v14\s+copart\s+P\(ACV\) 0\.2923\s+insufficient\s+verify_first frame\s+PASS$/);
  });

  it("--use-shipped-config reports differences but exits 0", async () => {
    const lines = capture();
    expect(await main(["samples", SAMPLE_PATH, "--use-shipped-config"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("config/ as shipped (weights v0)");
    expect(text).toMatch(/informational; exit code 0/);
    expect(text).toContain("FAIL");
  });

  it("default mode exits 1 on any FAIL", async () => {
    dir = mkdtempSync(join(tmpdir(), "underscope-samples-"));
    const data = JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
    data.vehicles[0].expected_offline.confidence = "close_call"; // v01 is clear
    const path = join(dir, "samples.json");
    writeFileSync(path, JSON.stringify(data));
    const lines = capture();
    expect(await main(["samples", path])).toBe(1);
    expect(lines.join("\n")).toContain("confidence: expected close_call, got clear");
    expect(lines.join("\n")).toContain("14/15 PASS, 1 FAIL");
  });

  it("rejects --as-of for samples and --use-shipped-config for other commands", async () => {
    await expect(main(["samples", SAMPLE_PATH, "--as-of", "2025"])).rejects.toThrow(/generated/);
    await expect(main(["eval", "--offline", "--use-shipped-config"])).rejects.toThrow(/only applies to the samples command/);
  });
});
