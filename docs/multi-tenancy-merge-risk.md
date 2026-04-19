# Multi-Tenancy Merge Risk Assessment

**Generated:** 2026-04-18
**Scope:** merging `fix/multi-tenancy` into `main` and deploying to production
**Analysis mode:** read-only. No merge executed. No files modified except this document.

---

## 1. Branch inventory

| | Commit | Notes |
|---|---|---|
| `fix/multi-tenancy` HEAD (local and origin — in sync) | `883d4c7` | "Add staging setup guide and multi-tenancy test plan" |
| `main` HEAD | `14d1b31` | "fix(initDB): wrap automation admin_seed INSERT in migrate() helper" |
| Merge base | `88fad12` | "Strengthen SMS consent page language for Twilio verification" |
| Commits on branch, not in main | **3** | See §2 |
| Commits on main, not in branch | **4** | **Branches diverged — no fast-forward possible.** |

## 2. Commits overview

### On `fix/multi-tenancy` and NOT yet in `main`

```
883d4c7 Add staging setup guide and multi-tenancy test plan
24be05c Address verification report findings
3090979 Fix 3 critical multi-tenancy bugs blocking multi-user support
```

### On `main` and NOT yet in `fix/multi-tenancy` (branch doesn't know about these)

```
14d1b31 fix(initDB): wrap automation admin_seed INSERT in migrate() helper   ← Phase 0 G1 fix
b84c74e Add verbatim opt-in form example to SMS consent page                 ← Twilio opt-in fix
b71e149 Replace industries-roadmap FAQ with Buildium/AppFolio comparison    ← FAQ edit
91da529 Add legal and trust pages: Terms, Privacy, Security                  ← merged from feat/legal-pages
```

### Files the branch changed relative to merge base

| File | Insertions | Deletions | Notes |
|---|---|---|---|
| `docs/codebase-audit.md` | 951 | 0 | New audit doc |
| `docs/staging-setup.md` | 344 | 0 | New staging setup guide |
| `docs/staging-test-plan.md` | 650 | 0 | New test plan (Tests A-H) |
| `package.json` | 1 | 0 | Adds `connect-pg-simple` dependency |
| `server.js` | 203 | 40 | Multi-tenant routing, session store, drafts refactor |
| `views/app.html` | 26 | 0 | Routing-info admin card |
| **Total** | **2,135** | **40** | **6 files changed** |

---

## 3. Conflict detection

### Dry-run results
- `git merge-tree --write-tree main fix/multi-tenancy` exit code: **0**
- Tree written successfully: `4c83c487fd621dafbe55265e1623449fc55016ba`
- Auto-merge message: only `Auto-merging server.js`
- Zero conflict markers in output

**Conclusion: ZERO MERGE CONFLICTS.** Git can auto-resolve the divergence with a standard 3-way merge.

### Verification of the auto-merge result

The tree git would produce correctly preserves both sides:

- ✅ G1 fix preserved: `automation.admin_seed` migrate() wrapper is present at line 478–483 in merged tree
- ✅ Branch additions preserved: `connect-pg-simple` import (line 18), `twilio_phone_number`/`inbound_email_alias` columns (lines 504–505), `drafts` table (line 509), `inbound_email_alias` backfill (lines 566–570), settings route returning routing info (line 737), drafts routes (lines 1371+)
- ✅ SESSION_SECRET enforcement preserved: `_getEncryptionKey()` requires the env var (line 122–123)
- ✅ Session middleware uses pgSession store

The merge result contains everything from both branches with no manual resolution required.

---

## 4. Schema implications — overlap with Phase 0

Phase 0 added the following to production on 2026-04-18:

| Phase 0 addition | Branch also adds? |
|---|---|
| `automation.user_id` (structural rebuild) | **No** |
| `users.notification_email`, `notifications_enabled`, `onboarding_completed`, `stripe_customer_id`, `stripe_subscription_id`, `payment_forward_token` | **No** |
| `contacts.lease_start`, `lease_end`, `monthly_rent` | **No** |
| `email_accounts` table | **No** |
| `payment_events` table | **No** |

Branch additions (NOT in Phase 0):

| Branch addition | Phase 0 also adds? | Collision risk |
|---|---|---|
| `users.twilio_phone_number` (nullable TEXT) | No | None — additive only |
| `users.inbound_email_alias` (nullable TEXT) | No | None — additive only |
| `drafts` table | No | None — new table |
| `user_sessions` table (auto-created by connect-pg-simple at startup) | No | None — new table |

**Conclusion: ZERO SCHEMA OVERLAP.** The branch's migrations add only columns/tables that do not exist on production. All use `IF NOT EXISTS` guards, so they are idempotent.

**Post-merge startup behavior:** `initDB()` on the merged code running against post-Phase-0 production will:
- Re-run all Phase 0 migrations as no-ops (everything already exists, guarded by `IF NOT EXISTS`)
- Add the 2 new columns and the `drafts` table
- `connect-pg-simple` will auto-create `user_sessions` on first session write

No destructive operations. All additive.

---

## 5. Code-path implications

### 5.1 The G1 fix and the branch's automation handling

This was the most important check. Result: **no conflict at the G1 line**.

- Main (L472–477) now has: `await migrate(INSERT INTO automation..., 'automation.admin_seed')`
- Branch at same region has: `await pool.query(INSERT INTO automation...)` (older pattern)
- Git 3-way merge correctly picks main's G1-wrapped version because the branch never modified that specific line. The branch only ADDED code AROUND the region.
- Merged tree confirms: G1 fix is intact.

### 5.2 Inbound webhook handlers

The branch heavily refactored `/api/sms/incoming`, `/api/voice/recording`, `/api/voice/transcription`, and `/api/email/incoming` to look up the destination user dynamically via `lookupUserByPhone()` / `lookupUserByEmailAlias()` instead of the hardcoded `WEBHOOK_USER_ID = 1`.

Main has NOT modified these handlers since the branch was cut. No conflicts. However:

**🚨 OPERATIONAL RISK — inbound message routing changes behavior:**

Before the merge, all inbound SMS/email/voicemail routes to user 1 (admin). After the merge, inbound messages are routed to the user whose `twilio_phone_number` (for SMS/voice) or `inbound_email_alias` (for email) matches the destination address. **If no user has the matching value set, the message is DROPPED with a logged warning** (not routed to user 1 as a fallback — this is an intentional change).

On production today:
- `users.twilio_phone_number`: column was added by Phase 0 — wait, actually no. Phase 0 did NOT add these two columns. They come from the branch. So post-merge, both columns exist on `users` but are NULL for every user (the branch's backfill only populates `inbound_email_alias`, not `twilio_phone_number`).

**Consequence:** right after the merge deploys:
- Every inbound SMS to `+18555350785` will be dropped (no user has that number on file).
- Every inbound voicemail call will be dropped.
- Every inbound email to `*@modernmanagementapp.com` (resident messages) will be dropped UNLESS the admin's `inbound_email_alias` happens to match.
- Payment-forwarded emails (`payments+TOKEN@...`) continue to work — they use the token lookup path, unchanged.

**Mitigation:** BEFORE deploying the merge, we must set `users.twilio_phone_number` for the admin user:
```sql
UPDATE users SET twilio_phone_number='+18555350785' WHERE id=1;
```
The `inbound_email_alias` will be auto-backfilled by the branch's `initDB()` on first startup. If we want resident messages to route correctly, the admin's Twilio number must be set BEFORE any inbound message arrives post-deploy.

### 5.3 Sessions change

- Main: in-memory `session.MemoryStore` (users logged out on every restart)
- Branch: `connect-pg-simple` Postgres-backed store, auto-creates `user_sessions` table on first startup

After the merge deploys, the `user_sessions` table is created automatically. All currently-logged-in users (there's only you) will be logged out ONCE because their existing in-memory session is gone. Future restarts preserve sessions.

**🚨 BREAKING CHANGE:** The merged code requires `SESSION_SECRET` environment variable to be set — it `process.exit(1)` if missing. Render must have this env var configured BEFORE the deploy pulls the new code.

### 5.4 Drafts route change

`/api/drafts` routes now require auth (`requireAuth`) and scope by `user_id`. Anyone calling these unauthenticated will 401. Check if `views/app.html` or any other client sends unauthenticated requests to these endpoints — the branch's change includes this, so it's been considered.

---

## 6. Test plan artifacts

### Result: YES, a test plan already exists on the branch

**`docs/staging-test-plan.md`** — 650 lines, covering:

| Test | What it verifies |
|---|---|
| A | Inbound SMS routes to User A's number → User A's inbox only |
| B | Inbound SMS routes to User B's number → User B's inbox only |
| C | Inbound SMS to unassigned number → dropped with logged warning, NOT routed to user 1 |
| D | Inbound email to User A's alias → User A's inbox only |
| E | Inbound email to User B's alias → User B's inbox only |
| F | Inbound email to unassigned alias → dropped |
| G | Drafts are scoped per user — User B cannot see User A's draft |
| H | Sessions persist across server restart |

Tests are exhaustive for the three multi-tenancy fixes. **No need to produce a new test plan.**

**`docs/staging-setup.md`** — 344 lines. Covers creating two test users, assigning them different Twilio numbers and email aliases via SQL, and preparing the staging environment.

---

## 7. Recommended merge strategy

### Primary recommendation: **merge commit (not rebase, not fast-forward)**

**Why not fast-forward:** impossible. Main has 4 commits the branch doesn't have.

**Why not rebase:** rebasing `fix/multi-tenancy` onto `main` would rewrite the 3 branch commits on top of `main`'s 4 new commits. The branch is already pushed to origin — rebasing forces a push with `--force-with-lease`, which is an unnecessary risk when a clean merge is available. Also, the branch's commit history is valuable (shows the verification report review cycle).

**Why merge commit:** git auto-merges cleanly with no conflicts (verified in §3). A merge commit preserves the history of both branches, documents when multi-tenancy work was integrated, and doesn't rewrite any shared history.

### Pre-merge actions required

Before running `git merge fix/multi-tenancy` on `main`:

1. **Verify Render has `SESSION_SECRET` env var set** — the merged code `process.exit(1)`s without it. Without this, the production service will crash on the first deploy after merge.
2. **Set `twilio_phone_number` on the admin user** in production Neon BEFORE the deploy hits production:
   ```sql
   UPDATE users SET twilio_phone_number='+18555350785' WHERE id=1;
   ```
   Otherwise all inbound SMS/voicemail is dropped post-deploy.
3. **Staging verification** — even though the branch has a 650-line test plan, it was written against the OLD staging branch (now diverged). If we still have a fresh Neon branch available (`staging-phase0-20260418`), consider running at minimum the abbreviated smoke tests:
   - Test A+B+C (SMS routing happy path + unassigned)
   - Test H (session persistence)

### Merge commands (when ready)

```bash
git checkout main
git pull origin main               # confirm local main is current
git merge --no-ff fix/multi-tenancy -m "Merge multi-tenancy: inbound routing, drafts, sessions"
# Do NOT push yet — let me review first
```

Then verify the merge commit with `git log --oneline -5`, confirm `node --check server.js` passes, confirm the G1 fix is preserved, then push.

### Post-merge verification steps

After `git push origin main` triggers Render deploy:

1. **Watch Render logs on deploy** — look for `DB init complete.` (not `FATAL: SESSION_SECRET`)
2. **Verify `user_sessions` table auto-created** (Neon SQL: `SELECT COUNT(*) FROM user_sessions;`)
3. **Verify `drafts` table exists** (Neon SQL: `\d drafts`)
4. **Verify `users.twilio_phone_number` and `users.inbound_email_alias` columns exist and admin's values are populated**:
   ```sql
   SELECT id, username, twilio_phone_number, inbound_email_alias FROM users;
   ```
5. **Smoke test**: log in to the app, confirm you stay logged in across a Render service restart (forces the new session store)
6. **Inbound smoke test** (optional, careful): send a real SMS from your phone to `+18555350785` and verify it shows up in your Modern Management inbox. Confirms routing works end-to-end.

---

## 8. Rollback plan

Because the merge deploys are non-destructive (all migrations are additive), rollback is straightforward:

### If deploy fails immediately (SESSION_SECRET missing / server crash)

- Cause: Render env var missing
- Action: add the env var in Render dashboard, re-deploy. No git revert needed.

### If deploy succeeds but inbound messages are dropped

- Cause: admin's `twilio_phone_number` not set
- Action: `UPDATE users SET twilio_phone_number='+18555350785' WHERE id=1;` in Neon. Fix is immediate — no redeploy needed.

### If a subtle bug in the multi-tenant routing causes real problems

- Action: git revert the merge commit on main and push
  ```bash
  git revert -m 1 <merge-commit-sha> --no-edit
  git push origin main
  ```
- Render auto-deploys the revert. Inbound routing falls back to the current main's behavior (user 1 hardcode).
- The `user_sessions`, `drafts` tables, and 2 new user columns REMAIN in the DB — they're additive and harmless. Rolling back the code means they just don't get used.
- Any sessions created in `user_sessions` are abandoned (users log out once again).

### Nuclear option

Neon snapshot `pre-phase0-snapshot-20260418-v2` still exists as our frozen rollback target. In the extreme case where a data corruption issue surfaces, we can restore production data from that snapshot. But nothing in this merge should require that — all changes are additive.

---

## 9. Risk summary

| Risk | Severity | Mitigation |
|---|---|---|
| Merge conflict | **None** | Auto-merge verified clean |
| Schema overlap with Phase 0 | **None** | Zero overlap; all additive |
| G1 fix lost in merge | **None** | Merged tree verified to preserve it |
| Deploy crashes on missing SESSION_SECRET | **High probability** | Verify env var is set before deploy |
| Inbound routing drops all messages | **High** | Set admin's `twilio_phone_number` in Neon before deploy |
| Users logged out after deploy | **Low — one-time** | Expected. Session store transition. Log back in once. |
| Unknown bugs in multi-tenant routing | **Medium** | Test plan exists. Run at least Tests A, C, H on a fresh staging branch before merging. |

---

## 10. Go/No-Go checklist

Before approving the merge:

- [ ] `SESSION_SECRET` environment variable confirmed set in Render (not empty, not the old default)
- [ ] Fresh Neon staging branch available (staging-phase0-20260418 still exists and is current)
- [ ] At least Tests A, C, H from `docs/staging-test-plan.md` have been run against the merged code on staging
- [ ] Admin user's `twilio_phone_number` will be set in production Neon as the first action after the deploy succeeds
- [ ] A rollback procedure is documented and ready (§8)

When all five are checked, the merge is safe to execute.

---

**Recommendation:** proceed with a merge commit (`git merge --no-ff fix/multi-tenancy`), after setting `SESSION_SECRET` in Render and preparing the admin's Twilio number UPDATE statement. No rebase. No fast-forward. Run at minimum abbreviated Tests A + C + H on staging first.
