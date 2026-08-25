-- 085: BH0 (business-hours arc, rung 1) — closed weekdays.
-- 0=Sunday .. 6=Saturday. DEFAULT '{}' = no closed days = byte-
-- identical behavior for every existing workspace until set.
-- Announced before apply, 2026-08-25. Later rungs (open/close hours,
-- per-day hours, knowledge derived from the same source) build on
-- this column family — see docs/backlog-business-hours.md.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS closed_weekdays INTEGER[] DEFAULT '{}';
