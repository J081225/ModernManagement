# MAINT-1 — dependency + connection hygiene (2026-08-25)

## Upgraded (npm audit fix, NO --force, package.json untouched —
## every bump was in-range, lockfile-only)
31 vulnerabilities → 20. All six fixable HIGHs closed:
- **axios → 1.19.0** (28 advisories: SSRF/proto-pollution/DoS; transitive dep)
- **multer → 2.2.0** (DoS via nested fields / aborted uploads; we use
  memoryStorage + `upload.none()` on the inbound-email parse only)
- **express → 4.22.2** (vulnerable qs), **form-data → 4.0.6** (CRLF),
  **ip-address**, **brace-expansion**, **body-parser**,
  **follow-redirects** — all patch/minor.
Full suite sweep green after the bumps.

## Remaining 20 — breaking-fix-only, documented, NOT forced
### nodemailer 6.10.1 (1 HIGH; fix = 9.x major, pulls imapflow too)
Used ONLY for the user-connected email_accounts SMTP send. Advisory
applicability against our usage:
- Transport-name CRLF, List-* header comments, jsonTransport bypass,
  OAuth2 token-fetch TLS, message-level `raw` bypass, `envelope.size`
  injection: **N/A** — we never set transport names or List-* headers,
  use SMTP (not jsonTransport) with password auth (not OAuth2), and
  pass neither `raw` nor `envelope.size`.
- addressparser recursive DoS + address-interpretation conflict:
  **partially applicable** (recipient addresses are user-supplied).
  Impact is process DoS / misrouted mail on hostile input from an
  authenticated owner's own account — low blast radius, accepted.
**Disposition: upgrade to nodemailer 9 + imapflow bump as its own
future unit (breaking API review), not under a hygiene pass.**

### @sentry/node 8.55.2 cluster (19 moderate; fix = Sentry 10 major)
One root advisory (otel W3C Baggage unbounded memory allocation)
fanned out across ~19 @opentelemetry/* subpackages. Applicability:
baggage-header parsing on inbound requests is a DoS-shaped vector;
sampled tracing (0.1) narrows but does not eliminate it. Moderate,
DoS-only, monitoring-path — accepted. **Disposition: Sentry v10
migration as its own future unit.**

## DB connection: sslmode=verify-full pinned
[server.js](../server.js) now normalizes DATABASE_URL to
`sslmode=verify-full` at pool construction (replacing
`ssl: { rejectUnauthorized: false }`, which encrypted WITHOUT
verifying the server's identity). pg v8 already treats `require` as
verify-full; v9 will weaken it to libpq semantics — pinning removes
the cliff and closes the MITM window. **Verified with a live Neon
query under verify-full before shipping.** `DB_SSLMODE` env is the
emergency override; unset, verify-full always wins. Render needs no
env change (normalization is code-side).
