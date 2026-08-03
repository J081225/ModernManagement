# AD9 Investigation — Rebuilding the Lost Gates

The final Admin-arc checkpoint. AD8's `scripts/gates/README.md` named
16 gates lost to temp-dir cleanup; this reconstructs what each proved,
rules redundancy against the 10 in-repo suites, and plans the rebuild.
**Test infrastructure only** — no production change is expected; any
rebuild that surfaces a production gap is flagged loudly, not silently
patched. State: clean tree at `15abafc`; AD8 live (migration 060
applied clean, plaintext reset tokens cleared, deploy healthy).

## Testability, established up front

Two tiers, from the subsystem map:

- **Tier A — pure or dependency-injected libs** (the AD5–AD8 fixture
  pattern applies directly): `deposits`, `outbound-persist`,
  `read-state`, `reflection`, `owner-alert`, and the engine's
  `buildSystemPrompt`/`buildToolListForEngine` (pure) +
  `findOrCreateThread` (injectable db). These rebuild as real
  behavioral suites driving the actual code.
- **Tier B — logic embedded in `server.js`, module-scoped, not
  exported**: `email/incoming` routing, `runPendingActionExpirySweep`,
  the `/api/conversations` grouping route, `/api/command` owner-context
  assembly, `handleRelayUpgrade` (ws auth). These get **slim gates**:
  replay the decision logic against fixtures AND source-pin that
  server.js implements it that way — the established CS14/D5/K8/M9
  pattern. No function is exported purely for a test (that would be a
  production change the ruling forbids); where an export would be
  cleaner it is noted as a flagged recommendation, not taken.

## Redundancy verdicts (arguing each, per the ruling)

Three of the sixteen were already reincarnated (brain-expense, budget,
ledger-via-B21). Of the remaining thirteen:

| # | Gate | Verdict | Reasoning |
|---|------|---------|-----------|
| 2 | deposits | **REBUILD** | `depositsLive`/`depositConfig`/`computeDepositCents` are used as a DEPENDENCY by test-finances-summary/test-contact-verify (env setup) but never asserted as a unit — the key-prefix live-detection and cents math are untested. Pure module; cheap, high-value. |
| 6 | ib1 (outbound-persist) | **REBUILD** | No suite touches `persistOutboundMessage`; the owner-only thread-creation + `last_owner_message_at` stamp + `onOwnerTurn` hook are unproven. |
| 11 | readstate | **REBUILD** | `lib/read-state` (mark-on-fetch, distinct-conversation unread count, group-read grammar) has zero coverage. |
| 7 | ib3 | **FOLD → readstate** | The t/c/m conversation-key grammar is shared between `conversationKeyOf` (server.js) and `markGroupRead`/`unreadConversationCount` (read-state). One suite proves the grammar once (lib behavioral + a server.js source-pin), rather than two overlapping files. |
| 12 | reflection | **REBUILD** | Already argued (not a brain-expense duplicate): distinct surface — SPAM_MARKERS, normalizeTitle, containment dedupe, the cap, strict-JSON parse. Shares only `validateExpensePayload`. |
| 1 | behaviors | **FOLD → playbook** | "Behaviors" and "playbook" are the SAME `buildSystemPrompt` block (lines 415–452) viewed twice — situation rules + per-channel style. One suite asserts the block; splitting would duplicate. |
| 10 | playbook | **REBUILD** (with behaviors) | The day-of-note / complaint-receipt / thread-unwedge rows and the channel-agnostic-behavior + channel-only-style contract, asserted against the real pure `buildSystemPrompt`. |
| 3 | driver | **REBUILD** | `findOrCreateThread` ai_paused sticky-inheritance on reopen + the entry-gate pause (voice-exempt) — injectable, no existing coverage. |
| 9 | ping | **REBUILD-SLIM** | The alert-chain ROUTING (`sendOwnerAlert`: phone→email, notifications-off honored, emergency always-send) is ALREADY covered — test-security-notices CS8–CS11 and test-contact-verify V1/V2 drive it directly. What's uncovered is the QUEUE→ping WIRING: the engine pings only for customer-originated pending actions, never owner-originated, and the badge counts pending rows. Slim gate for the wiring; cite the routing coverage, don't duplicate it. |
| 4 | email | **REBUILD-SLIM** | `lookupUserByEmailAlias` + the fail-loud unroutable branch (no DB write, no notify, structured error) — replay + source-pin. |
| 5 | expiry | **REBUILD-SLIM** | `runPendingActionExpirySweep` idempotence (each row flips once), the 4h/7d TTL split, customer-notify + owner-task — replay the SQL semantics + source-pin the sweep and its 30-min schedule. |
| 8 | owner-context | **REBUILD-SLIM** | `/api/command` stitches contextSummary + conversation memory + screenContext + vertical framing into one owner-brain prompt (distinct from the engine's customer-facing `buildSystemPrompt`). Source-pin the assembly; assert the pure framing pieces where they are pure. |
| 13 | ws | **REBUILD-SLIM** | `handleRelayUpgrade` token auth: the `/twilio-relay/v2/<48hex>` regex → `workspaces.voice_relay_token` match, the 15-min boot grace, silent `socket.destroy()` on every reject — replay the predicate + source-pin. |

**None fully redundant** — every one covers ground no in-repo suite
holds. `ping`'s routing half is the only real overlap, and the slim
gate deliberately excludes it.

## The rebuild plan — one gate (one commit) per unit

Tier A first (real behavioral suites), then the Tier B slim gates:

1. `test-deposits.js` — item 2 (dormancy detector + deposit cents).
2. `test-outbound-persist.js` — item 6 (owner/ai/system linkage).
3. `test-read-state.js` — items 11 + 7 (mark-on-fetch, unread-by-
   conversation, t/c/m group-read grammar; + `/api/conversations`
   grammar source-pin).
4. `test-reflection.js` — item 12 (spam gate, dedupe, cap,
   strict-JSON parse; a fixture no-tools "model" drives the pass).
5. `test-playbook.js` — items 1 + 10 (the buildSystemPrompt playbook
   block + channel-style contract + per-vertical tool list).
6. `test-driver.js` — item 3 (ai_paused sticky inheritance + entry-
   gate pause, voice-exempt).
7. `test-queue-ping.js` — item 9 (customer-only queue→ping wiring +
   badge; routing coverage cited, not duplicated).
8. `test-email-routing.js` — item 4 (alias lookup + fail-loud drop).
9. `test-expiry-sweep.js` — item 5 (idempotent flip, TTL split,
   notify+task).
10. `test-owner-context.js` — item 8 (owner-brain prompt assembly).
11. `test-ws-auth.js` — item 13 (relay token auth + boot grace).

Each: fixture-drives the real lib where Tier A, replay+source-pin
where Tier B, `PASS/FAIL` per row + `N/N` footer + `process.exit`,
`__dirname`-anchored, following the AD5–AD8 conventions. As each lands
its README row flips to "Reincarnated." A final commit adds a harness
runner (`scripts/gates/run-all.js` + an `npm test` wire) so the
harness can never again be an unrunnable pile of loose files — the
durability lesson, closed.

## Production-gap watch

Expected: none. The subsystems are all live and shipped. If a rebuilt
gate cannot make the real code pass a rule the arc docs claim it
enforces, that is a production finding — it will halt the gate, be
reported, and NOT be papered over by weakening the test. Flagged here
so the intent is on record before a line is written.

No code changed for this doc; it is the whole of the look-first.
