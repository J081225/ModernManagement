#!/usr/bin/env node
// scripts/backfill-message-links.js — IB1 historical linkage backfill.
//
// Repairs messages written before migration 051: NULL thread_id /
// contact_id / direction / sent_by. Matching uses the same
// normalization helpers as the live paths (lib/phone), never new
// lookups:
//
//   contact:   last-10-digit phone match against contacts.phone, else
//              exact lowercase email match — per user (messages are
//              user-scoped; contacts via workspaces.owner_user_id).
//   thread:    same-workspace appointment_threads with the same phone
//              digits whose [created_at - 1h, updated_at + 6h] window
//              contains the message's createdAt (6h = the CP1 idle
//              window); nearest-by-creation wins on overlap.
//   direction/sent_by (look-first (b) inference):
//     status='sent' AND subject LIKE 'SMS to %'    → outbound / ai
//       (the engine's + CP3 notifier's historical shape — the two are
//        indistinguishable in old rows; 'ai' is the honest majority)
//     status='sent' AND subject LIKE 'Email to %'  → outbound / ai
//     everything else                              → inbound / customer
//       (inbound webhooks, voicemail, voice transcripts, seed rows)
//
// MODES
//   --dry-run  (default) print the per-row plan and counts; writes NOTHING
//   --apply    execute the whole plan inside one transaction
//
// Usage: node scripts/backfill-message-links.js [--apply]

require('dotenv').config();
const { Pool } = require('pg');
const { phoneDigits10 } = require('../lib/phone');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function inferDirection(row) {
  const subj = String(row.subject || '');
  if (row.status === 'sent' && (subj.startsWith('SMS to ') || subj.startsWith('Email to '))) {
    return { direction: 'outbound', sent_by: 'ai' };
  }
  return { direction: 'inbound', sent_by: 'customer' };
}

async function main() {
  console.log(`[backfill-message-links] mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);

  // Migration 051 applies at next deploy boot; a dry-run before that
  // treats EVERY row as unlinked (which is exactly true). Apply mode
  // refuses without the columns — it has nothing to write into.
  const colCheck = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'direction'`
  );
  const migrated = colCheck.rows.length > 0;
  if (!migrated) {
    console.log('migration 051 not applied on this database yet — all rows are unlinked by definition');
    if (APPLY) {
      console.error('APPLY requires migration 051. Deploy first, then re-run.');
      await pool.end();
      process.exit(1);
    }
  }

  const { rows: targets } = await pool.query(`
    SELECT m.id, m.user_id, m.subject, m.category, m.status, m.phone, m.email, m."createdAt"
      FROM messages m
     ${migrated ? 'WHERE m.direction IS NULL' : ''}
     ORDER BY m.id
  `);
  console.log(`unlinked rows${migrated ? ' (direction IS NULL)' : ''}: ${targets.length}`);

  // Workspace per user (threads are workspace-scoped; contacts user-scoped).
  const { rows: wsRows } = await pool.query(
    `SELECT id, owner_user_id FROM workspaces`
  );
  const wsByOwner = new Map(wsRows.map((w) => [w.owner_user_id, w.id]));

  const { rows: contactRows } = await pool.query(
    `SELECT id, user_id, name, phone, email FROM contacts`
  );
  const { rows: threadRows } = await pool.query(
    `SELECT id, workspace_id, customer_phone, customer_email, contact_id, created_at, updated_at
       FROM appointment_threads`
  );

  const counts = {
    total: targets.length,
    contact_linked: 0,
    thread_linked: 0,
    outbound_ai: 0,
    inbound_customer: 0,
    no_identity: 0,
  };
  const plan = [];

  for (const m of targets) {
    const digits = phoneDigits10(m.phone);
    const email = m.email ? String(m.email).trim().toLowerCase() : null;
    const { direction, sent_by } = inferDirection(m);
    if (direction === 'outbound') counts.outbound_ai++; else counts.inbound_customer++;

    // Contact match (per user).
    let contactId = null;
    if (digits) {
      const c = contactRows.find((c) => c.user_id === m.user_id && phoneDigits10(c.phone) === digits);
      if (c) contactId = c.id;
    }
    if (!contactId && email) {
      const c = contactRows.find((c) => c.user_id === m.user_id && String(c.email || '').trim().toLowerCase() === email);
      if (c) contactId = c.id;
    }
    if (contactId) counts.contact_linked++;

    // Thread match (per workspace, phone digits, time window).
    let threadId = null;
    const wsId = wsByOwner.get(m.user_id);
    if (wsId && digits) {
      const at = new Date(m.createdAt).getTime();
      const candidates = threadRows.filter((t) =>
        t.workspace_id === wsId
        && phoneDigits10(t.customer_phone) === digits
        && at >= new Date(t.created_at).getTime() - 60 * 60 * 1000
        && at <= new Date(t.updated_at).getTime() + 6 * 60 * 60 * 1000
      );
      if (candidates.length) {
        candidates.sort((a, b) =>
          Math.abs(at - new Date(a.created_at).getTime()) - Math.abs(at - new Date(b.created_at).getTime()));
        threadId = candidates[0].id;
        if (!contactId && candidates[0].contact_id) {
          contactId = candidates[0].contact_id;
          counts.contact_linked++;
        }
      }
    }
    if (threadId) counts.thread_linked++;
    if (!digits && !email) counts.no_identity++;

    plan.push({ id: m.id, category: m.category, direction, sent_by, contactId, threadId });
    console.log(
      `#${m.id} [${m.category || '?'}] "${String(m.subject || '').slice(0, 44)}" -> ${direction}/${sent_by}`
      + (contactId ? ` contact=${contactId}` : '')
      + (threadId ? ` thread=${threadId}` : '')
    );
  }

  console.log('\n[counts]');
  console.log(`  total unlinked:      ${counts.total}`);
  console.log(`  direction inbound:   ${counts.inbound_customer} (customer)`);
  console.log(`  direction outbound:  ${counts.outbound_ai} (ai — engine/notifier shape)`);
  console.log(`  contact linkable:    ${counts.contact_linked}`);
  console.log(`  thread linkable:     ${counts.thread_linked}`);
  console.log(`  no identity at all:  ${counts.no_identity} (direction stamped, links stay NULL)`);

  if (!APPLY) {
    console.log('\nDRY RUN complete — nothing written. Re-run with --apply to execute.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(
        `UPDATE messages SET direction = $1, sent_by = $2,
                contact_id = COALESCE(contact_id, $3),
                thread_id  = COALESCE(thread_id, $4)
          WHERE id = $5 AND direction IS NULL`,
        [p.direction, p.sent_by, p.contactId, p.threadId, p.id]
      );
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED: ${plan.length} rows updated in one transaction.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('APPLY failed — rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
