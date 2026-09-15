-- ============================================================================
-- Staff Documents & Training — module foundation.
-- See docs/STAFF-DOCUMENTS-SPEC.md.
--
-- A staff-facing library of policies / agreements / training / official docs.
-- Each document declares, per instance, how "done" is defined (read-only /
-- tick / sign), who it applies to, and how it is chased / reviewed / escalated.
--
-- Tables:
--   staff_documents             — the document + its completion + chase config
--   staff_document_versions     — versioned content (editing = new version)
--   staff_document_assignments  — per-user "you need to do this" tracker
--   staff_document_completions  — immutable log, one row per signing/tick event
--
-- Phase 1 payload: the Capital on Tap company-card Authorised User Agreement,
-- seeded at the bottom (sign mode, annual re-sign, targets card-holders).
-- ============================================================================

-- ── The document ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_documents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   VARCHAR(80) UNIQUE NOT NULL,
  title                  VARCHAR(200) NOT NULL,
  category               VARCHAR(40) NOT NULL DEFAULT 'policy'
    CHECK (category IN ('policy','agreement','training','official_doc','contract','other')),
  completion_mode        VARCHAR(20) NOT NULL DEFAULT 'read_only'
    CHECK (completion_mode IN ('read_only','tick','sign')),
  tick_label             VARCHAR(200),                 -- tick mode: e.g. "I have read and agree"
  visibility             VARCHAR(20) NOT NULL DEFAULT 'assignees'
    CHECK (visibility IN ('everyone','assignees','owner_admin')),
  -- Targeting rule (materialised into staff_document_assignments by the resolver):
  target_type            VARCHAR(20) NOT NULL DEFAULT 'list'
    CHECK (target_type IN ('all_staff','role','list','cot_card_holders')),
  target_roles           TEXT[],                       -- when target_type='role'
  target_user_ids        UUID[],                       -- when target_type='list'
  -- Chase / review / escalation config (all optional, all soft nudges):
  chase_interval_days    INT,                          -- NULL = no active chasing
  escalate_after_days    INT,                          -- NULL = never escalate to managers
  review_interval_months INT,                          -- NULL = complete once forever
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Versions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_document_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES staff_documents(id) ON DELETE CASCADE,
  version         INT NOT NULL,
  body            TEXT,                                 -- markdown/HTML content (nullable if file-only)
  file_r2_key     TEXT,                                 -- uploaded PDF/doc (nullable if body-only)
  file_name       VARCHAR(200),
  change_note     TEXT,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Only one current version per document; version numbers unique per document.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_doc_versions_current
  ON staff_document_versions(document_id) WHERE is_current = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_doc_versions_num
  ON staff_document_versions(document_id, version);

-- ── Per-user assignment (the tracker) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_document_assignments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             UUID NOT NULL REFERENCES staff_documents(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','lapsed')),
  assigned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_completion_id   UUID,                          -- FK wired after completions table exists
  expires_at              TIMESTAMPTZ,                    -- completed_at + review_interval_months
  -- Scanner dedup stamps (mirror the receipt-chaser / sanity-scanner pattern):
  chase_sent_at           TIMESTAMPTZ,
  escalated_at            TIMESTAMPTZ,
  review_reminder_sent_at TIMESTAMPTZ,
  UNIQUE (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_doc_assign_user   ON staff_document_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_doc_assign_status ON staff_document_assignments(status);

-- ── Immutable completion records ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_document_completions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id     UUID NOT NULL REFERENCES staff_document_assignments(id) ON DELETE CASCADE,
  version_id        UUID NOT NULL REFERENCES staff_document_versions(id),
  user_id           UUID NOT NULL REFERENCES users(id),
  mode              VARCHAR(20) NOT NULL,                -- tick | sign (snapshot of how it was completed)
  completed_by_name VARCHAR(200) NOT NULL,
  completed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_r2_key  TEXT,
  pdf_r2_key        TEXT,
  ip_address        VARCHAR(60),
  user_agent        TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_doc_completions_assign ON staff_document_completions(assignment_id);

ALTER TABLE staff_document_assignments
  DROP CONSTRAINT IF EXISTS fk_staff_doc_assign_completion;
ALTER TABLE staff_document_assignments
  ADD CONSTRAINT fk_staff_doc_assign_completion
  FOREIGN KEY (current_completion_id) REFERENCES staff_document_completions(id);

-- ── Seed: Capital on Tap card Authorised User Agreement (Phase 1) ────────────
-- Sign mode, annual re-sign, chased weekly, escalated after 14 days, targets
-- everyone with a COT card. Body is markdown; [name] / [last4] are merged at
-- render from the user's cot_card_label / cot_card_last4.
INSERT INTO staff_documents
  (slug, title, category, completion_mode, visibility, target_type,
   chase_interval_days, escalate_after_days, review_interval_months, is_active)
VALUES
  ('cot-card-agreement',
   'Company Card (Capital on Tap) Authorised User Agreement',
   'agreement', 'sign', 'assignees', 'cot_card_holders',
   7, 14, 12, TRUE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO staff_document_versions (document_id, version, body, change_note, is_current)
SELECT d.id, 1,
$body$**Ooosh Tours — Company Card (Capital on Tap) Authorised User Agreement**

I, **[name]**, have been issued a Capital on Tap company card (ending **[last4]**) for use in my role at Ooosh Tours. I understand and agree that:

1. **Business use only.** The card is for legitimate Ooosh business expenses only. I will not use it for personal, cash-withdrawal, or non-business spending.
2. **Receipts, promptly.** I will obtain a valid VAT receipt or invoice for every transaction and submit it (via the Operations Platform / to the office) **within 3 working days**. I understand unlogged spend will be chased and may be treated as a personal charge until evidenced.
3. **Within limits.** I will stay within any spending limit set on my card and seek manager approval before any large or unusual purchase.
4. **Keep it secure.** I will keep the card, PIN and card details secure, will not share them with anyone, and will not let anyone else use my card.
5. **Report problems immediately.** I will tell the office at once if the card is lost, stolen, or if I notice any transaction I don't recognise.
6. **Accidental or personal spend.** If I use the card in error or for anything not clearly business, I will flag it straight away and repay Ooosh promptly.
7. **Return on request.** The card remains the property of Ooosh Tours. I will return it (or confirm its destruction) when I leave the company or whenever asked.
8. **Capital on Tap terms.** I understand my use is also governed by Capital on Tap's Authorised User Terms and Conditions, and that Ooosh Tours is financially responsible to Capital on Tap for my card activity.

I confirm I have read and agree to the above.$body$,
  'Initial version', TRUE
FROM staff_documents d
WHERE d.slug = 'cot-card-agreement'
  AND NOT EXISTS (SELECT 1 FROM staff_document_versions v WHERE v.document_id = d.id);
