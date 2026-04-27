#!/usr/bin/env node
// Phase B B3 — interactive Twilio number-provisioning test harness.
//
// Usage:
//   node scripts/test_twilio_provisioning.js                # interactive purchase
//   node scripts/test_twilio_provisioning.js --dry-run      # search + verify creds, no purchase
//   node scripts/test_twilio_provisioning.js --auto-release # skip inspection pause; release immediately
//   node scripts/test_twilio_provisioning.js --area-code=503  # override default 718
//   (flags can combine, e.g. --dry-run --area-code=503)
//
// Reads TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN from .env.
// Reads TWILIO_TEST_WEBHOOK_BASE_URL from .env (default https://example.com).
//
// Side effects when run without --dry-run:
//   - Spends roughly $1.15 on a Twilio US local number (prorated; quick
//     releases usually do not generate a bill, but YMMV).
//   - Number is released after configuration verification (immediately
//     with --auto-release; after a manual press-Enter pause otherwise).
//
// On error mid-flow, prints the SID of any partially-purchased number
// so it can be cleaned up via the Twilio dashboard.

require('dotenv').config();
const readline = require('readline');
const {
  searchAvailableNumbers,
  purchaseNumber,
  configureNumberWebhooks,
  fetchNumberConfig,
  releaseNumber,
} = require('../lib/twilio-provisioning');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt(q) {
  return new Promise(resolve => rl.question(q, answer => resolve(answer.trim())));
}
function ms(start) { return (Date.now() - start) + 'ms'; }
function header(title) {
  console.log('\n' + '='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

const args = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const AUTO_RELEASE = args.includes('--auto-release');
const areaCodeArg  = (args.find(a => a.startsWith('--area-code=')) || '').split('=')[1];
const AREA_CODE    = areaCodeArg || '718';
const BASE_URL     = process.env.TWILIO_TEST_WEBHOOK_BASE_URL || 'https://example.com';

(async () => {
  const t0 = Date.now();

  // === Echo config ===
  header('Twilio provisioning test harness');
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  console.log('Twilio account SID:        ', sid ? sid.slice(0, 6) + '...' + sid.slice(-4) : '(MISSING)');
  console.log('Webhook base URL:          ', BASE_URL);
  console.log('Searching area code:       ', AREA_CODE);
  console.log('Dry-run mode:              ', DRY_RUN ? 'YES (no purchase will happen)' : 'no');
  console.log('Auto-release after verify: ', AUTO_RELEASE ? 'YES (skip inspection pause)' : 'no');

  if (!sid || !process.env.TWILIO_AUTH_TOKEN) {
    console.error('\nERROR: Twilio credentials missing in .env. Aborting.');
    rl.close();
    process.exit(1);
  }

  // === 1. Search ===
  header('Step 1 — Search for available numbers');
  let results;
  const t1 = Date.now();
  try {
    results = await searchAvailableNumbers(AREA_CODE, 5);
  } catch (err) {
    console.error('Search failed. Aborting.');
    rl.close();
    process.exit(2);
  }
  console.log('Search took ' + ms(t1));
  if (!results.length) {
    console.error('No numbers available in area code ' + AREA_CODE + '. Try a different area code with --area-code=XXX.');
    rl.close();
    process.exit(2);
  }
  results.forEach((n, i) => {
    const caps = Object.entries(n.capabilities || {}).filter(function (kv) { return kv[1]; }).map(function (kv) { return kv[0]; }).join('/');
    console.log('  ' + (i + 1) + '. ' + n.phone_number + '  ' + (n.locality || '?') + ', ' + (n.region || '?') + '  [' + caps + ']');
  });

  if (DRY_RUN) {
    header('--dry-run: stopping after search');
    console.log('Credentials valid; search returned ' + results.length + ' numbers.');
    console.log('Total elapsed: ' + ms(t0));
    rl.close();
    process.exit(0);
  }

  // === 2. Pick + confirm ===
  header('Step 2 — Pick a number to buy');
  const pick = await prompt('Buy which? (1-' + results.length + ', or q to quit): ');
  if (pick.toLowerCase() === 'q') {
    console.log('Quit before purchase. No charges incurred.');
    rl.close();
    process.exit(0);
  }
  const idx = parseInt(pick, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= results.length) {
    console.error('Invalid pick. Aborting.');
    rl.close();
    process.exit(3);
  }
  const chosen = results[idx];
  const confirm = await prompt('Buy ' + chosen.phone_number + '? This is real money. (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled. No charges incurred.');
    rl.close();
    process.exit(0);
  }

  // === 3. Purchase ===
  header('Step 3 — Purchase');
  let purchased;
  const t3 = Date.now();
  try {
    purchased = await purchaseNumber(chosen.phone_number);
  } catch (err) {
    console.error('Purchase failed. No number was attached to your account.');
    rl.close();
    process.exit(4);
  }
  console.log('Purchased: ' + purchased.phone_number);
  console.log('SID:       ' + purchased.phone_sid);
  console.log('Purchase took ' + ms(t3));
  const PHONE_SID = purchased.phone_sid;

  // From here on, any failure leaves the number live in the Twilio
  // account. We catch + report the SID for manual cleanup.
  try {
    // === 4. Configure webhooks ===
    header('Step 4 — Configure webhooks');
    const t4 = Date.now();
    const configured = await configureNumberWebhooks(PHONE_SID, BASE_URL);
    console.log('SMS URL set to:   ' + configured.sms_url);
    console.log('Voice URL set to: ' + configured.voice_url);
    console.log('Configure took ' + ms(t4));

    // === 5. Verify via re-fetch ===
    header('Step 5 — Verify config via re-fetch');
    const t5 = Date.now();
    const fetched = await fetchNumberConfig(PHONE_SID);
    const expectedSms   = BASE_URL.replace(/\/$/, '') + '/api/sms/incoming';
    const expectedVoice = BASE_URL.replace(/\/$/, '') + '/api/voice/incoming';
    const smsOk   = fetched.sms_url === expectedSms;
    const voiceOk = fetched.voice_url === expectedVoice;
    console.log('Fetched SMS URL:   ' + fetched.sms_url + (smsOk ? '  [OK]' : '  [MISMATCH]'));
    console.log('Fetched Voice URL: ' + fetched.voice_url + (voiceOk ? '  [OK]' : '  [MISMATCH]'));
    console.log('Verify took ' + ms(t5));
    if (!smsOk || !voiceOk) {
      console.error('Webhook URLs do not match what we set. Releasing the number anyway to avoid leaving a misconfigured rental live.');
    } else {
      console.log('Webhooks confirmed.');
    }

    // === 6. Inspection pause (unless --auto-release) ===
    if (!AUTO_RELEASE) {
      header('Step 6 — Manual inspection pause');
      console.log('Number is live in your Twilio account.');
      console.log('Open https://console.twilio.com/us1/develop/phone-numbers/manage/incoming');
      console.log('to verify, then return here.');
      await prompt('Press Enter to release the number now (or Ctrl+C to leave it live): ');
    } else {
      console.log('\n[--auto-release] Skipping inspection pause.');
    }

    // === 7. Release ===
    header('Step 7 — Release');
    const t7 = Date.now();
    await releaseNumber(PHONE_SID);
    console.log('Released: ' + PHONE_SID);
    console.log('Release took ' + ms(t7));

    // === Summary ===
    header('Summary');
    console.log('Total elapsed:    ' + ms(t0));
    console.log('Number rented:    ' + chosen.phone_number);
    console.log('Released cleanly: yes');
    console.log('');
    console.log('Cost note: Twilio bills US local numbers at ~$1.15/month, prorated.');
    console.log('Quick rentals (< 1 hour) typically do not generate a bill, but up to');
    console.log('$1.15 may appear on your next invoice.');

    rl.close();
    process.exit(0);
  } catch (err) {
    console.error('\n========================================================');
    console.error('Error during configure / verify / release.');
    console.error('The purchased number may STILL BE ACTIVE in your account.');
    console.error('SID to clean up manually: ' + PHONE_SID);
    console.error('========================================================');
    rl.close();
    process.exit(5);
  }
})().catch(err => {
  console.error('\nFatal error in test harness:');
  console.error(err);
  rl.close();
  process.exit(99);
});
