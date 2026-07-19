# Finances / Live Budget Investigation

Read-only mapping ahead of the live-budget-ledger arc (feeds: A automatic money-IN from Stripe, B confirmed money-OUT via the brain, C owner anchors). Every claim cites `file:line` as verified on this working tree (branch `main`, HEAD `0d9cea5`). Sections 1–7 are factual; Section 8 is the only opinion section.

---

## 1. MONEY-IN, WHAT EXISTS

**The critical finding first: there are TWO money worlds with different units and different scoping.**

| World | Tables | Amount type | Scope |
|---|---|---|---|
| PS (E14 ledger) | `transactions`, `transaction_payments`, `appointments` money columns | **INTEGER cents** | **workspace_id** |
| PM (legacy) | `rent_payments`, `budget_transactions`, `invoices`, `payment_events` | **NUMERIC(10,2) dollars** | **user_id** |

**PS, the disciplined side:**
- `transactions` (`migrations/phase1-additive/036_transactions.sql:19-58`): workspace-scoped, `subtotal/tax/tip/discount/total_cents INTEGER` (`:31-35`), `amount_paid_cents`/`amount_refunded_cents` as rollups (`:36-37`), `line_items JSONB` with `unit_price_cents` (`:28-29`), status CHECK draft/pending/paid/partially_paid/unpaid/refunded/voided (`:67-69`), `source` CHECK incl. `booking_deposit` (050), `contact_id`/`appointment_id`/`parent_transaction_id` links (`:93-95`).
- `transaction_payments` (`042_transaction_payments.sql:34-46`): `amount_cents INTEGER NOT NULL` (`:38`), `payment_type` CHECK deposit/payment (`:56`), status pending/completed/failed, unique partial index on `stripe_checkout_session_id` for webhook idempotency (`:92-94`).
- `appointments`: `quoted_price_cents`, `final_price_cents`, `amount_paid_cents`, plus FD3-CP6's `deposit_required_cents`/`deposit_transaction_id`/`deposit_paid_at` (`050_deposits.sql:18-20`).

**PM, the legacy side:** `rent_payments` (`amount NUMERIC(10,2)`, `due_date TEXT`, status pending/paid/late — initDB, `server.js:1094-1105`), `budget_transactions` (`type income|expense`, `amount NUMERIC(10,2)`, `date TEXT` — initDB, with seeded demo rows `server.js:984-987`), `invoices` (`vendor`, `amount NUMERIC(10,2)`, status), `payment_events` (`parsed_amount NUMERIC(10,2)`, AI-parsed forwarded payment email). All `user_id`-scoped, all float-dollar.

**Money-in code paths (feed A's sources):**
1. **Stripe webhook** — `POST /api/stripe/webhook` verified with `STRIPE_TEST_WEBHOOK_SECRET` (`server.js:2001`); `checkout.session.completed` carrying `metadata.transaction_id` dispatches (`server.js:2056-2059`) to `processCustomerPaymentCompletedEvent` (`lib/payment-ledger.js:180-282`): flips the pending ledger row → recomputes the rollup (`recomputeTransactionPaidStatus`, `:97-151` — the SINGLE writer of `amount_paid_cents`/status) → CP6 deposit branch stamps `deposit_paid_at` + confirms the appointment (`:236-260`).
2. **Completion money** — `complete_appointment` records cash/card taken at completion through `recordPayment` + recompute in one BEGIN/COMMIT (`lib/tools/complete_appointment.js:110-160`), reusing the CP6 deposit transaction when one exists (`:115-135`).
3. **Manual/AI transactions** — `create_transaction` / `complete_transaction` (both feed the ledger; `lib/tools/complete_transaction.js:3`).
4. **PM rent** — `markRentPaidFromEvent` from the payment-email parser (`server.js:5979`, parser `processPaymentEmail` `server.js:6127-6160`, event-confirm path `server.js:2942`) and manual `PUT /api/rent/:id` (`server.js:7771`).

**How hard to also post a ledger line at these events?** Easy on the PS side: every money-in flows through exactly TWO choke points — `processCustomerPaymentCompletedEvent` and the `recordPayment`+recompute pairs — both in `lib/payment-ledger.js`, both already receiving `{workspace_id, transaction_id, amount_cents, payment_type}`. One hook (or, per §6, no hook at all — a read-time view over `transaction_payments WHERE status='completed'`). PM rent has one choke point pair (`markRentPaidFromEvent` + the PUT).

---

## 2. MONEY-OUT, THE HONEST GAP

**Correction to the expectation: it is not "almost nothing" — it is two half-things, neither of which records a payment.**

- **`budget_transactions` with `type='expense'`** IS a manual money-out ledger: user-scoped float dollars, `category/description/amount/date/notes` (initDB), endpoints `GET/POST/DELETE /api/budget` (`server.js:4383, 4396, 4410`), an AI tool `add_budget_transaction` (**PM-only**, `lib/tools/add_budget_transaction.js:13`, dollar `amount: number` `:21`), UI on page-admin (add-transaction modal, parity audit §1.11) and a one-line month summary on Finances (`views/app.html:11698-11717`). It is untyped free-text category, unlinked to vendors/contacts, and demo-seeded (`server.js:984-987`).
- **`invoices`** are vendor BILLS with a status workflow — pending/approved/rejected via `PUT /api/invoices/:id` (`server.js:7884-7893`) — but **no paid state, no payment recording, no amount ever leaves anywhere**, and no linkage to `budget_transactions`. Approving an invoice changes a word.
- **`refund_transaction`** (PS) is real money-out: negative-total child transactions with `parent_transaction_id` (`lib/tools/refund_transaction.js:59`, route `server.js:8062+` with the paid/partially_paid parent gate), approval-gated (AP3). It is refund-shaped only.
- **`message_vendor_for_restock`** — confirmed: it sends SMS/email and writes `messages` rows (`lib/tools/message_vendor_for_restock.js:136-146`); **no amount, no payment, no expense record of any kind**.
- **Payouts** (Stripe → the owner's bank): not modeled anywhere — charges are direct on the connected account (`lib/payment-requests.js:158-180`), so payouts happen entirely on Stripe's side, invisible here.

**What must be built from zero for feed B:** a workspace-scoped, integer-cents `expenses` table (vendor/contact link, category, date, source: manual|ai_confirmed|invoice, receipt linkage), its CRUD endpoints, an entry UI, an AI posting tool, and the confirmation flow (§5). The existing `budget_transactions` is a PM-culture prototype in the wrong units and wrong scope — substrate to read as a legacy feed (§7), not to extend.

---

## 3. OWNER-INPUT SURFACES

- **Manual expense/income entry exists** — the budget add-transaction modal (page-admin, `views/app.html:13669` submit → `POST /api/budget`) and `add_budget_transaction` via the panel. PM-flavored, dollars, user-scoped.
- **Cash-on-hand: nothing.** No table, column, or input anywhere (`grep cash` — no money-context hits).
- **Budgets/goals: nothing.** `budget_transactions` is a transaction log, not a budget target; no goals concept exists.
- **Patterns to model after:** the workspace-settings bus — columns on `workspaces` behind `GET/PATCH /api/workspace/ai-settings` with validation (autonomy matrix FD3-CP3, deposits FD3-CP6 `server.js:8808-8830`) — and the My Business `.mm-card` settings pattern (deposits card with the reality-gated toggle, `views/app.html:3846+`). A `cash-on-hand` anchor and goals belong in a small workspace-scoped table (anchors need history: amount + `as_of` + who set it — a column can't hold the reconciliation trail), following migration-file chassis (`lib/migrations.js` runner).

---

## 4. THE PAGE TODAY

`page-finances` (`views/app.html:3471`) is vertical-forked by `loadFinancesPage` (`views/app.html:11566-11605`): PS shows the Connect status card (`:3488`) + the transactions card (`:3504`); PM shows a rent summary card (`:3598`); both show invoices + budget one-line summaries (`:3572, :3585`).

- **Transactions card (PS):** search/customer/method/date filters + Refresh + Export CSV + New transaction (`:3478-3483`); `loadTransactions` (`:11757`) fetches `GET /api/transactions` (workspace-scoped, filters via `_buildTxFilters`, `server.js:7907-7946`) and renders rows with per-row `total_cents` formatting (`:11798`) — **no totals row, no aggregates on this card**.
- **Summaries compute CLIENT-side over full fetches:** budget month net (fetch all month rows → reduce, `views/app.html:11712-11716`), rent paid/pending/late counts (`:11719-11740`). The only server-side money aggregate anywhere is the PS dashboard's revenue-this-week (`SUM(amount_paid_cents)`, `server.js:2561-2569`).
- **Export CSV, traced end to end:** button → `exportTransactionsCsv` builds the same filter params and navigates (`views/app.html:11807-11821`) → `GET /api/transactions/export.csv` (`server.js:7974-8022`) rebuilds `_buildTxFilters`, SELECTs, formats cents→dollars (`fmt`, `:7993`), CSV-escapes (`:7987-7991`), streams with a content-disposition filename. Working, PS-transactions-only, no ledger/budget/rent export.
- **New transaction** posts a `create_transaction` prompt through `POST /api/command` (`views/app.html:12070-12085`) — the AI bus, not a REST endpoint.

---

## 5. THE BRAIN CONNECTION

**Money tools today — all PS-vertical, all owner-side.** None is in the engine's customer allowlist (`lib/appointment-engine.js:45-53` — verified unchanged through every FD3/IB gate): `find_transaction` (search, read-only, `requiresApproval:false`, `lib/tools/find_transaction.js:17,34`), `find_outstanding_balance` (unpaid/partial listing, `:21,33`), `create_transaction`/`complete_transaction`/`void_transaction` (unapproved owner actions), `refund_transaction` + `request_payments_batch` (`requiresApproval:true` — the payments autonomy lane, FD3-CP3). PM has `add_budget_transaction`/`add_invoice` (PM-vertical).

**How "did this come out of the budget?" rides EXISTING machinery:** two chassis already fit, split by who initiates:
- **AI-initiated posting → the approval queue.** A new `post_expense` tool with `requiresApproval:true` inherits the whole FD3 stack for free: `decideAutonomyAction` (`lib/autonomy.js:60-65` — add the tool to `TOOL_CATEGORY`, either under `payments` or a new `finances` category with an approve default), the `/api/command` divert into `pending_actions` (`server.js:5161+` region), the approve endpoint's execute-with-context (`server.js:7257-7346`), the CP4 badge/ping/TTL, and `buildPendingActionSummary` for the queue chip. The owner's Approve IS the "yes, it came out of the budget."
- **AI-detected probable expenses → the suggestion chassis.** Reflection already turns conversation evidence into suggested tasks with a verbatim-evidence `aiReason`, caps, and dismissal dedupe (`lib/reflection.js:139-186`). A restock message or "ordered more polish" conversation becomes a *suggested* expense card ("Post $84 to supplies? — Customer: 'the OPI order came in'") — accept posts, dismiss remembers. No new mechanism; a new suggestion *type* on the same rows.

**Proactive insights ride CP7's engine directly:** `runReflectionPass` is the template — no-tools model call, strict JSON, hard caps, suggested-task delivery (`lib/reflection.js`). A budget-insight pass is the same shape with ledger context instead of a transcript, and the existing unresolved-suggestion cap (`MAX_UNRESOLVED_SUGGESTIONS`, `:23`) already prevents nagging. Trigger candidates that exist today: the CP4 sweep interval (`server.js:758+`), the daily-nudge ensure endpoint (`server.js:2626`), or reflection-at-close for money-flavored conversations.

---

## 6. THE LEDGER MODEL (opinion)

**Derived view, computed on read — not a materialized running-balance ledger.** The data supports this three ways:

1. **The codebase already fought this war and picked derived.** E14's ADR made `amount_paid_cents` a rollup with ONE recompute function and forbade direct writes (`lib/payment-ledger.js:10-17`); the zero-ledger-row guard exists precisely because a materialized column drifted from truth pre-E14 (`:102-108`). A second materialized ledger reintroduces the same failure class across MORE writers.
2. **Every feed is already queryable at read time**: `transaction_payments WHERE status='completed'` (PS in), the new expenses table (out), `rent_payments WHERE status='paid'` (PM in), `budget_transactions` (PM legacy). A `/api/finances/summary` endpoint composes them with SQL sums — the PS dashboard already does this shape for revenue (`server.js:2561`).
3. **Idempotency stays free.** The webhook's ledger-row flip is idempotent by unique index (`042:92-94`); a posted-on-write budget line would need its own dedupe keys for every event type.

**Cash-on-hand without double-counting:** the anchor is a *baseline reset*, not a transaction — store `(amount_cents, as_of, set_by)`. Current cash = `anchor.amount_cents + Σ(money-in completed after as_of) − Σ(money-out dated after as_of)`. Events before `as_of` are inside the anchor by definition (the owner counted the drawer); events after compose on top. Re-anchoring is the owner's reconciliation act and starts a new baseline — no event is ever counted twice because the window is half-open at `as_of`. Keep anchor history (a table, not a column) so drift between anchor N and anchor N+1 is itself a reportable insight ("your ledger expected $4,210, you counted $4,020").

**Test-vs-live gating:** reuse FD3-CP6's one honest signal — `depositsLive()` reads the `sk_live_`/override reality (`lib/deposits.js:17-21`). While test-mode, Stripe-fed money-in is *demo money*: the summary layer should tag Stripe-origin sums (`payment_method='stripe'` rows, `042:39` region) and exclude them from cash-on-hand math unless live — same build-whole-ship-asleep pattern as deposits, same module, no second detector.

---

## 7. PM vs PS

Finances serves both today by **forking the page** (§4): PS gets the real cents ledger + Connect; PM gets rent counts; both get the invoice/budget one-liners. The money data never meets: PS money is workspace-scoped cents, PM money is user-scoped dollars, and no query joins them.

For a live budget: **one model, per-vertical feeds.** The ledger view's money-in is `transaction_payments` for PS and paid `rent_payments` for PM (both have clean paid-event choke points, §1). Money-out is the ONE shared new build — a workspace-scoped cents `expenses` table serving both verticals (a plumber's parts and a salon's polish are the same row shape), with `budget_transactions` read as a legacy PM feed (converted `amount*100` at read, labeled) rather than migrated in place — its rows are demo-seeded and user-scoped, and rewriting history in place violates the additive discipline. Vendor linkage differs only in source: PM expenses often trace to `invoices` (add a paid-state bridge), PS to restock conversations (the §5 suggestion path).

---

## 8. GAPS & BUILD ORDER (opinion)

Your shape is right with two resequencing notes: **(4) mostly dissolves into (1)** under the derived model — money-IN needs no posting hook, only inclusion in the summary view plus the live/test gate — and **(0) is real but small**: no correctness *bug* exists in the cents world (units and scoping are consistent inside each world), so (0) is a boundary decision, not a fix pass.

| CP | Work | Substrate vs new |
|---|---|---|
| 0 | **Boundary decision, stated once:** all NEW money is workspace-scoped integer cents; legacy PM tables are read-through feeds (×100 at read), never written by the new system. No in-place migration. | Decision + a conversion helper. Nothing to fix in the cents world (§1). |
| 1 | **Ledger summary layer:** `GET /api/finances/summary` composing feeds per §6 (period sums, category breakdown, cash-current when anchored), + the anchors table. The `depositsLive()` test-money tag from day one. | Mostly reusable: payment-ledger discipline, dashboard SUM pattern (`server.js:2561`), migration chassis, `lib/deposits.js`. New: the view queries + anchors table. |
| 2 | **Money-OUT construction** — the arc's biggest new build (§2): `expenses` table (workspace, cents, vendor/contact, category, date, source, invoice_id nullable), CRUD endpoints, entry UI, and the invoice paid-state bridge. | Genuinely new. Model the endpoints on the transactions routes (`server.js:7907-8022`), the UI on the transactions card. |
| 3 | **Dashboard UI** (Monarch-feel): summary tiles + category bars + cash line on page-finances, replacing the one-line summaries; `.mm-card` + tokens. | UI new; data all from CP1. |
| 4 | **Money-IN completeness:** PM rent feed into the view, Stripe-origin tagging verified live vs test, deposit lines labeled (CP6 columns). | Small — read-side only, per §6. |
| 5 | **Confirmation via the brain:** `post_expense` tool (`requiresApproval:true`, autonomy category), restock/conversation-driven *suggested* expenses via the reflection chassis (§5). "Did this come out of the budget?" = the approve queue, verbatim. | Almost all substrate: pending_actions, matrix, CP4 notify/TTL, CP7 suggestions. New: one tool + one suggestion type. |
| 6 | **Owner anchors:** cash-on-hand entry (with `as_of` + history per §6), goals table + UI, manual expense entry polish. | Patterns exist (settings bus, deposits card); tables new. |
| 7 | **Proactive insights:** a budget pass on the reflection template (no tools, strict JSON, caps, suggested-task delivery) triggered off an existing scheduler (§5). | Nearly all substrate (`lib/reflection.js`); new prompt + trigger wiring. |
| 8 | **Transaction views/filter/export, unified:** extend the working PS export (`server.js:7974`) to the composed ledger (expenses + PM feeds), plus in-page ledger filtering. | Half exists (PS export end-to-end today, §4); extension not invention. |

Ordering rationale: 1 before 2 so the expenses table is designed against the view that reads it; 2 before 3 so the dashboard never renders a feed that can't exist; 5 after 2 (the tool posts into a real table) and before 7 (insights that can say "post it?" need the posting path); 6 anywhere after 1 but before 7 (insights about cash need the anchor); 8 last because its PS half already works today.
