# AD5 Investigation — Verification-Before-Power for Contact Channels

Look-first for AD5 (Law 2 extended to notification_email / alert_phone).
State at time of writing: working tree clean; HEAD `e1f1af1`; **five
commits are local-only awaiting the AD4 diff-review push approval**
(origin at `ba0e608`). AD5 Step 1 is doc-only and stacks cleanly either
way.

## 1. AD3's email-change verification machinery, end to end

| Piece | Where | Detail |
|---|---|---|
| Token mint | `lib/credentials.mintToken()` | crypto.randomBytes(32) → 64-hex; returns `{ token, tokenHash }` |
| Hash at rest | `hashToken()` sha256 | Row stores the hash only; raw token exists once, in the mail |
| Storage | `users.pending_email`, `pending_email_token_hash`, `pending_email_expires` | Columns-on-users (migration 058), 1-hour expiry |
| Single-use | verify clears all three columns | Second presentation matches nothing |
| Endpoints | request / resend (3/hr) / cancel (re-authed) + public `GET /verify-email-change` | Verify is unauthenticated by design — the token IS the proof |
| Failure page | one uninformative message | Never confirms whether a pending exists |
| Sweep | CP4 30-min sweep piggyback | `sweepExpiredPendingEmails` |
| UI | Credentials card pending banner | masked target, Resend, password-confirmed Cancel |

**Reusable cleanly:** mintToken/hashToken, the expiry+single-use shape,
the public-verify-page pattern, the sweep piggyback idiom, maskEmail,
windowGate rate limiting.

**Assumes users.email specifically (NOT reusable as-is):** the swap
semantics. AD3 parks the new value in `pending_email` and only writes
`users.email` on verify — because the login email IS a power key and
must not exist on the row unverified. Contact channels are different:
the value can sit on the row immediately, **unverified and therefore
unused** — the power being gated is *receiving alerts*, not *being the
reset key*. So AD5 wants per-field verified state, not a pending-swap.
Also AD3's artifacts are single-field columns-on-users; AD5 has two
fields plus a guess-attempt counter for the spoken code — a table fits
better (the house has table precedent: password_reset_tokens).

## 2. Every sender to notification_email / alert_phone, with channel + pre-A2P deliverability

| Sender | Channel | Deliverable pre-A2P? |
|---|---|---|
| `lib/owner-alert.sendOwnerAlert` — THE chain (emergency wrapper ×4 sites, engine approval ping, AD2 test-alert button) | SMS to alert_phone first (twilio.messages.create from env.TWILIO_PHONE_NUMBER), else email to notification_email, else account email | **SMS: NO** (A2P pending — the create call fails/filters). The catch at owner-alert.js:40 falls through to email, so delivery survives via the email legs today |
| `server.js:1174 sendNotificationEmail` — new-message notices | SendGrid to notification_email only (no account-email fallback except env for user 1) | **YES** |
| `lib/signup-orchestrator.notifyOperatorOfFailure` | Reads the ADMIN user's alert_phone/notification_email; its own inline sends, mirroring (not calling) the chain | Same as above — SMS leg dead, email leg fine |
| `lib/receipts.js` | Sends to CUSTOMERS, not these fields | n/a — out of scope |

**Existing honesty gap surfaced (pre-dates AD5):** with A2P pending,
the alert_phone SMS leg fails on every attempt and everything already
lands on email — yet the AD2 card promises "Urgent alerts arrive by
text when this is set." That copy overpromises until A2P lands. AD5's
UI commit should fix the sentence while it's in that card anyway.

## 3. Voice + code infrastructure today

- **Outbound voice does not exist.** Twilio voice is INBOUND-only
  (TwiML `<Say>` responses in the inbound webhooks, server.js:6840,
  6866). But `twilioClient` (server.js:195) supports
  `calls.create({ to, from, twiml })` with **inline TwiML — no webhook
  endpoint needed** for a spoken code. The platform number already
  handles inbound voice, so it is voice-capable. Cost ≈ $0.014/min,
  one short call per verification — negligible. **No reason found to
  reject the voice-code approach**; it is the only channel that can
  prove phone control pre-A2P.
- **No verification-code/OTP table or pattern exists anywhere** (grep:
  zero hits). The only token patterns are password_reset_tokens
  (plaintext, flagged in AD3) and AD3's hashed pending-email columns.

## 4. Recommended design (Step 2 shape, contingent on these findings)

**Storage — one new table** (house precedent: password_reset_tokens),
additive migration 059:

    contact_verifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK (field IN ('notification_email','alert_phone')),
      target_value TEXT NOT NULL,      -- the exact value being proven
      code_hash TEXT NOT NULL,          -- sha256; raw code/token never stored
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,  -- guess counter (phone code)
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    -- one active verification per (user_id, field): new request replaces old

**Verified state — two additive columns on users:**
`notification_email_verified_at`, `alert_phone_verified_at`.
Verified = value non-null AND verified_at non-null. Any AD4-passed save
that changes the value **clears the matching verified_at** in the same
UPDATE (no window where a new value inherits old trust).

**Grandfathering in the migration itself:** `UPDATE users SET
<field>_verified_at = NOW() WHERE <field> IS NOT NULL AND <field> <> ''`
— every existing account keeps alert delivery; no behavior change at
deploy. (Dev DB: both accounts have values → both grandfathered.)

**notification_email flow:** reuse mintToken/hashToken; single-use
LINK via SendGrid (the AD3 verify-page pattern, new public route
`GET /verify-contact-email?token=`), 1-hour expiry, resend 3/hour,
one uninformative failure page. Link over typed code: proven UX,
zero new entry UI, and email links are the house pattern.

**alert_phone flow:** 6-digit code (crypto.randomInt), sha256 at rest,
**Twilio voice call** with inline TwiML — `<Say>` reads the code
digit-by-digit, pauses, repeats twice. User types it into the contact
card. 10-minute expiry, 5 wrong guesses burns the code (new call
required), calls rate-limited 3/hour/user via windowGate. Works today
because voice is live and SMS is not.

**Chain gating (the law's teeth):** `sendOwnerAlert` and
`sendNotificationEmail` treat an unverified value exactly as they
treat an absent one — the SMS leg skips an unverified phone, the
notification leg skips an unverified email and falls to account email
(owner-alert) or pauses (new-message notices, which never had a
fallback). **The emergency path obeys the law too**: an
attacker-planted phone must never receive, even an emergency; the
email fallback keeps emergencies delivered. Flagged explicitly because
it is the one place law 2 trades against reachability.

**Unverified-value behavior, explicit:**
- UI: an "Unverified" badge on the field with one honest sentence —
  "Alerts won't use this until you verify it" — plus a Verify button
  (email: sends the link; phone: places the call and reveals the code
  input). Verified fields show a quiet "Verified" tick.
- Never completed: the value persists on the row, unverified, skipped
  by every sender forever; the badge persists; expired verification
  rows are cleared by the CP4 sweep (piggyback again). Nothing nags.
- Signup-set alert_phone (new accounts post-migration): starts
  UNVERIFIED — the owner proves it from the card. Acceptable under the
  law; reported so it isn't a surprise.

## 5. Flags / conflicts for the ruling

1. **Emergency-vs-law tension** (above): recommendation is law wins,
   fallback carries emergencies. Needs explicit confirmation.
2. **sendNotificationEmail pause**: an unverified notification_email
   pauses new-message notices (that sender has no fallback by design,
   AD2 finding). UI copy must say "set AND verified" where it now says
   "set."
3. **notifyOperatorOfFailure bypass**: the operator alert mirrors the
   chain inline rather than calling lib/owner-alert, so chain-gating
   won't cover it. It targets the platform admin's own (grandfathered)
   values. Recommend: leave + flag for the same follow-up that owns
   the rotate-token orphans, rather than expand AD5 into the signup
   orchestrator.
4. **Pre-A2P copy fix** (§2): fold the honest sentence into AD5's UI
   commit.
5. **AD4 interplay**: first-set needs no password (AD4) but starts
   unverified (AD5) — the two laws compose: a session thief can plant
   a value only where none was set, and the planted value is powerless
   until verified against a channel the thief must control anyway.

No code has been changed for AD5; this document is the whole of Step 1.
