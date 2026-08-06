// scripts/eval-arabic.js — ST7a's launch gate (the ST6 ruling).
//
// LIVE model eval — deliberately named eval-*, NOT test-*, so the
// deterministic harness never calls the API. Run manually before the
// Arabic claim ships (and after any prompt change touching the ar
// branch): node scripts/eval-arabic.js
//
// Drives the REAL buildSystemPrompt (the actual ar branch — no
// simulation) against the three Dearborn scenarios, then checks the
// two failure modes ST6 observed plus the follow rule:
//   E1 price-quoting: the $120 Color price must appear (ST6 saw it
//      dodged with "starts from a certain price").
//   E2 feminine register: no masculine first-person آسف/سعيد forms.
//   E3 follow-the-customer: an English message gets an English reply.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));
const { ANTHROPIC_MODEL } = require(path.join(__dirname, '..', 'lib', 'config'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const workspace = {
  id: 99, business_name: 'Salon Yasmin', vertical: 'professional-services',
  timezone: 'America/Detroit', customer_language: 'ar',
};
const menu = [
  { id: 1, name: 'Haircut', type: 'service', base_price_cents: 4500, duration_minutes: 45, active: true },
  { id: 2, name: 'Color', type: 'service', base_price_cents: 12000, duration_minutes: 90, active: true },
];
const knowledge = [{ title: 'Hours of Operation', content: 'Tue-Sat 10am-7pm, closed Sun-Mon' }];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

async function ask(msg) {
  const system = buildSystemPrompt({ workspace, contact: null, knowledge, callerAppointments: [], menu, thread: {}, channel: 'sms' });
  const r = await anthropic.messages.create({
    model: ANTHROPIC_MODEL, max_tokens: 300, system,
    messages: [{ role: 'user', content: msg }],
  });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}

(async () => {
  // E1 — the price dodge, retested through the real ar branch
  const price = await ask('السلام عليكم، كم سعر صبغة الشعر عندكم؟');
  check('E1 [price-quoting]: the Color price ($120) is quoted exactly, not hedged',
    /120/.test(price) && !/سعر معين|يعتمد على/.test(price), price.slice(0, 140));

  // E2 — feminine register under an apology-inducing scenario
  const apology = await ask('مرحبا، جيت امبارح على الموعد وما لقيت حدا بالمحل! شو صار؟');
  check('E2 [feminine register]: no masculine first-person forms (آسف/سعيد/متأكد as أنا-forms); feminine or neutral phrasing only',
    !/أنا آسف(?!ة)|انا اسف(?!ه|ة)|أنا سعيد(?!ة)|أنا متأكد(?!ة)/.test(apology), apology.slice(0, 140));

  // E3 — follow-the-customer: English in, English out
  const english = await ask('Hi, do you have anything open Saturday morning for a haircut?');
  check('E3 [follow-the-customer]: an English message gets an English reply (no Arabic forced back)',
    !/[؀-ۿ]/.test(english), english.slice(0, 140));

  console.log(`${pass}/${pass + fail} — ARABIC EVAL GATE ${fail ? 'FAILED (the claim must not ship)' : 'PASSED'}`);
  console.log('E1 sample: ' + price.replace(/\n+/g, ' | ').slice(0, 200));
  console.log('E2 sample: ' + apology.replace(/\n+/g, ' | ').slice(0, 200));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EVAL FAIL: ' + e.message); process.exit(1); });
