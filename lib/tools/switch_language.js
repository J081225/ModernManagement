// lib/tools/switch_language.js — LS: the mid-call SPOKEN language switch.
//
// A caller says "in Spanish please" / "¿habla español?" / "can we do this
// in Arabic" and Sarah calls this. It (1) tells ConversationRelay to
// switch STT+TTS via the relay closure's onLanguageSwitch (the same
// session-language override the DTMF pin uses), (2) re-stamps the
// conversation's language so receipts and links follow (Phase-1
// plumbing), and (3) returns the confirmation IN THE NEW language, which
// the engine speaks.
//
// Constraints, all structural:
//   - EXPLICIT REQUEST ONLY. Never inferred from how the caller speaks —
//     auto-detect is the failed spike (register). The description says so.
//   - Voice only: the engine offers this tool on channel 'voice' alone.
//   - Target must be ENABLED for the workspace AND voice-ready. Arabic is
//     a FULL PEER here — no special-casing: voice-ready is the
//     voiceLanguageFor fixed point, and the ONLY Arabic gate is
//     ARABIC_VOICE_ENABLED in customer-strings. Flag off → "coming soon"
//     in the current language + offer to continue or take a message;
//     flag on → switches exactly like Spanish. Zero code changes to flip.
//   - customer-strings is required INSIDE execute so the flag state is
//     read fresh (tests exercise both states in one process).
const registry = require('../tool-registry');

const RELAY_LANGUAGE_CODES = { en: 'en-US', es: 'es-US', ar: 'ar' };

registry.register({
  name: 'switch_language',
  description: 'Switch this live phone conversation to another language. Call ONLY when the caller EXPLICITLY asks to change language (for example "in Spanish please", "¿habla español?", "can we do this in Arabic"). NEVER call it because of the language the caller happens to be speaking — an explicit request only. Languages: en (English), es (Spanish), ar (Arabic). The confirmation is spoken for you in the new language; do not add your own reply text in this turn.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['en', 'es', 'ar'], description: 'The language the caller explicitly asked for.' },
    },
    required: ['language'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const cs = require('../customer-strings');
    const ws = ctx.workspace || {};
    const current = ws.customer_language || 'en';
    const target = String(input.language || '').trim();
    const name = (lang) => cs.languageName(lang, current);

    if (!cs.LANGUAGES.includes(target)) {
      return { success: false, message: cs.customerString(current, 'language_not_offered', { languageName: name(target) || target }) };
    }
    if (target === current) {
      return { success: true, message: cs.customerString(current, 'language_switched'), switched_to: current };
    }
    // LANG-CARD: the switchable set is ALL voice-ready languages —
    // enabled_languages is no longer consulted (the card is one
    // "Starting language" control; a customer may always ask for any
    // language the pipeline can actually speak). Flag-gating for
    // Arabic is unchanged: the voice-ready gate below IS the flag.
    // The voice-ready gate — the fixed point. For 'ar' this IS the
    // ARABIC_VOICE_ENABLED flag, and nothing else.
    if (cs.voiceLanguageFor(target) !== target) {
      return { success: false, message: cs.customerString(current, 'language_coming_soon', { languageName: name(target) }), coming_soon: target };
    }
    const isVoice = ctx.origin && ctx.origin.channel_detail === 'voice';
    if (!isVoice || typeof ctx.onLanguageSwitch !== 'function') {
      return { success: false, message: cs.customerString(current, 'language_not_offered', { languageName: name(target) }) };
    }

    await ctx.onLanguageSwitch(target, RELAY_LANGUAGE_CODES[target]);

    // Re-stamp the conversation (Phase-1 plumbing: receipts/links follow).
    const threadId = ctx.origin && ctx.origin.appointment_thread_id;
    if (threadId && ctx.db) {
      try {
        await ctx.db.query('UPDATE appointment_threads SET language = $1 WHERE id = $2', [target, threadId]);
      } catch (err) {
        (ctx.logger || console).error('[switch_language] thread re-stamp failed (switch stands):', err.message);
      }
    }
    return { success: true, message: cs.customerString(target, 'language_switched'), switched_to: target };
  },
});

module.exports = { RELAY_LANGUAGE_CODES };
