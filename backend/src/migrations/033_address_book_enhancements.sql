-- Migration 033: Address book enhancements
-- Do Not Hire flag, Working Terms, AI text fields, file sharing

-- Do Not Hire flag on people and organisations
ALTER TABLE people ADD COLUMN IF NOT EXISTS do_not_hire BOOLEAN DEFAULT false;
ALTER TABLE people ADD COLUMN IF NOT EXISTS do_not_hire_reason TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS do_not_hire_set_at TIMESTAMPTZ;
ALTER TABLE people ADD COLUMN IF NOT EXISTS do_not_hire_set_by VARCHAR(255);

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS do_not_hire BOOLEAN DEFAULT false;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS do_not_hire_reason TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS do_not_hire_set_at TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS do_not_hire_set_by VARCHAR(255);

-- Working Terms on people and organisations
-- terms_type: 'usual', 'flex_balance', 'no_deposit', 'credit', 'custom'
ALTER TABLE people ADD COLUMN IF NOT EXISTS working_terms_type VARCHAR(50);
ALTER TABLE people ADD COLUMN IF NOT EXISTS working_terms_credit_days INTEGER;
ALTER TABLE people ADD COLUMN IF NOT EXISTS working_terms_notes TEXT;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS working_terms_type VARCHAR(50);
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS working_terms_credit_days INTEGER;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS working_terms_notes TEXT;

-- AI text fields (placeholder panels for future AI integration)
-- People already have 'notes' field — that becomes the internal notes
ALTER TABLE people ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS ai_research TEXT;

-- Organisations already have 'notes' field — that becomes the internal notes
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ai_research TEXT;

-- Venues already have 'general_notes' field — that becomes the internal notes
ALTER TABLE venues ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS ai_research TEXT;
