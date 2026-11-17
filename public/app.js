// Underscope demo page. The seller types a VIN, one box per fact the decision needs, and one general box.
// /api/parse-notes writes the boxes into one description (reader/src/form.ts) and turns that
// description into JSON (title, mileage, values, part grades, flags), /api/vehicle decodes the VIN (free
// NHTSA lookup), /api/repair-estimate prices the repair and /api/route picks the marketplace and says whether repairing pays. Nothing here is paid.
// Where the server turns on /api/engine (ENGINE_ENABLED=1), the same boxes also go to the trained reader.
// Deep links: /?vin=...&title=clean&mileage=84k&...&notes=...&run=1  or  /?sample=front-hit
const GRADE_ORDER = ['fine', 'repairable', 'replace', 'unknown'];
const GRADE_LABEL = { fine: 'Fine', repairable: 'Repairable', replace: 'Replace', unknown: 'Not described' };
const TITLE_LABEL = { clean: 'Clean', salvage: 'Salvage', rebuilt: 'Rebuilt', flood: 'Flood', non_repairable: 'Non-repairable', lemon: 'Lemon buyback', unknown: 'Title not confirmed' };
const RUN_LABEL = { runs_and_drives: 'Runs and drives', starts: 'Starts', does_not_start: 'Does not start', unknown: 'Unknown' };
const FLAG_LABEL = { airbags_deployed: 'Airbags deployed', frame_suspected: 'Frame damage', fluid_leak: 'Fluid leak' };
const DEFAULT_LABOR_RATE = 95;   // $/hour; api/_lib/repair.ts has the same default
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const label = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }

let state = null;      // the checked vehicle; grades and flags stay editable
let sampleId = null;   // set while the form holds an unedited sample
let samples = {};

// /api/engine is on only where ENGINE_ENABLED=1.
const engineReady = fetch('/api/engine').then((r) => (r.ok ? r.json() : null)).then((b) => !!(b && b.enabled)).catch(() => false);
engineReady.then((on) => { if (on) $('model-note').textContent = 'The trained reader also reads this box and your answers above.'; });

// ---------- Assumptions ----------
const laborRate = () => { const n = Number($('labor-rate').value); return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LABOR_RATE; };

// ---------- VIN ----------
$('vin').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  e.target.value = v;
  const hint = $('vin-hint'); hint.classList.remove('bad');
  hint.textContent = v.length === 0 ? "17 characters, on the dash or the driver's door jamb." : `${v.length} of 17`;
});

// ---------- Boxes + general box -> JSON (POST /api/parse-notes) ----------
// One box per fact the decision needs (the reader's `expected` facts marked "needed"); `facts` are the
// paths each box answers. The server writes the boxes and the general box into one description.
const BOXES = [
  ['title', ['title_status']], ['mileage', ['mileage']], ['clean', ['values.clean_wholesale']], ['comps', ['values.salvage_comps']],
  ['damage', ['grades', 'grades.rest']], ['airbags', ['flags.airbags_deployed']], ['frame', ['flags.frame_suspected']], ['leaks', ['flags.fluid_leak']],
];
const readFields = () => Object.fromEntries(BOXES.map(([id]) => [id, $(`f-${id}`).value]));
const readInput = () => ({ fields: readFields(), text: $('notes').value });
const inputEmpty = (inp) => !inp.text.trim() && Object.values(inp.fields).every((v) => !v.trim());
function setInput(fields = {}, text = '') {
  for (const [id] of BOXES) $(`f-${id}`).value = fields[id] || '';
  $('notes').value = text;
}
// Parsed as the seller types, so they see what was understood and what is still needed before running.
let parsed = null, parseTicket = 0, submitted = false;
async function parseNow() {
  const ticket = ++parseTicket, input = readInput();
  if (inputEmpty(input)) { parsed = null; paintRead(); return null; }
  const p = await post('/api/parse-notes', input).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (ticket !== parseTicket) return parsed;
  parsed = p;
  if (p && p.vin && !$('vin').value) { $('vin').value = p.vin; $('vin').dispatchEvent(new Event('input')); }
  paintRead();
  return p;
}
// What the reader took for one box, in a few words.
function boxValue(p, id) {
  if (id === 'damage') {
    const damaged = p.grades.filter((g) => g.grade === 'repairable' || g.grade === 'replace').length;
    const fine = p.grades.filter((g) => g.grade === 'fine').length;
    return `${damaged} damaged part${damaged === 1 ? '' : 's'}, ${fine} fine`;
  }
  if (id === 'title') return TITLE_LABEL[p.title_status];
  if (id === 'mileage') return `${p.mileage.toLocaleString('en-US')} miles`;
  if (id === 'clean') return money(p.values.clean_wholesale);
  if (id === 'comps') return p.values.salvage_comps.map(money).join(', ');
  return yn(p.flags[{ airbags: 'airbags_deployed', frame: 'frame_suspected', leaks: 'fluid_leak' }[id]]);
}
// Each box: read / not understood / not answered. A box left empty is fine when the general box
// already gave its fact. Returns the ids of the boxes that still need an answer.
function paintBoxes() {
  const open = [];
  for (const [id, facts] of BOXES) {
    const typed = $(`f-${id}`).value.trim() !== '';
    const exp = parsed ? parsed.expected.filter((e) => facts.includes(e.field)) : [];
    const lacking = exp.filter((e) => !e.given);
    const read = exp.length > 0 && exp[0].given; // the box's own fact; "grades.rest" only adds a reminder
    let cls = '', msg = '';
    if (read) {
      cls = lacking.length ? 'warn' : 'ok';
      msg = `${typed ? 'Read' : 'Read from the box below'}: ${boxValue(parsed, id)}.${lacking.length ? ` Still to say: ${lacking.map((e) => e.ask).join('; ')}.` : ''}`;
    } else if (typed) {
      cls = 'warn';
      msg = /\b(not sure|unsure|unknown|don'?t know|not checked)\b/i.test($(`f-${id}`).value) ? 'Taken as unknown. The answer will be less precise.'
        : `Not read yet. Still needed: ${lacking.map((e) => e.ask).join('; ')}. Try other words, or write "not sure".`;
    } else {
      open.push(id);
      if (submitted) { cls = 'bad'; msg = 'Required. Write "not sure" if you do not know.'; }
    }
    const el = $(`s-${id}`);
    el.className = `box-status ${cls}`; el.textContent = msg;
    el.parentElement.classList.toggle('bad', cls === 'bad');
  }
  return open;
}
function paintRead() {
  paintBoxes();
  const el = $('read');
  if (!parsed) { el.innerHTML = ''; return; }
  const p = parsed, list = (xs) => `<ul>${xs.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`;
  const extra = [
    p.region && `in ${p.region}`, p.seller_type !== 'unknown' && `seller: ${label(p.seller_type).toLowerCase()}`,
    p.run_status !== 'unknown' && RUN_LABEL[p.run_status].toLowerCase(), p.keys !== 'unknown' && `keys: ${yn(p.keys).toLowerCase()}`,
    p.primary_damage !== 'unknown' && `${label(p.primary_damage).toLowerCase()} damage`,
    p.values.repair_estimate != null && `repair quote ${money(p.values.repair_estimate)}`, p.values.reserve_price != null && `lowest price ${money(p.values.reserve_price)}`,
  ].filter(Boolean);
  el.innerHTML = `${extra.length ? `<p><b>Also read:</b> ${esc(extra.join(' · '))}</p>` : ''}
    ${p.questions.length ? `<p><b>Please clarify:</b></p>${list(p.questions)}` : ''}
    ${p.could_add.length ? `<p><b>Would make the answer more precise:</b></p>${list(p.could_add)}` : '<p class="verified">Everything the reader was expecting is here.</p>'}`;
}
let parseTimer;
$('form').addEventListener('input', (e) => {
  if (!e.target.matches('#notes, [data-box]')) return;
  sampleId = null; $('go-hint').textContent = ''; clearTimeout(parseTimer); parseTimer = setTimeout(parseNow, 300);
});

// ---------- Samples ----------
function loadSample(v) {
  $('vin').value = v.vin; $('vin').dispatchEvent(new Event('input'));
  setInput(v.fields, v.notes);
  sampleId = v.id;
  $('form').requestSubmit();
}
const samplesReady = fetch('/demo_vehicles.json').then((r) => r.json()).then(({ vehicles }) => {
  for (const v of vehicles) {
    samples[v.id] = v;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(v.label)}</td><td class="vin-cell">${esc(v.vin)}</td><td>${esc(TITLE_LABEL[v.title_status])}</td><td><button class="btn btn-ghost btn-sm" type="button">Open</button></td>`;
    tr.querySelector('button').onclick = () => loadSample(v);
    $('samples').appendChild(tr);
  }
}).catch(() => {});

$('clear').onclick = () => {
  $('vin').value = ''; $('vin').dispatchEvent(new Event('input'));
  setInput(); parsed = null; parseTicket++; submitted = false; paintRead();
  sampleId = null; state = null; $('result').hidden = true; $('empty').hidden = false;
  history.replaceState(null, '', '/'); $('vin').focus();
};

// ---------- Run ----------
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTimeout(parseTimer);
  $('go').disabled = true; $('go').textContent = 'Running…';
  try {
    submitted = true;
    const p = await parseNow();
    const vin = $('vin').value.trim();
    if (!VIN_RE.test(vin)) {
      const hint = $('vin-hint'); hint.classList.add('bad');
      hint.textContent = /[IOQ]/.test(vin) ? 'VINs never use I, O or Q. Check for a 1 or a 0.' : `${vin.length} characters; a VIN has 17.`;
      $('vin').focus(); return;
    }
    const open = paintBoxes();
    if (open.length || !p) { $(`f-${open[0] || 'title'}`).focus(); $('go-hint').textContent = `${open.length} required box${open.length === 1 ? ' is' : 'es are'} empty.`; return; }
    $('go-hint').textContent = '';
    const v = await fetch(`/api/vehicle?vin=${encodeURIComponent(vin)}`).then((r) => r.json()).catch(() => ({}));
    state = {
      vin, vehicle: v.vehicle || {}, vinOk: v.check_digit_ok !== false, parsed: p, input: readInput(), notes: JSON.stringify(readInput()), sampleId,
      title_status: p.title_status,
      grades: new Map(p.grades.map((g) => [g.part, { grade: g.grade, edited: false }])),
      flags: { ...p.flags },
    };
    await recompute(true);
  } catch (err) {
    $('result').hidden = false;
    $('result').innerHTML = `<div class="error-box"><h3>Couldn't check this vehicle</h3><p>${esc(err.message)} Try again or open a sample below.</p></div>`;
    $('result').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  } finally {
    $('go').disabled = false; $('go').textContent = 'Run check';
  }
});

let pending = 0;
async function recompute(first = false) {
  if (!state) return;
  const ticket = ++pending, p = state.parsed;
  const grades = [...state.grades].map(([part, g]) => ({ part, grade: g.grade }));
  const values = { clean_wholesale: p.values.clean_wholesale || undefined, salvage_comps: p.values.salvage_comps };
  // One repair cost: the parts table prices the damage, and the engine uses that same estimate.
  const repair = await post('/api/repair-estimate', { grades, flags: state.flags, labor_rate: laborRate() }).then((r) => r.json());
  if (ticket !== pending) return;
  // The engine (engine/, via /api/route) decides where to send the car and whether repairing first pays.
  // It gets everything the reader returned; what the reviewer changed on the page wins.
  const routeBody = { vin: state.vin, vehicle: state.vehicle, title_status: state.title_status, grades, flags: state.flags, values,
    mileage: p.mileage || undefined, region: p.region || undefined,
    repair: repair.error ? undefined : { low: repair.low, high: repair.high } };
  const rt = await post('/api/route', { ...p, ...routeBody, flags: { ...p.flags, ...state.flags }, values: { ...p.values, ...values } })
    .then(async (r) => (r.ok ? r.json() : { error: (await r.json().catch(() => ({}))).error || `engine answered ${r.status}` }))
    .catch((e) => ({ error: e.message }));
  const engine = first && (await engineReady);
  if (ticket !== pending) return;
  state.route = rt;
  state.routeBody = routeBody;
  // The trained reader takes a few seconds on a local GPU, so it runs once per check and on "Read again".
  if (engine) runEngine();
  render(repair, first);
}

// ---------- The trained reader (POST /api/engine) ----------
// The same description, read by the reader with its model: the keyword rules and the trained model merged
// into one JSON (reader/src/read.ts). Shown under the result; it decides nothing.
let engineTicket = 0;
async function runEngine() {
  if (!state) return;
  const ticket = ++engineTicket, notes = state.notes;
  const started = Date.now();
  state.engine = { running: true, notes };
  paintEngine();
  const out = await post('/api/engine', state.input)
    .then(async (r) => {
      const b = await r.json().catch(() => ({}));
      return r.ok ? { data: b } : { error: b.error || `/api/engine answered ${r.status}` };
    })
    .catch((e) => ({ error: e.message }));
  if (ticket !== engineTicket || !state) return;
  state.engine = { ...out, notes, seconds: (Date.now() - started) / 1000 };
  paintEngine();
}
function paintEngine() { const el = $('engine-sec'); if (el) el.innerHTML = engineBody(); }
// "flags.fluid_leak", "grades.hood", "codes.P0301" -> the value at that path of the assessment.
function readerValue(a, path) {
  const [head, leaf] = path.split('.');
  let v = leaf === undefined ? a[head] : head === 'grades' ? (leaf === 'rest' ? 'fine' : (a.grades.find((g) => g.part === leaf) || {}).grade)
    : head === 'codes' ? (a.codes.find((c) => c.code === leaf) || {}).status : head === 'warning_lights' ? 'on' : (a[head] || {})[leaf];
  if (v === true) v = 'yes'; if (v === false) v = 'no';
  if (v == null) return 'unknown';
  return Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? v.toLocaleString('en-US') : String(v).replace(/_/g, ' ');
}
function engineBody() {
  const e = state.engine;
  const head = '<h3>The description, read by the trained reader</h3>';
  if (!e) return '';
  if (e.running) return `${head}<p class="tab-note">The trained reader is reading the description on the local model. This takes a few seconds.</p>`;
  const rerun = '<button class="btn btn-ghost btn-sm" type="button" data-engine-run>Read again</button>';
  if (e.error) return `${head}<p class="notice">The reader couldn't finish: ${esc(e.error)}.</p>${rerun}`;
  const { assessment: a, issues, model_error: down, model } = e.data;
  const rows = Object.entries(a.evidence).map(([path, quote]) => `<tr><td>${esc(path.replace(/_/g, ' '))}</td><td>${esc(readerValue(a, path))}</td><td class="lab">“${esc(quote)}”</td></tr>`).join('');
  const list = (xs) => `<ul class="tab-note" style="margin:4px 0 12px">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `${head}
    ${e.notes !== state.notes ? '<p class="notice">The description changed since this reading. Read it again to update it.</p>' : ''}
    ${down ? `<p class="notice">The model gave no answer (${esc(down)}), so this is the keyword rules' reading only. Start the model with <code>reader/model/serve.py</code>.</p>` : ''}
    <p class="tab-note">${a.reader === 'rules+model' ? `Keyword rules and ${esc(model)} merged` : 'Keyword rules only'}: ${Object.keys(a.evidence).length} value(s), each with the words it was read from. What the description does not say stays unknown.</p>
    ${rows ? `<table class="lines"><tbody><tr><td><b>Field</b></td><td><b>Read as</b></td><td><b>From the description</b></td></tr>${rows}</tbody></table>` : ''}
    ${a.conflicts.length ? `<p class="tab-note" style="margin:12px 0 4px"><b>Read two ways:</b></p>${list(a.conflicts.map((c) => `${c.field.replace(/_/g, ' ')}: kept ${c.kept}, not ${c.dropped}`))}` : ''}
    ${issues.length ? `<p class="tab-note" style="margin-top:8px">The checks removed ${issues.length} model answer(s) the description did not support: ${esc(issues.map((i) => i.path).join(', '))}.</p>` : ''}
    ${a.could_add.length ? `<p class="tab-note" style="margin:12px 0 4px"><b>Would sharpen the decision:</b></p>${list(a.could_add)}` : ''}
    <p class="tab-note" style="margin-top:12px">Took ${Math.round(e.seconds)} s.</p>
    ${rerun}`;
}

// The engine's routing is the headline: where to send the car.
const DEST_CLASS = { ACV: 'ok', Copart: 'bad', 'Parts buyer': 'warn' };
const DEST_LAMP = { ACV: ['on-acv', 'A'], Copart: ['on-copart', 'C'], 'Parts buyer': ['on-amber', 'P'] };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
function routeHero(first) {
  const r = state.route;
  if (!r || r.error) return '';
  if (r.confidence === 'insufficient') {
    const need = [...new Set([...(r.missing || []), ...(r.reader_missing || [])])];
    return `<div class="rec hero"><div class="lamp" aria-hidden="true">?</div><div>
      <h3>Not enough to go on</h3>
      <p class="why">The description does not give the engine what it needs to choose a marketplace.${need.length ? ` Still needed: ${esc(need.join('; '))}.` : ''}</p>
    </div></div>`;
  }
  const best = r.options[0], next = r.options[1];
  if (!next) {
    const [onlyLamp, onlyGlyph] = DEST_LAMP[r.destination] || ['', '?'];
    return `<div class="rec hero"><div class="lamp ${onlyLamp}${first ? ' ignite' : ''}" aria-hidden="true">${onlyGlyph}</div><div>
      <h3>Send it to ${esc(r.destination)}</h3>
      <p class="why"><b>${esc(cap(r.winner_label))}</b> is the only exit this title allows. Expected net ${money(best.expected)}, middle 80% ${money(best.p10)} to ${money(best.p90)}.</p>
    </div></div>`;
  }
  const [lamp, glyph] = DEST_LAMP[r.destination] || ['', '?'];
  const gap = best.expected - next.expected;
  // Both top exits at ACV and nearly tied: the destination is clear, the repair choice isn't.
  const acvTie = best.destination === 'ACV' && next.destination === 'ACV' && gap < Math.max(500, best.expected * 0.05);
  const why = acvTie
    ? `Repairing first and selling as-is come out within ${money(gap)} of each other (expected net about ${money(best.expected)}), so the destination is ACV either way. Use “Repair or sell as-is?” below to choose.`
    : `<b>${esc(cap(r.winner_label))}.</b> Expected net ${money(best.expected)}, middle 80% ${money(best.p10)} to ${money(best.p90)}. Next best: ${esc(next.label)} (${esc(next.destination)}), ${money(gap)} behind.`;
  return `<div class="rec hero"><div class="lamp ${lamp}${first ? ' ignite' : ''}" aria-hidden="true">${glyph}</div><div>
    <h3>Send it to ${esc(r.destination)}</h3>
    <p class="why">${why}</p>
    ${r.precision && r.precision.note ? `<p class="check">${esc(r.precision.note)}${r.precision.not_given && r.precision.not_given.length ? ` Not given: ${esc(r.precision.not_given.slice(0, 6).join('; '))}${r.precision.not_given.length > 6 ? `, and ${r.precision.not_given.length - 6} more` : ''}.` : ''}</p>` : ''}
    ${r.decided_by === 'model' ? `<p class="tab-note">Decided by a model trained on simulated outcomes, not real sales: ${Math.round(r.p_acv * 100)}% chance ACV nets more (the dollar simulation says ${Math.round(r.p_acv_simulation * 100)}%).</p>` : ''}
    ${r.needs_human_review && !acvTie ? `<p class="check"><b>Have a person review this one.</b> ${esc((r.review_reasons || []).join(' '))}</p>` : ''}
  </div></div>`;
}
function routeExits() {
  const r = state.route;
  if (!r) return '';
  if (r.error) return `<div class="sec"><p class="notice">The routing engine isn't available right now (${esc(r.error)}). The repair estimate below does not depend on it.</p></div>`;
  const rows = r.options.map((o, i) => `<tr${i === 0 ? ' class="total"' : ''}><td>${esc(cap(o.label))}</td><td><span class="badge ${DEST_CLASS[o.destination] || ''}">${esc(o.destination)}</span></td><td class="amt">${money(o.p10)} to ${money(o.p90)}</td><td class="amt">${money(o.expected)}</td></tr>`).join('');
  return `<div class="sec route">
    <h3>Every exit this title allows</h3>
    <p class="tab-note">Net proceeds over 1,000 simulated outcomes, using the repair estimate below.</p>
    <table class="lines"><tbody><tr><td><b>Exit</b></td><td><b>Goes to</b></td><td class="amt"><b>Middle 80%</b></td><td class="amt"><b>Expected net</b></td></tr>${rows}</tbody></table>
    ${r.flip_conditions && r.flip_conditions.length ? `<p class="tab-note" style="margin-top:12px"><b>What would change the answer:</b> ${esc(r.flip_conditions.join(' '))}</p>` : ''}
    <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--steel);font-size:13px">How the engine read your inputs</summary><ul class="tab-note" style="margin:8px 0 0">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>
  </div>`;
}
let debounce;
const recomputeSoon = () => { clearTimeout(debounce); debounce = setTimeout(() => recompute(false), 250); };
$('labor-rate').addEventListener('input', recomputeSoon);

// Reviewer toggle, tabs, copy link
$('result').addEventListener('click', (e) => {
  const pb = e.target.closest('[data-part]'), fb = e.target.closest('[data-flag]'), cl = e.target.closest('[data-copy]');
  if (pb && state) { const g = state.grades.get(pb.dataset.part); g.grade = GRADE_ORDER[(GRADE_ORDER.indexOf(g.grade) + 1) % GRADE_ORDER.length]; g.edited = true; recompute(false); }
  else if (fb && state) { const order = [true, false, 'unknown'], k = fb.dataset.flag; state.flags[k] = order[(order.indexOf(state.flags[k]) + 1) % order.length]; recompute(false); }
  else if (e.target.closest('[data-engine-run]') && state && !(state.engine && state.engine.running)) { runEngine(); }

  else if (cl) { copyLink(); }
});

function shareUrl() {
  const u = new URL('/', location.origin);
  if (state.sampleId) { u.searchParams.set('sample', state.sampleId); return u.toString(); }
  u.searchParams.set('vin', state.vin);
  for (const [id, v] of Object.entries(state.input.fields)) if (v.trim()) u.searchParams.set(id, v);
  if (state.input.text.trim()) u.searchParams.set('notes', state.input.text);
  u.searchParams.set('run', '1');
  return u.toString();
}
async function copyLink() {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
}

// ---------- Render ----------
function vehicleName() {
  const v = state.vehicle;
  const make = v.make && (v.make.length <= 3 ? v.make : v.make.replace(/\B\w+/g, (m) => m.toLowerCase()));
  return [v.year, make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle';
}
function titleBadge() {
  const t = state.title_status;
  const cls = t === 'clean' ? 'ok' : t === 'unknown' ? 'warn' : 'bad';
  return `<span class="badge ${cls}">${esc(TITLE_LABEL[t] || t)}${t !== 'unknown' ? ', seller stated' : ''}</span>`;
}

// Repair or sell as-is: the engine's two ACV exits side by side. Nothing is computed here; the numbers
// and the sentence are the engine's (options and answer from /api/route).
function repairOrSell() {
  const r = state.route;
  if (!r || r.error || r.confidence === 'insufficient') return '';
  const asIs = r.options.find((o) => o.path === 'acv_as_is'), fix = r.options.find((o) => o.path === 'repair_then_acv');
  if (!asIs || !fix) return '';
  const rows = [['Repair, then sell', 'fix', fix], ['Sell as-is', 'sell', asIs]];
  const min = Math.min(fix.p10, asIs.p10), max = Math.max(fix.p90, asIs.p90);
  const pad = (max - min) * 0.04 || 1, lo = min - pad, hi = max + pad, x = (v) => ((v - lo) / (hi - lo)) * 100;
  const winner = fix.expected > asIs.expected ? 'fix' : 'sell';
  return `<div class="sec"><h3>Repair or sell as-is?</h3>
    <p class="tab-note">${esc(r.answer || '')}</p>
    <div class="ranges">${rows.map(([name, cls, o]) => `
      <div class="rrow${cls === winner ? ' win' : ''}">
        <span class="name">${name}</span>
        <div class="track" aria-hidden="true">
          ${lo < 0 && hi > 0 ? `<span class="zero" style="left:${x(0)}%"></span>` : ''}
          <span class="bar ${cls}" style="left:${x(o.p10)}%;width:${Math.max(0.8, x(o.p90) - x(o.p10))}%"></span>
          <span class="mid" style="left:calc(${x(o.p50)}% - 1px)"></span>
        </div>
        <span class="nums"><b>${money(o.p10)} to ${money(o.p90)}</b>net on ACV, typically ${money(o.p50)}</span>
      </div>`).join('')}
      <p class="scale-note">Bar: middle 80% of simulated outcomes. Tick: typical.</p></div></div>`;
}

function repairTab(repair) {
  if (repair.error) return `<p class="notice">The repair estimate isn't available (${esc(repair.error)}).</p>`;
  const rows = repair.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="amt">${money(l.low)} to ${money(l.high)}</td></tr>`).join('')
    || '<tr><td>No damaged parts</td><td class="amt">$0</td></tr>';
  const allowances = repair.allowances.map((a) => `<tr class="widen"><td>${esc(a.reason)} (could cost more)</td><td class="amt">+${money(a.amount)}</td></tr>`).join('');
  return `<p class="tab-note">Parts plus labor at ${money(repair.labor_rate)}/hr, paint where a panel needs it. Rough ranges for a generic passenger vehicle, not shop quotes.</p>
    <table class="lines"><tbody>${rows}${allowances}<tr class="total"><td>Repair estimate</td><td class="amt">${money(repair.low)} to ${money(repair.high)}</td></tr></tbody></table>`;
}

function conditionTab() {
  const counts = {}; state.grades.forEach((g) => counts[g.grade] = (counts[g.grade] || 0) + 1);
  return `<p class="tab-note">Read from the description: ${counts.replace || 0} replace, ${counts.repairable || 0} repairable, ${counts.unknown || 0} not described. Click a grade or flag to change it.</p>
    <ul class="parts">${[...state.grades].map(([part, g]) => `
      <li class="g-${g.grade}"><button type="button" data-part="${part}" class="${g.edited ? 'edited' : ''}" aria-label="${esc(label(part))}: ${GRADE_LABEL[g.grade]}. Click to change.">
        <span class="dot" aria-hidden="true"></span><span>${esc(label(part))}</span><span class="grade">${GRADE_LABEL[g.grade]}${g.edited ? '*' : ''}</span>
      </button></li>`).join('')}</ul>
    <div class="flags">${Object.keys(FLAG_LABEL).map((k) => `<button type="button" data-flag="${k}" class="${state.flags[k] === true ? 'yes' : ''}">${FLAG_LABEL[k]}: <b>${yn(state.flags[k])}</b></button>`).join('')}</div>`;
}

// What the parser took from the description: each value with the words it came from, what is
// still missing, and the sentences it read nothing from.
function readTab() {
  const p = state.parsed, ev = p.evidence;
  const rows = [
    ['Title', TITLE_LABEL[p.title_status], ev.title_status],
    ['Mileage', p.mileage === null ? 'Unknown' : p.mileage.toLocaleString('en-US'), ev.mileage],
    ['State', p.region || 'Unknown', ev.region],
    ['Run status', RUN_LABEL[p.run_status], ev.run_status],
    ['Clean wholesale value', p.values.clean_wholesale === null ? 'Unknown' : money(p.values.clean_wholesale), ev['values.clean_wholesale']],
    ['Salvage comps', p.values.salvage_comps.length ? p.values.salvage_comps.map(money).join(', ') : 'None', ev['values.salvage_comps']],
    ...Object.keys(FLAG_LABEL).map((k) => [FLAG_LABEL[k], yn(p.flags[k]), ev[`flags.${k}`]]),
    ...p.grades.filter((g) => ev[`grades.${g.part}`]).map((g) => [label(g.part), GRADE_LABEL[g.grade], ev[`grades.${g.part}`]]),
    ev['grades.rest'] && ['All other parts', 'Fine', ev['grades.rest']],
  ].filter(Boolean);
  const ask = [...p.missing, ...p.questions];
  const list = (xs) => `<ul class="tab-note" style="margin:4px 0 0">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<p class="tab-note">Rules read the description into the JSON below; no AI and no paid lookup. Anything not stated stays unknown and widens the ranges.</p>
    <table class="lines"><tbody><tr><td><b>Field</b></td><td><b>Read as</b></td><td><b>From your words</b></td></tr>
      ${rows.map(([f, v, q]) => `<tr><td>${esc(f)}</td><td>${esc(v)}</td><td>${q ? `“${esc(q)}”` : '<span class="tab-note">not stated</span>'}</td></tr>`).join('')}</tbody></table>
    ${ask.length ? `<p class="tab-note" style="margin-top:12px"><b>Add to the description to tighten the answer:</b></p>${list(ask)}` : ''}
    ${p.additional.length ? `<p class="tab-note" style="margin-top:12px"><b>Kept as extra information, not used in the numbers:</b></p>${list(p.additional)}` : ''}`;
}

// The whole check as one JSON document: inputs, the parsed description, decision and routing.
function buildReport(repair) {
  return {
    generated_at: new Date().toISOString(),
    input: { vin: state.vin, ...state.input, sample: state.sampleId || null },
    vehicle: state.vehicle,
    parsed: state.parsed,
    part_grades: [...state.grades].map(([part, g]) => ({ part, grade: g.grade, edited_by_reviewer: g.edited })),
    flags: state.flags,
    repair_estimate: repair,
    route: state.route || null,
    engine: !state.engine ? null : state.engine.data ? state.engine.data : { error: state.engine.error || 'still running' },
  };
}
function downloadJson(report) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = `underscope-${report.input.vin}-${report.generated_at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render(repair, first) {
  const out = $('result');
  const report = buildReport(repair);
  out.hidden = false;
  const y = window.scrollY;
  const engine = state.vehicle.engine ? `<span class="vin-code">${esc(state.vehicle.engine)}</span>` : '';
  const vinWarn = state.vinOk ? '' : '<p class="notice">This VIN fails its check digit, so one character may be mistyped. The vehicle name below may be wrong.</p>';
  out.innerHTML = `
    <div class="vehbar"><h2>${esc(vehicleName())}</h2><span class="vin-code">${esc(state.vin)}</span>${engine}${titleBadge()}<span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-copy>Copy link</button>
      <button class="btn btn-ghost btn-sm" type="button" data-download>Download JSON</button></div>${vinWarn}
    ${routeHero(first)}${routeExits()}${repairOrSell()}
    ${state.engine ? `<div class="sec engine" id="engine-sec">${engineBody()}</div>` : ''}
    <div class="sec"><h3>Repair estimate</h3>${repairTab(repair)}</div>
    <div class="sec"><h3>Condition</h3>${conditionTab()}</div>
    <div class="sec"><h3>What we read from your description</h3>${readTab()}</div>
    <div class="sec"><details><summary style="cursor:pointer;color:var(--orange);font-weight:500;font-size:14px">API response (same as Download JSON)</summary><pre style="margin-top:10px">${esc(JSON.stringify(report, null, 2))}</pre></details></div>`;
  out.querySelector('[data-download]').onclick = () => downloadJson(buildReport(repair)); // includes a later engine result
  if (first) {
    history.replaceState(null, '', shareUrl().replace(location.origin, ''));
    out.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  } else {
    window.scrollTo(0, y); // reviewer edits: stay where you are
  }
}

// ---------- Deep links ----------
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('sample')) { await samplesReady; const v = samples[q.get('sample')]; if (v) loadSample(v); return; }
  const vin = (q.get('vin') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin) { $('vin').value = vin; $('vin').dispatchEvent(new Event('input')); }
  // An older link carries the whole description in `notes`; a box it already answers is not asked again.
  setInput(Object.fromEntries(BOXES.map(([id]) => [id, q.get(id) || ''])), q.get('notes') || '');
  if (!inputEmpty(readInput())) await parseNow();
  if (q.get('run') === '1' && VIN_RE.test(vin) && !inputEmpty(readInput())) $('form').requestSubmit();
})();
