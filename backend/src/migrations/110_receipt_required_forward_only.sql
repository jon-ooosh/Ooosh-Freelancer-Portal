-- 110_receipt_required_forward_only.sql
--
-- The migration 087 backfill flagged EVERY historic card-machine excess record
-- (Worldpay/Amex/cash) as receipt_required = TRUE, including long-finished and
-- already-resolved hires from before the receipt-scan requirement existed. That
-- filled the dashboard "Receipts Outstanding" bucket (and per-record banners)
-- with pre-change history that can never be actioned.
--
-- The requirement applies FORWARD ONLY (from 1 Jun 2026). Clear the flag on any
-- still-outstanding pre-1-Jun record so it stops lying everywhere it's read.
-- (The dashboard query also gained a created_at >= 1 Jun guard as belt-and-braces.)

UPDATE job_excess
SET receipt_required = FALSE,
    updated_at = NOW()
WHERE receipt_required = TRUE
  AND receipt_uploaded_at IS NULL
  AND created_at < DATE '2026-06-01';
