// lib/tools/update_knowledge.js — AP3, approval-gated.
// Updates the business knowledge the AI answers customers from —
// hours of operation, policies, or the business description. These
// rows steer every customer conversation, so changes queue for owner
// approval (and the FD2 engine gate keeps customers away entirely).

const registry = require('../tool-registry');

const FIELDS = {
  hours: 'Hours of Operation',
  policies: 'Policies',
  description: 'Business Description',
};

registry.register({
  name: 'update_knowledge',
  description: 'Rewrite one business-knowledge field the AI answers customers from: hours (Hours of Operation), policies, or description (Business Description). Replaces the field content wholesale. Requires owner approval.',
  vertical: 'core',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      field: { type: 'string', enum: ['hours', 'policies', 'description'] },
      content: { type: 'string', description: 'The full new content for the field.' },
    },
    required: ['field', 'content'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can change business knowledge.' };
    }
    const field = input.field;
    if (!FIELDS[field]) return { success: false, message: 'field must be hours, policies, or description.' };
    const content = String(input.content || '').trim();
    if (!content) return { success: false, message: 'content is required.' };
    const existing = await ctx.db.query(
      `SELECT id FROM knowledge WHERE user_id = $1 AND type = $2 ORDER BY id LIMIT 1`,
      [ctx.user.id, field]
    );
    if (existing.rows.length) {
      await ctx.db.query(
        `UPDATE knowledge SET title = $1, content = $2 WHERE id = $3 AND user_id = $4`,
        [FIELDS[field], content, existing.rows[0].id, ctx.user.id]
      );
    } else {
      await ctx.db.query(
        `INSERT INTO knowledge (user_id, title, type, content) VALUES ($1, $2, $3, $4)`,
        [ctx.user.id, FIELDS[field], field, content]
      );
    }
    return { success: true, data: { field }, message: `${FIELDS[field]} updated.`, summary: `Update ${FIELDS[field]}` };
  },
});
