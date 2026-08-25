// scripts/live-compose-check.js — MANUAL live round trip of the REAL
// compose pass through the ACTUAL Anthropic API (network + cost:
// deliberately NOT named test-*.js so the sweep never runs it).
// Proof requirement (URGENT package step 3): a spoken sentence
// containing the slot times comes back, with no tool-message shapes.
require('dotenv').config();
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const engine = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));
const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));

(async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = engine.buildSystemPrompt({
    workspace: { id: 21, business_name: 'Northside Barbers', vertical: 'professional-services', customer_language: 'en' },
    contact: null, knowledge: [], callerAppointments: [], menu: [], thread: {}, channel: 'voice',
  });
  const tools = registry.getAnthropicSchemaForVertical('professional-services');
  const out = await engine._composeSpokenResult({
    anthropicClient: client, systemPrompt, tools,
    body: 'What do you have open on September first?',
    aiResponse: { content: [
      { type: 'text', text: 'Let me check that for you.' },
      { type: 'tool_use', id: 'toolu_livecheck01', name: 'propose_appointment_times', input: { target_date: '2026-09-01', duration_minutes: 30 } },
    ] },
    toolResults: [{ tool_use_id: 'toolu_livecheck01', content: 'Open 30-minute slots on 2026-09-01: 9:00 AM, 1:30 PM, 5:30 PM.' }],
  });
  console.log('COMPOSED:', JSON.stringify(out));
  const speaksSlots = /9/.test(out) && /(1:30|one[- ]thirty)/i.test(out) && /(5:30|five[- ]thirty)/i.test(out);
  const clean = !/\d{4}-\d{2}-\d{2}|Open 30-minute slots/.test(out);
  if (!speaksSlots || !clean) { console.error('LIVE CHECK FAILED: slots missing or not speech-grade'); process.exit(1); }
  console.log('LIVE ROUND TRIP OK — slot times spoken, no tool-message shapes.');
})().catch((e) => { console.error('LIVE CHECK FAILED:', e.message); process.exit(1); });
