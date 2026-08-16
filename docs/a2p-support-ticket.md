# Twilio support ticket — A2P campaign manual re-vet (ready to paste)

Draft for the escalation Jay authorized: the campaign keeps failing on
privacy/terms verification even though the live site now publishes fully
compliant pages, and resubmissions return the **same codes within
seconds** — i.e., the automated vet is serving a cached verdict tied to
the campaign SID rather than re-crawling. Ask: **trigger a manual re-vet
against the live URLs.**

Fill the two bracketed values from Twilio Console before sending.

---

**Subject:** A2P 10DLC campaign rejected on privacy/terms (30908/30882) — site now compliant, please trigger a manual re-vet

**Body:**

Hello,

Our A2P 10DLC campaign is being rejected for privacy-policy and
terms-and-conditions verification, but our website now publishes the
required, compliant pages. Repeated resubmissions return the identical
error codes within seconds, which suggests the automated vetting is
returning a cached result tied to the campaign SID rather than
re-crawling the (now updated) site. Please trigger a **manual re-vet**
of the campaign against the live URLs below.

- Account SID: [ACCOUNT_SID]
- A2P Brand SID: BNadd0ca7348529df7d25b2eed981f8e28 (status: APPROVED)
- A2P Campaign SID: QE2c6890da8086d771620e9b13fadeba0b (use case: LOW_VOLUME)
- Messaging Service SID: MG5422d67b5fda2f0caa797880a988c00e
- Rejection codes: 30908 (privacy policy could not be verified),
  30882 (terms and conditions)

Our live, compliant pages (all reachable from the homepage footer):

- Privacy Policy — https://modernmanagementapp.com/privacy — §4.2
  "Mobile Information and SMS Consent" states verbatim that mobile
  information, including mobile phone numbers and SMS opt-in/consent
  data, is **not shared with third parties or affiliates for marketing
  or promotional purposes**, and is never sold or rented.
- SMS Program Terms & Privacy — https://modernmanagementapp.com/sms-terms
  — first paragraph: transactional/service messages only, sent by each
  business using our platform to its own customers, **no marketing, no
  third-party or affiliate sharing or sale** of mobile information or
  consent, message frequency varies, message & data rates may apply,
  STOP to opt out / HELP for help, carrier disclaimer.
- Terms of Service — https://modernmanagementapp.com/terms — §2.1 "SMS
  Messaging Program" mirrors the same transactional/ISV statements.
- SMS Consent — https://modernmanagementapp.com/sms-consent

Program summary: messages are transactional and service-related
(appointment reminders/confirmations, customer-service replies,
verification codes, payment links/receipts), business-initiated to
customers with an existing relationship. This is an ISV/reseller setup:
the sending identity is the customer business using our platform; consent
is collected per business, per end customer. We honor STOP/HELP both in
our application and via the Messaging Service's opt-out.

Please advise if any specific wording or page is still needed. Thank you.

---

_Status: campaign FAILED again 2026-08-16 (instant, same codes) on a
fresh Messaging Service (MG5422d67b…) with a brand-new /sms-terms page
and the policy URLs embedded in the application text — confirming the
cached-verdict behavior. This ticket is the next step per Jay's ruling._
