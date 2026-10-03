// lib/workspace-email.js — EMAIL-POLICY: Reply-To routing.
//
// Customer-facing sends set replyTo to the WORKSPACE'S vanity alias
// (<username>@modernmanagementapp.com) so a customer's reply lands in
// that business's own inbox through Inbound Parse. Platform emails
// (welcome, reset, verification, owner alerts) use the ops address,
// which /api/email/incoming forwards to the operator. Fallback on any
// lookup failure is the old SENDGRID_FROM_EMAIL behavior, logged.

const SUPPORT_REPLY_TO = 'support@modernmanagementapp.com';
const DOMAIN_RE = /@modernmanagementapp\.com$/i;

async function aliasForUser(db, userId, env) {
  try {
    const r = await db.query('SELECT inbound_email_alias FROM users WHERE id = $1', [userId]);
    const alias = r.rows[0] && r.rows[0].inbound_email_alias;
    if (alias && DOMAIN_RE.test(alias)) return alias;
  } catch (err) {
    console.error('[workspace-email] alias lookup failed (fallback replyTo):', err.message);
  }
  return (env && env.SENDGRID_FROM_EMAIL) || 'noreply@modernmanagementapp.com';
}

async function customerReplyTo(db, workspace, env) {
  return aliasForUser(db, workspace.owner_user_id, env);
}

module.exports = { aliasForUser, customerReplyTo, SUPPORT_REPLY_TO };
