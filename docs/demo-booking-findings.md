# Demo booking flow — two defects
(Read-only, 2026-08-25. Evidence: messages row 92 (ws21 demo voice
call CA5daebb…, caller +1 443 504 4832 — the most recent demo call),
tool + engine source. No changes.)

## DEFECT 1 — a date-RANGE ask answered with a single day

### The transcript
Caller: **"we have available between the 1st and the September 4."**
then "Mids haircut." then **"Preferably before 3PM."**

AI: "Let me check what we have available between September 1st and
4th, before 3 PM, for a Classic Cut."
→ ONE tool call: `propose_appointment_times(target_date=2026-09-01,
duration 30, window 09:00–15:00)` → **"Open 30-minute slots on
2026-09-01 between 9:00 AM and 3:00 PM: 9:00 AM, 12:00 PM, 3:00 PM."**
— September 1 only. The caller had to drive the range manually:
**"What about the 2nd?"** → a second single-day call for 09-02, same
three slots. Days 3 and 4 were never checked.

(DS1 itself is working as shipped: the window param carried "before
3 PM" and the endpoint-inclusive spread 9:00/12:00/15:00 matches the
source arithmetic exactly. One semantics note: a 3:00 PM START was
offered for "before 3 PM" — window_end is documented as the *latest
acceptable start, inclusive* ([propose_appointment_times.js:26](../lib/tools/propose_appointment_times.js#L26)); borderline, flagged not judged.)

### The chain
- **Schema: single day only.** `target_date` (YYYY-MM-DD) is required,
  no end-date/range field exists ([propose_appointment_times.js:23](../lib/tools/propose_appointment_times.js#L23), [:29](../lib/tools/propose_appointment_times.js#L29)).
- **Prompt: silent on multi-day asks.** Every instruction (engine
  [:477](../lib/appointment-engine.js#L477), [:498](../lib/appointment-engine.js#L498), [:500](../lib/appointment-engine.js#L500), [:501](../lib/appointment-engine.js#L501)) is per-call/per-window; nothing says "for a
  date range, call once per day" or "offer the first day and say
  you'll check further days." Behavior is accordingly inconsistent:
  the PRIOR call (row 85) looped 5 days unprompted; this one checked
  one day and presented it as the answer.

### Verdict 1: **schema gap + prompt gap** (not tool logic — per-day
calls work). The tool can't be asked for a range, and the model is
unguided about looping, so range asks degrade to whichever shape the
model improvises.

## DEFECT 2 — post-selection recheck instead of booking

### The transcript, from selection to the end
Caller: **"Okay. Can I get 12PM on the 2nd?"** — selecting a slot the
AI had JUST offered.

AI: "Let me check if 12 PM on September 2nd works…"
→ `propose_appointment_times` → **"window_start must be earlier than
window_end."** (the DS1 validation error, verbatim — the model
point-checked one instant with a zero-width window, almost certainly
window_start = window_end = "12:00", which [:67-68](../lib/tools/propose_appointment_times.js#L67) rejects).

Caller: "Okay. And the result is?"
AI: "…I need to confirm that 12 PM works with our calendar before I
can lock it in — let me check that slot for you right now."
→ same call shape → **same error.** 📞 Call ended.

**`book_appointment` was NEVER called. Booking never completed.** (No
cap marker on the record — the caller gave up before the demo wrap.)

### The chain
1. **The prompt MANDATES the recheck** — twice: "before agreeing to
   any specific time, check with propose_appointment_times"
   ([engine:468](../lib/appointment-engine.js#L468)) and "check propose_appointment_times before
   agreeing to ANY time" ([:498](../lib/appointment-engine.js#L498)). There is **no carve-out for a
   slot the tool itself just returned** — the model was complying,
   not confused.
2. **The natural point-check shape is an error.** Verifying one exact
   time via the only availability tool means a zero-width window,
   which DS1's inverted-window guard rejects ([:67-68](../lib/tools/propose_appointment_times.js#L67)). The model
   then looped on the apology instead of widening the window.
3. **Why the prompt is so insistent: `book_appointment` has NO
   conflict check at write time.** Its INSERT ([book_appointment.js:126-134](../lib/tools/book_appointment.js#L126))
   writes appointments + cal_events unconditionally — no overlap
   query, nothing atomic. The propose-first rule is the ONLY
   double-booking guard in the whole chain, which is exactly why the
   model won't skip it.

### Verdict 2: **prompt gap, compounded by a tool-logic edge, resting
on a real tool gap.**
- Prompt gap: no "a just-offered slot the customer picks may be
  booked directly" instruction ([:468](../lib/appointment-engine.js#L468)/[:498](../lib/appointment-engine.js#L498) mandate the opposite).
- Tool-logic edge: zero-width windows — the natural single-slot
  check — are rejected rather than treated as a point query
  ([propose_appointment_times.js:67-68](../lib/tools/propose_appointment_times.js#L67)).
- Underlying tool gap: `book_appointment` performs no atomic
  availability validation at write ([book_appointment.js:126-134](../lib/tools/book_appointment.js#L126)),
  so the prompt rule can't safely be relaxed until the write path
  checks conflicts itself.

## Fix shape (for ruling — nothing built)
1. `book_appointment`: atomic conflict check in the write transaction
   (overlap query against non-canceled cal_events; refuse with the
   conflicting time named). This makes booking safe WITHOUT a recheck.
2. Prompt: "when the customer picks a slot you offered THIS
   conversation, book it directly — book_appointment verifies."
3. propose_appointment_times: accept window_start == window_end as a
   point query (does 12:00 fit?) instead of erroring.
4. Range support: either an optional end_date (scan N≤7 days) or an
   explicit prompt rule to loop per-day and say which days were
   checked.
5. Pins per piece; the DS gate grows rows for the point query.

## Side observation (out of scope, one line)
Mid-call the AI reset to a fresh greeting ("Hey there! Welcome to
Northside Barbers…") after a fragmented utterance ("the") — a
possible context/turn anomaly on fragment turns, worth its own look.
