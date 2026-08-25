# A2P approved state — live Twilio read-back
(Read-only, 2026-08-25, via Twilio REST GETs + DB read. No changes.)

## 1. Campaign status: **VERIFIED**
- Resource: `QE2c6890da8086d771620e9b13fadeba0b` on
  MG5422d67b5fda2f0caa797880a988c00e, brand BNadd0ca7…
- `campaign_status: "VERIFIED"` (verbatim), `failure_reason: null`,
  `errors: []`, date_updated 2026-08-16T17:27:16Z.
- **Premise correction:** the sid `CM23e5d60d235b7fe2cf73ebf455178a22`
  from the request returns HTTP 404 and appears nowhere in the
  account. The campaign's TCR id is **`CEB9N5O`**; the Twilio resource
  sid is the QE… above. Those two are the real identifiers.

## 2. Numbers on the Messaging Service — exactly ONE
| Number | PN sid | Workspace | sms_url | voice_url |
|---|---|---|---|---|
| +1 646 917 7820 | PN342fccc1… | ws17 R2 Labs | modernmanagementapp.com/api/sms/incoming | …/api/voice/relay-incoming |

Fallback URLs and status_callback: empty. Everything on-domain.

## 3. Stale-config flags: **the two known ones NO LONGER EXIST**
Checked sms_url, sms_fallback_url, voice_url, voice_fallback_url, and
status_callback on ALL FOUR account numbers:
- **No `example.com` placeholder anywhere.**
- **Toll-free +1 855 535 0785 voice_url = modernmanagementapp.com/api/voice/incoming** — not old Render.
- No URL on any number points off-domain. The two flagged staleness
  items appear to have been fixed at some earlier point; the live read
  contradicts the premise, so nothing to fix here.
- Only anomaly: the spike line **+1 313 631 8389 has an EMPTY
  sms_url** (inbound SMS to it goes nowhere). Harmless for a
  voice-only test line; noting for completeness.

## 4. Workspace numbers NOT attached to the service
These cannot send SMS under the approval today:
| Number | Workspace | Note |
|---|---|---|
| +1 855 535 0785 | ws3 Modern Management (platform/PM) | Toll-free — rides the separate toll-free verification path, not 10DLC; whether TF verification exists is unverified (open question). All six PM-era platform-number send paths ride this number. |
| +1 332 249 4333 | ws21 Northside Barbers (demo) | NOT attached. Demo SMS is structurally blocked in code anyway — but if demo texting is ever ruled ON post-approval, attaching this number to MG5422… comes FIRST. |

(+1 313 631 8389 spike line: no workspace, not attached — expected.)

## Implications for the go-live ruling (nothing done)
1. Only ws17's number can send under the campaign right now. Real
   customer workspaces onboarding later must have their numbers added
   to MG5422… as part of provisioning — worth a suite row when ruled.
2. Demo texting (if ever) = attach +1332… first, then revisit the
   three structural is_demo SMS blocks.
3. ~~Toll-free verification status for the 855 is the remaining
   unknown~~ **RESOLVED (read 2026-08-25): the 855's toll-free
   verification is `TWILIO_APPROVED`** (verification HHda4168…,
   rejection_reason null, since 2026-04-22). The six PM-era platform
   send paths' compliance dependency is settled — their remaining gate
   is the [[pm-platform-send-paths]] ruling itself, not carrier
   status.
