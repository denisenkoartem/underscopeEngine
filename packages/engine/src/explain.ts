// Human-readable explanation of a Decision: the 3 reasons, the 2 risks, and the
// contribution table printed by `pnpm engine explain`. Every number comes from the
// Decision (category scores x config weights), so the text always matches the JSON.

import { join } from "node:path";
import { CONFIRM_TITLE, OPTION_LABEL, TIE_EPS, contribution, otherOption, utility } from "./combine.js";
import { PACKAGE_ROOT, type EngineConfig } from "./config.js";
import {
  CATEGORIES,
  OPTIONS,
  type Category,
  type Decision,
  type FlagName,
  type FlagValue,
  type Option,
  type Valuation,
} from "./types.js";

export const NO_HIDDEN_RISK = "No unresolved hidden-risk flags";
/** Start of risks[0] when verify_first was picked by tie order because no single flag moves the answer. */
export const NO_SINGLE_CHECK = "No single check moves the answer";

/** "+0.350" / "-0.105" (never "-0.000"). */
function signed(x: number): string {
  const r = Math.round(x * 1000) / 1000 || 0;
  return (r >= 0 ? "+" : "") + r.toFixed(3);
}

function contrib(d: Decision, config: EngineConfig, c: Category, o: Option): number {
  return contribution(config, c, d.category_scores[c], o);
}

/** "title +0.350 for ACV: Title brand: clean" */
function categoryLine(d: Decision, config: EngineConfig, c: Category, o: Option): string {
  const factor = d.category_scores[c].factors[0] ?? "no factors";
  return `${c} ${signed(contrib(d, config, c, o))} for ${OPTION_LABEL[o]}: ${factor}`;
}

/** Categories by contribution to `o`, strongest first (ties keep CATEGORIES order). */
function byContribution(d: Decision, config: EngineConfig, o: Option): Category[] {
  return [...CATEGORIES].sort((a, b) => contrib(d, config, b, o) - contrib(d, config, a, o));
}

const exclusionLine = (e: { option: Option; reason: string }) => `${OPTION_LABEL[e.option]} excluded: ${e.reason}`;

/**
 * The shared total when both options are eligible and their utilities tie (|diff| < TIE_EPS),
 * else null. combine.ts then reports the first option (ACV) only because it comes first.
 */
export function deadHeatTotal(d: Decision, config: EngineConfig): number | null {
  if (d.recommendation === null || d.excluded.length > 0) return null;
  const [a, b] = OPTIONS.map((o) => utility(config, d.category_scores, o)) as [number, number];
  return Math.abs(a - b) < TIE_EPS ? a : null;
}

/** Exactly 3 reasons. */
export function buildReasons(d: Decision, config: EngineConfig): string[] {
  const rec = d.recommendation;
  if (rec === null) {
    // No option left: the exclusions explain it, then the categories with the largest absolute pull.
    const strongest = (c: Category): Option =>
      Math.abs(contrib(d, config, c, "copart")) > Math.abs(contrib(d, config, c, "acv")) ? "copart" : "acv";
    const size = (c: Category) => Math.abs(contrib(d, config, c, strongest(c)));
    const ordered = [...CATEGORIES].sort((a, b) => size(b) - size(a));
    return [
      `No option available: ${d.excluded.map(exclusionLine).join("; ")}`,
      ...ordered.slice(0, 2).map((c) => categoryLine(d, config, c, strongest(c))),
    ];
  }
  const lines = byContribution(d, config, rec).map((c) => categoryLine(d, config, c, rec));
  const loserExcluded = d.excluded.find((e) => e.option === otherOption(rec));
  if (loserExcluded) return [exclusionLine(loserExcluded), ...lines.slice(0, 2)];
  const tie = deadHeatTotal(d, config);
  if (tie !== null) {
    const deadHeat = `Dead heat: both options total ${signed(tie)}; ${OPTION_LABEL[rec]} is listed only because it comes first`;
    return [deadHeat, ...lines.slice(0, 2)];
  }
  return lines.slice(0, 3);
}

/** risks[0] when no counted flag moves the answer and verify_first is the first one in tie order. */
function noSingleCheckLine(counted: { flag: FlagName; value: FlagValue }[], first: string | null): string {
  const values = [...new Set(counted.map((f) => f.value))];
  const n = counted.length;
  const flags = `hidden-risk flag${n === 1 ? "" : "s"}`;
  const which =
    values.length === 1
      ? `${n} ${flags} ${values[0]} (${counted.map((f) => f.flag).join(", ")})`
      : `${n} ${flags} unresolved (${counted.map((f) => `${f.flag} ${f.value}`).join(", ")})`;
  return `${NO_SINGLE_CHECK}: ${which}; ${first ?? "none"} is verify_first only by tie order`;
}

/**
 * Exactly 2 risks. `counted` = the counted hidden-risk flags with their values. `noMove`: no
 * single flag moves the answer, so verify_first came from tie order alone (combine.ts); risks[0]
 * then says so and how many flags are open.
 */
export function buildRisks(
  d: Decision,
  config: EngineConfig,
  counted: { flag: FlagName; value: FlagValue }[],
  opts: { noMove?: boolean } = {},
): string[] {
  const unresolved =
    counted.length === 0
      ? null
      : opts.noMove
        ? noSingleCheckLine(counted, d.verify_first)
        : `Unresolved: ${counted.map((f) => `${f.flag} (${f.value})`).join(", ")}`;
  const rec = d.recommendation;
  if (rec === null) {
    const none = d.excluded.map((e) => `${OPTION_LABEL[e.option]} not available: ${e.reason}`).join("; ");
    return [unresolved ?? NO_HIDDEN_RISK, none];
  }
  const loser = otherOption(rec);
  const label = OPTION_LABEL[loser];
  const loserExcluded = d.excluded.find((e) => e.option === loser);
  if (loserExcluded) return [unresolved ?? NO_HIDDEN_RISK, `${label} not available: ${loserExcluded.reason}`];

  const [first, second] = byContribution(d, config, loser) as [Category, Category];
  const caseText = (c: Category) =>
    `${c} ${signed(contrib(d, config, c, loser))}: ${d.category_scores[c].factors[0] ?? "no factors"}`;
  // Without unresolved flags, the loser's second-best category is the next risk, if it actually favours the loser.
  const fallback = contrib(d, config, second, loser) > 0 ? `${label}'s second-strongest case: ${caseText(second)}` : NO_HIDDEN_RISK;
  // When nothing pushes toward the loser, its "strongest case" would quote a factor that argues
  // the other way (e.g. "drivable +0.000: Run status: run_and_drive" for Copart), so say so plainly.
  const strongest =
    contrib(d, config, first, loser) > 0
      ? `${label}'s strongest case: ${caseText(first)}`
      : `No category favors ${label} (its best: ${first} ${signed(contrib(d, config, first, loser))})`;
  return [unresolved ?? fallback, strongest];
}

// ---------------------------------------------------------------------------
// Contribution table (CLI `explain`)
// ---------------------------------------------------------------------------

const num = (x: number, digits = 3) => (Math.round(x * 10 ** digits) / 10 ** digits || 0).toFixed(digits);

function table(rows: string[][], rightAlign: (col: number) => boolean): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (rightAlign(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Did category `c` exclude option `o`? combine.ts words each scorer exclusion as
 * "<reason> (<category>)" and joins an option's reasons with "; "; a lanes_allowed exclusion
 * names no category.
 */
function excludedBy(d: Decision, o: Option, c: Category): boolean {
  return d.excluded.some((e) => e.option === o && e.reason.split("; ").some((r) => r.endsWith(`(${c})`)));
}

/** What the probabilities are: a softmax only when both options are eligible. */
function probabilityNote(d: Decision, config: EngineConfig): string {
  const eligible = OPTIONS.filter((o) => !d.excluded.some((e) => e.option === o));
  if (eligible.length === 0) return "no option eligible";
  if (eligible.length === 1) return `only ${OPTION_LABEL[eligible[0]!]} eligible: P = 1, softmax not used`;
  return `softmax of utility / temperature ${config.weights.temperature}`;
}

/** Which rule set the confidence (the threshold only applies when nothing overrode it). */
function confidenceNote(d: Decision, config: EngineConfig): string {
  if (d.recommendation === null) return "no option eligible";
  // verify_first is "confirm title brand" only when the title was unknown and the clean and
  // salvage branches disagreed, so the clean branch is reported with confidence forced to close_call.
  const branchesDisagree = d.verify_first === CONFIRM_TITLE;
  if (d.confidence === "insufficient") {
    // With an option recommended, only the unknown-title override gives "insufficient".
    return (
      "insufficient: title unknown and 3+ unresolved hidden-risk flags" +
      (branchesDisagree ? "; the clean and salvage title branches also disagree" : "")
    );
  }
  if (branchesDisagree) return "close_call forced: title unknown and the clean and salvage title branches disagree";
  if (d.excluded.length > 0) return "only one option eligible";
  return `clear when the top probability >= ${config.weights.clear_threshold}`;
}

const usd = (x: number): string => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The explain block for the input's prices. Display only: nothing in the decision reads them. */
export function valuationLines(v: Valuation): string[] {
  const comps = v.salvage_comps;
  const compsText =
    comps.length === 0
      ? "none"
      : `${comps.length} (min ${usd(Math.min(...comps))}, median ${usd(median(comps))}, max ${usd(Math.max(...comps))})`;
  return [
    "Valuation (shown only, not used in the decision):",
    `  Clean wholesale: ${v.clean_wholesale === null ? "not given" : usd(v.clean_wholesale)}`,
    `  Salvage comps: ${compsText}`,
    `  Purchase price: ${v.purchase_price === null ? "not given" : usd(v.purchase_price)}`,
  ];
}

export function renderExplainTable(d: Decision, config: EngineConfig): string {
  const isExcluded = (o: Option) => d.excluded.some((e) => e.option === o);
  // An excluded option keeps its numbers in the categories that did not exclude it; the excluding
  // category (whose reported score is a meaningless 0) and the total say "excluded".
  const cell = (o: Option, c: Category, x: number) => (excludedBy(d, o, c) ? "excluded" : num(x));
  const titleAssumedClean = d.verify_first === CONFIRM_TITLE;
  const rows: string[][] = [
    ["Category", "ACV score", "Copart score", "Weight", "Confidence", "ACV contrib", "Copart contrib", "Source"],
  ];
  for (const c of CATEGORIES) {
    const s = d.category_scores[c];
    rows.push([
      c,
      cell("acv", c, s.acv),
      cell("copart", c, s.copart),
      num(config.weights.weights[c], 2),
      num(s.confidence, 2),
      cell("acv", c, contrib(d, config, c, "acv")),
      cell("copart", c, contrib(d, config, c, "copart")),
      c === "title" && titleAssumedClean ? "input, assumed clean (title unknown)" : s.source,
    ]);
  }
  const total = (o: Option) => (isExcluded(o) ? "excluded" : num(utility(config, d.category_scores, o)));
  rows.push(["Total utility", "", "", "", "", total("acv"), total("copart"), ""]);

  const pct = (o: Option) => `${OPTION_LABEL[o]} ${d.probabilities[o].toFixed(4)}`;
  const { codesets } = config;
  const bySource = new Map<string, string[]>();
  for (const [name, src] of Object.entries(codesets.set_sources)) bySource.set(src, [...(bySource.get(src) ?? []), name]);
  const codeSources = [...bySource].map(([src, names]) => `${names.join(", ")} from ${src}`).join("; ");
  const severeWhen = codesets.severe_when.map((e) => e.join("+")).join(", ");

  const tie = deadHeatTotal(d, config);
  const byTieOrder = d.risks[0]?.startsWith(NO_SINGLE_CHECK) ?? false;
  const lines = [
    table(rows, (i) => i > 0 && i < 7),
    "",
    `Probabilities: ${OPTIONS.map(pct).join(", ")}  (${probabilityNote(d, config)})`,
    `Recommendation: ${d.recommendation ? OPTION_LABEL[d.recommendation] : "none"}` +
      (tie !== null ? `  (dead heat: both options total ${signed(tie)}; listed first only)` : ""),
    `Confidence: ${d.confidence}  (${confidenceNote(d, config)})`,
    `verify_first: ${d.verify_first ?? "none"}` + (byTieOrder ? "  (no single check moves the answer; first in tie order)" : ""),
    `Excluded: ${d.excluded.length ? d.excluded.map((e) => `${OPTION_LABEL[e.option]}: ${e.reason}`).join("; ") : "none"}`,
    "",
    "Factors:",
    ...CATEGORIES.map((c) => `  ${c}: ${d.category_scores[c].factors.join("; ")}`),
    "Reasons:",
    ...d.reasons.map((r, i) => `  ${i + 1}. ${r}`),
    "Risks:",
    ...d.risks.map((r, i) => `  ${i + 1}. ${r}`),
    ...(d.market_signals.length ? ["Market signals:", ...d.market_signals.map((s) => `  - ${s.claim} <${s.url}>`)] : []),
    ...(d.valuation ? valuationLines(d.valuation) : []),
    "",
    `Code sets: ${codeSources}; severe_when (${severeWhen}) from config/codesets.json`,
    `Weights version: ${d.weights_version} (${join(PACKAGE_ROOT, "config", "weights.json")})`,
  ];
  return lines.join("\n");
}
