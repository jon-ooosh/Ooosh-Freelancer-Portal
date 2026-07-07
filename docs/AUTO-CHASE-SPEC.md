# AUTO-CHASE-SPEC.md — Operational Awareness Layer & Auto-Chase

**Status:** Phase 1 BUILT + merged (Jul 2026, PR #919) — deployed **inert** until the `GMAIL_*` env vars are set on the server (see §13.1 below). Phases 1.5 → 4 are design. Written for review + tweak; expect this to span several sessions.

**Branch:** `claude/auto-chase-feature-design-tiknf2`

## 0. One-line summary

Ingest the `info@oooshtours.co.uk` Gmail inbox into OP so every client conversation is logged automatically, then sit an AI-drafted "just checking in?" auto-chase on top of that clean data — **drafted, not auto-sent, by default**, and never fired over a live conversation.

## 1. Motivation & the core insight

We used to run a crude Monday.com + Zapier auto-chase: set a chase date, mark it "auto chase in X days", and at 9am on the day Zapier found the last quote email in `info@` and fired a generic "any thoughts on this quote?" reply, then marked the item Chased. Useful time-saver, but two real problems:

1. **Generic email** — no awareness of what was actually quoted or the relationship.
2. **Human slackness** — a quote had been progressing (discussed with client + staff) but nobody updated the Monday item, so the auto-email fired anyway. Jarring for the client, embarrassing for us.

**The core insight:** the "jarring email" problem is fundamentally an *activity-awareness* problem, not a chase-logic problem. The old system fired blind because it couldn't see the conversation. Every serious sales-engagement tool (HubSpot Sequences, Salesloft, Outreach, Apollo, Mixmax, Reply.io) solves this the same way: **auto-unenroll on reply/activity** — the moment the prospect replies or anything happens on the thread, they drop out of the sequence. That single pattern is what this whole feature is designed around.

So the build order inverts what you'd expect: **email ingestion first, auto-chase second.** Once OP can *see* what's happening, the chase is almost a by-product.

## 2. Design principles

- **Draft, don't send (by default).** Trust is earned. Drafts land as Gmail drafts in `info@`, threaded onto the original quote email. Staff glance + one-click send. Auto-send is opt-in, per-quote, once the drafts have proven themselves.
- **Activity-aware suppression is non-negotiable.** No chase (draft or send) fires without a pre-flight check that the conversation hasn't moved on.
- **Toggleable per-quote at chase-marking time.** Set on the existing `ChaseModal` (`frontend/src/components/ChaseModal.tsx`). Off / Draft / Auto-send. Not every chase is a candidate; staff keep the call.
- **Recognise cold dead-ends.** After N silent chases, stop and ask a human ("call them or drop it?") rather than firing chase #4 into the void.
- **Store the email body, not just "an email happened".** Suppression only needs "did activity happen"; disputes + summaries need the actual words. Storing bodies is the deliberate choice that unlocks the dispute helper (§7).
- **`info@` only to start.** Prove it there before extending to manager mailboxes (§6). Company-owned addresses, legitimate business interest — the real consideration is staff comfort, not legality.
- **Reuse existing infrastructure.** This layers onto the May 2026 chase model, the email service, the interactions/timeline system, the `job_contacts` routing model, and `config/anthropic.ts`. It is an *extension*, not a greenfield build.

## 3. How it fits the existing chase model

OP already has (see CLAUDE.md "Pipeline Chase Model (May 2026)"):

- `next_chase_date` on jobs + a derived `is_chasing` flag (date-granular, not timestamp).
- Daily 08:00 alert scanner (opt-in, `chase_alert_user_id`).
- **Auto-bump on contact-type interactions** — logging a `call`/`email`/`meeting` interaction on a job bumps `next_chase_date` by `chase_interval_days`, subject to the **sacred-future rule** (never shorten a deliberately future-dated chase).
- `skip_chase_bump` opt-out for backdated/non-consequential entries.

**This is the hook.** When Gmail ingestion logs a client email as an `interaction` (type `email`) on the job, the existing auto-bump fires for free — the pipeline stays honest even if staff never touch OP. Auto-chase then sits on top of clean data instead of stale data. We are not rebuilding chase logic; we're feeding it.

## 4. Model choices (per the `claude-api` skill, Jun 2026)

Split by task — do not use one model for everything:

| Task | Model | ID | Why |
|---|---|---|---|
| Thread summaries | Haiku 4.5 | `claude-haiku-4-5` | Cheap ($1/$5 per MTok), cacheable, well within ability. Same tier as PCN extraction. Bump the individual call to `claude-sonnet-5` if long rumbling threads lose nuance. |
| AI-drafted chase emails | Sonnet 5 | `claude-sonnet-5` | Client-facing; tone + accuracy matter. Still a fraction of a penny per draft. Same tier as the backline matcher. |
| Dispute-helper NL query | Sonnet 5 (default) / Haiku for cheap lookups | `claude-sonnet-5` | Reasoning over a thread chain to surface "who asked for what, when". |

- **Prompt-cache the system prompt** on every call (`cache_control: {type: "ephemeral"}` on the frozen system block).
- **Cache the summary on the thread record** — only regenerate when a new message lands. Summaries are pennies AND cacheable, so token cost is a non-issue; owning the summary (vs Gmail's native card, which is **not** exposed via any API — see §7) buys us exact placement in OP.
- All calls go through `getAnthropicClient()` in `backend/src/config/anthropic.ts` (guarded by `isAnthropicConfigured()` — degrade cleanly to 503 if `ANTHROPIC_API_KEY` unset). `ANTHROPIC_API_KEY` is already on prod.

## 5. Phase 1 — Gmail → interactions ingestion (the foundation, valuable alone)

A service that reads `info@` and logs client emails onto job timelines as `interactions`.

### 5.1 Access mechanism

- **Google Workspace domain-wide delegation.** One service account; jon (as Workspace admin) consents once; OP can read `info@` (and later any mailbox) without per-user OAuth. This is also what makes §6 (manager mailboxes) a small add rather than five separate OAuth flows.
- Gmail API only (`gmail.googleapis.com`) — **not** Zapier. This kills the Zapier attachment-zip irritation: the Gmail API sends multiple attachments as native separate MIME parts, so a chase with two PDFs attached individually is the standard shape.
- Env: `GMAIL_SERVICE_ACCOUNT_JSON` (or path), `GMAIL_DELEGATED_USER=info@oooshtours.co.uk`. Guard with an `isGmailConfigured()` helper mirroring the Stripe/Anthropic config pattern so the app boots without it.

### 5.2 Sync loop

- Poll every ~10 min (node-cron, alongside the existing schedulers in `config/scheduler.ts`). Use Gmail `history.list` with a stored `historyId` cursor for incremental fetch (not a full re-scan).
- For each new message: dedup, match to a job, log as an interaction, cache/refresh the thread summary.

### 5.3 Matching engine (email → job)

Match in priority order (per jon: no consistency in client subject conventions, so lean on sender + attachment filename):

1. **Sender/recipient email address → person → job.** We have `job_contacts` (per-job contact list) and `person_organisation_roles`. A known contact email on a thread points at their org's jobs; disambiguate by recency + open pipeline status.
2. **HH job number in subject or body** (regex `#?\d{4,5}`, validated against `jobs.hh_job_number`).
3. **HH job number in an attached PDF filename** — HireHop quote PDFs carry the job number in the filename. This is the strongest fallback and the same key the Zapier flow used. Parse attachment part filenames from the MIME structure.
4. **AI fuzzy match** (Haiku) for the ambiguous residue — given sender, subject, snippet + a shortlist of candidate open jobs for that client, pick the job or return "no confident match".
5. **No match** → log to an "unmatched inbound" review queue (staff can hand-link, feeding the matcher over time). Never guess-attach.

### 5.4 Dedup

- Dedup on the RFC822 `Message-ID` header (globally unique per message). One interaction per unique message regardless of how many mailboxes surface it (critical once §6 adds manager inboxes and the same email appears 4×).

### 5.4a Internal / automated sender filter (BUILT — critical, added Jul 2026)

`info@` receives a large volume of **our own** mail, not just client replies: every internal notification / alert / reminder is sent from `notifications@` or a staff address (all `@oooshtours.co.uk`), and **many carry a HH job number** — referral alerts, pre-hire briefings (T-5/3/1), chase & holding digests, hire-form fallback alerts, and especially the **client-no-email fallback** (our *outbound* client message redirected into `info@` with the job ref embedded, so staff can forward it). Left unfiltered, every one of those would match a real job via the matcher's job-number layer (§5.3.2/3), land in the inbox (so `direction='inbound'`), and get logged onto the job timeline as a fake "client reply."

**The rule (in `gmail-ingestion.ts` `processMessage`, before matching):** skip entirely — no interaction, no unmatched-queue row — any inbound whose From is on our own domain (`INTERNAL_SENDER_DOMAINS = ['oooshtours.co.uk']`), OR that looks automated (`Auto-Submitted` header ≠ `no`; `Precedence: bulk/list/junk`). The skipped count surfaces on the `/ingest` summary. The history cursor advances past skipped messages so they never reappear.

**Why the domain cut is clean:** client replies are always from external domains; clients are never on our domain. It also correctly drops our own SENT copies (Phase 2 owns draft-vs-sent capture) and the client-no-email fallback (which is bounced OUTBOUND, not a reply). It stays correct into §6 manager mailboxes — a client replying to Sarah is still external (kept); Sarah's outbound is from our domain (skipped). The only loss is a staff member *forwarding* a client thread into `info@` (from a staff address), which is acceptable and is manager-mailbox territory anyway.

**Decision (jon, Jul 2026):** filter smartly rather than move internal mail off `info@`. Staff rely on seeing those alerts in the shared inbox, and the sender filter is lower blast-radius and reversible. Extend `INTERNAL_SENDER_DOMAINS` if we ever quote/send client mail from another owned domain.

**Enquiry carve-out (`ENQUIRY_SOURCE_ADDRESSES`) — RESOLVED (Jul 2026): don't use it for enquiries.** The website enquiry form was confirmed to send **From `info@oooshtours.co.uk`** (via Resend / `send.oooshtours.co.uk`), real client in **reply-to**. So the internal filter skips it — but that's fine: a brand-new enquiry has no job to attach to, so it'd only hit the unmatched queue anyway. And `info@` is **NOT** a safe allowlist entry, because it's also the address staff reply to clients from in the shared inbox — allowlisting it would ingest our own outbound as fake client mail. **The right home for enquiry-auto-create (Phase 4, §11) is a DIRECT form→OP webhook** — since we control the enquiry-form repo, POST structured fields (band / service / client email from reply-to / message) straight to an OP endpoint rather than scraping the email. `ENQUIRY_SOURCE_ADDRESSES` stays empty; keep it only for a genuinely distinct future enquiry sender.

### 5.5 What gets stored

- `interactions` row: `type='email'`, `job_id`, `content` = **full body text** (plus a short snippet for previews), `direction` (inbound/outbound), `created_by = SYSTEM_USER_ID`, plus new metadata (see §9): Gmail `message_id`, `thread_id`, `from`, `to`, `subject`, `has_attachments`.
- Attachments: harvest to R2 + append to `jobs.files` (see §8 "attachment harvesting"). Store the Gmail attachment part reference so we can re-fetch the original PDF for a chase (§8.4).
- **This auto-bumps `next_chase_date`** via the existing contact-interaction rule (§3). Inbound client emails should bump; our own outbound auto-chase should NOT bump (pass `skip_chase_bump` — the chase already reschedules itself).

### 5.6 Privacy / GDPR + retention window

- `info@` is shared/transactional — clean to ingest. Logging client emails as interactions is legitimate business interest, already within the relationship.
- Storing bodies is a deliberate choice (needed for disputes). This is the first place OP holds a large volume of free-text client PII, so it needs an explicit retention window (CLAUDE.md Security already flags "Data retention/expiry policy for PII" as an open gap).

**Proposed retention (jon deferred to this, Jun 2026):**

| Age of `type='email'` interaction | What we keep |
|---|---|
| **0 – 24 months** | Full body text + metadata + summary. Covers the realistic dispute / "where's X??" window — a hire's dispute tail almost always closes inside two years, and repeat-client history stays rich. |
| **> 24 months** | **Strip the body**, keep metadata (`gmail_message_id`, `thread_id`, from/to, subject, date, `has_attachments`) + the AI summary. The thread is still *visible* on the timeline ("Sarah emailed re: the quote, 3 Jun 2024, summary: …") and dedup/audit still work, but the raw personal-data payload is gone. |

- **Why strip-not-delete:** deleting the interaction row entirely would leave holes in the timeline and lose the audit that a conversation happened at all. Keeping metadata + summary preserves the operational history (client relationship, "we did talk to them") while discharging the GDPR data-minimisation duty on the bulk PII (the verbatim body). The summary is our own derived artefact, not raw client data.
- **Mechanism:** a low-frequency scheduled task (weekly is ample) `UPDATE interactions SET content = NULL, body_stripped_at = NOW() WHERE type='email' AND created_at < NOW() - INTERVAL '24 months' AND body_stripped_at IS NULL`. Cheap, idempotent, and reversible in policy (extend the window later without a migration). Attachments harvested to `jobs.files` (§8) follow the file-retention policy separately — they're operational documents, not conversational PII, so they are NOT auto-stripped by this task.
- The window is a `system_settings` value (`email_retention_months`, default 24) so it's tunable without a deploy if legal/ops want it shorter or longer.

## 6. Phase 1.5 — Manager mailboxes (feasible; deferred until `info@` proven)

- **Feasibility: yes.** Domain-wide delegation (§5.1) scales trivially to the 5 managers' `@oooshtours.co.uk` accounts — admin consents once, no per-manager OAuth.
- **The real work is dedup, not access** — §5.4 already handles it via `Message-ID`. Adding mailboxes = adding delegated users to the poll loop; each message still logs once.
- **Prove on `info@` first**, then roll out. GDPR is a staff-comfort question, not a legal blocker (company property, legitimate interest).

### 6.1 The staleness cost of `info@`-only (jon, Jun 2026)

Confirmed: staff genuinely do start or carry threads on their own `@oooshtours.co.uk` addresses — a client likes to reply to their usual point of contact, and we shouldn't break that relationship by forcing everything through `info@`. So an `info@`-only Phase 1 has a real blind spot: a quote thread that has moved on entirely on Sarah's personal mailbox looks *silent* to the auto-chase, and a chase could fire over the top of a live conversation OP simply can't see.

**We accept this as a known cost of the first cut, deliberately, rather than paper over it:**

- **No "always CC info@" mandate.** Forcing a CC would clutter the shared inbox and still wouldn't catch client-*initiated* threads (the client won't CC us). Not worth breaking the relationship for imperfect coverage.
- **Draft-not-send is the mitigation.** Because Phase 1/2 default to *drafts* (§9.4), the human glancing at the draft in `info@` is the backstop — they know if they've been talking to the client on their own address and just bin the draft. The staleness cost only bites hard once auto-send (Phase 3) is on, which is exactly why auto-send stays per-quote opt-in and manually judged.
- **It sharpens the case for §6 (manager mailboxes), which becomes the priority follow-up rather than a "someday".** Every mailbox we add shrinks the blind spot. The plan is: prove ingestion on `info@`, then roll the 5 manager mailboxes in *quickly* — the dedup (§5.4) is already built for it, so it's low-effort, high-coverage. Treat manager-mailbox rollout as Phase 1.5 proper, not a deferred nicety.

## 7. Gmail's native summary + the dispute dream

### 7.1 Can we tap Gmail's native thread summary? No.

The Gemini summary cards in Gmail are a **UI feature** — the Gmail API exposes messages/threads/attachments/headers/bodies but **no endpoint returns the summary**. There is no `threads.summarize`. We generate our own with Haiku (§4) — cheap, cacheable, and placed exactly where we want it on the Job Detail page. The "someone already did the work" instinct is right in spirit but the work is sub-penny, so owning it wins.

### 7.2 Dispute helper (native OP/Claude, falls out of Phase 1)

Because Phase 1 ingests **full bodies**, the whole email chain is searchable per job. "Where's X??" becomes a natural-language query over the job's comms — Claude surfaces "3 weeks ago Dave (drummer) asked to remove X [quoted text, dated], we confirmed on the 4th."

- Surface: a "Ask about this job's comms" box on the Job Detail Activity tab, or a dedicated dispute panel.
- **Step further (small addition, high value):** diff `jobs.line_items` over time (we currently sync current state, not history) and cross-reference with the email chain → OP auto-assembles the audit trail ("client requested X removed (email 3 May) → removed from HH 4 May"). Needs a line-item-diff history table. This is the piece that makes disputes near-instant. Flagged as a Phase 4 companion.

## 8. Other gleanings from Gmail ingestion (the suppression smarts + freebies)

These feed §10's suppression checklist and are cheap once ingestion exists:

1. **OOO autoresponders** → parse "away until the 15th", auto-push the chase past their return. Genuinely human.
2. **Bounce detection** → wrong email on file surfaces as a data-quality to-do instead of a silent dead chase.
3. **Hot inbound** → a client chasing *us* ("any update??") is the inverse of needing a chase — flag loud, never auto-chase over the top.
4. **Attachment harvesting** → stage plots / tech specs / riders clients email in get auto-filed to `jobs.files` (with the existing `share_with_freelancer` flag defaulting off).
5. **(Later) New-enquiry detection** → unknown sender + quote-request language → "looks like a new enquiry, create one?" See §11 for the website-form special case.

### 8.4 The PDF problem solves itself

Thread-latching + PDF retrieval cascade cleanly:

- **Match** (§5.3) gives us the Gmail `thread_id`.
- **Latch** — drafting a reply *into* that thread (correct `In-Reply-To`/`References`) is free once matched.
- **PDF** — if the quote went out from `info@`, the PDF is **already in that sent thread**; pull the original attachment back via the API (`messages.attachments.get`). No regeneration. And if we reply in-thread, the client already has it, so re-attaching is often unnecessary.
- Match fails entirely → plain "checking in on the quote we sent" referencing job/value, no attachment, or flag for manual. No blind firing.

## 9. Phase 2 — AI-drafted chases as Gmail drafts

### 9.1 The mechanism

When a chase comes due (existing `next_chase_date` + `is_chasing` model), and the pre-flight suppression checklist (§10) passes:

1. Claude (Sonnet 5) drafts the email, grounded strictly in retrieved data — quote line items (HH), band/date/service, repeat-client vs first-contact (from hire history), and the actual prior thread text.
2. OP creates it as a **Gmail draft in `info@`, threaded onto the original quote email, PDF retrieved from the thread if needed** (§8.4).
3. Staff see it in the inbox they already work from. One glance, one click to send. No new review-queue UI to build or check.

**Why this is the sweet spot:** the draft lives where staff already are; ~90% of the typing is eliminated; a human reads it before it goes (AI hallucination in a client email is the one intolerable failure, and this neutralises it).

### 9.2 Grounding + guardrails

- Keep the model on a tight leash: it's a "just checking in, any thoughts?" email, NOT a renegotiation. Short, warm, references the quote concretely, tone varies by relationship.
- **Prompt structure lives in code** (the "checking-in not renegotiating" rails, grounding instructions, output constraints). Staff can't break these.
- **"Chase voice" surfaceable setting** — a free-text value in `system_settings` (category `chase`, e.g. `chase_voice_instructions`), edited from the Settings page, **appended** to the code prompt. This is jon's "more of this / less of that" knob, editable without a deploy. (Uses the existing `getSystemSetting()` helper + 60s cache.)
- **Ground on OP structured data, not just the email thread (Jul 2026, live-feedback fix).** The draft cross-references OP's own fields as a sanity layer over the (possibly sparse) email history. First instance: **hire-date proximity drives tone** — `chase-draft.ts` computes `daysUntilStart` from `out_date` and hard-rules the register (a hire days away must NOT read "no rush"; only >1 week away gets the relaxed tone). A live draft for a hire starting *tomorrow* had said "no rush" because the prompt pulled the dates but never reasoned about them. This is the pattern to keep extending — cross-referencing OP data (dates, pipeline status, deposit/payment state, hire history) both grounds the draft and surfaces contradictions worth flagging to staff.

### 9.3 Feedback loops → eventual auto-send

Two loops, both cheap:

1. **Passive** — capture the diff between the AI draft and what staff actually sent (compare draft body vs the sent message body when the draft's thread gets an outbound message). Over weeks the patterns emerge ("always warmer", "always cut the sign-off") and tune the code prompt. Free training signal.
2. **Explicit** — the §9.2 chase-voice setting.

### 9.4 ChaseModal integration

Add an **Auto-chase** control to `ChaseModal.tsx` (set at chase-marking time): **Off / Draft / Auto-send**, per quote. Default **Draft** (or Off for a first rollout). Persist on the job (new column, see §12). This is the graduation dial — start everyone at Draft, let individual quotes graduate to Auto-send once trusted.

## 10. Phase 3 — Opt-in auto-send behind the suppression gate

Once drafts are trusted, allow **real auto-send per-quote, opt-in** (the `Auto-send` ChaseModal option), for low-value/simple hires — **manual judgement per quote, no auto-classification rules for now** (jon's call).

Every auto-chase (draft OR send) runs a pre-flight checklist first. Any hit downgrades an auto-send to a draft + flags staff:

- **Email activity on the thread since the quote went out?** → hold, downgrade to draft, flag. *(The headline suppression — auto-unenroll on reply.)*
- **Pipeline moved** (provisional/confirmed) or **deposit/payment activity**? → cancel the chase (mostly handled by existing chase-date clearing on lifecycle moves).
- **OOO autoresponder detected** (§8) → push the chase past the return date.
- **Last send bounced** (§8) → flag, don't pile on.
- **Hot inbound** — client chasing us (§8) → suppress loudly.
- **Client `Do Not Hire` / on hold** (existing flags) → suppress.
- **Already chased N times with no reply** → escalate to a human ("call them or drop it?"), don't fire chase #4. *(Cold-dead-end recognition — as valuable as the chase itself.)*

An **AI thread-state summary** (§7.1) is itself a suppression signal: "client asked about a second van, we replied, awaiting their confirmation" → not an appropriate moment to chase.

## 11. Website enquiry form (fold into ingestion, don't double up)

Jon's musing: hook the website email/enquiry form so new enquiries land in the OP pipeline with client details matched/extracted — but if enquiries already arrive in `info@`, that would double up.

**Resolution:** recognise enquiry-form emails as a **special class within the `info@` ingestion**, not a separate integration. Form-generated emails have a predictable structure (fixed template, known sender), so extraction is reliable and we can **auto-create a pipeline enquiry with confidence** — a much stronger signal than the fuzzy "unknown sender looks like an enquiry" heuristic in §8.5. Detect by sender address / subject signature, parse the known fields, create the enquiry + `job_contacts`. Folds cleanly into Phase 1's matcher as a recognised source; no double-up.

## 12. Data model sketch (to firm up at build time)

New / extended:

- **`interactions`** — extend with email metadata columns (or a `metadata JSONB`): `gmail_message_id` (unique index — the dedup key), `gmail_thread_id`, `email_from`, `email_to`, `email_subject`, `email_direction` (`inbound`/`outbound`), `has_attachments`. `content` holds the full body.
- **`gmail_sync_state`** — one row per delegated mailbox: `mailbox`, `history_id` cursor, `last_synced_at`.
- **`gmail_unmatched_inbound`** — review queue for messages the matcher couldn't confidently attach (`message_id`, `thread_id`, `from`, `subject`, `snippet`, `received_at`, `resolved_job_id`, `dismissed`).
- **`jobs`** — `auto_chase_mode` (`off`/`draft`/`send`, default `off` or `draft`), `auto_chase_count` (silent-chase counter for cold-dead-end escalation), `last_auto_chase_at`.
- **`system_settings`** — `chase_voice_instructions` (category `chase`).
- **(Phase 4) `job_line_item_history`** — for the dispute audit trail (§7.2). Deferred.

Reuse: `job_contacts` for recipient resolution (a chase goes to the primary contact — same routing rule as §"Per-job contacts"). The email service (`email-service.ts`) is NOT the send path for chases — chases go out as **Gmail drafts/sends via the Gmail API** so they thread correctly and land in `info@`; the branded email-service templates are for transactional client emails, a different artefact.

## 13. Phasing / build order

1. **Phase 1 — Gmail → interactions ingestion.** Domain-wide delegation, poll loop, matcher, dedup, full-body storage, attachment harvesting. Feeds the existing chase model for free. **Valuable standalone** (clean pipeline data, client history, dispute evidence).
2. **Phase 1.5 — Manager mailboxes.** Add delegated users; dedup already handled.
3. **Phase 2 — AI-drafted chases as Gmail drafts.** ChaseModal Off/Draft/Send toggle (default Draft), in-thread drafts, PDF retrieved from thread, chase-voice setting, passive draft-vs-sent diff capture.
4. **Phase 3 — Opt-in auto-send** behind the §10 suppression gate.
5. **Phase 4 — Dispute helper** (NL query over the chain) **+ line-item diff history** for the auto-assembled audit trail. Website-form enquiry auto-create can land here or alongside Phase 1's matcher.
6. **Later** — multi-step cadences, cold-lead escalation surfaces, send-time tuning.

### 13.1 Phase 1 — as built (Jul 2026, PR #919)

Merged to main on `claude/auto-chase-feature-design-tiknf2`. **Everything is inert until `GMAIL_SERVICE_ACCOUNT_JSON` + `GMAIL_DELEGATED_USER` are set** — `isGmailConfigured()` gates the scheduler crons and every endpoint degrades cleanly (`configured: false`). Safe to deploy ahead of the Google config.

**Files:**
- `backend/src/config/gmail.ts` — `isGmailConfigured()`, `getPrimaryMailbox()`, `loadServiceAccountKey()` (**auto-detects inline JSON vs a file PATH** — value starting with `{` is inline, else read from disk), `getGmailAuthClient(mailbox)` (domain-wide-delegation JWT via `google-auth-library`, cached per mailbox, scope `gmail.readonly`, `subject` = impersonated mailbox), `gmailApiGet()`, `getGmailProfile()`.
- `backend/src/services/email-matcher.ts` — `matchEmailToJob()`: deterministic layers only (HH job# in PDF filename → HH job# in subject/body validated against `jobs.hh_job_number` → sender/recipient email → single OPEN job). No match ⇒ unmatched queue. Layer 4 (AI fuzzy) deferred.
- `backend/src/services/gmail-ingestion.ts` — `runIngestionForPrimaryMailbox()` (first run establishes a baseline `historyId` and ingests nothing historic; thereafter incremental via the History API, dedup on RFC822 Message-ID, matched → `interactions` row `type='email'` `created_by=SYSTEM_USER_ID`, unmatched → `gmail_unmatched_inbound`), `getGmailIngestionStatus()`.
- `backend/src/services/email-retention.ts` — `runEmailRetentionSweep()` (strips bodies older than `system_settings.email_retention_months`, default 24; keeps metadata; idempotent via `body_stripped_at`).
- `backend/src/routes/auto-chase.ts` — `GET /status` (admin/manager), `POST /ingest` (admin), `POST /retention-sweep` (admin), `GET /unmatched` (admin/manager). Mounted at `/api/auto-chase`.
- **Migration 157** (`157_gmail_ingestion.sql`) — email metadata + dedup index on `interactions`; `gmail_sync_state`; `gmail_unmatched_inbound`; `jobs.auto_chase_mode/count/last_at`; seeds `chase_voice_instructions` / `email_retention_months` / `auto_chase_max_silent` into `system_settings` (category `chase`).
- **Scheduler** (`config/scheduler.ts`) — ingestion `*/10 * * * *`, retention sweep weekly `0 4 * * 0` (Europe/London), both guarded by `isGmailConfigured()`.
- Dependency: `google-auth-library` (chosen over the heavy `googleapis` package; we hit the Gmail REST API with plain `fetch`).

**Go-live (Google side) — outstanding:**
1. **⚠️ The service-account private key pasted into chat during setup is COMPROMISED — delete that key in GCP and issue a fresh one** (project `op-gmail-ingest`, #395184500010). Domain-wide-delegation consent survives (it's tied to the Client ID, not the key), so only the key needs re-issuing.
2. **Store the JSON as a FILE, not inline in `.env`** — systemd/dotenv can't parse multi-line JSON (`Ignoring invalid environment assignment`). Put it at `/var/www/ooosh-portal/backend/gmail-sa.json` (`chmod 600`), set `GMAIL_SERVICE_ACCOUNT_JSON=/var/www/ooosh-portal/backend/gmail-sa.json` and `GMAIL_DELEGATED_USER=info@oooshtours.co.uk`. `gmail-sa.json` is git-ignored.
3. Test: `GET /api/auto-chase/status` → `configured:true` + profile; `POST /api/auto-chase/ingest` → `baselineEstablished:true`; then email `info@` mentioning a real HH job# and re-run `/ingest` → interaction lands on that job's timeline.

### 13.2 Phase 2 — progress (Jul 2026)

**Slice 1 SHIPPED — AI chase-draft generation + preview.** `services/chase-draft.ts` (`gatherChaseContext()` + `draftChaseEmail()`) drafts the chase with Claude Sonnet 5, forced tool-use, prompt-cached code rails + appended `chase_voice_instructions` (§9.2). `POST /api/auto-chase/preview-draft/:jobId` returns `{ draft: {subject, body}, context }` as JSON **without** touching Gmail — so draft quality is judgeable on real jobs before any Gmail write. Grounds on `jobs.line_items`, repeat-vs-first-contact hire history, prior ingested email thread (degrades gracefully when Phase 1 has ingested nothing yet), and `auto_chase_count`.

**Slice 2 SHIPPED — real Gmail draft creation** (`gmail.compose` scope added by jon Jul 2026). `config/gmail.ts` `getGmailComposeClient` (separate JWT client, ingestion stays read-only) + `createGmailDraft()` (`POST /users/{mailbox}/drafts`, base64url RFC822 + optional `threadId`). `services/gmail-draft.ts` `createChaseDraftForJob()` resolves recipient + thread latch → builds MIME → creates the draft. `POST /api/auto-chase/create-draft/:jobId`. **OP creates drafts only; staff send from Gmail.**

**Thread-latch reality (§8.4 caveat):** we filter our own outbound out of ingestion, so we don't hold the *original sent-quote* thread id. So the common "we quoted, silence, no reply" case creates a **standalone** draft to the job's primary contact; we only latch into a thread once the client has actually replied (that inbound is ingested with a `gmail_thread_id`). Latching onto the sent-quote thread would need a Gmail `messages.list?q=` search step (by job#/client) — a clean future add, not built.

**Slice 3 SHIPPED — manual trigger + tuning surface.** "✨ Draft chase" button in `ChaseModal` (manager-tier) calls `create-draft` and shows recipient + threaded/standalone inline. `ChaseVoiceSettingsSection` on the Settings page edits `chase_voice_instructions` (no deploy). **Grounding fix (INSIDE dates).** Drafts must reference the *actual* hire days, not HireHop's booking envelope. We read OP's `jobs` (synced from HH). Hire START = `job_date` (chargeable start, fallback `out_date`); last hire DAY = `job_end` date **minus 1 when `job_end`'s time-of-day is a morning marker** (`< 12:00 UTC` — Ooosh books `job_end` ~09:00 the morning *after* the last hire day, which is the return, not a hire day). Matches OP's own "N days" figure (Sunny Day = 10th→15th = 6 days, NOT "to the 16th"). Fixes both the 1-day-as-2-day AND the multi-day overstatement. A HARD RULE forbids describing the hire as running to the return date. Code-only — the voice setting can't reach a factual date calc.

**Slice 4 SHIPPED — Gmail search primitive → live latch + cold-start backfill.** `gmailSearchMessageIds()` (readonly) powers both: (i) `create-draft` now searches for the sent-quote thread when the client hasn't replied, so a "silent quote" chase threads into the original conversation; (ii) `services/gmail-backfill.ts` + `POST /api/auto-chase/backfill` (admin, `{limit?,dryRun?}`) — one-off pass over open-pipeline jobs with an HH number: search the mailbox for the job number, pull the matching thread(s), ingest every message onto the KNOWN job (client replies that don't mention the number still land). Idempotent via RFC822 dedup, so safe to run repeatedly a limit at a time. Shared `ingestGmailMessage()` extracted from `processMessage()` (live = matcher; backfill = forced known job).

**Remaining Phase 2 slices:** (a) wire `create-draft` into the 08:00 chase-due trigger for jobs with `auto_chase_mode='draft'` (the scheduler already scans due chases); (b) ChaseModal Off/Draft/Auto-send toggle (§9.4) persisting `auto_chase_mode`; (d) passive draft-vs-sent diff capture (§9.3).

**Cold-start backfill (capstone — jon, Jul 2026).** The baseline ingests nothing historic, so for the first few weeks drafts have no thread context and every latch is standalone. Fix retroactively once (e) exists: a one-off pass over the OPEN pipeline (`new_enquiry`/`quoting`/`paused`/`provisional`/`confirmed`) that, per job, runs the same Gmail `messages.list?q=` search (by HH job number + client email), pulls the matching historical thread(s), and ingests them through the normal matcher/dedup path. Same primitive as (e), run in bulk — gives the whole live pipeline context immediately instead of waiting for organic accumulation. Build after the UI/automation slices land.

## 14. Open decisions (carried into build)

- **Thread-latch vs new email:** confirmed jon prefers latching onto the original quote thread; new-email-with-PDF is second-best. Latching is free once matched (§8.4), so the effort is all in the matcher.
- **Sending identity:** confirm `info@` is the only quoting identity, or whether staff sometimes quote from personal `@oooshtours.co.uk` addresses (affects where §6 looks for threads *and* where drafts should land). Assume `info@`-only for Phase 1/2.
- **Auto-send trust threshold:** manual per-quote for now (no £-value or service-type rules). Revisit if volume justifies rules.
- **Retention window** on `type='email'` interaction bodies — **DECIDED (jon, Jun 2026): 24 months full body, then strip body + keep metadata/summary.** See §5.6. Stored as `system_settings.email_retention_months` (default 24) so it's tunable without a deploy.
- **Cold-dead-end N:** **DECIDED (jon, Jun 2026): 3 silent chases**, then escalate to a human ("call them or drop it?") rather than firing chase #4. Stored as `system_settings.auto_chase_max_silent` (default 3) so it's tunable.
- **Multi-mailbox staleness:** **ACCEPTED as a Phase 1 cost (jon, Jun 2026)** — see §6.1. Draft-not-send is the mitigation; fast manager-mailbox rollout (Phase 1.5) is the fix. No "always CC info@" mandate.
- **Website enquiry From address (Resend):** what From does the website enquiry form actually send with? If `@oooshtours.co.uk`, it's currently caught by the internal-sender filter (harmless now, but must go in `ENQUIRY_SOURCE_ADDRESSES` before Phase 4 enquiry auto-create). If a non-owned domain (e.g. `resend.dev` or the customer's own address), it flows to the unmatched queue already. **Determine before building Phase 4** (or now — jon to confirm).

## 15. What we're explicitly NOT doing

- Not using Zapier (kills the attachment-zip, gains incremental history sync + dedup).
- Not replicating Gmail's Gemini summary via API (impossible — we generate our own, cheaply).
- Not auto-classifying "simple/low-value" for auto-send (manual judgement per quote for now).
- Not blind-firing: no chase without a match + a passed suppression checklist.
- Not sending chases through the branded email-service templates — they go as Gmail drafts/sends so they thread and live in `info@`.
