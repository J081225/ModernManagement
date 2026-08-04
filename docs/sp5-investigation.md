# SP5 Investigation — Webhook Repair

Look-first for SP5. No changes made. State: clean tree; SP4b+SP4c
local behind the standing gate; origin at `bc01c47`.

## 1. Live webhook state (Twilio API, both numbers)

| Number | Workspace | Vertical | VOICE url | SMS url |
|---|---|---|---|---|
| **+18555350785** | ws 3 "Modern Management" | property-management | **`modernmanagement.onrender.com`/api/voice/incoming** ⚠ STALE HOST | `modernmanagementapp.com`/api/sms/incoming ✓ |
| **+16469177820** | ws 17 "R2 Labs" | professional-services | `modernmanagementapp.com`/api/voice/relay-incoming ✓ | `modernmanagementapp.com`/api/sms/incoming ✓ |

Neither number has voice/SMS **fallback URLs** or a **status callback**
configured (all empty) — noted, not currently a defect.

**Correct URL set** (canonical host = `PUBLIC_BASE_URL` =
`https://modernmanagementapp.com`):
- **PM numbers:** VOICE → `/api/voice/incoming` (the voicemail TwiML:
  `<Say>` + `<Record transcribe>` → `/api/voice/transcription`).
- **PS numbers:** VOICE → `/api/voice/relay-incoming` (the
  ConversationRelay entry TwiML that opens the AI socket).
- **Both:** SMS → `/api/sms/incoming`.

So exactly **one field on one number** is wrong: ws3's voice host.

## 2. THE HEADLINE (found while probing, and it changes the arc)

**Twilio webhook signature validation is BYPASSED in production.**

Probed directly against our own stateless TwiML endpoint:
- a valid signature computed for the **onrender** URL → **200**
- a valid signature for the **app.com** URL → **200**
- a **deliberately bogus** signature → **200**
- **no `X-Twilio-Signature` header at all → 200**

The last case is decisive: `validateTwilioSignature` returns 403 when
the header is missing, so the only reachable path to 200 is the
escape hatch at server.js:298 —
`TWILIO_VALIDATE_WEBHOOKS === 'false'` is set in the Render
environment (it is NOT in the local .env, so it was set deployment-side
and has been on ever since).

Two consequences, both material:

**(a) It is the only reason the stale URL currently works.** The
validator builds its expected URL from `PUBLIC_BASE_URL`, *not* from
the request's actual host:
```js
const base = process.env.PUBLIC_BASE_URL ? ... : (req.protocol + '://' + req.get('host'));
const publicUrl = base + req.originalUrl;
```
Twilio signs the URL **it actually called**. So the moment validation
is switched on, a call to ws3's onrender voice URL is signed over
`modernmanagement.onrender.com/...` while the app checks against
`modernmanagementapp.com/...` → mismatch → **403 → the call drops**.
**Fixing the URL is therefore a prerequisite for ever re-enabling
signature validation**, and re-enabling validation without fixing it
would silently break PM voice.

**(b) Independently: all six Twilio-facing routes are currently
unauthenticated.** Anyone who knows the URLs can POST forged inbound
SMS, voicemail recordings, or transcriptions and have them land in a
customer's inbox as genuine. That is a real security hole, wider than
SP5's scope, and it deserves its own ruling — see §5.

## 3. Blast radius of a wrong voice URL

- **Wrong HOST (today's ws3 state):** works only while both hosts
  resolve *and* validation stays off. If onrender is retired/renamed →
  Twilio gets a connection error → the caller hears Twilio's generic
  failure message and **the call is lost** (no voicemail, no
  transcript, no record in the inbox — the owner never learns someone
  called). If validation is enabled first → same loss, immediately,
  via 403.
- **Wrong PATH, PM number → `/api/voice/relay-incoming`:** the caller
  reaches the AI-relay entry point; `lookupWorkspaceByTwilioNumber`
  *would* match ws3, so it would try to open an AI socket for a
  property-management workspace — the PM owner's callers would get an
  AI receptionist instead of voicemail, and no recording/transcript
  would ever be produced.
- **Wrong PATH, PS number → `/api/voice/incoming` (the exact damage a
  naive repair re-run would cause):** the caller hears *"Thank you for
  calling Modern Management. Please leave your message after the
  beep"* — the wrong business identity, in the wrong product, with the
  AI receptionist silently bypassed. This is the single most important
  reason the code fix must land before any repair run.

## 4. Is the repair code, config, or both? — BOTH, in this order

**Code first (mandatory).** `lib/twilio-provisioning.configureNumberWebhooks`
hardcodes the PM path for every number:
```js
smsUrl:   baseUrl + '/api/sms/incoming',
voiceUrl: baseUrl + '/api/voice/incoming',
```
Any repair run — or any future re-provision — pointed at a PS number
would clobber `/api/voice/relay-incoming` into the PM voicemail path
(the §3 damage). So `configureNumberWebhooks` must become
**vertical-aware** *before* it is ever pointed at a live number. Note
this is also why SP4a's worker is currently PM-correct only: it calls
the same function, so **every number it provisions today gets the PM
voice URL regardless of vertical** — meaning a newly provisioned PS
workspace would have the wrong voice path from birth. That is a live
bug the vertical-aware fix also closes.

**Then config (the one-field repair).** Repoint ws3's voice URL to
`https://modernmanagementapp.com/api/voice/incoming`. Two ways:
- via the fixed code (preferred — it exercises the new path and proves
  it), or
- a one-line Twilio Console edit.

**A repair blocker to solve first:** `workspaces.twilio_phone_sid` is
**NULL for ws3** (ws17 has `PN342fccc1…`, matching the API). The
configure function takes a *SID*, so a code-driven repair must first
resolve ws3's SID from the API by phone number (`PNe484e725…`) — and
ideally backfill the column while it's there, since a missing SID also
blocks any future automated reconfiguration or release.

## 5. Proposed SP5 sequence

- **SP5a — make `configureNumberWebhooks` vertical-aware** (code only,
  no live numbers touched): take the vertical (or an explicit
  voiceUrl), map PS → `/api/voice/relay-incoming`, PM → `/api/voice/
  incoming`, SMS unchanged; update the SP4a worker's call to pass the
  workspace's vertical. Suite: PM/PS each get the right pair; an
  unknown vertical defaults safely; the worker passes its vertical
  through. **This also fixes the birth-defect for newly provisioned PS
  numbers.**
- **SP5b — the repair run** (config, executed through the fixed code):
  backfill ws3's `twilio_phone_sid` from the API, then repoint its
  voice URL to the canonical host, then re-read from the API and prove
  both numbers match their vertical's correct set. A verification-only
  script that reports drift is worth keeping.
- **SP5c (ruling wanted) — re-enable signature validation.** Once the
  URLs are canonical, `TWILIO_VALIDATE_WEBHOOKS` can be removed/flipped
  on Render so the six Twilio routes stop accepting forged requests.
  Recommend also making the validator's `base` fall back to the request
  host rather than trusting `PUBLIC_BASE_URL` blindly, so a
  legitimately multi-host deployment can't be broken by the same
  mismatch. **This is a security fix, not a webhook-repair chore —
  it deserves its own explicit go/no-go from Jay**, including whether
  to flip it in a low-traffic window and how to watch for 403s
  afterward.

**Flag on ordering:** SP5c must come *after* SP5b, never before —
enabling validation while ws3 still points at onrender would drop that
number's calls immediately.

No code changed for this investigation; this document is the whole of
the SP5 look-first.
