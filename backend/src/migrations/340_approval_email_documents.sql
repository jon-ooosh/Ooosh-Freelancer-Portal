-- Staff Documents attached to the "you're approved" email (jon, Nov 2026;
-- services/approval-email-documents.ts, FREELANCER-PORTAL-SPEC.md §8).
--
-- The portal's how-to guide was only readable once a freelancer had logged in to
-- the portal, so a new freelancer couldn't read how to use it first. A document
-- shared with freelancers can now be ticked "Attach to the 'you're approved'
-- email": the email carries its CURRENT version's file, so a new version needs
-- no other change. Only while the document is shared with freelancers.
ALTER TABLE staff_documents
  ADD COLUMN IF NOT EXISTS attach_to_approval_email BOOLEAN NOT NULL DEFAULT FALSE;
