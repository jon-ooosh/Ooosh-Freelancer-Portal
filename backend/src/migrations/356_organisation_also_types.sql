-- ============================================================================
-- 356: Organisations can be more than one kind of thing — "Also" types
-- ============================================================================
-- docs/PREMISES-COMPLIANCE-SPEC.md §8 (jon, 19 Nov 2026): "a shame we only have
-- one attribute per Org … Promoter AND Supplier for instance".
--
-- `organisations.type` stays THE main type — about 44 places across 20 files
-- read it as one value, so it is not turned into a list. `also_types` holds any
-- further types from the same org_type list ("Also: Supplier"). Today it is
-- read in two places, both through services/org-types.ts:
--   * the Organisations page type filter matches main OR also;
--   * the client pickers (New Enquiry, a job's client) leave out PURE suppliers
--     — main type 'supplier' and nothing else in also — so a promoter who also
--     supplies us is still findable as a client.
-- TEXT[], not JSONB: node-postgres sends a JS array as a Postgres array, which
-- is exactly what this column takes.
-- ============================================================================

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS also_types TEXT[] NOT NULL DEFAULT '{}';
