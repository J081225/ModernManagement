// scripts/test-square-security.js — SQ security-hardening gate.
// Pins addendum items 1, 2, 4, 5, 8 (items 3, 6 live in
// test-square-webhook; item 7 in the expiry pin below).
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

(function () {
  // ---- SS1 [item 2]: all three money-flow endpoints re-auth ----
  {
    const start = /app\.post\('\/api\/square\/connect\/start'[\s\S]{0,400}credentials\._reauth\(pool, req\.session\.userId, \(req\.body \|\| \{\}\)\.current_password/.test(srv);
    const sw = /app\.patch\('\/api\/workspace\/payment-processor'[\s\S]{0,600}credentials\._reauth\(pool, req\.session\.userId/.test(srv);
    const disc = /app\.post\('\/api\/square\/disconnect'[\s\S]{0,1600}credentials\._reauth\(pool, req\.session\.userId/.test(srv);
    check('SS1 [item 2]: connect, switch, and disconnect ALL re-auth via the shared _reauth (current_password) — money-flow changes are credential-class events',
      start && sw && disc, JSON.stringify({ start, sw, disc }));
  }

  // ---- SS2 [item 2]: each sends an AD6 security notice to the anchor ----
  {
    const helper = srv.includes('async function sendSquareSecurityNotice(user, action)')
      && srv.includes('credentials.sendSecurityNotice({ sendgrid: sgMail, env: process.env }, user && user.email');
    const connectNotice = srv.includes("sendSquareSecurityNotice(re.user, 'connect')");
    const switchNotice = srv.includes("sendSquareSecurityNotice(re.user, 'switch')");
    const discNotice = srv.includes("sendSquareSecurityNotice(re.user, 'disconnect')");
    check('SS2 [item 2]: connect/switch/disconnect each send an AD6 security notice to the anchor email (a payment-change alert)',
      helper && connectNotice && switchNotice && discNotice,
      JSON.stringify({ helper, connectNotice, switchNotice, discNotice }));
  }

  // ---- SS3 [item 1]: OAuth state is session-bound + single-use ----
  {
    const boundToSession = srv.includes('.update(`${payload}.${sid}`)') && srv.includes('const sid = req.sessionID');
    const singleUse = srv.includes('req.session.squareStateNonce = nonce')
      && srv.includes('req.session.squareStateNonce !== nonce) return null')
      && srv.includes('delete req.session.squareStateNonce');
    const shortLived = srv.includes('10 * 60 * 1000) return null');
    check('SS3 [item 1]: the OAuth state is signed over workspace+session, verified against the SAME session, single-use (nonce stashed then consumed), and 10-min expired',
      boundToSession && singleUse && shortLived, JSON.stringify({ boundToSession, singleUse, shortLived }));
  }

  // ---- SS4 [item 4]: token perimeter — encrypted columns never leave the server ----
  {
    // no API response / json / log ever includes the *_enc columns or a
    // decrypted token. Scan server.js for the columns appearing in a
    // res.json / console log context.
    const encCols = ['square_access_token_enc', 'square_refresh_token_enc'];
    // they may appear ONLY in: the SELECT for the payment path, the
    // callback UPDATE, and the disconnect UPDATE (all writes/reads for
    // internal use) — never in a res.json(...) or console.*(...).
    const leakInJson = encCols.some((c) => new RegExp('res\\.json\\([^;]*' + c).test(srv));
    const leakInLog = encCols.some((c) => new RegExp('console\\.(log|error|warn)\\([^;]*' + c).test(srv));
    // and the plan-summary payload (the main UI read) never carries them
    const planClean = !/res\.json\(\{[\s\S]{0,1500}square_access_token/.test(srv);
    // the decrypted token variable is never logged
    const decLeak = /console\.[a-z]+\([^;]*decryptToken\(/.test(srv);
    check('SS4 [item 4]: the Square token columns and decrypted tokens never appear in any res.json or console log — the perimeter holds',
      !leakInJson && !leakInLog && planClean && !decLeak,
      JSON.stringify({ leakInJson, leakInLog, planClean, decLeak }));
  }

  // ---- SS5 [item 5]: public callback errors are bland (no oracle) ----
  {
    // every fail() on the public callback uses the SAME bland sentence;
    // no "connected"/"not connected"/"expired" leaks to the browser.
    const bland = srv.includes('The connection could not be completed. Please start again from Settings.');
    const noOracle = !/fail\('(Square reported|The connection link expired|already connected|not connected)/.test(srv);
    check('SS5 [item 5]: the public OAuth callback returns one bland message for every failure (forged/expired/replayed/wrong-session) — no connection-state oracle',
      bland && noOracle, JSON.stringify({ bland, noOracle }));
  }

  // ---- SS6 [item 8]: disconnect warns with count, completion survives ----
  {
    const warns = srv.includes('needs_confirm: true, pending_count: pendingCount')
      && srv.includes("processor = 'square' AND status = 'pending'");
    const clearsTokens = /square_status = 'revoked'[\s\S]{0,200}square_access_token_enc = NULL/.test(srv);
    // completion-still-works is structural: the webhook lookup uses
    // (processor, processor_ref) and never a token — assert the handler
    // has no token read.
    const webhookTokenless = !/processSquarePaymentCompleted[\s\S]{0,400}access_token/.test(srv);
    const uiConfirm = app.includes('async function disconnectSquare') && app.includes('data.needs_confirm');
    check('SS6 [item 8]: disconnect warns with the pending-request count (two-step confirm) and clears tokens; pending payments still complete afterward (the webhook needs no token)',
      warns && clearsTokens && webhookTokenless && uiConfirm,
      JSON.stringify({ warns, clearsTokens, webhookTokenless, uiConfirm }));
  }

  console.log(`${pass}/${pass + fail} — square-security gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
