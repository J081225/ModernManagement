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
// Pricing model (2026-08-16 ruling — LOCKED): ONE plan + a 7-day trial.
//
// The old six-tier ladder (solo/team/enterprise + starter/pro/premium) is
// RETIRED. Those tiers differentiated almost entirely on features that do
// not exist (see ANTI_LIST) — the claims census forbids re-listing them.
// getPlan() falls back to the single plan for ANY legacy stored id, so every
// existing workspace resolves safely to 'professional' with NO migration.
//
//   - ONE price: $320/mo, $3,200/yr (2 months free). Founding: $160/mo for
//     the first 10-15 customers, locked 12 months — a GATED cohort with a
//     stated trade (testimonial + call recordings + monthly feedback), NOT
//     self-serve at signup.
//   - No displayed caps: every resource limit is null (unlimited). Fair use
//     (~1,000 AI voice min/mo, ~250 calls) is a SOFT, fine-print,
//     conversational line — never a code gate, never a surprise invoice.
//   - maxUsers stays 1 (single-owner schema reality; multi-user is a future
//     free upgrade, not sold today).
//   - Feature flags: every REAL feature on; the five nonexistent PS features
//     stay false FOREVER (ANTI_LIST) so no gate/tool/marketing claims them.
//
// Reference: docs/lp-pricing-strategy.md + memory pricing-model-locked.
// ============================================================================

// The five features the retired tiers sold that have ZERO code behind them.
// NEVER re-list these as product features (claims census). Pinned by
// scripts/test-pricing-claims.js against both this module and the landing copy.
const ANTI_LIST = [
  { flag: 'automaticReminders',      label: 'Automatic appointment reminders' },
  { flag: 'multiStaffScheduling',    label: 'Multi-staff scheduling' },
  { flag: 'brandedSmsSenderId',      label: 'Branded SMS sender ID' },
  { flag: 'priorityResponseQueue',   label: 'Priority response queue' },
  { flag: 'customAppointmentFields', label: 'Custom appointment fields' },
];

const PLANS = {
  // The 7-day trial: full access to the one plan, free, for 7 days.
  trial: {
    name: 'Trial',
    displayName: '7-day Trial',
    monthlyPrice: 0,
    extraUserPrice: 0,
    limits: {
      maxUsers: 1,
      aiCommandsPerDayPerUser: null,
      reportsPerMonth: null,
      maxProperties: null,
      maxUnits: null,
      maxContacts: null,
      maxAppointmentsPerMonth: null,
      maxAIConversationsPerMonth: null,
      maxServices: null,
      maxInventoryItems: null,
      maxKnowledgeBaseEntries: null
    },
    features: {
      broadcast: true,
      autoResponse: true,
      apiAccess: false,
      multiUserCollaboration: false,
      dailyBriefing: true,
      customAITraining: false,
      dedicatedCSM: false,
      // ANTI_LIST — nonexistent, false forever.
      automaticReminders: false,
      vendorMessaging: true,
      customAppointmentFields: false,
      multiStaffScheduling: false,
      brandedSmsSenderId: false,
      priorityResponseQueue: false,
      premiumOnboarding: false
    }
  },

  // THE plan. One price, everything included.
  professional: {
    name: 'Professional',
    displayName: 'Modern Management',
    vertical: 'professional-services',
    // ONE price. Monthly + annual (2 months free) + founding (gated cohort).
    monthlyPrice: 320,
    annualPrice: 3200,
    foundingPrice: 160,
    extraUserPrice: 0,
    limits: {
      maxUsers: 1, // single-owner reality; multi-user is a future free upgrade
      // No displayed caps — everything unlimited. Fair use is soft/verbal.
      aiCommandsPerDayPerUser: null,
      reportsPerMonth: null,
      maxProperties: null,
      maxUnits: null,
      maxContacts: null,
      maxAppointmentsPerMonth: null,
      maxAIConversationsPerMonth: null,
      maxServices: null,
      maxInventoryItems: null,
      maxKnowledgeBaseEntries: null
    },
    features: {
      // Real features — on.
      broadcast: true,
      autoResponse: true,
      dailyBriefing: true,
      vendorMessaging: true,
      // Not sold today.
      apiAccess: false,
      multiUserCollaboration: false,
      customAITraining: false,
      dedicatedCSM: false,
      premiumOnboarding: false,
      // ANTI_LIST — nonexistent features, false FOREVER (claims census).
      automaticReminders: false,
      multiStaffScheduling: false,
      brandedSmsSenderId: false,
      priorityResponseQueue: false,
      customAppointmentFields: false
    }
  }
};

const VALID_PLAN_IDS = Object.keys(PLANS);
// The one live plan. getPlan() maps every legacy stored id (solo/team/
// enterprise/starter/pro/premium) here, so no DB migration is needed.
const DEFAULT_PLAN_ID = 'professional';

/**
 * Return the full plan config for a plan id. Falls back to the default
 * plan if the id is unknown — this is intentional defensive behavior so
 * a stale plan name in the DB never breaks the app. Post-collapse, this
 * is also how every retired-tier workspace resolves to the one live plan.
 */
function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

/**
 * Return the limit for a specific resource on a given plan.
 * Returns null for unlimited.
 *
 * Example: getLimit('professional', 'maxContacts') => null (unlimited)
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
 * Example: hasFeature('professional', 'autoResponse') => true
 *          hasFeature('professional', 'automaticReminders') => false (anti-list)
 */
function hasFeature(planId, featureName) {
  const plan = getPlan(planId);
  return !!(plan.features && plan.features[featureName]);
}

/**
 * Check whether the current count is at or over the plan's limit for a resource.
 * Returns true if the action would exceed the limit.
 *
 * Example: isAtLimit('professional', 'maxContacts', 5000) => false (unlimited)
 */
function isAtLimit(planId, limitName, currentCount) {
  const limit = getLimit(planId, limitName);
  if (limit === null) return false; // unlimited
  return currentCount >= limit;
}

/**
 * Return how many of a resource the workspace can still add.
 * Returns Infinity for unlimited.
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
  ANTI_LIST,
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
