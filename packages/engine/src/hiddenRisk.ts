// Hidden-risk scorer: count the flags still "unknown"/"suspected" and look the count up.
// A flag set to "yes" is a disclosed problem, not a hidden one, so it never counts here
// (frame/airbag "yes" are handled by drivable's severe modifier instead).

import type { EngineConfig } from "./config.js";
import type { NormalizedRecord } from "./input.js";
import { FLAG_NAMES, type FlagName, type ScoreResult } from "./types.js";

/** Flags that count as hidden risk, in FLAG_NAMES (verify_first tie-break) order. */
export function countedFlags(record: NormalizedRecord, config: EngineConfig): FlagName[] {
  const { counts, count_as_risk } = config.scoring.hidden_risk;
  return FLAG_NAMES.filter((f) => counts.includes(f) && count_as_risk.includes(record.flags[f]));
}

export function scoreHiddenRisk(record: NormalizedRecord, config: EngineConfig): ScoreResult {
  const counted = countedFlags(record, config);
  const n = counted.length;
  const key = n >= 3 ? "3+" : (String(n) as "0" | "1" | "2");
  const row = config.scoring.hidden_risk.by_count[key];
  return {
    acv: row.acv,
    copart: row.copart,
    confidence: row.confidence ?? 1,
    factors: n === 0 ? ["No unresolved hidden-risk flags"] : counted.map((f) => `${f}: ${record.flags[f]}`),
    excluded: [],
    source: "input",
  };
}
