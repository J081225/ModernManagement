# Phase 3 — Cleanup

**DO NOT RUN these SQL files until every precondition below is satisfied.**

## Follow-up Work

**Migration-tool adoption:** per Decision §9.1, a migration-tool adoption pass must be scheduled **within 60 days of Phase 3 completing**. Candidates for evaluation:

- `node-pg-migrate` — lightweight, SQL-first, fits the existing hand-rolled pattern most naturally.
- `drizzle-kit` — heavier, schema-object-first, pairs with the Drizzle ORM if we ever introduce one.

The evaluation pass should: (a) inventory all live `migrate()` helper calls inside `initDB()` at that time, (b) formalize the existing `/migrations/phase*/` SQL files under the chosen tool's migration table, and (c) retire the inline `migrate()` helper in server.js.

## Preconditions

All of:

1. Every route in `migrations/phase2-code-cutover/README.md` sessions 2.1–2.4 has been cut over to read/write the new tables, merged to `main`, and deployed to production.
2. At least **7 consecutive calendar days** have elapsed since the final Phase 2 cutover hit production.
3. The daily drift-check SQL (see `docs/schema-migration-plan.md` §8.2) has returned **zero rows every day** for those 7 days.
4. Row count invariants hold on production:
   - `COUNT(recurring_charges WHERE charge_type='rent') >= COUNT(rent_payments)`
   - `COUNT(service_requests WHERE request_type='maintenance') >= COUNT(maintenance_tickets)`
   - `COUNT(agreements WHERE agreement_type='lease') >= COUNT(contacts WHERE lease_end IS NOT NULL AND lease_end != '')`
5. A fresh Neon branch snapshot has been taken: **`pre-schema-gen-phase3-YYYYMMDD`**.
6. The dual-write code in server.js has been removed in a separate commit that landed AT LEAST one hour before running these files. (Old tables should be fully read-only from the app's perspective when these files run.)
7. The user (the human reviewer) has personally run through the Go/No-Go checklist in `docs/schema-migration-risks.md` §5 "Before Phase 3".

## Run order

1. `001_drop_rent_payments.sql` — drops the `rent_payments` table (guarded).
2. `002_drop_maintenance_tickets.sql` — drops the `maintenance_tickets` table (guarded).
3. `003_remove_lease_columns_from_contacts.sql` — drops lease_start/lease_end/monthly_rent from contacts (guarded).
4. `004_drop_resident_from_messages.sql` — drops `messages.resident` once `sender_name` fully mirrors it (guarded on `resident IS DISTINCT FROM sender_name`). Added per Decision §9.5.
5. `005_drop_matched_rent_id_from_payment_events.sql` — drops `payment_events.matched_rent_id` once `matched_charge_id` fully covers it (guarded). Added per Decision §9.8.

### Additional preconditions for 004 and 005

- Phase 2 Sessions 2.4 and 2.5 have landed and been in production for at least 7 days.
- Every INSERT/UPDATE to `messages` during the soak period wrote BOTH `resident` and `sender_name`.
- Every INSERT/UPDATE to `payment_events.matched_rent_id` during the soak period also set `matched_charge_id` to the id of the corresponding `recurring_charges` row.
- The guard queries (embedded in 004 and 005) all return 0 on production before running.

Each guard raises an EXCEPTION and aborts if new-table counts don't meet or exceed old-table counts (or, for 004 and 005, if any drift is detected). This is by design.

## Deferred / user-decision cleanup

The following are NOT included as Phase 3 SQL files because they require user confirmation:

- **Dropping `contacts.type`**: user must confirm the new `contact_type` is authoritative. Until then, both columns exist. See `docs/schema-migration-plan.md` §9.3 and §9.4.
- **Dropping `legacy_id` from recurring_charges and service_requests**: recommended to keep for at least one more release cycle as an audit trail. When confident, run:
  ```sql
  ALTER TABLE recurring_charges DROP COLUMN legacy_id;
  ALTER TABLE service_requests  DROP COLUMN legacy_id;
  DROP INDEX IF EXISTS recurring_charges_legacy_id_uq;
  DROP INDEX IF EXISTS service_requests_legacy_id_uq;
  ```
- ~~**Dropping `payment_events.matched_rent_id`**: after `matched_charge_id` is in place and populated. Script not included here.~~ **Superseded:** per Decision §9.8, this is now covered by `005_drop_matched_rent_id_from_payment_events.sql`.

## Rollback

`DROP TABLE` is not reversible via SQL. Rollback is Neon branch restore:

1. In Neon, create a new branch from `pre-schema-gen-phase3-YYYYMMDD`.
2. Swap the app's `DATABASE_URL` to the restored branch.
3. `git revert` the Phase 3 commit on `main` and redeploy.

Data written to the new tables AFTER the snapshot and BEFORE the restore is lost. Minimize this window: take the snapshot immediately before running 001/002/003.

## After Phase 3

- Update `initDB()` in server.js so fresh databases come up with the final schema (no `rent_payments`, no `maintenance_tickets`, no lease columns).
- Remove the Phase 2 dual-write helper functions.
- Optionally: introduce a formal migration tool at this point (node-pg-migrate or equivalent).
- Optionally: open a follow-on project to refactor `views/app.html` labels to read from `vertical_configs.labels`.
