// lib/migrations.js
//
// Auto-running migration system for Modern Management.
//
// Reads migration files from migrations/phase1-additive/ in lexical (numeric)
// order, applies each one inside a transaction, and records the application
// in the schema_migrations table. Already-applied migrations are skipped.
//
// Design principles:
//   1. Idempotent — safe to call on every startup. Already-applied migrations
//      are detected via the schema_migrations tracking table and skipped.
//   2. Fail-loud — any migration error halts startup with a clear message.
//      Silent failure was the bug in the previous home-grown system.
//   3. Transactional — each migration applies atomically. Either it
//      completes fully or rolls back entirely. No partial application.
//   4. Forward-only — there is no "down" migration support. If you need to
//      revert, write a new migration that undoes the previous one.
//
// First-run requirements:
//   - Migration 032 (schema_migrations table) must be applied manually via
//     Neon SQL Editor BEFORE this runner can work.
//   - After the table exists, the user must backfill it with the names of
//     migrations already applied to the live database. Use this SQL:
//
//     INSERT INTO schema_migrations (filename, applied_via) VALUES
//       ('018_add_archived_at_to_entities.sql',          'manual_backfill_d8'),
//       ('019_drop_entities_one_default_per_workspace_uq.sql', 'manual_backfill_d8'),
//       ('020_add_users_alert_phone.sql',                'manual_backfill_d8'),
//       ('021_add_messages_emergency_flagged.sql',       'manual_backfill_d8'),
//       ('022_create_audit_log.sql',                     'manual_backfill_d8'),
//       ('023_multi_customer_workspace_columns.sql',     'manual_backfill_d8'),
//       ('024_signup_session_state.sql',                 'manual_backfill_d8'),
//       ('025_password_reset_tokens.sql',                'manual_backfill_d8'),
//       ('026_workspace_vertical.sql',                   'manual_backfill_d8'),
//       ('027_reports_table.sql',                        'manual_backfill_d8'),
//       ('028_pending_actions.sql',                      'manual_backfill_d8'),
//       ('029_workspace_plan.sql',                       'manual_backfill_d8'),
//       ('030_usage_tracking.sql',                       'manual_backfill_d8'),
//       ('031_drop_orphan_columns.sql',                  'manual_backfill_d8'),
//       ('032_create_schema_migrations.sql',             'manual_backfill_d8')
//     ON CONFLICT (filename) DO NOTHING;
//
//     Only include rows for migrations actually applied to the live DB. To
//     check what's applied, see the queries in the codebase audit Section 6.
//
// Usage:
//   const migrations = require('./lib/migrations');
//   await migrations.runPendingMigrations(pool);
//   // Throws if any migration fails. Caller should let the process exit.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations', 'phase1-additive');

/**
 * Run all pending migrations. Throws on any error.
 *
 * @param {pg.Pool} pool — the shared Postgres pool
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
async function runPendingMigrations(pool) {
  // 1. Read available migration files
  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort(); // lexical sort puts NNN_*.sql in numeric order
  } catch (err) {
    throw new Error(`[migrations] Could not read migrations directory ${MIGRATIONS_DIR}: ${err.message}`);
  }

  if (files.length === 0) {
    console.log('[migrations] No migration files found.');
    return { applied: [], skipped: [] };
  }

  // 2. Read already-applied set
  let applied;
  try {
    const result = await pool.query(`SELECT filename FROM schema_migrations`);
    applied = new Set(result.rows.map(r => r.filename));
  } catch (err) {
    // If the schema_migrations table itself doesn't exist, the user hasn't
    // applied migration 032 yet. Halt with a clear setup instruction.
    if (err.code === '42P01') {
      throw new Error(
        '[migrations] schema_migrations table does not exist. ' +
        'Apply migration 032_create_schema_migrations.sql manually via Neon SQL Editor first, ' +
        'then backfill the table with already-applied migration filenames. ' +
        'See lib/migrations.js header comment for the backfill SQL.'
      );
    }
    throw new Error(`[migrations] Could not read schema_migrations table: ${err.message}`);
  }

  // 3. Apply pending migrations in order
  const newlyApplied = [];
  const skipped = [];

  for (const filename of files) {
    if (applied.has(filename)) {
      skipped.push(filename);
      continue;
    }

    const filepath = path.join(MIGRATIONS_DIR, filename);
    let sql;
    try {
      sql = fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      throw new Error(`[migrations] Could not read migration file ${filename}: ${err.message}`);
    }

    // Apply the migration in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, applied_via) VALUES ($1, $2)`,
        [filename, 'auto_runner']
      );
      await client.query('COMMIT');
      console.log(`[migrations] Applied ${filename}`);
      newlyApplied.push(filename);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* swallow rollback error */ }
      // FAIL LOUD — halt startup. The previous system silently swallowed errors.
      throw new Error(`[migrations] FAILED ${filename}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[migrations] Migration run complete. Applied ${newlyApplied.length} new, skipped ${skipped.length} already-applied.`);
  return { applied: newlyApplied, skipped };
}

module.exports = {
  runPendingMigrations,
  MIGRATIONS_DIR, // exported for test / inspection
};
