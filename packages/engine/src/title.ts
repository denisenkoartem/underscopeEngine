// Title scorer: a straight lookup of title.brand in scoring.json. A value of "excluded"
// rules that option out entirely (its numeric score is reported as 0).

import type { EngineConfig } from "./config.js";
import type { NormalizedRecord } from "./input.js";
import { OPTIONS, type Option, type ScoreResult } from "./types.js";

export function scoreTitle(record: NormalizedRecord, config: EngineConfig): ScoreResult {
  const brand = record.title.brand;
  const row = config.scoring.title[brand];
  const excluded: Option[] = OPTIONS.filter((o) => row[o] === "excluded");
  const score = (o: Option): number => {
    const v = row[o];
    return v === "excluded" ? 0 : v;
  };

  const missing = brand === "unknown" && record.missing.includes("title.brand") ? " (missing)" : "";
  const factors = [`Title brand: ${brand}${missing}`];
  if (record.title.state) factors.push(`Title state: ${record.title.state}`);

  return {
    acv: score("acv"),
    copart: score("copart"),
    confidence: row.confidence ?? 1,
    factors,
    excluded,
    // Short noun phrase; the combiner renders it as e.g. "ACV excluded: salvage title (title)".
    ...(excluded.length > 0 ? { exclusion_reason: `${brand} title` } : {}),
    source: "input",
  };
}
