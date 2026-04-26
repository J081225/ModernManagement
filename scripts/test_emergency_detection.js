// Manual dev tool for the AI Auto-Reply Safety Layer 1 keyword detector.
// Not an automated test suite — run by hand when you change the keyword
// list or the regex shape.
//
// Usage:  node scripts/test_emergency_detection.js
//
// What's covered (per the spec at sub-step B):
//   - True positives (keyword in real emergency context)
//   - True positives (keyword in non-emergency context — safer to flag)
//   - False positives we DO NOT want (words that contain a keyword
//     substring: "fireman", "alarming", "alarmed", "firework")
//   - Multi-word phrases ("gas leak", "burst pipe")
//   - Multiple keywords in one message
//   - Clean messages (rent / lease questions)
//   - Capitalization variants
//
// IMPORTANT — keep this file in sync with server.js manually. The keyword
// list and regex below are duplicated from the real implementation so the
// script can run standalone (no DB, no Express boot). If you change the
// real list in server.js, also change it here. The whole point of this
// tool is to verify the detector behaves the way you think it does, so
// drift defeats the purpose.

// ---- Mirror of server.js detector (sub-step B) -----------------------

const EMERGENCY_KEYWORDS = [
  // Fire / smoke
  'fire', 'smoke', 'burning', 'alarm',
  // Gas
  'gas leak', 'gas smell', 'propane',
  // Water
  'flood', 'flooding', 'water leak', 'burst pipe', 'sewage',
  // Safety
  'emergency', 'urgent', 'threat', 'threatening', 'weapon', 'gun', 'knife',
  'intruder', 'break-in', 'broken in',
  // Health
  'hurt', 'injured', 'bleeding', 'unconscious', 'dead', 'body', 'overdose',
  // Severity markers
  '911', 'asap urgent', 'life threatening',
];

function _escapeRegexChars(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const EMERGENCY_KEYWORD_REGEX = new RegExp(
  '\\b(' + EMERGENCY_KEYWORDS.map(_escapeRegexChars).join('|') + ')\\b',
  'gi'
);

function detectEmergency(text) {
  if (!text) return [];
  const matches = String(text).match(EMERGENCY_KEYWORD_REGEX);
  if (!matches) return [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = m.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

// ---- Test cases ------------------------------------------------------
// [label, input, expected]
//   expected = array of lower-cased keywords expected to match (any order)
//   expected = []  → should NOT match anything
const tests = [
  // --- Single keyword in real emergency context (should match) ---
  ['fire in real context',           "There's a fire in the kitchen",            ['fire']],
  ['gas leak phrase',                'I smell a gas leak from the basement',     ['gas leak']],
  ['burst pipe phrase',              'There is a burst pipe in 4B',              ['burst pipe']],
  ['flooding mid-sentence',          "There's water flooding everywhere",        ['flooding']],
  ['911 numeric',                    'Call 911 right now',                       ['911']],
  ['emergency word',                 'This is an emergency',                     ['emergency']],
  ['intruder word',                  'There is an intruder in the building',     ['intruder']],
  ['break-in hyphenated',            'I think there was a break-in last night',  ['break-in']],
  ['unconscious word',               'My neighbor is unconscious in the hall',   ['unconscious']],
  ['life threatening phrase',        'This is a life threatening situation',     ['life threatening']],

  // --- True positives in non-emergency context (still match by design;
  //     better to over-flag than miss a real emergency) ---
  ['fire alarm inspection still flags',  'Fire alarm inspection scheduled for Tuesday', ['fire', 'alarm']],
  ['urgent question still flags',        'Urgent question about my lease renewal',      ['urgent']],

  // --- Words that contain a keyword substring but should NOT match ---
  ['"fireman" should not match',     'The fireman said hello yesterday',         []],
  ['"alarming" should not match',    'The alarming news arrived this morning',   []],
  ['"alarmed" should not match',     'I felt alarmed by the noise',              []],
  ['"firework" should not match',    'Fireworks tonight at the park',            []],
  ['"begun" should not match "gun"', 'The painting has begun on the third floor', []],

  // --- Multiple keywords in a single message ---
  ['fire AND smoke combined',        'Fire and smoke in 3B',                     ['fire', 'smoke']],

  // --- Clean messages (no keywords at all) ---
  ['rent due date',                  "What's the rent due date this month?",     []],
  ['lease renewal clean',            'When does my lease end?',                  []],
  ['package question clean',         'Package was delivered to the wrong address', []],

  // --- Capitalization variants (case-insensitive expected) ---
  ['ALL UPPERCASE matches',          'FIRE in the building',                     ['fire']],
  ['Title Case matches',             'Fire in the building',                     ['fire']],
  ['MiXeD case matches',             'There is a GAS LEAK in unit 5',            ['gas leak']],
];

// ---- Runner ----------------------------------------------------------

function arraysEqualAsSets(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map(s => s.toLowerCase()));
  for (const x of b) if (!sa.has(String(x).toLowerCase())) return false;
  return true;
}

let passed = 0;
let failed = 0;
const failures = [];

console.log('Emergency keyword detector — manual verification\n');
console.log('='.repeat(70));

tests.forEach(([label, input, expected], i) => {
  const got = detectEmergency(input);
  const ok = arraysEqualAsSets(got, expected);
  const status = ok ? 'PASS' : 'FAIL';

  console.log(`\nTest ${i + 1}: ${label}`);
  console.log(`  Input:    ${JSON.stringify(input)}`);
  console.log(`  Expected: ${JSON.stringify(expected)}`);
  console.log(`  Got:      ${JSON.stringify(got)}`);
  console.log(`  ${status}`);

  if (ok) passed++;
  else { failed++; failures.push({ i: i + 1, label, expected, got, input }); }
});

console.log('\n' + '='.repeat(70));
console.log(`Results: ${passed} passed, ${failed} failed (out of ${tests.length})`);
console.log('='.repeat(70));

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  Test ${f.i} — ${f.label}`);
    console.log(`    Input:    ${JSON.stringify(f.input)}`);
    console.log(`    Expected: ${JSON.stringify(f.expected)}`);
    console.log(`    Got:      ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
process.exit(0);
