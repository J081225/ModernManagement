-- 045_workspace_ai_personality.sql
--
-- Store an owner's chosen assistant tone and sales approach as per-
-- workspace preferences that the appointment engine reads at prompt-
-- build time to actually change how the AI talks (voice + SMS + email).
--
--   ai_tone
--     Allowed values (validated at the /api/workspace/ai-settings PATCH
--     endpoint, no DB CHECK constraint so we can widen later without a
--     migration): 'warm' | 'professional' | 'brief' | NULL.
--     NULL = current default behavior (existing "Be concise" bullet + the
--     voice-channel "warm receptionist" block only).
--
--   ai_sales_posture
--     Allowed values: 'reactive' | 'proactive' | NULL.
--     NULL = current default (no explicit sales guidance).
--
-- Read by lib/appointment-engine.buildSystemPrompt after the "## Your job"
-- section — an "if set, inject a paragraph" pattern that leaves existing
-- workspaces unaffected until they opt in via the My Business UI.
--
-- Both columns nullable and no DEFAULT, so applying this migration to a
-- live DB is a zero-behavior-change operation; existing rows read NULL
-- and the prompt builder's null-guards fall through to today's copy.
-- ADD COLUMN IF NOT EXISTS is safe to re-run.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_tone TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_sales_posture TEXT;
