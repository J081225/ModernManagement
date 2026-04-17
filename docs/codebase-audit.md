# Modern Management -- Codebase Audit

Generated: 2026-04-16

---

## 1. Complete File Tree

```
ModernManagement/
|-- .env                          (environment variables -- gitignored)
|-- .gitignore
|-- README.md
|-- package.json
|-- package-lock.json
|-- server.js                     (2643 lines -- entire backend)
|-- node_modules/                 (gitignored)
|-- public/
|   |-- landing.html              (marketing landing page)
|   |-- login.html                (login form)
|   |-- signup.html               (signup form)
|   |-- sms-consent.html          (SMS consent disclosure)
|   |-- how-it-works.html         (marketing page)
|   |-- why-ai.html               (marketing page)
|   |-- css/
|   |   |-- features.css          (shared CSS for feature pages)
|   |-- features/
|       |-- ai.html
|       |-- broadcasts-and-contacts.html
|       |-- budget.html
|       |-- calendar.html
|       |-- inbox.html
|       |-- knowledge-base.html
|       |-- maintenance.html
|       |-- rent-and-leases.html
|       |-- reports.html
|       |-- tasks.html
|-- views/
    |-- app.html                  (4179 lines -- entire SPA frontend)
```

**Key observations:**
- Monolithic single-file backend (`server.js`, 2643 lines).
- Monolithic single-file SPA frontend (`views/app.html`, 4179 lines -- HTML + CSS + JS all inline).
- No test files, no CI config, no Docker/container files.
- Marketing pages live under `public/features/`.

---

## 2. Full Database Schema

All tables are created inside the `initDB()` function (lines 292-604) using PostgreSQL via `pg.Pool`. Migrations use a safe `migrate()` helper (line 91) that wraps `ALTER TABLE` in try/catch so failures are logged but never crash the server.

### 2.1 `users`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `username` | TEXT | -- | UNIQUE NOT NULL | lowercased on signup |
| `password_hash` | TEXT | -- | NOT NULL | bcrypt hash |
| `email` | TEXT | `''` | | |
| `plan` | TEXT | `'free'` | | `'free'`, `'pro'`, or `'admin'` |
| `created_at` | TIMESTAMPTZ | `NOW()` | | |
| `notification_email` | TEXT | `''` | | (migration, line 477) |
| `notifications_enabled` | BOOLEAN | `true` | | (migration, line 478) |
| `onboarding_completed` | BOOLEAN | `false` | | (migration, line 481) |
| `stripe_customer_id` | TEXT | `''` | | (migration, line 482) |
| `stripe_subscription_id` | TEXT | `''` | | (migration, line 483) |
| `payment_forward_token` | TEXT | `''` | | (migration, line 486) Unique per-user token for email-forwarded payment matching |

Created: line 297. Migrations: lines 477-486.

### 2.2 `messages`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `resident` | TEXT | | | Sender name |
| `subject` | TEXT | | | |
| `category` | TEXT | | | `'email'`, `'sms'`, `'voicemail'`, `'maintenance'`, `'renewal'` |
| `text` | TEXT | | | Message body |
| `status` | TEXT | `'new'` | | `'new'`, `'sent'` |
| `folder` | TEXT | `'inbox'` | | `'inbox'`, `'archived'`, `'deleted'` |
| `email` | TEXT | | | Sender email address |
| `phone` | TEXT | | | Sender phone number |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | Quoted camelCase |

Created: line 322. Migration: line 337.

### 2.3 `contacts`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `name` | TEXT | | | |
| `type` | TEXT | | | `'resident'`, `'vendor'`, `'important'` |
| `unit` | TEXT | | | Unit number |
| `email` | TEXT | | | |
| `phone` | TEXT | | | |
| `notes` | TEXT | | | |
| `lease_start` | TEXT | `''` | | (migration, line 472) |
| `lease_end` | TEXT | `''` | | (migration, line 473) |
| `monthly_rent` | NUMERIC(10,2) | `0` | | (migration, line 474) |

Created: line 347. Migrations: lines 359, 472-474.

### 2.4 `tasks`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `title` | TEXT | | | |
| `category` | TEXT | | | `'vendor'`, `'maintenance'`, `'lease'`, `'finance'`, `'other'` |
| `"dueDate"` | TEXT | | | YYYY-MM-DD string |
| `notes` | TEXT | | | |
| `done` | BOOLEAN | `false` | | |
| `suggested` | BOOLEAN | `false` | | AI-suggested flag |
| `"aiReason"` | TEXT | `''` | | Explanation of why AI suggested this task |

Created: line 370. Migrations: lines 383-385.

### 2.5 `maintenance_tickets`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `title` | TEXT | -- | NOT NULL | |
| `description` | TEXT | `''` | | |
| `unit` | TEXT | `''` | | |
| `resident` | TEXT | `''` | | |
| `category` | TEXT | `'general'` | | `'plumbing'`, `'electrical'`, `'hvac'`, `'appliance'`, `'structural'`, `'pest'`, `'general'` |
| `priority` | TEXT | `'normal'` | | `'normal'` or `'emergency'` (auto-detected) |
| `status` | TEXT | `'open'` | | `'open'`, `'resolved'` |
| `outcome` | TEXT | `''` | | |
| `requires_action` | BOOLEAN | `false` | | |
| `action_notes` | TEXT | `''` | | |
| `emergency_sms_sent` | BOOLEAN | `false` | | |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |
| `"updatedAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 395. Migration: line 414.

### 2.6 `cal_events`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `date` | TEXT | | | YYYY-MM-DD string |
| `title` | TEXT | | | |

Created: line 417. Migration: line 425.

### 2.7 `budget_transactions`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `type` | TEXT | -- | NOT NULL | `'income'` or `'expense'` |
| `category` | TEXT | | | Free-form (e.g. `'Rent Received'`, `'Maintenance'`, `'Landscaping'`) |
| `description` | TEXT | | | |
| `amount` | NUMERIC(10,2) | -- | NOT NULL | |
| `date` | TEXT | | | YYYY-MM-DD string |
| `notes` | TEXT | | | |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 433. Migration: line 446.

### 2.8 `automation`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `user_id` | INTEGER | -- | PRIMARY KEY | One row per user |
| `"autoReplyEnabled"` | BOOLEAN | `false` | | Toggle for auto-reply to inbound messages |

Created: line 462.

### 2.9 `email_accounts`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | -- | NOT NULL UNIQUE | One account per user |
| `email` | TEXT | -- | NOT NULL | |
| `provider` | TEXT | `'custom'` | | Auto-detected: `'gmail'`, `'outlook'`, `'yahoo'`, etc. |
| `imap_host` | TEXT | -- | NOT NULL | |
| `imap_port` | INTEGER | `993` | | |
| `smtp_host` | TEXT | -- | NOT NULL | |
| `smtp_port` | INTEGER | `465` | | |
| `encrypted_password` | TEXT | -- | NOT NULL | AES-256-GCM encrypted |
| `last_sync_uid` | INTEGER | `0` | | IMAP UID watermark for incremental sync |
| `last_sync_at` | TIMESTAMPTZ | | | |
| `sync_enabled` | BOOLEAN | `true` | | |
| `created_at` | TIMESTAMPTZ | `NOW()` | | |

Created: line 489.

### 2.10 `payment_events`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | -- | NOT NULL | |
| `raw_from` | TEXT | `''` | | Original sender |
| `raw_subject` | TEXT | `''` | | Original subject |
| `raw_body` | TEXT | `''` | | Truncated to 4000 chars |
| `parsed_tenant` | TEXT | `''` | | AI-extracted payer name |
| `parsed_amount` | NUMERIC(10,2) | `0` | | AI-extracted payment amount |
| `parsed_date` | TEXT | `''` | | AI-extracted date |
| `parsed_source` | TEXT | `''` | | e.g. `'Zelle'`, `'Venmo'` |
| `confidence` | TEXT | `'low'` | | `'high'`, `'medium'`, `'low'`, `'none'` |
| `matched_rent_id` | INTEGER | | | FK to `rent_payments.id` (logical, not enforced) |
| `status` | TEXT | `'needs_review'` | | `'auto_matched'`, `'needs_review'`, `'unmatched'`, `'not_payment'`, `'dismissed'` |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 508.

### 2.11 `rent_payments`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `resident` | TEXT | -- | NOT NULL | |
| `unit` | TEXT | `''` | | |
| `amount` | NUMERIC(10,2) | -- | NOT NULL | |
| `due_date` | TEXT | | | YYYY-MM-DD string |
| `status` | TEXT | `'pending'` | | `'pending'`, `'paid'`, `'late'` |
| `notes` | TEXT | `''` | | |
| `paid_date` | TEXT | `''` | | |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 536. Migrations: lines 550-551.

### 2.12 `invoices`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `vendor` | TEXT | -- | NOT NULL | |
| `description` | TEXT | `''` | | |
| `amount` | NUMERIC(10,2) | -- | NOT NULL | |
| `date` | TEXT | | | |
| `status` | TEXT | `'pending'` | | `'pending'`, `'paid'` |
| `notes` | TEXT | `''` | | |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 554. Migration: line 567.

### 2.13 `knowledge`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `title` | TEXT | -- | NOT NULL | |
| `type` | TEXT | `'policy'` | | `'policy'`, `'procedure'`, `'uploaded'` |
| `content` | TEXT | `''` | | Full text content |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 570. Also defensively re-created in `ensureKnowledgeTable()` (line 1373).

### 2.14 `broadcasts`

| Column | Type | Default | Constraints | Notes |
|---|---|---|---|---|
| `id` | SERIAL | auto | PRIMARY KEY | |
| `user_id` | INTEGER | `1` | NOT NULL | |
| `channel` | TEXT | -- | NOT NULL | `'email'` or `'sms'` |
| `subject` | TEXT | `''` | | |
| `body` | TEXT | -- | NOT NULL | |
| `recipient_filter` | TEXT | `'all'` | | `'all'`, `'resident'`, `'vendor'`, `'custom'` |
| `recipient_count` | INTEGER | `0` | | |
| `sent_count` | INTEGER | `0` | | |
| `failed_count` | INTEGER | `0` | | |
| `"createdAt"` | TIMESTAMPTZ | `NOW()` | | |

Created: line 589.

### Relationships summary

There are **no enforced foreign keys** in any table. All relationships are logical, enforced by application code via `user_id` columns:

- Every data table has `user_id` referencing `users.id`.
- `payment_events.matched_rent_id` references `rent_payments.id` (logical only).
- `contacts` serves as the source of truth for resident names; `rent_payments.resident` and `maintenance_tickets.resident` match by name string, not by FK.
- `automation` uses `user_id` as its PRIMARY KEY (one row per user).
- `email_accounts` has a UNIQUE constraint on `user_id` (one account per user).

### Indexes

No explicit indexes are created beyond the implicit ones from PRIMARY KEY and UNIQUE constraints.

---

## 3. Every API Endpoint

### Legend
- **Auth**: `requireAuth` = API middleware returning 401 JSON; `requireAuthPage` = page middleware redirecting to `/login`; `session` = uses catch-all `/api` middleware (line 989); `open` = no auth required; `webhook` = inbound webhook (no auth).

### Page Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | Serves landing.html or redirects to /workspace if authenticated (line 58) |
| GET | `/login` | none | Serves login.html or redirects to /workspace (line 62) |
| GET | `/signup` | none | Serves signup.html or redirects to /workspace (line 66) |
| GET | `/workspace` | requireAuthPage | Serves views/app.html (line 70) |
| GET | `/sms-consent` | none | SMS consent page (line 75) |
| GET | `/how-it-works` | none | Marketing page (line 76) |
| GET | `/why-ai` | none | Marketing page (line 77) |
| GET | `/features/ai` | none | Feature page (line 78) |
| GET | `/features/inbox` | none | Feature page (line 79) |
| GET | `/features/rent-and-leases` | none | Feature page (line 80) |
| GET | `/features/broadcasts-and-contacts` | none | Feature page (line 81) |
| GET | `/features/maintenance` | none | Feature page (line 82) |
| GET | `/features/budget` | none | Feature page (line 83) |
| GET | `/features/tasks` | none | Feature page (line 84) |
| GET | `/features/reports` | none | Feature page (line 85) |
| GET | `/features/calendar` | none | Feature page (line 86) |
| GET | `/features/knowledge-base` | none | Feature page (line 87) |
| GET | `/healthz` | none | Health check for Render (line 2622) |

### Auth Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/login` | open | Authenticate user | `{ username, password }` | `{ success: true }` or 401 |
| POST | `/api/signup` | open | Create new user account | `{ username, password, email }` | `{ success: true }` or 400/409 |
| GET | `/api/logout` | none | Destroy session, redirect to `/` | -- | Redirect |
| GET | `/api/me` | requireAuth | Get current user profile | -- | `{ id, username, email, plan, onboarding_completed }` |
| PUT | `/api/me/onboarding` | requireAuth | Mark onboarding complete | -- | `{ success: true }` |

### Settings Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/settings` | requireAuth | Get notification settings | -- | `{ notification_email, notifications_enabled }` |
| PUT | `/api/settings` | requireAuth | Update notification settings | `{ notification_email, notifications_enabled }` | `{ notification_email, notifications_enabled }` |

### Connected Email Account Routes (IMAP/SMTP)

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/email-account` | requireAuth | Get connection status | -- | `{ connected, account }` |
| GET | `/api/email-account/detect` | requireAuth | Auto-detect IMAP/SMTP settings from email | Query: `?email=...` | `{ name, imap, smtp, imap_port, smtp_port, domain }` |
| POST | `/api/email-account/test` | requireAuth | Test IMAP credentials without saving | `{ email, password, imap_host?, imap_port? }` | `{ success, mailboxCount }` or `{ success: false, error }` |
| POST | `/api/email-account/connect` | requireAuth | Connect/update email account (tests first) | `{ email, password, imap_host?, imap_port?, smtp_host?, smtp_port? }` | `{ success: true }` or 400 |
| POST | `/api/email-account/sync` | requireAuth | Trigger manual IMAP sync | -- | `{ synced }` or `{ synced, error }` |
| DELETE | `/api/email-account` | requireAuth | Disconnect and delete credentials | -- | `{ success: true }` |

### Payment Forwarding Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/payments/forwarding-info` | requireAuth | Get user's forwarding address | -- | `{ token, address }` |
| POST | `/api/payments/rotate-token` | requireAuth | Generate new forwarding token | -- | `{ token, address }` |
| GET | `/api/payments/events` | requireAuth | List payment events | Query: `?status=...` | Array of payment_events joined with rent_payments |
| POST | `/api/payments/events/:id/confirm` | requireAuth | Confirm a payment event match | `{ rentId? }` | `{ success: true }` |
| POST | `/api/payments/events/:id/dismiss` | requireAuth | Dismiss a payment event | -- | `{ success: true }` |
| POST | `/api/payments/test` | requireAuth | Test payment email parsing | `{ from?, subject?, body }` | Payment event object |

### Contacts Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/contacts` | session | List all contacts for user | -- | Array of contact objects |
| POST | `/api/contacts` | session | Create a contact | `{ name, type, unit, email, phone, notes }` | Contact object (201) |
| PUT | `/api/contacts/:id` | session | Update a contact | `{ name, type, unit, email, phone, notes, lease_start, lease_end, monthly_rent }` | Contact object |
| DELETE | `/api/contacts/:id` | session | Delete a contact | -- | `{ success: true }` |
| POST | `/api/contacts/import` | session | CSV bulk import contacts | multipart file upload | `{ imported, errors }` |

### Leases Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/leases` | requireAuth | List residents with lease end dates | -- | Array of contacts with `days_until` computed column |
| POST | `/api/leases/check-renewals` | requireAuth | Auto-create renewal tasks for leases expiring in 90 days | -- | `{ checked, tasksCreated }` |

### Tasks Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/tasks` | session | List all tasks | -- | Array of task objects |
| POST | `/api/tasks` | session | Create a task | `{ title, category, dueDate, notes, suggested?, aiReason? }` | Task object (201) |
| PUT | `/api/tasks/:id` | session | Update a task | `{ done, title, category, dueDate, notes }` | Task object |
| PUT | `/api/tasks/:id/approve` | session | Approve an AI-suggested task (set suggested=false) | -- | Task object |
| DELETE | `/api/tasks/:id/reject` | session | Reject (delete) an AI-suggested task | -- | `{ success: true }` |
| DELETE | `/api/tasks/:id` | session | Delete a task | -- | `{ success: true }` |

### Maintenance Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/maintenance` | session | List all maintenance tickets | -- | Array of ticket objects |
| POST | `/api/maintenance` | session | Create a ticket (auto-detects emergencies) | `{ title, description, unit, resident, category }` | Ticket object (201) |
| PUT | `/api/maintenance/:id` | session | Update ticket status/outcome | `{ status, outcome, requires_action, action_notes }` | Ticket object |
| DELETE | `/api/maintenance/:id` | session | Delete a ticket | -- | `{ success: true }` |

### Calendar Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/calevents` | session | List all calendar events | -- | Array of event objects |
| POST | `/api/calevents` | session | Create a calendar event | `{ date, title }` | Event object (201) |
| DELETE | `/api/calevents/:id` | session | Delete a calendar event | -- | `{ success: true }` |

### Budget Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/budget` | session | List budget transactions (optional month/year filter) | Query: `?month=&year=` | Array of transaction objects |
| POST | `/api/budget` | session | Create a budget transaction | `{ type, category, description, amount, date, notes }` | Transaction object (201) |
| DELETE | `/api/budget/:id` | session | Delete a budget transaction | -- | `{ success: true }` |

### Automation Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/automation` | session | Get automation settings | -- | `{ autoReplyEnabled }` |
| PUT | `/api/automation` | session | Toggle auto-reply | `{ autoReplyEnabled }` | `{ autoReplyEnabled, managerReviewRequired }` |

### Messages Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/messages` | session | List messages by folder | Query: `?folder=inbox` | Array of message objects |
| GET | `/api/messages/:id` | session | Get single message | -- | Message object |
| POST | `/api/messages` | session | Create a message | `{ resident, subject, category, text }` | Message object (201) |
| PUT | `/api/messages/:id/folder` | session | Move message to folder | `{ folder }` | Message object |
| PUT | `/api/messages/:id/status` | session | Update message status | `{ status }` | Message object |
| DELETE | `/api/messages/:id` | session | Delete a message | -- | `{ success: true }` |
| DELETE | `/api/messages/folder/deleted` | session | Empty the deleted folder | -- | `{ success: true }` |

### Drafts Routes (in-memory, ephemeral)

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/drafts` | none* | List all drafts | -- | Array of draft objects |
| POST | `/api/drafts` | none* | Create a draft | `{ messageId, content, status }` | Draft object (201) |
| PUT | `/api/drafts/:id` | none* | Update a draft | any fields | Draft object |

*Drafts are stored in a global in-memory array (line 1333), not per-user. They are shared across all sessions.

### Knowledge Base Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/knowledge` | requireAuth | List knowledge docs | -- | Array of knowledge objects |
| POST | `/api/knowledge` | requireAuth | Create a knowledge doc | `{ title, type, content }` | Knowledge object (201) |
| PUT | `/api/knowledge/:id` | requireAuth | Update a knowledge doc | `{ title, type, content }` | Knowledge object |
| DELETE | `/api/knowledge/:id` | requireAuth | Delete a knowledge doc | -- | `{ success: true }` |
| POST | `/api/knowledge/upload` | requireAuth | Upload PDF or TXT file | multipart file upload | Knowledge object (201) |

### AI Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/generate` | session | Generate AI draft reply to a message | `{ messageId, contacts }` | Draft object `{ id, messageId, content, status, createdAt }` |
| POST | `/api/command` | requireAuth | AI command center (multi-tool) | `{ prompt, contacts, calEvents, tasks, messages, rentRecords, maintenanceTickets }` | `{ reply, actions[] }` |
| POST | `/api/report` | session | Generate AI property report | `{ tasks, messages, calEvents, contacts, budget }` | `{ report }` (markdown string) |

### Communication Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/email/send` | session | Send email (prefers connected account, falls back to SendGrid) | `{ to, subject, body }` | `{ success, via }` |
| POST | `/api/sms/send` | session | Send SMS via Twilio | `{ to, body }` | `{ success, sid }` |

### Inbound Webhook Routes (no auth)

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/email/incoming` | open (webhook) | SendGrid inbound parse webhook; also handles payment-forwarded emails | SendGrid multipart | 200 |
| POST | `/api/sms/incoming` | open (webhook) | Twilio inbound SMS webhook | Twilio form data | TwiML XML |
| POST | `/api/voice/incoming` | open (webhook) | Twilio incoming call -- plays greeting, starts recording | Twilio form data | TwiML XML |
| POST | `/api/voice/recording` | open (webhook) | Twilio recording callback -- saves voicemail placeholder | Twilio form data | TwiML XML |
| POST | `/api/voice/transcription` | open (webhook) | Twilio transcription callback -- updates voicemail text | Twilio form data | 200 |

### Rent Payment Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/rent` | requireAuth | List rent payments (optional month/year filter) | Query: `?month=&year=` | Array of rent payment objects |
| POST | `/api/rent` | requireAuth | Create a rent payment record | `{ resident, unit, amount, due_date, notes }` | Rent payment object (201) |
| PUT | `/api/rent/:id` | requireAuth | Update rent payment | `{ status, notes, amount, due_date }` | Rent payment object |
| DELETE | `/api/rent/:id` | requireAuth | Delete a rent payment | -- | `{ success: true }` |
| POST | `/api/rent/generate-month` | requireAuth | Generate monthly rent records from contacts | `{ month, year, due_day? }` | `{ created, skipped, total }` |
| POST | `/api/rent/:id/late-notice` | requireAuth | Send late payment notice via email or SMS | -- | `{ success, sent, channel, contactFound }` |

### Invoice Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/invoices` | requireAuth | List all invoices | -- | Array of invoice objects |
| POST | `/api/invoices` | requireAuth | Create an invoice | `{ vendor, description, amount, date, notes }` | Invoice object (201) |
| PUT | `/api/invoices/:id` | requireAuth | Update invoice status | `{ status, notes }` | Invoice object |
| DELETE | `/api/invoices/:id` | requireAuth | Delete an invoice | -- | `{ success: true }` |

### Broadcast Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| GET | `/api/broadcasts` | requireAuth | List recent broadcasts (limit 50) | -- | Array of broadcast objects |
| POST | `/api/broadcast` | requireAuth | Send broadcast to filtered contacts | `{ channel, subject, body, recipientFilter, contactIds? }` | `{ broadcastId, recipientCount, status }` |

### Stripe Billing Routes

| Method | Path | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/billing/create-checkout` | requireAuth | Create Stripe Checkout session for Pro upgrade | -- | `{ url }` |
| GET | `/api/billing/portal` | requireAuth | Get Stripe customer portal URL | -- | `{ url }` |
| POST | `/api/billing/webhook` | open (webhook) | Stripe webhook for subscription events | raw JSON body | 200 |

---

## 4. Hardcoded Domain Terminology

The following analysis covers `server.js` and `views/app.html` code logic -- not marketing pages which are expected to contain these terms.

### server.js

| Term | Lines (selected) | Context |
|---|---|---|
| `tenant` | 515, 1845-1858, 1896, 1901-1911, 2008 | `parsed_tenant` column; AI payment parsing prompt uses "tenant" for payer name; `matchPaymentToRent` uses `tenantLower` |
| `rent` | 451-458, 474, 536-551, 1531, 1542-1543, 1609-1631, 1663-1675, 1881-1926, 2213-2327 | Pervasive: `rent_payments` table, `monthly_rent` column, rent generation, rent matching, late notices, AI tool `mark_rent_paid`, `generate_rent`, `send_late_notice` |
| `lease` | 364-366, 391, 471-473, 1030-1084, 1075, 1531, 1601-1602 | `lease_start`/`lease_end` columns on contacts, `/api/leases` endpoint, renewal task generation, AI tool `add_contact` with `lease_start`/`lease_end` |
| `property` | 628-629, 1490-1501, 1524, 1682-1701, 1758-1776, 1805-1806, 2152-2198 | AI system prompts: "property management assistant", "property management team", "property management app", report prompt "property management advisor" |
| `landlord` | (not found in server.js) | |
| `rental` | (not found in server.js) | |
| `maintenance` | 342, 394-414, 455, 1131-1211, 1178-1181, 1195-1201, 1648-1660, 1546, 1770 | `maintenance_tickets` table, emergency keywords, emergency SMS, AI tool `add_maintenance_ticket`, task suggestion rules |
| `resident` | 326, 341-342, 363-366, 401, 538, 1035-1036, 1055, 1073-1078, 1168, 1482-1483, 1490-1501, 1531, 1577-1587, 1614, 1626, 1656, 1664-1665, 1762-1766, 2063-2064, 2169, 2259, 2294 | Column name in messages/maintenance_tickets/rent_payments; contact type `'resident'`; AI prompts reference "resident" heavily; compose_message tool says "Recipient name (must match a contact name)" |
| `vendor` | 363, 390, 447, 1569, 1591-1606, 2169 | Contact type `'vendor'`; task category; AI tool `add_contact` enum; seed data |
| `unit` | 353, 401, 541, 1012-1018, 1073, 1148, 1200, 1531, 1546, 1600, 1615, 1656, 2254, 2269, 2309 | Column on contacts, maintenance_tickets, rent_payments; used in AI tool schemas; used in late notice subjects |

### views/app.html

| Term | Lines (selected) | Context |
|---|---|---|
| `resident` | 382, 392, 447, 603 (CSS classes), plus throughout JS | `avatar-resident`, `tag-resident`, `cat-maintenance` CSS; contact type filter; AI command context building |
| `vendor` | 383, 393, 447, 603 (CSS classes), plus throughout JS | `avatar-vendor`, `tag-vendor`, `cat-vendor` CSS; contact type filter |
| `lease` | 395-407, 449, plus JS functions | `lease-badge`, `lease-red`, `lease-yellow`, `lease-green` CSS classes; lease panel rendering functions |
| `maintenance` | 448, 558, 603, plus JS functions | `cat-maintenance` CSS; sidebar nav; maintenance panel rendering |
| `rent` | Throughout JS functions | Rent panel rendering, rent status badges, rent generation UI |
| `unit` | Throughout JS forms and renders | Contact forms, maintenance forms, rent records display |
| `property` | 541, 628-629 | `#homePropertyName`, "Your property dashboard" |
| `tenant` | (minimal in app.html) | Used in payment events display referencing `parsed_tenant` |

---

## 5. AI Prompt Construction

There are **5 distinct Anthropic API call sites** in server.js, plus 1 follow-up call in the command center flow.

### 5.1 Draft Reply Generator -- `/api/generate` (line 1487)

**Route:** `POST /api/generate` (line 1471)

**System prompt (line 1490):**
```
You are a professional property management assistant. Draft concise, friendly, and helpful
responses to resident messages on behalf of the property management team.

Use the following company policies, procedures, and contact directory to inform your response:

${knowledgeContext}${contactContext}

Guidelines:
- Address the resident by first name
- Be warm but professional
- Reference relevant policies where appropriate, but don't quote them verbatim
- Keep responses to 3-5 short paragraphs
- End with "Best regards,\nThe Property Management Team"
```

**Hardcoded property-management references:** "property management assistant", "property management team", "resident messages", "resident by first name"

**Context passed:** Knowledge base docs, contacts directory, message details (resident, subject, category, text)

### 5.2 AI Command Center -- `/api/command` (line 1679)

**Route:** `POST /api/command` (line 1519)

**System prompt (line 1682):**
```
You are an AI command center assistant for a property management app called Modern Management.
You help property managers get things done by taking action within the app.

${contextSummary}

Today's date is ${new Date().toISOString().split('T')[0]}.

You have access to the following tools. Use them proactively when the user's intent is clear:
- add_calendar_event: schedule events and appointments
- add_task: create tasks with categories and due dates
- compose_message: draft and save messages to residents or contacts
- add_contact: add residents, vendors, or important contacts (including lease dates and monthly rent)
- mark_rent_paid: mark a resident's rent as paid -- match by name from the rent records
- send_late_notice: send a payment reminder to an unpaid resident
- add_budget_transaction: log income or expenses to the budget tracker
- add_maintenance_ticket: create maintenance/repair tickets
- generate_rent: create pending rent records for all residents for a given month

You can use multiple tools in one response if needed (e.g. "add Maria and generate May rent"
-> add_contact + generate_rent).
Always explain what you did clearly. For mark_rent_paid and send_late_notice, identify the closest
matching resident from the rent records. If no match, say so.
```

**Hardcoded property-management references:** "property management app", "property managers", "residents or contacts", "lease dates and monthly rent", "mark a resident's rent as paid", "payment reminder to an unpaid resident", "maintenance/repair tickets", "rent records for all residents"

**Context passed via `contextSummary` (line 1527):** Knowledge base, contacts (with lease end, monthly rent), calendar events, tasks, inbox messages, rent records for current month, open maintenance tickets

**Tools defined (lines 1549-1675):** 9 tools -- `add_calendar_event`, `add_task`, `compose_message`, `add_contact`, `mark_rent_paid`, `send_late_notice`, `add_budget_transaction`, `add_maintenance_ticket`, `generate_rent`

**Follow-up call (line 1728):** If the model returns `tool_use` stop reason, a second API call is made with a minimal system prompt: `"You are an AI command center assistant for Modern Management. Be brief and friendly."` passing the tool results back to get a text summary.

### 5.3 AI Task Suggestion -- `suggestTasksFromConversation()` (line 1755)

**Called from:** Inbound email handler (line 1980), inbound SMS handler (line 2072), voicemail transcription handler (line 2133), maintenance ticket creation (line 1178), auto-reply flow (line 1835)

**System prompt (line 1758):**
```
You are a property management assistant that identifies follow-up tasks from resident
communications. Return ONLY a valid JSON array of task objects, or [] if no tasks are needed.
Each object must have: title (string), category (one of: maintenance, vendor, lease, finance,
other), dueDate (YYYY-MM-DD), notes (string), aiReason (string explaining why this task is needed).
```

**User prompt (line 1761):**
```
Analyze this property management conversation and identify any tasks that were promised,
implied, or are clearly necessary.

Today's date: ${today}
Resident/caller: ${message.resident}
Message received: "${message.text}"
${replyText ? `Reply sent: "${replyText}"` : ''}

Rules:
- If an emergency was mentioned (gas leak, flood, fire, no heat, etc.), set dueDate to today
- If something was promised ("we will dispatch", "we will follow up", "we will send"), create a task for it
- If maintenance is needed, create a task for it
- If a lease or financial issue was raised, create a task if follow-up is needed
- Do not create tasks for things already resolved
- Return [] if no tasks are needed
```

**Hardcoded property-management references:** "property management assistant", "property management conversation", "Resident/caller", "emergency" keywords, "maintenance", "lease or financial issue"

**Context passed:** Message text, resident name, any reply text, today's date

### 5.4 Auto-Reply -- `autoReplyToMessage()` (line 1798)

**Called from:** Inbound email handler (line 1979), inbound SMS handler (line 2071), voicemail transcription handler (line 2132)

**System prompt for regular messages (line 1806):**
```
You are a professional property management assistant. Draft concise, friendly, and helpful
responses to resident messages on behalf of the property management team.

${knowledgeContext}

Guidelines:
- Address the resident by first name
- Be warm but professional
- Keep responses to 3-5 short paragraphs
- End with "Best regards,\nThe Property Management Team"
```

**System prompt for voicemails (line 1805):**
```
You are a professional property management assistant. Write a SHORT SMS reply (under 160
characters) acknowledging a voicemail was received. Be warm and let them know someone will
follow up soon. Do NOT include "Best regards" or signatures.
```

**Hardcoded property-management references:** Same as 5.1.

**Context passed:** Knowledge base, message text, resident name, subject

### 5.5 Payment Email Parser -- `parsePaymentEmail()` (line 1844)

**Called from:** `processPaymentEmail()` (line 1989), which is called from inbound email webhook and `/api/payments/test`

**System prompt (line 1845):**
```
You extract structured payment information from payment confirmation emails (Zelle, Venmo,
Chase QuickPay, bank deposit alerts, Stripe, PayPal, Square, AppFolio, Buildium, etc.).

Return ONLY a JSON object with these exact keys:
- tenant: string -- the payer's name as it appears in the email (just name, no email/phone)
- amount: number -- the payment amount in USD, as a plain number (e.g. 1800, not "$1,800.00")
- date: string -- the payment date in YYYY-MM-DD format; if unclear, use today
- source: string -- the payment platform (e.g. "Zelle", "Venmo", "Chase", "Bank deposit", "Stripe")
- confidence: "high" | "medium" | "low" -- your confidence in the extraction

Rules:
- If the email is NOT a payment confirmation (e.g. it's spam, marketing, unrelated), return
  {"confidence": "none"} only.
- If amount is ambiguous, use the largest dollar figure in the email.
- Never invent data. If a field is missing, use empty string for strings or 0 for amount.

Today's date is ${today}. Return ONLY the JSON, no other text.
```

**Hardcoded property-management references:** "tenant" (for payer name), "AppFolio, Buildium" (property management software), payment platform names

**Context passed:** Email from, subject, and body

### 5.6 Property Report -- `/api/report` (line 2201)

**Route:** `POST /api/report` (line 2142)

**System prompt (embedded as user message, line 2152):**
```
You are an expert property management advisor with deep knowledge of real estate market trends,
landlord best practices, tenant relations, and operational efficiency. Today is ${todayFmt}.

Generate a comprehensive, actionable property management report based on the following live data:
[...tasks, inbox, calendar, contacts, financials...]

Write a professional report with EXACTLY these five sections:
- Executive Summary
- Priority Action Items
- AI Recommendations (including property management market trends, tenant retention, seasonal maintenance)
- Activity Insights
- This Week's Focus
```

**Hardcoded property-management references:** "property management advisor", "real estate market trends", "landlord best practices", "tenant relations", "property management report", "tenant retention", "seasonal maintenance"

**Context passed:** Tasks (with overdue flags), inbox messages, calendar events, contacts, budget summary (income/expenses/net)

---

## 6. Authentication & Multi-Tenant Model

### Session-based authentication

- **Library:** `express-session` (line 11)
- **Config (lines 35-40):**
  - `secret`: `process.env.SESSION_SECRET || 'mm-session-secret-2026'`
  - `resave: false`
  - `saveUninitialized: false`
  - `cookie.maxAge`: 24 hours (86,400,000 ms)
- **Session store:** Default in-memory store (no persistent store configured -- sessions are lost on server restart)

### How users are created

**Signup flow (line 733, `POST /api/signup`):**
1. Validate `username` and `password` (password >= 8 chars)
2. Hash password with bcrypt (10 rounds)
3. Generate a `payment_forward_token`
4. Insert into `users` table with `plan='free'`
5. Create an `automation` row for the user
6. Set `req.session.authenticated = true`, `req.session.userId`, `req.session.username`
7. Return `{ success: true }`

**Admin seed (lines 309-319):**
- On first `initDB()` run, if the `users` table is empty, an admin user is seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars (defaults: `admin` / `modernmgmt2026`) with `plan='admin'`.

### Data isolation per user

Every data table includes a `user_id` column. All queries filter by `req.session.userId`:
```sql
SELECT * FROM contacts WHERE user_id=$1
DELETE FROM tasks WHERE id=$1 AND user_id=$2
```

This is the sole mechanism for multi-tenant data isolation. There are no database-level row-level security policies. All isolation is enforced in application code.

### WEBHOOK_USER_ID constant

**Defined at line 28:** `const WEBHOOK_USER_ID = 1;`

**Purpose:** All inbound webhooks (Twilio SMS, SendGrid email, Twilio voice) arrive without user authentication. These messages are assigned to `user_id = 1` (the first admin account). This means:
- Inbound SMS from Twilio goes to user 1's inbox (line 2064)
- Inbound email from SendGrid goes to user 1's inbox (line 1973)
- Voicemail recordings and transcriptions go to user 1 (lines 2105, 2127)
- Payment-forwarded emails use the token to look up the correct user (lines 1951-1967), bypassing `WEBHOOK_USER_ID`

**Limitation:** Only user 1 receives inbound Twilio/SendGrid webhook messages. Multi-user inbound routing is not implemented for general messages.

### Routes that bypass auth -- the `open` array

**Line 990:**
```js
const open = ['/login', '/signup', '/sms/incoming', '/email/incoming', '/voice/incoming',
              '/voice/recording', '/voice/transcription', '/billing/webhook'];
```

The catch-all middleware at line 989 checks all `/api/*` routes. If the path matches one of these 8 entries, it skips auth. Otherwise it requires `req.session.authenticated && req.session.userId`.

### requireAuth vs requireAuthPage middleware

| Middleware | Defined | Behavior on failure |
|---|---|---|
| `requireAuth` | Line 48 | Returns `401 { error: 'Unauthorized' }` JSON |
| `requireAuthPage` | Line 52 | Redirects to `/login` |

`requireAuth` is used on API endpoints that need early explicit auth (before the catch-all middleware). `requireAuthPage` is used only on `GET /workspace` to redirect unauthenticated browsers to the login page.

Many API routes between the `open` array and the catch-all middleware at line 989 rely on the catch-all middleware for auth rather than explicitly using `requireAuth`. This includes contacts, tasks, maintenance, calendar, budget, automation, messages, drafts, generate, email/send, sms/send, and report routes.

---

## 7. Third-Party Integrations

### 7.1 Twilio (SMS + Voice)

- **Import:** `const twilio = require('twilio')` (line 9)
- **Init:** `const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)` (line 24)
- **Routes that use it:**
  - `POST /api/sms/incoming` (line 2057) -- inbound SMS webhook, responds with TwiML
  - `POST /api/sms/send` (line 2077) -- outbound SMS via `twilioClient.messages.create()`
  - `POST /api/voice/incoming` (line 2090) -- inbound call TwiML (Say + Record)
  - `POST /api/voice/recording` (line 2100) -- recording callback
  - `POST /api/voice/transcription` (line 2117) -- transcription callback
  - `sendEmergencySMS()` (line 1144) -- sends emergency maintenance SMS
  - `autoReplyToMessage()` (line 1829) -- auto-reply via SMS if message has phone
  - `POST /api/rent/:id/late-notice` (line 2315) -- late payment SMS
  - `POST /api/broadcast` (line 2424) -- broadcast SMS
- **Error handling:** Individual try/catch blocks; errors are logged via `console.error()` and returned as 500 JSON.

### 7.2 SendGrid (Email)

- **Import:** `const sgMail = require('@sendgrid/mail')` (line 10)
- **Init:** `sgMail.setApiKey(process.env.SENDGRID_API_KEY)` (line 18)
- **Routes that use it:**
  - `POST /api/email/incoming` (line 1936) -- inbound email webhook (SendGrid Inbound Parse)
  - `POST /api/email/send` (line 2025) -- outbound email (fallback if connected SMTP fails)
  - `sendNotificationEmail()` (line 617) -- admin notification emails
  - `autoReplyToMessage()` (line 1821) -- auto-reply via email
  - `POST /api/rent/:id/late-notice` (line 2305) -- late payment email
  - `POST /api/broadcast` (line 2414) -- broadcast email
- **From address:** Always `{ name: 'Modern Management', email: 'noreply@modernmanagementapp.com' }` with `replyTo` from `SENDGRID_FROM_EMAIL`
- **Error handling:** try/catch with console.error and 500 responses.

### 7.3 Stripe (Billing/Subscriptions)

- **Import:** `const Stripe = require('stripe')` (line 13)
- **Init:** `const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null` (line 17). Conditional -- if no key, billing routes return 503.
- **Routes that use it:**
  - `POST /api/billing/create-checkout` (line 2511) -- creates Stripe Checkout session with 14-day trial
  - `GET /api/billing/portal` (line 2543) -- creates Stripe billing portal session
  - `POST /api/billing/webhook` (line 2562) -- handles `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`
- **Webhook verification:** Uses `stripe.webhooks.constructEvent()` with `STRIPE_WEBHOOK_SECRET`
- **Error handling:** try/catch; webhook always returns 200 even on handler errors to avoid retries.

### 7.4 Anthropic / Claude (AI)

- **Import:** `const Anthropic = require('@anthropic-ai/sdk').default` (line 8)
- **Init:** `const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })` (line 23)
- **Model used:** `claude-opus-4-6` everywhere (lines 1488, 1679, 1729, 1756, 1809, 1863, 2202)
- **Routes that use it:** See Section 5 above (5 distinct call sites)
- **Helper functions:**
  - `getKnowledge(userId)` (line 1353) -- fetches knowledge docs to include in prompts
  - `formatKnowledgeContext(docs)` (line 1367) -- formats docs into markdown for prompts
- **Error handling:** try/catch with console.error; returns 500 JSON with `details: err.message`.

### 7.5 IMAP/SMTP (imapflow + nodemailer)

- **Imports:** `const nodemailer = require('nodemailer')` (line 14), `const { ImapFlow } = require('imapflow')` (line 15)
- **Init:** No global init -- connections are created per-request using stored credentials.
- **Helper functions:**
  - `detectEmailProvider(email)` (line 132) -- auto-detects IMAP/SMTP settings for major providers
  - `testImapConnection()` (line 153) -- tests IMAP credentials
  - `sendViaConnectedAccount()` (line 173) -- sends email via user's SMTP
  - `syncEmailAccount(userId)` (line 198) -- syncs IMAP INBOX into messages table
  - `extractTextFromEmail(raw)` (line 268) -- naive plain-text extraction from RFC822
  - `runPeriodicEmailSync()` (line 278) -- background sync every 5 minutes
- **Routes:** See "Connected Email Account Routes" in Section 3
- **Credential storage:** Passwords are encrypted with AES-256-GCM (lines 110-129) using a key derived from `SESSION_SECRET`
- **Error handling:** try/catch with graceful client.close() in finally blocks.

### 7.6 pdf-parse (Document Upload)

- **Import:** `const pdfParse = require('pdf-parse')` (line 7)
- **Used in:** `POST /api/knowledge/upload` (line 1442) -- extracts text from uploaded PDF files
- **Error handling:** Returns 400 if no text extracted (likely scanned/image PDF), 500 on parse errors.

### 7.7 multer (File Upload)

- **Import:** `const multer = require('multer')` (line 6)
- **Init:** `const upload = multer({ storage: multer.memoryStorage() })` (line 45)
- **Used in:**
  - `POST /api/knowledge/upload` (line 1442) -- `upload.single('file')`
  - `POST /api/contacts/import` (line 2447) -- `upload.single('file')`
  - `POST /api/email/incoming` (line 1936) -- `upload.none()` (multipart form without files)

---

## 8. Environment Variables & Config

| Variable | Used At (line) | Purpose | Default Fallback |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | 17 | Stripe API secret key | `null` (billing disabled) |
| `SENDGRID_API_KEY` | 18 | SendGrid email API key | None (will error on send) |
| `DATABASE_URL` | 20 | PostgreSQL connection string | None (required) |
| `ANTHROPIC_API_KEY` | 23 | Anthropic Claude API key | None (required for AI features) |
| `TWILIO_ACCOUNT_SID` | 24 | Twilio account SID | None (will error on send) |
| `TWILIO_AUTH_TOKEN` | 24 | Twilio auth token | None (will error on send) |
| `PORT` | 25 | Server listen port | `4000` |
| `SESSION_SECRET` | 37, 112 | Express session secret; also used as encryption key seed | `'mm-session-secret-2026'` |
| `ADMIN_USERNAME` | 311 | Initial admin user username | `'admin'` |
| `ADMIN_PASSWORD` | 312 | Initial admin user password | `'modernmgmt2026'` |
| `NOTIFICATION_EMAIL` | 629 | Fallback notification email for admin (user 1) | Falls back to `SENDGRID_FROM_EMAIL` |
| `SENDGRID_FROM_EMAIL` | 629, 1824, 2045, 2308, 2418 | Reply-to email address for outbound SendGrid emails | None |
| `APP_URL` | 638, 2513, 2545 | Base URL of the app (used in email links and Stripe redirects) | `'https://modernmanagement.onrender.com'` |
| `MAINTENANCE_PHONE` | 1145 | Phone number for emergency maintenance SMS alerts | None (emergency SMS skipped) |
| `TWILIO_PHONE_NUMBER` | 1149, 1829, 2081, 2315, 2425 | Twilio "from" phone number | None (will error on send) |
| `STRIPE_PRO_PRICE_ID` | 2530 | Stripe Price ID for the Pro plan | None (required for billing) |
| `STRIPE_WEBHOOK_SECRET` | 2569 | Stripe webhook signature verification secret | None (required for webhook) |

**Summary:**
- Truly required for the server to start: `DATABASE_URL`
- Required for core features: `ANTHROPIC_API_KEY`, `SENDGRID_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- Required for billing: `STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`
- Have sensible defaults: `PORT`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `APP_URL`
- Optional: `NOTIFICATION_EMAIL`, `MAINTENANCE_PHONE`, `SENDGRID_FROM_EMAIL`

---

## Appendix: Notable Architecture Observations

1. **No foreign key constraints.** All relationships are enforced in application code. This means orphaned records are possible if deletions are not coordinated.

2. **In-memory drafts.** The `drafts` array (line 1333) is global, not per-user, and is lost on restart. This is a data isolation issue in multi-user scenarios.

3. **WEBHOOK_USER_ID = 1.** All inbound Twilio/SendGrid messages go to user 1. Multi-user inbound routing is only implemented for payment-forwarded emails (via token).

4. **Session store is in-memory.** All user sessions are lost on server restart. For production use on Render (which may restart the process), this means users will be logged out.

5. **No rate limiting.** No middleware protects against brute-force login attempts or API abuse.

6. **Encryption key derived from SESSION_SECRET.** The AES-256-GCM key for stored email passwords is derived from `SESSION_SECRET`. If the secret changes, all stored email credentials become undecryptable.

7. **Date columns stored as TEXT.** `dueDate`, `date`, `lease_start`, `lease_end`, `due_date`, `paid_date` are all TEXT columns storing YYYY-MM-DD strings rather than proper DATE/TIMESTAMP types. This makes date-range queries rely on string comparison (which works for ISO format but prevents native PostgreSQL date functions).

8. **Model is `claude-opus-4-6` everywhere.** All 5+ Anthropic API calls use the same model with no fallback or configurable model selection.

9. **Background periodic sync.** `runPeriodicEmailSync()` runs every 5 minutes via `setInterval` (line 290), syncing all connected email accounts.

10. **DB init with retry.** `initDBWithRetry()` (line 2629) attempts up to 5 times with exponential backoff, allowing the server to start serving traffic while the database warms up.
