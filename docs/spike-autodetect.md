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
