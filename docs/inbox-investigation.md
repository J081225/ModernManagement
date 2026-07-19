# Inbox Investigation

Read-only mapping ahead of the unified-inbox rebuild (one threaded, multi-channel view; the AI a visible participant — who's driving, drafts, approvals, "needs you" triage). Every claim cites `file:line` as verified on this working tree (branch `main`, HEAD `a622c46`). Sections 1–6 are factual; Section 7 is the only opinion section.

---

## 1. CHANNEL TRUTH

The inbox's storage unit is the legacy **`messages`** table — user-scoped, flat, no thread key: `(id, user_id, resident, subject, category, text, status DEFAULT 'new', folder DEFAULT 'inbox', email, phone, "createdAt")` (`server.js:848-861`), plus `emergency_flagged` (flag write `server.js:5807`, pinned sort `server.js:4497`). Threading, where it exists at all, lives in a *different* table (`appointment_threads`, §2) that the inbox never reads.

### SMS
- **In:** `POST /api/sms/incoming` (`server.js:5935`, Twilio-signature-validated) INSERTs a `category:'sms'`, `status/folder` per-branch row (`server.js:5950`), then offers the turn to the appointment engine (`server.js:5974`); `_e2Handled` (`server.js:5966, 5987`) gates the legacy path — not-handled falls through to emergency-flagging → auto-reply → task suggestion (`server.js:5993` onward).
- **Out (AI):** the engine sends via Twilio and persists its own outbound as a `category:'sms'`, `status:'sent'`, `folder:'inbox'` row (`lib/appointment-engine.js:601-608`). CP3's approval notifier does the same (`server.js:7223-7229`).
- **Out (owner):** `POST /api/sms/send` (`server.js:6017-6028`) — sends via Twilio and **persists nothing**. An owner's SMS reply exists only in Twilio's logs; the conversation on file is missing every owner turn (§6).

### Voice (live AI calls)
- **In:** `POST /api/voice/relay-incoming` (`server.js:6179`) returns `<ConversationRelay>` TwiML with the tokened WS URL; the socket handler (`server.js:8893`, upgrade guard `server.js:8857`) drives the engine per utterance.
- **Persistence:** FD3-CP1's per-call transcript — **one `messages` row per call**, `category:'voice'`, subject `[CALLSID:…]`, `status:'new'`, `folder:'inbox'`, phone-keyed, appended per turn (`lib/voice-transcript.js:21-33`, placeholder-swap append in `appendCallTurn`).
- **Relation to the inbox:** voice rows ARE inbox rows — `GET /api/messages?folder=inbox` returns them like any other. But the inbox renderer doesn't know the category: its icon map covers `email`/`sms`/`voicemail` and voice falls to the generic 💬 default (`views/app.html:4636`). A call also leaves a *parallel* trace in `appointment_threads.context_summary` (`lib/appointment-engine.js:633-651`) — two records of the same conversation, unlinked (no thread id on the messages row, no callSid on the thread).
- **Out:** spoken live over the WS; deliberately **not** persisted as separate outbound rows (the transcript row contains both sides).

### Voicemail
- **In:** `POST /api/voice/incoming` (`server.js:6030`) returns `<Record>` TwiML; `/api/voice/recording` (`server.js:6040`) inserts a placeholder row (`server.js:6052`); `/api/voice/transcription` (`server.js:6064`) inserts the transcribed `category:'voicemail'` row, offers it to the engine (`server.js:6105`), and closes the thread immediately (`closeConversationThread(engineResult.thread_id, 'voicemail')`, `server.js:6122-6123`) — voicemail is a one-shot conversation.
- **Out:** engine auto-SMS back to the caller when handled (same engine send path as SMS).

### Email — settled: inbound ingestion IS real, with conditions
- **In:** `POST /api/email/incoming` (`server.js:5743`) is a SendGrid Inbound Parse webhook (multipart, `upload.none()`). It strips HTML, splits two ways: `payments+TOKEN@` addresses go to the payment parser (`server.js:5757-5775`), everything else routes by recipient address through `lookupUserByEmailAlias` (`server.js:5918-5926` — `users.inbound_email_alias`, the "forwarding address" the admin page copies). Matched mail INSERTs a `category:'email'` row (`server.js:5792`) and runs the same emergency/auto-reply/suggest cascade (`server.js:5800-5820`). **Unmatched recipient = silently dropped** with only a server log (`server.js:5788-5790`). So: ingestion exists, but only for mail forwarded to the per-user alias — there is no engine handoff on email (the appointment engine is never offered email turns; no `processInboundMessage` call in this route).
- **Out:** `POST /api/email/send` (`server.js:5864-5893`) — connected-SMTP first (`email_accounts`, `sendViaConnectedAccount`), SendGrid fallback. **Persists nothing** (same gap as SMS out). Other outbound email: engine email replies (`lib/appointment-engine.js:617-627`), CP3 notifier fallback (`server.js:7231-7238`), auto-reply (`server.js:5628`).

---

## 2. THREAD MODEL

**Schema:** `appointment_threads` (`migrations/phase1-additive/035_appointments.sql:95-117`): workspace-scoped, `contact_id`, `appointment_id`, `state`, `inbound_channel`, `customer_phone/email`, `context_summary`, `last_ai_message_at`, `last_customer_message_at`, `message_count`, escalation fields, `closed_at` (still never written — closure sets `state` only, `server.js:694-704`).

**States actually written:** `gathering` (creation, `lib/appointment-engine.js:176-179`), `awaiting_confirmation`/`complete` (booking, `lib/tools/book_appointment.js:157-169`), `escalated_to_staff` (`lib/tools/escalate_appointment_to_owner.js:38`), `closed` (FD3-CP1: end hook `server.js:694-704` + 6-hour idle sweep `server.js:713-727`). `proposing_times` remains never-written. **Reopen:** `findOrCreateThread` skips `closed`/`complete` rows and creates a fresh thread (`lib/appointment-engine.js:156-170`) — reopening is "new thread, same phone"; CP5's approval-resolution touch is the one true reopen (`closed`→`active`, `server.js:7335-7346`, note: `'active'` is written there and by nothing else).

**Linkage:** thread→contact via `contact_id` (stamped since FD3-CP2 resolution, `lib/appointment-engine.js:76-86`), thread→appointment via `appointment_id`. **Thread↔messages linkage does not exist** — no `thread_id` on `messages`, no message ids on threads; the only join possible is fuzzy (same phone digits + overlapping time).

**What page-inbox renders:** three folder buttons — Inbox / Archive / Deleted (`views/app.html:2506-2508`) — filtering **only on `messages.folder`** via `GET /api/messages?folder=` (`server.js:4491-4503`; folder moves `server.js:4559`, hard delete `4568`, empty-trash `4574`). The list is flat messages, newest-first, emergencies pinned (`server.js:4497`); detail is a single message with emergency banner + reply buttons + drafts area (`views/app.html:4709-4770`). No thread grouping anywhere.

**Read/unread:** `messages.status` is the only stateful field — `'new'` renders bold in the list (`views/app.html:4643`), and the folder badge counts... status values are free text (`'new'`, `'sent'`, `'in-progress'` badges at `views/app.html:4635`). **Nothing marks a message read on open**: `showMessage` (`views/app.html:4709`) fetches and renders but never writes status; `setStatus` (`views/app.html:4904` → `PUT /api/messages/:id/status`, `server.js:4579`) fires only from explicit UI actions (e.g. after a reply sends, `views/app.html:4850`). "Unread" today means "still `status='new'` because nothing ever changed it."

**Who is driving:** confirmed **nothing per-thread exists**. The only switch is workspace-global `appointment_auto_respond` (engine gate `lib/appointment-engine.js:62-64`; PM equivalent `autoReplyEnabled` via `getAutomation`, `server.js:5817`). No column on `appointment_threads` records "owner took over"; no code path pauses the AI for one conversation (§6 consequence).

---

## 3. THE FD3 SURFACES (unifiable today)

| Surface | Shape available | Enough to render? |
|---|---|---|
| **Pending actions w/ customer identity** (CP3/4) | `pending_actions`: `tool_name`, `input`, `ai_summary`, `status`, `created_at`, + `customer_phone/email/channel`, `appointment_thread_id` (queue INSERT `lib/appointment-engine.js:463-473`); list `GET /api/pending-actions?status=pending` (`server.js:7184`), count `GET /api/pending-actions/count` (`server.js:7242`), approve/reject with CP3 customer notify + CP5 thread touch (`server.js:7257-7346`) | **Yes** — summary, wait-age, customer identity, and thread pointer all present; a "waiting on you" rail can render and resolve today. Gap: `ai_summary` is the only human text (tool-input JSON otherwise). |
| **Suggested tasks w/ evidence** (CP7) | `tasks` rows `suggested=true` with `aiReason` evidence quote, `dismissed_at` chassis (`lib/reflection.js:169-180`; resolve endpoints `server.js:3912-3931`) | **Yes** — title + evidence + Add/Dismiss are API-complete. Gap: no back-pointer to the thread/conversation that spawned one (reflection writes only prose in `notes`, `lib/reflection.js:176-178`). |
| **Day-of appointment notes** (CP5) | Timestamped lines appended to `appointments.notes_internal` (`lib/tools/append_appointment_note.js:120-133`), rendered in the event modal (`views/app.html:6366`) | **Partial** — renderable via the appointment join, but notes are one TEXT blob (no per-note rows), and nothing links the note back to the message/thread that produced it. |
| **CP4 topbar badge data** | `GET /api/pending-actions/count` (`server.js:7242-7256`), refreshed on nav/approve/reject/refresh (`views/app.html` showPage hook + handlers) | **Yes** — the badge's data source is exactly a "needs you" counter; an inbox rail can reuse the endpoint as-is. |

Also real and adjacent: emergency-flagged messages (pinned + banner, `server.js:4497`, `views/app.html:4720-4738`) and AI drafts (`drafts` table `server.js:1028`, listed per-message in detail `views/app.html:4757-4767`, send via `sendDraft` `views/app.html:4802-4830` — created only by `POST /api/drafts` `server.js:4601`; no server code currently authors drafts).

---

## 4. IDENTITY

**Helpers:** `resolveCallerContact` (phone-first last-10-digit SQL match, email fallback — `lib/customer-scope.js:17-42`), `phoneDigits10`/`normalizePhone` (`lib/phone.js`), `callerOwnsAppointment` with thread-phone fallback (`lib/customer-scope.js:44-60`), FD1 auto-create with placeholder names (`lib/tools/book_appointment.js:53-99`).

**Can "one customer, one thread across channels" be computed?** Mostly, for phone-bearing channels: `messages.phone` (SMS `server.js:5950`, voice `lib/voice-transcript.js:31`, voicemail `server.js:6052`) ↔ `appointment_threads.customer_phone` (`lib/appointment-engine.js:176-179`) ↔ `contacts.phone` (via the digit-match in `lib/customer-scope.js:20-27`) all join on last-10 digits. Email joins via `messages.email` ↔ `contacts.email` (exact lowercase, `lib/customer-scope.js:30-36`).

**Where it breaks, concretely:**
- **Same person, new number** — nothing merges: a new phone → no contact match → FD1 creates a *second* contact (`lib/tools/book_appointment.js:79-95`), and the two histories never meet. The escalation task ("may have changed numbers", `lib/customer-scope.js:64-84`) is the only acknowledgment.
- **Email-only contacts on phone channels** — a caller whose contact row has email but no phone digit-matches nothing; `resolveCallerContact` needs `customer_phone` OR `customer_email` and the voice channel has no email.
- **SMS↔email cross-linking** — a customer who texts AND emails matches the same contact only if the contact row carries *both*; the messages rows themselves never learn `contact_id` (no such column), so any inbox-side identity is a join-at-read, not stored truth.
- **PM-side `messages.resident`** is free text (`server.js:848`), unusable as identity.

---

## 5. SEARCH

**None for messages or threads, anywhere.** No search input exists on page-inbox (`views/app.html:2481-2520` — folders, list, detail only), `GET /api/messages` accepts only `folder` (`server.js:4491-4492`), and no message-table query in the codebase takes a text filter. For contrast, transactions have real server search (`GET /api/transactions?q=`, used at `views/app.html:11903`) and contacts have client-side filtering — the pattern exists, just not here.

---

## 6. COMPOSE & SEND

**Owner-initiated outbound, per channel:**
- SMS: detail-pane "Reply via SMS" → `prompt()` dialog → `POST /api/sms/send` (`views/app.html:4838-4854`, `server.js:6017`) — no persistence, no thread awareness.
- Email: "Reply via Email" → two `prompt()`s → `POST /api/email/send` (`views/app.html:4856-4874`, `server.js:5864`) — connected-SMTP-first, no persistence.
- Drafts: per-message textarea + "Send Reply" routing to the same two endpoints (`views/app.html:4802-4830`).
- New-message compose: `POST /api/messages` exists (`server.js:4538`) but is an internal record-creator (no UI compose button on page-inbox; the seed/demo path uses it).
- AI-mediated (panel): `send_sms` / `send_email` / `reply_to_message` / `compose_message` tools, all `requiresApproval:true` (`lib/tools/send_sms.js:35`, `send_email.js:35`, `reply_to_message.js:39`, `compose_message.js:28`) → pending_actions → approve executes. Broadcasts via `POST /api/broadcast` (`server.js:8562`).

**The takeover question — what a manual owner reply into an AI-driven thread does today: nothing, twice.** First, the owner's reply is invisible to the AI: `/api/sms/send` writes no messages row and touches no thread, so the engine's next turn builds context from `context_summary` (`lib/appointment-engine.js:633-651`) that **does not contain the owner's words** — the AI can contradict what the owner just told the customer. Second, the AI keeps driving: the customer's next inbound hits `/api/sms/incoming` → engine gate checks only workspace-global `auto_respond` (`lib/appointment-engine.js:62-64`) → the engine replies again. There is no per-thread mute, no "owner has taken over" state, and no detection of owner outbound at all. (The FD2/CP3 machinery is unaffected either way — this is purely a conversation-coherence gap, not a security one.)

---

## 7. GAPS & BUILD ORDER (opinion)

**Suspicions confirmed, with one correction.** Read-state: effectively missing (status exists but nothing writes 'read' — §2). Per-thread driver: confirmed missing (§2, §6). Cross-channel merge: confirmed missing (§4). Email ingestion: **correction — it exists** (SendGrid Inbound Parse → alias-routed messages rows, §1); what's missing is engine handoff on email, non-alias mail (dropped), and outbound persistence. The deepest gap the suspicions missed: **owner outbound is never persisted on any channel** (§1, §6) — a unified inbox that can't show the owner's own replies isn't a conversation view, and every other feature (takeover, AI context, threading) degrades without it.

Reusable substrate is substantial: per-call voice transcripts (CP1), thread lifecycle + reopen touch (CP1/CP5), pending-actions rail with identity + resolution + notify (CP3/4/5), suggestion chassis with evidence + dedupe (CP7), identity helpers (FD1/FD2), the count-badge endpoint (CP4), the emergency pipeline, and the mm-* component set.

**Checkpoint sequence I'd run:**

1. **CP1 — Persist every side, link every row.** Additive: `messages.thread_id` + `messages.contact_id` + `messages.direction`; make `/api/sms/send` and `/api/email/send` INSERT their outbound (mirroring `lib/appointment-engine.js:601`), stamped to the thread/contact via the §4 joins. Voice transcript rows get their thread id (the WS closure already holds `lastThreadId`, `server.js:8900`, close-time use `server.js:9084`). Everything downstream needs rows that exist and join; this is the inbox's FD3.1.
2. **CP2 — Read-state honestly.** `read_at` on messages (or finally define `status` semantics); mark-on-open in `showMessage`; recount the folder badges from it. Small, isolated, immediately felt.
3. **CP3 — The thread view.** New conversation-grouped list (group by `thread_id`, fall back to contact/phone+day for legacy rows) with channel icons per turn (add the missing `voice` icon, `views/app.html:4636`); detail = the conversation, both sides, AI turns labeled. Folders become filters on conversation state, not `messages.folder`.
4. **CP4 — Who's driving.** `appointment_threads.driver` (`'ai'|'owner'`) or `owner_takeover_at`: set on any owner outbound into the thread (possible only after CP1), cleared on close/reopen; engine gate checks it after `auto_respond` (`lib/appointment-engine.js:62-64` is the one choke point). This is the takeover fix §6 shows is impossible today.
5. **CP5 — The "needs you" rail.** Unify pending approvals (identity-bearing, §3), emergency flags, escalated threads, and CP7 suggestions into one triage surface; all four sources are API-complete now — this checkpoint is mostly UI plus one union endpoint.
6. **CP6 — Search + identity merge.** Server-side message/thread search (the `transactions?q=` pattern); a contact-merge affordance for the same-person-new-number break (§4) — merge rewrites `contact_id` pointers, which only exist after CP1.
7. **CP7 — Email parity.** Offer email turns to the engine (the one channel without a brain, §1), persist outbound (done in CP1), and surface the silently-dropped-mail case (§1) as an admin-visible warning instead of a server log.

Rationale for the order: 1 unblocks 3, 4, and 6 (nothing threads, takes over, or merges without linked rows); 2 is independent and cheap; 5 rides entirely on FD3 substrate; 7 last because email is the lowest-traffic channel and its ingestion, uniquely, already works.
