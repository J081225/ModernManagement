# SPIKE — Voice Language Auto-Detect (Phase 2)

Active per Jay's ruling after the Spanish live test passed. The spike
proves or disproves; **shipping is a separate ruling on the evidence.**
No production wiring — the testbed is isolated by construction.

## 1. The prices, read precisely

Per-minute components (public pricing; **console-confirm flagged
below**):

| Component | Rate | 3-min call |
|---|---|---|
| Twilio inbound local voice | ~$0.0085/min | ~$0.03 |
| ConversationRelay (default STT+TTS included) | ~$0.07/min | $0.21 |
| LLM (Haiku, our brain) | per-token | ~$0.01 |
| **Today's booking call (en/es, default stack)** | | **≈ $0.25** |
| + Deepgram nova-3 multilingual STT (detect) | ~$0.006/min direct; Twilio surcharge TBD | +$0.02–0.07 |
| **With detection** | | **≈ $0.27–0.32 (+8–30%)** |
| + ElevenLabs multi TTS (auto-switching voices) | ~$0.05–0.08/min | +$0.15–0.24 |
| **With detection AND premium TTS** | | **≈ $0.40–0.50 (+60–100%)** |

**The economics headline: detection is the cheap half; ElevenLabs
multi-TTS is the expensive half.** Which yields the recommended
architecture if the spike passes: **detect with Deepgram-multi, then
switch the session to the detected language via the mid-call
`language` WebSocket message using per-language DEFAULT voices** —
detection without the ElevenLabs tax. Voice replies switch on the
NEXT utterance (the caller hears one default-language greeting first;
the wrong-guess recovery below covers exactly this window).

**Console-confirm (two ways):** Twilio's exact premium-STT surcharge
isn't in public docs. (a) Jay reads Voice > ConversationRelay pricing
in the console; better, (b) after the first day of test calls we pull
the Twilio usage-records API for the spike number — ACTUAL per-call
costs, evidence-grade. I'll do (b) automatically once calls exist.

## 2. The testbed — LIVE NOW

**Call +1 (313) 631-8389** (a Detroit-local number so Dearborn testers
see a familiar area code; FriendlyName marks it TEMPORARY).

The rig: `/api/voice/spike-incoming` (signature-validated) returns
ConversationRelay TwiML with `transcriptionProvider="Deepgram"
speechModel="nova-3-general" transcriptionLanguage="multi"` — Twilio's
automatic language detection. Its own wss path and handler (never
touches the production relay flow); TTS stays default English
deliberately, pacing testers with "Recorded. Please read your next
line." **Every utterance lands in `spike_transcripts`** with the
detected language and the full payload.

End-to-end verification already run: signed TwiML probe 200 with the
multi attributes; unsigned probe 403 (signature validation holds);
wss handshake + fake Arabic prompt → evidence row `lang=ar` with the
transcript, canned reply returned. The pipe is proven; real phones
are the remaining variable.

## 3. The test-call protocol

The tester-facing sheet is **docs/spike-autodetect-protocol.md** —
one page, hand it to native speakers. Design summary:

- **Languages**: English (control), Spanish, Arabic (Levantine and
  Yemeni speakers explicitly — MSA-only testing would validate the
  wrong thing for Dearborn).
- **Per call, six lines**: greeting, booking request, price question
  (each language), then the hard cases — a code-switched sentence
  (Arabic/English mid-sentence), a line delivered with background
  noise (TV/kitchen), and a rapid colloquial line.
- **Scoring** (from `spike_transcripts`, per utterance):
  - **Language detection**: detected `lang` matches the spoken
    language. Claimable ≥ 95% on clean lines, ≥ 80% on hard cases.
  - **Transcript accuracy**: reviewer marks intent-preserving /
    partially-usable / garbage. Claimable: ≥ 90% intent-preserving on
    clean lines, ≥ 70% on dialect lines. (Word-error-rate is
    overkill; Sarah needs INTENT, not verbatim.)
  - Per language×dialect cell, minimum 3 speakers × 6 lines before
    reading a verdict.
- **The wrong-guess recovery** (design, for the shipping ruling):
  detection misfire must never strand a caller. The floor:
  1. First utterance in the wrong language → the caller naturally
     repeats or protests; Deepgram-multi re-detects per utterance and
     the session self-corrects via the `language` message.
  2. The greeting always ends with the keypress floor: "para español,
     oprima el dos — للعربية اضغط ثلاثة" (press-2/press-3) — a DTMF
     menu no detection failure can take away. ConversationRelay
     forwards DTMF to the socket; the handler pins the session
     language on keypress, overriding detection for the rest of the
     call.
  3. If two consecutive utterances detect differently, prefer the
     caller's LAST language and never flip back silently.

## 4. Exit criteria

The spike closes with a ruling when each language×dialect cell has
its 3×6 evidence and the usage-records read gives actual unit costs.
PASS → ship the detect-with-default-voices architecture (and ST7b's
Arabic voice unlocks if the Arabic cells pass). FAIL in any cell →
that language's voice claim stays off, per-channel truth unchanged,
and the spike table records exactly why.

Teardown when ruled: release +13136318389, remove the spike route +
whitelist entry + wss branch, drop spike_transcripts (066).

---

## RESULTS REGISTER (durable)

### English baseline — 2026-08-19, call CAdaab71… — PASS
Pipe proven end-to-end. 8/8 utterances detected en; 7 intent-preserving,
1 partially-usable (onset clip), 0 garbage.

### Arabic (Levantine, Jay-confirmed) multi auto-detect — 2026-08-19 — **FAILED (spike RESULT, not a deferral)**
Calls CA83c8…(29s), CAefe5…(2s hangup), CA6564…(48s), CAba3e…(107s).
**0/10 utterances detected ar** (9 en, 1 es); transcripts romanized
through an English lens. Grades: 0 intent-preserving / 2 partially-usable
("Marhaba, with the isa al iza hand kun Mawaid fadiyeh" ≈ مرحبا إذا عندكن
مواعيد فاضية; "same time middle el marra el madiel") / 8 garbage
("Marjada." · "But the esophageal mawahed" · "Marja Bakis con g o 1
Marrabeto Selfi con" · "But the issue is now end." · "The" · "Ja, chicken
last year sorry," · "Lehwen vet pus el but was the" · "Kiev"(es)).
Secondary: endpointing mismatch (mid-sentence cuts + never-finalized
utterances = low-confidence drops; no webhook/TwiML errors).
**RULING: Phase-3 auto-detect for Arabic is OFF THE TABLE on current
providers. Re-entry requires re-running this rig (3 speakers/dialect) on
any new provider before anything ships. The Phase-1 keypress menu is the
architecture (customer-declared, un-mishearable) — not a stopgap.**

### Variant B — transcriptionLanguage="ar" FIXED (no detection) — OPEN
Route /api/voice/spike-b-incoming (nova-3, ar). Tests DECLARED-language
dialectal transcription. Pass bar: ≥70% intent-preserving on dialect
lines → "press 3 for Arabic" becomes a real voice path; fail → Arabic
voice stays off, text remains Dearborn's offer.
Variant C staged (/api/voice/spike-c-incoming, nova-2 + multi), unpointed.

### Variant B — fixed ar, Levantine speaker — 2026-08-19 — **PASS (83–100%)**
Calls CA2a9e…(35s warm-up, redialed) + CA81eb…(76s, the six-line run).
All 13 utterances ar (fixed). The run: greeting ✔ · Saturday booking
"بدئج احجز موعد قصة شعر يوم الثبات الصبح إذا في مجال" (السبت→الثبات:
partially-usable, day slot garbled but recoverable) · color price
"أداش سعر صبغة الشعار عندكم؟" ✔ · code-switched same-time line
"بعمل أبويمنت لبكرة بس سيم تايم مثل المرة الماضية اذا ممكن" ✔ PERFECT
(multi rendered this "Ja, chicken last year sorry") · noise line ✔
(split, minor dup) · rushed parking line ✔. Score: 5/6 intent-preserving
+ 1 partially-usable = 83% strict, ≥70% bar → **PASS. "Press 3 for
Arabic" is ruled a real voice path (declared language, no detection).**
Endpointing: dramatically better than multi — zero dropped utterances in
the run, one benign split, 5–12s finalization (multi: whole-utterance
drops + 24–29s dead gaps). Warm-up call showed two early cuts (بدي اح /
بدي أحلى) before she settled — note for the tester script: start
speaking a beat after the greeting. Number restored to baseline
/spike-incoming post-cell.
