# Booking → Contact Linkage Audit

## 1. DATA MODEL

### `appointments`

Created in `migrations/phase1-additive/035_appointments.sql:24-58`.

| Column | Definition | Citation | Nullable? |
|---|---|---|---|
| `contact_id` | `INTEGER` — comment: *"nullable for walk-ins; soft FK to user-scoped contacts"* | `035_appointments.sql:27` | **Yes.** No `NOT NULL`, no `REFERENCES` clause — not a real foreign key |
| `source` | `TEXT NOT NULL DEFAULT 'staff_command_bar'` | `035_appointments.sql:48` | No (defaulted) |
| `created_by_user_id` | `INTEGER REFERENCES users(id) ON DELETE SET NULL` | `035_appointments.sql:49` | Yes — this is the *owner/staff* user, never the customer |
| `cal_event_id` | `INTEGER REFERENCES cal_events(id) ON DELETE SET NULL` | `035_appointments.sql:28` | Yes |

**`contact_id` is the only column on `appointments` that can identify a customer.** There is no `customer_name`, no `customer_phone`, no `customer_email`, and no `phone` column on this table — the full column list at `035_appointments.sql:24-58` contains none of them. The customer's name is not even denormalized onto the row; the only free-text fields are `title`, `notes_internal`, and `notes_customer` (`035_appointments.sql:31-33`).

Nothing enforces linkage. The index is explicitly partial, which presumes nulls are normal:

```
CREATE INDEX IF NOT EXISTS idx_appointments_contact_id ON appointments(contact_id) WHERE contact_id IS NOT NULL;
```
(`035_appointments.sql:81`)

`source` is constrained by a CHECK at `035_appointments.sql:73-75`:

```
CHECK (source IN ('ai_inbound_sms','ai_inbound_email','ai_inbound_voicemail',
                  'staff_command_bar','public_booking','walk_in'))
```

**Note the absence of any `voice` value.** `'ai_inbound_voice'` is not permitted by the constraint, and `'public_booking'` is permitted but unreachable — `grep -rn "public_booking" server.js lib/ views/ public/` returns zero hits.

### `cal_events`

Base table in `server.js:803-808`; extended by `migrations/phase1-additive/034_calendar_extension.sql:26-31`.

| Column | Definition | Citation | Nullable? |
|---|---|---|---|
| `user_id` | `INTEGER NOT NULL DEFAULT 1` | `server.js:805` | No — but this is the *owner*, not the customer |
| `appointment_id` | `INTEGER` (FK added later) | `034_calendar_extension.sql:31` | Yes |
| `workspace_id` | `INTEGER REFERENCES workspaces(id) ON DELETE CASCADE` | `034_calendar_extension.sql:26` | Yes |

**`cal_events` has no contact linkage whatsoever — direct or by column.** Its only path to a person is transitively through `appointment_id → appointments.contact_id`. The FK is added in `035_appointments.sql:89-90` with `ON DELETE SET NULL`. There is no `contact_id` column on this table in either the base CREATE TABLE (`server.js:803-808`) or any `ADD COLUMN` in `034_calendar_extension.sql:26-31`.

### `contacts`

Created in `server.js:733-743`.

| Column | Definition | Citation | Nullable? |
|---|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | `server.js:734` | No |
| `user_id` | `INTEGER NOT NULL DEFAULT 1` | `server.js:735` | No |
| `name` | `TEXT` | `server.js:736` | **Yes** |
| `type` | `TEXT` | `server.js:737` | Yes |
| `email` | `TEXT` | `server.js:739` | **Yes** |
| `phone` | `TEXT` | `server.js:740` | **Yes** |

Additional columns bolted on at `server.js:862-864` (`lease_start`, `lease_end`, `monthly_rent`).

Two structural facts matter for this incident:

1. **`contacts` is `user_id`-scoped, not `workspace_id`-scoped.** There is no `workspace_id` column (`server.js:733-743`). Every consumer must join via `workspaces.owner_user_id` — as `book_appointment.js:56` does. This is called out in the source comment at `lib/tools/book_appointment.js:12-13`.
2. **There is no unique constraint or index on `phone`.** No `CREATE INDEX` or `UNIQUE` on `contacts.phone` exists anywhere; the only DDL after creation is the four `ALTER TABLE contacts` statements at `server.js:744` and `server.js:862-864`. Phone-based dedupe would therefore be a full scan and could silently create duplicates.

### `appointment_threads`

Created in `migrations/phase1-additive/035_appointments.sql:95-118`.

| Column | Definition | Citation | Nullable? |
|---|---|---|---|
| `contact_id` | `INTEGER` | `035_appointments.sql:98` | **Yes.** Again no `REFERENCES` — soft FK |
| `appointment_id` | `INTEGER REFERENCES appointments(id) ON DELETE CASCADE` | `035_appointments.sql:99` | Yes |
| `customer_phone` | `TEXT` | `035_appointments.sql:103` | **Yes** |
| `customer_email` | `TEXT` | `035_appointments.sql:104` | **Yes** |
| `inbound_channel` | `TEXT NOT NULL` | `035_appointments.sql:102` | No |

`inbound_channel` was originally constrained to `('sms','email','voicemail')` (`035_appointments.sql:133`) and widened to include `'voice'` by `migrations/phase1-additive/044_appointment_threads_add_voice_channel.sql:31`.

**This is the critical asymmetry of the whole system:** `appointment_threads` *does* carry `customer_phone` (`035_appointments.sql:103`), and it is indexed (`035_appointments.sql:138`). `appointments` does not. The caller's phone number is captured and persisted on the thread, then is not carried across to the appointment row that the thread produces.

**Summary of enforcement: none.** Every linkage column on every table above (`appointments.contact_id`, `appointment_threads.contact_id`, `appointment_threads.customer_phone`, `contacts.phone`, `contacts.name`) is nullable, and none of the three `contact_id` columns is a real foreign key. The database cannot reject an orphaned appointment.

---

## 2. SMS PATH

### Where `From` enters

`server.js:5709`, in the `/api/sms/incoming` handler (`server.js:5708`):

```js
const from = req.body.From || 'Unknown';
```

It is immediately persisted to the `messages` table in both the `resident` and `phone` columns (`server.js:5722-5725`).

### Whether it reaches the engine

Yes. `server.js:5747-5759` calls the engine with the number threaded in as `customer_phone`:

```js
const engineResult = await appointmentEngine.processInboundMessage({
  workspace,
  contact: null,
  customer_phone: from,
```
(`server.js:5747-5750`)

Note `contact: null` at **`server.js:5749`** — the SMS route never attempts a contact lookup before calling the engine, and hardcodes null.

### Whether a contact is looked up, and by what logic

Not by the SMS handler and not by the engine. The only contact lookup on this entire path is inside the booking tool itself, and it matches on **name only** — never on phone:

```js
const f = await ctx.db.query(
  `SELECT id FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 1`,
  [ctx.workspace.owner_user_id, `%${customer_name.toLowerCase()}%`]
);
```
(`lib/tools/book_appointment.js:54-57`)

Three defects are visible in this one query:

- It matches on `LOWER(name) LIKE '%...%'` — a substring match. A customer saying "Jo" matches contact "Joanne". `ORDER BY name LIMIT 1` then silently picks one of possibly many matches, with no ambiguity signal to the caller.
- It never consults `phone`, despite the phone being the one identifier the channel supplies with certainty.
- It is skipped entirely for walk-ins by the guard at `lib/tools/book_appointment.js:53`.

### Whether a contact is ever created on this path

**No. No contact-creation call exists on the SMS path.** Two independent lines of evidence:

1. `grep -n "INSERT INTO contacts" server.js lib/*.js lib/tools/*.js` returns exactly four sites, none of which is reachable from an inbound message: `server.js:748` (demo seed data for `user_id=1`), `server.js:2876` (the authenticated `POST /api/contacts` form), `server.js:8185` (the authenticated CSV import at `POST /api/contacts/import`), and `lib/tools/add_contact.js:36` (the AI tool).
2. The `add_contact` tool — the only one of those four an AI could invoke — **is not exposed to the appointment engine at all.** The engine's allowlist is:

```js
const APPOINTMENT_TOOL_NAMES = [
  'book_appointment',
  'update_appointment',
  'cancel_appointment',
  'propose_appointment_times',
  'escalate_appointment_to_owner',
  'add_calendar_event',
  'add_task',
];
```
(`lib/appointment-engine.js:38-46`)

`add_contact` and `update_contact` are absent. This list is the hard filter applied at `lib/appointment-engine.js:341-346` — `buildToolListForEngine` intersects the registry against it, so the model is never even shown a contact-creation tool.

**There is therefore no auto-create-vs-ask-permission decision anywhere in the codebase.** The question does not arise, because contact creation is structurally unreachable from every inbound channel. No consent gate was removed or disabled; one was never built.

### What `contact_id` ends up on the row, and why

Whatever the name substring match at `lib/tools/book_appointment.js:54-57` happened to return, or `null`. `contact_id` is initialized to `null` at `lib/tools/book_appointment.js:52` and is only ever reassigned inside the `if (f.rows.length > 0)` branch at `lib/tools/book_appointment.js:58`. It is then inserted as parameter `$2` at `lib/tools/book_appointment.js:78-86`.

So on SMS: if the caller is an existing contact **and** the AI transcribed their name closely enough to substring-match, the row links. Otherwise it is orphaned — even though `customer_phone` was known with certainty from `server.js:5709` onward.

---

## 3. VOICE PATH

### Does the voice handler receive the caller's number?

**Yes.** The number is present and correct at three separate layers.

**Layer 1 — TwiML entry.** `/api/voice/relay-incoming` (`server.js:5946`) receives the standard Twilio POST. It reads only `req.body.To` (`server.js:5947`) to resolve the workspace and **never reads `req.body.From`** — a grep of the handler body (`server.js:5946-5992`) shows no `From` reference. The number is available in the POST body but discarded here. The handler's sole output is TwiML pointing at the WebSocket (`server.js:5984-5991`), and it passes no `<Parameter>` elements, so nothing is forwarded to the WS by this route.

**Layer 2 — WebSocket `setup` message.** The number arrives again in the ConversationRelay `setup` frame and *is* captured:

```js
if (msg.type === 'setup') {
  callSid = msg.callSid || null;
  callerPhone = msg.from || null;
```
(`server.js:8393-8395`)

It is stored in per-call closure state declared at `server.js:8357-8359` and logged at `server.js:8409`.

**Layer 3 — engine invocation.** It is passed correctly into the engine:

```js
const result = await appointmentEngine.processInboundMessage({
  workspace,
  contact: null,
  customer_phone: callerPhone,
```
(`server.js:8424-8427`)

The handler even treats the number as load-bearing, refusing to proceed without it:

```js
if (!callerPhone) {
  sendText("I'm sorry, I'm having trouble identifying your number — let me have someone call you back.");
  return;
}
```
(`server.js:8419-8422`)

**So the voice path is not the failure point.** It captures the caller's number and hands it to the engine exactly as the SMS path does. Note `contact: null` at `server.js:8426`, matching `server.js:5749` and `server.js:5880`.

### Does voice booking go through `book_appointment`?

Yes — and there is no alternative route. **`lib/tools/book_appointment.js:78` is the only `INSERT INTO appointments` statement in the entire codebase**; `grep -n "INSERT INTO appointments" server.js lib/*.js lib/tools/*.js` returns that single hit. Every appointment on every channel is created by this one tool.

Full path, WS message → DB insert:

| Step | Location |
|---|---|
| Twilio opens WS; `setup` captures `callerPhone` | `server.js:8393-8395` |
| `prompt` frame → utterance extracted | `server.js:8413-8414` |
| `processInboundMessage({ customer_phone: callerPhone, channel: 'voice' })` | `server.js:8424-8436` |
| `findOrCreateThread` persists phone to `appointment_threads.customer_phone` | `lib/appointment-engine.js:132-155` |
| System prompt built | `lib/appointment-engine.js:89` |
| Anthropic call with the 7-tool allowlist | `lib/appointment-engine.js:101-107`, `lib/appointment-engine.js:341-346` |
| `executeAIResult` builds `ctx` and dispatches the tool | `lib/appointment-engine.js:364-379` |
| `book_appointment.execute` name-matches, then inserts | `lib/tools/book_appointment.js:54-57`, `:78-86` |

### The exact point where identity is lost

**`lib/appointment-engine.js:364-377`** — the tool-context builder in `executeAIResult`. The engine receives `customer_phone` as a named parameter (`lib/appointment-engine.js:349-350`) and uses it later in the same function to send the outbound SMS (`lib/appointment-engine.js:395-399`), so the value is live and in scope. But it is **not copied into `ctx`**:

```js
const ctx = {
  user: { id: workspace.owner_user_id },
  workspace,
  db,
  sms: twilio,
  sendgrid,
  env,
  logger,
  origin: {
    channel: 'ai_inbound',
    appointment_thread_id: thread.id,
    contact_id: contact ? contact.id : null,
  },
};
```
(`lib/appointment-engine.js:364-377`)

`ctx.origin` carries `channel`, `appointment_thread_id`, and `contact_id` — but **no `customer_phone` key**. This is the precise line where the caller's number stops being available to the booking tool. Everything downstream of `lib/appointment-engine.js:377` is blind to who is calling.

The failure is doubly sealed by two further facts:

- **`ctx.origin.contact_id` is always `null` regardless.** It is derived from the `contact` parameter (`lib/appointment-engine.js:375`), and all three call sites hardcode `contact: null` — `server.js:5749` (SMS), `server.js:5880` (voicemail), `server.js:8426` (voice). No caller ever supplies a contact, so this field is dead in production.
- **`book_appointment` never reads `ctx.origin.contact_id` anyway.** It consumes `ctx.origin.channel` at `lib/tools/book_appointment.js:73` and `ctx.origin.appointment_thread_id` at `lib/tools/book_appointment.js:112`, and nothing else. Even if the engine populated `contact_id`, the tool would ignore it — the only assignment to the local `contact_id` variable is from the name query at `lib/tools/book_appointment.js:58`.

The net effect on the reported incident: a real voice booking whose caller ID was known at `server.js:8395`, persisted to `appointment_threads.customer_phone`, and then dropped at `lib/appointment-engine.js:377`, producing an appointment row whose `contact_id` is null (`lib/tools/book_appointment.js:52`) and which has no phone column of its own to fall back on (`035_appointments.sql:24-58`).

### Secondary voice defect: `source` is mislabeled

`book_appointment` computes `source` as:

```js
const sourceValue = source ||
  (ctx.origin && ctx.origin.channel === 'ai_inbound' ? 'ai_inbound_sms' : 'staff_command_bar');
```
(`lib/tools/book_appointment.js:72-73`)

The engine sets `ctx.origin.channel = 'ai_inbound'` for *all* inbound channels (`lib/appointment-engine.js:373`) — the real channel (`'voice'`) is a separate parameter that never reaches the tool. So a voice booking where the model omits `source` is recorded as **`'ai_inbound_sms'`**. If the model does supply `source`, it must choose from the tool's enum (`lib/tools/book_appointment.js:33`), which offers `ai_inbound_sms`, `ai_inbound_email`, `ai_inbound_voicemail`, `staff_command_bar`, `walk_in` — no voice option exists. The DB CHECK at `035_appointments.sql:73-75` is equally voice-less. **Voice bookings are therefore untraceable by `source` after the fact**, which materially complicates the orphan triage in Section 5.

### Note on `/api/voice/incoming` (the legacy voicemail line)

This is a separate, older flow (`server.js:5803`) that records a voicemail rather than conversing. It captures `From` at `server.js:5814` and `server.js:5839`, writes it to `messages.phone` (`server.js:5824-5827`), and passes it to the engine as `customer_phone` at `server.js:5881`. It then hits **the identical `ctx` gap at `lib/appointment-engine.js:377`**, so it orphans bookings for exactly the same reason.

---

## 4. OWNER PATHS

### Command bar — `POST /api/command` (`server.js:4787`)

The tool-execution context is built at `server.js:4987-4997`:

```js
const ctx = {
  workspace: _workspaceRow,
  user: { id: req.session.userId },
  db: pool,
  logger: console,
  ...
};
```

**There is no `origin` key at all** — the object spans `server.js:4987-4997` and contains `workspace`, `user`, `db`, `logger`, `mailer`, `sms`, `stripe`, `env`, `generateReportContent`. Tools are dispatched with it at `server.js:5112`.

Consequences for a command-bar booking:

- `ctx.origin` is `undefined`, so the guard at `lib/tools/book_appointment.js:73` short-circuits and `source` becomes `'staff_command_bar'` — which is at least accurate here.
- `ctx.origin.appointment_thread_id` is undefined, so the thread-link block at `lib/tools/book_appointment.js:112` is skipped — correct, since there is no thread.
- Contact attachment falls through to the same name-substring query at `lib/tools/book_appointment.js:54-57`. This is the one path where that logic is defensible: the owner is typing a name they know, and the PS context snapshot fed to the model (`server.js:4857-4870`) includes workspace contacts. But it is still substring-matched and still silently `null` on a miss.

The identical gap exists in `buildExecutorContext` (`server.js:4644-4664`), used by the pending-actions approval route at `server.js:6964-6967` — it returns the same nine keys with no `origin`.

### Calendar add-event form — `POST /api/calevents` (`server.js:3873`)

**Confirmed: this route creates `cal_events` rows with no appointment and no contact.** The INSERT is:

```js
INSERT INTO cal_events
  (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type)
```
(`server.js:3929-3931`)

Eight columns — no `appointment_id`, no contact reference of any kind. And the route explicitly forbids creating appointment-type events:

```js
// Whitelist event_type. 'appointment' is deliberately EXCLUDED — those
// rows are created only by lib/tools/book_appointment.js so the
// appointment_id / cal_event_id linkage stays consistent.
const ALLOWED = ['general', 'time_off', 'personal'];
```
(`server.js:3879-3882`)

This is a deliberate, correctly-reasoned design decision and **is not a source of orphans**. Rows from this route are owner-blocked time (`time_off`, `personal`) or generic events, not customer bookings. They will appear in a naive "cal_events with no contact" sweep and must be excluded from orphan counts by `event_type <> 'appointment'`.

### Other owner-initiated paths

None found. Since `lib/tools/book_appointment.js:78` is the sole `INSERT INTO appointments` site, every owner booking necessarily routes through the command bar or the approval queue, both covered above. There is no public/self-serve booking page — the `'public_booking'` source value permitted at `035_appointments.sql:74` has no corresponding code.

---

## 5. THE ORPHANS

### Diagnostic query shape

Read-only. Not run.

```sql
-- Orphaned appointments: no contact linkage, with best-effort attribution
-- of the originating channel via the thread that produced them.
SELECT
    a.id                AS appointment_id,
    a.workspace_id,
    a.source,
    a.status,
    a.starts_at,
    a.title,
    a.created_at,
    t.id                AS thread_id,
    t.inbound_channel,          -- 'voice' | 'voicemail' | 'sms' | 'email'
    t.customer_phone,           -- recoverable identity, if a thread exists
    t.customer_email
FROM appointments a
LEFT JOIN appointment_threads t
       ON t.appointment_id = a.id
WHERE a.contact_id IS NULL
ORDER BY a.created_at DESC;

-- Rollup: which channel/source combinations are generating orphans, and
-- how many are recoverable (a phone survives on the thread).
SELECT
    a.source,
    COALESCE(t.inbound_channel, '(no thread)') AS inbound_channel,
    COUNT(*)                                        AS orphan_count,
    COUNT(t.customer_phone)                         AS phone_recoverable,
    COUNT(*) - COUNT(t.customer_phone)              AS unrecoverable
FROM appointments a
LEFT JOIN appointment_threads t
       ON t.appointment_id = a.id
WHERE a.contact_id IS NULL
GROUP BY 1, 2
ORDER BY orphan_count DESC;

-- Downstream blast radius: draft revenue rows that inherited the null.
SELECT COUNT(*)
FROM transactions
WHERE appointment_id IS NOT NULL
  AND contact_id IS NULL;
```

The join to `appointment_threads` is what makes triage possible: `appointments` retains nothing about the customer, but the thread that produced the booking still holds `customer_phone` (`035_appointments.sql:103`) and the true `inbound_channel` (`035_appointments.sql:102`). `book_appointment` writes the back-link at `lib/tools/book_appointment.js:112-121` whenever `ctx.origin.appointment_thread_id` is present — which is exactly the inbound-AI case. **The identity of most orphans is therefore recoverable from the database today**, without re-contacting anyone.

### Orphan categories and their distinguishing evidence

| Category | `source` value | Thread evidence | Origin path | Why it orphaned |
|---|---|---|---|---|
| **Live voice AI** | `'ai_inbound_sms'` (misattributed) or `'ai_inbound_voicemail'` if the model guessed | Thread exists, `inbound_channel = 'voice'`, `customer_phone` populated | `/twilio-relay` WS (`server.js:8424`) | Phone known at `server.js:8395`, dropped at `lib/appointment-engine.js:377`. **This is the reported incident.** |
| **Voicemail AI** | `'ai_inbound_voicemail'` or `'ai_inbound_sms'` | Thread exists, `inbound_channel = 'voicemail'`, `customer_phone` populated | `/api/voice/transcription` (`server.js:5878`) | Same `ctx` gap at `lib/appointment-engine.js:377` |
| **SMS AI** | `'ai_inbound_sms'` | Thread exists, `inbound_channel = 'sms'`, `customer_phone` populated | `/api/sms/incoming` (`server.js:5747`) | Same gap; name substring missed at `lib/tools/book_appointment.js:54-57` |
| **Owner command bar** | `'staff_command_bar'` | **No thread row** — `t.id IS NULL` | `/api/command` (`server.js:5112`) | `ctx` has no `origin` (`server.js:4987-4997`); name typed didn't substring-match |
| **Walk-in** | `'walk_in'` | No thread row | Command bar with explicit `source` | Intentional — `lib/tools/book_appointment.js:53` skips lookup when name is `"walk-in"`. **Not a defect.** |

**The decisive discriminator is `inbound_channel` on the joined thread, not `source`.** Because `lib/tools/book_appointment.js:72-73` collapses every inbound channel to `'ai_inbound_sms'` and the tool enum at `lib/tools/book_appointment.js:33` offers no voice value, `source` alone cannot separate a voice orphan from an SMS orphan. Rows with `source = 'ai_inbound_sms'` **and** `inbound_channel = 'voice'` are voice bookings mislabeled at the tool boundary.

Secondary null-pattern tell: `appointments.created_by_user_id` is set to `ctx.user.id` at `lib/tools/book_appointment.js:85`, which the engine defines as `workspace.owner_user_id` (`lib/appointment-engine.js:365`). So AI-inbound bookings are attributed to the owner and are indistinguishable from owner bookings on that column alone — another reason the thread join is required.

Note also `'public_booking'`: permitted by `035_appointments.sql:74` but with zero code references. Any row bearing it did not come from this application.

### Downstream contamination

The null does not stay contained. `complete_appointment` copies `a.contact_id` straight into the transactions ledger:

```js
INSERT INTO transactions
  (workspace_id, contact_id, appointment_id, customer_display_name, ...)
```
(`lib/tools/complete_appointment.js:109-118`, passing `a.contact_id` at `:116`)

and falls back to a literal string for the display name:

```js
const customerName = a.contact_name || 'Walk-in';
```
(`lib/tools/complete_appointment.js:83`)

So an orphaned appointment becomes an orphaned revenue record labeled **"Walk-in"** — indistinguishable in the books from a genuine walk-in. The orphan count in `transactions` is likely to exceed the visible symptom, and historical revenue attribution is already degraded.

---

## 6. CONVERSATIONAL REQUIREMENTS

### Shared system prompt — `buildSystemPrompt` (`lib/appointment-engine.js:200-339`)

**No instruction to collect a name or any contact information exists anywhere in this prompt.** The "Your job" block is the full set of behavioral directives:

> `- Help the customer book, change, or cancel an appointment.`
> (`lib/appointment-engine.js:300`)

> `- Use book_appointment ONLY when you have BOTH service details AND a confirmed time.  Set source to match the channel.`
> (`lib/appointment-engine.js:305`)

The gating condition is **"service details AND a confirmed time"** — identity is not among the preconditions. The model is explicitly told what it must have before booking, and a customer name is not on the list.

The prompt does tell the model whether the customer is known:

> `lines.push(contact ? `The customer is on file as: ${contact.name}.` : 'The customer is not yet on file.');`
> (`lib/appointment-engine.js:216`)

But since all three call sites pass `contact: null` (`server.js:5749`, `server.js:5880`, `server.js:8426`), **this branch always renders "The customer is not yet on file."** The model is told on every single turn — including with repeat customers — that the caller is unknown, and is then given no tool or instruction to do anything about it.

The only reference to a name anywhere in the prompt is conditional on tone configuration:

> `Speak warmly and personally, like a friendly local receptionist. Be personable and use the customer's name when you know it.`
> (`lib/appointment-engine.js:317`)

Note **"when you know it"** — this presumes prior knowledge and does not instruct the model to ask. It also only fires when `workspace.ai_tone === 'warm'` (`lib/appointment-engine.js:314`). A `grep` for name-collection phrasing (`your name`, `their name`, `ask for.*name`, `full name`) across `lib/appointment-engine.js`, `lib/tools/book_appointment.js`, `lib/tools/propose_appointment_times.js`, and `lib/tools/update_appointment.js` returns **only line 317** — nothing else in the booking surface mentions a name.

### Voice-specific prompt additions (`lib/appointment-engine.js:294-299`)

There is no separate voice prompt or personality file — `grep -rln "voice" lib/` returns no dedicated prompt module. The voice additions are inline, gated on `thread.inbound_channel === 'voice'` (`lib/appointment-engine.js:294`), and consist of one block:

> `You are on a live phone call, so sound like a warm, friendly receptionist having a natural conversation. Keep every reply to one or two short sentences.`
> (`lib/appointment-engine.js:297`)

> `If a caller mentions a general need (like "a haircut"), respond warmly and ask one short, friendly follow-up question to narrow it down, rather than listing all the options.`
> (`lib/appointment-engine.js:297`)

**This block contains no identity-collection instruction, and it actively works against identity capture.** "Keep every reply to one or two short sentences" and "ask one short, friendly follow-up question" pressure the model toward brevity and toward spending its single follow-up on *service* disambiguation. On the channel where the phone number is most reliably available and the name is least likely to be volunteered, the prompt is at its most terse and its most silent on identity.

### `book_appointment` tool description (`lib/tools/book_appointment.js:20`)

> `Book an appointment for a customer. Use only when you have a customer name (or "walk-in"), a service title, a confirmed start time, and a duration.`

This *does* name identity as a precondition — but immediately supplies `"walk-in"` as a sanctioned escape hatch, and the system prompt's own restatement of the gate (`lib/appointment-engine.js:305`) drops the name requirement entirely. The model sees a conflicting pair of instructions and an explicit, blessed way to satisfy the weaker one.

### `customer_name` parameter description (`lib/tools/book_appointment.js:26`)

> `customer_name: { type: 'string', description: 'Customer name (use "walk-in" if unknown).' }`

**This is the single most damaging line of prompt text in the system.** It is the only place the model is told what to do when identity is unknown, and it instructs it to fabricate a placeholder rather than ask. `customer_name` is in the `required` array (`lib/tools/book_appointment.js:35`), so the model must emit *something* — and this description tells it that `"walk-in"` is the correct something. That value then routes directly into the guard at `lib/tools/book_appointment.js:53`, which skips the contact lookup entirely and guarantees `contact_id` stays `null` from its initialization at `lib/tools/book_appointment.js:52`.

The result is a closed loop: the prompt never asks the model to collect a name, the tool offers a sanctioned way to proceed without one, and the tool then treats that sanctioned value as an explicit instruction not to link a contact.

---

## 7. GAPS

Ranked by severity. This is the only section containing proposals.

---

**1. `ctx` does not carry the customer's phone number to the tools — the direct cause of the incident.**

*Broken:* `lib/appointment-engine.js:364-377` builds the tool context without a `customer_phone` key, despite the value being an in-scope parameter at `lib/appointment-engine.js:349-350` and used 20 lines later at `lib/appointment-engine.js:395-399`. Every channel — voice (`server.js:8427`), SMS (`server.js:5750`), voicemail (`server.js:5881`) — captures the number correctly and loses it here.

*Change:* Thread `customer_phone` (and `customer_email`) into `ctx.origin` alongside the existing `channel` / `appointment_thread_id` / `contact_id` fields. This is a small, additive change at one location that unblocks every fix below. Nothing currently reads these keys, so adding them is behavior-neutral until consumed.

---

**2. No path can create a contact from an inbound conversation.**

*Broken:* `add_contact` is absent from the engine's tool allowlist at `lib/appointment-engine.js:38-46`, and that list is the hard filter applied at `lib/appointment-engine.js:341-346`. All four `INSERT INTO contacts` sites (`server.js:748`, `server.js:2876`, `server.js:8185`, `lib/tools/add_contact.js:36`) require an authenticated owner session or are demo seed data. A customer who books by voice or SMS *cannot* become a contact, no matter how much information they volunteer.

*Change:* Have `book_appointment` resolve-or-create the contact itself, using the phone from gap #1 as the identity key, rather than exposing `add_contact` to the engine as a second model-driven step the model must remember to take. Doing it inside the booking tool makes linkage structural rather than dependent on model judgment. The owner-consent question — auto-create silently vs. surface for review — should be decided deliberately; note that no consent gate exists today to preserve, so either choice is new behavior.

---

**3. Contact lookup matches on name substring instead of phone.**

*Broken:* `lib/tools/book_appointment.js:54-57` queries `LOWER(name) LIKE '%...%' ORDER BY name LIMIT 1`. It ignores `contacts.phone` entirely. This fails for every first-time caller, every caller whose name the AI transcribed imperfectly, and every caller who never stated a name — and it silently mis-links when a substring matches the wrong person ("Jo" → "Joanne"), with `LIMIT 1` hiding the ambiguity.

*Change:* Match on normalized phone first (exact, high-confidence), fall back to name only when no phone is available. Phone matching requires E.164 normalization on both sides, since `contacts.phone` is free-text `TEXT` (`server.js:740`) and holds hand-entered formats — the seed data at `server.js:749-751` uses `555-201-1111` while Twilio supplies `+15552011111`. Also add an index on normalized phone; none exists today (see #7).

---

**4. The `customer_name` parameter description instructs the model to fabricate `"walk-in"` instead of asking.**

*Broken:* `lib/tools/book_appointment.js:26` reads `'Customer name (use "walk-in" if unknown).'` — the only guidance the model gets for the unknown-identity case, and it points away from asking. The value then triggers the lookup-skip guard at `lib/tools/book_appointment.js:53`, hard-guaranteeing a null `contact_id`.

*Change:* Reserve `"walk-in"` for genuine owner-entered walk-ins and stop offering it as the inbound-channel fallback. On channels where a phone number is available, identity should be resolved from the channel rather than from a model-supplied string at all — which is what #1 and #3 together enable.

---

**5. Neither the shared nor the voice prompt asks the AI to collect a name.**

*Broken:* The booking precondition at `lib/appointment-engine.js:305` requires only "service details AND a confirmed time." The voice block at `lib/appointment-engine.js:294-299` adds brevity pressure and no identity instruction. The sole name reference (`lib/appointment-engine.js:317`) says "when you know it" and only fires for `ai_tone === 'warm'`.

*Change:* Add an identity step to the "Your job" block, scoped to fire only when the contact is genuinely unresolved — the requirement is that the name is asked *only when actually unknown*, so this must be conditional on the lookup from #3, not an unconditional "always ask your name" that would badger repeat customers. This depends on #1 and #3 landing first; without them the prompt has no way to know whether the caller is known.

---

**6. The engine always tells the AI the customer is unknown.**

*Broken:* `lib/appointment-engine.js:216` renders "The customer is not yet on file." whenever `contact` is falsy, and all three call sites hardcode `contact: null` (`server.js:5749`, `server.js:5880`, `server.js:8426`). Repeat customers are greeted as strangers on every turn. Relatedly, `ctx.origin.contact_id` (`lib/appointment-engine.js:375`) is permanently null and is dead code — and `book_appointment` would ignore it anyway, reading only `ctx.origin.channel` (`lib/tools/book_appointment.js:73`) and `.appointment_thread_id` (`lib/tools/book_appointment.js:112`).

*Change:* Resolve the contact by phone once at the top of `processInboundMessage` and pass the real row through to both `buildSystemPrompt` and `ctx`. This makes #5's conditional prompt possible and lets the AI greet returning customers by name, which is the behavior `lib/appointment-engine.js:317` already assumes it can.

---

**7. `contacts` has no phone index and no uniqueness guarantee.**

*Broken:* Only four `ALTER TABLE contacts` statements exist (`server.js:744`, `server.js:862-864`) and none creates an index or constraint on `phone`. `phone` is nullable free-text (`server.js:740`).

*Change:* Once #3 introduces phone lookups on every inbound message, this becomes a hot path over an unindexed column. Needs a functional index on the normalized form, plus a dedupe decision — without uniqueness, the auto-create in #2 can generate duplicate contacts for one person across format variations.

---

**8. `source` cannot distinguish a voice booking.**

*Broken:* `lib/tools/book_appointment.js:72-73` collapses all inbound channels to `'ai_inbound_sms'`; the tool enum at `lib/tools/book_appointment.js:33` has no voice value; the DB CHECK at `035_appointments.sql:73-75` has none either. The engine passes the true channel to `executeAIResult` (`lib/appointment-engine.js:349`) but never into `ctx`.

*Change:* Carry the real channel through `ctx.origin` (same change as #1), derive `source` from it rather than defaulting, and widen both the tool enum and the DB CHECK to admit a voice value. This is attribution/observability rather than linkage — it does not cause orphans, but it is why the incident was hard to triage, and it will keep future voice regressions invisible. The unreachable `'public_booking'` value (`035_appointments.sql:74`, zero code references) could be dropped in the same pass.

---

**9. Orphaned appointments propagate into the revenue ledger as "Walk-in".**

*Broken:* `lib/tools/complete_appointment.js:116` copies `a.contact_id` into `transactions.contact_id`, and `lib/tools/complete_appointment.js:83` labels the null case `'Walk-in'` — making an orphaned booking indistinguishable from a genuine walk-in in the books.

*Change:* Fixing #1-#3 stops new contamination, but existing rows stay wrong. A one-time backfill is feasible for most of them: the query shape in Section 5 shows that `appointment_threads.customer_phone` (`035_appointments.sql:103`) survives for every AI-inbound orphan, so historical identity is largely recoverable from the database without contacting anyone. Backfill scope and owner review should be decided separately from the code fix.

---

**10. `appointments` has no customer identity column of its own, and nothing is enforced.**

*Broken:* The table carries only the nullable, non-FK `contact_id` (`035_appointments.sql:27`) — no `customer_phone`, no `customer_name` (`035_appointments.sql:24-58`). All three `contact_id` columns across the schema are soft FKs. The database cannot reject an orphan, and the partial index at `035_appointments.sql:81` encodes the assumption that nulls are routine.

*Change:* Consider denormalizing `customer_phone` onto `appointments` as a durable fallback, so identity survives even when contact resolution fails — this would have preserved the incident booking's identity on the row itself. Full `NOT NULL` enforcement on `contact_id` is not advisable while genuine walk-ins exist (`lib/tools/book_appointment.js:53`), but a CHECK requiring *either* a `contact_id` *or* a captured phone would make the orphan state unrepresentable without breaking the walk-in case. Ranked last because it is a schema migration over live data and gaps #1-#3 eliminate the great majority of orphans without it.
