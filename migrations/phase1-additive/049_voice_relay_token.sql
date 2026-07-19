-- FD3-CP4 — 049_voice_relay_token.sql
--
-- Per-workspace secret for the ConversationRelay WebSocket URL. The
-- socket previously accepted ANY upgrade on /twilio-relay with zero
-- auth (CP2-assigned finding); the token is generated lazily the
-- first time TwiML is issued for the workspace, embedded in the
-- wss:// URL, and validated on upgrade. NULL simply means "no voice
-- call has come in since this deploy" — the column self-populates.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS voice_relay_token TEXT;
