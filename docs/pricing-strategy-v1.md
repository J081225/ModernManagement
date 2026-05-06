# Modern Management — Pricing Strategy v1

**Status:** Locked for launch (D6 repositioning, May 2026).
**Reference implementation:** [lib/plans.js](../lib/plans.js).

---

## Repositioning Note (D6, May 2026)

**Original strategy** specified multi-user workspaces with:
- Solo: 1 user
- Team: 5 users included, $25/extra
- Enterprise: 10 users included, $25/extra

**Launch tier model is now single-user across all tiers.** Multi-user
collaboration is on the roadmap as a free upgrade for Team and Enterprise
customers, to ship after launch once real customer demand materializes.

**Why repositioned:**

1. **Schema reality.** The codebase has no `workspace_users` join table. The
   workspace-user relationship is single-owner via `workspaces.owner_user_id`.
   Building multi-user properly is a 2-3 week project touching auth, billing,
   usage tracking, and the UI. Speculative pre-launch work risks building the
   wrong abstractions before any paying customer asks for them.

2. **AI-native SaaS pricing convention.** Cursor Pro, ChatGPT Plus, Notion
   AI all ship single-user with feature/capacity differentiation. Per-seat
   pricing is the legacy enterprise SaaS pattern that AI-native products
   have largely abandoned.

3. **Customer profile.** Most small property management operations under
   25 units are owner-operated. The product's AI-as-operator value
   proposition is most useful for solo operators in the first place.

**What this means for differentiation:**

- **Solo (entry):** individuals managing 3 or fewer properties, exploring
  AI-powered property management.
- **Team (the standard tier):** growing portfolios up to 10 properties,
  broadcast messaging, auto-response, daily briefing.
- **Enterprise:** unlimited everything, custom AI training, dedicated CSM,
  API access.

---

## Tier Comparison

| | Solo | Team | Enterprise |
|---|---|---|---|
| **Price** | $79/mo | $149/mo | $299/mo |
| **Trial** | 7-day free trial available (Solo limits) | — | — |
| **Users** | 1 | 1 | 1 |
| **AI commands per day per user** | 15 | 30 | 500 |
| **Reports per month** | 5 | 20 | unlimited |
| **Properties** | 3 | 10 | unlimited |
| **Units** | 10 | unlimited | unlimited |
| **Contacts** | 25 | unlimited | unlimited |
| **Broadcast messaging** | — | ✓ | ✓ |
| **Auto-response** | — | ✓ | ✓ |
| **Daily briefing** | — | ✓ | ✓ |
| **API access** | — | — | ✓ |
| **Custom AI training** | — | — | ✓ |
| **Dedicated success manager** | — | — | ✓ |
| **Multi-user collaboration** | — | future free upgrade | future free upgrade |

All amounts USD. Prices apply per workspace per month. Annual billing offered
at the same monthly rate × 12 (no annual discount in v1; revisit when churn
data is available).

---

## Tier Graduation Triggers

The triggers below are the practical signals that a customer is ready to
upgrade. Each upgrade prompt in the UI cites the specific limit hit (D5).

| From | To | Trigger |
|---|---|---|
| Solo | Team | Hits the 3-property limit; needs broadcast or auto-response; outgrows the 15/day AI command cap or the 5-reports/month cap; hits 10-unit cap |
| Team | Enterprise | Hits the 10-property limit; needs unlimited reports; needs API integrations; needs a dedicated success manager; needs custom AI training |

**Removed triggers (D6):** "Adding a second user" and "more than X users on
Team" were graduation triggers in the original strategy. They no longer apply
because all tiers are single-user at launch. When multi-user lands as a
free upgrade for Team and Enterprise, these triggers will not return — the
seat count itself is not metered.

---

## Stripe Configuration

The signup flow at [`server.js:1242`](../server.js) resolves prices via
`lookup_keys` (configured in the Stripe Dashboard, per the codebase audit
2026-05-06):

| Lookup key | Tier | Cadence | Status |
|---|---|---|---|
| `solo_monthly` | Solo | monthly | active |
| `solo_annual` | Solo | annual | active |
| `team_monthly` | Team | monthly | active |
| `team_annual` | Team | annual | active |
| `enterprise_monthly` | Enterprise | monthly | active |
| `enterprise_annual` | Enterprise | annual | active |
| `additional_user_monthly` | per-seat add-on | monthly | **reserved (D6) — not currently charged** |

The `additional_user_monthly` Stripe Price object is kept configured so the
future multi-user work doesn't require creating a new price. Until multi-user
ships, no checkout session line items reference this lookup key.

**Trial activation (D3):** Solo subscriptions can include a 7-day trial when
`POST /api/signup/create-checkout-session` is called with `trial: true`. Team
and Enterprise do not receive trials regardless of the flag. Trial duration is
controlled in code, not in the Stripe Dashboard.

---

## Enforcement (D4)

Limits and feature flags in this document are enforced server-side by
[`lib/plan-enforcement.js`](../lib/plan-enforcement.js):

- **Subscription status:** `canceled` workspaces are read-only (no AI commands,
  no resource creation). `past_due` and `trial` retain full access; D5
  surfaces a banner for `past_due`.
- **AI command daily caps:** `/api/command` returns 429 with the friendly
  upgrade-prompt message when the user has hit their plan's daily cap.
- **Report monthly caps:** `generateReportContent` throws (translated to 429
  by the route handler) when the workspace has hit its plan's monthly cap.
- **Resource creation caps:** `POST /api/entities`, `/api/offerings`, and
  `/api/contacts` all check the plan's `maxProperties` / `maxUnits` /
  `maxContacts` before INSERTing.
- **Feature gating:** `send_broadcast` is filtered from the AI tool registry
  on plans where `features.broadcast = false` (Solo today). The AI literally
  doesn't know the tool exists.

When any gate fires, D5's `handlePlanError` displays the upgrade prompt
modal with the friendly message and a "Upgrade Plan" CTA that opens the
Stripe Customer Portal.

---

## Post-launch Roadmap

Items below are explicitly **not** in the launch scope. They wait for
either real customer demand or a clear product reason to invest.

### Multi-user workspaces (free upgrade for Team / Enterprise)

Demand-driven. Will ship as a no-cost addition to existing Team and
Enterprise customers when:
- Multiple paying customers explicitly ask for it, OR
- Sales conversations consistently lose deals because the buyer has more
  than one team member.

Implementation outline:
- New `workspace_users` join table with role enforcement (owner, member,
  read-only).
- Invitation flow (email invite → user signup → join existing workspace).
- Refactor of `user_id`-scoped queries (contacts, tasks, messages,
  invoices, rent_payments, maintenance_tickets, etc.) to consider workspace
  membership rather than just `user_id` ownership. The audit lists 8+
  legacy tables affected.
- Stripe subscription quantity management — switch from flat-price
  subscriptions to per-seat with `additional_user_monthly` as the metered
  line item.
- D2's `getAllUsersTodayCounts` query (which today joins through
  `workspaces.owner_user_id`) gets replaced with a `workspace_users`-aware
  query.
- Solo remains permanently single-user (positioning hook: "Want to add a
  teammate? Upgrade to Team — multi-user is included.").

### Annual discount

v1 ships annual billing at flat `monthly × 12`. After 6 months of churn data,
revisit whether discounting annual (e.g., `monthly × 10`) reduces churn enough
to justify the revenue compression.

### Per-vertical tiers

The schema supports `workspaces.vertical` (default `'property-management'`).
If we open a second vertical (professional services, healthcare, etc.) the
tier names and feature flags above remain; the AI tool registry filters by
vertical (`lib/tool-registry.js`'s `getToolsForPlan(vertical, plan)` already
handles this).

### Volume / enterprise-custom pricing

Single-property-manager portfolios above ~50 properties may want custom
pricing (e.g., a $999/mo "Portfolio" tier). Defer until a customer asks.

---

## Maintenance Notes

- Any change to limits or features must be made in [`lib/plans.js`](../lib/plans.js)
  and reflected here. The two are intended to stay in sync; the code is the
  source of truth for runtime behavior, this doc is the source of truth for
  the marketing/UX narrative.
- Stripe Dashboard and `lib/plans.js` must be kept in sync manually until a
  programmatic sync is built.
- A pricing change of any kind should be a separate D-series session, not
  bundled with feature work.
