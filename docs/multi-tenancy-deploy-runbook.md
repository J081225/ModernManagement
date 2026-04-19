# Multi-Tenancy Merge & Deploy Runbook

**Purpose:** one-source-of-truth execution checklist for merging `fix/multi-tenancy` into `main` and deploying to production.

**Read before starting:** `docs/multi-tenancy-merge-risk.md` (the full risk assessment). This runbook is the execution script for the recommendation in §7 of that doc.

**Scope:** every action from "now" until "production confirmed healthy on the merged code".

**Conventions in this doc:**
- 👤 = action the user performs (you)
- 🤖 = action the agent performs
- ✅ = verification step that gates the next action
- 🛑 = abort condition — stop immediately and revert

---

## Pre-flight (checks before any merge commands run)

### Step 0.1 — Render `SESSION_SECRET` confirmed set

👤 Follow the "Render walkthrough" in the session transcript (Check 1) to verify `SESSION_SECRET` is set on the production service.

✅ Env var visible in the Environment list with value dots (••••••••••) displayed — NOT missing from the list, and NOT showing as empty.

🛑 If `SESSION_SECRET` is missing: STOP. Set it first (any 64+ byte hex string), save, deploy, let the current main redeploy cleanly, then resume.

### Step 0.2 — Neon staging branch confirmed current

👤 Follow the "Neon staging branch walkthrough" in the session transcript (Check 3). Confirm `staging-phase0-20260418` still exists and its row counts match production.

✅ All row-count sanity queries on staging match production ±0.

🛑 If the staging branch is missing, stale, or has diverged from production: cut a fresh branch `staging-multi-tenancy-YYYYMMDD` off current production before continuing.

### Step 0.3 — Production snapshot taken

👤 In Neon console, confirm `pre-phase0-snapshot-20260418-v2` still exists (earlier rollback target), OR cut a fresh pre-merge snapshot:
- Name: `pre-multi-tenancy-merge-YYYYMMDD`
- Parent: `production`
- Data source: Current data
- Auto-delete: Never (or longest option)

✅ Snapshot branch visible on Neon Branches page.

🛑 If snapshot creation fails: do not proceed. Rollback target is mandatory.

### Step 0.4 — Post-deploy SQL ready

👤 Open `migrations/post-multi-tenancy-deploy/001_set_admin_twilio_number.sql` in your editor. Keep this file open in a browser tab or terminal window ready to paste. DO NOT run it yet.

✅ File open and ready.

---

## Phase A — Staging verification

### Step A.1 — Generate merged tree on staging's DB without touching main

Goal: prove the merged code runs clean against the current production schema (captured on staging).

Option 1 (simplest): run the merge locally into a throwaway branch, deploy to a Render staging service pointed at `staging-phase0-20260418`.

🤖 When you're ready, the agent will:
```bash
git checkout main
git pull origin main
git checkout -b test/multi-tenancy-merge-YYYYMMDD
git merge --no-ff fix/multi-tenancy -m "Test merge: multi-tenancy into main"
node --check server.js
```

✅ `node --check server.js` exits clean. No staging push yet — this branch is local-only for verification.

🛑 If `node --check` errors: stop. Investigate the merge result before continuing.

### Step A.2 — Deploy the test merge to Render staging (optional but strongly recommended)

👤 Decide: do you want a staging deploy before production, or are you comfortable deploying directly to production after the code-level verification?

If YES (staging deploy first, safer):
- In Render, edit the `modernmanagement-staging` service (if it exists from earlier multi-tenancy work)
- Change the Deploy Branch to `test/multi-tenancy-merge-YYYYMMDD`
- Change `DATABASE_URL` to the `staging-phase0-20260418` Neon connection string
- Confirm `SESSION_SECRET` is set on the staging service (separate value from production)
- Manual deploy

If NO (direct to production, faster, higher risk):
- Skip to Phase B.
- ⚠ This deviates from the risk assessment's recommendation. Acceptable only for single-user production where downtime has no external cost.

### Step A.3 — Run Tests A, C, H from the test plan

👤 In a terminal, follow exactly `docs/staging-test-plan.md`:
- Test A: Inbound SMS routes to User A's number → User A's inbox only
- Test C: Inbound SMS to unassigned number → dropped with warning
- Test H: Session persistence across restart

✅ All three tests pass with expected outcomes.

🛑 If any test fails: stop. Debug the specific routing/session issue before proceeding to production.

---

## Phase B — Merge to main

### Step B.1 — Start from clean local state

🤖 Agent will run:
```bash
git checkout main
git pull origin main
git status            # must report clean
git log --oneline -3  # confirm HEAD is 14d1b31 or newer
```

✅ Local main is clean and up to date with origin.

### Step B.2 — Create the merge commit (LOCAL ONLY, not pushed)

🤖 Agent will run:
```bash
git merge --no-ff fix/multi-tenancy -m "Merge multi-tenancy: inbound routing, drafts, sessions

Merges fix/multi-tenancy into main. See docs/multi-tenancy-merge-risk.md
for the full risk assessment. Key changes: dynamic inbound-webhook
routing by user, drafts table moved from in-memory to DB with auth,
sessions moved to connect-pg-simple PostgreSQL store.

Pre-deploy requires: SESSION_SECRET set on Render; admin user's
twilio_phone_number set in Neon (see migrations/post-multi-tenancy-deploy/).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

✅ Merge commit created. Report back the commit hash.

🛑 If merge produces conflict markers despite the dry-run saying clean: abort the merge with `git merge --abort` and do NOT push.

### Step B.3 — Verify the merge commit locally

🤖 Agent will run:
```bash
git log --oneline -5
git diff HEAD~1 -- server.js | head -50
node --check server.js
grep -n "automation.admin_seed" server.js
grep -n "SESSION_SECRET" server.js | head -3
```

✅ All checks green:
- `git log` shows the new merge commit at HEAD
- `node --check` passes
- `automation.admin_seed` still wrapped in migrate() (G1 fix preserved)
- `SESSION_SECRET` enforcement still present

🛑 If any verification fails: reset local main with `git reset --hard origin/main` to discard the merge, do not push.

---

## Phase C — Deploy to production

### Step C.1 — Final env var verification

👤 Open Render dashboard for production service (ModernManagement). Confirm `SESSION_SECRET` is still set in Environment. (Paranoid re-check.)

✅ Confirmed set.

🛑 If missing: set it now. Wait for current main to redeploy. Return to Step C.1.

### Step C.2 — Push the merge to origin

🤖 Agent will run:
```bash
git push origin main
```

✅ Push succeeds. Render auto-deploy triggered. Note the merge commit hash.

### Step C.3 — Watch Render deploy in real time

👤 In Render dashboard → ModernManagement → Logs tab. Watch deploy start.

Expected log sequence:
```
==> Cloning from https://github.com/J081225/ModernManagement
==> Checking out commit <merge-sha>
==> Running 'npm install'
...
==> Running 'node server.js'
Server running on http://localhost:10000
DB init complete.
==> Your service is live 🎉
```

✅ `DB init complete.` appears. Service goes live.

🛑 If you see `FATAL: SESSION_SECRET environment variable is not set.`: the env var is still missing. Set it in Render, redeploy. Continue watching logs.

🛑 If you see `DB init attempt N failed:` (any reason): check the specific error. Investigate before continuing.

### Step C.4 — Run the post-deploy SQL immediately

👤 The moment the service is live, open Neon SQL Editor. Switch to `production` branch (verify breadcrumb shows `production`).

Paste the contents of `migrations/post-multi-tenancy-deploy/001_set_admin_twilio_number.sql`:
```sql
UPDATE users SET twilio_phone_number = '+18555350785' WHERE id = 1;
SELECT id, username, twilio_phone_number FROM users WHERE id = 1;
```

✅ UPDATE returns `1 row affected`. SELECT confirms `twilio_phone_number = '+18555350785'`.

🛑 If UPDATE affects 0 rows: the users table changed shape. Stop. Investigate.

---

## Phase D — Post-deploy verification

### Step D.1 — Session store verification

👤 In Neon SQL Editor on production branch:
```sql
SELECT COUNT(*) FROM user_sessions;
SELECT COUNT(*) FROM drafts;
```

✅ Both queries return a number (0 is fine — tables just need to exist).

🛑 If either query errors "relation does not exist": `initDB()` didn't complete. Check Render logs for migration failures.

### Step D.2 — User routing columns verification

👤 In Neon SQL Editor on production branch:
```sql
SELECT id, username, twilio_phone_number, inbound_email_alias
FROM users ORDER BY id;
```

✅ Admin (id=1) shows `twilio_phone_number = '+18555350785'` and a non-null `inbound_email_alias`. User 2 shows nulls for `twilio_phone_number` and an auto-generated `inbound_email_alias`.

### Step D.3 — Smoke test: login survives a restart

👤 In a browser:
1. Open https://modernmanagementapp.com/login
2. Log in as admin
3. Confirm you land on the workspace
4. In Render dashboard, click "Manual Deploy → Clear build cache & deploy" (or any restart that cycles the process)
5. Wait for "Your service is live" again (~90 seconds)
6. Refresh the browser

✅ You remain logged in. If you stay logged in through the restart, `connect-pg-simple` is working correctly.

🛑 If you're logged out immediately after the restart: the pgSession store isn't being used. Check Render logs for `connect.session() MemoryStore` warning — if it's still there, connect-pg-simple failed to initialize.

### Step D.4 — Smoke test: inbound SMS routes correctly (OPTIONAL but strongly recommended)

👤 From your phone, send a real text message to `+18555350785`. Any short message.

✅ Within ~30 seconds, the message appears in the Modern Management inbox when you log in as admin.

🛑 If the message never appears:
- Check Render logs for `Inbound SMS to unrecognized number` warning
- If present, `twilio_phone_number` on admin didn't save. Re-run Step C.4.
- If absent, Twilio verification may have lapsed. Check Twilio dashboard.

### Step D.5 — Drafts isolation smoke test (LOW PRIORITY)

Only relevant once >1 user is actually using drafts. Skippable for the single-user launch.

If you want to verify: sign up a test user in an incognito window, create a draft, log out, log back in as admin, confirm the draft does NOT appear in admin's drafts list.

---

## Phase E — Declare victory

After D.1–D.4 are green:

🤖 Agent will clean up:
```bash
git branch -d test/multi-tenancy-merge-YYYYMMDD    # delete the local test branch
git fetch --prune
```

👤 Confirm in GitHub:
- `main` shows the new merge commit at HEAD
- Commit graph shows the merge: 3 commits from `fix/multi-tenancy` converging with 4 commits from `main`

✅ Multi-tenancy fully deployed. `fix/multi-tenancy` branch can remain on origin as history; optionally delete with `git push origin --delete fix/multi-tenancy` once the merge is stable for 48 hours.

---

## Abort conditions — universal rollback procedure

At ANY point from C.2 onwards, if something looks wrong:

🤖 Agent will run:
```bash
# Find the merge commit hash from git log
git log --oneline -5
# Revert the merge (use -m 1 to keep main as the mainline parent)
git revert -m 1 <merge-commit-sha> --no-edit
git push origin main
```

Render auto-deploys the revert. The `user_sessions`, `drafts` tables, and `twilio_phone_number`/`inbound_email_alias` columns remain in the DB (harmlessly, since the reverted code doesn't reference them).

Users will be logged out one more time (session store went Postgres → memory again). That's acceptable.

No data loss. No destructive state changes.

---

## After all is well — follow-up tasks

1. 🤖 Commit the post-deploy SQL file to the repo (it's already in `migrations/post-multi-tenancy-deploy/001_set_admin_twilio_number.sql` but currently untracked on main).
2. 🤖 Commit this runbook.
3. 👤 Schedule a 48-hour observation window before merging anything else to main. Keep an eye on Render logs for any unexpected errors.
4. 👤 When comfortable, delete old Neon branches no longer needed: the old `staging` branch, the compromised `pre-phase0-snapshot-20260418` (keep -v2 as the enduring rollback target).

---

**This runbook is the execution script. Every action on merge night should match a step here. If something happens that isn't in this runbook, stop and update the runbook before continuing.**
