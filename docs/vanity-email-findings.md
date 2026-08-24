# Vanity email — look-first findings
(Read-only investigation, 2026-08-23. Evidence: file:line, DB read-back,
SendGrid API GETs, DNS lookups. No changes.)

## 1. Current inbound_email_alias
- **Format:** `user-<token>@inbound.modernmanagementapp.com`, token = 12
  chars from `abcdefghjkmnpqrstuvwxyz23456789` (no 0/o/i/l/1 —
  `generateForwardToken`, [server.js:576-581](../server.js#L576), dup at
  [signup-orchestrator.js:46-50](../lib/signup-orchestrator.js#L46)).
- **Generated at:** signup
  ([signup-orchestrator.js:361](../lib/signup-orchestrator.js#L361)) and
  boot backfill for null/empty
  ([server.js:1400](../server.js#L1400)). Column is `users.inbound_email_alias`.
- **All live values (DB read 2026-08-23):**
  | user | username | alias |
  |---|---|---|
  | 1 | admin (ws3) | user-ywe8ndujxhff@inbound.modernmanagementapp.com |
  | 14 | jayhorton87 (ws17) | user-atfscmatgtkx@inbound.modernmanagementapp.com |
  | 18 | northside_demo (ws21, demo) | `northside-demo` — **bare string, not an address** (hand-seeded; breaks the format contract, and can never match the router's full-address compare) |

## 2. Outbound engine emails today
- **Engine customer replies**
  ([appointment-engine.js:804](../lib/appointment-engine.js#L804)):
  `from: env.SENDGRID_FROM_EMAIL` — **bare `jayhorton87@gmail.com`, no
  display name, no Reply-To.** Subject "Re: your message to <business>".
- **Every other platform sender:** `from: { name: 'Modern Management',
  email: 'noreply@modernmanagementapp.com' }` +
  `replyTo: env.SENDGRID_FROM_EMAIL` — i.e. **Reply-To is Jay's personal
  gmail** ([send_email.js:58-59](../lib/tools/send_email.js#L58),
  [reply_to_message.js:113-114](../lib/tools/reply_to_message.js#L113),
  [send_late_notice.js:73-74](../lib/tools/send_late_notice.js#L73),
  [send_broadcast.js:146-147](../lib/tools/send_broadcast.js#L146),
  [credentials.js:107-108](../lib/credentials.js#L107),
  [signup-orchestrator.js:238-239](../lib/signup-orchestrator.js#L238),
  plus 9 server.js sites e.g. :1558, :1776, :7808, :9506).
- **Display-name exceptions** (already vanity-shaped):
  [receipts.js:144](../lib/receipts.js#L144) and
  [message_vendor_for_restock.js:119](../lib/tools/message_vendor_for_restock.js#L119)
  send as `{ name: <business_name>, email: 'noreply@…' }`.
  [owner-alert.js:62](../lib/owner-alert.js#L62) has no Reply-To.

## 3. SendGrid / DNS ground truth (API GETs + MX lookups)
- **Domain auth for modernmanagementapp.com: VALID** — em226 link,
  mail_cname/dkim1/dkim2 all verified. (Two stale INVALID duplicate
  attempts, em3433/em4514, clutter the account — cleanup candidates.)
- **Inbound Parse:** hostname **modernmanagementapp.com (the ROOT)** →
  https://modernmanagementapp.com/api/email/incoming. Root MX →
  mx.sendgrid.net.
- **inbound.modernmanagementapp.com is NXDOMAIN** — no DNS record at
  all. **Every generated alias is therefore undeliverable from the
  outside world**; the router's alias tier
  ([server.js:7844-7860](../server.js#L7844), exact full-address match)
  can never have matched real mail. Mail CAN already reach
  `<anything>@modernmanagementapp.com` today.
- **Verified single sender:** jayhorton87@gmail.com (that's why the
  engine's bare-gmail From delivers at all — but it can't DKIM-align
  with gmail.com, so it rides on gmail's lenient DMARC).
- **Code restrictions: NONE.** `sendgrid.send` is called directly in 6
  files — no wrapper, nothing pins the from-address. With domain auth
  valid, **any local part @modernmanagementapp.com is sendable today**
  with zero new SendGrid setup.

## 4. Where the alias / platform From surfaces
- **GET /api/settings** ([server.js:1635](../server.js#L1635)) returns
  `inbound_email_alias`; the business-identity response adds
  `platform_from = SENDGRID_FROM_EMAIL || 'noreply@…'`
  ([server.js:1686](../server.js#L1686)).
- **My Business routing card**
  ([app.html:3143-3152](../views/app.html#L3143), populated
  :5701-5706): alias read-only + copyable (AD2 c3 — editing it is the
  UNROUTABLE-drop hazard). Next to it, :5691-5694 shows **"Your AI
  assistant replies from jayhorton87@gmail.com"** (bizEmail, copyable)
  — Jay's personal gmail is in the product UI.
- **Routing:** `lookupUserByEmailAlias` (server.js:7844) — tier 1 users
  alias, tier 2 connected email_accounts, both lowercased (pin EM6,
  [test-email-routing.js:87-89](../scripts/test-email-routing.js#L87)).
  Kill-switch pin K4 asserts the alias SURVIVES a burn
  ([test-kill-switch.js:148-150](../scripts/test-kill-switch.js#L148)).
- **The emails themselves never display the alias** — no template
  references it; Reply-To is always SENDGRID_FROM_EMAIL or absent.

## 5. Reserved-name risk
- **Signup blocks nothing but shape + uniqueness:**
  `/^[a-z0-9_]{3,30}$/` ([server.js:2389](../server.js#L2389)
  availability check, [:2530](../server.js#L2530) submit) + unique
  constraint (:2573, orchestrator :263). **There is NO reserved-word
  list anywhere.**
- `admin` is already taken (user 1) — by uniqueness luck, not policy.
  **`support`, `billing`, `noreply`, `info`, `sales`, `help`, `mail`,
  `postmaster`, `abuse`, `inbound` are all mintable today.** If vanity
  becomes `<username>@modernmanagementapp.com`, `noreply` collides with
  the hardcoded platform From (a signup would receive the platform's
  bounce/reply traffic), `postmaster`/`abuse` are RFC-expected
  addresses, and support/billing are obvious future ops addresses.
  Charset itself is email-safe (underscore is a legal local-part char).

## Net findings for the arc
1. **Today's aliases have never been reachable** (NXDOMAIN subdomain +
   parse bound to the root). A vanity address at the root domain would
   be the FIRST working inbound email address — and the root is already
   MX'd, parsed, and webhooked. No DNS work needed if vanity lives on
   the root.
2. **Reply-To on every platform email is Jay's personal gmail**, and
   the engine sends From it bare. Customer replies bypass the platform
   router entirely. The vanity arc naturally retires both.
3. **SendGrid is ready:** domain auth valid, no code restriction — the
   build is a routing-table + From-policy + reserved-names problem, not
   an infrastructure one.
4. **A reserved-name gate must ship before or with vanity addresses**;
   there is none today.
5. Demo's bare `northside-demo` alias breaks the format contract
   (harmless only because nothing is deliverable anyway).
