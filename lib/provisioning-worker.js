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

// PROV-ATTACH failure path: LOUD, never fatal. A Sentry capture
// (graceful no-op when monitoring is off), a structured error log, and
// an operator task filed against the admin user (the SP4c precedent)
// naming the number and the manual fix.
async function alertAttachFailure(pool, log, opts, workspaceId, purchased, err) {
  log.error('[provisioning] ws=' + workspaceId + ' MESSAGING-SERVICE ATTACH FAILED for '
    + purchased.phone_number + ' — this number can NOT send SMS under the A2P campaign until attached: ' + err.message);
  try {
    const sentry = (opts && opts.sentry) || require('@sentry/node');
    if (sentry && typeof sentry.captureException === 'function') sentry.captureException(err);
  } catch (sentryErr) {
    log.error('[provisioning] Sentry capture failed (continuing):', sentryErr.message);
  }
  try {
    const adminR = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (adminR.rows.length) {
      await pool.query(
        `INSERT INTO tasks (user_id, title, category, "dueDate", notes)
         VALUES ($1, $2, 'other', $3, $4)`,
        [adminR.rows[0].id,
          'Attach a provisioned number to the messaging service',
          new Date().toISOString().slice(0, 10),
          'Workspace ' + workspaceId + ' received number ' + purchased.phone_number + ' ('
          + purchased.phone_sid + ') but attaching it to the A2P Messaging Service failed: '
          + String(err.message || err).slice(0, 300)
          + '\nVoice works. SMS under the campaign will NOT until the number is added to the '
          + 'service (Console > Messaging > Services), or the worker retries on a future signup fix.']
      );
    }
  } catch (taskErr) {
    log.error('[provisioning] could not file the operator attach task for ws=' + workspaceId + ':', taskErr.message);
  }
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
        RETURNING id, twilio_attempts, area_code_preference, area_code_backup_preference, vertical`,
      [workspaceId, IN_FLIGHT_LOCK_SECONDS]
    );
    if (!claim.rows.length) return { attempted: false, reason: 'not_claimable' };
    const ws = claim.rows[0];
    attempt = ws.twilio_attempts;

    const candidates = await findCandidates(ws, deps, env, log);
    const purchased = await deps.purchaseNumber(candidates[0].phone_number);
    purchasedSid = purchased.phone_sid;
    const baseUrl = (env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    // SP5a: the workspace's vertical decides the VOICE path. Before
    // this, every number the worker provisioned got the PM voicemail
    // path — so a newly provisioned PS salon answered calls with
    // "Thank you for calling Modern Management" and never reached its
    // AI receptionist. The claim now returns the vertical for exactly
    // this.
    await deps.configureNumberWebhooks(purchased.phone_sid, baseUrl, { vertical: ws.vertical });

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
    // PROV-ATTACH: a number that is not on the A2P Messaging Service
    // cannot send SMS under the VERIFIED campaign. Attach AFTER the
    // flip; failure is LOUD (Sentry + operator task) but NEVER rolls
    // the signup back — voice works, and the texting gap is flagged,
    // not hidden. Applies to NEW provisioning only: nothing here (or
    // anywhere) touches existing attachments, the demo number, or the
    // toll-free.
    try {
      await deps.attachToMessagingService(purchased.phone_sid, env);
      log.log('[provisioning] ws=' + workspaceId + ' attached ' + purchased.phone_number + ' to the messaging service');
    } catch (attachErr) {
      await alertAttachFailure(pool, log, opts, workspaceId, purchased, attachErr);
    }
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
        const failed = await pool.query(
          `UPDATE workspaces
              SET twilio_status = 'failed',
                  twilio_last_error = $2,
                  twilio_next_attempt_at = NULL
            WHERE id = $1 AND twilio_status = 'provisioning'
            RETURNING owner_user_id`,
          [workspaceId, message]
        );
        log.error('[provisioning] ws=' + workspaceId + ' FAILED after ' + attempt + ' attempts: ' + message);
        // SP4b: the owner learns in-app, not by noticing silence. One
        // task per failure transition (the UPDATE's status guard makes
        // this fire exactly once — a re-armed-then-failed-again
        // workspace files a fresh one, which is correct).
        if (failed.rows.length) {
          try {
            await pool.query(
              `INSERT INTO tasks (user_id, title, category, "dueDate", notes)
               VALUES ($1, $2, 'other', $3, $4)`,
              [failed.rows[0].owner_user_id,
                'Your business phone number needs attention',
                new Date().toISOString().slice(0, 10),
                "We couldn't finish setting up your dedicated number automatically after " +
                attempt + ' attempts. Your account is fully working otherwise — you can ' +
                'retry from Settings, and support has been alerted. Last error: ' + message]
            );
          } catch (taskErr) {
            log.error('[provisioning] could not file the owner task for ws=' + workspaceId + ':', taskErr.message);
          }
        }
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

// SP4b: the one-tap re-arm. A 'failed' workspace goes back to
// 'provisioning' with a zeroed counter and an immediately-due gate,
// so the caller's kick (or the next sweep) picks it straight up.
// Guarded on status='failed' — it can never disturb an active
// workspace or double-arm one already provisioning.
async function rearmProvisioning(pool, workspaceId) {
  const r = await pool.query(
    `UPDATE workspaces
        SET twilio_status = 'provisioning',
            twilio_attempts = 0,
            twilio_last_error = NULL,
            twilio_next_attempt_at = NULL
      WHERE id = $1 AND twilio_status = 'failed'
      RETURNING id`,
    [workspaceId]
  );
  return { rearmed: r.rows.length > 0 };
}

module.exports = {
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  IN_FLIGHT_LOCK_SECONDS,
  backoffSeconds,
  findCandidates,
  provisionWorkspaceNumber,
  runProvisioningSweep,
  rearmProvisioning,
};
