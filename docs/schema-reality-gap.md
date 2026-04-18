# Schema Reality Gap — Production vs. Codebase Audit

**Generated:** 2026-04-18
**Source of truth:** Live `information_schema.columns` dump from production Neon DB
**Compared against:** `docs/codebase-audit.md` (which describes what `server.js` on `main` expects) and `server.js` on `main` at commit `b71e149`
**Status:** Analysis-only. No SQL has been run. No code has been modified.

---

## Executive summary

Production is missing **2 tables** and **9 columns** that `server.js` on `main` actively references. The root cause is a single unwrapped `pool.query()` call inside `initDB()` at `server.js:472` which throws on every cold start, aborting `initDB()` before the downstream migrations can run. Because the error is caught by the top-level retry loop (`initDBWithRetry`, 5 attempts) and then swallowed, the server keeps serving traffic — silently degraded.

| | Count |
|---|---|
| Tables in code, missing from production | **2** (`email_accounts`, `payment_events`) |
| Columns in code, missing from production | **9** (6 on `users`, 3 on `contacts`) |
| Table with structural mismatch | **1** (`automation` — has `id` column where code expects `user_id` as primary key) |
| Extra columns on production, not in code | **0** |
| User-facing features actively broken | **3** (payment forwarding, Stripe billing, notification email, lease tracking, IMAP/SMTP email, lease renewal alerts, onboarding flag) |

---

## Section 1 — Per-table gap

### 1.1 `users`

| Column | In code | In production | Notes |
|---|---|---|---|
| `id` | ✓ | ✓ | |
| `username` | ✓ | ✓ | |
| `password_hash` | ✓ | ✓ | |
| `email` | ✓ | ✓ | |
| `plan` | ✓ | ✓ | |
| `created_at` | ✓ | ✓ | |
| `notification_email` | ✓ (migration L480) | **MISSING** | Notification email routing broken |
| `notifications_enabled` | ✓ (migration L481) | **MISSING** | Notification toggle has no backing column |
| `onboarding_completed` | ✓ (migration L484) | **MISSING** | Onboarding wizard re-appears every login |
| `stripe_customer_id` | ✓ (migration L485) | **MISSING** | Stripe Checkout flow can't persist customer ID |
| `stripe_subscription_id` | ✓ (migration L486) | **MISSING** | Stripe webhook can't update plan status |
| `payment_forward_token` | ✓ (migration L489) | **MISSING** | Payment auto-match feature is broken |

### 1.2 `contacts`

| Column | In code | In production | Notes |
|---|---|---|---|
| `id`, `name`, `type`, `unit`, `email`, `phone`, `notes`, `user_id` | ✓ | ✓ | |
| `lease_start` | ✓ (migration L475) | **MISSING** | Lease start field on contact modal does not persist |
| `lease_end` | ✓ (migration L476) | **MISSING** | Lease expiration tracking is silently broken |
| `monthly_rent` | ✓ (migration L477) | **MISSING** | Rent auto-generation reads this — currently gets nothing |

### 1.3 `automation`

**Structural mismatch, not just missing columns.**

Code (server.js:466–470) expects:
```sql
CREATE TABLE automation (
  user_id INTEGER PRIMARY KEY,
  "autoReplyEnabled" BOOLEAN DEFAULT false
);
```

Production has:
```sql
automation (
  id INTEGER,               -- where code expects user_id
  "autoReplyEnabled" BOOLEAN
);
```

**Impact:** every `SELECT * FROM automation WHERE user_id = $1` (code line 612) throws `column "user_id" does not exist`. The seed INSERT at line 472 (`INSERT INTO automation (user_id, "autoReplyEnabled") VALUES (1, false) ON CONFLICT DO NOTHING`) also throws, which is the root cause of the chain failure described in §3.

### 1.4 `email_accounts`

**TABLE MISSING ENTIRELY.** Code expects this structure (server.js:493–506):
```sql
CREATE TABLE email_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  email TEXT NOT NULL,
  provider TEXT DEFAULT 'custom',
  imap_host TEXT NOT NULL,
  imap_port INTEGER DEFAULT 993,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER DEFAULT 465,
  encrypted_password TEXT NOT NULL,
  last_sync_uid INTEGER DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  sync_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

All IMAP/SMTP connection features are broken.

### 1.5 `payment_events`

**TABLE MISSING ENTIRELY.** Code expects this structure (server.js:512–528):
```sql
CREATE TABLE payment_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  raw_from TEXT DEFAULT '',
  raw_subject TEXT DEFAULT '',
  raw_body TEXT DEFAULT '',
  parsed_tenant TEXT DEFAULT '',
  parsed_amount NUMERIC(10,2) DEFAULT 0,
  parsed_date TEXT DEFAULT '',
  parsed_source TEXT DEFAULT '',
  confidence TEXT DEFAULT 'low',
  matched_rent_id INTEGER,
  status TEXT DEFAULT 'needs_review',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
```

All payment auto-match (email forwarding → rent paid) features are broken.

### 1.6 Tables that DO match exactly

No gaps found on these — columns in production match the codebase-audit document exactly:

- `messages` — all 11 columns present
- `tasks` — all 9 columns present
- `maintenance_tickets` — all 15 columns present
- `cal_events` — all 4 columns present
- `budget_transactions` — all 9 columns present
- `rent_payments` — all 10 columns present (including the `paid_date` migration — see §3 note)
- `invoices` — all 9 columns present
- `knowledge` — all 6 columns present
- `broadcasts` — all 10 columns present

### 1.7 Extra columns on production not in audit

**None found.** Every column on production is accounted for in the codebase audit.

---

## Section 2 — Code paths broken by each gap

For each missing piece, every `server.js:main` line number that references it. Assume **every one of these routes will throw** at runtime if reached.

### 2.1 `users.notification_email` and `users.notifications_enabled`

- **L624** — `sendNotificationEmail()` helper: `SELECT notification_email, notifications_enabled FROM users WHERE id=$1` — throws when any inbound message triggers the helper. Caught by `try/catch` in the helper → just skips notification silently.
- **L702** — `GET /api/settings` — SELECT fails → 500 response. The Admin → Notification Settings page breaks.
- **L709–712** — `PUT /api/settings` — UPDATE fails → 500 response. Saving notification preferences is impossible.

### 2.2 `users.onboarding_completed`

- **L768** — `GET /api/me` — SELECT fails → 500 response on page load after signup/login.
- **L775** — `PUT /api/me/onboarding` — UPDATE fails → onboarding wizard can never be dismissed. User sees it every login.

### 2.3 `users.stripe_customer_id` and `users.stripe_subscription_id`

- **L2521, L2528** — `POST /api/billing/create-checkout` — read/write `stripe_customer_id`. Every Upgrade button click fails.
- **L2550–2551** — `GET /api/billing/portal` — SELECT fails → customer portal link unavailable.
- **L2583, L2590, L2598** — `POST /api/billing/webhook` — Stripe webhook handlers fail silently; subscription events don't propagate to user records. Paid customers may not be marked as Pro.

### 2.4 `users.payment_forward_token`

- **L531, L535** — `initDB()` backfill block (currently unreachable due to chain failure).
- **L744** — `POST /api/signup` — **INSERT into users with this column fails** → signup is broken for any user after the chain break.
- **L892, L895, L898** — `GET /api/payments/forwarding-info` — SELECT fails; Admin → Auto-Match Payments card cannot load the forwarding address.
- **L911** — `POST /api/payments/rotate-token` — UPDATE fails.
- **L1958** — `/api/email/incoming` payment routing — SELECT fails; forwarded payment emails cannot find the target user.

### 2.5 `contacts.lease_start`, `lease_end`, `monthly_rent`

- **L1015, L1018, L1020** — `PUT /api/contacts/:id` — UPDATE fails whenever user edits a contact with lease info filled in.
- **L1036–1039** — `GET /api/leases` — SELECT explicitly filters `WHERE lease_end IS NOT NULL AND lease_end != ''` → always returns empty. Home page Lease Expirations card always shows zero leases, regardless of what residents exist.
- **L1052–1053** — `POST /api/leases/check-renewals` — same issue; auto-task generation never fires.
- **L1067, L1069, L1080** — AI command bar renewal logic reads `c.lease_end` — returns undefined.
- **L1534** — AI system prompt context builder — silently drops lease/rent info from the context block sent to Claude.

### 2.6 `automation.user_id` (structural)

- **L472** — `initDB()` seed INSERT **throws on every server restart.** This is the root cause of the chain failure.
- **L612** — `getAutomation(userId)` — thrown error per inbound message. The function does not catch; callers (inbound SMS L2094, inbound email L2007, voicemail L2145, etc.) get a rejected promise. Net effect: auto-reply logic never runs, task suggestions from inbound messages never run.
- **L615** — same function, the fallback INSERT is equally broken.
- **L749** — `POST /api/signup` — creates an automation row for a new user; fails. Signup fails here even if L744 succeeded.
- **L1275** — `PUT /api/automation` — UPSERT fails → Operations page auto-reply toggle cannot be saved.

### 2.7 `email_accounts` (table missing)

- **L178** — `sendViaConnectedAccount()` — SELECT returns error.
- **L204** — `syncEmailAccount()` — SELECT returns error; background sync worker (5-minute interval) logs error every cycle.
- **L252, L256** — sync-state UPDATE fails.
- **L284** — `runPeriodicEmailSync()` — SELECT fails; worker effectively does nothing.
- **L786** — `GET /api/email-account` — Admin → Property Email Connection card cannot load.
- **L842** — `POST /api/email-account/connect` — INSERT fails; "Connect & Save" never works.
- **L881** — `DELETE /api/email-account` — fails (but nothing to delete anyway).
- **L2034** — `POST /api/email/send` — conditional SELECT to check for connected account; fails, falls through to SendGrid fallback (so outbound still works).

### 2.8 `payment_events` (table missing)

- **L923** — `GET /api/payments/events` — SELECT fails → Admin → Auto-Match Payments events list cannot render.
- **L942** — `POST /api/payments/events/:id/confirm` — SELECT fails.
- **L951, L965** — status UPDATE fails.
- **L1997, L2010** — `processPaymentEmail()` inserts — forwarded payment emails silently fail to store an audit record.

---

## Section 3 — Root cause analysis

### Chain-failure mechanism

`initDB()` in `server.js:main` runs in this order:

```
Lines 297–463:  CREATE TABLE / INSERT seed / migrate() calls — OK
  (these use migrate() wrapper or guarded INSERTs)

Line 472:       await pool.query(`INSERT INTO automation (user_id, ...) ...`);
                ^^ RAW pool.query, NOT wrapped in migrate().
                ^^ Throws on production because automation.user_id doesn't exist.
                ^^ Exception propagates up through initDB().
                ^^ Everything below NEVER RUNS.

Lines 475–489:  migrate() calls for contacts.lease_*, users.notification_*,
                users.stripe_*, users.onboarding_completed, users.payment_forward_token.
                ALL SKIPPED on every restart.

Lines 493–528:  CREATE TABLE email_accounts, payment_events.
                BOTH SKIPPED.

Lines 540–605:  Other tables (rent_payments, invoices, knowledge, broadcasts) and
                migrations.
                ALL SKIPPED.
```

### Why is the error invisible?

`initDBWithRetry()` (around server.js:2632) wraps `initDB()` in `try/catch`:

```js
async function initDBWithRetry(attempt = 1) {
  try {
    await initDB();
  } catch (err) {
    console.error(`DB init attempt ${attempt} failed:`, err.message);
    if (attempt < 5) setTimeout(() => initDBWithRetry(attempt + 1), delay);
    else console.error('DB init failed after 5 attempts...');
  }
}
```

- The error is logged to Render logs: `DB init attempt N failed: column "user_id" of relation "automation" does not exist`
- 5 retries run with backoff (2s, 4s, 6s, 8s, 10s), all fail the same way
- After the 5th failure, the message "DB init failed after 5 attempts" is logged
- **`app.listen()` was already called before `initDBWithRetry()`**, so the server keeps serving HTTP — silently degraded

### Why do `rent_payments`, `invoices`, `knowledge`, `broadcasts` exist on production?

These are created by `CREATE TABLE IF NOT EXISTS` statements AFTER line 472. For them to exist on production, `initDB()` must have previously succeeded end-to-end. This implies the `automation` table's broken state developed **after** those tables were created — most likely via a `DROP TABLE automation CASCADE` at some point (possibly the earlier staging debugging session; possibly a manual operation), followed by a recreation with the wrong primary key (either via a prior code version that used `id SERIAL PRIMARY KEY` or via manual re-creation).

### Is this in the Render logs?

**Highly likely.** The exact error message `DB init attempt 1 failed: column "user_id" of relation "automation" does not exist` should appear at every cold start. Recommend checking Render logs for the past 48 hours to confirm.

### State of `fix/multi-tenancy` branch

- **NOT merged to main.** Confirmed via `git log main --oneline -20` — no commit from `fix/multi-tenancy` appears in main's history.
- Last production deploy was commit `b71e149` (FAQ update from `feat/legal-pages` merge).
- `drafts` table: not in production (expected — branch unmerged).
- `user_sessions` table: not in production (expected — branch unmerged; this table would be auto-created by `connect-pg-simple` once the branch merges).
- `users.twilio_phone_number`, `users.inbound_email_alias`: not in production (expected — branch unmerged).

**Important:** The `fix/multi-tenancy` branch also contains the sessions-store fix (`connect-pg-simple`) and the `drafts` isolation fix. Neither is live. Sessions still use in-memory store → users get logged out on every Render restart. Drafts are still a shared in-memory array → any draft a user creates is visible to every other user who hits the `/api/drafts` route.

---

## Section 4 — Risk classification

| Gap | Risk | Evidence | Impact |
|---|---|---|---|
| `automation.user_id` structural mismatch | **CRITICAL** | `initDB()` chain failure at every restart; blocks all downstream migrations | Blocks all of §4 below from ever being applied on future deploys |
| `users.payment_forward_token` missing | **CRITICAL** | Referenced in `POST /api/signup` (L744) — new user signup throws | Signup is broken for any new user |
| `email_accounts` table missing | **CRITICAL** | Admin → Property Email Connection entirely broken; background sync worker errors every 5 min | Users paying for IMAP/SMTP connection get a broken feature; periodic log noise |
| `payment_events` table missing | **CRITICAL** | Payment auto-match feature entirely broken | Forwarded payment emails are silently dropped; rent cannot be auto-marked |
| `users.stripe_customer_id`, `stripe_subscription_id` missing | **CRITICAL** | `POST /api/billing/create-checkout` fails | Paid upgrades are broken |
| `contacts.lease_start/end/monthly_rent` missing | **DEGRADED** | `GET /api/leases` always returns empty; renewal tasks never generated | Lease expiration feature silently returns wrong (empty) data |
| `users.onboarding_completed` missing | **DEGRADED** | Onboarding wizard shows every login | UX annoyance; no data loss |
| `users.notification_email`, `notifications_enabled` missing | **DEGRADED** | Notification emails never fire; Settings save returns 500 | UX bug |
| In-memory `drafts` shared across users (unmerged fix) | **DORMANT** → **CRITICAL** when users > 1 | In-memory array shared globally | Privacy breach as soon as a second user signs up |
| In-memory session store (unmerged fix) | **DEGRADED** | Users logged out on every Render restart | UX annoyance |
| `users.twilio_phone_number`, `inbound_email_alias` (unmerged fix) | **DORMANT** | Inbound SMS/email still routes to `WEBHOOK_USER_ID=1` | Would break multi-tenancy the moment a second user's Twilio number goes active |

### What I am not classifying as a gap

- Tables and columns from the `plan/schema-generalization` branch (`workspaces`, `entities`, `agreements`, `recurring_charges`, `service_requests`, `vertical_configs`, `contact_type`, `is_important`, `sender_name`, `matched_charge_id`) are **expected to be missing** — that branch is still a planning document. They are out of scope for this reconciliation.

---

## Section 5 — What the catch-up migration must do

Produce a single file, `/migrations/phase0-reconciliation/001_catchup.sql`, that:

1. **Fixes the `automation` table** without losing data. The approach:
   - Create a new `automation_new` table with the correct schema.
   - Copy whatever data exists in the old table (there may be 0 or 1 rows).
   - Drop the old table.
   - Rename the new one.
   - Re-seed the admin row.

2. **Adds the 9 missing columns** using `ALTER TABLE ADD COLUMN IF NOT EXISTS` — idempotent and non-destructive.

3. **Creates the 2 missing tables** using `CREATE TABLE IF NOT EXISTS`.

4. **Backfills `payment_forward_token`** for the existing admin user (the initDB code already does this, but it's been unreachable).

5. **Does NOT include any `plan/schema-generalization` work.** Workspaces, entities, agreements, etc. are explicitly out of scope. This catch-up brings production in line with what `server.js:main` expects — nothing more.

6. **Is fully idempotent.** Safe to run twice. Safe to run after a partial previous attempt.

See the adjacent `/migrations/phase0-reconciliation/001_catchup.sql` for the actual SQL.

---

## Section 6 — Open questions for the user

1. **Is the dumped schema really production?** If the user accidentally dumped staging (e.g., during earlier multi-tenancy debugging we ran `DROP TABLE automation CASCADE` on the staging Neon branch), this analysis is about staging. Confirm by cross-checking the Neon branch name in the connection string used for the dump.
2. **Can we check Render logs for the "column user_id does not exist" error?** Confirming that error fires on every cold start would validate this entire analysis.
3. **Is there ANY data in the existing `automation` table on production?** Run `SELECT * FROM automation;` and report row count. The catch-up migration needs to know whether to preserve or ignore.
4. **Are there any users besides user 1 (admin) on production?** Run `SELECT id, username FROM users;` — if there's more than one user, the `POST /api/signup` failure has been affecting new signups and we need to know how many.
5. **When did this gap first appear?** Correlating a Git history bisection with Neon branch snapshots may answer this, but it's not strictly required to fix the problem — the catch-up migration is the same regardless.
