// read() and merge() (src/read.ts): the one place that decides what the output says.
import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { chatParserClient } from "../src/chatAdapter.js";
import { main } from "../src/cli.js";
import { emptyAssessment, listMissing, type Assessment } from "../src/contract.js";
import { PRIMARY, merge, read } from "../src/read.js";

const make = (reader: "rules" | "model", patch: (a: Assessment) => void): Assessment => {
  const a = emptyAssessment(reader);
  patch(a);
  listMissing(a);
  return a;
};
const client = (answer: unknown, fail = false) =>
  chatParserClient({ chat: { completions: { create: async () => {
    if (fail) throw new Error("connection refused");
    return { id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer), refusal: null } }] } as ChatCompletion;
  } } } });

describe("merge", () => {
  it("a field only one reader filled is taken, with its evidence", () => {
    const rules = make("rules", (a) => { a.title_status = "clean"; a.evidence.title_status = "clean title"; });
    const model = make("model", (a) => { a.keys = false; a.evidence.keys = "lost the keys"; a.values.repair_estimate = 4000; a.evidence["values.repair_estimate"] = "quoted 4k"; });
    const m = merge(rules, model);
    expect(m).toMatchObject({ reader: "rules+model", title_status: "clean", keys: false, conflicts: [] });
    expect(m.values.repair_estimate).toBe(4000);
    expect(m.evidence).toMatchObject({ title_status: "clean title", keys: "lost the keys", "values.repair_estimate": "quoted 4k" });
  });
  it("a plain disagreement keeps the primary reader's value and is recorded and asked", () => {
    const rules = make("rules", (a) => { a.run_status = "starts"; a.evidence.run_status = "starts"; });
    const model = make("model", (a) => { a.run_status = "runs_and_drives"; a.evidence.run_status = "starts and drives"; });
    const m = merge(rules, model);
    expect(PRIMARY).toBe("rules");
    expect(m.run_status).toBe("starts");
    expect(m.conflicts).toEqual([{ field: "run_status", kept: "starts", dropped: "runs_and_drives" }]);
    expect(m.questions.join(" ")).toMatch(/two ways for run status/);
    expect(merge(rules, model, "model").run_status).toBe("runs_and_drives");
  });
  it("a risk flag keeps the worse value whoever said it", () => {
    const rules = make("rules", (a) => { a.flags.frame_suspected = false; a.evidence["flags.frame_suspected"] = "no frame damage noted"; });
    const model = make("model", (a) => { a.flags.frame_suspected = true; a.evidence["flags.frame_suspected"] = "would not trust the frame"; });
    const m = merge(rules, model);
    expect(m.flags.frame_suspected).toBe(true);
    expect(m.evidence["flags.frame_suspected"]).toBe("would not trust the frame");
    expect(m.conflicts).toHaveLength(1);
  });
  it("part grades: the costlier explicit grade wins; an explicit grade beats a swept-up 'fine'", () => {
    const grade = (a: Assessment, part: string, g: "fine" | "repairable" | "replace", quote?: string) => {
      a.grades.find((x) => x.part === part)!.grade = g;
      if (quote) a.evidence[`grades.${part}`] = quote;
    };
    const rules = make("rules", (a) => { grade(a, "hood", "repairable", "hood dented"); a.grades.forEach((g) => { if (g.grade === "unknown") g.grade = "fine"; }); a.evidence["grades.rest"] = "rest is fine"; });
    const model = make("model", (a) => { grade(a, "hood", "replace", "hood needs replacing"); grade(a, "roof", "repairable", "roof has hail dents"); });
    const m = merge(rules, model);
    expect(m.grades.find((g) => g.part === "hood")!.grade).toBe("replace");
    expect(m.grades.find((g) => g.part === "roof")!.grade).toBe("repairable");
    expect(m.grades.find((g) => g.part === "grille")!.grade).toBe("fine");
    expect(m.conflicts.map((c) => c.field)).toEqual(["grades.hood"]);
  });
  it("lists are joined without repeating a complaint", () => {
    const rules = make("rules", (a) => { a.codes = [{ code: "P0301", status: "confirmed" }]; a.symptoms = [{ system: "engine", text: "small coolant leak" }]; a.warning_lights = ["abs"]; });
    const model = make("model", (a) => { a.codes = [{ code: "P0301", status: "confirmed" }, { code: "P0420", status: "pending" }]; a.symptoms = [{ system: "engine", text: "coolant leak" }, { system: "brakes", text: "brakes grind" }]; a.warning_lights = ["check_engine"]; });
    const m = merge(rules, model);
    expect(m.codes.map((c) => c.code)).toEqual(["P0301", "P0420"]);
    expect(m.symptoms.map((s) => s.text)).toEqual(["small coolant leak", "brakes grind"]);
    expect(m.warning_lights).toEqual(["abs", "check_engine"]);
  });
});

describe("read", () => {
  const text = "Clean title, 84k miles. Runs and drives. Lost the keys.";
  it("without a model server it is the rules' reading", async () => {
    const r = await read(text, { env: {} as NodeJS.ProcessEnv });
    expect(r).toMatchObject({ model_error: null, issues: [] });
    expect(r.assessment).toMatchObject({ reader: "rules", title_status: "clean", mileage: 84000 });
  });
  it("with a model it returns one merged assessment", async () => {
    const r = await read(text, { client: client({ seller_type: { value: "individual", evidence: "Lost the keys" }, mileage: { value: 84000, evidence: "84k miles" } }), env: {} as NodeJS.ProcessEnv, log: () => {} });
    expect(r.assessment).toMatchObject({ reader: "rules+model", seller_type: "individual", mileage: 84000, keys: false, conflicts: [] });
  });
  it("a model that fails falls back to the rules and says so; 'required' fails instead", async () => {
    const opts = { client: client({}, true), env: {} as NodeJS.ProcessEnv, log: () => {}, sleep: async () => {} };
    const r = await read(text, opts);
    expect(r.assessment.reader).toBe("rules");
    expect(r.model_error).toMatch(/connection refused|request failed/i);
    await expect(read(text, { ...opts, model: "required" })).rejects.toThrow();
  });
  it("model 'off' never calls the model", async () => {
    const r = await read(text, { client: client({}, true), model: "off" });
    expect(r).toMatchObject({ model_error: null });
  });
});

describe("cli", () => {
  it("read prints the assessment JSON; a missing text is a usage error", async () => {
    const out: string[] = [];
    const log = console.log, err = console.error;
    console.log = (s: string) => void out.push(s);
    console.error = () => {};
    try {
      expect(await main(["read", "Salvage", "title,", "does", "not", "start"], { env: {} as NodeJS.ProcessEnv })).toBe(0);
      expect(JSON.parse(out[0]!)).toMatchObject({ reader: "rules", title_status: "salvage", run_status: "does_not_start" });
      expect(await main(["read"])).toBe(1);
      expect(await main(["decide", "x.json"])).toBe(1);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
