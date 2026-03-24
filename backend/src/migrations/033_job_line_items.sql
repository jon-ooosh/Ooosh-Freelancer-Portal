-- Migration 033: Add line_items JSONB column to jobs table
-- Stores HireHop job line items locally so the Allocations page
-- can load instantly from the database instead of making ~50
-- individual HireHop API calls per page load.
--
-- Format: [{ "ITEM_ID": 1130, "ITEM_NAME": "Premium LWB...", "QUANTITY": 1, "CATEGORY_ID": 370 }, ...]

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]';

-- Index for queries that filter on line items (e.g. "jobs with vehicles")
CREATE INDEX IF NOT EXISTS idx_jobs_line_items_gin ON jobs USING gin (line_items);
