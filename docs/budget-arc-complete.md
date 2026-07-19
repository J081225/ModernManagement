# Budget Arc — Complete

The live-budget ledger arc (BG1–BG8), closed 2026-07-19. Born from [finances-investigation.md](finances-investigation.md); every checkpoint look-first-cited, gate-proven, pushed. This is the arc's closing record.

## The eight checkpoints

| CP | Delivered |
|---|---|
| **BG1** | The spine: `budget_anchors` + `budget_goals` tables (055/056), `GET /api/finances/summary` — a **derived view computed on read, nothing materialized** (the E14 lesson). Money-in with provenance (PS cents ledger + legacy rent ×100), the half-open anchor window (an event at exactly `as_of` stays in the drawer), `cash_current: null` without an anchor (unknown ≠ zero), the test-money gate from day one (`depositsLive()`, no second detector). The **boundary decision**, binding for the arc: all new money is workspace-scoped INTEGER CENTS; legacy PM dollar tables are read-through feeds, never written or migrated. |
| **BG2** | Money-out from zero: the `expenses` table (057), CRUD with filtered window-totals, cents-only validation (floats rejected, never rounded), the expenses card + add-expense modal, the summary's money-out feed going live beside the labeled legacy read-through, and the **invoice paid-state bridge** (mark-paid posts a `source='invoice'` expense, ×100 once, idempotent by invoice_id). |
| **BG3** | The dashboard: period control (month/quarter/custom, workspace-tz boundaries), the scorecard (Money In with provenance + honest demo line, Money Out, sign-colored Net, Cash-on-Hand as figure-or-invitation, Goal as bar-or-invitation), category breakdown bars, the detail layer framing — zero client money math, every number from the summary. |
| **BG4** | Money-in completeness **proven, not patched**: every PS payment is a ledger row so webhook + completion money can't double-count; both rent flip paths counted; two documented exclusions (legacy budget income — double-count risk with rent; dateless rows — nothing to bucket by). Deposits gained a labeled sub-total with the demo gate applied; the all-sources test-money matrix (B16) proved both modes across every feed at once. |
| **BG5** | The brain connection: `post_expense` (approval-gated, `payments` lane, vertical `core`) — "I paid the towel vendor $200" becomes an approval chip whose Approve **is** "yes, it came out of the budget"; AI-detected expenses as validated reflection suggestions (ask-don't-guess amounts, the EXPENSE marker, accept-posts-once). Owner-only proven at both layers: not in the customer allowlist, and a forged customer-side call can only queue. |
| **BG6** | Owner anchors + goals: INSERT-only anchoring (history preserved — the reconciliation trail), **drift surfaced on recount** ("Your ledger expected $4,210; you entered $4,020 — a $190 difference…", derived, stored nowhere), one-active-goal-per-period with deactivate-not-delete replacement, both BG3 invitation tiles made real. Commit 4's verification found and fixed the expenses card BG3 had accidentally deleted. |
| **BG7** | Proactive insights: the CP7 reflection engine pointed at money — once per workspace-day on first app open (riding the daily-nudge idempotency; no new timers/tables), context = this month + last month from the summary, **zero is the expected answer** for a healthy month, shared unresolved cap, dismissal dedupe, and the structural test-money proof (a test-only workspace shows $0 real revenue — a false insight has nothing to cite). Surfaced in the tasks feed + a dismissible dashboard strip with honest actions only. |
| **BG8** | The finish: the unified ledger view (both sides, one time-ordered list, direction/category/source filters, In/Out/Net totals) and the full-ledger CSV export extending the original machinery (extracted `_csvEscape`/`_csvDollars`, one implementation; the transactions-only export kept for its richer per-transaction columns). **The totals-match gate: the ledger and the dashboard compose the same feeds with the same boundaries and cannot disagree — proven, B21.** |

## The three in-repo suites (run: `node scripts/<name>.js`, no DB needed)

- `test-finances-summary.js` — **39 rows**: summary math, half-open anchors, test-money both modes, legacy coexistence, the bridge, BG6 history/drift/goals, the BG8 totals-match + isolation + escaping proofs.
- `test-brain-expense.js` — **12 rows**: post_expense boundaries (FD2 property re-verified), forged-call queuing, suggestion markers, accept-once.
- `test-budget-insights.js` — **11 rows**: the no-nag proof, cap-before-call, dismissal dedupe, period-over-period context, structural test-money proof.

## The one thing still gated

**Real-dollar money-in.** The entire Stripe path runs on the test-mode key; `depositsLive()` (sk_live_ prefix or the staging override) is the single activation signal, shared by deposits (FD3-CP6), the summary's demo split, cash-on-hand math, the ledger view's Real/Test column, and the insight pass. When live mode arrives, Stripe dollars fold into real money everywhere at once — no code changes, one honest detector, built whole and shipped asleep.
