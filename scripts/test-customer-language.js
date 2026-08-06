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
    const lazy = keys.filter((k) => {
      const en = JSON.stringify(STRINGS[k].en(sameParams));
      const es = JSON.stringify(STRINGS[k].es(sameParams));
      return en === es;
    });
    check('CL1 [the ruled census]: every canned-string key declares BOTH en and es (' + keys.length + ' keys × ' + LANGUAGES.length + ' languages), and no es variant is a copy of the English',
      missing.length === 0 && lazy.length === 0,
      JSON.stringify({ missing, lazy }));
  }

  // ---- CL2: the three copies of the language set agree ----
  {
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '063_customer_language.sql'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const dbSet = /CHECK \(customer_language IN \('en', 'es'\)\)/.test(migration);
    const endpointSet = srv.includes("const CUSTOMER_LANGUAGES = ['en', 'es'];");
    const moduleSet = JSON.stringify(LANGUAGES) === JSON.stringify(['en', 'es']);
    check('CL2: the ruled launch set (en+es ONLY) is identical in the DB CHECK, the endpoint, and the strings module — a new language must widen all three, forcing the claim decision',
      dbSet && endpointSet && moduleSet, JSON.stringify({ dbSet, endpointSet, moduleSet }));
  }

  // ---- CL3: the REAL prompt builder carries default-and-follow ----
  {
    const base = { contact: null, knowledge: [], callerAppointments: [], menu: [], thread: {}, channel: 'sms' };
    const es = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services', customer_language: 'es' } });
    const en = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services', customer_language: 'en' } });
    const unset = buildSystemPrompt({ ...base, workspace: { id: 7, business_name: 'X', vertical: 'professional-services' } });
    const esOk = es.includes('## Language') && es.includes('Greet and reply in Spanish by default')
      && es.includes('follow the customer');
    const enOk = en.includes('Greet and reply in English by default') && en.includes('follow the customer');
    const unsetOk = unset.includes('Greet and reply in English by default');
    check('CL3: the real prompt builder injects the Language block ALWAYS — Spanish default-and-follow for es, explicit English for en AND for legacy unset workspaces (no implicit drift)',
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
    const prOk = pr.includes("customerString(workspace.customer_language || 'en', 'payment_link_sms'")
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
    const control = app.includes('id="mbCustomerLanguage"')
      && /value="en">English \(default\)/.test(app) && app.includes('Espa&ntilde;ol');
    const onlyTwo = (app.match(/id="mbCustomerLanguage"[\s\S]{0,600}?<\/select>/) || [''])[0].split('<option').length - 1 === 2;
    const channelTruth = app.includes('Phone calls: English for now');
    const wired = app.includes('loadCustomerLanguage();') && app.includes('mbSaveCustomerLanguage');
    check('CL6: the control offers EXACTLY the two ruled languages, carries per-channel truth (voice honestly English until ST5b ships), and is wired fire-and-forget',
      control && onlyTwo && channelTruth && wired,
      JSON.stringify({ control, onlyTwo, channelTruth, wired }));
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

  console.log(`${pass}/${pass + fail} — customer-language suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
