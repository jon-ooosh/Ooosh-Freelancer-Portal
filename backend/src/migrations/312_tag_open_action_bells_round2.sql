-- Label the bells already waiting, second round (jon, Oct 2026).
--
-- Migration 311 labelled the first set of bells that ask for something; this
-- does the same for the keys added since: chases, requirement chases, van
-- compliance, mid-tour drivers, the managers' staff-document escalation,
-- claim check-ins and client chases, company-card receipts and undelivered
-- emails. As in 311, it only LABELS open bells by the type / record / title
-- the code writes; the first 5-minute sweep after the deploy then retires
-- every one whose thing is already done, by the rule in
-- services/bell-rules.ts — nothing here decides that.
--
-- Only open bells (acknowledged_at IS NULL) without a key. Deliberately NOT
-- matched: New Enquiry's "Chase reminder" (sent at once, with a future chase
-- date, so it would read as done straight away), the prep-flag and low-tread
-- van bells, "Mid-tour driver auto-added", and a send failure "Email not
-- delivered" (Resend could not send it — nothing about the address to fix).
-- Re-running it changes nothing.

-- ── Jobs: chases and requirements ──────────────────────────────────────────
UPDATE notifications SET resolve_key = 'chase_due'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'chase_alert' AND entity_type = 'jobs'
   AND (title LIKE 'Chase due: %' OR title LIKE 'Auto-chase stopped: %');

UPDATE notifications SET resolve_key = 'requirement_due'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND entity_type = 'job_requirements'
   AND ((type = 'chase_alert' AND title LIKE 'Overdue: %')
        OR (type = 'follow_up' AND title LIKE 'Reminder: %'));

-- ── Vans: compliance, one key per item. "Service" and "Rossetts Service"
--    can't match each other: the item follows the "OVERDUE: " / "Due soon: ".
UPDATE notifications SET resolve_key = 'compliance_mot'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: MOT — %' OR title LIKE 'Due soon: MOT — %');

UPDATE notifications SET resolve_key = 'compliance_tax'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: Tax — %' OR title LIKE 'Due soon: Tax — %');

UPDATE notifications SET resolve_key = 'compliance_insurance'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: Insurance — %' OR title LIKE 'Due soon: Insurance — %');

UPDATE notifications SET resolve_key = 'compliance_tfl'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: TFL — %' OR title LIKE 'Due soon: TFL — %');

UPDATE notifications SET resolve_key = 'compliance_service'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: Service — %' OR title LIKE 'Due soon: Service — %');

UPDATE notifications SET resolve_key = 'compliance_rossetts'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'compliance' AND entity_type = 'fleet_vehicles'
   AND (title LIKE 'OVERDUE: Rossetts Service — %' OR title LIKE 'Due soon: Rossetts Service — %');

-- ── Drivers ────────────────────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'mid_tour_driver'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'hire_form' AND entity_type = 'vehicle_hire_assignments'
   AND title LIKE 'Mid-tour driver — %';

-- ── Claims ─────────────────────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'claim_check_in'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'incident_claims'
   AND title LIKE 'Check in on claim — %';

UPDATE notifications SET resolve_key = 'claim_form_chase'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND entity_type = 'incident_claims'
   AND title LIKE 'Client form not coming back — %';

-- ── Money and email ────────────────────────────────────────────────────────
UPDATE notifications SET resolve_key = 'cot_receipts'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'follow_up' AND entity_type = 'costs' AND entity_id IS NULL
   AND title ~ '^[0-9]+ company-card purchases? needs? a receipt$';

UPDATE notifications SET resolve_key = 'email_undelivered'
 WHERE resolve_key IS NULL AND acknowledged_at IS NULL
   AND type = 'system' AND title LIKE 'Email not delivered to %'
   AND content NOT LIKE '%: Resend could not send it. What to do: Re-send it.%';

-- ── The managers' "Outstanding staff document" escalation. New ones point at
--    the person's ASSIGNMENT; the old ones point at the document, with the
--    person only in the wording ("<name> still hasn’t completed “<title>”"),
--    built exactly as the scanner builds it. Re-pointed only where that names
--    exactly one assignee on the document — a renamed person, or two with the
--    same name, is left alone and keeps its Done button.
WITH m AS (
  SELECT n.id AS bell_id, MIN(a.id::text)::uuid AS assignment_id, COUNT(*) AS hits
    FROM notifications n
    JOIN staff_document_assignments a ON a.document_id = n.entity_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN people p ON p.id = u.person_id
   WHERE n.resolve_key IS NULL AND n.acknowledged_at IS NULL
     AND n.type = 'follow_up' AND n.entity_type = 'staff_documents'
     AND n.title LIKE 'Outstanding staff document: %'
     AND starts_with(n.content,
           COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''), u.email)
           || ' still hasn’t completed “')
   GROUP BY n.id
)
UPDATE notifications n
   SET entity_type = 'staff_document_assignments',
       entity_id = m.assignment_id,
       resolve_key = 'staff_doc_escalation'
  FROM m
 WHERE n.id = m.bell_id AND m.hits = 1;
