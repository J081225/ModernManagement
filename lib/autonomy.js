// lib/autonomy.js — FD3-CP3 autonomy matrix.
//
// Per-category policy for the CUSTOMER-facing brain: what the AI may
// do on its own (act), what waits for the owner (approve), and what it
// must decline (off). The owner's own commands (/api/command) are
// NEVER gated by this matrix — it governs ai_inbound conversations
// only, enforced at one choke point in the engine's tool loop.
//
// Defaults reproduce pre-matrix behavior exactly: bookings, contacts,
// and tasks acted immediately; payment actions were approval-gated.

const CATEGORIES = ['bookings', 'contacts', 'tasks', 'payments'];
const MODES = ['act', 'approve', 'off'];

const DEFAULTS = {
  bookings: 'act',
  contacts: 'act',
  tasks: 'act',
  payments: 'approve',
};

// Tool → category. Tools not listed (read-only lookups, escalation)
// are uncategorized and always allowed to run for customers that can
// reach them at all — reachability itself is still the FD2 allowlist's
// job, not this map's.
const TOOL_CATEGORY = {
  book_appointment: 'bookings',
  update_appointment: 'bookings',
  cancel_appointment: 'bookings',
  add_contact: 'contacts',
  update_contact: 'contacts',
  add_task: 'tasks',
  update_task: 'tasks',
  delete_task: 'tasks',
  refund_transaction: 'payments',
  request_payments_batch: 'payments',
};

function categoryFor(toolName) {
  return TOOL_CATEGORY[toolName] || null;
}

function autonomyMode(workspace, toolName) {
  const cat = categoryFor(toolName);
  if (!cat) return 'act';
  const stored = workspace && workspace['autonomy_' + cat];
  return MODES.includes(stored) ? stored : DEFAULTS[cat];
}

// The single decision the engine's choke point consults.
//   'execute' — run the tool now
//   'queue'   — insert into pending_actions; the ONLY execution path
//               from there is the owner's authenticated approve
//               endpoint, so a customer conversation still can never
//               EXECUTE an approval-gated action (the FD2 property).
//   'decline' — polite no + message-taking
// tool.requiresApproval always at least queues, regardless of an
// 'act' category — approval-gated tools never execute from a customer
// conversation under any matrix setting.
function decideAutonomyAction(workspace, tool) {
  const mode = autonomyMode(workspace, tool.name);
  if (mode === 'off') return 'decline';
  if (mode === 'approve' || tool.requiresApproval) return 'queue';
  return 'execute';
}

module.exports = { CATEGORIES, MODES, DEFAULTS, TOOL_CATEGORY, categoryFor, autonomyMode, decideAutonomyAction };
