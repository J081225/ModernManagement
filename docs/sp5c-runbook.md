# SP5c Runbook — Re-enabling Twilio Signature Validation

The code half is built and suite-proven. The **env flip is a Render
dashboard action** (no Render API key exists locally), so this is the
exact instruction for Jay, plus the verification to run after.

## Do NOT run this until both are true

1. **SP5a is live** (vertical-aware `configureNumberWebhooks` deployed).
2. **SP5b is applied and verified** — ws3's voice URL repointed to the
   canonical host and the dry-run reports zero drift.

**Why the order is non-negotiable:** while ws3's voice URL still points
at `modernmanagement.onrender.com`, Twilio signs *that* URL. The
validator now also accepts the origin host (SP5c's multi-candidate
fix), so the flip would *probably* survive — but the repair is the
thing that makes the configuration honest, and doing the security flip
first means debugging two changes at once if anything misbehaves.
Repair first, then flip.

## What currently happens (the state being fixed)

`TWILIO_VALIDATE_WEBHOOKS=false` is set in the Render environment, so
`validateTwilioSignature` takes its escape hatch and **every Twilio
route accepts unsigned requests**. Verified by probe: a POST to
`/api/voice/incoming` with **no** `X-Twilio-Signature` header returns
200 TwiML. Anyone who knows the URLs can inject forged inbound SMS,
voicemail recordings, or transcriptions.

Six routes are affected: `/api/sms/incoming`, `/api/voice/incoming`,
`/api/voice/recording`, `/api/voice/transcription`,
`/api/voice/relay-incoming`, `/api/email/incoming`.

## The flip

**Render dashboard → the Modern Management service → Environment.**

- **Variable:** `TWILIO_VALIDATE_WEBHOOKS`
- **Action:** **delete the variable** (preferred), or set its value to
  `true`.
- **Why delete is preferred:** the middleware only bypasses on the
  exact string `'false'`. Deleting it removes the foot-gun entirely;
  any other value (including a typo) already means "validate".
- Save. Render redeploys automatically; wait for the deploy to go live
  (~60–90s) before probing.

## The verification probe (run after the deploy is live)

The same four-way probe from the SP5 investigation, with **inverted
expectations** — unsigned requests must now be refused:

```bash
node -e "
require('dotenv').config();
const crypto = require('crypto');
const tok = process.env.TWILIO_AUTH_TOKEN;
const params = { CallSid: 'CAverify', From: '+15555550123', To: '+18555350785' };
const body = new URLSearchParams(params).toString();
const sign = (url) => {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', tok).update(Buffer.from(data, 'utf-8')).digest('base64');
};
const post = async (label, url, sig) => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sig) headers['X-Twilio-Signature'] = sig;
  const res = await fetch(url, { method: 'POST', headers, body });
  console.log(label + ' -> HTTP ' + res.status);
};
(async () => {
  const canon = 'https://modernmanagementapp.com/api/voice/incoming';
  await post('1. VALID signature, canonical host   (expect 200)', canon, sign(canon));
  await post('2. NO signature header               (expect 403)', canon, null);
  await post('3. BOGUS signature                   (expect 403)', canon, 'OBVIOUSLY_INVALID');
  const origin = 'https://modernmanagement.onrender.com/api/voice/incoming';
  await post('4. VALID signature, origin host      (expect 200)', origin, sign(origin));
})();
"
```

**Pass criteria: 200 / 403 / 403 / 200.**
- Probe 1 proves legitimate Twilio traffic still works.
- Probes 2 and 3 prove the hole is closed — this is the whole point.
- Probe 4 proves the multi-candidate fix works: a call arriving via the
  origin host is still accepted, so no number is stranded by the flip.

## If something goes wrong

Set `TWILIO_VALIDATE_WEBHOOKS=false` again in the dashboard — the
escape hatch is deliberately retained for exactly this. Then capture
the `[twilio-validate] Bad signature for ... — tried: ...` log lines;
SP5c's logging prints every candidate URL it checked, which names the
mismatch directly.

## Watch after the flip

For the first hours, watch Render logs for `[twilio-validate] Bad
signature`. A steady trickle means some number is configured with a
host we don't recognize — the log names the candidates tried, so the
fix is to repoint that number (SP5b) rather than to disable
validation again.
