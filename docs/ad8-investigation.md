# AD8 Investigation — Arc-Closing Cleanup

Look-first for AD8, the checkpoint that clears the debts the AD3–AD7
credential arc flagged along the way. State: clean tree; AD7 pushed
(`ea84b0a`), deploy healthy (site + login HTTP 200). No code changed
here — findings and a recommended sequence only.

## (a) Legacy public POST /api/signup — CONFIRMED live attack surface

- The route (server.js:2764) creates a **free account with a password,
  no Stripe, no workspace, no vertical** — it bypasses the entire paid
  onboarding the product runs on. It sets a live session on success.
- Its only caller is **public/signup.html:250**, a legacy single-screen
  page that is **still served** (`/signup.html` → HTTP 200). The REAL
  signup is views/signup.html (served at `/signup`, server.js:372),
  which drives the Stripe flow via `/api/signup/checkout` +
  `/api/signup/check-username|check-email` — all distinct endpoints.
  The bare `POST /api/signup` and check-endpoints do NOT overlap.
- **Blast radius of removal: nil for the real flow.** Grep confirms no
  other caller. Recommend removing the route AND retiring the orphan
  static page (leaving the page reachable but dead is its own
  confusion). `POST /api/signup/check-*` stay — they belong to the
  live page.
- Cleanest, lowest-priority first because it's pure deletion with a
  clean grep.

## (b) POST /api/payments/rotate-token — orphan; the feature around it is LIVE

Nuance the roster's "orphaned" label needs:
- `payments+TOKEN@` routing IS a live feature — inbound payment email
  is matched by `payment_forward_token` at server.js:6497, self-sends
  skipped at 586. Do NOT touch that.
- `GET /api/payments/forwarding-info` (3357) mints-on-read and returns
  the address; its UI caller (the payment-forwarding card) was removed
  in AD1, so it too is now UI-orphaned but harmless (read + lazy mint).
- `POST /api/payments/rotate-token` (3376) has **zero callers**
  anywhere (grep clean) and rotating the forward token is a
  credential-ish action left session-only and unreachable.
- **Recommendation: remove rotate-token** (dead + sensitive). For
  forwarding-info: it's a live read path with no current UI but real
  routing behind it — recommend KEEP (removing it would strand the
  lazy-mint that backfills tokens for older accounts), flagged as
  "orphaned but load-bearing." Ruling wanted on forwarding-info:
  keep-as-is vs remove.

## (c) notifyOperatorOfFailure — refactor onto the gated chain

- lib/signup-orchestrator.js:246 hand-rolls the SMS→email chain inline
  (its own twilio + sgMail), duplicating lib/owner-alert. It targets
  the `admin` user by username.
- It does NOT go through AD5's verification gating or AD6's shared
  sender — it's the last inline copy of the routing the arc unified.
- Refactor: call `sendOwnerAlert({ ..., respectEnabled: false }, adminId,
  {...})` — operator failures are alarms, always send, exactly the
  emergency posture. One wrinkle to honor: owner-alert takes a userId;
  the orchestrator currently looks up admin by username, so resolve
  admin's id first (or add a by-username convenience). Post-AD5, admin's
  alert_phone is grandfather-verified and notification_email verified,
  so gating changes nothing for the current operator — the refactor is
  behavior-preserving today and correct going forward.
- Low risk, self-contained, ~15 lines.

## (d) Hash password_reset_tokens at rest — the standing AD3 flag

- Blast radius (every site): INSERT (1869), check-token SELECT (1939),
  reset SELECT ... FOR UPDATE (1971), UPDATE used_at (1996), sweep
  DELETE (666). All key on the raw `token`.
- Fix: mail the raw 32-byte token (unchanged UX), store and look up
  `hashToken(token)` (sha256, the AD3/AD5 pattern already in
  lib/credentials). Five sites change from `token` to its hash; the
  URL and email are untouched.
- **Migration question (ruling wanted):** existing rows hold plaintext
  tokens that become unmatchable once lookups hash. They're 1-hour
  TTL, single-use. Simplest honest path: the migration `DELETE`s all
  existing reset tokens — anyone mid-reset (rare; a ≤1h window)
  re-requests. Additive otherwise (no column change — the column stays
  TEXT, now holding a hash). Recommend the DELETE; alternative is a
  dual-read grace window, which is more code for a 1-hour edge.
- Note: AD7's kill-switch already DELETEs these on any password write,
  so hashing closes the at-rest-readability window; the two are
  complementary.

## (e) Rebuild the 16 lost gate scripts in-repo — the big one

- The lost set: behaviors, brain-expense, budget, deposits, driver,
  email, expiry, ib1, ib3, ledger, owner-context, ping, playbook,
  readstate, reflection, ws. They lived in the temp scratchpad and
  were cleaned up mid-session.
- **Overlap check:** three are ALREADY reincarnated in-repo —
  brain-expense (`scripts/test-brain-expense.js`), budget
  (`test-finances-summary.js`), budget-insights (`test-budget-insights.js`).
  So the genuine gap is ~13 scripts, each testing a shipped subsystem
  whose CODE still exists (the source is the spec — every gate was
  written against live behavior).
- This is materially larger than the other six items combined:
  ~13 fixture harnesses reconstructed from the code they covered.
  **Scope ruling wanted:** bundling it into a cleanup commit would
  dwarf the checkpoint. Recommend e become **its own checkpoint
  (AD9?)**, sequenced after the quick wins, so each rebuilt gate gets
  real attention rather than a rushed stub. AD8 can ship a placeholder
  `scripts/gates/README.md` listing the 16, which are covered, and
  which remain — turning "16 lost files" into a tracked backlog.

## (f) Mail failure-streak alarm — design proposal (build TBD)

The June–August outage was invisible because every send soft-fails to
an unread console line. Design constraints: the alarm must NOT itself
be email (email is what's broken), and must survive the per-send
soft-fail discipline (never block a change).

Proposed:
- A module-level consecutive-failure counter shared by the send paths
  (sendSecurityNotice, sendNotificationEmail, owner-alert's email leg,
  the orchestrator once refactored). Increment on send failure, reset
  to 0 on any success.
- At threshold N (recommend 5), escalate ONCE per streak to channels a
  human actually sees, none of them email:
  1. a distinct log marker (`[mail-outage]`) that a Render log alert
     can trigger on;
  2. an owner TASK row (the CP4-expiry pattern — visible in-app on the
     admin's task list) titled "Email delivery is failing — check
     SendGrid";
  3. optionally an admin-only in-app banner from a lightweight
     `system_health` flag.
- In-memory counter resets on deploy — acceptable (a real outage
  re-trips within N sends); persisting it is over-engineering for a
  courtesy alarm.
- Design only in AD8; if approved, build is small enough to fit AD8 or
  fold into the (e) checkpoint.

## (g) user 1 empty anchor email — actionable now

- Confirmed: user 1 (`admin`) has `users.email = ''`; its
  notification_email is `jayhorton87@gmail.com` (verified) and
  alert_phone is verified. So the operator account can currently
  receive owner-alerts (notification leg) but has **no reset-key
  anchor** and no recipient for AD6 security notices routed to
  users.email.
- Jay operates both accounts; user 14's anchor is
  `jayhorton87@gmail.com`. **Recommend setting user 1's anchor to
  `jayhorton87@gmail.com`** for consistency — but it's an identity
  choice, so flag for Jay's explicit confirmation (vs. the separate
  `jhorton081225@gmail.com` seen mid-flight on user 14's pending
  change). Pure one-line data UPDATE, no code, no deploy — run it as a
  data op once Jay names the value.

## Recommended sequencing

Quick, independent, pure wins first; the big rebuild last / separate:

1. **(a)** remove legacy signup route + orphan page — deletion, clean grep.
2. **(b)** remove rotate-token — deletion (pending forwarding-info ruling).
3. **(c)** operator-alert refactor onto owner-alert — ~15 lines.
4. **(d)** hash reset tokens — 5 sites + a DELETE migration.
5. **(g)** set admin anchor — data op, Jay's value, anytime.
6. **(f)** mail-outage alarm — build if approved (small).
7. **(e)** rebuild the 16 gates — **its own checkpoint**; AD8 ships the
   tracking README.

Each of 1–4 (+6) is one logical commit; suite rows where there's logic
to prove (d's hash round-trip and the sweep; c's routing; f's counter),
source-pin deletions for a/b, full harness green, full diff for review,
push gated on Jay's live test as the arc has run throughout.

## Scope rulings needed before Step 2

1. **(e)**: own checkpoint (recommended) or bundled into AD8?
2. **(b)**: forwarding-info — keep (recommended, load-bearing) or remove?
3. **(d)**: migration DELETEs existing plaintext tokens (recommended)
   or dual-read grace window?
4. **(f)**: build in AD8 or defer to the (e) checkpoint?
5. **(g)**: confirm the anchor value (`jayhorton87@gmail.com` recommended).
6. Commit granularity: one-per-item (recommended) or grouped.

No code has been changed for AD8; this document is the whole of Step 1.
