// scripts/test-customer-language.js — ST5a suite.
//
// The ruled censuses, enforced: (1) every canned customer string
// declares every supported language variant or this gate fails;
// (2) the three copies of the supported-language set (DB CHECK,
// endpoint, strings module) can never drift apart; (3) the REAL
// prompt builder carries the default-and-follow contract in both
// languages; (4) the rewired sites route through the module with no
// English remnants on the es path.
const path = require('path');
const fs = require('fs');
const { STRINGS, LANGUAGES, customerString, shortDate, longDate } =
  require(path.join(__dirname, '..', 'lib', 'customer-strings'));
const { buildSystemPrompt } = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));
const receipts = require(path.join(__dirname, '..', 'lib', 'receipts'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  // ---- CL1: THE census pin — every key declares every language ----
  {
    const keys = Object.keys(STRINGS);
    const missing = [];
    for (const key of keys) {
      for (const lang of LANGUAGES) {
        if (typeof STRINGS[key][lang] !== 'function') missing.push(key + ':' + lang);
      }
    }
    // and the variants must genuinely differ (a copy-pasted English
    // "translation" is the subtle failure mode)
    const sameParams = { businessName: 'X', paymentType: 'deposit', amount: '$1.00', url: 'u', customer: 'C', date: 'd', total: '$1.00', method: 'cash', txId: 1 };
    // no non-English variant may be a byte-copy of the English
    const lazy = [];
    for (const k of keys) {
      const en = JSON.stringify(STRINGS[k].en(sameParams));
      for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
        if (JSON.stringify(STRINGS[k][lang](sameParams)) === en) lazy.push(k + ':' + lang);
      }
    }
    check('CL1 [the ruled census]: every canned-string key declares EVERY supported language (' + keys.length + ' keys × ' + LANGUAGES.length + ' languages), and no variant is a byte-copy of the English',
      missing.length === 0 && lazy.length === 0,
      JSON.stringify({ missing, lazy }));
  }

  // ---- CL2 [evolved ST7a]: the three copies of the language set agree ----
  {
    // 064 is the CURRENT authority (it re-creates the constraint 063
    // introduced); the widening evolved this pin exactly as designed.
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '064_arabic_language.sql'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const dbSet = /CHECK \(customer_language IN \('en', 'es', 'ar'\)\)/.test(migration);
    const endpointSet = srv.includes("const CUSTOMER_LANGUAGES = ['en', 'es', 'ar'];");
    const moduleSet = JSON.stringify(LANGUAGES) === JSON.stringify(['en', 'es', 'ar']);
    check('CL2 [evolved ST7a]: the ruled set (en+es+ar) is identical in the DB CHECK (064), the endpoint, and the strings module — a new language must widen all three, forcing the claim decision',
      dbSet && endpointSet && moduleSet, JSON.stringify({ dbSet, endpointSet, moduleSet }));
  }

  // ---- CL3: the REAL prompt builder carries default-and-follow ----
  {
    const base = { contact: null, knowledge: [], callerAppointments: [], menu: [], thread: {}, channel: 'sms' };
    const es = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services', customer_language: 'es' } });
    const en = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services', customer_language: 'en' } });
    const unset = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services' } });
    // CL3 [evolved ST7a]: the E3 eval caught "default" beating
    // "follow" — the contract now puts the customer's message
    // language FIRST, with the workspace default as tie-breaker.
    const followFirst = 'Always reply in the language the customer\'s message is written in';
    const esOk = es.includes('## Language') && es.includes(followFirst)
      && es.includes('Default to Spanish only when') && es.includes('Never mix languages');
    const enOk = en.includes(followFirst) && en.includes('Default to English only when');
    const unsetOk = unset.includes('Default to English only when');
    check('CL3 [evolved ST7a]: the Language contract is ordered by dominance — customer\'s message language outranks the workspace default, no mixed-language replies, explicit English for legacy unset workspaces',
      esOk && enOk && unsetOk, JSON.stringify({ esOk, enOk, unsetOk }));
  }

  // ---- CL4: the rewired sites — es output has zero English remnants ----
  {
    const tx = { id: 9, total_cents: 4500, subtotal_cents: 4500, customer_display_name: 'Dana', payment_method: 'cash', payment_received_at: '2026-08-06T15:00:00Z', line_items: [] };
    const esSms = receipts.generateReceiptSMS(tx, { business_name: 'B', customer_language: 'es' });
    const esHtml = receipts.generateReceiptHTML(tx, { business_name: 'B', customer_language: 'es' });
    const enSms = receipts.generateReceiptSMS(tx, { business_name: 'B', customer_language: 'en' });
    const smsOk = esSms.includes('¡gracias') && esSms.includes('Referencia')
      && !/thanks|Your receipt|Paid via|Reference/.test(esSms);
    const htmlOk = ['Recibo', 'Cliente', 'Artículos', 'Sin detalle', 'Pagado con', 'Gracias por su visita']
      .every((s) => esHtml.includes(s))
      && !/>Receipt #|>Customer<|>Items<|No itemized|Paid via|Thanks for your visit/.test(esHtml)
      && !esHtml.includes('${'); // the interpolation bug class, pinned
    const enOk = enSms.includes('thanks Dana');
    check('CL4: an es receipt (SMS + email HTML) renders with ZERO English remnants and no un-interpolated ${...} artifacts; en output unchanged',
      smsOk && htmlOk && enOk, JSON.stringify({ smsOk, htmlOk, enOk, esSms: esSms.slice(0, 60) }));
  }

  // ---- CL5: the sites route through the module (no inline canned strings) ----
  {
    const pr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8');
    const rc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'receipts.js'), 'utf8');
    // LANG unit 3: the link SMS follows the CONVERSATION's language
    // (thread stamp via lib/conversation-language), primary fallback.
    const prOk = pr.includes("customerString(_linkLang || 'en', 'payment_link_sms'")
      && pr.includes(".conversationLanguage(pool, workspace, customerPhone, null)")
      && !pr.includes('secure ${label} link');
    const rcOk = rc.includes("customerString(lang, 'receipt_sms'")
      && rc.includes("'receipt_email_subject'")
      && !rc.includes('thanks ${customer}! Your receipt');
    // the payment SMS amount now formats through lib/money
    const moneyOk = pr.includes('amount: formatCents(amountCents)');
    check('CL5: payment-link SMS, receipt SMS, and both email subjects route through customer-strings (old inline strings gone); the SMS amount formats through lib/money',
      prOk && rcOk && moneyOk, JSON.stringify({ prOk, rcOk, moneyOk }));
  }

  // ---- CL6: the setting UI — per-channel truth on the control ----
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    // CL6 [evolved again — LANG Phase1 unit 4]: the control is now
    // toggles + a primary star. Exactly the three ruled languages, each
    // row carrying its OWN channel truth (ar = text only until the voice
    // spike), a star per row, and the primary-stays-enabled guard.
    const rows = ['en', 'es', 'ar'].every((l) =>
      app.includes('id="mbLangOn_' + l + '"') && app.includes('id="mbLangStar_' + l + '"'));
    const exactlyThree = (app.match(/id="mbLangOn_/g) || []).length === 3
      && (app.match(/<input type="radio" name="mbLangPrimary"/g) || []).length === 3;
    const rowTruth = /voice \+ text/.test(app)
      && /text only; voice answers in English until Arabic passes native-speaker review/.test(app);
    const primaryGuard = app.includes('Star a primary language first.')
      && app.includes('At least one language must stay on.');
    const wired = app.includes('loadCustomerLanguage();') && app.includes('mbSaveCustomerLanguage')
      && app.includes('enabled_languages: enabled');
    check('CL6 [LANG unit 4]: the control is toggles + primary star — exactly three ruled languages, per-ROW channel truth (ar text-only until the voice spike), primary-stays-enabled guard, saving primary+set together',
      rows && exactlyThree && rowTruth && primaryGuard && wired,
      JSON.stringify({ rows, exactlyThree, rowTruth, primaryGuard, wired }));
  }

  // ---- CL7: date localization ----
  {
    const es = shortDate('2026-08-06T15:00:00Z', 'es');
    const en = shortDate('2026-08-06T15:00:00Z', 'en');
    const esLong = longDate('2026-08-06T15:00:00Z', 'es');
    check('CL7: dates localize per language (es short/long differ from en; unknown language falls back to en, never throws)',
      es !== en && /agosto|ago/.test(esLong + es) && shortDate('2026-08-06T15:00:00Z', 'xx') === en,
      JSON.stringify({ es, en, esLong }));
  }

  // ---- CL8 (ST5b): the voice path speaks the setting ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const block = srv.slice(srv.indexOf('const wsUrl = '), srv.indexOf('// ============================================================\n// Reports'));
    // CL8 [evolved ST7a]: the voice language is GATED separately
    // through voiceLanguageFor — ar workspaces keep the English
    // greeting and session until the spike proves Arabic STT.
    const { voiceLanguageFor, VOICE_READY } = require(path.join(__dirname, '..', 'lib', 'customer-strings'));
    const greetingViaModule = block.includes("voiceString(vlang, 'voice_greeting', { businessName: bizName })");
    // LANG unit 2 evolved the gate: sendRelayConnect is the single tail
    // and EVERY path into it routes through voiceLanguageFor — the
    // single-language direct connect, the menu's voice-choice filter
    // (fixed-point test), and the no-digit fallback in relay-menu.
    const gated = block.includes('sendRelayConnect(req, res, workspace, voiceLanguageFor(primary))')
      && block.includes('voiceChoices = orderedLangs.filter((l) => voiceLanguageFor(l) === l)')
      && block.includes(`vlang === 'es' ? ' language="es-US"' : ''`);
    const twimlCarries = block.includes("welcomeGreeting=\"' + greeting + '\"' + langAttr");
    const mapping = voiceLanguageFor('es') === 'es' && voiceLanguageFor('en') === 'en'
      && voiceLanguageFor('ar') === 'en' && voiceLanguageFor(undefined) === 'en'
      && JSON.stringify(VOICE_READY) === JSON.stringify(['en', 'es']);
    const esGreeting = customerString('es', 'voice_greeting', { businessName: 'X' });
    const greetingSpanish = esGreeting.includes('Hola') && !/thanks for calling/i.test(esGreeting);
    check('CL8 [evolved ST7a]: the relay greets via voiceLanguageFor — es speaks Spanish (es-US, default voices), ar workspaces get the ENGLISH greeting and session (no overclaim-by-behavior), en emits no attribute; the ST7b flip is VOICE_READY alone',
      greetingViaModule && gated && twimlCarries && mapping && greetingSpanish,
      JSON.stringify({ greetingViaModule, gated, twimlCarries, mapping, greetingSpanish }));
  }

  // ---- CL9 (ST7a): the Arabic prompt branch carries the ST6 gate ----
  {
    const base = { contact: null, knowledge: [], callerAppointments: [], menu: [], thread: {}, channel: 'sms' };
    const ar = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services', customer_language: 'ar' } });
    const ok = ar.includes('Default to Arabic only when')
      && ar.includes('mirror their dialect in conversation')
      && ar.includes('Modern Standard Arabic')
      && ar.includes('آسفة')                       // the feminine-register guard (the observed slip)
      && ar.includes('Always quote exact menu prices') // the price-quoting guard
      && ar.includes('Always reply in the language the customer\'s message is written in');
    check('CL9 [ST7a]: the Arabic prompt branch encodes the eval-gate contract — customer-language-first, dialect-mirroring + MSA-for-formal, the feminine-register guard (آسفة), the quote-exact-prices guard',
      ok);
  }

  // ---- CL10 (ST7a): RTL receipts render right, en/es untouched ----
  {
    const tx = { id: 88, total_cents: 4500, subtotal_cents: 4500, tax_cents: 300, discount_cents: 100, customer_display_name: 'ليلى', payment_method: 'cash', payment_received_at: '2026-08-06T15:00:00Z', line_items: [{ description: 'قصة شعر', quantity: 1, total_cents: 4500 }] };
    const ar = receipts.generateReceiptHTML(tx, { business_name: 'صالون ياسمين', customer_language: 'ar' });
    const en = receipts.generateReceiptHTML(tx, { business_name: 'B', customer_language: 'en' });
    const dirOk = ar.includes('<html dir="rtl" lang="ar">');
    // every money value and the reference are LTR runs (bidi-safe)
    const ltrRuns = (ar.match(/<span dir="ltr">/g) || []).length >= 6; // 5 money cells + ref
    const arLabels = ['إيصال', 'العميل', 'البنود', 'الإجمالي', 'طريقة الدفع', 'شكراً لزيارتكم'].every((s) => ar.includes(s));
    const westernDigits = ar.includes('$45.00') && !/[٠-٩]/.test(ar); // nu-latn ruling: no Eastern Arabic numerals
    const enClean = !en.includes('dir=') && !en.includes('<span dir');
    check('CL10 [ST7a]: an ar receipt renders dir="rtl" lang="ar" with every amount and the reference wrapped as LTR runs (no bidi artifacts), Arabic labels throughout, WESTERN digits per the numerals ruling; en output carries no RTL residue',
      dirOk && ltrRuns && arLabels && westernDigits && enClean,
      JSON.stringify({ dirOk, ltrRuns, arLabels, westernDigits, enClean }));
  }

  console.log(`${pass}/${pass + fail} — customer-language suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
