# ST4 Investigation — Customer-Facing AI Language

Look-first for the multilingual addition to the ST arc (Jay's owner
vision ruling). No code changed. Evidence: codebase reads 2026-08-06
+ Twilio ConversationRelay documentation (sources at bottom).

## 1. Text channels (SMS + the text side of the one brain)

**Today:** the engine prompt pins NOTHING about language — zero
language/locale mentions in lib/appointment-engine.js. Behavior is
therefore implicit: Sarah answers in whatever language the model
drifts to, which in practice means English templates (greeting copy,
menu rendering, price lines are English-built strings) even when a
customer writes in Spanish. The canned copy AROUND the model
(payment-link SMS in payment-requests.js:233, receipts, welcome
texts) is hard-coded English.

**What "default language X, follow the customer" requires:**
- One workspace column (e.g. `customer_language`, IANA-style BCP-47
  code, default `en`).
- One prompt block in the one-brain builder: "Respond in <language>.
  If the customer writes in a different language, follow the
  customer." (~5 lines, same injection pattern as ai_tone at
  engine:456.)
- The canned strings AROUND the model need per-language variants or
  they betray the illusion: the SMS greeting templates, payment-link
  SMS, receipt SMS/email. This is the hidden majority of the work on
  text — the model half is nearly free.

**Honest language tier at our model (engine + owner AI both run
`claude-haiku-4-5`, lib/config.js:14):** Spanish, French, Portuguese,
German, Italian are solidly within Haiku-class competence for
service-booking conversation. We should CLAIM: **Spanish first-class
at launch** (the vertical's real market), others selectable as
"beta/best-effort" if Jay wants them listed at all. Do not claim
CJK/Arabic/etc. without dedicated testing — honesty rule applies to
the language list exactly as it did to deposits' reality gate.

## 2. Voice — the hard half (and it's more tractable than feared)

**Today:** our `<ConversationRelay>` TwiML sets ONLY `url` +
`welcomeGreeting` (server.js:7219). No language attributes at all —
so STT/TTS run at Twilio's defaults (en-US), and the greeting string
is an English template.

**What ConversationRelay actually supports (per Twilio docs):**
- TwiML attributes `language`, `ttsLanguage`, `transcriptionLanguage`
  set the session defaults; nested `<Language>` elements declare each
  language a session may use, each mapping a code to TTS/STT
  providers and a voice.
- Spanish exists in three variants (es-US, es-MX, es-ES), plus
  French, German, Italian, Portuguese, and more. Default voices per
  language exist when no voice is pinned.
- **Mid-call switching is supported**: the WebSocket accepts a
  `language` message that changes STT+TTS for the rest of the call.
- **Automatic language detection** exists as a configuration
  (Deepgram STT + ElevenLabs TTS with "multi") — but premium
  providers likely carry cost deltas; exact per-provider pricing
  needs a Twilio-console read before we commit to auto-detect.

**Can a Spanish default greeting + Spanish STT work TODAY?** Yes,
structurally: `/api/voice/relay-incoming` already renders TwiML
per-workspace (it looks up the workspace for the greeting), so
adding `language="es-US"` + a Spanish greeting template from the same
workspace column is a small, honest change. What's missing:
- the workspace language column (shared with §1),
- per-language greeting templates,
- the same language block in the VOICE prompt (the relay websocket's
  reply generation),
- a decision on auto-detect vs fixed-default (recommend FIXED default
  + follow-the-customer in text; auto-detect voice later once pricing
  is read — mid-call `language` messages leave the door open).

**Cost note, stated honestly:** default voices at default providers
carry no obvious premium; ElevenLabs/"multi" auto-detect is where
cost deltas live. The build should start on default voices.

## 3. Owner-side assistant (Command Center)

As expected: cheap. The owner AI runs the same Haiku model with a
server-built system prompt (server.js /api/command region). One
`users.preferred_language` (or reuse the workspace column — ruling
below) + one prompt line. The tool layer is language-agnostic
(tools return data; messages are composed by the model). The only
hard-coded English an owner sees from the AI path is tool
`message` strings (e.g. refund_transaction's copy) — those render
verbatim in chat. Fixing every tool message per-language is NOT
cheap (67 tools); recommendation: prompt-level language for the
conversational layer now, tool-message strings stay English and are
flagged as the known seam (same honesty pattern as §1's canned SMS).

## 4. OUT of scope, on the record

**Full UI translation (i18n of app.html and every surface) is
DEFERRED as its own someday-project** — Jay's ruling, recorded here
and in the durable backlog. Nothing in this arc translates the app
chrome; the scope is what the AI SAYS and HEARS, per channel.

## 5. The control's shape (proposed) + checkpoint split

**The control** lives on **My Business**, beside tone (the ST1/ST3
pattern: business behavior lives with business behavior):

> **Customer language** — [English (default) | Español | …]
> "Sarah greets and replies in this language, and follows the
> customer if they switch. **Texts: full support. Phone calls:
> greeting and conversation in Spanish; other languages coming
> later.**" (per-channel truth ON the control, deposits-style)

**Checkpoint split proposed:**
- **ST5a — the column + text channel**: `customer_language`, the
  one-brain prompt block (default + follow-the-customer), Spanish
  variants of the canned customer SMS strings, suite rows (prompt
  census + canned-string census so no English string leaks into an
  es conversation path we claim to support).
- **ST5b — voice**: TwiML `language`/`<Language>` from the workspace
  column, Spanish greeting template, the voice-prompt language block,
  default voices only; the setting's copy updates to claim voice
  truthfully. (SP5-style ordering: config change only after the
  code that renders it is live.)
- **ST5c — owner-side**: preferred language on the Command Center
  prompt; tool-message seam documented, not silently half-done.

**Rulings for Jay:**
1. Launch language list: Spanish-only first-class (recommended), or
   also list FR/PT/DE as best-effort?
2. Voice auto-detect: defer until provider pricing is read
   (recommended), or investigate now?
3. Owner-side language: same workspace setting or a separate
   per-user preference? (Recommend separate user-level — the owner's
   language and the customers' language are different facts.)
4. The 67 tool-message strings stay English in ST5c (flagged seam) —
   acceptable?
5. Sequence ST5a → ST5b → ST5c approved?

Sources: [ConversationRelay TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) · [Voice configuration / picking a voice](https://www.twilio.com/docs/voice/conversationrelay/voice-configuration) · [Automatic language detection changelog](https://www.twilio.com/en-us/changelog/conversationrelay-now-supports-a-configuration-for-automatic-lan) · [WebSocket messages (mid-call language switch)](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
