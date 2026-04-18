# Phase 2 — Code Cutover

**This phase contains no SQL files.** Every change in Phase 2 is a code edit to `server.js`. The database schema produced in Phase 1 is not touched.

See `docs/schema-migration-plan.md` §5 for the full per-route impact analysis and §7 for the cutover strategy.

---

## Route cutover order

Least-risky routes go first. Within a session, aim to land one route completely (read path + dual-write + deploy + bake 24h) before starting the next.

### Session 2.1 — Leases (read-only, low traffic)

1. `GET /api/leases` (server.js L1034) — swap query from `contacts WHERE type='resident' AND lease_end != ''` to `agreements WHERE agreement_type='lease'` joined to `contacts`.
2. `POST /api/leases/check-renewals` (server.js L1046) — same join change. Preserve task-creation semantics exactly.

Response shape guideline: the frontend expects fields like `name`, `unit`, `lease_end`, `days_until`. Alias the new columns back to these names in the SELECT so UI rendering is unchanged:

```sql
SELECT
  c.name,
  c.unit,
  a.end_date::text  AS lease_end,
  a.start_date::text AS lease_start,
  a.monthly_amount  AS monthly_rent,
  a.end_date - CURRENT_DATE AS days_until
FROM agreements a
JOIN contacts c ON c.id = a.contact_id
WHERE a.workspace_id = $1 AND a.agreement_type = 'lease'
ORDER BY a.end_date ASC;
```

### Session 2.2 — Contacts (dual-write lease cols + contact_type)

3. `GET /api/contacts` (L1000) — include `contact_type` in response, alongside `type`.
4. `POST /api/contacts` (L1005) — write both `type` AND `contact_type`; create/update `agreements` row if lease fields are present.
5. `PUT /api/contacts/:id` (L1014) — same dual-write. Wrap in a single pg transaction.
6. `DELETE /api/contacts/:id` (L1027) — add `DELETE FROM agreements WHERE contact_id=$1` before contact delete.
7. `POST /api/contacts/import` (L2450) — CSV importer: write both columns, create `agreements` for rows with lease fields.

### Session 2.3 — Rent + Maintenance (highest traffic)

8. `GET /api/rent` (L2218) — read from `recurring_charges WHERE charge_type='rent'`. Alias `payer_name AS resident` in SELECT for UI compatibility.
9. `POST /api/rent` (L2232) — dual-write both tables in one tx. Store the new row's `legacy_id = rent_payments.id` when both succeed.
10. `PUT /api/rent/:id` (L2242) — update both tables matched by legacy_id.
11. `POST /api/rent/generate-month` (L2254) — dual-write every generated row.
12. `DELETE /api/rent/:id` (L2285) — dual-delete.
13. `POST /api/rent/:id/late-notice` (L2291) — read-only; update source.
14. `GET /api/maintenance` (L1162) — read from `service_requests WHERE request_type='maintenance'`. Alias `requester_name AS resident`.
15. `POST /api/maintenance` (L1170) — dual-write.
16. `PUT /api/maintenance/:id` (L1187) — dual-write.
17. `DELETE /api/maintenance/:id` (L1211) — dual-delete.

### Session 2.4 — Payment events + AI prompts

**Note on `payment_events.matched_charge_id`:** per Decision §9.8, this column is now added in **Phase 1 via `014_add_matched_charge_id_to_payment_events.sql`** — not in this session. The column already exists and is backfilled by the time Session 2.4 starts. Session 2.4 only needs to teach the code to use it.

18. `GET /api/payments/events` (L919) — update JOIN from `rent_payments rp ON rp.id = pe.matched_rent_id` to `recurring_charges rc ON rc.id = pe.matched_charge_id`. During the dual-write window, queries that still use `matched_rent_id` continue to work because the column is still populated.
19. `POST /api/payments/events/:id/confirm` (L938) — `markRentPaidFromEvent()` helper must dual-write: set `matched_charge_id` AND `matched_rent_id` on the event, update `recurring_charges.status='paid'` AND `rent_payments.status='paid'` (both, matched by `legacy_id`). Everything inside the same transaction.
20. Any other write path that sets `payment_events.matched_rent_id` (grep confirms this is the only one in the code today) must also set `matched_charge_id` from the same lookup.
21. Extract AI system prompts (L1493, L1685, L1734, L1761, L1848) into `async function getSystemPrompt(userId, promptType)`. Read vertical labels once per call.

**Verification for Session 2.4 payment_events dual-write:**
After 24h of production traffic, run:
```sql
SELECT COUNT(*) FROM payment_events
 WHERE matched_rent_id IS NOT NULL AND matched_charge_id IS NULL;
-- Expected: 0
SELECT COUNT(*) FROM payment_events pe
  LEFT JOIN recurring_charges rc ON rc.id = pe.matched_charge_id
 WHERE pe.matched_rent_id IS NOT NULL
   AND pe.matched_charge_id IS NOT NULL
   AND rc.legacy_id IS DISTINCT FROM pe.matched_rent_id;
-- Expected: 0 (this is the same guard Phase 3's 005 uses)
```

### Session 2.5 — Messages `resident` → `sender_name` (per Decision §9.5)

Phase 1 migration `013_add_sender_name_to_messages.sql` has already added the `sender_name` column and backfilled it from `resident`. Phase 2 must dual-write both columns on every INSERT/UPDATE to `messages` and keep exposing `resident` in API responses as an aliased field so the frontend doesn't notice.

**Rule for Session 2.5:** every `INSERT INTO messages (...)` and every `UPDATE messages SET ...` statement that touches `resident` must set BOTH `resident` and `sender_name` to the same value inside the same statement (or the same transaction).

**Routes and code paths that touch `messages.resident` (from audit of server.js):**

| # | Line | Path / helper | Operation | Change |
|---|---|---|---|---|
| M1 | L244 | `/api/email/incoming` (internal `markRentPaidFromEvent` helper path inserts sample messages in `initDB` sample-data seed) | INSERT | Add `sender_name` to column list, repeat value. |
| M2 | L344 | `initDB()` sample data seed | INSERT | Add `sender_name` to column list, repeat value. |
| M3 | L1300 | `POST /api/messages` (L1297 route) | INSERT | Dual-write. |
| M4 | L1976 | `/api/email/incoming` main body insert | INSERT | Dual-write. |
| M5 | L2067 | `/api/sms/incoming` (or `/api/voice/incoming`) insert | INSERT | Dual-write. |
| M6 | L2108 | `/api/sms/*` inbound inserts | INSERT | Dual-write. |
| M7 | L2129 | `UPDATE messages SET text=..., subject=...` (inbound dedupe path) | UPDATE | No change to `resident`/`sender_name` here, but verify nothing overwrites them. |

**Read sites that return `message.resident` in response bodies or use it for rendering** (these do NOT need dual-write, but are safe to keep using `resident` because Phase 2 dual-write keeps the values in sync):

- L666, L689, L691 — email notification HTML template uses `message.resident`.
- L1507, L1543, L1767, L1791, L1817 — AI prompts inject `message.resident`.
- L2165 — `/api/report` cites `m.resident` for unread messages.

Per the compatibility pattern documented below, API responses continue to expose `resident` as an aliased field for frontend compat throughout Phase 2. A follow-up UI pass may switch the frontend to `sender_name`; Phase 3's 004 drop only removes the stored column, not the response field.

**Cutover template for messages (INSERT case):**

```js
await pool.query(
  `INSERT INTO messages (user_id, resident, sender_name, subject, category, text, status, folder, email)
   VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
  [userId, residentOrSender, subject, category, text, status, folder, email]
);
```

Note `$2` is reused for both `resident` and `sender_name` — one value source, two column targets. No divergence possible within a single INSERT.

---

## Dual-write pattern (standard template)

```js
// Inside a Phase 2 route
const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Old table write (authoritative during Phase 2)
  const { rows: [oldRow] } = await client.query(
    `INSERT INTO rent_payments (user_id, resident, unit, amount, due_date, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, resident, unit, amount, dueDate, status, notes]
  );

  // New table write (shadow)
  const { rows: [newRow] } = await client.query(
    `INSERT INTO recurring_charges
       (user_id, workspace_id, charge_type, payer_name, unit, amount, due_date, status, notes, legacy_id)
     VALUES ($1,$2,'rent',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, workspaceId, resident, unit, amount, dueDate, status, notes, oldRow.id]
  );

  await client.query('COMMIT');
  res.json(oldRow); // UI still reads old field names
} catch (e) {
  await client.query('ROLLBACK');
  res.status(500).json({ error: e.message });
} finally {
  client.release();
}
```

---

## Per-route go/no-go checklist

Before merging each route cutover:

- [ ] READ swapped to new table; manual click-through in UI confirms identical results.
- [ ] WRITE dual-write wrapped in pg transaction.
- [ ] DELETE dual-delete handled.
- [ ] Response field names preserved for frontend (use SQL aliases).
- [ ] Drift-check SQL for this table run and returns zero rows after 24h.
- [ ] Commit message tagged `[phase2-cutover] <route>`.

---

## Stop criteria — when to move to Phase 3

All of:
- Every route in sessions 2.1–2.4 cut over and merged to main.
- 7 days elapsed with zero drift on daily drift-check.
- Row counts in new tables >= old tables.
- No open bug reports tied to any of the touched routes.
