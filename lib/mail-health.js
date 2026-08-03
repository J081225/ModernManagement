// lib/mail-health.js — AD8 (f).
//
// The June-August SendGrid outage was invisible because every send
// soft-fails to an unread console line. This watches the EMAIL send
// paths for a failure STREAK and escalates ONCE per streak to channels
// a human actually sees — never email (email is what's broken).
//
// Design (ruling-approved): a consecutive-failure counter shared by the
// email senders; increment on failure, reset to 0 on any success. At
// the threshold it escalates once (a distinct [mail-outage] log marker
// + an owner TASK row, the CP4-expiry pattern), and will not escalate
// again until a success resets the streak. In-memory — a real outage
// re-trips within N sends after a deploy; persisting it would be
// over-engineering for a courtesy alarm.

const DEFAULT_THRESHOLD = 5;

// Factory — isolated state, injectable escalate + threshold, so the
// suite drives it deterministically.
function createMailHealthMonitor({ threshold = DEFAULT_THRESHOLD, escalate, logger } = {}) {
  let consecutive = 0;
  let escalated = false;
  const log = logger || console;
  return {
    recordSuccess() {
      consecutive = 0;
      escalated = false;
    },
    // meta: { source, reason } for the escalation payload. Returns true
    // iff THIS failure triggered the (single) escalation.
    async recordFailure(meta = {}) {
      consecutive += 1;
      if (consecutive >= threshold && !escalated) {
        escalated = true; // once per streak — set before awaiting so a
                          // burst can't double-fire
        log.error('[mail-outage] ' + consecutive + ' consecutive email send failures — escalating. last:', meta.source || '?', meta.reason || '');
        if (escalate) {
          try {
            await escalate({ consecutive, ...meta });
          } catch (err) {
            log.error('[mail-outage] escalation action failed:', err.message);
          }
        }
        return true;
      }
      return false;
    },
    _state() { return { consecutive, escalated }; },
  };
}

// The shared singleton the real send paths feed. escalate is injected
// once at server boot via configure() so the module needs no DB handle
// of its own and stays require-cycle-free.
let _singleton = createMailHealthMonitor();

function configure(opts) {
  _singleton = createMailHealthMonitor(opts);
}
function recordSuccess() { return _singleton.recordSuccess(); }
function recordFailure(meta) { return _singleton.recordFailure(meta); }

module.exports = {
  DEFAULT_THRESHOLD,
  createMailHealthMonitor,
  configure,
  recordSuccess,
  recordFailure,
};
