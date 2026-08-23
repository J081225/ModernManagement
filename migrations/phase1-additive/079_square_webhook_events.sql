-- SQW3 (first change): the Square webhook DELIVERY LOG. Announced in
-- docs/sqw-investigation.md §2.1c, pre-approved on principle.
--
-- Every delivery leaves a row with its OUTCOME, so "did Square send it /
-- what did we do with it?" is a DB query — never a Render-log ask again
-- (this machine cannot read Render logs; two diagnosis rounds were spent
-- on that). No raw bodies here: the tray keeps payment objects, the
-- refund table keeps refunds. Bad-signature deliveries carry no event id.
CREATE TABLE IF NOT EXISTS square_webhook_events (
  id               SERIAL PRIMARY KEY,
  square_event_id  TEXT,                  -- Square's event_id; NULL when unparseable/bad signature
  event_type       TEXT,
  merchant_id      TEXT,
  object_id        TEXT,                  -- payment id / refund id
  outcome          TEXT NOT NULL CHECK (outcome IN (
                     'completed', 'refused', 'tray_recorded', 'tray_duplicate', 'tray_refused',
                     'refund_settled', 'refund_refused', 'ignored_type', 'ignored_status',
                     'bad_signature', 'error')),
  reason           TEXT,
  http_status      INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 1,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Redelivery of the same event updates the row (attempts++), never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sq_webhook_event ON square_webhook_events (square_event_id) WHERE square_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sq_webhook_received ON square_webhook_events (received_at);
