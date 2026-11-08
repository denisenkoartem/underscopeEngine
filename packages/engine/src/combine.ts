// Combiner: four category scores -> exclusions -> weighted utility -> softmax -> Decision.
//
// TODO(v2): repair costs and the fix-then-sell option plug in here.
//  - Repair cost is a new CATEGORY. That is generic already: add it to CATEGORIES (types.ts),
//    score it in scoreCategories() below with a scorer next to the other four, and give it a
//    weight in config/weights.json (the weights schema is built from CATEGORIES).
//  - Fix-then-sell is a new OPTION, and the option side is still two-way. It needs:
//      * OPTIONS (types.ts) and OPTION_LABEL (below);
//      * Decision.probabilities (types.ts), today {acv, copart};
//      * an n-way softmax() and an argmax recommendation in evaluate() (both read acv/copart);
//      * the 1-eligible probabilities map in evaluate() and reportedProbabilities(), which
//        rounds ACV and derives Copart as 1 - ACV;
//      * otherOption() and the single "loser" in buildReasons()/buildRisks() (explain.ts);
//      * a column in every scoring.json row, plus the Row/TitleRow/severe_code_modifier
//        schemas in config.ts (zod drops an unknown third key silently);
//      * the option columns of the explain table (renderExplainTable in explain.ts).

import type { EngineConfig } from "./config.js";
import { scoreDrivable } from "./drivable.js";
import { buildReasons, buildRisks } from "./explain.js";
import { countedFlags, scoreHiddenRisk } from "./hiddenRisk.js";
import { withFlag, withTitleBrand, type NormalizedRecord } from "./input.js";
import { scoreMarketFit, type MarketFitOptions } from "./marketFit.js";
import { scoreTitle } from "./title.js";
import {
  CATEGORIES,
  OPTIONS,
  type Category,
  type CategoryScore,
  type Confidence,
  type Decision,
  type MarketFitResult,
  type Option,
  type ScoreResult,
} from "./types.js";

export const OPTION_LABEL: Record<Option, string> = { acv: "ACV", copart: "Copart" };
export const CONFIRM_TITLE = "confirm title brand";
/** Movements and ties smaller than this are treated as zero / equal. */
const EPS = 1e-9;

type Scored = { acv: number; copart: number; confidence: number };

/** Contribution of one category to one option: weight x score x confidence. */
export function contribution(config: EngineConfig, category: Category, score: Scored, option: Option): number {
  return config.weights.weights[category] * score[option] * score.confidence;
}

/** utility(option) = sum of the category contributions. */
export function utility(config: EngineConfig, scores: Record<Category, Scored>, option: Option): number {
  return CATEGORIES.reduce((sum, c) => sum + contribution(config, c, scores[c], option), 0);
}

/** softmax(u / temperature) over both options (max-shifted for numerical safety). */
export function softmax(u: Record<Option, number>, temperature: number): Record<Option, number> {
  const max = Math.max(u.acv, u.copart);
  const e = { acv: Math.exp((u.acv - max) / temperature), copart: Math.exp((u.copart - max) / temperature) };
  const sum = e.acv + e.copart;
  return { acv: e.acv / sum, copart: e.copart / sum };
}

export const otherOption = (o: Option): Option => (o === "acv" ? "copart" : "acv");

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Probabilities as the Decision reports them: ACV rounded to 4 decimals, Copart = 1 - ACV (so they sum to 1). */
export function reportedProbabilities(p: Record<Option, number>): Record<Option, number> {
  if (p.acv + p.copart === 0) return { acv: 0, copart: 0 };
  const acv = round4(p.acv);
  return { acv, copart: round4(1 - acv) };
}

export function scoreCategories(
  record: NormalizedRecord,
  config: EngineConfig,
  market: MarketFitResult,
): Record<Category, ScoreResult> {
  return {
    title: scoreTitle(record, config),
    drivable: scoreDrivable(record, config),
    hidden_risk: scoreHiddenRisk(record, config),
    market_fit: market,
  };
}

/** One scoring pass without verify_first (also what verify_first re-runs). */
interface Evaluation {
  scores: Record<Category, ScoreResult>;
  excluded: { option: Option; reason: string }[];
  /** Unrounded. */
  probabilities: Record<Option, number>;
  recommendation: Option | null;
  confidence: Confidence;
}

function evaluate(record: NormalizedRecord, config: EngineConfig, market: MarketFitResult): Evaluation {
  const scores = scoreCategories(record, config, market);

  const why = new Map<Option, string[]>();
  const exclude = (o: Option, reason: string) => why.set(o, [...(why.get(o) ?? []), reason]);
  for (const c of CATEGORIES) {
    for (const o of scores[c].excluded) exclude(o, `${scores[c].exclusion_reason ?? "excluded"} (${c})`);
  }
  for (const o of OPTIONS) if (!record.lanes_allowed.includes(o)) exclude(o, "not in seller.lanes_allowed");
  const excluded = OPTIONS.filter((o) => why.has(o)).map((o) => ({ option: o, reason: why.get(o)!.join("; ") }));
  const eligible = OPTIONS.filter((o) => !why.has(o));

  const [only] = eligible;
  if (only === undefined) {
    return { scores, excluded, probabilities: { acv: 0, copart: 0 }, recommendation: null, confidence: "insufficient" };
  }
  if (eligible.length === 1) {
    const probabilities = { acv: only === "acv" ? 1 : 0, copart: only === "copart" ? 1 : 0 };
    return { scores, excluded, probabilities, recommendation: only, confidence: "clear" };
  }
  const u = { acv: utility(config, scores, "acv"), copart: utility(config, scores, "copart") };
  const p = softmax(u, config.weights.temperature);
  const recommendation: Option = p.acv >= p.copart ? "acv" : "copart";
  // Threshold on the probability the Decision reports (4 decimals), so it never shows 0.7000
  // next to "close_call". verify_first movements still use the unrounded p.
  const shown = reportedProbabilities(p)[recommendation];
  const confidence = shown >= config.weights.clear_threshold ? "clear" : "close_call";
  return { scores, excluded, probabilities: p, recommendation, confidence };
}

/**
 * The counted hidden-risk flag whose resolution (to "no" or "yes") moves the recommended
 * option's probability most; ties go to the earlier flag in FLAG_NAMES. null when nothing moves.
 * Re-runs use evaluate() on the given record (same title brand, never the unknown-title
 * branching), so `base` must be that same record's evaluate() result.
 */
function verifyFirst(
  record: NormalizedRecord,
  config: EngineConfig,
  market: MarketFitResult,
  base: Evaluation,
): string | null {
  const top = base.recommendation;
  if (top === null) return null;
  let best: string | null = null;
  let bestMove = 0;
  for (const flag of countedFlags(record, config)) {
    const move = Math.max(
      ...(["no", "yes"] as const).map((v) =>
        Math.abs(evaluate(withFlag(record, flag, v), config, market).probabilities[top] - base.probabilities[top]),
      ),
    );
    // Must be more than EPS ahead of the current best, so an earlier flag keeps a tie.
    if (move >= EPS && (best === null || move > bestMove + EPS)) {
      best = flag;
      bestMove = move;
    }
  }
  return best;
}

function assemble(
  record: NormalizedRecord,
  config: EngineConfig,
  market: MarketFitResult,
  ev: Evaluation,
  verify_first: string | null,
  titleNote?: string,
): Decision {
  const category_scores = {} as Record<Category, CategoryScore>;
  for (const c of CATEGORIES) {
    const s = ev.scores[c];
    category_scores[c] = { acv: s.acv, copart: s.copart, confidence: s.confidence, factors: [...s.factors], source: s.source };
  }
  if (titleNote) category_scores.title.factors.unshift(titleNote);

  const probabilities = reportedProbabilities(ev.probabilities);

  const decision: Decision = {
    recommendation: ev.recommendation,
    probabilities,
    confidence: ev.confidence,
    verify_first,
    category_scores,
    reasons: [],
    risks: [],
    market_signals: [...market.signals],
    weights_version: config.weights.version,
    excluded: ev.excluded,
  };
  decision.reasons = buildReasons(decision, config);
  decision.risks = buildRisks(
    decision,
    config,
    countedFlags(record, config).map((flag) => ({ flag, value: record.flags[flag] })),
  );
  return decision;
}

/** Pure and synchronous: the whole decision given an already-computed market-fit result. */
export function decideWithMarket(record: NormalizedRecord, config: EngineConfig, market: MarketFitResult): Decision {
  const base = evaluate(record, config, market);
  if (record.title.brand === "unknown") return decideUnknownTitle(record, config, market, base);
  return assemble(record, config, market, base, verifyFirst(record, config, market, base));
}

/**
 * Unknown title (DESIGN.md, round-2 user decision):
 *  1. BASE = the normal pass on the record as-is, so the title category is scoring.json's
 *     title.unknown row (0 / 0, confidence 0.3), with its own probabilities, confidence and
 *     verify_first.
 *  2. The clean and salvage branches are scored with the same market result (no extra API call).
 *  3. Branches agree -> report BASE. Branches disagree -> report the clean branch with
 *     confidence "close_call" and verify_first "confirm title brand".
 *  4. Insufficient override (unknown title AND 3+ counted hidden-risk flags) on whichever is reported.
 * Only the branches' recommendations are compared, so their own verify_first is never computed.
 */
function decideUnknownTitle(
  record: NormalizedRecord,
  config: EngineConfig,
  market: MarketFitResult,
  base: Evaluation,
): Decision {
  const clean = withTitleBrand(record, "clean");
  const evClean = evaluate(clean, config, market);
  const evSalvage = evaluate(withTitleBrand(record, "salvage"), config, market);
  const agree = evClean.recommendation === evSalvage.recommendation;

  // BASE's verify_first rescoring goes through verifyFirst() -> evaluate(), the single
  // non-branching pass: each flag variant keeps the title "unknown" (withFlag never touches the
  // brand) and is NOT re-branched into clean/salvage. So "top probability" means the same thing
  // in the unmodified and the modified runs: P(BASE's recommendation) from the unknown-title
  // row. Re-branching each variant would sometimes swap in the clean branch's probability
  // (whenever that variant's branches disagree) and compare numbers from different runs.
  const reported: { record: NormalizedRecord; ev: Evaluation; verify: string | null } = agree
    ? { record, ev: base, verify: verifyFirst(record, config, market, base) }
    : { record: clean, ev: { ...evClean, confidence: "close_call" }, verify: CONFIRM_TITLE };

  // Insufficient override: unknown title plus 3+ unresolved hidden-risk flags.
  const confidence: Confidence = countedFlags(record, config).length >= 3 ? "insufficient" : reported.ev.confidence;
  const show = (o: Option | null) => o ?? "none";
  const note =
    `Title brand unknown: clean branch -> ${show(evClean.recommendation)}, ` +
    `salvage branch -> ${show(evSalvage.recommendation)}; ` +
    (agree ? "branches agree, reported the unknown-title run" : "reported the clean branch");
  return assemble(reported.record, config, market, { ...reported.ev, confidence }, reported.verify, note);
}

/** Score market fit once (API, cache or fallback), then decide. */
export async function decide(record: NormalizedRecord, config: EngineConfig, opts: MarketFitOptions = {}): Promise<Decision> {
  const market = await scoreMarketFit(record, config, opts);
  return decideWithMarket(record, config, market);
}
