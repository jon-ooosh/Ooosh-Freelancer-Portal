-- Migration 006: Merge 'quoting' into 'new_enquiry' (now displayed as "Enquiries")
-- Any jobs with pipeline_status = 'quoting' are moved to 'new_enquiry'

UPDATE jobs SET pipeline_status = 'new_enquiry', updated_at = NOW()
WHERE pipeline_status = 'quoting';
