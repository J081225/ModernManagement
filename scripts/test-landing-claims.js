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
// The honesty section (id="honesty") is the ONE place absent features may
// be NAMED — as things she does NOT do. LC1/LC2 run on the page MINUS that
// section; LC10 holds the section itself to truthful "doesn't do" framing.
const honestMatch = page.match(/<section class="honest"[\s\S]*?<\/section>/);
const honest = honestMatch ? honestMatch[0] : '';
const pageNoHonest = honest ? page.replace(honest, '') : page;
const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');

const DEMO_NUMBER_TEL = 'tel:+13322494333';

(async () => {
  // ---- LC1: anti-list features never appear as claims (honesty section
  // exempt — naming them as NOT built is its whole job) ----
  {
    const hits = plans.ANTI_LIST.filter((a) => pageNoHonest.includes(a.label)).map((a) => a.label);
    check('LC1: none of the 5 nonexistent features (anti-list) appear in active landing copy outside the honesty section',
      hits.length === 0, JSON.stringify(hits));
  }

  // ---- LC2: gated claims stay out — SMS texting + Arabic (honesty
  // section exempt for the same reason) ----
  {
    // The page may say the demo "will never text you" (a true negative);
    // what it may NOT do is CLAIM texting as a feature.
    const smsClaim = /texts back|handles SMS|text conversations|by text/i.test(pageNoHonest);
    const arabic = /Arabic/i.test(pageNoHonest);
    check('LC2: no SMS-as-feature claim (A2P pending) and no Arabic claim in active copy outside the honesty section',
      !smsClaim && !arabic, JSON.stringify({ smsClaim, arabic }));
  }

  // ---- LC10: the honesty section exists and stays TRUTHFUL — every item
  // framed as not-yet, each with a "Flips when true" note. A rewrite that
  // turns a doesn't-do item into a feature claim fails here. ----
  {
    const exists = honest.length > 0 && /What she doesn&rsquo;t do yet|What she doesn't do yet/.test(honest);
    const items = (honest.match(/class="honest-item/g) || []).length;
    const flips = (honest.match(/Flips when true/g) || []).length;
    const texting = /carrier review|pending carrier/i.test(honest);
    const languages = /native.speaker/i.test(honest);
    const reminders = /Not built yet/.test(honest);
    const multiStaff = /One owner per business/i.test(honest);
    check('LC10: the honesty section exists with 4 truthfully-framed items (carrier review, native-speaker gate, "Not built yet" reminders, one-owner multi-staff), each carrying a "Flips when true" note',
      exists && items === 4 && flips === 4 && texting && languages && reminders && multiStaff,
      JSON.stringify({ exists, items, flips, texting, languages, reminders, multiStaff }));
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

  // ---- LC8: salon-narrowed audience language is RETIRED site-wide
  // (2026-08-16 rulings: the audience is "businesses that take
  // bookings"). Bans both the "salons & barbershops" phrase AND the
  // salon-narrowed founding line ("first 10–15 salons") in every
  // public + views HTML file. ----
  {
    const dirs = [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', 'views')];
    const phrase = /salons\s*(?:&amp;|&|and)\s*barbershops|barbershops\s*(?:&amp;|&|and)\s*salons|10\s*(?:&ndash;|–|-)\s*15 salons/i;
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.html') && phrase.test(fs.readFileSync(p, 'utf8'))) hits.push(entry.name);
      }
    };
    dirs.forEach(walk);
    check('LC8: salon-narrowed language is retired in ALL public/views HTML — no "salons & barbershops", no "first 10–15 salons" (founding audience is businesses)',
      hits.length === 0, JSON.stringify(hits));
  }

  // ---- LC9: proof frames are REAL captures or the honest empty state —
  // never a mock, stock image, or hand-built UI standing in as real
  // (sequencing ruling 2026-08-16). Every .proof-frame must hold either
  // an <img> from /img/product/ (the real-capture folder) or the literal
  // honest empty line; and ANY <img> on the page must come from
  // /img/product/. ----
  {
    const frames = pageRaw.split('class="proof-frame"').length - 1;
    const empties = (pageRaw.match(/Real screenshot arriving/g) || []).length;
    const productImgs = (pageRaw.match(/<img[^>]+src="\/img\/product\//g) || []).length;
    const allImgs = (pageRaw.match(/<img/g) || []).length;
    const framesHonest = frames > 0 && (empties + productImgs) >= frames;
    const noForeignImgs = allImgs === productImgs;
    check('LC9: every proof frame is a real /img/product/ capture or the honest "Real screenshot arriving" empty state, and no other <img> exists on the page',
      framesHonest && noForeignImgs,
      JSON.stringify({ frames, empties, productImgs, allImgs }));
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
