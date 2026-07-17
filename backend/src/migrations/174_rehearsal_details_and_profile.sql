-- 174: Rehearsal job details + band rehearsal profile + info-pack boilerplate
--
-- Grows the Rehearsals module past studio-sitter cover (see
-- docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md). Three pieces:
--   1. rehearsal_job_details      — lightweight per-job intake (one row per job)
--                                    + info-pack "last sent" tracking
--   2. organisation_rehearsal_profile — persistent BAND profile (the "hotel book"
--                                    that surfaces preferences next time they're in)
--   3. system_settings (category 'rehearsals') — the client-facing info-pack
--                                    boilerplate (directions / parking / wifi / …)
--
-- Profile anchors on the band org (job_organisations.role='band'), falling back to
-- the job's client org. Capture is staff-entered (level A); the client-facing intake
-- form is the flagged phase-2 follow-on.

-- ── 1. Per-job intake ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rehearsal_job_details (
  job_id            UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  pa_setup          TEXT,          -- what PA the band wants
  backline_notes    TEXT,          -- backline they want FROM US (HH-derived backline
                                   --   is shown read-only; this is the intake note on top)
  cars_count        INTEGER,       -- how many cars the band is bringing (parking/space)
  dropoff_pickup    TEXT,          -- lorry/truck/van drop-off & pickup arrangements
  notes             TEXT,          -- general free-form
  info_pack_sent_at TIMESTAMPTZ,
  info_pack_sent_by UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Persistent band profile ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organisation_rehearsal_profile (
  organisation_id   UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  room_setup        TEXT,          -- layout preference (round-a-table / forward / their own)
  mic_list          TEXT,          -- mics they usually ask for
  power_notes       TEXT,          -- power / distro needs
  pa_monitoring     TEXT,          -- PA & monitoring preferences (wedges/IEMs, mix quirks)
  usual_backline    TEXT,          -- what they hire from us vs bring
  desk              TEXT,          -- which in-house digital desk they use
  load_in_access    TEXT,          -- early in / late finish / loading quirks
  regular_contact   TEXT,          -- regular TM/engineer + comms preference (free-form)
  preferences       JSONB NOT NULL DEFAULT '[]',   -- [{label,value}] hotel prefs:
                                   --   milk, catering, room temperature, "watch-outs" …
  internal_notes    TEXT,          -- "last time…" observations
  files             JSONB NOT NULL DEFAULT '[]',   -- desk files / saved mixes:
                                   --   [{r2_key, filename, content_type, size_bytes,
                                   --     label, uploaded_at, uploaded_by}]
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. Info-pack boilerplate (client-facing static content) ──────────────────
-- value is plain text (system_settings.value is TEXT). Editable from the
-- Rehearsals hub → Info Pack settings tab (admin/manager). Seeded empty.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('rehearsal_directions',  '', 'How to find us (directions)',   'rehearsals', 'text', 10),
  ('rehearsal_parking',     '', 'Parking info',                  'rehearsals', 'text', 20),
  ('rehearsal_wifi',        '', 'WiFi network & password',       'rehearsals', 'text', 30),
  ('rehearsal_amenities',   '', 'Local shops & takeaways',       'rehearsals', 'text', 40),
  ('rehearsal_house_rules', '', 'House rules / good to know',    'rehearsals', 'text', 50),
  ('rehearsal_contact',     '', 'Studio contact (on the day)',   'rehearsals', 'text', 60)
ON CONFLICT (key) DO NOTHING;
