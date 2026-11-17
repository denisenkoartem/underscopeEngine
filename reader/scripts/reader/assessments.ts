// Assessments for the engine's tests: what the reader hands the engine, as JSON lines.
//   pnpm -s reader:assessments > ../engine/tests/fixtures/reader_assessments.jsonl
//
// Rows are { id, kind, a }:
// - kind "rules": the keyword rules' reading of each test note (fixtures/reader/gold.jsonl). This is what
//   the app sends the engine today: many unknowns, usually no VIN.
// - kind "label": generated notes with every stated field filled (the answer a perfect reader gives), so
//   the engine also sees the fields the rules often miss.
// - kind "complete": the same kind of generated assessment with a clean value and 3 to 5 comps added
//   (20% to 50% of the clean value), so the engine's dollar comparison and its model actually run.
//   Those two values are made up here, not read from the note.
// Deterministic: the same reader code gives the same file. engine/tests/test_reader_fixture.py runs them all.

import { listMissing } from "../../src/contract.js";
import { readRules } from "../../src/rules.js";
import { goldItems } from "./gold.js";
import { rng, verifyNotes } from "./lib.js";
import { synthItem } from "./synth.js";

const LABELS = 120;

for (const g of goldItems()) process.stdout.write(`${JSON.stringify({ id: g.id, kind: "rules", a: readRules(g.notes) })}\n`);
const r = rng(20261116);
for (let i = 0; i < LABELS; i++) {
  const x = synthItem(r, `label-${String(i + 1).padStart(3, "0")}`, true);
  if (!("item" in x)) continue;
  const a = verifyNotes(x.item.notes, x.item.target).assessment;
  const complete = i % 2 === 1;
  if (complete) {
    const clean = Math.round((8000 + r() * 25000) / 100) * 100;
    a.values.clean_wholesale = clean;
    a.values.salvage_comps = Array.from({ length: 3 + Math.floor(r() * 3) }, () => Math.round((clean * (0.2 + r() * 0.3)) / 50) * 50);
    if (a.mileage === null) a.mileage = Math.round((20000 + r() * 150000) / 100) * 100;
    if (a.vehicle.year === null) a.vehicle.year = 2008 + Math.floor(r() * 18);
    listMissing(a); // expected / missing / precision must describe the values just added
  }
  process.stdout.write(`${JSON.stringify({ id: x.item.id, kind: complete ? "complete" : "label", a })}\n`);
}
