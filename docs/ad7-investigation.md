# AD7 Investigation — Tokens as Ammunition (Law 4, the kill-switch)

Look-first for AD7. State: clean tree at `08e0185`; the AD6 stack
(investigation + three code commits) is local-only; pipeline gate
unchanged — Jay's AD5 live test → AD6 push → AD6 quick test → then AD7.

## 1. Session mechanics, verified against the LIVE table

`user_sessions` (connect-pg-simple, createTableIfMissing at boot),
confirmed by information_schema on the deployed DB:

- `sid` varchar PRIMARY KEY, `sess` **json** (not jsonb), `expire`
  timestamp + `IDX_session_expire`. No index on the user id inside
  sess.
- **userId is reliably queryable**: login writes
  `req.session.userId = user.id` (a number) at the JSON top level, so
  `(sess->>'userId')::int` works on the json type — this exact
  expression is already shipped and suite-proven (AD3's
  `endOtherSessions`, row CR4).
- **Cost of "kill every session for user X except sid Y"**: one
  DELETE with a sequential scan (no expression index). The table
  holds active sessions for a handful of users — trivial today. If
  the fleet grows, add
  `CREATE INDEX ... ((sess->>'userId'))` — flagged, not needed now.
- **Gotchas, flagged honestly:**
  1. json vs jsonb: `->>` works fine; only means no GIN indexing
     without a cast. Non-issue at this scale.
  2. **Write-timing race**: connect-pg-simple's `set()` is
     INSERT ... ON CONFLICT (sid) DO UPDATE. A session whose request
     is IN FLIGHT during the massacre, and which MODIFIES its session
     in that request, re-inserts its own row after the DELETE.
     `touch()` (the per-request expiry bump) is UPDATE-only and
     cannot resurrect. The window is one in-flight
     session-modifying request wide; most authed requests don't
     modify the session. Accept + document; closing it needs a
     session-generation column, which is its own project.
  3. Session-store write timing on the SURVIVING session is a
     non-issue: the current sid is excluded from the DELETE, so its
     end-of-request save always lands on a live row.

## 2. Every live artifact an attacker could hold

| Artifact | At rest | Dies on in-app change? | Dies on public reset? | Reasoning |
|---|---|---|---|---|
| Other sessions (`user_sessions`) | server-side rows | **YES — already shipped** (AD3, keep current sid) | **YES — build** (kill ALL, no exceptions; today reset kills nothing) | Positions 1–2 upheld by code; reset half is the gap. |
| `password_reset_tokens` | **plaintext** (AD3 flag stands) | **YES — build** | **YES — build** (incl. sibling tokens beyond the one being used) | An attacker can stockpile reset links (10/hr/IP). Today NOTHING burns them on a password write — an owner who changes their password leaves the attacker's unused reset link live for up to an hour. Plaintext at rest makes them the hottest item on this list. Burn = DELETE (the boot sweep's semantics). |
| AD3 pending email swap (`pending_email*` on users) | hash at rest | **YES — already shipped** (changePassword clears it in the same UPDATE, says so in the success message) | **YES — build** (reset clears nothing today) | Position upheld: a compromised account's pending swap is plausibly the attacker's. The reset flow — the RECOVERY path — currently leaves it ticking. |
| AD5 `contact_verifications` (email link + voice code) | sha256 at rest | **YES — recommend** | **YES — recommend** | Argued, not assumed: the voice-code submit is session-bound, so the session massacre already neutralizes it. But the EMAIL verify endpoint is PUBLIC by design (the token IS the proof) — it is the ONE artifact session death cannot touch. Attacker plants notification_email, requests verification, owner resets password, every session dies... and the attacker's inbox still holds a live public link that stamps the planted address verified. Burn both fields' artifacts on any password write: one DELETE, closes the sessionless hole, symmetric. |
| **`push_subscriptions` — NEW FINDING** | endpoint keys, server-side | **RULING NEEDED — recommend burn** | **RULING NEEDED — recommend burn** | Bearer-ish channel artifacts the session massacre does not touch: a subscription registered from the attacker's browser keeps receiving push payloads (new-message notices WITH PREVIEW TEXT, server.js:1290-region fanout) after every session dies. No sid linkage exists to prune selectively. Recommend: delete ALL for the user on both password writes; the owner re-enables push in one tap (the card's push toggle). Cost: one tap of UX for the owner; the alternative is an attacker's device silently reading message previews forever. |
| `payment_forward_token` | plaintext column | survives | survives | Routing secret, not a credential; already scheduled for the post-AD7 cleanup (with the rotate-token orphans). Burning it here would silently break the owner's mail-forwarding rule — wrong law. |
| `inbound_email_alias` | plaintext column | survives | survives | Routing identity; changing it is the UNROUTABLE-drop hazard (AD2 verdict). Not a bearer credential. |
| Signup drafts (`draft_data` incl. password_hash) | pre-account | n/a | n/a | No account exists yet; out of scope, noted. |

No remember-me tokens, API keys, or refresh tokens exist anywhere
(grepped; the only "api key" hits are provider env vars).

## 3. Password-write sites — the complete trigger list

Every `bcrypt.hash` site, classified:

1. `lib/credentials.changePassword` ← POST /api/credentials/change-password — **trigger** (sessions already handled; artifacts to add).
2. POST /api/auth/reset-password (public) — **trigger** (handles nothing today; the whole reset half of the kill-switch).
3. POST /api/signup (server.js:2746) — account CREATION, sets a fresh session, no prior artifacts exist → not a trigger. **Adjacent finding:** this is a LEGACY PUBLIC free-account signup path outside the Stripe flow, still mounted. Flag for the post-AD7 cleanup checkpoint (audit: should it still exist?).
4. Admin seed at boot; signup-checkout draft hash — creation, not triggers.

The kill-switch has exactly TWO triggers. Both call one shared
function so the lists can never drift.

## 4. AD6 reset-notice wording

Current: "Your password was just reset using a password-reset link. /
If this wasn't you, reset it again right now at … and contact support
immediately." Once AD7 makes reset kill every session, recommend:

> "Your password was just reset using a password-reset link, and
> every signed-in device has been signed out.
>
> If this wasn't you, reset it again right now at …/forgot-password
> and contact support immediately."

The in-app change notice already says "Other signed-in devices were
signed out" — accurate, unchanged. Recommend NOT enumerating artifact
burns in either notice: the burns are internal hygiene; listing them
adds noise without action value. The notices stay about what the
owner can observe (their devices) and do (reset).

## 5. Starting positions — challenged, all five upheld

1. In-app change: current survives, others die — matches shipped code
   (CR4). Upheld.
2. Public reset kills everything — nothing contradicts it; today it
   kills nothing, which is the gap, not a counter-argument. Upheld —
   and reset gets the artifact burns too (it's the recovery path; it
   must leave the board clean).
3. Reset tokens burn on any password change — upheld; today neither
   write burns them (gap).
4. Pending swaps burn — upheld; in-app already ships it, reset lacks
   it (gap).
5. AD5 codes — argued to BURN on both (§2): the public email-verify
   link is the one artifact session death can't reach.

Plus one artifact class the positions didn't list: push_subscriptions
(§2, ruling needed).

## 6. What Step 2 would build (pending rulings)

1. `lib/credentials.burnCredentialArtifacts(db, userId, { keepSid })`
   — ONE function, both triggers call it: DELETE the user's
   password_reset_tokens; clear pending_email*; DELETE
   contact_verifications; (pending ruling) DELETE push_subscriptions;
   kill sessions (all, or all-except-keepSid). Returns per-artifact
   counts for honest logging.
2. Wire into both triggers; reset flow's notice text updated per §4.
3. Suite rows: in-app change keeps the current sid, kills others +
   every artifact class; public reset kills ALL sessions + artifacts;
   each artifact class proven dead by fixture; survivors
   (payment_forward_token, alias) proven alive; the AD3/AD6 notice
   pins stay green; the two-trigger list pinned in source so a third
   password-write site can't appear unwired.

No code has been changed for AD7; this document is the whole of Step 1.
