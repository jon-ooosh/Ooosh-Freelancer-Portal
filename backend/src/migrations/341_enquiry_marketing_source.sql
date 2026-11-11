-- 341: Where an enquiry came from, for marketing (docs/BUSINESS-FIGURES-SPEC.md §7, Nov 2026).
--
-- Two different things, kept apart (jon, Nov 2026):
--   - "came in by" (phone / email / website / in person) stays jobs.enquiry_source;
--   - where they HEARD about us lives here — what they told us (heard_about) and, for
--     website enquiries, what the website saw: the ad / campaign tags of their FIRST
--     visit (stored on oooshtours.co.uk only with cookie consent), and the visit they
--     enquired on when it carried tags of its own (last_touch).
-- One row per job. Every value is cleaned and length-capped on the way in
-- (services/marketing-source.ts) — a link anyone can craft carries them.
CREATE TABLE IF NOT EXISTS job_marketing_source (
  job_id              UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  heard_about         VARCHAR(30),           -- google_search | google_ad | social | print | recommendation | returning | ai | saw_at_venue | other
  heard_about_detail  VARCHAR(300),          -- "who recommended us?" / "where?"
  utm_source          VARCHAR(200),
  utm_medium          VARCHAR(200),
  utm_campaign        VARCHAR(200),
  utm_term            VARCHAR(200),
  utm_content         VARCHAR(200),
  gclid               VARCHAR(300),          -- Google Ads click
  fbclid              VARCHAR(300),          -- Facebook / Instagram click
  link_code           VARCHAR(100),          -- an Ooosh tracked link (go.oooshtours.co.uk) — the links themselves come later
  referrer            VARCHAR(300),          -- site + path only, never our own site
  landing_page        VARCHAR(300),          -- path only
  first_seen_at       TIMESTAMPTZ,
  last_touch          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_marketing_source_heard ON job_marketing_source (heard_about);
