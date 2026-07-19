# Admin Page Investigation

Read-only mapping before page-admin becomes the owner's **account home** (contact info, credentials, subscription/billing, payment rails) with My Business keeping business/AI config. Every claim cites `file:line` at HEAD `9f5b321`. Sections 1–6 are factual; Section 7 is the only opinion section.

---

## 1. FULL INVENTORY

`page-admin` spans `views/app.html:3149-3489`. Seven cards:

| Card | Lines | Controls → endpoints | Tag |
|---|---|---|---|
| **Notification settings** | 3167-3230 | Email-alerts toggle (`notifToggle` 3182) + notification email (`notifEmail` 3207) + emergency alert phone (`alertPhone` 3211) → `saveNotifSettings` → `PUT /api/settings` (`server.js:1323`); per-device push toggle (`pushToggle` 3196) → VAPID + `POST /api/push/subscribe` | **KEEP** — this is the owner's contact/notification config, the account home's core. |
| **Phone & email routing** | 3232-3258 | Read-only pills: business phone (`routingPhone` 3241) + inbound address (`routingEmail` 3246), loaded from `GET /api/settings` (`views/app.html:5208-5209`; endpoint `server.js:1315-1321` — `users.twilio_phone_number`, `users.inbound_email_alias`) | **DECIDE** — these are the BUSINESS's rails (front-desk number, mail alias) stored on USER-level columns (`server.js:1023-1024`). Natural home reads My Business; the account page could keep a read-only mirror. The user/workspace identity split (§4) is the real question. |
| **Plan & usage** | 3254-3299 | `planUsageCard` badge/price/status/grid/features fed by `GET /api/plan-summary` (`server.js:2359-2464`); Manage Billing + Upgrade Plan (3289-3290) → `openBillingPortal` → `POST /api/billing/portal-session` (`server.js:2756`) | **KEEP** — the subscription home (§5). |
| — Inventory-tracking toggle | 3275-3288 (inside Plan card, PS-only) | `invTrackToggle` → `POST /api/workspace/inventory-tracking` | **MOVE** — workspace/business config; belongs on My Business with the other workspace toggles. |
| **Auto-match payments** | 3301-3344 | Forwarding address copy (`payments+TOKEN@`), payment-events list + Run AI Match → `GET /api/payments/events`, `POST /api/payments/test`, confirm/dismiss per event (`server.js:2900-2950` region) | **REMOVE-PM** — the rent-payment email parser; matches to `rent_payments` (`markRentPaidFromEvent`, `server.js:5979`). PM plumbing, not account config. |
| **Rent payments** | 3345-3395 | Month/year filters, ⚡ Generate Month, mark-paid/late-notice/delete per row → `/api/rent*` (`server.js:7747-7846`) | **REMOVE-PM** — vertical operations, not account. |
| **Invoices & vendor payments** | 3397-3427 | Add/approve/reject/reset/delete + BG2's Mark-paid bridge → `/api/invoices*` (`server.js:7873-7906`), `POST /api/invoices/:id/mark-paid` | **MOVE** — bills are money-out; Finances is their home post-BG2 (the bridge already posts to the ledger there). |
| **Budget tracker** | 3429-3489 | Month/year selects, type filter, + Add Transaction modal (`views/app.html:13800s`), delete per row → `/api/budget*` (`server.js:4401-4431`) | **REMOVE-BUDGET** — superseded by the BG arc (§2). |

---

## 2. THE BUDGET REMNANT

**UI:** the budget card (3429-3489), the add-transaction modal, `loadBudget` (`views/app.html:7213`) and its render — plus the Home stats fetch of `/api/budget` for the income/expense chips (`views/app.html:9780`, hero chip `9820`).

**Endpoints:** `GET/POST/DELETE /api/budget` (`server.js:4401, 4414, 4429`). **Tool:** `add_budget_transaction` (PM-vertical, dollars — `lib/tools/add_budget_transaction.js:13,21`), listed in the /api/command prompt (`server.js:5448`).

**Every OTHER reader of `budget_transactions`:**
- **BG1's legacy read-through** — `lib/finances-summary.js:113` (expenses sum + by_category) and the BG8 ledger composer (`legacy_budget` feed) — the supersession itself; UNTOUCHED by any admin-UI removal.
- The Opus report generator's budget branch (`server.js:6698-6706`) and the AI-context snapshot (`snapshot.budget`, `server.js:6720`).
- Demo seeds (`server.js:977-1000`).

**Removing the admin UI breaks nothing:** the card/modal/loadBudget/Home-chips are the only UI writers-and-readers; the table, seeds, endpoints, tool, summary read-through, report, and snapshot are all independent of the DOM. (The Home chips would need their fetch removed alongside — same commit.)

**Tool/endpoint options (reported, not decided):** (a) retire both — manual expense entry is BG2's cents world now; PM loses manual *income* logging (rent is the canonical income; non-rent income has no home — a real loss to weigh); (b) keep both as the legacy PM path, hidden from admin (the read-through keeps displaying history either way); (c) restrict — keep GET (history) and retire POST/tool (no new dollar-world writes). Each is one small change; (c) matches the arc's never-write-legacy boundary most closely.

---

## 3. PM REMNANTS ON ADMIN

- The **Auto-match payments** card entire (3301-3344): "forwarded payment emails", tenant matching, `matched_rent_id`.
- The **Rent payments** card entire (3345-3395): "resident", "Unit", late notices ("— Property Management" template, `server.js:7873`).
- The **Budget tracker** card's seeded categories are PM-flavored (Landscaping, property insurance — `server.js:984-987`).
- PM wording in notification copy: "when a tenant message is held for manual review" (`views/app.html:3218`).
- Links OUT (blast radius if cards move/leave): Finances links IN to admin twice — the invoices card ("Manage invoices in Admin →", `views/app.html:3693`) and PM's rent card links; the home hero chips read `/api/budget` (`views/app.html:9780`). The AI tools `generate_rent`, `mark_rent_paid`, `send_late_notice` operate on the same tables from the panel regardless of this page.

---

## 4. ACCOUNT & CONTACT INFO

**What the owner can see/change about themselves today: notification email, alert phone, notifications toggle. Nothing else.**

- **Login is by USERNAME, not email** (`POST /api/login`, `server.js:1391-1399`, `SELECT * FROM users WHERE username=$1`). `users.email` (set at signup, `server.js:2307+`) is used for exactly one thing: the **password-reset lookup** (`LOWER(email) = $1`, `server.js:1430-1433`). There is **no change-email, no change-username, and no logged-in change-password** anywhere (grep: no such endpoint or UI). Password changes exist only via the forgot-password flow: email → silent-no-op on unknown address (enumeration-safe, `server.js:1435-1437`) → 32-byte token (`server.js:1442`) → `/reset-password` page → `POST /api/auth/reset-password` re-hashes (`server.js:1531, 1566`). Hashing is bcrypt (`server.js:33`, `BCRYPT_ROUNDS`); sessions are express-session cookies (`server.js:32, 254`) with an SHA-256-derived key (`server.js:461`).
- **A SAFE email change would require** (flagged, not designed): re-authentication (no logged-in password check exists today), verification of the NEW address before it becomes the reset target (otherwise an attacker with a session can redirect resets), notice to the OLD address, and awareness that email is the reset-flow's only identity anchor. Username change additionally touches the login key and the seeded-admin path (`server.js:838-841`). **Security-sensitive; deliberate design needed.**
- **notification_email / alert_phone / notifications_enabled:** editable on the admin Notification card (`PUT /api/settings`, `server.js:1323-1348`). Readers: `lib/owner-alert.js:20-24` (the ONE routing — emergency alerts, approval pings, deposit pings, day-of notes), `sendNotificationEmail` (`server.js:1174+`), and the reflection-adjacent passes that route through owner-alert.
- **inbound_email_alias (IB5):** visible read-only on the routing card (`views/app.html:5209`) and copyable in the auto-match card; **not editable anywhere**. Blast radius if changed: it is the inbound-mail routing KEY (`lookupUserByEmailAlias`, `server.js:6247-6255`) — mail to the old alias becomes UNROUTABLE (the IB5 loud-drop path); nothing else references it.
- **User-level vs workspace-level identity:** the OWNER's personal contact is `users.email/notification_email/alert_phone`. The BUSINESS's identity is split awkwardly: `users.twilio_phone_number` + `users.inbound_email_alias` (user columns, `server.js:1023-1024`) but ALSO `workspaces.twilio_phone_number` (`lookupWorkspaceByTwilioNumber` routes inbound by the WORKSPACE column, `server.js:6234-6241`; engine sends from it, `lib/appointment-engine.js:594`; outbound email is a hardcoded `noreply@modernmanagementapp.com` from-address with `SENDGRID_FROM_EMAIL` reply-to, e.g. `server.js:5881-5886`). Shown on admin's routing pills from the USER columns; the live routing reads the WORKSPACE column — a latent duplication to be aware of when carding this up.

---

## 5. SUBSCRIPTION & BILLING

- **Plan state:** `users.plan` (legacy, `server.js:829`) and the real one — `workspaces.plan` + `workspaces.subscription_status` (webhook-tracked: `invoice.payment_failed` etc., `server.js:78` comment; `planEnforcement.getWorkspacePlanInfo` composes it, `server.js:2367`). Stripe ids: `users.stripe_customer_id` (`server.js:1016`; documented in `023_multi_customer_workspace_columns.sql:90`) and `users.stripe_subscription_id` (`server.js:1017`) plus `workspaces.stripe_subscription_id` (`024_signup_session_state.sql:96`, written by the signup orchestrator).
- **The Billing Portal already works:** `POST /api/billing/portal-session` (`server.js:2756-2790`) issues a real Stripe Billing Portal session from `stripe_customer_id` (honest errors when absent/unconfigured); both admin buttons call it (`views/app.html:3289-3290`). The past-due/canceled banner is topbar-global (`subscriptionBanner`, `views/app.html:2229-2233`).
- **What the owner can SEE today:** the Plan & usage card renders plan name/price/status + resource-usage bars + feature list from `GET /api/plan-summary` (`server.js:2359-2464`). **No invoice history, no next-billing-date, no card-on-file display** — the portal link is the only window into charges. Expected-little, confirmed.

---

## 6. PAYMENT RAILS SURFACES

- **Processor connection lives on Finances** — the Connect status card (`connectCard`, `views/app.html:3574`, PS-only, driven by `connect_status`/`connect_charges_enabled` from `041_connect_accounts.sql:27-42`; onboarding `POST /api/connect/onboarding/start`, `server.js:2036+`). Natural home: **stays on Finances** (it's money infrastructure the dashboard depends on) with at most a status line + link on the account page — the account page owns the RELATIONSHIP (billing MM), Finances owns the BUSINESS's rails.
- **Where a "or pay via Venmo @handle" line would join:** the payment-request SMS body is composed at exactly one point — `lib/payment-requests.js:221` (`"...secure ${label} link for $X — ${session.url}"`). A stored handle (workspace-level) appended there covers the batch tool AND the button path (both funnel through `createPaymentRequest`, `lib/tools/request_payments_batch.js:131`, `server.js:8670`).
- **payment_method already fits:** the `transaction_payments` CHECK is `('cash','card','venmo','zelle','gift_card','stripe','other')` (`042_transaction_payments.sql:67-70`) — **no migration needed** for Venmo/Zelle money-in rows; `recordPayment` passes the method through (`lib/payment-ledger.js:46-71`).
- **Owner-confirmed money-IN** ("did that $80 Venmo arrive?") mirrors BG5 exactly: a `requiresApproval` tool → `pending_actions` → approve executes `recordPayment(payment_method:'venmo')` + recompute — every choke point already exists (`lib/payment-ledger.js:97-151`, approve path `server.js:7257+`); alternatively the CP7 suggestion chassis for AI-detected "customer says they Venmo'd you".
- **Square (the future SQ arc) would touch:** a webhook entry alongside the Stripe dispatch (`server.js:2001-2060` — signature scheme differs, needs its own raw-body route like `server.js:243`), checkout/payment-link creation as a sibling of `createPaymentRequest`'s session block (`lib/payment-requests.js:158-180` — the ledger insert + double-send guard around it are processor-agnostic), ledger posting through the SAME `recordPayment`/`processCustomerPaymentCompletedEvent` discipline keyed by a Square payment id (the idempotency unique-index pattern, `042:92-94`, would need a Square-id column or a generalized external-id column), connection state as sibling columns to `workspaces.stripe_connect_*` (041), and the `depositsLive()`-style live/test detector generalized per processor (`lib/deposits.js:17-21`). None of this exists; all of it has a Stripe-shaped template.

---

## 7. GAPS & BUILD ORDER (opinion)

1. **AD1 — Cleanup.** Remove REMOVE-tagged cards (budget tracker + its Home chips, rent payments, auto-match) and move the invoices card to Finances + the inventory toggle to My Business; pick a §2 option for the budget endpoints/tool (I lean (c): keep GET, retire POST/tool — matches the never-write-legacy boundary). Pure deletion/relocation; the BG read-through guarantees history keeps rendering on Finances.
2. **AD2 — Account & contact card.** Editable notification email/alert phone (exists — restyle into the account frame), read-only login identity (username + account email), the routing pills clarified as business identity with a pointer to My Business, and the user-vs-workspace Twilio duplication (§4) resolved read-side.
3. **AD3 — Credentials, deliberately.** Logged-in password change (current-password required) and email change with new-address verification + old-address notice (§4's flags). **Security-sensitive: design first, small surface, no shortcuts** — this is the checkpoint that needs its own spec.
4. **AD4 — Subscription card.** Plan & usage stays; add what the portal can't show at a glance (status, renewal date via the subscription id, past-due surfaced beyond the banner). The portal session endpoint already does the heavy lifting.
5. **AD5 — Venmo/Zelle rails.** Workspace-level handle storage (settings-bus pattern), the one-line join in `payment-requests.js:221`, and owner-confirmed money-in via the BG5 mirror. No CHECK migration needed (§6).
6. **SQ arc (separate, later)** — needs built from zero: Square webhook route + signature verification, a processor-agnostic external-payment-id on `transaction_payments`, sibling connect columns + onboarding, a per-processor live/test detector, and checkout creation beside the Stripe session block. The ledger and confirmation machinery need nothing new.

Ordering rationale: cleanup first so the account frame is built on an empty stage; contact before credentials (low-risk before high-risk on the same card); billing next (mostly display over existing endpoints); rails last among AD checkpoints because they ride patterns (BG5, settings bus) that don't depend on the earlier admin work.
