# TR1 Investigation — Transaction History Report

Look-first for the TR arc. No code changed. Evidence is cited as
file:line or as live-DB reads (2026-08-04).

## 1. What exists — inventory

### The tables (live schema, migrations 036 + 042)

**`transactions`** (30 columns) is the *source document*: workspace-scoped,
integer cents throughout (`subtotal/tax/tip/discount/total/amount_paid/
amount_refunded_cents`), JSONB `line_items`, `status` lifecycle
`draft → pending → paid | partially_paid | unpaid | refunded | voided`,
`source` ∈ {appointment_completion, walk_in, product_sale, manual,
refund, booking_deposit}, refunds as *linked child rows*
(`parent_transaction_id`, negative line items — the original is never
edited), void as stamped columns. Receipt/send state rides on the row.

**`transaction_payments`** (11 columns) is the *cash ledger*: one row
per money movement (`payment_type` 'deposit'|'payment',
`payment_method` cash|card|venmo|zelle|gift_card|stripe|other,
`status` pending|completed|failed, `stripe_checkout_session_id` for
online). lib/payment-ledger.js is the **single writer** of the
rollup: `transactions.amount_paid_cents` and paid-status are derived
in exactly one place (`recomputeTransactionPaidStatus`), with a
zero-ledger-row guard for legacy/refund rows.

### Where rows are born (this was hidden — creation is AI-tool-driven)

There is **no `POST /api/transactions`**. Creation lives in the tool
registry, i.e. the Front Desk *is* Sarah:

- `lib/tools/book_appointment.js:193` — FD3 booking deposit: a
  `source='booking_deposit'` transaction + deposit ask (autonomy-gated).
- `lib/tools/complete_appointment.js:133` — auto-created at completion.
- `lib/tools/create_transaction.js:97` — walk-in / manual sale.
- `lib/tools/complete_transaction.js` — settles, feeding the ledger.
- Refunds: `lib/tools/refund_transaction.js:59` + the owner endpoint
  `POST /api/transactions/:id/refund` (server.js:9162).

REST surface is otherwise read/act-only: list, detail, refund,
request-payment, send-receipt, export.csv.

### The BG unified ledger and the TWO existing exports

`lib/finances-summary.composeLedgerRows` (283–415) is the **already-
built unified read-model**. It unions four sources at read time:

| source key | table | unit | scope | direction |
|---|---|---|---|---|
| `ledger` | transaction_payments (completed) | cents | workspace | in |
| `legacy_rent` | rent_payments (status='paid') | dollars→cents at read | owner user | in |
| `expenses` | expenses (BG2) | cents | workspace | out |
| `legacy_budget` | budget_transactions (type='expense') | dollars→cents at read | owner user | out |

It already solves the three hard problems TR needs: **unit
normalization** (`legacyDollarsToCents`), **scope normalization**
(workspace vs owner-user), and **timezone-aware dating** (`wsTz`).
Plus the demo/test split (Stripe rows flagged `demo` when deposits
aren't live) and totals that exclude test money.

Two CSV buttons exist today:
- **Finances → Export CSV** → `/api/finances/ledger/export.csv`
  (server.js:9037): the ledger rows — Date, Direction, Description,
  Category, Source, Money(Real/Test), Amount + In/Out/Net totals.
  Honors period + direction/category/source filters. `\r\n` line ends.
- **Transactions tab → Export CSV** → `/api/transactions/export.csv`
  (server.js:9079): the source documents — Date, Customer, Line-item
  description, Subtotal, Tax, Tip, Total, Method, Status, Notes, ID.
  PS-only by construction (reads `transactions` alone). `\n` line ends.

### Extending vs building new — the one-source-of-truth story

The report should be a **third VIEW over the same read-model, not a
third source**. `composeLedgerRows` is the single place that already
knows how to merge both verticals' money truthfully; the transactions
export is the per-document detail view for PS. TR = extend the
composer (grouping, subtotals, customer dimension, richer row detail)
and render it as a report; **do not** write a new query stack that
would have to re-solve units/scope/timezones and could drift.

## 2. Data completeness census

Money events that DO write rows (evidence):

| event | row written | where |
|---|---|---|
| Customer pays a Stripe link | pending ledger row at session creation → webhook flips to completed | payment-requests.js:198; server.js:2616 → payment-ledger:180 |
| Deposit paid at booking | same pending→completed path; stamps `appointments.deposit_paid_at` | payment-ledger:239 (FD3-CP6) |
| Manual payment taken in conversation (cash/venmo/…) | completed ledger row | tools create/complete_transaction, complete_appointment |
| Appointment completed | transaction born (+ ledger row if paid then) | complete_appointment.js:133 |
| Refund recorded | child transaction `source='refund'` + parent `amount_refunded_cents` | server.js:9200; refund_transaction.js:59 |
| PM rent marked paid | rent_payments UPDATE status='paid' | markRentPaidFromEvent (server.js:6576), email-forwarding + AI paths |
| Owner expense logged | expenses row (BG2) / legacy budget_transactions | BG arc; add_budget_transaction tool |

**Gaps found (each with evidence):**

- **G1 — legacy PM INCOME is invisible.** `budget_transactions` holds
  **4 live `type='income'` rows** (verified by query), but every
  reader — `legacyExpensesOut`, `composeLedgerRows`
  (finances-summary:367–388) — filters `type='expense'`. Non-rent PM
  income exists in the DB and appears in NO summary, NO ledger, NO
  export. The money report must not inherit this blind spot.
- **G2 — refunds record but do not MOVE money.** Neither the refund
  endpoint nor the tool calls Stripe; a card-paid refund requires a
  manual Stripe-dashboard refund that nothing links or verifies (no
  stripe_refund_id column). Recorded-but-not-refunded and
  refunded-but-not-recorded are both silently possible. (SP4c built
  exactly this machinery for signup refunds — precedent exists.)
- **G3 — SP4c automated signup refunds** live only in
  `stripe_events._remedy` + Stripe. Correct: the workspace never
  existed, so they belong to *platform* bookkeeping, not any owner's
  report. Noted so nobody "fixes" it into TR.
- **G4 — data reality, not code:** `rent_payments` is EMPTY in
  production (ws3's real rent isn't tracked in-app yet) and
  `transactions`/`transaction_payments`/`expenses` are all empty (no
  live customer money has flowed). Today the entire report universe
  is 12 legacy budget rows. The report ships ahead of its data —
  design for the empty state honestly.
- **G5 — no non-AI creation path.** If the owner wants to log a cash
  sale without a Sarah conversation, there is no UI form. Out of TR's
  scope; flagged as inventory.

## 3. Retention — permanent storage confirmed, one caveat

- **No pruning anywhere.** The only interval cleaners are email sync,
  signup drafts, reset tokens, conversation inactivity, pending-action
  expiry, and the provisioning sweep (server.js:674–901). None touch
  money tables. No TTL, no archive job, no DELETE of
  transactions/transaction_payments exists anywhere in server, libs,
  scripts, or migrations.
- The new-system tables are **append-only by design**: no delete
  endpoint exists; corrections are voids and linked refunds.
- Legacy tables DO have owner-initiated single-row deletes
  (budget_transactions server.js:4961, rent_payments 8421, expenses
  8784) — an owner can hand-delete history the report would show.
- **Caveat:** `transactions.workspace_id` is `ON DELETE CASCADE` —
  deleting a workspace erases its entire money history. Fine for test
  workspaces (ws18), but "forever" formally means "as long as the
  workspace row lives."

## 4. Both verticals, one report

PM and PS money do **not** land in the same tables (PM: rent_payments
+ legacy budget, user-scoped dollars; PS: transactions +
transaction_payments, workspace-scoped cents; shared: expenses). The
consequence: any "one report" MUST go through a read-time normalizer
— and that normalizer already exists and is deployed
(`composeLedgerRows`). One report serving both = one composer feeding
one renderer, with per-vertical category vocabularies (Rent vs
Deposit/Payment) preserved as data, not branched UI.

## 5. Proposed TR sequence + rulings for Jay

Proposed checkpoints:
- **TR2 — the report read-model**: extend finances-summary with
  grouping (by month, by customer, by category), running totals, and
  fix **G1** (legacy income rows join the ledger/summary as
  direction='in', source='legacy_budget'). Suite rows pin the census.
- **TR3 — the report UI**: a Report view on Finances — date-range
  presets (this month / quarter / YTD / last year / custom / all),
  customer + category + direction filters, month subtotals, empty
  state that says what will appear here and how.
- **TR4 — printable + accountant export**: print-styled report page +
  the report-scoped CSV (extend the ledger CSV with the grouping
  columns; two CSVs already exist, do not add an unrelated third).
- **TR5 — hardening**: suite + census pins (row-source census, cents
  discipline pin, retention pin: no DELETE path may appear on money
  tables).

Rulings requested:
1. **What is a row** — cash events (money movements, ledger-style;
   what an accountant reconciles) vs documents (transactions with
   status). **Recommend cash events**, with transaction id as a
   reference column; the Transactions tab remains the document view.
2. **G1 fix in TR2** (recommended) or ruled out separately.
3. **G2 scope** — real Stripe refunds from the refund flow is its own
   checkpoint (SP4c precedent exists); recommend deferring OUT of TR
   like the PM send-paths, but it needs an explicit ruling.
4. **Printable = print-styled HTML** (recommended) vs generated PDF.
   Reasoning: browser print-to-PDF produces the PDF anyway; no new
   dependency (PDF generation on Render means puppeteer/pdfkit weight);
   page-break CSS handles month sections; and at tax time the
   accountant's actual want is the **CSV** (imports into their
   software) — ship print CSS + report CSV, skip server-side PDF.
5. **Test money** — report defaults to Real only with a "show test"
   toggle (the ledger's demo split already computes this).

## The cents flag (asked for explicitly)

Storage is uniformly integer cents in the new system; legacy dollars
are converted at read (`legacyDollarsToCents`). But **there is no
shared display formatter anywhere**: `_csvDollars` (server CSVs),
`receipts.js:16`, `appointment-engine.js:350 fmtPrice`, ~10 inline
`(cents/100).toFixed(2)` sites across server.js/lib/tools, and ~15
inline `/100` + `toLocaleString` sites in app.html — each formats
independently. TR should introduce ONE shared helper (or promote
`_csvDollars`) and format every report surface exclusively through
it; retrofitting the existing sites is optional follow-up, but the
report must not add a 20th independent formatter.
