-- ============================================================================
-- 141: Carnet — Ooosh signatory settings (for the Letter of Authorisation)
--
-- The Letter of Authorisation PDF has a fixed Ooosh "appointment" block signed
-- by a director. These are editable from Settings → Carnet so the signatory /
-- address can change without a deploy. The signature image is uploaded to R2;
-- carnet_ooosh_signature_url holds its key.
--
-- system_settings PUT is update-only (not upsert), so the keys must be seeded.
-- See docs/CARNET-SPEC.md.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('carnet_ooosh_signatory_name', 'Jonathan Wood',  'Signatory name',            'carnets', 'text', 10),
  ('carnet_ooosh_signatory_role', 'Company Director','Signatory role / designation', 'carnets', 'text', 20),
  ('carnet_company_address',      'Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL, UK', 'Company address (letter header)', 'carnets', 'text', 30),
  ('carnet_ooosh_signature_url',  '',               'Signature image (R2 key)',  'carnets', 'url',  40)
ON CONFLICT (key) DO NOTHING;
