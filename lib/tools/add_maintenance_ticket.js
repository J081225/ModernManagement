// lib/tools/add_maintenance_ticket.js
//
// maintenance_tickets schema: (user_id, title, description, unit,
//   resident, category, priority, status, outcome, requires_action,
//   action_notes, emergency_sms_sent, "createdAt", "updatedAt").
//   user_id-scoped.
//
// Side-effect parity with POST /api/maintenance:
//   - priority is set to 'emergency' if isEmergency() matches
//     a keyword in title+description, else 'normal'.
//   - Emergency tickets fire an SMS to MAINTENANCE_PHONE via
//     ctx.sms (Twilio). Emergency_sms_sent column flips true on success.
//   - The POST endpoint also calls suggestTasksFromConversation()
//     for AI-generated follow-up tasks. That helper lives inside
//     server.js and is not portable — we intentionally skip it
//     here. Users who create tickets via the UI still get follow-up
//     suggestions; AI-created tickets do not. Documented in the B3
//     completion report.
const registry = require('../tool-registry');

const EMERGENCY_KEYWORDS = [
  'gas leak','gas smell','flooding','flood','sewage','raw sewage',
  'fire','smoke','carbon monoxide','no heat','burst pipe','burst pipes',
  'broken window','shattered window','structural','collapse','roof collapse',
  'electrical fire','sparks','no water','water damage','major leak'
];

function isEmergency(text) {
  const lower = (text || '').toLowerCase();
  return EMERGENCY_KEYWORDS.some(k => lower.includes(k));
}

registry.register({
  name: 'add_maintenance_ticket',
  description: 'Create a maintenance ticket for a repair or issue at the property.',
  vertical: 'property-management',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Brief title of the issue.' },
      description: { type: 'string', description: 'Full description of the problem.' },
      unit: { type: 'string', description: 'Unit number where the issue is.' },
      resident: { type: 'string', description: 'Resident name reporting the issue.' },
      category: { type: 'string', enum: ['plumbing', 'electrical', 'hvac', 'appliance', 'structural', 'pest', 'general'], description: 'Issue category.' }
    },
    required: ['title']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'maintenance', focus: { type: 'newest_ticket' } },
  async execute(input, ctx) {
    const { title, description, unit, resident, category } = input;
    if (!title) {
      return { success: false, message: 'Missing required field: title.' };
    }
    const priority = isEmergency((title || '') + ' ' + (description || '')) ? 'emergency' : 'normal';
    const result = await ctx.db.query(
      `INSERT INTO maintenance_tickets (user_id, title, description, unit, resident, category, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ctx.user.id, title, description || '', unit || '', resident || '', category || 'general', priority]
    );
    const ticket = result.rows[0];

    // Fire emergency SMS to MAINTENANCE_PHONE if applicable. Mirrors
    // sendEmergencySMS() in server.js. Failures here are non-fatal —
    // the ticket is already created and the user is informed.
    let emergencySmsNote = '';
    if (priority === 'emergency') {
      const phone = ctx.env && ctx.env.MAINTENANCE_PHONE;
      if (!phone) {
        emergencySmsNote = ' (emergency: MAINTENANCE_PHONE not configured)';
      } else {
        try {
          const msg = `🚨 EMERGENCY MAINTENANCE — ${ticket.unit ? 'Unit ' + ticket.unit + ' · ' : ''}${ticket.title}. ${ticket.description ? String(ticket.description).slice(0, 100) : ''} Resident: ${ticket.resident || 'Unknown'}. Please respond immediately.`;
          await ctx.sms.messages.create({ from: ctx.env.TWILIO_PHONE_NUMBER, to: phone, body: msg });
          await ctx.db.query('UPDATE maintenance_tickets SET emergency_sms_sent=true WHERE id=$1', [ticket.id]);
          emergencySmsNote = ' (emergency SMS sent to maintenance contact)';
        } catch (err) {
          ctx.logger.error('[add_maintenance_ticket] Emergency SMS failed:', err.message);
          emergencySmsNote = ' (emergency SMS failed — check Twilio config)';
        }
      }
    }

    return {
      success: true,
      data: ticket,
      message: `Created maintenance ticket: "${title}"${unit ? ` (Unit ${unit})` : ''}${priority === 'emergency' ? emergencySmsNote : ''}`
    };
  }
});
