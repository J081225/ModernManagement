-- =====================================================================
-- Phase 1 — 006_create_service_requests.sql
-- =====================================================================
-- Purpose:
--   Create `service_requests` — the generalized successor to
--   `maintenance_tickets`. Adds `request_type` (default 'maintenance'),
--   `workspace_id`, `entity_id`, `contact_id`, and `legacy_id` for
--   traceability.
--
-- Depends on: 001 (workspaces), 002 (entities), existing
--             `maintenance_tickets` and `contacts` tables.
-- Enables:    012 (backfill_service_requests), and /api/maintenance/*
--             cutover in Phase 2.
--
-- Column mapping (applied in 012):
--   maintenance_tickets.id                 → service_requests.legacy_id
--   maintenance_tickets.user_id            → service_requests.user_id
--   maintenance_tickets.title              → service_requests.title
--   maintenance_tickets.description        → service_requests.description
--   maintenance_tickets.unit               → service_requests.unit
--   maintenance_tickets.resident           → service_requests.requester_name
--   maintenance_tickets.category           → service_requests.category
--   maintenance_tickets.priority           → service_requests.priority
--   maintenance_tickets.status             → service_requests.status
--   maintenance_tickets.outcome            → service_requests.outcome
--   maintenance_tickets.requires_action    → service_requests.requires_action
--   maintenance_tickets.action_notes       → service_requests.action_notes
--   maintenance_tickets.emergency_sms_sent → service_requests.emergency_sms_sent
--   maintenance_tickets."createdAt"        → service_requests.created_at
--   maintenance_tickets."updatedAt"        → service_requests.updated_at
--   (constant 'maintenance')               → service_requests.request_type
--
-- Idempotent: Yes. Unique index on legacy_id.
-- Reversible: DROP TABLE IF EXISTS service_requests CASCADE;
-- =====================================================================

CREATE TABLE IF NOT EXISTS service_requests (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL DEFAULT 1,
  workspace_id        INTEGER,
  entity_id           INTEGER,
  contact_id          INTEGER,
  request_type        TEXT NOT NULL DEFAULT 'maintenance',
  title               TEXT NOT NULL,
  description         TEXT DEFAULT '',
  unit                TEXT DEFAULT '',
  requester_name      TEXT DEFAULT '',
  category            TEXT DEFAULT 'general',
  priority            TEXT DEFAULT 'normal',
  status              TEXT DEFAULT 'open',
  outcome             TEXT DEFAULT '',
  requires_action     BOOLEAN DEFAULT false,
  action_notes        TEXT DEFAULT '',
  emergency_sms_sent  BOOLEAN DEFAULT false,
  legacy_id           INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_requests_user_id_idx      ON service_requests(user_id);
CREATE INDEX IF NOT EXISTS service_requests_workspace_id_idx ON service_requests(workspace_id);
CREATE INDEX IF NOT EXISTS service_requests_status_idx       ON service_requests(status);
CREATE INDEX IF NOT EXISTS service_requests_priority_idx     ON service_requests(priority);
CREATE INDEX IF NOT EXISTS service_requests_request_type_idx ON service_requests(request_type);

CREATE UNIQUE INDEX IF NOT EXISTS service_requests_legacy_id_uq
  ON service_requests(legacy_id)
  WHERE legacy_id IS NOT NULL;
