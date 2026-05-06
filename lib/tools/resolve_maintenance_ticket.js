// lib/tools/resolve_maintenance_ticket.js
//
// Opinionated alternative to update_maintenance_ticket: sets status to
// 'resolved' and appends a timestamped resolution note to the ticket's
// `action_notes` column (the actual notes column on this legacy table).
// user_id-scoped to match the rest of maintenance_tickets.
const registry = require('../tool-registry');

registry.register({
  name: 'resolve_maintenance_ticket',
  description: "Mark a maintenance ticket as resolved (closed). Optionally include a resolution note describing how the issue was fixed — the note is appended to the ticket's existing notes with a timestamp. Use this tool when the user wants to close out a completed ticket; for non-closure status changes (open, in_progress, on_hold), use update_maintenance_ticket instead.",
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      ticket: { type: 'string', description: 'Title or partial title identifying the ticket to resolve.' },
      resolution_notes: { type: 'string', description: "Optional. A note describing how the issue was resolved (e.g., \"Replaced washer in kitchen faucet\"). If provided, appended to the ticket's notes field." }
    },
    required: ['ticket']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { ticket, resolution_notes } = input;
    if (!ticket) {
      return { success: false, message: 'No ticket identifier provided.' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM maintenance_tickets
       WHERE user_id = $1 AND LOWER(title) LIKE $2 AND status != 'resolved'
       ORDER BY "createdAt" DESC LIMIT 5`,
      [ctx.user.id, `%${ticket.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No active (unresolved) maintenance ticket found matching "${ticket}".` };
    }
    const target = matches.rows[0];

    // Compose updated notes — append resolution to existing action_notes
    // if both exist. action_notes is the actual column name on this table.
    let newNotes = target.action_notes || null;
    if (resolution_notes && resolution_notes.trim()) {
      const stamp = `[Resolved ${new Date().toISOString().slice(0, 10)}] ${resolution_notes.trim()}`;
      newNotes = newNotes ? `${newNotes}\n\n${stamp}` : stamp;
    }

    const result = await ctx.db.query(
      `UPDATE maintenance_tickets
         SET status = 'resolved', action_notes = $1, "updatedAt" = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [newNotes, target.id, ctx.user.id]
    );

    const more = matches.rows.length > 1
      ? ` (matched ${matches.rows.length} active tickets; resolved "${target.title}")`
      : '';
    return {
      success: true,
      data: result.rows[0],
      message: resolution_notes
        ? `Resolved ticket "${target.title}" — ${resolution_notes}${more}`
        : `Resolved ticket "${target.title}"${more}`
    };
  }
});
