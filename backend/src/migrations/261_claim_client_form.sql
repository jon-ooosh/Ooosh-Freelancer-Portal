-- ============================================================================
-- 261: Possible claims — Phase 2, the client form
-- ============================================================================
-- docs/INCIDENT-CLAIMS-SPEC.md §6.2, §8, §10.
--
--   incident_claim_links  — one tokenised link per recipient (drivers on the
--       van, the lead contact, anyone a recipient forwards it to). Token in the
--       clear: a chase must re-send the SAME link (house convention, see
--       services/freelancer-day-offer.ts). Works while the case is open /
--       form_out; dead once revoked.
--   incident_claim_codes  — 6-digit email codes proving "I was the driver"
--       (spec D7). Own table rather than driver_verification_codes so a claim
--       code can never consume or clash with a hire-form code. Hashed.
--   fleet_vehicles.outline_type — which van drawing to mark damage on.
--       NULL = guess from make/model/vehicle_type (services side), generic if
--       nothing matches.
--   incident_claim_files.uploaded_via_link_id — client uploads have no user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS incident_claim_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          UUID NOT NULL REFERENCES incident_claims(id) ON DELETE CASCADE,
  token             TEXT NOT NULL UNIQUE,
  recipient_name    TEXT,
  recipient_email   TEXT,
  driver_id         UUID REFERENCES drivers(id),
  person_id         UUID REFERENCES people(id),
  -- 'driver' (a driver on the van) · 'contact' (a job contact / typed in by
  -- staff) · 'forwarded' (created by a recipient handing it on)
  role              VARCHAR(20) NOT NULL DEFAULT 'contact'
    CHECK (role IN ('driver', 'contact', 'forwarded')),
  status            VARCHAR(20) NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'opened', 'handed_off', 'submitted', 'revoked')),
  -- What the person said about themselves on "Who's filling this in?"
  filled_as         VARCHAR(20) CHECK (filled_as IN ('driver', 'witness')),
  filled_by_name    TEXT,
  handed_off_from   UUID REFERENCES incident_claim_links(id),
  sent_at           TIMESTAMPTZ,
  first_opened_at   TIMESTAMPTZ,
  last_opened_at    TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_claim_links_claim ON incident_claim_links(claim_id);

CREATE TABLE IF NOT EXISTS incident_claim_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      UUID NOT NULL REFERENCES incident_claim_links(id) ON DELETE CASCADE,
  driver_id    UUID NOT NULL REFERENCES drivers(id),
  code_hash    TEXT NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_claim_codes_link ON incident_claim_codes(link_id, created_at);

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS outline_type VARCHAR(20)
  CHECK (outline_type IN ('vito', 'sprinter_mwb', 'sprinter_lwb', 'generic'));

ALTER TABLE incident_claim_files ADD COLUMN IF NOT EXISTS uploaded_via_link_id UUID REFERENCES incident_claim_links(id);

-- Who submitted, and when (the client form's submit, or staff marking it complete).
ALTER TABLE incident_claims ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE incident_claims ADD COLUMN IF NOT EXISTS submitted_via_link_id UUID REFERENCES incident_claim_links(id);
