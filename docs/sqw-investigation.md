# SQ-W Investigation — walk-in (counter-tap) payment capture

Demo-surfaced gap: a barber's counter taps (customer taps phone on his
Square reader) never reach Finances. Our Square webhook receives
`payment.updated` for EVERY payment on the connected merchant and
deliberately drops the ones that aren't ours. **Investigation only — no
code changed.** Evidence is file:line; Square payload facts are from the
Square Payments API reference; the one thing I could NOT do from here is
fire a sandbox in-person payment (reason in §1.3).

---

## 0. TL;DR

- **Yes, the taps arrive.** Square webhook subscriptions are merchant-wide:
  POS taps, Terminal, Virtual Terminal, Invoices, and our Checkout links
  all emit `payment.created` → `payment.updated` (COMPLETED). The webhook
  already sees them; the ledger refuses them at
  [payment-ledger.js:320/330](../lib/payment-ledger.js) (`no_order_id` /
  `no_ledger_row`), the route logs "completion REFUSED" and returns 200,
  and the payment is **gone — nothing persists** (there is no webhook-
  event table). That's the whole defect: a drop with no trace.
- **The discriminator is NOT "has an order."** POS taps create Square
  orders too. The honest test is "is this order/payment ONE OF OURS"
  (`transaction_payments.processor_ref`) — plus payload fields that say
  *how* it was taken (`card_details.entry_method`,
  `application_details.square_product`, `device_details`).
- **Security posture holds by construction:** the new lane never touches
  a pending row; it only CREATES its own rows, attributed by the signed
  event's `merchant_id` → `workspaces.square_merchant_id`.
- **Shape:** an "Unmatched Square payments" tray on Finances with one-tap
  "Record as walk-in sale" through the existing seam (`processor='square'`,
  `processor_ref`, `square_payment_id`) + an optional auto-record setting
  that ships ONLY with the real path (no-fake-controls). Merchant-side
  refunds of walk-ins follow the isolated `square_refunds` pattern.
- **Stripe Terminal:** `payment_intent.succeeded` with
  `payment_method_details.card_present` — currently not even logged
  (our Stripe webhook handles `checkout.session.completed` only).
  Sequenced after Square ships; shares the tray + seam.
- **Seven rulings at the bottom.** The selling sentence "your counter
  taps show up in your books automatically" is claimable only when
  auto-record ships and passes a live test; until then the honest
  sentence is "…with one tap."

---

## 1. Does the webhook receive in-person / Terminal payments?

### 1.1 Mechanism (confirmed in code)
- Our route handles `payment.created` and `payment.updated`
  ([server.js:3075](../server.js#L3075)) and settles only on
  `payment.status === 'COMPLETED'`. Square delivers these for **every
  payment on the merchant** the webhook subscription is attached to —
  there is no per-application filter on payment webhooks. Jay's premise
  ("we receive all merchant payments") matches the model.
- Attribution today is indirect: the route passes `payment.order_id` and
  the ledger finds OUR pending row by `processor_ref = order_id`
  ([payment-ledger.js:323-329](../lib/payment-ledger.js)); the merchant
  check compares `event.merchant_id` to that row's workspace
  (`w.square_merchant_id`). A walk-in has no pending row, so attribution
  must flip to **merchant-first**: `event.merchant_id` →
  `workspaces.square_merchant_id` (one merchant ↔ one workspace;
  column confirmed on `workspaces`).

### 1.2 Payload fields that distinguish a counter tap from our link payments
From the Square `Payment` object (what `payment.updated` carries):

| Field | Counter tap (POS / reader) | Terminal API | Our payment links (Checkout) |
|---|---|---|---|
| `application_details.square_product` | `SQUARE_POS` | `TERMINAL_API` | `ECOMMERCE_API` |
| `application_details.application_id` | Square's own POS | the Terminal app | **OUR app id** |
| `card_details.entry_method` | `CONTACTLESS` / `EMV` / `SWIPED` | same (card-present) | `KEYED` (typed online) / `ON_FILE` |
| `device_details` (`device_id`, `device_name`) | present | present | absent |
| `source_type` | `CARD` (or `CASH` if rung as cash) | `CARD` | `CARD` |
| `order_id` | **present** (POS creates an order per sale) | present | present — and it's in OUR `processor_ref` |
| `location_id` | merchant location | merchant location | the location we passed to `quick_pay` |

So: **"unmatched" = `order_id` not in `transaction_payments.processor_ref`
(or no `order_id` at all)**, and the *kind* of unmatched payment is read
from `square_product` + `entry_method`. Display fields for the tray:
`amount_money`, `tip_money`, `total_money`, `created_at`,
`card_details.card.card_brand` + `card_details.card.last_4`,
`receipt_number`, `receipt_url`, `note`, `customer_id` (rarely set for
walk-ins).

One guard falls straight out of this table: a payment whose
`application_id` is OURS but whose order isn't in our ledger should
**never** be recorded as a walk-in — that's a forged or malformed event
and belongs in the loud-refusal bucket, not the tray.

### 1.3 Sandbox test — feasible, but not from this machine
Three ways to produce an "unmatched merchant payment" in the sandbox:
1. **Sandbox Dashboard → Virtual Terminal** (Jay, ~1 minute): take a keyed
   card sale on the ws17 sandbox merchant. Emits `payment.updated` with
   `square_product: VIRTUAL_TERMINAL`, no order of ours → hits our drop
   path exactly like a counter tap does. **Recommended first step.**
2. **Terminal API with the sandbox test device** — Square's sandbox
   exposes a simulated Terminal device (amount-driven outcomes) for
   `TerminalCheckout` flows; closest to a real reader tap
   (`square_product: TERMINAL_API`, `entry_method` card-present).
3. **Payments API `CreatePayment`** with the sandbox nonce
   `cnon:card-nonce-ok` and NO `order_id` → the `no_order_id` branch.

I could not run (2)/(3) from here: the merchant token is stored
encrypted with Render's `TOKEN_ENCRYPTION_KEY`, which this machine
doesn't have ([[square-oauth-sandbox-deferred]]). (1) needs no token.
**Proposed proof step (R5):** one tiny pre-build commit that logs the
discriminator fields for every refused payment; Jay runs one Virtual
Terminal sale; the log line becomes the documented real payload.

---

## 2. Where unmatched payments die today — and what the check becomes

### 2.1 The drop, exactly
1. [server.js:3075-3084](../server.js#L3075): COMPLETED `payment.*` →
   `processSquarePaymentCompleted({ orderId, merchantId, amountCents,
   currency, paymentId })`.
2. [payment-ledger.js:320](../lib/payment-ledger.js#L320):
   `if (!orderId) return { ok:false, reason:'no_order_id' }`.
3. [payment-ledger.js:330](../lib/payment-ledger.js#L330): no
   `transaction_payments` row with `processor='square' AND processor_ref =
   orderId` → `{ ok:false, reason:'no_ledger_row' }`.
4. [server.js:3082-3084](../server.js#L3082): the route responds 200.
   **CORRECTION (2026-08-23, exact-line read):** the refusal log fired
   ONLY for `*_mismatch` reasons — `no_order_id` and `no_ledger_row`
   (i.e. every counter tap) were **completely silent**. No row, no
   table, not even a log line. SQW1 replaces this with a structured
   discriminator log for EVERY refused COMPLETED payment (pinned SW8).

### 2.1b THE REAL PAYLOAD (evidence gate passed 2026-08-23 17:06 UTC)
Jay's sandbox Virtual Terminal sale ($12.34, keyed Mastercard 5105…5100,
no note, no customer) landed in the tray as row 2 — **lane 2 recorded it
end to end.** Verbatim discriminators:
- `refusal_reason: no_ledger_row` — a VT sale **does** carry an
  `order_id` (`mRXPQxo2ghy6cLBkNLA3pVoSdd4F`); "unmatched" = not ours.
- `square_product: VIRTUAL_TERMINAL`, `entry_method: KEYED`,
  `source_type: CARD`, merchant `MLGP6ZBSG119Q`, location `LZE0M794KWKKC`.
- **Populated:** `card_brand MASTERCARD`, `last_4 5100`, `receipt_number
  VIN5` (first 4 of the payment id), `receipt_url`, `card_type CREDIT`,
  `team_member_id`/`employee_id` (who took it), `risk_evaluation`,
  `statement_description`. **Absent:** `device_details` (dashboard sale
  → `device_name` null), `tip_money` (→ 0), `note`, `customer_id`.
- **Guard refinement (real-payload finding):** `application_details.
  application_id` was `sandbox-sq0idb-…` — an app-format id on a
  dashboard sale (the sandbox test account is owned by our app). The
  forgery guard passed only because Render's `SQUARE_APP_ID` differs.
  Refined in SQW3: forgery = our app id **AND** `square_product ===
  'ECOMMERCE_API'` (our Checkout path). A POS / Terminal / VT sale
  stamped with our app id is legitimate.
- The earlier "two silent sales" were never fired (Charge not pressed)
  — no defect; the evidence gate held honestly.

### 2.1c ANNOUNCE-FIRST — `square_webhook_events` (pre-approved on principle; SQW3's first change)
Every Square webhook delivery leaves a row, so "did it arrive?" is a DB
query, never a Render-log ask: `id`, `square_event_id` (UNIQUE —
redelivery increments `attempts`), `event_type`, `merchant_id`,
`object_id` (payment/refund id), `outcome` (`completed` | `refused` |
`tray_recorded` | `tray_duplicate` | `refund_settled` | `ignored_type`
| `ignored_status` | `bad_signature` | `error`), `reason`, `http_status`,
`received_at`, `attempts`. No raw body (the tray keeps the payment
object; refunds keep theirs); bad-signature rows carry no event id.

### 2.1a RULINGS RECORD (2026-08-23)
- **Catch side R1–R7: proceed** (Jay: "then SQW2–5"). R2's table is
  announced in §3.5 and will be created in SQW2.
- **Launch side R8–R11: APPROVED.** R9 note format = `Ref <id> · <business>`
  (customer-receipt-grade). **R10 re-ruled:** the device test is NOT
  sequenced behind SQ6 — when SQW6 is built, Jay creates a free real
  Square merchant ("MM Test Counter") with the POS app, runs one real
  ~$1 tap, immediately refunded via the SQ5 machinery; that proves deep
  link + callback + note round-trip + auto-match, and VERIFIES the
  `transaction_id ≡ v2 order id` claim (if confirmed → `processor_ref`
  directly). Enabling the POS API + registering the callback URL on our
  Square app is part of SQW6.
- **R11 claims ladder, pinned with a census row per rung:**
  "with one tap" (post-SQW3) → "automatically" (post auto-record live
  test) → "charge in person from the app" (post device test).
- **Order of work:** SQW1 proof log → Jay's sandbox Virtual Terminal
  sale (the evidence gate) → SQW2–5 → launch side SQW6–7 → SQW8 optional.
- **PROGRESS:** SQW1 `89ca382` ✓ · evidence gate ✓ (§2.1b) · SQW2
  `5fe5daf` ✓ (tray table + lane 2) · **SQW3 `fea40ca` ✓** (delivery
  log `square_webhook_events` (079) + Counter payments tray + one-tap
  record through the seam + dismiss; forgery guard refined; LC11 claims
  ladder pinned, no rung earned yet). **Live test of SQW3 pending:**
  Jay records tray row 2 ($12.34) from Finances → expected: a paid
  `walk_in` transaction + a completed `square` payment row, tray row
  `recorded`/`one_tap`, the sale visible in Ledger/TR/CSV. That test
  earns rung 1 ("with one tap").
- **SQW3 LIVE TEST PASSED (2026-08-23, Jay):** tray row 2 → **walk_in
  transaction #8** (paid, 1234¢ in full, "Walk-in / Card sale (Square)")
  + **payment row #5** (`processor='square'`, `processor_ref` = the
  Square order id, `square_payment_id` kept, completed) + tray row
  `recorded/one_tap`; Money In reflects it ($57.34); the real-only
  transaction-report composer (shared by the report and CSV export)
  includes #8. **RUNG 1 EARNED — "Square counter taps show up in your
  books with one tap" is live on the landing; LC11 is now a real ladder
  (earned verbatim / unearned absent).**
- **SQW4 `360b8d4` ✓** — merchant-side refunds: `no_refund_row` →
  correlate by `payment_id` → a recorded walk-in gets a `square_refunds`
  row (`initiated_by='square'`, migration 080, capped at what remains)
  and the EXISTING core settles it; an unrecorded tray row is marked
  `refunded`; unknown payments untouched.
- **SQW4 LIVE TEST PASSED (2026-08-23, refund via API Explorer — the
  sandbox seller dashboard exposes no refund UI, so the Refunds API is
  the real merchant-side scenario anyway).** Chain verbatim:
  `square_refunds` row 2 — `initiated_by='square'`, 1234¢, `completed`,
  `transaction_id=8`, `refund_child_transaction_id=9`,
  `created_by_user_id` NULL; **child #9** source `refund`, total −1234¢,
  parent 8; **parent #8** → `refunded`, `amount_refunded_cents=1234`
  (ratcheted once); **isolation intact** — `transaction_payments` for
  #8/#9 is still only the one completed payment row #5, zero refund rows.
  Two findings worth keeping:
  1. **Idempotency held under a genuine double-delivery.** Square sent
     `refund.updated` COMPLETED **twice** (delivery-log rows 3 & 4, both
     `refund_settled`, distinct event ids so not a dedup — two real
     events) — yet exactly ONE child (#9) and ONE ratchet. The SQ5
     FOR-UPDATE core absorbed the second as a no-op.
  2. **Recording an order CLAIMS it.** Refunding also re-emitted
     `payment.updated` for the original payment (log row 2, outcome
     `completed`) — because payment row #5 now carries
     `processor_ref = order id`, it matched LANE 1 (idempotent no-op),
     so it did NOT re-appear in the tray. A recorded walk-in can never
     double-tray.
- **The "1:06pm duplicate" did not happen.** The tray holds exactly ONE
  row (id 2, the recorded #8); there is no tray row 3 and no second
  payment in the delivery log. Like the earlier "silent sales," the
  accidental second charge was never actually fired. (Also: the 1:06pm
  sale predates the SQW3 delivery-log deploy ~17:15Z, so it correctly
  has no log row — the log's first-ever rows are these refund events.)
- **CATCH SIDE COMPLETE (SQW1–4 shipped + live-tested).**
- **SQW5 `c3aa2e9` ✓ (ruling R3, no fake control):** migration 081
  `square_auto_record_walkins DEFAULT FALSE`; the record core extracted
  to `lib/square-walkins.recordTrayRowAsSale` — ONE implementation
  shared by the one-tap endpoint (adapter, no SQL of its own) and lane
  2's auto path (`via='auto'`, attributed to the owner; failure leaves
  the row one-tappable, logs `auto_failed`; delivery-log reason carries
  `auto:sale#N`). Toggle lives on the "How you get paid" card
  (discoverable with an empty tray), never pre-checked, reflects stored
  truth, resyncs on failure; tray marks auto rows "(auto)". Pins SW12
  (shared core + both call sites), SW13 (default-off at every layer);
  SW10/SR11 no-books invariants rescoped to recorder/correlator.
  **LIVE TEST PENDING (earns rung 2 "automatically"):** Jay flips the
  toggle ON in How you get paid, fires one Virtual Terminal sale →
  expected: tray row `recorded/auto` with NO tap, an ordinary paid
  walk_in transaction + completed square payment row, delivery-log
  `tray_recorded` with `auto:sale#N`, Money In reflects it. Then LC11
  rung 2 flips in the same commit as this test's record. Then launch
  side SQW6–7.

### 2.2 What must NOT change
The three-way check for link payments — signed event's merchant ==
workspace merchant, amount == pending amount, currency == USD — plus the
`pending → completed` ratchet under `FOR UPDATE`
(`completePendingPayment`). Property: **a foreign event can never
complete one of our rows.** The walk-in lane keeps this by never
reading or writing pending rows at all.

### 2.3 The check becomes two lanes at the webhook
```
COMPLETED payment event
  ├─ lane 1 (unchanged): processor_ref match → three-way verify → complete pending row
  └─ lane 2 (new): no_order_id | no_ledger_row
        → attribute: event.merchant_id = workspaces.square_merchant_id
          (exactly ONE connected workspace; 0 or >1 → log + drop, as today)
        → guards: status COMPLETED; amount > 0; currency USD;
                  application_id is NOT ours (ours-but-unmatched = loud refusal)
        → record into square_unmatched_payments (idempotent on square_payment_id)
          with amount/tip/total, created_at, brand/last4, entry_method,
          square_product, device_name, receipt_number/url, note, raw order_id
        → NO transaction, NO revenue effect until recorded (or auto-record)
```
Lane 2 also closes the audit gap: every merchant payment we decline to
complete is now on record with its reason.

---

## 3. The honest shape

### 3.1 The tray — "Unmatched Square payments" (Finances)
Placement: its own card between **Overview** and **Ledger**
([app.html ~3416](../views/app.html)), rendered only when rows exist
(or auto-record is on, so the owner can see what it did). Columns:
time · amount (+tip shown separately) · card brand/last4 · how it was
taken (Tap / Chip / Swipe / Keyed / Cash, from `entry_method` /
`source_type`) · Square receipt link.

Actions per row:
- **Record as walk-in sale** (one tap): creates a `transactions` row —
  `source='walk_in'` (already a CHECK-valid source), `status='paid'`,
  `payment_method='card'`, `total_cents` = total, `tip_cents` = tip,
  `customer_display_name` = optional pick (contact) or "Walk-in",
  `line_items` = optional service label (menu item) or "Card sale
  (Square)" — plus a `transaction_payments` row `processor='square'`,
  `processor_ref` = the Square order_id (or the payment id when none),
  `square_payment_id`, `status='completed'`, `payment_method='square'`.
  **The same seam every link payment lands through** — finances-summary,
  the transaction report, CSV export, and refunds all see it as an
  ordinary paid transaction. The tray row flips to `recorded` with the
  `transaction_id`.
- **Ignore** (personal / test / duplicate): tray row → `dismissed` with
  the reason. Never deleted — the audit trail is the point.
- Optional labeling at record time: customer (contact picker) and
  service (menu item); both editable afterward on the transaction like
  any other.

### 3.2 Auto-record (optional setting) — only if it really works
My Business → "How you get paid": **"Record Square counter payments
automatically as walk-in sales"** — default OFF. When ON, lane 2
performs the record step at webhook time (customer "Walk-in", line
"Card sale (Square)"), and the tray shows the result as *recorded
automatically* with an edit affordance. No-fake-controls: the toggle
ships in the SAME commit as the wired auto path and a pin that proves
it, or it doesn't ship.

### 3.3 Refund correlation (merchant-side refunds of walk-ins)
Today SQ5 settles only refunds WE initiated (a `square_refunds` row
pre-exists; an unknown refund id is refused). A barber refunding a
walk-in inside the Square app emits `refund.updated` COMPLETED with
`payment_id`. New behavior, same isolation:
- `payment_id` matches a **recorded** walk-in's `square_payment_id` →
  insert a `square_refunds` row (`initiated_by='square'`, new column),
  three-way verify (merchant match, amount ≤ original, USD), create the
  record-only refund CHILD transaction + ratchet the parent ONCE — the
  G2 rule (claim "refunded" only on COMPLETED) and the "never a
  transaction_payments row for a refund" rule both hold.
- `payment_id` matches an **unrecorded** tray row → mark the tray row
  `refunded` (it can never be recorded as income; it's shown struck
  through). No transaction is created for money that never entered the
  books.
- Idempotency: `square_refund_id` is already unique; tray rows unique on
  `square_payment_id`.

### 3.4 One-ledger law, restated for this lane
Recorded walk-ins are ordinary transactions + completed payments. No
parallel "counter sales" ledger, no second revenue sum. The tray table
holds only the *unrecorded* state (like `square_refunds` holds only
refund money-state) and is never summed into revenue.

### 3.5 New table — announce-first
`square_unmatched_payments`: id, workspace_id, square_payment_id
(UNIQUE), square_order_id, merchant_id, amount_cents, tip_cents,
total_cents, currency, card_brand, last_4, entry_method, square_product,
device_name, receipt_number, receipt_url, note, paid_at, status
(`unrecorded` | `recorded` | `dismissed` | `refunded`), dismiss_reason,
transaction_id, recorded_by_user_id, created_at, updated_at.
**Announced here; created only on R2's approval.**

---

## 4. Stripe Terminal — scope only
- Stripe Terminal sales are PaymentIntents with `payment_method_types:
  ['card_present']`; the webhook events are `payment_intent.succeeded` /
  `charge.succeeded` carrying `payment_method_details.card_present`
  (brand, last4, reader info). Our Stripe webhook handles
  **only** `checkout.session.completed`
  ([server.js:2855](../server.js#L2855)) — a Terminal sale today is an
  unhandled event type: not refused, not logged, simply ignored.
- Equivalent lane: subscribe to `payment_intent.succeeded`, take only
  `card_present`, attribute by the workspace's Stripe connection, write
  the SAME tray (add a `processor` column: 'square' | 'stripe') and
  record through the SAME seam with `processor='stripe'`,
  `processor_ref` = the PaymentIntent id. Refunds: `charge.refunded` →
  the Stripe refund gap ([[stripe-refund-gap]]) must close first.
- **Sequenced after Square ships** (R7); the tray is built
  processor-agnostic from day one so Stripe is a lane, not a rebuild.

---

## 5. Rulings for Jay (before any build)

| # | Ruling | Recommendation |
|---|---|---|
| R1 | Tray name + placement: "Unmatched Square payments" between Overview and Ledger, shown only when non-empty (or auto-record on)? | Yes; name it **"Counter payments"** in the owner's UI (what it is to them), "unmatched" in code |
| R2 | **Announce-first:** approve the new isolated table `square_unmatched_payments` (§3.5)? | Approve — same isolation philosophy as `square_refunds` |
| R3 | Auto-record: default OFF; ships only with the wired path + pin; toggle copy per §3.2? | Approve |
| R4 | Merchant-side refunds of walk-ins: extend SQ5's isolated pattern with `initiated_by='square'` + the child-transaction artifact (§3.3)? | Approve — the G2 + no-refund-in-payments rules hold unchanged |
| R5 | **Proof step before build:** one tiny commit logging discriminator fields for refused payments; Jay runs a sandbox **Virtual Terminal** sale on ws17; the real payload becomes the spec? | Yes — costs one line of code and one minute of Jay |
| R6 | **Claims census:** "your counter taps show up in your books automatically" is claimable only after auto-record ships and passes a live test; until then the selling sentence is "…show up in your books with one tap." | Agree — the demo sentence follows the toggle, not the tray |
| R7 | Stripe Terminal sequenced after Square; tray built processor-agnostic now? | Yes |

**Build sequence on approval:** SQW1 discriminator log (R5) → Jay's
Virtual Terminal sale → SQW2 migration + lane 2 recorder (idempotent,
guarded) → SQW3 tray + one-tap record + ignore (through the seam) →
SQW4 merchant-side refund correlation → SQW5 auto-record toggle (wired
+ pinned, same commit) → suite rows per rule → live test on ws17's
sandbox (tap → tray → record → appears in Finances/TR/CSV → Square-side
refund → child transaction).

---

## 6. The LAUNCH side — "Charge in person" from inside Modern Management

(Investigation addition, 2026-08-23. Sequenced AFTER SQW1–5: the catch
side must exist before a launched charge has anywhere to land. Facts are
from Square's Point of Sale API reference; two items are flagged VERIFY
because only a real device settles them.)

### 6.1 Square Point of Sale API deep links (mobile web → Square POS app)

Square's Point of Sale API has a **web flavor** for both platforms: a
page in the merchant's mobile browser opens the installed Square POS app
with the charge pre-filled, the merchant taps the reader, and POS
redirects back to our URL.

**iOS — custom URL scheme.** `square-commerce-v1://payment/create?data=<URL-encoded JSON>`:

```
{ "amount_money": { "amount": "4500", "currency_code": "USD" },
  "callback_url": "https://modernmanagementapp.com/api/square/pos-return",
  "client_id": "<our Square application id>",
  "version": "1.3",
  "notes": "Ref 123 · Skin fade · Northside Barbers",
  "state": "<opaque string we mint — a signed, short-lived tx token>",
  "options": { "supported_tender_types": ["CREDIT_CARD","CASH","OTHER","SQUARE_GIFT_CARD","CARD_ON_FILE"],
               "auto_return": true, "clear_default_fees": true } }
```

Return: POS opens `callback_url?data=<URL-encoded JSON>` →
`{ "status":"ok", "transaction_id":"…", "client_transaction_id":"…", "state":"<echoed>" }`
or `{ "status":"error", "error_code":"…", "state":"<echoed>" }` (codes
include `not_logged_in`, `payment_canceled`, `amount_invalid_format`,
`unsupported_tender_type`, `invalid_client_id`).

**Android — intent URL (from the browser):**

```
intent://#Intent;action=com.squareup.pos.action.CHARGE;package=com.squareup;
  S.com.squareup.pos.WEB_CALLBACK_URI=https://modernmanagementapp.com/api/square/pos-return;
  S.com.squareup.pos.CLIENT_ID=<app id>;S.com.squareup.pos.API_VERSION=v2.0;
  i.com.squareup.pos.TOTAL_AMOUNT=4500;S.com.squareup.pos.CURRENCY_CODE=USD;
  S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD,com.squareup.pos.TENDER_CASH;
  S.com.squareup.pos.NOTE=Ref 123;S.com.squareup.pos.REQUEST_METADATA=<opaque>;
  S.browser_fallback_url=https://modernmanagementapp.com/get-square-pos;end
```

Return: `WEB_CALLBACK_URI` with query params
`com.squareup.pos.CLIENT_TRANSACTION_ID`, `com.squareup.pos.SERVER_TRANSACTION_ID`,
`com.squareup.pos.REQUEST_METADATA` — or `com.squareup.pos.ERROR_CODE` +
`ERROR_DESCRIPTION`.

**What we can pre-fill (both):** amount (integer cents) + currency,
allowed tender types, a **note** (printed on the receipt AND set on the
resulting Payment object), an **opaque state/metadata string** (round-
trips to OUR callback only), optional `location_id` / `customer_id`. We
cannot attach our own order id — POS creates its own order; the link is
made through the note and the returned transaction id (§6.2).

**Not installed:**
- Android: `S.browser_fallback_url` falls through automatically to a URL
  we choose (Play Store listing or our "Get Square POS" page). Clean.
- iOS: a custom scheme with no handler just fails in Safari ("cannot
  open the page") — no automatic fallback exists. Standard pattern:
  navigate, and if our page is still visible ~1.5s later, show the App
  Store link + "Install Square POS, then tap Charge again." Honest,
  well-trodden, slightly clunky; nothing better exists on iOS.
- Either platform: POS must be **logged into the merchant account**
  (`not_logged_in` otherwise). The charge screen opens with the amount
  pre-filled; the merchant taps the reader exactly as today.

**Developer prerequisites:** enable the Point of Sale API on our Square
application (Developer Dashboard) and register the web callback URL(s).
Same application as our OAuth app → same `client_id`.

**⚠️ VERIFY (device proof step): sandbox support.** The Point of Sale
API drives the real Square POS app logged into a real merchant; sandbox
merchants cannot log into the production POS app. Expect the launch
side's live test to require **production Square** — sequencing it
behind the SQ6 production cutover, or a real test merchant. A real
constraint, not a footnote.

### 6.2 The match — honest "automatically," with real provenance

Two identifiers survive the round trip, on two different paths:

1. **The note → the webhook (server-side; the one that matters).** The
   `notes`/`NOTE` we pre-fill lands on the resulting Payment object's
   `note` field, which rides inside `payment.updated`. Lane 2 (§2.3)
   parses `Ref <id>` from `payment.note`, verifies the event's merchant
   owns transaction `<id>` AND the amount matches that transaction's
   balance, then records it **against the originating transaction**
   (`transaction_payments`: `processor='square'`, `processor_ref` = the
   Square order id, `square_payment_id`, `status='completed'`) — the
   same seam, now with provenance. This is the honest sense of
   "automatically": the system knows what it's recording. Guards: a
   note naming a transaction the merchant doesn't own, or an amount that
   doesn't match, is NOT recorded against it — it falls into the
   unmatched tray like any other tap, mismatch logged. Notes are
   merchant-editable in POS before tapping; the amount check is what
   stops a stray edit from mis-attributing money.
2. **The returned transaction id → our callback (client-side; the
   belt).** `/api/square/pos-return` receives `transaction_id` (iOS) /
   `SERVER_TRANSACTION_ID` (Android) plus our echoed `state` /
   `REQUEST_METADATA` — minted by us as a signed, short-lived token
   naming the transaction, never a raw id. We store
   `square_pos_transaction_id` on the transaction immediately, so if the
   note was edited or stripped, the Square id still matches.
   **⚠️ VERIFY:** the POS API's returned `transaction_id` is documented
   as equivalent to the v2 **order id** — if so it equals
   `payment.order_id` and becomes `processor_ref` directly. The device
   proof step confirms this.

Both paths converge on one rule: **record against the originating
transaction only when merchant + amount + identifier all agree;
otherwise it is a tray row.** The §2 three-way posture carries over
unchanged.

### 6.3 The desktop truth — no deep link exists

A desktop browser cannot open the POS app. No fake tap UI, ever. Honest
desktop behavior for "Charge in person" on a transaction:
- Show the amount large and the line: **"Take it on your reader in the
  Square app. It'll show up under Counter payments in a moment — record
  it with one tap."** If the merchant types the shown `Ref <id>` into
  the POS note before tapping, lane 2's note match (§6.2) records it
  against this sale automatically — the card says so, reference shown
  copy-ready.
- **Square Terminal hardware (not the Reader) has a real server-driven
  desktop path:** the Terminal API (`CreateTerminalCheckout` with
  `reference_id` + `note`) pushes the amount to the device, the device
  prompts the customer, and the resulting payment matches through the
  checkout → order → `payment.order_id`. Its own small unit for Terminal
  owners after the Reader path ships — same tray, same seam.
- Mobile-web detection decides which UI renders: iOS/Android browser →
  the deep-link button; everything else → the honest desktop card.

### 6.4 Stripe Terminal reality check — why Square-first

Stripe has **no consumer-app deep link**. Stripe Terminal is
server-driven: smart readers (WisePOS E, S700) are driven via
`POST /v1/terminal/readers/{id}/process_payment_intent`; Tap to Pay and
the Reader M2 require Stripe's Terminal SDK inside a **native app of our
own**. There is no Stripe "POS app" to hand a charge to, and the Stripe
Dashboard mobile app exposes no documented launch API. So a Stripe
"Charge in person" is either (a) a server-driven Terminal-hardware flow
(the analogue of §6.3's Terminal path) or (b) a native Modern Management
app — neither is a web deep link. Square-first because the merchant's
own Square app + reader is the installed base and needs no native app
from us; Stripe's catch side (§4) comes first, its launch side only with
Terminal hardware or a native app.

### 6.5 Sequencing + rulings (launch side)

After SQW1–5 ship and the catch side is live-tested:
- **SQW6** — "Charge in person" on the transaction screen: mobile-web
  deep link (iOS scheme + Android intent with fallback), signed state
  token, `/api/square/pos-return` storing the returned id, the honest
  desktop card; Point of Sale API enabled on our Square app.
- **SQW7** — lane-2 note/id match → record against the originating
  transaction (guards per §6.2); tray provenance label "from Charge in
  person."
- **SQW8** — Terminal API desktop path (Terminal hardware owners).

| # | Ruling | Recommendation |
|---|---|---|
| R8 | Build the launch side as SQW6–7 after SQW1–5, SQW8 optional? | Yes |
| R9 | The note is printed on the customer's Square receipt — `Ref <id> · <business>` (friendly) vs `MM-TX-<id>` (terse)? | `Ref <id> · <business>`; the parser accepts both |
| R10 | Launch-side live test needs production Square (the POS app can't log into a sandbox merchant) — sequence behind SQ6, or test earlier on a real merchant? | Behind SQ6 unless a real test merchant exists |
| R11 | Census: "Charge in person from the app" is claimable only after the device test; until then the claim stays at the catch side ("with one tap"). | Agree |
