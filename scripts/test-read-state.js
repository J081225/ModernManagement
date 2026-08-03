// scripts/test-read-state.js — AD9, rebuild of the lost `readstate`
// gate, with the `ib3` conversation-key grammar folded in.
//
// IB2 definition: unread iff direction='inbound' AND read_at IS NULL;
// owner/ai/system and legacy direction-NULL rows are never unread.
// Marking is server-side on fetch; opening a threaded row marks the
// whole conversation. The badge counts CONVERSATIONS, not rows. The
// t/c/m group-read grammar mirrors the /api/conversations endpoint
// (source-pinned here).
//
// FLAGGED DIVERGENCE (RS7): unreadConversationCount groups threadless
// rows by 'm'+id, while /api/conversations groups threadless-but-
// contact-linked rows by 'c'+contact_id. The badge therefore over-
// counts vs the list for that row class. Documented, not patched
// (AD9 is test-infra only) — reported in the commit for a future
// ruling.
const path = require('path');
const fs = require('fs');
const readState = require(path.join(__dirname, '..', 'lib', 'read-state'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// A fixture messages table. Rows: {id, user_id, thread_id, contact_id,
// direction, read_at, folder}. UPDATE ... read_at = NOW() sets read_at
// on the matching still-unread inbound rows and reports rowCount.
function makeDb(rows, opts = {}) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (opts.throwOn && s.startsWith(opts.throwOn)) throw new Error('db down (fixture)');
      const mark = (pred) => {
        let n = 0;
        for (const r of rows) {
          if (r.direction === 'inbound' && !r.read_at && pred(r)) { r.read_at = 'NOW'; n++; }
        }
        return { rowCount: n };
      };
      if (s.startsWith('UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND thread_id = $2')) {
        return mark((r) => r.user_id === params[0] && r.thread_id === params[1]);
      }
      if (s.startsWith('UPDATE messages SET read_at = NOW() WHERE id = $1 AND user_id = $2')) {
        return mark((r) => r.id === params[0] && r.user_id === params[1]);
      }
      if (s.startsWith('UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND contact_id = $2 AND thread_id IS NULL')) {
        return mark((r) => r.user_id === params[0] && r.contact_id === params[1] && !r.thread_id);
      }
      if (s.startsWith('UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND id = $2')) {
        return mark((r) => r.user_id === params[0] && r.id === params[1]);
      }
      if (s.startsWith('SELECT COUNT(DISTINCT COALESCE')) {
        // COUNT(DISTINCT COALESCE('t'||thread_id, 'm'||id)) for inbox
        // inbound unread — the badge's exact grammar.
        const keys = new Set();
        for (const r of rows) {
          if (r.user_id === params[0] && r.folder === 'inbox' && r.direction === 'inbound' && !r.read_at) {
            keys.add(r.thread_id ? 't' + r.thread_id : 'm' + r.id);
          }
        }
        return { rows: [{ n: keys.size }] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

(async () => {
  // ---- RS1: opening a threaded inbound row marks the WHOLE thread ----
  {
    const rows = [
      { id: 1, user_id: 3, thread_id: 9, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 2, user_id: 3, thread_id: 9, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 3, user_id: 3, thread_id: 9, direction: 'outbound', read_at: null, folder: 'inbox' },
    ];
    const n = await readState.markReadOnFetch({ db: makeDb(rows), userId: 3, message: rows[0] });
    check('RS1: opening one threaded inbound row marks both inbound rows (2); the outbound row is untouched',
      n === 2 && rows[0].read_at && rows[1].read_at && !rows[2].read_at, JSON.stringify(rows));
  }

  // ---- RS2: a threadless row marks only itself ----
  {
    const rows = [
      { id: 5, user_id: 3, thread_id: null, contact_id: 8, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 6, user_id: 3, thread_id: null, contact_id: 8, direction: 'inbound', read_at: null, folder: 'inbox' },
    ];
    const n = await readState.markReadOnFetch({ db: makeDb(rows), userId: 3, message: rows[0] });
    check('RS2: a threadless row marks ONLY itself (1), not its contact-siblings',
      n === 1 && rows[0].read_at && !rows[1].read_at);
  }

  // ---- RS3: non-inbound or already-read is a no-op (no query) ----
  {
    const outbound = await readState.markReadOnFetch({ db: makeDb([]), userId: 3, message: { id: 1, direction: 'outbound', read_at: null } });
    const already = await readState.markReadOnFetch({ db: makeDb([]), userId: 3, message: { id: 1, direction: 'inbound', read_at: 'NOW' } });
    const nullDir = await readState.markReadOnFetch({ db: makeDb([]), userId: 3, message: { id: 1, direction: null, read_at: null } });
    check('RS3: outbound / already-read / direction-NULL all no-op to 0 without a query',
      outbound === 0 && already === 0 && nullDir === 0);
  }

  // ---- RS4: mark is error-safe — a failing UPDATE returns 0, never throws ----
  {
    const rows = [{ id: 1, user_id: 3, thread_id: 9, direction: 'inbound', read_at: null, folder: 'inbox' }];
    const db = makeDb(rows, { throwOn: 'UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND thread_id = $2' });
    let threw = false, n;
    try { n = await readState.markReadOnFetch({ db, userId: 3, message: rows[0] }); } catch (e) { threw = true; }
    check('RS4: a failing mark returns 0 and never throws (the message is still served)', threw === false && n === 0);
  }

  // ---- RS5: the badge counts CONVERSATIONS, not rows ----
  {
    const rows = [
      { id: 1, user_id: 3, thread_id: 9, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 2, user_id: 3, thread_id: 9, direction: 'inbound', read_at: null, folder: 'inbox' }, // same thread
      { id: 3, user_id: 3, thread_id: null, direction: 'inbound', read_at: null, folder: 'inbox' }, // standalone
      { id: 4, user_id: 3, thread_id: 9, direction: 'outbound', read_at: null, folder: 'inbox' }, // outbound
      { id: 5, user_id: 3, thread_id: 7, direction: 'inbound', read_at: 'NOW', folder: 'inbox' }, // read
      { id: 6, user_id: 3, thread_id: 8, direction: 'inbound', read_at: null, folder: 'sent' }, // wrong folder
    ];
    const n = await readState.unreadConversationCount({ db: makeDb(rows), userId: 3 });
    check('RS5: 3 unread inbox inbound rows across 2 conversations (thread 9 once + standalone) -> count 2; outbound/read/non-inbox excluded',
      n === 2, String(n));
  }

  // ---- RS6: group-read grammar — t / c / m each scope correctly ----
  {
    const rows = [
      { id: 10, user_id: 3, thread_id: 4, contact_id: null, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 11, user_id: 3, thread_id: null, contact_id: 6, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 12, user_id: 3, thread_id: null, contact_id: 6, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 13, user_id: 3, thread_id: null, contact_id: null, direction: 'inbound', read_at: null, folder: 'inbox' },
    ];
    const db = makeDb(rows);
    const t = await readState.markGroupRead({ db, userId: 3, key: 't4' });
    const c = await readState.markGroupRead({ db, userId: 3, key: 'c6' });
    const m = await readState.markGroupRead({ db, userId: 3, key: 'm13' });
    const bad = await readState.markGroupRead({ db, userId: 3, key: 'z9' });
    const noId = await readState.markGroupRead({ db, userId: 3, key: 't' });
    check('RS6: t4 marks the thread (1); c6 marks the contact\'s threadless pair (2); m13 marks the single (1); unknown/idless keys -> 0',
      t === 1 && c === 2 && m === 1 && bad === 0 && noId === 0,
      JSON.stringify({ t, c, m, bad, noId }));
  }

  // ---- RS7: the FLAGGED badge-vs-list divergence, captured as a fact ----
  {
    // Two threadless inbound rows for ONE contact. The badge grammar
    // ('m'+id) counts them as 2; the /api/conversations grammar
    // ('c'+contact_id) groups them as 1. This asserts the CURRENT
    // behavior so the divergence is on the record, not silently
    // "passing".
    const rows = [
      { id: 20, user_id: 3, thread_id: null, contact_id: 42, direction: 'inbound', read_at: null, folder: 'inbox' },
      { id: 21, user_id: 3, thread_id: null, contact_id: 42, direction: 'inbound', read_at: null, folder: 'inbox' },
    ];
    const badge = await readState.unreadConversationCount({ db: makeDb(rows), userId: 3 });
    // list grouping (conversationKeyOf): both -> 'c42' -> one bucket
    const listKeys = new Set(rows.map((r) => r.thread_id ? 't' + r.thread_id : (r.contact_id ? 'c' + r.contact_id : 'm' + r.id)));
    check('RS7 [FLAG]: badge counts 2 for a contact\'s 2 threadless unread; the list groups them to 1 — a real divergence (documented, unpatched)',
      badge === 2 && listKeys.size === 1, JSON.stringify({ badge, listBuckets: listKeys.size }));
  }

  // ---- RS8: source-pin — the endpoint grammar matches the lib grammar ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fnIdx = src.indexOf('function conversationKeyOf(m) {');
    const fn = src.slice(fnIdx, src.indexOf('}', src.indexOf('return', fnIdx + 40)) + 1);
    const grammarOk = fn.includes("return 't' + m.thread_id") && fn.includes("return 'c' + m.contact_id") && fn.includes("return 'm' + m.id");
    const reOk = src.includes('const CONVO_KEY_RE = /^[tcm]\\d+$/;');
    check('RS8: /api/conversations conversationKeyOf uses the same t/c/m grammar markGroupRead consumes; the key regex is [tcm]\\d+',
      fnIdx !== -1 && grammarOk && reOk, JSON.stringify({ grammarOk, reOk }));
  }

  console.log(`${pass}/${pass + fail} — read-state gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
