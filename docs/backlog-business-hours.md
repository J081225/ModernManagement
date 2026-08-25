# BACKLOG — PER-WORKSPACE BUSINESS HOURS arc
(Filed 2026-08-25, from the demo-call audit's hours-mismatch finding:
ws21's knowledge said 9 AM–7 PM while propose_appointment_times
hard-codes 9:00–18:00 — the AI quoted hours it could never book.)

## The arc, when ruled in
1. Workspaces get real open/close times (eventually per-day-of-week:
   open_time/close_time columns or a JSONB week schedule), owner-
   editable from My Business.
2. `propose_appointment_times` (and any future scheduler) reads THEM
   instead of DEFAULT_DAY_START_HOUR/DEFAULT_DAY_END_HOUR
   ([propose_appointment_times.js:18-19](../lib/tools/propose_appointment_times.js#L18)).
   book_appointment's conflict window inherits the same bounds.
3. **The invariant that motivates the arc: knowledge and tool must
   derive from the same source.** The AI's spoken/written hours and
   the slots it offers must be structurally incapable of disagreeing —
   either the Hours knowledge text is GENERATED from the workspace
   schedule, or the prompt's hours section reads the schedule directly
   and freetext hours are retired. A census-style pin should assert
   the single source.
4. Closed-day awareness: the day list (Tue–Sat for the demo) belongs
   in the same schedule — today the tool happily proposes Monday
   slots for a shop whose knowledge says it is closed Monday (same
   mismatch class, one level up).

## Interim state (until ruled in)
ws21's Hours knowledge was corrected (2026-08-25, announced + read
back) to state 9:00 AM–6:00 PM, matching the tool's hard-coded day —
truthful again, but by HAND-SYNC. Every new PS workspace inherits the
9–6 tool bounds regardless of its real hours: this arc is what
removes that lie-in-waiting.
