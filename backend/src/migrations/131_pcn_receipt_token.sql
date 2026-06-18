-- ============================================================================
-- 131: PCN pay-direct closed-loop — receipt upload token
--
-- The lenient "driver pays the issuer direct" path emails the driver a private
-- link to upload proof of payment. Unlike the 15-min mobile_upload_tokens (a
-- staff QR handoff), this link lives for days while the chase ladder runs, so
-- it's a status-bound token stored on the row (mirrors the OOH parking token):
-- valid while status = 'driver_notified_pay', rejected once paid/escalated.
-- ============================================================================

ALTER TABLE pcns ADD COLUMN IF NOT EXISTS receipt_upload_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pcns_receipt_token
  ON pcns (receipt_upload_token) WHERE receipt_upload_token IS NOT NULL;
