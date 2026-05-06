// lib/subscription-lifecycle.js
//
// Subscription lifecycle event processors. Mirrors Stripe's source-of-truth
// state into workspaces.subscription_status and workspaces.plan.
//
// All processors are idempotent — re-running on the same event is safe.
// All processors are best-effort on the audit_log writes; never fail the
// webhook because of an audit issue.
//
// Schema notes (verified in 2026-05-06 codebase audit):
//   - workspaces.subscription_status accepts 'active' | 'past_due' |
//     'canceled' | 'trial' (not 'trialing'). The mapping function below
//     normalizes Stripe's vocabulary to ours.
//   - workspaces.plan accepts 'trial' | 'solo' | 'team' | 'enterprise'
//     per the migration 029 CHECK constraint.
//   - audit_log columns: (user_id, event_type, details JSONB, ip,
//     created_at). One owner per workspace today, so user_id is the
//     workspace owner.

function mapStripeStatusToWorkspaceStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
      return 'past_due'; // payment in progress; treat as needing attention
    case 'paused':
      return 'canceled'; // rare; treat as effectively canceled
    default:
      console.warn(`[subscription-lifecycle] Unknown Stripe status: ${stripeStatus}`);
      return 'canceled';
  }
}

async function resolvePlanFromSubscription(subscription, stripeClient) {
  if (!subscription || !subscription.items || !subscription.items.data || !subscription.items.data.length) {
    return null;
  }
  const firstItem = subscription.items.data[0];
  const lookupKey = firstItem && firstItem.price && firstItem.price.lookup_key;
  if (lookupKey) {
    if (lookupKey.startsWith('solo_')) return 'solo';
    if (lookupKey.startsWith('team_')) return 'team';
    if (lookupKey.startsWith('enterprise_')) return 'enterprise';
    if (lookupKey === 'additional_user_monthly') {
      // Add-on, not a tier change
      return null;
    }
  }
  // Fallback: hit Stripe to fetch the lookup_key
  const priceId = firstItem && firstItem.price && firstItem.price.id;
  if (priceId && stripeClient) {
    try {
      const priceObj = await stripeClient.prices.retrieve(priceId);
      const fetchedKey = priceObj && priceObj.lookup_key;
      if (fetchedKey) {
        if (fetchedKey.startsWith('solo_')) return 'solo';
        if (fetchedKey.startsWith('team_')) return 'team';
        if (fetchedKey.startsWith('enterprise_')) return 'enterprise';
      }
    } catch (err) {
      console.warn('[subscription-lifecycle] Failed to fetch price for lookup_key:', err.message);
    }
  }
  return null;
}

async function logChange(pool, workspaceId, ownerUserId, eventType, details) {
  if (!pool || !ownerUserId) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, event_type, details, ip, created_at)
       VALUES ($1, $2, $3::jsonb, NULL, NOW())`,
      [ownerUserId, eventType, JSON.stringify({ workspace_id: workspaceId, ...details })]
    );
  } catch (err) {
    console.warn('[subscription-lifecycle] audit_log write failed:', err.message);
  }
}

async function sendOperatorAlert(pool, workspaceId, message, ctx) {
  console.warn(`[subscription-lifecycle] OPERATOR ALERT — workspace ${workspaceId}: ${message}`);
  if (!ctx || !ctx.sms || !ctx.env) return;
  try {
    const { rows } = await pool.query(
      `SELECT u.alert_phone FROM users u
       JOIN workspaces w ON w.owner_user_id = u.id
       WHERE w.id = $1 AND u.alert_phone IS NOT NULL AND u.alert_phone <> ''`,
      [workspaceId]
    );
    const alertPhone = rows[0] && rows[0].alert_phone;
    if (alertPhone && ctx.env.TWILIO_PHONE_NUMBER) {
      await ctx.sms.messages.create({
        from: ctx.env.TWILIO_PHONE_NUMBER,
        to: alertPhone,
        body: `Modern Management billing alert: ${message}`,
      });
    }
  } catch (err) {
    console.warn('[subscription-lifecycle] operator alert send failed:', err.message);
  }
}

/**
 * Process customer.subscription.updated webhook event.
 * Idempotent. Mirrors Stripe state into workspaces.subscription_status,
 * workspaces.plan, and workspaces.canceled_at.
 *
 * D7: workspaces.subscription_tier is no longer read or written here —
 * the column is dropped by migration 031.
 */
async function processSubscriptionUpdatedEvent(event, pool, stripeClient, ctx = {}) {
  const eventId = event.id;
  const subscription = event.data && event.data.object;
  if (!subscription || !subscription.id) {
    console.warn('[subscription-lifecycle] subscription.updated: missing subscription object');
    return { skipped: true, reason: 'missing_subscription' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(
      `SELECT processed_at FROM stripe_events WHERE stripe_event_id = $1 FOR UPDATE`,
      [eventId]
    );
    if (eventRows.length === 0) {
      await client.query('ROLLBACK');
      console.warn(`[subscription-lifecycle] event ${eventId} not in stripe_events — likely race condition`);
      return { skipped: true, reason: 'event_row_missing' };
    }
    if (eventRows[0].processed_at !== null) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'already_processed' };
    }

    const { rows: wsRows } = await client.query(
      `SELECT id, owner_user_id, subscription_status, plan, canceled_at
       FROM workspaces WHERE stripe_subscription_id = $1 FOR UPDATE`,
      [subscription.id]
    );
    if (wsRows.length === 0) {
      await client.query(
        `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
        [eventId]
      );
      await client.query('COMMIT');
      console.warn(`[subscription-lifecycle] subscription.updated for unknown subscription ${subscription.id}`);
      return { skipped: true, reason: 'workspace_not_found' };
    }
    const workspace = wsRows[0];

    const newStatus = mapStripeStatusToWorkspaceStatus(subscription.status);
    const newPlan = await resolvePlanFromSubscription(subscription, stripeClient);

    const oldStatus = workspace.subscription_status;
    const oldPlan = workspace.plan;
    const planChanged = newPlan !== null && newPlan !== oldPlan;
    const statusChanged = newStatus !== oldStatus;
    const canceledAtIso = subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null;

    const updates = [];
    const params = [];
    let paramIdx = 1;
    if (statusChanged) {
      updates.push(`subscription_status = $${paramIdx++}`);
      params.push(newStatus);
    }
    if (planChanged) {
      updates.push(`plan = $${paramIdx++}`);
      params.push(newPlan);
      // Session D7: subscription_tier writeback removed. The column is
      // dropped by migration 031; workspaces.plan is canonical.
    }
    if (canceledAtIso && !workspace.canceled_at) {
      updates.push(`canceled_at = $${paramIdx++}`);
      params.push(canceledAtIso);
    }

    if (updates.length > 0) {
      params.push(workspace.id);
      await client.query(
        `UPDATE workspaces SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
        params
      );
    }

    await client.query(
      `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
      [eventId]
    );

    await client.query('COMMIT');

    // Post-commit, best-effort
    if (statusChanged || planChanged) {
      await logChange(pool, workspace.id, workspace.owner_user_id, 'subscription_updated', {
        old_status: oldStatus,
        new_status: newStatus,
        old_plan: oldPlan,
        new_plan: newPlan,
        stripe_subscription_id: subscription.id,
        stripe_event_id: eventId,
      });
    }

    if (newStatus === 'past_due' && oldStatus !== 'past_due') {
      await sendOperatorAlert(pool, workspace.id,
        `Subscription past due. Workspace ID ${workspace.id}, sub ${subscription.id}.`, ctx);
    }

    return { processed: true, workspace_id: workspace.id, statusChanged, planChanged };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[subscription-lifecycle] subscription.updated processing failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process customer.subscription.deleted webhook event.
 * Idempotent. Sets workspace to canceled state with canceled_at stamped.
 */
async function processSubscriptionDeletedEvent(event, pool, ctx = {}) {
  const eventId = event.id;
  const subscription = event.data && event.data.object;
  if (!subscription || !subscription.id) {
    console.warn('[subscription-lifecycle] subscription.deleted: missing subscription object');
    return { skipped: true, reason: 'missing_subscription' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(
      `SELECT processed_at FROM stripe_events WHERE stripe_event_id = $1 FOR UPDATE`,
      [eventId]
    );
    if (eventRows.length === 0) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'event_row_missing' };
    }
    if (eventRows[0].processed_at !== null) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'already_processed' };
    }

    const { rows: wsRows } = await client.query(
      `SELECT id, owner_user_id, subscription_status, plan
       FROM workspaces WHERE stripe_subscription_id = $1 FOR UPDATE`,
      [subscription.id]
    );
    if (wsRows.length === 0) {
      await client.query(
        `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
        [eventId]
      );
      await client.query('COMMIT');
      return { skipped: true, reason: 'workspace_not_found' };
    }
    const workspace = wsRows[0];

    await client.query(
      `UPDATE workspaces
         SET subscription_status = 'canceled',
             canceled_at = COALESCE(canceled_at, NOW())
       WHERE id = $1`,
      [workspace.id]
    );

    await client.query(
      `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
      [eventId]
    );

    await client.query('COMMIT');

    await logChange(pool, workspace.id, workspace.owner_user_id, 'subscription_canceled', {
      old_status: workspace.subscription_status,
      old_plan: workspace.plan,
      stripe_subscription_id: subscription.id,
      stripe_event_id: eventId,
    });

    return { processed: true, workspace_id: workspace.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[subscription-lifecycle] subscription.deleted processing failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process invoice.payment_failed webhook event.
 * Idempotent. Sets subscription_status='past_due' and triggers operator alert.
 */
async function processInvoicePaymentFailedEvent(event, pool, ctx = {}) {
  const eventId = event.id;
  const invoice = event.data && event.data.object;
  if (!invoice || !invoice.subscription) {
    return { skipped: true, reason: 'missing_subscription_on_invoice' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(
      `SELECT processed_at FROM stripe_events WHERE stripe_event_id = $1 FOR UPDATE`,
      [eventId]
    );
    if (eventRows.length === 0) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'event_row_missing' };
    }
    if (eventRows[0].processed_at !== null) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'already_processed' };
    }

    const { rows: wsRows } = await client.query(
      `SELECT id, owner_user_id, subscription_status, plan
       FROM workspaces WHERE stripe_subscription_id = $1 FOR UPDATE`,
      [invoice.subscription]
    );
    if (wsRows.length === 0) {
      await client.query(
        `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
        [eventId]
      );
      await client.query('COMMIT');
      return { skipped: true, reason: 'workspace_not_found' };
    }
    const workspace = wsRows[0];

    await client.query(
      `UPDATE workspaces SET subscription_status = 'past_due' WHERE id = $1`,
      [workspace.id]
    );

    await client.query(
      `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
      [eventId]
    );

    await client.query('COMMIT');

    await logChange(pool, workspace.id, workspace.owner_user_id, 'invoice_payment_failed', {
      old_status: workspace.subscription_status,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: invoice.subscription,
      stripe_event_id: eventId,
      attempt_count: invoice.attempt_count,
      amount_due: invoice.amount_due,
    });

    await sendOperatorAlert(pool, workspace.id,
      `Invoice payment failed. Workspace ${workspace.id}, invoice ${invoice.id}, attempt ${invoice.attempt_count}.`, ctx);

    return { processed: true, workspace_id: workspace.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[subscription-lifecycle] invoice.payment_failed processing failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  processSubscriptionUpdatedEvent,
  processSubscriptionDeletedEvent,
  processInvoicePaymentFailedEvent,
  // Exported for testing/inspection
  _mapStripeStatusToWorkspaceStatus: mapStripeStatusToWorkspaceStatus,
  _resolvePlanFromSubscription: resolvePlanFromSubscription,
};
