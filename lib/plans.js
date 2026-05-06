// lib/plans.js
//
// Central pricing config and capability lookup.
//
// Every feature gate, usage limit, or plan-dependent behavior in the
// codebase MUST consult this module. Do not duplicate plan limits
// elsewhere — change them here once and the entire app picks it up.
//
// This module is loaded at server startup (via require('./lib/plans')
// in server.js) so the values are available everywhere.
//
// ============================================================================
// Tier model (Session D6 repositioning, 2026-05-06):
// All tiers ship single-user-only at launch. Tier differentiation comes from:
//   - AI command daily caps (Solo 15, Team 30, Enterprise 500)
//   - Monthly report caps (Solo 5, Team 20, Enterprise unlimited)
//   - Resource caps (properties, units, contacts)
//   - Feature inclusion (broadcast, auto-response, daily briefing, API,
//     custom AI training, dedicated CSM)
//
// Multi-user collaboration is on the roadmap as a free upgrade for Team and
// Enterprise — to ship after launch when real customer demand justifies the
// schema work (workspace_users join table, invitation flow, per-seat Stripe
// quantity management). Until then:
//   - limits.maxUsers = 1 across every tier (matches schema reality:
//     workspaces.owner_user_id is single-owner, no workspace_users table)
//   - features.multiUserCollaboration = false across every tier
//   - extraUserPrice = 0 across every tier
//   - The Stripe lookup_key 'additional_user_monthly' (configured in
//     SIGNUP_PRICE_LOOKUP_KEYS in server.js) is RESERVED but NOT charged
//     today — kept so future multi-user work doesn't need a new Stripe
//     price object.
//
// Reference: docs/pricing-strategy-v1.md
// ============================================================================

const PLANS = {
  trial: {
    name: 'Trial',
    displayName: '7-day Trial',
    monthlyPrice: 0,
    extraUserPrice: 0,
    // Trial gives Solo-level access for 7 days
    limits: {
      maxUsers: 1,
      aiCommandsPerDayPerUser: 15,
      reportsPerMonth: 5,
      maxProperties: 3,
      maxUnits: 10,
      maxContacts: 25
    },
    features: {
      broadcast: false,
      autoResponse: false,
      apiAccess: false,
      multiUserCollaboration: false,
      dailyBriefing: false,
      customAITraining: false,
      dedicatedCSM: false
    }
  },

  solo: {
    name: 'Solo',
    displayName: 'Solo',
    monthlyPrice: 79,
    extraUserPrice: 0, // Solo is single-user; no extras
    limits: {
      maxUsers: 1,
      aiCommandsPerDayPerUser: 15,
      reportsPerMonth: 5,
      maxProperties: 3,
      maxUnits: 10,
      maxContacts: 25
    },
    features: {
      broadcast: false,
      autoResponse: false,
      apiAccess: false,
      multiUserCollaboration: false,
      dailyBriefing: false,
      customAITraining: false,
      dedicatedCSM: false
    }
  },

  team: {
    name: 'Team',
    displayName: 'Team',
    monthlyPrice: 149,
    extraUserPrice: 0, // D6: multi-user not yet shipped; reserved for future use
    limits: {
      maxUsers: 1, // D6: single-user at launch; multi-user is a post-launch free upgrade
      aiCommandsPerDayPerUser: 30,
      reportsPerMonth: 20,
      maxProperties: 10,
      maxUnits: null, // unlimited
      maxContacts: null // unlimited
    },
    features: {
      broadcast: true,
      autoResponse: true,
      apiAccess: false,
      multiUserCollaboration: false, // D6: future free upgrade
      dailyBriefing: true,
      customAITraining: false,
      dedicatedCSM: false
    }
  },

  enterprise: {
    name: 'Enterprise',
    displayName: 'Enterprise',
    monthlyPrice: 299,
    extraUserPrice: 0, // D6: multi-user not yet shipped; reserved for future use
    limits: {
      maxUsers: 1, // D6: single-user at launch; multi-user is a post-launch free upgrade
      aiCommandsPerDayPerUser: 500, // soft cap for abuse prevention; effectively unlimited
      reportsPerMonth: null, // unlimited
      maxProperties: null, // unlimited
      maxUnits: null, // unlimited
      maxContacts: null // unlimited
    },
    features: {
      broadcast: true,
      autoResponse: true,
      apiAccess: true,
      multiUserCollaboration: false, // D6: future free upgrade
      dailyBriefing: true,
      customAITraining: true,
      dedicatedCSM: true
    }
  }
};

const VALID_PLAN_IDS = Object.keys(PLANS);
const DEFAULT_PLAN_ID = 'team'; // matches the DB column default

/**
 * Return the full plan config for a plan id. Falls back to the default
 * plan if the id is unknown — this is intentional defensive behavior so
 * a stale plan name in the DB never breaks the app.
 */
function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

/**
 * Return the limit for a specific resource on a given plan.
 * Returns null for unlimited.
 *
 * Example: getLimit('solo', 'maxProperties') => 3
 *          getLimit('team', 'maxContacts') => null (unlimited)
 */
function getLimit(planId, limitName) {
  const plan = getPlan(planId);
  if (!plan.limits || !(limitName in plan.limits)) return null;
  return plan.limits[limitName];
}

/**
 * Check whether a plan includes a particular feature.
 * Returns true/false.
 *
 * Example: hasFeature('solo', 'broadcast') => false
 *          hasFeature('team', 'broadcast') => true
 */
function hasFeature(planId, featureName) {
  const plan = getPlan(planId);
  return !!(plan.features && plan.features[featureName]);
}

/**
 * Check whether the current count is at or over the plan's limit for a resource.
 * Returns true if the action would exceed the limit.
 *
 * Example: isAtLimit('solo', 'maxProperties', 3) => true (already at 3, can't add more)
 *          isAtLimit('team', 'maxContacts', 50) => false (unlimited)
 *          isAtLimit('solo', 'maxContacts', 25) => true (at limit)
 *          isAtLimit('solo', 'maxContacts', 24) => false (one slot left)
 */
function isAtLimit(planId, limitName, currentCount) {
  const limit = getLimit(planId, limitName);
  if (limit === null) return false; // unlimited
  return currentCount >= limit;
}

/**
 * Return how many of a resource the workspace can still add.
 * Returns Infinity for unlimited.
 *
 * Example: remainingCapacity('solo', 'maxProperties', 2) => 1
 *          remainingCapacity('team', 'maxContacts', 50) => Infinity
 */
function remainingCapacity(planId, limitName, currentCount) {
  const limit = getLimit(planId, limitName);
  if (limit === null) return Infinity;
  return Math.max(0, limit - currentCount);
}

/**
 * Build a customer-facing message explaining why an action was blocked.
 * Used by future enforcement code to render upgrade prompts.
 */
function buildLimitMessage(planId, limitName, currentCount) {
  const plan = getPlan(planId);
  const limit = getLimit(planId, limitName);
  const friendlyNames = {
    maxUsers: 'users',
    maxProperties: 'properties',
    maxUnits: 'units',
    maxContacts: 'contacts',
    aiCommandsPerDayPerUser: 'AI commands today',
    reportsPerMonth: 'reports this month'
  };
  const noun = friendlyNames[limitName] || limitName;
  return `Your ${plan.name} plan allows ${limit} ${noun}. You're currently at ${currentCount}. Upgrade to add more.`;
}

/**
 * Build a customer-facing message for blocked features.
 */
function buildFeatureMessage(planId, featureName) {
  const plan = getPlan(planId);
  const friendlyNames = {
    broadcast: 'broadcast messaging',
    autoResponse: 'auto-response',
    apiAccess: 'API access',
    multiUserCollaboration: 'multi-user collaboration',
    dailyBriefing: 'Daily Briefing',
    customAITraining: 'custom AI training',
    dedicatedCSM: 'dedicated success manager'
  };
  const featureDisplay = friendlyNames[featureName] || featureName;
  return `${featureDisplay} is not included in your ${plan.name} plan. Upgrade to access it.`;
}

module.exports = {
  PLANS,
  VALID_PLAN_IDS,
  DEFAULT_PLAN_ID,
  getPlan,
  getLimit,
  hasFeature,
  isAtLimit,
  remainingCapacity,
  buildLimitMessage,
  buildFeatureMessage
};
