// scripts/test-owner-context.js — AD9, rebuild of the lost
// `owner-context` gate. The owner-brain prompt assembly is inline in
// server.js's /api/command handler, so this is a slim gate: REPLAY the
// screen-context bounding rules (the one piece of pure logic worth
// executing) and SOURCE-PIN the assembly + the security-relevant
// invariant that the owner brain is NOT gated by the autonomy matrix.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Replay of the screenContext IIFE: bounded, named-keys-only, whole
// block capped at 600 chars.
function screenContext(body, currentPage) {
  const c = body.context;
  const cap = (v, n) => String(v == null ? '' : v).slice(0, n);
  if (!c || typeof c !== 'object') {
    return currentPage ? `The owner is currently looking at the "${cap(currentPage, 40)}" screen of the app.` : '';
  }
  const bits = [`Owner is on the "${cap(c.page || currentPage || 'unknown', 40)}" screen.`];
  if (c.calendar_view) bits.push(`Calendar ${cap(c.calendar_view, 10)} view, showing ${cap(c.calendar_range, 24)}.`);
  if (c.selected_day) bits.push(`Selected day: ${cap(c.selected_day, 12)}.`);
  if (c.open_contact && typeof c.open_contact === 'object') {
    bits.push(`Open contact: #${cap(c.open_contact.id, 12)} "${cap(c.open_contact.name, 40)}".`);
  }
  if (c.period) bits.push(`Visible finance period: ${cap(c.period, 10)}.`);
  return bits.join(' ').slice(0, 600);
}

(async () => {
  // ---- OC1: no context object -> a page-only line, or empty ----
  {
    check('OC1: absent/invalid context -> the page-only line when a page is known, else empty',
      screenContext({}, 'calendar') === 'The owner is currently looking at the "calendar" screen of the app.'
        && screenContext({}, null) === '');
  }

  // ---- OC2: a rich context renders only named keys ----
  {
    const s = screenContext({ context: { page: 'calendar', calendar_view: 'week', calendar_range: 'Aug 3-9', selected_day: '2026-08-05', period: 'month', junk: 'IGNORED' } }, null);
    check('OC2: named keys render; unknown keys ("junk") are ignored',
      s.includes('Owner is on the "calendar"') && s.includes('Calendar week view') && s.includes('Selected day: 2026-08-05')
        && s.includes('Visible finance period: month') && !s.includes('IGNORED'));
  }

  // ---- OC3: every field is length-capped, and the whole block caps at 600 ----
  {
    const s = screenContext({ context: { page: 'x'.repeat(200), open_contact: { id: '9', name: 'N'.repeat(200) } } }, null);
    check('OC3: the page slice caps at 40, the contact name at 40, and the whole block never exceeds 600 chars',
      !s.includes('x'.repeat(41)) && !s.includes('N'.repeat(41)) && s.length <= 600,
      'len=' + s.length);
  }

  // ---- OC4: source-pin — businessFraming is vertical-aware ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const idx = src.indexOf('const businessFraming =');
    const block = src.slice(idx, idx + 1200);
    const ps = block.includes('service business') && block.includes('"customers"') && block.includes('services and products');
    const pm = block.includes('property management') || block.includes('property managers');
    check('OC4: businessFraming frames PS as a service business (customers/services) and PM as property management — one owner brain, two vocabularies',
      idx !== -1 && ps && pm, JSON.stringify({ ps, pm }));
  }

  // ---- OC5: source-pin — systemPrompt stitches framing + snapshot + time anchor + screen context ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const idx = src.indexOf('const systemPrompt = `${businessFraming}');
    const block = src.slice(idx, idx + 700);
    // OC5 [evolved HN3]: the anchor is now computed ONCE from
    // _workspaceRow above the template and used twice — in this
    // prompt and again on the live turn, where it outranks replayed
    // history. Same intent (the prompt carries the ws-timezone
    // anchor), stronger guarantee.
    const anchorFromWorkspace = src.includes('const _timeAnchor = require(\'./lib/time-helpers\').promptTimeAnchor(_workspaceRow)');
    const anchorInPrompt = block.includes('${_timeAnchor.tz}') && block.includes('${_timeAnchor.nowInTz}');
    const anchorOnLiveTurn = src.includes('[Current date and time: ${_timeAnchor.nowInTz}');
    check('OC5 [evolved HN3]: systemPrompt embeds businessFraming, contextSummary, the ws-timezone anchor and screenContext — and the anchor, computed once from _workspaceRow, ALSO rides the live turn so history cannot outrank it',
      idx !== -1 && block.includes('${contextSummary}') && block.includes('${screenContext}')
        && anchorFromWorkspace && anchorInPrompt && anchorOnLiveTurn,
      JSON.stringify({ anchorFromWorkspace, anchorInPrompt, anchorOnLiveTurn }));
  }

  // ---- OC6: source-pin — the OWNER brain is NOT gated by the autonomy matrix ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cmdIdx = src.indexOf("app.post('/api/command'");
    // The command handler is large; scan a generous window for the
    // matrix choke-point call. It must NOT appear — the matrix governs
    // ai_inbound customer conversations only (lib/autonomy header).
    const block = src.slice(cmdIdx, cmdIdx + 46000);
    check('OC6: /api/command never calls decideAutonomyAction — the owner commanding their own app is not customer-gated (the FD3-CP3 invariant)',
      cmdIdx !== -1 && !block.includes('decideAutonomyAction'));
  }

  // ---- OC7: source-pin — relative references resolve from screen context, never guessed ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('OC7: the prompt instructs resolving "this Friday"/"them"/"this appointment" from screen context and asking ONE question rather than guessing a target',
      src.includes('resolve them from the screen context above') && src.includes('never guess a date or which existing record was meant'));
  }

  console.log(`${pass}/${pass + fail} — owner-context gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
