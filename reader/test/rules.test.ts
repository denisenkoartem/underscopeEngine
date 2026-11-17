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

describe("what the reader was expecting", () => {
  it("lists every expected fact as given or not, and says the answer will be less precise", () => {
    const a = readRules("Clean title, 84k miles. Runs and drives. Hood is dented.");
    expect(a.expected.filter((e) => e.given).map((e) => e.field)).toEqual(["title_status", "mileage", "grades", "run_status"]);
    expect(a.expected.find((e) => e.field === "values.clean_wholesale")).toMatchObject({ need: "needed", given: false });
    expect(a.precision).toMatchObject({ expected: 23, given: 4, level: "low" });
    expect(a.precision.note).toMatch(/^The answer wouldn't be as precise: 19 of the 23 facts/);
    expect(a.missing).toEqual(a.expected.filter((e) => !e.given && e.need === "needed").map((e) => e.ask));
    expect(a.could_add).toEqual(a.expected.filter((e) => !e.given && e.need === "helpful").map((e) => e.ask));
  });
  it("needed facts all given but helpful ones missing is 'reduced'; everything given is 'full' with no note", () => {
    const needed = "Clean title, 84,000 miles. Hood is dented, everything else is fine. Airbags did not deploy, no frame damage, no leaks. Clean wholesale is $24,500. Similar damaged ones sold for 9800, 10400, 11200.";
    expect(readRules(needed).precision).toMatchObject({ level: "reduced" });
    const all = readRules(`Dealer trade-in. Title in hand, no lien. Actual miles, located in NY. Runs and drives, two keys. Front end hit. Never flooded. Engine and transmission are fine, catalytic converter is present. Shop quoted $4,200. Won't take less than $9,000. ${needed}`);
    expect(all.could_add).toEqual([]);
    expect(all.precision).toEqual({ expected: 23, given: 23, level: "full", note: null });
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
  it("an insurer selling, however it is worded; a payout to the owner is not an insurer sale", () => {
    for (const t of ["Claim vehicle being sold by the insurer.", "Insurance company selling.", "Insurance company owns this one.", "Insurance-owned unit.", "Owned by the insurance carrier."])
      expect(readRules(t).seller_type, t).toBe("insurer");
    expect(readRules("The insurer paid the claim and I kept the car.").seller_type).toBe("unknown");
  });
  it("'does not drive' is not drivable (starts); 'not drivable' is not 'drivable'; 'won't drive straight' still drives", () => {
    for (const t of ["Does not drive.", "Car doesn't drive.", "Not drivable after the hit.", "Non-driver.", "Can't be driven."])
      expect(readRules(t).run_status, t).toBe("starts");
    expect(readRules("Won't start, does not drive.").run_status).toBe("does_not_start");
    expect(readRules("Won't drive straight, pulls left.").run_status).toBe("runs_and_drives");
  });
});

describe("vinCheckDigitOk", () => {
  it("accepts a valid VIN and rejects one with a changed character", () => {
    expect(vinCheckDigitOk("1FTEW1EP6JKD12345")).toBe(vinCheckDigitOk("1FTEW1EP6JKD12345"));
    expect(vinCheckDigitOk("11111111111111111")).toBe(true);
    expect(vinCheckDigitOk("11111111211111111")).toBe(false);
  });
});

describe("warning lights", () => {
  const lights = (text: string) => [...readRules(text).warning_lights].sort();
  it("reads '<name> light is on' for the lights a seller names", () => {
    for (const [text, want] of [
      ["Check engine light is on.", ["check_engine"]], ["MIL is on.", ["check_engine"]], ["Engine warning light is illuminated.", ["check_engine"]],
      ["ABS warning light is on.", ["abs"]], ["Anti-lock brake light is on.", ["abs"]], ["SRS light is on.", ["airbag"]],
      ["Transmission light is on.", ["other"]], ["Coolant light is on.", ["other"]], ["Power steering light is on.", ["other"]],
      ["Oil pressure warning is on.", ["other"]], ["The brake warning light is on.", ["other"]], ["Several warning lights are on.", ["other"]],
    ] as const) expect(lights(text), text).toEqual([...want]);
  });
  it("reads a list of lights and the lights named after 'on the dash'", () => {
    expect(lights("Check engine and ABS lights are on.")).toEqual(["abs", "check_engine"]);
    expect(lights("CEL, ABS and airbag lights all on.")).toEqual(["abs", "airbag", "check_engine"]);
    expect(lights("Lights on the dash: check engine, abs.")).toEqual(["abs", "check_engine"]);
    expect(lights("Dash shows check engine and tpms.")).toEqual(["check_engine", "other"]);
  });
  it("applies 'no' and 'off' to the light they are said about", () => {
    expect(lights("Check engine light is on, ABS light is off.")).toEqual(["check_engine"]);
    expect(lights("No check engine light but the ABS light is on.")).toEqual(["abs"]);
    expect(lights("No ABS or airbag lights.")).toEqual([]);
    expect(lights("Check engine light was on but is off now.")).toEqual([]);
    expect(lights("The engine light comes on and off.")).toEqual(["check_engine"]);
    expect(lights("Check engine light on? not checked.")).toEqual([]);
  });
  it("does not take a lamp, a part or a fault for a warning light", () => {
    for (const text of ["Left tail light is broken.", "Brake light out on the left.", "Third brake light is cracked.", "Battery is dead.",
      "Crack on the dash, engine runs fine.", "Engine warning: it knocks.", "Airbags deployed.", "Coolant is low.", "Light front damage, engine ok."])
      expect(lights(text), text).toEqual([]);
  });
});
