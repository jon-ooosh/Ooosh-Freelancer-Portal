-- Free the `label` field on enquiry-form files.
--
-- Phase 1 wrote provenance INTO the user-facing tag: every file that arrived on
-- the public enquiry form got `label: 'From enquiry form'`. That squats on the
-- one field staff use to tag a file "Rider" or "Stage Plot" — so a client's
-- rider could be marked as coming from the enquiry form, or marked as a rider,
-- but never both. It also polluted the tag filter row with a pseudo-tag.
--
-- Provenance is now derived at read time from `uploaded_by = 'enquiry form'`
-- (which Phase 1 already stored) and shown as a separate muted "origin" chip,
-- so no replacement column is needed — just clear the squatted label.
-- routes/enquiry-intake.ts no longer writes it for new enquiries.
UPDATE jobs
SET files = (
      SELECT jsonb_agg(
               CASE WHEN f->>'label' = 'From enquiry form' THEN f - 'label' ELSE f END
             )
      FROM jsonb_array_elements(files) AS f
    ),
    updated_at = NOW()
WHERE files @> '[{"label": "From enquiry form"}]'::jsonb;
