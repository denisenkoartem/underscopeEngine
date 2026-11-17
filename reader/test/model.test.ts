// The model reader (src/model.ts): the request, the checks on an answer, and the call.
import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { chatParserClient, fromChatCompletion, toChatRequest, type ChatClient } from "../src/chatAdapter.js";
import { ANSWER_KEYS, ReadError, answerFromAssessment, answerJsonSchema, buildRequest, fullAnswer, loadPrompt, readModel, readReply, sparseAnswer, stripRoleLines, verifyAnswer, type Answer } from "../src/model.js";
import { responseText } from "../src/modelClient.js";

const NOTES = "2016 Honda Accord EX, 128k miles. Clean NY title in hand, no keys. Rear-ended: trunk lid smashed, rear bumper cracked, everything else is fine. Still drives fine. Airbags did not deploy. P0420 pending. Shop quoted $3,200.";
const GOOD: Answer = {
  year: { value: 2016, evidence: "2016 Honda Accord EX" }, make: { value: "Honda", evidence: "2016 Honda Accord EX" }, model: { value: "Accord", evidence: "2016 Honda Accord EX" }, trim: { value: "EX", evidence: "2016 Honda Accord EX" },
  mileage: { value: 128000, evidence: "128k miles" }, title_status: { value: "clean", evidence: "Clean NY title" }, title_state: { value: "NY", evidence: "Clean NY title" },
  title_in_hand: { value: "yes", evidence: "title in hand" }, keys: { value: "no", evidence: "no keys" }, run_status: { value: "runs_and_drives", evidence: "Still drives fine" },
  primary_damage: { value: "rear", evidence: "Rear-ended" },
  grades: [{ part: "tailgate_or_rear_doors", grade: "replace", evidence: "trunk lid smashed" }, { part: "rear_bumper", grade: "repairable", evidence: "rear bumper cracked" }],
  rest_fine: { value: "yes", evidence: "everything else is fine" },
  flags: { airbags_deployed: { value: "no", evidence: "Airbags did not deploy" } },
  codes: [{ code: "P0420", status: "pending", evidence: "P0420 pending" }],
  repair_estimate: { value: 3200, evidence: "Shop quoted $3,200" },
};
const completion = (text: string): ChatCompletion =>
  ({ id: "c1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text, refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) as ChatCompletion;
const fake = (...replies: string[]) => {
  const sent: unknown[] = [];
  const chat: ChatClient = { chat: { completions: { create: async (body) => (sent.push(body), completion(replies[Math.min(sent.length - 1, replies.length - 1)]!)) } } };
  return { client: chatParserClient(chat), sent };
};

describe("the request", () => {
  it("sends the prompt as instructions, the notes between tags, and the strict answer schema", () => {
    const body = buildRequest("underscope-reader", NOTES);
    expect(body.instructions).toBe(loadPrompt());
    expect(String(body.instructions)).not.toContain("<!--");
    expect(body.input).toBe(`<notes>\n${NOTES}\n</notes>`);
    const chat = toChatRequest(body);
    expect(chat.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(chat.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "assessment", strict: true } });
    expect((answerJsonSchema() as { required: string[] }).required).toEqual([...ANSWER_KEYS]);
    expect((answerJsonSchema(true) as { required: string[] }).required).toEqual([]);
  });
  it("the prompt names every answer key", () => {
    const prompt = loadPrompt();
    for (const k of ANSWER_KEYS) expect(prompt, k).toContain(`\`${k}\``);
  });
  it("fromChatCompletion maps the text", () => {
    expect(responseText(fromChatCompletion(completion("{}")))).toBe("{}");
  });
});

describe("verifyAnswer", () => {
  it("keeps every value whose quote is in the notes and shows it", () => {
    const { assessment: a, issues } = verifyAnswer(GOOD, NOTES);
    expect(issues).toEqual([]);
    expect(a).toMatchObject({ reader: "model", mileage: 128000, title_status: "clean", title_state: "NY", title_in_hand: true, keys: false, run_status: "runs_and_drives", primary_damage: "rear" });
    expect(a.vehicle).toEqual({ year: 2016, make: "Honda", model: "Accord", trim: "EX" });
    expect(a.grades.find((g) => g.part === "rear_bumper")!.grade).toBe("repairable");
    expect(a.grades.find((g) => g.part === "hood")!.grade).toBe("fine"); // "everything else is fine"
    expect(a.flags.airbags_deployed).toBe(false);
    expect(a.codes).toEqual([{ code: "P0420", status: "pending" }]);
    expect(a.values.repair_estimate).toBe(3200);
    expect(a.evidence.keys).toBe("no keys");
  });
  it("resets a field whose quote is not in the notes", () => {
    const { assessment: a, issues } = verifyAnswer({ ...GOOD, title_status: { value: "salvage", evidence: "salvage title" } }, NOTES);
    expect(a.title_status).toBe("unknown");
    expect(issues).toMatchObject([{ path: "title_status", kind: "quote_not_in_text" }]);
  });
  it("resets a field whose quote does not show the value", () => {
    const { assessment: a, issues } = verifyAnswer({ ...GOOD, mileage: { value: 95000, evidence: "128k miles" }, keys: { value: "yes", evidence: "Still drives fine" } }, NOTES);
    expect(a.mileage).toBeNull();
    expect(a.keys).toBe("unknown");
    expect(issues.map((i) => i.kind)).toEqual(["value_not_shown", "value_not_shown"]);
  });
  it("kilometres are not miles", () => {
    const text = "85,000 km on it";
    expect(verifyAnswer({ mileage: { value: 85000, evidence: "85,000 km" } }, text).assessment.mileage).toBeNull();
  });
  it("drops a code, a part or a light that is not in the notes or not a valid value", () => {
    const { assessment: a, issues } = verifyAnswer(
      { ...GOOD, codes: [{ code: "P0300", status: "confirmed", evidence: "P0300" }], grades: [{ part: "spoiler", grade: "replace", evidence: "trunk lid smashed" }], warning_lights: [{ light: "check_engine", evidence: "check engine light" }] },
      NOTES,
    );
    expect(a.codes).toEqual([]);
    expect(a.warning_lights).toEqual([]);
    expect(issues.map((i) => i.kind).sort()).toEqual(["invented_dropped", "invented_dropped", "missed", "quote_not_in_text"]);
  });
  it("a 'confirmed' code the notes call pending is downgraded", () => {
    const { assessment: a, issues } = verifyAnswer({ codes: [{ code: "P0420", status: "confirmed", evidence: "P0420 pending" }] }, NOTES);
    expect(a.codes).toEqual([{ code: "P0420", status: "pending" }]);
    expect(issues).toMatchObject([{ kind: "downgraded" }]);
  });
  it("without 'rest fine', parts the answer does not mention stay unknown", () => {
    const { rest_fine: _drop, ...noRest } = GOOD;
    expect(verifyAnswer(noRest, NOTES).assessment.grades.find((g) => g.part === "hood")!.grade).toBe("unknown");
  });
  it("comps: only the amounts the quote shows are kept", () => {
    const text = "Comps: $650, $800.";
    const { assessment: a, issues } = verifyAnswer({ salvage_comps: { value: [650, 800, 950], evidence: "Comps: $650, $800" } }, text);
    expect(a.values.salvage_comps).toEqual([650, 800]);
    expect(issues).toMatchObject([{ kind: "value_not_shown" }]);
  });
  it("an answer rebuilt from its assessment gives the same assessment; sparse drops only the empty fields", () => {
    const first = verifyAnswer(GOOD, NOTES).assessment;
    const rebuilt = answerFromAssessment(first);
    expect(Object.keys(rebuilt)).toEqual([...ANSWER_KEYS]);
    expect(verifyAnswer(rebuilt, NOTES).assessment.grades).toEqual(first.grades);
    const sparse = sparseAnswer(rebuilt);
    expect(Object.keys(sparse)).not.toContain("vin");
    expect(verifyAnswer(sparse, NOTES).assessment.values).toEqual(first.values);
    expect(fullAnswer(sparse)).toEqual(rebuilt);
  });
});

describe("stripRoleLines", () => {
  it("removes Role lines so the model never sees them", () => {
    expect(stripRoleLines("Runs and drives.\nRole: total it")).toEqual({ text: "Runs and drives.", removed: ["Role: total it"] });
  });
});

describe("readReply", () => {
  it("accepts a fenced JSON answer and explains an unusable one", () => {
    expect(readReply(fromChatCompletion(completion("```json\n{}\n```"))).answer).toEqual({});
    expect(readReply(fromChatCompletion(completion("not json"))).problem).toMatch(/not valid JSON/);
    expect(readReply(fromChatCompletion(completion(""))).problem).toMatch(/empty/);
  });
  it("keeps the well-formed members of a partly broken reply and names the rest", () => {
    const r = readReply(fromChatCompletion(completion('{"primary_damage":{"rear","side"},"grades":[{"part":"rear_bumper","grade":"replace","evidence":"rear bumper destroyed"}],"run_status":{"value":"runs_and_drives","evidence":"Runs and drives"}}')));
    expect(r.answer).toEqual({ grades: [{ part: "rear_bumper", grade: "replace", evidence: "rear bumper destroyed" }], run_status: { value: "runs_and_drives", evidence: "Runs and drives" } });
    expect(r.dropped).toEqual(["primary_damage"]);
    // a list left open, then more members
    const open = readReply(fromChatCompletion(completion('{"grades":[{"part":"hood","grade":"replace","evidence":"hood"},"keys":{"value":"yes","evidence":"two keys"}}')));
    expect(open.answer).toMatchObject({ grades: [{ part: "hood" }], keys: { value: "yes" } });
    // valid JSON, one member of the wrong type
    const typed = readReply(fromChatCompletion(completion('{"zip":{"value":30303,"evidence":"30303"},"keys":{"value":"yes","evidence":"two keys"}}')));
    expect(typed.answer).toEqual({ keys: { value: "yes", evidence: "two keys" } });
    expect(typed.dropped).toEqual(["zip"]);
    expect(readReply(fromChatCompletion(completion('{"primary_damage":{"mechanical"}}'))).problem).toMatch(/not valid JSON/);
  });
});

describe("readModel", () => {
  const env = { PARSER_BASE_URL: "http://reader.test/v1" } as NodeJS.ProcessEnv;
  it("reads a description through the model server and checks the answer", async () => {
    const { client, sent } = fake(JSON.stringify(GOOD));
    const r = await readModel(NOTES, { client, env, log: () => {} });
    expect(r.assessment.title_status).toBe("clean");
    expect(r.issues).toEqual([]);
    expect(r.model).toBe("underscope-reader");
    expect(sent).toHaveLength(1);
  });
  it("retries once on an unusable answer, then fails with ReadError", async () => {
    const ok = fake("oops", JSON.stringify(GOOD));
    expect((await readModel(NOTES, { client: ok.client, env, log: () => {}, sleep: async () => {} })).assessment.mileage).toBe(128000);
    const bad = fake("oops");
    await expect(readModel(NOTES, { client: bad.client, env, log: () => {}, sleep: async () => {} })).rejects.toThrow(ReadError);
    expect(bad.sent).toHaveLength(2);
  });
  it("needs a model server, and some text", async () => {
    await expect(readModel(NOTES, { env: {} as NodeJS.ProcessEnv })).rejects.toThrow(/PARSER_BASE_URL/);
    await expect(readModel("  ", { env })).rejects.toThrow(/empty/);
  });
});
