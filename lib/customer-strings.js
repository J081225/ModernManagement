// lib/customer-strings.js — ST5a.
//
// Every CANNED string a customer can receive lives here, and every
// key DECLARES all supported language variants — the ruled census:
// a customer-facing canned string without its variants fails the
// suite, so no English string can leak into a conversation we claim
// to hold in Spanish. (The model-generated half of conversations is
// steered by the engine's language block; this module is the other
// half — the strings no model touches.)
//
// LANGUAGES mirrors the DB CHECK (063) and the endpoint's list —
// three copies of the same ruled set, each pinned to the others by
// the suite.

const LANGUAGES = ['en', 'es'];
const DATE_LOCALE = { en: 'en-US', es: 'es-US' };

function shortDate(d, lang) {
  return new Date(d).toLocaleDateString(DATE_LOCALE[lang] || 'en-US', { month: 'short', day: 'numeric' });
}
function longDate(d, lang) {
  return new Date(d).toLocaleDateString(DATE_LOCALE[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const STRINGS = {
  // The payment-link SMS (payment-requests.js) — deposit or balance.
  payment_link_sms: {
    en: ({ businessName, paymentType, amount, url }) =>
      `${businessName}: secure ${paymentType === 'deposit' ? 'deposit' : 'payment'} link for ${amount} — ${url}`,
    es: ({ businessName, paymentType, amount, url }) =>
      `${businessName}: enlace seguro para ${paymentType === 'deposit' ? 'el depósito' : 'el pago'} de ${amount} — ${url}`,
  },

  // The receipt SMS (receipts.js).
  receipt_sms: {
    en: ({ businessName, customer, date, total, method, txId }) =>
      `${businessName}: thanks ${customer}! Your receipt for ${date} — Total ${total}. Paid via ${method}. Reference #${txId}.`,
    es: ({ businessName, customer, date, total, method, txId }) =>
      `${businessName}: ¡gracias ${customer}! Su recibo del ${date} — Total ${total}. Pagado con ${method}. Referencia #${txId}.`,
  },

  // The voice greeting (relay-incoming TwiML welcomeGreeting) — ST5b.
  voice_greeting: {
    en: ({ businessName }) => `Hi, thanks for calling ${businessName}. How can I help you today?`,
    es: ({ businessName }) => `Hola, gracias por llamar a ${businessName}. ¿En qué puedo ayudarle hoy?`,
  },

  // The receipt email's subject + fixed labels (receipts.js HTML).
  receipt_email_subject: {
    en: ({ businessName }) => `Receipt from ${businessName}`,
    es: ({ businessName }) => `Recibo de ${businessName}`,
  },
  receipt_email_labels: {
    en: () => ({
      receipt: 'Receipt', customer: 'Customer', items: 'Items',
      noItems: 'No itemized details', subtotal: 'Subtotal', tax: 'Tax',
      discount: 'Discount', tip: 'Tip', total: 'Total', paidVia: 'Paid via',
      footer: 'Thanks for your visit. We hope to see you again soon.',
    }),
    es: () => ({
      receipt: 'Recibo', customer: 'Cliente', items: 'Artículos',
      noItems: 'Sin detalle de artículos', subtotal: 'Subtotal', tax: 'Impuestos',
      discount: 'Descuento', tip: 'Propina', total: 'Total', paidVia: 'Pagado con',
      footer: 'Gracias por su visita. ¡Esperamos verle pronto!',
    }),
  },
};

// customerString(lang, key, params) — the one lookup. Unknown lang
// falls back to English (never throws mid-send); unknown key THROWS
// (a typo must fail loudly in tests, not send an empty SMS).
function customerString(lang, key, params) {
  const entry = STRINGS[key];
  if (!entry) throw new Error('customer-strings: unknown key ' + key);
  const fn = entry[LANGUAGES.includes(lang) ? lang : 'en'] || entry.en;
  return fn(params || {});
}

module.exports = { customerString, shortDate, longDate, STRINGS, LANGUAGES };
