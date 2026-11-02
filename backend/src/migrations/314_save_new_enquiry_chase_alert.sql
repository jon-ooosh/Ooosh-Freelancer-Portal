-- New Enquiry's "Alert: X" was never saved on the job (jon, Oct 2026).
--
-- The form's "First chase [date] · Alert: X" is meant to have the 08:00 chase
-- scanner send X a "Chase due" on that date. createPipelineEnquiry only sent X
-- a "Chase reminder" bell at once and never stored X on the job, so the
-- scanner — which needs jobs.chase_alert_user_id — never alerted anyone. From
-- this release it is saved (with delivery 'bell'). This fills it in for the
-- enquiries already open, from the "Chase reminder" bell each one sent.
--
-- Only a job whose chase-alert setting nobody has ever saved (user AND
-- delivery both blank): the Chase modal always saves a delivery, so a person
-- who has since set "no alert" there is never overruled. Only live enquiries
-- (the scanner's stages, not dismissed or deleted) and an active recipient.
--
-- One-off effect: at the next 08:00 run, every one of these whose chase date
-- has already passed gets its "Chase due" bell. Re-running it changes nothing.

UPDATE jobs j
   SET chase_alert_user_id = b.user_id,
       chase_alert_delivery = 'bell'
  FROM (SELECT DISTINCT ON (n.entity_id) n.entity_id, n.user_id
          FROM notifications n
         WHERE n.type = 'chase_alert' AND n.entity_type = 'jobs'
           AND n.title LIKE 'Chase reminder: %'
         ORDER BY n.entity_id, n.created_at DESC) b
  JOIN users u ON u.id = b.user_id AND u.is_active = true
 WHERE j.id = b.entity_id
   AND j.chase_alert_user_id IS NULL
   AND j.chase_alert_delivery IS NULL
   AND j.is_deleted = false
   AND j.dismissed_at IS NULL
   AND j.pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional');
