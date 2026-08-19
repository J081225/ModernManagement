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

const LANGUAGES = ['en', 'es', 'ar'];
// ST7a numerals ruling: Western digits for Arabic (ar-u-nu-latn) —
// matches how Dearborn businesses write prices and keeps amounts
// unambiguous next to $ signs.
const DATE_LOCALE = { en: 'en-US', es: 'es-US', ar: 'ar-u-nu-latn' };

// ST7a voice honesty: which languages the VOICE channel may claim.
// Arabic text ships first (the ST6 ruling: Arabic STT is unproven
// for Dearborn's dialect reality — an Arabic greeting without proven
// Arabic STT is an overclaim by behavior). ST7b's spike flips 'ar'
// in exactly one place: here.
const VOICE_READY = ['en', 'es'];
// Variant B PASS (2026-08-19, Levantine 83–100% fixed-ar): "press 3 for
// Arabic" is a REAL voice path — shipped DARK behind ARABIC_VOICE_ENABLED
// until the honesty gates clear (native-speaker greeting pass + 2 more
// speaker cells per dialect, Levantine + Yemeni — see the spike register).
// This is the ST7b-promised single flip point.
if (process.env.ARABIC_VOICE_ENABLED === 'true') VOICE_READY.push('ar');
function voiceLanguageFor(customerLanguage) {
  return VOICE_READY.includes(customerLanguage) ? customerLanguage : 'en';
}

function shortDate(d, lang) {
  return new Date(d).toLocaleDateString(DATE_LOCALE[lang] || 'en-US', { month: 'short', day: 'numeric' });
}
function longDate(d, lang) {
  return new Date(d).toLocaleDateString(DATE_LOCALE[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const STRINGS = {
  // The payment-link SMS (payment-requests.js) — deposit or balance.
  // Arabic variants are MSA (the written standard every dialect
  // reads — the ST6 register ruling for money documents), pending
  // the native-speaker review pass before the claim ships.
  payment_link_sms: {
    en: ({ businessName, paymentType, amount, url }) =>
      `${businessName}: secure ${paymentType === 'deposit' ? 'deposit' : 'payment'} link for ${amount} — ${url}`,
    es: ({ businessName, paymentType, amount, url }) =>
      `${businessName}: enlace seguro para ${paymentType === 'deposit' ? 'el depósito' : 'el pago'} de ${amount} — ${url}`,
    ar: ({ businessName, paymentType, amount, url }) =>
      `${businessName}: رابط آمن ${paymentType === 'deposit' ? 'لدفع العربون' : 'للدفع'} بمبلغ ${amount} — ${url}`,
  },

  // The receipt SMS (receipts.js).
  receipt_sms: {
    en: ({ businessName, customer, date, total, method, txId }) =>
      `${businessName}: thanks ${customer}! Your receipt for ${date} — Total ${total}. Paid via ${method}. Reference #${txId}.`,
    es: ({ businessName, customer, date, total, method, txId }) =>
      `${businessName}: ¡gracias ${customer}! Su recibo del ${date} — Total ${total}. Pagado con ${method}. Referencia #${txId}.`,
    ar: ({ businessName, customer, date, total, method, txId }) =>
      `${businessName}: شكراً ${customer}! إيصالكم بتاريخ ${date} — الإجمالي ${total}. طريقة الدفع: ${method}. رقم المرجع #${txId}.`,
  },

  // The voice greeting (relay-incoming TwiML welcomeGreeting) — ST5b.
  // The ar variant is DECLARED (the census requires it) but UNUSED
  // until ST7b's spike proves Arabic STT — voiceLanguageFor routes
  // ar workspaces to the English greeting until then.
  // B3 (AI-scope): the polite off-topic close — spoken/sent verbatim at
  // the 6th consecutive non-business turn, zero model involvement.
  off_topic_close: {
    en: ({ businessName }) => `I want to make sure I'm helping with ${businessName} matters — I'll pass along anything you'd like the owner to see. For appointments, hours, or anything else about the business, call or text anytime. Take care!`,
    es: ({ businessName }) => `Quiero asegurarme de ayudarle con asuntos de ${businessName} — con gusto le paso al dueño cualquier mensaje. Para citas, horarios o cualquier tema del negocio, llame o escriba cuando quiera. ¡Cuídese!`,
    ar: ({ businessName }) => `أريد أن أتأكد من مساعدتكم في أمور ${businessName} — يسعدني إيصال أي رسالة تريدونها لصاحب المحل. للمواعيد أو ساعات العمل أو أي أمر يخص المحل، اتصلوا أو راسلونا في أي وقت. مع السلامة!`,
  },

  voice_greeting: {
    en: ({ businessName }) => `Hi, thanks for calling ${businessName}. How can I help you today?`,
    es: ({ businessName }) => `Hola, gracias por llamar a ${businessName}. ¿En qué puedo ayudarle hoy?`,
    ar: ({ businessName }) => `مرحباً، شكراً لاتصالكم بـ${businessName}. كيف أقدر أساعدكم اليوم؟`,
  },

  // The receipt email's subject + fixed labels (receipts.js HTML).
  receipt_email_subject: {
    en: ({ businessName }) => `Receipt from ${businessName}`,
    es: ({ businessName }) => `Recibo de ${businessName}`,
    ar: ({ businessName }) => `إيصال من ${businessName}`,
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
    ar: () => ({
      receipt: 'إيصال', customer: 'العميل', items: 'البنود',
      noItems: 'بدون تفاصيل البنود', subtotal: 'المجموع الفرعي', tax: 'الضريبة',
      discount: 'الخصم', tip: 'الإكرامية', total: 'الإجمالي', paidVia: 'طريقة الدفع',
      footer: 'شكراً لزيارتكم. نتطلع لرؤيتكم قريباً!',
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

module.exports = { customerString, shortDate, longDate, STRINGS, LANGUAGES, VOICE_READY, voiceLanguageFor };
