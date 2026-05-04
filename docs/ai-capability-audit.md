# Modern Management — AI Capability Audit

**Date:** 2026-05-03
**Codebase state:** branch `feat/multi-customer-infrastructure` @ `36b3f52` (working tree has uncommitted changes to `views/app.html`)
**Auditor:** Coding agent (read-only audit pass)

## Executive summary

AI coverage today is partial and ad-hoc. There are **19 AI tools** wired up to the home-page command bar, all hardcoded as a single inline array inside one Express route ([server.js:3185–3472](../server.js#L3185-L3472)) and all property-management-specific. There is no tool registry, no vertical awareness, and no approval-workflow infrastructure — every tool the AI calls executes immediately. The biggest single bug class is **API/tool schema mismatch**: the AI tool definitions list only the truly required fields (e.g. `create_property` requires `name`), but the underlying API endpoints reject the request when other fields are blank (`POST /api/entities` requires both name AND address). That's why "Create a property named Sunset" fails today. The biggest gap is on the Inbox, Operations, and Admin pages — none of their settings-style actions (mark message reviewed, save automation mode, save notification email, generate rent for a month is the only one wired) are reachable from the command bar. The recommended next step is a small fix-it pass on the partial-input bugs (Quick Wins — under an hour each) followed by a tool-registry refactor that makes vertical-awareness and approval workflows possible.

---

## Step 1 — User actions per page

Inventoried by reading `views/app.html` and matching `onclick`/`onsubmit`/`onchange` handlers to backend endpoints in `server.js`.

### Home (`#page-home`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Upload banner photo | Hero banner | file | — | (localStorage only) | update |
| Edit property name | Hero banner | name (prompt) | sub | (localStorage only) | update |
| Submit AI command | Ask AI card | prompt | — | `POST /api/command` | external-facing (AI) |
| Toggle dictation | Ask AI card | (mic permission) | — | (browser SpeechRecognition) | update (UI) |
| Generate property report | Property Report card | — | — | `POST /api/report` | read (AI synthesis) |
| Navigate to inbox/tasks/contacts/calendar | Stat tiles + Quick-access tiles | — | — | (client-side route) | read |
| View lease expirations | Lease Expirations card | — | — | `GET /api/leases` | read |

### Inbox (`#page-inbox`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Switch folder (inbox / archive / deleted) | Folder sidebar | folder | — | `GET /api/messages?folder=` | read |
| Empty trash | Folder sidebar | (confirm) | — | `DELETE /api/messages/folder/deleted` | delete |
| Open message | Message list | id | — | `GET /api/messages/:id` | read |
| Move message → folder | Message list / detail | folder | — | `PUT /api/messages/:id/folder` | update |
| Permanent delete | Message list / detail | (confirm) | — | `DELETE /api/messages/:id` | delete |
| Mark emergency reviewed | Detail emergency banner | — | — | `POST /api/messages/:id/clear-emergency` | update |
| Generate AI draft reply | Detail | messageId | — | `POST /api/generate` | external-facing (AI) |
| Send draft (email or SMS) | Draft area | body, channel | — | `POST /api/email/send` or `POST /api/sms/send` | external-facing |
| Reply via SMS (ad-hoc) | Detail | body | — | `POST /api/sms/send` | external-facing |
| Reply via email (ad-hoc) | Detail | subject, body | — | `POST /api/email/send` | external-facing |
| Set message status | (called by send flows) | status | — | `PUT /api/messages/:id/status` | update |

### Operations (`#page-operations`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Save automation mode (auto/review) | Automation card | autoReplyEnabled | — | `PUT /api/automation` | update |
| Submit auto-reply consent | Consent modal | (checkbox) | — | `POST /api/automation/consent` | update (legal) |
| Connect property email (test) | Email connection | email, password | imap/smtp | `POST /api/email-account/test` | external-facing |
| Connect property email (save) | Email connection | email, password | imap/smtp | `POST /api/email-account/connect` | external-facing |
| Sync inbox now | Email connection | — | — | `POST /api/email-account/sync` | external-facing |
| Disconnect email | Email connection | (confirm) | — | `DELETE /api/email-account` | delete |
| Detect provider preview | Email connection | email | — | `GET /api/email-account/detect` | read |
| Add knowledge document (manual) | Knowledge base | title, content | type | `POST /api/knowledge` | create |
| Upload knowledge file (PDF/TXT) | Knowledge base | file | — | `POST /api/knowledge/upload` | create |
| Delete knowledge document | Knowledge base | (confirm) | — | `DELETE /api/knowledge/:id` | delete |

### Calendar (`#page-calendar`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Change month | Calendar nav | direction | — | (client-only) | read |
| Select day | Day cell | dateStr | — | (client-only) | read |
| Add event | Add Event modal / Day panel | title, date | (also-task flag, category) | `POST /api/calevents` | create |
| Add task on date | Day panel | dateStr | — | (jumps to Tasks page) | navigation |
| Delete event | Day panel | id | — | `DELETE /api/calevents/:id` | delete |

### Admin (`#page-admin`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Save notification settings | Notification card | — | notification_email, alert_phone, notifications_enabled | `PUT /api/settings` | update |
| Copy forwarding address | Auto-Match Payments | — | — | (clipboard) | read |
| Refresh payment events | Auto-Match Payments | — | — | `GET /api/payments/events` | read |
| Confirm payment match | Auto-Match Payments event row | id | — | `POST /api/payments/events/:id/confirm` | financial |
| Dismiss payment event | Auto-Match Payments event row | id | — | `POST /api/payments/events/:id/dismiss` | update |
| Test payment email | Auto-Match Payments details | body | subject, from | `POST /api/payments/test` | external-facing (AI) |
| Generate monthly rent | Rent Payments | month, year | due_day | `POST /api/rent/generate-month` | financial |
| Add rent record | Add Rent modal | resident, amount | unit, due_date, notes | `POST /api/rent` | financial |
| Mark rent paid | Rent table row | id | — | `PUT /api/rent/:id` | financial |
| Send late notice | Rent table row | id | — | `POST /api/rent/:id/late-notice` | external-facing |
| Delete rent record | Rent table row | (confirm) | — | `DELETE /api/rent/:id` | delete |
| Add invoice | Add Invoice modal | vendor, amount | description, date, notes | `POST /api/invoices` | financial |
| Update invoice status | Invoice table row | status | — | `PUT /api/invoices/:id` | financial |
| Delete invoice | Invoice table row | (confirm) | — | `DELETE /api/invoices/:id` | delete |
| Filter budget by month/year/type | Budget controls | month, year | type | `GET /api/budget?month=&year=` | read |
| Add budget transaction | Add Tx modal | type, category, description, amount, date | notes | `POST /api/budget` | financial |
| Delete transaction | Budget table row | (confirm) | — | `DELETE /api/budget/:id` | delete |
| Start Stripe upgrade | Plan & Billing | — | — | `POST /api/billing/create-checkout` | financial |
| Open Stripe portal | Plan & Billing | — | — | `GET /api/billing/portal` | read |

### Maintenance (`#page-maintenance`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Filter tickets | Filter dropdown | filter | — | (client-only) | read |
| New ticket | New Ticket modal | title | description, unit, resident, category | `POST /api/maintenance` | create |
| Update ticket | Update modal | id | status, outcome, requires_action, action_notes | `PUT /api/maintenance/:id` | update |
| Quick-update status | Ticket card dropdown | id, status | — | `PUT /api/maintenance/:id` | update |
| Delete ticket | Ticket card | (confirm) | — | `DELETE /api/maintenance/:id` | delete |

### Contacts (`#page-contacts`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Search/filter contacts | Search + filter buttons | query | — | (client-only) | read |
| Select contact | Contact card | id | — | (client-only) | read |
| Add contact | Add Contact modal | name, type | unit dropdown, email, phone, notes, lease_start, lease_end, monthly_rent | `POST /api/contacts` | create |
| Edit contact | Edit Contact modal | id, name, type | (same as Add) | `PUT /api/contacts/:id` | update |
| Delete contact | Detail panel | (confirm) | — | `DELETE /api/contacts/:id` | delete |
| Import contacts (CSV) | Import button | file | — | `POST /api/contacts/import` | create (bulk) |
| Compose to contact | Detail panel | subject, text | — | (creates message in inbox) | external-facing (limited) |
| Send broadcast | Broadcast modal | channel, body, recipientFilter | subject (email) | `POST /api/broadcast` | external-facing |

### Inventory (`#page-inventory`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| List properties | Properties grid | — | — | `GET /api/entities` | read |
| Open property detail | Property card | id | — | `GET /api/entities/:id` | read |
| Add property | Add Property modal | name, address | building_type, year_built, number_of_floors, total_unit_count, description | `POST /api/entities` | create |
| Edit property | Edit form | name, address | (all metadata) | `PATCH /api/entities/:id` | update |
| Archive property | Detail header | (confirm) | — | `DELETE /api/entities/:id` | delete (soft) |
| List units | Property detail | entity_id | — | `GET /api/offerings` | read |
| Add unit | Add Unit modal | name | description, floor, bedrooms, bathrooms, sqft, rent, frequency, amenities, notes, tenant | `POST /api/offerings` | create |
| Edit unit | Edit unit form | name | (all metadata) | `PATCH /api/offerings/:id` | update |
| Set unit off-market | Edit unit form | off_market flag | — | `PATCH /api/offerings/:id` | update |
| Retire unit | Detail header | (confirm) | — | `DELETE /api/offerings/:id` | delete (soft) |
| Open unit detail | Units row | id | — | `GET /api/offerings/:id` | read |
| Assign tenant to unit | Tenant dropdown (unit edit OR contact edit) | contact_id, offering_id | start_date, end_date, current_price | `POST /api/engagements` | create |
| Move tenant | (composite via reconciler) | — | — | `PATCH /api/engagements/:id` + `POST /api/engagements` | update |
| End tenant assignment | (composite via reconciler) | engagement id | — | `PATCH /api/engagements/:id` | update |

### Tasks (`#page-tasks`)

| Action | Where | Required | Optional | Endpoint | Category |
|---|---|---|---|---|---|
| Filter tasks (all/pending/done/overdue) | Filter buttons | filter | — | (client-only) | read |
| Add task | New Task card | title, dueDate | category, notes | `POST /api/tasks` | create |
| Toggle task done | Task row checkbox | id | — | `PUT /api/tasks/:id` | update |
| Delete task | Task row × | id | — | `DELETE /api/tasks/:id` | delete |
| Approve AI-suggested task | Suggested section | id | — | `PUT /api/tasks/:id/approve` | update |
| Reject AI-suggested task | Suggested section | id | — | `DELETE /api/tasks/:id/reject` | delete |

---

## Step 2 — Current AI capabilities

### Where the AI lives

There are **five distinct Anthropic API call sites**, each with its own inline system prompt:

| Site | File:Line | Purpose | Tool calls allowed? |
|---|---|---|---|
| `/api/command` | [server.js:3139](../server.js#L3139) | Home command-bar AI assistant | **Yes** — 19 tools |
| `/api/generate` | [server.js:3091](../server.js#L3091) | Inbox draft-reply generator | No |
| `/api/report` | [server.js:4197](../server.js#L4197) | Property report synthesis | No |
| `autoReplyToMessage()` | [server.js:3723](../server.js#L3723) | Auto-send AI reply to inbound message | No |
| `parsePaymentEmail()` | [server.js:3769](../server.js#L3769) | Extract structured payment data | No (returns JSON) |
| `suggestTasksFromConversation()` | [server.js:3557](../server.js#L3557) | Generate task suggestions from comms | No (returns JSON) |

There is **no tool registry**. The 19 tools are defined as a single inline `const tools = [...]` array starting at [server.js:3185](../server.js#L3185). They are passed verbatim to both the initial `messages.create` call and the follow-up "tool result" round-trip.

### The 19 registered AI tools

All 19 are reachable only via `/api/command` (the Home page command bar). Each row notes whether the tool gracefully accepts partial input or refuses.

| Tool name | Description | Required (per AI schema) | Optional | What it actually does | Page | Category | Failure on partial? |
|---|---|---|---|---|---|---|---|
| `add_calendar_event` | Add an event to the calendar | title, date | — | `INSERT INTO cal_events` | Calendar | create | No (all required) |
| `add_task` | Create a new task | title, category, dueDate | notes | `INSERT INTO tasks` | Tasks | create | No (all required) |
| `compose_message` | Save a message in the inbox | to, subject, body | — | `INSERT INTO messages` | Inbox | create | No (all required) |
| `add_contact` | Add resident/vendor/important | name, contact_type | unit, email, phone, monthly_rent, lease_start, lease_end, notes | `INSERT INTO contacts` | Contacts | create | Soft — accepts blank optionals |
| `mark_rent_paid` | Mark rent paid | resident | unit | Looks up rent rows by name; `PUT /api/rent/:id` | Admin/Home | financial | No |
| `send_late_notice` | Send payment reminder | resident | unit | `POST /api/rent/:id/late-notice` (sends SMS or email) | Admin/Home | external-facing | No |
| `add_budget_transaction` | Log income/expense | transaction_type, category, description, amount, date | notes | `INSERT INTO budget_transactions` | Admin | financial | No (all required) |
| `add_maintenance_ticket` | Create maintenance ticket | title | description, unit, resident, category | `INSERT INTO maintenance_tickets` (may auto-trigger emergency SMS) | Maintenance | create + external-facing | Soft |
| `generate_rent` | Generate monthly rent records | month, year | due_day | `POST /api/rent/generate-month` (bulk insert) | Admin | financial | Soft |
| `create_property` | Create a property | name | address, building_type, year_built, number_of_floors, total_unit_count, description | `POST /api/entities` | Inventory | create | **YES — API requires address** ([server.js:1893](../server.js#L1893)) |
| `update_property` | Update a property | property | name, address, description, building_type, year_built, number_of_floors, total_unit_count, heating_system, water_source, parking_setup, pet_policy, smoking_policy | `PATCH /api/entities/:id` (only sets present fields) | Inventory | update | Soft (PATCH only updates present fields) |
| `archive_property` | Soft-delete a property | property | — | `DELETE /api/entities/:id` (sets `archived_at`) | Inventory | delete | Soft |
| `create_unit` | Create a unit | property, name | description, floor, rent, frequency, bedrooms, bathrooms, sqft, amenities, notes | `POST /api/offerings` | Inventory | create | Soft (only name + entity_id required by API) |
| `update_unit` | Update a unit | unit | (lots) | `PATCH /api/offerings/:id` | Inventory | update | Soft |
| `set_unit_off_market` | Toggle off-market flag | unit, off_market | property | `PATCH /api/offerings/:id` with status | Inventory | update | Soft |
| `retire_unit` | Soft-delete a unit | unit | property | `DELETE /api/offerings/:id` (status='retired') | Inventory | delete | Soft |
| `assign_tenant_to_unit` | Create active engagement | tenant, unit | property, start_date, end_date, rent | `POST /api/engagements` | Inventory + Contacts | create | Soft (defaults from contact lease dates) |
| `move_tenant_to_unit` | Atomic move | tenant, unit | property | PATCH old engagement → terminated; POST new | Inventory + Contacts | update | Soft |
| `end_tenant_assignment` | Terminate active engagement | tenant | — | `PATCH /api/engagements/:id` to status=terminated | Inventory + Contacts | update | Soft |

### How tool results flow back to the AI

The pattern in [server.js:3526–3547](../server.js#L3526-L3547):

```js
if (actions.length && response.stop_reason === 'tool_use') {
  const toolResults = actions.map(a => ({
    type: 'tool_result',
    tool_use_id: response.content.find(b => b.type === 'tool_use' && b.name === a.type)?.id || '',
    content: `Successfully executed ${a.type}`
  }));
  const followUp = await anthropic.messages.create({ ... });
}
```

**The server reports "Successfully executed X" to the AI even though it has not yet executed anything.** The actual execution happens client-side in `applyActions()` in [views/app.html](../views/app.html). The AI's follow-up text is generated assuming success regardless of what actually happens. If a tool fails client-side (e.g. `create_property` 400s on missing address), the user sees a warning chip but the AI's "Done!" reply is already written.

This is a meaningful architectural quirk — the AI never learns from failed actions, can't retry intelligently, can't ask for clarification after a failure.

### Where execution actually happens

`applyActions()` lives in `views/app.html` inside the `submitHomeCommand` flow. It dispatches each `action.type` through a giant `if/else if` chain that calls the matching `/api/*` endpoint. Every action runs **immediately** with no confirmation step.

---

## Step 3 — Gap analysis

Sorted by Page → Operation category (read, create, update, delete, financial, external-facing).

| Page | User action | Category | AI capability today | Notes |
|---|---|---|---|---|
| Home | Submit AI command | external-facing | Full match | This IS the command bar |
| Home | Generate property report | read | Partial — limited | Can be triggered by AI saying "generate report" only if user clicks button; no `generate_report` tool |
| Home | Upload banner photo | update | None | Low value (manual UI gesture) |
| Home | Edit property name | update | None | Low value (no tool needed for branding) |
| Inbox | Switch folder | read | None | Could be useful: "show me archived messages" |
| Inbox | Open message | read | None | "What's the latest message from Maria?" — context already includes message subjects, but no `read_message_full` tool |
| Inbox | Generate AI draft | external-facing | Partial — limited | `/api/generate` exists separately; not callable as a command-bar tool |
| Inbox | Send draft / SMS / email reply | external-facing | None | High-value gap — "reply to Maria saying we'll send a plumber Tuesday" cannot be done via command bar |
| Inbox | Move to folder / delete / restore | update / delete | None | Medium-value batch ops gap |
| Inbox | Mark emergency reviewed | update | None | Low priority |
| Operations | Save automation mode | update | None | "Turn on auto-reply" — should be possible |
| Operations | Add knowledge document | create | None | "Add a policy: pets allowed under 25lbs" — should be possible |
| Operations | Upload knowledge file | create | None | File upload via AI is hard; deferred |
| Operations | Connect/disconnect email | external-facing | None | Sensitive (credentials); intentional skip |
| Calendar | Add event | create | Full match | `add_calendar_event` |
| Calendar | Delete event | delete | None | "Cancel the board meeting on May 5" — useful |
| Calendar | Change month / select day | read | None | Trivial; UI-only is fine |
| Admin | Save notification settings | update | None | "Send notifications to alex@example.com" — useful |
| Admin | Test payment email | external-facing | None | Backend test endpoint; low value to wire up |
| Admin | Confirm/dismiss payment event | financial | None | Useful: "confirm the Zelle from Maria" |
| Admin | Generate monthly rent | financial | Full match | `generate_rent` |
| Admin | Add rent record | financial | None | Useful for ad-hoc records ("add March rent of $1500 for Alex") |
| Admin | Mark rent paid | financial | Full match | `mark_rent_paid` |
| Admin | Send late notice | external-facing | Full match | `send_late_notice` |
| Admin | Add invoice | financial | None | Common gap — "add a $400 invoice from AcePlumbing" |
| Admin | Update invoice status (approve/reject) | financial | None | Useful: "approve all pending invoices under $200" |
| Admin | Add budget transaction | financial | Full match | `add_budget_transaction` |
| Admin | Delete rent / invoice / transaction | delete | None | Sensitive; manual is fine |
| Admin | Stripe upgrade / portal | financial | None | Intentional skip (paywall flow) |
| Maintenance | Filter tickets | read | None | "Show me open emergency tickets" — answerable from context, no tool needed |
| Maintenance | Create ticket | create | Full match | `add_maintenance_ticket` |
| Maintenance | Update ticket (status, outcome) | update | None | Useful: "mark ticket #14 resolved with note 'fixed leak'" |
| Maintenance | Delete ticket | delete | None | Manual is fine |
| Contacts | Search/filter | read | Partial — context | Snapshot includes contacts; AI can answer from context |
| Contacts | Add contact | create | Full match | `add_contact` |
| Contacts | Edit contact | update | None | Important gap — "update Maria's phone to 555-1234" |
| Contacts | Delete contact | delete | None | Manual is fine |
| Contacts | Import CSV | create (bulk) | None | File upload; deferred |
| Contacts | Compose message to contact | external-facing | Full match | `compose_message` |
| Contacts | Send broadcast | external-facing | None | High-value gap — "email all residents about Saturday's water shutoff" |
| Inventory | List/view properties + units | read | Partial — context | Snapshot includes properties + units; can answer most read questions |
| Inventory | Add property | create | Partial — bug | `create_property` exists, but **fails if address is blank** (API rejects) |
| Inventory | Edit property | update | Full match | `update_property` |
| Inventory | Archive property | delete | Full match | `archive_property` |
| Inventory | Add unit | create | Full match | `create_unit` |
| Inventory | Edit unit | update | Full match | `update_unit` |
| Inventory | Set off-market | update | Full match | `set_unit_off_market` |
| Inventory | Retire unit | delete | Full match | `retire_unit` |
| Inventory | Assign / move / end tenant | create / update | Full match | `assign_tenant_to_unit`, `move_tenant_to_unit`, `end_tenant_assignment` |
| Tasks | Filter tasks | read | Partial — context | Snapshot has tasks |
| Tasks | Add task | create | Full match | `add_task` |
| Tasks | Toggle task done | update | None | "Mark the insurance task done" — common request |
| Tasks | Delete task | delete | None | Manual is fine |
| Tasks | Approve / reject AI suggestion | update / delete | None | Manual UX is appropriate |

### Summary counts

- **Total user actions identified:** ~80 (across 9 pages, deduplicated)
- **Total AI capabilities identified:** 19 tools + 5 non-tool AI flows = 24 distinct AI surfaces
- **Full matches:** ~17
- **Partial matches:** ~6 (mostly read questions answerable from context)
- **Gaps:** ~57

### Top 5 highest-value gaps

These rank highest because each one removes friction from a daily workflow and is a natural thing to ask the AI in plain English.

1. **Reply to inbox message via command bar.** Today: open inbox, find message, click reply, type. Future: "Reply to Maria saying we'll send a plumber Tuesday" → AI uses `/api/sms/send` or `/api/email/send`. No tool exists for this. Highest day-to-day friction win.
2. **Send broadcast via command bar.** "Email all residents that water will be off Saturday 9am-noon." Today requires opening Contacts → Broadcast modal, picking filter, writing subject + body. AI could capture the entire intent in one sentence.
3. **Update task / mark done.** Tasks accumulate; "mark the insurance renewal task done" is the most common state-change request that has no tool today.
4. **Update contact fields.** "Set Alex Rivera's phone to 555-1234" or "extend Maria's lease to Dec 31 2026." `update_contact` doesn't exist — the only contact tool is `add_contact`.
5. **Update / resolve maintenance ticket.** "Mark ticket #14 resolved with outcome 'fixed leak'." `add_maintenance_ticket` exists but no `update_maintenance_ticket`. Maintenance lifecycle is naturally voice-friendly.

### Actions where AI should NOT be wired up

- **Stripe checkout / billing portal** — payment flows must be initiated explicitly by the user.
- **Connect/disconnect email account** — credentials handling, sensitive.
- **Permanent message delete / empty trash** — destructive + irreversible.
- **CSV import** — file upload from a chat surface is awkward; let users use the dedicated UI.
- **Banner photo upload** — visual gesture, not a textual command.
- **Stripe subscription management** — same reasoning as billing.

---

## Step 4 — Architectural observations

### Tool registry: hardcoded inline, not registry-based

There is no registry. Tools are a literal array inside the `/api/command` route handler:

```js
// server.js:3185
const tools = [
  { name: 'add_calendar_event', description: '...', input_schema: {...} },
  { name: 'add_task', description: '...', input_schema: {...} },
  // ...17 more...
];
```

The system prompt at [server.js:3478–3506](../server.js#L3478-L3506) hardcodes a description of every tool inline below the dynamic context block. Adding a tool means editing three places: the inline tools array, the system prompt's tool list, and `applyActions()` in `views/app.html`.

### Vertical-awareness: none

`grep -r vertical server.js` returns no business-logic hits. The `workspaces` table (referenced at [server.js:160](../server.js#L160), [server.js:1395](../server.js#L1395), [server.js:4019–4025](../server.js#L4019-L4025)) does not appear to have a `vertical` column based on the schema introspection in scope. Table comments make the assumption explicit:

```js
// server.js:1849
// --- Inventory: Entities (Properties in PM vertical) ---
// server.js:2017
// --- Inventory: Offerings (Units in PM vertical) ---
// server.js:2249
// --- Inventory: Engagements (Tenancies in PM vertical) ---
```

The schema names (`entities` / `offerings` / `engagements`) are vertical-agnostic by design, but every other table (`rent_payments`, `maintenance_tickets`, `leases` view, `contacts.lease_end`, `contacts.monthly_rent`) bakes in property-management terms.

### Where the AI prompt is assembled

Home-page command-bar AI prompt: assembled inline at [server.js:3478–3506](../server.js#L3478-L3506). The prompt opens with:

> `You are an AI command center assistant for a property management app called Modern Management. You help property managers get things done by taking action within the app.`

This string would need to be parameterized for any other vertical.

### Context passed to the AI per request

Per [server.js:3147–3178](../server.js#L3147-L3178), the system prompt for `/api/command` includes:

- Knowledge base documents (full content, not just titles)
- All contacts (name, type, unit, email, phone, monthly_rent, lease_end)
- All calendar events (date + title)
- All tasks (status, title, dueDate)
- Inbox messages (id, sender, subject, status — no body)
- Rent records for the current month (resident, unit, amount, due_date, status)
- Open maintenance tickets (id, title, unit, priority)
- Properties (id, name, address, building_type, year_built, floors, unit count)
- Units (id, name, property name, bedrooms, bathrooms, sqft, rent, frequency, occupancy state)

Notably **not** included: workspace metadata, user identity beyond the session, automation settings, broadcast history, payment events, knowledge document IDs.

A comment at [server.js:3179–3183](../server.js#L3179-L3183) flags the snapshot will get unwieldy beyond ~200 units.

### Tool result format

When the AI calls a tool, the server records `actions.push({ type: block.name, ...block.input })` ([server.js:3518](../server.js#L3518)) and reports a synthetic `"Successfully executed ${a.type}"` back to the AI in the follow-up call ([server.js:3530](../server.js#L3530)). The AI never sees the actual result, the actual error, or any returned record. This is a fundamental limitation that prevents intelligent retry / clarification.

### Approval workflow: none

All tools execute the moment `applyActions()` reaches them in `views/app.html`. There is no "AI proposes → user confirms → executes" flow. The closest thing is the AI-suggested tasks feature ([server.js:3557](../server.js#L3557)), where Claude generates task suggestions from inbox conversations and the user clicks Approve/Reject in the Tasks page UI. That's a different shape (asynchronous, off-thread, page-based) and doesn't generalize.

### Where a registry refactor would insert itself

Three files would need to change to introduce a vertical-aware capability registry:

1. **New: `lib/tool-registry.js`** — single source of truth. Each tool definition lives in its own module, with the schema, the system-prompt one-liner, the executor function, and a `vertical` tag. The registry exposes `getToolsForVertical('property-management')` and `executeTool(name, input, ctx)`.
2. **`server.js`** at the `/api/command` route ([line 3139](../server.js#L3139)) — replace the inline `const tools = [...]` array with `const tools = registry.getToolsForVertical(workspace.vertical)`. Replace the synthetic "Successfully executed" follow-up with a real call into `registry.executeTool(...)` server-side, so the AI sees actual outcomes.
3. **`views/app.html`** — collapse the giant `applyActions()` if/else chain into a single dispatcher that posts to a new `/api/command/execute-action` endpoint. The frontend stops carrying tool-specific knowledge.

A fourth, optional change: add a `pending_actions` table for an approval-workflow tier — actions tagged "requires_approval" land there, the user sees them in a queue, confirms or rejects, and only then does the executor fire.

---

## Step 5 — Partial-input failure inventory

Bugs where the AI tool definition allows partial input but the underlying API or DB rejects it.

| Tool | What it currently rejects | Where the rejection happens | What it should do instead |
|---|---|---|---|
| `create_property` | Missing `address` | `POST /api/entities` returns 400 at [server.js:1893](../server.js#L1893): `if (!address) return res.status(400).json({ error: 'address is required' });` | Drop the address requirement. AI tool schema says only `name` is required; API should match. Save what's provided, leave the rest blank. |
| `add_calendar_event` | Missing `date` (only allows YYYY-MM-DD) | AI schema requires `date`; format constraint enforced in tool description but no graceful interpretation | Accept fuzzy dates ("next Tuesday", "this week"). Move parsing to the executor. |
| `add_task` | Missing `dueDate` or `category` | AI schema lists `title`, `category`, `dueDate` as required | Make `category` and `dueDate` optional; default category='other', default dueDate=today+7. Today the AI invents these silently anyway. |
| `compose_message` | Missing `subject` or `body` | AI schema requires all three (`to`, `subject`, `body`) | `subject` should be optional — AI can derive from body if not given. |
| `add_budget_transaction` | Missing `category` or `date` | AI schema requires 5 fields | `category` should default to "Other"; `date` should default to today. Description + amount + type are the only true requirements. |
| `add_maintenance_ticket` | (no rejection — soft acceptance) | — | Already correct. Use as the model. |
| `generate_rent` | Missing `due_day` | Tool optional; API accepts (default 1) | Already correct. |
| `mark_rent_paid` / `send_late_notice` | Resident name doesn't match | Client-side fuzzy match in `applyActions()`; if no match, surfaces "Could not find" warning | Acceptable today, but should also let user clarify ("Did you mean Maria S. or Maria T.?") instead of silently failing. |
| `add_contact` | (no API rejection beyond name) | — | Already correct. |

The single most user-visible offender is `create_property`. Fix it first.

---

## Step 6 — Multi-vertical readiness

### Vertical detection

There is **no `workspace.vertical` column** in the code paths examined. Workspace lookups use `workspaces.owner_user_id` ([server.js:160](../server.js#L160)) and per-customer routing fields like `twilio_phone_number` and `subscription_status` (added in Phase A migration 023), but no vertical tag.

To add a second vertical, the first migration is: `ALTER TABLE workspaces ADD COLUMN vertical TEXT NOT NULL DEFAULT 'property-management'`.

### Vertical-specific data models

Tables baked into property management:

- `rent_payments` — entire concept (resident, unit, amount, due_date, paid_date, status). Would not exist for a hair salon.
- `contacts.lease_start`, `contacts.lease_end`, `contacts.monthly_rent` — three columns hardcoded to lease semantics.
- `maintenance_tickets` — useful concept, but the property-specific dispatcher logic (emergency SMS to maintenance contact) is rent-specific.
- `leases` (view) — fully PM-only.
- `entities`, `offerings`, `engagements` — **vertical-agnostic by design** (named after generic concepts, not "properties/units/tenancies"), but the API endpoints have PM comments and the PATCH validators accept PM-flavored fields like `building_type`, `pet_policy`, `heating_system`.

### Vertical-specific UI

Page titles, hero subtitles, and labels in `views/app.html` are hardcoded:

- "Inventory" hero subtitle: "Units, properties and physical asset management"
- "Maintenance" hero subtitle: "Work orders, repair requests and vendor coordination"
- "Admin" hero subtitle: "Rent, invoices, budget and financial management"
- Section labels in modals say "Lease Details", "Monthly Rent", "Unit", "Resident"

To add a second vertical, every page-hero subtitle and every form label would need to come from a vertical-keyed copy table.

### Vertical-specific AI prompt content

Yes, heavily. Quoted from [server.js:3478–3506](../server.js#L3478-L3506):

> `You are an AI command center assistant for a property management app called Modern Management.`
> `You help property managers get things done by taking action within the app.`
> `For READ questions about inventory ("what's vacant?", "who lives in Unit 3B?", "how many units at Glenwood?"...)`

And from `/api/generate` at [server.js:3110–3121](../server.js#L3110-L3121):

> `You are a professional property management assistant. Draft concise, friendly, and helpful responses to resident messages on behalf of the property management team.`
> `End with "Best regards,\nThe Property Management Team"`

And from `/api/report` at [server.js:4207](../server.js#L4207):

> `You are an expert property management advisor with deep knowledge of real estate market trends, landlord best practices, tenant relations, and operational efficiency.`

Three separate places to parameterize.

### Cross-vertical core (already vertical-agnostic)

These pieces would survive vertical changes intact:

- Calendar (events table, /api/calevents endpoints)
- Tasks (tasks table, /api/tasks endpoints, AI suggestions)
- Generic contacts (name, type, email, phone, notes — though `type` enum and lease fields are PM-specific)
- Inbox (messages table, all the email/SMS routing infrastructure, draft generation pattern)
- Knowledge base (documents are arbitrary text)
- Broadcast tool
- Authentication, sessions, billing infrastructure
- The `entities` / `offerings` / `engagements` triplet (generic by intent — would just need a different label set per vertical)

### Assessment

Adding a second vertical today would take **roughly 2–3 weeks** of focused work, broken down approximately:

- DB: 1 day (workspace.vertical column + vertical-keyed defaults, no rewrite of existing tables)
- Tool registry refactor: 2–3 days (the highest-leverage single change)
- Per-vertical copy tables for UI labels and page subtitles: 1–2 days
- Per-vertical AI system prompts: 1 day
- A second tool set for the new vertical (appointment-based businesses): 4–6 days
- A new "vertical pack" for inventory semantics (services instead of units, clients instead of tenants): 2–3 days
- QA and dual-vertical testing: 2–3 days

**Highest-leverage single refactor:** the tool registry. Once tools live in their own modules tagged with a vertical, every other piece (system prompt, UI dispatcher, executor) reduces to looking the registry up by `workspace.vertical`.

---

## Step 7 — Recommendations

Ordered by value/effort ratio (highest first).

### Quick wins (S — under an hour each)

| # | Title | Why it matters | Effort | Dependencies |
|---|---|---|---|---|
| 1 | **Drop `address` requirement on `POST /api/entities`** | Fixes the canonical "create property named Sunset" bug. Single-line change at [server.js:1893](../server.js#L1893). | S | None |
| 2 | **Make `add_task` schema's `category` and `dueDate` optional** | "Add a task: call electrician" should work without forcing the AI to pick a date. Defaults: today+7, category='other'. | S | None |
| 3 | **Make `add_budget_transaction` schema's `category` and `date` optional** | Same partial-input pattern. Defaults: 'Other', today. | S | None |
| 4 | **Make `compose_message` schema's `subject` optional** | "Tell Maria the parking lot will be repaved Saturday" — subject is derivable from body. | S | None |
| 5 | **Add `update_task` tool** | "Mark the insurance task done" — common ask, simple add. | S | None |
| 6 | **Add `update_contact` tool** | "Set Maria's phone to 555-1234" — common ask. | S | None |
| 7 | **Add `delete_calendar_event` tool** | "Cancel the board meeting on May 5" — symmetric with add. | S | None |

### Medium effort (M — a few hours each)

| # | Title | Why it matters | Effort | Dependencies |
|---|---|---|---|---|
| 8 | **Wire the Inbox into the command bar (reply / send / change folder)** | Highest day-to-day workflow gap. Add `reply_to_message`, `send_sms`, `send_email`, `archive_message` tools. | M | None |
| 9 | **Add `send_broadcast` tool** | "Email all residents about Saturday's water shutoff" — high-value, naturally voice-friendly. Reuses `/api/broadcast`. | M | None |
| 10 | **Add `update_maintenance_ticket` and `resolve_maintenance_ticket` tools** | Closes the maintenance lifecycle gap. | M | None |
| 11 | **Add `add_invoice` and `update_invoice_status` tools** | "Add a $400 invoice from AcePlumbing"; "approve all pending invoices under $200". | M | None |
| 12 | **Make the AI see real tool results** | Replace the synthetic `"Successfully executed ${a.type}"` with the actual API response (or error). Enables retry / clarification. Touches both `/api/command` and `applyActions()`. | M | Requires moving execution server-side OR threading results back through the front-end's response | 

### Large effort (L — multi-day)

| # | Title | Why it matters | Effort | Dependencies |
|---|---|---|---|---|
| 13 | **Tool registry refactor** | Foundation for vertical-awareness, easier tool maintenance, and approval-workflow infrastructure. New `lib/tool-registry.js`; collapse three duplicated tool lists (inline tools, system-prompt list, applyActions chain) into one source of truth. | L | None — but enables 14, 15, 16 |
| 14 | **Server-side action execution** | Move `applyActions()` from `views/app.html` to a new `POST /api/command/execute-action` endpoint. Eliminates client-side tool dispatch. Makes #12 trivial. | L | #13 |
| 15 | **Approval-workflow tier** | New `pending_actions` table; tools tagged `requires_approval` (e.g. `send_broadcast`, mass `mark_rent_paid`) land in a queue surfaced on the Home page; user confirms or rejects before execution. | L | #13, #14 |
| 16 | **Vertical-awareness foundation** | Add `workspaces.vertical` column; parameterize the three AI system prompts; thread `workspace.vertical` into tool registry lookups. Sets up the second-vertical work. | L | #13 |
| 17 | **Second vertical implementation (professional services)** | Use the registry + vertical-awareness to add a hair-stylist / appointment-based vertical. New tool set, new copy pack, new schema additions. | L | #13, #16 |

---

## Final notes

- **Files modified by this audit:** only `docs/ai-capability-audit.md` (this file). No source files touched.
- **Sampling:** `views/app.html` (8131 lines) and `server.js` (4726 lines) were grep-driven sampled rather than read end-to-end. The 19 tool definitions, all five AI call sites, all 100+ API endpoints, and the user-action inventory across all 9 pages were directly read from source. If something seems off, the file:line citations are accurate as of the commit at the top of this document.
- **Uncertainty:** the `workspaces` schema was not read directly — its column inventory is inferred from the SQL queries that reference it. If a `vertical` column already exists on the table from a migration outside the read scope, that detail of Step 6 is wrong (but the rest of the analysis still holds).
