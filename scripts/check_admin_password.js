// Read-only diagnostic: does the current .env ADMIN_PASSWORD match the
// bcrypt hash stored for ADMIN_USERNAME in the database?
//
// Usage:  node scripts/check_admin_password.js
//
// Prints: which DB host, the username it's checking, and whether the
// password matches. Does NOT modify anything.

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

(async () => {
  const dbHost = (process.env.DATABASE_URL || '').match(/@([^/]+)/);
  console.log('DB host:    ', dbHost ? dbHost[1] : '(unparseable)');

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  console.log('Checking username:', JSON.stringify(username));
  console.log('.env password length:', password.length);

  if (!password) {
    console.log('\n.env has no ADMIN_PASSWORD set. Cannot compare.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query(
    'SELECT id, username, plan, length(password_hash) AS hash_len FROM users WHERE username=$1',
    [username]
  );
  if (!rows.length) {
    console.log(`\nNo row in users table with username = ${JSON.stringify(username)}.`);
    console.log('Users that DO exist:');
    const all = await pool.query('SELECT id, username, plan FROM users ORDER BY id');
    for (const u of all.rows) console.log('  -', u);
    await pool.end();
    process.exit(2);
  }

  const { rows: full } = await pool.query(
    'SELECT password_hash FROM users WHERE username=$1',
    [username]
  );
  const match = await bcrypt.compare(password, full[0].password_hash);

  console.log('\nUser found:', rows[0]);
  console.log('Password matches stored hash:', match);

  if (!match) {
    console.log('\n.env ADMIN_PASSWORD does NOT match the hash in the DB.');
    console.log('Re-run with the correct password, or reset the hash to match .env');
    console.log('via a separate reset script (ask me before running one).');
  }

  await pool.end();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(99);
});
