// scripts/test-landing-claims.js — LP landing-rebuild claims gate (LP2c).
//
// The rebuilt landing page (public/landing-next.html, /lp-preview until the
// R1 flip) lives under the claims census + the LP2 craft rules. This gate
// pins, at every commit:
//   - the anti-list (5 nonexistent features) never appears;
//   - the GATED claims (SMS texting, Arabic) stay out of active copy;
//   - no fabricated testimonials (no <blockquote> until quotes are EARNED);
//   - no placeholder tokens (lorem, REPLACE WITH, xxx, TODO) — ever;
//   - the demo-line claims are TRUE: the tel: links carry the real demo
//     number, and "it will never text you" is backed by the structural
//     is_demo SMS block in the engine (copy pinned to mechanism);
//   - headline discipline: the h1 is 8 words or fewer.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const plans = require('../lib/plans');
const pageRaw = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing-next.html'), 'utf8');
// Active copy = what renders. Strip HTML comments (flip-ready lines live there).
const page = pageRaw.replace(/<!--[\s\S]*?-->/g, '');
const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');

const DEMO_NUMBER_TEL = 'tel:+13322494333';

(async () => {
  // ---- LC1: anti-list features never appear in active copy ----
  {
    const hits = plans.ANTI_LIST.filter((a) => page.includes(a.label)).map((a) => a.label);
    check('LC1: none of the 5 nonexistent features (anti-list) appear in active landing copy',
      hits.length === 0, JSON.stringify(hits));
  }

  // ---- LC2: gated claims stay out — SMS texting + Arabic ----
  {
    // The page may say the demo "will never text you" (a true negative);
    // what it may NOT do is CLAIM texting as a feature.
    const smsClaim = /texts back|handles SMS|text conversations|by text/i.test(page);
    const arabic = /Arabic/i.test(page);
    check('LC2: no SMS-as-feature claim (A2P pending) and no Arabic claim in active copy',
      !smsClaim && !arabic, JSON.stringify({ smsClaim, arabic }));
  }

  // ---- LC3: no fabricated testimonials ----
  {
    // Structural: zero <blockquote> until quotes are EARNED (founding
    // customers). The fake-Sarah pattern (attribution dash + "owner")
    // is also banned outright.
    const blockquote = /<blockquote/i.test(page);
    const attributionPattern = /&mdash;\s*[A-Z][a-z]+,\s*[a-z]+\s+owner|—\s*[A-Z][a-z]+,\s*[a-z]+\s+owner/.test(page);
    check('LC3: no <blockquote> and no "— Name, x owner" attribution pattern (testimonials must be earned, never fabricated)',
      !blockquote && !attributionPattern, JSON.stringify({ blockquote, attributionPattern }));
  }

  // ---- LC4: no placeholder tokens, ever (checked in RAW source — comments included) ----
  {
    const tokens = ['REPLACE WITH', 'lorem', 'Lorem', 'PLACEHOLDER', 'TODO', 'FIXME', 'xxx', 'XXX', 'TKTK'];
    const hits = tokens.filter((t) => pageRaw.includes(t));
    check('LC4: zero placeholder tokens in the page source (comments included)',
      hits.length === 0, JSON.stringify(hits));
  }

  // ---- LC5: the demo number is real and consistent ----
  {
    const telLinks = (pageRaw.match(/tel:\+\d+/g) || []);
    const allCorrect = telLinks.length >= 2 && telLinks.every((t) => t === DEMO_NUMBER_TEL);
    check('LC5: every tel: link is the real purchased demo number (+1 332 249 4333), hero + mini-CTA',
      allCorrect, JSON.stringify(telLinks));
  }

  // ---- LC6: "it will never text you" is backed by the structural block ----
  {
    const claim = /never text/i.test(page);
    const mechanism = /is_demo[\s\S]{0,300}SUPPRESSED outbound SMS from DEMO workspace/.test(engine)
      || /SUPPRESSED outbound SMS from DEMO workspace/.test(engine);
    check('LC6: the "never texts you" claim is pinned to the engine\'s is_demo SMS hard-block (copy and mechanism fail together)',
      claim && mechanism, JSON.stringify({ claim, mechanism }));
  }

  // ---- LC8: "salons & barbershops" is RETIRED site-wide (2026-08-16
  // ruling: the audience is "businesses that take bookings"). Scans every
  // public + views HTML file, not just the new landing. ----
  {
    const dirs = [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', 'views')];
    const phrase = /salons\s*(?:&amp;|&|and)\s*barbershops|barbershops\s*(?:&amp;|&|and)\s*salons/i;
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.html') && phrase.test(fs.readFileSync(p, 'utf8'))) hits.push(entry.name);
      }
    };
    dirs.forEach(walk);
    check('LC8: the retired "salons & barbershops" phrase appears in NO public/views HTML (audience is "businesses that take bookings")',
      hits.length === 0, JSON.stringify(hits));
  }

  // ---- LC7: headline discipline — h1 is 8 words or fewer ----
  {
    const m = page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const text = m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const words = text ? text.split(' ').filter(Boolean) : [];
    check('LC7: the h1 is 8 words or fewer (craft rule) — "' + text + '"',
      words.length > 0 && words.length <= 8, String(words.length) + ' words');
  }

  console.log(`${pass}/${pass + fail} — landing-claims gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
