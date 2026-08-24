// scripts/test-email-routing.js — AD9, rebuild of the lost `email`
// gate (IB5). The routing logic is inline + module-scoped in server.js
// (lookupUserByEmailAlias, the /api/email/incoming handler), so this is
// a slim gate: REPLAY the recipient-key routing + fail-loud decision
// against a fixture, and SOURCE-PIN that server.js implements exactly
// that (the recipient address is the routing key; unroutable mail is a
// loud drop, never a sender-guess).
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Replay of the handler's routing loop: extract every recipient
// address, resolve each via the alias lookup, first match wins,
// no match -> null (the caller then drops loud).
const ADDR_RE = /[\w.+-]+@[\w.-]+/gi;
async function routeInbound(toRaw, resolve) {
  const toAddresses = String(toRaw).match(ADDR_RE) || [];
  let userId = null;
  for (const addr of toAddresses) {
    userId = await resolve(addr);
    if (userId) break;
  }
  return { toAddresses, userId };
}

// Replay of lookupUserByEmailAlias: alias first, then email_accounts,
// case-insensitive.
function makeResolver({ aliases = {}, accounts = {} }) {
  return async (addr) => {
    const a = String(addr).toLowerCase();
    if (aliases[a]) return aliases[a];
    if (accounts[a]) return accounts[a];
    return null;
  };
}

(async () => {
  // ---- EM1: the recipient alias is the routing key ----
  {
    const resolve = makeResolver({ aliases: { 'user-abc@inbound.modernmanagementapp.com': 14 } });
    const r = await routeInbound('user-abc@inbound.modernmanagementapp.com', resolve);
    check('EM1: a recipient matching an inbound alias routes to that owner',
      r.userId === 14, JSON.stringify(r));
  }

  // ---- EM2: alias wins, else a connected email_account matches ----
  {
    const resolve = makeResolver({ accounts: { 'shop@gmail.com': 22 } });
    const r = await routeInbound('shop@gmail.com', resolve);
    check('EM2: no alias but a connected email_account matches -> routes to its user (two-tier lookup)',
      r.userId === 22);
  }

  // ---- EM3: case-insensitive matching ----
  {
    const resolve = makeResolver({ aliases: { 'user-abc@inbound.modernmanagementapp.com': 14 } });
    const r = await routeInbound('User-ABC@Inbound.ModernManagementApp.com', resolve);
    check('EM3: recipient matching is case-insensitive', r.userId === 14);
  }

  // ---- EM4: first matching recipient wins across multiple To addresses ----
  {
    const resolve = makeResolver({ aliases: { 'b@inbound.test': 7 } });
    const r = await routeInbound('a@nowhere.test, b@inbound.test, c@else.test', resolve);
    check('EM4: with several recipients, the first that resolves wins',
      r.toAddresses.length === 3 && r.userId === 7);
  }

  // ---- EM5: no recipient resolves -> unroutable (null), never a sender guess ----
  {
    const resolve = makeResolver({ aliases: { 'someone@inbound.test': 99 } });
    const r = await routeInbound('stranger@example.com', resolve);
    check('EM5: no recipient matches any workspace -> null (the handler then drops loud; the SENDER is never used to guess an owner)',
      r.userId === null);
  }

  // ---- EM6: source-pin — lookupUserByEmailAlias is the two-tier, lowercased lookup ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fnIdx = src.indexOf('async function lookupUserByEmailAlias');
    const fn = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
    const twoTier = /LOWER\(inbound_email_alias\)=\$1/.test(fn) && /email_accounts WHERE LOWER\(email\)=\$1/.test(fn);
    const lowercases = fn.includes('.toLowerCase()');
    check('EM6: lookupUserByEmailAlias checks users.inbound_email_alias then email_accounts.email, both lowercased',
      fnIdx !== -1 && twoTier && lowercases, JSON.stringify({ twoTier, lowercases }));
  }

  // ---- EM6b (VE2): the vanity format routes as-is through the replay ----
  {
    // The mint is <username>@modernmanagementapp.com (lowercase by the
    // username regex). The router lowercases the wire address, so a
    // "Display Name <Addr>" To with mixed case still matches.
    const resolve = makeResolver({ aliases: { 'jayhorton87@modernmanagementapp.com': 14 } });
    const r = await routeInbound('Jay Horton <Jayhorton87@ModernManagementApp.com>', resolve);
    check('EM6b: a vanity <username>@modernmanagementapp.com address routes (case-insensitive, display-name form)',
      r.userId === 14, JSON.stringify(r));
  }

  // ---- EM7: source-pin — the fail-loud drop precedes any DB write ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const guardIdx = src.indexOf('if (!userId) {');
    const region = src.slice(guardIdx, guardIdx + 900);
    // Inside the !userId guard: a structured UNROUTABLE console.error
    // and an early `return` — BEFORE the INSERT INTO messages that
    // follows the guard. No DB write, no notify on the unroutable path.
    const loud = region.includes('[email/incoming] UNROUTABLE') && /console\.error/.test(region);
    const returnsBeforeInsert = region.indexOf('return;') !== -1
      && region.indexOf('return;') < region.indexOf('INSERT INTO messages');
    const structuredDetail = region.includes('JSON.stringify({ to: toAddresses');
    check('EM7: the unroutable branch logs a structured [email/incoming] UNROUTABLE error and RETURNS before any INSERT — a loud drop, not a silent one',
      guardIdx !== -1 && loud && returnsBeforeInsert && structuredDetail,
      JSON.stringify({ loud, returnsBeforeInsert, structuredDetail }));
  }

  // ---- EM8: source-pin — a routed email reaches the brain (engine handoff) ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // After the INSERT, the PS auto-respond path hands the email to the
    // engine with channel 'email'.
    const handoff = /processInboundMessage[\s\S]{0,400}channel: 'email'/.test(src)
      || (src.includes("channel: 'email'") && src.includes('processInboundMessage'));
    check('EM8: a routed inbound email reaches the engine with channel email (the IB5 brain handoff exists)',
      handoff);
  }

  console.log(`${pass}/${pass + fail} — email-routing gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
