# A2P 10DLC Registration Plan (prep — read-only, for Jay's review)

Status: **prep only. Nothing submitted, no code changed.** Fees below are
best-known figures — **confirm current Twilio pricing at submission time**
(A2P fees change and carrier pass-through fees are separate). Verified
against the Twilio Trust Hub API 2026-08-16.

---

## 0. TL;DR + recommendations

- **Profile:** the new `BU2df49f5a9c04a3518c975764d1b8ffea` is
  **API-confirmed `twilio-approved`** and is a **"Primary Customer
  Profile of type Business"** — the correct profile for A2P Brand. It
  **differs** from the rejected `BU93940826…`. **No runtime code** binds
  to any profile SID (only a historical support-reply script mentions the
  old one).
- **Brand tier:** recommend **Low-Volume Standard** — we have an EIN, so
  we qualify as a Standard brand, and our volume is tiny (no texts
  delivered yet), so we skip the ~$40 external vetting.
- **Numbers — important:** only **ws17's local `+1 646…`** is an A2P
  10DLC number. **The platform `+1 855…` and ws3's `+1 855…` are
  TOLL-FREE** → they use **Toll-Free Verification, a SEPARATE path, not
  A2P**. The A2P campaign covers local long-code numbers only.
- **Pre-campaign BUILD required (STOP):** our inbound handler does **not**
  honor STOP today — a customer texting "STOP" is fed to the AI, which
  would reply conversationally. See §3.4. Recommend a small opt-out
  short-circuit before we go live.
- **Use case:** one campaign, **Low-Volume Mixed** (transactional:
  reminders, confirmations, customer-service replies, verification codes,
  payment links/receipts).

---

## 1. Profile verification (Trust Hub API, 2026-08-16)

| Profile SID | friendly_name | status | policy | verdict |
|---|---|---|---|---|
| `BU2df49f5a9c04a3518c975764d1b8ffea` | "My first Twilio account" | **twilio-approved** | **Primary Customer Profile of type Business** | ✅ the A2P Primary Business Profile |
| `BUa18dc186a68d44e75c509e31029be93d` | "Modern Management" | twilio-approved | Starter Customer Profile (basic tier) | not the A2P Primary — leave it |
| `BU93940826a7eaa1d353df389e1204e09c` | R2 LABS LLC (ticket #28847766) | rejected / not listed | — | superseded ✅ |

- **Confirmed:** the new SID reads `twilio-approved` and **differs** from
  the rejected one. Contact email on both live profiles is
  `jayhorton87@gmail.com`.
- **⚠️ Confirm before Brand submit:** BU2df49's friendly_name is the
  generic default ("My first Twilio account"). The A2P Brand pulls its
  legal business name + EIN from this profile — **verify the business
  entity/EIN inside it is R2 LABS LLC** (or whatever legal entity should
  appear on the brand). Twilio approved it, so the underlying business
  info is verified; just confirm it's the entity we want on the brand.
- **Code/config referencing the OLD profile SID:** exactly one file —
  `scripts/send-twilio-reply.js` (lines 10 & 31), a one-off script that
  emailed Twilio support about the rejected profile. It is **not runtime
  config** and nothing in the app reads it. **No migration needed;**
  optional cleanup (delete/annotate the historical script).

---

## 2. Trust Hub next steps

### 2a. A2P Brand registration (uses BU2df49…)

**⚠️ SUBMISSION REALITY (found 2026-08-16, before submitting):** the Brand
POST requires TWO bundles — `CustomerProfileBundleSid` (BU2df49 ✓,
approved) **and `A2PProfileBundleSid`, an "A2P Messaging Profile"
TrustProduct that DOES NOT EXIST yet.** The account's only two bundles are
**SHAKEN/STIR (voice)** and **Toll-free** — neither is A2P messaging.
Creating the A2P bundle is a multi-step TrustHub operation (TrustProduct
with the A2P policy → assign BU2df49 + an `us_a2p_messaging_profile`
end-user → evaluate → submit → await its OWN approval), and only then can
the Brand be POSTed (then the Brand itself needs approval).

**Path decision (Jay's call):**
- **Console A2P wizard (recommended):** creates the A2P bundle + brand in
  one guided flow AND shows the exact fee BEFORE charging (a raw API POST
  charges with no preview). Enter the fields below; report the Brand SID +
  fee it shows.
- **API orchestration (I can do it):** I build the A2P bundle + brand via
  TrustHub calls — flagged risk: several async approval gates and
  end-user attributes that, done wrong, create rejected/malformed bundles
  and waste fees. I did NOT fire these blind.

Brand type is **STANDARD** (Low-Volume is a campaign/vetting distinction,
not a brand type; set `SkipAutomaticSecVet=true` to avoid the ~$40 sec
vet). Fields the Brand form requires (most auto-fill from BU2df49):

- **Legal business name** (must match EIN records exactly)
- **Business type / structure** (e.g., Private / LLC)
- **Business identity** — "Private for-profit" (typical)
- **Business registration ID type** — usually **EIN** (US Tax ID)
- **Business registration number** — the EIN
- **Business industry / vertical** (e.g., Professional Services)
- **Website URL** (`https://modernmanagementapp.com`)
- **Regions of operation** (US / +others)
- **Stock exchange + ticker** — only if publicly traded (N/A for us)
- **Authorized representative** — first name, last name, business title/
  job position, email, phone
- **Business address** — street, city, state/region, postal code, country

**Standard vs. Low-Volume Standard:**
- **Standard:** full brand; to unlock higher carrier throughput you pay
  a one-time **external vetting** (~$40, third-party). Best when you send
  volume.
- **Low-Volume Standard (recommended):** same EIN-backed Standard brand,
  registered for low-volume campaigns; **no external vetting fee**, lower
  monthly, lower daily caps (fine for our stage). We are **not** Sole
  Proprietor — we have an EIN and a Business profile.

**Fees (confirm at submission):**
- Brand registration: **one-time ~$4**.
- Standard external vetting: **~$40 one-time — SKIPPED** for low-volume.

### 2b. A2P Campaign registration

Campaign form fields:

- **Use case** (pick one): our fit is **Low-Volume Mixed** (or Customer
  Care + 2FA if we split). Mixed covers reminders + service + codes +
  payment notices in one campaign.
- **Campaign description** — the use-case narrative (draft in §3.1).
- **Sample messages** — 2–5 representative messages (draft in §3.2).
- **Message flow / opt-in description** — how consumers consent (§3.3).
- **Opt-in keywords/message, Opt-out keywords/message (STOP), Help
  keywords/message (HELP)** (§3.4).
- **Embedded links?** → **Yes** (payment links).
- **Embedded phone numbers?** → optional (business callback).
- **Age-gated / SHAFT content?** → **No**.
- **Direct lending / loan?** → **No**. **Affiliate marketing?** → **No**.

**Fees (confirm at submission):**
- Campaign registration: **monthly**, by use case — Low-Volume Mixed
  **~$1.50–$2/mo**; a Standard Mixed campaign is **~$10/mo**.
- Some use cases carry a **one-time campaign vetting (~$15)**.
- **Carrier pass-through fees** (per-campaign monthly + per-message
  carrier surcharges) are **separate and additional** — these are the
  ones that add up; check the current Twilio A2P fee schedule.

---

## 3. Campaign submission text — APPROVED (rulings 4 + 5 applied)

Approved by Jay with two edits, applied below: samples anonymized to a
placeholder customer business ("Bella's Salon"), and the ISV transparency
sentence added. **This is the text to submit.**

### 3.1 Campaign description (FINAL)

> Modern Management provides an AI-assisted scheduling and operations
> platform for small service businesses (salons, barbers, and similar
> service providers). The sender identity is the customer business using
> the Modern Management platform to reach its own customers, and consent
> is collected per business, per end customer. Messages are sent by the
> business to its own customers with whom it has an existing relationship,
> after the customer contacts the business or books an appointment. All
> messages are transactional and service-related: appointment reminders
> and confirmations, replies to customer service questions, one-time
> verification codes, and payment-request links and receipts. Every
> message is business-initiated in response to a customer inquiry or
> booking. No promotional, marketing, or advertising content is sent on
> this campaign.

**Reasoning:** every message type is transactional and tied to an
existing customer relationship (inbound contact or a booking) — the
lowest-risk A2P profile. The ISV sentence is honest about the
platform/business relationship (we operate the platform; the business is
the sender). We explicitly disclaim marketing so the campaign is reviewed
as transactional/customer-care.

### 3.2 Sample messages (FINAL — anonymized to "Bella's Salon")

1. **Reminder:** "Hi, this is Bella's Salon — a reminder of your
   appointment tomorrow at 2:00 PM. Reply C to confirm or call
   (646) 555-0100 to reschedule. Reply STOP to opt out."
2. **Confirmation:** "Bella's Salon: your appointment on Aug 20 at
   2:00 PM is confirmed. See you then. Reply STOP to opt out."
3. **Customer-service reply:** "Hi — yes, we have openings Friday
   afternoon. Would 3:00 PM work? — Bella's Salon. Reply STOP to opt out."
4. **Verification code:** "Your Bella's Salon verification code is 481920.
   It expires in 10 minutes. Reply STOP to opt out."
5. **Payment link / receipt:** "Bella's Salon: your balance of $45.00 is
   ready to pay securely: https://squareup.com/pay/… . Reply STOP to opt
   out."

(Each sample includes the STOP disclosure — carriers expect it in at
least the first/periodic message.)

### 3.3 Opt-in description (draft) + honesty note

> Consumers provide their mobile number to the business when they contact
> it (call, text, or in person) or when booking an appointment, and in
> doing so consent to receive service messages about their appointment
> and account. Messages are sent only to customers with an existing
> relationship with the business.

**⚠️ Honest gap to close:** carriers/CTIA want opt-in **consent language
visible at the point of collection.** Our booking/contact flow should
display a line like: *"By providing your number you agree to receive
service texts from [business]; msg & data rates may apply; reply STOP to
opt out, HELP for help."* If the booking UI / intake doesn't show this
today, add it before or alongside the campaign (small copy change, not a
big build). Flagging so we don't claim an opt-in disclosure we don't show.

### 3.4 Opt-out (STOP) + HELP — **PRE-CAMPAIGN BUILD FLAGGED**

**Current reality (verified):** `POST /api/sms/incoming`
([server.js:7331](../server.js#L7331)) does **NOT** check for STOP. An
inbound "STOP" is written to `messages` and, for auto-respond PS
workspaces (like ws17), passed straight to the AI engine
(`processInboundMessage`) — which would try to **reply conversationally
to "STOP."** No app-level opt-out, HELP, or opted-out suppression exists
(the only `opt-out` string in the codebase is spam-detection in
`lib/reflection.js`).

**What protects us today:** Twilio's default opt-out honors STOP at the
account/Messaging-Service layer (blocks further sends, auto-confirms),
so a real customer wouldn't receive the AI's reply — but relying on that
alone is fragile and not auditable, and the AI processing "STOP" as a
conversation is wrong.

**Recommendation (two parts):**
1. **Required:** route campaign sends through a **Messaging Service with
   Advanced Opt-Out enabled** (default on) — Twilio then handles
   STOP/UNSTOP/HELP at its edge and they never reach our webhook.
2. **Recommended pre-campaign build (small, own unit):** short-circuit
   `STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT`, `START/UNSTOP`, and `HELP`
   in `/api/sms/incoming` **before** the AI engine — record the opt-out,
   suppress future sends to that number, and never let the AI answer a
   keyword. Belt-and-suspenders + auditable.

Declared to Twilio: **Opt-out** — "Reply STOP to unsubscribe; we send a
confirmation and no further messages." **HELP** — "Reply HELP → 'R2 Labs:
for help call (646) 555-0100. Msg & data rates may apply. Reply STOP to
opt out.'"

### 3.5 What could read as MARKETING — and how to word around it honestly

- **Payment links:** a link + a dollar amount can trip marketing filters.
  Keep copy strictly "pay your balance / your receipt" — **never** "book
  now," "special," "% off," "deal," or any offer. (Our copy above does.)
- **Rebooking nudges:** an unsolicited "time for your next visit?" reads
  as marketing. Only send appointment messages **in response to** a
  booking/inquiry or as a reminder for an existing appointment — not
  unprompted win-back blasts on this campaign.
- **`send_broadcast` tool:** it exists and could be used to blast many
  customers. On a transactional campaign that's a violation if the
  content is promotional. Either restrict broadcasts to genuine service
  notices (closure, delay) **or** register a **separate Marketing
  campaign** if promotional blasts are ever wanted. Flag: keep this
  campaign clean of anything promotional.
- **Links:** use first-party / processor domains (Square/Stripe, our app)
  — **avoid public URL shorteners** (bit.ly etc.), which carriers flag.

---

## 4. Messaging Service linkage, numbers, and the ISV future path

**Now (small scale):**
- Create **one Messaging Service**, enable **Advanced Opt-Out** (default),
  and **link it to the A2P campaign**.
- **Attach the LOCAL 10DLC numbers** to it. Today that's **ws17 `+1 646…`
  (R2 Labs, active, auto-respond on)** and any future local workspace
  numbers.
- **Toll-free numbers are separate:** the platform **`+1 855…`** and ws3
  **`+1 855…` (Modern Management)** are toll-free → they go through
  **Toll-Free Verification** (its own Twilio flow — no brand/campaign, no
  monthly campaign fee; toll-free actually gets higher throughput once
  verified). **Do not** put them on the A2P campaign.

**Related deferred item now in scope:** the six PM-era paths that send
from the platform number directly (memory: *pm-platform-send-paths*) —
with A2P clearing, revisit whether each should send from the workspace
number (held when absent) or remain platform-sourced. The platform number
being toll-free means those platform sends ride Toll-Free Verification,
not A2P.

**Future ISV / sub-brand path (deferred, for scale):** as the platform
grows, the compliant model is the **ISV/reseller** pattern — register
**each customer business as its own sub-account/Secondary Customer
Profile + A2P Brand + Campaign**, so a customer's number sends under
**their** brand (their EIN, their consent), not ours. That's a larger
build (per-customer Trust Hub onboarding, likely via the Twilio ISV API)
and is **not** today's task. Today: **one brand (ours) + one campaign**
covering our own local numbers.

---

## 5. Status after the eight rulings

**Pre-campaign BUILDS — shipped:**
- ✅ **STOP/HELP unit** (§3.4): migration 069 `sms_opt_outs`,
  `lib/sms-consent`, inbound short-circuit before the AI, send-layer
  suppression, pin `test-sms-consent.js`. TCPA law.
- ✅ **send_broadcast guard** (ruling 7): service-notices-only +
  opt-out suppression, pinned.
- ✅ **Opt-in consent line** (ruling 5): shipped on the contact-intake
  form (owner attests consent; "reply STOP anytime"). No customer-facing
  self-service phone form exists — customers arrive via inbound SMS or
  owner entry.
- ✅ **Annotation** (ruling 8): `scripts/send-twilio-reply.js` marked
  SUPERSEDED (kept, not deleted).

**Infra:**
- **Messaging Service + Advanced Opt-Out + attach ws17's 646** (ruling 2)
  — see §6 for the created resource. Inbound webhook left on the number
  (defer) so ws17's live inbound is unchanged.

**Open items / Jay's errands:**
1. **Jay to confirm in Console (ruling 1):** the legal entity + EIN inside
   `BU2df49…` is the entity we want on the brand (friendly_name is the
   generic default). Report on Jay's word.
2. **Toll-Free Verification — separate task (opened):** the platform
   `+1 855…` and ws3's `+1 855…` need Toll-Free Verification, a distinct
   Twilio flow from A2P. Tracked as its own small item; not part of this
   A2P submission.
3. **Fees at submission (ruling 6) — record here for the pricing session:**

   | Item | Est. | Actual (fill at submit) |
   |---|---|---|
   | Brand registration (one-time) | ~$4 | |
   | External vetting (Low-Volume: skipped) | $0 | |
   | Campaign — Low-Volume Mixed (monthly) | ~$1.50–2 | |
   | One-time campaign vetting (if any) | ~$15? | |
   | Carrier pass-through (monthly + per-msg) | varies | |

**Submission sequence (Jay's order):** STOP unit ✅ → consent copy ✅ →
**submit Brand → Campaign** with the approved §3.1–3.2 text → create/link
Messaging Service (§6) → attach the local number.

_No A2P Brand/Campaign submitted. Ready for Jay's final eyes + Console
confirmation (item 1)._

---

## 6. Messaging Service — CREATED (ruling 2)

Created via the Twilio API 2026-08-16:

- **Service SID:** `MGc58146677dd937feb0dcf98aca497f31`
- **Friendly name:** "Modern Management A2P (transactional)"
- **`use_inbound_webhook_on_number = true`** — the service DEFERS inbound
  to each number's own webhook, so **ws17's `/api/sms/incoming` routing
  is unchanged** (this is what keeps live inbound working).
- **Attached number:** `+16469177820` (ws17, R2 Labs) —
  `PN342fccc19fae1d316aa7cf1b710559af`. Verified on the service.
- **Advanced Opt-Out:** a new Messaging Service defaults to opt-out
  management ON (STOP/UNSTOP/HELP handled at Twilio's edge). Jay to
  confirm it's enabled in Console; our in-app STOP layer (§3.4) is the
  belt-and-suspenders regardless.

**At submission:** link the approved **A2P Campaign** to this Messaging
Service; only then do carrier sends deliver. Future local workspace
numbers attach to this same service (toll-free numbers do NOT — §5 item 2).
