# SP1 Investigation — Signup Provisioning Robustness

Look-first for the SP arc. Investigation only; no code changed. State:
clean tree at `8a1e7c5` (Admin arc AD1–AD9 closed).

## Overriding finding: the described artifacts are not in this environment

Before the per-item detail — the single most important thing, because
it changes what SP should build. **Three of the specifics in the prompt
are NOT present in the database/Twilio account my env credentials
reach:**

- **Workspace 12 (testerc) does not exist.** The Neon prod DB
  (`ep-red-star-an47bxr0…`, the same one AD5/AD8 migrations landed on)
  holds exactly **2 workspaces** — ws3 (admin, Modern Management, PM)
  and ws17 (jayhorton87, R2 Labs, PS) — **max id 17**. So ~15
  workspaces were created and deleted over the project's life; ws12 is
  among the deleted. There is no `testerc` user. The impossible-state
  ROW is gone — I can reconstruct the mechanism from code (item 2) but
  cannot do live-row forensics on it.
- **No workspace is currently in the impossible state.** The census of
  `connect_status × phone-null` returns only `not_started+phone` (ws3)
  and `pending+phone` (ws17). Zero `ready`-with-NULL-phone rows today.
- **The Twilio account has 2 numbers, not the described stale set.** No
  number points at example.com; no tollfree points at the old onrender
  host. (There IS a real stale VOICE webhook — see item 3 — just not
  the ones named.)

Most likely explanation: the observations were made against a
different environment (a separate prod, or a pre-reset DB/account), or
they have since been cleaned. **Recommendation: before SP builds
anything, confirm which DATABASE_URL + TWILIO_ACCOUNT_SID the
impossible state actually lives in.** If it's a different account, the
webhook repair (item 3) and ws-12 cleanup (item 2) target that one;
this document audits the environment I can see and reasons about the
code, which is shared across environments.

## 1. The signup → provisioning flow, end to end

Path: `views/signup.html` (multi-screen form) → `POST /api/signup/checkout`
(creates a Stripe Checkout Session + a `signup_drafts` row holding the
bcrypt hash and area codes) → Stripe hosted checkout → webhook
`checkout.session.completed` → **`lib/signup-orchestrator.js`
`processCheckoutCompletedEvent`** → `views/signup-success.html` polls
`GET /api/signup/status`.

**The orchestrator (the ONE workspace creator):**
- Grep confirms `INSERT INTO workspaces` exists in exactly one place:
  `signup-orchestrator.js:420`. It runs inside a DB transaction with
  the user insert.
- **Number provisioning is a 4-rung fallback chain** (already built,
  lines 447–475): (1) `draft.area_code` → `searchAvailableNumbers`;
  (2) `draft.area_code_backup`; (3) `TWILIO_FALLBACK_AREA_CODE` env
  (wrapped so a bad value doesn't abort); (4) `searchAnyAvailableNumber`
  — any US local with SMS+Voice. Area code source is the customer's
  signup input (primary + optional backup).
- **Zero search results** after all four rungs → `throw new Error('No
  Twilio numbers available…')`.
- **Twilio API error** → caught, rethrown as `'Twilio provisioning
  failed: …'`.
- **Either throw propagates to the outer catch → `ROLLBACK`** (user +
  workspace inserts undone) **+ best-effort `releaseNumber`** if a
  number was already purchased. So the orchestrator is **all-or-nothing**:
  it cannot leave a committed workspace with a NULL phone.
- On success: `UPDATE workspaces SET twilio_phone_number, twilio_phone_sid,
  twilio_provisioned_at`, then `configureNumberWebhooks`, then mark the
  stripe_event processed, delete the draft, COMMIT.

**Where `connect_status` becomes `'ready'`:** ONLY
`lib/connect-lifecycle.js` `syncAccountState` (line 66), via
`deriveConnectStatus`: `charges_enabled === true → 'ready'`. This is
**Stripe Connect** (can-this-workspace-accept-card-payments) state,
fired from the `account.updated` webhook / the Connect return route.
Column default is `'not_started'` (migration 041). It is **completely
independent of Twilio provisioning** — nothing couples them.

**What the success screen shows / the path that lies:**
`/api/signup/status` returns `status:'success'` when the orchestrator's
stripe_event has `processed_at` set and no `_orchestrator_error` — i.e.
after the atomic commit. `signup-success.html` polls it and, on
success, renders the number. **The lie is `signup-success.html:166`:**

    document.getElementById('success-phone').textContent =
      ws.twilio_phone_number || '(provisioned)';

If the phone is NULL, the screen prints the literal string
**"(provisioned)"** — asserting a number exists when none does. Today
the atomic orchestrator makes `success` imply a real phone, so the
fallback is dormant — but it is the code pre-admitting the NULL-phone
case and choosing to hide it. It is exactly what would fire for an
impossible-state workspace. The pending copy (line 104) also promises
"reserving your dedicated phone."

## 2. Workspace-12 forensics — reconstructed from code (row is gone)

The row no longer exists (deleted; the id-17-with-2-survivors gap
proves ws12 was created and removed), so this is a code-level
reconstruction, not DB evidence.

**Why the current orchestrator CANNOT produce it:** provisioning is in
the same transaction as the workspace insert and throws→rolls-back on
any Twilio failure. A committed workspace therefore always has a phone.

**So the impossible state requires a workspace born OUTSIDE the current
atomic orchestrator.** The doors, in likelihood order:
1. **A pre-atomic version of the orchestrator.** Given ~15 deleted
   workspaces from an era of heavy iteration, ws12 was plausibly
   created when Twilio provisioning was either not yet in the
   transaction or non-fatal (log-and-continue). That commits a
   workspace with NULL phone.
2. **A removed/legacy signup path.** The legacy `POST /api/signup`
   (tombstoned in AD8) created a *user*; if any era paired it with a
   workspace insert lacking provisioning, that's a door.
3. **Manual/seed creation** (ws3 admin has a phone, so not this one,
   but the mechanism exists).

**Then how it reached `ready`:** the owner ran Stripe Connect
onboarding → `charges_enabled` → `syncAccountState` set
`connect_status='ready'`. **Nothing anywhere checks for a phone before
a workspace can be `ready`** — that missing invariant IS the door.
`connect_status` (payment readiness) and `twilio_phone_number`
(the line) are set by independent subsystems with no coupling.

**The real defect is structural, not a single bad write:** two
orthogonal "readiness" facts, no invariant tying them, plus a success
screen that hides a NULL phone as "(provisioned)". SP can fix this
without ws12's row.

## 3. Twilio Console audit (this account: AC755ea99a…, 2 numbers)

| Number | Workspace | VOICE url | SMS url |
|--------|-----------|-----------|---------|
| +18555350785 | ws3 (PM, admin) | **`modernmanagement.onrender.com`/api/voice/incoming** ⚠ | `modernmanagementapp.com`/api/sms/incoming |
| +16469177820 | ws17 (PS, R2 Labs) | `modernmanagementapp.com`/api/voice/relay-incoming | `modernmanagementapp.com`/api/sms/incoming |

**The stale one:** `+18555350785`'s **VOICE webhook points at the old
`modernmanagement.onrender.com` host**, while its SMS and the entire
other number use the canonical `modernmanagementapp.com`
(= `PUBLIC_BASE_URL`). Both hosts currently return 200, so voice isn't
dead today, but it rides the deprecated domain — a latent break the day
onrender is retired.

**The described example.com / old-onrender-tollfree numbers are NOT on
this account** (see the overriding finding).

**Correct URL set** (canonical host = `https://modernmanagementapp.com`;
`configureNumberWebhooks` sets `/api/sms/incoming` + `/api/voice/incoming`,
but PS numbers need the ConversationRelay voice path):
- **+18555350785 (PM):** VOICE → `…app.com/api/voice/incoming` (repoint
  off onrender); SMS already correct.
- **+16469177820 (PS):** VOICE → `…app.com/api/voice/relay-incoming`
  (already correct — PS ConversationRelay); SMS already correct.
- **Note a code nuance:** `configureNumberWebhooks` hardcodes
  `/api/voice/incoming` for every number, but PS relies on
  `/api/voice/relay-incoming` (set separately, server.js ~7064). SP's
  webhook-repair should make the canonical voice path **vertical-aware**
  so a re-run doesn't clobber a PS number back to the PM path.

This repair is **mostly config, partly code**: the one stale number can
be fixed via a single `configureNumberWebhooks` re-run (or Console
edit); the vertical-aware voice URL is a code change so future
provisioning/repair is correct by construction.

## 4. Architecture — blocking (today) vs async

**Today is blocking + atomic, with a polling UX.** The orchestrator
runs synchronously on the Stripe webhook and provisions Twilio inside
the transaction; `signup-success.html` polls `/api/signup/status` every
few seconds showing "Payment received. We're creating your account,
reserving your dedicated phone…" until it flips to success/failed. So
the user already *waits on a spinner* — the number is guaranteed present
at success because it's the same commit.

**Cost of blocking when Twilio is slow/empty:**
- Slow: the poll spins longer; tolerable.
- **Empty inventory:** the 4-rung fallback (incl. any-US) makes this
  rare, but if truly dry, signup **fails after a successful Stripe
  charge** — the catastrophic case: the customer paid, has a Stripe
  subscription, and got no account.
- **Twilio API outage:** the fallback chain does NOT help (it addresses
  emptiness, not errors) → same paid-but-failed catastrophe.

**Async (account first, number seconds later)** would commit the
user+workspace immediately with a NULL phone, show success, and
provision in the background, reflecting the number when ready.
- **Requires:** honest NULL-phone states EVERYWHERE (success screen,
  the AD2 business-identity card already handles NULL with a warning,
  the app's SMS/voice send paths, the badge) — i.e. the impossible
  state becomes a NORMAL transient state that every reader must handle.
- **Removes** the paid-but-failed catastrophe: a Twilio outage delays
  the number, it never voids a paid signup.
- **Cost:** more surface area, and a background job/retry queue.

**Recommendation (ruling is Jay's):** move to **async account-first**.
The decisive evidence is the failure asymmetry — today a transient
Twilio problem after a successful charge is *catastrophic and
irreversible from the user's seat*; async downgrades it to "your number
is arriving." Async's cost — honest NULL-phone handling throughout — is
**exactly the work item 2 already demands** (the missing invariant, the
"(provisioned)" lie). So async and the impossible-state fix are the same
project pointed forward instead of backward. **Caveat, flagged:** async
makes NULL-phone normal-transient, so the honest-failure-states work
becomes a PREREQUISITE, not optional — it must land before or with the
cutover, never after.

## 5. Proposed SP checkpoint sequence

Adjusted by the evidence (the fallback chain already exists; the
described rows/numbers aren't here):

- **SP2 — Environment confirmation + honest NULL-phone states (do
  first).** Confirm which DB/Twilio account holds the impossible state.
  Then make NULL-phone honest everywhere it's currently hidden: kill
  the `signup-success.html:166` "(provisioned)" lie (say "being set
  up"), audit every SMS/voice send + UI read for NULL-phone handling.
  This is the prerequisite for either architecture and the real fix
  for item 2's structural defect.
- **SP3 — The readiness invariant.** Couple the facts: a workspace must
  not present as fully set-up (or, post-async, must show a clear
  "number pending" state) without a phone. Add the guard the impossible
  state walked through — a workspace can be `connect_status='ready'`
  (payments) AND phone-pending, but the UI/model must never conflate
  them or claim a number that's absent.
- **SP4 — Provisioning resilience.** The 4-rung fallback is DONE for
  emptiness; ADD retry/backoff for transient Twilio API errors (the gap
  the chain doesn't cover), and — per the item-4 ruling — either keep
  atomic-with-better-failure-UX or cut over to async background
  provisioning with a retry queue.
- **SP5 — Webhook repair (config + code).** Repoint +18555350785's
  VOICE off onrender to `…app.com/api/voice/incoming` (one
  `configureNumberWebhooks` re-run or Console edit), and make the
  canonical voice URL vertical-aware in code so PS numbers keep
  `/api/voice/relay-incoming` and future provisioning is correct by
  construction. Re-audit the account the impossible state actually
  lives in for the example.com/tollfree numbers named in the prompt.

**Argument on ordering vs the prompt's expected shape:** the prompt
expected "the fallback chain" as a build item — but it already exists
(4 rungs), so SP2's real work is *honest failure states*, not the
chain. And environment confirmation must precede webhook/row fixes,
because the artifacts to fix aren't in the environment I can see. The
sequence above front-loads the structural fix (which both architectures
need) and defers the async cutover to a ruled decision.

No code was changed for this investigation; this document is the whole
of SP1.
