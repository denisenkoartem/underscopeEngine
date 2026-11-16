// CLI: pnpm engine read "<text>" | --file <notes.txt> [--out <file.json>] [--rules-only | --model]
//
// Prints the assessment JSON for a seller's description (src/read.ts). stdout is that JSON only; logs
// go to stderr. pnpm runs this with cwd = reader; INIT_CWD is where the user ran pnpm.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT, ReadError } from "./model.js";
import type { ParserClient } from "./openaiParse.js";
import { read } from "./read.js";

const REPO_ROOT = resolve(PACKAGE_ROOT, "..");

const USAGE = `Usage: pnpm -s engine read "<text>" [options]
  Turns a seller's description of one damaged vehicle into the assessment JSON.
  The keyword rules always read it (free). When PARSER_BASE_URL points at a model server
  (reader/model/serve.py), the trained model reads it too and the two readings are merged.
Options:
  --file <notes.txt>   read the text from a file instead of the argument
  --out <file.json>    also write the JSON to this file
  --rules-only         do not call the model even when PARSER_BASE_URL is set
  --model              fail when the model gives no answer (default: fall back to the rules)`;

class UsageError extends Error {}

export interface CliArgs {
  command: string;
  words: string[];
  file?: string;
  out?: string;
  model: "auto" | "off" | "required";
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "", words: [], model: "auto" };
  let i = 0;
  const valueOf = (a: string, name: string): string => {
    const v = a.includes("=") ? a.slice(name.length + 1) : argv[++i];
    if (!v) throw new UsageError(`${name} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue; // pnpm/npm separator
    if (a === "--rules-only") args.model = "off";
    else if (a === "--model") args.model = "required";
    else if (a === "--file" || a.startsWith("--file=")) args.file = valueOf(a, "--file");
    else if (a === "--out" || a.startsWith("--out=")) args.out = valueOf(a, "--out");
    else if (a === "-h" || a === "--help") args.command = "help";
    else if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
    else if (!args.command) args.command = a;
    else args.words.push(a);
  }
  return args;
}

/** Load .env (reader/.env, then the repo root's). A variable already set in the shell wins. */
export function loadDotEnv(paths: string[] = [join(PACKAGE_ROOT, ".env"), join(REPO_ROOT, ".env")], warn: (line: string) => void = (line) => console.error(line)): void {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
    } catch {
      warn(`Warning: cannot read ${p}; ignoring it`);
    }
  }
}

/** What tests inject; the CLI itself passes nothing. */
export interface CliDeps {
  client?: ParserClient;
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
    if (args.command === "help" || args.command === "") {
      console.log(USAGE);
      return args.command === "help" ? 0 : 1;
    }
    if (args.command !== "read") throw new UsageError(`Unknown command "${args.command}"`);
    if (args.file !== undefined && args.words.length > 0) throw new UsageError("read takes either the text or --file, not both");
    if (args.file === undefined && args.words.length === 0) throw new UsageError('read needs the text, e.g. pnpm -s engine read "Clean title, 84k miles, runs and drives", or --file <notes.txt>');
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  let text: string;
  if (args.file !== undefined) {
    const path = [resolve(base, args.file), resolve(PACKAGE_ROOT, args.file)].find((p) => existsSync(p));
    if (!path) {
      console.error(`File not found: ${args.file}`);
      return 1;
    }
    text = readFileSync(path, "utf8");
  } else text = args.words.join(" "); // unquoted words arrive as separate arguments
  if (!deps.env) loadDotEnv();
  try {
    const r = await read(text, { model: args.model, ...(deps.client ? { client: deps.client } : {}), ...(deps.env ? { env: deps.env } : {}), log: (line) => console.error(line) });
    if (r.model_error) console.error(`read: the model gave no answer (${r.model_error}); this is the rules' reading only`);
    const json = JSON.stringify(r.assessment, null, 2);
    if (args.out) writeFileSync(resolve(base, args.out), `${json}\n`);
    console.log(json);
    return 0;
  } catch (e) {
    if (!(e instanceof ReadError)) throw e;
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
