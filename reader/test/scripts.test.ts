// The training-data scripts (scripts/reader): generated notes, the v1 upgrade, the export and the scoring.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PARTS } from "../src/contract.js";
import { PACKAGE_ROOT, verifyAnswer, type Answer } from "../src/model.js";
import { readRules } from "../src/rules.js";
import { sftLine, sftTarget } from "../scripts/reader/export.js";
import { goldItems } from "../scripts/reader/gold.js";
import { assessmentFields, expectAssessment, gates, metrics, readJsonl, rng, scoreItem, targetProblems, verifyNotes, type GoldItem } from "../scripts/reader/lib.js";
import { synthItem } from "../scripts/reader/synth.js";
import { upgradeItem } from "../scripts/reader/upgrade.js";
import { fromV1 } from "../scripts/reader/v1.js";

describe("generated notes", () => {
  it("every generated note's answer passes the production checks, in both styles", () => {
    const r = rng(7);
    for (let i = 0; i < 150; i++) {
      const x = synthItem(r, `t-${i}`, i % 3 !== 0);
      expect("item" in x, "dropped" in x ? `${x.dropped}\n${x.notes}` : "").toBe(true);
    }
  });
  it("new-style notes state the 2026-11-16 fields", () => {
    const r = rng(3);
    const answers = Array.from({ length: 80 }, (_, i) => synthItem(r, `t-${i}`, true)).flatMap((x) => ("item" in x ? [x.item.target] : []));
    const filled = (k: string) => answers.filter((a) => (a[k] as { value?: unknown })?.value != null).length;
    for (const k of ["seller_type", "title_in_hand", "keys", "primary_damage", "repair_estimate", "reserve_price"]) expect(filled(k), k).toBeGreaterThan(5);
    expect(answers.filter((a) => (a.grades ?? []).length > 0).length).toBeGreaterThan(20);
  });
});

describe("upgrading a v1 item", () => {
  const notes = "'19 Chevy Malibu LT, 84k miles, salvage title, R&D unit, airbag light on, bent frame rail, transmission slips between 2nd and 3rd, emissions monitors not ready, two keys, asking $4,500";
  const old = {
    id: "v1-1", source: "synthetic", origin: "synth:template", notes,
    target: {
      year: { value: 2019, evidence: "'19 Chevy Malibu LT" }, make: { value: "Chevrolet", evidence: "'19 Chevy Malibu LT" }, model: { value: "Malibu", evidence: "'19 Chevy Malibu LT" }, trim: { value: "LT", evidence: "'19 Chevy Malibu LT" },
      odometer: { value: 84000, evidence: "84k miles" }, title_brand: { value: "salvage", evidence: "salvage title" }, runs_drives: { value: "run_and_drive", evidence: "R&D unit" },
      flags: { frame: { value: "yes", evidence: "bent frame rail" }, airbag: { value: "suspected", evidence: "airbag light on" }, monitors_incomplete: { value: "yes", evidence: "emissions monitors not ready" } },
      codes: [], reported_symptoms: [{ system: "transmission", text: "transmission slips between 2nd and 3rd" }], unmapped: ["two keys", "asking $4,500"],
    },
  };
  it("renames the fields and moves phrases to the fields they now belong to", () => {
    const x = upgradeItem(old);
    expect("item" in x, "dropped" in x ? x.dropped : "").toBe(true);
    const a = verifyNotes(notes, (x as { item: { target: Answer } }).item.target).assessment;
    expect(a).toMatchObject({ mileage: 84000, title_status: "salvage", run_status: "runs_and_drives", keys: true, transmission_condition: "minor", warning_lights: ["airbag"] });
    expect(a.flags).toMatchObject({ frame_suspected: true, airbags_deployed: "unknown" });
    expect(a.grades.find((g) => g.part === "underbody")!.grade).toBe("repairable");
    expect(a.values.reserve_price).toBe(4500);
    expect(a.additional).toEqual(["emissions monitors not ready"]);
  });
  it("nonrepairable and the run statuses are renamed", () => {
    const a = fromV1({ title_brand: { value: "nonrepairable", evidence: "junk title" }, runs_drives: { value: "no", evidence: "no start" } });
    expect(a.title_status).toMatchObject({ value: "non_repairable" });
    expect(a.run_status).toMatchObject({ value: "does_not_start" });
  });
});

describe("the test set", () => {
  const gold = goldItems();
  it("fixtures/reader/gold.jsonl is what scripts/reader/gold.ts writes", () => {
    expect(readJsonl<GoldItem>(join(PACKAGE_ROOT, "fixtures", "reader", "gold.jsonl"))).toEqual(JSON.parse(JSON.stringify(gold)));
  });
  it("has at least 180 notes with unique ids and texts, and valid labels", () => {
    expect(gold.length).toBeGreaterThanOrEqual(180);
    expect(new Set(gold.map((g) => g.id)).size).toBe(gold.length);
    expect(new Set(gold.map((g) => g.notes)).size).toBe(gold.length);
    for (const g of gold) {
      const a = expectAssessment(g.expect);
      expect(a.grades.map((x) => x.part), g.id).toEqual([...PARTS]);
      for (const [code] of g.expect.codes ?? []) expect(g.notes.toUpperCase(), g.id).toContain(code);
      for (const n of [g.expect.mileage, ...Object.values(g.expect.values ?? {}).flat()]) {
        if (typeof n === "number") expect(g.notes.replace(/[,$]/g, ""), `${g.id} ${n}`).toMatch(new RegExp(`${n}|${n / 1000}\\s?(k|mil|thousand)`, "i"));
      }
    }
  });
  it("the rules reader is scored against it (the free baseline)", () => {
    const m = metrics(gold.map((g) => scoreItem(g.id, expectAssessment(g.expect), readRules(g.notes), [])));
    expect(m.failed).toBe(0);
    expect(m.stated_accuracy).toBeGreaterThan(0.75);
    expect(m.invented_rate).toBeLessThan(0.5);
  });
});

describe("export", () => {
  const r = rng(11);
  const item = (synthItem(r, "x-1", true) as { item: Parameters<typeof sftLine>[0] }).item;
  it("a full line is the production request plus the answer; sparse lists only filled fields; both pass the checks", () => {
    const full = JSON.parse(sftLine(item)) as { messages: { role: string; content: string }[] };
    expect(full.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(full.messages[0]!.content).toBe(readFileSync(join(PACKAGE_ROOT, "prompts", "read.md"), "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, ""));
    const sparse = JSON.parse((JSON.parse(sftLine(item, { sparse: true })) as typeof full).messages[2]!.content) as Answer;
    expect(JSON.stringify(sparse).length).toBeLessThan(full.messages[2]!.content.length);
    expect(JSON.stringify(sparse)).not.toContain("null");
    expect(targetProblems(item.notes, sparse)).toEqual([]);
  });
  it("--drop leaves the keys out", () => {
    expect(Object.keys(sftTarget(item.target, { drop: ["zip", "drivetrain"] }))).not.toContain("zip");
  });
});

describe("scoring", () => {
  it("counts right, invented and missed fields, and the gates compare two readers", () => {
    const gold = expectAssessment({ title_status: "salvage", keys: false, grades: { hood: "replace" } });
    const good = scoreItem("a", gold, gold, []);
    const pred = expectAssessment({ title_status: "clean", mileage: 5 });
    const bad = scoreItem("a", gold, pred, []);
    expect(assessmentFields(gold)["grades.replace"]).toBe("hood");
    const mGood = metrics([good]), mBad = metrics([bad]);
    expect(mGood).toMatchObject({ overall_accuracy: 1, stated_accuracy: 1, invented_rate: 0, missed_rate: 0 });
    expect(mBad.invented_rate).toBe(1);
    expect(mBad.missed_rate).toBe(3); // keys, the hood grade, the replace list
    expect(gates(mBad, mGood).some((g) => !g.pass)).toBe(true);
    expect(gates(mGood, mGood).every((g) => g.pass)).toBe(true);
    expect(verifyAnswer({}, "x").assessment.reader).toBe("model");
  });
});
