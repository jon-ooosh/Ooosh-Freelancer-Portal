-- 313_freelancer_portal_url_fix.sql
-- The approval email's "Set up your portal login" button pointed nowhere.
--
-- Migration 230 seeded freelancer_portal_url as https://www.freelancer.oooshtours.co.uk.
-- That "www." host has no DNS record (only freelancer.oooshtours.co.uk exists), so
-- every approval email since 21 Sep 2026 sent new freelancers to "This site can't be
-- reached" (Henry Pascoe-Smith, 22 Oct 2026). The portal itself was fine.
--
-- Points the button straight at the sign-up form. Only replaces the bad seeded value —
-- never overwrites an address someone has typed in Settings › Freelancer welcome links.

UPDATE system_settings
   SET value = 'https://freelancer.oooshtours.co.uk/register', updated_at = NOW()
 WHERE key = 'freelancer_portal_url'
   AND value IN ('https://www.freelancer.oooshtours.co.uk', 'https://www.freelancer.oooshtours.co.uk/');
