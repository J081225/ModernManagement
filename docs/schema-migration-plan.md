# Modern Management — Schema Generalization Migration Plan

**Branch:** `plan/schema-generalization`
**Author:** Planning pass on 2026-04-18
**Status:** DRAFT — planning only. No SQL has been executed. No application code has been modified.

---

## Section 1 — Executive Summary

### What
Refactor the Modern Management PostgreSQL schema away from property-management-specific nouns (`resident`, `lease`, `rent_payments`, `maintenance_tickets`) toward vertical-agnostic primitives (`contact`, `agreement`, `recurring_charges`, `service_requests`) hung off a new two-level tenancy hierarchy: **workspace → entity**. Terminology for each vertical will be driven by a new `vertical_configs` table.

### Why
The product currently assumes a single implicit vertical (property management) with a single implicit tenancy level (`user_id`). This blocks three near-term goals: (a) selling into adjacent verticals (HOA boards, short-term rental operators, small-practice healthcare front desks) without schema forks, (b) allowing one workspace to hold multiple properties/entities, and (c) supporting multi-user workspaces in the future. A naming refactor now is cheap; the same refactor after we have 10+ paying customers is considerably more painful.

### How
Three-phase strategy designed for **zero downtime and zero data loss**. The old tables remain the authoritative source of truth until Phase 3. The app stays on production-main on every commit.

| Phase | Goal | Estimated effort | Behavior of production app |
|---|---|---|---|
| **Phase 1 — Additive** | Create the new tables, backfill from old tables, expose compatibility views | ~1 focused session (2–3 hours) | Unchanged. App still reads/writes old tables. |
| **Phase 2 — Code Cutover** | Refactor server.js routes one at a time to read from new tables; dual-write where possible | ~3–4 sessions (8–12 hours total) | Unchanged externally. Internally each route migrates; old tables stay in sync. |
| **Phase 3 — Cleanup** | Stop writing to old tables; verify parity in prod for one week; drop old tables | ~1 session (1–2 hours), plus 7-day soak | Unchanged. Only internal deletes. |

### Guiding principles
1. **Old tables are authoritative until Phase 3.** The new tables are a shadow/mirror during Phases 1–2.
2. **Idempotent SQL.** Every migration file must be safe to run twice.
3. **No schema tool introduced in this pass.** We stay with the existing `initDB()` + `migrate()` helper pattern for now, layering the `migrations/` SQL files on top. See Open Questions (Section 9).
4. **No UI changes in this plan.** The frontend's hardcoded labels ("Residents", "Rent Payments", "Leases") remain. Abstracting them is a follow-on project enabled by, but not executed by, this plan.

---

## Section 2 — Proposed End-State Schema

> **Convention:** All identifiers are `snake_case`. All new tables use `created_at TIMESTAMPTZ DEFAULT NOW()` for consistency with the existing `users.created_at`/`email_accounts.created_at` style — note that several older tables use `"createdAt"` (quoted camelCase); new tables deliberately break this to establish the canonical style. The `initDB()` lift-and-shift can happen later.

### 2.1 `workspaces` — top-level tenancy

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id             SERIAL PRIMARY KEY,
  owner_user_id  INTEGER NOT NULL,              -- current owner; logical FK to users.id
  name           TEXT NOT NULL DEFAULT '',      -- "Oakwood Apartments", "Dr. Lee DDS", etc.
  vertical_type  TEXT NOT NULL DEFAULT 'property_management',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_user_id_idx ON workspaces(owner_user_id);
```

| Column | Purpose |
|---|---|
| `id` | Primary key; referenced by `entities.workspace_id`, `agreements.workspace_id`, future `recurring_charges.workspace_id`, etc. |
| `owner_user_id` | Logical link to the owning user. Today: 1:1 with users. Future: additional users carried by a separate `workspace_members` join table (see §9.2). Note that all **other** new tables keep `user_id` unchanged — only `workspaces` adopts the `owner_user_id` name to make the semantic distinction explicit. |
| `name` | Display name. For Phase 1 backfill we default this to `users.username`. |
| `vertical_type` | Joins to `vertical_configs.vertical_type` for UI labels. Default `property_management` preserves current behavior. |

### 2.2 `entities` — mid-level grouping within a workspace

```sql
CREATE TABLE IF NOT EXISTS entities (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  entity_type   TEXT NOT NULL DEFAULT 'property',
  address       TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS entities_workspace_id_idx ON entities(workspace_id);
```

| Column | Purpose |
|---|---|
| `id` | Primary key; referenced by `agreements.entity_id` and future `service_requests.entity_id`. |
| `workspace_id` | Logical FK to `workspaces.id`. |
| `name` | "Oakwood Apartments – Building A", "Downtown Clinic". |
| `entity_type` | `property` for PM, `office` for healthcare, `listing` for STR, etc. |
| `address` | Optional mailing/street address. |

For Phase 1 backfill: one entity per workspace, name = workspace name + " – Default", entity_type = `property`.

### 2.3 `agreements` — leases, contracts, memberships

```sql
CREATE TABLE IF NOT EXISTS agreements (
  id              SERIAL PRIMARY KEY,
  workspace_id    INTEGER NOT NULL,
  entity_id       INTEGER,                       -- NULL allowed if not tied to a specific entity yet
  contact_id      INTEGER NOT NULL,              -- logical FK to contacts.id
  agreement_type  TEXT NOT NULL DEFAULT 'lease',
  start_date      DATE,
  end_date        DATE,
  monthly_amount  NUMERIC(10,2) DEFAULT 0,
  status          TEXT DEFAULT 'active',         -- active | expiring | expired | terminated
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agreements_workspace_id_idx ON agreements(workspace_id);
CREATE INDEX IF NOT EXISTS agreements_contact_id_idx   ON agreements(contact_id);
CREATE INDEX IF NOT EXISTS agreements_end_date_idx     ON agreements(end_date);
```

| Column | Purpose |
|---|---|
| `agreement_type` | `lease` (PM), `membership` (gym/club), `contract` (service provider), `subscription`. |
| `start_date`/`end_date` | `DATE` type (the old columns were `TEXT`). Backfill will `CAST` non-empty strings; empties become NULL. |
| `monthly_amount` | Promotes `contacts.monthly_rent`. |
| `status` | Derived from `end_date` during backfill. |

### 2.4 `vertical_configs` — UI label abstraction layer

```sql
CREATE TABLE IF NOT EXISTS vertical_configs (
  vertical_type TEXT PRIMARY KEY,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

Seed row (inserted by `004_create_vertical_configs.sql`):

```json
{
  "contacts": "Tenants",
  "entities": "Properties",
  "agreements": "Leases",
  "recurring_charges": "Rent Payments",
  "service_requests": "Maintenance Tickets"
}
```

Future rows: `hoa`, `short_term_rental`, `healthcare_front_desk`, etc.

### 2.5 `recurring_charges` — generalizes `rent_payments`

```sql
CREATE TABLE IF NOT EXISTS recurring_charges (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL DEFAULT 1,
  workspace_id   INTEGER,                        -- populated from user_id→workspace lookup
  contact_id     INTEGER,                        -- optional link to contacts.id
  charge_type    TEXT NOT NULL DEFAULT 'rent',   -- rent | dues | subscription | invoice_line
  payer_name     TEXT NOT NULL DEFAULT '',       -- renamed from `resident`
  unit           TEXT DEFAULT '',                -- keep; may become NULL or be renamed later
  amount         NUMERIC(10,2) NOT NULL,
  due_date       DATE,
  status         TEXT DEFAULT 'pending',
  notes          TEXT DEFAULT '',
  paid_date      DATE,
  legacy_id      INTEGER,                        -- source rent_payments.id for traceability
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recurring_charges_user_id_idx      ON recurring_charges(user_id);
CREATE INDEX IF NOT EXISTS recurring_charges_workspace_id_idx ON recurring_charges(workspace_id);
CREATE INDEX IF NOT EXISTS recurring_charges_due_date_idx     ON recurring_charges(due_date);
CREATE UNIQUE INDEX IF NOT EXISTS recurring_charges_legacy_id_uq ON recurring_charges(legacy_id) WHERE legacy_id IS NOT NULL;
```

Notes on the column choices:
- `payer_name TEXT` preserves the current behavior where `rent_payments.resident` was a denormalized display string, not a FK. Down the line we can move to `contact_id`-only and drop `payer_name`, but for Phase 1 backfill, keeping a display name is safer.
- `legacy_id` is a hard audit trail: for every old `rent_payments.id` we know which `recurring_charges.id` corresponds. Drops in Phase 3 once parity is proven.
- `due_date` and `paid_date` become `DATE`; the old columns were `TEXT`. Empty strings in the source become NULL.

### 2.6 `service_requests` — generalizes `maintenance_tickets`

```sql
CREATE TABLE IF NOT EXISTS service_requests (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL DEFAULT 1,
  workspace_id        INTEGER,
  entity_id           INTEGER,
  contact_id          INTEGER,
  request_type        TEXT NOT NULL DEFAULT 'maintenance', -- maintenance | support | service | work_order
  title               TEXT NOT NULL,
  description         TEXT DEFAULT '',
  unit                TEXT DEFAULT '',
  requester_name      TEXT DEFAULT '',                     -- renamed from `resident`
  category            TEXT DEFAULT 'general',
  priority            TEXT DEFAULT 'normal',
  status              TEXT DEFAULT 'open',
  outcome             TEXT DEFAULT '',
  requires_action     BOOLEAN DEFAULT false,
  action_notes        TEXT DEFAULT '',
  emergency_sms_sent  BOOLEAN DEFAULT false,
  legacy_id           INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS service_requests_user_id_idx      ON service_requests(user_id);
CREATE INDEX IF NOT EXISTS service_requests_workspace_id_idx ON service_requests(workspace_id);
CREATE INDEX IF NOT EXISTS service_requests_status_idx       ON service_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_legacy_id_uq ON service_requests(legacy_id) WHERE legacy_id IS NOT NULL;
```

### 2.7 `contacts.contact_type` — new enum column + `contacts.is_important` boolean

Adds two columns:

```sql
-- 007
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT;
-- Backfill maps 'resident'→'tenant', NULL/''→'tenant', 'vendor'→'vendor',
-- everything else passes through unchanged. See §4.2.

-- 007b
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_important BOOLEAN DEFAULT false;
-- Rows with legacy type='important' get is_important=true and their
-- contact_type rewritten to 'other' (per Decision §9.4).
```

We keep the old `type` column populated in parallel during Phase 2 via dual-write. Both columns are dropped/renamed in Phase 3 only if the user decides to remove `type`. See Open Questions.

After 007b runs, `'important'` is no longer a valid `contact_type` value — it has been split out into the orthogonal `is_important` boolean flag. A vendor or tenant can now simultaneously be important.

### 2.8 Tenancy hierarchy

```
users (1) ─┬─ (1) workspaces ─┬─ (N) entities
           │  (owner_user_id) ├─ (N) agreements ─── (1) contacts
           │                  ├─ (N) recurring_charges
           │                  └─ (N) service_requests
           └─ (existing legacy tables remain until Phase 3)
```

Every new table (besides `workspaces`) continues to carry `user_id` during Phases 1–2 as a safety net: if something goes wrong with `workspace_id` population, routes can fall back to filtering by `user_id`. Only `workspaces` itself renames this column to `owner_user_id`.

### 2.9 Foreign key decisions

**Recommendation: start logical, no enforced FKs, exactly like the current codebase.**

Rationale:
- The existing 14 tables have zero `REFERENCES` clauses. Introducing FKs mid-migration compounds risk.
- Backfill order must be strict if FKs are enforced (workspaces → entities → agreements, etc.). With logical-only links, a partial rerun is safer.
- Post-Phase 3 we can do a separate "enforce FKs" pass once row counts are stable.

If we later enforce FKs, the order will be:
1. `entities.workspace_id → workspaces.id`
2. `agreements.workspace_id → workspaces.id`, `agreements.contact_id → contacts.id`
3. `recurring_charges.workspace_id → workspaces.id`
4. `service_requests.workspace_id → workspaces.id`, `service_requests.entity_id → entities.id`

### 2.10 Compatibility views

At the end of Phase 1, we create `CREATE OR REPLACE VIEW` wrappers so code that still selects from `rent_payments` or `maintenance_tickets` continues to work if we accidentally touch the wrong name:

```sql
-- These are NOT written in Phase 1 migration files because old tables still exist.
-- They are added only if we drop a table and need emergency fallback during Phase 3.
-- Listed here for completeness.
```

(Phase 1 does NOT create these views because the real tables still exist. The documentation mentions them as the rollback mechanism for Phase 3 — see Section 8.)

---

## Section 3 — Table-by-Table Migration Map

| # | Current table | Target | Action | Phase | Risk |
|---|---|---|---|---|---|
| 1 | `users` | `users` (unchanged structure) | No action. Referenced by new `workspaces.owner_user_id`. | — | LOW |
| 2 | `messages` | `messages` with `resident → sender_name` rename | Phase 1 adds `sender_name` and backfills. Phase 2 dual-writes both columns (every INSERT/UPDATE sets both). Phase 3 drops `resident` once drift=0. | All three | MEDIUM |
| 3 | `contacts` | `contacts` + new `contact_type` column; lease columns move to `agreements` | Add column, keep old during Phase 2, drop `lease_start`/`lease_end`/`monthly_rent` in Phase 3 | All three | **HIGH** |
| 4 | `tasks` | `tasks` (unchanged) | No action. `category='lease'` string is UI-level; leave alone. | — | LOW |
| 5 | `maintenance_tickets` | `service_requests` | Shadow table created in Phase 1, routes cut over in Phase 2, old table dropped in Phase 3 | All three | **HIGH** |
| 6 | `cal_events` | `cal_events` (unchanged) | No action. | — | LOW |
| 7 | `budget_transactions` | `budget_transactions` (unchanged) | No action. Seed data has "Rent Received" as a category string — that's UI-level, not schema. | — | LOW |
| 8 | `automation` | `automation` (unchanged) | No action. | — | LOW |
| 9 | `email_accounts` | `email_accounts` (unchanged) | No action. | — | LOW |
| 10 | `payment_events` | `payment_events` + `matched_charge_id` to replace `matched_rent_id` | **Phase 1 (per Decision §9.8):** 014 adds `matched_charge_id` and backfills via `recurring_charges.legacy_id`. Phase 2 Session 2.4 dual-writes both columns. Phase 3 (005) drops `matched_rent_id` with guarded check. | All three | MEDIUM |
| 11 | `rent_payments` | `recurring_charges` | Shadow table created in Phase 1, routes cut over in Phase 2, old table dropped in Phase 3 | All three | **HIGH** |
| 12 | `invoices` | `invoices` (unchanged for now) | No action in this plan. Candidate to generalize into `recurring_charges` with `charge_type='invoice_line'` in a future pass. | — | LOW |
| 13 | `knowledge` | `knowledge` (unchanged) | No action. | — | LOW |
| 14 | `broadcasts` | `broadcasts` (unchanged) | No action. | — | LOW |
| 15 | — | **NEW** `workspaces` | Create + backfill (1 row per user) | Phase 1 | MEDIUM |
| 16 | — | **NEW** `entities` | Create + backfill (1 row per workspace) | Phase 1 | MEDIUM |
| 17 | — | **NEW** `agreements` | Create + backfill from `contacts` rows with `lease_end != ''` | Phase 1 | MEDIUM |
| 18 | — | **NEW** `vertical_configs` | Create + seed `property_management` row | Phase 1 | LOW |
| 19 | — | **NEW** `recurring_charges` | Create + backfill from `rent_payments` | Phase 1 | **HIGH** |
| 20 | — | **NEW** `service_requests` | Create + backfill from `maintenance_tickets` | Phase 1 | **HIGH** |

---

## Section 4 — Column-by-Column Data Mapping

### 4.1 `contacts` → `agreements` (split)

| Source column | Target | Backfill rule |
|---|---|---|
| `contacts.id` | `agreements.contact_id` | Direct copy |
| `contacts.user_id` | `agreements.workspace_id` | Lookup: `workspaces.id WHERE workspaces.owner_user_id = contacts.user_id LIMIT 1` |
| `contacts.lease_start` | `agreements.start_date` | `NULLIF(contacts.lease_start,'')::date` wrapped in try/catch per row |
| `contacts.lease_end` | `agreements.end_date` | `NULLIF(contacts.lease_end,'')::date` |
| `contacts.monthly_rent` | `agreements.monthly_amount` | Direct copy; default 0 |
| — | `agreements.agreement_type` | Constant `'lease'` |
| — | `agreements.status` | `CASE WHEN end_date < CURRENT_DATE THEN 'expired' WHEN end_date < CURRENT_DATE + INTERVAL '60 days' THEN 'expiring' ELSE 'active' END` |
| — | `agreements.entity_id` | Lookup: the single entity for this workspace |

**Filter:** Only backfill rows `WHERE contacts.lease_end IS NOT NULL AND contacts.lease_end != ''` to avoid creating junk `agreements` for non-resident contacts.

### 4.2 `contacts.type` → `contacts.contact_type` (+ `is_important`)

Per Decision §9.3 (Option A): stored values become vertical-neutral primitives; the UI layer maps them through `vertical_configs.labels`. Per Decision §9.4: the legacy `'important'` value splits into an orthogonal boolean column.

| Source value | Target value | Handled by |
|---|---|---|
| `'resident'` | `contact_type = 'tenant'` | 007 |
| `'vendor'` | `contact_type = 'vendor'` (unchanged) | 007 |
| `NULL` or `''` | `contact_type = 'tenant'` (default) | 007 |
| `'important'` | `contact_type = 'other'`, `is_important = true` | **007b** (see §9.4) |
| Any other existing value | `contact_type = type` (pass-through) | 007 |

**Audit & logging:**
- Before the UPDATE, 007 snapshots the pre-migration `contacts.type` distribution into the `migration_audit` table (`migration_key = '007_contact_type_pre'`). The snapshot is a JSONB row-count histogram keyed by type value.
- 007 emits `RAISE NOTICE 'Migrated % resident→tenant, % null→tenant, % vendor unchanged, % other passthrough', …`.
- 007b emits `RAISE NOTICE '007b: flagged N contacts as is_important, rewrote M contact_type values to ''other'''`.

Re-running 007 + 007b is safe: the audit snapshot is guarded by a `migration_key` uniqueness check, and every UPDATE is guarded so it only touches rows with the expected pre-state (see 007b's `is_important = false` guard).

### 4.3 `rent_payments` → `recurring_charges`

| Source | Target | Rule |
|---|---|---|
| `rent_payments.id` | `recurring_charges.legacy_id` | Direct copy for traceability |
| `rent_payments.user_id` | `recurring_charges.user_id` | Direct copy |
| `rent_payments.user_id` | `recurring_charges.workspace_id` | Lookup via workspaces |
| `rent_payments.resident` | `recurring_charges.payer_name` | Direct copy |
| `rent_payments.resident` | `recurring_charges.contact_id` | Best-effort match: `SELECT id FROM contacts WHERE user_id=X AND name=rent_payments.resident LIMIT 1`. NULL if no match. |
| `rent_payments.unit` | `recurring_charges.unit` | Direct copy |
| `rent_payments.amount` | `recurring_charges.amount` | Direct copy |
| `rent_payments.due_date` | `recurring_charges.due_date` | `NULLIF(due_date,'')::date` |
| `rent_payments.status` | `recurring_charges.status` | Direct copy |
| `rent_payments.notes` | `recurring_charges.notes` | Direct copy |
| `rent_payments.paid_date` | `recurring_charges.paid_date` | `NULLIF(paid_date,'')::date` |
| `rent_payments."createdAt"` | `recurring_charges.created_at` | Direct copy |
| — | `recurring_charges.charge_type` | Constant `'rent'` |

### 4.4 `maintenance_tickets` → `service_requests`

| Source | Target | Rule |
|---|---|---|
| `maintenance_tickets.id` | `service_requests.legacy_id` | Direct copy |
| `maintenance_tickets.user_id` | `service_requests.user_id` | Direct copy |
| `maintenance_tickets.user_id` | `service_requests.workspace_id` | Lookup via workspaces |
| `maintenance_tickets.title` | `service_requests.title` | Direct copy |
| `maintenance_tickets.description` | `service_requests.description` | Direct copy |
| `maintenance_tickets.unit` | `service_requests.unit` | Direct copy |
| `maintenance_tickets.resident` | `service_requests.requester_name` | Direct copy |
| `maintenance_tickets.resident` | `service_requests.contact_id` | Best-effort contact match; NULL if no match |
| `maintenance_tickets.category` | `service_requests.category` | Direct copy |
| `maintenance_tickets.priority` | `service_requests.priority` | Direct copy |
| `maintenance_tickets.status` | `service_requests.status` | Direct copy |
| `maintenance_tickets.outcome` | `service_requests.outcome` | Direct copy |
| `maintenance_tickets.requires_action` | `service_requests.requires_action` | Direct copy |
| `maintenance_tickets.action_notes` | `service_requests.action_notes` | Direct copy |
| `maintenance_tickets.emergency_sms_sent` | `service_requests.emergency_sms_sent` | Direct copy |
| `maintenance_tickets."createdAt"` | `service_requests.created_at` | Direct copy |
| `maintenance_tickets."updatedAt"` | `service_requests.updated_at` | Direct copy |
| — | `service_requests.request_type` | Constant `'maintenance'` |
| — | `service_requests.entity_id` | Lookup: the single entity for the workspace |

### 4.5 New workspace/entity seeding

| Target column | Rule |
|---|---|
| `workspaces.owner_user_id` | `users.id` (source column rename applies **only** to the `workspaces` table — every other new table keeps `user_id`) |
| `workspaces.name` | `COALESCE(NULLIF(users.username,''), 'My Workspace')` |
| `workspaces.vertical_type` | Constant `'property_management'` |
| `entities.workspace_id` | FK from workspaces |
| `entities.name` | `workspaces.name || ' — Default'` |
| `entities.entity_type` | Constant `'property'` |

### 4.6 `messages.resident` → `messages.sender_name` (per Decision §9.5)

| Source column | Target column | Backfill rule | Phase |
|---|---|---|---|
| `messages.resident` | `messages.sender_name` | `UPDATE messages SET sender_name = resident WHERE sender_name = '' OR sender_name IS NULL` (Phase 1) | Phase 1 (013) |
| — | — | Every Phase 2 INSERT/UPDATE sets BOTH columns to the same value | Phase 2 (Session 2.5) |
| — | — | `DROP COLUMN resident` guarded by `COUNT(*) WHERE resident IS DISTINCT FROM sender_name = 0` | Phase 3 (004) |

During Phase 2, API responses continue to expose `resident` in their JSON output for frontend compat. The column drop in Phase 3 does not affect response shapes — routes can alias `sender_name AS resident` in their SELECT lists if the frontend hasn't migrated yet.

---

## Section 5 — Application Code Impact

Each bullet is anchored to a line number from inspection of `server.js`. Grouped by risk.

### 5.1 HIGH-risk routes (directly read/write a renamed table)

#### `/api/rent/*` — 6 routes (server.js)
- `GET /api/rent` @ **L2218** — reads `rent_payments` → cut over to `recurring_charges WHERE charge_type='rent'`.
- `POST /api/rent` @ **L2232** — writes `rent_payments` → cut over (dual-write during Phase 2 soak).
- `PUT /api/rent/:id` @ **L2242** — updates. Dual-write both tables during Phase 2; match by `legacy_id`.
- `POST /api/rent/generate-month` @ **L2254** — creates many rows. Dual-write.
- `DELETE /api/rent/:id` @ **L2285** — delete both old row (by id) and new row (by legacy_id) during Phase 2.
- `POST /api/rent/:id/late-notice` @ **L2291** — read-only against `rent_payments`; update read source.

Additional rent-touching read in payments path:
- `GET /api/payments/events` @ **L919** — joins `rent_payments rp ON rp.id = pe.matched_rent_id`. Must update to join on `recurring_charges` via `legacy_id` during Phase 2 window, then on `matched_charge_id` after Phase 3.
- `POST /api/payments/events/:id/confirm` @ **L938** — `markRentPaidFromEvent()` helper updates `rent_payments`. Must dual-update.

#### `/api/maintenance/*` — 4 routes
- `GET /api/maintenance` @ **L1162** — reads `maintenance_tickets` → cut over to `service_requests`.
- `POST /api/maintenance` @ **L1170** — writes. Dual-write.
- `PUT /api/maintenance/:id` @ **L1187** — update. Dual-write by `legacy_id`.
- `DELETE /api/maintenance/:id` @ **L1211** — delete. Dual-delete.

Also touched: emergency SMS logic @ **L1151** references `ticket.resident` — will need to read from `requester_name` (or alias in SELECT) in Phase 2.

#### `/api/contacts/*` — 5 routes
- `GET /api/contacts` @ **L1000** — return both old `type` and new `contact_type` during Phase 2; clients ignore extra.
- `POST /api/contacts` @ **L1005** — write both columns in Phase 2.
- `PUT /api/contacts/:id` @ **L1014** — **touches `lease_start`, `lease_end`, `monthly_rent`** (see L1015, L1018–1020). During Phase 2 this route must: (a) keep updating those columns on `contacts` (old path), AND (b) upsert into `agreements` (new path, keyed by `contact_id`). In Phase 3 we drop the three columns and the route writes only to `agreements`.
- `DELETE /api/contacts/:id` @ **L1027** — cascade: delete agreements, recurring_charges linked to this contact. Currently does not cascade, so add explicit `DELETE FROM agreements WHERE contact_id=$1 AND user_id=$2` before contact delete.
- `POST /api/contacts/import` @ **L2450** — CSV import. Must write `contact_type` (default `tenant`) AND populate `agreements` if CSV row has lease fields.

#### `/api/messages/*` and all `messages.resident` writers — dual-write `resident` + `sender_name` (per Decision §9.5)

Every INSERT/UPDATE to `messages` must set BOTH `resident` and `sender_name` to the same value during Phase 2. The write surface is wider than the `/api/messages` CRUD routes:

- `POST /api/messages` insert @ **L1300** — dual-write.
- `/api/email/incoming` insert @ **L1976** — dual-write.
- `/api/sms/incoming` inserts @ **L2067, L2108** — dual-write.
- `UPDATE messages SET text=..., subject=...` @ **L2129** — no change to sender fields, verify.
- `initDB()` seed path @ **L244, L344** — add `sender_name` to the INSERT column list.

Read sites (email template @ L666/L689/L691, AI prompts @ L1507/L1543/L1767/L1791/L1817, `/api/report` @ L2165) continue to read `message.resident` throughout Phase 2. Phase 3 script `004_drop_resident_from_messages.sql` drops the column once drift is zero.

#### `/api/leases/*` — 2 routes
- `GET /api/leases` @ **L1034** — currently a SELECT on `contacts` with `WHERE type='resident' AND lease_end != ''` (see L1036–1039). **Full rewrite** in Phase 2: `SELECT a.*, c.name, c.unit FROM agreements a JOIN contacts c ON c.id=a.contact_id WHERE a.workspace_id=$1 AND a.agreement_type='lease' ORDER BY a.end_date ASC`.
- `POST /api/leases/check-renewals` @ **L1046** — same table joins (L1051–L1053 query `contacts` by `lease_end BETWEEN`). Rewrite to query `agreements` in Phase 2.

### 5.2 HIGH-risk: AI system prompts (5 sites)

These hardcode "property management", "resident", "rent", "lease". They don't touch DB directly, but they shape AI responses, and any downstream code that parses those responses may be affected.

| # | Line | Route | Current prompt flavor | Change |
|---|---|---|---|---|
| 1 | **L1493** | `POST /api/generate` (draft replies) | "You are a professional property management assistant...respond to resident messages..." | Read `vertical_configs.labels` for workspace, inject template placeholders like `{{contact_label}}`, `{{vertical_name}}`. Phase 2 only. |
| 2 | **L1685** | `POST /api/command` (agent command) | "...AI command center assistant for a property management app called Modern Management." | Same — parameterize with workspace's `vertical_type`. |
| 3 | **L1734** | inner fallback inside `/api/command` | "...AI command center assistant for Modern Management. Be brief and friendly." | Minor — can stay generic; low priority. |
| 4 | **L1761** | task extraction | "...property management assistant that identifies follow-up tasks from resident communications... category (one of: maintenance, vendor, lease, finance, other)..." | Parameterize; the `category` enum may widen per vertical. |
| 5 | **L1848** | payment event parsing (`/api/email/incoming` path) | "You extract structured payment information from payment confirmation emails (Zelle, Venmo...)..." | Already reasonably generic but mentions PM vendors. Optional generalize. |

All five sites should be extracted into a single helper `async function getSystemPrompt(userId, promptType)` that reads the workspace's vertical labels and composes the template. This helper lands in Phase 2, late (after the schema reads are stable).

### 5.3 MEDIUM-risk routes

- **Messages routes — now covered by Session 2.5 dual-write (per Decision §9.5):** `/api/messages` family (@ **L1282, L1291, L1297, L1306, L1315, L1321, L1326**) must dual-write `resident` AND `sender_name` on every INSERT/UPDATE. See §5.1 (moved) and Phase 2 README §"Session 2.5". Email notification template at **L666, L689, L691** and AI prompts at **L1507, L1543, L1767, L1791, L1817** continue to read `message.resident` during Phase 2 — the dual-write keeps that field populated until Phase 3's 004 drops the column.
- `/api/email/incoming` @ **L1939** — inserts into `messages` @ **L1976** and also the sample seed @ **L244, L344**. All three must set `sender_name` alongside `resident`.
- `/api/broadcast` @ **L2377** — filters contacts. Must update `WHERE type='resident'` clauses to `WHERE contact_type IN ('tenant','resident')` during Phase 2 to tolerate both. Grep confirms — see broadcast recipient logic.
- `/api/tasks/*` @ **L1090, L1095, L1104, L1114, L1123, L1128** — `category='lease'` is a string, schema-agnostic. No change.
- `POST /api/billing/webhook` @ **L2565** — unrelated.

### 5.4 LOW-risk routes (no change needed)

- `/api/settings`, `/api/me*`, `/api/login`, `/api/signup`, `/api/logout`
- `/api/email-account/*` (6 routes)
- `/api/payments/forwarding-info`, `/api/payments/rotate-token`
- `/api/tasks/*`, `/api/calevents/*`, `/api/budget/*`, `/api/automation`
- `/api/drafts/*`, `/api/knowledge/*`, `/api/invoices/*`
- `/api/broadcasts` GET (just lists history)
- `/api/sms/*`, `/api/voice/*`, `/api/report`
- `/api/billing/*`, `/healthz`
- All static page routes @ L59–L91

---

## Section 6 — UI Impact (views/app.html)

`views/app.html` is 4179 lines of single-page SPA with hardcoded English labels: "Residents", "Rent Payments", "Leases", "Maintenance", "Properties", "Tenant", etc. are scattered throughout tabs, modal titles, column headers, empty-state messages, and AI response templates.

**This plan deliberately does NOT refactor the UI strings.** Reasons:

1. The refactor would need to be paired with a runtime label-substitution system (fetch `vertical_configs.labels` once at login, swap at render time).
2. That runtime system is a meaningful piece of frontend architecture and should be designed with its own RFC.
3. The DB/API changes can land and bake in production independently of UI label work.

**What this plan enables for a later UI project:**

- `vertical_configs` table exists with authoritative labels per vertical.
- Every API response already returns data keyed by the neutral column names (`contact_type` not `type`, `payer_name` not `resident`, etc.), so the frontend can rebind without schema assumptions.
- `GET /api/me` can be augmented to return `{ labels: {...} }` in a one-line addition once UI work begins.

**Minimum compatibility work for Phase 2** (so the UI keeps working unchanged):

- API responses must continue to expose the **old field names** as aliases during Phase 2. Example: `GET /api/rent` returns `{ resident, unit, amount, ... }`, mapped from `recurring_charges.payer_name` as `resident`. This is documented in the per-route code notes in Section 5.
- `GET /api/contacts` returns `lease_start`, `lease_end`, `monthly_rent` as top-level fields, joined in from `agreements` during Phase 2, even after the source columns move. Frontend doesn't notice.

---

## Section 7 — Phased Migration Strategy

### Phase 1 — Additive (target: 1 session, ~2–3h)

**Goal:** Create all new tables and backfill them from existing data. Production unchanged.

Steps:
1. Take a **Neon branch snapshot** of production as a safety net (see Section 8).
2. Run the 12 SQL files in `/migrations/phase1-additive/` **in numerical order** against the target DB (staging first if available).
3. Run verification queries (Section 8). Confirm row counts match: `COUNT(rent_payments) == COUNT(recurring_charges)`, etc.
4. Commit `/migrations/phase1-additive/` to `plan/schema-generalization` branch. Do NOT merge to main yet.
5. Apply to production during a low-traffic window. App behavior unchanged.

**Rollback for Phase 1:** `DROP TABLE workspaces, entities, agreements, vertical_configs, recurring_charges, service_requests CASCADE;` — no data loss since old tables are untouched. `ALTER TABLE contacts DROP COLUMN IF EXISTS contact_type;` to undo the single column add.

### Phase 2 — Code Cutover (target: 3–4 sessions, 8–12h)

**Goal:** Refactor server.js routes to read from new tables and dual-write.

**Ordering (least-risky first):**

| Session | Routes touched | Why this order |
|---|---|---|
| 2.1 | `/api/leases` (2 routes) | Pure reads. Swap source from contacts to agreements. Read-only is the safest first cutover. |
| 2.2 | `/api/contacts` (5 routes) | Dual-write `type` + `contact_type`. Dual-write `contacts` lease cols + `agreements`. Keep UI unchanged. |
| 2.3 | `/api/maintenance` (4 routes) + `/api/rent` (6 routes) | Dual-write tables. Aliased response fields for UI. |
| 2.4 | `/api/payments/*` touch-points + AI system prompts | Wire in `getSystemPrompt()` helper and update `payment_events.matched_charge_id` logic. |

**Per-route cutover pattern:**
1. Change the READ to use the new table. Run the app against it. Frontend unchanged.
2. Add dual-write: every INSERT/UPDATE/DELETE hits both tables inside the same pg transaction.
3. Log (via console.log or a dedicated `migration_audit` table — optional) any row where dual-write disagrees.
4. After 24h of production traffic with no mismatches, mark the route "cutover confirmed" in the Phase 2 README checklist.

**Rollback for Phase 2:** every route is cut over in isolation. Git revert of the specific commit reverts a single route. Old tables are still being written to, so rollback is purely code-level.

### Phase 3 — Cleanup (target: 1 session, after 7-day soak)

**Pre-conditions before running any Phase 3 SQL:**
- All Phase 2 commits have been in production for at least 7 days.
- All shadow-write mismatch logs show zero drift.
- Row counts (new vs old) match exactly.
- A fresh Neon branch snapshot has been taken.

**Steps:**
1. Stop the dual-write code (a one-line toggle in a helper; land it a day before dropping tables).
2. Run `/migrations/phase3-cleanup/001_drop_rent_payments.sql` with its guard check.
3. Run `002_drop_maintenance_tickets.sql` with its guard check.
4. Run `003_remove_lease_columns_from_contacts.sql`.
5. Remove the `legacy_id` columns from `recurring_charges` and `service_requests` in a follow-on pass (not part of this plan).

**Rollback for Phase 3:** harder, because we've dropped tables. Mitigation: the Neon branch snapshot from step 0 is the rollback. Out of the snapshot we can restore just the dropped tables.

---

## Section 8 — Verification Strategy

### 8.1 Checksums and row counts

Run before and after each phase:

```sql
-- Baseline
SELECT 'rent_payments' AS t, COUNT(*) FROM rent_payments
UNION ALL SELECT 'maintenance_tickets', COUNT(*) FROM maintenance_tickets
UNION ALL SELECT 'contacts',             COUNT(*) FROM contacts
UNION ALL SELECT 'contacts_with_lease',  COUNT(*) FROM contacts WHERE lease_end IS NOT NULL AND lease_end != ''
UNION ALL SELECT 'users',                COUNT(*) FROM users;

-- After Phase 1
SELECT 'workspaces',         COUNT(*) FROM workspaces
UNION ALL SELECT 'entities', COUNT(*) FROM entities
UNION ALL SELECT 'agreements',          COUNT(*) FROM agreements
UNION ALL SELECT 'recurring_charges',   COUNT(*) FROM recurring_charges
UNION ALL SELECT 'service_requests',    COUNT(*) FROM service_requests
UNION ALL SELECT 'vertical_configs',    COUNT(*) FROM vertical_configs;
```

**Expected invariants after Phase 1:**
- `COUNT(workspaces) == COUNT(users)`
- `COUNT(entities) == COUNT(workspaces)`
- `COUNT(recurring_charges) == COUNT(rent_payments)`
- `COUNT(service_requests) == COUNT(maintenance_tickets)`
- `COUNT(agreements) == COUNT(contacts WHERE lease_end IS NOT NULL AND lease_end != '')`

### 8.2 Shadow comparison (Phase 2 only)

For each dual-write route, add a one-shot comparison job (a cron) that once a day runs:

```sql
-- Example for rent vs recurring_charges
SELECT r.id AS rent_id, c.id AS charge_id, r.amount AS old_amt, c.amount AS new_amt
FROM rent_payments r
LEFT JOIN recurring_charges c ON c.legacy_id = r.id
WHERE r.amount <> c.amount OR r.status <> c.status OR r.resident <> c.payer_name;
```

Empty result set = ok to proceed.

### 8.3 Read-path parity

For each cutover route, the cutover commit ships with a dev-only flag: `?_parity=1` query param runs both the old and new SELECT and diffs the JSON. Dev runs this against a staging DB during development; it does NOT ship to production code paths (easy to leave behind accidentally).

### 8.4 Staging discipline

- Every migration file runs against a Neon branch of production before touching production.
- Phase 1 backfills run twice in staging (first run, then re-run to confirm idempotency).

### 8.5 Snapshots

- Before Phase 1: Neon branch named `pre-schema-gen-phase1-YYYYMMDD`.
- Before Phase 3: Neon branch named `pre-schema-gen-phase3-YYYYMMDD`.

---

## Section 9 — Open Questions

Before we touch SQL the user should answer:

### 9.1 Formal migration tool?
**Question:** Introduce `node-pg-migrate` (or similar) now, or keep hand-rolled `initDB()` + `migrate()` + the new `/migrations/` SQL files?
**Recommendation:** Not now. Introducing a tool in parallel with a schema refactor doubles the risk surface. Land the refactor first, then a follow-up PR adds a tool and formalizes existing migrations.
**Decision: NO — keep hand-rolled pattern for this refactor. A migration-tool adoption pass must be scheduled within 60 days of Phase 3 completing.**

### 9.2 Workspace–user cardinality
**Question:** Should `workspaces` be 1:1 with `users` permanently, or is this a stepping-stone to multi-user workspaces?
**Recommendation:** Assume it becomes N:1 (many users per workspace) eventually. That means the workspaces owner column is the current **owner**; future `workspace_members` join table will carry additional users.
**Decision: Design for many-users-per-workspace. The workspaces table uses `owner_user_id` (not `user_id`) to make the semantic distinction explicit now, while the column is cheap to name. A future `workspace_members` join table will carry additional users.** All other tables (contacts, agreements, recurring_charges, service_requests, etc.) keep `user_id` unchanged in this refactor.

### 9.3 Default `contact_type`: `tenant` vs. preserving `resident`?
**Question:** User wrote "tenant" by default. The current value in prod is "resident". Migrating `'resident' → 'tenant'` changes displayed values and may surprise existing users.
**Options:**
- **Option A (user's stated target):** Remap `resident → tenant` during backfill. Explicit break.
- **Option B:** Keep `'resident'` as the stored value for existing rows; use `'tenant'` as the default for new rows only. Vertical config maps both to the same UI label.
- **Option C:** Use `vertical_configs.labels.contacts` to display "Tenants" while the stored value stays `'resident'`. No data migration at all.
**Decision: Option A. Stored values become vertical-neutral primitives. Backfill logs row counts via RAISE NOTICE and snapshots pre-migration distribution to migration_audit table.**

### 9.4 What about `contacts.type = 'vendor'` and `'important'`?
**Question:** The current `contacts.type` enum includes `'vendor'` and `'important'`. Do these become `contact_type='vendor'`/`'important'`, or do we split them into a separate concept (e.g., `contact_role`)?
**Decision: Split NOW. New `contacts.is_important BOOLEAN` added in 007b. `'important'` is no longer a `contact_type` value.** `'vendor'` remains a `contact_type` (pass-through unchanged). After 007b: `is_important` is orthogonal to `contact_type`, so a vendor can simultaneously be important without overloading the type column.

### 9.5 Rename `messages.resident`?
**Question:** The `messages` table has a `resident` column that's a denormalized display name of who sent the message. Not in the target rename list, but semantically inconsistent.
**Decision: Rename IN this migration. Phase 1 adds `sender_name` + backfill. Phase 2 dual-writes both columns. Phase 3 drops `resident`.**
- Phase 1: `013_add_sender_name_to_messages.sql` adds `sender_name TEXT DEFAULT ''`, backfills with an idempotent guard (`sender_name = '' OR sender_name IS NULL`).
- Phase 2 Session 2.5: every INSERT/UPDATE to `messages` sets BOTH columns. API responses continue to expose `resident` for frontend compat.
- Phase 3: `004_drop_resident_from_messages.sql` drops the column, guarded by `COUNT(*) WHERE resident IS DISTINCT FROM sender_name = 0` — RAISE EXCEPTION on drift.

### 9.6 Invoices generalization
**Question:** Should `invoices` fold into `recurring_charges` with `charge_type='invoice'`?
**Decision: Keep invoices as a separate table. No change in this refactor.**

### 9.7 Staging environment
**Question:** Is there a Neon branch configured for staging runs? If not, Phase 1 effectively touches production first.
**Decision (updated): Cut a FRESH Neon branch off current production named `staging-schema-gen-YYYYMMDD` (today's date). Do NOT reuse the older branch from the multi-tenancy fix work. Confirm it's current before any Phase 1 SQL runs against it.** Phase 1 runs twice against this fresh branch (first run executes, second run verifies idempotency) before any production migration. See `/migrations/phase1-additive/README.md` for the operational checklist.

### 9.8 `payment_events.matched_rent_id` pattern consistency
**Question:** Should the replacement of `matched_rent_id` with `matched_charge_id` follow the same add-in-Phase-1, dual-write-in-Phase-2, drop-in-Phase-3 pattern we established for `messages.sender_name` — or stay in Phase 2 as originally planned?
**Decision: Move to Phase 1, matching the messages pattern.** Consistency matters more than effort savings. Phase 1 adds `matched_charge_id` via `014_add_matched_charge_id_to_payment_events.sql` and backfills from `recurring_charges.legacy_id`. Phase 2 Session 2.4 dual-writes both columns. Phase 3's `005_drop_matched_rent_id_from_payment_events.sql` drops the old column with a guarded check.

### 9.9 Pre-Phase-1 production audits (Q2 + Q3 resolutions)
**Question:** Can we finalize the exact `UPDATE` clauses for 007 (blank `contacts.type` default) and 007b (the `'important'` rewrite rule) without knowing what's actually in production?
**Decision: No — run audits first.** Two production sampling audits must complete before Phase 1 SQL is finalized:
- **Audit 1 (Q2):** Distribution of `contacts.type = 'important'` rows by `has_lease` and `has_rent`. Refined 007b proposal: rows with lease or rent become `contact_type='tenant' AND is_important=true`; rows with neither become `contact_type='other' AND is_important=true`.
- **Audit 2 (Q3):** Count and sample of `contacts.type IS NULL OR type = ''`. Code-side finding already confirmed: CSV importer defaults missing type to `'resident'`, so blanks must come from `POST /api/contacts` without a `type` in the body. If the audit shows blank rows have lease/rent, keep the current `'tenant'` default. If blanks are purely unclassified (no lease, no rent), change 007 to default them to `'other'`.

The audit queries are in `/docs/pre-phase1-audit-queries.md`. Paste the query results back to the session before Phase 1 SQL is finalized.

### 9.10 Frontend-visible API field compatibility (Q6 findings)
**Question:** Are there any places where the frontend (`views/app.html`) directly sends `resident` as a JSON body field to a messages endpoint, requiring server-side translation during Phase 2?
**Decision: Yes — one site. Phase 2 server accepts BOTH keys as input.**
Verified findings:
- All **7 server-side messages INSERT/UPDATE sites** are in `server.js` (L244, L344, L1300, L1976, L2067, L2108, L2129). L2129 is an UPDATE that does NOT touch the sender column — verify-only, no dual-write needed there.
- `SELECT sender_name AS resident` aliasing covers **every frontend read path** of a messages record.
- **One frontend write site** submits a `resident` field: `views/app.html` line 3250 — `POST /api/messages` with `{ resident: action.to, ... }`. Phase 2 Session 2.5 must update the `/api/messages` POST handler at server.js L1300 to accept `req.body.sender_name || req.body.resident` as the canonical input, and INSERT that value into BOTH `sender_name` and `resident` columns during Phase 2. After Phase 3 drops `resident`, only `sender_name` remains — but API response aliases keep the frontend working unchanged until a separate frontend migration ships.
- Aliased SELECT statements in Phase 2 must carry this comment: `// ALIAS: sender_name → resident for v1 API compatibility. Remove when frontend migrates.`

**`views/app.html` line 2066 (`POST /api/rent`, `{ resident, ... }`) and line 2590 (`POST /api/maintenance`, `{ resident, ... }`) are NOT messages writes** — they're rent and maintenance writes. They are covered by the Session 2.3 cutover for `rent_payments`/`maintenance_tickets`, not Session 2.5.

---

## Appendix A — File inventory produced by this plan

Under `/docs/`:
- `schema-migration-plan.md` (this file)
- `schema-migration-risks.md`
- `pre-phase1-audit-queries.md` (Q2 + Q3 + baseline row counts — per Decision §9.9)

Under `/migrations/phase1-additive/`:
- `README.md` (staging discipline, run order, preconditions — per Decision §9.7)
- `001_create_workspaces.sql` (uses `owner_user_id`, per Decision §9.2)
- `002_create_entities.sql`
- `003_create_agreements.sql`
- `004_create_vertical_configs.sql`
- `005_create_recurring_charges.sql`
- `006_create_service_requests.sql`
- `007_add_contact_type_column.sql` (Option A remap + migration_audit snapshot, per Decision §9.3)
- `007b_add_is_important_column.sql` (is_important split, per Decision §9.4 — REFINED PENDING Q2 audit per §9.9)
- `008_backfill_workspaces.sql`
- `009_backfill_entities.sql`
- `010_backfill_agreements.sql`
- `011_backfill_recurring_charges.sql`
- `012_backfill_service_requests.sql`
- `013_add_sender_name_to_messages.sql` (per Decision §9.5)
- `014_add_matched_charge_id_to_payment_events.sql` (per Decision §9.8)

Under `/migrations/phase2-code-cutover/`:
- `README.md` (no SQL — documents route-by-route plan, includes Session 2.5 for messages dual-write and Session 2.4 expansion for payment_events dual-write)

Under `/migrations/phase3-cleanup/`:
- `001_drop_rent_payments.sql` (guarded)
- `002_drop_maintenance_tickets.sql` (guarded)
- `003_remove_lease_columns_from_contacts.sql` (guarded)
- `004_drop_resident_from_messages.sql` (guarded, per Decision §9.5)
- `005_drop_matched_rent_id_from_payment_events.sql` (guarded, per Decision §9.8)
- `README.md`
