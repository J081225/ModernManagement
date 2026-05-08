# Modern Management — Project Handoff Brief

**Purpose of this document:** You are a Claude Chat assistant helping me write prompts for Claude Code sessions on the Modern Management codebase. This document captures the full state of the project, the work that's shipped, the technical realities you need to know about, and the specific assumption gaps that have tripped up prior prompts. Use it as your ground truth before drafting any new session prompt.

**As of:** 2026-05-07. The B-series and C-series shipped feature work; the D-series (D1–D8) shipped production-readiness. The next phase is manual deployment work (credential rotation, env vars, Stripe live-mode switch, production push) followed by frontend marketing surfaces (trial CTA, public pricing page).

---

## Part 1: TL;DR

- **Product:** AI-powered property management SaaS. Single workspace per owner. Tenant operations (rent, contacts, maintenance, calendar, broadcasts, reports) automated by an AI command bar.
- **Stack:** Node.js + Express, PostgreSQL (Neon), Stripe Subscriptions, Twilio (SMS + voice), SendGrid (email), Anthropic Claude (the AI command bar).
- **Tiers:** Solo $79 / Team $149 / Enterprise $299. All single-user at launch (D6 repositioning). 7-day Solo trial available via `trial=true` flag at signup.
- **Codebase scale:** `server.js` ≈ 5400 lines. `views/app.html` ≈ 10K lines (the SPA). 31 AI tools registered. 15 SQL migrations (018–032). 9 modules in `lib/`.
- **What's done:** All backend production-readiness (D1–D8 complete). Existing customers (just the user's admin workspace today) continue working unchanged.
- **What's next (not coding):** Manual deployment — credential rotation, env vars on Render, Stripe live-mode switch, production push. Then frontend marketing pages.

---

## Part 2: Sessions completed (in order)

These are the sessions that have shipped. Each was scoped by a written prompt, executed by a Claude Code agent, and produced a final report.

### B-series — feature work (predates this conversation; partial recap from session B5)

- **B1:** Tool registry + lib/tools/ scaffolding. Tools self-register on import.
- **B2:** Wired registry into `/api/command`. Per-workspace `vertical` column added (migration 026, value `'property-management'`).
- **B3:** First batch of executor tools (calendar, tasks, contacts, property/unit CRUD, engagement triplet, etc.). Twilio + SendGrid wired into ctx.
- **B3.5:** Tool → page refresh mapping (`TOOL_PAGE_MAP`) for auto-refresh after AI actions.
- **B4:** Reports system (`reports` table, generate_report tool, `generateReportContent` helper).
- **B4.5:** Four-tier text-color hierarchy (the dark navy/forest/gold theme): Tier 1 ivory `#f5e6d3`, Tier 2 gold `#d4af37`, Tier 3 light gray `#e2e8f0`, Tier 4 muted `#94a3b8`.
- **B5:** Auto-navigation + AI response follow-along banner. Tools tagged with `navigationPolicy` (auto / home_only / never) and `navigateTo` template.

### C-series — approval workflow and outbound comms

- **C1:** Approval workflow infrastructure. New `pending_actions` table (migration 028). Tools tagged `requiresApproval: true` queue instead of executing. UI: approval queue card on Home + inline approve/reject buttons on chips.
- **C2:** 4 new tools: `update_maintenance_ticket`, `resolve_maintenance_ticket`, `add_invoice`, `update_invoice_status`. None require approval (internal-only).
- **C2.5:** Bug fix + legibility pass. Maintenance status snapshot widened (open / in_progress / on_hold). Report Detail modal converted to dark-navy. Maintenance ticket card titles fixed (were dark navy on dark navy = invisible).
- **C3:** 4 outbound comms tools, ALL `requiresApproval: true`: `send_sms`, `send_email`, `send_broadcast`, `reply_to_message`. Real Twilio + SendGrid sends after user clicks Approve.

### Codebase audit + migration runner investigation

- **2026-05-06 audit** (`docs/codebase-audit-2026-05-06.md`): 5 parallel investigation agents read the codebase end-to-end. Produced a 53KB ground-truth document.
- **Migration runner investigation:** confirmed there was NO auto-running migration system. `migrations/phase1-additive/` was documentation-only; user had been applying SQL manually via Neon. (D8 finally fixed this.)

### D-series — production readiness

- **D1:** `lib/plans.js` capability/limits config + `workspaces.plan` column (migration 029, default `'team'`).
- **D2:** `lib/usage.js` counters + `ai_usage_daily` and `report_usage_monthly` tables (migration 030). Counters increment but nothing reads them.
- **D3:** Subscription lifecycle handlers — `customer.subscription.updated/deleted` and `invoice.payment_failed` now mirror Stripe state into `workspaces.subscription_status` and `workspaces.plan`. Operator alerts on past-due. Optional `trial=true` flag at signup activates a 7-day trial (Solo only).
- **D4:** Plan enforcement reads. `lib/plan-enforcement.js` central layer. `/api/command` checks daily AI quota. `generateReportContent` checks monthly report quota. Resource creation routes (`POST /api/entities` / `/api/offerings` / `/api/contacts`) check resource caps. Tool registry filters `send_broadcast` from Solo plans via `getToolsForPlan(vertical, plan)` and a static `TOOL_REQUIRED_FEATURE` map.
- **D5:** Customer-facing billing UI. `GET /api/plan-summary` endpoint. `POST /api/billing/portal-session` (new Stripe portal endpoint). Plan badge in topbar. Plan & Usage card on Admin page. Subscription status banner. Upgrade prompt modal triggered by 403/429 plan errors.
- **D6:** Tier repositioning to single-user. All tiers `maxUsers: 1`. Multi-user becomes a future free upgrade for Team+. Created `docs/pricing-strategy-v1.md` (didn't previously exist on disk).
- **D7:** Drift cleanup. Anthropic model name centralized in new `lib/config.js`. Legacy `/api/billing/*` routes return 410. `subscription_tier` column writes removed; migration 031 drops the column.
- **D8:** Production hardening. New `lib/migrations.js` auto-running migration runner. Migration 032 creates the `schema_migrations` tracking table. Debug endpoint guarded by `NODE_ENV !== 'production'`. New `validateRequiredEnv()` checks 10 critical env vars at startup with `process.exit(1)` on any missing.

---

## Part 3: Architecture map

### Top-level directories

```
server.js                    — Express monolith, ~5400 lines
views/app.html               — SPA, ~10K lines
public/                      — Marketing pages (landing, login, terms, etc.)
public/features/             — Per-feature marketing pages
lib/                         — 9 modules (see below)
lib/tools/                   — 31 AI tool executors
migrations/phase1-additive/  — 15 SQL files (018–032), now auto-applied by D8 runner
migrations/post-multi-tenancy-deploy/  — One-shot manual SQL
scripts/                     — Diagnostic/dev scripts
docs/                        — codebase-audit-2026-05-06.md, pricing-strategy-v1.md, etc.
```

### lib/ module inventory

| File | Purpose | Sessions |
|---|---|---|
| `lib/tools/index.js` + 31 tool files | AI tool executors, self-register on import | B1–C3 |
| `lib/tool-registry.js` | Map-based registry. `getToolsForVertical`, `getToolsForPlan`, etc. Static `TOOL_REQUIRED_FEATURE` map (D4). | B1 / D4 |
| `lib/signup-orchestrator.js` | Phase B4. Idempotent transactional user+workspace+Twilio provisioner. Triggered by `checkout.session.completed`. | B4 (preexisting) / D7 (orchestrator INSERT switched to write `plan` instead of `subscription_tier`) |
| `lib/twilio-provisioning.js` | Twilio API wrappers (search/purchase/configure/release numbers) | B4 (preexisting) |
| `lib/plans.js` | Pricing config + capability helpers (`getPlan`, `hasFeature`, `isAtLimit`, etc.) | D1 / D6 |
| `lib/usage.js` | Counter helpers (`incrementAICommand`, `incrementReport`, getters) | D2 |
| `lib/subscription-lifecycle.js` | 3 webhook event processors (subscription.updated/deleted, invoice.payment_failed) | D3 / D7 (subscription_tier write removed) |
| `lib/plan-enforcement.js` | Central enforcement layer (status check, feature check, resource cap, AI quota, report quota) | D4 |
| `lib/config.js` | Centralized constants (just `ANTHROPIC_MODEL` today) | D7 |
| `lib/migrations.js` | Auto-running file-based migration runner with `schema_migrations` table | D8 |

### server.js section map (approximate line ranges)

| Lines | Section |
|---|---|
| 1–100 | Imports, Stripe client init (TWO clients: `stripe` legacy unused, `stripeSignup` canonical), env validation (D8), SESSION_SECRET check |
| 130–155 | Express setup, raw-body for webhooks, sessions, static |
| 155–245 | Auth middleware, page routes |
| 246–280 | `migrate()` helper (legacy single-SQL applier), encryption helpers |
| 290–430 | Email account IMAP/SMTP helpers, sync worker |
| 435–485 | Periodic background tasks (email sync, draft cleanup, token cleanup) |
| 502–842 | `initDB()` — inline schema CREATE/ALTER (legacy; new schema goes in migration files now) |
| 1163–1232 | Signup uniqueness checks + Stripe price-id lookup |
| 1242–1358 | `POST /api/signup/create-checkout-session` (new flow; supports optional `trial=true`) |
| 1371–1435 | `GET /api/signup/status` (polling) |
| 1443–1565 | `POST /api/stripe/webhook` (new Stripe webhook; D3 added subscription lifecycle dispatch) |
| 1614–1626 | `/api/me`, `/api/plan-summary` (D5), `/api/billing/portal-session` (D5) |
| 1870–2275 | Inventory: entities, offerings, engagements (workspace-scoped, B3 era, D4 gates added) |
| 2596+ | Tasks, maintenance, calendar, budget, automation |
| 2862–3000 | Messages, drafts |
| 3014–3130 | Knowledge base + uploads |
| 3185–3270 | C1 helpers + D1/D2/D3/D4 wiring |
| 3344–3540 | **`POST /api/command`** — the AI command bar; D4 enforcement gates here |
| 4451+ | `generateReportContent` (D2 increment + D4 quota gate) |
| 4639–4748 | `/api/pending-actions` (C1) |
| 5358–5450 | Legacy `/api/billing/*` routes (D7 retired to 410-Gone) |
| 5460–5490 | `initDBWithRetry()` + D8 migration runner invocation |

---

## Part 4: Schema reality (the gotchas that bit prior prompts)

This is the most important section for prompt-writing. The schema has accumulated legacy column names that don't match modern conventions. Future prompts MUST cite the actual column names, not assumed ones.

### Tables that DO NOT exist (despite appearing in planning lists)

These were on the audit's input list but have zero references in code or migrations. Do NOT scope sessions around them:

- `agreements`
- `migration_audit` (the user may have been thinking of `audit_log`)
- `recurring_charges`
- `service_requests`
- `vertical_configs` (the vertical concept is a **column** on `workspaces`, not a separate lookup table)

### Critical column-name corrections

| Table | Wrong assumption | Reality |
|---|---|---|
| `messages` | `sender, body, channel, direction` | `resident, text, category` (no `direction` column at all; folder='inbox', status='sent' encodes outbound) |
| `workspaces` | `vertical_type` with value `property_management` | `vertical` with value `'property-management'` (hyphen) |
| `maintenance_tickets` | scoped by `workspace_id`, has `notes` column | scoped by **`user_id`**, no `notes` column — only `action_notes` |
| `tasks` | `due_date`, `ai_reason` | `"dueDate"`, `"aiReason"` (quoted camelCase, legacy) |
| `automation` | `auto_reply_enabled` | `"autoReplyEnabled"` (quoted camelCase) |
| `users` | has `workspace_id` | does NOT — relationship is `workspaces.owner_user_id → users.id` |
| `cal_events`, `budget_transactions`, `messages`, etc. | `created_at` | `"createdAt"` (quoted camelCase) |

### user_id vs. workspace_id scoping (mixed)

| Scope | Tables |
|---|---|
| `user_id`-scoped (legacy) | `contacts`, `tasks`, `messages`, `maintenance_tickets`, `cal_events`, `budget_transactions`, `invoices`, `rent_payments`, `knowledge`, `drafts`, `email_accounts`, `automation` |
| `workspace_id`-scoped (newer) | `entities`, `offerings`, `engagements`, `reports`, `pending_actions`, `ai_usage_daily`, `report_usage_monthly`, `audit_log` (user_id but workspace context), `signup_drafts`, `stripe_events`, `workspaces`, `password_reset_tokens` |

### Plan-related columns (drift cleanup in progress)

| Column | Values | Status |
|---|---|---|
| `users.plan` | `'free'` / `'pro'` / `'admin'` | Legacy. Never read by new code. Only the retired `/api/billing/webhook` writes it. |
| `workspaces.plan` | `'trial'` / `'solo'` / `'team'` / `'enterprise'` | **CANONICAL.** D1+. Default `'team'`. CHECK constraint enforces values. |
| `workspaces.subscription_tier` | Was orphan column | D7 removed all writes. Migration 031 drops the column. |
| `workspaces.subscription_status` | `'active'` / `'trial'` / `'past_due'` / `'canceled'` | D3 mirrors Stripe state. **Note: `'trial'` not `'trialing'`** — D3's mapping helper normalizes. |

### Migrations applied (15 total, in order)

```
018_add_archived_at_to_entities.sql
019_drop_entities_one_default_per_workspace_uq.sql
020_add_users_alert_phone.sql
021_add_messages_emergency_flagged.sql
022_create_audit_log.sql
023_multi_customer_workspace_columns.sql
024_signup_session_state.sql
025_password_reset_tokens.sql
026_workspace_vertical.sql
027_reports_table.sql
028_pending_actions.sql
029_workspace_plan.sql
030_usage_tracking.sql
031_drop_orphan_columns.sql
032_create_schema_migrations.sql
```

Migration 031 (drop subscription_tier) and 032 (schema_migrations table) need MANUAL application via Neon SQL Editor before the D8 runner can take over. After 032 + a one-time backfill, the runner auto-applies any new migration on server startup.

---

## Part 5: Tier model and pricing (current state, D6)

| | Solo | Team | Enterprise |
|---|---|---|---|
| **Price** | $79/mo | $149/mo | $299/mo |
| **Trial** | 7-day Solo trial via `trial=true` | — | — |
| **Users** | 1 | 1 | 1 |
| **AI commands/day/user** | 15 | 30 | 500 |
| **Reports/month** | 5 | 20 | unlimited |
| **Properties** | 3 | 10 | unlimited |
| **Units** | 10 | unlimited | unlimited |
| **Contacts** | 25 | unlimited | unlimited |
| **Broadcast messaging** | — | ✓ | ✓ |
| **Auto-response** | — | ✓ | ✓ |
| **Daily briefing** | — | ✓ | ✓ |
| **API access** | — | — | ✓ |
| **Custom AI training** | — | — | ✓ |
| **Dedicated CSM** | — | — | ✓ |
| **Multi-user** | — | future free upgrade | future free upgrade |

Stripe lookup keys configured in the Dashboard:

- `solo_monthly`, `solo_annual`
- `team_monthly`, `team_annual`
- `enterprise_monthly`, `enterprise_annual`
- `additional_user_monthly` (reserved for the future multi-user upgrade; not currently charged)

---

## Part 6: AI tools registered (31 total)

### Calendar / tasks / contacts (no approval)
`add_calendar_event`, `delete_calendar_event`, `add_task`, `update_task`, `add_contact`, `update_contact`

### Property / unit CRUD (no approval, workspace-scoped)
`create_property`, `update_property`, `archive_property`, `create_unit`, `update_unit`, `set_unit_off_market`, `retire_unit`

### Engagement triplet (no approval)
`assign_tenant_to_unit`, `move_tenant_to_unit`, `end_tenant_assignment`

### Property management single-table (no approval)
`add_budget_transaction`, `add_maintenance_ticket`, `mark_rent_paid`, `generate_rent`

### Maintenance lifecycle (C2, no approval)
`update_maintenance_ticket`, `resolve_maintenance_ticket`

### Invoice (C2, no approval)
`add_invoice`, `update_invoice_status`

### Reports (no approval)
`generate_report`

### **APPROVAL-REQUIRED tools** (these queue first, fire only on user click)
| Tool | Notes |
|---|---|
| `compose_message` | Saves a message draft to the inbox (C1 retrofit) |
| `send_late_notice` | Real SMS/email via existing send_late_notice executor |
| `send_sms` | Real Twilio SMS (C3) |
| `send_email` | Real SendGrid email (C3) |
| `send_broadcast` | Multiple recipients in one approval; **GATED to Team+ via `requiredFeature: 'broadcast'`** in registry's static map (D4) |
| `reply_to_message` | Auto-detects channel from original (C3) |

### Tool authoring rules (the things prompts have repeatedly violated)

1. **Hard constraint that bites every session: "Do NOT modify executors in `lib/tools/`"**. Workarounds:
   - To add tool metadata (e.g., D4's `requiredFeature`) — use a static map in `lib/tool-registry.js`, NOT a property on the tool object
   - To add per-tool DB tracking (e.g., D2's report counter) — wire into a shared helper (`generateReportContent`) that BOTH the AI tool path AND any manual UI path call
2. Every tool's executor returns `{ success, data, message }`. Routes route by these, not by HTTP status.
3. Tools that need plan-feature gating must be added to `TOOL_REQUIRED_FEATURE` in `lib/tool-registry.js`; `getAnthropicSchemaForPlan` filters them out at `/api/command`.
4. `requiresApproval: true` works automatically — the approval interception lives in `/api/command`'s execution loop and queues without modifying the tool.

---

## Part 7: Things that have gone wrong (and how we fixed them)

This is the section most useful for prompt-writing. Every entry is a real surprise that derailed a session and forced a mid-stream fix. Future prompts should be drafted to avoid repeating these.

### Schema reality vs. spec assumptions

1. **C2 — `maintenance_tickets` scoping was wrong in the spec.**
   - Spec said: scoped by `workspace_id`, has a `notes` column.
   - Reality: scoped by `user_id`, no `notes` column (only `action_notes`).
   - Fix: agent caught it during executor authoring, deviated from spec, documented the deviation in the final report. Future maintenance tools must follow.

2. **C3 — `messages` table column names were wrong in the spec.**
   - Spec said: `sender, body, channel, direction`.
   - Reality: `resident, text, category` — and there's NO `direction` column at all.
   - Fix: agent caught it from the existing `compose_message` and `send_late_notice` tools and used real columns. Encoding outbound is via `status='sent', folder='inbox'`. Future comm tools follow this pattern.

3. **D2 — `users` has no `workspace_id` column.**
   - Spec implied a `users.workspace_id` join.
   - Reality: relationship is `workspaces.owner_user_id → users.id` (single-owner).
   - Fix: `getAllUsersTodayCounts` in `lib/usage.js` joins through `workspaces.owner_user_id`. Multi-user is deferred to post-launch (D6 documented).

4. **Audit revealed 5 phantom tables.**
   - `agreements`, `migration_audit`, `recurring_charges`, `service_requests`, `vertical_configs` were on planning lists but don't exist.
   - Fix: documented in the audit's Section 1; future prompts should sanity-check table names before scoping.

5. **The vertical column is `vertical`, not `vertical_type`.**
   - Default is `'property-management'` (hyphen), not `'property_management'` (underscore).
   - Fix: tool registry uses the same hyphen format.

### Architecture surprises

6. **A complete Stripe + Twilio signup orchestrator already existed before D-series.**
   - D3 was originally scoped as "build Stripe Subscriptions from scratch" — wrong. The orchestrator was shipped in Phase B4 and uses Stripe `lookup_keys` (`solo_monthly`, etc.) that align with the D1 pricing strategy.
   - Fix: D-series rescoped to integrate with the existing flow. The codebase audit caught this before D3 wrote any code.

7. **TWO parallel Stripe systems.**
   - Legacy: `stripe` client + `STRIPE_SECRET_KEY` + `/api/billing/webhook` + values `'free'`/`'pro'`. Dead code by disuse but still received webhooks.
   - New: `stripeSignup` client + `STRIPE_TEST_SECRET_KEY` + `/api/stripe/webhook` + values `solo`/`team`/`enterprise`.
   - Fix: D7 retired the legacy routes to 410-Gone. D8 marked the legacy import for future cleanup.

8. **There was no auto-running migration system.**
   - `migrations/phase1-additive/*.sql` was documentation-only. The user had been pasting SQL into Neon SQL Editor manually.
   - Fix: D8 finally built one (`lib/migrations.js`) plus `schema_migrations` tracking table.

9. **Three plan-naming conventions drifting apart.**
   - `users.plan` (free/pro/admin), `workspaces.plan` (D1: trial/solo/team/enterprise), `workspaces.subscription_tier` (orphan).
   - Fix: D7 retired `subscription_tier` (migration 031) and confirmed `workspaces.plan` is canonical.

### Latent bugs caught mid-session

10. **D7 caught a latent signup-orchestrator bug.**
    - Before D7, the orchestrator INSERTed `subscription_tier` but NOT `plan`, leaving `workspaces.plan` to its default `'team'`. A Solo signup would briefly have `plan='team'` until D3's `customer.subscription.updated` webhook ran and corrected it.
    - Fix: D7's INSERT change (writing `plan` directly) eliminated the race window.

11. **D5 — duplicate `id="planBadge"` collision.**
    - Legacy "Plan & billing" admin card used `id="planBadge"` for a Pro/Free badge from the dead billing flow.
    - D5 spec wanted `id="planBadge"` for a new topbar chrome badge.
    - Fix: D5 removed the legacy element and reused the ID for the new topbar badge.

12. **D5 — report errors weren't surfacing as 403/429 on the frontend.**
    - `generateReportContent` throws on plan failure with `err.code` set, but the surrounding `POST /api/reports` catch returned generic 500. Frontend `handlePlanError` (which checks 403/429) didn't trigger.
    - Fix: D5 added a code-aware translator in the catch block — `err.code='report_quota_exceeded'` → 429, others → 403, with structured `{error, message}` body.

13. **D5 — D4 plan-error responses needed verification.**
    - Spec was uncertain whether D4 already included `message` in error bodies. Verification confirmed all gates already wrote `{error, message, count, limit}`. Step 3 was a no-op.

### Process / harness issues

14. **C3 — write tool was permission-denied on outbound-comms files.**
    - System safety hook flagged `send_email.js`, `send_broadcast.js`, `reply_to_message.js` (real SendGrid/Twilio calls).
    - Fix: agent stopped, surfaced the issue, user explicitly approved. After approval the writes proceeded normally. `send_sms.js` had been written before the gate fired and didn't need re-approval.

15. **D6 — pricing strategy doc didn't exist on disk.**
    - Spec listed `pricing-strategy-v1.md` as "Modified" but a repo-wide search found nothing — it had been in the user's outputs directory which doesn't exist on Windows.
    - Fix: agent created it fresh at `docs/pricing-strategy-v1.md` with the D6 repositioning baked in.

### Things that took multiple tries

16. **C2.5 — maintenance status filter was JS-side, not SQL-side.**
    - Spec assumed a SQL `WHERE status = 'open'` clause to widen.
    - Reality: the filter was JS code in the request-body snapshot construction at server.js:3296 (then). The fix was a JS array `.includes()` check, not a SQL change. Plus the spec's regex check (`status (IN|in) \('open', 'in_progress', 'on_hold'\)`) needed satisfaction via a SQL-style comment alongside the JS code.

17. **D4 — `/api/command` already had workspace data loaded.**
    - The handler at server.js:3344 already does `SELECT * FROM workspaces WHERE id = $1` and stores `_workspaceRow`. D4's gates can reuse it instead of re-fetching via `getWorkspacePlanInfo`. Saved one round-trip per request.

---

## Part 8: Hard constraints that recur in every prompt

These are the constraint clauses that show up in every D-series prompt. The prompt-writer should include them by reflex:

1. **Do NOT modify D1–D8 enforcement logic** unless explicitly the subject of the session.
2. **Do NOT modify any tool executor in `lib/tools/`** unless adding a single metadata field. Workarounds: edit `lib/tool-registry.js` (static maps), edit shared helpers in server.js, edit the route handler.
3. **Do NOT introduce npm dependencies.** Several sessions have flexed this rule — almost always wrong choice.
4. **Preserve every existing API endpoint signature.** If a route's behavior must change, document the signature change explicitly in the prompt.
5. **Existing customers must continue working.** The user's admin workspace (id=3, plan='enterprise', subscription_status='active') must see no behavior change.
6. **Workspace and user scoping is critical.** Every query must filter by the right `_id`. See Part 4 for the table-by-table breakdown.
7. **Best-effort tracking writes.** Counter increments, audit_log writes, etc. must NOT fail the user's request if the tracking write errors. Catch and log; never throw.
8. **Stripe credentials use `STRIPE_TEST_*` env vars** today. Migration to live keys is part of manual deployment work, not a Claude Code session.
9. **Currency is USD only.** Display as `$79/mo` etc. No internationalization.
10. **The four-tier color palette (B4.5)** governs all UI work: Tier 1 ivory `#f5e6d3`, Tier 2 gold `#d4af37`, Tier 3 light gray `#e2e8f0`, Tier 4 muted `#94a3b8`. New CSS must reuse these; don't introduce new colors.

---

## Part 9: Open items / what's left

### Manual deployment work (not coding sessions)

1. Apply migration 032 manually via Neon SQL Editor (`CREATE TABLE schema_migrations ...`)
2. Backfill `schema_migrations` with already-applied filenames (template in `lib/migrations.js` header)
3. Apply migration 031 manually if not yet applied (`ALTER TABLE workspaces DROP COLUMN subscription_tier`)
4. Restart server, verify `[migrations] Migration run complete. Applied 0 new, skipped N already-applied.`
5. Credential rotation: Twilio, SendGrid, Anthropic, Neon, admin password
6. Env var configuration on Render (the 10 from `validateRequiredEnv()` in server.js)
7. Stripe live-mode switch:
   - Configure live Stripe Products/Prices with the same lookup_keys
   - Update env to live keys: `STRIPE_TEST_SECRET_KEY` value → live secret key
   - Configure ONE webhook endpoint pointing at `/api/stripe/webhook` (delete the legacy `/api/billing/webhook` config in the Stripe Dashboard)
8. Production deployment push
9. Smoke tests: signup → checkout → orchestrator → workspace ready

### Frontend marketing surfaces (separate sessions)

10. Trial CTA on landing page (must POST to `/api/signup/create-checkout-session` with `trial: true` for Solo)
11. Public pricing page

### Future work (post-launch, demand-driven)

12. Multi-user workspaces (Team/Enterprise free upgrade): `workspace_users` join table, invitation flow, refactor of `user_id`-scoped queries, Stripe per-seat quantity. Roadmap documented in `docs/pricing-strategy-v1.md`.
13. Drafts table integration with auto-reply feature (the table exists; the auto-reply path still uses an in-memory array — flagged in the audit).
14. Subscription updated/deleted sub-handlers — D3 covers these but `customer.subscription.updated` could be more granular (downgrades, plan changes).
15. Annual discount evaluation — currently annual = monthly × 12, no discount.
16. Per-vertical tiers if a second vertical opens.

---

## Part 10: How to write good prompts for this codebase

Distilled lessons:

1. **Always cite the audit explicitly.** "Read `docs/codebase-audit-2026-05-06.md` first" is a useful sentence; without it Claude tends to assume schema.
2. **Quote actual column names in the prompt.** Don't say "the messages.body column"; say "messages has columns (resident, text, category) — see audit".
3. **Specify the table's scope.** Every query in the codebase needs to filter by user_id OR workspace_id. The wrong one returns the wrong rows or breaks RLS-style guarantees we don't have but should pretend we do.
4. **Specify the file count expected in the final report.** Sessions that say "N files modified, M files created" force the agent to count and surface accidental scope creep.
5. **List "Hard constraints — MUST OBSERVE"** at the top. Reuse the boilerplate from Part 8.
6. **Include "Files in scope" with explicit Created and Modified lists.** Anything outside that list is forbidden.
7. **Include verification steps with exact grep commands.** Prevents "I think it works" finishes.
8. **Include a "What this session does NOT do" section.** Helps the agent resist scope creep and helps you remember what's deferred.
9. **For UI work, name specific element IDs.** Otherwise the agent invents them and they collide with existing IDs (D5 collision example).
10. **For schema-touching work, build the migration in `migrations/phase1-additive/` only.** The D8 runner picks it up. Don't add CREATE/ALTER inline to `initDB()` anymore.
11. **For routes that need plan enforcement, USE existing `lib/plan-enforcement.js` helpers.** Don't reinvent the gate logic.
12. **For new AI tools, follow the lib/tools/ pattern.** Schema, navigationPolicy, navigateTo, requiresApproval, async execute(input, ctx) returning {success, data, message}. Then add `require('./toolname')` to `lib/tools/index.js`.
13. **The "tool registry filter by plan" is the right place to gate tools — not the executor.** D4's `TOOL_REQUIRED_FEATURE` map keyed on tool name is the established pattern.
14. **For UI prompts, specify dark-navy aesthetic and the four-tier palette.** Otherwise legibility regresses.

---

## Part 11: File inventory (snapshot for cross-reference)

### Migration files (15)

| File | Created by | Purpose |
|---|---|---|
| 018–025 | Pre-Phase 1 / Phase B | Foundation tables + columns |
| 026_workspace_vertical.sql | B2 | `workspaces.vertical` column |
| 027_reports_table.sql | B4 | `reports` table |
| 028_pending_actions.sql | C1 | `pending_actions` table |
| 029_workspace_plan.sql | D1 | `workspaces.plan` column with CHECK constraint |
| 030_usage_tracking.sql | D2 | `ai_usage_daily` and `report_usage_monthly` tables |
| 031_drop_orphan_columns.sql | D7 | DROP `workspaces.subscription_tier` |
| 032_create_schema_migrations.sql | D8 | `schema_migrations` tracking table for the runner |

### Lib modules (9)

| File | Lines | Purpose |
|---|---|---|
| `lib/tools/index.js` | 50 | Master require list for the 31 tool files |
| `lib/tools/*.js` (31 files) | varies | Individual tool executors |
| `lib/tool-registry.js` | ~110 | Map registry, vertical+plan filters, schema export |
| `lib/signup-orchestrator.js` | ~445 | Idempotent transactional signup user+workspace+Twilio creator |
| `lib/twilio-provisioning.js` | ~155 | Twilio search/purchase/configure/release |
| `lib/plans.js` | ~250 | Tier config + capability helpers |
| `lib/usage.js` | ~165 | Counter helpers (increment, get, all-users) |
| `lib/subscription-lifecycle.js` | ~310 | 3 webhook event processors |
| `lib/plan-enforcement.js` | ~165 | Central enforcement (status, feature, resource, AI quota, report quota) |
| `lib/config.js` | 20 | `ANTHROPIC_MODEL` constant |
| `lib/migrations.js` | ~135 | Auto-running file-based migration runner |

### Notable docs

- `docs/codebase-audit-2026-05-06.md` (53KB) — ground-truth audit of the entire codebase
- `docs/pricing-strategy-v1.md` (D6) — pricing tier strategy + post-launch roadmap
- `docs/d-series-handoff-2026-05-07.md` — this file

---

## Part 12: How to use this document for prompt-writing

When the user describes a new session they want, reference these heuristics:

1. **Identify which sub-system the session touches** (signup, AI command bar, reports, billing, UI, schema, etc.) and pull the relevant section above.
2. **Cross-check the spec against Part 4 (Schema reality)** — column names, scoping, table existence.
3. **Cross-check against Part 7 (Things that have gone wrong)** — has this kind of work been tried before? What surprised the agent?
4. **Apply Part 8 (Hard constraints)** as boilerplate.
5. **Use Part 10 (How to write good prompts)** as a checklist.
6. **For UI work, cite the four-tier palette.** For Stripe work, cite the new flow only. For schema work, use migration files not inline initDB().
7. **End each prompt with explicit verification steps** (grep counts, `node -c`, `node -e` for module behavior).

This document is a living reference. As D-series follow-on work happens (frontend marketing, multi-user, etc.), it should be updated to reflect new gotchas as they're discovered.
