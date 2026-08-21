# AI-Scope Hardening — Register

The durable record of the "free therapist" guardrail arc: audit →
build (B1–B5) → reconciliation. Suite: `scripts/test-ai-scope.js`
(9 rows) runs on every commit via the in-repo harness.

## Audit (2026-08-20, look-first — findings as of that date)

1. **Prompt scoping:** the receptionist prompt carried ZERO scope rules —
   tone coaching only ("warm, friendly, short sentences"). No
   never-counsel rule, no off-topic handling, no crisis guidance.
2. **Call caps:** demo-only, keyed off `is_demo`. Business relay lines
   had NO per-call cap — a two-hour call was possible.
3. **Emergency detection:** all four channels verified covered by the one
   shared `detectEmergency` gate — SMS (Layer-1 in /api/sms/incoming),
   email (/api/email/incoming), voicemail transcription (with re-alert
   dedup), live relay voice (FD3-CP2) — plus a display recompute.
   ~~The keyword list was NOT yet read — may be property-only.~~
   **SUPERSEDED (corrected 2026-08-21): the list WAS read at build time
   (B2, commit 8aea1fa) — property-only confirmed (fire/gas/flood/
   threat/health, zero self-harm terms) — and extended with the
   human-crisis group (suicide, suicidal, kill myself, end my life,
   want to die, hurt/harm myself, self-harm, kill you/him/her),
   word-boundary matching per the "Cancel my 2pm" lesson. Suite-pinned
   per channel (AS2 behavior-tests the rebuilt production regex; AS8
   fixtures each channel) since 2079aa3..2406521.**
4. **Topic-redirect machinery:** none existed — no counters, no intent
   tracking.

## Build (2026-08-19, five commits, one unit each — all LIVE)

- **B1 `2079aa3`** — every relay call capped: demo 172s, business 580s;
  graceful wrap spoken pre-cutoff; `{type:'end'}` +8s; firings logged.
- **B2 `8aea1fa`** — human-crisis keyword group (see above) reaching all
  four channels through the one gate; the engine "## Scope" contract:
  receptionist not counselor, ONE warm sentence for emotional content,
  crisis reply minimal + 988 while the structural gate alerts the owner.
- **B3 `64aaea1`** — turn-counted topic redirect, structural (migration
  077 `off_topic_turns`): business turn = intent signal in the message
  OR tool call in the reply; N=4 → one warm redirect directive; N=6 →
  canned `off_topic_close` (en/es/ar, conversation-language aware, zero
  model cost) riding the normal send gates; voice ends politely after.
- **B4 `7ec34e1`** — owner-assistant scope contract (generous on
  business; ONE friendly redirect for personal asks) + `lib/report-cap`:
  10 AI report generations/workspace/day at BOTH creation sites,
  honest resets-at-midnight message, generation-only, fail-open.
- **B5 `2406521`** — the pin suite (then 7 rows).

## Reconciliation note (2026-08-21, commit 0020e4e)

A duplicate build order arrived as a fresh-session brief carrying the
pre-build audit state. **Look-first prevented re-building live code** —
the existing commits were verified unit-by-unit against the brief and
only its NEW specifics shipped as deltas:

- **Two-stage business wrap:** the ruled check-in verbatim at 520s
  ("I want to make sure I'm not keeping you — was there anything else
  about your appointment?", conversation continues so the answer is
  heard), final goodbye + end at 580s. A check-in question followed by
  an 8-second hangup would have been rude. Demo stays single-stage.
- **Cap marker on the call record:** a System turn on the transcript
  ("[Call reached the N-minute limit and was wrapped up.]"), not just
  the console log.
- **Suite +2 rows:** AS1b (demo caps unchanged: 172s, demo wrap line,
  35-min daily ceiling, check-in excluded) and AS8 (all four channel
  call sites pinned + a channel-shaped crisis fixture through the
  rebuilt production regex per channel). Gate 9/9; full suite 467/0.

**Attribution, for the process record: the architect's status memory
was the stale party; the register was right.** The lesson is the
standing one — a status note must be updated the session its work
ships, and a build order is checked against the live code before a
single line is rewritten.
