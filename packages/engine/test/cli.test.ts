// CLI behaviour that the unit tests do not reach: file reading, .env loading, the eval summary.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDotEnv, main } from "../src/cli.js";
import { PACKAGE_ROOT } from "../src/config.js";
import { InputError } from "../src/input.js";
import { readSampleFile } from "../src/samples.js";

const SAMPLE_PATH = join(PACKAGE_ROOT, "..", "..", "sample_vehicles.json");
const EX2_PATH = join(PACKAGE_ROOT, "examples", "02_clean_runs_2022_40k.json");

let dir: string | undefined;
const tempDir = (): string => (dir = mkdtempSync(join(tmpdir(), "underscope-cli-")));
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const capture = () => {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  return out;
};

describe("files saved with a UTF-8 byte-order mark", () => {
  it("decide reads a record with a BOM", async () => {
    const path = join(tempDir(), "bom.json");
    writeFileSync(path, `﻿${readFileSync(EX2_PATH, "utf8")}`);
    const out = capture();
    expect(await main(["decide", path, "--offline", "--as-of", "2026"])).toBe(0);
    const decision = JSON.parse(out.join("\n"));
    expect(decision).toMatchObject({ recommendation: "acv", confidence: "clear" });
  });

  it("samples reads a sample file with a BOM", () => {
    const path = join(tempDir(), "samples.json");
    writeFileSync(path, `﻿${readFileSync(SAMPLE_PATH, "utf8")}`);
    expect(readSampleFile(path).vehicles).toHaveLength(15);
  });
});

describe("decide input checks", () => {
  it("refuses a file that is not a condition record (e.g. sample_vehicles.json) instead of deciding on it", async () => {
    capture();
    await expect(main(["decide", SAMPLE_PATH, "--offline"])).rejects.toThrow(InputError);
    await expect(main(["decide", SAMPLE_PATH, "--offline"])).rejects.toThrow(/Unrecognized keys?: /);
  });
});

describe("loadDotEnv", () => {
  it("skips a .env it cannot read with a warning, instead of throwing", () => {
    const unreadable = join(tempDir(), ".env");
    mkdirSync(unreadable); // exists, but process.loadEnvFile cannot read it
    const warnings: string[] = [];
    expect(() => loadDotEnv([unreadable, join(dir!, "missing.env")], (l) => warnings.push(l))).not.toThrow();
    expect(warnings).toEqual([`Warning: cannot read ${unreadable} (not a readable file); ignoring it`]);
  });
});

describe("eval", () => {
  it("passes offline and reports API requests (not examples) in the cost line", async () => {
    const out = capture();
    expect(await main(["eval", "--offline"])).toBe(0);
    expect(out.filter((l) => l.startsWith("PASS"))).toHaveLength(6);
    expect(out.at(-1)).toBe("\nTotal API cost: $0.0000 (0 API requests for 0 of 6 examples)");
  });
});
