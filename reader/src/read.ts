// The reader's one entry point and its one decision maker: read(text) -> the assessment JSON.
//
// Two things can read a description: the keyword rules (rules.ts; free, instant, always run) and the
// trained model (model.ts; runs when a model server is configured). They never answer side by side.
// merge() below is the only place that decides what the output says when both have read the text:
//
//   1. A field only one of them read: that value.
//   2. Both read it the same: that value.
//   3. They differ on a risk flag: the worse value (true).
//   4. They differ on a part grade: the costlier grade (replace > repairable > fine).
//   5. They differ on anything else: PRIMARY's value.
//   Lists (codes, warning lights, symptoms) are joined.
//
// Every difference in 3-5 is recorded in `conflicts` and asked back in `questions`, so nothing is
// overridden silently. Evidence always belongs to the value that was kept.

import { FLAGS, PARTS, listMissing, type Assessment, type GradeName } from "./contract.js";
import { FIELDS, ReadError, readModel, type Issue, type ReadOptions } from "./model.js";
import { readRules } from "./rules.js";

/**
 * Who wins when the rules and the model give different values for a plain field. The rules, until the
 * model comparison (reader/model/README.md) shows a trained model reads better; then change it here.
 */
export const PRIMARY: "rules" | "model" = "rules";

const GRADE_RANK: Record<GradeName, number> = { unknown: -1, fine: 0, repairable: 1, replace: 2 };
const isUnknown = (v: unknown): boolean => v === null || v === undefined || v === "unknown" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const get = (a: Assessment, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], a);
function set(a: Assessment, path: string, value: unknown): void {
  const [head, leaf] = path.split(".") as [string, string | undefined];
  if (leaf) ((a as Record<string, unknown>)[head] as Record<string, unknown>)[leaf] = value;
  else (a as Record<string, unknown>)[head] = value;
}
const label = (path: string) => path.replace(/^(values|vehicle|flags|grades)\./, "").replace(/_/g, " ");
const text = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v).replace(/_/g, " "));

/** One assessment from the two readings. `primary` wins plain disagreements (rule 5 above). */
export function merge(rules: Assessment, model: Assessment, primary: "rules" | "model" = PRIMARY): Assessment {
  const first = primary === "rules" ? rules : model;
  const second = primary === "rules" ? model : rules;
  const out: Assessment = structuredClone(first);
  out.reader = "rules+model";
  out.conflicts = [];
  const asked: string[] = [];
  const conflict = (field: string, kept: unknown, dropped: unknown) => {
    out.conflicts.push({ field, kept, dropped });
    asked.push(`The description can be read two ways for ${label(field)}: ${text(kept)} or ${text(dropped)}. Which is it?`);
  };
  const take = (path: string, evidencePath = path) => {
    set(out, path, structuredClone(get(second, path)));
    if (second.evidence[evidencePath] !== undefined) out.evidence[evidencePath] = second.evidence[evidencePath]!;
    else delete out.evidence[evidencePath];
  };

  for (const { path } of FIELDS) {
    const a = get(first, path), b = get(second, path);
    if (isUnknown(b) || same(a, b)) continue;
    if (isUnknown(a)) take(path);
    else conflict(path, a, b);
  }
  for (const name of FLAGS) {
    const path = `flags.${name}`, a = first.flags[name], b = second.flags[name];
    if (b === "unknown" || a === b) continue;
    if (a === "unknown") take(path);
    else {
      if (b === true) take(path);
      conflict(path, true, false);
    }
  }
  // Part grades. "Everything else is fine" from either reader fills its untouched parts, so a part one
  // reader graded and the other only swept up as "fine" keeps the explicit grade.
  const explicit = (r: Assessment, part: string) => r.evidence[`grades.${part}`] !== undefined;
  out.grades = PARTS.map((part, i) => {
    const a = first.grades[i]!.grade, b = second.grades[i]!.grade;
    const ea = explicit(first, part), eb = explicit(second, part);
    let from = first;
    if (a === "unknown" || (!ea && eb)) from = b === "unknown" ? first : second;
    else if (ea && eb && a !== b) {
      if (GRADE_RANK[b] > GRADE_RANK[a]) from = second;
      conflict(`grades.${part}`, from === first ? a : b, from === first ? b : a);
    }
    if (from === second) {
      if (eb) out.evidence[`grades.${part}`] = second.evidence[`grades.${part}`]!;
      else delete out.evidence[`grades.${part}`];
    }
    return { part, grade: from === second ? b : a };
  });
  if (out.evidence["grades.rest"] === undefined && second.evidence["grades.rest"] !== undefined) out.evidence["grades.rest"] = second.evidence["grades.rest"]!;

  for (const c of second.codes) {
    const mine = out.codes.find((x) => x.code === c.code);
    if (!mine) {
      out.codes.push({ ...c });
      out.evidence[`codes.${c.code}`] = second.evidence[`codes.${c.code}`] ?? c.code;
    } else if (mine.status !== c.status) conflict(`codes.${c.code}`, mine.status, c.status);
  }
  for (const light of second.warning_lights) {
    if (out.warning_lights.includes(light)) continue;
    out.warning_lights.push(light);
    if (second.evidence[`warning_lights.${light}`] !== undefined) out.evidence[`warning_lights.${light}`] = second.evidence[`warning_lights.${light}`]!;
  }
  // The same complaint read twice (one text inside the other) is listed once.
  const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const s of second.symptoms) {
    if (!out.symptoms.some((x) => flat(x.text).includes(flat(s.text)) || flat(s.text).includes(flat(x.text)))) out.symptoms.push({ ...s });
  }
  // Unread sentences: the rules list whole sentences, the model short notes. Keep the rules' list when
  // there is one (it is the seller's own words), minus sentences the model did read a value from.
  const quoted = Object.values(model.evidence).map(flat);
  out.additional = rules.additional.filter((s) => !quoted.some((q) => q !== "" && flat(s).includes(q)));
  if (out.additional.length === 0 && rules.additional.length === 0) out.additional = [...model.additional];
  out.questions = [...new Set([...rules.questions, ...model.questions, ...asked])];
  listMissing(out);
  return out;
}

export interface ReadResult {
  assessment: Assessment;
  /** What the checks removed from the model's answer (empty without a model). */
  issues: Issue[];
  /** Set when a model server is configured but gave no usable answer; the assessment is then the rules' reading. */
  model_error: string | null;
}

export interface ReadTextOptions extends ReadOptions {
  /**
   * "auto" (default): use the model when PARSER_BASE_URL is set (or a client is passed), and fall back to
   * the rules alone if it fails. "off": rules only (what the page does as the seller types).
   * "required": fail when the model gives no answer.
   */
  model?: "auto" | "off" | "required";
}

/** A seller's description -> the assessment JSON. The only function callers need. */
export async function read(text: string, opts: ReadTextOptions = {}): Promise<ReadResult> {
  const rules = readRules(text);
  const env = opts.env ?? process.env;
  const mode = opts.model ?? "auto";
  const configured = opts.client !== undefined || !!env.PARSER_BASE_URL?.trim();
  if (mode === "off" || (mode === "auto" && !configured) || text.trim() === "") return { assessment: rules, issues: [], model_error: null };
  try {
    const m = await readModel(text, opts);
    return { assessment: merge(rules, m.assessment), issues: m.issues, model_error: null };
  } catch (e) {
    if (!(e instanceof ReadError) || mode === "required") throw e;
    return { assessment: rules, issues: [], model_error: e.message };
  }
}
