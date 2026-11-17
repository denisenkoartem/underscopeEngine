// The page's form: one box per fact the decision needs, plus one general box for everything else.
// The reader still takes one text. compose() writes the boxes into that text, each answer behind the
// words that say what it answers ("Mileage: 84,000."), so both readers (rules.ts, model.ts) read the
// same thing and a short answer like "no" keeps its question. A yes/no box has a neutral lead, so an
// answer the reader does not understand stays unknown; only a plain "yes" gets the lead that states the fact.
export const BOXES = [
  { id: 'title', lead: 'Title', facts: ['title_status'] },
  { id: 'mileage', lead: 'Mileage', facts: ['mileage'] },
  { id: 'clean', lead: 'Clean wholesale value', facts: ['values.clean_wholesale'] },
  { id: 'comps', lead: 'Similar damaged vehicles sold for', facts: ['values.salvage_comps'] },
  { id: 'damage', lead: null, facts: ['grades', 'grades.rest'] }, // sentences of its own, no lead
  { id: 'airbags', lead: 'Airbags', yes: 'Airbags deployed', facts: ['flags.airbags_deployed'] },
  { id: 'frame', lead: 'Frame', yes: 'Frame damage', facts: ['flags.frame_suspected'] },
  { id: 'leaks', lead: 'Leaks', yes: 'Fluid leaks', facts: ['flags.fluid_leak'] },
] as const;
export type BoxId = (typeof BOXES)[number]['id'];
export type FormFields = Partial<Record<BoxId, string>>;

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The boxes and the general box as the one description the reader reads. */
export function compose(fields: FormFields = {}, notes = ''): string {
  const parts: string[] = [];
  for (const box of BOXES) {
    const answer = (fields[box.id] ?? '').trim();
    if (!answer) continue;
    const lead = 'yes' in box && /^(?:yes|yeah|yep|y)\b/i.test(answer) ? box.yes : box.lead;
    parts.push(sentence(lead ? `${lead}: ${answer}` : answer));
  }
  if (notes.trim()) parts.push(notes.trim());
  return parts.join('\n');
}

/** The request body of /api/parse-notes and /api/engine: { text } alone, or { fields, text }. */
export function composeBody(body: unknown): string | null {
  const b = (body ?? {}) as { text?: unknown; notes?: unknown; fields?: unknown };
  const text = b.text ?? b.notes ?? ''; // "notes" is the name the page used before 2026-11-16
  if (typeof text !== 'string') return null;
  if (b.fields === undefined) return text;
  if (typeof b.fields !== 'object' || b.fields === null) return null;
  const fields: FormFields = {};
  for (const box of BOXES) {
    const v = (b.fields as Record<string, unknown>)[box.id];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return null;
    fields[box.id] = v;
  }
  return compose(fields, text);
}
