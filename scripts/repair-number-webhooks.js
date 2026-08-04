// scripts/repair-number-webhooks.js — SP5b.
//
// The webhook repair run. Reads every workspace with a number, works
// out the CORRECT url pair for its vertical (SP5a's mapping — never a
// second copy of it), compares against Twilio's live config, and
// reports drift. Also backfills workspaces.twilio_phone_sid when it's
// missing (ws3's blocker: the configure API takes a SID and ws3 has
// none stored).
//
// SAFE BY DEFAULT: --dry-run (the default) writes NOTHING — not to
// Twilio, not to the database. Use --apply to perform the repair.
// The AD-era backfill discipline: look, report, then apply.
//
// ORDERING (ruled): this may only be APPLIED once SP5a's
// vertical-aware configureNumberWebhooks is LIVE. Applied against the
// old code it would clobber the PS number's relay path into the PM
// voicemail path — the exact damage SP5a exists to prevent. The
// script refuses to apply unless the local code carries the SP5a
// mapping, which is a guard, not a substitute for checking the deploy.
require('dotenv').config();
const { Pool } = require('pg');
const twilioProvisioning = require('../lib/twilio-provisioning');

const APPLY = process.argv.includes('--apply');
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

async function twilioGet(pathSuffix) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + pathSuffix, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error('Twilio API ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

(async () => {
  if (!BASE) fail('PUBLIC_BASE_URL is not set — refusing to guess the canonical host.');
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) fail('Twilio credentials missing.');
  // The SP5a guard: the mapping must exist in the loaded code.
  if (typeof twilioProvisioning.voicePathForVertical !== 'function') {
    fail('SP5a is not present in this checkout (voicePathForVertical missing). The repair MUST NOT run against the pre-SP5a code — it would clobber the PS relay path.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(APPLY ? '=== REPAIR RUN (--apply: WILL WRITE) ===' : '=== DRY RUN (default: writes nothing) ===');
  console.log('canonical base: ' + BASE + '\n');

  const { rows: workspaces } = await pool.query(
    `SELECT id, business_name, vertical, twilio_phone_number, twilio_phone_sid
       FROM workspaces
      WHERE twilio_phone_number IS NOT NULL
      ORDER BY id`
  );
  const live = await twilioGet('/IncomingPhoneNumbers.json?PageSize=100');
  const byNumber = new Map((live.incoming_phone_numbers || []).map((n) => [n.phone_number, n]));

  let drift = 0, sidBackfills = 0, repaired = 0;

  for (const ws of workspaces) {
    const wanted = {
      voice: BASE + twilioProvisioning.voicePathForVertical(ws.vertical),
      sms: BASE + '/api/sms/incoming',
    };
    const n = byNumber.get(ws.twilio_phone_number);
    console.log('ws ' + ws.id + '  ' + (ws.business_name || '').slice(0, 22) + '  [' + ws.vertical + ']  ' + ws.twilio_phone_number);
    if (!n) {
      console.log('   !! not found on the Twilio account — skipping (investigate manually)\n');
      continue;
    }

    // 1) SID backfill (the ws3 blocker).
    if (!ws.twilio_phone_sid) {
      console.log('   SID missing in DB; Twilio has ' + n.sid);
      if (APPLY) {
        await pool.query('UPDATE workspaces SET twilio_phone_sid = $1 WHERE id = $2 AND twilio_phone_sid IS NULL', [n.sid, ws.id]);
        console.log('   -> backfilled twilio_phone_sid');
      } else {
        console.log('   -> would backfill twilio_phone_sid');
      }
      sidBackfills++;
    }

    // 2) URL drift.
    const voiceOk = n.voice_url === wanted.voice;
    const smsOk = n.sms_url === wanted.sms;
    if (voiceOk && smsOk) {
      console.log('   voice OK: ' + n.voice_url);
      console.log('   sms   OK: ' + n.sms_url + '\n');
      continue;
    }
    drift++;
    if (!voiceOk) {
      console.log('   VOICE DRIFT');
      console.log('     is:     ' + (n.voice_url || '(none)'));
      console.log('     should: ' + wanted.voice);
    }
    if (!smsOk) {
      console.log('   SMS DRIFT');
      console.log('     is:     ' + (n.sms_url || '(none)'));
      console.log('     should: ' + wanted.sms);
    }
    if (APPLY) {
      const result = await twilioProvisioning.configureNumberWebhooks(n.sid, BASE, { vertical: ws.vertical });
      console.log('   -> REPAIRED. voice=' + result.voice_url + '  sms=' + result.sms_url);
      repaired++;
    } else {
      console.log('   -> would repair via configureNumberWebhooks(vertical=' + ws.vertical + ')');
    }
    console.log('');
  }

  console.log('--- summary ---');
  console.log('workspaces with a number: ' + workspaces.length);
  console.log('SID backfills ' + (APPLY ? 'applied: ' : 'needed: ') + sidBackfills);
  console.log('numbers with drift: ' + drift + (APPLY ? ('; repaired: ' + repaired) : ''));
  if (!APPLY && (drift || sidBackfills)) console.log('\nRe-run with --apply to perform the repair (SP5a must be LIVE first).');
  await pool.end();
})().catch((err) => { console.error('REPAIR FAILED:', err.message); process.exit(1); });
