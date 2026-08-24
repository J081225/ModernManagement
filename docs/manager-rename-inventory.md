# MANAGER RENAME — "assistant" inventory
(Read-only, 2026-08-24. ~115 case-insensitive "assistant" hits + 13
"Sarah" hits swept across server.js, lib/, views/, public/. No changes.)

## 1. USER-VISIBLE occurrences, by surface

### App UI (views/app.html) — the biggest surface
Panel identity:
- [16498](../views/app.html#L16498) cc-tab: label **"Assistant"** + aria "Open assistant (press /)"
- [16501](../views/app.html#L16501) panel header: **"Assistant"**; [16499](../views/app.html#L16499) aria "AI assistant panel"; [16502](../views/app.html#L16502) aria "Close assistant"
- [15582-15583](../views/app.html#L15582) panel greeting: *"I'm your AI assistant. Ask me anything about your business/portfolio, or try one of these:"*

Home + My Business:
- [2352](../views/app.html#L2352) section label "AI Tools — **your assistant**"; [2360](../views/app.html#L2360) card "**Ask your assistant**"
- [3141](../views/app.html#L3141) "Your **AI assistant's** email replies send from this address."
- [3154](../views/app.html#L3154) "Customers can email this address — messages reach your inbox and your **AI assistant**…"
- [5691](../views/app.html#L5691) "Your **AI assistant** replies from <platform_from>."
- [3799](../views/app.html#L3799), [3805](../views/app.html#L3805) knowledge card: "Tell **your assistant** about your business…" / "The more **your assistant** knows…"
- [3962-3963](../views/app.html#L3962) card "**How your assistant works**" + subtitle; toggles [3973-3984](../views/app.html#L3973) "Let **my assistant** reply to customers…" / "…book appointments automatically"; hints [3999](../views/app.html#L3999), [4011](../views/app.html#L4011)
- [4133](../views/app.html#L4133) "What **your assistant** may do on its own" + the six approval descriptions [14657-14673](../views/app.html#L14657) ("**Your assistant** books, reschedules…")
- [14606](../views/app.html#L14606) saved toast "…**your assistant** serves customers in English."
- [15919](../views/app.html#L15919) onboarding: "the more **your assistant** knows about your business…"

### Landing + marketing pages
- [public/index.html:7](../public/index.html#L7), [:342](../public/index.html#L342) (PM chooser page): "Modern Management is an **AI assistant** that runs/handles the operations of your business…"
- [public/landing-next.html:1015](../public/landing-next.html#L1015) room label "**The Assistant**"; [:1017](../public/landing-next.html#L1017) img alt "The **assistant** chat…"; [:1087](../public/landing-next.html#L1087) feature-grid item "The on-every-screen **assistant**"
- [public/professional-services.html:7](../public/professional-services.html#L7)/[:9](../public/professional-services.html#L9) meta+og "An **AI assistant** for service businesses…"; [:380](../public/professional-services.html#L380) hero-sub same
- [public/property-management.html:7](../public/property-management.html#L7), [:298](../public/property-management.html#L298), [:438](../public/property-management.html#L438) "…handled by an **AI assistant**…" / "Ready to run your property business with an **AI assistant**?"
- [public/why-ai.html:54](../public/why-ai.html#L54) "…feel less like software and more like an **assistant**."; [:143](../public/why-ai.html#L143) "…the AI equivalent of hiring a careful, thoughtful **assistant**…"
- [public/features/knowledge-base.html:110](../public/features/knowledge-base.html#L110) "the employee handbook for your **AI assistant**"

### Signup
- views/signup.html: **zero occurrences** (form copy is assistant-free).

### Emails / SMS templates
- Welcome email ([lib/signup-orchestrator.js:80](../lib/signup-orchestrator.js#L80), [:178](../lib/signup-orchestrator.js#L178), [:197](../lib/signup-orchestrator.js#L197), [:211](../lib/signup-orchestrator.js#L211), [:228](../lib/signup-orchestrator.js#L228)): subject "Welcome to Modern Management — **your AI assistant** is ready" + body/checklist ("…under 'How **your assistant** works'"). NOTE: the checklist item names the app card — renaming the card renames this string too or they drift.
- SMS templates: **zero** — no canned SMS contains "assistant" (CTIA STOP/HELP replies say "appointment & account texts").

### The five A2P compliance pages
- /privacy, /terms, /sms-terms, /sms-opt-in, /sms-consent: **ZERO
  occurrences of "assistant"** — the rename cannot touch the A2P
  surfaces. (Their AI language says "AI features" / "the AI".)

### Voice greeting / system prompts
- Voice greeting ([lib/customer-strings.js:103-107](../lib/customer-strings.js#L103)): "Hi, thanks for calling <business>. How can I help you today?" — **contains neither "assistant" nor any AI mention** (see §3 flag).
- Engine system prompt [lib/appointment-engine.js:383](../lib/appointment-engine.js#L383): "You are the **AI assistant** for <business>…" — shapes what the AI calls itself if a caller asks. [:531](../lib/appointment-engine.js#L531) already says "You are this business's **receptionist**…" (B2 scope contract).
- Owner-panel prompts [server.js:6906-6907](../server.js#L6906): "You are an **AI command center assistant** for…" (PS + PM variants).
- Draft/task prompts [server.js:6509](../server.js#L6509), [:7277](../server.js#L7277), [:7492-7493](../server.js#L7492): "You are a professional property management **assistant**…"

### "Sarah"
- User-visible: only [professional-services.html:379](../public/professional-services.html#L379) — "— Sarah, salon owner" (a TESTIMONIAL attribution: Sarah is the OWNER there, not the AI) and a fixture tenant "Sarah Park" ([features/maintenance.html:145](../public/features/maintenance.html#L145)). Neither uses assistant language.
- All other 11 hits are code comments — and they are INCONSISTENT:
  engine comment says "Sarah is a receptionist" (the AI) while tool
  comments say "Sarah taps approve" (the owner). Worth a comment
  cleanup ruling someday; zero user impact.

## 2. CODE-ONLY identifiers — RECOMMEND KEEP (churn, zero user value)
- CSS/JS: `body.assistant-open` (+4 CSS refs), `openAssistant()` / `collapseAssistant()` / `buildAssistantContext()`, sessionStorage key `assistantOpen` (renaming resets users' panel state), ~10 comments (app.html 1774-2006, 15402-15446).
- **The `'assistant'` message ROLE** ([server.js:6777-6781](../server.js#L6777), [:7174](../server.js#L7174), [:7248](../server.js#L7248), [app.html:15702](../views/app.html#L15702)): this is the Anthropic API role string and DB history value — **must never be renamed**, it is a wire/schema contract, not copy.
- `lib/assistant-honesty.js` (module + require [server.js:125](../server.js#L125)) and comments in lib/tools/* (finalize_transaction, request_payments_batch), [server.js:10759-10760](../server.js#L10759) no-self-approve comments.
- `update_ai_settings` tool internals ([lib/tools/update_ai_settings.js:12](../lib/tools/update_ai_settings.js#L12)) — but its :29/:57 MESSAGES ("Only the business owner can change assistant settings." / "Assistant settings updated:") are spoken/shown to the owner → those two strings belong in §1, not here.

## 3. DISCLOSURE sentences — the carve-out category
Sentences whose JOB is disclosing AI/automation (rename only under an
explicit ruling; changing them changes what we disclose):
- Privacy §4 "AI Processing Disclosure" + Terms §5 "AI-Generated Content" — say "AI features"/"the AI", never "assistant": **rename-proof already**.
- Panel greeting "I'm your **AI assistant**…" (app.html:15582-15583) — the one first-person self-disclosure in the product.
- Engine prompt self-conception ("You are the **AI assistant** for…", engine:383) — governs the answer to "am I talking to a robot?".
- Landing hero eyebrow "AI RECEPTIONIST FOR BUSINESSES THAT TAKE BOOKINGS" (landing-next) — the public AI framing uses **receptionist**, not assistant.
- **FLAG: the voice greeting contains NO AI disclosure at all.** Callers are not told they're talking to an AI unless they ask. Whatever the rename ruling says, this is a standing exposure worth its own ruling (several states now expect bot disclosure on outbound calls; inbound is grayer).

## 4. "Manager" collisions — where the word already means a HUMAN
- **"Manager review"** — the auto-reply-OFF mode is literally named this ([app.html:4096](../views/app.html#L4096), API field `managerReviewRequired` :6333): here "manager" = the human owner reviewing the AI. A rename of the AI to "manager" makes this card read as the AI reviewing itself. **Direct collision — needs renaming or re-ruling first.**
- "Dedicated Success Manager" ([app.html:9725](../views/app.html#L9725)) — a human employee of ours (plan copy).
- **"Property manager"** — pervasive on PM surfaces AND the legal pages (privacy uses it 4×, sms-consent 7×, terms 2×, why-ai/how-it-works ~6 each) meaning the human customer/controller of data. On any shared surface, "your AI manager" next to "the property manager is the controller of your data" is genuinely confusing.
- "document manager" (knowledge base UI comments), `PushManager` (browser API) — code-only, keep.

## Net counts
User-visible rename candidates: ~45 strings (app UI ~28, landing ~13,
welcome email 5, tool messages 2). Code-only keep: ~35. Disclosure
carve-outs: 4 surfaces + the missing-voice-disclosure flag. Collisions:
2 hard ("Manager review", property-manager-on-shared-surfaces), 1 soft
(Success Manager).
