// lib/tool-registry.js
//
// Central registry for AI tools available via the command bar.
// Tools are registered by importing them in lib/tools/index.js.
// Each tool module calls registry.register() with a definition
// including its schema, executor, vertical tag, and navigation
// metadata.
//
// This registry is loaded at server startup but is NOT yet wired
// into /api/command. Session B2 will perform that switch. Until
// then, the registry exists alongside the old inline tool system
// for verification purposes only.

const plans = require('./plans');

// Session D4: static map of tool → required plan feature. Keeps tool
// executor files in lib/tools/ untouched. Tools whose name appears
// here are filtered out of getToolsForPlan() when the workspace's plan
// does not include the listed feature. Tools NOT in this map pass
// through unchanged on all plans.
//
// Aligns with lib/plans.js features keys: broadcast, autoResponse,
// apiAccess, multiUserCollaboration, dailyBriefing, customAITraining,
// dedicatedCSM. Per the D4 pricing review, only send_broadcast is
// gated today — individual sends (send_sms / send_email /
// reply_to_message) are allowed on all tiers.
const TOOL_REQUIRED_FEATURE = {
  send_broadcast: 'broadcast',
};

const tools = new Map();

function register(toolDef) {
  if (!toolDef || !toolDef.name) {
    throw new Error('Tool definition must have a name');
  }
  if (tools.has(toolDef.name)) {
    throw new Error(`Tool already registered: ${toolDef.name}`);
  }
  const requiredFields = ['name', 'description', 'schema', 'vertical', 'category', 'execute'];
  for (const field of requiredFields) {
    if (!(field in toolDef)) {
      throw new Error(`Tool ${toolDef.name} missing required field: ${field}`);
    }
  }
  if (typeof toolDef.execute !== 'function') {
    throw new Error(`Tool ${toolDef.name}: execute must be a function`);
  }
  // Defaults for optional fields
  if (!('navigationPolicy' in toolDef)) toolDef.navigationPolicy = 'never';
  if (!('navigateTo' in toolDef)) toolDef.navigateTo = null;
  if (!('requiresApproval' in toolDef)) toolDef.requiresApproval = false;
  tools.set(toolDef.name, toolDef);
}

function getTool(name) {
  return tools.get(name) || null;
}

function getAllTools() {
  return Array.from(tools.values());
}

function getToolsForVertical(vertical) {
  const result = [];
  for (const tool of tools.values()) {
    if (tool.vertical === 'core' || tool.vertical === vertical) {
      result.push(tool);
    }
  }
  return result;
}

function getAnthropicSchemaForVertical(vertical) {
  return getToolsForVertical(vertical).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  }));
}

/**
 * Session D4: vertical filter + plan-feature filter. Tools listed in
 * TOOL_REQUIRED_FEATURE are excluded when the plan doesn't include the
 * listed feature. Tools without an entry in the map pass through.
 *
 * If `plan` is null/undefined (legacy workspace), behaves like
 * getToolsForVertical (no plan filtering applied).
 */
function getToolsForPlan(vertical, plan) {
  const verticalTools = getToolsForVertical(vertical);
  if (!plan) return verticalTools;
  return verticalTools.filter(t => {
    const requiredFeature = TOOL_REQUIRED_FEATURE[t.name];
    if (!requiredFeature) return true;
    return plans.hasFeature(plan, requiredFeature);
  });
}

function getAnthropicSchemaForPlan(vertical, plan) {
  return getToolsForPlan(vertical, plan).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  }));
}

function getSystemPromptToolBlockForVertical(vertical) {
  const lines = getToolsForVertical(vertical).map(t => {
    const firstSentence = t.description.split('.')[0];
    return `- ${t.name}: ${firstSentence}.`;
  });
  return lines.join('\n');
}

// Reset for testing only — never called in production
function _reset() {
  tools.clear();
}

module.exports = {
  register,
  getTool,
  getAllTools,
  getToolsForVertical,
  getAnthropicSchemaForVertical,
  getSystemPromptToolBlockForVertical,
  getToolsForPlan,
  getAnthropicSchemaForPlan,
  TOOL_REQUIRED_FEATURE,
  _reset
};
