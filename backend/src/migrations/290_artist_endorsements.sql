-- 290_artist_endorsements.sql
-- Artist endorsements (jon, 16 Oct 2026 — docs/DISCOUNTS-SPEC.md phase 1).
--
-- A reference, not a calculator: who is endorsed by which brand, what the deal
-- is (FREE TEXT — no maths on it), who confirmed it and when it was last checked.
-- We only ever see a snapshot ("endorsed when they toured with us"), so there is
-- no expiry date: a check older than 12 months is flagged, that's all.
--
-- An endorsement belongs to the ARTIST — it follows them, not the band. When the
-- artist isn't in OP ("our drummer is endorsed by C&C") it can sit on the band,
-- with `who` saying who. Exactly one of person_id / organisation_id (CHECK).
-- Ended, never deleted (soft-cancel convention).
--
-- Read and written ONLY through services/endorsements.ts.

CREATE TABLE IF NOT EXISTS endorsement_brands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  standard_deal TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_endorsement_brands_name ON endorsement_brands (LOWER(name));

INSERT INTO endorsement_brands (name, standard_deal) VALUES
  ('DW',     '70% off DW kit (subject to minimum hire charge)'),
  ('Orange', '70% off Orange kit (subject to minimum hire charge)'),
  ('C&C',    '70% off C&C kit (subject to minimum hire charge)'),
  ('Paiste', '70% off Paiste kit (subject to minimum hire charge)'),
  ('GK',     '70% off GK kit (subject to minimum hire charge)')
ON CONFLICT ((LOWER(name))) DO NOTHING;

CREATE TABLE IF NOT EXISTS artist_endorsements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        UUID NOT NULL REFERENCES endorsement_brands(id),
  person_id       UUID REFERENCES people(id),
  organisation_id UUID REFERENCES organisations(id),
  who             TEXT,            -- e.g. "Drummer — Sam" (mostly for band-level ones)
  deal            TEXT,            -- free text; NULL = the brand's standard deal
  confirmed_with  TEXT,            -- the rep / A&R who gave the nod
  last_checked_on DATE,            -- NULL = not confirmed yet
  last_checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ended_at        TIMESTAMPTZ,
  ended_reason    TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT artist_endorsements_one_owner CHECK ((person_id IS NULL) <> (organisation_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_artist_endorsements_person ON artist_endorsements(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artist_endorsements_org    ON artist_endorsements(organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artist_endorsements_brand  ON artist_endorsements(brand_id);
