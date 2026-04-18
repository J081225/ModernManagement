-- =====================================================================
-- Phase 1 — 012_backfill_service_requests.sql
-- =====================================================================
-- Purpose:
--   Copy every row from `maintenance_tickets` into `service_requests`,
--   setting request_type='maintenance' and legacy_id = source id.
--
-- Depends on: 006 (service_requests table), 008 (workspaces),
--             009 (entities), existing maintenance_tickets table.
-- Enables:    /api/maintenance/* cutover in Phase 2.
--
-- Idempotent: Yes. ON CONFLICT (legacy_id) DO NOTHING via the partial
--             unique index created in 006.
--
-- Reversible: DELETE FROM service_requests WHERE request_type='maintenance'
--             AND legacy_id IS NOT NULL;
-- =====================================================================

INSERT INTO service_requests (
  user_id,
  workspace_id,
  entity_id,
  contact_id,
  request_type,
  title,
  description,
  unit,
  requester_name,
  category,
  priority,
  status,
  outcome,
  requires_action,
  action_notes,
  emergency_sms_sent,
  legacy_id,
  created_at,
  updated_at
)
SELECT
  mt.user_id,
  w.id  AS workspace_id,
  e.id  AS entity_id,
  (SELECT c.id FROM contacts c
     WHERE c.user_id = mt.user_id AND c.name = mt.resident
     LIMIT 1) AS contact_id,
  'maintenance' AS request_type,
  mt.title,
  mt.description,
  mt.unit,
  mt.resident AS requester_name,
  mt.category,
  mt.priority,
  mt.status,
  mt.outcome,
  mt.requires_action,
  mt.action_notes,
  mt.emergency_sms_sent,
  mt.id AS legacy_id,
  mt."createdAt" AS created_at,
  mt."updatedAt" AS updated_at
FROM maintenance_tickets mt
LEFT JOIN workspaces w ON w.owner_user_id = mt.user_id
LEFT JOIN entities   e ON e.workspace_id = w.id AND e.entity_type = 'property'
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING;

DO $$
DECLARE
  src_count INTEGER;
  dst_count INTEGER;
  orphan    INTEGER;
BEGIN
  SELECT COUNT(*) INTO src_count FROM maintenance_tickets;
  SELECT COUNT(*) INTO dst_count FROM service_requests WHERE request_type='maintenance';

  SELECT COUNT(*) INTO orphan
  FROM service_requests
  WHERE request_type='maintenance' AND workspace_id IS NULL;

  RAISE NOTICE 'Backfill 012: maintenance_tickets=% service_requests=% null_workspace=%',
               src_count, dst_count, orphan;

  IF dst_count < src_count THEN
    RAISE WARNING 'Backfill 012: destination row count < source. Investigate before proceeding.';
  END IF;
END $$;
