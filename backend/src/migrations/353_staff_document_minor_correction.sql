-- 353: a "small correction" version of a Staff Document (jon, 19 Nov 2026).
-- An admin can publish a typo fix without asking everyone to read / sign it again:
-- completed sign-offs stay completed, freelancers' read-confirmations are carried
-- over to the corrected version, and no bells go out. The flag keeps the record
-- honest — a person who signed version 2 signed it before version 3's correction.
ALTER TABLE staff_document_versions
  ADD COLUMN IF NOT EXISTS minor_correction BOOLEAN NOT NULL DEFAULT false;
