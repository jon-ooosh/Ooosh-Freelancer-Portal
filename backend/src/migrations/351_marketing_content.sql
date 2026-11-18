-- 351: the social media planner — Marketing › Content (jon, 17–18 Nov 2026;
-- docs/BUSINESS-FIGURES-SPEC.md §8e).
--
-- OP PLANS posts; scheduling and posting stay in Meta Business Suite (OP can't post to
-- Meta without an app review). Every staff login sees and edits it; Matt runs it day to day.
--
-- A post is one piece of content on one or more channels (Instagram and Facebook are
-- usually the same post). Never deleted: 'dropped' instead. A post with no date is an idea.
CREATE TABLE IF NOT EXISTS marketing_posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              VARCHAR(200) NOT NULL,                 -- internal name: "Ruby Rd on tour - van shot"
  publish_at         TIMESTAMPTZ,                           -- null = an idea, no date yet
  channels           TEXT[] NOT NULL DEFAULT '{}'
                       CHECK (channels <@ ARRAY['instagram', 'facebook', 'newsletter', 'blog']::text[]),
  format             VARCHAR(20)
                       CHECK (format IS NULL OR format IN ('reel', 'carousel', 'image', 'story', 'video', 'text', 'newsletter', 'article')),
  caption            TEXT,                                  -- the words, call to action included
  hashtags           TEXT,                                  -- hashtags and @mentions
  theme              VARCHAR(60),                           -- the pillar: "Bands on the road", "Kit spotlight"…
  status             VARCHAR(20) NOT NULL DEFAULT 'idea'
                       CHECK (status IN ('idea', 'in_progress', 'review', 'approved', 'scheduled', 'published', 'dropped')),
  owner_person_id    UUID REFERENCES people(id) ON DELETE SET NULL,
  job_id             UUID REFERENCES jobs(id) ON DELETE SET NULL,
  organisation_id    UUID REFERENCES organisations(id) ON DELETE SET NULL,   -- the band it's about
  credit_person_id   UUID REFERENCES people(id) ON DELETE SET NULL,          -- photographer / who to credit
  tracked_link_id    UUID REFERENCES marketing_links(id) ON DELETE SET NULL, -- the call to action's link
  live_url           TEXT,                                  -- the post once it's up
  notes              TEXT,
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_posts_publish ON marketing_posts (publish_at) WHERE publish_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_posts_status ON marketing_posts (status);

-- The content library: photos, videos and graphics, as LINKS (the files stay in Google
-- Drive — jon). Archived, never deleted. `added_by_person_id` / source 'sitter' are for
-- studio sitters sending content in from the freelancer portal (the next step).
CREATE TABLE IF NOT EXISTS marketing_assets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               VARCHAR(200) NOT NULL,
  url                 TEXT NOT NULL,
  kind                VARCHAR(20) NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video', 'graphic', 'other')),
  credit_person_id    UUID REFERENCES people(id) ON DELETE SET NULL,
  job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  organisation_id     UUID REFERENCES organisations(id) ON DELETE SET NULL,
  notes               TEXT,
  source              VARCHAR(10) NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'sitter')),
  added_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  added_by_person_id  UUID REFERENCES people(id) ON DELETE SET NULL,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_assets_live ON marketing_assets (created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS marketing_post_assets (
  post_id   UUID NOT NULL REFERENCES marketing_posts(id) ON DELETE CASCADE,
  asset_id  UUID NOT NULL REFERENCES marketing_assets(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_post_assets_asset ON marketing_post_assets (asset_id);

-- Saved hashtag sets, added to a post with one click.
CREATE TABLE IF NOT EXISTS marketing_hashtag_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(80) NOT NULL UNIQUE,
  tags        TEXT NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
