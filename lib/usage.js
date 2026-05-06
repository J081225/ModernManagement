// lib/usage.js
//
// Central usage tracking helpers.
//
// Every code path that should count toward a plan limit MUST call into
// this module. Future enforcement (D6+) reads from these counters to
// decide whether to allow or block actions.
//
// Design principles:
// 1. Never throw. Counter failures must not break user requests. Log
//    and return safely. Tracking is best-effort.
// 2. Never block in the request path longer than necessary. Increments
//    use a single SQL upsert.
// 3. Daily counts use UTC-day boundary via toISOString(). The
//    workspace.timezone column is not yet plumbed through; future
//    session can swap todayDate() to be tz-aware.
//
// Schema reality note: in this codebase, the user-workspace relation is
// `workspaces.owner_user_id -> users.id` (workspaces own a single owner).
// There is no `users.workspace_id` column. getAllUsersTodayCounts joins
// through workspaces accordingly. Multi-workspace users are future work.

/**
 * Get the current period_start DATE for a workspace, in YYYY-MM-DD format.
 * Defaults to the server's UTC interpretation of "today" — the workspace
 * timezone column is not yet plumbed through, so this is best-effort.
 */
function todayDate() {
  const now = new Date();
  // Use ISO date format YYYY-MM-DD
  return now.toISOString().slice(0, 10);
}

function firstOfMonthDate() {
  const now = new Date();
  return now.toISOString().slice(0, 7) + '-01';
}

/**
 * Increment the AI command counter for a user-workspace pair for today.
 * Returns the new count, or null if the increment failed (best-effort,
 * never throws).
 */
async function incrementAICommand(db, { workspaceId, userId }) {
  if (!db || !workspaceId || !userId) return null;
  const periodStart = todayDate();
  try {
    const result = await db.query(
      `INSERT INTO ai_usage_daily (workspace_id, user_id, period_start, command_count, last_command_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (workspace_id, user_id, period_start)
       DO UPDATE SET command_count = ai_usage_daily.command_count + 1,
                     last_command_at = NOW()
       RETURNING command_count`,
      [workspaceId, userId, periodStart]
    );
    return result.rows[0]?.command_count || null;
  } catch (err) {
    console.error('[usage] Failed to increment AI command counter:', err.message);
    return null;
  }
}

/**
 * Increment the report counter for a workspace for the current month.
 */
async function incrementReport(db, { workspaceId }) {
  if (!db || !workspaceId) return null;
  const periodStart = firstOfMonthDate();
  try {
    const result = await db.query(
      `INSERT INTO report_usage_monthly (workspace_id, period_start, report_count, last_report_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (workspace_id, period_start)
       DO UPDATE SET report_count = report_usage_monthly.report_count + 1,
                     last_report_at = NOW()
       RETURNING report_count`,
      [workspaceId, periodStart]
    );
    return result.rows[0]?.report_count || null;
  } catch (err) {
    console.error('[usage] Failed to increment report counter:', err.message);
    return null;
  }
}

/**
 * Read the current AI command count for a user-workspace pair today.
 * Returns 0 if no row exists. Returns null on db error (caller decides
 * whether to fail-open or fail-closed when reading fails).
 */
async function getAICommandCountToday(db, { workspaceId, userId }) {
  if (!db || !workspaceId || !userId) return null;
  const periodStart = todayDate();
  try {
    const result = await db.query(
      `SELECT command_count FROM ai_usage_daily
       WHERE workspace_id = $1 AND user_id = $2 AND period_start = $3`,
      [workspaceId, userId, periodStart]
    );
    return result.rows[0]?.command_count || 0;
  } catch (err) {
    console.error('[usage] Failed to read AI command count:', err.message);
    return null;
  }
}

/**
 * Read the current report count for a workspace this month.
 */
async function getReportCountThisMonth(db, { workspaceId }) {
  if (!db || !workspaceId) return null;
  const periodStart = firstOfMonthDate();
  try {
    const result = await db.query(
      `SELECT report_count FROM report_usage_monthly
       WHERE workspace_id = $1 AND period_start = $2`,
      [workspaceId, periodStart]
    );
    return result.rows[0]?.report_count || 0;
  } catch (err) {
    console.error('[usage] Failed to read report count:', err.message);
    return null;
  }
}

/**
 * Read all per-user AI command counts for a workspace today.
 * Useful for admin UI showing current usage across the team.
 *
 * Joins through workspaces.owner_user_id since this codebase has a
 * single-owner-per-workspace model (no users.workspace_id column).
 */
async function getAllUsersTodayCounts(db, { workspaceId }) {
  if (!db || !workspaceId) return [];
  const periodStart = todayDate();
  try {
    const result = await db.query(
      `SELECT u.id AS user_id, u.email, COALESCE(a.command_count, 0) AS command_count
       FROM users u
       JOIN workspaces w ON w.owner_user_id = u.id
       LEFT JOIN ai_usage_daily a
         ON a.user_id = u.id AND a.workspace_id = w.id AND a.period_start = $2
       WHERE w.id = $1
       ORDER BY a.command_count DESC NULLS LAST, u.email`,
      [workspaceId, periodStart]
    );
    return result.rows;
  } catch (err) {
    console.error('[usage] Failed to read all-users counts:', err.message);
    return [];
  }
}

module.exports = {
  incrementAICommand,
  incrementReport,
  getAICommandCountToday,
  getReportCountThisMonth,
  getAllUsersTodayCounts,
  // Exported for testing / debugging
  _todayDate: todayDate,
  _firstOfMonthDate: firstOfMonthDate
};
