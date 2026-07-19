// lib/tools/update_ai_settings.js — AP3, approval-gated.
// Mirrors PATCH /api/workspace/ai-settings. The AI changing its own
// guardrails is exactly what the approval queue exists for:
// requiresApproval routes this through pending_actions on /api/command,
// and the FD2 engine gate refuses approval-gated tools outright, so a
// customer conversation can never reach it by construction.

const registry = require('../tool-registry');

registry.register({
  name: 'update_ai_settings',
  description: 'Change how the AI assistant behaves: appointment_auto_respond (AI answers inbound customer messages), appointment_auto_confirm (bookings confirm without owner review), ai_tone (warm / professional / brief), ai_sales_posture (reactive / proactive). Requires owner approval before it takes effect.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      appointment_auto_respond: { type: 'boolean' },
      appointment_auto_confirm: { type: 'boolean' },
      ai_tone: { type: 'string', enum: ['warm', 'professional', 'brief'] },
      ai_sales_posture: { type: 'string', enum: ['reactive', 'proactive'] },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can change assistant settings.' };
    }
    const setClauses = [];
    const params = [];
    let i = 1;
    if (typeof input.appointment_auto_respond === 'boolean') {
      setClauses.push(`appointment_auto_respond = $${i++}`);
      params.push(input.appointment_auto_respond);
    }
    if (typeof input.appointment_auto_confirm === 'boolean') {
      setClauses.push(`appointment_auto_confirm = $${i++}`);
      params.push(input.appointment_auto_confirm);
    }
    if (input.ai_tone && ['warm', 'professional', 'brief'].includes(input.ai_tone)) {
      setClauses.push(`ai_tone = $${i++}`);
      params.push(input.ai_tone);
    }
    if (input.ai_sales_posture && ['reactive', 'proactive'].includes(input.ai_sales_posture)) {
      setClauses.push(`ai_sales_posture = $${i++}`);
      params.push(input.ai_sales_posture);
    }
    if (!setClauses.length) return { success: false, message: 'No valid settings provided.' };
    params.push(ctx.workspace.id);
    await ctx.db.query(
      `UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = $${i}`,
      params
    );
    const changed = setClauses.map(c => c.split(' =')[0]).join(', ');
    return { success: true, data: { changed: changed.split(', ') }, message: `Assistant settings updated: ${changed}.`, summary: `Change assistant settings (${changed})` };
  },
});
