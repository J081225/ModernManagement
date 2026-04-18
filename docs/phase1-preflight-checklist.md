# Phase 1 Pre-Flight Checklist

**Use this document as the operational gate before executing ANY Phase 1 SQL.**

Work top-to-bottom. Do NOT start Phase 1 in production until every box is checked.

---

## A. Production audits (per Decision §9.9)

- [ ] **A1.** Audit 1 queries from `docs/pre-phase1-audit-queries.md` §Audit 1 run against production. Results pasted back to the session.
- [ ] **A2.** Audit 2 queries from `docs/pre-phase1-audit-queries.md` §Audit 2 run against production. Results pasted back.
- [ ] **A3.** Based on Audit 1 results: confirm whether 007b should use the **refined** (tenant-vs-other split based on `has_lease OR has_rent`) or **simple** (all rewritten to `'other'`) rule. Update `007b_add_is_important_column.sql` if refined.
- [ ] **A4.** Based on Audit 2 results: confirm whether 007's default for blank `type` should stay `'tenant'` (current) or change to `'other'` (safer if blanks are unclassified). Update `007_add_contact_type_column.sql` if changing.
- [ ] **A5.** Audit 3 baseline row counts captured and saved locally.

## B. Staging environment (per Decision §9.7 as updated)

- [ ] **B1.** Fresh Neon branch cut off current production. Name: `staging-schema-gen-YYYYMMDD` where YYYYMMDD = today's date.
- [ ] **B2.** Parity check: run `COUNT(*)` on `users`, `contacts`, `rent_payments`, `maintenance_tickets`, `messages`, `payment_events` — staging vs production match exactly.
- [ ] **B3.** Neon connection string for the staging branch captured locally.
- [ ] **B4.** Pre-flight sanity query run against staging: `SELECT current_database(), current_user, version();` — confirms not accidentally hitting production.

## C. Snapshot (production rollback target)

- [ ] **C1.** Fresh Neon branch snapshot of production taken. Name: `pre-schema-gen-phase1-YYYYMMDD`.
- [ ] **C2.** Snapshot connection string saved locally (this is the rollback target).

## D. First staging run — correctness

Run all 14 files against the `staging-schema-gen-YYYYMMDD` branch in order (see `migrations/phase1-additive/README.md` §Invocation).

- [ ] **D1.** `001_create_workspaces.sql` — succeeds; `workspaces` table exists with `owner_user_id` column.
- [ ] **D2.** `002_create_entities.sql` through `006_create_service_requests.sql` — all succeed.
- [ ] **D3.** `007_add_contact_type_column.sql` — succeeds; `migration_audit` row for `'007_contact_type_pre'` exists; `RAISE NOTICE` reports four non-negative counts summing to `COUNT(contacts)`.
- [ ] **D4.** `007b_add_is_important_column.sql` — succeeds; `RAISE NOTICE` reports `N is_important` flagged AND `M contact_type` rewritten. (If using refined logic, three counts: `X→tenant, Y→other, total Z is_important`.)
- [ ] **D5.** `008`–`012` — all succeed.
- [ ] **D6.** `013_add_sender_name_to_messages.sql` — succeeds; `RAISE NOTICE` shows row count == `COUNT(messages)`.
- [ ] **D7.** `014_add_matched_charge_id_to_payment_events.sql` — succeeds; `RAISE NOTICE` shows backfilled count + orphan count.
- [ ] **D8.** All post-run invariants pass (see `migrations/phase1-additive/README.md` §Post-run verification):
  - `COUNT(workspaces) == COUNT(users)`
  - `COUNT(entities) == COUNT(workspaces)`
  - `COUNT(recurring_charges) == COUNT(rent_payments)`
  - `COUNT(service_requests) == COUNT(maintenance_tickets)`
  - `COUNT(agreements) == COUNT(contacts WHERE lease_end IS NOT NULL AND lease_end != '')`
  - `COUNT(contacts WHERE is_important = true) == COUNT(contacts WHERE type = 'important')`
  - `COUNT(messages WHERE sender_name = resident) == COUNT(messages)`
  - For rows where `matched_rent_id` is set and the corresponding `recurring_charges.legacy_id` exists: `matched_charge_id` is populated.

## E. Second staging run — idempotency

Re-run every file against the SAME staging branch.

- [ ] **E1.** Every file re-runs with zero errors.
- [ ] **E2.** Zero row-count deltas on every invariant from D8.
- [ ] **E3.** `RAISE NOTICE` output on the second run indicates idempotency paths firing (e.g., "already exists; not overwriting", zero rows updated).
- [ ] **E4.** `migration_audit` still has exactly one `migration_key = '007_contact_type_pre'` row (not duplicated).

## F. Production execution

Only proceed after A–E are all green.

- [ ] **F1.** Low-traffic deployment window chosen. No scheduled rent runs, no active broadcasts.
- [ ] **F2.** `pre-schema-gen-phase1-YYYYMMDD` snapshot confirmed accessible.
- [ ] **F3.** Phase 1 rollback SQL (from `migrations/phase1-additive/README.md` §Rollback) pasted into a scratchpad.
- [ ] **F4.** `SELECT current_database();` run against production as the first statement of the session — confirms target DB.
- [ ] **F5.** Files run in listed order, one at a time. `RAISE NOTICE` outputs captured to a log file.

## G. Post-production verification

- [ ] **G1.** All 8 invariants from D8 pass on production.
- [ ] **G2.** `migration_audit` has the pre-migration snapshot row.
- [ ] **G3.** Smoke test via the UI:
  - Log in as admin
  - View Contacts list (should be unchanged)
  - View Rent page (should be unchanged)
  - View Maintenance page (should be unchanged)
  - Send a test message (should appear in inbox)
  - View Admin → Payment Events (should show the same events as before)
- [ ] **G4.** No user-visible changes. No errors in Render logs.
- [ ] **G5.** Commit Phase 1 SQL to `plan/schema-generalization` branch with a message indicating production execution date.

---

## Decision: Go or No-Go

After G is green: Phase 1 is **complete**. Do NOT merge `plan/schema-generalization` to `main` yet — the branch will continue to accumulate Phase 2 code changes. Phase 2 begins in a separate session.

If ANYTHING fails at any step: stop, document the failure, and roll back. Rollback SQL is in `migrations/phase1-additive/README.md` §Rollback. The old tables are untouched so no data is lost.
