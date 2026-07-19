# Playbook Regression Sheet

The manual QA sheet for every future prompt change. One row per [conversation-playbook.md](conversation-playbook.md) row: the message to send (SMS to the workspace number, or say it on a call), and the visible outcome that proves the row still works. **Artifacts** means what must exist afterward — task / note / alert / queue row — checked in the app, not inferred from the reply.

Rows marked ⚙ are also covered by the automated harness (`executeAIResult` + `buildSystemPrompt` driven with stub transports — last run **19/19 PASS**, FD3-CP5). Rows marked 👤 need live model judgment (does the model *recognize* the situation?) and are manual-only: the harness proves the mechanism, not the recognition.

| # | Row | Send this | Expected reply shape | Expected artifacts | Auto |
|---|-----|-----------|---------------------|--------------------|------|
| 1 | Booking | "Can I get a gel manicure Tuesday afternoon?" | Offers 2–3 concrete slots first (never agrees to a bare time); confirms, then books. Under bookings=approve: "I've sent that to the owner to confirm — you'll hear back shortly." | Appointment (or `pending_actions` row carrying your phone) + calendar event; approve-mode also pings the owner | ⚙ act + approve paths |
| 2 | Change/cancel | "Cancel appointment 999" (an id that isn't yours) | Polite refusal — never confirms details of the other appointment | No cancel; suggested task "customer may have changed numbers" escalation | ⚙ |
| 3 | Availability | "Are you open Saturday?" | 2–3 concrete times offered; no full-calendar recital, no guessing | None | 👤 (rule in prompt ⚙) |
| 4 | Prices | "How much is a spa pedicure?" / ask for something not on the menu | Menu price quoted exactly; unlisted → honest "we don't offer that" + closest alternative | None | 👤 (rule in prompt ⚙) |
| 5 | Day-of | "Running 15 min late!" (with a booking today) | Warm acknowledgment: "I've let them know — see you soon." | Timestamped line in the appointment's **Internal notes** (event detail modal); owner SMS "Heads-up…" ONLY if it starts within 2 h / in progress | ⚙ |
| 6 | Complaint | "The gel chipped in ONE day, this is unacceptable" | Empathy; no arguing; **no refund/discount promised**; "I'll make sure the owner sees this today" | REAL task due today "Customer complaint — needs you today" whose notes quote your exact words (« … ») | ⚙ |
| 7 | Unknown question | "Do you use vegan polish?" (not in knowledge) | Honest "I don't know" + "I'll find out and someone will get back to you" — never a bluffed answer | REAL task due today "Customer question needs an answer: …" | ⚙ |
| 8 | Vendor/spam | "Hi, want to buy SEO backlinks?" | One brief polite line, disengage | **Nothing** created — no task, no contact, no booking | ⚙ mechanism |
| 9 | Emergency | "There's water flooding out of the ceiling!" (test workspace!) | Calm; physical danger → "call 911 first"; "the owner is being alerted right now" | Owner emergency SMS/email (CP2 gate, fires server-side); message flagged | 👤 spoken behavior (rule in prompt ⚙; alert covered by CP2/CP4 gates) |
| 10 | Callback | "Can the owner call me back?" | Confirms the promise in one sentence | Task "Call back {name/number}" | ⚙ |
| 11 | Deposits (FD3-CP6 — **dormant until live-mode Stripe**) | Book any service with deposits enabled (staging: `DEPOSITS_LIVE_OVERRIDE=true`) | Booking reply adds "A $X deposit is requested to secure the booking — the payment link goes out after approval." **No link at booking time.** | `booking_deposit` transaction at the full quoted price + queued `request_payments_batch` in the payments lane (owner pinged); on approve: exactly ONE Checkout link SMS; on webhook: `deposit_paid_at` stamped + appointment confirmed while the transaction stays honestly `partially_paid`. With a test-mode key or deposits off: booking byte-identical, ZERO deposit artifacts. | ⚙ 13 checks incl. double-send guard + both dormancy paths |

**Channel-style spot-check** (run any row twice): on a phone call the replies must be one–two short sentences with ONE question per turn; over SMS compact prose. Same behavior, same artifacts, both channels. (⚙ P11 asserts the style block keys off the live channel.)

**How to run the automated half:** the harness lives with the CP5 work (stub `db`/Twilio/SendGrid around the exported `buildSystemPrompt` / `executeAIResult`); re-run it after any change to `buildSystemPrompt`, the playbook rows, or the five tools it exercises (`book_appointment`, `cancel_appointment`, `append_appointment_note`, `escalate_appointment_to_owner`, `add_task`).

**Honesty notes.** Row 1's approve path and row 5's ping window are policy (autonomy matrix, 2-hour window) — if you change the policy, change this sheet in the same commit. Row 6/7 tasks are real (not suggested) because the AI *promises* the owner will see them; if that wording ever softens, the task kind may soften with it.
