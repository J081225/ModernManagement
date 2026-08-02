# AD6 Investigation — Notice to the Old Guard (Law 3)

Look-first for AD6. State: clean tree at `aa5e492`; AD5 pushed and
deploying (migration 059 verification pending in this same session);
AD6 builds locally, nothing pushes until Jay's AD5 live test passes.

## 1. Every credential-change event, and what notice fires today

| # | Event | Notice today? | To | Verdict |
|---|-------|---------------|----|---------|
| 1 | Password change (in-app, AD3 c1) | **YES** — "Your Modern Management password was changed" + reset-now instructions + other-sessions count | users.email | Covered. |
| 2 | Password RESET (public forgot-password flow) | **NO.** The reset LINK mail exists at request time (server.js:1850), but completing the reset sends nothing — the hash updates, the token burns, silence. | — | **GAP.** The one flow an email-thief would use is the one flow that never announces itself. |
| 3 | Login email change (AD3 c2) | **YES**, three-part: warning to the OLD address at request ("your password may be compromised", masked target), verification link to the NEW, confirmation to BOTH on completion | old + new + both | Covered — AD6's model citizen. |
| 4 | Username change (AD3 c3) | **YES** — notice with reset-now instructions | users.email | Covered. |
| 5 | notification_email change (PUT /api/settings) | **NO.** AD4 re-auths it, AD5 unverifies it — but nobody is TOLD. | — | **GAP.** |
| 6 | alert_phone change (PUT /api/settings) | **NO.** Same. | — | **GAP.** |

(Not credential changes, no notice recommended: the notifications_enabled
toggle — a preference; AD5 verification *completions* — the change
notice at save time already covered the event, and verification is the
owner closing their own loop. Extra mail there is noise.)

## 2. The finding that sharpens the design: first-set + self-verify

AD4 deliberately lets FIRST-SET through without a password (the
onboarding constraint), and AD5 makes a planted value powerless until
verified — but verification proves control of the *channel*, and a
session thief controls their own phone. So the one quiet takeover
left is: thief with a live session first-sets alert_phone to their
own number (no password needed — nothing was set), answers the voice
call, verifies, and urgent alerts now reach the thief. Every step is
per-spec. **A notice on first-set makes this loud** — the anchor
inbox learns a phone was added the moment it happens, not when an
alert goes missing. Therefore the recommendation below notices ANY
value change — first-set, edit, and clear — not just change-of-set.

## 3. Recommended notices (informational only)

Anchor identity: **users.email** — the reset key, the address every
other law already defends. The "old guard" for a retiring email value
is the old value itself.

| Event | Recipient(s) | Message core |
|---|---|---|
| Password reset completes (public flow) | users.email | "Your password was just reset via the reset-link flow. If this wasn't you, contact support immediately — do not reuse the reset link." |
| notification_email changed (set→set or cleared) | the OLD notification_email, PLUS users.email when distinct | "This address no longer receives Modern Management alerts — they now go to n***@d***.com [or: nowhere until a new one is verified]. If this wasn't you, reset your password now." |
| notification_email first-set | users.email | "A notification email was just added (n***@d***.com). Alerts will use it once verified. If this wasn't you, reset your password now." |
| alert_phone changed / first-set / cleared | users.email (else verified notification_email — see flag) | Same shape, masked number ((443) ***-**99 style or last-2 masking; define once beside maskEmail). |

All notices: the account-mail path (direct SendGrid, the AD3 pattern),
IGNORING notifications_enabled — you can silence pings, never alarms
(LAW 3, already encoded in every AD3 sender). Masking uses the AD3
maskEmail rule; a maskPhone sibling gets defined once in lib.

## 4. Constraint check: delivery is email-only pre-A2P

All recommended notices deliver by email — no design depends on SMS.
**Flag: events with no reachable email exist.** users.email is
`TEXT DEFAULT ''` and can be empty; if notification_email is also
absent/unverified, a contact-channel change has nowhere to send its
notice. Posture (matching AD3's password/username senders): log
loudly (`[credentials] ... no email on file — notice skipped`), never
block the change. Worth reporting: the dev DB's two accounts both
have users.email set, so the empty-anchor case is a future-account
risk, not a current-data one. A later checkpoint could require
users.email at signup (it's already validated when provided) — out of
AD6 scope.

## 5. The starting position, challenged as instructed — and upheld

Informational-only is RIGHT, and the investigation strengthens it:
- A one-click revert link is a bearer token that UNDOES security state,
  living in inboxes indefinitely — a stolen old-guard mailbox could
  revert a legitimate change (the exact inversion of law 2, which
  spent AD5 proving control before granting power).
- Every notice already carries the correct action: "reset your
  password now" — the reset flow is re-authenticated by its own token
  ceremony and ends every other session (AD3 c1 pattern), which IS the
  safe revert.
- AD3's shipped notices set the precedent: instruction, never a
  mechanism. Consistency matters in security copy.
If a revert mechanism is ever wanted, it needs its own checkpoint with
its own token hygiene, expiry, and suite — agreed, not smuggled here.

## 6. What AD6 Step 2 would build (pending ruling)

1. lib addition: `maskPhone` beside `maskEmail`; a small
   `sendSecurityNotice(sgMail, env, to, subject, text)` helper OR keep
   the inline AD3 try/catch idiom (recommend the helper — six senders
   now exist and each hand-rolls the same block).
2. Reset-completion notice in POST /api/auth/reset-password (after
   COMMIT, soft-fail).
3. Contact-change notices in the PUT /api/settings adapter (after the
   lib save returns; the lib already knows old + new values — extend
   its return with `{ emailChanged, phoneChanged, oldEmail, oldPhone }`
   so the adapter doesn't re-query).
4. Suite rows: reset completion fires to users.email; contact change
   notices fire to old + anchor (distinct-address case included);
   first-set fires to anchor; cleared fires; no-email-anywhere logs
   and never blocks; notices ignore notifications_enabled; no notice
   on the notifications_enabled toggle or on verification completion.

No code has been changed for AD6; this document is the whole of Step 1.
