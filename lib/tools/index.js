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

// Session E2: Professional Services appointment tools
require('./book_appointment');
require('./update_appointment');
require('./cancel_appointment');
require('./complete_appointment');
require('./propose_appointment_times');
require('./escalate_appointment_to_owner');

// Session E3: Professional Services transaction tools
require('./create_transaction');
require('./update_transaction');
require('./complete_transaction');
require('./void_transaction');
require('./find_transaction');
require('./find_outstanding_balance');
require('./request_payments_batch');

// Session E4: Professional Services menu, inventory, and vendor tools
require('./add_menu_item');
require('./update_menu_item');
require('./archive_menu_item');
require('./update_inventory_status');
require('./add_inventory_item'); // E6: missing inventory tool from E4
require('./add_vendor');
require('./update_vendor');
require('./message_vendor_for_restock');
require('./find_menu_item');

// AP3: read tools (owner-side parity wrappers)
require('./find_task');
require('./find_contact');
require('./find_inventory_item');
require('./find_vendor');
require('./delete_task');
require('./delete_contact');
require('./archive_inventory_item');
require('./archive_vendor');
require('./update_ai_settings');
require('./update_knowledge');
require('./refund_transaction');

// FD3-CP5: day-of logistics — timestamped note on a TODAY appointment.
require('./append_appointment_note');
