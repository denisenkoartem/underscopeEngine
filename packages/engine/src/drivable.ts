// Drivable scorer: look up runs_drives, then apply severe_code_modifier ONCE when any severe
// cause holds (a severe_when code-set combination on confirmed codes, frame/airbag "yes", or a
// reported symptom whose system is in drivable.severe_symptom_systems), and clamp each score to
// [-1, 1]. Reported symptoms are disclosed problems, so they never count as hidden risk.

import type { EngineConfig } from "./config.js";
import type { NormalizedRecord } from "./input.js";
import type { ReportedSymptom, ScoreResult, SymptomSystem } from "./types.js";

const clamp = (x: number): number => Math.min(1, Math.max(-1, x));
/** Drop float noise such as 0.30000000000000004 from added scores. */
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Codes of the record in `set` with the given status filter. */
function codesIn(record: NormalizedRecord, set: string[], confirmedOnly: boolean): string[] {
  return record.codes
    .filter((c) => set.includes(c.code) && (!confirmedOnly || c.status === "confirmed"))
    .map((c) => c.code);
}

/** Is this reported symptom's system one that makes the record severe? */
function isSevereSymptom(system: SymptomSystem, config: EngineConfig): boolean {
  return config.scoring.drivable.severe_symptom_systems.includes(system);
}

/**
 * Human-readable list of the severe causes that hold, e.g.
 * ["MISFIRE+CATALYST confirmed (P0301, P0420)", "frame: yes", "reported symptom: transmission"].
 * Pending and history codes never count. A severe symptom system is listed once, however many
 * symptoms name it; the user's words go in their own factors (scoreDrivable).
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
  const systems = new Set(record.reported_symptoms.map((x) => x.system).filter((sys) => isSevereSymptom(sys, config)));
  for (const sys of systems) causes.push(`reported symptom: ${sys}`);
  return causes;
}

/** `Reported symptom: transmission ("transmission is generating noise")`, plus a note when the system is not severe. */
function symptomFactor(symptom: ReportedSymptom, config: EngineConfig): string {
  const base = `Reported symptom: ${symptom.system} (${JSON.stringify(symptom.text)})`;
  return isSevereSymptom(symptom.system, config) ? base : `${base}, not a severe system: no modifier`;
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
  for (const symptom of record.reported_symptoms) factors.push(symptomFactor(symptom, config));

  // Codes from severe sets that did not count because they are not confirmed.
  const allSevereCodes = new Set(config.codesets.severe_when.flat().flatMap((n) => config.codesets.sets[n] ?? []));
  const ignored = record.codes.filter((c) => c.status !== "confirmed" && allSevereCodes.has(c.code));
  if (ignored.length > 0) {
    factors.push(`Not counted (not confirmed): ${ignored.map((c) => `${c.code} ${c.status}`).join(", ")}`);
  }
  if (!record.codes_provided) factors.push("No scan codes provided");

  return { acv, copart, confidence: row.confidence ?? 1, factors, excluded: [], source: "input" };
}
