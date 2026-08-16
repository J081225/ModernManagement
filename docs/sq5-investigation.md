# SQ5 investigation — Square refunds (look-first)

Read-only. The current "Issue refund" wiring, the gaps for a real
money-moving Square refund, and the ruling-aligned build plan.

## 1. Current refund wiring — RECORD-ONLY (G2 honesty)

Two paths, both record-only, both create a linked **negative refund
transaction** (`source='refund'`, `parent_transaction_id`) and ratchet
the parent (`amount_refunded_cents += amt`; `status → 'refunded'` when
fully refunded, else stays paid/partially_paid). **Neither moves money.**

- **Owner endpoint** `POST /api/transactions/:id/refund`
  ([server.js:10016](../server.js#L10016)): `requireAuth`, validates
  paid/partially_paid + amount ≤ remaining, writes the refund child +
  parent ratchet. **No re-auth, no processor API call.**
- **Assistant tool** `refund_transaction`
  ([lib/tools/refund_transaction.js](../lib/tools/refund_transaction.js)):
  `requiresApproval:true`, customer-blocked (`ctx.origin.channel ===
  'ai_inbound'` → refused), same record-only writes. Message is honest:
  *"No money moved — … process the refund in the Stripe dashboard."*
- **UI:** the transaction-detail "Issue refund" button →
  `openRefundModal` → `submitRefund` → the endpoint.

So the honest record + the state ratchet already exist. SQ5 adds the
real Square money movement on top, per processor.

## 2. Gaps for a real Square refund

- **`transaction_payments`** columns: `processor`, `processor_ref`
  (=order_id), `status` (pending/completed/failed), `payment_type`
  (**deposit/payment only — no `refund`**), `amount_cents`, … There is
  **no captured Square `payment_id`.**
- **Completion** (`processSquarePaymentCompleted` →
  `completePendingPayment`) matches on `order_id`; it does **not** store
  `payment.id` from the webhook.
- **Square `RefundPayment` (`POST /v2/refunds`) needs the `payment_id`**,
  which we don't have. → SQ5 must obtain it.
- **Square webhook** ([server.js:2910](../server.js#L2910)) verifies
  signature + three-way (merchant/amount/currency) but handles only
  `payment.updated`/`created`.

## 3. Build plan (per the standing SQ5 rulings)

1. **Migration 070:** widen `transaction_payments.payment_type` CHECK to
   include `'refund'`; add `square_payment_id TEXT` (the payment a refund
   targets / captured at completion).
2. **Capture `payment_id`:** thread `payment.id` through the webhook →
   `processSquarePaymentCompleted` → `completePendingPayment`, stored on
   the completed row. **Backfill note:** #6 was paid BEFORE this change,
   so its row has no `square_payment_id`; the refund path fetches it from
   Square by `order_id` as a fallback when the column is null.
3. **`lib/square-refunds.js`:** `refundSquarePayment({ accessToken,
   paymentId, amountCents, idempotencyKey, reason })` → `POST /v2/refunds`
   `{ idempotency_key, payment_id, amount_money:{amount,currency:'USD'},
   reason }`; returns `{ refund_id, status }`. Verbatim error surfacing
   (the SQ4 lesson — no self-echo).
4. **`payment-ledger.processSquareRefundCompleted(pool, { refundId,
   merchantId, amountCents, currency })`:** the refund completion core,
   mirroring the payment core — three-way verify (merchant + amount +
   currency), find the pending refund ledger row by `(processor='square',
   processor_ref=refundId)` `FOR UPDATE`, mark `completed`, ratchet the
   parent (`amount_refunded_cents`, `status`; partial-refund honest).
   Idempotent (status guard — a completed row is a no-op).
5. **Endpoint becomes PROCESSOR-AWARE:**
   - **Square-paid:** require owner **re-auth** (`credentials._reauth`) —
     the structural money gate (same class as connect/switch/disconnect);
     resolve the `payment_id`; call `refundSquarePayment` with an
     idempotency key (`sqrf-{ws}-{txn}-{amount}`); write a refund
     **ledger row** (`processor='square'`, `processor_ref=refund_id`,
     `payment_type='refund'`, negative amount, `status` from Square) +
     the record child txn. **G2:** claim "refunded/moved" only after
     Square confirms (`COMPLETED`); otherwise "submitted to Square." The
     parent ratchet lands on the `refund.updated` webhook (or immediately
     if the API returns `COMPLETED`).
   - **Stripe / cash / other:** unchanged **record-only** + banner
     (Stripe real refunds stay deferred — see `stripe-refund-gap`).
6. **Structural owner-only (a law):** the money-moving refund lives ONLY
   on the re-auth-gated endpoint. The assistant `refund_transaction` tool
   **stays record-only** — no assistant path, no autonomy setting, can
   move refund money. (Same stance as `no-self-approve-law` /
   `square-refund-owner-approved`.)
7. **Webhook:** add `refund.created` / `refund.updated` → verify
   signature + merchant + amount → `processSquareRefundCompleted`.
   Idempotent against redelivery (SP4c pattern — the ledger status guard
   + unique `(processor, processor_ref)`).
8. **UI:** the Issue-Refund modal, for a **Square-paid** txn, collects
   the owner password (re-auth) with honest copy ("this moves money via
   Square, refunded to the customer's card"); for Stripe/cash it keeps
   the record-only banner.
9. **Suites (a row per rule):** refund lib payload/idempotency/error;
   ledger refund core (three-way + ratchet + idempotent); endpoint
   processor-aware + re-auth gate; webhook refund handling + signature/
   merchant checks; structural no-assistant-money-refund; partial-refund
   honesty; G2 per-processor truth (Stripe stays record-only).
10. **Live-test gate:** Jay refunds #6 in sandbox → Square `RefundPayment`
    → `refund.updated` COMPLETED → #6 `refunded`, honest record.

## 4. One design flag for the build

The refund of **#6** needs its Square `payment_id`, but #6 completed
before the capture change — so the endpoint must **fetch the payment_id
from Square by `order_id`** when `square_payment_id` is null (a
`ListPayments`/order lookup), then `RefundPayment`. New payments capture
it at completion; this fallback covers pre-existing paid rows like #6.

_Ready to build on this plan. No refund code written yet._
