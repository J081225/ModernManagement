// lib/tools/update_maintenance_ticket.js
//
// maintenance_tickets is user_id-scoped (legacy table). The DB column is
// `action_notes` (not `notes`); the AI tool's `notes` input is mapped to
// `action_notes` for clarity. Other quoted-camelCase columns: "createdAt",
// "updatedAt". The "updatedAt" column is bumped on every change.
const registry = require('../tool-registry');

registry.register({
  name: 'update_maintenance_ticket',
  description: 'Update an existing maintenance ticket — change its status (open / in_progress / on_hold / resolved / cancelled), update title / description / notes, or change the unit and resident assignment. The user identifies the ticket by its title; fuzzy matching is done against the maintenance list in context. Use this tool when the user wants to modify an open ticket without resolving it. For resolving (closing out) a ticket with a resolution note, use resolve_maintenance_ticket instead.',
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      ticket: { type: 'string', description: 'Title or partial title identifying the ticket. Use fuzzy matching against the maintenance list in context.' },
      status: { type: 'string', enum: ['open', 'in_progress', 'on_hold', 'resolved', 'cancelled'], description: 'Optional. New status for the ticket.' },
      title: { type: 'string', description: 'Optional. New title.' },
      description: { type: 'string', description: 'Optional. New description (replaces existing).' },
      unit: { type: 'string', description: 'Optional. New unit assignment.' },
      resident: { type: 'string', description: 'Optional. New resident.' },
      category: { type: 'string', description: 'Optional. New category.' },
      notes: { type: 'string', description: 'Optional. New notes (replaces existing).' }
    },
    required: ['ticket']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { ticket } = input;
    if (!ticket) {
      return { success: false, message: 'No ticket identifier provided.' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM maintenance_tickets
       WHERE user_id = $1 AND LOWER(title) LIKE $2
       ORDER BY "createdAt" DESC LIMIT 5`,
      [ctx.user.id, `%${ticket.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No maintenance ticket found matching "${ticket}".` };
    }
    const target = matches.rows[0];

    // Map AI input field names → DB columns. The AI uses `notes` for
    // clarity; the actual column is `action_notes`.
    const fieldMap = [
      { input: 'status', column: 'status' },
      { input: 'title', column: 'title' },
      { input: 'description', column: 'description' },
      { input: 'unit', column: 'unit' },
      { input: 'resident', column: 'resident' },
      { input: 'category', column: 'category' },
      { input: 'notes', column: 'action_notes' }
    ];
    const updates = [];
    const params = [];
    let i = 1;
    for (const { input: inputKey, column } of fieldMap) {
      if (input[inputKey] !== undefined) {
        updates.push(`${column} = $${i++}`);
        params.push(input[inputKey]);
      }
    }
    if (updates.length === 0) {
      return { success: false, message: `Found ticket "${target.title}" but no fields to update were specified.` };
    }
    updates.push('"updatedAt" = NOW()');
    params.push(target.id, ctx.user.id);
    const result = await ctx.db.query(
      `UPDATE maintenance_tickets SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i++} RETURNING *`,
      params
    );
    const fields = fieldMap
      .filter(f => input[f.input] !== undefined)
      .map(f => f.input)
      .join(', ');
    const more = matches.rows.length > 1
      ? ` (matched ${matches.rows.length} tickets; updated "${target.title}")`
      : '';
    return {
      success: true,
      data: result.rows[0],
      message: `Updated ticket "${target.title}": ${fields}${more}`
    };
  }
});
