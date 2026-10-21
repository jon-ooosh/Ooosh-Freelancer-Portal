-- Migration 301: freelancer invoices fall due from APPROVAL again
--
-- Ooosh pays freelancers on the first Friday one week after an invoice is
-- approved (8 to 14 days after approval; jon, Oct 2026). Since Sep 2026 OP had
-- counted from the invoice date instead. services/supplier-terms.ts now counts
-- from approval for bills approved from this moment on; bills approved before
-- it keep the date they already have (and already sent to Xero).
--
-- This row records the moment of the switch: it is stamped when the migration
-- runs, i.e. at deploy. Don't edit it — moving it moves real bills' due dates.

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('freelancer_terms_approval_from',
        to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Freelancer invoices approved from this moment fall due on the first Friday a week after approval (set at deploy; do not edit)',
        'freelancers', 'text', 90)
ON CONFLICT (key) DO NOTHING;
