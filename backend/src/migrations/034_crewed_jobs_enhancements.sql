-- Migration 034: Crewed Jobs Enhancements
-- Adds crew_count to quotes for multi-crew quoting,
-- and per-assignment client_introduction tracking

-- crew_count: how many crew needed (defaults to 1, calculator multiplies fees)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS crew_count INTEGER DEFAULT 1;

-- Per-assignment intro tracking (in addition to quote-level)
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS client_introduction VARCHAR(20) DEFAULT 'todo';
