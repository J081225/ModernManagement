# Toll-Free Verification (TFV) — investigation (read-only)

Status: **investigation only. Finding: already done — nothing to submit.**
Verified against the Twilio API 2026-08-16.

## Finding — the toll-free number is ALREADY verified

- The account has **exactly one** toll-free (855) number: **`+18555350785`**
  (`PNe484e725dc7af5a26d9fcd9b9718e130`). The "platform number"
  (`TWILIO_PHONE_NUMBER`) and **ws3 "Modern Management"** are the **same
  number** — not two.
- Its Toll-Free Verification is **`TWILIO_APPROVED`**
  (`HHda4168fe1f74ed197e3fef6fea58a1f6`, `rejection_reason: null`). The
  supporting trust bundle (`BUb6092…`, toll-free policy) is approved and
  bound to the "Modern Management" profile (`BUa18dc186…`).

**So there is no TFV submission to make** — the platform toll-free number
is already cleared to send. This task is closed unless/until a NEW
toll-free number is added.

## For the record — what TFV asks (if a future number needs it)

The Toll-Free Verification form (Twilio Console / `/v1/Tollfree/Verifications`)
asks for:
- **Business name + website + address**, business contact.
- **Use-case category** (e.g., "Account Notifications", "Customer Care",
  "2FA", "Higher Education", etc.).
- **Use-case summary / message volume** (monthly).
- **Sample messages** (1–5).
- **Opt-in type + opt-in image/URL** — how consumers consent, with
  evidence (screenshot of the consent language at collection).
- **Production message content**, and whether messages include
  **embedded links / phone numbers**.

## Our honest use case (for the record)

Same as A2P (transactional/service): appointment reminders and
confirmations, customer-service replies, verification codes, and payment
links/receipts — business-initiated to customers with an existing
relationship. No marketing.

**Sample messages:** identical shape to the A2P samples (see
`a2p-registration-plan.md` §3.2, "Bella's Salon").

**Opt-in story:** customers provide their number by contacting the
business or booking; consent is captured at the point of the
relationship, and every message carries "Reply STOP to opt out." **The
consent-line ruling applies here too** — the disclosure shipped on the
contact-intake form (`app.html`, `#cPhoneConsent`) covers this surface;
the STOP/HELP honoring (migration 069 + `lib/sms-consent`) applies to the
toll-free number as well.

_No TFV submitted (none needed). Reopen only if a new toll-free number is
provisioned._
