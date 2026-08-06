# ST6 Investigation — Arabic Through the Verification Pipeline

Owner priority: Dearborn, MI demos — the largest Arabic-speaking
market in the US. Look-first; no product code changed. The §1 samples
are REAL Haiku outputs generated through the real prompt shape
(buildSystemPrompt + the future Arabic Language block), not
assumptions.

## 1. Model quality at Haiku tier — VERIFIED with live samples

Three Dearborn-real scenarios against `claude-haiku-4-5` with our
actual engine prompt (fixture salon, real menu/hours):

**Levantine colloquial booking** («مرحبا كيفك، بدي احجز موعد قصة شعر
لبنتي يوم السبت الصبح») → Sarah replied in matching Levantine
(«تمام التمام… أي تاريخ السبت قصدك — هذا السبت ولا سبت تاني؟») —
warm, natural, correctly disambiguating the date. Minor colloquial
awkwardness («بدي تشوفي» for "would you like to see").

**MSA price + hours** («السلام عليكم، كم سعر صبغة الشعر عندكم؟…») →
proper religious-register response («وعليكم السلام ورحمة الله
وبركاته»), accurate hours from the knowledge base — **but it dodged
the menu price** («تبدأ من سعر معين» — "starts from a certain
price") when Color $120 was in the prompt. The English path quotes
menu prices reliably; the Arabic path hedged. This is the single
biggest quality finding.

**Code-switched reschedule** (hi يعطيكن العافية، عندي appointment
بكرا…) → handled the mixed register naturally (kept "appointment" in
English as the customer did — correct Dearborn register), honestly
said it had no booking on file, asked for the phone number. One
register slip: **«أنا آسف» — masculine apology; Sarah is feminine
(آسفة)**.

**Verdict, honestly:** Haiku Arabic is genuinely good — dialect-
mirroring, warm, accurate on facts it retrieved — and NOT yet
claim-ready without guardrails. The launch gate must include an
**Arabic eval suite**: a price-quoting row (the observed miss), a
feminine-register row (آسفة/سعيدة agreement), and a follow-the-
customer row. These are cheap live-sample rows in the CL suite
pattern.

**Written register (the ruling ask):** MSA is right for CANNED
strings — receipts, payment SMS, templates — it's the written
standard every Arabic speaker reads regardless of dialect, and the
formal register suits money documents. For CONVERSATION, do NOT
force MSA: the samples show the model naturally mirroring the
customer's dialect, which reads warmer to a Levantine speaker than
stiff MSA. Recommended prompt contract: "reply in Arabic, matching
the customer's register; use clear MSA for anything formal."

## 2. Customer strings: inventory, RTL, and SMS economics

**Inventory** (CL1 forces completeness automatically the moment 'ar'
joins LANGUAGES): payment_link_sms, receipt_sms, voice_greeting,
receipt_email_subject, receipt_email_labels (11 labels) — 5 keys.
MSA translations are a small, reviewable set; recommend a native-
speaker review pass before the claim ships (Jay has Dearborn
contacts; one page of strings).

**The RTL seam (receipt EMAIL):** the template needs
- `dir="rtl" lang="ar"` on the container (flips table columns,
  text flow, and the label/amount alignment semantics correctly in
  every mail client that honors dir — the table's text-align:right
  amount cells become text-align:left mirror-images, so alignment
  must switch to logical or per-language values);
- **bidi-safe amounts**: `$45.00` is an LTR run inside RTL text —
  wrap amounts and reference numbers in `<span dir="ltr">` or the
  layout shows "45.00$#88" artifacts;
- **numerals ruling needed**: ar-US locale dates can render Eastern
  Arabic numerals (٤٥) — recommend Western digits via
  `ar-u-nu-latn` locale for amounts/dates (matches how Dearborn
  businesses write prices) — one line in shortDate/longDate.
- SMS is plain text: RTL handled by the phone; only the bidi-run
  ordering of amounts/URLs needs eyeballing on a real device.

**SMS encoding economics (the pricing flag):** any Arabic character
forces UCS-2: **70 chars/segment (67 when concatenated) vs 160
(153) for GSM-7**. Our receipt SMS (~140 chars in English) becomes
2–3 segments in Arabic — roughly **2–3× the per-message carrier
cost** on every Arabic SMS. Not a blocker; a real line item for the
Dearborn unit economics. (Also A2P throughput is counted in
segments.)

## 3. Voice, read honestly: NOT claimable today

Two stacked unknowns, either fatal to an honest claim:

1. **Availability is unverified.** Twilio's TTS catalog carries
   Arabic voices (e.g. ar-AE Gulf tier), but ConversationRelay's
   TRANSCRIPTION language list is provider-dependent (Google/
   Deepgram) and the docs I could reach do not confirm an Arabic STT
   locale for ConversationRelay sessions. This needs a live spike —
   configure `language="ar-AE"` (and Google-provider variants) on a
   test call and see what the session accepts — before anything is
   promised.
2. **The dialect reality is the harder wall.** Dearborn callers
   speak Levantine, Yemeni, and Iraqi Arabic, heavily code-switched
   with English. Production STT for Arabic is MSA-biased; dialectal
   accuracy is the known weak spot industry-wide, and code-switching
   compounds it. The failure mode is ugly: an Arabic greeting sets
   the expectation that Sarah UNDERSTANDS Arabic speech; if STT
   feeds her garbage, the customer gets nonsense in fluent Arabic —
   worse than honest English.

**Recommendation: text-first, exactly like the Spanish precedent.**
The control's per-channel truth says so: "Texts: Arabic. Phone
calls: English for now." Do NOT ship an Arabic voice greeting before
Arabic STT is proven — a greeting-only ship is an overclaim by
behavior. The voice spike (a real test-call protocol with native
speakers across the three dialects) is its own gated checkpoint.

## 4. What Arabic requires mechanically (small, by design)

The ST5a architecture makes this a widening, not a build:
- Migration 064: widen the CHECK to `('en','es','ar')`.
- `CUSTOMER_LANGUAGES` + strings-module `LANGUAGES` gain 'ar' — CL2
  forces all three together; **CL1 then FAILS until every key
  declares its ar variant** (the census working as designed).
- The engine Language block gains the ar branch (register contract
  from §1); the control gains the option with per-channel truth.
- New: the RTL/bidi handling in generateReceiptHTML (dir, ltr spans,
  nu-latn) and the numerals decision.
- New: the Arabic eval rows (price-quoting, feminine register,
  follow-the-customer) — the §1-mandated launch gate.

## 5. The split and the honest timeline

- **ST7a — Arabic text** (build-ready once rulings land): column
  widening + strings (with native review) + prompt branch + RTL
  receipt + eval rows + control option with per-channel truth.
  Everything verified in §1 except the native string review. This is
  DAYS of work, demo-able in Dearborn on text + receipts.
- **ST7b — Arabic voice SPIKE** (gated, not promised): live
  ConversationRelay ar-locale test + native-speaker dialect calls.
  Claim nothing until it passes; the Spanish per-channel-truth
  pattern carries the honesty until then.

**Rulings for Jay:**
1. §1's launch gate (the three Arabic eval rows) — approved as the
   claim condition?
2. Native-speaker review of the MSA strings before ship — who?
3. Numerals: Western digits (recommended) or Eastern Arabic?
4. ST7b voice spike: authorize the test-call protocol now or after
   the text demo?
5. The SMS segment-cost line item — acceptable for Dearborn
   economics as stated?

Sources: [ConversationRelay TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) · [Voice configuration](https://www.twilio.com/docs/voice/conversationrelay/voice-configuration) · [Twilio TTS voices](https://www.twilio.com/docs/voice/twiml/say/text-speech) · [Auto language detection changelog](https://www.twilio.com/en-us/changelog/conversationrelay-now-supports-a-configuration-for-automatic-lan)
