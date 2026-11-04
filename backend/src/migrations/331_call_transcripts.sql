-- 331: Call intelligence stage I-a — Twilio transcripts + Claude summaries
-- (docs/CALL-INTELLIGENCE-SPEC.md §I, Nov 2026).
--
-- With TWILIO_INTELLIGENCE_SERVICE_SID set, a recording stays in Twilio until its
-- transcript is back (Twilio transcribes the recording it holds), then both are
-- deleted from Twilio — OP keeps the only copy. Without it, nothing changes.
ALTER TABLE call_records
  ADD COLUMN IF NOT EXISTS transcript_sid          VARCHAR(64),
  ADD COLUMN IF NOT EXISTS transcript_status       VARCHAR(12) NOT NULL DEFAULT 'none'
    CHECK (transcript_status IN ('none', 'pending', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS transcript_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transcript              TEXT,      -- "Caller: …" / "Ooosh: …" lines; admins only
  ADD COLUMN IF NOT EXISTS twilio_recording_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary                 TEXT,
  ADD COLUMN IF NOT EXISTS call_category           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sentiment               VARCHAR(10),
  ADD COLUMN IF NOT EXISTS mentioned_job_refs      JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS suggested_action        TEXT,
  ADD COLUMN IF NOT EXISTS urgent                  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS analysed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_purged_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_call_records_transcript_pending
  ON call_records (transcript_requested_at) WHERE transcript_status = 'pending';

INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('telephony_retention_months', '24',
   'Months to keep call audio and full transcripts (the summary is kept after)', 'phones', 'number', 80)
ON CONFLICT (key) DO NOTHING;
