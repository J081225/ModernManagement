# Modern Management — Code Reference Bundle for Prompt-Writing

**Companion to** [`d-series-handoff-2026-05-07.md`](d-series-handoff-2026-05-07.md). The handoff doc describes the system; this file shows the actual contracts so future session prompts can say "follow the pattern of `send_sms.js` exactly" instead of describing it.

Two files are included verbatim below:

1. **`lib/tool-registry.js`** — the contract every new AI tool plugs into.
2. **`lib/tools/send_sms.js`** — a representative `requiresApproval: true` external-facing tool. Use this as the template for any future approval-gated outbound tool.

---

## File 1: `lib/tool-registry.js`

This is the entire registry module — 133 lines. Every tool registers via `registry.register({...})` at import time. The plan-aware filter (`getToolsForPlan` / `getAnthropicSchemaForPlan`) and the static `TOOL_REQUIRED_FEATURE` map are the D4 additions; everything else is from B1.

```js
// lib/tool-registry.js
//
// Central registry for AI tools available via the command bar.
// Tools are registered by importing them in lib/tools/index.js.
// Each tool module calls registry.register() with a definition
// including its schema, executor, vertical tag, and navigation
// metadata.
//
// This registry is loaded at server startup but is NOT yet wired
// into /api/command. Session B2 will perform that switch. Until
// then, the registry exists alongside the old inline tool system
// for verification purposes only.

const plans = require('./plans');

// Session D4: static map of tool → required plan feature. Keeps tool
// executor files in lib/tools/ untouched. Tools whose name appears
// here are filtered out of getToolsForPlan() when the workspace's plan
// does not include the listed feature. Tools NOT in this map pass
// through unchanged on all plans.
//
// Aligns with lib/plans.js features keys: broadcast, autoResponse,
// apiAccess, multiUserCollaboration, dailyBriefing, customAITraining,
// dedicatedCSM. Per the D4 pricing review, only send_broadcast is
// gated today — individual sends (send_sms / send_email /
// reply_to_message) are allowed on all tiers.
const TOOL_REQUIRED_FEATURE = {
  send_broadcast: 'broadcast',
};

const tools = new Map();

function register(toolDef) {
  if (!toolDef || !toolDef.name) {
    throw new Error('Tool definition must have a name');
  }
  if (tools.has(toolDef.name)) {
    throw new Error(`Tool already registered: ${toolDef.name}`);
  }
  const requiredFields = ['name', 'description', 'schema', 'vertical', 'category', 'execute'];
  for (const field of requiredFields) {
    if (!(field in toolDef)) {
      throw new Error(`Tool ${toolDef.name} missing required field: ${field}`);
    }
  }
  if (typeof toolDef.execute !== 'function') {
    throw new Error(`Tool ${toolDef.name}: execute must be a function`);
  }
  // Defaults for optional fields
  if (!('navigationPolicy' in toolDef)) toolDef.navigationPolicy = 'never';
  if (!('navigateTo' in toolDef)) toolDef.navigateTo = null;
  if (!('requiresApproval' in toolDef)) toolDef.requiresApproval = false;
  tools.set(toolDef.name, toolDef);
}

function getTool(name) {
  return tools.get(name) || null;
}

function getAllTools() {
  return Array.from(tools.values());
}

function getToolsForVertical(vertical) {
  const result = [];
  for (const tool of tools.values()) {
    if (tool.vertical === 'core' || tool.vertical === vertical) {
      result.push(tool);
    }
  }
  return result;
}

function getAnthropicSchemaForVertical(vertical) {
  return getToolsForVertical(vertical).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  }));
}

/**
 * Session D4: vertical filter + plan-feature filter. Tools listed in
 * TOOL_REQUIRED_FEATURE are excluded when the plan doesn't include the
 * listed feature. Tools without an entry in the map pass through.
 *
 * If `plan` is null/undefined (legacy workspace), behaves like
 * getToolsForVertical (no plan filtering applied).
 */
function getToolsForPlan(vertical, plan) {
  const verticalTools = getToolsForVertical(vertical);
  if (!plan) return verticalTools;
  return verticalTools.filter(t => {
    const requiredFeature = TOOL_REQUIRED_FEATURE[t.name];
    if (!requiredFeature) return true;
    return plans.hasFeature(plan, requiredFeature);
  });
}

function getAnthropicSchemaForPlan(vertical, plan) {
  return getToolsForPlan(vertical, plan).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  }));
}

function getSystemPromptToolBlockForVertical(vertical) {
  const lines = getToolsForVertical(vertical).map(t => {
    const firstSentence = t.description.split('.')[0];
    return `- ${t.name}: ${firstSentence}.`;
  });
  return lines.join('\n');
}

// Reset for testing only — never called in production
function _reset() {
  tools.clear();
}

module.exports = {
  register,
  getTool,
  getAllTools,
  getToolsForVertical,
  getAnthropicSchemaForVertical,
  getSystemPromptToolBlockForVertical,
  getToolsForPlan,
  getAnthropicSchemaForPlan,
  TOOL_REQUIRED_FEATURE,
  _reset
};
```

### What this contract demands of every new tool

When prompting Claude Code to author a new tool, the prompt must specify:

- **Required fields**: `name`, `description`, `schema`, `vertical`, `category`, `execute` — `register()` throws if any are missing.
- **Optional fields with auto-defaults**: `navigationPolicy` defaults to `'never'`, `navigateTo` defaults to `null`, `requiresApproval` defaults to `false`. Tools omit them only if the defaults are correct.
- **`vertical` values**: `'core'` (visible everywhere) or `'property-management'` (visible to PM workspaces). Note hyphen, not underscore.
- **`category` values seen in the codebase**: `'create'`, `'update'`, `'delete'`, `'financial'`, `'external-facing'`, `'read'`. Free-text but stick to convention.
- **Plan gating** is added by editing `TOOL_REQUIRED_FEATURE` here in this file — NOT by adding a property to the tool definition. Hard constraint "do not modify lib/tools/" is honored that way.
- **Approval gating** is set on the tool definition itself (`requiresApproval: true`). The interception lives in `/api/command`'s execution loop.

---

## File 2: `lib/tools/send_sms.js`

A representative `requiresApproval: true` external-facing tool. 88 lines. Use this as the template for any future approval-gated outbound tool. Notice the schema-reality comment block at the top — every tool whose spec divergence is non-obvious includes one.

```js
// lib/tools/send_sms.js
//
// Real outbound SMS via Twilio. Writes the sent message to the messages
// table so the user has a record in the inbox view.
//
// Schema reality check (matches the messages table actually defined in
// server.js, NOT the column names suggested in the C3 spec):
//   columns are (user_id, resident, subject, category, text, status,
//                folder, email, phone, "createdAt").
//   - `resident` = recipient name (legacy column name)
//   - `text` = body
//   - `category` = channel encoding ('sms' here)
//   - `status='sent'` + `folder='inbox'` = mirrors how the auto-reply
//     path marks outbound mutations on existing rows
//
// Twilio pattern matches send_late_notice.js: from = TWILIO_PHONE_NUMBER.
// requiresApproval=true: never executes until the user clicks Approve.
const registry = require('../tool-registry');

registry.register({
  name: 'send_sms',
  description: 'Send a real SMS text message to a contact via Twilio. Identify the recipient by name (fuzzy-matched against the contact list). Use this when the user wants to text someone — e.g., "send Maria a text saying we\'ll send a plumber Tuesday at 10am" or "text the electrician to confirm Friday at 9". The AI should NOT use this for replies to existing inbox messages (use reply_to_message for that). Requires approval before sending.',
  vertical: 'core',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Name of the contact (resident, vendor, or other) to send the SMS to. Use fuzzy matching against the contact list.' },
      body: { type: 'string', description: 'The full text of the SMS message. Keep concise — SMS works best under 160 characters.' }
    },
    required: ['to', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { to, body } = input;
    if (!to || !body) {
      return { success: false, message: 'Missing required fields: to (recipient name) and body (message text).' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${to.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${to}". Add the contact first or check the spelling.` };
    }
    const recipient = matches.rows[0];
    if (!recipient.phone || !String(recipient.phone).trim()) {
      return { success: false, message: `${recipient.name} has no phone number on file. Add a phone number first, or use send_email instead if they have an email address.` };
    }

    let sentSid = null;
    try {
      const result = await ctx.sms.messages.create({
        from: ctx.env.TWILIO_PHONE_NUMBER,
        to: recipient.phone,
        body
      });
      sentSid = result && result.sid;
    } catch (err) {
      ctx.logger.error('[send_sms] Twilio error:', err.message);
      return { success: false, message: `Twilio failed to send: ${err.message}` };
    }

    let savedId = null;
    try {
      const subject = `SMS to ${recipient.name}`;
      const saved = await ctx.db.query(
        `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
         VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)
         RETURNING id`,
        [ctx.user.id, recipient.name, subject, body, recipient.phone]
      );
      savedId = saved.rows[0].id;
    } catch (err) {
      ctx.logger.error('[send_sms] Failed to record sent message (SMS still went out):', err.message);
    }

    return {
      success: true,
      data: { recipient: recipient.name, phone: recipient.phone, channel: 'sms', message_id: savedId, twilio_sid: sentSid },
      message: `Sent SMS to ${recipient.name} (${recipient.phone}): "${body.length > 80 ? body.slice(0, 77) + '...' : body}"`
    };
  }
});
```

### Pattern observations for future tool prompts

- **Header comment block** documents schema-reality deviations from the spec. Future PS-vertical tools should include the same kind of block citing PS-vertical column names.
- **Validate input first** with explicit `success: false` messages for each missing field. Never throw — always return.
- **Fuzzy-match recipients** by name with `LIMIT 5` and use the first row. The message field cites the matched name back to the user.
- **Pre-flight channel check** (`!recipient.phone`) before calling the external service. Fails with a friendly fallback suggestion ("use send_email instead").
- **External call wrapped in try/catch.** On failure, return `{ success: false }` with the provider error message — never let it propagate.
- **Persist after sending.** The `messages` INSERT runs in a SECOND try/catch so persistence failure does NOT make the SMS look failed (the SMS already went out). The error is logged but the success result still returns to the user.
- **Return shape**: `{ success: true, data: {...}, message: '...' }`. The `message` field is shown to the user as the friendly outcome; `data` carries IDs for navigation/follow-up.

When prompting for a new approval-required tool (e.g., "send a calendar invite"), copy this skeleton and adjust:

1. Header comment with schema-reality notes (cite the audit's Schema Reality table).
2. `name`, `description`, `vertical`, `category`, `schema`.
3. `requiresApproval: true`.
4. Input validation block.
5. Resolve recipient(s) from contacts/etc.
6. Pre-flight check that the channel info exists.
7. External call with try/catch returning friendly failure.
8. Persistence with a second try/catch (best-effort).
9. Structured success return.

---

## File 3 (NOT included): `agent-prompt-session-e1.md`

This file lives in your planning conversation's outputs directory (`/mnt/user-data/outputs/...`), which doesn't exist on the Windows environment where the codebase lives. I cannot extract it from here.

**To get it into the new chat:**

1. **Easiest path:** open the conversation that produced E1, copy the file's contents, and paste it directly into the new chat as a code block (or save it locally as `agent-prompt-session-e1.md` and upload the file).
2. **Save it to the repo first:** if you want the prompt-writing chat to reference it persistently, paste the contents into a new file at `docs/agent-prompts/session-e1.md` in the repo. Then upload that. Future E2/E3/E4 prompts can be saved there too — gives you a permanent record alongside session reports.
3. **Ask the planning conversation to regenerate it:** if the original conversation is still open, ask it to print the E1 prompt verbatim so you can copy it into the new chat.

### What the new chat should look for in E1

When the new chat reads E1, it should specifically check:

- **Does E1 backfill `workspaces.vertical` for the existing admin workspace?** The audit confirmed the admin workspace (id=3) was created before migration 026 added the `vertical` column. The default `'property-management'` should apply via the column default, but if E1 changes the vertical model (e.g., to add a `'professional-services'` vertical) it must include an UPDATE for id=3.
- **Does E1 use `migrations/phase1-additive/`** for any schema work, with fresh files numbered 033+? After D8, the runner auto-applies new migrations on next startup — schema changes do NOT belong in `initDB()` anymore.
- **Does E1 cite the codebase audit and the D-series handoff brief?** Without those, Claude Code re-discovers the schema reality the hard way.
- **Does E1's "Files in scope" list match the actual subsystem touched?** If E1 is "add a new vertical config", it shouldn't be touching enforcement code or the signup orchestrator.
- **Does E1 specify `vertical: 'professional-services'` (hyphen) or `'professional_services'` (underscore)?** The codebase uses hyphens for vertical values; matching the existing convention is mandatory.

---

## How to use this bundle in the new chat

Upload three files to the new conversation:

1. `docs/codebase-audit-2026-05-06.md` — the 53KB ground-truth audit.
2. `docs/d-series-handoff-2026-05-07.md` — the orientation brief.
3. **This file** (`docs/code-reference-bundle-2026-05-07.md`) — the literal contracts.

Plus the E1 prompt as a separate paste/upload (per the instructions in File 3 above).

That's the minimum useful payload. Optionally also include `docs/pricing-strategy-v1.md` if the next sessions touch tier configuration.

If the new chat asks for more code (other tool files, the orchestrator, the enforcement layer), you can either:

- **Read directly:** open the file in your IDE, copy, paste into the chat.
- **Ask me here:** I can read any file in the repo and paste it back to you in a single response. Just say "give me `lib/plan-enforcement.js`" or "give me the executor of `add_invoice.js`" and I'll print it.
