-- Amend the COT card agreement wording (jon, Jul 2026): clause 2 gains
-- "…, or as soon as possible" — you don't always get an invoice at the point of
-- ordering and may have to wait a week or so.
--
-- Done as an in-place REPLACE on the current version body (NOT a new version) so
-- the handful of staff who already signed are not forced to re-sign for this
-- minor clarification — and their signed snapshot PDFs already preserve the exact
-- text they agreed to. Future material changes should go via the "New version"
-- flow in the admin UI, which correctly re-flags completers.
--
-- Idempotent: REPLACE is a no-op once the new phrase is present, and if the doc
-- text has since been edited in-app this simply finds no match.
UPDATE staff_document_versions v
SET body = REPLACE(
  v.body,
  'submit it (via the Operations Platform / to the office) **within 3 working days**.',
  'submit it (via the Operations Platform / to the office) **within 3 working days**, or as soon as possible.'
)
FROM staff_documents d
WHERE d.id = v.document_id
  AND d.slug = 'cot-card-agreement';
