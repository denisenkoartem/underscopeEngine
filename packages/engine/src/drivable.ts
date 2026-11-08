// Drivable scorer: look up runs_drives, then apply severe_code_modifier ONCE when any severe
// cause holds (a severe_when code-set combination on confirmed codes, or frame/airbag "yes"),
// and clamp each score to [-1, 1].

import type { EngineConfig } from "./config.js";
import type { NormalizedRecord } from "./input.js";
import type { ScoreResult } from "./types.js";

const clamp = (x: number): number => Math.min(1, Math.max(-1, x));
/** Drop float noise such as 0.30000000000000004 from added scores. */
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Codes of the record in `set` with the given status filter. */
function codesIn(record: NormalizedRecord, set: string[], confirmedOnly: boolean): string[] {
  return record.codes
    .filter((c) => set.includes(c.code) && (!confirmedOnly || c.status === "confirmed"))
    .map((c) => c.code);
}

/**
 * Human-readable list of the severe causes that hold, e.g.
 * ["MISFIRE+CATALYST confirmed (P0301, P0420)", "frame: yes"]. Pending and history codes never count.
 */
export function severeCauses(record: NormalizedRecord, config: EngineConfig): string[] {
  const { sets, severe_when } = config.codesets;
  const causes: string[] = [];
  for (const entry of severe_when) {
    const hits = entry.map((name) => codesIn(record, sets[name] ?? [], true));
    if (hits.every((h) => h.length > 0)) causes.push(`${entry.join("+")} confirmed (${hits.flat().join(", ")})`);
  }
  if (record.flags.frame === "yes") causes.push("frame: yes");
  if (record.flags.airbag === "yes") causes.push("airbag: yes");
  return causes;
}

export function scoreDrivable(record: NormalizedRecord, config: EngineConfig): ScoreResult {
  const table = config.scoring.drivable;
  const row = table[record.runs_drives];
  let acv = row.acv;
  let copart = row.copart;
  const missing = record.missing.includes("runs_drives") ? " (missing)" : "";
  const factors = [`Run status: ${record.runs_drives}${missing}`];

  const causes = severeCauses(record, config);
  if (causes.length > 0) {
    const mod = table.severe_code_modifier;
    const rawAcv = acv + mod.acv;
    const rawCopart = copart + mod.copart;
    acv = tidy(clamp(rawAcv));
    copart = tidy(clamp(rawCopart));
    const clamped = acv !== tidy(rawAcv) || copart !== tidy(rawCopart) ? ", clamped to [-1, 1]" : "";
    factors.push(`Severe: ${causes.join("; ")} -> modifier applied once${clamped}`);
  }

  // Codes from severe sets that did not count because they are not confirmed.
  const allSevereCodes = new Set(config.codesets.severe_when.flat().flatMap((n) => config.codesets.sets[n] ?? []));
  const ignored = record.codes.filter((c) => c.status !== "confirmed" && allSevereCodes.has(c.code));
  if (ignored.length > 0) {
    factors.push(`Not counted (not confirmed): ${ignored.map((c) => `${c.code} ${c.status}`).join(", ")}`);
  }
  if (!record.codes_provided) factors.push("No scan codes provided");

  return { acv, copart, confidence: row.confidence ?? 1, factors, excluded: [], source: "input" };
}
