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

## S1 RESOLVED BY EVIDENCE + SUPERSEDED (2026-08-21)

Drive's own ACL read: the folder is `type: anyone, role: reader` —
genuinely public, no sign-in wall. BUT a public Drive folder still
renders as a JavaScript app, which an AUTOMATED CTA verifier may not
crawl — so the Drive link is retired as proof regardless. **The proof
now lives on OUR domain: https://modernmanagementapp.com/a2p-proof** —
plain HTML, zero JS, both screenshots self-hosted at
/img/a2p/opt-in-form.png + /img/a2p/owner-intake.png (pulled from the
Drive folder, visually verified: the Bella's Salon opt-in form with
unchecked box + disabled button, and the owner Add Contact gate).
Nothing a reviewer lands on requires a login or a script.

## Revised campaign description (1004 chars, MEASURED — fits the 1024
## cap; paste verbatim WHEN the hold lifts)

Modern Management (R2 LABS LLC) is a scheduling platform for appointment-based businesses (salons, barbershops). WHO SENDS: each business texts its OWN customers; sender identity is that business (e.g. Bella's Salon); we operate the platform on its behalf. WHO RECEIVES: only that business's own customers, with prior consent. WHY: transactional only — appointment reminders/confirmations, service replies, verification codes, payment links/receipts. No marketing. OPT-IN: (1) live web form at https://modernmanagementapp.com/sms-opt-in — publicly viewable, no login — the customer must check an unchecked-by-default box with the full consent text, STOP/HELP and Msg&Data rates; not a condition of purchase; each opt-in recorded (wording, date, number). (2) In-app owner intake blocks saving a number until the same consent box is confirmed. (3) Customers who text first receive replies. Reply STOP to unsubscribe, HELP for help. Opt-in proof (public, no login): https://modernmanagementapp.com/a2p-proof

## HOLD
Do NOT resubmit until (a) Daniela answers, or (b) the incognito test
convicts S1 and the link is fixed public. The page fix (S2) ships now
regardless — the live form must read real to any visitor at any time.
