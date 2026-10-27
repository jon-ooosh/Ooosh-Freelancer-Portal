-- 322: the completion chaser's 2nd reminder also goes by text (jon, Oct 2026,
-- after HH 16535: a freelancer who never completed on the portal and didn't
-- see the emails). On from the start; 'false' stops the texts without a
-- deploy, the emails carry on. services/completion-chaser.ts.
--
-- Category 'sms', not 'freelancers': the Settings page draws every
-- 'freelancers' row as a link box. Like the other on/off switches
-- (closeout_arrival_hook_enabled, shop_auto_close_enabled) it has no screen:
--   UPDATE system_settings SET value = 'false' WHERE key = 'completion_chase_sms_enabled';
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('completion_chase_sms_enabled', 'true',
        'Text freelancers with the 2nd "please complete your job" reminder (when we have their mobile)',
        'sms', 'bool', 10)
ON CONFLICT (key) DO NOTHING;
