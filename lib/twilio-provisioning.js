// Phase B B3: Twilio number-provisioning helpers.
//
// Used by:
//   - scripts/test_twilio_provisioning.js (interactive dev tool)
//   - B4 signup orchestrator (post-Stripe-payment account creation,
//     future session)
//
// Design choices:
//   - Lazy client init: this file can be required even in environments
//     without TWILIO_ACCOUNT_SID/AUTH_TOKEN. Helpers throw on first call
//     instead of at require-time.
//   - Each helper logs a structured failure line with a prefix before
//     re-throwing — gives symmetrical context whether or not the caller
//     also logs.
//   - No DB access: this lib is pure Twilio API surface. Persistence
//     of workspaces.twilio_phone_number / twilio_phone_sid / etc. is
//     B4 orchestrator's responsibility.

const twilio = require('twilio');

let _client = null;
function getClient() {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error('Twilio credentials missing — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env');
    }
    _client = twilio(sid, token);
  }
  return _client;
}

// Search for available US local numbers in the given area code.
// Returns up to `limit` candidates with phone_number, locality, region,
// and capabilities flags.
//
// Twilio errors of note:
//   21452 — No phone numbers found in area code
//   21703 — Invalid value for areaCode
async function searchAvailableNumbers(areaCode, limit = 5) {
  if (!/^[0-9]{3}$/.test(String(areaCode))) {
    throw new Error('areaCode must be a 3-digit string or number, e.g. 718');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 30) {
    throw new Error('limit must be an integer 1-30');
  }
  try {
    const results = await getClient().availablePhoneNumbers('US').local.list({
      areaCode: Number(areaCode),
      limit,
    });
    return results.map(n => ({
      phone_number: n.phoneNumber,
      locality:     n.locality,
      region:       n.region,
      capabilities: n.capabilities,
    }));
  } catch (err) {
    console.error('[twilio-provisioning] searchAvailableNumbers failed: code=' + (err.code || 'unknown') + ', message=' + err.message);
    throw err;
  }
}

// Purchase a specific phone number. Twilio confirms the purchase and
// the number is immediately attached to your account (and starts
// accruing rental charges per Twilio's billing policy).
//
// Twilio errors of note:
//   21422 — Number not available (someone else bought it between
//           your search and purchase, or it was released back to pool)
//   20003 — Authentication failed (bad SID / token)
//   20429 — Rate limited
async function purchaseNumber(phoneNumber) {
  if (!/^\+1[0-9]{10}$/.test(String(phoneNumber))) {
    throw new Error('phoneNumber must be in E.164 format, e.g. +17185551234');
  }
  try {
    const result = await getClient().incomingPhoneNumbers.create({ phoneNumber });
    return {
      phone_sid:    result.sid,
      phone_number: result.phoneNumber,
      capabilities: result.capabilities,
    };
  } catch (err) {
    console.error('[twilio-provisioning] purchaseNumber failed: code=' + (err.code || 'unknown') + ', message=' + err.message);
    throw err;
  }
}

// Configure SMS + Voice webhooks on a purchased number.
//
// Note: the recording and transcription URLs are set dynamically inside
// the TwiML response from /api/voice/incoming, not on the number itself.
// We only set smsUrl + voiceUrl here, matching the existing webhook
// handler shape in server.js.
async function configureNumberWebhooks(phoneSid, webhookBaseUrl) {
  if (!phoneSid) throw new Error('phoneSid required');
  if (!webhookBaseUrl) throw new Error('webhookBaseUrl required');
  // Strip trailing slash so we don't end up with .../api//sms/incoming
  const baseUrl = String(webhookBaseUrl).replace(/\/$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error('webhookBaseUrl must start with http:// or https://');
  }
  try {
    const result = await getClient().incomingPhoneNumbers(phoneSid).update({
      smsUrl:   baseUrl + '/api/sms/incoming',
      voiceUrl: baseUrl + '/api/voice/incoming',
    });
    return {
      phone_sid: result.sid,
      sms_url:   result.smsUrl,
      voice_url: result.voiceUrl,
    };
  } catch (err) {
    console.error('[twilio-provisioning] configureNumberWebhooks failed: code=' + (err.code || 'unknown') + ', message=' + err.message);
    throw err;
  }
}

// Re-fetch the current config for an owned number. Used by the test
// harness's verify step (compare smsUrl / voiceUrl against what we
// just set), and useful for B4 / future admin tools that want to
// display the current Twilio-side state of a workspace's number.
async function fetchNumberConfig(phoneSid) {
  if (!phoneSid) throw new Error('phoneSid required');
  try {
    const result = await getClient().incomingPhoneNumbers(phoneSid).fetch();
    return {
      phone_sid:    result.sid,
      phone_number: result.phoneNumber,
      sms_url:      result.smsUrl,
      voice_url:    result.voiceUrl,
    };
  } catch (err) {
    console.error('[twilio-provisioning] fetchNumberConfig failed: code=' + (err.code || 'unknown') + ', message=' + err.message);
    throw err;
  }
}

// Release a number back to Twilio. Used for cleanup (test harness)
// and for the cancellation flow (Phase D admin tools).
async function releaseNumber(phoneSid) {
  if (!phoneSid) throw new Error('phoneSid required');
  try {
    await getClient().incomingPhoneNumbers(phoneSid).remove();
    return { released: true, phone_sid: phoneSid };
  } catch (err) {
    console.error('[twilio-provisioning] releaseNumber failed: code=' + (err.code || 'unknown') + ', message=' + err.message);
    throw err;
  }
}

module.exports = {
  searchAvailableNumbers,
  purchaseNumber,
  configureNumberWebhooks,
  fetchNumberConfig,
  releaseNumber,
};
