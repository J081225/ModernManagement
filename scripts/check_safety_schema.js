// Read-only diagnostic: do migrations 020/021/022 exist on the DB
// pointed at by .env's DATABASE_URL? Auto-reply safety layer code
// crashes if any of these are missing.
//
// Usage: node scripts/check_safety_schema.js

require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const dbHost = (process.env.DATABASE_URL || '').match(/@([^/]+)/);
  console.log('DB host:', dbHost ? dbHost[1] : '(unparseable)');
  console.log();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const checks = [
    {
      label: '020: users.alert_phone column',
      sql: `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'users' AND column_name = 'alert_phone'`,
    },
    {
      label: '021: messages.emergency_flagged column',
      sql: `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'messages' AND column_name = 'emergency_flagged'`,
    },
    {
      label: '022: audit_log table',
      sql: `SELECT table_name FROM information_schema.tables
              WHERE table_name = 'audit_log'`,
    },
    {
      label: '022: audit_log_user_event_time_idx index',
      sql: `SELECT indexname FROM pg_indexes
              WHERE indexname = 'audit_log_user_event_time_idx'`,
    },
  ];

  let allOk = true;
  for (const c of checks) {
    const { rows } = await pool.query(c.sql);
    const present = rows.length > 0;
    console.log((present ? 'OK  ' : 'MISSING ') + c.label);
    if (!present) allOk = false;
  }

  console.log();
  if (allOk) {
    console.log('All safety-layer schema is present on this DB.');
  } else {
    console.log('At least one migration has NOT been run on this DB.');
    console.log('Run the missing files from migrations/phase1-additive/');
    console.log('against the Neon branch shown above.');
  }

  await pool.end();
  process.exit(allOk ? 0 : 1);
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(99);
});
