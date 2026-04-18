# Phase 0 Reconciliation — Go/No-Go Checklist

**Purpose:** Bring production schema into alignment with what `server.js` on `main` currently expects. This is NOT part of the vertical-agnostic schema generalization plan. This is pure catch-up for migrations that have been silently failing.

**Single SQL file:** `/migrations/phase0-reconciliation/001_catchup.sql`

**Estimated time in production:** under 30 seconds (all operations are fast — no backfills across large tables).

**Rollback safety:** every operation is additive or data-preserving. No columns are dropped, no data is deleted.

---

## A. Pre-execution verification

- [ ] **A1.** Read `docs/schema-reality-gap.md` end to end and confirm the gap analysis matches what you see on production.
- [ ] **A2.** Open the Neon console. Confirm the project and branch shown match the production connection string on Render (`DATABASE_URL`). Do NOT proceed if you aren't 100% sure you're looking at production.
- [ ] **A3.** Check Render logs for the last few cold starts. Confirm the error `DB init attempt 1 failed: column "user_id" of relation "automation" does not exist` (or similar) appears. If a DIFFERENT error appears, the root cause may differ from this analysis — stop and investigate.
- [ ] **A4.** In Neon SQL editor, run: `SELECT COUNT(*) FROM automation;` — note the row count. If it is > 1, there may be additional data to preserve; review the catch-up script's Step 1 logic.
- [ ] **A5.** In Neon SQL editor, run: `SELECT id, username FROM users ORDER BY id;` — note how many users exist. Anything beyond user 1 means new signups have been breaking, confirming the payment_forward_token gap.

## B. Fresh snapshot (rollback target)

- [ ] **B1.** In the Neon console, take a branch snapshot of production. Name it `pre-phase0-catchup-YYYYMMDD` (today's date). This is the only rollback target — do NOT skip this step.
- [ ] **B2.** Record the snapshot timestamp and connection string in a local scratchpad. Do not share.

## C. Dry-run on staging

Staging first. Always.

- [ ] **C1.** Cut a fresh Neon branch off production named `staging-phase0-catchup-YYYYMMDD`. Do NOT reuse older staging branches — they have diverged.
- [ ] **C2.** In the Neon SQL editor for the staging branch, run the full contents of `migrations/phase0-reconciliation/001_catchup.sql`.
- [ ] **C3.** Verify the final `RAISE NOTICE` block reports:
  - `users columns added (should be 6): 6`
  - `contacts columns added (should be 3): 3`
  - `email_accounts table exists: t`
  - `payment_events table exists: t`
  - `automation.user_id column present: t`
- [ ] **C4.** Verify no errors were thrown. The script uses `BEGIN; ... COMMIT;` — a failure would roll back everything.
- [ ] **C5.** Re-run the script against the same staging branch. Second run must be a no-op (all `IF NOT EXISTS` guards skip). All `RAISE NOTICE` lines report "already present" or "0 backfilled".
- [ ] **C6.** Smoke test against staging (point a throwaway Render service at the staging branch if easiest, or run manual `psql` queries):
  - `INSERT INTO users (username, password_hash, email, plan, payment_forward_token) VALUES ('test', 'x', 'x', 'free', 'xxx') RETURNING id;` — should succeed.
  - `SELECT * FROM email_accounts LIMIT 0;` — should return zero rows with correct columns.
  - `SELECT * FROM payment_events LIMIT 0;` — same.
  - `SELECT user_id, "autoReplyEnabled" FROM automation;` — returns admin row.

## D. Production execution

Only after A, B, C are all green.

- [ ] **D1.** Pick a low-traffic window. Evening hours work best.
- [ ] **D2.** In Neon SQL editor, switch to the production branch. Verify with `SELECT current_database();` — match against Render's `DATABASE_URL` host.
- [ ] **D3.** Paste the full contents of `migrations/phase0-reconciliation/001_catchup.sql` into the editor. Execute.
- [ ] **D4.** Watch the `RAISE NOTICE` output. Capture it to a local log file with timestamps.
- [ ] **D5.** Confirm the final-state block shows the same all-green state as staging did in C3.
- [ ] **D6.** If ANY step fails: the transaction rolls back automatically. Nothing will have changed. Investigate the specific error before retrying.

## E. Post-execution verification

- [ ] **E1.** In Render dashboard, trigger a manual redeploy of the production service.
- [ ] **E2.** Watch the Render logs during the redeploy. Confirm `DB init complete.` now appears (instead of `DB init attempt N failed`).
- [ ] **E3.** Smoke test production via the app UI:
  - [ ] Admin login works.
  - [ ] Admin → Notification Settings loads (no 500).
  - [ ] Admin → Billing Plan loads (shows current plan).
  - [ ] Admin → Auto-Match Payments loads and displays the forwarding address.
  - [ ] Admin → Property Email Connection loads.
  - [ ] Onboarding wizard does NOT re-appear after dismissal.
  - [ ] Contacts page loads; adding a contact with a lease_end value persists across refresh.
  - [ ] Home page Lease Expirations card reflects real lease data (may still be empty if no residents have lease_end set — but no longer 500s).
  - [ ] Signup a brand-new test user on a private browser session — completes successfully.

## F. Documentation and commit

- [ ] **F1.** Commit `/migrations/phase0-reconciliation/001_catchup.sql`, `/docs/schema-reality-gap.md`, and `/docs/phase0-reconciliation-checklist.md` to a new branch `fix/phase0-catchup`.
- [ ] **F2.** Merge `fix/phase0-catchup` to `main` — no code changes needed in `server.js`; the migrations already exist in `initDB()`, they just won't fire any more because the schema now matches.
- [ ] **F3.** In the PR description, reference this checklist, the schema-reality-gap doc, and paste the Render log excerpt showing `DB init complete.` post-execution.

## G. Follow-up cleanup (non-blocking)

- [ ] **G1.** Edit `server.js:472` to wrap the `INSERT INTO automation` in `migrate()` instead of raw `pool.query()` — this prevents any future chain failure of the same kind.
- [ ] **G2.** Schedule merge of `fix/multi-tenancy` branch (separate exercise — has its own checklist).
- [ ] **G3.** Continue with `plan/schema-generalization` Phase 1 only after G1 + G2 are complete.

---

## Decision gate

Phase 0 is complete when **every box in E is green**.

If ANY step fails at any point: stop. The transaction in the SQL file auto-rolls back. No data can be lost. Investigate the error, document it, and seek human review before retrying.

Do NOT proceed to `plan/schema-generalization` Phase 1 until Phase 0 is fully green and the `server.js:472` fix (G1) is merged. Otherwise the same chain-failure mechanism will recur with the NEW migrations.
