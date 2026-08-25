// lib/speech-fallbacks.js — deterministic speech for the compose
// fallback (URGENT hardening after the 100%-fallback outage).
//
// When the compose pass fails, the fallback SPEAKS THE ANSWER: plain-
// code formatters render the schedule tools' data speakably (no model
// involved, no ISO dates, no tool-message shapes). "That's all set"
// survives ONLY for action tools with nothing to report; read tools
// never claim a success they can't show.

const { wsTz } = require('./time-helpers');

function spokenTime(iso, tz) {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
}
function spokenDate(iso, tz) {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
}
// A bare YYYY-MM-DD calendar date, rendered without timezone drift.
function spokenDay(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}
function listJoin(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

const FORMATTERS = {
  propose_appointment_times(t, tz) {
    const d = t.data || {};
    if (Array.isArray(d.days) && d.days.length) {
      const parts = d.days.map((day) => {
        if (day.closed) return `we're closed on ${spokenDay(day.date)}`;
        if (!day.slots.length) return `${spokenDay(day.date)} has nothing open`;
        return `on ${spokenDay(day.date)} we have ${listJoin(day.slots.map((s) => spokenTime(s.starts_at, tz)))}`;
      });
      return parts.join('; ') + '.';
    }
    if (Array.isArray(d.slots) && d.slots.length) {
      return `On ${spokenDate(d.slots[0].starts_at, tz)} we have ${listJoin(d.slots.map((s) => spokenTime(s.starts_at, tz)))} open.`;
    }
    if (d.reason === 'closed_that_day') return "We're closed that day — is there another day that works for you?";
    if (d.reason === 'window_outside_business_day') return "That time falls outside our hours — is there another time that works?";
    return "I don't have anything open there — is there another time that would work?";
  },
  book_appointment(t, tz) {
    // The R5a review-mode line is already first-person speech-grade.
    if (t.message && /^I have you booked/.test(t.message)) return t.message;
    if (t.success && t.input && t.input.starts_at) {
      return `You're booked for ${t.input.title || 'your appointment'} on ${spokenDate(t.input.starts_at, tz)} at ${spokenTime(t.input.starts_at, tz)}.`;
    }
    return null;
  },
};

function speakToolFallback(used_tools, workspace, registry) {
  const tz = wsTz(workspace);
  for (let i = used_tools.length - 1; i >= 0; i--) {
    const t = used_tools[i];
    if (t.success === false) continue;
    const fmt = FORMATTERS[t.name];
    if (fmt) {
      try { const line = fmt(t, tz); if (line) return line; } catch (err) { /* fall through */ }
    }
  }
  if (used_tools.some((t) => t.success === false)) {
    return "I'm sorry — I hit a snag with that just now. Could we try that once more?";
  }
  const last = used_tools[used_tools.length - 1];
  const tool = last && registry && registry.getTool ? registry.getTool(last.name) : null;
  if (tool && tool.category === 'read') {
    return "I'm sorry — I had trouble reading that back just now. Could you ask me once more?";
  }
  return "That's all set — is there anything else I can help you with?";
}

module.exports = { speakToolFallback, FORMATTERS };
