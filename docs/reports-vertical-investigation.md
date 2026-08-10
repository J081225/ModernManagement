# Reports Page — Vertical-Awareness Investigation

Read-only, per Jay's ruling: Reports becomes vertical-aware, and this
is architecture, not copy. Evidence is file:line.

## 1. Inventory — every report type and its substance

The report-type dropdown (app.html, page-reports) is static and
PM-labeled: **Budget, Tenant, Inventory, Activity, General.** What
each actually pulls (server.js buildReportSnapshot, PM branch):

| Type | Data source | Substance |
|---|---|---|
| **Budget** | budget_transactions, **rent_payments**, invoices | PM financial, rent-centric |
| **Tenant** | contacts WHERE type='resident', lease_start/end, monthly_rent | **PM-only** — PS has no residents |
| **Inventory** | entities (properties), offerings (units), engagements (tenancies), occupancy_rate | **PM-only** — the property/unit tables, not the PS menu |
| **Activity** | cal_events, **maintenance_tickets**, tasks | Mostly PM (maintenance is PM) |
| **General** | all of the above combined | PM |

**But the data layer is NOT actually PM-only.** There is a *second*
snapshot builder for PS (server.js:7449 dispatches on vertical): it
pulls contacts (broad, no resident filter), **menu_items**,
**appointments** (next 14 days), **recent_transactions** (paid, last
7 days), ai_conversations, low_stock, tasks. So a PS workspace fed
into Reports gets a genuinely PS-shaped snapshot.

**The mismatch — this is the real defect:** the snapshot is
vertical-aware; the **system prompt and the UI are not**. The prompt
(server.js:8038) hard-codes *"You are an expert property management
advisor writing a report for a property manager,"* with per-type
instructions like *"When writing tenant content, surface anyone whose
lease is expiring"* and *"call out occupancy rate and vacant units."*
So a PS salon that picks **Tenant** or **Inventory** gets a PS
snapshot (no residents, no units) poured into a prompt demanding
tenant/occupancy prose — an empty or nonsensical report. What a PS
workspace can *usefully* generate today: effectively nothing via the
labeled types; only the PS snapshot's raw shape is right, and no UI
exposes PS-appropriate types.

**Cost tier (flagged):** reports run on `ANTHROPIC_REPORT_MODEL =
claude-opus-4-6` (config.js:18) — **Opus**, not the Haiku the rest of
the app uses (config.js:14). Every report is an Opus generation
(4000 max_tokens), quota-capped per plan (checkReportQuota). Adding
PS report types means **PS reports each cost an Opus run** — the
single biggest cost implication in this decision.

## 2. Map against the TR arc

The **Transaction History Report is the PS reporting story**, and it
is a different animal from Reports on every axis:

| | Reports page | TR (Finances) |
|---|---|---|
| Engine | LLM narrative (Opus) | **deterministic composer**, zero LLM |
| Source | fresh per-type SQL snapshot | `composeLedgerRows` → `composeTransactionReport` (the one-composer law) |
| Output | markdown prose | grouped rows, subtotals, CSV, print |
| Cost | Opus per report | free |
| Content | property/tenant/budget narrative | the money ledger |
| Age | Session B4/D4 — **predates TR** | recent TR arc |

**Reports does not duplicate TR — it predates it, on a different
mechanism.** They don't overlap in engine or in content: TR is
money, Reports is PM-operational narrative.

**The second-query-stack risk is real and specific.** The PS
snapshot already reads `recent_transactions` directly from the
payments tables (server.js PS branch). If option (a) adds a PS
"revenue" report type, its snapshot would sum money **outside**
`composeTransactionReport` — a second money-query stack that can
drift from the TR composer, violating the one-source-of-truth law TR5
pinned. **Any PS money figure in a report must come from the TR
composer, never a fresh transaction query.** This is the
non-negotiable guardrail on option (a).

## 3. Recommended shape

Three options, argued:

**(a) Vertical-gated report types on one page** — PS sees PS-relevant
types (e.g. Activity, Customers, Services/menu), a PS system prompt
replaces the "property management advisor" framing, PM types
(Tenant/Inventory) hide for PS. The PS snapshot already exists, so
the data work is mostly done; the work is prompt + dropdown gating.
- *For:* keeps the genuine PS value the daily-nudge already proves —
  an LLM narrative over appointments/customers/activity is useful and
  is NOT something TR (money-only) provides.
- *Against:* every PS report is an **Opus** run (cost); and it demands
  the money guardrail (§2) or it grows a second money stack.

**(b) PS Reports = a door to Finances/TR** — the Reports page for PS
shows a short pointer ("Your reporting lives in Finances → Transaction
History Report") and no generator.
- *For:* zero Opus cost for PS; no second money stack possible;
  honors the one-composer law absolutely; tiny build.
- *Against:* throws away non-money narrative (a PS owner asking "how
  did my week go?" gets nothing — TR is money rows, not prose).

**(c) Reports becomes PM-only nav** — PS never sees Reports at all
(add nav-pm-only, like Maintenance/Inventory).
- *For:* simplest; the labeled types ARE all PM-substance today.
- *Against:* discards the working PS snapshot and the proven PS
  narrative value; a blunt instrument.

**Recommendation: (a), with two hard constraints.**
1. **The money guardrail is law:** any dollar figure in a PS report
   is read from `composeTransactionReport`, never a fresh query — TR
   stays the single source. PS report types should lean
   *non-money-narrative* (activity, customers, services, "week ahead")
   precisely so they complement TR rather than racing it.
2. **The Opus cost is acknowledged and bounded:** PS report types run
   on the same Opus model + the existing per-plan report quota; no new
   uncapped cost path. If Jay wants PS narrative on the cheaper Haiku
   tier, that's a one-line model swap for the PS path — worth a
   sub-ruling.

(b) is the right call if the money-narrative value is judged low and
cost-avoidance dominates. (c) only if PS Reports is deemed noise.

## Rulings for Jay
1. Shape: (a) vertical-gated types with the money guardrail
   [recommended], (b) door-to-Finances, or (c) PM-only nav?
2. If (a): which PS report types — Activity, Customers, Services, a
   "week ahead" summary? (Explicitly NOT a money report — that's TR.)
3. If (a): PS reports on Opus (parity with PM) or downgraded to Haiku
   for cost? (One-line difference on the PS path.)
4. Confirm the money guardrail as law regardless of shape: no report,
   PM or PS, grows a second money-query stack outside the TR composer.
