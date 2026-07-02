// lib/config.js
//
// Central app-wide configuration constants.
// Add config here when it needs to be referenced from multiple places.
//
// Session D7: introduced to centralize the Anthropic model name.
// Previously the model literal was hardcoded across 8 call sites in
// server.js, making model upgrades a multi-file edit. Now there's a
// single source of truth — change ANTHROPIC_MODEL below to upgrade.

// Default model for almost all AI features (Command Center, auto-reply,
// task suggester, appointment engine, payment parser, daily nudge,
// home-page snapshot report). Chosen for low cost + low latency.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Stronger model reserved ONLY for the main long-form report generator
// (generateReportContent), where writing quality matters most.
const ANTHROPIC_REPORT_MODEL = 'claude-opus-4-6';

// Future additions:
// - Default report generation parameters
// - Rate limit thresholds
// - Feature flags

module.exports = {
  ANTHROPIC_MODEL,
  ANTHROPIC_REPORT_MODEL,
};
