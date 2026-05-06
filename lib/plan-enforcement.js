// lib/plan-enforcement.js
//
// Central plan enforcement layer (D4). Route handlers call into this
// module to check whether a workspace can perform an action.
//
// Reads from:
//   - workspaces (plan, subscription_status)
//   - lib/plans.js (limits and feature flags per plan)
//   - lib/usage.js (current usage counters)
//
// Returns structured { allowed, reason, suggestion } objects rather
// than throwing. Routes decide how to respond (403, 429, etc.).
//
// Best-effort semantics on the read side: if a counter helper returns
// null (DB error), the check fails OPEN (allow the action). Tracking
// failures must not block legitimate users. The strict side is the
// success path: a confirmed at-or-over-limit count BLOCKS.

const plans = require('./plans');
const usage = require('./usage');

/**
 * Resolve a workspace to its current plan info.
 * Returns { id, plan, subscription_status, owner_user_id } or null.
 */
async function getWorkspacePlanInfo(pool, workspaceId) {
  if (!pool || !workspaceId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id, plan, subscription_status, owner_user_id
       FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[plan-enforcement] getWorkspacePlanInfo failed:', err.message);
    return null;
  }
}

/**
 * Check whether the workspace's subscription status permits any platform use.
 *
 * - canceled: read-only mode (no writes, no AI). UI banner from D5.
 * - past_due: full access for now (D5 will add UI nudges).
 * - active, trial: full access.
 * - null/undefined (legacy): allowed — don't break existing workspaces.
 */
function checkSubscriptionStatus(planInfo) {
  if (!planInfo) return { allowed: true, reason: null, suggestion: null };
  const status = planInfo.subscription_status;
  if (!status) return { allowed: true, reason: null, suggestion: null };
  if (status === 'canceled') {
    return {
      allowed: false,
      reason: 'subscription_canceled',
      suggestion: 'Your subscription has been canceled. Reactivate to continue using Modern Management.',
    };
  }
  return { allowed: true, reason: null, suggestion: null };
}

/**
 * Check whether a feature is included in the workspace's plan.
 */
function checkFeature(planInfo, featureName) {
  if (!planInfo || !planInfo.plan) {
    return { allowed: true, reason: null, suggestion: null };
  }
  if (plans.hasFeature(planInfo.plan, featureName)) {
    return { allowed: true, reason: null, suggestion: null };
  }
  return {
    allowed: false,
    reason: 'feature_not_in_plan',
    suggestion: plans.buildFeatureMessage(planInfo.plan, featureName),
  };
}

/**
 * Check whether adding one more of a resource would exceed the plan limit.
 *
 * Best-effort: null/undefined currentCount allows the action.
 */
function checkResourceLimit(planInfo, limitName, currentCount) {
  if (!planInfo || !planInfo.plan) {
    return { allowed: true, reason: null, suggestion: null };
  }
  if (currentCount === null || currentCount === undefined) {
    return { allowed: true, reason: null, suggestion: null };
  }
  if (plans.isAtLimit(planInfo.plan, limitName, currentCount)) {
    return {
      allowed: false,
      reason: 'limit_reached',
      suggestion: plans.buildLimitMessage(planInfo.plan, limitName, currentCount),
    };
  }
  return { allowed: true, reason: null, suggestion: null };
}

/**
 * Check whether the user can run another AI command today.
 * Fails OPEN on counter read errors (tracking shouldn't block legit users).
 */
async function checkAICommandQuota(pool, planInfo, userId) {
  if (!planInfo || !planInfo.plan || !userId) {
    return { allowed: true, reason: null, suggestion: null, count: null, limit: null };
  }
  const limit = plans.getLimit(planInfo.plan, 'aiCommandsPerDayPerUser');
  if (limit === null || limit === undefined) {
    return { allowed: true, reason: null, suggestion: null, count: null, limit: null };
  }
  const count = await usage.getAICommandCountToday(pool, {
    workspaceId: planInfo.id,
    userId,
  });
  if (count === null) {
    // Read failed — fail open
    return { allowed: true, reason: null, suggestion: null, count: null, limit };
  }
  if (count >= limit) {
    return {
      allowed: false,
      reason: 'ai_quota_exceeded',
      suggestion: `You've used ${count} of your ${limit} daily AI commands on the ${plans.getPlan(planInfo.plan).name} plan. Quota resets at midnight. Upgrade for more.`,
      count,
      limit,
    };
  }
  return { allowed: true, reason: null, suggestion: null, count, limit };
}

/**
 * Check whether the workspace can generate another report this month.
 */
async function checkReportQuota(pool, planInfo) {
  if (!planInfo || !planInfo.plan) {
    return { allowed: true, reason: null, suggestion: null, count: null, limit: null };
  }
  const limit = plans.getLimit(planInfo.plan, 'reportsPerMonth');
  if (limit === null || limit === undefined) {
    return { allowed: true, reason: null, suggestion: null, count: null, limit: null };
  }
  const count = await usage.getReportCountThisMonth(pool, {
    workspaceId: planInfo.id,
  });
  if (count === null) {
    return { allowed: true, reason: null, suggestion: null, count: null, limit };
  }
  if (count >= limit) {
    return {
      allowed: false,
      reason: 'report_quota_exceeded',
      suggestion: `You've generated ${count} of your ${limit} monthly reports on the ${plans.getPlan(planInfo.plan).name} plan. Quota resets on the 1st. Upgrade for more.`,
      count,
      limit,
    };
  }
  return { allowed: true, reason: null, suggestion: null, count, limit };
}

module.exports = {
  getWorkspacePlanInfo,
  checkSubscriptionStatus,
  checkFeature,
  checkResourceLimit,
  checkAICommandQuota,
  checkReportQuota,
};
