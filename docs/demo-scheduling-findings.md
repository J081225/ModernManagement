# Demo scheduling bug — findings
(Read-only, 2026-08-25. Evidence: messages row 85 (ws21 demo voice
call, CALLSID CAa296…, caller +1 256 436 2052), tool source, engine
prompt lines. No changes.)

## 1. The call, verbatim
Caller's stated window (three times, escalating clarity):
> "Between 5 and 7PM?" … "What do you have between 5 and 7PM?" …
> "What's your next available day that you have 5 to 7PM available
> for my service?"

The AI even narrated the right intent:
> "Let me check what we have available between 5 and 7 PM for your
> 45-minute Cut + Beard service."

…and then offered, every single time, for five straight days:
> "Open 45-minute slots on 2026-08-25: **9:00 AM, 10:30 AM, 12:00 PM.**"
> (identical 9:00/10:30/12:00 for 08-26 through 08-29)

The loop repeated until the 3-minute demo cap wrapped the call. The
caller never got an afternoon time — or an acknowledgment that the
offered times ignored their window.

## 2. How the times were produced — the full chain
1. Engine prompt instructs: availability questions go through the tool,
   never guess times ([appointment-engine.js:468](../lib/appointment-engine.js#L468), [:477](../lib/appointment-engine.js#L477), [:498](../lib/appointment-engine.js#L498), [:500](../lib/appointment-engine.js#L500)); allowlisted at [:54](../lib/appointment-engine.js#L54). The model complied — it called the tool for every ask.
2. The tool: [lib/tools/propose_appointment_times.js](../lib/tools/propose_appointment_times.js).
   **Schema (:20-28) accepts ONLY `target_date`, `duration_minutes`,
   `max_slots`. There is NO time-window parameter.** The caller's
   "5 to 7 PM" had nowhere to go — the model physically could not pass
   it.
3. Day bounds are hard-coded 9:00–18:00 (:11-12, :43-44).
4. Slot scan (:73-83): starts at 9:00, steps 30 min, and **breaks as
   soon as `max_slots * 3` (9) open slots are found (:82)**. On the
   demo's empty calendar that's 9:00–13:00 — the scan NEVER REACHES
   the afternoon.
5. Spread-picker (:88-91): 9 candidates, step = 3 → indices 0/3/6 =
   **exactly 9:00 AM, 10:30 AM, 12:00 PM** — a perfect match for the
   transcript. The bug reproduces from source arithmetic alone.

The cruel detail: a 5:00 PM slot is inside the tool's own 9–18 window
(17:00 + 45 min ≤ 18:00) and the calendar was open — the caller could
have been given exactly what they asked for. The tool just can't be
asked, and its sampler can't get there.

## 3. Verdict: MISSING TOOL PARAMETER (with two accessories)
- **Primary — missing tool parameter.** No `window_start`/`window_end`
  in the schema (:20-28). Not a prompt gap the model could route
  around: relaying tool output verbatim is the pinned honesty
  behavior, and inventing 5–7 PM times would violate "Never guess
  times" (:500). The model did the best legal move available.
- **Accessory A — the `max_slots * 3` early break (:82).** Even with
  no conflicts, offered slots ALWAYS come from the first ~4.5 open
  hours. Afternoon/evening slots are structurally unreachable today,
  window parameter or not. Any fix must address this too or an
  evening window returns empty.
- **Accessory B — no mismatch acknowledgment (prompt gap).** :500 says
  "offer 2-3 concrete slots" but nothing tells the model to SAY "I
  don't have anything between 5 and 7" when the returned slots miss a
  stated window — so it presented morning times as if they answered
  the question, three times, until the cap. One prompt line closes
  this ("if the returned slots don't satisfy the customer's stated
  window, say so plainly and offer the nearest alternatives").
- **NOT model-ignoring-instructions**: no instruction about stated
  windows exists anywhere in the chain to be ignored.

## Fix shape (for ruling — nothing built)
1. Add optional `window_start`/`window_end` (wall-clock HH:MM in the
   workspace tz) to the tool schema; clamp the scan to the
   intersection of the window and business day.
2. Remove or rescope the `max_slots * 3` break so the scan covers the
   whole day, THEN spread.
3. One prompt line: honor and acknowledge stated time windows.
4. Suite rows: window respected; whole-day reachability (an evening
   slot can be proposed); mismatch acknowledged.
