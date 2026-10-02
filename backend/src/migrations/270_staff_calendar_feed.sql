-- Personal read-only calendar feed (staff calendar spec §10, built Oct 2026).
--
-- One secret link per person. The token in the URL IS the credential — a
-- calendar app cannot send a login — so it is long, random, and replaceable:
-- "Reset link" writes a new token and the old URL stops working at once.
-- What the feed carries is decided in services/staff-ical.ts and is the
-- person's OWN time only (jon, Oct 2026): nobody else's, and no overtime.

CREATE TABLE IF NOT EXISTS staff_calendar_feeds (
    person_id        UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    token            VARCHAR(64) NOT NULL UNIQUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_fetched_at  TIMESTAMPTZ
);
