-- Migration 047: Cancellation System
-- Adds 'cancelled' as a distinct status from 'lost', with cancellation-specific fields

-- Cancellation fields on jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_fee DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_refund DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_notice_days INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_notes TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancellation_tier VARCHAR(20);
-- Tier values: '>7_days', '2_to_7_days', '<2_days'

-- Track re-opened jobs (link original cancelled job to new booking)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reopened_from_job_id UUID REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reopened_to_job_id UUID REFERENCES jobs(id);

-- Cancellation reason picklist options (stored as cancellation_reason text, not FK)
-- Options: 'Client cancelled', 'Event cancelled', 'Date change', 'Venue change', 'Budget', 'Overbooked', 'Other'
