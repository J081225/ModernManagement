-- SQW5 (ruling R3): the auto-record toggle for Square counter payments.
-- DEFAULT FALSE at the schema layer — the default-off promise is pinned
-- here first, not just in UI state. When TRUE, lane 2's tray insert is
-- followed by the SAME record core the one-tap button uses (shared
-- function, identical seam), stamped recorded_via='auto' so provenance
-- stays honest. OFF = behavior identical to SQW3.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS square_auto_record_walkins BOOLEAN NOT NULL DEFAULT FALSE;
