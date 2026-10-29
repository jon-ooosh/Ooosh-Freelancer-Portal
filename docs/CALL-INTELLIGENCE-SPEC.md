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
> | Recordings by email via Mailgun/Postmark | **Superseded again (29 Oct 2026):** recordings arrive from Twilio's recording callback (§T). There is no email step and no Gmail mailbox for recordings |
> | Voipfone webhooks, `X-Pbx-Token` | **Superseded (29 Oct 2026):** Twilio, §T. Voipfone has no webhooks or API (their support, Oct 2026) |
> | "Calls Inbox" page | Matching stays deterministic, as for email (number → person → their open job; a job number said on the call as evidence, never a guess). Unmatched calls go to ONE review surface shared with unmatched email, not a second inbox |
> | `pg-boss` / `bull` worker | The existing `config/scheduler.ts` (node-cron) pattern with a table queue |
> | `claude-sonnet-4-…` | `config/anthropic.ts` constants, structured output read with `readStructuredJson()` |
> | MP3s in R2 under `recordings/` | A private prefix that `GET /api/files/download` role-gates (today only `staff-records/` and `claims/` are gated — every other prefix is readable by any staff login). Recordings must be gated |
> | (not covered) | Retention: a setting like email's 24 months, then strip audio and transcript, keep the summary |
>
> **To check before building:** the "calls may be recorded" announcement is now OP's own (§T3), so it ships
> with the inbound route; who may listen to a recording.
>
> **What it feeds:** call summaries go into the client brief (`AI-KNOWLEDGE-SPEC.md` §5), so a chase or
> a quote knows what was said on the phone; `suggested_action` becomes a suggested To Do for a person
> to accept, never an automatic action.

---

## T. Telephony on Twilio — the phone system itself (decided 29 Oct 2026)

**Why:** Voipfone has no webhooks and no API, so it cannot feed this module. Ooosh is moving its phones
to **Twilio**, the account OP already uses for SMS (`services/sms-service.ts`). OP becomes the phone
system: Twilio asks OP what to do with each call, and OP answers in TwiML. **Everything in the March
sections below about Voipfone, recording emails and Mailgun/Postmark is superseded by this section.**
The intelligence half (transcribe → summarise → match → `interactions`) is unchanged.

This section is built and tested BEFORE the March phases. Phones first, intelligence second.

### T1. Settled (jon, Oct 2026)

- **Handsets stay:** four Gigaset A540H handsets on **two Gigaset N300IP bases**. Each N300IP takes
  6 SIP accounts and up to 3 internet calls at once.
- **One SIP login per BASE** (`base1`, `base2`), not per person or per handset. Handsets are shared
  and get swapped around. Per-handset logins (the N300IP can assign a SIP account to each handset) are
  a later option, not part of this build.
- **Incoming:** a short recording notice, then ring both bases at once. Unanswered after the timeout
  goes to voicemail.
- **Record everything**, inbound and outbound.
- **Voicemail** is recorded by Twilio, goes through the same pipeline as calls, and is emailed by Resend
  (`email-service.ts`) with the summary, transcript and audio. This replaces Voipfone's emailed MP3.
- **The phones must work when OP is down:** the number's fallback URL is a Twilio-hosted TwiML Bin that
  rings both bases with no OP involvement (no recording, no voicemail). Outbound calls need OP; if OP is
  down, staff use mobiles.
- **Audio is copied to R2, then deleted from Twilio.** OP is the only long-term store, so retention
  (§0) is OP's to enforce.
- **01273 911382 is ported only after a test number has run for about a week** (T5, T6). Voipfone is
  not cancelled until the port completes. Voipfone's free 056 number is not ported.
- **Rough cost:** about £15–20/month for telephony at ~300 outbound and a few hundred inbound minutes,
  against ~£26 on Voipfone today. Transcription and Claude are extra, as already costed.

### T2. Twilio Console setup (jon, by hand — not code)

1. **Test number:** buy one UK Local number (any area; about £0.87/month). Attach the existing UK
   Regulatory Compliance bundle (the SMS one). Attach an **Emergency Address**: Compass House,
   7 East Street, Portslade, BN41 1DL. Outbound calls need it.
2. **SIP Domain:** create one (e.g. `ooosh.sip.twilio.com`). Create a credential list with `base1` and
   `base2`, each with a long random password. Turn on **SIP Registration** and **Emergency Calling** on
   the domain.
   - Voice URL: `POST https://staff.oooshtours.co.uk/api/telephony/outbound`
3. **Number's voice config:**
   - A call comes in: `POST https://staff.oooshtours.co.uk/api/telephony/inbound`
   - Primary handler fails: a **TwiML Bin** that `<Dial>`s `sip:base1@…` and `sip:base2@…` together.
4. **Bases:** before changing anything, screenshot each N300IP's current Voipfone settings so the
   change can be rolled back. Then point ONE base at Twilio for the test (registrar = the SIP domain,
   username/password from step 2). Turn off "SIP ALG" on the office router if it has it.

### T3. OP endpoints — new `routes/telephony.ts`, logic in `services/telephony.ts`

- **Every request is checked with `X-Twilio-Signature`**, which needs the account **Auth Token**. The
  API key SMS uses cannot validate signatures, so add `TWILIO_AUTH_TOKEN`. An unsigned or badly signed
  request gets a 403.
- **Always answer in TwiML, fast.** Never block on R2, AssemblyAI or Claude inside a TwiML response;
  queue it.
- **Twilio is called over REST, no SDK**, following `sms-service.ts`.

| Route | Called by | Does |
|---|---|---|
| `POST /api/telephony/inbound` | the number | Insert `call_records` (direction `inbound`, `caller_number` = `From`, `unique_call_id` = `CallSid`). Reply: `<Say>` the recording notice → `<Dial timeout=… record="record-from-answer-dual" recordingStatusCallback=…/recording action=…/inbound-after>` with `<Sip>` for base1 and base2 (simultaneous ring, `referUrl` set — see transfers) |
| `POST /api/telephony/inbound-after` | the `<Dial>` action | `DialCallStatus` answered → `<Hangup/>`. Otherwise → voicemail greeting + `<Record maxLength="180" recordingStatusCallback=…/recording?kind=voicemail>` |
| `POST /api/telephony/outbound` | the SIP domain | Read the dialled digits from `To` (`sip:07700900123@…`), normalise to E.164 with the ONE shared normaliser (07… → +447…, 0… → +44…, 00… → +…). Reply `<Dial callerId=TELEPHONY_CALLER_ID record="record-from-answer-dual" recordingStatusCallback=…><Number>`. Insert `call_records` (direction `outbound`, the matched number = the dialled one). Refuse premium-rate (09…) and anything unparseable with a spoken message, not silence |
| `POST /api/telephony/recording` | recording callbacks | Download the recording (authenticated), upload to R2 under a **gated** prefix `calls/YYYY/MM/<CallSid>.<ext>` (add `calls/` to the gated list in `GET /api/files/download` alongside `staff-records/` and `claims/`), then DELETE it from Twilio. Enqueue `transcribe`. **Idempotent on `RecordingSid`**: Twilio retries callbacks |
| `POST /api/telephony/refer` | a handset transfer | Cross-base transfer (below) |

**Emergency calls (999/112):** with Emergency Calling on the SIP domain, these must go straight to the
emergency services and never depend on OP. **Confirm in Twilio's SIP emergency-calling docs exactly how a
registered SIP device's 999 is routed, and that OP's outbound route can never swallow one.** Never test
by dialling 999 for real; use Twilio's documented test route if one exists.

**Transfers:**
- A transfer between handsets on the same base stays inside the base.
- A transfer to the OTHER base sends SIP REFER: the handset → Twilio → `referUrl` → OP replies `<Dial><Sip>` to the other base. Twilio charges $0.10 per refer.
- **This must be proved in the T5 test.** If the N300IP's transfer doesn't send a REFER Twilio accepts, say so; don't build a workaround without jon.

**Differences from the March tables:**
- `unique_call_id` holds Twilio's `CallSid`.
- Add `kind` (`call` | `voicemail` | `missed`), `answered_by` (`base1` | `base2` | null) and `recording_sid`.
- `audio_url` becomes an R2 key.
- `record-from-answer-dual` puts staff and caller on separate channels. Use AssemblyAI's multichannel mode for cleaner speaker labels than diarisation.
- A **missed call with no voicemail** is still logged (`kind = 'missed'`, no audio, no AI), so the number is matched and can be called back.

### T4. Settings and env

**`system_settings`** (staff-editable, no deploy needed):
- `telephony_ring_timeout_seconds` (default 25)
- `telephony_recording_notice` (spoken text)
- `telephony_voicemail_greeting` (spoken text, or later an R2 audio file)
- `telephony_voicemail_email_to` (default info@)

**`.env`:**
- Add `TWILIO_AUTH_TOKEN`, `TWILIO_SIP_DOMAIN` and `TELEPHONY_CALLER_ID` (the test number until the port, then `+441273911382`).
- Remove `VOIPFONE_WEBHOOK_SECRET` and `RECORDING_EMAIL_SECRET` from the March list; they are not needed.

### T5. Test plan — test number, ONE base, about a week

**Calls**
- [ ] The base registers and stays registered through a night
- [ ] Inbound: notice plays, both handsets on the base ring, answer, two-way audio clear
- [ ] Outbound to a landline, a mobile, and one EU number: caller ID shows the test number
- [ ] Hold: what the caller hears
- [ ] Two calls at once on one base

**Voicemail**
- [ ] Unanswered → voicemail → email arrives with audio, and later the summary

**Recordings and pipeline**
- [ ] Recording lands in R2 under `calls/`, is gated, and is gone from Twilio
- [ ] Bad signature → 403

**Fallback**
- [ ] Fallback: point the inbound URL at a dead path; the TwiML Bin still rings the phones

**Second base**
- [ ] Move the second base over; both ring; cross-base transfer (REFER) works or is reported as not working

**Costs and emergency**
- [ ] Twilio usage for the week matches the estimate
- [ ] 999 routing confirmed from Twilio's docs (not by test call)

### T6. Go-live (jon)

1. Ask Voipfone to confirm 01273 911382 is a **single-line** number. Multi-line is the usual reason UK
   ports are rejected.
2. Submit the port to Twilio. UK geographic ports can take up to 4–6 weeks.
3. **Before the port date**, give the ported number the same voice URL and fallback as the test number.
4. Set `TELEPHONY_CALLER_ID=+441273911382`.
5. After the port, ring it from a mobile: does it reach the bases?
6. **Only then** cancel Voipfone's services.

### T7. Known risks (accepted by jon, Oct 2026)

- **No helpdesk:** OP and Claude Code are the support line. The fallback TwiML Bin is the safety net for inbound.
- **Office network:** NAT and router "SIP ALG" are the usual first-week faults (one-way audio, dropped registrations).
- **Data location:** recordings sit briefly in Twilio, a US account, until OP deletes them; covered by Twilio's DPA. UK-GDPR-compliant storage is enough (jon); UK-only storage is not required.

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

> **Steps 1–4 are now §T (Twilio recording callback → R2). Steps 5–7 stand.**

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

### Voipfone — SUPERSEDED, see §T (Twilio). Kept for history only.
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
> **SUPERSEDED by §T3** (`/api/telephony/*`). This route and `/api/calls/recording-email` are not built.

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
TWILIO_AUTH_TOKEN=                 # validates X-Twilio-Signature (§T3/T4; replaces VOIPFONE_WEBHOOK_SECRET)
TWILIO_SIP_DOMAIN=                 # §T2
TELEPHONY_CALLER_ID=               # test number, then +441273911382 after the port
ASSEMBLYAI_API_KEY=                # AssemblyAI API key (sign up at assemblyai.com)
CLOUDFLARE_R2_RECORDINGS_BUCKET=   # R2 bucket name for MP3 storage
# Note: ANTHROPIC_API_KEY already exists in platform
# Note: Cloudflare R2 credentials already exist in platform
```

---

## Legal / Compliance Note

Under UK law (Telecommunications (Lawful Business Practice) (Interception of Communications) Regulations 2000), businesses may record calls for legitimate purposes without consent **only if** callers are informed. This is typically handled by a brief announcement played when the call is answered (e.g. *"This call may be recorded for quality and training purposes"*).

This is now OP's inbound TwiML (§T3, text in `telephony_recording_notice`), so it ships with the inbound route. Outbound calls: staff should mention recording where it matters; jon to decide whether outbound also plays a short notice.

---

## Build Phases & Priority

Given the ops platform is being built now (July 2026 target), the recommended build order is:

**Phase 1 — Foundation (build alongside core platform)**
- Database tables (`call_records`, `call_processing_queue`, `phone_number_index`)
- Webhook receiver endpoint (`POST /api/calls/webhook`)
- Phone number normalisation utility
- CRM integration: populate `phone_number_index` on contact create/update

**Phase 2 — Processing pipeline**
- ~~Email ingest for recordings~~ — replaced by the Twilio recording callback (§T3)
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
- Consider speaker labelling once contact is matched (relabel Speaker A → "Tom" in transcript view)

---

## Open Questions for CC to Note

1. **Activity timeline implementation:** The spec refers to a generic activity/timeline system on contact records. CC building the ops platform should confirm the data model for this so call entries conform to the same pattern as other activity types (emails, notes, etc.)

2. **Background worker approach:** The spec is agnostic between a simple `setInterval` loop, `bull` (Redis-backed), or `pg-boss` (PostgreSQL-backed). Given the platform already uses PostgreSQL, `pg-boss` avoids adding a Redis dependency. CC should confirm what's already in use or planned.

3. **Contact data model:** The spec assumes a `contacts` table with `id` UUID primary key. CC should confirm field names for phone numbers on the contacts table so the `phone_number_index` population logic is correct.

4. **HireHop job lookup:** The worker references checking `mentioned_job_refs` against HireHop API. CC should confirm whether a HireHop job lookup utility already exists in the platform codebase to reuse.

5. ~~Inbound email provider~~ — not needed; recordings come from Twilio (§T).

---

*Spec prepared March 2026. Contact Jon at Ooosh Tours with any questions.*
