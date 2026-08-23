// lib/square-webhook-log.js — SQW3: the Square webhook delivery log.
//
// One call per delivery, at whichever outcome the handler reaches. Keyed
// by Square's event_id so a redelivery updates attempts instead of adding
// a row; bad-signature deliveries (no parseable body) log with a NULL
// event id. Best-effort and fail-open: a logging failure must never
// affect the money path — it is reported to the console and swallowed.

async function logSquareWebhookEvent(pool, { eventId = null, eventType = null, merchantId = null, objectId = null, outcome, reason = null, httpStatus = 200 }) {
  if (!pool || !outcome) return;
  try {
    if (eventId) {
      await pool.query(
        `INSERT INTO square_webhook_events (square_event_id, event_type, merchant_id, object_id, outcome, reason, http_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (square_event_id) WHERE square_event_id IS NOT NULL
         DO UPDATE SET attempts = square_webhook_events.attempts + 1,
                       outcome = EXCLUDED.outcome, reason = EXCLUDED.reason,
                       http_status = EXCLUDED.http_status, updated_at = NOW()`,
        [eventId, eventType, merchantId, objectId, outcome, reason, httpStatus]
      );
    } else {
      await pool.query(
        `INSERT INTO square_webhook_events (square_event_id, event_type, merchant_id, object_id, outcome, reason, http_status)
         VALUES (NULL, $1, $2, $3, $4, $5, $6)`,
        [eventType, merchantId, objectId, outcome, reason, httpStatus]
      );
    }
  } catch (err) {
    console.error('[square-webhook-log] write failed (money path unaffected):', err.message);
  }
}

module.exports = { logSquareWebhookEvent };
