// lib/report-cap.js — B4 (AI-scope hardening).
//
// Reports run the PREMIUM model (ANTHROPIC_REPORT_MODEL) — the one
// per-request cost that dwarfs everything else. This is the structural
// sanity cap: ~10 generations per workspace per day, enforced at BOTH
// creation sites (POST /api/reports and the generate_report tool).
// Honest refusal, resets at midnight, stored reports unaffected.
// Fail-open: a count failure must never block a paying owner's report.

const DAILY_REPORT_CAP = 10;

async function reportCapExceeded(db, workspaceId) {
  if (!workspaceId) return false;
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM reports
        WHERE workspace_id = $1 AND created_at >= date_trunc('day', NOW())`,
      [workspaceId]
    );
    return r.rows[0].n >= DAILY_REPORT_CAP;
  } catch (err) {
    console.error('[report-cap] count failed (allowing):', err.message);
    return false;
  }
}

const REPORT_CAP_MESSAGE = "That's a lot of reports today — you've hit the "
  + DAILY_REPORT_CAP + "-per-day limit. It resets at midnight, and everything "
  + "you've generated today is saved in Reports.";

module.exports = { DAILY_REPORT_CAP, reportCapExceeded, REPORT_CAP_MESSAGE };
