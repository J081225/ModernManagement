// lib/receipts.js
//
// Receipt formatting and delivery for E3 transactions.
//
// Channel preference: email > sms > save
// "Save" means: generate the receipt HTML and persist on the transaction row
// (receipt_sent_via='none', receipt_html populated) so Sarah can manually
// trigger a send later from the detail card.
//
// IMPORTANT: receipt language never claims Modern Management charged the customer.
// Modern Management does not process customer payments yet. Receipts are records
// of a payment that already happened (cash, card terminal, Venmo, etc.).

function formatCents(cents) {
  if (cents == null) return '$0.00';
  const dollars = cents / 100;
  return '$' + dollars.toFixed(2);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateReceiptHTML(transaction, workspace) {
  const businessName = escapeHtml(workspace.business_name || workspace.name || 'Your business');
  const txId = transaction.id;
  const date = new Date(transaction.payment_received_at || transaction.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const customer = escapeHtml(transaction.customer_display_name || 'Customer');
  const lineItems = Array.isArray(transaction.line_items) ? transaction.line_items : [];

  const itemsHtml = lineItems.map(item => `
    <tr>
      <td style="padding:8px 0;color:#e2e8f0;">${escapeHtml(item.description || 'Item')}${item.quantity > 1 ? ` &times; ${item.quantity}` : ''}</td>
      <td style="padding:8px 0;color:#e2e8f0;text-align:right;">${formatCents(item.total_cents)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px;background:#0d1117;color:#e2e8f0;">
    <div style="border-bottom:1px solid #94a3b8;padding-bottom:16px;margin-bottom:24px;">
      <h1 style="color:#f5e6d3;margin:0 0 4px 0;font-size:24px;">${businessName}</h1>
      <div style="color:#94a3b8;font-size:14px;">Receipt #${txId} &middot; ${date}</div>
    </div>

    <div style="margin-bottom:24px;">
      <div style="color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Customer</div>
      <div style="color:#f5e6d3;font-size:16px;">${customer}</div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <thead>
        <tr><th colspan="2" style="text-align:left;padding-bottom:8px;color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;font-weight:normal;">Items</th></tr>
      </thead>
      <tbody>
        ${itemsHtml || '<tr><td colspan="2" style="color:#94a3b8;padding:8px 0;">No itemized details</td></tr>'}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;border-top:1px solid #94a3b8;padding-top:8px;">
      <tr><td style="color:#94a3b8;padding:4px 0;">Subtotal</td><td style="color:#e2e8f0;text-align:right;padding:4px 0;">${formatCents(transaction.subtotal_cents)}</td></tr>
      ${transaction.tax_cents ? `<tr><td style="color:#94a3b8;padding:4px 0;">Tax</td><td style="color:#e2e8f0;text-align:right;padding:4px 0;">${formatCents(transaction.tax_cents)}</td></tr>` : ''}
      ${transaction.discount_cents ? `<tr><td style="color:#94a3b8;padding:4px 0;">Discount</td><td style="color:#e2e8f0;text-align:right;padding:4px 0;">-${formatCents(transaction.discount_cents)}</td></tr>` : ''}
      ${transaction.tip_cents ? `<tr><td style="color:#94a3b8;padding:4px 0;">Tip</td><td style="color:#e2e8f0;text-align:right;padding:4px 0;">${formatCents(transaction.tip_cents)}</td></tr>` : ''}
      <tr><td style="color:#f5e6d3;font-weight:bold;padding:8px 0;border-top:1px solid #94a3b8;">Total</td><td style="color:#d4af37;font-weight:bold;text-align:right;padding:8px 0;border-top:1px solid #94a3b8;">${formatCents(transaction.total_cents)}</td></tr>
      ${transaction.payment_method ? `<tr><td style="color:#94a3b8;padding:4px 0;font-size:13px;">Paid via</td><td style="color:#94a3b8;text-align:right;padding:4px 0;font-size:13px;">${escapeHtml(transaction.payment_method)}</td></tr>` : ''}
    </table>

    ${transaction.notes_customer ? `<div style="margin-top:24px;padding:16px;background:#161e2e;border-radius:6px;color:#e2e8f0;font-size:14px;">${escapeHtml(transaction.notes_customer)}</div>` : ''}

    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #94a3b8;color:#94a3b8;font-size:13px;text-align:center;">
      Thanks for your visit. We hope to see you again soon.
    </div>
  </div>
</body></html>
`.trim();
}

function generateReceiptSMS(transaction, workspace) {
  const businessName = workspace.business_name || workspace.name || 'Your business';
  const total = formatCents(transaction.total_cents);
  const customer = transaction.customer_display_name || 'there';
  const date = new Date(transaction.payment_received_at || transaction.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
  return `${businessName}: thanks ${customer}! Your receipt for ${date} — Total ${total}. Paid via ${transaction.payment_method || 'unrecorded'}. Reference #${transaction.id}.`;
}

const { persistOutboundMessage } = require('./outbound-persist');

async function sendReceipt({ transaction, workspace, contact, db, sendgrid, twilio, env, logger }) {
  const log = logger || console;
  const html = generateReceiptHTML(transaction, workspace);
  const sms = generateReceiptSMS(transaction, workspace);

  // Persist the HTML on the transaction row regardless of outcome
  try {
    await db.query(`UPDATE transactions SET receipt_html = $1 WHERE id = $2`, [html, transaction.id]);
  } catch (err) {
    log.error('[receipts] persist receipt_html failed:', err.message);
  }

  const customerEmail = contact && contact.email ? String(contact.email).trim() : null;
  const customerPhone = contact && contact.phone ? String(contact.phone).trim() : null;

  // Channel: email > sms > save
  if (customerEmail && sendgrid) {
    try {
      await sendgrid.send({
        to: customerEmail,
        from: { name: workspace.business_name || 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        replyTo: env.SENDGRID_FROM_EMAIL,
        subject: `Receipt from ${workspace.business_name || workspace.name || 'your visit'}`,
        html,
      });
      await db.query(
        `UPDATE transactions SET receipt_sent_via='email', receipt_sent_at=NOW() WHERE id=$1`,
        [transaction.id]
      );
      await persistOutboundMessage({
        db, workspace, channel: 'email', to: customerEmail,
        body: sms, subject: `Receipt from ${workspace.business_name || workspace.name || 'your visit'}`,
        sentBy: 'system', logger: log,
      });
      return { sent_via: 'email', sent_at: new Date().toISOString() };
    } catch (err) {
      log.error('[receipts] email send failed, will try SMS fallback:', err.message);
    }
  }

  if (customerPhone && twilio) {
    try {
      await twilio.messages.create({
        from: workspace.twilio_phone_number || env.TWILIO_PHONE_NUMBER,
        to: customerPhone,
        body: sms,
      });
      await db.query(
        `UPDATE transactions SET receipt_sent_via='sms', receipt_sent_at=NOW() WHERE id=$1`,
        [transaction.id]
      );
      await persistOutboundMessage({
        db, workspace, channel: 'sms', to: customerPhone, body: sms,
        sentBy: 'system', logger: log,
      });
      return { sent_via: 'sms', sent_at: new Date().toISOString() };
    } catch (err) {
      log.error('[receipts] SMS send failed:', err.message);
    }
  }

  // Save-but-don't-send
  try {
    await db.query(
      `UPDATE transactions SET receipt_sent_via='none' WHERE id=$1 AND receipt_sent_via IS NULL`,
      [transaction.id]
    );
  } catch (err) {
    log.error('[receipts] save-but-don\'t-send mark failed:', err.message);
  }
  return { sent_via: 'none', reason: 'No customer email or phone on file' };
}

module.exports = { generateReceiptHTML, generateReceiptSMS, sendReceipt };
