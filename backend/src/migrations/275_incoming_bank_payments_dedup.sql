-- 275_incoming_bank_payments_dedup.sql
-- The first live night (6–7 Oct 2026) produced three rows and three alerts per Wise
-- transfer: the same Wise email reached three mailboxes (jonwood@ directly, info@ via
-- jon's auto-forward, and onward), each copy with its own Message-ID, so the
-- Message-ID dedup never fired. Two fixes in code (only the configured source mailbox
-- is a Wise source; Wise's transfer number is a second dedup key) and this cleanup:
-- later copies of the same transfer become ignored 'duplicate_copy' rows, and a
-- partial unique index stops it recurring.
--
-- Also: a reference can name SEVERAL Xero invoices ("OT6797 OT6805", two storage
-- invoices paid together), so the row keeps a list, not one invoice.

ALTER TABLE incoming_bank_payments
  ADD COLUMN IF NOT EXISTS xero_invoices JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE incoming_bank_payments i
   SET status = 'ignored',
       match_method = 'duplicate_copy',
       match_notes = COALESCE(match_notes, '') || ' [duplicate copy of the same Wise transfer from another mailbox — migration 275]',
       resolved_at = NOW()
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY transfer_number ORDER BY created_at, id) AS rn
      FROM incoming_bank_payments
     WHERE transfer_number IS NOT NULL
  ) d
 WHERE i.id = d.id AND d.rn > 1 AND i.status <> 'recorded';

CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_bank_payments_transfer
  ON incoming_bank_payments (transfer_number)
  WHERE transfer_number IS NOT NULL AND match_method IS DISTINCT FROM 'duplicate_copy';
