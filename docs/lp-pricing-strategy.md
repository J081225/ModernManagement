# Pricing strategy → LP arc input (for Jay's final ruling)

Investigation + proposal per the owner rulings. **No code changed** — the
plans table and landing copy are audited, the cost picture is modeled,
and a pricing section is proposed. Awaiting the final ruling to build LP1.

---

## 1. Claims census — the current tier table is mostly fiction

The live PS table (`public/professional-services.html`, Starter $149 /
Pro $295 / Premium $375) differentiates tiers almost entirely on features
that **do not exist in the code**:

| Claimed differentiator | Exists? | Evidence |
|---|---|---|
| **Automatic appointment reminders** | **NO** | No reminder scheduler/cron/sweep anywhere (grep clean). The only "reminder" strings are words inside message copy. This is the *one* feature claimed as "included in Pro" — and it isn't built. |
| **Multi-staff scheduling** | **NO** | `maxUsers: 1` on every tier; zero code (`staff_id`/`assigned_staff` absent). Single-owner only. |
| **Branded SMS sender ID** | **NO** | Not implemented; US A2P sends from the workspace's own number, not an alphanumeric brand. |
| **Priority response queue** | **NO** | No queue exists; the only "priority" is `maintenance_tickets.priority`. |
| **Custom appointment fields** | **NO** | Zero code. |
| **Premium AI setup / dedicated CSM** | service, not software | An onboarding call — real only if Jay does it; not a product feature. |
| **Vendor messaging** | yes (minor) | `message_vendor_for_restock` exists, but it's a PM/inventory restock tool — niche for a salon. |

**And the table OMITS the real headline features (all confirmed live):**
- **Voice AI receptionist** — ConversationRelay (the ST arc). Answers the
  phone, books, answers questions.
- **Spanish (+ Arabic)** — `customer_language`.
- **Transaction report / honest books** — `composeTransactionReport` (TR arc).
- **Honest payments** — Square + Stripe payment links, receipts, and
  real refunds (SQ arc).

**Verdict:** the table over-promises what doesn't exist and hides what
does. Rebuild from the census — live features only.

---

## 2. Unit-cost picture per workspace (so $320 margin is knowable)

**Cost basis (⚠️ estimates — confirm the starred rates against real
Twilio/Anthropic bills; the voice rate is the one that moves the answer):**
- **Voice (the driver):** Twilio ConversationRelay ~$0.06/min* + inbound
  voice ~$0.0085/min + Anthropic **Haiku** for the conversation
  (~$0.01/call). A 4-min AI call ≈ **~$0.30–0.40 all-in.** (Voice runs on
  the cheap model — confirmed `ANTHROPIC_MODEL = haiku-4-5`.)
- **SMS:** Twilio ~$0.0079 + A2P carrier fee ~$0.003 ≈ **~$0.011/msg.**
- **Reports:** Anthropic **Opus 4.6** (`ANTHROPIC_REPORT_MODEL`), ~15k in
  + 4k out ≈ **~$0.50/report.**
- **Text AI conversation (Haiku):** ~**$0.015** each.
- **Telephony fixed:** local number ~$1.15/mo; A2P campaign ~$2/mo
  (shared across all workspaces, amortized ~$0/ws early).
- **Card processing on the $320 charge:** 2.9% + $0.30 ≈ **~$9.60/mo.**
- **Hosting:** Render, fixed/amortized — a couple $/ws at scale.

### Two realistic salons (per month)

| Line | Quiet salon | Busy salon |
|---|---|---|
| AI voice calls | ~60 (2–3/day) → $21 | ~250 (~10/day) → $88 |
| SMS | ~120 → $1.30 | ~450 → $5.00 |
| Reports (Opus) | ~5 → $2.50 | ~20 → $10 |
| Text AI convos | ~80 → $1.20 | ~350 → $5.25 |
| Number + A2P | ~$3.15 | ~$3.15 |
| Card processing | ~$9.60 | ~$9.60 |
| **≈ Total COGS** | **~$39/mo** | **~$121/mo** |
| **Margin @ $320** | **~$281 (~88%)** | **~$199 (~62%)** |
| **Margin @ ~$160 (founding)** | ~$121 (~76%) | ~$39 (~24%) |

**Takeaway:** $320 clears a healthy margin for both the quiet and the
typical busy salon. Voice is ~55–75% of COGS — everything hinges on call
volume, which is exactly the heavy-caller risk.

### Heavy-caller risk + proposed fair-use line

An outlier that routes *every* call to the AI (or a very high-volume
shop) could hit 600–1,000+ calls/mo → voice $210–350 → total COGS
$250–400 → margin thin-to-negative at $320.

**Proposed fair-use line (soft, NOT displayed as metering, NO hard cap):**
> *Fair use: about 1,000 AI-handled voice minutes a month (≈250 calls)
> are included. We'll never cut you off mid-call — if you consistently run
> well beyond that, we'll reach out to find a plan that fits.*

Lives in Terms / a footnote, not on the pricing card. It caps the outlier
through a conversation, honoring "no caps displayed."

---

## 3. Proposed pricing SECTION for the new landing page (LP1 absorbs)

**Framing:** replace-your-front-desk, one price, everything included.

> ## One price. Your whole front desk.
> A full-time receptionist runs $3,000–$4,000 a month. This is **$320.**
>
> **$320 / month** — or **$3,200 / year (2 months free)**
> Everything included. No per-call, per-conversation, or per-appointment caps.
>
> **[ Start free 7-day trial ]**
>
> **Founding customers:** the first 10–15 salons get **~$160/month, locked
> for 12 months** — in exchange for a short testimonial, permission to use
> call recordings, and a monthly feedback call. Help us build it; keep the
> price forever.
>
> **What you get** (all live today):
> - **A 24/7 AI phone receptionist** — answers every call, books
>   appointments, answers questions, takes messages.
> - **Texts back, too** — handles SMS conversations start to finish.
> - **Speaks English & Spanish** (and Arabic).
> - **Takes payment, honestly** — send a secure card link (Square or
>   Stripe), receipts, and real refunds — no surprise fees, no overclaiming.
> - **Your books, done for you** — every sale, deposit, and refund in one
>   honest transaction report.
> - **Calendar, contacts, tasks, and a knowledge base** your AI actually uses.

Two numbers, the founding offer, live features only, receptionist framing.
No tier ladder.

---

## 4. Build implications (after the ruling — LP1 + a small pricing unit)

- **Collapse `lib/plans.js`** to one live plan (retire solo/team/enterprise
  + starter/pro/premium), keep the trial. Update `plan-enforcement` so the
  removed caps/flags don't gate anything (the caps aren't displayed and the
  fair-use line is soft).
- **Founding price** = a locked Stripe price (a coupon or a separate price
  object) applied to the first cohort, honored 12 months.
- **Annual price** = a Stripe annual price ($3,200) — the annual toggle was
  deferred in E11; LP1 re-opens it.
- Rewrite the PS landing pricing block to the §3 copy; delete the
  fictional-feature list (census law — no claim without the feature).

_Awaiting Jay's final ruling on: the $320 number, the fair-use minutes,
and the section copy. Then LP1 builds it._
