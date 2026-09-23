-- ============================================================================
-- 235: Shop stock cache — a local mirror of HireHop's SALE stock catalogue
-- ============================================================================
-- Step 2 of docs/SHOP-SALES-SPEC.md. HireHop remains the single stock database;
-- this table is a read-through mirror, never a second source of truth. Nothing
-- writes a stock LEVEL here — `quantity` is a snapshot for display, and every
-- real movement still happens in HireHop (a job line, or a tally adjustment).
--
-- WHY MIRROR AT ALL: the till must never call HireHop to search or price an
-- item. A counter with a customer waiting cannot wait on a 327 rate-limit
-- storm, and a studio sitter looking up "how much is a jack lead?" on their
-- phone needs an answer instantly on a bad evening. Search, price lookup and
-- barcode resolution all become Postgres queries. See SHOP-SALES-SPEC.md §10.
--
-- Persisted rather than in-memory (which is what `backline-stock.ts` does for
-- HIRE stock) so a service restart doesn't cost the next user a cold HireHop
-- round-trip.
--
-- ⚠️ `quantity` is the SHELF count, not availability. An item can read 15 on
-- the shelf while 3 are reserved for a job going out Thursday — HireHop tracks
-- that reservation, but it is per-job and only comes from the picklist
-- endpoint, not this bulk list. The till shows the shelf count LABELLED AS
-- SUCH, and asks HireHop for live availability when an item enters the basket.
-- See SHOP-SALES-SPEC.md §2.3.
--
-- ⚠️ `vat_rate_index` is HireHop's tax-TYPE index, NOT a percentage. The
-- verified item returned 0 while the HireHop UI displayed "Tax rate Standard",
-- so 0 means the standard rate and emphatically not zero-rated. Anything that
-- treats this column as a percentage charges no VAT on every item and
-- under-declares the weekly invoice. Resolve it through
-- `resolveVatRate()` in services/shop-stock.ts. See SHOP-SALES-SPEC.md §2.2.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shop_stock_cache (
  -- HireHop's consumables ID. Addressed as `a<id>` when adding to a job — the
  -- picklist returns `a25` for this row's 25. Hire stock uses `b<id>`.
  hh_stock_id     INTEGER PRIMARY KEY,

  title           TEXT NOT NULL,
  alt_title       TEXT,
  part_number     TEXT,
  barcode         TEXT,

  category_id     INTEGER,
  category_path   TEXT,

  -- Price A, ex-VAT, from PRICES._1.PRICE. The numbered PRICE1/2/3 fields are
  -- marked DEPRECATED in HireHop's API docs — do not read them.
  price           NUMERIC(10,2),
  cost_price      NUMERIC(10,2),

  -- See the warning above: an INDEX, not a percentage.
  vat_rate_index  INTEGER,

  -- 0–100. An item below 100 cannot be fully discounted, which is one reason
  -- internal consumption uses a tally adjustment rather than a 100%-discounted
  -- sale line (SHOP-SALES-SPEC.md §2).
  max_discount    NUMERIC(5,2),

  -- Shelf count at `refreshed_at`. Advisory only — never gate a sale on it.
  quantity        NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Drive the reorder view: knowing on Monday beats running out on Friday.
  reorder_level   NUMERIC(10,2),
  reorder_qty     NUMERIC(10,2),

  -- HireHop's own status index: 0=Active, 1=Hidden in picklist, 2=Deleted.
  -- Rows that vanish from the HireHop feed are marked 2 rather than deleted,
  -- so a historic sale line can still resolve the name it was sold under.
  status          INTEGER NOT NULL DEFAULT 0,

  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The till's search path: type-ahead over name, alt name, part number.
-- A trigram index rather than full-text — staff type fragments and part
-- numbers ("gree fl 1", "PROGAFF24"), not natural-language queries.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_shop_stock_title_trgm
  ON shop_stock_cache USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shop_stock_alt_trgm
  ON shop_stock_cache USING gin (alt_title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shop_stock_part_trgm
  ON shop_stock_cache USING gin (part_number gin_trgm_ops);

-- Barcode scanning is an exact lookup, and the scanner is the fast path.
CREATE INDEX IF NOT EXISTS idx_shop_stock_barcode
  ON shop_stock_cache (barcode) WHERE barcode IS NOT NULL AND barcode <> '';

-- Sellable items only, for the default till listing and the reorder view.
CREATE INDEX IF NOT EXISTS idx_shop_stock_active
  ON shop_stock_cache (status, category_id);
