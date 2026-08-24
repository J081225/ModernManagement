# A2P round 6 — live-page ground truth
(Read-only, 2026-08-24. Every quote below is from a LIVE curl of
production, not from repo files, except where a file:line is cited for
raw-HTML or code evidence. No changes.)

## 1. The pages and their exact URLs
| Page | URL | Served from |
|---|---|---|
| Opt-in form | https://modernmanagementapp.com/sms-opt-in | [server.js:476](../server.js#L476) → public/sms-opt-in.html |
| Reviewer proof | https://modernmanagementapp.com/a2p-proof | [server.js:486](../server.js#L486) |
| **Privacy Policy** | **https://modernmanagementapp.com/privacy** | [server.js:490](../server.js#L490) → public/privacy.html |
| **Terms of Service** | **https://modernmanagementapp.com/terms** | [server.js:489](../server.js#L489) → public/terms.html |
| SMS Program Terms | https://modernmanagementapp.com/sms-terms | [server.js:481](../server.js#L481) |
| SMS consent explainer | https://modernmanagementapp.com/sms-consent | [server.js:471](../server.js#L471) |

All five fetched live; full visible text captured (privacy is the
Aug 16, 2026 revision; terms likewise). Terms §2.1 "SMS Messaging
Program" and the dedicated /sms-terms page both exist and carry the
program language.

## 2. Privacy Policy vs the 30909 checklist
| Check | Verdict | Live quote |
|---|---|---|
| (a) numbers/consent NOT shared with third parties | **PRESENT** (§4.2) | "Mobile information — including mobile phone numbers and SMS opt-in and consent data — is not shared with third parties or affiliates for marketing or promotional purposes." Followed by: "Text-message opt-in and consent data is not shared with any third parties, and mobile phone numbers collected for messaging are never sold, rented, or shared for third-party marketing." |
| (b) message frequency disclosure | **MISSING on /privacy** | The word "frequency" does not appear anywhere on the live privacy page. It IS present on /sms-opt-in ("Message frequency varies.") and twice on /sms-terms ("Message frequency varies; message and data rates may apply."). If the vetter reads only the Privacy URL field target, this box is unchecked. |
| (c) "message and data rates may apply" | **PRESENT** (§4.2) | "Recipients can reply STOP at any time to opt out, or HELP for help; message and data rates may apply." |

**Round-6 gap: one sentence.** Adding "Message frequency varies" to
privacy §4.2 closes the only privacy-page miss.

## 3. /sms-opt-in vs the same checks
| Check | Verdict | Live quote |
|---|---|---|
| (a) no-third-party-sharing statement | **MISSING on-page** | The form links to Privacy/Terms/SMS program terms but carries no sharing statement of its own. (Both linked pages carry it.) |
| (b) frequency | **PRESENT** | "Consent is not a condition of any purchase. Message frequency varies. You can reply STOP at any time to cancel or HELP for help." |
| (c) rates | **PRESENT** (inside the checkbox label) | "Msg&Data Rates may apply." |

**Checkbox label, verbatim** (live text == repo
[public/sms-opt-in.html:126](../public/sms-opt-in.html#L126); business
name is dynamic via `?business=`, defaulting to the demo):

> By checking this box, you agree to receive SMS notifications about
> appointment reminders, confirmations, service replies, verification
> codes, and payment requests/receipts from **Northside Barbers** via
> Modern Management. To Unsubscribe, reply STOP. Need Assistance? Reply
> HELP. Msg&Data Rates may apply. See our Privacy Policy and Terms of
> Use.

**Unchecked by default: CONFIRMED in the actual HTML** —
`<input type="checkbox" id="consent" aria-label="I agree to receive SMS
messages" />` ([public/sms-opt-in.html:124](../public/sms-opt-in.html#L124))
has no `checked` attribute, and the page states beneath it: "Required —
you must check this box to sign up. It is never pre-checked."

## 4. Opt-in confirmation SMS: THERE ISN'T ONE
`POST /api/sms-opt-in` ([server.js:509-538](../server.js#L509)) only
INSERTs the consent row into `sms_consents` — **no SMS is sent after
the form.** Confirmation is on-screen only ("You're signed up …
Reply STOP anytime to cancel."). This is structurally consistent with
today's reality: the campaign isn't approved (nothing may send yet) and
the demo workspace is SMS-blocked at three seams.

The only consent-adjacent SMS copy that exists is the CTIA keyword
replies in [lib/sms-consent.js:70-78](../lib/sms-consent.js#L70):
- STOP → "<business>: you're unsubscribed and will get no more texts.
  Reply START to resubscribe."
- START → "<business>: you're resubscribed to appointment & account
  texts. Reply STOP to opt out."
- HELP → "<business> appointment & account texts. Msg & data rates may
  apply. Reply STOP to opt out."

So against the checklist's confirmation-SMS attributes (brand,
frequency, rates, STOP/HELP): **n/a — the message doesn't exist.** If
round 6 requires a post-opt-in confirmation SMS, it is a NEW build
(post-approval only), not a copy fix; the keyword replies above are the
closest existing pattern to model it on.

## Round-6 punch list implied by this ground truth (not built)
1. Privacy §4.2: add the missing frequency sentence (one line).
2. Optional belt: add the no-sharing sentence to /sms-opt-in itself so
   the form stands alone without following links.
3. Decide whether a post-form confirmation SMS is in scope for the
   resubmission narrative (currently: none exists, honestly disclosed).
