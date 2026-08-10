# SQ1 Investigation — Square Payment Processing

Read-only. The Stripe flow is the template to mirror; Square is read
from its docs (sources at bottom, "confirm-in-sandbox" flags where the
docs were thin). Evidence is file:line.

## 1. Today's Stripe story, end to end (the template)

1. **Connect** — `POST /api/connect/onboarding/start` (server.js:2797)
   creates a Stripe **Express** connected account, stores
   `stripe_connect_account_id`, sets `connect_status='pending'`. The
   `account.updated` webhook + `syncAccountState` (connect-lifecycle.js)
   derive the status axis: `deriveConnectStatus` maps
   `charges_enabled → 'ready'`, `details_submitted-only → 'restricted'`,
   else `'pending'`; `'not_started'` is the column default. CHECK-
   constrained to those four.
2. **Payment request** — `createPaymentRequest` (payment-requests.js:55)
   calls `stripe.checkout.sessions.create` as a **direct charge on the
   connected account** (`{ stripeAccount: …connect_account_id }`, no
   platform fee — salon keeps 100%). Metadata carries
   `transaction_id / workspace_id / payment_type` for webhook routing.
   Returns `session.url`, SMS'd to the customer (SP4b's customerSmsFrom).
3. **Pending ledger row** — `paymentLedger.recordPayment` inserts a
   `transaction_payments` row: `payment_method='stripe'`,
   `stripe_checkout_session_id = session.id`, `status='pending'`. The
   unique partial index on that column (migration 042) is the webhook's
   idempotency anchor.
4. **Webhook records completion** — `checkout.session.completed`
   (server.js:2670) → `processCustomerPaymentCompletedEvent`
   (payment-ledger.js:180): looks up the pending row by
   `stripe_checkout_session_id` `FOR UPDATE`, flips `pending→completed`
   (idempotent — a redelivery no-ops), then `recomputeTransactionPaidStatus`
   rolls the sum onto `transactions.amount_paid_cents` and derives
   `status` (paid / partially_paid). A paid deposit also promotes the
   linked appointment.
5. **Receipts + ledger** — the rollup feeds receipts (receipts.js) and
   the Finances TR composer (`composeLedgerRows` reads
   `transaction_payments` where `status='completed'`). One source.

**Processor-specific surface (the whole list):**
- `transaction_payments.stripe_checkout_session_id` — the ONLY
  processor-named column.
- `payment_method` CHECK includes `'stripe'`, NOT `'square'`.
- `recordPayment`'s signature hard-codes `stripe_checkout_session_id`
  as a named param (payment-ledger.js:49,64).
- `processCustomerPaymentCompletedEvent` keys its idempotent lookup on
  that column (payment-ledger.js:192).
- `createPaymentRequest` is entirely Stripe (checkout.sessions).

Everything else — the transactions tables, the rollup, receipts, the
ledger — is processor-agnostic already.

## 2. Square's equivalents (from the docs)

| Stripe | Square | 1:1? |
|---|---|---|
| Express account we CREATE via onboarding | Seller's EXISTING account we **OAuth** into (scoped token) | **No** — different connect model (§3) |
| connect_status from charges_enabled/details_submitted | Merchant already onboarded with Square; "connected" ≈ valid token + can accept | **No** — simpler axis |
| checkout.sessions.create (direct charge) | `POST /v2/online-checkout/payment-links` (create_payment_link) → Square-hosted page, returns `{ order_id, url: square.link/u/… }` | **Close** — hosted link, same UX |
| metadata.transaction_id | order `reference_id` / payment link metadata **[confirm exact field in sandbox]** | Likely 1:1 |
| success_url / cancel_url | `checkout_options.redirect_url` (optional; else Square confirmation page) | 1:1 |
| checkout.session.completed webhook | `payment.updated` (status → COMPLETED); also payment.created | 1:1 in spirit |
| webhook signature (Stripe-Signature) | `x-square-signature` / signature key verification | 1:1 concept |
| Refunds API | Refunds API + `refund.created/updated` webhooks | 1:1 |
| test mode keys | **Sandbox** — full: OAuth, payment links, webhooks, test cards | 1:1, and see §5 |

**Key structural difference — connect:** Stripe, we *provision* an
Express account and watch charges_enabled flip. Square, the seller
*already has* a Square account (they run a register/POS); we OAuth for
a **scoped access token + refresh token + expiry** and store them
per-workspace. There is no "charges_enabled" ripening — a seller who
authorizes is generally ready. So Square's status axis is shorter:
`not_started → connected → (expired/revoked)`.

## 3. The per-workspace processor choice (recommended data model)

**One active processor per workspace** (recommended over per-request):
it matches how a real business runs — they use Square OR Stripe, not
both per transaction — and it keeps "cards ready?" a single boolean
question. Per-request choice multiplies UI, webhook routing, and
reconciliation surface for no real-world gain.

Proposed columns:
```
workspaces.payment_processor  TEXT NOT NULL DEFAULT 'stripe'
                              CHECK (payment_processor IN ('stripe','square'))
-- Square OAuth (mirror of the stripe_connect_* set)
workspaces.square_merchant_id       TEXT
workspaces.square_access_token       TEXT   -- ENCRYPTED at rest (see §5 ruling)
workspaces.square_refresh_token      TEXT   -- ENCRYPTED
workspaces.square_token_expires_at   TIMESTAMPTZ
workspaces.square_status             TEXT NOT NULL DEFAULT 'not_started'
                              CHECK (square_status IN ('not_started','connected','expired','revoked'))
```

**The SP3-style status axis extends to a per-capability derivation.**
Today "cards ready" = `connect_status='ready'`. With two processors it
becomes a function of the ACTIVE one:
```
cardsReady(ws) =
  ws.payment_processor === 'square'
    ? ws.square_status === 'connected'
    : ws.connect_status === 'ready'
```
This is the exact SP3 pattern (a derived per-capability view over a
raw status column) — one helper, `workspace-readiness.cardsReady()`,
so no surface hand-rolls the two-processor logic. The honest UI reads
that helper, never a raw column.

## 4. One-ledger law — where Square enters the SAME tables

Square payments enter through the **identical** path: `recordPayment`
→ `transaction_payments` → `recomputeTransactionPaidStatus` →
`transactions` rollup → receipts + TR composer. The ledger is already
processor-agnostic; only these Stripe assumptions need generalizing:

1. **The reference column.** `stripe_checkout_session_id` is Stripe-
   named. Two options: (a) add a parallel `square_order_id` +
   `square_payment_id`, or (b) generalize to `processor TEXT` +
   `processor_ref TEXT` with a unique index on `(processor,
   processor_ref)`. **Recommend (b)** — it's the honest shape (one
   idempotency anchor for any processor) and stops a third processor
   from needing a third column. Migration backfills existing rows to
   `processor='stripe', processor_ref=stripe_checkout_session_id`.
2. **`payment_method` CHECK** must add `'square'`.
3. **`recordPayment`** takes a generic `{ processor, processor_ref }`
   instead of a Stripe-named param (keep a back-compat shim during
   migration).
4. **The webhook handler** — a Square sibling to
   `processCustomerPaymentCompletedEvent` that looks up the pending row
   by `(processor='square', processor_ref=square_payment_id)` and runs
   the SAME recompute. The rollup/receipt/ledger half is shared
   verbatim.

Nothing in the rollup, receipts, or TR composer assumes Stripe — the
one-composer money law (RV2/TR) already reads `transaction_payments`
by status alone, so Square money lands in the ledger and reports with
zero new query stack.

## 5. Sandbox-now vs Stripe-live-first — sequencing

**Square sandbox is COMPLETE**: OAuth, payment links, webhooks, and
test cards all work in sandbox without touching Square production.
This is the sequencing headline — unlike the Stripe path (whose live
charges needed real Connect onboarding), **the entire SQ flow can be
built AND tested end-to-end in Square sandbox now**, in parallel with
everything else, gated only by the standing live-test rule at the end.

Proposed checkpoint split:
- **SQ2 — the generic ledger seam** (no Square yet): migrate
  `transaction_payments` to `processor` + `processor_ref` (backfill
  Stripe), widen the `payment_method` CHECK, generalize `recordPayment`
  with a back-compat shim, re-point the Stripe webhook lookup. Pure
  refactor under the existing Stripe tests — proves the seam before
  Square exists.
- **SQ3 — Square connect**: OAuth flow, the square_* columns, the
  `square_status` axis, `cardsReady()` helper, the processor-choice
  setting. Sandbox OAuth.
- **SQ4 — Square payment request + webhook**: create_payment_link, the
  pending row via the generic recordPayment, the `payment.updated`
  handler with signature verification, sandbox end-to-end (test card →
  completed → rollup → receipt → TR).
- **SQ5 — refunds parity**: Square refund API behind the SAME G2
  honesty rule — recording a refund is not moving money unless the
  processor call succeeds; a Square refund actually CAN move money
  (unlike the deferred workspace-Stripe refund), so this is where the
  refund honesty finally has a real money-moving path for one
  processor. Worth its own careful checkpoint.
- **SQ6 — the live-test gate**: sandbox proves everything; a real
  Square account connect + $1 live charge is the only step needing
  production, sequenced last.

## Rulings for Jay
1. **Processor choice UX**: one active processor per workspace
   [recommended] — where does the choice live (Settings, beside the
   Stripe card-payments card)? A radio, or auto-set by whichever the
   owner connects first?
2. **If a business connects both**: forbid (one active, switching
   disconnects the other), or allow both connected with one marked
   active? Recommend one-active, switchable.
3. **Token encryption**: the Square access/refresh tokens are bearer
   credentials to a merchant's account — they MUST be encrypted at rest
   (the Stripe path never stored a secret like this). Confirm the
   encryption approach (app-level crypto vs a KMS) before SQ3.
4. **Fees display**: Square and Stripe have different fee structures —
   do we surface processor fees to the owner at all, or stay silent as
   today (we take no platform fee either way)?
5. **Refunds parity + G2**: SQ5 gives Square a real money-moving
   refund. Confirm it runs under the G2 honesty rule (record ≠ move
   until the API confirms) and that the workspace-Stripe refund stays
   deferred, so the two processors aren't held to different honesty
   standards.
6. **The generic-seam refactor (SQ2)** landing FIRST, under Stripe
   tests, before any Square code — approved as the safe ordering?

Sources: [Square OAuth](https://developer.squareup.com/docs/oauth-api/square-permissions) · [Checkout / Payment Links API](https://developer.squareup.com/reference/square/checkout-api/create-payment-link) · [Payments & Refunds](https://developer.squareup.com/docs/payments-refunds) · [Refunds webhooks](https://developer.squareup.com/docs/refunds-api/webhooks) · [Sandbox overview](https://developer.squareup.com/docs/devtools/sandbox/overview) · [Sandbox payments/test cards](https://developer.squareup.com/docs/devtools/sandbox/payments)
