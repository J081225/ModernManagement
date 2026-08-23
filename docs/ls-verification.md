# LS verification — mid-call language switch + demo-line Spanish
(Read-only look-first, 2026-08-23. Evidence is file:line, DB read-back,
git, and a live suite run. No changes.)

## 1. The switch_language tool — EXISTS, explicit-only, Arabic gated
- Registered in [lib/tools/switch_language.js:28](../lib/tools/switch_language.js#L28);
  engine allowlist [appointment-engine.js:50](../lib/appointment-engine.js#L50);
  **voice-only** filter [appointment-engine.js:161](../lib/appointment-engine.js#L161)
  (`channel === 'voice' || t.name !== 'switch_language'`).
- **Explicit-request-only by description (:29):** "Call ONLY when the
  caller EXPLICITLY asks… NEVER call it because of the language the
  caller happens to be speaking." Auto-detect is nowhere in the path —
  that is the failed spike, by ruling.
- **Languages:** schema enum `['en','es','ar']` (:35), further gated by
  workspace `enabled_languages` AND voice-readiness
  (`voiceLanguageFor(target) !== target` → decline, :61).
- **Arabic with ARABIC_VOICE_ENABLED off:** :61–62 returns
  `language_coming_soon` in the CALLER'S CURRENT language — "…on the
  phone is coming soon — I can't switch just yet. We can keep going in
  [language], or I can take a message for the owner." No switch, no
  re-stamp. Flag on → full peer, same tool, no special-casing
  (LS4/LS5 pin both states in one process).

## 2. The DTMF keypress menu
- [server.js:8314-8329](../server.js#L8314): `enabledSet` read from
  `workspace.enabled_languages` (fallback `[customer_language]`),
  primary listed first (:8318), voice-ready = the `voiceLanguageFor`
  fixed point (:8319). **Menu only when >1 voice-ready language**
  (:8320 — single language goes straight to the relay, byte-identical
  TwiML). Wording: each option in ITS language — "Para español, oprima
  el dos" (:8324-8325), Spanish spoken with `language="es-US"`. The
  relay-menu action re-derives the same choice list (:8367-8372);
  no/invalid digit falls back to the primary — silence never strands
  a call.

## 3. ws21 (demo line (332) 249-4333) — DB right now
`{ id: 21, business_name: "Northside Barbers", customer_language: "en",
enabled_languages: ["en","es"], is_demo: true }` — **Spanish is enabled
and voice-ready** (es is in VOICE_READY unconditionally), so the demo
line fronts the bilingual keypress menu and accepts a spoken
"can we do this in Spanish?" mid-call.

## 4. Deployment status — LIVE on Render
- Commits: `cfc265a` (unit 1) → `156b260` (menu) → `4fa963f`
  (conversation language) → `72efef2` (owner control) → `dae6714`
  (switch_language + ws21 bilingual), all on main;
  `git merge-base --is-ancestor dae6714 origin/main` → YES;
  `main...origin/main` in sync (origin head `71ce214`).
- At ship time (2026-08-22 22:47Z) the deploy was verified live with the
  newer-than-push check; migrations 075/076 confirmed APPLIED; ws21
  backfill read back. Nothing is local-only.

## 5. Pinned suite rows
`scripts/test-language-switch.js` — **9/9 PASSED** on this run,
including LS4 (**flag OFF**: Arabic → coming-soon in the current
language, hook never called) and LS5 (**flag ON**: Arabic switches
exactly like Spanish — fresh-require per state, both exercised in one
process). LS1 pins voice-only + explicit-only + hook threading; LS9
pins the relay wiring + demo caps untouched.

**Net: everything asked about is built, pinned, pushed, and live.**
The one open item in this area is unrelated to code: the
ARABIC_VOICE_ENABLED flip itself stays gated on the native-speaker
greeting pass + the Levantine/Yemeni speaker cells (spike register).
