# A2P campaign resubmission — exact field spec

**Campaign: `QE2c6890da8086d771620e9b13fadeba0b` — REUSE IT. Do NOT create a
new campaign.** (A new campaign = new fee, new brand-derived SID, and loses
the history Danny is expediting.) Brand `BNadd0ca7…` stays APPROVED.

**Where:** the **Twilio Console campaign form** (Messaging → Regulatory
Compliance / Trust Hub → A2P → the campaign). The **Usa2p compliance API
does not expose the Privacy Policy / Terms URL fields** — that blank is the
whole reason it kept failing — so this is a Console edit, not an API call.

**Gate:** do NOT submit until the Drive screenshot link (Screenshot 1) is
in the opt-in narrative below. Jay confirms the link is in; then submit.

---

## The two fields that were EMPTY → the actual fix

| Campaign form field | Before | Set to |
|---|---|---|
| **Privacy Policy URL** | *(empty)* — caused **30908** | `https://modernmanagementapp.com/privacy` |
| **Terms & Conditions URL** | *(empty)* — caused **30882** | `https://modernmanagementapp.com/terms` |

These are dedicated URL **fields** on the form (distinct from the
description / message-flow text). The vetter reads them directly. Setting
them is the change Danny told us to make.

---

## Opt-in / message-flow narrative — small edit (keep, don't rewrite)

Keep the existing narrative (the §3.3 opt-in text + the `/sms-terms` link +
STOP/HELP handling). **Add two sentences** describing the now-live consent
surface and the visual proof:

> Consent is collected on a live web opt-in form at
> https://modernmanagementapp.com/sms-opt-in, where the customer enters
> their number and must actively check an unchecked-by-default consent box
> (worded exactly as our program terms) before the form can be submitted;
> consent is not a condition of any purchase. Visual proof of the opt-in
> screen: <PASTE DRIVE SCREENSHOT LINK HERE>.

`<PASTE DRIVE SCREENSHOT LINK HERE>` = the "Anyone with link can view" Drive
link for `screenshot-1-end-user-opt-in.png` (from the capture guide). **This
placeholder is the submit gate — fill it first.**

---

## Everything else — UNCHANGED

Do not touch these (they were never the problem):

- **Use case:** LOW_VOLUME (Low Volume Mixed).
- **Campaign description:** the §3.1 text — unchanged.
- **Sample messages:** the five §3.2 samples — unchanged.
- **Embedded links = Yes, embedded phone = Yes** — unchanged.
- **Messaging Service linkage** — leave the campaign on its current MS; do
  not move it again (moving MS was one of the wrong "cache" fixes and
  changes nothing here).
- Age-gated/SHAFT = No, direct lending = No, affiliate = No — unchanged.

---

## Change summary (what to tell anyone reviewing)

Exactly **three edits** to campaign `QE2c6890…`, all on the Console form:
1. Privacy Policy URL field → `/privacy` (was empty).
2. Terms & Conditions URL field → `/terms` (was empty).
3. Opt-in narrative → +2 sentences (live opt-in form + Drive screenshot link).

Then **submit for re-vet** (Danny expedites). No new campaign, no new fee,
no brand change.
