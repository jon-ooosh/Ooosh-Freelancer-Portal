-- 347: the referral scheme (docs/BUSINESS-FIGURES-SPEC.md §8d).
--
-- A client (a PERSON, never a band) recommends us; the friend's enquiry is linked to them
-- by their personal link (go.oooshtours.co.uk/r/<code>) or by staff ("Who recommended
-- us?" / a postcard with a name on it). When the friend's hire is Completed a manager is
-- asked to send the referrer a thank-you; the friend can get a welcome credit, which IS a
-- goodwill credit (source 'referral') — nothing new for money.

-- One personal link per person. The code is printed / shared, so it never changes.
CREATE TABLE IF NOT EXISTS referral_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  code          VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]*$'),
  scans         INTEGER NOT NULL DEFAULT 0,       -- people, not link previews / crawlers
  last_scan_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- What we're offering. The newest row is the current offer; each referral keeps the one
-- that was live, so offers can be compared over time. Plain text — jon rotates them.
CREATE TABLE IF NOT EXISTS referral_offers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_reward       VARCHAR(200),             -- "a Tour Store voucher"
  friend_offer          VARCHAR(200),             -- "£20 off their first hire"
  friend_credit_ex_vat  NUMERIC(10,2) CHECK (friend_credit_ex_vat IS NULL OR friend_credit_ex_vat > 0),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One referral per job (the friend's enquiry).
CREATE TABLE IF NOT EXISTS referrals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  job_id               UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  how                  VARCHAR(10) NOT NULL CHECK (how IN ('link', 'named', 'card')),
  offer_id             UUID REFERENCES referral_offers(id) ON DELETE SET NULL,
  status               VARCHAR(15) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'reward_due', 'rewarded', 'declined')),
  declined_reason      VARCHAR(300),
  thanks_email_sent_at TIMESTAMPTZ,               -- "someone you recommended has been in touch"
  reward_due_at        TIMESTAMPTZ,
  rewarded_at          TIMESTAMPTZ,
  rewarded_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  reward_detail        VARCHAR(300),
  welcome_credit_id    UUID REFERENCES goodwill_credits(id) ON DELETE SET NULL,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_person_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);

-- The friend's welcome credit is a goodwill credit with its own source.
ALTER TABLE goodwill_credits DROP CONSTRAINT IF EXISTS goodwill_credits_source_kind_check;
ALTER TABLE goodwill_credits ADD CONSTRAINT goodwill_credits_source_kind_check
  CHECK (source_kind IN ('close_out', 'problem', 'cancellation', 'organisation', 'person', 'referral'));

-- The two referral emails are off until jon turns them on (Marketing › Referrals).
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('referral_emails_enabled', 'false',
        'Email a referrer when someone they recommended gets in touch (Marketing › Referrals)',
        'marketing', 'bool', 61)
ON CONFLICT (key) DO NOTHING;
