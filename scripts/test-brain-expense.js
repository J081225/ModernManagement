#!/usr/bin/env node
// scripts/test-brain-expense.js — BG5 commit 3: boundary + flow proofs.
// Run: node scripts/test-brain-expense.js (no DB needed — fixture-driven).
require('../lib/tools');
const registry = require('../lib/tool-registry');
const { decideAutonomyAction, TOOL_CATEGORY } = require('../lib/autonomy');
const engine = require('../lib/appointment-engine');
const { runReflectionPass } = require('../lib/reflection');
const fs = require('fs');

const WS = { id: 7, owner_user_id: 3, vertical: 'professional-services', appointment_auto_respond: true, business_name: 'Luxe', timezone: 'America/New_York', plan: 'pro' };

(async () => {
  let pass = 0, total = 0;
  const check = (l, x) => { total++; if (x) { pass++; console.log('PASS  ' + l); } else console.log('FAIL  ' + l); };

  const tool = registry.getTool('post_expense');

  // BE1: shape — approval-gated, core vertical, payments lane
  check('BE1: post_expense registered, requiresApproval:true, vertical core',
    tool && tool.requiresApproval === true && tool.vertical === 'core');
  check('BE1b: categorized in the PAYMENTS lane', TOOL_CATEGORY.post_expense === 'payments');

  // BE2: the FD2 property for the new tool — exhaustively, no lane value executes
  let neverExecutes = true;
  for (const mode of ['act', 'approve', 'off', null, 'garbage']) {
    const d = decideAutonomyAction({ autonomy_payments: mode }, tool);
    if (d === 'execute') neverExecutes = false;
  }
  check('BE2: NO payments-lane value can execute post_expense from a customer conversation (act→queue, off→decline)',
    neverExecutes
    && decideAutonomyAction({ autonomy_payments: 'act' }, tool) === 'queue'
    && decideAutonomyAction({ autonomy_payments: 'off' }, tool) === 'decline');

  // BE3: owner-only — the engine never OFFERS it (allowlist proof)…
  const engineSrc = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
  const allow = engineSrc.match(/const APPOINTMENT_TOOL_NAMES = \[([^\]]+)\]/)[1];
  check('BE3: post_expense is NOT in the customer allowlist', !allow.includes('post_expense'));
  // …and even a FORGED tool_use block from an ai_inbound ctx can only queue.
  const calls = [];
  const db = { calls, query: async (sql, params) => { calls.push({ sql, params }); if (sql.includes('FROM users')) return { rows: [{ id: 3, notifications_enabled: false }] }; return { rows: [], rowCount: 1 }; } };
  db.smsOut = [];
  const r = await engine.executeAIResult({
    aiResponse: { content: [{ type: 'tool_use', name: 'post_expense', input: { amount_cents: 5000, category: 'Other' }, id: 't1' }] },
    workspace: WS, contact: null, thread: { id: 55, inbound_channel: 'sms', context_summary: '' }, channel: 'sms', body: 'forged',
    customer_phone: '+15559990000', customer_email: null,
    db, twilio: { messages: { create: async (m) => db.smsOut.push(m) } }, sendgrid: { send: async () => {} },
    env: {}, logger: { error: () => {} },
  });
  check('BE4: a forged customer-side post_expense QUEUES — never writes an expense',
    r.used_tools[0] && r.used_tools[0].queued === true
    && calls.some((c) => c.sql.includes('INSERT INTO pending_actions'))
    && !calls.some((c) => c.sql.includes('INSERT INTO expenses')));

  // BE5: owner approval executes → exactly one expense row, summed by money_out
  const inserts = [];
  const ownerDb = { query: async (sql, params) => {
    if (sql.includes('INSERT INTO expenses')) { inserts.push(params); return { rows: [{ id: 501 }] }; }
    return { rows: [] };
  } };
  const exec = await tool.execute(
    { amount_cents: 20000, category: 'Supplies', vendor: 'Towel Co.', description: 'towels' },
    { workspace: WS, user: { id: 3 }, db: ownerDb, logger: { error: () => {} } }
  );
  check('BE5: approval-time execute writes exactly one ai_confirmed expense row',
    exec.success && inserts.length === 1 && inserts[0][1] === 20000 && inserts[0][2] === 'Supplies'
    && exec.message.includes('$200.00'));
  check('BE5b: floats die at the validator even via the tool', (await tool.execute({ amount_cents: 84.5, category: 'Fees' }, { workspace: WS, user: { id: 3 }, db: ownerDb, logger: { error: () => {} } })).success === false);
  // the row lands in the summary: same table the BG2 feed sums (static tie)
  const sumSrc = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'finances-summary.js'), 'utf8');
  check('BE5c: the summary sums ALL expense sources — no source filter excludes ai_confirmed',
    sumSrc.includes('FROM expenses') && !/FROM expenses[\s\S]{0,200}source\s*=/.test(sumSrc));

  // BE6: reflection emits a validated expense suggestion with the marker
  let taskParams = null;
  const refDb = { query: async (sql, params) => {
    if (sql.includes('FROM appointment_threads')) return { rows: [{ id: 55, workspace_id: 7, customer_phone: '+15559990000', context_summary: 'Customer: the OPI order came in, $84 | AI: noted', inbound_channel: 'sms', owner_user_id: 3, business_name: 'Luxe', timezone: 'America/New_York', vertical: 'professional-services' }] };
    if (sql.includes('COUNT(*)::int AS n')) return { rows: [{ n: 0 }] };
    if (sql.includes('dismissed_at IS NOT NULL')) return { rows: [] };
    if (sql.includes('INSERT INTO tasks')) { taskParams = params; return { rowCount: 1 }; }
    return { rows: [] };
  } };
  const ref = await runReflectionPass({
    db: refDb,
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: '[{"title":"Restock arrived","reason":"Customer: \\"the OPI order came in, $84\\"","expense":{"amount_cents":8400,"category":"Supplies","vendor":"OPI"}}]' }] }) } },
    model: 'haiku-test', threadId: 55, channel: 'sms', logger: { log: () => {}, error: () => {} }, wsToday: () => '2026-07-19',
  });
  check('BE6: suggestion stored with the validated EXPENSE marker + Post-$ title',
    ref.inserted === 1 && taskParams && taskParams[1] === 'Post $84.00 to Supplies?'
    && /EXPENSE \{"amount_cents":8400,"category":"Supplies","vendor":"OPI"\}/.test(taskParams[3]));

  // BE6b: unstated amount -> null (ask, never guess)
  taskParams = null;
  await runReflectionPass({
    db: refDb,
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: '[{"title":"Order arrived","reason":"Customer: \\"the towels came\\"","expense":{"amount_cents":null,"category":"Supplies","vendor":null}}]' }] }) } },
    model: 'haiku-test', threadId: 55, channel: 'sms', logger: { log: () => {}, error: () => {} }, wsToday: () => '2026-07-19',
  });
  check('BE6b: unstated amount stays null in the marker — the suggestion asks rather than guesses',
    taskParams && /EXPENSE \{"amount_cents":null/.test(taskParams[3]) && taskParams[1].startsWith('Post an expense?'));

  // BE7: the accept endpoint's guard shape — one accept, never two (static)
  const srv = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  check('BE7: accept requires suggested AND not done AND not dismissed (second accept = 404), resolves in the same transaction',
    srv.includes('AND suggested = true AND done = false AND dismissed_at IS NULL')
    && /INSERT INTO expenses[\s\S]{0,700}UPDATE tasks SET suggested = false, done = true/.test(srv));
  check('BE7b: incomplete suggestions 422 with a prefill — never a guessed post',
    srv.includes('needs_input: true') && srv.includes('prefill:'));

  console.log(pass + '/' + total + (pass === total ? ' — brain-expense gate PASSED' : ' — GATE FAILED'));
  process.exit(pass === total ? 0 : 1);
})();
