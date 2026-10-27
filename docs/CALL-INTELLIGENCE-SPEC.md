# Call Intelligence Module — Full Specification
**Ooosh! Tours Operations Platform**
*Version 1.0 — March 2026*

> ## 0. Status and what has changed since March (27 Oct 2026)
>
> **PLANNED, not built.** Written before most of OP existed; the idea and the flow still stand.
> Where OP has since built the same plumbing for email, the build should reuse it rather than
> follow the March details below. Part of the "joined-up" aim in `AI-KNOWLEDGE-SPEC.md` §8a.
>
> | March spec says | OP today — use this instead |
> |---|---|
> | `contacts` table, `phone_number_index` | `people` (`phone`, `mobile`, `international_phone`) and `organisations`. An index table is still worth having, filled from those, with one normaliser shared with `services/address-book-search.ts` `phoneDigitsForSearch()` |
> | Generic "activity timeline" | `interactions` (type `call` is already allowed) on the job / person / organisation, the way ingested emails are stored — and the same rules: hidden and detached rows never reach any AI read |
> | Recordings by email via Mailgun/Postmark | OP already reads Gmail mailboxes (`gmail-ingestion.ts`, domain-wide delegation). A recordings mailbox can be read the same way; no new email provider |
> | "Calls Inbox" page | Matching stays deterministic, as for email (number → person → their open job; a job number said on the call as evidence, never a guess). Unmatched calls go to ONE review surface shared with unmatched email, not a second inbox |
> | `pg-boss` / `bull` worker | The existing `config/scheduler.ts` (node-cron) pattern with a table queue |
> | `claude-sonnet-4-…` | `config/anthropic.ts` constants, structured output read with `readStructuredJson()` |
> | MP3s in R2 under `recordings/` | A private prefix that `GET /api/files/download` role-gates (today only `staff-records/` and `claims/` are gated — every other prefix is readable by any staff login). Recordings must be gated |
> | (not covered) | Retention: a setting like email's 24 months, then strip audio and transcript, keep the summary |
>
> **To check before building:** what Voipfone offers now (webhooks out of beta? a direct recording link?);
> the "calls may be recorded" announcement switched on first (legal note below); who may listen to a
> recording.
>
> **What it feeds:** call summaries go into the client brief (`AI-KNOWLEDGE-SPEC.md` §5), so a chase or
> a quote knows what was said on the phone; `suggested_action` becomes a suggested To Do for a person
> to accept, never an automatic action.

---

## Context & Purpose

This document specifies the **Call Intelligence module** for the Ooosh Tours Operations Platform. It is intended to be read by Claude Code sessions building or extending the ops platform, and contains all architectural decisions, data models, API contracts, UI requirements, and integration details needed to build and integrate this module from day one.

The module captures inbound and outbound business phone calls made via Voipfone, automatically transcribes them, uses Claude AI to summarise and extract key information, matches calls to existing contacts in the CRM, and logs everything to the relevant activity timeline. Calls that cannot be auto-matched are surfaced in a **Calls Inbox** — a dedicated module section for staff to resolve manually.

---

## How It Fits Into the Ops Platform

The ops platform is a React/Vite frontend (Netlify) with a Node.js/Express backend (Hetzner VPS) and a PostgreSQL database. This module adds:

- **Two new backend services** (webhook receiver, async processing worker) on the existing Express server
- **Three new database tables** (`call_records`, `call_processing_queue`, `phone_number_index`)
- **Two new frontend modules** (Call Activity component reused across the CRM, and the Calls Inbox page)
- **Three third-party API integrations** (Voipfone webhooks, AssemblyAI transcription, Claude API summarisation — the ops platform already integrates Claude API for other features)

The module has **no dependency on Monday.com** — this is intentional, as the ops platform is designed to replace Monday.com. All call data lives in PostgreSQL.

---

## System Architecture & Data Flow

```
1. Call ends on Voipfone
        │
        ▼
2. Voipfone fires webhook → POST /api/calls/webhook
   Payload includes: caller_id (phone number), dest_number,
   unique_call_id, recorded_at, type (inbound/outbound)
        │
        ▼
3. Webhook handler validates token, stores call metadata
   in call_records, adds job to call_processing_queue
        │
        ▼
4. Recording arrives via email (Voipfone "recordings to email"
   feature) → inbound email parser extracts MP3 attachment,
   matches to call_record via unique_call_id in subject line,
   stores MP3 to Cloudflare R2, updates call_record with audio_url
   [NOTE: When Voipfone releases direct recording links, step 4
   simplifies to: webhook handler fetches MP3 directly from URL]
        │
        ▼
5. Async worker picks up queued job, sends MP3 to AssemblyAI
   → receives transcript (plain text with speaker diarisation)
        │
        ▼
6. Transcript sent to Claude API with structured prompt
   → receives JSON: summary, mentioned_job_refs, sentiment,
   suggested_action, call_type_category
        │
        ▼
7. Phone number looked up in phone_number_index
   → Result: MATCHED (1 contact) / UNMATCHED (0) / AMBIGUOUS (2+)
        │
   ┌────┴──────────────────────────┐
   ▼                               ▼
MATCHED or AMBIGUOUS           UNMATCHED
   │                               │
   ▼                               ▼
Activity logged to         Call appears in
contact timeline           Calls Inbox as
(or flagged in             "New — Unknown Caller"
Calls Inbox if
ambiguous)
```

---

## Third-Party Service Details

### Voipfone
- **What it provides:** Webhook events on call completion, call recording as MP3 (emailed or, once available, via direct link)
- **Webhook beta:** Must be activated by contacting Voipfone support. Configured in PBX Settings → Integrations tab.
- **Events to subscribe to:** `recording_inbound`, `recording_outbound`, `voicemail`
- **Auth:** Each webhook request includes `X-Pbx-Token` header — validate against `VOIPFONE_WEBHOOK_SECRET` env var
- **Interim recording delivery:** Set Voipfone to email recordings to a dedicated inbound address (e.g. `recordings@oooshtours.co.uk`). Use Mailgun or Postmark inbound parsing to receive and process. Subject line contains the `unique_call_id` for matching.
- **Future:** When Voipfone releases `call_recording_link` in webhook payload, the email step is removed and the MP3 is fetched directly. The processing worker should check for `audio_url` on the call record first, then fall back to waiting for email delivery.

### AssemblyAI
- **Purpose:** Speech-to-text transcription of call recordings
- **Model:** `best` (maps to their highest-accuracy model, currently Universal-2)
- **Pricing:** ~$0.0042/min effective (pay-as-you-go, no commitment needed at Ooosh call volumes)
- **Key features used:** Transcription, speaker diarisation (labels speakers as Speaker A / Speaker B), automatic punctuation
- **API key:** `ASSEMBLYAI_API_KEY` env var
- **Flow:** POST audio URL to AssemblyAI → poll for completion (or use webhook callback) → retrieve transcript
- **Speaker diarisation:** Set `speaker_labels: true` in transcription request. Useful for distinguishing staff member from caller in the transcript view.
- **Docs:** https://www.assemblyai.com/docs

### Claude API (Anthropic)
- **Purpose:** Summarisation, information extraction, call categorisation
- **Model:** `claude-sonnet-4-20250514` (consistent with other ops platform usage)
- **API key:** Already configured as `ANTHROPIC_API_KEY` in the platform
- **Prompt:** See Section "Claude Summarisation Prompt" below
- **Expected output:** Structured JSON (Claude instructed to return JSON only)
- **Cost:** Negligible — a 5-minute call transcript (~800 words) costs under £0.01

---

## Claude Summarisation Prompt

The following prompt is sent to Claude after transcription. The response must be valid JSON only.

```
You are a helpful assistant for Ooosh Tours, a music industry services company based in Brighton, UK. 
Ooosh Tours provides splitter van hire, backline equipment rental, and rehearsal facilities to touring 
artists, tour managers, and production companies.

Analyse the following phone call transcript and return a JSON object with these exact fields:

{
  "summary": "2-3 sentence plain English summary of what the call was about and any key outcomes",
  "call_type": "one of: enquiry | booking_related | job_query | complaint | supplier | personal | unknown",
  "sentiment": "one of: positive | neutral | negative",
  "mentioned_job_refs": ["array of any HireHop job numbers, quote numbers, or reference codes mentioned"],
  "mentioned_company": "company name if identified, or null",
  "suggested_action": "brief plain English follow-up action if any, or null",
  "urgent": true or false
}

Rules:
- Return JSON only. No preamble, explanation, or markdown.
- For mentioned_job_refs, look for patterns like job numbers, quote numbers, booking references.
- Keep the summary factual and concise — it will be read by staff in a timeline view.
- Mark urgent: true only if the caller expressed time pressure, urgency, or a complaint.

Transcript:
{{TRANSCRIPT}}
```

---

## Database Schema

### Table: `call_records`

```sql
CREATE TABLE call_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_call_id      VARCHAR(255) UNIQUE NOT NULL,  -- Voipfone's unique_call_id
  call_type           VARCHAR(20) NOT NULL,           -- 'inbound' | 'outbound'
  caller_number       VARCHAR(50),                    -- CLI from Voipfone (E.164 format preferred)
  dest_number         VARCHAR(50),                    -- number that was dialled/received on
  recorded_at         TIMESTAMPTZ NOT NULL,
  duration_seconds    INTEGER,
  audio_url           TEXT,                           -- Cloudflare R2 URL of MP3
  
  -- Processing state
  status              VARCHAR(30) NOT NULL DEFAULT 'pending_audio',
  -- States: pending_audio | queued | transcribing | analysing | 
  --         matched | unmatched | ambiguous | resolved | ignored

  -- Transcript & analysis (populated after processing)
  transcript          TEXT,
  transcript_speakers JSONB,                          -- Speaker-labelled segments from AssemblyAI
  summary             TEXT,
  call_category       VARCHAR(30),
  sentiment           VARCHAR(20),
  mentioned_job_refs  JSONB,                          -- array of strings
  mentioned_company   VARCHAR(255),
  suggested_action    TEXT,
  urgent              BOOLEAN DEFAULT FALSE,

  -- Contact matching
  matched_contact_id  UUID REFERENCES contacts(id),  -- null until matched
  matched_hirehop_job VARCHAR(50),                    -- HireHop job number if linked
  match_confidence    VARCHAR(20),                    -- 'auto' | 'manual' | 'ambiguous'
  match_candidates    JSONB,                          -- array of contact IDs if ambiguous
  resolved_by         UUID REFERENCES users(id),      -- who resolved ambiguous/unmatched
  resolved_at         TIMESTAMPTZ,

  -- Metadata
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_call_records_caller_number ON call_records(caller_number);
CREATE INDEX idx_call_records_status ON call_records(status);
CREATE INDEX idx_call_records_recorded_at ON call_records(recorded_at DESC);
CREATE INDEX idx_call_records_matched_contact ON call_records(matched_contact_id);
```

### Table: `call_processing_queue`

```sql
CREATE TABLE call_processing_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_record_id  UUID NOT NULL REFERENCES call_records(id),
  stage           VARCHAR(30) NOT NULL,
  -- Stages: transcribe | analyse | match
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Statuses: pending | processing | complete | failed
  attempts        INTEGER DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Table: `phone_number_index`

This table is a denormalised lookup used for fast phone number matching. It is populated/maintained by the CRM module whenever contacts are created or updated.

```sql
CREATE TABLE phone_number_index (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  VARCHAR(50) NOT NULL,        -- normalised E.164 format
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label         VARCHAR(50),                 -- e.g. 'mobile', 'office', 'direct'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_phone_number_index_number ON phone_number_index(phone_number);
```

**Phone number normalisation:** All phone numbers stored and looked up using E.164 format (e.g. `+447911123456`). A normalisation utility function must handle: stripping spaces/dashes, converting `07xxx` to `+447xxx`, converting `01xxx`/`02xxx`/`03xxx` to `+441xxx` etc. This function is used both when indexing contact phone numbers AND when processing the Voipfone CLI.

---

## Backend: API Endpoints

All routes under `/api/calls/`. Authenticated routes use the standard ops platform JWT middleware.

### POST `/api/calls/webhook`
**Auth:** Validates `X-Pbx-Token` header against `VOIPFONE_WEBHOOK_SECRET`. No JWT required (external service).

Receives Voipfone webhook events. Handles:
- `recording_inbound` — new inbound call recording completed
- `recording_outbound` — new outbound call recording completed  
- `voicemail` — voicemail left (store, but handle separately — lower priority)

On receipt:
1. Validate token
2. Upsert `call_records` row with metadata (status: `pending_audio`)
3. Add `transcribe` job to `call_processing_queue`
4. Return `200 OK` immediately (Voipfone expects fast response)

```javascript
// Expected Voipfone webhook payload (recording_inbound example):
{
  type: "recording_inbound",
  unique_call_id: "abc123xyz",
  caller_id: "+441273000000",       // caller's number (CLI)
  dest_number: "+441273500500",     // our number that was called
  recorded_at: "2026-03-11T10:14:00Z",
  emails: "recordings@oooshtours.co.uk",
  email_subject: "Call Recording abc123xyz",
  email_message: "...",
  call_recording_link: null         // currently null, future: direct MP3 URL
}
```

### POST `/api/calls/recording-email`
**Auth:** Shared secret header (from Mailgun/Postmark inbound webhook)

Receives parsed inbound email from recording delivery. Extracts:
- `unique_call_id` from email subject
- MP3 attachment

Uploads MP3 to Cloudflare R2 under `recordings/{year}/{month}/{unique_call_id}.mp3`.
Updates `call_records.audio_url` and `status` to `queued`.

### GET `/api/calls/inbox`
**Auth:** JWT required

Returns paginated list of calls requiring human attention (status: `unmatched`, `ambiguous`).

Query params: `page`, `limit`, `status` filter

```javascript
// Response shape:
{
  calls: [
    {
      id: "uuid",
      call_type: "inbound",
      caller_number: "+447911123456",
      recorded_at: "2026-03-11T10:14:00Z",
      duration_seconds: 272,
      summary: "Caller enquired about van hire for a June festival run...",
      sentiment: "positive",
      urgent: false,
      mentioned_company: "Forta Productions",
      mentioned_job_refs: [],
      suggested_action: "Follow up with quote",
      status: "unmatched",
      match_candidates: []           // populated if status is 'ambiguous'
    }
  ],
  total: 12,
  page: 1
}
```

### GET `/api/calls/:id`
**Auth:** JWT required

Returns full call record including full transcript and speaker-labelled segments.

### PATCH `/api/calls/:id/resolve`
**Auth:** JWT required

Resolves an unmatched or ambiguous call. Body:

```javascript
// Option A: Link to existing contact
{ action: "link", contact_id: "uuid", hirehop_job: "JOB-4821" }

// Option B: Create new contact (ops platform handles contact creation separately;
// this just marks the call as resolved with a new contact_id once created)
{ action: "link", contact_id: "newly-created-uuid" }

// Option C: Ignore (spam, wrong number etc.)
{ action: "ignore" }
```

On resolve: updates `call_records` status to `resolved` or `ignored`, sets `resolved_by` and `resolved_at`, triggers activity timeline entry creation if linked.

### GET `/api/calls/contact/:contact_id`
**Auth:** JWT required

Returns all call records matched to a given contact, newest first. Used by the CRM activity timeline component.

### GET `/api/calls/stats`
**Auth:** JWT required

Returns summary stats for dashboard widget: total calls today, total this week, unresolved inbox count, average call duration.

---

## Backend: Processing Worker

A background worker runs on the Hetzner server (can be a simple `setInterval` loop or a lightweight job queue — `bull` or `pg-boss` are both good fits given the existing PostgreSQL setup).

**Worker loop (runs every 30 seconds):**

1. Claim next `pending` job from `call_processing_queue` (use `SELECT ... FOR UPDATE SKIP LOCKED` to be concurrency-safe)
2. Mark job as `processing`
3. Execute stage:

**Stage: `transcribe`**
- Fetch MP3 from `call_records.audio_url` (if null, skip and re-queue — audio not yet received)
- POST to AssemblyAI `/v2/transcript` with `audio_url`, `speaker_labels: true`, `language_code: "en_gb"`
- Poll AssemblyAI until `status === "completed"` (or use their webhook callback — preferred)
- Store transcript text in `call_records.transcript`
- Store speaker segments in `call_records.transcript_speakers`
- Enqueue `analyse` stage

**Stage: `analyse`**
- Send transcript to Claude API using prompt template above
- Parse JSON response
- Update `call_records` with all analysis fields
- Enqueue `match` stage

**Stage: `match`**
- Normalise `call_records.caller_number` to E.164
- Query `phone_number_index` for matching contacts
- **0 results:** Set status to `unmatched`
- **1 result:** Set status to `matched`, set `matched_contact_id`, create activity timeline entry
- **2+ results:** Set status to `ambiguous`, store candidate contact IDs in `match_candidates`
- For matched/ambiguous: also check `mentioned_job_refs` against HireHop API — if a valid job is found and the contact matches, auto-link `matched_hirehop_job`

**Error handling:**
- On failure, increment `attempts`, store `last_error`, re-queue with exponential backoff (max 3 attempts)
- After 3 failures, set status to `failed` — surface in a simple admin view or log alert

---

## Activity Timeline Entry

When a call is successfully matched, create an activity entry in the ops platform's standard activity/timeline system (however that is implemented — adapt to existing pattern).

The entry should contain:

```javascript
{
  type: "call",
  contact_id: "uuid",
  hirehop_job: "JOB-4821",        // if linked, else null
  direction: "inbound",            // or "outbound"
  duration_seconds: 272,
  recorded_at: "2026-03-11T10:14:00Z",
  summary: "Tom from Forta Productions called regarding the Sheffield Arena run...",
  sentiment: "positive",
  urgent: false,
  suggested_action: "Follow up with quote for 3 Sprinters",
  call_record_id: "uuid"           // link to full call record for transcript view
}
```

**Rendered in the timeline as:**
```
📞 Inbound call · 4m 32s · 11 Mar 2026, 10:14am
"Tom from Forta Productions called regarding the Sheffield Arena run in May. 
Confirmed they need 3 Sprinters from the 12th."
[View transcript ↗]   [Linked: Job #4821]
```

---

## Frontend: Calls Inbox Page

**Route:** `/calls/inbox`
**Nav position:** Top-level nav item (alongside Jobs, CRM, Fleet etc.)
**Badge:** Show unresolved count on nav item (unmatched + ambiguous)

### Layout

Standard ops platform page layout. Two tabs:

- **Needs attention** — unmatched + ambiguous calls (default view)
- **All calls** — full call log, filterable by date, direction, status

### Call Card (Needs Attention tab)

Each card shows:

```
┌─────────────────────────────────────────────────────────┐
│  📞 INBOUND  ·  +44 7911 123456  ·  11 Mar, 10:14am  ·  4m 32s
│
│  "Caller enquired about van hire for a June festival run.
│   Mentioned working with AEG. Wants 2 Sprinters."
│
│  🏢 AEG  ·  😊 Positive  ·  💡 Follow up with quote
│
│  [🔗 Link to contact]  [➕ Create contact]  [🗑 Ignore]
└─────────────────────────────────────────────────────────┘
```

For **ambiguous** calls, the card also shows candidate contacts:

```
│  ⚠️ Multiple matches found:
│  ○ Tom Harris — Forta Productions — last contact 2 weeks ago
│  ○ Tom Harris — AEG Presents — last contact 3 months ago
│  [Select correct contact]
```

### Link to Contact Flow

Clicking "Link to contact" opens a modal:
- Search field to find/confirm contact
- Optional: select a HireHop job to associate (dropdown of recent open jobs for that contact)
- Confirm button → calls `PATCH /api/calls/:id/resolve`

### Transcript View

Clicking any call record (in All Calls tab or from a contact's timeline) opens a slide-over/drawer showing:
- Call metadata (number, time, duration, direction)
- Claude summary + suggested action
- Full transcript with speaker labels (Speaker A / Speaker B, not yet named — future enhancement could label once contact is matched)

---

## Frontend: Call Activity in CRM

On each contact record's activity timeline, call entries render as described in the Activity Timeline Entry section above. Clicking "View transcript" opens the same slide-over drawer used in the Calls Inbox.

The `phone_number_index` should be maintained by the CRM module — whenever a contact's phone numbers are added or updated, the index is updated accordingly.

---

## Environment Variables Required

Add to existing `.env` / Hetzner server environment:

```
VOIPFONE_WEBHOOK_SECRET=           # Token to validate incoming Voipfone webhooks
ASSEMBLYAI_API_KEY=                # AssemblyAI API key (sign up at assemblyai.com)
RECORDING_EMAIL_SECRET=            # Shared secret for inbound email webhook (Mailgun/Postmark)
CLOUDFLARE_R2_RECORDINGS_BUCKET=   # R2 bucket name for MP3 storage
# Note: ANTHROPIC_API_KEY already exists in platform
# Note: Cloudflare R2 credentials already exist in platform
```

---

## Legal / Compliance Note

Under UK law (Telecommunications (Lawful Business Practice) (Interception of Communications) Regulations 2000), businesses may record calls for legitimate purposes without consent **only if** callers are informed. This is typically handled by a brief announcement played when the call is answered (e.g. *"This call may be recorded for quality and training purposes"*).

This must be configured in Voipfone's IVR/call flow settings before call recording is enabled. This is an operational step for Jon/the team — not a code task — but the module should not be activated until this is in place.

---

## Build Phases & Priority

Given the ops platform is being built now (July 2026 target), the recommended build order is:

**Phase 1 — Foundation (build alongside core platform)**
- Database tables (`call_records`, `call_processing_queue`, `phone_number_index`)
- Webhook receiver endpoint (`POST /api/calls/webhook`)
- Phone number normalisation utility
- CRM integration: populate `phone_number_index` on contact create/update

**Phase 2 — Processing pipeline**
- Email ingest for recordings (Mailgun/Postmark inbound)
- R2 upload for MP3 storage
- AssemblyAI transcription integration
- Claude summarisation integration
- Background worker with all three stages

**Phase 3 — Frontend**
- Call activity component for CRM timeline
- Calls Inbox page (both tabs)
- Link/resolve flow and modal
- Transcript drawer

**Phase 4 — Polish**
- Nav badge for unresolved count
- Dashboard stats widget
- Swap email ingest for direct Voipfone recording URL once Voipfone releases it (single line change in worker: fetch from URL rather than wait for email)
- Consider speaker labelling once contact is matched (relabel Speaker A → "Tom" in transcript view)

---

## Open Questions for CC to Note

1. **Activity timeline implementation:** The spec refers to a generic activity/timeline system on contact records. CC building the ops platform should confirm the data model for this so call entries conform to the same pattern as other activity types (emails, notes, etc.)

2. **Background worker approach:** The spec is agnostic between a simple `setInterval` loop, `bull` (Redis-backed), or `pg-boss` (PostgreSQL-backed). Given the platform already uses PostgreSQL, `pg-boss` avoids adding a Redis dependency. CC should confirm what's already in use or planned.

3. **Contact data model:** The spec assumes a `contacts` table with `id` UUID primary key. CC should confirm field names for phone numbers on the contacts table so the `phone_number_index` population logic is correct.

4. **HireHop job lookup:** The worker references checking `mentioned_job_refs` against HireHop API. CC should confirm whether a HireHop job lookup utility already exists in the platform codebase to reuse.

5. **Inbound email provider:** Mailgun and Postmark both support inbound email parsing. If the ops platform already uses one of these for outbound email, use the same provider for consistency.

---

*Spec prepared March 2026. Contact Jon at Ooosh Tours with any questions.*
