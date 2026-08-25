# Voice endpointing — findings
(Read-only, 2026-08-25. Sources: server.js TwiML build, Twilio's
current ConversationRelay docs (fetched today), transcript row 92.
No changes.)

## 1. What we set today: almost nothing
The production `<ConversationRelay>` ([server.js:8240](../server.js#L8240)) carries exactly:
- `url` (the wss relay), `welcomeGreeting` (customer-strings
  voice_greeting incl. the MR1 disclosure), and the language attr
  ([:8233-8234](../server.js#L8233)): es → `language="es-US"`; ar (flag-gated) →
  `language="ar" transcriptionProvider="Deepgram"
  speechModel="nova-3-general" transcriptionLanguage="ar"`.
- en sets NO attributes beyond url + greeting.

**Nothing endpointing-related is set anywhere on business lines** — no
speechTimeout, no interrupt tuning. Everything runs on Twilio
defaults. (The spike lines :8364-8392 set Deepgram models but also no
endpointing knobs; the WS handler logs `interrupt` events
([:12195](../server.js#L12195)) but nothing configures them.)

## 2. Twilio's endpointing controls (exact names, from today's docs)
| Attribute | What it does | Default | Range / values |
|---|---|---|---|
| **`speechTimeout`** | ms of silence after speech before the FINAL prompt is reported over the WS — the end-of-turn knob | `auto` | integer 600–5000 ms |
| **`eotThreshold`** | confidence required to finish a turn | 0.8 | 0.5–0.9; **Deepgram `flux` model only** |
| **`partialPrompts`** | send unfinalized prompts (`last=False`) + eager EOT events | false | true/false; Deepgram flux only |
| **`interruptible`** | whether caller speech/DTMF stops TTS | `any` | none/dtmf/speech/any |
| **`interruptSensitivity`** | how easily speech interrupts TTS | `high` | high/medium/low (medium/low reduce false barge-ins) |
| **`welcomeGreetingInterruptible`** | interruption during the greeting | `any` | none/dtmf/speech/any |
| **`reportInputDuringAgentSpeech`** | deliver prompts while agent speaks | `none` | none/dtmf/speech/any |
| **`ignoreBackchannel`** | filter "yeah/uh-huh/okay" so they don't interrupt | false | true/false (en, es, fr, de, …) |
| **`preemptible`** | next turn's tokens may cut current TTS | false | true/false |

Trade-off per the docs: with Deepgram + `flux`, `speechTimeout` is
forwarded as the max silence duration and Deepgram does server-side
turn detection; on other providers it is Twilio-side. Longer
speechTimeout = fewer mid-sentence cuts, but adds that much latency
to EVERY turn end.

## 3. The greeting-reset oddity: CONFIRMED fragment-triggered
Transcript 92, verbatim sequence:
1. Caller: "What do you have available between" → cut mid-sentence
   (endpointing fired on a pause) — AI asks them to finish.
2. Caller: **"the"** — a one-word fragment final.
3. AI: **"Hey there! Welcome to Northside Barbers. How can I help you
   today?"** — a fresh-greeting-shaped reply, mid-call.

Facts: this is the MODEL's reply, not the TwiML `welcomeGreeting`
(which says "…this is their automated manager"); the CALLSID is
constant across the whole row — **no session reset occurred**. The
greeting-shaped reply directly and only follows the contentless
fragment turn: the trigger is confirmed. Mechanism at the model
layer: handed a turn containing just "the", it answered as if a new
caller had said hello. (Whether the engine delivered full history on
that turn wasn't provable read-only; either way the fragment is the
proximate cause.)

**Would longer endpointing have prevented it? Very likely yes,
counterfactually unprovable.** All three utterances were one
continuous sentence delivered as three finals — `speechTimeout: auto`
fired twice inside a natural mid-sentence pause. At 1,200–2,000 ms
the fragment turn almost certainly never exists, so the model never
sees a bare "the". It cannot be proven for THIS call (auto's actual
threshold isn't reported), which is why this is stated as likely,
not certain.

## Recommendation shape (for ruling — nothing set)
1. Set `speechTimeout` explicitly on business lines (start ~1200 ms);
   accept the added turn-end latency as the price of whole sentences.
2. Consider `ignoreBackchannel="true"` (supported for en + es) and
   `interruptSensitivity="medium"` for noisy callers.
3. Orthogonal belt: an engine-side fragment guard (a contentless
   sub-word turn merges into the next rather than reaching the model)
   would close the reset even when endpointing still misfires.
4. The Deepgram `flux`/`eotThreshold` path is a bigger experiment —
   spike-line material, not a quiet default change.
