# Demo-call audit — call 94 (+ the R1-R5 fix package)
(2026-08-25. Evidence: messages row 94 (CALLSID CAeb7eab…, ws21,
caller +1 443 504 4832), ws21 DB row, appointment #13, source. The
fix package shipped in the same session — statuses noted per defect.)

## The transcript (turns + tool calls interleaved)
1. C: "Hi. I'd like to book an appointment to get a haircut."
2. AI: "…classic haircut, or would you like to add a beard trim?"
3. C: "I like a classic whiskey cut." → AI: **"I'm sorry — could you
   repeat that?"** ✓ (MISHEAR line 1, served + followed)
4. C: "I'd like a gin and tonic." → AI: **"I think you might have the
   wrong number! Northside Barbers is a barbershop — we do haircuts
   and beard trims, not drinks."** ✗ (the forbidden shape)
5. C: "…classic cut. What do you have between September 1 and
   September 3?" → TOOL propose_appointment_times(start_date 09-01,
   end_date 09-03, 30min) → per-day slots, all three days ✓ (BK2c
   range WORKING)
6. C: "I'll take September 30, 05:30PM." → AI narrates "I need to
   check…" → TOOL propose (point query 17:30==17:30 on 09-30) →
   "5:30 PM" ✓ (BK2b point query WORKING; narration = R3 defect)
7. C: "I'll take that slot." → AI: "I need to make sure I have the
   right time — are you confirming…?" (2nd confirmation) → C: "Yes."
   → AI: name? → C: "James" → AI restates a 3rd time → TOOL
   book_appointment → appointment #13 'requested' → tool message
   "Requested: … Awaiting your confirmation." relayed to the CALLER.
8. Policy questions: cancellation + late — answered CORRECTLY from
   ws21 knowledge ("Booking policy": 24h notice, 10-min hold — NOT
   invented ✓). Then: "What time were you thinking about coming
   in?" — post-booking context loss. Demo cap wrapped the call.

## (a) Post-selection re-check + the approval language
BK2's direct-book rule WAS in the served prompt (deployed hours
before the call). The tool-side re-check was RULE-COMPLIANT: Sep 30
was never offered until the point query (propose-first for un-offered
times, engine rule). book_appointment WAS called and was NOT
intercepted by any queue — appointment #13 exists, status
'requested' because **ws21 appointment_auto_confirm was FALSE**. The
"approval" language came from the tool's OWNER-shaped result message
("Requested… Awaiting your confirmation.",
[book_appointment.js](../lib/tools/book_appointment.js) pre-fix)
relayed to the caller. The "checking" language was model narration
(no rule forbade it — R3 gap).

## (b) ws21 settings at call time
`appointment_auto_confirm: false` (→ 'requested'),
`appointment_auto_respond: true`, all four autonomy_* columns null.
**Post-R4: appointment_auto_confirm = true (flipped, announced,
read back).**

## (c) Gin-and-tonic: RULE SCOPE GAP (not instruction ignored)
MISHEAR's first line was served and followed verbatim (turn 3). On
the clear repeat, the model concluded the request was genuinely
out-of-domain — a case the mishear framing ("suspected mishearing")
did not cover, so it fell through to a scope-style answer and NAMED
the interpretation. The instruction wasn't ignored; its scope was too
narrow. **Fixed by R1's absolute strict-domain rule + the
FORBIDDEN/CORRECT example pair.**

## (d) Questions asked
| Question | Verdict |
|---|---|
| classic cut or + beard trim? | borderline — service variant; R2 allows ONE such question |
| could you repeat that? | necessary (mishear) |
| anything for a haircut or shave? | recovery of the forbidden turn — gone with R1 |
| "are you confirming Sept 30 5:30?" | INTERROGATION — caller had just said "I'll take that slot" |
| your name? | necessary |
| (3rd restatement before booking) | INTERROGATION — R3 allows exactly one confirmation |
| "What time were you thinking about coming in?" (post-booking) | INTERROGATION + context loss — the appointment was already booked at 5:30 |

## (e) Everything else found
1. **No approval seam existed at all**: 'requested' rendered as a
   badge; PATCH /api/appointments/:id accepted no `status`; the owner
   literally could not approve a booking. → CLOSED (R5b): guarded
   requested→confirmed|canceled transition + Confirm/Decline buttons
   in the calendar modal.
2. **notifyPendingActionCustomer had NO STOP gate** (and no demo
   check) — an opted-out customer could still receive outcome texts.
   → CLOSED (R5c): isOptedOut gate added; the new appointment outcome
   texts carry isOptedOut + is_demo + workspace-number-only gates.
3. **Hours mismatch**: ws21 knowledge says open 9 AM–7 PM (last
   appointment 6:30 PM); propose_appointment_times hard-codes
   9 AM–6 PM (DEFAULT_DAY_END_HOUR=18,
   [propose_appointment_times.js:19](../lib/tools/propose_appointment_times.js#L19)).
   The AI QUOTES 7 PM hours while never offering past 5:30. OPEN —
   needs a ruling (per-workspace business hours vs fixing the demo's
   knowledge text).
4. Policy answers were real (knowledge-sourced) — no fabrication ✓.
5. Post-booking context loss (the tail question) — partially
   addressed by R3's no-narration + booked-confirmation-line rule;
   worth watching on retest.

## The shipped package (same session)
- **R1 STRICT-DOMAIN** (voice prompt): absolute never-conclude/
  never-name/never-"we don't do X" + the two ruled lines only +
  taught FORBIDDEN/CORRECT gin-and-tonic pair; B2 kept for
  business-adjacent asks. Pins MH1-MH3.
- **R2 MINIMAL-ASK**: name+time+service (or standard-service default)
  books; max ONE clarifying question; `open_question` on
  book_appointment files a suggested owner task naming customer, gap,
  thread. Pins MH4, BA7.
- **R3 CONFIRMATION SCRIPT**: exactly one confirmation in the exact
  ruled shape, book immediately, one-line booked confirmation, zero
  process narration. Pin MH5.
- **R4 SEAMLESS DEFAULT**: ws21 flipped autonomous (announced, read
  back); migration 084 makes autonomous the default for NEW
  workspaces; Owner review stays the opt-in toggle. Pin BA9.
- **R5 PENDING-APPROVAL LOOP**: caller-facing ruled line from the
  tool when review is on (never process words — BA6); PATCH
  approve/decline + Confirm/Decline UI; approved/declined outcome
  texts in the ruled shapes, consent-gated (STOP + demo + own-number),
  logged to messages. FD3-CP3's ungated send fixed. Pins BA6, BA8.
- **Consent note (R5c)**: outcome texts are transactional replies to
  the customer's own request — the registered campaign's
  customer-initiated path; the STOP suppression gate applies to them
  like every send, now structurally.
