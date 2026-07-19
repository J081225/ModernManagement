// lib/appointment-engine.js
//
// Appointment-conversation orchestrator. Handles inbound SMS / email /
// voicemail for PS workspaces with appointment_auto_respond=true.
// Returns:
//   { handled: true,  outbound_text, thread_id, used_tools }
//   { handled: false, reason }
// When handled=false the caller should fall through to the existing
// inbound-message handlers (emergency detection, auto-reply, etc.).
//
// Schema reality:
//   - messages columns: (user_id, resident, subject, category, text, status,
//     folder, email, phone, "createdAt"). Outbound SMS uses category='sms',
//     status='sent', folder='inbox'.
//   - contacts is user_id-scoped — look up via workspaces.owner_user_id.
//   - knowledge is user_id-scoped — same lookup pattern.
//   - appointments / appointment_threads are workspace_id-scoped (E2).
//   - cal_events extended in E2 with workspace_id + starts_at + ends_at +
//     event_type.
//   - menu_items / inventory_items / vendors are workspace_id-scoped (E4).
//
// E4 enhancement (documented exception to "do not modify lib/"): the engine
// now ALSO loads menu_items into the system prompt so AI knows what services
// and products the workspace offers. This is the natural extension of the
// existing knowledge + calendar context pattern. Failure to load menu does
// NOT break the engine — we fall through with an empty list.
//
// Anthropic SDK note: server.js imports the SDK as
// `require('@anthropic-ai/sdk').default` (the v0.55 CommonJS interop
// quirk). Keep the same pattern here so we don't regress on the new
// surface.

const Anthropic = require('@anthropic-ai/sdk').default;
const { ANTHROPIC_MODEL } = require('./config');
const registry = require('./tool-registry');
const { phoneDigits10 } = require('./phone');
const { wsTz } = require('./time-helpers');

// CP6: add_calendar_event is deliberately ABSENT — it can create
// time_off blocks, which are owner-only. Customers book through
// book_appointment; they must never reach calendar-writing tools.
const APPOINTMENT_TOOL_NAMES = [
  'book_appointment',
  'update_appointment',
  'cancel_appointment',
  'propose_appointment_times',
  'escalate_appointment_to_owner',
  'add_task',
];

const MAX_THREAD_LINES = 12;

async function processInboundMessage({
  workspace, contact, customer_phone, customer_email, channel, body,
  db, twilio, sendgrid, env, logger,
}) {
  if (!workspace || workspace.vertical !== 'professional-services') {
    return { handled: false, reason: 'not_professional_services' };
  }
  if (!workspace.appointment_auto_respond) {
    return { handled: false, reason: 'auto_respond_disabled' };
  }
  if (!body || !String(body).trim()) {
    return { handled: false, reason: 'empty_body' };
  }

  let thread;
  try {
    thread = await findOrCreateThread({
      workspace, contact, customer_phone, customer_email, channel, db, logger,
    });
  } catch (err) {
    logger.error('[appointment-engine] thread lookup/create failed:', err.message);
    return { handled: false, reason: 'thread_failure' };
  }

  const knowledge = await loadKnowledge(workspace, db).catch((err) => {
    logger.error('[appointment-engine] knowledge load failed (continuing):', err.message);
    return [];
  });
  const callerAppointments = await loadCallerAppointments({ workspace, db, customer_phone, customer_email }).catch((err) => {
    logger.error('[appointment-engine] caller-appointments load failed (continuing):', err.message);
    return [];
  });
  // E4: load menu_items so AI knows what's offered. Best-effort; missing
  // menu just means the AI is more conservative about quoting prices/durations.
  const menu = await loadMenu(workspace, db).catch((err) => {
    logger.error('[appointment-engine] menu load failed (continuing):', err.message);
    return [];
  });

  const systemPrompt = buildSystemPrompt({ workspace, contact, knowledge, callerAppointments, menu, thread });
  const tools = buildToolListForEngine(workspace.vertical, workspace.plan);

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('[appointment-engine] ANTHROPIC_API_KEY missing — falling through');
    return { handled: false, reason: 'anthropic_unconfigured' };
  }

  const anthropic = new Anthropic({ apiKey });
  let aiResponse;
  try {
    aiResponse = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: [{ role: 'user', content: body }],
    });
  } catch (err) {
    logger.error('[appointment-engine] Anthropic call failed:', err.message);
    return { handled: false, reason: 'anthropic_error' };
  }

  const result = await executeAIResult({
    aiResponse, workspace, contact, thread, channel,
    customer_phone, customer_email, db, twilio, sendgrid, env, logger,
  });

  try {
    await updateThreadContext({ thread, body, aiResponse: result.outbound_text, db });
  } catch (err) {
    logger.error('[appointment-engine] thread context update failed (non-fatal):', err.message);
  }

  return {
    handled: true,
    outbound_text: result.outbound_text,
    thread_id: thread.id,
    used_tools: result.used_tools,
  };
}

async function findOrCreateThread({
  workspace, contact, customer_phone, customer_email, channel, db,
}) {
  const lookupKey = customer_phone || customer_email;
  if (!lookupKey) throw new Error('No customer_phone or customer_email');
  const lookupColumn = customer_phone ? 'customer_phone' : 'customer_email';

  // FD3-CP1: 'closed' threads are deliberately skipped here — that IS
  // the reopen behavior. A customer texting back after their
  // conversation ended (hangup, voicemail processed, or the 6-hour
  // inactivity sweep) is the same relationship starting a NEW
  // conversation: fresh thread, fresh context, same phone/email key.
  const existing = await db.query(
    `SELECT * FROM appointment_threads
      WHERE workspace_id = $1 AND ${lookupColumn} = $2
        AND state NOT IN ('closed', 'complete')
      ORDER BY id DESC LIMIT 1`,
    [workspace.id, lookupKey]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const inserted = await db.query(
    `INSERT INTO appointment_threads
       (workspace_id, contact_id, inbound_channel, customer_phone, customer_email, state)
     VALUES ($1, $2, $3, $4, $5, 'gathering') RETURNING *`,
    [workspace.id, contact ? contact.id : null, channel,
      customer_phone || null, customer_email || null]
  );
  return inserted.rows[0];
}

async function loadKnowledge(workspace, db) {
  const r = await db.query(
    `SELECT k.title, k.type, k.content
       FROM knowledge k
       JOIN workspaces w ON w.owner_user_id = k.user_id
      WHERE w.id = $1
      ORDER BY k."createdAt" DESC LIMIT 50`,
    [workspace.id]
  );
  return r.rows;
}

// FD2: the customer-facing prompt no longer lists the workspace-wide
// schedule (that leaked every booking's time and service to any texter).
// It lists the CALLER'S OWN upcoming appointments only — matched by the
// caller's phone (FD1 normalization) or email via their contact row,
// with a thread-phone fallback for pre-FD1 bookings. Availability
// questions flow through propose_appointment_times, which reads the
// full calendar server-side.
async function loadCallerAppointments({ workspace, db, customer_phone, customer_email }) {
  const digits = phoneDigits10(customer_phone);
  const email = customer_email ? String(customer_email) : null;
  if (!digits && !email) return [];
  const r = await db.query(
    `SELECT a.id, a.title, a.starts_at, a.duration_minutes, a.status
       FROM appointments a
      WHERE a.workspace_id = $1
        AND a.status IS DISTINCT FROM 'canceled'
        AND a.starts_at >= NOW()
        AND a.starts_at < NOW() + INTERVAL '60 days'
        AND (
          a.contact_id IN (
            SELECT c.id FROM contacts c
             WHERE c.user_id = $2
               AND (
                 ($3::text IS NOT NULL AND RIGHT(regexp_replace(c.phone, '\\D', '', 'g'), 10) = $3)
                 OR ($4::text IS NOT NULL AND LOWER(c.email) = LOWER($4))
               )
          )
          OR ($3::text IS NOT NULL AND a.id IN (
            SELECT t.appointment_id FROM appointment_threads t
             WHERE t.appointment_id IS NOT NULL
               AND RIGHT(regexp_replace(t.customer_phone, '\\D', '', 'g'), 10) = $3
          ))
        )
      ORDER BY a.starts_at ASC
      LIMIT 10`,
    [workspace.id, workspace.owner_user_id, digits, email]
  );
  return r.rows;
}

// E4: menu_items for the workspace. Active and non-archived only. Up to
// 200 items so the system prompt stays bounded for typical menus.
async function loadMenu(workspace, db) {
  const r = await db.query(
    `SELECT id, type, name, category, base_price_cents, duration_minutes,
            description, parent_menu_item_id, tax_behavior
       FROM menu_items
      WHERE workspace_id = $1
        AND active = TRUE
        AND archived_at IS NULL
      ORDER BY type ASC, category ASC, name ASC
      LIMIT 200`,
    [workspace.id]
  );
  return r.rows;
}

function buildSystemPrompt({ workspace, contact, knowledge, callerAppointments, menu, thread }) {
  const lines = [];
  const tz = wsTz(workspace);
  // Format helper for calendar events below — renders wall-clock times in
  // the business timezone so the AI reads and quotes correct local times.
  const fmtEventTime = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch (err) { return String(iso); }
  };
  lines.push(`You are the AI assistant for ${workspace.business_name || workspace.name}, a Professional Services business.`);
  lines.push(`A customer is contacting the business via ${thread.inbound_channel} about an appointment.`);
  lines.push(contact ? `The customer is on file as: ${contact.name}.` : 'The customer is not yet on file.');
  // Anchor the AI in the business's real time. Without these three lines
  // the model has no idea what timezone the business is in and defaults
  // to sending naive UTC-flavored times, which stores wrong.
  lines.push('');
  lines.push(`Business timezone: ${tz}.`);
  let nowInTz;
  try {
    nowInTz = new Date().toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch (err) { nowInTz = new Date().toISOString(); }
  lines.push(`Right now it is ${nowInTz}.`);
  lines.push('When calling tools, always pass appointment times as ISO 8601 WITH the timezone offset (e.g. 2026-07-15T09:30:00-04:00). Never pass a time without an offset.');
  lines.push('');
  lines.push('## Business knowledge (hours, services, policies)');
  if (knowledge.length === 0) {
    lines.push('(No knowledge base entries on file. Be conservative — gather information rather than asserting facts.)');
  } else {
    for (const k of knowledge) {
      const truncated = (k.content || '').slice(0, 800);
      lines.push(`- ${k.title}: ${truncated}`);
    }
  }
  lines.push('');
  lines.push('## Menu — what this business offers');
  if (!menu || menu.length === 0) {
    lines.push('(No menu items configured yet. The owner has not yet listed services or products.)');
  } else {
    const fmtPrice = (cents) => cents > 0 ? '$' + (cents / 100).toFixed(2) : 'price on request';
    const taxNote = (b) => b === 'included' ? 'tax included'
      : b === 'added' ? 'sales tax added'
      : null;
    const services = menu.filter(m => m.type === 'service');
    const products = menu.filter(m => m.type === 'product');
    const addons = menu.filter(m => m.type === 'addon');
    if (services.length) {
      lines.push('Services:');
      for (const s of services) {
        const dur = s.duration_minutes ? ` (${s.duration_minutes} min)` : '';
        const tax = taxNote(s.tax_behavior);
        lines.push(`- ${s.name}${dur}: ${fmtPrice(s.base_price_cents)}${tax ? ' — ' + tax : ''}${s.description ? ' — ' + s.description : ''}`);
      }
    }
    if (products.length) {
      lines.push('Products:');
      for (const p of products) {
        const tax = taxNote(p.tax_behavior);
        lines.push(`- ${p.name}: ${fmtPrice(p.base_price_cents)}${tax ? ' — ' + tax : ''}${p.description ? ' — ' + p.description : ''}`);
      }
    }
    if (addons.length) {
      const parentNames = {};
      for (const s of services) parentNames[s.id] = s.name;
      lines.push('Add-ons:');
      for (const a of addons) {
        const parent = parentNames[a.parent_menu_item_id] || `service #${a.parent_menu_item_id}`;
        lines.push(`- ${a.name} (parent: ${parent}): ${fmtPrice(a.base_price_cents)}${a.description ? ' — ' + a.description : ''}`);
      }
    }
    lines.push('Pricing on the menu is "starting from" — the actual amount on the receipt is set at completion based on what was actually done.');
  }
  lines.push('');
  // FD2: only the caller's own appointments appear here — never the
  // workspace-wide schedule. Ids are included so update/cancel target
  // the right appointment (the scope guard rejects any other id).
  lines.push("## This customer's upcoming appointments");
  if (callerAppointments.length === 0) {
    lines.push('(None on file for this phone/email.)');
  } else {
    for (const a of callerAppointments) {
      lines.push(`- Appointment #${a.id} [${a.status}] ${fmtEventTime(a.starts_at)} (${a.duration_minutes} min): ${a.title}`);
    }
  }
  lines.push("Never share other customers' bookings. To answer availability questions, or before agreeing to any specific time, check with propose_appointment_times.");
  lines.push('');
  lines.push('## Conversation context so far');
  lines.push(thread.context_summary || '(No prior context — this is the start.)');
  lines.push('');
  lines.push('## Your job');
  if (thread.inbound_channel === 'voice') {
    lines.push('');
    lines.push('## Phone call style (IMPORTANT — this is a live voice call)');
    lines.push('You are on a live phone call, so sound like a warm, friendly receptionist having a natural conversation. Keep every reply to one or two short sentences. Greet callers warmly and answer what they actually asked — do NOT recite the menu or list prices unless the caller specifically asks for them. If a caller mentions a general need (like "a haircut"), respond warmly and ask one short, friendly follow-up question to narrow it down, rather than listing all the options. Be personable and human; a caller should feel like they are talking to a kind person, not a directory.');
    lines.push('');
  }
  lines.push('- Help the customer book, change, or cancel an appointment.');
  lines.push('- If they ask for a service or product, check the business knowledge first.');
  lines.push('- If something is not on the menu or you cannot fulfill it, offer alternatives. Do NOT promise things you cannot verify.');
  lines.push('- If the customer asks for a callback, use add_task to create a "call back this customer" task.');
  lines.push('- Use propose_appointment_times to suggest concrete times that do not conflict with the calendar.');
  lines.push('- Use book_appointment ONLY when you have BOTH service details AND a confirmed time. Set source to match the channel.');
  // FD1: collect a name from unrecognized customers, exactly once.
  if (contact && contact.name) {
    lines.push(`- The customer is ${contact.name}, a known contact. Do NOT ask for their name.`);
  } else {
    lines.push('- If the customer has not given their name in this conversation, ask for it before finalizing a booking ("Can I get your name for the appointment?"). Ask only once — never re-ask a name you already have.');
  }
  lines.push('- Use escalate_appointment_to_owner for non-routine, ambiguous, or low-confidence cases.');
  lines.push('- Be concise. Two or three sentences max per response.');

  // Owner-configured personality — read from workspaces.ai_tone and
  // workspaces.ai_sales_posture. Fire independent of channel so voice
  // AND text messages inherit the same personality. When either field
  // is null/unset the block is skipped; existing workspaces without
  // these preferences see the exact same prompt as before.
  if (workspace.ai_tone === 'warm') {
    lines.push('');
    lines.push('## Tone');
    lines.push("Speak warmly and personally, like a friendly local receptionist. Be personable and use the customer's name when you know it.");
  } else if (workspace.ai_tone === 'professional') {
    lines.push('');
    lines.push('## Tone');
    lines.push('Speak in a polished, professional manner — courteous, clear, and precise. Avoid slang.');
  } else if (workspace.ai_tone === 'brief') {
    lines.push('');
    lines.push('## Tone');
    lines.push('Keep replies short and efficient with minimal small talk, while staying polite and helpful.');
  }

  if (workspace.ai_sales_posture === 'reactive') {
    lines.push('');
    lines.push('## Sales approach');
    lines.push('Focus on what the customer asks for. Only mention add-ons or extra services if directly relevant. Never be pushy.');
  } else if (workspace.ai_sales_posture === 'proactive') {
    lines.push('');
    lines.push('## Sales approach');
    lines.push('When it fits naturally, gently suggest ONE relevant add-on or complementary service or product (for example, a beard trim alongside a haircut). Keep it light and never pushy.');
  }

  return lines.join('\n');
}

function buildToolListForEngine(vertical, plan) {
  const allowed = registry.getToolsForPlan(vertical, plan);
  return allowed
    .filter((t) => APPOINTMENT_TOOL_NAMES.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

async function executeAIResult({
  aiResponse, workspace, contact, thread, channel,
  customer_phone, customer_email, db, twilio, sendgrid, env, logger,
}) {
  const used_tools = [];
  let outbound_text = '';

  for (const block of (aiResponse.content || [])) {
    if (block.type === 'text') {
      outbound_text += (outbound_text ? '\n' : '') + block.text;
    } else if (block.type === 'tool_use') {
      const tool = registry.getTool(block.name);
      if (!tool) {
        logger.error('[appointment-engine] Unknown tool requested:', block.name);
        continue;
      }
      // FD2 (§4.5.3): this engine has no approval queue. If a future
      // allowlist addition carries requiresApproval, refuse rather than
      // silently executing an approval-gated action from a customer chat.
      if (tool.requiresApproval) {
        logger.error('[appointment-engine] Approval-gated tool blocked in customer engine:', tool.name);
        used_tools.push({ name: tool.name, success: false, message: 'requires owner approval' });
        continue;
      }
      const ctx = {
        user: { id: workspace.owner_user_id },
        workspace,
        db,
        sms: twilio,
        sendgrid,
        env,
        logger,
        // FD1: the channel's customer identity rides into every tool so
        // bookings can link (or create) the right contact. This was the
        // exact point the caller's number used to be dropped.
        customer_phone: customer_phone || null,
        customer_email: customer_email || null,
        origin: {
          channel: 'ai_inbound',
          appointment_thread_id: thread.id,
          contact_id: contact ? contact.id : null,
        },
      };
      try {
        const r = await tool.execute(block.input, ctx);
        used_tools.push({ name: tool.name, success: !!r.success, message: r.message });
        if (r.message && !outbound_text.includes(r.message)) {
          outbound_text += (outbound_text ? '\n' : '') + r.message;
        }
      } catch (err) {
        logger.error(`[appointment-engine] Tool ${tool.name} threw:`, err.message);
        used_tools.push({ name: tool.name, success: false, message: err.message });
      }
    }
  }

  // Voice calls skip auto-send: on a live phone call the reply is spoken
  // by the /twilio-relay ConversationRelay WebSocket handler, so texting
  // or emailing the caller mid-call would be wrong. Other channels
  // ('sms', 'email', 'voicemail') keep sending exactly as before.
  if (outbound_text && customer_phone && channel !== 'voice') {
    try {
      await twilio.messages.create({
        from: workspace.twilio_phone_number || env.TWILIO_PHONE_NUMBER,
        to: customer_phone,
        body: outbound_text,
      });
      try {
        await db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
           VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)`,
          [
            workspace.owner_user_id,
            contact ? contact.name : (customer_phone || 'unknown'),
            `SMS to ${contact ? contact.name : customer_phone}`,
            outbound_text,
            customer_phone,
          ]
        );
      } catch (err) {
        logger.error('[appointment-engine] persist outbound failed (still sent):', err.message);
      }
    } catch (err) {
      logger.error('[appointment-engine] Twilio send failed:', err.message);
    }
  } else if (outbound_text && customer_email && channel !== 'voice') {
    try {
      await sendgrid.send({
        to: customer_email,
        from: env.SENDGRID_FROM_EMAIL,
        subject: `Re: your message to ${workspace.business_name || workspace.name}`,
        text: outbound_text,
      });
    } catch (err) {
      logger.error('[appointment-engine] SendGrid send failed:', err.message);
    }
  }

  return { outbound_text, used_tools };
}

async function updateThreadContext({ thread, body, aiResponse, db }) {
  const newLine = `Customer: ${(body || '').slice(0, 120)} | AI: ${(aiResponse || '').slice(0, 120)}`;
  const existing = thread.context_summary || '';
  const lines = existing.split('\n').filter(Boolean);
  lines.push(newLine);
  while (lines.length > MAX_THREAD_LINES) lines.shift();

  await db.query(
    `UPDATE appointment_threads
        SET context_summary = $1,
            last_customer_message_at = NOW(),
            last_ai_message_at = NOW(),
            message_count = message_count + 1,
            updated_at = NOW()
      WHERE id = $2`,
    [lines.join('\n'), thread.id]
  );
}

module.exports = { processInboundMessage };
