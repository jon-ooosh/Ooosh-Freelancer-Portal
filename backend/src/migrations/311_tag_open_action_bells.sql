-- Label the bells already waiting with what they ask for (jon, Oct 2026).
--
-- Migration 310 added notifications.resolve_key; from this release the code
-- sets it on every new bell that asks for something, and the rule for each
-- key in services/bell-rules.ts retires the bell once that is done. Bells
-- created BEFORE this release carry no key, so nothing would ever retire
-- them. This labels the open ones by the same type / record / title the code
-- writes; the first 5-minute sweep after the deploy then retires every one
-- whose thing is already done, by the rule — nothing here decides that.
--
-- Only open bells (acknowledged_at IS NULL) without a key. FYI bells that
-- share a type and record ("Issue resolved", "Approved", "Renewal coming up",
-- "Outstanding staff document") are deliberately NOT matched. Re-running it
-- changes nothing.

-- ── The two driver bells had no record at all: file them under the driver,
--    whose id is in their link (/drivers/<uuid>). Strict UUID shape, so the
--    cast can't fail.
UPDATE notifications
   SET entity_type = 'drivers',
       entity_id = substring(action_url from '^/drivers/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid
 WHERE type IN ('referral', 'dva_check')
   AND entity_id IS NULL
   AND action_url ~ '^/drivers/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- ── Problems, claims, sales, the studio, quote options ─────────────────────
UPDATE notifications SET resolve_key = 'problem_open'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'job_issues'
   AND (title LIKE 'New issue: %' OR title LIKE 'Issue re-flagged: %'
        OR title LIKE 'You''ve been assigned an issue: %');

UPDATE notifications SET resolve_key = 'claim_review'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'incident_claims'
   AND title LIKE 'Claim form submitted — %';

UPDATE notifications SET resolve_key = 'sale_photos'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'vehicle_sales'
   AND title LIKE '% is for sale — check its sale photos';

UPDATE notifications SET resolve_key = 'lockup_missing'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'studio_sitter_shifts'
   AND title LIKE '🔒 Lock-up not submitted — %';

UPDATE notifications SET resolve_key = 'option_siblings_open'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'quote_option_confirmed';

-- ── Drivers ────────────────────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'referral_needed'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'referral' AND entity_type = 'drivers';

UPDATE notifications SET resolve_key = 'dva_check_needed'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'dva_check' AND entity_type = 'drivers';

-- ── Storage and held items ─────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'storage_invoice'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'storage_tenancies'
   AND (title LIKE 'Storage invoice due — %' OR title LIKE 'Storage invoice overdue — %');

UPDATE notifications SET resolve_key = 'storage_rate_review'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'storage_tenancies'
   AND title LIKE 'Storage rate review due — %';

UPDATE notifications SET resolve_key = 'held_item_review'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'held_items'
   AND title LIKE 'Hold/review date %';

UPDATE notifications SET resolve_key = 'lost_property_chases'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'held_items'
   AND title LIKE 'Lost property: %chase%';

-- ── Settings and money ─────────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'kiosk_pin_rotation'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'kiosk_pin_rotation';

UPDATE notifications SET resolve_key = 'overtime_cashout'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_overtime_entry' AND entity_id IS NULL
   AND title LIKE 'Overtime to pay in January payroll — %';

-- ── Staff time, To Do, reviews, records ────────────────────────────────────
UPDATE notifications SET resolve_key = 'rtw_due'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_absence';

UPDATE notifications SET resolve_key = 'freelancer_unconfirmed'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'freelancer_day_booking';

UPDATE notifications SET resolve_key = 'task_owner'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type IN ('staff_task_due', 'staff_task_assigned', 'staff_task_handed_back')
   AND entity_type = 'staff_tasks';

UPDATE notifications SET resolve_key = 'task_list_item'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_list_item_due';

UPDATE notifications SET resolve_key = 'task_follow_up'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_task_follow_up';

UPDATE notifications SET resolve_key = 'series_proposed'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_task_series_proposed';

UPDATE notifications SET resolve_key = 'review_due'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_review_due' AND entity_type = 'people';

UPDATE notifications SET resolve_key = 'record_action'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_record_action_due';

UPDATE notifications SET resolve_key = 'record_delete'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'staff_record_delete_due';

-- ── Staff documents (all follow_up on the document) ─────────────────────────
UPDATE notifications SET resolve_key = 'staff_doc_to_complete'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_documents'
   AND (title LIKE 'Document to %: %' OR title LIKE 'Renewal due: %' OR title LIKE 'Reminder: %'
        OR title = 'A document was updated — please review again');

UPDATE notifications SET resolve_key = 'staff_doc_content_review'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_documents'
   AND (title LIKE 'Review due: %' OR title LIKE 'Overdue content review: %');

UPDATE notifications SET resolve_key = 'staff_doc_approval'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_documents'
   AND title LIKE 'Document awaiting approval: %';

UPDATE notifications SET resolve_key = 'staff_doc_changes'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'staff_documents'
   AND title LIKE 'Changes requested: %';
