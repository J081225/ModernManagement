# ST1 Investigation — The Settings Page

Look-first for the ST arc. No code changed. Evidence cited as
file:line or live-DB reads (2026-08-06).

## 1. Every setting that actually exists today

Three homes already exist. Every control below has a live endpoint
and arc-era suite coverage — "works" is the norm, exceptions flagged.

### Admin page (`page-admin`) — the account: identity, reach, credentials, plan

| Setting | Storage | Controls | Works? |
|---|---|---|---|
| Notification email (+ verify) | users.notification_email, _verified_at | where owner alerts/emails land (owner-alert chain rung 2) | ✓ AD2/AD5 |
| Notifications enabled | users.notifications_enabled | master gate on non-emergency owner notifications (respectEnabled) | ✓ AD2 |
| Alert phone (+ verify, + test) | users.alert_phone, _verified_at | owner SMS alerts (owner-alert rung 1); `/api/settings/test-alert` | ✓ AD2/AD5 |
| Login email (verified change) | users.email + pending_email flow | account email, AD3's 4-law flow | ✓ AD3 |
| Username / password | users | credentials; changes burn sessions/tokens (AD7 artifact burn — automatic, not a setting) | ✓ AD3/AD7 |
| Business identity card | workspaces (read) + users.inbound_email_alias | READ/copy-only: business number (+ SP4b retry when failed), inbound alias. business_name/number have NO edit path (deliberate — "contact support") | ✓ |
| Plan & usage | Stripe billing portal + users.plan | Manage Billing / Upgrade via `openBillingPortal()` | ✓ D5 |
| Inventory tracking toggle | workspaces.inventory_tracking_enabled | shows/hides PS inventory nav + behavior | ✓ |

### My Business page (`page-my-business`) — business behavior

| Setting | Storage | Controls | Works? |
|---|---|---|---|
| Auto-respond | workspaces.appointment_auto_respond | THE master gate on the customer AI engine (appointment-engine:56) | ✓ |
| Auto-confirm | workspaces.appointment_auto_confirm | AI bookings land confirmed vs requested (book_appointment:66) | ✓ |
| AI tone / sales posture | workspaces.ai_tone / ai_sales_posture | prompt personality injection (engine:456) | ✓ |
| Autonomy matrix (4 lanes) | workspaces.autonomy_bookings/contacts/tasks/payments | per-category act-vs-queue via lib/autonomy choke point | ✓ FD3 |
| Deposits (on/mode/value) | workspaces.deposit_* | booking-deposit policy, honest reality gate (depositsLive) | ✓ FD3-CP6 |
| Services & Products | menu tables | what Sarah quotes and books | ✓ |

### Operations page (`page-operations`) — PM-side

| Setting | Storage | Controls | Works? |
|---|---|---|---|
| Response mode (manual/auto) | automation."autoReplyEnabled" | PM auto-reply, with the consent endpoint (server:5018) | ✓ |
| Connected email account | email_accounts (connect/test/sync/delete, server:3329–3426) | inbound email ingestion + payment-forwarding | ✓ |

Also real but scoped elsewhere: per-thread AI pause (IB4, a
conversation control, not a setting); payments+TOKEN@ forwarding
address (users.payment_forward_token, PM email parsing).

## 2. The AI/copy overclaim census

Method: pattern census across server.js, lib/**, lib/tools/**, views
for "settings", directional copy ("in Admin", "open X and…"), and
configurability claims in prompts + tool descriptions.

**TRUE claims (leave alone):**
- `update_ai_settings` tool description — mirrors PATCH
  /api/workspace/ai-settings field-for-field, approval-gated,
  customer-channel blocked twice (engine gate + execute guard). The
  owner-AI's claims surface IS the tool registry, and it matches
  reality.
- Provisioning owner-task "retry from Admin" — the retry button is on
  Admin's identity card. True (SP4b).
- **Sarah (customer-facing) makes NO settings claims anywhere** — the
  engine prompt and every customer-reachable tool message are clean.

**OVERCLAIMS / MISDIRECTIONS (the fix list — all in the welcome
emails, lib/signup-orchestrator.js):**
1. **"Manage billing in Settings."** — ×4 (both verticals, HTML+text;
   lines 113/148/190/221). No surface named "Settings" exists
   anywhere in the product. The capability exists — Admin → Plan &
   usage → Manage Billing. Wrong name, right feature.
2. **PS: "open Admin and turn on auto-respond"** (line ~196) —
   auto-respond lives on **My Business** ("How your assistant
   works"), not Admin. A new owner following their welcome email
   lands on the wrong page for the arc's most important toggle.
3. **PM: "Set your alert phone in Admin → Notification Settings"**
   (119/153) — right page, stale card name (the card is "How Modern
   Management reaches you"). Mildest of the three.

Also noted (internal, not user-facing): code comments speak of "the
global switch lives in settings" (app.html:5077) — the team's mental
model has a Settings home the product doesn't name.

## 3. Near-misses vs no-backend

**Real hooks, no UI (the arc's candidates):**
- **Timezone** (workspaces.timezone) — THE near-miss. It already
  drives calendar day-math, ledger/report dating (wsTz), and "today"
  everywhere; set at signup, never editable. A business that moves
  or got it wrong has no recourse.
- **Backup area code** (workspaces.area_code_backup_preference) —
  read by the SP4a worker's fallback chain; settable only at signup.
  Minor (only matters pre-provisioning or re-arm).
- **Inbound alias regeneration / payment-forwarding surfacing** —
  tokens exist and work; the Admin card shows the alias read-only.
  Rotation has no UI (and arguably shouldn't, quietly — flag only).

**NO backend behavior — build NO toggles (the no-fake-controls list):**
quiet hours / notification schedules; per-event notification
granularity; language/locale; currency; SMS signature; business
hours as structured data (hours live in the knowledge base via
`update_knowledge`, which works — a structured-hours SETTING would be
new backend, not a toggle); owner-side dark mode / display prefs;
data export. None of these get a control until their behavior exists.

## 4. Information architecture — recommendation

**The Finances-pattern judgment applied: settings should live where
their domain lives, and they already do.** My Business = how the
business behaves (assistant, autonomy, deposits, menu). Admin = who
you are and how we reach you (identity, credentials, notifications,
plan). Operations = PM's operational mode + email plumbing. Moving
working, arc-pinned controls onto a monolithic Settings page would
break domain context, churn suites, and recreate the drift the
Finances page avoided.

**The actual defect is naming and discoverability, not placement:**
outbound copy says "Settings"; the product says "Admin" and "My
Business"; nothing indexes the three homes.

Recommended shape (smallest true fix first):
- **ST2 — every claim becomes true**: fix the three welcome-email
  overclaims to name the real homes ("Admin → Plan & usage",
  "My Business → How your assistant works", the real card name), and
  pin the claims with a census row so future copy can't point at
  places that don't exist.
- **ST3 (optional, ruling 6)** — a thin **Settings index**: one page
  (or Admin-page section) that LINKS to the real homes with one-line
  descriptions. No duplicated controls, no moved controls — an index,
  so "where do I change X?" has one answer. Cheap, honest,
  low-risk.
- **ST4 (ruling 2)** — the timezone setting on My Business (real
  hooks, real need), with the calendar/ledger implications stated in
  the UI copy.

## Rulings for Jay

1. **Naming**: keep "Admin" and fix the copy to say Admin (recommended),
   or rename Admin → "Settings" to match the copy? (Renaming touches
   nav, welcome emails, AD-arc suite pins.)
2. **Timezone UI** — build in this arc? (Recommend yes: real hooks,
   no recourse today.)
3. **Backup area code** post-signup exposure — build or leave
   signup-only? (Recommend leave; only matters pre-provisioning.)
4. **The no-backend list** — confirm the standing no-fake-controls
   rule covers all of §3's second list.
5. **Welcome-email copy fixes** — in-scope for ST2 as proposed?
6. **The Settings index page** (ST3) — wanted, or is fixed copy
   enough?
