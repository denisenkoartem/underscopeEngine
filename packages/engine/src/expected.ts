// Parse the ```expected block of examples/*.expected.md and compare it with a Decision.
//
//   ```expected
//   as_of_year: 2026
//   recommendation: acv            # acv | copart | none
//   confidence: clear              # clear | close_call | insufficient
//   verify_first: frame            # a flag name, "confirm title brand", or none
//   p_acv: 0.7427                  # optional; compared with tolerance 0.005
//   ```

import { CONFIRM_TITLE } from "./combine.js";
import { InputError } from "./input.js";
import { FLAG_NAMES, OPTIONS, type Confidence, type Decision, type Option } from "./types.js";

export const P_TOLERANCE = 0.005;
const CONFIDENCES: Confidence[] = ["clear", "close_call", "insufficient"];

export interface ExpectedOutcome {
  as_of_year: number;
  recommendation: Option | null;
  confidence: Confidence;
  verify_first: string | null;
  p_acv?: number;
  p_copart?: number;
}

export function parseExpected(markdown: string, source = "expected.md"): ExpectedOutcome {
  const block = /^```expected[ \t]*\r?\n([\s\S]*?)^```/m.exec(markdown);
  if (!block) throw new InputError(`${source}: no \`\`\`expected block`);
  const fail = (msg: string): never => {
    throw new InputError(`${source}: ${msg}`);
  };

  const kv = new Map<string, string>();
  for (const raw of (block[1] ?? "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim(); // drop "# comments"
    if (line === "") continue;
    const m = /^([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return fail(`cannot parse line: ${raw.trim()}`);
    kv.set(m[1]!, m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }

  const take = (key: string): string => {
    const v = kv.get(key);
    kv.delete(key);
    return v ?? fail(`missing "${key}"`);
  };
  const prob = (key: string): number | undefined => {
    if (!kv.has(key)) return undefined;
    const p = Number(take(key));
    return Number.isFinite(p) && p >= 0 && p <= 1 ? p : fail(`${key} must be a number in [0, 1]`);
  };

  const year = Number(take("as_of_year"));
  if (!Number.isInteger(year)) fail("as_of_year must be an integer year");
  const rec = take("recommendation");
  if (rec !== "none" && !(OPTIONS as readonly string[]).includes(rec)) fail(`recommendation must be acv, copart or none`);
  const confidence = take("confidence");
  if (!(CONFIDENCES as string[]).includes(confidence)) fail(`confidence must be one of ${CONFIDENCES.join(", ")}`);
  const verify = take("verify_first");
  if (verify !== "none" && verify !== CONFIRM_TITLE && !(FLAG_NAMES as readonly string[]).includes(verify)) {
    fail(`verify_first must be a flag name, "${CONFIRM_TITLE}" or none`);
  }
  const out: ExpectedOutcome = {
    as_of_year: year,
    recommendation: rec === "none" ? null : (rec as Option),
    confidence: confidence as Confidence,
    verify_first: verify === "none" ? null : verify,
  };
  const p_acv = prob("p_acv");
  const p_copart = prob("p_copart");
  if (p_acv !== undefined) out.p_acv = p_acv;
  if (p_copart !== undefined) out.p_copart = p_copart;
  if (kv.size > 0) fail(`unknown key(s): ${[...kv.keys()].join(", ")}`);
  return out;
}

/** Human-readable mismatches between the expectation and a Decision; [] when it matches. */
export function compareDecision(expected: ExpectedOutcome, d: Decision): string[] {
  const show = (v: string | null) => v ?? "none";
  const out: string[] = [];
  if (expected.recommendation !== d.recommendation) {
    out.push(`recommendation: expected ${show(expected.recommendation)}, got ${show(d.recommendation)}`);
  }
  if (expected.confidence !== d.confidence) out.push(`confidence: expected ${expected.confidence}, got ${d.confidence}`);
  if (expected.verify_first !== d.verify_first) {
    out.push(`verify_first: expected ${show(expected.verify_first)}, got ${show(d.verify_first)}`);
  }
  for (const o of OPTIONS) {
    const want = o === "acv" ? expected.p_acv : expected.p_copart;
    if (want !== undefined && Math.abs(want - d.probabilities[o]) > P_TOLERANCE) {
      out.push(`p_${o}: expected ${want} ± ${P_TOLERANCE}, got ${d.probabilities[o]}`);
    }
  }
  return out;
}
