# Post-confirmation turn — findings (calls 95 + 96)
(Read-only, 2026-08-25. Evidence: transcripts 95/96, appointments
14/15, engine + relay source. No changes.)

## 1-2. What happened after each "yes" — and what TTS received
The transcript's bare un-prefixed lines decode the whole defect:
`appendCallTurn` writes `AI: <text>` where `<text>` was MULTI-LINE —
the engine's `outbound_text` concatenates the model's pre-tool text
AND the RAW TOOL MESSAGE ([appointment-engine.js:629-633](../lib/appointment-engine.js#L629), the accumulation loop). `sendText` then speaks the
whole thing (markdown stripped, newlines collapsed —
[server.js stripSpeechMarkup](../server.js#L12076)). So TTS received, verbatim:

**Call 96** (after "Yes." at the verification):
> "Perfect! Let me book that for you. Booked: Classic Cut for James
> on Thu, Sep 3, 5:30 PM (30 min). Calendar updated."

**Call 95**: same shape ("…I'm booking a Classic Cut for her at 2:30
PM… Booked: Classic Cut for James on Fri, Sep 4, 2:30 PM (30 min).
Calendar updated.")

And the availability turns were worse — the raw range-tool message
rode along:
> "…Open 30-minute slots, 2026-09-01 to 2026-09-03: 2026-09-01 —
> 9:00 AM, 1:30 PM, 5:30 PM; 2026-09-02 — 9:00 AM, 1:30 PM, 5:30
> PM; …"

ISO dates ("twenty twenty-six dash zero nine dash zero one"), "Booked
colon", "(30 min)", "Calendar updated" — all spoken.

**Bookings succeeded on BOTH calls**: appointment #14 (Sep 4 2:30 PM,
created 17:37:15Z) and #15 (Sep 3 5:30 PM, created 17:55:33Z), both
'confirmed' (R4 autonomous working).

**Then the second defect fired.** book_appointment marks the thread
'complete' on a confirmed booking ([book_appointment.js thread-link block](../lib/tools/book_appointment.js)); the thread lookup excludes
completed threads ([appointment-engine.js:248-251](../lib/appointment-engine.js#L248), `state NOT IN ('closed','complete')`). So when the confused
caller spoke again ("Yes. That's correct."), a FRESH thread with ZERO
history was created — and the model, seeing a first turn, greeted
anew: "Hi James! Thanks for calling Northside Barbers. What can I
help you with today…" Both calls show it. (Call 92's mid-call
greeting had the same *shape* from a different trigger — fragments;
this one is structural: post-booking context is GUARANTEED lost
in-call.)

## 3. Verdicts (both calls identical)
**Reply-sent-but-garbled, then structural context reset.** Not
dead-air (a reply went out each turn), not a relay fault (ws.send
succeeded as far as any evidence shows).
- Garble: raw tool messages are concatenated into the spoken reply —
  there is NO post-tool model pass on this path; the tool's
  owner/debug-grade message IS the customer's sentence ending.
- Reset: 'complete' thread + not-complete lookup = every post-booking
  utterance in the same call starts a blank conversation.

## 4. Relay/WS error logs
Render-side only — this machine cannot read Render logs (standing
limitation; ws.send failures would appear there as
"[twilio-relay] ws.send failed"). Nothing error-shaped is persisted
in any table for these CALLSIDs. **Telemetry gap noted:** transcripts
carry no per-turn timestamps, so dead-air GAPS are unmeasurable from
the DB; if this class needs real timing, per-turn timestamps (or a
relay send log) is a small announce-first addition.

## Fix shapes (for ruling — DIRECT-ANSWER shipped separately today)
1. **Never speak raw tool messages**: voice replies = model text
   only; run a post-tool model pass (or make every booking/schedule
   tool message speech-grade). The BA6 caller-line message is already
   speech-grade — the "Booked:"/"Open slots" messages are not.
2. **Post-booking continuity**: keep the thread alive for the rest of
   the call (mark complete at call end), or carry same-call history
   across the thread boundary — a caller who just booked must not
   meet a stranger two seconds later.
3. Per-turn transcript timestamps (telemetry).
