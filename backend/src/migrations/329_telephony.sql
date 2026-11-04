-- 329: Telephony on Twilio — OP as the phone system (docs/CALL-INTELLIGENCE-SPEC.md §T, Nov 2026).
--
-- One row per call Twilio asks OP about: inbound to our number, outbound from a
-- handset. Recordings are copied to R2 under the admin-only `calls/` prefix and
-- then deleted from Twilio, so OP is the only long-term copy.
-- The transcript / summary / matching columns arrive with the intelligence phase.
CREATE TABLE IF NOT EXISTS call_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_call_id      VARCHAR(64) UNIQUE NOT NULL,      -- Twilio CallSid (parent leg)
  call_type           VARCHAR(10) NOT NULL CHECK (call_type IN ('inbound', 'outbound')),
  kind                VARCHAR(10) NOT NULL DEFAULT 'call' CHECK (kind IN ('call', 'voicemail', 'missed')),
  caller_number       VARCHAR(50),                       -- who rang (inbound) / which handset login (outbound)
  dest_number         VARCHAR(50),                       -- our number (inbound) / the number dialled (outbound)
  other_party_number  VARCHAR(50),                       -- the outside number, E.164 where known — what matching will use
  answered_by         VARCHAR(20),                       -- base login (outbound: the base that dialled)
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_seconds    INTEGER,
  recording_sid       VARCHAR(64) UNIQUE,
  audio_r2_key        TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending_audio'
                      CHECK (status IN ('pending_audio', 'stored', 'no_audio', 'failed')),
  voicemail_emailed_at TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_records_recorded_at ON call_records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_records_other_party ON call_records (other_party_number);

-- Staff-editable without a deploy (Settings › Phones).
INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('telephony_recording_notice',
   'Hi, you''re through to Ooosh Tours. Calls are recorded for quality and training. Connecting you now.',
   'Spoken to every incoming caller before the phones ring', 'phones', 'text', 10),
  ('telephony_voicemail_greeting',
   'Thanks for calling Ooosh Tours. Sorry we can''t get to the phone, please leave your name and number, and we''ll call you back asap. Or email info at oooshtours dot co dot uk.',
   'Voicemail greeting (spoken before the beep)', 'phones', 'text', 20),
  ('telephony_say_ooosh_as', 'oosh',
   'How the voice says "Ooosh": a sounds-like spelling (e.g. oosh, ooosh, oo-sh). Ring the number to hear it', 'phones', 'text', 30),
  ('telephony_voice', 'Polly.Amy-Neural',
   'Twilio voice for the spoken messages (Polly.Amy-Neural is British English)', 'phones', 'text', 40),
  ('telephony_ring_timeout_seconds', '25',
   'Seconds the phones ring before voicemail', 'phones', 'number', 50),
  ('telephony_ring_bases', 'base1,base2',
   'Base logins that ring for an incoming call, comma-separated', 'phones', 'text', 60),
  ('telephony_voicemail_email_to', 'info@oooshtours.co.uk',
   'Where voicemails are emailed (with the recording attached)', 'phones', 'text', 70)
ON CONFLICT (key) DO NOTHING;
