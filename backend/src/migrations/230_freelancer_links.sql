-- ============================================================================
-- 230: The three links a newly approved freelancer needs on day one
-- ============================================================================
-- The approval email used to be a welcome and nothing else: it TOLD people that
-- work is offered through a WhatsApp group without linking it, and the
-- onboarding checklist's "send them the portal sign-up link" was a job someone
-- had to remember to do by hand, from memory, per freelancer.
--
-- Settings rather than constants because a WhatsApp group invite link is
-- effectively a password — it gets reset when a group is tidied or a link
-- leaks — and the day that happens, every approval email points at a dead
-- invite until someone can ship a deploy. Same argument, weaker, for the
-- invoicing guide. Each block in the email is conditional, so emptying one of
-- these drops it from the email instead of sending a broken link.
--
-- The portal URL is the freelancer-facing app (registration is self-service and
-- gated on being an approved freelancer whose email matches the people record),
-- NOT the staff app.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('freelancer_whatsapp_url',      'https://chat.whatsapp.com/IQmYQSGWqOK637fRlLRpq7',
     'WhatsApp group invite link',  'freelancers', 'text', 10),
  ('freelancer_portal_url',        'https://www.freelancer.oooshtours.co.uk',
     'Freelancer portal URL',       'freelancers', 'text', 20),
  ('freelancer_invoice_guide_url', 'https://docs.google.com/document/d/1ITv-dhKRuv4TbMl3uaIIH_d1-qt1a_uzLsG3BLDIl4k/',
     'How to invoice us (guide)',   'freelancers', 'text', 30)
ON CONFLICT (key) DO NOTHING;
