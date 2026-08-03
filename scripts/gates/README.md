# Lost gate scripts — AD9 rebuild backlog

The AD3–AD7 credential arc ran its harness on 16 gate scripts that
lived in a temp scratchpad **outside the repo** and were destroyed by
temp-dir cleanup mid-session (diagnosed in the AD4 harness-repair
commit). Keeping the harness out of the repo was the durability
mistake; AD9 rebuilds each in-repo under `scripts/`.

This file is the backlog of record. AD8 (the arc-closing cleanup)
ships it; AD9 works it down.

## The 16, with coverage status and the subsystem each proved

| Gate | Subsystem it proved | Status |
|------|--------------------|--------|
| brain-expense | `post_expense` tool — approval-gated, owner-only, cents boundary (BG5) | **Reincarnated** → `scripts/test-brain-expense.js` (12) |
| budget | finances-summary math — feeds, half-open window, demo gate, cents (BG1–4) | **Reincarnated** → `scripts/test-finances-summary.js` (39) |
| ledger | unified ledger totals == summary; direction/category/source filters (BG8) | **Substantially covered** by `test-finances-summary.js` rows B21–B21d; a dedicated rebuild may still be warranted |
| behaviors | conversation behaviors — per-channel playbook responses (lib/appointment-engine) | **Reincarnated** (folded) → `scripts/test-playbook.js` |
| deposits | deposit dormancy — `depositsLive()`, no real link until Stripe live (FD3-CP6) | **Reincarnated** → `scripts/test-deposits.js` (9) |
| driver | per-thread driver/takeover — `appointment_threads.ai_paused`, precedence, voice-exempt (IB4, migration 054) | **Reincarnated** → `scripts/test-driver.js` (8) |
| email | inbound email reaches the brain; non-alias fails loud (IB5) | **Lost — rebuild** |
| expiry | `pending_actions` expiry sweep — customer notify + owner task, idempotent (FD3-CP4) | **Lost — rebuild** |
| ib1 | outbound persistence + linkage — owner/ai/system sends, backfill (IB1) | **Reincarnated** → `scripts/test-outbound-persist.js` (9) |
| ib3 | unified thread view — conversation grouping, thread key grammar (IB3) | **Reincarnated** (folded) → `scripts/test-read-state.js` grammar rows |
| owner-context | assistant-context assembly for the owner `/api/command` brain | **Lost — rebuild** |
| ping | approval-queue notification — badge/ping/TTL, restored customer origin (CP4/CP5) | **Lost — rebuild** |
| playbook | conversation playbook regression — day-of notes, complaint receipts, thread unwedge (FD3-CP5) | **Reincarnated** → `scripts/test-playbook.js` (9) |
| readstate | `read_at`, mark-on-fetch, Gmail-arithmetic unread counts (IB2) | **Reincarnated** → `scripts/test-read-state.js` (8) |
| reflection | reflection pass — no-tools Haiku, strict JSON, dedupe, MAX suggestions (FD3-CP7) | **Reincarnated** → `scripts/test-reflection.js` (12) |
| ws | voice websocket auth — answers only to Twilio (FD3-CP4) | **Lost — rebuild** |

**Tally:** 2 exact reincarnations, 1 substantially covered, **13 to
rebuild**.

## Rebuild guidance for AD9

- The CODE each gate covered still exists and is the spec — every
  original gate was written against live behavior. Reconstruct from
  the subsystem source + the cited checkpoint's commit message.
- Follow the in-repo suite conventions now established (AD5–AD8):
  `scripts/test-<name>.js`, `__dirname`-anchored requires, fixture DBs
  over the real libs, a `PASS/FAIL` line per row and an `N/N — <name>
  PASSED` footer with `process.exit(fail ? 1 : 0)`.
- Prefer driving the real lib with fixtures over asserting against a
  live server; use source pins only where the law lives in an adapter.
- As each is rebuilt, move its row to a "Reincarnated" status here so
  the backlog stays honest.

## The current in-repo harness (what green means today)

`test-finances-summary` (39), `test-brain-expense` (12),
`test-budget-insights` (11), `test-contact-settings` (20),
`test-credentials` (17), `test-contact-verify` (12),
`test-security-notices` (11), `test-kill-switch` (9),
`test-reset-token-hashing` (6), `test-mail-health` (10).
