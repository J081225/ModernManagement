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
const { resolveCallerContact } = require('./customer-scope');
const { decideAutonomyAction, categoryFor } = require('./autonomy');
const { sendOwnerAlert } = require('./owner-alert');
const { wsTz, promptTimeAnchor } = require('./time-helpers');
// SP4b: customer sends leave from the workspace's own number or hold.
const { customerSmsFrom } = require('./workspace-readiness');

// CP6: add_calendar_event is deliberately ABSENT — it can create
// time_off blocks, which are owner-only. Customers book through
// book_appointment; they must never reach calendar-writing tools.
const APPOINTMENT_TOOL_NAMES = [
  // LS: mid-call spoken language switch — offered on the voice channel
  // only (filtered in processInboundMessage); explicit request only.
  'switch_language',
  'book_appointment',
  'update_appointment',
  'cancel_appointment',
  'propose_appointment_times',
  'escalate_appointment_to_owner',
  'add_task',
  // FD3-CP5: day-of notes on the caller's OWN today appointment
  // (ai_inbound-scoped inside the tool, FD2 pattern).
  'append_appointment_note',
];

const MAX_THREAD_LINES = 12;

async function processInboundMessage({
  workspace, contact, customer_phone, customer_email, channel, body,
  db, twilio, sendgrid, env, logger,
  // LS: relay-closure hook for the mid-call spoken language switch
  // (voice only; null on every other channel).
  onLanguageSwitch = null,
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

  // FD3-CP2: resolve the caller to a contact ONCE, here, for every
  // channel. All three routes pass contact: null (investigation §1
  // delta table: "Contact param — null … parity, both dead"), which
  // left the known-customer prompt branches — "The customer is on
  // file as: {name}" and FD1's "do NOT ask for their name" — dead in
  // practice. Resolving before findOrCreateThread also stamps
  // contact_id on newly created threads. One resolution, one brain.
  if (!contact) {
    try {
      contact = await resolveCallerContact({ db, workspace, customer_phone, customer_email });
    } catch (err) {
      logger.error('[appointment-engine] caller resolve failed (continuing unknown):', err.message);
    }
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

  // IB4: the per-thread driver check — the ONE choke point, directly
  // after the thread exists and before any model work. Precedence:
  // global auto_respond gated above (line ~66); a paused thread makes
  // the AI silent HERE. Boundary: async channels only — a live
  // ConversationRelay call remains AI-answered (there is no human
  // alternative mid-call; the global switch owns the phone line).
  // Pausing the AI's VOICE must not blind the system's EYES: the
  // inbound row was already persisted by the route, the customer's
  // line still enters the thread context (so the owner's panel and
  // reflection read a complete conversation), the idle clock still
  // ticks toward close, and handled:true stops the route's legacy
  // auto-reply from becoming a second AI voice.
  if (thread.ai_paused === true && channel !== 'voice') {
    try {
      await updateThreadContext({
        thread, body,
        aiResponse: '(no reply — the owner is handling this conversation)',
        db,
      });
    } catch (err) {
      logger.error('[appointment-engine] paused-thread context write failed:', err.message);
    }
    return { handled: true, reason: 'ai_paused', thread_id: thread.id, paused: true };
  }

  // B3 (AI-scope): turn-counted topic redirect — structural, not
  // prompt-only. A turn is BUSINESS if the message carries a
  // booking/hours/price/payment signal (regex below) or the reply ends
  // up using a tool (checked post-generation). Consecutive non-business
  // turns: 4 → one warm redirect directive; 6 → canned polite close,
  // no model call at all.
  const BUSINESS_INTENT_RE = /\b(book|booking|booked|appointment|appt|reschedule|cancel|confirm|hours|open|opening|closed?|price|prices|pricing|cost|how much|pay|payment|deposit|invoice|receipt|refund|service|services|available|availability|slot|time|today|tomorrow|week|weekend|walk.?ins?|haircut|trim|color|shave|fade|beard|nails?|manicure|massage|appointment)\b/i;
  const _isBusinessTurn = BUSINESS_INTENT_RE.test(String(body));
  let offTopicTurns = _isBusinessTurn ? 0 : (thread.off_topic_turns || 0) + 1;

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

  const systemPrompt = buildSystemPrompt({ workspace, contact, knowledge, callerAppointments, menu, thread, channel });
  // LS: switch_language exists for LIVE VOICE only — a text thread has no
  // session to switch (the customer just writes in the other language
  // and the language contract follows them).
  const tools = buildToolListForEngine(workspace.vertical, workspace.plan)
    .filter((t) => channel === 'voice' || t.name !== 'switch_language');

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('[appointment-engine] ANTHROPIC_API_KEY missing — falling through');
    return { handled: false, reason: 'anthropic_unconfigured' };
  }

  const anthropic = new Anthropic({ apiKey });
  let aiResponse;
  let closeConversation = false;
  if (offTopicTurns >= 6) {
    // B3: sixth consecutive off-topic turn — the canned close, declared
    // variants in the CONVERSATION's language, zero model cost. The
    // fabricated single-text-block response rides the normal
    // executeAIResult path so every send-layer gate (opt-out, demo)
    // still applies.
    const { customerString } = require('./customer-strings');
    const closeLang = thread.language || workspace.customer_language || 'en';
    aiResponse = { content: [{ type: 'text', text: customerString(closeLang, 'off_topic_close', { businessName: workspace.business_name || workspace.name || 'the business' }) }] };
    closeConversation = true;
    logger.error('[appointment-engine] OFF-TOPIC CLOSE (turn ' + offTopicTurns + ') thread=' + thread.id + ' ws=' + workspace.id);
  } else {
    // B3: fourth consecutive off-topic turn — one warm redirect, said in
    // THIS reply, never scolding.
    const redirectDirective = offTopicTurns === 4
      ? '\n\n## Redirect now\nThis conversation has drifted away from business topics for several turns. In THIS reply: one warm sentence acknowledging the customer, then gently steer back to appointments, services, hours, or anything else about the business. Kind, never scolding. If they continue off-topic after this, you will offer to take a message and wrap up.'
      : '';
    try {
      aiResponse = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt + redirectDirective,
        tools,
        messages: [{ role: 'user', content: body }],
      });
    } catch (err) {
      logger.error('[appointment-engine] Anthropic call failed:', err.message);
      return { handled: false, reason: 'anthropic_error' };
    }
  }

  const result = await executeAIResult({
    aiResponse, workspace, contact, thread, channel, body,
    customer_phone, customer_email, db, twilio, sendgrid, env, logger,
    onLanguageSwitch,
  });
  // B3: a tool call IS business intent — reset; the close resets too so
  // a customer who returns tomorrow starts clean. Persist best-effort.
  try {
    const usedTool = Array.isArray(aiResponse.content) && aiResponse.content.some((b) => b.type === 'tool_use');
    const finalTurns = (usedTool || closeConversation) ? 0 : offTopicTurns;
    if (finalTurns !== (thread.off_topic_turns || 0)) {
      await db.query('UPDATE appointment_threads SET off_topic_turns = $1 WHERE id = $2', [finalTurns, thread.id]);
    }
  } catch (err) {
    logger.error('[appointment-engine] off-topic counter persist failed:', err.message);
  }
  if (closeConversation) result.close_conversation = true;

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
  if (existing.rows.length > 0) {
    // LANG unit 3: a DTMF-pinned session language moves the CONVERSATION
    // to that language — receipts and links for this customer follow.
    const pin = workspace._session_language;
    if (pin && existing.rows[0].language !== pin) {
      try {
        const upd = await db.query(
          'UPDATE appointment_threads SET language = $1 WHERE id = $2 RETURNING *',
          [pin, existing.rows[0].id]
        );
        if (upd.rows[0]) return upd.rows[0];
      } catch (err) { /* keep the thread; language stamp is best-effort */ }
    }
    return existing.rows[0];
  }

  // IB4: driver state is STICKY across reopens. A new thread for a
  // customer whose most recent conversation was owner-handled inherits
  // the pause — "if the owner took a conversation over, a follow-up
  // week later is still theirs" — until the owner taps Let-AI-resume.
  // Best-effort: an inheritance lookup failure means a fresh false.
  let inherit = { ai_paused: false, paused_at: null, paused_by: null };
  try {
    const prior = await db.query(
      `SELECT ai_paused, paused_at, paused_by FROM appointment_threads
        WHERE workspace_id = $1 AND ${lookupColumn} = $2
        ORDER BY id DESC LIMIT 1`,
      [workspace.id, lookupKey]
    );
    if (prior.rows[0] && prior.rows[0].ai_paused === true) inherit = prior.rows[0];
  } catch (err) { /* fresh thread defaults apply */ }

  const inserted = await db.query(
    `INSERT INTO appointment_threads
       (workspace_id, contact_id, inbound_channel, customer_phone, customer_email, state, ai_paused, paused_at, paused_by, language)
     VALUES ($1, $2, $3, $4, $5, 'gathering', $6, $7, $8, $9) RETURNING *`,
    [workspace.id, contact ? contact.id : null, channel,
      customer_phone || null, customer_email || null,
      inherit.ai_paused === true, inherit.paused_at, inherit.paused_by,
      // LANG unit 3: the conversation's language at birth — the session
      // pin (voice menu) when present, else the workspace primary.
      workspace._session_language || workspace.customer_language || 'en']
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

function buildSystemPrompt({ workspace, contact, knowledge, callerAppointments, menu, thread, channel }) {
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
  // MR1: rebrand keeps the factual AI identification — the Manager is
  // automated, says so in the greeting, and answers "are you a robot?"
  // with a plain yes. Never claims to be human.
  lines.push(`You are the automated manager for ${workspace.business_name || workspace.name}, a Professional Services business.`);
  lines.push('If anyone asks whether they are talking to an AI, a bot, or a human, say plainly that you are an automated AI manager — never claim to be human.');
  lines.push(`A customer is contacting the business via ${channel || thread.inbound_channel} about an appointment.`);
  // FD3-CP2: FD1-created placeholder contacts ("Caller +1 ...") are a
  // known NUMBER, not a known NAME — greet as returning, still ask.
  const contactHasRealName = !!(contact && contact.name && !String(contact.name).startsWith('Caller '));
  if (contactHasRealName) {
    lines.push(`The customer is on file as: ${contact.name}.`);
  } else if (contact) {
    lines.push('The customer has contacted the business before, but we do not have their name on file yet.');
  } else {
    lines.push('The customer is not yet on file.');
  }
  // Anchor the AI in the business's real time. Without these three lines
  // the model has no idea what timezone the business is in and defaults
  // to sending naive UTC-flavored times, which stores wrong.
  lines.push('');
  // FD3-CP2: shared anchor — one implementation, two brains.
  const anchor = promptTimeAnchor(workspace);
  lines.push(`Business timezone: ${anchor.tz}.`);
  lines.push(`Right now it is ${anchor.nowInTz}.`);
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
  lines.push("Never share other customers' bookings. To answer availability questions, or before agreeing to a time you have NOT offered in this conversation, check with propose_appointment_times.");
  lines.push('');
  lines.push('## Conversation context so far');
  lines.push(thread.context_summary || '(No prior context — this is the start.)');
  lines.push('');
  lines.push('## Your job');
  lines.push('- Help the customer book, change, or cancel an appointment.');
  lines.push('- If they ask for a service or product, check the business knowledge first.');
  lines.push('- If something is not on the menu or you cannot fulfill it, offer alternatives. Do NOT promise things you cannot verify.');
  lines.push('- Use propose_appointment_times to suggest concrete times that do not conflict with the calendar.');
  lines.push('- Use book_appointment ONLY when you have BOTH service details AND a confirmed time. Set source to match the channel.');
  // FD1: collect a name from unrecognized customers, exactly once.
  // FD3-CP2: placeholder-named contacts ("Caller +1 ...") count as
  // unnamed — known number, unknown name — so the ask-once rule fires.
  if (contactHasRealName) {
    lines.push(`- The customer is ${contact.name}, a known contact. Do NOT ask for their name.`);
  } else {
    lines.push('- If the customer has not given their name in this conversation, ask for it before finalizing a booking ("Can I get your name for the appointment?"). Ask only once — never re-ask a name you already have.');
  }
  lines.push('- Use escalate_appointment_to_owner for non-routine, ambiguous, or low-confidence cases.');
  lines.push('- Be concise. Two or three sentences max per response.');

  // FD3-CP5: the conversation playbook — the table's rows as terse
  // behavioral rules (trigger → job → exit), one per situation. ONE
  // playbook for every channel; the channel-style block below changes
  // delivery, never behavior. Source of truth for the rows:
  // docs/conversation-playbook.md; regression sheet: playbook-tests.md.
  lines.push('');
  lines.push('## Conversation playbook');
  lines.push('Recognize the situation, do the job, land the exit:');
  lines.push('- BOOKING: they want an appointment -> confirm service and time (for a time you have not offered this conversation, check propose_appointment_times first), get a name if unknown -> book_appointment. Exit: booked or sent for confirmation, stated plainly.');
  lines.push('- CHANGE/CANCEL: about their own appointment -> confirm which one, then reschedule (time only) or cancel. Exit: the change confirmed back in one sentence.');
  lines.push('- AVAILABILITY: "are you open/free..." -> propose_appointment_times, offer 2-3 concrete slots. Never guess times, never read the calendar aloud. Exit: concrete options offered.');
  lines.push('- If the customer states a time window (e.g. "between 5 and 7 PM", "after 4"), pass it to propose_appointment_times as window_start/window_end. If the returned slots do not satisfy the stated window, say so plainly and offer the nearest alternatives — never present non-matching times as if they answer the request.');
  lines.push('- When the customer picks a time you ALREADY offered in this conversation, call book_appointment DIRECTLY — no availability re-check, no narrated verification. book_appointment refuses with "slot_taken" if the time was just taken; then apologize briefly and offer the nearest open times.');
  lines.push('- For a multi-day ask ("sometime this week", "between the 1st and the 4th"), pass start_date and end_date to propose_appointment_times (up to 7 days) — NEVER answer with one day as if it covered the range. To check one exact time you did not offer, pass window_start equal to window_end.');
  lines.push('- MINIMAL-ASK: name + time + service (or this business\'s most standard service as a sensible default) is ENOUGH to book. Ask at most ONE clarifying question per booking; put any remaining detail (variant, add-ons, preferences) into book_appointment\'s open_question field — the owner follows up. Do not keep asking the customer.');
  lines.push('- Confirm EXACTLY ONCE before booking, in exactly this shape: "I\'m verifying you want [service] at [time] on [date] — correct?" On yes, call book_appointment immediately, then give ONE short line confirming the booking. Never narrate availability checks, tool use, or internal process ("let me check that slot", "I need to make sure") — just do it.');
  lines.push('- PRICES/SERVICES: answer ONLY from the menu and business knowledge above. Not listed -> say so honestly and offer the closest real alternative. Exit: honest answer, no invented prices.');
  lines.push('- DAY-OF LOGISTICS: "running late" / "on my way" about today -> acknowledge warmly and append_appointment_note so it lands on their appointment (falls back to add_task if they have no appointment today). Exit: "I\'ve let them know - see you soon."');
  lines.push('- COMPLAINT: unhappy about service, staff, or an experience -> empathize and take it seriously. NEVER argue. NEVER promise refunds, discounts, or compensation - you do not have that authority. Say honestly: "I\'ll make sure the owner sees this today", then escalate_appointment_to_owner with kind "complaint" and the reason. Exit: escalated; do not re-litigate.');
  lines.push('- UNKNOWN QUESTION: not answerable from the knowledge above -> say so honestly and promise a follow-up ("I\'ll find out and someone will get back to you"), then escalate_appointment_to_owner with kind "question". NEVER bluff or invent an answer. Exit: follow-up promised and escalated.');
  lines.push('- VENDOR/WRONG NUMBER/SPAM: not a customer -> brief and polite, then disengage. Use NO tools. Exit: a short goodbye, nothing created.');
  lines.push('- EMERGENCY: danger, injury, fire, flood -> stay calm. If anyone is in physical danger, tell them to call 911 first. Reassure them the owner is being alerted right now (the alert fires automatically). Exit: calm handoff, no booking talk.');
  lines.push('- CALLBACK: they ask for a call back -> add_task ("Call back {name or number}"). Exit: the promise made and on the task list.');

  // FD3-CP5: style keyed off the LIVE channel. Investigation FD3.5
  // flagged the old block keying off thread.inbound_channel — a voice
  // call continuing an SMS-created thread spoke in text style. Delivery
  // only; the playbook above is identical on every channel.
  lines.push('');
  const liveChannel = channel || thread.inbound_channel;
  if (liveChannel === 'email') {
    // IB5: email's longer form is INTENTIONAL per-channel style —
    // same playbook, same brain, fuller register.
    lines.push('## Channel style (email)');
    lines.push('You are replying by email, so write like a warm, professional front-desk email: full sentences, a brief greeting, and a one-line sign-off with the business name. A short paragraph or two at most — email tolerates more than a text, but nobody wants an essay. Ask at most ONE question, and make any proposed times easy to scan.');
  } else if (liveChannel === 'voice') {
    lines.push('## Channel style (live phone call)');
    lines.push('You are on a live phone call, so sound like a warm, friendly receptionist having a natural conversation. Keep every reply to one or two SHORT sentences and ask at most ONE question per turn. Greet callers warmly and answer what they actually asked — do NOT recite the menu or list prices unless the caller specifically asks for them. If a caller mentions a general need (like "a haircut"), respond warmly and ask one short, friendly follow-up question to narrow it down, rather than listing all the options. Be personable and human; a caller should feel like they are talking to a kind person, not a directory.');
  } else {
    lines.push('## Channel style (text message)');
    lines.push('Keep it compact and friendly — a couple of short sentences, at most one question per message. No bullet lists, no headers; write like a person texting from the front desk.');
  }
  lines.push('The playbook applies on every channel — style changes, behavior does not.');

  // B2 (AI-scope hardening): the scope contract. Sarah is a receptionist,
  // never a counselor — warmth without therapy, and crisis language gets
  // a minimal, kind reply while the structural keyword gate (server-side
  // detectEmergency on every channel) alerts the owner.
  lines.push('');
  lines.push('## Scope');
  lines.push('You are this business\'s receptionist — bookings, services, hours, prices, payments, and messages for the owner. You are not a general assistant, advisor, or counselor.');
  lines.push('If a customer shares something emotional or personal, respond with ONE brief, warm sentence of acknowledgment — never advice, never counseling, never follow-up questions about it — then gently return to how you can help with the business.');
  lines.push('If a customer expresses intent to harm themselves or someone else, do not continue the conversation or attempt to help with it yourself: reply with one short, kind sentence encouraging them to reach someone who can help right now (in the US, call or text 988), and let them know the owner will see their message. Nothing else.');

  // R1 STRICT-DOMAIN (voice only — replaces the mishear-suspicion
  // framing after the gin-and-tonic call): out-of-domain
  // interpretations are NEVER concluded, named, or denied on voice —
  // no matter how clear or how often repeated. Only the two ruled
  // clarification lines exist. B2's honest scope answer survives ONLY
  // for plausible business-adjacent services. Text channels carry the
  // customer's exact words; none of this applies there.
  if ((channel || thread.inbound_channel) === 'voice') {
    lines.push('');
    lines.push('## Voice transcription — strict domain');
    lines.push('The customer\'s words arrive through automatic speech transcription, which makes errors. ABSOLUTE RULE: NEVER conclude the caller wants something outside this business\'s services. NEVER name, repeat, or paraphrase an out-of-domain interpretation. NEVER say "we don\'t do X" or "we don\'t serve X" for out-of-domain X — no matter how clearly it was transcribed or how many times it repeats.');
    lines.push('When an utterance seems out-of-domain or nonsensical, your ONLY two moves are — first time: "I\'m sorry — could you repeat that?" If confusion repeats: "I may be getting what you\'re saying confused — if you could speak a little more clearly, that would help."');
    lines.push('FORBIDDEN example — caller: "I\'d like a gin and tonic." You: "We do haircuts, not drinks." NEVER do this. CORRECT — you: "I\'m sorry — could you repeat that?"');
    lines.push('A plausible request for a business-adjacent service you simply do not offer is DIFFERENT: give the honest scope answer per the rules above. When uncertain which case applies, ask to repeat rather than guess.');
  }

  // ST5a: the language contract — ALWAYS injected (explicit English
  // beats implicit drift), default-and-follow per the ruling: greet
  // and reply in the workspace's customer language; if the customer
  // writes in a different language, follow the customer.
  lines.push('');
  // ST7a language contract, ordered by dominance (the E3 eval caught
  // "default" beating "follow" — a customer writing English got an
  // Arabic reply with an English tail). The customer's message
  // language is PRIMARY; the workspace default only breaks ties.
  const langName = workspace.customer_language === 'es' ? 'Spanish'
    : workspace.customer_language === 'ar' ? 'Arabic' : 'English';
  lines.push('## Language');
  lines.push('Always reply in the language the customer\'s message is written in — this rule outranks the default below. Never mix languages in one reply.');
  lines.push(`Default to ${langName} only when the customer's language is ambiguous (a very short or mixed-language message) or when you are writing first.`);
  if (workspace.customer_language === 'ar') {
    // ST7a: the ST6 register ruling — MSA for formal/written content,
    // dialect-mirroring in conversation (forcing MSA in chat reads
    // stiffer than what the model does naturally). The feminine
    // register line answers the observed آسف/آسفة slip.
    lines.push('When replying in Arabic: match the customer\'s register — mirror their dialect in conversation, and use clear Modern Standard Arabic for formal or written content (prices, confirmations, receipts). You are female — use feminine first-person forms (e.g. آسفة, سعيدة). Always quote exact menu prices when asked.');
  }

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
  aiResponse, workspace, contact, thread, channel, body,
  customer_phone, customer_email, db, twilio, sendgrid, env, logger,
  onLanguageSwitch = null,
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
      // FD3-CP3: the autonomy matrix choke point — customer brain only
      // (/api/command is never gated by this). Refines FD2's §4.5.3
      // hard-refusal: approval-gated or approve-mode actions now QUEUE
      // to pending_actions instead of refusing. Queuing is not
      // executing — the only path from the queue to execution is the
      // owner's authenticated approve endpoint, so FD2's security
      // property ("a customer conversation can never EXECUTE an
      // approval-gated action") holds unchanged.
      const decision = decideAutonomyAction(workspace, tool);
      if (decision === 'decline') {
        // 'off': polite no + take a message (the CP2 honesty pattern).
        try {
          await db.query(
            `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
             VALUES ($1, $2, 'other', $3, $4, true, $5)`,
            [workspace.owner_user_id,
              `Customer request needs you: ${tool.name.replace(/_/g, ' ')}`,
              new Date().toISOString().slice(0, 10),
              `A customer (${customer_phone || customer_email || 'unknown'}) asked for something the AI is set not to handle (${tool.name}). Input: ${JSON.stringify(block.input).slice(0, 300)}`,
              'Autonomy matrix: category set to off.']
          );
        } catch (err) {
          logger.error('[appointment-engine] decline-task insert failed:', err.message);
        }
        const declineMsg = "I can't take care of that automatically, but I've passed your request along — the owner will follow up with you directly.";
        used_tools.push({ name: tool.name, success: false, message: declineMsg });
        if (!outbound_text.includes(declineMsg)) {
          outbound_text += (outbound_text ? '\n' : '') + declineMsg;
        }
        continue;
      }
      if (decision === 'queue') {
        try {
          const summary = `${tool.name.replace(/_/g, ' ')}: ${JSON.stringify(block.input).slice(0, 140)}`;
          await db.query(
            `INSERT INTO pending_actions
               (workspace_id, user_id, tool_name, input, ai_summary, status,
                customer_phone, customer_email, customer_channel, appointment_thread_id)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
            [workspace.id, workspace.owner_user_id, tool.name,
              JSON.stringify(block.input), summary,
              customer_phone || null, customer_email || null, channel || null, thread.id]
          );
        } catch (err) {
          logger.error('[appointment-engine] approval queue insert failed:', err.message);
          used_tools.push({ name: tool.name, success: false, message: 'could not queue for approval' });
          continue;
        }
        // FD3-CP4: announce the wait. Investigation §3: "Is the owner
        // notified? No." — a customer could sit in the queue until the
        // owner happened to open Home. Routed through the same
        // alert_phone→email chain as emergencies (lib/owner-alert);
        // respects notifications_enabled since this isn't an emergency.
        // Best-effort: the customer reply never blocks on it, and the
        // queue row is already safe on disk. Owner-originated queue rows
        // (the /api/command divert) deliberately never ping — the owner
        // just did it themselves.
        try {
          const CATEGORY_NOUN = { bookings: 'a booking', contacts: 'a contact change', tasks: 'a task', payments: 'a payment' };
          const noun = CATEGORY_NOUN[categoryFor(tool.name)] || 'an action';
          await sendOwnerAlert({ db, twilio, sendgrid, env, logger }, workspace.owner_user_id, {
            smsBody: `A customer is waiting on ${noun} approval — open Modern Management to review.`,
            emailSubject: 'A customer is waiting on your approval',
            respectEnabled: true,
          });
        } catch (err) {
          logger.error('[appointment-engine] approval ping failed (queue row intact):', err.message);
        }
        const queuedMsg = "I've sent that to the owner to confirm — you'll hear back shortly.";
        used_tools.push({ name: tool.name, success: true, message: queuedMsg, queued: true });
        if (!outbound_text.includes(queuedMsg)) {
          outbound_text += (outbound_text ? '\n' : '') + queuedMsg;
        }
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
        // LS: the relay closure's language-switch hook (voice calls only;
        // null elsewhere — switch_language refuses without it).
        onLanguageSwitch,
        origin: {
          channel: 'ai_inbound',
          // FD3-CP5: the receipt — previous customer line (from the
          // context summary, may be truncated at 120 chars) plus the
          // CURRENT message verbatim, so escalations carry the
          // customer's own words rather than a paraphrase.
          recent_customer_words: (() => {
            const out = [];
            const prior = (thread.context_summary || '').split('\n').filter(Boolean);
            for (let i = prior.length - 1; i >= 0; i--) {
              const m = prior[i].match(/^Customer: (.*?) \| AI:/);
              if (m && m[1].trim()) { out.push(m[1].trim()); break; }
            }
            out.push(String(body).slice(0, 500));
            return out;
          })(),
          // FD3-CP2: the real inbound channel rides along so tools can
          // label provenance honestly (voice bookings were stamped as
          // SMS). origin.channel stays 'ai_inbound' — every FD2/CP6
          // guard keys on it.
          channel_detail: channel,
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
  // SP4b: the reply leaves from the workspace's OWN number or not at
  // all — the platform fallback is retired (unfamiliar sender +
  // unroutable replies). This path is structurally unreachable while
  // provisioning (it needs an inbound, which needs a number), so a
  // null here means a genuinely broken state: log it loudly.
  const replyFrom = customerSmsFrom(workspace);
  if (outbound_text && customer_phone && channel !== 'voice' && !replyFrom) {
    logger.error('[appointment-engine] CANNOT reply — workspace ' + workspace.id +
      ' has no number (unexpected: an inbound reached us without one). Reply withheld: ' +
      String(outbound_text).slice(0, 80));
  }
  // A2P/TCPA: never send to a number that opted out of THIS workspace —
  // the structural send-layer gate, independent of Twilio's Advanced
  // Opt-Out. Strict liability (see lib/sms-consent).
  const _optedOut = (outbound_text && customer_phone && channel !== 'voice' && replyFrom)
    ? await require('./sms-consent').isOptedOut(db, workspace.id, customer_phone)
    : false;
  if (_optedOut) {
    logger.error('[appointment-engine] SUPPRESSED outbound to opted-out '
      + customer_phone + ' (ws ' + workspace.id + ') — TCPA opt-out honored.');
  }
  // LP2a: the demo workspace may NEVER send SMS while the A2P campaign is
  // pending (R2 ruling). Structural send-layer block, same seam as opt-out.
  if (workspace.is_demo && outbound_text && customer_phone && channel !== 'voice') {
    logger.error('[appointment-engine] SUPPRESSED outbound SMS from DEMO workspace '
      + workspace.id + ' — demo lines never text (A2P pending).');
  }
  if (outbound_text && customer_phone && channel !== 'voice' && replyFrom && !_optedOut && !workspace.is_demo) {
    try {
      await twilio.messages.create({
        from: replyFrom,
        to: customer_phone,
        body: outbound_text,
      });
      try {
        await db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, direction, sent_by, thread_id, contact_id)
           VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5, 'outbound', 'ai', $6, $7)`,
          [
            workspace.owner_user_id,
            contact ? contact.name : (customer_phone || 'unknown'),
            `SMS to ${contact ? contact.name : customer_phone}`,
            outbound_text,
            customer_phone,
            thread ? thread.id : null,
            contact ? contact.id : null,
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
      // IB1: the engine's email replies were the one AI send that never
      // persisted — the record now matches the SMS branch above.
      try {
        await db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email, direction, sent_by, thread_id, contact_id)
           VALUES ($1, $2, $3, 'email', $4, 'sent', 'inbox', $5, 'outbound', 'ai', $6, $7)`,
          [workspace.owner_user_id,
            contact ? contact.name : customer_email,
            `Email to ${contact ? contact.name : customer_email}`,
            outbound_text, customer_email,
            thread ? thread.id : null, contact ? contact.id : null]
        );
      } catch (err) {
        logger.error('[appointment-engine] persist outbound email failed (still sent):', err.message);
      }
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

// buildSystemPrompt + executeAIResult exported for the CP5 playbook
// regression harness (docs/playbook-tests.md) — pure function + the
// tool-execution path driven with stub transports.
// IB1 commit 3: the brain hears the owner. Owner turns enter the same
// context_summary the prompt's "## Conversation context so far"
// section reads — labeled unmistakably, trimmed by the same
// MAX_THREAD_LINES cap as customer/AI pairs. An AI reply generated
// after an owner turn is therefore built on a prompt that CONTAINS
// that turn and cannot claim ignorance of it.
async function appendOwnerTurnToContext({ db, threadId, text }) {
  if (!threadId || !text) return;
  const tR = await db.query(
    'SELECT context_summary FROM appointment_threads WHERE id = $1',
    [threadId]
  );
  if (!tR.rows.length) return;
  const lines = (tR.rows[0].context_summary || '').split('\n').filter(Boolean);
  lines.push('The owner replied directly: ' + String(text).slice(0, 120));
  while (lines.length > MAX_THREAD_LINES) lines.shift();
  await db.query(
    'UPDATE appointment_threads SET context_summary = $1, updated_at = NOW() WHERE id = $2',
    [lines.join('\n'), threadId]
  );
}

// findOrCreateThread exported for IB1's owner-outbound persistence —
// an owner reply joins (or opens) the same conversation the engine
// would use, via the same code.
module.exports = { processInboundMessage, buildSystemPrompt, executeAIResult, findOrCreateThread, appendOwnerTurnToContext };
