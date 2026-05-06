# Modern Management Codebase Audit — 2026-05-06

**Purpose:** Ground truth for future development planning. Recent sessions repeatedly discovered pre-existing schema and code that was assumed not to exist (e.g., D3 was scoped as "build Stripe Subscriptions from scratch" while a fully working Stripe + Twilio signup orchestrator already shipped in Phase B). This document maps what is actually in the codebase as of 2026-05-06 so future sessions can plan with accurate scope.

**Method:** Read-only inspection of `c:\Users\jayho\.vscode\ModernManagement` by 5 parallel investigation agents. No SQL was run. No code was modified. Every claim cites `file:line`.

**Repo size at audit time:** server.js = 5207 lines, views/app.html = ~10,000 lines. 31 registered AI tools. 13 numbered migrations in `migrations/phase1-additive/`. `lib/` has 6 modules: plans, usage, signup-orchestrator, twilio-provisioning, tool-registry, tools/ index.

---

## Top-line corrections to recent assumptions

Before the section-by-section detail, these are the assumption-vs-reality items most likely to derail planning:

1. **A complete Stripe + Twilio signup orchestrator already exists.** It's at [`lib/signup-orchestrator.js`](../lib/signup-orchestrator.js), wired to a webhook at `server.js:1443`. It already uses Solo/Team/Enterprise tier names via Stripe `lookup_keys`. Future Stripe work integrates with this; it does not "build it from scratch."

2. **There are TWO parallel Stripe systems**, with separate Stripe clients (`stripe` vs. `stripeSignup`), separate webhooks (`/api/billing/webhook` vs. `/api/stripe/webhook`), separate webhook secrets, and incompatible plan-name conventions (`free`/`pro` vs. `solo`/`team`/`enterprise`). The legacy one is essentially dead code — no frontend triggers it — but it still receives webhooks if Stripe is configured to send them.

3. **The schema column is `workspaces.vertical`, not `vertical_type`.** Default value is `'property-management'` (hyphen). The B-series tool registry uses the same hyphenated string — there is no underscore/hyphen mismatch in real code.

4. **Four tables on the user's audit list do not exist:** `agreements`, `migration_audit`, `recurring_charges`, `service_requests`, plus `vertical_configs` (the vertical concept is a column on `workspaces`, not a separate lookup table). Zero references in any JS file or migration.

5. **`messages` table real columns are `resident` / `text` / `category`** — not `sender` / `body` / `channel` as previously assumed. The C3 outbound-comms tools were already adapted to this in their respective files.

6. **There is no auto-running migration system.** The previous investigation was correct. `migrations/phase1-additive/` is documentation-only; `initDB()` in server.js is one giant inline script of `CREATE TABLE IF NOT EXISTS` and `migrate()` ALTER calls. The `migrate()` helper takes a SQL string argument; it does NOT scan a directory. The `migration_audit` table the user asked about does not exist; the user may have been thinking of `audit_log` (from migration 022, used for auto-reply consent events).

7. **`users.plan` and `workspaces.plan` are different concepts that have drifted apart.** `users.plan` defaults to `'free'` and is read/written by the legacy billing webhook with values `free`/`pro`/`admin`. `workspaces.plan` was added in D1 and accepts `trial`/`solo`/`team`/`enterprise`. A third column, `workspaces.subscription_tier`, is written by the signup orchestrator but never read for decisions.

8. **Plan enforcement is at zero.** Both D1 (`lib/plans.js`) and D2 (`lib/usage.js`) deliberately stopped at "infrastructure with no enforcement." Counters are incremented; nothing is gated.

9. **Multi-user workspaces are not implemented.** The schema is single-owner via `workspaces.owner_user_id`. `lib/plans.js` defines `maxUsers` for Team (5) and Enterprise (10), but no `user_workspaces` join table exists and no code supports more than one user per workspace.

10. **Trial duration is set in the Stripe Dashboard, not in code, for new signups.** The legacy `/api/billing/create-checkout` hardcodes `trial_period_days: 14`, but the new signup flow at `server.js:1339` does not. The `'trial'` plan in `lib/plans.js` (7-day Solo limits) is not wired to anything Stripe sees.

---

## Section 1: Schema audit

### agreements
- **Purpose:** Not implemented. Zero references in code or migrations.
- **Active or abandoned:** Does not exist. The name appears on the user's audit list but nowhere in the codebase.
- **Schema notes:** N/A.

### ai_usage_daily
- **Purpose:** Daily AI command counter per (workspace, user) pair. Foundation for plan-aware throttling; written but never read for enforcement.
- **Written by:** `lib/usage.js:incrementAICommand()` (upsert on `workspace_id, user_id, period_start`). Called twice from `server.js` `/api/command` (after both response paths).
- **Read by:** `lib/usage.js:getAICommandCountToday()` and `getAllUsersTodayCounts()` — neither helper has a caller in the codebase.
- **Active or abandoned:** Half-active. Counters increment correctly; nothing checks them.
- **Schema notes:** Columns: `id`, `workspace_id` (FK), `user_id` (FK), `period_start` (DATE), `command_count`, `last_command_at`. UNIQUE on `(workspace_id, user_id, period_start)`. Period is UTC-day per current `lib/usage.js`.

### audit_log
- **Purpose:** Compliance/safety event log. Currently only captures auto-reply consent grants/revocations.
- **Written by:** `server.js:2819` (revoke event), `server.js:2842` (grant event). No other writers.
- **Read by:** Nothing in JS code. Write-only audit trail.
- **Active or abandoned:** Active for the auto-reply consent flow; otherwise unused. Migration 022 enumerates intended future event types (keyword edits, admin impersonation, data export, bulk sends, account deletion) but none are wired up.
- **Schema notes:** `(user_id, event_type, details JSONB, ip, created_at)` with index on `(user_id, event_type, created_at DESC)`.

### automation
- **Purpose:** Per-user feature-flag table. Currently only stores the auto-reply toggle.
- **Written by:** `server.js:666` (seed), `server.js:834` (lazy-init in `getAutomation`), `server.js:1525` (signup flow), `server.js:2828`/`2849` (consent toggle).
- **Read by:** `server.js:831` (`getAutomation` SELECT). Used to decide whether to fire `autoReplyToMessage()` on inbound messages.
- **Active or abandoned:** Active but minimal — single boolean. Schema is `(user_id PRIMARY KEY, "autoReplyEnabled" BOOLEAN)` — quoted camelCase column, legacy.

### broadcasts
- **Purpose:** Batch-send template + delivery tracking row. One broadcast = one row; the actual per-recipient sends are written to the `messages` table.
- **Written by:** `server.js:4937` (POST `/api/broadcast`); `server.js:4976` (UPDATE counters after async send loop).
- **Read by:** `server.js:4904` (GET `/api/broadcasts`, last 50).
- **Active or abandoned:** Active, fully functional async send.
- **Schema notes:** `(user_id, channel, subject, body, recipient_filter, recipient_count, sent_count, failed_count, "createdAt")`. No status column; `sent_count` + `failed_count` is the completion signal.

### budget_transactions
- **Purpose:** Income/expense ledger.
- **Written by:** `server.js:644` (seed), `server.js:2775` (POST `/api/budget`).
- **Read by:** `server.js:2756` (GET `/api/budget`); used in report generation around `server.js:4250-4280`.
- **Active or abandoned:** Active. Full CRUD via UI and AI tool `add_budget_transaction`.
- **Schema notes:** `(user_id, type, category, description, amount, date TEXT, notes, "createdAt")`. `type` is free-text 'income'/'expense' — no CHECK constraint.

### cal_events
- **Purpose:** Calendar events.
- **Written by:** `server.js:623` (seed), `server.js:2741` (POST `/api/calevents`).
- **Read by:** `server.js:2734`. Also used in AI context snapshot for `/api/command`.
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, date TEXT, title)`. Minimal — no timestamps, no notes column, no time-of-day field. AI tool `add_calendar_event` accepts more fields than the schema persists (documented on the tool itself).

### contacts
- **Purpose:** Tenant + vendor + important-contact directory.
- **Written by:** `server.js:557` (seed), `server.js:1784` (POST), `server.js:1793` (PATCH).
- **Read by:** `server.js:1777` (GET); used in AI context, broadcast recipient filtering, and email account sync.
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, name, type, unit, email, phone, notes, lease_start TEXT, lease_end TEXT, monthly_rent NUMERIC)`. `type` is free-text, conventionally `'resident'`/`'vendor'`/`'important'`. Lease columns added by `migrate()` ALTERs in initDB. **`user_id`-scoped, NOT workspace-scoped** — legacy.

### drafts
- **Purpose:** Persistent draft storage (separate from `signup_drafts`).
- **Written by:** `server.js:2976` (POST), `server.js:2989` (PUT).
- **Read by:** `server.js:2963` (GET).
- **Active or abandoned:** Active for the API but **not actually used by the auto-reply draft generation feature**. The auto-reply path (`server.js:3170`+) builds drafts in an in-memory array, not in the DB. Migration of in-memory state to this table is unfinished.
- **Schema notes:** `(user_id, message_id NULLABLE, content, status DEFAULT 'draft', created_at)`. Logical FK to `messages` (not enforced).

### email_accounts
- **Purpose:** Per-user IMAP/SMTP credentials for connecting an external mailbox.
- **Written by:** No explicit INSERT in server.js; rows are likely created by an external setup flow or by the email-account configure routes (`server.js:1597-1645`).
- **Read by:** `server.js:331` (per-user fetch), `server.js:357` (background sync), `server.js:405/409` (UPDATE last_sync state).
- **Active or abandoned:** Active. Background IMAP sync runs every 5 minutes (`server.js:446`).
- **Schema notes:** `(user_id UNIQUE, email, provider, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, last_sync_uid, last_sync_at, sync_enabled, created_at)`. **UNIQUE on `user_id` enforces one account per user**. Encrypted password uses AES-256-GCM with a `SESSION_SECRET`-derived key (`server.js:267-287`).

### engagements
- **Purpose:** Tenant-to-unit assignment record. Lifecycle: `pending → active → renewed/terminated/expired`.
- **Written by:** `server.js:2378` (POST), `server.js:2496` (PATCH with state-machine validation).
- **Read by:** `server.js:2298`, `server.js:2313`; in AI tools `assign_tenant_to_unit`, `move_tenant_to_unit`, `end_tenant_assignment`; in report generation.
- **Active or abandoned:** Active. State transitions defined in `ENGAGEMENT_TRANSITIONS` at `server.js:2411`.
- **Schema notes:** `(workspace_id, contact_id, offering_id, start_date, end_date, current_price, status, metadata JSONB)`. Partial unique on `(contact_id, offering_id) WHERE status='active'` prevents duplicate active leases. **`workspace_id`-scoped** (newer pattern).

### entities
- **Purpose:** Properties/buildings.
- **Written by:** `server.js:1912` (POST), `server.js:1999` (PATCH).
- **Read by:** `server.js:1875`, `server.js:1891`; AI tools (create/update/archive_property), report generation.
- **Active or abandoned:** Active.
- **Schema notes:** `(workspace_id, name, entity_type, address, description, building_type, year_built, number_of_floors, total_unit_count, heating_system, water_source, parking_setup, pet_policy, smoking_policy, shared_amenities JSONB, emergency_contacts JSONB, service_vendors JSONB, archived_at)`. Migration 018 added `archived_at` for soft-delete. **`workspace_id`-scoped**.

### invoices
- **Purpose:** Vendor invoices, separate from budget_transactions.
- **Written by:** `server.js:4879` (POST), `server.js:4888` (PATCH); AI tools `add_invoice` and `update_invoice_status`.
- **Read by:** `server.js:4869` (GET), report generation.
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, vendor, description, amount, date TEXT, status DEFAULT 'pending', notes, "createdAt")`. **`user_id`-scoped**.

### knowledge
- **Purpose:** Policies, procedures, and uploaded PDFs/TXTs that feed the AI's system prompt.
- **Written by:** `server.js:805` (seed), `server.js:3064` (POST), `server.js:3121` (POST upload).
- **Read by:** `server.js:3017` (`getKnowledge` helper); used heavily in `/api/command` system prompt.
- **Active or abandoned:** Active. Core to AI context.
- **Schema notes:** `(user_id, title, type, content, "createdAt")`. PDF text extracted via `pdf-parse`. **`user_id`-scoped**. There's a defensive duplicate `CREATE TABLE` at `server.js:3036`.

### maintenance_tickets
- **Purpose:** Maintenance/repair tracking.
- **Written by:** `server.js:2690` (POST), `server.js:2706` (PATCH); AI tools `add_maintenance_ticket`, `update_maintenance_ticket`, `resolve_maintenance_ticket`.
- **Read by:** `server.js:2680` (GET), `server.js:2669` (emergency check + SMS).
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, title, description, unit, resident, category, priority, status, outcome, requires_action BOOLEAN, action_notes, emergency_sms_sent BOOLEAN, "createdAt", "updatedAt")`. **`user_id`-scoped despite the multi-tenant convention** — confirmed during C2 schema discovery; the C2 spec said `workspace_id` but reality is `user_id`. **There is no `notes` column** — only `action_notes`.

### messages
- **Purpose:** Inbound + outbound message records (SMS, email, voicemail, AI compose).
- **Written by:**
  - `server.js:4058-4090` (`/api/sms/incoming` Twilio webhook)
  - `server.js:3867-3945` (`/api/email/incoming` SendGrid webhook)
  - `server.js:2909-2930` (POST `/api/messages` from manual UI)
  - `lib/tools/compose_message.js`, `send_sms.js`, `send_email.js`, `send_broadcast.js`, `reply_to_message.js`
- **Read by:** `server.js:2862` (GET), `server.js:2877` (single).
- **Active or abandoned:** Active. Core inbox.
- **Schema notes:** **Real columns are `(user_id, resident, subject, category, text, status DEFAULT 'new', folder DEFAULT 'inbox', email, phone, "createdAt")`** — `resident`/`text`/`category`, NOT `sender`/`body`/`channel`. `category` encodes channel (`'sms'`, `'email'`, `'general'`, `'maintenance'`, `'renewal'`). Status `'sent'` marks outbound. `emergency_flagged BOOLEAN` added by migration 021. **`user_id`-scoped**.

### migration_audit
- **Purpose:** Does not exist.
- **Active or abandoned:** Phantom name. The user may have been thinking of `audit_log` (migration 022), which is for auto-reply consent events, not migrations.
- **Schema notes:** N/A.

### offerings
- **Purpose:** Rental units within properties.
- **Written by:** `server.js:2123` (POST `/api/offerings`), `server.js:2228` (PATCH); AI tools `create_unit`, `update_unit`, `set_unit_off_market`, `retire_unit`.
- **Read by:** `server.js:2059`, `server.js:2074`; report generation.
- **Active or abandoned:** Active.
- **Schema notes:** `(workspace_id, entity_id, name, description, floor, price_amount, price_frequency, status, metadata JSONB)`. `metadata` packs bedrooms/bathrooms/sqft/amenities. Status: `available`/`unavailable`/`retired`. **`workspace_id`-scoped**.

### password_reset_tokens
- **Purpose:** Magic-link password reset tokens, 1-hour TTL.
- **Written by:** `server.js:1015` (request reset).
- **Read by:** `server.js:1085` (validate), `server.js:1117` (consume), `server.js:474` (cleanup job).
- **Active or abandoned:** Active. Cleanup runs every 6 hours.
- **Schema notes:** `(token TEXT PK, user_id FK CASCADE, created_at, expires_at, used_at)`.

### payment_events
- **Purpose:** AI-parsed inbound payment confirmation emails, matched against `rent_payments`.
- **Written by:** `server.js:3956` (forwarded payment email), `server.js:3969` (AI parse), `server.js:1727` (auto-match update), `server.js:1741` (dismiss).
- **Read by:** `server.js:1695` (GET `/api/payments/events`).
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, raw_from, raw_subject, raw_body, parsed_tenant, parsed_amount, parsed_date, parsed_source, confidence, status, matched_rent_id, "createdAt")`. `matched_rent_id` is a logical FK (not enforced).

### pending_actions
- **Purpose:** Approval queue for AI tool calls flagged `requiresApproval: true`.
- **Written by:** `server.js:3448` (queue from `/api/command`).
- **Read by:** `server.js:4639` (GET list), `server.js:4659` (approve), `server.js:4717` (reject).
- **Active or abandoned:** Active. Foundation of the C1 approval workflow.
- **Schema notes:** `(workspace_id, user_id, tool_name, input JSONB, ai_summary, status, result JSONB, resolved_at, resolved_by)`. Status: `pending`/`approved`/`rejected`/`executed`/`failed`. **`workspace_id`-scoped**.

### recurring_charges
- **Purpose:** Does not exist. Zero references.
- **Active or abandoned:** Phantom.

### rent_payments
- **Purpose:** Per-resident-per-month rent ledger.
- **Written by:** `server.js:4769` (POST), `server.js:4779` (PATCH), `server.js:4809` (`/api/rent/generate-month` bulk insert); AI tools `mark_rent_paid`, `generate_rent`, `send_late_notice`.
- **Read by:** `server.js:4753` (list), `server.js:4825` (single); payment-event matching.
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, resident TEXT, unit, amount, due_date, status, notes, paid_date, "createdAt")`. `resident` is a name string, not an FK to contacts. Status: `pending`/`paid`/`late`. **`user_id`-scoped**.

### report_usage_monthly
- **Purpose:** Monthly report counter per workspace for plan-aware caps.
- **Written by:** `lib/usage.js:incrementReport()` (upsert on `workspace_id, period_start`); called from `generateReportContent` in `server.js:4385`.
- **Read by:** `lib/usage.js:getReportCountThisMonth()` — no caller in the codebase yet.
- **Active or abandoned:** Half-active. Counters increment; nothing checks them.
- **Schema notes:** `(workspace_id, period_start DATE, report_count, last_report_at)`. UNIQUE on `(workspace_id, period_start)`.

### reports
- **Purpose:** AI-generated saved reports (B4).
- **Written by:** `server.js:4595` (POST `/api/reports`); AI tool `generate_report` (inserts directly via ctx.db).
- **Read by:** `server.js:4526` (list), `server.js:4543` (single).
- **Active or abandoned:** Active.
- **Schema notes:** `(workspace_id, user_id, title, type, prompt, content, data_snapshot JSONB, parameters JSONB, created_at, updated_at)`. **`workspace_id`-scoped**.

### service_requests
- **Purpose:** Does not exist. Zero references.
- **Active or abandoned:** Phantom.

### signup_drafts
- **Purpose:** Persists signup form state across the Stripe Checkout redirect. 24-hour TTL.
- **Written by:** `server.js:1310` (POST `/api/signup/create-checkout-session` before redirect).
- **Read by:** `lib/signup-orchestrator.js:249` (orchestrator on webhook), `server.js:456` (cleanup job DELETE expired).
- **Active or abandoned:** Active. Cleanup every 6 hours.
- **Schema notes:** `(id TEXT PK, draft_data JSONB, created_at, expires_at DEFAULT NOW() + INTERVAL '24h')`. **`draft_data` contains a bcrypt password hash** — must be redacted from any logs/exports.

### stripe_events
- **Purpose:** Idempotent log of Stripe webhook deliveries with FOR UPDATE locking on processing.
- **Written by:** `server.js:1475` (`/api/stripe/webhook` insert with `ON CONFLICT DO NOTHING`).
- **Read by:** `lib/signup-orchestrator.js:230` (`SELECT ... FOR UPDATE` for idempotent processing); `server.js:1379` (signup status polling).
- **Active or abandoned:** Active.
- **Schema notes:** `(stripe_event_id UNIQUE, event_type, event_data JSONB, received_at, processed_at, error_message)`. Partial index `(received_at) WHERE processed_at IS NULL` for "next unprocessed" scans.

### tasks
- **Purpose:** To-do items. Manual or AI-suggested.
- **Written by:** `server.js:1849` (AI suggested via `suggestTasksFromConversation`), `server.js:2614` (POST), AI tool `add_task`.
- **Read by:** `server.js:2598` (GET); used in AI context.
- **Active or abandoned:** Active.
- **Schema notes:** `(user_id, title, category, "dueDate" TEXT, notes, done BOOLEAN, suggested BOOLEAN, "aiReason" TEXT)`. **Quoted camelCase columns `"dueDate"` and `"aiReason"`** — legacy. **`user_id`-scoped**.

### user_sessions
- **Purpose:** express-session storage via `connect-pg-simple`.
- **Written by:** Session middleware (server.js:142-148).
- **Read by:** Session middleware on every request.
- **Active or abandoned:** Active. Auto-created via `createTableIfMissing: true`.
- **Schema notes:** Standard `(sid, sess, expire)` schema; not directly accessed by app code.

### users
- **Purpose:** Authentication + per-user metadata + legacy single-tenant Stripe/Twilio fields.
- **Written by:** `server.js:509` (admin seed), `server.js:1520` (legacy `/api/signup`), `lib/signup-orchestrator.js:266` (new signup flow).
- **Read by:** Login, password reset, signup uniqueness check, every request via `req.session.userId`.
- **Active or abandoned:** Active. Heavily additive — many columns added via `migrate()` ALTERs in initDB:
  - Core: `(id, username UNIQUE, password_hash, email, plan, created_at)`
  - Notifications: `notification_email`, `notifications_enabled`, `alert_phone`
  - Stripe (legacy): `stripe_customer_id`, `stripe_subscription_id`
  - Onboarding: `onboarding_completed`
  - Multi-tenant routing: `payment_forward_token`, `inbound_email_alias`
  - Twilio (legacy): `twilio_phone_number` (superseded by `workspaces.twilio_phone_number`)
- **Schema notes:** `users.plan` defaults to `'free'`; values seen in code: `free`/`pro`/`admin`. **No `users.workspace_id` column** — workspace ownership is via `workspaces.owner_user_id`.

### vertical_configs
- **Purpose:** Does not exist as a table. Vertical is a column on `workspaces`, not a separate lookup table.
- **Active or abandoned:** Phantom.

### workspaces
- **Purpose:** Multi-tenant workspace record. One per owner today (single-owner model).
- **Written by:** `lib/signup-orchestrator.js:297` (signup orchestrator INSERT).
- **Read by:** `server.js:174` (`getWorkspaceId`); report data snapshot; everywhere `workspace_id` scoping is used.
- **Active or abandoned:** Active. Foundation of multi-tenancy.
- **Schema notes:** Heavily additive across migrations:
  - Core: `(id, owner_user_id FK users, name)`
  - Signup: `business_name`, `area_code_preference`, `created_during_signup BOOLEAN`, `welcome_email_sent_at`
  - Twilio: `twilio_phone_number` (UNIQUE partial), `twilio_phone_sid`, `twilio_provisioned_at`, `twilio_released_at`
  - Subscription: `subscription_tier`, `subscription_status` (`active`/`past_due`/`canceled`/`trial`), `stripe_subscription_id`, `canceled_at`
  - Vertical: `vertical TEXT DEFAULT 'property-management'` (migration 026; **column is `vertical`, NOT `vertical_type`**)
  - Plan: `plan TEXT DEFAULT 'team'` with CHECK constraint to `trial/solo/team/enterprise` (migration 029, D1)

---

## Section 2: Existing Stripe / billing infrastructure

### 2.1 — Stripe customer creation

Two paths:
- **Legacy `/api/billing/create-checkout`** (`server.js:5056`): `stripe.customers.create({ email, metadata: { userId, username } })` is called explicitly. Customer ID is then written to `users.stripe_customer_id` (`server.js:5061`). The legacy path is gated by `requireAuth`, meaning it's an upgrade flow for already-signed-up users — but it has no UI trigger today.
- **New signup flow**: customer creation is **implicit** in Stripe Checkout. `server.js:1339-1351` creates a Checkout session with the user's email; Stripe creates the customer behind the scenes; the customer ID arrives in the `checkout.session.completed` webhook as `session.customer` and is written to `users.stripe_customer_id` at `lib/signup-orchestrator.js:281`.

### 2.2 — Stripe subscription creation

**`stripe.subscriptions.create` is never called explicitly anywhere.** Subscriptions are created implicitly by Stripe Checkout sessions with `mode: 'subscription'`. The subscription ID arrives in the webhook as `session.subscription`.

**Price selection:**
- **Legacy:** `server.js:5066` hardcodes `process.env.STRIPE_PRO_PRICE_ID` — single price, single tier.
- **New:** `server.js:1201-1231` resolves prices via Stripe `lookup_keys` at runtime. The lookup keys list at `server.js:1205` is:
  ```js
  ['solo_monthly', 'solo_annual',
   'team_monthly', 'team_annual',
   'enterprise_monthly', 'enterprise_annual',
   'additional_user_monthly']
  ```
  These are queried once at first use and cached in `_signupPriceCache`. **This list aligns exactly with the D1 pricing strategy.** The Stripe account must have prices configured with these lookup keys or the entire signup flow returns 500.

**Subscription ID storage (TWO columns exist):**
- `users.stripe_subscription_id` — written by the legacy webhook at `server.js:5117`/`5124`.
- `workspaces.stripe_subscription_id` — written by the new signup orchestrator at `lib/signup-orchestrator.js:310`.
- The two are not synced. A workspace created via the new flow has the workspace column populated but the user column blank. A user upgrading via the legacy flow has the user column populated but the workspace column unchanged.

**Trial period:**
- Legacy path hardcodes `subscription_data: { trial_period_days: 14 }` at `server.js:5070`.
- New signup flow at `server.js:1339-1351` does NOT set `subscription_data`. Trial duration is configured at the Stripe Product/Price level (Stripe Dashboard).
- The `'trial'` plan in `lib/plans.js` (7 days, Solo limits) is not wired to anything Stripe sees and is never assigned by application code.

### 2.3 — Stripe webhook handling

**Two webhook endpoints** with separate secrets:

1. **`/api/billing/webhook`** (`server.js:5098-5140`) — legacy
   - Secret: `STRIPE_WEBHOOK_SECRET`
   - Handles: `checkout.session.completed` (sets `users.plan='pro'`), `customer.subscription.deleted` (`users.plan='free'`), `customer.subscription.updated` (`'pro'` if active/trialing, else `'free'`).
   - Updates `users.plan` and `users.stripe_subscription_id`. Never touches workspaces.

2. **`/api/stripe/webhook`** (`server.js:1443-1510`) — new
   - Secret: `STRIPE_TEST_WEBHOOK_SECRET`
   - Stores all `checkout.session.*`, `customer.subscription.*`, `invoice.payment_*` events into `stripe_events` (idempotent on `stripe_event_id`).
   - Only `checkout.session.completed` is **acted on** — dispatched to `processCheckoutCompletedEvent()` in `lib/signup-orchestrator.js`.
   - Comment at `server.js:1493`: "Other event types... are logged-only for now."

**The orchestrator on `checkout.session.completed`:**
1. Validates the event and acquires a `SELECT ... FOR UPDATE` lock on `stripe_events`.
2. Reads `signup_drafts` for the form state.
3. Generates a `payment_forward_token` and `inbound_email_alias`.
4. INSERTs `users` with username, bcrypt password, plan, customer ID.
5. INSERTs `automation` row (autoReplyEnabled=false).
6. INSERTs `workspaces` with `subscription_status='active'`, `created_during_signup=TRUE`, `stripe_subscription_id`.
7. Calls Twilio: `searchAvailableNumbers(area_code) → purchaseNumber → configureNumberWebhooks`. Falls back to backup area code if primary yields nothing. Updates workspace with `twilio_phone_number`/`twilio_phone_sid`/`twilio_provisioned_at`.
8. Marks `stripe_events.processed_at = NOW()`.
9. DELETEs the `signup_drafts` row (data minimization for the password hash).
10. COMMITs the transaction.
11. Post-commit: sends welcome email via SendGrid, marks `welcome_email_sent_at`.
12. On any failure: `releaseNumber(twilioSid)` to refund the Twilio purchase, stamp error on `stripe_events.event_data`, send operator alert SMS to admin's `alert_phone` (fall back to email).

### 2.4 — Plan / tier checking

**Three columns store overlapping concepts:**

| Column | Default | Values seen | Where read | Where written |
|---|---|---|---|---|
| `users.plan` | `'free'` | `free`/`pro`/`admin` | Never read for gating; read for display | `server.js:5117/5124/5132` (legacy webhook) |
| `workspaces.plan` | `'team'` | `trial`/`solo`/`team`/`enterprise` | Never read | `lib/signup-orchestrator.js:309` (new signup) |
| `workspaces.subscription_tier` | (none) | Same as workspaces.plan in practice | Never read | `lib/signup-orchestrator.js:300` (new signup) |

**Currently zero gating logic.** Both D1's `lib/plans.js` and D2's `lib/usage.js` were deliberately scoped to "infrastructure with no enforcement." The helpers `plans.hasFeature`, `plans.isAtLimit`, `plans.remainingCapacity` exist but are not called from anywhere in `server.js` or `lib/tools/`.

The C-series tools that should logically be gated (`send_broadcast`, `send_sms`, `send_email`) all execute when approved regardless of plan.

### 2.5 — Users vs. workspaces around billing

**Architecture today:** the new system treats **the workspace as the billing entity**. The Stripe subscription is attached to a workspace via `workspaces.stripe_subscription_id`. The customer ID is on the user (`users.stripe_customer_id`) but is only used by the legacy `/api/billing/portal` route.

**Why two `stripe_subscription_id` columns:** the legacy single-tenant model put it on `users`; the new multi-tenant model put it on `workspaces`. Phase B5 was supposed to consolidate per a comment at `server.js:43` ("Env-var rename / consolidation happens in Phase B5 before production launch") — that consolidation never shipped.

**Single-owner constraint:** `workspaces.owner_user_id` is a single FK. There is no `user_workspaces` join table. `lib/usage.js:getAllUsersTodayCounts()` was written assuming this single-owner model and joins through `workspaces.owner_user_id` accordingly. Any future multi-user feature requires a new schema and a refactor of `lib/usage.js`.

### 2.6 — Missing / incomplete pieces

1. **Plan enforcement** — zero gates. Every workspace is treated as Team-tier (the column default).
2. **Subscription lifecycle handlers** — `customer.subscription.updated/deleted/past_due`, `invoice.payment_failed` are stored in `stripe_events` but no code processes them. A user whose card is declined still has `subscription_status='active'`.
3. **Customer portal** — only the legacy `/api/billing/portal` exists. It uses `users.stripe_customer_id`. New-flow workspaces have a customer ID written there too (orchestrator line 281), so the portal would technically work — but there is no UI link to it.
4. **Trial expiry handling** — no code. Trial duration is in Stripe Dashboard, Stripe sends `customer.subscription.updated` events, code doesn't handle them.
5. **Multi-user workspaces** — schema doesn't support it; `plans.js` defines limits (5/10) but no implementation.
6. **Env var consolidation** — `STRIPE_SECRET_KEY` (legacy) and `STRIPE_TEST_SECRET_KEY` (new) coexist. New flow is permanently in test-mode credentials per the env var name.
7. **Price cache invalidation** — `_signupPriceCache` at `server.js:1216` is set once and never refreshed. If a Stripe lookup_key is renamed/added in Stripe Dashboard, server restart is required.
8. **Drift risk** — if a user upgrades via legacy `/api/billing/*`, `users.plan` becomes `'pro'` while their `workspaces.plan` is unchanged from signup. No reconciliation.

---

## Section 3: Existing signup flow

**Entry:** `GET /signup` at `server.js:192` serves `views/signup.html` — a 4-screen progressive form (display-toggled, no page reloads):

1. **Account credentials** — username (3–30 lowercase alnum+`_`, uniqueness checked via `/api/signup/check-username`), password (8+ chars, strength meter), email (uniqueness via `/api/signup/check-email`).
2. **Business info** — business name (1–100 chars), units (1–1000), property type (residential_apartment/condo/single_family/mixed_use/commercial). Drives plan recommendation (≤25→Solo, ≤100→Team, >100→Enterprise).
3. **Phone preferences** — area code, backup area code, owner alert phone (E.164 `+1XXXXXXXXXX`).
4. **Plan selection** — solo/team/enterprise + monthly/annual toggle.

**State persistence:**
- Client-side: `sessionStorage` draft (no password) survives the Stripe Checkout round-trip.
- Server-side: `signup_drafts` row created by `POST /api/signup/create-checkout-session` (`server.js:1310`). Contains bcrypt password hash + form state. 24-hour TTL.

**End of flow** — orchestrator on `checkout.session.completed` (covered in 2.3 above): user + automation + workspace + Twilio number + welcome email, all in one DB transaction.

**Polling UX:** `views/signup-success.html` polls `/api/signup/status?session_id=...` every 2 seconds (60s timeout). Status endpoint at `server.js:1371` queries `stripe_events.processed_at` and joins to `workspaces` for the resolved phone number / username to display.

**Cancel UX:** `views/signup-canceled.html` preserves sessionStorage draft so the user can resume signup with prior values intact.

**Trial handling in signup:**
- `subscription_status='active'` is set on workspace creation (`lib/signup-orchestrator.js:302`) — not `'trialing'`.
- 14-day trial only fires for the **legacy** `/api/billing/create-checkout` path, NOT for new signups.
- The codebase has no logic for trial-end transitions.
- The `'trial'` plan in `lib/plans.js` is dead code — no INSERT or UPDATE ever sets a workspace to `plan='trial'`.

---

## Section 4: Existing multi-vertical infrastructure

- **`vertical_configs` table does not exist.** No code references.
- **`workspaces.vertical`** (the column is **`vertical`, NOT `vertical_type`**) was added by migration 026 with default `'property-management'`. Read at `server.js:3187/3287/3352/4250` and used to filter the AI tool registry.
- **B-series tools tag themselves as `vertical: 'core'` or `vertical: 'property-management'`.** The string matches the column value exactly — both use hyphens. No conversion code.
- **Filter logic** is at `lib/tool-registry.js:47-55`: tools with `vertical === 'core'` or `vertical === <workspace.vertical>` are included; others are filtered out before being shown to the AI.
- **No code branches on vertical anywhere else.** No if/else by vertical type. The infrastructure is ready for additional verticals but currently has only one (`'property-management'`).

---

## Section 5: Existing communication / messaging infrastructure

- **`messages`** — already covered in Section 1. Real columns: `resident`/`text`/`category`. Insert paths: Twilio webhook, SendGrid webhook, manual UI, 5 AI tools. Folders: `inbox`/`archive`/`deleted`. Statuses: `new`/`read`/`sent`. `emergency_flagged BOOLEAN` for inbox pinning.
- **`broadcasts`** — covered in Section 1. One row per broadcast batch; per-recipient sends written separately to `messages`. `recipient_count`/`sent_count`/`failed_count` track delivery.
- **`drafts`** — persistent draft API exists but the auto-reply draft generation feature still uses an in-memory array (`server.js:3170`). Migration of in-memory state to this table is unfinished.
- **`email_accounts`** — IMAP/SMTP credentials per user (UNIQUE on user_id; one account per user). Background sync every 5 minutes via `runPeriodicEmailSync()`. Encrypted password uses AES-256-GCM keyed off SESSION_SECRET. Coexists with SendGrid inbound (`/api/email/incoming`) and per-workspace `users.inbound_email_alias`.
- **`automation`** — single-toggle table for auto-reply consent (Layer 3 safety). One row per user, only column besides `user_id` is `"autoReplyEnabled" BOOLEAN`. Quoted camelCase legacy name.

**Routing on inbound:** `lookupUserByEmailAlias()` (`server.js:4041`) checks `users.inbound_email_alias` first, then `email_accounts.email`. `lookupWorkspaceByTwilioNumber()` (`server.js:4027`) maps inbound SMS numbers to workspaces.

---

## Section 6: Migration tracking

**Confirmed: there is no auto-running migration system.**

- `migrate()` at `server.js:248` is a try/catch wrapper around `pool.query(sql)` that takes a SQL string parameter. It does NOT scan a directory.
- `initDB()` at `server.js:486-827` is a single inline script of `CREATE TABLE IF NOT EXISTS` and `migrate()` ALTER calls.
- Grep for `readdirSync`, `readdir`, `readFileSync` + `migrations` finds zero hits across `server.js`, `lib/`, `scripts/`.
- The single mention of `phase1-additive` in any JS file is `scripts/check_safety_schema.js:56`, a diagnostic script that prints `"Run the missing files from migrations/phase1-additive/"` — confirming the directory is documentation/manual-apply, not auto-run.

**`migration_audit` does not exist.** The user may have been thinking of `audit_log` (migration 022, used for auto-reply consent).

**Suggested user-side query** to inspect what's actually applied:
```sql
SELECT to_regclass('reports'), to_regclass('pending_actions'),
       to_regclass('ai_usage_daily'), to_regclass('report_usage_monthly'),
       to_regclass('audit_log'), to_regclass('signup_drafts'),
       to_regclass('stripe_events');
SELECT column_name FROM information_schema.columns
  WHERE table_name='workspaces' AND column_name IN ('vertical','plan');
```

---

## Section 7: Code organization map

### server.js (5207 lines)

Approximate section ranges:

| Lines | Section |
|---|---|
| 1–55 | Imports, Stripe client init (TWO clients), SendGrid setup |
| 56–66 | Tool registry require, plans/usage requires (D1/D2) |
| 67–155 | Express app setup, body parsing, sessions, static |
| 156–245 | Auth middleware, page routes, public/* HTML routes |
| 246–254 | `migrate()` helper |
| 256–290 | Encryption helpers (AES-256-GCM via SESSION_SECRET) |
| 289–432 | Email account IMAP/SMTP helpers + sync worker |
| 434–484 | Periodic background tasks: email sync, signup-draft cleanup, password-reset-token cleanup |
| 486–827 | `initDB()` — ALL schema creation, inline |
| 829–917 | Automation helpers, notification email |
| 919–957 | `/api/settings` |
| 960–1103 | Auth: login, password reset request/check/apply |
| 1163–1232 | Signup uniqueness checks + price-id lookup |
| 1242–1358 | `POST /api/signup/create-checkout-session` |
| 1371–1435 | `GET /api/signup/status` (polling) |
| 1443–1510 | **`POST /api/stripe/webhook` (new)** |
| 1512–1535 | Legacy `POST /api/signup` (still exists; coexists with new flow) |
| 1542–1693 | `/api/me`, email account routes, payment-forwarding routes |
| 1695–1774 | `/api/payments/events` |
| 1776–1808 | Contacts CRUD |
| 1810–1869 | Lease helpers |
| 1870–2275 | Inventory: entities, offerings, engagements (workspace-scoped, B3-era) |
| 2596–2655 | Tasks |
| 2658–2731 | Maintenance tickets |
| 2733–2786 | Calendar + budget |
| 2788–2860 | Automation (auto-reply consent) |
| 2862–3000 | Messages, drafts |
| 3014–3130 | Knowledge base + uploads |
| 3132–3275 | `/api/generate` (legacy AI utility) |
| 3185–3270 | C1 helpers: `buildExecutorContext`, `buildPendingActionSummary`, `selectNavigation`/`resolveNavigateTo` |
| 3278–3540 | **`POST /api/command` (THE AI command bar)** |
| 3563–3725 | Auto-reply pipeline: task suggestion, emergency detection, owner alerts |
| 3729–3950 | Payment email parsing pipeline |
| 3867–3985 | `/api/email/incoming` (SendGrid inbound webhook) |
| 3987–4055 | `/api/email/send` |
| 4058–4170 | `/api/sms/incoming`, `/api/sms/send`, voice routes |
| 4213–4423 | Report generation (snapshot + AI prompt + content) |
| 4439–4516 | Legacy `/api/report` (Quick Snapshot) |
| 4518–4630 | `/api/reports` CRUD (B4) |
| 4639–4748 | `/api/pending-actions` (C1 approval queue) |
| 4751–4865 | Rent payments + late notice |
| 4867–4900 | Invoices |
| 4902–4980 | Broadcasts |
| 4983–5043 | Contacts CSV import |
| 5046–5141 | **Legacy Stripe billing (mostly dead-code)** |
| 5142–5167 | Sentry debug endpoint |
| 5169–5207 | Error middleware + DB-init-with-retry boot loop |

### lib/

- **`lib/plans.js`** — D1 pricing config + capability helpers. Loaded but not enforced.
- **`lib/usage.js`** — D2 counter helpers (incrementAICommand, incrementReport, getAICommandCountToday, getReportCountThisMonth, getAllUsersTodayCounts). Increments fire from `/api/command` and `generateReportContent`. No reads in app code.
- **`lib/signup-orchestrator.js`** — Phase B4. Exports `processCheckoutCompletedEvent(event, pool)`. Idempotent transactional user+workspace+Twilio provisioner with welcome email.
- **`lib/twilio-provisioning.js`** — Twilio API wrappers: `searchAvailableNumbers`, `purchaseNumber`, `configureNumberWebhooks`, `fetchNumberConfig`, `releaseNumber`.
- **`lib/tool-registry.js`** — Map-based tool registry. `register()`, `getTool()`, `getAllTools()`, `getToolsForVertical()`, `getAnthropicSchemaForVertical()`. Required fields: `name, description, schema, vertical, category, execute`. Defaults: `navigationPolicy='never'`, `navigateTo=null`, `requiresApproval=false`.
- **`lib/tools/index.js`** — Master require list.

### lib/tools/ (31 tools)

Calendar/tasks/contacts (core, no approval): `add_calendar_event`, `delete_calendar_event`, `add_task`, `update_task`, `add_contact`, `update_contact`.
Property management single-table: `add_budget_transaction`, `add_maintenance_ticket`.
Approval-required messaging: `compose_message` (C1).
Property management fuzzy-match: `mark_rent_paid`, `send_late_notice` (C1 approval), `generate_rent`.
Property/unit CRUD: `create_property`, `update_property`, `archive_property`, `create_unit`, `update_unit`, `set_unit_off_market`, `retire_unit`.
Engagement triplet: `assign_tenant_to_unit`, `move_tenant_to_unit`, `end_tenant_assignment`.
Reports: `generate_report`.
**C2 maintenance/invoice:** `update_maintenance_ticket`, `resolve_maintenance_ticket`, `add_invoice`, `update_invoice_status`.
**C3 outbound (all approval-required):** `send_sms`, `send_email`, `send_broadcast`, `reply_to_message`.

### views/

- `app.html` — main SPA (~10K lines), contains the entire UI for inbox, calendar, contacts, inventory, reports, admin, etc.
- `signup.html` — 4-screen signup form (Phase B1).
- `signup-success.html` — post-Checkout polling page.
- `signup-canceled.html` — Checkout-cancellation fallback.

### public/

Marketing/static pages: `landing.html`, `login.html`, `forgot-password.html`, `reset-password.html`, `terms.html`, `privacy.html`, `security.html`, `changelog.html`, `sms-consent.html`, `how-it-works.html`, `why-ai.html`. Plus per-feature pages under `public/features/`.
Note: `public/signup.html` exists but is **not routed** — superseded by `views/signup.html` per `server.js:194-196`.

### migrations/

- `migrations/phase1-additive/` — 13 numbered SQL files (018–030). **Documentation only**; not auto-run.
- `migrations/post-multi-tenancy-deploy/001_set_admin_twilio_number.sql` — one-shot, manual.

### scripts/

- `check_admin_password.js` — diagnostic.
- `check_safety_schema.js` — diagnostic; tells operator which migration files need manual application.
- `setup_jay_workspace.sql` — one-shot setup.
- `test_emergency_detection.js`, `test_twilio_provisioning.js` — interactive dev tools.

---

## Section 8: Things that look broken or half-finished

| # | Item | Confidence | Description |
|---|---|---|---|
| 1 | **Two parallel Stripe systems** | Definitive | `stripe` vs `stripeSignup` clients, `/api/billing/webhook` vs `/api/stripe/webhook`, `STRIPE_SECRET_KEY` vs `STRIPE_TEST_SECRET_KEY`. Comment at `server.js:43` flags Phase B5 consolidation that never shipped. |
| 2 | **Legacy `/api/billing/*` is dead-code-by-disuse** | Definitive | `/api/billing/create-checkout` is gated by `requireAuth` and has no UI button anywhere. `/api/billing/webhook` will only receive events if Stripe is still configured to send them — but it updates `users.plan` to legacy `'free'`/`'pro'`, which would conflict with `workspaces.plan` if both flows existed. |
| 3 | **Three plan-naming conventions** | Definitive | `users.plan` (free/pro/admin), `workspaces.plan` (trial/solo/team/enterprise per D1), `workspaces.subscription_tier` (orphan column written by orchestrator, never read). |
| 4 | **Plan enforcement entirely absent** | Definitive | D1+D2 deliberately built infrastructure without enforcement; future sessions never followed up. |
| 5 | **Multi-user workspaces unimplemented** | Definitive | Schema is single-owner. `lib/plans.js` defines `maxUsers` for Team (5) and Enterprise (10) which today are aspirational. |
| 6 | **Subscription lifecycle webhooks logged-only** | Definitive | `customer.subscription.*` and `invoice.payment_*` events are stored in `stripe_events` but never processed. Card declines / cancellations are not reflected in workspace state. |
| 7 | **Trial expiry has no handler** | Definitive | `subscription_status='active'` is set at signup; trial duration lives in Stripe Dashboard; `'trial'` plan in `lib/plans.js` is never assigned. When a Stripe trial actually ends, nothing happens server-side. |
| 8 | **Drafts table not used by auto-reply feature** | Likely | The `drafts` API exists; the auto-reply draft generation at `server.js:3170` still pushes to an in-memory array. Persistence migration was never done. |
| 9 | **`workspaces.subscription_tier` is dead** | Definitive | Written by orchestrator at `lib/signup-orchestrator.js:300` but never read for any decision. Probably superseded by `workspaces.plan` in D1. |
| 10 | **Price cache never invalidates** | Definitive | `_signupPriceCache` at `server.js:1216` is set once at startup. Lookup-key changes in Stripe Dashboard require a server restart to pick up. |
| 11 | **`users.stripe_customer_id` and `users.stripe_subscription_id` desync risk** | Likely | Legacy webhook updates `users` columns; new signup updates `workspaces` columns. A user upgrading via legacy then created/updated via the new flow has split state. |
| 12 | **No-auto-migration system** | Definitive | Already detailed in Section 6. `initDB()` is inline-only. `migrations/phase1-additive/*.sql` files require manual application via Neon SQL Editor. |
| 13 | **Phantom tables on the user's audit list** | Definitive | `agreements`, `migration_audit`, `recurring_charges`, `service_requests`, `vertical_configs` do not exist. The user's mental model included these but the codebase doesn't. |
| 14 | **Email accounts are limited to 1 per user** | Definitive | UNIQUE on `email_accounts.user_id`. If multi-mailbox support is wanted later, the schema must change. |
| 15 | **`maintenance_tickets` is `user_id`-scoped despite multi-tenant convention** | Definitive | The C2 spec said `workspace_id` but reality is `user_id`. Confirmed in C2 schema discovery; tools were adapted to reality. Future tools must follow suit. |
| 16 | **Quoted camelCase columns** | Definitive | `tasks."dueDate"`/`"aiReason"`, `maintenance_tickets."createdAt"`/`"updatedAt"`, `automation."autoReplyEnabled"`, `messages."createdAt"`. Easy footgun; SQL must always quote. |
| 17 | **`server.js:5142-5157` debug endpoint** | Definitive | `/api/debug/trigger-error` exists when `ENABLE_DEBUG_ENDPOINTS` is truthy. Must be unset for production. Currently behind `requireAuth` so authenticated users could trigger Sentry test events. |
| 18 | **Anthropic model `claude-opus-4-6` hardcoded throughout** | Likely benign | Several `/api/command` and report-generation calls hardcode `model: 'claude-opus-4-6'`. Any model upgrade requires editing multiple call sites. Worth centralizing. |

---

## Section 9: Recommendations for D-series resumption

### 9.1 — Is the existing Stripe integration usable?

**Yes — and starting fresh would destroy existing customer data.** The new signup orchestrator (`lib/signup-orchestrator.js`) is feature-complete: it creates the user, workspace, automation row, Twilio number, and welcome email atomically with full idempotency on the Stripe event ID. The lookup_keys it expects align with the D1 pricing strategy.

**Future D-series work integrates with it; it does not replace it.** Concretely:

- **Use the new flow only.** Treat `/api/billing/*` as legacy. Do NOT add features there. Eventually retire it.
- **`workspaces.plan` is canonical.** Ignore `users.plan` for new gating logic. Don't write to it.
- **`workspaces.stripe_subscription_id` is canonical.** Ignore `users.stripe_subscription_id` for new logic.
- **The Stripe Products/Prices must already exist** with the lookup keys: `solo_monthly`, `solo_annual`, `team_monthly`, `team_annual`, `enterprise_monthly`, `enterprise_annual`, `additional_user_monthly`. Verify in the Stripe Dashboard before any signup test.
- **The `_signupPriceCache` requires a restart** to pick up Dashboard changes — known limitation.

### 9.2 — Pricing tier alignment

The pricing strategy aligns with existing infrastructure for **tier names**: `solo`, `team`, `enterprise`. The seventh lookup key `additional_user_monthly` is the per-extra-user add-on that future multi-user work will need.

**Gaps to close to honor the pricing strategy:**

| Need | Current state | What's missing |
|---|---|---|
| Per-tier feature gating (broadcast, autoResponse, apiAccess) | `lib/plans.js` defines them; nothing checks | A `requirePlanFeature(feature)` middleware OR per-route guards |
| Daily AI command cap | `lib/usage.js` increments `ai_usage_daily`; nothing reads | Pre-check in `/api/command`: `if (count >= limit) return 429` |
| Monthly report cap | `lib/usage.js` increments `report_usage_monthly`; nothing reads | Pre-check in `generateReportContent` |
| Property/unit/contact creation caps | `plans.maxProperties/maxUnits/maxContacts` defined; not enforced | Pre-INSERT guard on POST `/api/entities`, `/api/offerings`, `/api/contacts` |
| User cap (5/10) | No multi-user code | New schema (`user_workspaces`), invitation flow, enforcement |
| Trial → paid transition | `'trial'` plan in `lib/plans.js` is dead | Either set workspaces to `plan='trial'` at signup, or scrap the `'trial'` plan and rely solely on Stripe `trial_period_days` (Dashboard config) |
| Subscription status sync from Stripe | webhook stores events; doesn't process them | Implement `customer.subscription.updated/deleted` handlers that update `workspaces.subscription_status`, `workspaces.plan`, `workspaces.canceled_at` |
| `workspaces.subscription_tier` cleanup | Orphan | Pick: drop the column OR start writing `workspaces.subscription_tier = workspaces.plan` to keep them in sync. Easier: drop. |

### 9.3 — What should the next session be?

The best next session is **D3 = "Wire trial + subscription-status reconciliation"**, narrowly scoped:

1. Process `customer.subscription.updated` and `customer.subscription.deleted` in `/api/stripe/webhook` to keep `workspaces.subscription_status` and `workspaces.plan` honest.
2. On `customer.subscription.deleted` or downgrades, log to `audit_log` and do not assume any specific tier.
3. Decide trial semantics: either (a) accept Stripe's `trial_period_days` and treat `subscription.status='trialing'` as the source of truth (no `'trial'` row in `workspaces.plan`), OR (b) set `workspaces.plan='trial'` at signup and transition on `subscription.updated` to the paid tier. Option (a) is simpler.

This unblocks D4 (enforcement reads) and D5 (UI for status display + upgrade prompts) without requiring a schema change. It also closes the highest-risk gap in production-readiness (a card decline today leaves the workspace fully functional and free).

**Two preliminary tasks before D3:**

1. **Manually backfill the database** to ensure `workspaces.plan` and `workspaces.subscription_tier` are consistent on all existing rows. The user can run:
   ```sql
   UPDATE workspaces SET plan = COALESCE(NULLIF(subscription_tier, ''), 'team')
     WHERE plan IS NULL OR plan = '';
   -- or if the user wants subscription_tier to mirror plan:
   UPDATE workspaces SET subscription_tier = plan WHERE subscription_tier <> plan;
   ```

2. **Verify Stripe Dashboard prices exist** with the seven lookup keys. Without these, `/api/signup/create-checkout-session` returns 500 with `Stripe price lookup_key not found in account: ...`.

After D3, sessions D4–D8 can proceed in this order:
- **D4** — Plan enforcement reads (gate `/api/command` daily cap, gate report generation monthly cap, gate POST `/api/entities`/`/api/offerings`/`/api/contacts` count caps, filter `requiresApproval` tools by `plans.hasFeature`)
- **D5** — Subscription UI: link to Stripe customer portal, plan badge in app chrome, upgrade prompts surfaced when limit messages fire
- **D6** — Multi-user (only if needed for go-to-market): `user_workspaces` table, invitation tokens, role enforcement
- **D7** — Drift cleanup: drop or repurpose `workspaces.subscription_tier`, retire legacy `/api/billing/*` routes
- **D8** — Production readiness: real migration runner (Option B from the prior investigation), env var consolidation, model-name centralization, Sentry verification

---

## Confidence statement

This audit was assembled from five parallel investigation agents that read the codebase end-to-end. Every claim above is sourced from a file:line reference. The biggest residual uncertainty is **what's actually applied to the live Neon database** vs. what's defined in code/migration files — this can only be resolved by querying Neon directly. The user should run the verification SQL in Section 6 before assuming any specific schema state.
