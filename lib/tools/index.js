// lib/tools/index.js
//
// Importing this file registers every tool with the central registry.
// Add new tools by creating a file in this directory and adding a
// require() line below.

require('./add_calendar_event');
require('./delete_calendar_event');
require('./add_task');
require('./update_task');
require('./add_contact');
require('./update_contact');

// Session B3 — Tier 1: simple single-table operations
require('./add_budget_transaction');
require('./add_maintenance_ticket');
require('./compose_message');

// Session B3 — Tier 2: fuzzy-match against context
require('./mark_rent_paid');
require('./send_late_notice');
require('./generate_rent');

// Session B3 — Tier 3: property + unit CRUD (workspace_id-scoped)
require('./create_property');
require('./update_property');
require('./archive_property');
require('./create_unit');
require('./update_unit');
require('./set_unit_off_market');
require('./retire_unit');

// Session B3 — Tier 4: engagement triplet (state-sensitive)
require('./assign_tenant_to_unit');
require('./move_tenant_to_unit');
require('./end_tenant_assignment');

// Session B4: reports
require('./generate_report');

// Session C2: maintenance lifecycle + invoice tools
require('./update_maintenance_ticket');
require('./resolve_maintenance_ticket');
require('./add_invoice');
require('./update_invoice_status');

// Session C3: outbound communication tools (all requiresApproval=true)
require('./send_sms');
require('./send_email');
require('./send_broadcast');
require('./reply_to_message');
