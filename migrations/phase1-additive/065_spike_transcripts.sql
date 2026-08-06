-- SPIKE (autodetect, Phase 2): transcript evidence capture for the
-- language-detection test line. TEMPORARY BY INTENT — this table is
-- the spike's evidence store, isolated from every production table,
-- and gets dropped when the spike closes with a ruling.
CREATE TABLE IF NOT EXISTS spike_transcripts (
  id          SERIAL PRIMARY KEY,
  call_sid    TEXT,
  event_type  TEXT NOT NULL,
  detected_language TEXT,
  transcript  TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
