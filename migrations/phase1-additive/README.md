# Phase 1 — Additive

This phase creates new tables and backfills them from existing data. **Production application behavior is unchanged.** Every SQL file in this directory is idempotent and safe to re-run.

See `docs/schema-migration-plan.md` §7 ("Phased Migration Strategy") and §9.7 (staging decision).

## Staging discipline (per Decision §9.7)

**Phase 1 runs TWICE in staging before any production migration.**

1. **First run in staging** — executes the backfill against a Neon branch that mirrors production data. This is the primary correctness check.
2. **Second run in staging, same branch** — re-runs every file end-to-end. Because every file is idempotent, the second run must produce zero row-count deltas and zero errors. This is the idempotency check.

If either run fails, fix the root cause and restart both runs from a fresh snapshot. **Do not promote to production until both staging runs are green.**

## Preconditions before Phase 1 runs in staging

- [ ] **Production audit queries run and pasted back** (per `docs/pre-phase1-audit-queries.md` + plan §9.9). Results from Audit 1 (important-contact distribution) and Audit 2 (blank-type distribution) must be in hand before 007 and 007b are finalized.
- [ ] **Fresh Neon staging branch cut** (per Decision §9.7, updated in §9.4 of the review pass): create a brand-new Neon branch named `staging-schema-gen-YYYYMMDD` (today's date) off current production. **Do NOT reuse the older staging branch from the multi-tenancy fix work** — it will have diverged. After creating the fresh branch, do a smoke `SELECT COUNT(*)` comparison against production on `users`, `contacts`, `rent_payments`, `maintenance_tickets`, `messages`, `payment_events` to confirm parity.
- [ ] **Fresh snapshot of production taken.** Neon branch named `pre-schema-gen-phase1-YYYYMMDD` branched off `main` at the start of the session. This is the rollback target if Phase 1 lands in production and must be undone.
- [ ] **Baseline row counts captured** per plan §8.1. Save the query output to a local scratch file; Phase 1 verification compares against it.
- [ ] **Pre-flight sanity:** run `SELECT current_database(), current_user, version();` as the first statement of the session to confirm the target DB is the staging branch and not production.

## Preconditions before Phase 1 runs in production

Everything above, plus:

- [ ] Both staging runs completed with zero errors.
- [ ] Staging post-run row-count invariants match plan §8.1 expectations.
- [ ] Low-traffic deployment window chosen (evening hours recommended — app writes are user-initiated and sparse).
- [ ] Phase 1 rollback SQL (`docs/schema-migration-risks.md` §4.1) is pasted into a scratchpad and ready to run.

## Run order

Run these files in strict numerical order. Each file's header documents its dependencies. `007b` runs after `007` and before any backfill that reads `contact_type`. `013` and `014` are independent additions and are run last.

```
001_create_workspaces.sql
002_create_entities.sql
003_create_agreements.sql
004_create_vertical_configs.sql
005_create_recurring_charges.sql
006_create_service_requests.sql
007_add_contact_type_column.sql
007b_add_is_important_column.sql
008_backfill_workspaces.sql
009_backfill_entities.sql
010_backfill_agreements.sql
011_backfill_recurring_charges.sql
012_backfill_service_requests.sql
013_add_sender_name_to_messages.sql
014_add_matched_charge_id_to_payment_events.sql
```

Total: **14 SQL files** (counting `007b` as its own file). `014` depends on `011` (uses `recurring_charges.legacy_id`), so must run after 011.

## Invocation (manual)

Each file is run explicitly against the target DB. Example against the staging branch:

```bash
export STAGING_URL='postgresql://.../staging-branch'
for f in \
  migrations/phase1-additive/001_create_workspaces.sql \
  migrations/phase1-additive/002_create_entities.sql \
  migrations/phase1-additive/003_create_agreements.sql \
  migrations/phase1-additive/004_create_vertical_configs.sql \
  migrations/phase1-additive/005_create_recurring_charges.sql \
  migrations/phase1-additive/006_create_service_requests.sql \
  migrations/phase1-additive/007_add_contact_type_column.sql \
  migrations/phase1-additive/007b_add_is_important_column.sql \
  migrations/phase1-additive/008_backfill_workspaces.sql \
  migrations/phase1-additive/009_backfill_entities.sql \
  migrations/phase1-additive/010_backfill_agreements.sql \
  migrations/phase1-additive/011_backfill_recurring_charges.sql \
  migrations/phase1-additive/012_backfill_service_requests.sql \
  migrations/phase1-additive/013_add_sender_name_to_messages.sql \
  migrations/phase1-additive/014_add_matched_charge_id_to_payment_events.sql ; do
    echo "=== Running $f ==="
    psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f "$f" || { echo "FAILED on $f"; break; }
done
```

Prefer running files one at a time during the first pass in staging so each `RAISE NOTICE` line is easy to read in isolation.

## Post-run verification

After the first run in staging, confirm the invariants from plan §8.1:

- `COUNT(workspaces) == COUNT(users)`
- `COUNT(entities) == COUNT(workspaces)`
- `COUNT(recurring_charges) == COUNT(rent_payments)`
- `COUNT(service_requests) == COUNT(maintenance_tickets)`
- `COUNT(agreements) == COUNT(contacts WHERE lease_end IS NOT NULL AND lease_end != '')`
- `COUNT(contacts WHERE contact_type = 'tenant') >= COUNT(contacts WHERE type = 'resident' OR type IS NULL OR type = '')` (per 007 remap)
- `COUNT(contacts WHERE is_important = true) == COUNT(contacts WHERE type = 'important')` (per 007b)
- `COUNT(messages WHERE sender_name = resident) == COUNT(messages)` (per 013)
- `COUNT(payment_events WHERE matched_rent_id IS NOT NULL AND matched_charge_id IS NULL) == 0` excluding orphan references (per 014). Orphan count is reported by 014's `RAISE NOTICE`; any non-orphan row with `matched_rent_id` set must have `matched_charge_id` populated.

Check `migration_audit` for the pre-migration snapshot:

```sql
SELECT migration_key, snapshot_label, row_count, captured_at, snapshot
FROM migration_audit
ORDER BY captured_at;
```

Second run in staging: the same queries should return identical row counts (zero drift). Every file's `RAISE NOTICE` message should report `already exists; not overwriting` or equivalent.

## Rollback

Phase 1 rollback is a clean drop of the new tables plus removing the two new columns on `contacts` and the new column on `messages`:

```sql
DROP TABLE IF EXISTS service_requests CASCADE;
DROP TABLE IF EXISTS recurring_charges CASCADE;
DROP TABLE IF EXISTS vertical_configs CASCADE;
DROP TABLE IF EXISTS agreements CASCADE;
DROP TABLE IF EXISTS entities CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
ALTER TABLE contacts DROP COLUMN IF EXISTS contact_type;
ALTER TABLE contacts DROP COLUMN IF EXISTS is_important;
ALTER TABLE messages DROP COLUMN IF EXISTS sender_name;
ALTER TABLE payment_events DROP COLUMN IF EXISTS matched_charge_id;
DROP INDEX IF EXISTS payment_events_matched_charge_id_idx;
-- The audit table is retained deliberately for any post-mortem analysis.
-- DROP TABLE IF EXISTS migration_audit;  -- optional
```

See `docs/schema-migration-risks.md` §4.1 for the canonical rollback.
