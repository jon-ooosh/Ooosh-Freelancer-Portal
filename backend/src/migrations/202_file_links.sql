-- Cross-entity file links — the explicit "job file → org" direction.
--
-- See docs/CROSS-ENTITY-FILES-SPEC.md. A file's bytes live in R2 exactly once,
-- owned by whichever entity it was uploaded to. Extra surfaces are WINDOWS onto
-- that same file, never copies. There are two directions and they are
-- deliberately asymmetric:
--
--   org → job   DERIVED, automatic. No rows here. The Job Files tab resolves the
--               job's orgs (job_organisations + jobs.client_id) at read time and
--               surfaces their files. Change a job's orgs and the set re-derives
--               for free.
--
--   job → org   EXPLICIT, opt-in. One row here per link. Because the row names a
--               SPECIFIC organisation, the link survives the job's client later
--               being changed — the rider stays with the band.
--
-- `r2_key` is the FileAttachment `url` (the R2 storage key; note the shape has no
-- separate r2_key field). External links (type: 'link') hold an http(s) URL there
-- instead — they link fine, there are just no bytes of ours behind them.
--
-- Polymorphic on both ends, so no foreign keys: only 'jobs' is used as an owner
-- and only 'organisations' as a link target today, but the shape doesn't need
-- changing to link a file onto a person or a venue later. Reads join the target
-- table, so a row orphaned by a deleted org simply stops rendering.
CREATE TABLE IF NOT EXISTS file_links (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    r2_key               TEXT NOT NULL,
    owner_entity_type    VARCHAR(50) NOT NULL,
    owner_entity_id      UUID NOT NULL,
    linked_entity_type   VARCHAR(50) NOT NULL,
    linked_entity_id     UUID NOT NULL,
    created_by           VARCHAR(255) NOT NULL,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    -- The same file can't be linked to the same target twice. Note this is keyed
    -- on the OWNER too: two jobs may each hold their own copy of an identical
    -- external URL, and linking one must not collide with the other.
    CONSTRAINT uq_file_link UNIQUE (r2_key, owner_entity_type, owner_entity_id, linked_entity_type, linked_entity_id)
);

-- "What has this job linked out?" — drives the per-file chips on a Job Files tab
-- and the delete guard (deleting a still-linked file is blocked, not unlinked).
CREATE INDEX IF NOT EXISTS idx_file_links_owner
  ON file_links (owner_entity_type, owner_entity_id);

-- "What has been linked to this org?" — drives the "Linked from jobs" group on
-- the Org Files tab, and the org→job derivation for the band's OTHER jobs.
CREATE INDEX IF NOT EXISTS idx_file_links_linked
  ON file_links (linked_entity_type, linked_entity_id);

COMMENT ON TABLE file_links IS
  'Windows onto a file that lives elsewhere. One row = one explicit link from an owning entity''s file (r2_key = the FileAttachment url) to another entity that should also surface it. The reverse direction (org files onto a job) is derived at read time and has no rows here.';
