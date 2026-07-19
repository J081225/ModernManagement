#!/usr/bin/env node
// scripts/backfill-contact-links.js — FD1 orphan backfill.
//
// Repairs appointments booked by the AI before customer identity flowed
// into the tool ctx (docs/booking-contact-linkage.md §5): appointments
// with NULL contact_id whose appointment_thread still holds the
// customer's phone number.
//
// Per orphan:
//   - thread has no phone            → UNRECOVERABLE (reported, skipped)
//   - phone matches an existing
//     contact (normalized, last-10)  → LINK that contact_id
//   - no match                       → CREATE a contact (placeholder
//     "Caller +1 ..." name, normalized phone, backfill note), then link
// Then propagate the recovered contact_id onto transactions rows from
// those appointments that inherited the NULL (the "Walk-in" ledger
// rows); their customer_display_name is fixed only when it is exactly
// 'Walk-in' and the linked contact has a real (non-placeholder) name.
//
// MODES
//   --dry-run  (default) print the per-row plan and counts; writes NOTHING
//   --apply    execute the whole plan inside one transaction
//
// Usage: node scripts/backfill-contact-links.js [--apply]

require('dotenv').config();
const { Pool } = require('pg');
const { normalizePhone, phoneDigits10, callerPlaceholderName } = require('../lib/phone');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log(`[backfill-contact-links] mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);

  // Orphans + their thread identity + the workspace's owner (contacts
  // are user-scoped via workspaces.owner_user_id).
  const { rows: orphans } = await pool.query(`
    SELECT a.id AS appointment_id,
           a.workspace_id,
           a.source,
           a.status,
           a.starts_at,
           a.title,
           w.owner_user_id,
           t.id AS thread_id,
           t.inbound_channel,
           t.customer_phone,
           t.customer_email
      FROM appointments a
      JOIN workspaces w ON w.id = a.workspace_id
      LEFT JOIN appointment_threads t ON t.appointment_id = a.id
     WHERE a.contact_id IS NULL
     ORDER BY a.id
  `);

  const plan = { link: [], create: [], unrecoverable: [] };

  for (const o of orphans) {
    const digits = phoneDigits10(o.customer_phone);
    if (!digits) {
      plan.unrecoverable.push(o);
      continue;
    }
    const { rows: match } = await pool.query(
      `SELECT id, name FROM contacts
        WHERE user_id = $1
          AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
        ORDER BY id LIMIT 1`,
      [o.owner_user_id, digits]
    );
    if (match.length) {
      plan.link.push({ ...o, contact_id: match[0].id, contact_name: match[0].name });
    } else {
      plan.create.push({ ...o, new_name: callerPlaceholderName(o.customer_phone), new_phone: normalizePhone(o.customer_phone) });
    }
  }

  // Print the per-row plan.
  for (const o of plan.link) {
    console.log(`LINK    appt #${o.appointment_id} (${o.inbound_channel || 'no-thread'}, "${o.title}") → contact #${o.contact_id} "${o.contact_name}" via ${o.customer_phone}`);
  }
  for (const o of plan.create) {
    console.log(`CREATE  appt #${o.appointment_id} (${o.inbound_channel || 'no-thread'}, "${o.title}") → new contact "${o.new_name}" ${o.new_phone}`);
  }
  for (const o of plan.unrecoverable) {
    console.log(`SKIP    appt #${o.appointment_id} (source=${o.source}, ${o.inbound_channel || 'no thread'}, "${o.title}") — no phone on thread`);
  }

  // Ledger blast radius for the recoverable set.
  const recoverableIds = [...plan.link, ...plan.create].map(o => o.appointment_id);
  let txCount = 0;
  if (recoverableIds.length) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS c FROM transactions
        WHERE contact_id IS NULL AND appointment_id = ANY($1::int[])`,
      [recoverableIds]
    );
    txCount = Number(rows[0].c);
  }

  console.log('');
  console.log(`Orphans total:        ${orphans.length}`);
  console.log(`  link to existing:   ${plan.link.length}`);
  console.log(`  create contact:     ${plan.create.length}`);
  console.log(`  unrecoverable:      ${plan.unrecoverable.length}`);
  console.log(`Ledger rows to heal:  ${txCount}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to execute.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of plan.create) {
      const created = await client.query(
        `INSERT INTO contacts (user_id, name, type, unit, email, phone, notes)
         VALUES ($1, $2, 'resident', '', $3, $4, 'Auto-created by FD1 backfill from appointment thread.')
         RETURNING id`,
        [o.owner_user_id, o.new_name, o.customer_email || '', o.new_phone || '']
      );
      o.contact_id = created.rows[0].id;
      o.contact_name = o.new_name;
    }
    for (const o of [...plan.link, ...plan.create]) {
      await client.query(
        `UPDATE appointments SET contact_id = $1, updated_at = NOW() WHERE id = $2 AND contact_id IS NULL`,
        [o.contact_id, o.appointment_id]
      );
      await client.query(
        `UPDATE transactions SET contact_id = $1 WHERE appointment_id = $2 AND contact_id IS NULL`,
        [o.contact_id, o.appointment_id]
      );
      // Fix the ledger display name only where it is the literal
      // 'Walk-in' AND we recovered a real (non-placeholder) name.
      if (o.contact_name && !String(o.contact_name).startsWith('Caller ')) {
        await client.query(
          `UPDATE transactions SET customer_display_name = $1
            WHERE appointment_id = $2 AND customer_display_name = 'Walk-in'`,
          [o.contact_name, o.appointment_id]
        );
      }
    }
    await client.query('COMMIT');
    console.log('\nApplied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nFailed — rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
