-- Migration 024: Transport & Crew Operations
-- Adds operational tracking, completion, run grouping, and local delivery support to quotes

-- ============================================================
-- QUOTES TABLE — Operational fields
-- ============================================================

-- Operational status (independent of commercial quote status)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS ops_status VARCHAR(30) DEFAULT 'todo';

-- Completion tracking
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completed_by VARCHAR(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completion_notes TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completion_signature TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completion_photos JSONB DEFAULT '[]';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_present BOOLEAN;

-- Arranging details
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS key_points TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_introduction TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tolls_status VARCHAR(20) DEFAULT 'not_needed';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accommodation_status VARCHAR(20) DEFAULT 'not_needed';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS flight_status VARCHAR(20) DEFAULT 'not_needed';

-- Crewed job specifics
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS work_description TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS work_type VARCHAR(50);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS work_type_other TEXT;

-- Run grouping (multi-drop / combined jobs)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS run_group UUID;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS run_group_fee NUMERIC(10,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS run_order INTEGER;

-- Local delivery/collection flag
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS is_local BOOLEAN DEFAULT false;

-- ============================================================
-- QUOTE_ASSIGNMENTS TABLE — Freelancer confirmation + expenses
-- ============================================================

-- Freelancer confirmation
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- "Ooosh crew" flag (in-house staff, no specific person needed)
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS is_ooosh_crew BOOLEAN DEFAULT false;

-- Expense tracking (for future invoice comparison)
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS expected_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS actual_expenses NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS expense_notes TEXT;
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS invoice_received BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS invoice_amount NUMERIC(10,2);
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS invoice_queried BOOLEAN DEFAULT false;
ALTER TABLE quote_assignments ADD COLUMN IF NOT EXISTS invoice_query_notes TEXT;

-- ============================================================
-- INDEXES for operations queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_quotes_ops_status ON quotes(ops_status);
CREATE INDEX IF NOT EXISTS idx_quotes_job_date ON quotes(job_date);
CREATE INDEX IF NOT EXISTS idx_quotes_run_group ON quotes(run_group) WHERE run_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_job_type ON quotes(job_type);

-- ============================================================
-- CALCULATOR SETTINGS — Local delivery default fee
-- ============================================================

INSERT INTO calculator_settings (key, value, label, category)
VALUES ('local_delivery_fee', '50', 'Local delivery/collection fee', 'transport')
ON CONFLICT (key) DO NOTHING;
