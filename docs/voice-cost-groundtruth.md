# Voice cost — ground truth from Twilio usage records
(Read-only, 2026-08-25, Usage Records API, window 2026-06-26 →
2026-08-25. All figures verbatim from the API. No changes.)

## The headline: a live AI call costs ~$0.079/min Twilio-side, all-in
| Category (verbatim) | Count | Usage | Price |
|---|---|---|---|
| **conversation-relay** | 30 calls | **52 minutes** | **$3.64** → **$0.07/min flat** |
| calls-inbound (local) | 8 | 18 minutes | $0.153 → $0.0085/min |
| transcriptions (legacy voicemail) | 1 | 1 | $0.05 |
| recordings/storage | — | ~16 rec-min | $0.017 |

**There is NO separate TTS line item.** No ElevenLabs, Google, Amazon,
or any tts/stt category appears with nonzero usage anywhere in the 60
days — ConversationRelay's **$0.07/minute is all-in** (STT +
ElevenLabs-default TTS + orchestration) as we run it today. The
"premium default voice" carries no visible separate charge at our
usage. (Caveat: that's the empirical bill, not a rate card — BYO
provider keys or future tier pricing could split it; today it
doesn't.)

Per-minute for a live AI call as configured: **$0.07 (relay) +
$0.0085 (inbound leg) ≈ $0.0785/min**, plus Anthropic tokens (not in
Twilio's records; note SPEECH-GRADE added a second model call per
tool turn).

## Demo line per-call
Calls to +1 332 249 4333: **14 calls, 1,380s total (avg ~99s)**; 12
of them since Aug 20 (1,089s, avg ~91s). At ~2 billed minutes per
call: **≈ $0.15–0.16 Twilio-side per demo call**. The 35-min/day
demo cap therefore bounds Twilio exposure at ≈ **$2.75/day** worst
case.

## Reconciliation flag (honest)
`conversation-relay` shows 30 calls/52 min while `calls-inbound`
shows only 8 calls/18 min — yet the call lists show 41 calls across
the demo + 646 lines. Usage records aggregate with a daily lag;
today's heavy test traffic has likely not fully landed in every
category. The derived RATES are solid (they match Twilio's standard
$0.0085 inbound; relay divides to exactly $0.07); the 60-day TOTALS
will drift up a little as aggregation catches up. Re-read after the
next monthly invoice for closure.

## 60-day account context
Total: **$38.71**, dominated by fixed/registration costs — A2P fees
$57 lifetime-window ($21 monthly registration + $19.50 one-time +
$15 vetting + $1.50 campaign), phone numbers $13.85/60d, channels
$21. Usage-proportional VOICE spend was only **≈ $3.86** — voice is
cheap; compliance and numbers are the bill.

## What this settles (pricing-arc backlog)
At $320/mo, one customer funds ≈ **4,000 AI-call minutes/mo** of
Twilio cost (ex-Anthropic) — voice unit economics are not a pricing
constraint at current scale. The voice-cost backlog item is now READ;
next checkpoint is the first invoice after real customer traffic.
