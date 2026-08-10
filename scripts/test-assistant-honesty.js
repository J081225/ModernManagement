// scripts/test-assistant-honesty.js — the HN gate.
//
// Pins the species, not the instance. A live defect had the Command
// Center claim three mutations that never touched the database:
//   - the history renderer appended "[tools used: X]" to replayed
//     ASSISTANT turns, and the model imitated the marker as prose
//     instead of calling tools;
//   - nothing verified the reply against reality;
//   - a five-week-old replayed turn asserting "Today is July 4"
//     outranked the (correct) fresh date anchor.
// These rows make each of the three structurally impossible.
const path = require('path');
const fs = require('fs');
const {
  stripToolMarker, hasToolMarker, verifyReplyClaims,
} = require(path.join(__dirname, '..', 'lib', 'assistant-honesty'));
const { promptTimeAnchor } = require(path.join(__dirname, '..', 'lib', 'time-helpers'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

(async () => {
  // ---- HN1: the marker can never enter the assistant channel ----
  {
    // (a) the renderer no longer appends it, and strips what's there
    const appendGone = !/text \+= `\\n\[tools used:/.test(srv);
    const stripsOnRead = /if \(r\.role === 'assistant'\) text = stripToolMarker\(text\)/.test(srv);
    // (b) no marker string survives in CODE — comments may describe
    //     the defect (they must, to explain the fix), but nothing may
    //     emit the marker into content.
    const literalWrites = srv.split('\n')
      .filter((l) => l.includes('[tools used:') && !l.trim().startsWith('//'))
      .length;
    // (c) the stripper actually removes the real poisoned shape
    const poisoned = "I've added **Blue hair dye** as a product to your menu.\n[tools used: add_menu_item]";
    const cleaned = stripToolMarker(poisoned);
    check('HN1 [imitation]: the history renderer never appends the tool marker to assistant turns, strips any already-stored marker on read, and no literal marker string remains in server.js',
      appendGone && stripsOnRead && literalWrites === 0
        && cleaned === "I've added **Blue hair dye** as a product to your menu."
        && !hasToolMarker(cleaned),
      JSON.stringify({ appendGone, stripsOnRead, literalWrites, cleaned }));
  }

  // ---- HN1b: the stripper handles the shapes a model might emit ----
  {
    const shapes = [
      '[tools used: add_menu_item]',
      'Done.\n[tools used: add_contact, book_appointment]',
      'Done. [Tools used: x]',
      'Done.\n[tools used: unterminated',
    ];
    const allClean = shapes.every((s) => !hasToolMarker(stripToolMarker(s)));
    const keepsRealText = stripToolMarker('Added it.\n[tools used: add_menu_item]') === 'Added it.';
    check('HN1b: every marker shape a model might imitate is stripped (case variants, multi-tool, unterminated) while the real prose survives intact',
      allClean && keepsRealText);
  }

  // ---- HN4: no tools, no completion claim ----
  {
    // the three REAL replies from the defect, verbatim
    const real = [
      "I've added **Blue hair dye** as a product to your menu with no base price set.\n[tools used: add_menu_item]",
      "I've updated **Blue hair dye** to $15.00.\n[tools used: update_menu_item]",
      "I've blocked off the next two weeks on your calendar as time off:\n- **Sunday, July 18 – Saturday, July 31, 2026** (14 days)\n[tools used: add_calendar_event]",
    ];
    const allSuppressed = real.every((r) => {
      const v = verifyReplyClaims({ reply: r, toolInvocationCount: 0 });
      return v.ok === false && !/I've (added|updated|blocked)/.test(v.reply) && /nothing was changed/.test(v.reply);
    });
    check('HN4 [the gate]: all three real phantom replies are suppressed when zero tools ran, and the replacement text claims nothing',
      allSuppressed);
  }

  // ---- HN4b: the gate does not eat legitimate replies ----
  {
    const allowedNoTools = [
      'I can add that for you — what price should it be?',
      'You have 8 contacts and 17 menu items.',
      'Which Riverside — Riverside Lofts (#4) or Riverside North (#7)?',
      'Done!',
    ].every((r) => verifyReplyClaims({ reply: r, toolInvocationCount: 0 }).ok);
    // a claim WITH tools is trusted (its truth is the tools' results)
    const allowedWithTools = verifyReplyClaims({
      reply: "I've added **Blue hair dye** as a product.", toolInvocationCount: 2,
    }).ok;
    check('HN4b: conversational replies, read answers, clarifying questions and the "Done!" fallback all pass with zero tools; a mutation claim WITH tools is trusted',
      allowedNoTools && allowedWithTools);
  }

  // ---- HN4c: the gate runs BEFORE the history write ----
  {
    const gateIdx = srv.indexOf('const _claimCheck = verifyReplyClaims(');
    const histIdx = srv.indexOf("INSERT INTO command_history (workspace_id, user_id, role, content, tool_calls_summary)");
    const logs = /UNVERIFIED CLAIM suppressed/.test(srv);
    check('HN4c: the claim gate runs BEFORE the assistant history write — a suppressed lie can never become the next imitation example — and logs loudly with the original text',
      gateIdx > 0 && histIdx > gateIdx && logs,
      JSON.stringify({ gateIdx, histIdx }));
  }

  // ---- HN3: the clock outranks history ----
  {
    // The anchor is real, fresh, and timezone-aware.
    const a = promptTimeAnchor({ timezone: 'America/New_York' });
    const now = new Date();
    const expectedYear = String(now.getFullYear());
    const anchorFresh = a.nowInTz.includes(expectedYear) && a.tz === 'America/New_York';

    // It rides with the LIVE turn, marked authoritative, after history.
    const ridesLive = /const anchoredPrompt =\s*\n\s*`\[Current date and time: \$\{_timeAnchor\.nowInTz\}/.test(srv)
      && /overrides any date mentioned earlier in this conversation/.test(srv);
    const afterHistory = /conversationMessages = \[\.\.\.historyMessages, \{ role: 'user', content: anchoredPrompt \}\]/.test(srv);

    // FIXTURE: a stale "today is X" in replayed history must be
    // outranked. Structural proof — the stale claim sits in an
    // EARLIER message; the authoritative anchor is in the LAST one.
    const staleHistory = [
      { role: 'user', content: 'what date is it?' },
      { role: 'assistant', content: "It's **Saturday, July 4, 2026** at 9:44 PM (Eastern Time)." },
    ];
    const liveTurn = { role: 'user', content: `[Current date and time: ${a.nowInTz} (${a.tz}). This is authoritative — it overrides any date mentioned earlier in this conversation.]\n\nwhat date is it?` };
    const convo = [...staleHistory, liveTurn];
    const staleIdx = convo.findIndex((m) => /July 4, 2026/.test(m.content));
    const anchorIdx = convo.findIndex((m) => /This is authoritative/.test(m.content));
    check('HN3 [the date]: the anchor is fresh and timezone-aware, rides with the LIVE turn after all history, and is marked authoritative — so a stale "Today is July 4" replayed in history is outranked by position and by instruction',
      anchorFresh && ridesLive && afterHistory && anchorIdx > staleIdx,
      JSON.stringify({ anchorFresh, ridesLive, afterHistory, staleIdx, anchorIdx, anchor: a.nowInTz }));
  }

  // ---- HN2: history is bounded by time, not just count ----
  {
    // NOTE: server.js has TWO command_history reads — the Command
    // Center's history-listing endpoint (paginated, LIMIT $3) and the
    // REPLAY query that feeds the model. Only the replay query is the
    // contamination path; pin it by its own text, not by position.
    const replayIdx = srv.indexOf("AND created_at > NOW() - INTERVAL '48 hours'");
    const replayQuery = replayIdx > 0 ? srv.slice(replayIdx - 260, replayIdx + 160) : '';
    const windowed = replayIdx > 0;
    const stillCapped = /LIMIT 20/.test(replayQuery);
    const isReplayQuery = /SELECT role, content, tool_calls_summary FROM command_history/.test(replayQuery);
    check('HN2: the REPLAY query (the one feeding the model, not the UI listing endpoint) is bounded by a 48-hour window AND the 20-turn cap — archaeology cannot replay',
      windowed && stillCapped && isReplayQuery,
      JSON.stringify({ windowed, stillCapped, isReplayQuery }));
  }

  console.log(`${pass}/${pass + fail} — assistant-honesty gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
