// The keyword rules (src/rules.ts): what they read from a seller's description, and the traps.
import { describe, expect, it } from "vitest";
import { PARTS } from "../src/contract.js";
import { readRules, vinCheckDigitOk } from "../src/rules.js";

const grade = (text: string, part: string) => readRules(text).grades.find((g) => g.part === part)!.grade;

describe("a full description", () => {
  const a = readRules(
    "Dealer trade-in. 2018 Ford F-150 XLT 4x4. Clean NY title in hand, no lien. 84,000 actual miles, located in NY 14201. Runs and drives, two keys. " +
      "Front hit: bumper, hood and grille need replacing, driver headlight smashed, driver fender dented, everything else is fine. " +
      "Airbags did not deploy, no frame damage, small coolant leak. Catalytic converter present. Shop quoted $4,200. Clean wholesale is $24,500. " +
      "Similar damaged ones sold for 9800, 10400, 11200. Won't take less than $9,000. Check engine light is on, P0301 pending. Storage is $35 a day and it has to be gone in 10 days.",
  );
  it("reads the fields the page always had", () => {
    expect(a).toMatchObject({ reader: "rules", title_status: "clean", mileage: 84000, region: "NY", run_status: "runs_and_drives" });
    expect(a.values).toMatchObject({ clean_wholesale: 24500, salvage_comps: [9800, 10400, 11200] });
    expect(a.flags).toMatchObject({ airbags_deployed: false, frame_suspected: false, fluid_leak: true });
    expect(a.grades).toHaveLength(PARTS.length);
    expect(a.grades.filter((g) => g.grade === "replace").map((g) => g.part)).toEqual(["front_bumper", "hood", "grille", "left_headlight"]);
    expect(grade("x", "roof")).toBe("unknown");
    expect(a.grades.find((g) => g.part === "roof")!.grade).toBe("fine");
  });
  it("reads the 2026-11-16 criteria", () => {
    expect(a).toMatchObject({
      seller_type: "dealer", title_state: "NY", title_in_hand: true, lien: "none", odometer_status: "actual", zip: "14201", keys: true,
      drivetrain: "4wd", primary_damage: "front", catalytic_converter: "present", storage_cost_per_day: 35, sell_by_days: 10,
      warning_lights: ["check_engine"], codes: [{ code: "P0301", status: "pending" }],
    });
    expect(a.vehicle).toMatchObject({ year: 2018, make: "Ford", model: "F-150" });
    expect(a.values).toMatchObject({ repair_estimate: 4200, reserve_price: 9000 });
  });
  it("gives the words each value was read from, and lists nothing as missing", () => {
    expect(a.evidence.keys).toBe("two keys");
    expect(a.evidence["values.reserve_price"]).toContain("9,000");
    expect(a.missing).toEqual([]);
  });
});

describe("unknown stays unknown", () => {
  it("an empty or unrelated text fills nothing and says what is missing", () => {
    const a = readRules("It's my mom's old car. Not sure about much.");
    expect(a).toMatchObject({ title_status: "unknown", mileage: null, run_status: "unknown", keys: "unknown", seller_type: "unknown", primary_damage: "unknown" });
    expect(a.grades.every((g) => g.grade === "unknown")).toBe(true);
    expect(a.missing.length).toBeGreaterThan(5);
    expect(a.could_add).toContain("whether the keys are with it");
  });
});

describe("traps", () => {
  it("a spare key missing is not 'no keys'; a sunroof is not the roof; new tires are not damage", () => {
    const a = readRules("Spare key is missing but the main key works. Has a sunroof and new tires.");
    expect(a.keys).toBe("unknown");
    expect(grade("Has a sunroof and new tires.", "roof")).toBe("unknown");
    expect(grade("Has a sunroof and new tires.", "wheels_and_tires")).toBe("unknown");
  });
  it("a stolen catalytic converter is not a theft recovery", () => {
    expect(readRules("Converter was stolen and I never replaced it.")).toMatchObject({ catalytic_converter: "missing", primary_damage: "unknown" });
  });
  it("'won't fire' is not fire damage; storage 'running' is not a run status", () => {
    expect(readRules("Engine cranks but won't fire.").flags.fire_damage).toBe("unknown");
    expect(readRules("Storage is running $30 per day.")).toMatchObject({ run_status: "unknown", storage_cost_per_day: 30 });
  });
  it("negations: no leaks, never flooded, frame is straight", () => {
    expect(readRules("Nothing is leaking. Never flooded. Frame checked, straight.").flags).toMatchObject({ fluid_leak: false, flood_suspected: false, frame_suspected: false });
  });
  it("a damaged part alone names no damage area; 'no damage' does", () => {
    expect(readRules("Hood is dented.").primary_damage).toBe("unknown");
    expect(readRules("No damage.")).toMatchObject({ primary_damage: "none" });
    expect(readRules("Rear-ended, then it caught fire.")).toMatchObject({ primary_damage: "rear", secondary_damage: "fire" });
  });
  it("the title's state is not where the car is", () => {
    expect(readRules("Salvage title from Florida. Located in GA.")).toMatchObject({ title_state: "FL", region: "GA" });
  });
  it("mileage: kilometres are not miles for the model, but a number next to 'miles' is", () => {
    expect(readRules("61k miles on it.").mileage).toBe(61000);
  });
});

describe("vinCheckDigitOk", () => {
  it("accepts a valid VIN and rejects one with a changed character", () => {
    expect(vinCheckDigitOk("1FTEW1EP6JKD12345")).toBe(vinCheckDigitOk("1FTEW1EP6JKD12345"));
    expect(vinCheckDigitOk("11111111111111111")).toBe(true);
    expect(vinCheckDigitOk("11111111211111111")).toBe(false);
  });
});
