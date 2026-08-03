// scripts/gates/run-all.js — AD9. The harness runner that closes the
// durability lesson: the AD3-AD7 gates lived in a temp scratchpad and
// were lost to cleanup. This discovers every in-repo suite (scripts/
// test-*.js), runs each in its own process, and reports a single
// pass/fail — so `npm test` is the whole harness, in the repo, forever.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptsDir = path.join(__dirname, '..');
const suites = fs.readdirSync(scriptsDir)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

if (!suites.length) {
  console.error('run-all: no scripts/test-*.js suites found');
  process.exit(1);
}

let totalPass = 0, totalFail = 0, failedSuites = [];
const line = (s) => console.log(s);
line('Running ' + suites.length + ' in-repo gate suites\n' + '='.repeat(48));

for (const suite of suites) {
  const res = spawnSync(process.execPath, [path.join(scriptsDir, suite)], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  // Each suite prints a footer: "N/M — <name> PASSED|FAILED".
  const m = out.match(/(\d+)\/(\d+)\s+—\s+.*?(PASSED|FAILED)/);
  if (m) {
    const [, got, total, verdict] = m;
    totalPass += Number(got);
    totalFail += Number(total) - Number(got);
    if (verdict === 'FAILED' || res.status !== 0) failedSuites.push(suite);
    line((verdict === 'PASSED' && res.status === 0 ? 'ok   ' : 'FAIL ') + suite.padEnd(34) + got + '/' + total);
  } else {
    // No parseable footer — treat a non-zero exit as failure, and
    // surface the tail so the break is visible, not swallowed.
    failedSuites.push(suite);
    line('ERR  ' + suite.padEnd(34) + '(no footer; exit ' + res.status + ')');
    line(out.trim().split('\n').slice(-3).map((l) => '       ' + l).join('\n'));
  }
}

line('='.repeat(48));
line('checks: ' + totalPass + ' passed, ' + totalFail + ' failed across ' + suites.length + ' suites');
if (failedSuites.length) {
  line('FAILED suites: ' + failedSuites.join(', '));
  process.exit(1);
}
line('ALL GREEN');
process.exit(0);
