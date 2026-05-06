// lib/config.js
//
// Central app-wide configuration constants.
// Add config here when it needs to be referenced from multiple places.
//
// Session D7: introduced to centralize the Anthropic model name.
// Previously the model literal was hardcoded across 8 call sites in
// server.js, making model upgrades a multi-file edit. Now there's a
// single source of truth — change ANTHROPIC_MODEL below to upgrade.

const ANTHROPIC_MODEL = 'claude-opus-4-6';

// Future additions:
// - Default report generation parameters
// - Rate limit thresholds
// - Feature flags

module.exports = {
  ANTHROPIC_MODEL,
};
