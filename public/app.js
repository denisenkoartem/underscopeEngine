// Underscope demo page. The seller types a VIN and a free-text description; /api/parse-notes turns the
// description into JSON (title, mileage, values, part grades, flags), /api/vehicle decodes the VIN (free
// NHTSA lookup), /api/decide prices the repair and /api/route picks the marketplace. Nothing here is paid.
// Where the server turns on /api/engine (ENGINE_ENABLED=1), the same description also goes to the trained reader.
// Deep links: /?vin=...&notes=Clean%20title...&run=1  or  /?sample=front-hit
const GRADE_ORDER = ['fine', 'repairable', 'replace', 'unknown'];
const GRADE_LABEL = { fine: 'Fine', repairable: 'Repairable', replace: 'Replace', unknown: 'Not described' };
const TITLE_LABEL = { clean: 'Clean', salvage: 'Salvage', rebuilt: 'Rebuilt', flood: 'Flood', non_repairable: 'Non-repairable', lemon: 'Lemon buyback', unknown: 'Title not confirmed' };
const RUN_LABEL = { runs_and_drives: 'Runs and drives', starts: 'Starts', does_not_start: 'Does not start', unknown: 'Unknown' };
const FLAG_LABEL = { airbags_deployed: 'Airbags deployed', frame_suspected: 'Frame damage', fluid_leak: 'Fluid leak' };
const ASSUME = [
  ['labor_rate', 'Labor ($/hr)', 95], ['daily_cost', 'Holding ($/day)', 20], ['fix_days', 'Days to fix + resell', 30], ['as_is_days', 'Days to sell as-is', 7],
  ['fix_selling_fee', 'Resale fee ($)', 450], ['as_is_fee', 'Auction fee ($)', 350], ['transport', 'Transport ($)', 150],
];
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

// ---------- Assumptions ----------
$('assume').innerHTML = ASSUME.map(([k, l, v]) => `<label>${esc(l)}<input id="a-${k}" inputmode="numeric" value="${v}"></label>`).join('');
const readAssumptions = () => Object.fromEntries(ASSUME.map(([k, , v]) => { const n = Number($(`a-${k}`).value); return [k, Number.isFinite(n) && n >= 0 ? n : v]; }));

// ---------- VIN ----------
$('vin').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  e.target.value = v;
  const hint = $('vin-hint'); hint.classList.remove('bad');
  hint.textContent = v.length === 0 ? "17 characters, on the dash or the driver's door jamb." : `${v.length} of 17`;
});

// ---------- Description -> JSON (POST /api/parse-notes) ----------
// Parsed as the seller types, so they see what was understood and what is still needed before running.
let parsed = null, parseTicket = 0;
async function parseNow() {
  const ticket = ++parseTicket, text = $('notes').value;
  if (!text.trim()) { parsed = null; paintRead(); return null; }
  const p = await post('/api/parse-notes', { text }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (ticket !== parseTicket) return parsed;
  parsed = p;
  if (p && p.vin && !$('vin').value) { $('vin').value = p.vin; $('vin').dispatchEvent(new Event('input')); }
  paintRead();
  return p;
}
// What the parser read, as short facts.
function readFacts(p) {
  const damaged = p.grades.filter((g) => g.grade === 'repairable' || g.grade === 'replace').length;
  const described = p.grades.filter((g) => g.grade !== 'unknown').length;
  return [
    p.title_status !== 'unknown' && `${TITLE_LABEL[p.title_status]} title`,
    p.mileage !== null && `${p.mileage.toLocaleString('en-US')} miles`,
    p.region && `in ${p.region}`,
    p.run_status !== 'unknown' && RUN_LABEL[p.run_status].toLowerCase(),
    p.values.clean_wholesale !== null && `clean value ${money(p.values.clean_wholesale)}`,
    p.values.salvage_comps.length > 0 && `${p.values.salvage_comps.length} comp${p.values.salvage_comps.length === 1 ? '' : 's'}`,
    described > 0 && `${damaged} damaged part${damaged === 1 ? '' : 's'}, ${described - damaged} fine`,
    ...Object.keys(FLAG_LABEL).filter((k) => p.flags[k] !== 'unknown').map((k) => `${FLAG_LABEL[k].toLowerCase()}: ${yn(p.flags[k]).toLowerCase()}`),
  ].filter(Boolean);
}
function paintRead() {
  const el = $('read');
  if (!parsed) { el.innerHTML = ''; return; }
  const facts = readFacts(parsed), ask = [...parsed.missing, ...parsed.questions];
  el.innerHTML = `<p><b>Read so far:</b> ${facts.length ? esc(facts.join(' · ')) : 'nothing yet'}</p>
    ${ask.length ? `<p><b>Still needed:</b></p><ul>${ask.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p class="verified">Everything needed is here.</p>'}`;
}
let parseTimer;
$('notes').addEventListener('input', () => { sampleId = null; clearTimeout(parseTimer); parseTimer = setTimeout(parseNow, 300); });

// ---------- Samples ----------
function loadSample(v) {
  $('vin').value = v.vin; $('vin').dispatchEvent(new Event('input'));
  $('notes').value = v.notes;
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
  $('notes').value = ''; parsed = null; parseTicket++; paintRead();
  sampleId = null; state = null; $('result').hidden = true; $('empty').hidden = false;
  history.replaceState(null, '', '/'); $('vin').focus();
};

// ---------- Run ----------
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTimeout(parseTimer);
  $('go').disabled = true; $('go').textContent = 'Running…';
  try {
    const p = await parseNow();
    const vin = $('vin').value.trim();
    if (!VIN_RE.test(vin)) {
      const hint = $('vin-hint'); hint.classList.add('bad');
      hint.textContent = /[IOQ]/.test(vin) ? 'VINs never use I, O or Q. Check for a 1 or a 0.' : `${vin.length} characters; a VIN has 17.`;
      $('vin').focus(); return;
    }
    if (!p) { $('notes').focus(); $('read').innerHTML = '<p class="bad">Describe the vehicle first.</p>'; return; }
    const v = await fetch(`/api/vehicle?vin=${encodeURIComponent(vin)}`).then((r) => r.json()).catch(() => ({}));
    state = {
      vin, vehicle: v.vehicle || {}, vinOk: v.check_digit_ok !== false, parsed: p, notes: $('notes').value, sampleId,
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
  const body = {
    title_status: state.title_status,
    grades: [...state.grades].map(([part, g]) => ({ part, grade: g.grade })),
    flags: state.flags,
    values: { clean_wholesale: p.values.clean_wholesale || undefined, salvage_comps: p.values.salvage_comps },
    assumptions: readAssumptions(),
  };
  // The engine (engine/, via /api/route) decides where to send the car: ACV or Copart.
  // One repair cost: the engine gets the same repair estimate the page shows (parts table,
  // allowance for unknowns), so the two never price the damage differently.
  const d = await post('/api/decide', body).then((r) => r.json());
  if (ticket !== pending) return;
  const routeBody = { vin: state.vin, vehicle: state.vehicle, title_status: body.title_status,
    grades: body.grades, flags: body.flags, values: body.values,
    mileage: p.mileage || undefined, region: p.region || undefined,
    repair: d.repair ? { low: d.repair.low, high: d.repair.high } : undefined };
  // The engine reads the whole description (run status, keys, engine, flood signs, liens...), so it
  // gets everything the reader returned; the fields the reviewer can change on the page win.
  const rt = await post('/api/route', { ...p, ...routeBody, flags: { ...p.flags, ...body.flags }, values: { ...p.values, ...body.values } })
    .then(async (r) => (r.ok ? r.json() : { error: (await r.json().catch(() => ({}))).error || `engine answered ${r.status}` }))
    .catch((e) => ({ error: e.message }));
  const engine = first && (await engineReady);
  if (ticket !== pending) return;
  state.route = rt;
  state.routeBody = routeBody;
  // The trained reader takes a few seconds on a local GPU, so it runs once per check and on "Read again".
  if (engine) runEngine();
  render(d, first);
}

// ---------- The trained reader (POST /api/engine) ----------
// The same description, read by the reader with its model: the keyword rules and the trained model merged
// into one JSON (reader/src/read.ts). Shown under the result; it decides nothing.
let engineTicket = 0;
async function runEngine() {
  if (!state) return;
  const ticket = ++engineTicket, notes = state.notes.trim();
  const started = Date.now();
  state.engine = { running: true, notes };
  paintEngine();
  const out = await post('/api/engine', { text: notes })
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
    ${e.notes !== state.notes.trim() ? '<p class="notice">The description changed since this reading. Read it again to update it.</p>' : ''}
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
  const best = r.options[0], next = r.options[1];
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
    ${r.decided_by === 'model' ? `<p class="tab-note">Decided by a model trained on simulated outcomes, not real sales: ${Math.round(r.p_acv * 100)}% chance ACV nets more (the dollar simulation says ${Math.round(r.p_acv_simulation * 100)}%).</p>` : ''}
    ${r.needs_human_review && !acvTie ? `<p class="check"><b>Have a person review this one.</b> ${esc((r.review_reasons || []).join(' '))}</p>` : ''}
  </div></div>`;
}
function routeExits() {
  const r = state.route;
  if (!r) return '';
  if (r.error) return `<div class="sec"><p class="notice">The routing engine isn't available right now (${esc(r.error)}). The repair-or-sell analysis below still works.</p></div>`;
  const rows = r.options.map((o, i) => `<tr${i === 0 ? ' class="total"' : ''}><td>${esc(cap(o.label))}</td><td><span class="badge ${DEST_CLASS[o.destination] || ''}">${esc(o.destination)}</span></td><td class="amt">${money(o.p10)} to ${money(o.p90)}</td><td class="amt">${money(o.expected)}</td></tr>`).join('');
  return `<div class="sec route">
    <h3>All four exits</h3>
    <p class="tab-note">Net proceeds over 1,000 simulated outcomes, using the repair estimate below. ${esc(r.answer || '')}</p>
    <table class="lines"><tbody><tr><td><b>Exit</b></td><td><b>Goes to</b></td><td class="amt"><b>Middle 80%</b></td><td class="amt"><b>Expected net</b></td></tr>${rows}</tbody></table>
    ${r.flip_conditions && r.flip_conditions.length ? `<p class="tab-note" style="margin-top:12px"><b>What would change the answer:</b> ${esc(r.flip_conditions.join(' '))}</p>` : ''}
    <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--steel);font-size:13px">How the engine read your inputs</summary><ul class="tab-note" style="margin:8px 0 0">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>
  </div>`;
}
let debounce;
const recomputeSoon = () => { clearTimeout(debounce); debounce = setTimeout(() => recompute(false), 250); };
$('assume').addEventListener('input', recomputeSoon);

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
  u.searchParams.set('notes', state.notes);
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

function recBlock(d, first, compact = false) {
  const pct = d.p_fix == null ? null : Math.round(d.p_fix * 100);
  const V = {
    fix: ['on-green', '✓', 'Fix it, then sell', pct === 100 ? 'Fixing came out ahead in all 1,000 simulated outcomes.' : `Fixing came out ahead in ${pct}% of 1,000 simulated outcomes.`],
    sell_as_is: ['on-red', '!', 'Sell it as-is', pct === 0 ? 'Selling as-is came out ahead in all 1,000 simulated outcomes.' : `Fixing came out ahead in only ${pct}% of 1,000 simulated outcomes.`],
    too_close: ['on-amber', '?', 'Too close to call', `Fixing came out ahead in ${pct}% of 1,000 simulated outcomes; the ranges overlap too much to choose.`],
    not_fixable: ['on-red', '!', 'Sell it as-is', 'A non-repairable title means it can\'t be registered again after repair.'],
  }[d.verdict] || ['', '–', 'Needs market values', `Add ${d.missing.join(' and ')} above.`];
  const check = d.check ? `<p class="check"><b>Check before deciding:</b> ${esc(d.check.label)}. If it comes back clean, fixing wins ${Math.round(d.check.p_fix_if_resolved * 100)}% of the time.</p>` : '';
  return `<div class="rec${compact ? ' compact' : ''}"><div class="lamp ${V[0]}${first ? ' ignite' : ''}" aria-hidden="true">${V[1]}</div><div><h3>${esc(V[2])}</h3><p class="why">${esc(V[3])}</p>${check}</div></div>`;
}

function rangesBlock(d) {
  if (!d.as_is_net) return '';
  const rows = [d.fix_net && ['Fix and resell', 'fix', d.fix_net, d.days.fix], ['Sell as-is', 'sell', d.as_is_net, d.days.as_is]].filter(Boolean);
  const min = Math.min(...rows.map((r) => r[2].low)), max = Math.max(...rows.map((r) => r[2].high));
  const pad = (max - min) * 0.04 || 1, lo = min - pad, hi = max + pad, x = (v) => ((v - lo) / (hi - lo)) * 100;
  const fixWins = d.verdict === 'fix', sellWins = d.verdict === 'sell_as_is' || d.verdict === 'not_fixable';
  return `<div class="ranges">${rows.map(([name, cls, n, days]) => `
    <div class="rrow${(cls === 'fix' && fixWins) || (cls === 'sell' && sellWins) ? ' win' : ''}">
      <span class="name">${name}</span>
      <div class="track" aria-hidden="true">
        ${lo < 0 && hi > 0 ? `<span class="zero" style="left:${x(0)}%"></span>` : ''}
        <span class="whisker" style="left:${x(n.low)}%;width:${x(n.high) - x(n.low)}%"></span>
        <span class="bar ${cls}" style="left:${x(n.p10)}%;width:${Math.max(0.8, x(n.p90) - x(n.p10))}%"></span>
        <span class="mid" style="left:calc(${x(n.p50)}% - 1px)"></span>
      </div>
      <span class="nums"><b>${money(n.p10)} to ${money(n.p90)}</b>net, typically ${money(n.p50)}, ~${days} days</span>
    </div>`).join('')}
    <p class="scale-note">Bar: middle 80% of outcomes. Line: full range. Tick: typical.</p></div>`;
}

function repairTab(d) {
  const r = d.repair, a = d.assumptions, t = state.title_status, td = d.arv && d.arv.title_discount;
  const rows = r.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="amt">${money(l.low)} to ${money(l.high)}</td></tr>`).join('')
    || '<tr><td>No damaged parts</td><td class="amt">$0</td></tr>';
  const widen = r.widen.map((w) => `<tr class="widen"><td>${esc(w.reason)} (could cost more)</td><td class="amt">+${money(w.amount)}</td></tr>`).join('');
  const titleNote = td && td[1] > 0 ? `${Math.round(td[0] * 100)}–${Math.round(td[1] * 100)}% off for ${t === 'unknown' ? 'an unconfirmed' : `a ${TITLE_LABEL[t].toLowerCase()}`} title` : 'no title discount';
  return `<p class="tab-note">Parts plus labor at ${money(a.labor_rate)}/hr, paint where a panel needs it.</p>
    <table class="lines"><tbody>${rows}${widen}<tr class="total"><td>Repair estimate</td><td class="amt">${money(r.low)} to ${money(r.high)}</td></tr></tbody></table>
    <dl class="facts">
      ${d.arv ? `<div class="fact"><dt>Value after repair</dt><dd>${money(d.arv.low)} to ${money(d.arv.high)}<small>Clean wholesale less 5–12% for condition, ${esc(titleNote)}</small></dd></div>` : ''}
      ${d.as_is ? `<div class="fact"><dt>Value as-is</dt><dd>${money(d.as_is.low)} to ${money(d.as_is.high)}<small>Range of ${d.as_is.comps} salvage comps</small></dd></div>` : ''}
      <div class="fact"><dt>Costs to sell</dt><dd>${money(a.fix_selling_fee)} + ${money(a.daily_cost)}/day<small>After repair. As-is: ${money(a.as_is_fee)} fee + ${money(a.transport)} transport</small></dd></div>
    </dl>`;
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
function buildReport(d) {
  return {
    generated_at: new Date().toISOString(),
    input: { vin: state.vin, notes: state.notes, sample: state.sampleId || null },
    vehicle: state.vehicle,
    parsed: state.parsed,
    part_grades: [...state.grades].map(([part, g]) => ({ part, grade: g.grade, edited_by_reviewer: g.edited })),
    flags: state.flags,
    decision: d,
    route: state.route || null,
    engine: !state.engine ? null : state.engine.data ? { notes: state.engine.notes, ...state.engine.data } : { notes: state.engine.notes, error: state.engine.error || 'still running' },
  };
}
function downloadJson(report) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = `underscope-${report.input.vin}-${report.generated_at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render(d, first) {
  const out = $('result');
  const report = buildReport(d);
  out.hidden = false;
  const y = window.scrollY;
  const engine = state.vehicle.engine ? `<span class="vin-code">${esc(state.vehicle.engine)}</span>` : '';
  const vinWarn = state.vinOk ? '' : '<p class="notice">This VIN fails its check digit, so one character may be mistyped. The vehicle name below may be wrong.</p>';
  out.innerHTML = `
    <div class="vehbar"><h2>${esc(vehicleName())}</h2><span class="vin-code">${esc(state.vin)}</span>${engine}${titleBadge()}<span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-copy>Copy link</button>
      <button class="btn btn-ghost btn-sm" type="button" data-download>Download JSON</button></div>${vinWarn}
    ${state.route && !state.route.error
      ? `${routeHero(first)}${routeExits()}<div class="sec"><h3>Repair or sell as-is?</h3>${recBlock(d, false, true)}${rangesBlock(d)}</div>`
      : `${recBlock(d, first)}${rangesBlock(d)}${routeExits()}`}
    ${state.engine ? `<div class="sec engine" id="engine-sec">${engineBody()}</div>` : ''}
    <div class="sec"><h3>Where the numbers come from</h3>${repairTab(d)}</div>
    <div class="sec"><h3>Condition</h3>${conditionTab()}</div>
    <div class="sec"><h3>What we read from your description</h3>${readTab()}</div>
    <div class="sec"><details><summary style="cursor:pointer;color:var(--orange);font-weight:500;font-size:14px">API response (same as Download JSON)</summary><pre style="margin-top:10px">${esc(JSON.stringify(report, null, 2))}</pre></details></div>`;
  out.querySelector('[data-download]').onclick = () => downloadJson(buildReport(d)); // includes a later engine result
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
  if (q.get('notes')) { $('notes').value = q.get('notes'); await parseNow(); }
  if (q.get('run') === '1' && VIN_RE.test(vin) && q.get('notes')) $('form').requestSubmit();
})();
