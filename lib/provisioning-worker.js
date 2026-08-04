// lib/provisioning-worker.js — SP4a.
//
// Async number provisioning: the orchestrator commits the account with
// twilio_status='provisioning' (the seam) and this worker attaches the
// number afterward — so a Twilio hiccup can delay a number but can
// never again void a paid signup.
//
// Shape (ruled):
// - CLAIM-BY-UPDATE concurrency: an attempt starts by moving
//   twilio_next_attempt_at forward (an in-flight lock); of the
//   on-commit kick and the 1-minute sweep, only one claimant wins.
// - The 4-rung fallback chain, verbatim semantics from the old
//   in-transaction code: primary area code -> backup -> env fallback
//   -> any US local with SMS+Voice.
// - Bounded exponential backoff, 6 attempts over ~45 minutes
//   (BACKOFF_SECONDS after failures 1..5), then twilio_status='failed'
//   with a loud log. The owner task + one-tap re-arm land in SP4b.
// - The success flip is ONE statement guarded by status='provisioning'
//   and satisfies the 061 invariant by construction (checked in code
//   too via assertPhoneStatusLegal before writing).
// - Every Twilio dep is injectable for the suite; defaults are the
//   real lib/twilio-provisioning functions.

const twilioProvisioning = require('./twilio-provisioning');
const { assertPhoneStatusLegal } = require('./workspace-readiness');

const MAX_ATTEMPTS = 6;
// Delay AFTER failure N (1-indexed). Attempt times ~ 0s, 0:30, 2:00,
// 7:00, 19:00, 44:00 — six attempts spanning ~45 minutes, as ruled.
const BACKOFF_SECONDS = [30, 90, 300, 720, 1500];
// The claim's provisional in-flight lock: long enough to cover a slow
// Twilio round-trip, short enough that a crashed attempt is retried by
// the sweep within minutes. Overwritten by the real backoff on failure
// and cleared on success.
const IN_FLIGHT_LOCK_SECONDS = 120;

function backoffSeconds(failedAttemptNumber) {
  return BACKOFF_SECONDS[Math.min(failedAttemptNumber, BACKOFF_SECONDS.length) - 1];
}

// The 4-rung chain (moved verbatim in semantics from the orchestrator).
async function findCandidates(workspace, deps, env, log) {
  let candidates = [];
  if (workspace.area_code_preference) {
    candidates = await deps.searchAvailableNumbers(workspace.area_code_preference, 5);
  }
  if (!candidates.length && workspace.area_code_backup_preference) {
    log.log('[provisioning] primary area code ' + workspace.area_code_preference + ' empty; trying backup ' + workspace.area_code_backup_preference);
    candidates = await deps.searchAvailableNumbers(workspace.area_code_backup_preference, 5);
  }
  if (!candidates.length && env.TWILIO_FALLBACK_AREA_CODE) {
    log.log('[provisioning] user area codes empty; trying TWILIO_FALLBACK_AREA_CODE=' + env.TWILIO_FALLBACK_AREA_CODE);
    try {
      candidates = await deps.searchAvailableNumbers(env.TWILIO_FALLBACK_AREA_CODE, 5);
    } catch (fallbackErr) {
      log.error('[provisioning] TWILIO_FALLBACK_AREA_CODE search errored (continuing to any-US fallback):', fallbackErr.message);
    }
  }
  if (!candidates.length) {
    log.log('[provisioning] all area-code searches empty; trying any US local number with SMS+Voice');
    candidates = await deps.searchAnyAvailableNumber(5);
  }
  if (!candidates.length) {
    throw new Error('No Twilio numbers available in primary or backup area code (primary=' + (workspace.area_code_preference || 'none') + ', backup=' + (workspace.area_code_backup_preference || 'none') + ')');
  }
  return candidates;
}

// One attempt against one workspace. Returns { attempted, ok, ... };
// never throws (the kick is fire-and-forget, the sweep loops on).
async function provisionWorkspaceNumber(pool, workspaceId, opts = {}) {
  const deps = opts.deps || twilioProvisioning;
  const env = opts.env || process.env;
  const log = opts.logger || console;
  let attempt = null;
  let purchasedSid = null;
  try {
    // CLAIM: increments attempts and moves the time gate in one
    // statement — a concurrent kick/sweep sees a future gate and skips.
    const claim = await pool.query(
      `UPDATE workspaces
          SET twilio_attempts = twilio_attempts + 1,
              twilio_next_attempt_at = NOW() + make_interval(secs => $2)
        WHERE id = $1
          AND twilio_status = 'provisioning'
          AND (twilio_next_attempt_at IS NULL OR twilio_next_attempt_at <= NOW())
        RETURNING id, twilio_attempts, area_code_preference, area_code_backup_preference`,
      [workspaceId, IN_FLIGHT_LOCK_SECONDS]
    );
    if (!claim.rows.length) return { attempted: false, reason: 'not_claimable' };
    const ws = claim.rows[0];
    attempt = ws.twilio_attempts;

    const candidates = await findCandidates(ws, deps, env, log);
    const purchased = await deps.purchaseNumber(candidates[0].phone_number);
    purchasedSid = purchased.phone_sid;
    const baseUrl = (env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    await deps.configureNumberWebhooks(purchased.phone_sid, baseUrl);

    // The 061 invariant, checked in code before the write ever leaves.
    assertPhoneStatusLegal({ twilio_status: 'active', twilio_phone_number: purchased.phone_number });
    const flip = await pool.query(
      `UPDATE workspaces
          SET twilio_phone_number   = $1,
              twilio_phone_sid      = $2,
              twilio_provisioned_at = NOW(),
              twilio_status         = 'active',
              twilio_last_error     = NULL,
              twilio_next_attempt_at = NULL
        WHERE id = $3 AND twilio_status = 'provisioning'
        RETURNING id`,
      [purchased.phone_number, purchased.phone_sid, workspaceId]
    );
    if (!flip.rows.length) {
      // Someone else finished (or the state moved) while we held a
      // number — release it so we never rent two.
      try { await deps.releaseNumber(purchasedSid); } catch (relErr) {
        log.error('[provisioning] release after lost flip failed (manual cleanup):', relErr.message);
      }
      return { attempted: true, ok: false, reason: 'flip_lost' };
    }
    log.log('[provisioning] ws=' + workspaceId + ' ACTIVE: ' + purchased.phone_number + ' (attempt ' + attempt + ')');
    return { attempted: true, ok: true, phone: purchased.phone_number, attempt };
  } catch (err) {
    // Never hold a number we didn't record.
    if (purchasedSid) {
      try { await deps.releaseNumber(purchasedSid); } catch (relErr) {
        log.error('[provisioning] FAILED to release ' + purchasedSid + ' after error (manual cleanup):', relErr.message);
      }
    }
    // A claim failure (attempt === null) means the error came from the
    // claim query itself — nothing to record against attempts.
    if (attempt === null) {
      log.error('[provisioning] ws=' + workspaceId + ' claim errored:', err.message);
      return { attempted: false, ok: false, reason: 'claim_error' };
    }
    const terminal = attempt >= MAX_ATTEMPTS;
    const message = String(err.message || err).slice(0, 500);
    try {
      if (terminal) {
        await pool.query(
          `UPDATE workspaces
              SET twilio_status = 'failed',
                  twilio_last_error = $2,
                  twilio_next_attempt_at = NULL
            WHERE id = $1 AND twilio_status = 'provisioning'`,
          [workspaceId, message]
        );
        // LOUD. The owner task + one-tap re-arm land in SP4b; until
        // then this marker + the honest 'failed' state are the record.
        log.error('[provisioning] ws=' + workspaceId + ' FAILED after ' + attempt + ' attempts: ' + message);
      } else {
        const wait = backoffSeconds(attempt);
        await pool.query(
          `UPDATE workspaces
              SET twilio_last_error = $2,
                  twilio_next_attempt_at = NOW() + make_interval(secs => $3)
            WHERE id = $1 AND twilio_status = 'provisioning'`,
          [workspaceId, message, wait]
        );
        log.error('[provisioning] ws=' + workspaceId + ' attempt ' + attempt + ' failed (' + message + '); next in ' + wait + 's');
      }
    } catch (recordErr) {
      log.error('[provisioning] could not record attempt outcome for ws=' + workspaceId + ':', recordErr.message);
    }
    return { attempted: true, ok: false, attempt, terminal };
  }
}

// The 1-minute sweep: everything provisioning, under the cap, and due.
// Catches orphans the kick missed (server restart mid-provision,
// backoff expiries) and drives every retry.
async function runProvisioningSweep(pool, opts = {}) {
  const log = (opts && opts.logger) || console;
  try {
    const r = await pool.query(
      `SELECT id FROM workspaces
        WHERE twilio_status = 'provisioning'
          AND twilio_attempts < $1
          AND (twilio_next_attempt_at IS NULL OR twilio_next_attempt_at <= NOW())
        ORDER BY id`,
      [MAX_ATTEMPTS]
    );
    let attempted = 0;
    for (const row of r.rows) {
      const res = await provisionWorkspaceNumber(pool, row.id, opts);
      if (res && res.attempted) attempted++;
    }
    return { eligible: r.rows.length, attempted };
  } catch (err) {
    log.error('[provisioning] sweep failed:', err.message);
    return { eligible: 0, attempted: 0, error: err.message };
  }
}

module.exports = {
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  IN_FLIGHT_LOCK_SECONDS,
  backoffSeconds,
  findCandidates,
  provisionWorkspaceNumber,
  runProvisioningSweep,
};
