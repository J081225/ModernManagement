# Front Desk Investigation — Map of Today's Truth

Read-only investigation ahead of the "front desk arc" (one brain across voice/SMS/panel, per-action autonomy policy, conversation playbook, approval-gated deposits, reflection pass). Every claim cites `file:line` as verified on this working tree (branch `main`, HEAD `dc947aa`). Sections 1–6 are factual; Section 7 is the only opinion section.

---

## 1. THE TWO CONVERSATION LOOPS

### (a) The SMS engine loop

**Entry.** Twilio POSTs to `/api/sms/incoming` (`server.js:5798`). The inbound row is persisted to `messages` first (`server.js:5812-5815`), then — for PS workspaces with `appointment_auto_respond` true (`server.js:5836`) — the message is handed to `appointmentEngine.processInboundMessage` with `channel: 'sms'`, `contact: null`, and `customer_phone` = Twilio `From` (`server.js:5837-5849`).

**System prompt built at** `lib/appointment-engine.js:92` by `buildSystemPrompt` (`lib/appointment-engine.js:230-378`). What it includes:

- **Business timezone + "now"**: workspace-local weekday/date/time via `wsTz` (`lib/appointment-engine.js:251-259`), plus an offset-aware ISO instruction (`lib/appointment-engine.js:260`).
- **Hours / policies**: entirely from the knowledge base — "## Business knowledge (hours, services, policies)" (`lib/appointment-engine.js:262-270`), loaded by `loadKnowledge` (up to 50 docs, 800 chars each, `lib/appointment-engine.js:161-171`, truncation at `:267`). There is no structured hours table; knowledge docs are the only hours source.
- **Services/menu**: `loadMenu` (active, non-archived, up to 200 items, `lib/appointment-engine.js:215-228`) rendered as Services/Products/Add-ons with prices and durations (`lib/appointment-engine.js:272-308`).
- **Caller's own appointments only**: `loadCallerAppointments` (`lib/appointment-engine.js:180-211`) matches by normalized phone or email, 60-day window, 10 max; rendered at `lib/appointment-engine.js:313-321`. The workspace-wide schedule is deliberately absent (FD2 comment, `lib/appointment-engine.js:173-179`).
- **Thread memory**: `context_summary` verbatim (`lib/appointment-engine.js:323-324`).
- **Job rules + FD1 name collection + personality**: `lib/appointment-engine.js:326-346`; `ai_tone` block `:353-365`; `ai_sales_posture` block `:367-375`.

**Tools.** `APPOINTMENT_TOOL_NAMES = ['book_appointment', 'update_appointment', 'cancel_appointment', 'propose_appointment_times', 'escalate_appointment_to_owner', 'add_task']` (`lib/appointment-engine.js:42-49`), intersected with the plan/vertical registry by `buildToolListForEngine` (`lib/appointment-engine.js:380-385`). `add_calendar_event` is deliberately excluded (`lib/appointment-engine.js:39-41`).

**Caller identity.** Enters as `customer_phone` (Twilio `From`); the route always passes `contact: null` (`server.js:5839`), so the prompt's "customer is on file" branch (`lib/appointment-engine.js:246`) and the "known contact, do NOT ask for their name" branch (`lib/appointment-engine.js:341`) are dead in practice — identity resolution happens inside tools via phone matching (`lib/tools/book_appointment.js:61-70`, `lib/customer-scope.js:17-39`). `customer_phone`/`customer_email` and `origin.appointment_thread_id` ride into every tool ctx (`lib/appointment-engine.js:411-429`).

**Turn shape.** Exactly **one model call per turn** (`anthropic.messages.create`, max_tokens 1024, `lib/appointment-engine.js:104-110`). **No agentic loop**: `executeAIResult` runs each `tool_use` block once and concatenates tool result messages onto the reply text, but tool results are never fed back to the model (`lib/appointment-engine.js:394-441`). The reply is sent as SMS via Twilio (`lib/appointment-engine.js:447-453`), persisted as an outbound `messages` row (`lib/appointment-engine.js:455-465`), and the thread's `context_summary` is appended (each turn stored as `Customer: <120 chars> | AI: <120 chars>`, 12-line rolling window — `lib/appointment-engine.js:51, 488-505`).

### (b) The voice ConversationRelay loop

**Entry.** A call to the test number hits `/api/voice/relay-incoming` (`server.js:6036-6082`), which returns `<Connect><ConversationRelay url="wss://<host>/twilio-relay" welcomeGreeting=.../>` (`server.js:6074-6081`). The greeting is **hardcoded in the TwiML**, not model-generated (`server.js:6072`). Twilio then opens a WebSocket to the handler at `server.js:8443-8564`.

**The voice loop calls the same brain.** On each `prompt` message (one transcribed utterance), the WS handler calls `appointmentEngine.processInboundMessage` with `channel: 'voice'`, `contact: null`, `customer_phone` = the `setup` message's `from` (`server.js:8514-8526`). There is **no separate reduced path** — prompt build, context loads, and tools are identical to SMS. Three voice-specific differences inside the shared engine: (1) the prompt gains a "Phone call style" block when `thread.inbound_channel === 'voice'` (`lib/appointment-engine.js:327-332`); (2) `executeAIResult` **skips** the auto-SMS/email send for `channel === 'voice'` (`lib/appointment-engine.js:443-447`) — the reply is instead spoken via `ws.send({type:'text', ...})` after markdown-stripping (`server.js:8465-8471, 8456-8463, 8528-8529`); (3) if the engine returns `handled:false` (e.g. `appointment_auto_respond` off — checked inside the engine at `lib/appointment-engine.js:60-62`; the WS route has no pre-gate), the caller hears a canned "let me take a message" line but **no message is actually taken** (`server.js:8533-8536`).

**Per-call state** lives only in the connection closure (`workspace`, `callSid`, `callerPhone` — `server.js:8446-8449`); there is no local conversation array (comment `server.js:8436-8438`). `interrupt` messages are logged and ignored (`server.js:8540-8543`). Model calls per turn: one, same as SMS.

### (c) Voicemail: a variant of SMS's loop, not a third loop

`/api/voice/incoming` (legacy numbers) plays a greeting and records with `transcribeCallback` → `/api/voice/transcription` (`server.js:5893-5901`). The transcription handler updates the placeholder `messages` row with the transcript (`server.js:5936-5944`), then invokes **the same** `processInboundMessage` with `channel: 'voicemail'`, `contact: null` (`server.js:5963-5980`). Because `executeAIResult` sends for every channel except `'voice'` (`lib/appointment-engine.js:447`), the AI's reply to a voicemail goes out **as an SMS** to the caller. Verdict: voicemail is the SMS loop fed by a transcript, not a third loop.

**Thread sharing across channels:** `findOrCreateThread` keys on `customer_phone` only, ignoring channel (`lib/appointment-engine.js:142-149`); `inbound_channel` is stamped only at creation (`lib/appointment-engine.js:151-157`). So one open thread per phone number is shared by SMS, voicemail, and voice — and the "Phone call style" block keys off the thread's *creation* channel (`lib/appointment-engine.js:327`), so a thread opened by SMS and continued by phone call never gets the voice style block (and vice versa: a voice-opened thread continued by SMS keeps phone-call brevity rules).

### DELTA TABLE

| Dimension | SMS engine loop | Voice WS loop |
|---|---|---|
| Brain | `processInboundMessage` (`server.js:5837`) | **Same function** (`server.js:8514`) |
| Prompt, context loads, tools | Full set above | Identical, plus voice-style block (`lib/appointment-engine.js:327-332`) |
| Contact param | `null` (`server.js:5839`) | `null` (`server.js:8516`) — parity, both dead |
| Inbound persistence | `messages` row (`server.js:5812-5815`); voicemail transcript (`server.js:5941-5944`) | **Nothing.** No `messages` row anywhere in the WS handler (`server.js:8445-8564`) |
| Outbound persistence | Outbound SMS row (`lib/appointment-engine.js:455-465`) | **Nothing** — send block skipped (`lib/appointment-engine.js:447`), WS only speaks |
| Owner notification | Email + push on inbound (`server.js:5818-5819`, `5946-5947`) | **None** |
| Emergency keyword gate | Yes, when engine falls through (`server.js:5856-5869`, `5988-6007`) | **No** — fallback is a canned spoken line (`server.js:8534-8536`) |
| Auto-reply / suggest-tasks fallback | Yes (`server.js:5871-5873`, `6009-6011`) | **No** |
| Twilio auth | `validateTwilioSignature` on the route (`server.js:5798`, `5927`) | TwiML route validated (`server.js:6036`) but the **WS connection itself has no signature/auth check** (`server.js:8445`) |
| Greeting | Model-generated first reply | Hardcoded TwiML `welcomeGreeting` (`server.js:6072`) |
| Reply latency shape | Async (SMS) — single blocking model call is fine | Live call — same single blocking model call + tool execs per utterance (`lib/appointment-engine.js:104-131`) |
| Per-turn memory | `context_summary`, 12 lines × ~240 chars/turn (`lib/appointment-engine.js:51, 488-505`) | **Same rows** (voice turns also call `updateThreadContext`, `lib/appointment-engine.js:121-125`); closure holds only `workspace/callSid/callerPhone` (`server.js:8446-8449`), discarded on close (`server.js:8554-8559`) |
| Booking `source` value | AI passes `ai_inbound_sms` etc.; default fallback is `ai_inbound_sms` for any `ai_inbound` origin (`lib/tools/book_appointment.js:109-110`) | Schema enum for the tool has **no voice value** (`lib/tools/book_appointment.js:34`); the appointments CHECK has none either (`migrations/phase1-additive/035_appointments.sql:73-76`) — voice bookings get labeled as SMS |

Nothing SMS's brain *can do* that voice's cannot (same tool list); the deltas are entirely in persistence, safety fallbacks, notification, and delivery.

---

## 2. AUTONOMY TODAY

### The four My Business knobs

All four are read/written through `GET/PATCH /api/workspace/ai-settings` (`server.js:8062-8150`), saved by `mbSaveAISettings` (`views/app.html:12258-12297`), and also writable via the approval-gated `update_ai_settings` tool (`lib/tools/update_ai_settings.js:12-48`, `requiresApproval: true` at `:26`).

| Setting | UI control | Write path | Runtime reads |
|---|---|---|---|
| `appointment_auto_respond` | Checkbox `#mbAutoRespond` (`views/app.html:3714`) | PATCH → `workspaces.appointment_auto_respond` (`server.js:8096-8099`) | Master engine gate (`lib/appointment-engine.js:60-62`); route pre-gates at `server.js:5836` (SMS) and `server.js:5963` (voicemail). The voice WS has no pre-gate — it relies on the engine's internal check (`server.js:8514` invokes unconditionally). |
| `appointment_auto_confirm` | Checkbox `#mbAutoConfirm` (`views/app.html:3724`) | PATCH → column (`server.js:8100-8103`) | **One read**: `lib/tools/book_appointment.js:108` — initial status `'confirmed'` vs `'requested'` (which also picks the thread state, `lib/tools/book_appointment.js:156`). (The comment at `server.js:8051-8053` says "read at book_appointment.js:66" — stale; the read is at `:108`.) Additionally, the Stripe webhook can independently promote `requested → confirmed` on full payment (`lib/payment-ledger.js:229-237`). |
| `ai_tone` | Select `#mbTone` (`views/app.html:3743-3749`) | PATCH → column, validated against `['warm','professional','brief']` (`server.js:8059, 8104-8113`) | **Customer engine only**: `lib/appointment-engine.js:353-365`. The owner-panel `/api/command` prompt never reads it (no reference anywhere in `server.js:4806-5299`). |
| `ai_sales_posture` | Select `#mbSalesPosture` (`views/app.html:3755-3760`) | PATCH → column (`server.js:8114-8122`) | **Customer engine only**: `lib/appointment-engine.js:367-375`. Not read by `/api/command`. |

None are "written but never read," but `ai_tone`/`ai_sales_posture` are read by exactly one of the two brains.

### The SMS auto-reply-vs-approval fork

Order of decision in `/api/sms/incoming` (mirrored in `/api/voice/transcription` at `server.js:5988-6014` and `/api/email/incoming` at `server.js:5679-5681`):

1. **Engine first** — if it handles, everything else is short-circuited (`server.js:5829-5856`).
2. **Emergency keyword gate** — `detectEmergency` (`server.js:5388-5399`, keyword list `:5361-5375`); a hit flags the row and alerts the owner, no auto-reply (`server.js:5858-5869`).
3. **`getAutomation(userId).autoReplyEnabled`** (`server.js:5871`; helper reads the `automation` table, `server.js:1021-1027`): `true` → `autoReplyToMessage` sends immediately (PM-flavored prompt, `server.js:5468-5509`) and then also suggests tasks (`server.js:5505`); `false` → `suggestTasksFromConversation` only (`server.js:5873`).

The UI for this is the Operations "Automation settings" radio pair — `#autoReply` value `auto` (`views/app.html:2550`) vs `#requireReview` value `review` (`views/app.html:2557`), saved by `saveAutomation` (`views/app.html:4974-5010`). Enabling routes through a consent modal → `POST /api/automation/consent` with audit logging (`server.js:4310-4330`); disabling goes through `PUT /api/automation` (`server.js:4269-4303`). Notable: "Manager review" mode does **not** queue an AI draft for review — the non-auto branch only creates suggested tasks (`server.js:5873`); no draft reply is generated or queued anywhere on that path (drafts exist only via the manual `POST /api/generate`, `server.js:4603-4648`).

### Bug hunt (a): AI asks permission to add a contact

The customer engine can't add contacts at all (`add_contact` is not in `APPOINTMENT_TOOL_NAMES`, `lib/appointment-engine.js:42-49`; bookings auto-create contacts silently, `lib/tools/book_appointment.js:79-96`), so the hesitation lives in the **owner panel `/api/command` prompt**. Most likely home, in order:

1. `server.js:5038` — *"If the screen context cannot resolve a reference, ask ONE short clarifying question — never guess a date **or a person**."* This is the strongest generalized ask-before-person-actions instruction in the prompt.
2. `server.js:5068` — the CRITICAL DISAMBIGUATION RULE: *"when the user references a property, unit, **or contact** by name … do NOT call the tool — instead reply with a clarifying question."* Written for inventory tools, but it names contacts and trains ask-first behavior around person records.
3. A contributing mismatch: PS workspaces are told to call people **"customers"** (`server.js:5000`), while `add_contact`'s schema only offers `contact_type ∈ ['resident','vendor','important']` (`lib/tools/add_contact.js:17`) and the prompt's hardcoded tool list describes it as "add **residents, vendors, or important contacts**" (`server.js:5046`) — that PM-flavored tool list at `server.js:5040-5057` is injected verbatim regardless of vertical, so the PS model faces a category it can't cleanly map, a classic trigger for "Would you like me to add them as…?" hedging.

### Bug hunt (b): "this coming Tuesday" date wobble

- **Owner command prompt**: `Today's date is ${new Date().toISOString().split('T')[0]}.` (`server.js:5036`) — the **UTC** calendar date, with **no weekday and no timezone**. For a US-timezone workspace, from ~7–8 PM local until midnight, this is *tomorrow's* date; the model resolves "this coming Tuesday" from the wrong "today" and lands one day off. Even mid-day, giving a bare date with no weekday forces the model to compute day-of-week arithmetic itself, which is error-prone.
- **Engine prompt**: workspace-local and weekday-anchored — `Right now it is ${nowInTz}` rendered with `timeZone: wsTz(workspace)`, `weekday: 'long'` (`lib/appointment-engine.js:251-259`), plus tools that interpret naive times in workspace tz (`lib/time-helpers.js:60-85`, `lib/tools/book_appointment.js:98-104`).

The discrepancy is exactly the off-by-one-day generator: two brains, two date anchors — UTC-date-no-weekday (`server.js:5036`) vs local-datetime-with-weekday (`lib/appointment-engine.js:252-259`). The same UTC-date pattern also appears in `suggestTasksFromConversation` (`server.js:5303`) and the daily nudge (`server.js:2529`).

---

## 3. THE APPROVAL SYSTEM

**Schema.** `pending_actions` (`migrations/phase1-additive/028_pending_actions.sql:7-19`): `workspace_id`, `user_id`, `tool_name`, `input JSONB`, `ai_summary`, `status` (default `'pending'`), `result JSONB`, `created_at`, `resolved_at`, `resolved_by`; indexes on (workspace, status) and (workspace, created_at) (`:21-24`).

**What queues into it.** Exactly one writer in the codebase: the `requiresApproval` divert inside `/api/command`'s agentic loop — instead of executing, the tool call is INSERTed with a human-readable summary from `buildPendingActionSummary` (`server.js:5159-5196`; INSERT at `:5164-5175`; summary builder `server.js:4680-4717`). Eleven tools carry `requiresApproval: true` today: `compose_message`, `message_vendor_for_restock`, `request_payments_batch`, `reply_to_message`, `send_broadcast`, `send_email`, `refund_transaction`, `send_late_notice`, `send_sms`, `update_ai_settings`, `update_knowledge` (each at its `requiresApproval: true` line, e.g. `lib/tools/request_payments_batch.js:44`, `lib/tools/send_sms.js:35`). Nothing else writes rows.

**What the UI shows.** Three surfaces, all read-only renders of `tool_name` + `ai_summary` + relative queue time with Approve/Reject buttons:
- Home approval card `#approvalQueueCard` (`views/app.html:2305`), loaded on every Home navigation (`views/app.html:4211-4214`), rendered by `loadApprovalQueue` from `GET /api/pending-actions?status=pending` (`views/app.html:8999-9033`; endpoint `server.js:6998-7016`, LIMIT 100).
- PS dashboard "approvals" card `renderPSApprovalsList` (`views/app.html:8410-8430`), fed by `GET /api/dashboard/ps` (`server.js:2407-2427`).
- Inline chips in the command reply (`queued`/`pendingId`/`summary` on action chips, `server.js:5250-5258`).

**What approve/reject execute.** `POST /api/pending-actions/:id/approve` (`server.js:7018-7074`): flips status to `'approved'` (`:7038-7043`), then **re-runs `tool.execute(pending.input, ctx)`** with a **freshly built ctx** from `buildExecutorContext(req)` — current workspace row, current user, live db/mailer/sms/stripe clients (`server.js:7054-7057`; builder `server.js:4656-4676`). Final status becomes `'executed'` or `'failed'` with the result JSON stored (`server.js:7063-7067`). So approval-time execution sees *current* state, not proposal-time state (which `request_payments_batch` exploits with live re-checks, `lib/tools/request_payments_batch.js:88-116`). `POST /api/pending-actions/:id/reject` only sets `'rejected'` + `resolved_by` (`server.js:7076-7106`) — nothing executes.

**Is the owner notified?** **No.** The queue INSERT block (`server.js:5161-5196`) sends nothing. `sendPushNotification`/`sendNotificationEmail` fire only for inbound messages (`server.js:5660, 5819, 5947`; `:5818`). The owner discovers pending actions only by looking: Home navigation triggers `loadApprovalQueue` (`views/app.html:4214`) and the PS dashboard polls (`views/app.html:4220`).

**What expires or lingers.** Nothing expires. There is no DELETE, TTL, or sweep for `pending_actions` anywhere; the only scheduled cleanups are signup drafts and reset tokens (`server.js:644-675`). Un-actioned rows sit `'pending'` forever (the GET just filters and limits, `server.js:7004-7009`).

**FD2 engine-side interaction.** The customer engine has no queue: if a tool with `requiresApproval` ever enters the engine allowlist, the engine **refuses at dispatch** — logs, records `{success:false, message:'requires owner approval'}` in `used_tools`, and continues (`lib/appointment-engine.js:406-410`). Same flag, two behaviors: owner-side → queued pending action (`server.js:5161`); customer-side → hard refusal with **nothing** landing in the owner's queue. Today the branch is dormant — none of the six allowlisted engine tools carries the flag (`lib/appointment-engine.js:42-49` vs the eleven-tool list above).

---

## 4. SUGGESTIONS TODAY

**When it runs.** `suggestTasksFromConversation` (`server.js:5302-5345`) is called from five places:
1. `/api/sms/incoming` — engine didn't handle, no emergency, auto-reply off (`server.js:5873`);
2. `/api/voice/transcription` — same conditions (`server.js:6011`);
3. `/api/email/incoming` — same conditions (`server.js:5679-5681`);
4. `autoReplyToMessage` — after every successful auto-reply, with the reply text included (`server.js:5505`);
5. `POST /api/maintenance` — on every manually created ticket (`server.js:3832-3835`).

It never runs for the live-voice channel, and never when the appointment engine handled the turn (`server.js:5856, 5988`).

**What its prompt asks.** System: *"You are a **property management** assistant that identifies follow-up tasks from resident communications. Return ONLY a valid JSON array…"* with fields `title, category (maintenance|vendor|lease|finance|other), dueDate, notes, aiReason` (`server.js:5308`). This PM framing is used even for PS workspaces — there is no vertical branch. User content: **one message** (`message.text`) + optional reply text + UTC "Today's date" (`server.js:5311-5326`), with rules about emergencies/promises/maintenance (`server.js:5318-5324`).

**What it writes.** One `tasks` row per suggestion with `suggested=true` and `aiReason` (`server.js:5334-5340`). **No cap** (the loop inserts every array element), **no dedup** (repeated texts about the same issue create duplicate suggested tasks), **no expiry** (nothing ever sweeps suggested tasks).

**Where it surfaces.** The Tasks page "AI Suggested Tasks" banner `#suggestedSection` (`views/app.html:2944-2956`), rendered by `renderTasks` with the `aiReason` chip (`views/app.html:7148-7175`, chip `:7165`), plus a count stat-chip (`views/app.html:7145`). Approve → `PUT /api/tasks/:id/approve` sets `suggested=false` (`server.js:3765-3772`); Reject → `DELETE /api/tasks/:id/reject` hard-deletes (`server.js:3774-3777`).

**Capability assessment (factual).**
- **Sees one message, not the conversation**: input is `message.text` (+ reply when called from auto-reply) — no thread `context_summary`, no message history (`server.js:5313-5316`).
- **Evidence citation**: `aiReason` is a free-text explanation (`server.js:5308`); the only provenance is the default `notes` fallback naming sender/subject (`server.js:5338`). No structural pointer (no `message_id`/`thread_id` column on `tasks` — INSERT column list at `server.js:5337`).
- **The chassis already carries non-model writers**: escalations (`lib/tools/escalate_appointment_to_owner.js:50-57`), customer-scope mismatches (`lib/customer-scope.js:66-76`), and maintenance-resolution follow-ups (`server.js:3846-3852`) all insert `suggested=true` rows — so "suggested + aiReason + approve/reject + banner" is a proven generic review-inbox pattern.
- **What fits as-is**: any reflection output expressible as a task (title/category/dueDate/notes/aiReason) could ride this chassis unchanged, including the approve/reject endpoints and banner UI.
- **What does NOT fit**: (1) suggestion types that aren't tasks — a "raise Gel Manicure to $45", "add a cancellation-policy knowledge doc", or "turn on auto-confirm" suggestion has no executable payload here (contrast `pending_actions.input JSONB` + `tool_name`, which *is* executable — `028_pending_actions.sql:11-12`); (2) evidence links — no columns point at the source message/thread; (3) approval semantics — approving a task just clears the flag (`server.js:3767`); it cannot *do* anything.

---

## 5. MONEY PLUMBING

**What exists.**

- **`request_payments_batch`** (`lib/tools/request_payments_batch.js:37-196`): AI-proposed batch of payment links; `requiresApproval: true` (`:44`) so the proposal lands in `pending_actions` and nothing sends at proposal time. At approval, per recipient: live re-check that the transaction is still `unpaid/partially_paid` (`:88-116`), amount defaults to live remaining (`:118-125`), then delegates to the shared helper (`:131-142`); `already_pending`/`already_settled` become soft skips (`:153-173`). Each entry may carry `payment_type: 'deposit'|'payment'` (`:57, 77`).
- **`POST /api/transactions/:id/request-payment`** (`server.js:7511-7565`): the button path; validates `payment_type ∈ {'deposit','payment'}` and `amount_cents` (`server.js:7522-7529`), then calls the same helper.
- **The shared helper `createPaymentRequest`** (`lib/payment-requests.js:47-234`): gates on PS vertical (`:74-76`) and `connect_status === 'ready'` + `stripe_connect_account_id` (`:77-79`); computes remaining from the **completed ledger sum** (`:93-107`); double-send guard on any pending ledger row (`:121-133`); creates a **Stripe Checkout Session as a direct charge on the connected account** with `metadata: {transaction_id, workspace_id, payment_type}` (`:157-177`) and a "Deposit — <business>" product name for deposits (`:152-154`); inserts a `status='pending'` ledger row (`:194-204`); best-effort SMS of `session.url` to the contact's phone (`:216-226`). So yes — the "payment link" is a Stripe Checkout Session URL, generated per request.
- **Ledger**: `transaction_payments` (`migrations/phase1-additive/042_transaction_payments.sql:34-46`) with `payment_type CHECK ('deposit','payment')` (`:56`), status `pending/completed/failed` (`:80`), and a unique partial index on `stripe_checkout_session_id` for webhook idempotency (`:92-94`). Rollups are recomputed solely by `recomputeTransactionPaidStatus` (`lib/payment-ledger.js:97-151`).
- **Webhook**: `/api/stripe/webhook` (`server.js:1852`) verifies with `STRIPE_TEST_WEBHOOK_SECRET` (`server.js:1857`); `checkout.session.completed` events carrying `metadata.transaction_id` route to `processCustomerPaymentCompletedEvent` (`server.js:1912-1931`), which flips the pending ledger row to completed, recomputes the rollup, and — if the transaction lands fully `'paid'` and links to an appointment still `'requested'` — **promotes the appointment to `'confirmed'`** (`lib/payment-ledger.js:180-254`, promotion at `:222-238`).
- **Connect status columns**: `workspaces.stripe_connect_account_id`, `connect_status ('not_started'|'pending'|'ready'|'restricted')`, `connect_charges_enabled`, `connect_details_submitted`, `connect_updated_at` (`migrations/phase1-additive/041_connect_accounts.sql:27-42`); onboarding via `POST /api/connect/onboarding/start` (`server.js:2036`) and return/refresh pages (`server.js:2108, 2138`).
- **Test-mode markers**: everything new runs on `stripeSignup = new Stripe(process.env.STRIPE_TEST_SECRET_KEY)` (`server.js:52-54`); the legacy `STRIPE_SECRET_KEY` client is explicitly deprecated ("Do NOT add new code that uses this client", `server.js:39-45`); migration 041's header says "TEST MODE only at this point" (`041_connect_accounts.sql:4-8`). There is no live-mode key or `livemode` branch anywhere in the payment path.
- **`complete_appointment` payment recording** (`lib/tools/complete_appointment.js`): stamps `final_price_cents`/`amount_paid_cents`/`payment_method`/`payment_collected_at` on the appointment (`:58-71`), auto-creates a draft transaction, and routes any money taken at completion through the ledger + recompute in one DB transaction (`:104-143`). Owner-only — refuses `ai_inbound` origin (`:41-43`).

**Deposit-request flow gap analysis** (queue for approval → on approve, send a payment link tied to an appointment):

| Piece | Status |
|---|---|
| Approval queue + approve-time execution | **Exists** — `pending_actions` + re-exec (`server.js:5161-5196`, `7054-7057`) |
| Link generation for an arbitrary amount, typed `deposit` | **Exists** — `createPaymentRequest(paymentType:'deposit', amountCents)` (`lib/payment-requests.js:47-234`) |
| Webhook completion handling | **Exists** for transaction-keyed sessions (`lib/payment-ledger.js:180-254`) |
| Appointment auto-confirm on payment | **Partially exists** — promotion fires only when the transaction is paid **in full** (`lib/payment-ledger.js:223`); a deposit smaller than the total leaves the transaction `partially_paid` and the appointment `requested` |
| Deposit column on appointments | **Missing** — `appointments` has `quoted_price_cents`/`final_price_cents`/`amount_paid_cents` but no `deposit_required_cents` or deposit-state field (full column list, `migrations/phase1-additive/035_appointments.sql:24-58`) |
| A transaction to hang the deposit on at booking time | **Missing** — payment requests are keyed to `transactions` (`lib/payment-requests.js:83-91`), but transactions are only auto-created at *completion* (`lib/tools/complete_appointment.js:76-153`); nothing creates one at booking, and the `transactions.source` CHECK has no booking/deposit value (`migrations/phase1-additive/036_transactions.sql:78`). The webhook disambiguates solely on `metadata.transaction_id` (`server.js:1920-1923`), so an appointment-keyed session would be unroutable today |
| Customer-side path to request a deposit mid-conversation | **Missing** — `request_payments_batch` is not in the engine allowlist (`lib/appointment-engine.js:42-49`), and if added, the FD2 guard would refuse it rather than queue it (`lib/appointment-engine.js:406-410`) |
| Live mode | **Missing by design** — all keys/secrets are test-mode (`server.js:52-54, 1857`) |

---

## 6. CONVERSATION LIFECYCLE

**Thread state machine.** Six states in the CHECK: `gathering`, `proposing_times`, `awaiting_confirmation`, `complete`, `escalated_to_staff`, `closed` (`migrations/phase1-additive/035_appointments.sql:119-126`). Setters actually in code:
- `'gathering'` — thread creation (`lib/appointment-engine.js:151-157`).
- `'awaiting_confirmation'` / `'complete'` — `book_appointment` after a booking, depending on `auto_confirm` (`lib/tools/book_appointment.js:149-162`).
- `'escalated_to_staff'` — the escalate tool, with `escalated_at` + `escalation_reason` (`lib/tools/escalate_appointment_to_owner.js:36-44`).
- `'proposing_times'` and `'closed'` are **never written** anywhere — they appear only in the CHECK and in `NOT IN ('closed','complete')` filters (`lib/appointment-engine.js:145`; `server.js:2391, 2399, 6407`). `closed_at` (`035_appointments.sql:116`) is never populated.

**Timeout/expiry.** None. `findOrCreateThread` reuses any non-`closed`/`complete` thread for a phone number regardless of age (`lib/appointment-engine.js:142-149`); no scheduled job touches `appointment_threads` (the only sweeps are signup drafts and reset tokens, `server.js:644-675`). A customer who chats once and never books keeps one `gathering` thread forever, and it silently accretes context across unrelated future contacts.

**Voice WS teardown.** `ws.on('close')` logs the callSid and nulls the closure vars — nothing else (`server.js:8554-8559`). No thread-state change, no summary write, no `messages` row, no notification. The last engine turn's `updateThreadContext` write (`lib/appointment-engine.js:121-125`) is the only trace a call leaves.

**Transcript persistence per channel.**
- **SMS**: full fidelity — inbound row (`server.js:5812-5815`) + outbound row per engine reply (`lib/appointment-engine.js:455-465`).
- **Voicemail**: the transcription text is persisted into the `messages` row (`server.js:5941-5944`); the engine's SMS reply persists like any SMS (`lib/appointment-engine.js:455-465`).
- **Voice**: **nothing** beyond `appointment_threads.context_summary` — a 12-line window of `Customer: <=120 chars | AI: <=120 chars` pairs (`lib/appointment-engine.js:51, 489-493`). Full utterances are discarded.
- **Owner panel**: `command_history` rows per user prompt and assistant reply with a tool summary (`server.js:4894-4904, 5281-5292`).

**Where a post-conversation reflection hook could attach, per channel:**
- **Voice**: the one channel with a *real* end-of-conversation event — `ws.on('close')` (`server.js:8554`). `callSid`/`callerPhone`/`workspace` are still in the closure when the handler fires (nulled at `:8556-8558`); the thread would need a lookup by `customer_phone` since the thread id isn't held in the closure.
- **Voicemail**: inherently single-shot — the moment the engine returns inside `/api/voice/transcription` (`server.js:5981`) the "conversation" for that voicemail is over.
- **SMS**: **no "conversation over" signal exists.** The closest knowable points are the thread-state flips: booking finalization (`lib/tools/book_appointment.js:152-158`) and escalation (`lib/tools/escalate_appointment_to_owner.js:36-44`). Anything else (customer just stops replying) is only detectable by an idle sweep over `last_customer_message_at` (`035_appointments.sql:108`) — which does not exist today.
- **Owner panel**: end of the agentic loop, after the assistant history write (`server.js:5281-5294`) — each `/api/command` request is a complete turn.

---

## 7. GAPS & BUILD ORDER (opinion — the only opinion section)

**Already half-built and reusable:** the thread state machine with two free, never-written states (`035_appointments.sql:119-126`); the `pending_actions` chassis with approve-time re-execution (`server.js:7054-7057`) and live re-check precedent (`lib/tools/request_payments_batch.js:88-116`); the suggested-tasks chassis already serving three non-model writers (`lib/customer-scope.js:66-76`, `lib/tools/escalate_appointment_to_owner.js:50-57`, `server.js:3846-3852`); FD2 scope guards (`lib/customer-scope.js`) and the engine's approval refusal branch (`lib/appointment-engine.js:406-410`); the deposit-typed payment helper (`lib/payment-requests.js:152-154`) and the webhook's appointment-promotion logic (`lib/payment-ledger.js:222-238`); tz-correct time plumbing (`lib/time-helpers.js`); push/email notification helpers (`server.js:1030, 1118`).

**Proposed checkpoints, in build order:**

1. **FD3.1 — Persist every turn; give conversations an end.** Write voice utterances and spoken replies to `messages` (or a `conversation_turns` table keyed by thread), stamp per-turn channel, and add thread closure: an idle sweep on `last_customer_message_at` plus a hook in `ws.on('close')` (`server.js:8554`). Also add the missing `voice` source values (`035_appointments.sql:73-76`, `lib/tools/book_appointment.js:34`). Everything downstream (reflection, playbook tuning, debugging the voice loop) is blind without this, which is why it goes first.
2. **FD3.2 — Finish brain unification.** Voice already shares `processInboundMessage` (`server.js:8514`); the remaining unification is (a) resolving and passing `contact` at all three call sites instead of `null` (`server.js:5839, 5970, 8516`) so the known-caller prompt branches (`lib/appointment-engine.js:246, 341-343`) go live; (b) one date/timezone anchor — fix `server.js:5036` to workspace-local weekday+date via `wsTz` (kills bug (b)); (c) make the `/api/command` tool-list prose vertical-aware (`server.js:5040-5057`) and soften the person-clarify rules (`server.js:5038, 5068`) (kills bug (a)); (d) read `ai_tone`/`ai_sales_posture` in the owner prompt too, or document that they're customer-side only.
3. **FD3.3 — Per-action autonomy policy.** Replace the boolean `requiresApproval` constant with a per-workspace policy (`act` / `approve-first` / `off`) resolved at dispatch in both brains: the `/api/command` divert (`server.js:5161`) and the engine, where the current hard refusal (`lib/appointment-engine.js:406-410`) becomes "queue + tell the customer the owner will confirm." `appointment_auto_confirm` (`lib/tools/book_appointment.js:108`) becomes just one row of this policy table.
4. **FD3.4 — Notify the owner of pending work.** The queue is invisible until the owner opens Home (`views/app.html:4214`). Wire `pending_actions` inserts (and engine-side queues from FD3.3) into the existing `sendPushNotification`/`sendNotificationEmail` helpers (`server.js:1118, 1030`), and add a TTL/stale policy so rows don't sit `'pending'` forever (none exists today).
5. **FD3.5 — Playbook encoding.** Today's playbook is prompt prose scattered across `buildSystemPrompt` (`lib/appointment-engine.js:326-346`), the voice-style block keyed to the thread's creation channel rather than the live channel (`lib/appointment-engine.js:327`), and a hardcoded TwiML greeting (`server.js:6072`). Encode it as stored per-workspace playbook stages mapped onto the thread states — including finally using `proposing_times` — and key channel style off the current turn, not `thread.inbound_channel`.
6. **FD3.6 — Deposit flow (dormant until Stripe live mode).** Add `deposit_required_cents` to `appointments`; create a booking-time transaction (new `source` value, `036_transactions.sql:78`) so the existing transaction-keyed helper and webhook work unchanged; extend the promotion rule so a completed `payment_type='deposit'` ledger row confirms the appointment (today only full payment does — `lib/payment-ledger.js:223`); expose it as an approve-first action through FD3.3 so the engine can *propose* a deposit request that the owner approves. Gate every send on `connect_status='ready'` (`lib/payment-requests.js:77-79`) and keep it dark until live keys replace `STRIPE_TEST_SECRET_KEY` (`server.js:52-54`).
7. **FD3.7 — Reflection pass.** On the closure events from FD3.1, run a reflection job over the *full* transcript (not one message, unlike `suggestTasksFromConversation`, `server.js:5313-5316`). Reuse the suggested-chassis pattern (banner + approve/reject, `views/app.html:2944-2956`, `server.js:3765-3777`) but in a new table modeled on `pending_actions`' executable shape (`tool_name` + `input JSONB`, `028_pending_actions.sql:11-12`) with evidence columns (`thread_id`, message ids) — because task rows can't carry non-task suggestions or citations (Section 4). Retire the PM-framed suggestion prompt for PS workspaces (`server.js:5308`).

**Riskiest unification.** Not voice→brain routing — that's done (`server.js:8514`). The two real risks: **(1) turn-shape divergence** — the engine is single-shot (one model call, tool results never fed back, `lib/appointment-engine.js:104-441`) while `/api/command` is a 5-iteration agentic loop (`server.js:5098-5231`). Giving the customer brain chained-tool competence (needed for playbook flows like propose→confirm→book) multiplies per-utterance latency, which SMS tolerates and a live phone call does not; any loop added to the engine needs a voice latency budget and probably streaming/partial speech. **(2) memory divergence** — `command_history` (bounded replay of real turns, `server.js:4852-4887`) vs `context_summary` (lossy 120-char pairs, `lib/appointment-engine.js:489-493`) means the "one brain" still has two incompatible memories; unifying on persisted turns (FD3.1) is the prerequisite, and migrating live threads without breaking the FD2 scope guards (`lib/customer-scope.js:44-60`, which query threads by phone) is the delicate part.
