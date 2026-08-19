-- B3 (AI-scope hardening): turn-counted topic redirect. Consecutive
-- customer turns with no business intent (no booking/hours/price/payment
-- signal in the message AND no tool call in the reply) are counted HERE
-- — in code, not prompt-only. At 4 Sarah redirects once (warm, never
-- scolding); at 6 she offers a message and closes politely (canned,
-- declared variants, zero model cost). Any business signal resets to 0.
ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS off_topic_turns INTEGER NOT NULL DEFAULT 0;
