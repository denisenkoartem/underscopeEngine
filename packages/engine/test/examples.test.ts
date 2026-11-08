// Every examples/*.json must match its .expected.md with market fit offline (fallback table).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/combine.js";
import { PACKAGE_ROOT, loadConfig } from "../src/config.js";
import { compareDecision, parseExpected } from "../src/expected.js";
import { normalizeRecord } from "../src/input.js";
import type { Decision } from "../src/types.js";

const DIR = join(PACKAGE_ROOT, "examples");
const config = loadConfig();
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

describe("examples/", () => {
  it("has the six examples, each with an expected.md", () => {
    const stems = files.map((f) => f.replace(/\.json$/, ""));
    expect(stems).toEqual(
      expect.arrayContaining([
        "01_salvage_no_run",
        "02_clean_runs_2022_40k",
        "03_clean_misfire_cat_frame_unknown",
        "04_nonrepairable",
        "05_clean_no_run_2012_190k",
        "06_title_unknown",
      ]),
    );
    for (const s of stems) expect(existsSync(join(DIR, `${s}.expected.md`)), `${s}.expected.md`).toBe(true);
  });

  it.each(files)("%s matches its expected.md offline", async (file) => {
    const stem = file.replace(/\.json$/, "");
    const expected = parseExpected(readFileSync(join(DIR, `${stem}.expected.md`), "utf8"), stem);
    const record = normalizeRecord(JSON.parse(readFileSync(join(DIR, file), "utf8")));
    const decision = await decide(record, config, { offline: true, asOfYear: expected.as_of_year });
    expect(compareDecision(expected, decision)).toEqual([]);
    expect(decision.reasons).toHaveLength(3);
    expect(decision.risks).toHaveLength(2);
  });
});

describe("expected.md parsing", () => {
  const md = (body: string) => `# Title\n\nwhy...\n\n\`\`\`expected\n${body}\n\`\`\`\n`;
  const decision = {
    recommendation: "acv",
    probabilities: { acv: 0.7427, copart: 0.2573 },
    confidence: "clear",
    verify_first: "frame",
  } as Decision;

  it("parses values, comments, quotes and none", () => {
    const e = parseExpected(
      md(`as_of_year: 2026\nrecommendation: none   # acv | copart | none\nconfidence: insufficient\nverify_first: "confirm title brand"\np_acv: 0.5`),
    );
    expect(e).toEqual({
      as_of_year: 2026,
      recommendation: null,
      confidence: "insufficient",
      verify_first: "confirm title brand",
      p_acv: 0.5,
    });
  });

  it("reports each mismatching field; p_acv within 0.005", () => {
    const ok = parseExpected(md(`as_of_year: 2026\nrecommendation: acv\nconfidence: clear\nverify_first: frame\np_acv: 0.745`));
    expect(compareDecision(ok, decision)).toEqual([]);
    const bad = parseExpected(
      md(`as_of_year: 2026\nrecommendation: copart\nconfidence: close_call\nverify_first: none\np_acv: 0.75`),
    );
    expect(compareDecision(bad, decision)).toEqual([
      "recommendation: expected copart, got acv",
      "confidence: expected close_call, got clear",
      "verify_first: expected none, got frame",
      "p_acv: expected 0.75 ± 0.005, got 0.7427",
    ]);
  });

  it("rejects a missing block, missing keys, unknown keys and bad values", () => {
    expect(() => parseExpected("# no block")).toThrow(/no ```expected block/);
    expect(() => parseExpected(md("as_of_year: 2026\nrecommendation: acv\nconfidence: clear"))).toThrow(/verify_first/);
    expect(() =>
      parseExpected(md("as_of_year: 2026\nrecommendation: acv\nconfidence: clear\nverify_first: none\nfoo: 1")),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExpected(md("as_of_year: 2026\nrecommendation: acv\nconfidence: sure\nverify_first: none")),
    ).toThrow(/confidence/);
  });
});
