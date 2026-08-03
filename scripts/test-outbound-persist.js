// scripts/test-outbound-persist.js — AD9, rebuild of the lost `ib1` gate.
//
// persistOutboundMessage (IB1): the ONE way an owner/ai/system outbound
// is recorded after send. Contract proven: owner turns CREATE a thread
// and stamp last_owner_message_at + fire onOwnerTurn; ai/system notices
// link-only and never mint a conversation; it can never throw (the send
// already happened). Drives the real lib with a fixture DB.
const path = require('path');
const { persistOutboundMessage } = require(path.join(__dirname, '..', 'lib', 'outbound-persist'));
const { phoneDigits10 } = require(path.join(__dirname, '..', 'lib', 'phone'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const WS = { id: 5, owner_user_id: 3 };

// Fixture DB answering every shape persistOutboundMessage +
// resolveCallerContact issue. State: contacts, open threads; captures
// the messages INSERT and the last_owner_message_at UPDATE.
function makeDb(state, opts = {}) {
  return {
    inserts: [],
    stamps: [],
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (opts.throwOnInsert && s.startsWith('INSERT INTO messages')) throw new Error('db down (fixture)');
      // resolveCallerContact — contacts by phone digits10
      if (s.startsWith('SELECT id, name FROM contacts') && s.includes("regexp_replace(phone")) {
        const c = (state.contacts || []).find((x) => x.digits10 === params[1] && x.user_id === params[0]);
        return { rows: c ? [{ id: c.id, name: c.name }] : [] };
      }
      // resolveCallerContact — contacts by email
      if (s.startsWith('SELECT id, name FROM contacts') && s.includes('LOWER(email)')) {
        const c = (state.contacts || []).find((x) => (x.email || '').toLowerCase() === String(params[1]).toLowerCase() && x.user_id === params[0]);
        return { rows: c ? [{ id: c.id, name: c.name }] : [] };
      }
      // system/ai thread lookup by phone (open only)
      if (s.startsWith('SELECT id FROM appointment_threads') && s.includes("regexp_replace(customer_phone")) {
        const t = (state.threads || []).find((x) => x.digits10 === params[1] && x.workspace_id === params[0] && x.open);
        return { rows: t ? [{ id: t.id }] : [] };
      }
      // system/ai thread lookup by email (open only)
      if (s.startsWith('SELECT id FROM appointment_threads') && s.includes('LOWER(customer_email)')) {
        const t = (state.threads || []).find((x) => (x.email || '').toLowerCase() === String(params[1]).toLowerCase() && x.workspace_id === params[0] && x.open);
        return { rows: t ? [{ id: t.id }] : [] };
      }
      if (s.startsWith('INSERT INTO messages')) {
        const row = {
          user_id: params[0], resident: params[1], subject: params[2], category: params[3],
          text: params[4], phone: params[5], email: params[6], sent_by: params[7],
          thread_id: params[8], contact_id: params[9],
        };
        this.inserts.push(row);
        return { rows: [{ id: 9000 + this.inserts.length }] };
      }
      if (s.startsWith('UPDATE appointment_threads SET last_owner_message_at')) {
        if (opts.throwOnStamp) throw new Error('stamp failed (fixture)');
        this.stamps.push({ thread_id: params[0], workspace_id: params[1] });
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

const quiet = { error: () => {}, log: () => {} };

(async () => {
  // ---- OP1: owner send CREATES a thread, stamps, and fires the hook ----
  {
    const db = makeDb({ contacts: [{ id: 11, name: 'Dana', user_id: 3, digits10: phoneDigits10('+14435550111') }] });
    let created = false, hookFired = null;
    const id = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550111', body: 'On my way', sentBy: 'owner',
      logger: quiet,
      findOrCreateThread: async () => { created = true; return { id: 77 }; },
      onOwnerTurn: async ({ threadId, text }) => { hookFired = { threadId, text }; },
    });
    const row = db.inserts[0];
    check('OP1: owner send -> thread created, row is outbound/owner with thread+contact, stamped, hook fired',
      id && created === true && row.sent_by === 'owner' && row.thread_id === 77 && row.contact_id === 11
        && db.stamps.length === 1 && db.stamps[0].thread_id === 77
        && hookFired && hookFired.threadId === 77 && hookFired.text === 'On my way',
      JSON.stringify({ created, row, stamps: db.stamps, hookFired }));
  }

  // ---- OP2: a system notice NEVER creates a thread ----
  {
    const db = makeDb({ contacts: [], threads: [] });
    let created = false, hookFired = false;
    const id = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550222', body: 'Receipt #4', sentBy: 'system',
      logger: quiet,
      findOrCreateThread: async () => { created = true; return { id: 1 }; },
      onOwnerTurn: async () => { hookFired = true; },
    });
    const row = db.inserts[0];
    check('OP2: system notice -> findOrCreateThread NOT called; unthreaded row; no stamp, no hook',
      id && created === false && row.sent_by === 'system' && row.thread_id === null
        && db.stamps.length === 0 && hookFired === false,
      JSON.stringify({ created, thread_id: row.thread_id, stamps: db.stamps.length, hookFired }));
  }

  // ---- OP3: a system/ai notice LINKS to an existing OPEN thread if one matches ----
  {
    const db = makeDb({
      contacts: [],
      threads: [
        { id: 55, workspace_id: 5, digits10: phoneDigits10('+14435550333'), open: true },
        { id: 56, workspace_id: 5, digits10: phoneDigits10('+14435559999'), open: false }, // closed
      ],
    });
    const idOpen = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550333', body: 'ai note', sentBy: 'ai', logger: quiet,
    });
    const idClosed = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435559999', body: 'ai note 2', sentBy: 'ai', logger: quiet,
    });
    check('OP3: ai notice links to a matching OPEN thread (55); a closed thread is excluded -> unthreaded',
      db.inserts[0].thread_id === 55 && db.inserts[1].thread_id === null,
      JSON.stringify({ open: db.inserts[0].thread_id, closed: db.inserts[1].thread_id }));
  }

  // ---- OP4: an explicit threadId short-circuits all lookup ----
  {
    const db = makeDb({ contacts: [] });
    let lookedUp = false;
    await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550444', body: 'x', sentBy: 'ai', threadId: 999, logger: quiet,
      findOrCreateThread: async () => { lookedUp = true; return { id: 1 }; },
    });
    check('OP4: an explicit threadId is used verbatim, no create/lookup',
      db.inserts[0].thread_id === 999 && lookedUp === false);
  }

  // ---- OP5: contact linkage — match links, no-match persists unlinked ----
  {
    const db = makeDb({ contacts: [] }); // no contact for this number
    const id = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550555', body: 'hi', sentBy: 'system', logger: quiet,
    });
    check('OP5: no matching contact -> row still persists, contact_id null, label falls back to the address',
      id && db.inserts[0].contact_id === null && db.inserts[0].resident === '+14435550555');
  }

  // ---- OP6: it NEVER throws — a failing INSERT returns null ----
  {
    const db = makeDb({ contacts: [] }, { throwOnInsert: true });
    let threw = false, result;
    try {
      result = await persistOutboundMessage({
        db, workspace: WS, channel: 'sms', to: '+14435550666', body: 'x', sentBy: 'owner', logger: quiet,
        findOrCreateThread: async () => ({ id: 1 }),
      });
    } catch (e) { threw = true; }
    check('OP6: an INSERT failure is swallowed — returns null, never throws (the send already happened)',
      threw === false && result === null);
  }

  // ---- OP7: email vs sms column placement ----
  {
    const db = makeDb({ contacts: [] });
    await persistOutboundMessage({ db, workspace: WS, channel: 'email', to: 'c@x.test', body: 'e', sentBy: 'system', logger: quiet });
    await persistOutboundMessage({ db, workspace: WS, channel: 'sms', to: '+14435550777', body: 's', sentBy: 'system', logger: quiet });
    check('OP7: email send stores email (phone null, category email); sms stores phone (email null, category sms)',
      db.inserts[0].email === 'c@x.test' && db.inserts[0].phone === null && db.inserts[0].category === 'email'
        && db.inserts[1].phone === '+14435550777' && db.inserts[1].email === null && db.inserts[1].category === 'sms',
      JSON.stringify(db.inserts));
  }

  // ---- OP8: an owner stamp failure does NOT lose the row ----
  {
    const db = makeDb({ contacts: [] }, { throwOnStamp: true });
    const id = await persistOutboundMessage({
      db, workspace: WS, channel: 'sms', to: '+14435550888', body: 'x', sentBy: 'owner', logger: quiet,
      findOrCreateThread: async () => ({ id: 88 }),
    });
    check('OP8: the last_owner_message_at stamp throwing still returns the persisted row id',
      id && db.inserts[0].sent_by === 'owner' && db.inserts[0].thread_id === 88);
  }

  // ---- OP9: missing db/workspace/body -> null, no crash ----
  {
    const r1 = await persistOutboundMessage({ db: null, workspace: WS, body: 'x', sentBy: 'owner', logger: quiet });
    const r2 = await persistOutboundMessage({ db: makeDb({}), workspace: null, body: 'x', sentBy: 'owner', logger: quiet });
    const r3 = await persistOutboundMessage({ db: makeDb({}), workspace: WS, body: '', sentBy: 'owner', logger: quiet });
    check('OP9: absent db / workspace / body each return null without throwing',
      r1 === null && r2 === null && r3 === null);
  }

  console.log(`${pass}/${pass + fail} — outbound-persist gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
