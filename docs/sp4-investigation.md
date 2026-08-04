# SP4 Investigation — Async Provisioning

The arc's centerpiece. Look-first; no code changed. State: clean tree
at `006bda7`; SP3 live (migration 061 applied clean at 2026-08-04
01:27Z, both live workspaces `twilio_status='active'`, all three
constraints in place, and the illegal `active`+NULL write verified
rejected on the live DB). SP1 established the failure asymmetry, SP2
shipped the honest NULL-phone surfaces, SP3 modeled the Twilio axis
with its structural invariant — SP4 makes provisioning async so a
Twilio hiccup can no longer void a paid signup.

## 1. Current transaction shape, end to end

Flow: `views/signup.html` → Stripe Checkout (card charged by Stripe
BEFORE any of our code runs) → webhook `checkout.session.completed`
→ `processCheckoutCompletedEvent` (one DB transaction on a dedicated
client).

The webhook (server.js:2543) **awaits** the orchestrator before
returning 200 to Stripe. Inside the single transaction, in order:
1. Lock the `stripe_events` row (`FOR UPDATE`); bail if missing,
   short-circuit if already `processed_at` (idempotent replay).
2. Read the `signup_drafts` row (TTL-guarded).
3. Generate forward token + inbound email alias.
4. **INSERT users** (unique username/email throws → outer catch).
5. INSERT automation row.
6. **INSERT workspaces** (`created_during_signup = TRUE`).
7. **Twilio: search → purchase → configureNumberWebhooks** — the
   4-rung fallback chain, then `purchaseNumber`, then webhooks. Any
   failure `throw`s.
8. **UPDATE workspaces** with the number + `twilio_status='active'`
   (SP3, atomic).
9. Mark the stripe_event processed, delete the draft, **COMMIT**.
Post-commit, non-fatal: welcome email.

**Rollback behavior:** ANY throw (including all of step 7) →
`ROLLBACK` (undoes users+workspace+automation) + best-effort
`releaseNumber` if one was purchased + stamp `_orchestrator_error`
onto the event. So today **a Twilio failure destroys the whole
account** — the paid-but-failed catastrophe. The `/api/signup/status`
poll then returns `failed`; `signup-success.html` shows "Your payment
went through, but we couldn't finish creating your account… we'll get
this sorted within one business day." (Note: **no automated
refund/subscription-cancel exists** — the money is kept, recovery is
manual. Flagged in item 5.)

**The clean seam for "commit the account, queue the number":**
between step 6 and step 7. Steps 1–6 are pure DB and already atomic;
step 7 is the only external-vendor call in the transaction. Move step
7 OUT of the transaction: commit after step 6 with
`twilio_status='provisioning'` (a NULL-phone workspace is now legal —
SP3's whole point), return `success` immediately, and let the async
worker perform search→purchase→configure→flip-to-active afterward. The
seam is exact and the invariant already permits the intermediate
state.

## 2. The async job's shape

**Runner — both, following existing precedents.** The codebase has
five `setInterval` workers (email sync 5min, draft cleanup 6h, reset
cleanup 6h, inactivity 30min, expiry 30min), each with the same shape:
a `runX()` that selects a work-set and loops with per-item
`.catch()`. SP4's provisioning worker mirrors `runPeriodicEmailSync`
exactly:
- **On-demand kick** right after the orchestrator commits (fire the
  worker once, un-awaited) so the happy path provisions in seconds,
  not on the next tick.
- **Interval sweep** (recommend 1 min) as the safety net that catches
  anything the kick missed (server restart mid-provision, a transient
  error) and drives retries.
- The sweep's work-set: `SELECT … WHERE twilio_status = 'provisioning'
  AND twilio_attempts < MAX AND (next_attempt_at IS NULL OR
  next_attempt_at <= NOW())`. One helper, both callers.

**Retry policy against SP3's columns:**
- Each attempt increments `twilio_attempts`; on failure, write
  `twilio_last_error` and schedule the next attempt with backoff.
- **Backoff:** exponential with a cap — e.g. attempts at ~0s (kick),
  then +30s, +2m, +10m, +30m. Recommend a small
  `twilio_next_attempt_at TIMESTAMPTZ` column (SP4 migration) so the
  sweep query is a simple time gate rather than recomputing backoff
  from `attempts` each tick. (Flag: SP3 shipped `attempts` +
  `last_error`; `next_attempt_at` is the one addition SP4 needs.)
- **Declare `failed`** after MAX attempts (recommend 6, spanning
  ~45 min). `failed` is terminal for the automatic loop.

**A `failed` workspace's recovery path — both:**
- **Owner-visible:** an in-app owner task (the CP4-expiry pattern —
  a `tasks` row: "Your business phone number couldn't be set up —
  we're on it") so the owner isn't left guessing, AND the honest
  account-page state (SP3's derived readiness already renders
  `phone: 'failed'`).
- **Operator-visible:** a loud `[provisioning]` log marker + the
  mail-outage-style escalation is overkill here; recommend instead a
  `failed`-state count the operator can see, and — cleanest — an
  **owner-triggered "Try again" that resets `twilio_status` to
  `provisioning`, zeroes `attempts`, and re-arms the worker**. Not
  auto-retry-forever (a genuinely dead area code or account-level
  Twilio problem would spin forever and hammer the API); a bounded
  auto-loop that stops at `failed`, plus a one-tap manual re-arm, is
  the honest shape. Jay rules on MAX and whether operator alerting
  rides the SP-AD8 mail alarm.

## 3. The four platform-fallback send sites — hold vs fallback

All four send FROM `workspace.twilio_phone_number ||
process.env.TWILIO_PHONE_NUMBER`. The key question is what each does
during the pending window, and the answer **differs by
reachability**:

| Site | What / to whom | Reachable during pending? |
|------|----------------|---------------------------|
| **appointment-engine:642** — the AI's reply to an inbound customer text | customer | **NO.** Requires an inbound customer message, which requires the workspace to HAVE a number for the customer to text. Structurally unreachable while pending. |
| **server.js:8055** `notifyPendingActionCustomer` — approval outcome to a customer | customer | **NO.** Requires a customer-originated pending action, i.e. a prior inbound. Same gate — unreachable while pending. |
| **payment-requests:219** — a payment-link SMS the owner requested | customer | **YES (rare).** Owner-initiated; needs a contact + transaction + click. Also gated on `connect_status='ready'` (Stripe, phone-independent). Possible in the seconds/minutes before the number lands. |
| **receipts:143** — a receipt SMS after a completed transaction | customer | **YES (rare).** Owner/flow-initiated; needs a completed transaction. Has an **email path already** (SMS is the fallback leg). |

**Recommendation, per-site (Jay rules):**
- **Sites 1 & 2:** no pending-window change needed — they cannot fire
  without a number. (Their `|| platform` fallback is legacy defensive
  code; SP4 can leave it, or tighten it to skip when
  `twilio_status !== 'active'` for belt-and-suspenders. Low priority.)
- **Sites 3 & 4:** **HOLD, don't send from the platform number.**
  Sending a customer-facing SMS from a shared number the business
  doesn't own is doubly wrong: the customer sees an unfamiliar
  sender, and any reply hits the platform number where inbound routing
  (`lookupWorkspaceByTwilioNumber`) matches no workspace → an
  UNROUTABLE drop (the IB5 loud-drop). So during pending: site 4
  (receipts) **falls back to its existing email path**; site 3
  (payment-requests) **skips the SMS and surfaces the link in-app /
  by email** with an honest "your text line is still being set up —
  here's the link to share" note. Concretely: gate both on
  `twilio_status === 'active'` before the SMS leg.
- **General principle worth a ruling:** the `|| platform` fallback for
  *customer-facing* sends is arguably wrong even outside pending (same
  unfamiliar-sender + unroutable-reply problem). SP4 could retire it
  for customer sends entirely. Flagged; not assumed.

## 4. Success screen + welcome email under async

SP2 already built the honest branches; async is what finally triggers
them.
- **Success screen:** `/api/signup/status` returns `success` on
  `processed_at` set + no error. Under async the orchestrator commits
  (and sets `processed_at`) at step 6 with no number yet → the poll
  returns `success` with `twilio_phone_number: null` →
  `showSuccess` renders the **"Being set up"** state. This is correct
  and needs no copy change — but the status endpoint must return the
  workspace's `twilio_status` too, so the screen can distinguish
  `provisioning` ("arriving shortly") from `failed` ("we're on it")
  rather than showing the same pending copy for both. **One additive
  field on the status response.**
- **Welcome email:** fires post-commit. Under async it will now
  routinely send with `twilioPhone` null → the "Being set up" block
  (SP2). Correct as-is. **One tightening:** once the number lands, no
  email is re-sent — consider a follow-up "your number is ready" mail
  from the worker on the active-flip (nice-to-have; flag, don't
  assume).
- **The `failed` status screen:** today's "we couldn't finish creating
  your account" copy is now WRONG under async — the account WAS
  created; only the number failed. The failed-provisioning case needs
  its own honest copy ("your account is ready; your number hit a snag
  and we're retrying"), distinct from the (now much rarer)
  account-creation failure.

## 5. Proposed SP4 split (3 units) + the charge-ordering flag

- **SP4a — the seam + the worker.** Move Twilio out of the
  transaction: commit at the seam with `twilio_status='provisioning'`;
  add `twilio_next_attempt_at`; build the provisioning worker
  (on-commit kick + 1-min sweep, bounded retry with backoff, flip to
  `active` atomically on success, `failed` at MAX). Suite: happy path
  provisions post-commit; a failing Twilio leaves a committed account
  in `provisioning` then `failed` (NEVER a rolled-back account);
  retry/backoff/attempts; the active-flip honors the SP3 invariant.
- **SP4b — the send-site rulings + status surfacing.** Per item 3:
  hold sites 3 & 4 during pending; add `twilio_status` to
  `/api/signup/status`; the `failed`-provisioning success-screen copy;
  the owner "phone couldn't be set up" task + one-tap re-arm. Suite:
  hold-not-platform-send while pending; the screen distinguishes
  provisioning/failed/active.
- **SP4c — recovery + operator visibility.** The manual re-arm
  endpoint, the failed-count operator view, and (per ruling) any
  webhook-repair coordination with SP5. Possibly folds into SP4b if
  small.

**The charge-ordering flag (deserves its own scrutiny):** Stripe
charges the card at Checkout, BEFORE our webhook/orchestrator runs, and
**nothing refunds or cancels the subscription when the orchestrator
fails.** Async removes the *Twilio-caused* failure, which is most of
it — but a step 4/5 failure (username/email uniqueness race, DB error)
still leaves a charged card with no account and no automated remedy.
SP4 should AT LEAST make the orchestrator's own failure path attempt a
subscription cancel (or flag for refund) instead of silently keeping
the money — or explicitly rule that manual within-one-business-day is
acceptable. Flagged for a ruling; it's the one place the "paid but
nothing" risk survives even after async.

No code changed for this investigation; this document is the whole of
the SP4 look-first.
