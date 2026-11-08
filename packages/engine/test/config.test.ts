// config.ts: fallback-rule validation at load time, the RULES.md lookup, and BOM-tolerant JSON.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG_DIR,
  PACKAGE_ROOT,
  fallbackRuleProblem,
  findRulesMd,
  loadConfig,
  parseScoring,
} from "../src/config.js";

const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const shipped = loadConfig();

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "underscope-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of config/ in a temp dir, with scoring.json replaced by `scoringText` when given. */
function configDirWith(scoringText?: string): string {
  const dir = tempDir();
  for (const f of ["scoring.json", "weights.json", "codesets.json"]) copyFileSync(join(DEFAULT_CONFIG_DIR, f), join(dir, f));
  if (scoringText !== undefined) writeFileSync(join(dir, "scoring.json"), scoringText);
  return dir;
}

/** The shipped scoring.json with market_fit_fallback replaced. */
function scoringWithFallback(table: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(shipped.scoring), market_fit_fallback: table };
}

const NO_RULES = { UNDERSCOPE_RULES_PATH: "none" };

describe("market_fit_fallback rules are validated at load", () => {
  it("the shipped rules pass", () => {
    for (const [name, row] of Object.entries(shipped.scoring.market_fit_fallback)) {
      if (typeof row === "object") expect(fallbackRuleProblem(row.rule), name).toBeNull();
    }
  });

  it("a misspelled variable fails for every vehicle, naming the row (not only when evaluation reaches it)", () => {
    const table = structuredClone(shipped.scoring.market_fit_fallback) as Record<string, unknown>;
    table.old_or_high = { rule: "age_years > 10 or odometr > 150000", acv: -0.5, copart: 0.5 };
    const bad = scoringWithFallback(table);
    expect(() => parseScoring(bad)).toThrow(ConfigError);
    expect(() => parseScoring(bad)).toThrow(
      /market_fit_fallback\.old_or_high\.rule: unknown variable "odometr" \(allowed: age_years, odometer\)/,
    );
    // Through loadConfig (readJson) as well.
    const dir = configDirWith(JSON.stringify(bad));
    expect(() => loadConfig(dir, NO_RULES)).toThrow(ConfigError);
    expect(() => loadConfig(dir, NO_RULES)).toThrow(/old_or_high\.rule: unknown variable "odometr"/);
  });

  it("an unparseable comparison fails", () => {
    expect(fallbackRuleProblem("age_years >> 10")).toMatch(/^cannot parse "age_years >> 10"/);
    expect(fallbackRuleProblem("age_years <= 6 and")).toMatch(/cannot parse/);
    expect(fallbackRuleProblem("")).toMatch(/cannot parse/);
    expect(fallbackRuleProblem("Age_years > 1")).toMatch(/unknown variable "Age_years"/); // names are case-sensitive
    const table = { ...structuredClone(shipped.scoring.market_fit_fallback), mid: { rule: "age_years >> 10", acv: 0, copart: 0 } };
    expect(() => parseScoring(scoringWithFallback(table))).toThrow(/market_fit_fallback\.mid\.rule: cannot parse/);
  });

  it("needs exactly one 'otherwise' row", () => {
    const none = {
      late: { rule: "age_years <= 6", acv: 0.8, copart: 0 },
      old: { rule: "age_years > 10", acv: -0.5, copart: 0.5 },
      confidence: 0.4,
    };
    expect(() => parseScoring(scoringWithFallback(none))).toThrow(/exactly one row with rule "otherwise", found 0/);
    const two = { ...none, a: { rule: "otherwise", acv: 0, copart: 0 }, b: { rule: " otherwise ", acv: 0, copart: 0 } };
    expect(() => parseScoring(scoringWithFallback(two))).toThrow(/found 2/);
    const one = { ...none, a: { rule: "otherwise", acv: 0, copart: 0 } };
    expect(() => parseScoring(scoringWithFallback(one))).not.toThrow();
  });
});

describe("findRulesMd", () => {
  it("finds the repo-root RULES.md from packages/engine", () => {
    expect(findRulesMd({})).toBe(join(REPO_ROOT, "RULES.md"));
  });

  it("never looks above the repo root (first directory with pnpm-workspace.yaml or .git)", () => {
    // <t>/RULES.md is a stray file in an enclosing directory; <t>/outer/repo is the repo.
    const t = tempDir();
    const repo = join(t, "outer", "repo");
    const pkg = join(repo, "packages", "engine");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(t, "RULES.md"), "```yaml codesets\nMISFIRE: [P9999]\n```\n");
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    expect(findRulesMd({}, pkg)).toBeNull();

    writeFileSync(join(repo, "RULES.md"), "x");
    expect(findRulesMd({}, pkg)).toBe(join(repo, "RULES.md"));
    // packages/engine/rules/rules.md (the spec's location) comes first.
    mkdirSync(join(pkg, "rules"));
    writeFileSync(join(pkg, "rules", "rules.md"), "x");
    expect(findRulesMd({}, pkg)).toBe(join(pkg, "rules", "rules.md"));
  });

  it("a .git directory also marks the repo root", () => {
    const t = tempDir();
    const pkg = join(t, "repo", "packages", "engine");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(t, "repo", ".git"));
    writeFileSync(join(t, "RULES.md"), "x");
    expect(findRulesMd({}, pkg)).toBeNull();
  });

  it("without any repo root, only the package directory is searched", () => {
    const t = tempDir();
    const pkg = join(t, "a", "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(t, "RULES.md"), "x");
    expect(findRulesMd({}, pkg)).toBeNull();
    writeFileSync(join(pkg, "RULES.md"), "x");
    expect(findRulesMd({}, pkg)).toBe(join(pkg, "RULES.md"));
  });

  it("UNDERSCOPE_RULES_PATH: absolute, relative to INIT_CWD (where pnpm ran), 'none', or an error", () => {
    const t = tempDir();
    const file = join(t, "MY_RULES.md");
    writeFileSync(file, "x");
    expect(findRulesMd({ UNDERSCOPE_RULES_PATH: file })).toBe(file);
    // pnpm runs the script in packages/engine; a relative path is the user's, so INIT_CWD comes first.
    expect(findRulesMd({ UNDERSCOPE_RULES_PATH: "RULES.md", INIT_CWD: REPO_ROOT })).toBe(join(REPO_ROOT, "RULES.md"));
    expect(findRulesMd({ UNDERSCOPE_RULES_PATH: "MY_RULES.md", INIT_CWD: t })).toBe(file);
    expect(findRulesMd({ UNDERSCOPE_RULES_PATH: "none" })).toBeNull();
    expect(findRulesMd({ UNDERSCOPE_RULES_PATH: "" })).toBeNull();
    expect(() => findRulesMd({ UNDERSCOPE_RULES_PATH: "NOPE.md", INIT_CWD: t })).toThrow(ConfigError);
    expect(() => findRulesMd({ UNDERSCOPE_RULES_PATH: "NOPE.md", INIT_CWD: t })).toThrow(/missing file: NOPE\.md/);
  });

  it("loadConfig reads the code sets from the RULES.md the override names", () => {
    const t = tempDir();
    const rules = join(t, "RULES.md");
    writeFileSync(rules, "# rules\n\n```yaml codesets\nMISFIRE: [P0300, p0399]  # test\n```\n");
    const c = loadConfig(DEFAULT_CONFIG_DIR, { UNDERSCOPE_RULES_PATH: "RULES.md", INIT_CWD: t });
    expect(c.codesets.rules_md_path).toBe(rules);
    expect(c.codesets.sets.MISFIRE).toEqual(["P0300", "P0399"]);
    expect(c.codesets.set_sources.CATALYST).toBe("config/codesets.json");
  });
});

describe("JSON with a UTF-8 byte-order mark", () => {
  it("config files saved with a BOM still load", () => {
    const text = readFileSync(join(DEFAULT_CONFIG_DIR, "scoring.json"), "utf8");
    const dir = configDirWith(`﻿${text}`);
    expect(loadConfig(dir, NO_RULES).scoring).toEqual(loadConfig(DEFAULT_CONFIG_DIR, NO_RULES).scoring);
  });
});
