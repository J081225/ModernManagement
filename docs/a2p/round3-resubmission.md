# A2P round 3 — verbatim field text (30909 + 30886 fix)

Round 2 cleared 30908/30882 (URL fields). Remaining: 30909 (consent flow
insufficiently described — root cause: the consent field was LOCKED on
Jay's resubmission, reviewer read the old narrative) and 30886 (unclear
who sends / receives / why). Fix: the DESCRIPTION is now fully
self-contained — it carries the entire consent story, proof link, and
terms URL, so a locked consent field can never strand the facts again.
Campaign: QE2c6890da8086d771620e9b13fadeba0b (reuse; no new campaign).

---

## FIELD 1 — Campaign description (paste verbatim)

Modern Management (operated by R2 LABS LLC) is a scheduling and operations platform for appointment-based service businesses such as salons and barbershops. WHO SENDS: each business using the platform sends messages to its own customers; the sender identity is that business (for example, "Bella's Salon" in our samples), and Modern Management operates the platform on its behalf. WHO RECEIVES: only that business's own customers — people with an existing relationship with the business who have consented as described below. WHY: transactional and service messages only — appointment reminders and confirmations, replies to customer-service questions, one-time verification codes, and payment links and receipts. No marketing, promotional, or advertising content is sent on this campaign. HOW CONSENT IS COLLECTED (three paths): (1) LIVE WEB OPT-IN FORM at https://modernmanagementapp.com/sms-opt-in — the customer enters their name and mobile number and must actively check an unchecked-by-default checkbox before the form can be submitted. The checkbox text reads: "By checking this box, you agree to receive SMS notifications about appointment reminders, confirmations, service replies, verification codes, and payment requests/receipts from [Business Name] via Modern Management. To Unsubscribe, reply STOP. Need Assistance? Reply HELP. Msg&Data Rates may apply. See our Privacy Policy and Terms of Use." Consent is not a condition of any purchase, and each opt-in is recorded with the exact wording, date, and phone number. Screenshot proof of the opt-in screen (public link): https://drive.google.com/drive/folders/1kw3ltam0b4VpI1FNfpf5K2fc4SYdrGh9?usp=drive_link (2) IN-PERSON / OWNER INTAKE — when a business adds a customer's phone number inside the platform, saving is blocked until the business confirms, via the same unchecked-by-default checkbox wording, that the customer agreed to receive these messages. (3) CUSTOMER-INITIATED — a customer who texts the business first receives replies to their own inquiry. OPT-OUT: reply STOP at any time (enforced at our send layer and by the Messaging Service's Advanced Opt-Out); reply HELP for assistance. Full SMS program terms: https://modernmanagementapp.com/sms-terms — Privacy Policy: https://modernmanagementapp.com/privacy — Terms of Use: https://modernmanagementapp.com/terms

## FIELD 2 — Message flow / opt-in description (paste verbatim, if editable)

Consumers opt in through three paths, all requiring express consent before any message is sent. (1) The live web consent form at https://modernmanagementapp.com/sms-opt-in: the customer enters their mobile number and must actively check an unchecked-by-default checkbox reading "By checking this box, you agree to receive SMS notifications about appointment reminders, confirmations, service replies, verification codes, and payment requests/receipts from [Business Name] via Modern Management. To Unsubscribe, reply STOP. Need Assistance? Reply HELP. Msg&Data Rates may apply. See our Privacy Policy and Terms of Use." The form cannot be submitted unchecked; consent is not a condition of purchase; every opt-in is recorded with wording, date, and number. Visual proof: https://drive.google.com/drive/folders/1kw3ltam0b4VpI1FNfpf5K2fc4SYdrGh9?usp=drive_link (2) Owner intake: the business cannot save a customer's number in the platform without confirming, via the same checkbox wording, that the customer agreed. (3) Customer-initiated: customers who text the business first receive replies to their inquiry. Reply STOP to unsubscribe (send-layer enforced plus Advanced Opt-Out); reply HELP for help. Program terms: https://modernmanagementapp.com/sms-terms

## Note to Daniela (send after resubmitting)

Subject: Campaign QE2c6890 — round 3: URL codes cleared, description now self-contained

Hi Daniela — thank you: the URL-field fix worked, and 30908/30882 are gone. Two codes remained (30909, 30886), and we found why — the consent-narrative field was locked on our last resubmission, so the reviewer saw the old text; our live consent form, checkbox wording, and screenshot proof never reached them. I've now rewritten the campaign DESCRIPTION to be fully self-contained: who sends, who receives, why (transactional only), all three opt-in paths with the exact checkbox wording, the screenshot proof link, and the program-terms URL — so no locked field can hide the consent story again. Just resubmitted. If anything still reads unclear I'd be grateful for your eyes — and the expedite, if it looks right.

Best, Jay Horton — R2 Labs LLC / Modern Management
