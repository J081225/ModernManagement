// lib/time-helpers.js
//
// Shared timezone helpers used by the appointment engine and the
// appointment-related AI tools (book_appointment, update_appointment,
// propose_appointment_times). Standalone module to avoid a reverse
// dependency from tools -> appointment-engine.
//
// wsTz(workspace)          returns the workspace's IANA timezone, or a
//                          sensible default when the column is NULL /
//                          the workspace is missing.
// toZonedISO(input, tz)    normalizes an input timestamp to a canonical
//                          UTC ISO string. If input is already
//                          offset-aware (Z or ±HH:MM), it is parsed and
//                          normalized as-is. If it is a NAIVE
//                          'YYYY-MM-DD[T ]HH:mm[:ss]' string, it is
//                          interpreted as wall-clock time in tz and
//                          converted to the correct UTC ISO (DST-safe).
//                          Returns null for unparseable input so callers
//                          can surface a clear message.
//
// The naive-string handling is the belt-and-suspenders half of the fix:
// even if the AI ignores the tool schema's "must include offset"
// instruction and passes a bare "2026-07-15T09:30:00", we still store
// 13:30 UTC (correct 9:30 AM Eastern) instead of 09:30 UTC.

const DEFAULT_TZ = 'America/New_York';

function wsTz(workspace) {
  return (workspace && workspace.timezone) || DEFAULT_TZ;
}

// Match "YYYY-MM-DDTHH:mm[:ss]" or "YYYY-MM-DD HH:mm[:ss]" (space or T).
// Optional trailing fractional seconds are tolerated but discarded.
function parseNaive(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
    .exec(String(s || '').trim());
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mm: +m[5], ss: m[6] ? +m[6] : 0 };
}

// Given a UTC millisecond timestamp, return the tz's offset from UTC in
// minutes (positive = east of UTC) at that moment. Uses Intl.DateTimeFormat
// so it handles DST correctly with no external library.
function tzOffsetMinutes(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Node's Intl sometimes emits "24" for midnight in some locales; normalize.
  let hour = +map.hour;
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(+map.year, +map.month - 1, +map.day, hour, +map.minute, +map.second);
  return (asIfUtc - utcMs) / 60000;
}

function toZonedISO(input, tz) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  // Offset-aware? Trailing Z, or ±HHMM / ±HH:MM.
  if (/Z$/i.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  // Naive wall-clock — interpret in tz.
  const parts = parseNaive(s);
  if (!parts) return null;
  const wallAsUtc = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mm, parts.ss);
  // Two-pass to handle DST transitions correctly: the offset at the naive
  // wall time (interpreted as UTC) may differ from the offset at the true
  // UTC moment (near "spring forward" / "fall back" hours). Re-computing
  // once against the first guess converges.
  const off1 = tzOffsetMinutes(wallAsUtc, tz);
  const guess = wallAsUtc - off1 * 60000;
  const off2 = tzOffsetMinutes(guess, tz);
  const utcMs = wallAsUtc - off2 * 60000;
  return new Date(utcMs).toISOString();
}

// FD3-CP2: the ONE date/time anchor for AI prompts — workspace-local,
// weekday-named, so "this coming Tuesday" resolves from the business's
// real today (a bare UTC ISO date is tomorrow's date after ~7-8 PM
// Eastern and forces the model to do weekday arithmetic blind).
// Used by both brains: the customer engine and the owner /api/command
// prompt. One implementation, two callers.
function promptTimeAnchor(workspace) {
  const tz = wsTz(workspace);
  let nowInTz;
  try {
    nowInTz = new Date().toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch (err) {
    nowInTz = new Date().toISOString();
  }
  return { tz, nowInTz };
}

module.exports = { DEFAULT_TZ, wsTz, toZonedISO, promptTimeAnchor };
