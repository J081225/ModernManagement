# SP3 Investigation — The Readiness Invariant

Look-first for SP3. Investigation only; no code changed. State: clean
tree at `e77a3e4` (SP2 pushed and live, deploy healthy).

## The headline: `connect_status='ready'` never claimed a phone

The SP3 brief asks that `'ready'` "structurally require ALL its parts
(Stripe connected AND phone attached)". The evidence says that would be
**the wrong invariant** — it would break a working, correctly-scoped
field. Full writer/reader census below; the short version:

`workspaces.connect_status` is **Stripe Connect onboarding state, and
only that**. It answers exactly one question: *can this workspace
accept card payments?* It has never meant "the workspace is ready," and
nothing reads it as such.

- **The only consumer that gates behavior on it** is
  `lib/payment-requests.js:78`:
  `if (workspace.connect_status !== 'ready' || !workspace.stripe_connect_account_id)`
  → refuses with `"Card payments aren't set up yet."`
- **The only UI reader** is `views/app.html:12918`, which uses it to
  show/hide **Request deposit / Request payment** buttons, plus the
  4-variant Connect card (12139–12175) whose `'ready'` copy is *"Card
  payments are active. You can accept cards from customers."*

Both are about **cards**. Neither mentions, implies, or depends on a
phone number. So `ready`-with-NULL-phone is not a contradiction *in
this field* — a workspace genuinely can accept card payments while its
SMS line is still provisioning. Adding "AND phone attached" to
`connect_status='ready'` would:
1. **lie in the other direction** — a workspace with working Stripe
   card payments and a pending number would be told "card payments
   aren't set up," and the deposit/payment buttons would vanish;
2. **couple two independent subsystems** (Stripe Connect ↔ Twilio) that
   fail independently, so one vendor's outage would disable the other
   vendor's feature;
3. **fight SP4's async future**, where "account exists, phone pending"
   must be legal — under the proposed coupling that state would
   *also* disable card payments, which has nothing to do with it.

**The ws12 impossible state was never `connect_status` lying.** Per
SP1: `ready` was set correctly by Stripe Connect (charges enabled); the
NULL phone was set (or never set) by an unrelated path; the actual harm
was that **the success screen printed "(provisioned)"** — a phone claim
with no phone behind it. **SP2 already fixed the lie.** What remains is
not a bad value in `connect_status`; it's the *absence of a field that
tracks phone provisioning at all*.

## Writer census (complete)

| # | Writer | Sets | Meaning |
|---|--------|------|---------|
| 1 | migration 041 | `DEFAULT 'not_started'` | never onboarded |
| 2 | `server.js:2688` (onboarding start) | `'pending'` + `stripe_connect_account_id` | Stripe account created |
| 3 | `lib/connect-lifecycle.js:66` `syncAccountState` | `'ready'` / `'restricted'` / `'pending'` via `deriveConnectStatus` | mirrors the Stripe Account object (`charges_enabled` → ready) |

That's all three. Writer 3 is the only path to `'ready'`, it is
**idempotent and Stripe-derived**, and it is *correct*: it faithfully
mirrors what Stripe says about card capability. There is no rogue
writer to constrain.

**Corollary:** a DB CHECK constraint like
`connect_status <> 'ready' OR twilio_phone_number IS NOT NULL` would
make `syncAccountState` **throw** when Stripe legitimately reports
charges_enabled on a phone-pending workspace — converting a truthful
webhook into a crash. That is the opposite of robustness.

## The real gap: provisioning state is unmodeled

Today the phone has **no status field** — only `twilio_phone_number`
(NULL or set) and `twilio_provisioned_at`. Under the current atomic
flow that's survivable (NULL is impossible post-commit). Under **SP4's
async**, NULL becomes a normal transient, and the system needs to
distinguish states it currently cannot:

- never attempted (pre-provisioning)
- **in flight** (async job running) ← legal, honest, temporary
- **failed after retries** ← needs owner/operator visibility
- attached (number present)

Without this, "no phone" is ambiguous: the UI can't tell "arriving in
10 seconds" from "provisioning failed 3 days ago, nobody noticed" —
which is precisely how a ws12-class zombie is born and survives.

## Proposed invariant shape — argued against the alternatives

**Rejected — (a) DB CHECK coupling `connect_status` to the phone:**
breaks the truthful Stripe mirror (above), fails the webhook, couples
independent vendors, and outlaws SP4's legal pending state.

**Rejected — (b) guarded setter on `connect_status`:** same semantic
error as (a), just enforced in code — it would make `syncAccountState`
silently refuse to record a true fact from Stripe.

**Rejected — (c) redefine `connect_status='ready'` to mean
"everything ready":** would require rewriting both consumers
(payment-requests gate + the Connect card UI whose copy is explicitly
about cards), and would leave *card readiness* with no field at all.

**RECOMMENDED — (d) model the missing axis, then derive the composite.**
Two parts:

1. **Add `twilio_status`** (additive migration; TEXT NOT NULL DEFAULT
   `'not_started'`, CHECK in
   `('not_started','provisioning','active','failed')`), plus
   `twilio_last_error TEXT` and `twilio_attempts INT DEFAULT 0` for
   SP4's retry loop. Backfill: `active` where a number exists,
   `not_started` where not — so today's two live workspaces land
   correctly and nothing changes behaviorally.
   **The real invariant, and it IS structural:** a DB CHECK that ties
   the phone *status* to the phone *value* —
   `(twilio_status = 'active') = (twilio_phone_number IS NOT NULL)`.
   That makes "claims a working line but has no number" **unwritable**,
   which is the ws12 defect stated precisely — and unlike (a) it
   constrains only the Twilio axis, so no truthful Stripe write can
   ever fail.
2. **Derive the composite for display** — a small
   `workspaceReadiness(workspace)` helper returning per-capability
   truth (`{ cards: 'ready'|…, phone: 'active'|'provisioning'|'failed'|…,
   overall }`) rather than overloading either column. UI surfaces then
   say the true thing per capability: cards active / number arriving —
   two independent facts, honestly rendered, which is exactly what
   SP4's async world needs.

**Why (d) is right for SP4's future:** "account exists, phone pending"
becomes a *first-class, legal, named* state
(`twilio_status='provisioning'`), distinct from both `'active'` and
`'failed'`, and distinct from anything about Stripe. Async provisioning
gets a state machine to drive, retries get a counter and an error to
record, and the honest UI copy SP2 shipped gets real backing data
instead of inferring from a NULL.

## Recommended SP3 build (pending ruling)

1. **Migration 061 (additive):** `twilio_status`, `twilio_last_error`,
   `twilio_attempts`; backfill from `twilio_phone_number`; the CHECK
   constraint tying `active` ⇔ number-present.
2. **Set the status at the one writer:** the orchestrator's successful
   provision sets `twilio_status='active'` in the same UPDATE that
   writes the number (so they can never diverge); nothing else writes
   it until SP4's async job.
3. **`lib/workspace-readiness.js`:** the derived per-capability helper
   + a guard used by any future writer, so "active without a number"
   is refused in code as well as in the DB.
4. **Suite:** the constraint rejects the impossible pair (both
   directions); backfill maps today's rows correctly; a truthful
   Stripe `charges_enabled` write still succeeds on a phone-pending
   workspace (the regression the naive invariant would have caused);
   the derived helper reports cards and phone independently.

**Scope note / flag:** this is where SP3 diverges from the brief's
letter. I recommend **not** touching `connect_status` at all. If the
ruling is that `connect_status='ready'` must nonetheless require a
phone, say so explicitly and I'll build it — but the evidence says
that trades a fixed lie for a new one, and I'd want that on the record
before writing it.

No code changed for this investigation; this document is the whole of
the SP3 look-first.
