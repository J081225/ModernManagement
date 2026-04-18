# Pre-Phase 1 Production Audit Queries

**Status:** Required before running any Phase 1 SQL in production.
**Target:** Production Neon database (or a fresh staging branch cut from production — they should return identical results before any Phase 1 migration touches the branch).
**Runs where:** Neon SQL Editor, on the `production` branch (or a fresh snapshot of it).

Run **all three sections** below. Paste results back to the Claude Code session.

---

## Audit 1 — `contacts.type = 'important'` sample (for Q2 refinement)

This confirms whether the Decision §9.4 rewrite logic should be refined to preserve tenant/non-tenant semantics when splitting `'important'` into `is_important` + a generic `contact_type`.

### 1a. Count and distribution

```sql
SELECT
  COUNT(*)                                                                      AS total,
  COUNT(*) FILTER (WHERE lease_end IS NOT NULL AND lease_end != '')             AS has_lease,
  COUNT(*) FILTER (WHERE monthly_rent IS NOT NULL AND monthly_rent > 0)         AS has_rent,
  COUNT(*) FILTER (WHERE (lease_end IS NOT NULL AND lease_end != '')
                      OR (monthly_rent IS NOT NULL AND monthly_rent > 0))       AS has_lease_or_rent,
  COUNT(*) FILTER (WHERE (lease_end IS NULL OR lease_end = '')
                      AND (monthly_rent IS NULL OR monthly_rent = 0))           AS neither
FROM contacts
WHERE type = 'important';
```

### 1b. 10-row sample with lease/rent indicators

```sql
SELECT id, user_id, name, type, email, phone,
       CASE WHEN lease_end IS NOT NULL AND lease_end != ''
            THEN 'has_lease' ELSE 'no_lease' END AS lease_status,
       CASE WHEN monthly_rent > 0
            THEN 'has_rent'  ELSE 'no_rent'  END AS rent_status
FROM contacts
WHERE type = 'important'
ORDER BY user_id, id
LIMIT 10;
```

### Expected response format

Paste the full rows back. Based on the distribution:

- If `total = 0` → refined 007b is unnecessary; the current "rewrite to `'other'`" logic is fine (no rows to rewrite).
- If `has_lease_or_rent >= 1` → adopt **refined 007b** (below): these rows become `contact_type='tenant' AND is_important=true`, preserving the tenant relationship.
- If all `'important'` rows are `neither` → keep the simple `contact_type='other' AND is_important=true` rewrite.

### Proposed refined 007b logic (conditional, pending sample results)

```sql
UPDATE contacts
SET is_important = true,
    contact_type = CASE
      WHEN (lease_end IS NOT NULL AND lease_end != '')
        OR (monthly_rent IS NOT NULL AND monthly_rent > 0)
      THEN 'tenant'
      ELSE 'other'
    END
WHERE type = 'important' AND is_important = false;
```

Emit `RAISE NOTICE` with 3 counts:
1. Rows flagged as `is_important`
2. Rows rewritten to `contact_type='tenant'` (preserved tenant semantics)
3. Rows rewritten to `contact_type='other'` (pure flag-only rows)

---

## Audit 2 — Blank / NULL `contacts.type` (for Q3 default decision)

### 2a. Count blank rows and their data richness

```sql
SELECT
  COUNT(*)                                                             AS blank_count,
  COUNT(*) FILTER (WHERE lease_end IS NOT NULL AND lease_end != '')    AS blank_with_lease,
  COUNT(*) FILTER (WHERE monthly_rent IS NOT NULL AND monthly_rent>0)  AS blank_with_rent,
  COUNT(*) FILTER (WHERE email IS NOT NULL AND email != '')            AS blank_with_email,
  COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '')            AS blank_with_phone,
  COUNT(*) FILTER (WHERE unit  IS NOT NULL AND unit  != '')            AS blank_with_unit
FROM contacts
WHERE type IS NULL OR type = '';
```

### 2b. 10-row sample

```sql
SELECT id, user_id, name, type, unit, email, phone, lease_end, monthly_rent
FROM contacts
WHERE type IS NULL OR type = ''
ORDER BY user_id, id
LIMIT 10;
```

### Code-side finding (already confirmed, no query needed)

- `POST /api/contacts/import` (server.js line 2494) **always defaults missing type to `'resident'`** — CSV imports do not produce blank types.
- `POST /api/contacts` (line 1005–1012) does NOT default `type` — if the request body omits it, Postgres stores `NULL`. **The frontend `openAddContact()` flow in `views/app.html` is the sole producer of blank `type`.**
- Seed data (line 366) uses `'resident'` — never blank.

### Interpretation guide

| Condition | Recommended 007 default |
|---|---|
| `blank_count == 0` | Irrelevant. Keep `'tenant'` default for safety. |
| `blank_with_lease > 0 OR blank_with_rent > 0` | **Use `'tenant'`** (current plan). These are real tenants missing a type; labeling them `'tenant'` is correct. |
| All blanks have no lease/rent/unit but have email/phone | Ambiguous. Could be unclassified contacts. **Use `'other'` as the safer default** to avoid mislabeling. |
| Mixed distribution | Use `'tenant'` AND emit `RAISE NOTICE` listing the IDs that got defaulted so user can reclassify post-migration. |

The final choice will be embedded in `007_add_contact_type_column.sql`'s mapping clause. Expect to confirm one of the three branches after you paste results.

---

## Audit 3 — Phase 1 baseline row counts (for Section 8.1 verification)

Capture these numbers NOW from production. Save them locally. After Phase 1 runs in production, re-run the corresponding "after" query and compare.

```sql
SELECT 'users'                   AS t, COUNT(*) FROM users
UNION ALL SELECT 'messages',                 COUNT(*) FROM messages
UNION ALL SELECT 'contacts',                 COUNT(*) FROM contacts
UNION ALL SELECT 'contacts_with_lease',      COUNT(*) FROM contacts WHERE lease_end IS NOT NULL AND lease_end != ''
UNION ALL SELECT 'contacts_type_resident',   COUNT(*) FROM contacts WHERE type = 'resident'
UNION ALL SELECT 'contacts_type_vendor',     COUNT(*) FROM contacts WHERE type = 'vendor'
UNION ALL SELECT 'contacts_type_important',  COUNT(*) FROM contacts WHERE type = 'important'
UNION ALL SELECT 'contacts_type_blank',      COUNT(*) FROM contacts WHERE type IS NULL OR type = ''
UNION ALL SELECT 'contacts_type_other',      COUNT(*) FROM contacts WHERE type NOT IN ('resident','vendor','important') AND type IS NOT NULL AND type != ''
UNION ALL SELECT 'rent_payments',            COUNT(*) FROM rent_payments
UNION ALL SELECT 'maintenance_tickets',      COUNT(*) FROM maintenance_tickets
UNION ALL SELECT 'payment_events_matched',   COUNT(*) FROM payment_events WHERE matched_rent_id IS NOT NULL
UNION ALL SELECT 'payment_events_total',     COUNT(*) FROM payment_events
ORDER BY t;
```

---

## Decision gate before Phase 1 execution

Phase 1 SQL must not run in production until:

1. **Audit 1** results pasted back → refined 007b logic confirmed
2. **Audit 2** results pasted back → 007 default value for blank types confirmed (`'tenant'` vs `'other'`)
3. **Audit 3** baseline captured and saved locally
4. Fresh Neon staging branch cut: `staging-schema-gen-YYYYMMDD`
5. Production Neon snapshot taken: `pre-schema-gen-phase1-YYYYMMDD`
6. Phase 1 runs **twice** against staging first (second run verifies idempotency)

When all six are done, Phase 1 can execute against production.
