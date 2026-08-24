// scripts/backfill-vanity-aliases.js — VE2 one-time backfill.
//
// Rewrites every existing users.inbound_email_alias to the vanity
// format <username>@modernmanagementapp.com (including the demo's
// malformed bare 'northside-demo' string). Announce-before-touch:
// prints each before→after, applies, then VERIFIES BY READING the
// result rows (data-op discipline — never trust the commit receipt).
// Idempotent: rows already in vanity format are left untouched.
//
// payment_forward_token is a different feature and is NOT read or
// written here.

require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const { rows } = await pool.query(
      'SELECT id, username, inbound_email_alias FROM users ORDER BY id'
    );
    console.log('=== ANNOUNCE (before → after) ===');
    const planned = [];
    for (const u of rows) {
      const target = `${String(u.username).trim().toLowerCase()}@modernmanagementapp.com`;
      if (u.inbound_email_alias === target) {
        console.log(`user ${u.id} (${u.username}): already vanity — untouched`);
        continue;
      }
      console.log(`user ${u.id} (${u.username}): "${u.inbound_email_alias}" -> "${target}"`);
      planned.push({ id: u.id, target });
    }
    if (!planned.length) {
      console.log('Nothing to do — all rows already vanity.');
      return;
    }
    for (const p of planned) {
      await pool.query('UPDATE users SET inbound_email_alias=$1 WHERE id=$2', [p.target, p.id]);
    }
    console.log('=== VERIFY (result rows read back) ===');
    const { rows: after } = await pool.query(
      'SELECT id, username, inbound_email_alias FROM users ORDER BY id'
    );
    let bad = 0;
    for (const u of after) {
      const expect = `${String(u.username).trim().toLowerCase()}@modernmanagementapp.com`;
      const ok = u.inbound_email_alias === expect;
      if (!ok) bad++;
      console.log(`${ok ? 'OK  ' : 'BAD '} user ${u.id} (${u.username}): ${u.inbound_email_alias}`);
    }
    process.exitCode = bad ? 1 : 0;
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error('backfill failed:', err.message); process.exit(1); });
