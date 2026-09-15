-- Fold the rehearsal-profile "desk files" into the general org Files store.
--
-- organisation_rehearsal_profile.files (migration 176) was a second, bespoke file
-- surface: a band's stage plots and saved desk files, shown read-only on job Files
-- tabs by the RehearsalProfileFiles component. That predated organisations having
-- a real Files tab. Now that they do — and now that org files surface on every job
-- the org is on by themselves (CROSS-ENTITY-FILES-SPEC.md Phase 4) — a separate
-- store is one more place to look. One Files banner is the whole point.
--
-- The two shapes differ, so this is a mapping, not a copy:
--
--   profile file                      FileAttachment
--   ─────────────────────────────     ──────────────────────────────
--   r2_key                       →    url
--   filename                     →    name
--   (nothing)                    →    type      derived from the extension
--   uploaded_by = a USER UUID    →    uploaded_by = that user's EMAIL
--   label (often absent)         →    label, defaulting to 'Desk settings'
--
-- `content_type` / `size_bytes` are dropped: FileAttachment has no home for them
-- and nothing reads them. Files already present on the org (matched by R2 key) are
-- skipped, so this is safe to re-run and can't double up.
--
-- organisation_rehearsal_profile.files is deliberately LEFT IN PLACE and simply
-- stops being read — a later cleanup migration drops it, once this has been live
-- long enough to be sure nothing needed rolling back.
UPDATE organisations o
SET files = COALESCE(o.files, '[]'::jsonb) || m.new_files,
    updated_at = NOW()
FROM (
  SELECT p.organisation_id,
         jsonb_agg(
           jsonb_strip_nulls(
             jsonb_build_object(
               'name', COALESCE(NULLIF(f->>'filename', ''), 'Desk file'),
               'url',  f->>'r2_key',
               'type', CASE
                         WHEN f->>'filename' ~* '\.(jpg|jpeg|png|gif|webp|svg)$' THEN 'image'
                         WHEN f->>'filename' ~* '\.(pdf|doc|docx|xls|xlsx|csv|txt|rtf)$' THEN 'document'
                         ELSE 'other'
                       END,
               -- ISO-8601, matching what the app writes (new Date().toISOString()).
               -- NOW()::text yields '2026-09-09 09:23:45+00', which not every
               -- browser's Date parser accepts.
               'uploaded_at', COALESCE(
                 NULLIF(f->>'uploaded_at', ''),
                 to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
               ),
               -- The profile stored a user id; FileAttachment shows a person.
               -- Compare as text so a non-UUID value can't raise 22P02.
               'uploaded_by', COALESCE(u.email, 'rehearsals profile'),
               'label', COALESCE(NULLIF(f->>'label', ''), 'Desk settings'),
               'comment', NULLIF(f->>'comment', '')
             )
           )
         ) AS new_files
  FROM organisation_rehearsal_profile p
  CROSS JOIN LATERAL jsonb_array_elements(p.files) AS f
  JOIN organisations oo ON oo.id = p.organisation_id
  LEFT JOIN users u ON u.id::text = f->>'uploaded_by'
  WHERE COALESCE(f->>'r2_key', '') <> ''
    -- Already on the org (a re-run, or someone copied it by hand) — leave it.
    AND NOT COALESCE(oo.files, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('url', f->>'r2_key'))
  GROUP BY p.organisation_id
) m
WHERE o.id = m.organisation_id;
