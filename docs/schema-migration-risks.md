# Schema Generalization — Risk Assessment

Companion to `schema-migration-plan.md`. Focuses on what can go wrong, how we detect it, and how we recover.

---

## Section 1 — Catastrophic Risks

### 1.1 Data loss during column drops (Phase 3)

**What could happen:** Phase 3 drops `rent_payments`, `maintenance_tickets`, and the three lease columns from `contacts`. If the new tables are silently incomplete (e.g., a subset of rows failed to backfill with no error reported), dropping the old tables is terminal.

**Likelihood:** Low after the 7-day soak, but non-zero.
**Impact:** Catastrophic. Depending on the row, this is rent history, maintenance history, or lease terms gone.

**Mitigations:**
1. The backfill scripts are idempotent and can be re-run mid-migration without side effects.
2. Every Phase 3 script includes a **pre-flight guard**: `SELECT COUNT(*)` comparison that aborts the drop if new < old.
3. Neon branch snapshot `pre-schema-gen-phase3-YYYYMMDD` is taken immediately before Phase 3 runs.
4. `legacy_id` columns on `recurring_charges` and `service_requests` provide traceability — we can always prove which old row became which new row.

**Rollback:** restore Neon branch snapshot; re-attach application to the restore.

### 1.2 Split-brain during Phase 2 (dual-write divergence)

**What could happen:** A route is cut over but the dual-write logic has a bug. Some transactions update only the old table (or only the new), and the two diverge over time. When we remove dual-write in Phase 3, we pick the wrong truth.

**Likelihood:** Moderate. The failure mode is subtle — it doesn't throw an error, it just silently produces incorrect data.
**Impact:** High. Reads from the "wrong" side look fine until someone notices.

**Mitigations:**
1. **Single transaction dual-writes.** Every dual-write uses `BEGIN; ... COMMIT;` so either both tables update or neither does. Never `await` two separate `pool.query` calls without a tx.
2. **Daily drift check** cron job during Phase 2: the query in Section 8.2 of the plan must return zero rows. If not zero, the cutover is on hold.
3. **Per-row `legacy_id`** makes drift detectable at single-row resolution.
4. **Shadow reads with diffing.** Described in plan §8.3.

**Rollback:** revert the route's cutover commit. Old table is still authoritative, so reverting is pure code — no data surgery.

### 1.3 Reference count mismatches during backfill

**What could happen:** During backfill, `contacts.user_id → workspaces.id` lookups miss some rows (e.g., a `user_id` that points to a deleted user). The resulting `recurring_charges.workspace_id` is NULL. Queries that filter by `workspace_id` silently return fewer rows.

**Likelihood:** Moderate. Orphan rows are common in schemas without FKs — and this schema has none.
**Impact:** Medium. Data isn't lost but is invisible to workspace-scoped queries.

**Mitigations:**
1. Backfill scripts **WARN** (via `RAISE NOTICE` in a DO block, or a SELECT with COUNT reporting) when a row cannot resolve its workspace.
2. Phase 1 does not yet enforce workspace scoping in application code; routes still filter by `user_id`. The `workspace_id` column is additive — if NULL, the row remains reachable.
3. Backfill scripts produce an orphan report:

```sql
-- Orphan detection run AFTER backfill 008
SELECT rp.id, rp.user_id FROM rent_payments rp
LEFT JOIN workspaces w ON w.owner_user_id = rp.user_id
WHERE w.id IS NULL;  -- should be empty
```

**Rollback:** re-run the backfill after creating the missing workspace rows (idempotent).

### 1.4 Silent schema drift via the `migrate()` helper

**What could happen:** The existing `migrate()` helper at server.js:95 wraps `ALTER TABLE` in try/catch. If a new migration added via the existing helper conflicts with a new migration file in `/migrations/`, one silently wins.

**Likelihood:** Low during a controlled migration; moderate afterward if we keep both systems.
**Impact:** Medium. Schema becomes unpredictable.

**Mitigation:**
- This plan commits to **not adding new entries** to the `migrate()` helper during Phases 1–3. Only the new `/migrations/` SQL files are authoritative.
- After Phase 3, a follow-on pass replaces the inline `initDB()` + `migrate()` with a formal tool.

---

## Section 2 — Performance Risks

### 2.1 Table size doubling during Phases 1–2

**What could happen:** Phase 1 creates new tables populated with the same rows as the old tables. During Phases 1 and 2 the database carries both. Storage roughly doubles for the three duplicated tables (`rent_payments`+`recurring_charges`, `maintenance_tickets`+`service_requests`, and lease columns on `contacts`+`agreements`).

**Likelihood:** Certain (by design).
**Impact:** Low. The duplicated tables are small today (tens to hundreds of rows per user across <10 users, per the codebase audit context).

**Mitigation:** Accept the transient cost. Phase 3 restores single-table storage. If Neon plan limits become a concern, trim or archive old rows in the source tables before backfill.

### 2.2 Missing indexes on new tables

**What could happen:** Phase 1 DDL explicitly creates indexes on known hot paths (`workspaces(owner_user_id)`, `recurring_charges(due_date)`, `service_requests(status)`). If a route queries on a different column (e.g., a new filter the frontend adds mid-Phase-2), performance regresses.

**Likelihood:** Moderate.
**Impact:** Medium. Query latency goes up; doesn't break functionality.

**Mitigations:**
1. DDL in `/migrations/phase1-additive/` includes the top expected indexes (see Plan §2.1–2.6).
2. During Phase 2 cutover, run `EXPLAIN ANALYZE` on each route's new SELECT before committing.
3. `CREATE INDEX CONCURRENTLY` available for production if an index is needed after the fact.

### 2.3 Backfill locking

**What could happen:** A long backfill takes a `ROW EXCLUSIVE` lock on the source table, blocking writes during import.

**Likelihood:** Low given row counts today (likely <10k total rows).
**Impact:** Low at current scale; rising as the database grows.

**Mitigation:**
1. Backfills are plain `INSERT ... SELECT ...` which holds a share lock on the source. Writers are not blocked.
2. If table size grows before Phase 1 runs, chunk the backfill:

```sql
INSERT INTO recurring_charges (...)
SELECT ... FROM rent_payments
WHERE id BETWEEN 0 AND 1000
ON CONFLICT (legacy_id) DO NOTHING;
-- repeat in chunks
```

---

## Section 3 — Operational Risks

### 3.1 No formal migration tool

**What:** The project has no migration tool like `node-pg-migrate`, Flyway, Prisma Migrate, etc. All schema changes live inside `server.js`'s `initDB()` function. Rollback is not a first-class operation — undoing a schema change means writing compensating SQL by hand.

**Impact:** High during any multi-step migration. This one is multi-step.

**Mitigations in this plan:**
1. Every SQL file in `/migrations/` is **idempotent** (IF NOT EXISTS guards, ON CONFLICT DO NOTHING for backfills).
2. Every phase has an explicit rollback section in the plan.
3. Migration order is documented in filename prefixes (`001_`, `002_`, ...).
4. Phase 3 SQL is guarded with pre-flight COUNT checks.

**Recommended follow-up (not in scope):** after Phase 3 lands, introduce a real migration tool and formalize these files plus the existing `migrate()` helper calls.

### 3.2 No staging environment verified

**What:** The user has not confirmed a running staging database. Risk: Phase 1 SQL runs against production first.

**Impact:** High if a migration file has a bug — production is the discovery surface.

**Mitigations in this plan:**
1. The Go/No-Go checklist (§5) **requires** a Neon branch snapshot and staging verification before every phase.
2. Neon branches are cheap and fast to create — the tooling for staging exists; this is a process discipline issue, not an infrastructure gap.
3. All SQL files are written to run without prompting. They can be piped into a fresh branch and inspected in seconds.

### 3.3 Solo developer — no peer review

**What:** Only one reviewer (the user). Bugs in logic (especially around backfill mappings) will survive without a second set of eyes.

**Impact:** Moderate.

**Mitigations:**
1. Each SQL file has a comment header explaining intent, dependencies, and rollback.
2. The plan documents every field-to-field mapping so the user can audit the SQL against the mapping table.
3. Phase 2 dual-writes mean the OLD system keeps running — a bug in the NEW system is caught before users notice.

### 3.4 Connection string sprawl

**What:** Neon provides separate connection strings for each branch. A migration run against the wrong branch silently pollutes data.

**Impact:** High.

**Mitigations:**
1. The user runs each migration by explicitly `psql $STAGING_URL -f migrations/phase1-additive/001_...`.
2. No migration auto-runs on app boot — they are executed manually against a named DB.
3. Pre-flight `SELECT current_database(), current_user;` as the first line of the session to confirm target.

---

## Section 4 — Rollback Plans

### 4.1 Phase 1 rollback

Exact SQL to undo Phase 1:

```sql
-- In reverse order of creation
DROP TABLE IF EXISTS service_requests CASCADE;
DROP TABLE IF EXISTS recurring_charges CASCADE;
DROP TABLE IF EXISTS vertical_configs CASCADE;
DROP TABLE IF EXISTS agreements CASCADE;
DROP TABLE IF EXISTS entities CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
ALTER TABLE contacts DROP COLUMN IF EXISTS contact_type;
```

**Why this is safe:** Phase 1 does not write to any existing table except `contacts` (one new column). Old tables are untouched. Dropping the new tables is a clean revert.

### 4.2 Phase 2 rollback

Phase 2 is code, not SQL. Rollback is per-route:

```bash
# Revert a specific cutover commit
git revert <commit-sha>
# Deploy the revert
```

**Why this is safe:** Dual-write means old tables have been kept in sync. Switching reads back to the old tables is immediate.

**Exception:** if a Phase 2 commit ALSO adds or modifies a column on an old table (unlikely under this plan's rules), the revert may leave a stray column. Review each commit's schema touch explicitly.

### 4.3 Phase 3 rollback

Phase 3 drops tables. Rollback is snapshot restore:

1. In Neon console, branch from `pre-schema-gen-phase3-YYYYMMDD`.
2. Rename the branch to promote it (or update the app's `DATABASE_URL` to point at it).
3. Revert the Phase 3 commit in git.
4. Re-deploy.

**Data loss window:** any writes between the snapshot and the rollback are lost. The snapshot is taken *immediately* before Phase 3 runs (seconds earlier), so this window is <1 min.

### 4.4 Full rollback (worst case — undo everything)

1. Revert every commit on `plan/schema-generalization` that landed on `main`.
2. Run `/docs/schema-migration-risks.md §4.1` rollback SQL to drop the new tables.
3. The old tables (`rent_payments`, `maintenance_tickets`, `contacts.lease_*`) are still intact because Phase 3 hasn't run in this scenario.

### 4.5 Data preservation principle

At every moment during Phases 1 and 2, the old tables are **fully authoritative**. The new tables are shadows. This means rolling back is always a matter of removing the new tables and/or reverting code — we never need to rebuild old data from new data.

This principle breaks only in Phase 3, which is why Phase 3 has a dedicated snapshot.

---

## Section 5 — Go/No-Go Checklist

### Before Phase 1

- [ ] Staging Neon branch `staging-schema-gen` created.
- [ ] All Phase 1 SQL files reviewed line-by-line against Section 4 data mappings in the plan.
- [ ] Dry-run executed against staging branch. Row count invariants from plan §8.1 pass.
- [ ] Dry-run executed **twice** to confirm idempotency.
- [ ] Neon branch snapshot `pre-schema-gen-phase1-YYYYMMDD` created on production.
- [ ] Row count baseline captured from production (query in plan §8.1).
- [ ] Rollback SQL (§4.1 above) prepared in a scratchpad and tested on staging.
- [ ] Deployment window: low-traffic (app writes only from logged-in users; choose an evening).

### Before each Phase 2 route cutover

- [ ] Route's READ path rewritten; existing tests pass (if any) or manual walk-through completed.
- [ ] Dual-write code uses a single pg transaction.
- [ ] Route deployed to staging and smoke-tested.
- [ ] Drift check SQL (plan §8.2) prepared and scheduled as a daily job.
- [ ] Git commit message tagged with `[phase2-cutover] <route-name>` for easy revert.

### Before Phase 3

- [ ] All Phase 2 routes have been in production for at least 7 days.
- [ ] Drift check has returned zero rows every day for 7 days.
- [ ] Row counts `recurring_charges >= rent_payments` and `service_requests >= maintenance_tickets` confirmed on production.
- [ ] Fresh Neon branch snapshot `pre-schema-gen-phase3-YYYYMMDD` created.
- [ ] Dual-write code is removed in a separate commit that lands the day BEFORE Phase 3.
- [ ] Phase 3 SQL guard checks pass on staging (run against a copy of prod).

### After Phase 3

- [ ] Row counts match expected post-drop state.
- [ ] App smoke test: create a contact with a lease, record a rent payment, create a maintenance ticket, verify UI still shows everything.
- [ ] Final `pg_dump` of the new schema committed as `docs/schema-post-migration.sql` (optional; for reference).
- [ ] Update `initDB()` in server.js to match the new shape (so fresh DBs get the new schema).
