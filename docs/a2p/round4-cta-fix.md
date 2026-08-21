# A2P round 4 — CTA verification failure: fixes prepared, resubmission HELD

Round 3 verdict: earlier codes stayed cleared; NEW failure = "issues
verifying the Call to Action" — the reviewer couldn't validate the
opt-in as they see it. Two suspects:

- **S1 — the Drive proof link may be sign-in-walled.** Jay is
  incognito-testing. If the folder demands a Google login, that alone
  explains the CTA failure (the reviewer's "proof" was a login wall).
  Fix if convicted: set the folder to true anyone-with-link Viewer (or
  replace with direct file links / host the PNGs somewhere public).
- **S2 — the bare /sms-opt-in read as a mock** ("your business"
  placeholder wording). **FIXED regardless (this commit, deployed):**
  the bare page now presents fully real — defaults to the demo shop
  (Northside Barbers) everywhere the reviewer looks (title, consent
  sentence, success view) with the honest caption "Shown for our demo
  business, Northside Barbers — each business on Modern Management has
  this same form carrying its own name." No placeholder wording
  anywhere. Consent records from the bare page still store
  business_name = '' — the default is presentational, never recorded
  as consent FOR Northside.

## Revised campaign description (1015 chars, MEASURED — fits the 1024
## cap; paste verbatim WHEN the hold lifts)

Modern Management (R2 LABS LLC) is a scheduling platform for appointment-based service businesses (salons, barbershops). WHO SENDS: each business texts its OWN customers; the sender identity is that business (e.g. "Bella's Salon"); we operate the platform on its behalf. WHO RECEIVES: only that business's own customers, with prior consent. WHY: transactional only — appointment reminders/confirmations, service replies, verification codes, payment links/receipts. No marketing. OPT-IN: (1) live web form at https://modernmanagementapp.com/sms-opt-in — publicly viewable, no login required — the customer must check an unchecked-by-default box with the full consent text, STOP/HELP and Msg&Data rates; consent is not a condition of purchase; each opt-in is recorded (wording, date, number). (2) In-app owner intake blocks saving a number until the same consent box is confirmed. (3) Customers who text first receive replies. Reply STOP to unsubscribe, HELP for help. Terms: https://modernmanagementapp.com/sms-terms

(If the field still has room after paste, append: " Opt-in screenshots:
<Drive link>" — ONLY once S1 is cleared or the link is replaced with a
public one.)

## HOLD
Do NOT resubmit until (a) Daniela answers, or (b) the incognito test
convicts S1 and the link is fixed public. The page fix (S2) ships now
regardless — the live form must read real to any visitor at any time.
