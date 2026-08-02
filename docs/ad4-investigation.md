# AD4 Investigation — Credential Re-authentication (Law 1)

Look-first for the AD4 prompt. State at time of writing: main clean at
`ba0e608` (AD3 suite coverage), AD3 pushed and live-deploying.

## Headline finding: Law 1 is already implemented for credentials

AD3 (commits `98fb872`, `37ca109`, `63cb7f2`, `ba0e608` — pushed) built
what Step 2 of the AD4 prompt describes, before the AD4 prompt arrived:

- **The shared re-auth helper exists**: `lib/credentials.js` `_reauth()`
  — bcrypt-compares `current_password` from the request against the
  logged-in user's stored `password_hash`, behind a shared sliding-window
  rate limit (5 attempts per 15 minutes per user, `attemptGate`, every
  re-authed endpoint draws from the one budget). Missing-row path burns a
  dummy bcrypt compare for timing parity.
- **An in-app change-password endpoint exists**:
  `POST /api/credentials/change-password` (server.js:1379) — current +
  new + confirm, floor 8 chars, new==current refused, other sessions
  ended, security notice sent. The matching form is live on the account
  page (Credentials card, AD1 slot).
- **Deviation from AD4's letter, deliberate (AD3's own spec)**: failures
  return **400/429 with ONE generic sentence** ("Current password
  incorrect or attempt limit reached.") — never a "clear" wrong-password
  message, and never a distinguishable rate-limit message. AD4 asks for
  **403 + clear message**; AD3's law forbids distinguishing the failure
  modes. See Decision B below.

## Every endpoint that can modify credential/contact fields on `users`

| # | Endpoint | Fields written | UI caller | Proof of identity today |
|---|----------|----------------|-----------|------------------------|
| 1 | `POST /api/credentials/change-password` (1379) | password_hash (+ clears pending_email*) | Credentials card (app.html:5492) | **Current password** (shared `_reauth`) + rate limit |
| 2 | `POST /api/credentials/request-email-change` (1435) | pending_email, pending_email_token_hash, pending_email_expires | Credentials card (5652) | **Current password** + rate limit |
| 3 | `POST /api/credentials/cancel-email-change` (1507) | clears pending_email* | Credentials card (5703) | **Current password** + rate limit |
| 4 | `POST /api/credentials/change-username` (1518) | username | Credentials card (5596) | **Current password** + rate limit |
| 5 | `GET /verify-email-change` (public) | email (the swap), clears pending_email* | Email link | **Possession of single-use hashed token** (that IS the proof — Law 2 mechanics) |
| 6 | `POST /api/auth/reset-password` (public) | password_hash | forgot-password page | **Possession of single-use reset token** (public flow, by design) |
| 7 | `PUT /api/settings` (1357) | **notification_email, notifications_enabled, alert_phone** | AD2 contact card Save (5346) **and onboarding** (8680) | **NONE — session only.** Validation only (AD2). |
| 8 | `POST /api/credentials/resend-email-verification` (1481) | pending_email_token_hash, pending_email_expires | Credentials card (5688) | Session + 3/hour limit (deliberate: it can only re-send to an address a re-authed request already parked) |
| 9 | Signup checkout / webhook | creates username, password_hash, email, alert_phone | public signup | Public by design |
| 10 | Boot backfills (1092, 1099) | payment_forward_token, inbound_email_alias | none (system) | n/a |

**Adjacent finding (outside the listed fields, worth flagging):**
`POST /api/payments/rotate-token` (3180) and `GET
/api/payments/forwarding-info` (3161) rotate/mint the payment-forwarding
secret with session-only auth — and both are **UI orphans** since AD1
commit 2 removed the forwarding card. Dead-but-reachable endpoints
holding a secret-rotation capability; candidates for removal or re-auth
in their own cleanup, not silently bundled here.

## The one unprotected writer: `PUT /api/settings`

The AD2 contact card saves notification_email / notifications_enabled /
alert_phone with no proof of identity beyond the session. These are
**contact/ping fields, not credentials** — AD3's look-first (c) mapped
the three email roles: `users.email` is the reset key (protected),
`notification_email` is where pings go, `inbound_email_alias` is
customer-facing. A session thief who edits notification_email can
redirect *pings*, not password resets. AD4's prompt nonetheless
explicitly includes this path, which is defensible: alert_phone is where
urgent-alert SMS goes; redirecting it quietly is a real attack.

**Hard constraint discovered:** the onboarding flow (app.html:8680)
calls `PUT /api/settings` with `{ notification_email, notifications_
enabled: true }` at a moment when **no password is available to
re-prompt** (mid-wizard, fresh session). A naive "always require
current_password" breaks onboarding.

## Decisions needed before Step 2 (reported, not adapted silently)

**Decision A — scope of re-auth on the contact card.** Options:
1. *(Recommended)* Require `current_password` in `PUT /api/settings`
   only when the request would **change an already-set**
   notification_email or alert_phone (NULL→value first-set stays free,
   toggle-only saves stay free). Onboarding (first-set) keeps working;
   redirection of an existing channel — the alarm-worthy event —
   requires the password. UI prompts for current password only when
   editing a previously-set field.
2. Always require it, and rebuild onboarding's save to defer the field
   write until the wizard can prompt for the password. More disruptive;
   touches a flow AD4 didn't ask to touch.
3. Split endpoints (re-authed card path + un-authed onboarding path) —
   leaves the hole open under a different name. Not recommended.

**Decision B — status/message conflict.** AD4 says "403 and a clear
message"; AD3's shipped law (suite-pinned, CR1) says one generic
sentence, 400/429, never distinguishing failure modes — that generic
posture is what makes the oracle gate meaningful. Options:
1. *(Recommended)* Keep the AD3 generic sentence everywhere; new
   AD4-scope rejections use **403** with that same sentence. AD3
   endpoints keep their shipped 400/429 (suite-pinned, already live).
2. Move everything to 403 — requires amending AD3's suite row CR1 and
   accepting a behavior change to just-shipped endpoints.

**Decision C — the orphan payment-token endpoints.** Remove, re-auth, or
leave-and-log as their own follow-up. Recommendation: their own
follow-up; they're outside AD4's field list.

## What Step 2 would actually build (if decisions land as recommended)

1. `PUT /api/settings`: load stored values; if notification_email or
   alert_phone would change from a non-null stored value, demand
   `current_password` via the existing shared `_reauth` (same oracle
   budget), rejecting with 403 + the generic sentence; rate limiting is
   inherited from the shared gate.
2. AD2 contact card UI: when the user edits a previously-set email/phone
   field, reveal a current-password input before Save submits (matching
   the Credentials card idiom one card below).
3. Suite rows: change-with-no-password fails 403; wrong password fails;
   correct password succeeds; first-set without password still works
   (onboarding proof); toggle-only save without password works; oracle
   budget shared (settings failures count toward the same 5/15min).
4. No new endpoint needed — change-password already exists (AD3 c1).

No code has been changed for AD4; this document is the whole of Step 1.
