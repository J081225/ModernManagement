# Error Monitoring (Sentry)

Modern Management uses [Sentry](https://sentry.io) to catch silent server failures, crashes, and critical errors the moment they happen — preventing the kind of weeks-long silent degradation that caused the Phase 0 schema-drift incident.

**Integration:** `@sentry/node` v8, initialized in `server.js` at process startup.
**Activation:** only when `SENTRY_DSN` environment variable is set. No-op otherwise.
**Plan:** Sentry free tier (~5,000 errors/month).

---

## 1. Checking Sentry for recent errors

### The dashboard

1. Go to https://sentry.io and log in
2. In the project dropdown at the top-left, select **`modern-management-production`**
3. The default view is **Issues** — a list of recent error groups (Sentry auto-groups related errors into a single "issue")

### What each issue shows

- **Title and error message** — the exception type and message
- **Event count** — how many times this error has fired
- **User count** — how many distinct users were affected (computed from session info)
- **First seen / Last seen** — when the error first appeared and most recent occurrence
- **Stack trace** — full trace with code context (if source maps are uploaded — not configured yet)
- **Breadcrumbs** — timeline of what happened before the error (requests, DB queries, console logs)
- **Environment and release tags** — tells you if the issue is only on production, staging, etc.

### Where to look first

**Issues → Unresolved** (default tab): every active error. Click any row for full details.

**Issues → For Review**: issues Sentry's AI flagged as likely regressions or new high-impact errors.

**Performance** (left sidebar): transaction timings. Useful for "why is the rent endpoint slow lately?" investigations. Shows p50/p75/p95 response times per endpoint.

---

## 2. Configuring alerts (email me on new errors)

By default Sentry sends a weekly digest. For real incidents, set up these alerts:

### Alert A — "A new, never-before-seen error appeared"

1. In Sentry project → **Alerts** (left sidebar) → **Create Alert**
2. Alert type: **Issue Alert**
3. Conditions: **A new issue is created**
4. Action: **Send a notification to** → your email
5. Save

This is the single most valuable alert. It fires the moment any error class appears that Sentry has never seen before — catches regressions immediately.

### Alert B — "An existing error is spiking"

1. Create Alert → **Issue Alert**
2. Conditions: **The issue changes state from resolved to unresolved** AND **event frequency is more than 10 events in 1 hour**
3. Action: **Send a notification to** → your email

Catches "this bug came back" AND "something is now firing way more than usual."

### Alert C — "A slow endpoint" (performance)

1. Create Alert → **Metric Alert**
2. Metric: **Transaction Duration (p95)**
3. Filter: by transaction name, e.g. `GET /api/rent` or leave unfiltered for all
4. Trigger: **Critical if p95 is above 5000 ms** for 5 minutes
5. Action: **Send a notification to** → your email

Detects the classic "endpoint X got suddenly slow" scenario before users complain.

### Slack or PagerDuty

Free tier supports email notifications. Slack and PagerDuty integrations exist on paid plans — if/when we upgrade, connect them via **Settings → Integrations**.

---

## 3. Adjusting sampling rates

Set in `server.js` at Sentry initialization:

```js
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sampleRate: 1.0,        // 100% of errors
  tracesSampleRate: 0.1,  // 10% of transactions
});
```

### When to adjust

- **`sampleRate` (errors):** leave at `1.0`. Missing even a single error defeats the point of monitoring. Only reduce if hitting the free-tier quota (5k/month) — better first step is to fix noisy errors.
- **`tracesSampleRate` (performance transactions):** each captured transaction counts toward the quota. At `0.1` (10%) you see a statistical sample of all traffic. Good balance for current scale. Tune up to `0.5` if you need finer-grained performance data, down to `0.05` if quota pressure appears.

### Mid-flight sampling change

Changes require a code deploy. For quick throttling without a deploy, use Sentry's **Inbound Filters** (Settings → Inbound Filters → Rate Limit) to drop events at ingest.

---

## 4. Disabling Sentry temporarily

Two options:

### Option A — unset the env var (clean shutoff)

1. Render dashboard → ModernManagement production service → Environment
2. Delete the `SENTRY_DSN` row
3. Save Changes → Render redeploys
4. Server starts without initializing Sentry (the code checks `if (process.env.SENTRY_DSN)`). Zero events sent.

### Option B — kill switch on Sentry's side (no deploy)

1. Sentry project → **Settings → General Settings**
2. Scroll to **Project Status** section
3. Toggle the project status or set an ingest rate limit to 0
4. No code changes needed; events from the server are accepted by Sentry's edge and immediately dropped

Use Option A for extended pauses (cost or noise concerns). Use Option B for a quick "shut it off RIGHT NOW" situation.

---

## 5. Debug endpoint — testing Sentry works

We ship a manual test endpoint for verifying Sentry captures errors post-deploy.

### Enable it

Set `ENABLE_DEBUG_ENDPOINTS=true` in Render env vars. Server redeploys. The endpoint `GET /api/debug/trigger-error` becomes available (requires authenticated session).

### Use it

Log in to the app. Visit `https://modernmanagementapp.com/api/debug/trigger-error` in an authenticated browser session. You'll see a 500 error response. Within ~1 minute, the error appears in Sentry Issues.

### Disable it

Remove `ENABLE_DEBUG_ENDPOINTS` from Render env vars (or set to anything other than `true`). Redeploy. The endpoint returns 404.

**Important:** do not leave `ENABLE_DEBUG_ENDPOINTS=true` in production permanently. It's a one-time verification tool.

---

## 6. Understanding what's captured

### Automatically captured

- Any thrown exception in a synchronous route handler
- Any rejected promise in an `async` route handler (captured via `Sentry.setupExpressErrorHandler` + the process-level `unhandledRejection`/`uncaughtException` hooks)
- Transaction timing for every Express route when `tracesSampleRate > 0` (at 10% sampling)
- DB query timing (via automatic `pg` instrumentation in `@sentry/node`)
- Outbound HTTP timing (Anthropic, Twilio, SendGrid, Stripe)

### Not captured

- Console warnings/errors (those stay in Render logs only)
- Silent failures where code catches an exception and swallows it. If you care about these, add an explicit `Sentry.captureException(err)` in the catch block.
- Performance of frontend code (`views/app.html`). Browser-side monitoring would require a separate `@sentry/browser` setup — out of scope for this pass.

---

## 7. Cost management

Free tier ceiling: ~5,000 errors/month + ~10,000 transactions/month.

At current traffic (single-user, low volume), well under budget. If usage approaches the ceiling:

1. Check **Usage Stats** in Sentry settings — see where the consumption is coming from
2. Common culprits: a single noisy error firing hundreds of times (fix the error); overly aggressive `tracesSampleRate`
3. Upgrade to the Team plan ($26/month) if sustained growth demands it — but investigate consumption first

---

## 8. If something goes wrong

**Symptom: errors are happening in production but nothing shows in Sentry**
- Verify `SENTRY_DSN` is set in Render (Environment tab)
- Check Render logs for `Sentry initialized` on startup — if absent, env var is missing or malformed
- Test the integration by temporarily setting `ENABLE_DEBUG_ENDPOINTS=true` and hitting `/api/debug/trigger-error`

**Symptom: Sentry is firing too many duplicate events**
- Sentry's deduplication should group related errors automatically. If it's not, check the stack trace grouping in Sentry settings.
- Temporarily raise the error sampling threshold or rate-limit at Sentry's end

**Symptom: the server crashed on startup right after deploying Sentry**
- Remove `SENTRY_DSN` from Render to disable Sentry (`if (process.env.SENTRY_DSN)` guard kicks in)
- Check Render logs for the initialization error
- The most likely cause is a malformed DSN string — verify it starts with `https://` and contains an `@` and the Sentry project ID

---

## 9. Files and where things live

| Thing | Location |
|---|---|
| Sentry initialization code | `server.js` lines ~4–20 |
| Sentry Express error handler | `server.js` (immediately before the custom error handler) |
| unhandledRejection / uncaughtException Sentry forwarding | `server.js` (the process-level handlers near the bottom) |
| Debug test endpoint | `server.js` (gated by `ENABLE_DEBUG_ENDPOINTS`) |
| Dependency | `package.json` → `@sentry/node ^8.0.0` |
| Environment variables (in Render) | `SENTRY_DSN` (required); `ENABLE_DEBUG_ENDPOINTS` (optional, one-time test) |

---

## Quick reference — env vars

| Variable | Value | Purpose |
|---|---|---|
| `SENTRY_DSN` | `https://examplePublicKey@o0.ingest.sentry.io/0` format | The credential the server uses to report events. Lives in Render env vars only — never committed. |
| `ENABLE_DEBUG_ENDPOINTS` | `true` or unset | When `true`, exposes `/api/debug/trigger-error` for verifying Sentry is receiving. Remove after verification. |
| `NODE_ENV` | `production`, `development`, etc. | Tags Sentry events with the current environment for filtering. Defaults to `production` if unset. |
