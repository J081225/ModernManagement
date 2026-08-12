-- SQ3: Square as a second card processor. The active-processor choice
-- plus Square's OAuth connection state. Mirrors the stripe_connect_*
-- shape (SP3 status-axis pattern), additive — Stripe workspaces are
-- untouched (payment_processor defaults 'stripe').

-- The ONE active processor per workspace (ruling 1/2). Both can be
-- connected; exactly one is active. Defaults 'stripe' so every
-- existing workspace keeps its current behavior.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS payment_processor TEXT NOT NULL DEFAULT 'stripe';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_payment_processor_valid') THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_payment_processor_valid
      CHECK (payment_processor IN ('stripe', 'square'));
  END IF;
END $$;

-- Square OAuth connection. access_token / refresh_token are BEARER
-- CREDENTIALS to the merchant's Square account — stored AES-256-GCM
-- encrypted (lib/token-crypto, keyed by TOKEN_ENCRYPTION_KEY), never
-- in plaintext. The columns hold ciphertext.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS square_merchant_id        TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS square_access_token_enc   TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS square_refresh_token_enc  TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS square_token_expires_at   TIMESTAMPTZ;

-- The Square status axis (SP3 pattern). Sandbox docs refined SQ1:
-- access tokens expire after 30 DAYS; refresh tokens (code flow) do
-- NOT expire — so 'connected' is kept alive by refresh, 'expired' is
-- the access-token-lapsed-and-refresh-failed state, 'revoked' is the
-- seller disconnecting. 'not_started' is the default.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS square_status TEXT NOT NULL DEFAULT 'not_started';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_square_status_valid') THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_square_status_valid
      CHECK (square_status IN ('not_started', 'connected', 'expired', 'revoked'));
  END IF;
END $$;
