// lib/connect-lifecycle.js
//
// E13 — Stripe Connect (Express) lifecycle helpers. TEST MODE foundation.
//
// Pairs with:
//   - POST /api/connect/onboarding/start  (creates Express account on first
//     call, then always returns a fresh Account Link)
//   - GET  /payments/connect/return       (post-onboarding redirect; calls
//     syncAccountState to mirror Stripe → DB before bouncing into the app)
//   - GET  /payments/connect/refresh      (link expired; mints a new one)
//   - webhook case 'account.updated'      (calls processAccountUpdatedEvent)
//
// NO charge/payment-intent code lives here. This file is purely about
// keeping workspaces.connect_status in lockstep with the connected
// account's Stripe state — derived from charges_enabled +
// details_submitted on the Account object.
//
// Schema reality (E13 migration 041):
//   workspaces.stripe_connect_account_id  TEXT      nullable
//   workspaces.connect_status             TEXT NOT NULL DEFAULT 'not_started'
//                                         CHECK IN ('not_started','pending','ready','restricted')
//   workspaces.connect_charges_enabled    BOOLEAN NOT NULL DEFAULT FALSE
//   workspaces.connect_details_submitted  BOOLEAN NOT NULL DEFAULT FALSE
//   workspaces.connect_updated_at         TIMESTAMPTZ

/**
 * Derive a workspace connect_status from the boolean flags Stripe carries
 * on a connected Account object.
 *
 *   charges_enabled === true                      → 'ready'
 *   details_submitted but NOT charges_enabled     → 'restricted'
 *   account exists but neither flag set yet       → 'pending'
 *
 * 'not_started' is the pre-account-creation state and is never derived
 * here — it's the column default for workspaces that haven't kicked off
 * onboarding at all.
 */
function deriveConnectStatus({ charges_enabled, details_submitted }) {
  if (charges_enabled === true) return 'ready';
  if (details_submitted === true) return 'restricted';
  return 'pending';
}

/**
 * Mirror a fetched Stripe Account object into the workspaces row keyed by
 * stripe_connect_account_id. Naturally idempotent — running it twice with
 * the same Account in the same state is effectively a no-op (updated_at
 * advances, nothing else moves).
 *
 * Returns { matched, ... } so callers can react (e.g., the return route
 * could pick where to redirect based on the new status if we ever want
 * to). Today both callers just fire-and-forget the result.
 */
async function syncAccountState(pool, accountObject) {
  const accountId = accountObject && accountObject.id;
  if (!accountId) return { matched: false, reason: 'no_account_id' };

  const charges_enabled = !!accountObject.charges_enabled;
  const details_submitted = !!accountObject.details_submitted;
  const newStatus = deriveConnectStatus({ charges_enabled, details_submitted });

  const r = await pool.query(
    `UPDATE workspaces
        SET connect_charges_enabled   = $1,
            connect_details_submitted = $2,
            connect_status            = $3,
            connect_updated_at        = NOW()
      WHERE stripe_connect_account_id = $4
      RETURNING id, connect_status`,
    [charges_enabled, details_submitted, newStatus, accountId]
  );
  if (r.rows.length === 0) {
    return {
      matched: false,
      reason: 'workspace_not_found',
      stripe_connect_account_id: accountId,
    };
  }
  return {
    matched: true,
    workspace_id: r.rows[0].id,
    new_status: r.rows[0].connect_status,
    charges_enabled,
    details_submitted,
  };
}

/**
 * Process the account.updated webhook event. Lightweight — the heavy
 * lifting is in syncAccountState. Errors propagate so the webhook
 * dispatcher can decide to 500 Stripe for retry.
 *
 * Unlike the subscription handlers in lib/subscription-lifecycle.js,
 * this one doesn't gate on stripe_events.processed_at — the underlying
 * UPDATE is naturally idempotent, so re-processing the same event is
 * harmless (Stripe's typical retry behavior just refreshes connect_updated_at).
 */
async function processAccountUpdatedEvent(event, pool) {
  const accountObject = event && event.data && event.data.object;
  return syncAccountState(pool, accountObject);
}

module.exports = {
  deriveConnectStatus,
  syncAccountState,
  processAccountUpdatedEvent,
};
