---
paths:
  - "backend/src/services/{email-service,email-routing,email-matcher,email-retention,money-emails,vehicle-emails,vehicle-notify,portal-notification-prefs,notification-escalation,referral-alert,condition-report-email,confirmation-hooks,sanity-check-scanner,post-hook-recovery,gmail-*,chase-*,comms-*,remittance}.ts"
  - "backend/src/services/email-templates/**"
  - "backend/src/routes/{email,notifications,interactions,auto-chase,portal}.ts"
  - "backend/src/config/{gmail,scheduler}.ts"
  - "frontend/src/components/{ActivityTimeline,NotificationBell,JobContactsCard,FileEmailModal}.tsx"
  - "frontend/src/components/messaging/**"
---

# Email, notifications & comms — load-bearing rules

Full template registry, incident history and messaging spec pointers:
`docs/reference/SHARED-UTILITIES.md` and `docs/reference/INBOX-AND-WAREHOUSE.md`.

## Sending

- **ALL outbound email goes through `emailService`. Never `nodemailer.createTransport` outside `email-service.ts`.** There is exactly one transport (a pool, `maxConnections: 1`); a direct call silently misses pooling, retry, the audit log and the outage canary. Attachment sends use `sendRaw({ ..., attachments, skipLayout: true })`.
- **Pooling is the fix, retry is the mop-up.** A non-pooled transport opens a fresh authenticated connection per send, so a burst becomes a concurrent-AUTH storm and Gmail randomly `535`s the surplus — with valid credentials. Retry treats `535` as transient on the deliberate assumption the app password is good.
- **`emailService.send()` RESOLVES `{ success: false }` on a delivery failure — it does not throw.** A caller that only wraps it in try/catch will sail past a dead SMTP server and stamp whatever "we told them" column it owns, so the record says somebody was asked when nobody was. Always branch on `result.success`. (Caught in §9.4 before it shipped; `offer_email_sent_at` would have lied.)
- **Subjects are forced onto one line — `oneLineSubject()` in `send()` / `sendRaw()`. Never remove it or bypass it.** Subjects get built from staff-typed text (issue summaries, bell titles via the escalation emailer), which can contain line breaks. Resend rejects any email with `\n` in the subject (422) and the email is simply lost — Gmail SMTP used to fold it silently, so this only bit after the Resend switch (RF21PWX, Jul + Sep 2026). Fix it centrally there, not per caller.
- **The outage canary must NOT travel over the failing channel.** When a send fails after all retries it writes an **admin bell** (`email_sent_at` pre-stamped so the escalator never tries to email it), deduped hourly.
- **When a bell and a direct email fire for the same event, set `email_sent_at = NOW()` on the bell** — the escalation scheduler skips notifications that already have it, so the recipient doesn't get the same content twice.

## Templates

- **Production is `EMAIL_MODE=live` (via Resend) and has been since mid-2026.** Every registered template sends for real to the real recipient — `EMAIL_LIVE_TEMPLATES` is the test-mode allowlist and is **ignored entirely** when the mode is live, so a new template needs nothing added to it. Don't tell anyone to add one, and don't hedge a new email behind "it'll test-redirect until released" — it won't. Feature specs saying a template "ships OFF `EMAIL_LIVE_TEMPLATES`" describe a rollout that predates go-live.
- Variables are **HTML-escaped** — a `{{var}}` can't inject markup.
- **There is NO `{{else}}`.** Only `{{#if var}}…{{/if}}`. An `{{else}}` is not
  parsed — the whole block including the literal word renders when the variable
  is truthy, and vanishes when it is not. A two-way conditional is two FLAT
  blocks with complementary flags (`isChase` / `isFirstOffer`), and the caller
  derives the second so they cannot contradict each other.
- **`{{#if}}` is single-level only — NEVER nest.** The substituter's non-greedy regex matches to the FIRST `{{/if}}`, leaving literal `{{/if}}` / `{{#if}}` artifacts in the sent email. Render an image and its caption as two separate top-level blocks.
- **Every job-scoped template carries the HH job number in BOTH subject and body.** It's the thread that ties an email back to the job without clicking through. Callers pass `jobNumber: String(job.hh_job_number || '')` — an empty string degrades gracefully; omitting it renders the literal placeholder. Doesn't apply to auth flows, vehicle-scoped or non-job system alerts.

## How to greet somebody — `services/display-name.ts`

`greetingName(row)` for "Hi Will", `fullDisplayName(row)` for "Will Parish".
Never `row.first_name || 'there'`: `people.preferred_name` is what they asked to
be called, and it has been on the freelancer application form since migration
184 — we ask the question, so use the answer.

Set from **two** places, both writing the same `people.preferred_name`: the
person record ("Likes to be known as", `PersonForm`) and the staff Employment
card. One column, so they cannot disagree; each follows the same rule — absent
key leaves it alone, empty clears it to NULL.

**SELECT `preferred_name` in the query.** A row that never fetched it falls
straight through to the legal name and nothing errors, which is exactly how
this stayed broken: the helper cannot tell "not set" from "not fetched".

**Not for anything legal or financial** — payroll, the hire agreement,
right-to-work records and carnets want the passport name and build it
themselves. Client greetings are a different question again and belong to
`resolveClientEmailTarget`.

## Who receives a client email

Resolution order, and it is the single source of truth:

```
0. email_routing override (per-bucket, only when the sender passes a templateId)
1. job_contacts            ← primary = to, rest = CC. REPLACES org-level when non-empty.
2. person_organisation_roles via client_id / job_organisations
3. organisations.email
4. people name-match on jobs.client_name
5. info@oooshtours.co.uk   ← safety net, amber banner injected + timeline interaction logged
```

- **Never write a parallel recipient path.** Route through `resolveClientEmailTarget` / `getJobEmailRecipients`. A fresh `SELECT email FROM organisations WHERE id = client_id` bypasses the whole rule — that's how several senders drifted and silently dropped mail on sole-trader jobs.
- **`job_contacts` rows are detected FIRST, regardless of whether they have an email.** If rows exist but none are reachable, skip steps 2–4 and land on info@. Filtering emailless contacts inside the query made "primary has no email" indistinguishable from "no contacts picked" and sprayed the whole org.
- **Any NEW client-facing template should pass its `templateId`** so per-bucket routing overrides apply; add it to `TEMPLATE_BUCKETS` if it belongs to a bucket. Internal/staff/freelancer templates are deliberately unbucketed.
- **`has_client_email` (the Job Detail banner) mirrors the same order** — keep it in sync with `getJobEmailRecipients` or the warning contradicts send behaviour.

## Portal notifications — two classes

- **Informational** (new allocation, date/time/venue change) → **must call `shouldSuppressInformational()`** before sending; respects global and per-job mute.
- **Accountability** (completion chaser ladder, staff escalation) → **must NOT** call it; these bypass mute by design. The shared staff account keeps mute on permanently, and "you haven't marked the job complete" still has to land.

## Vehicle alerts

- **Use `getVehicleNotificationTargets()`** — never revert to `WHERE role IN ('admin','manager')`. That fanned one referral out to five staff who don't look after vehicles, each escalating to email after an hour.

## Deferred warning scanners

Warning emails that used to fire inline follow one shape (`services/sanity-check-scanner.ts`):

1. The triggering action sends nothing — it just does its work.
2. A 15-minute scanner finds candidates that have been in the concerning state past a **grace window** (long enough for background sync / desk-side action to land).
3. **Stamp the dedup marker FIRST, then send.** A transient send failure must not cause the next sweep to re-fire; duplicate emails on every scan is the spam pattern being eliminated.
4. **Clear the marker on transition out** of the state so a re-entry can warn afresh.

Adding a scanner: copy the shape, add a marker column, wire the clear into every status-write path. **Don't put the send back inline "just for the urgent case"** — the spam always comes back.

## Timelines & threads

- **Scoping guards are load-bearing:** entity timeline reads filter `issue_id IS NULL` / `shift_id IS NULL`. Issue chatter and shift handovers must NOT bubble onto the linked vehicle / driver / organisation timelines.
- **Mention emails fire at CREATION time**, not via the escalator — mentions get marked read within seconds when the user glances at the bell, so the escalator's `is_read = false` filter skipped them and no email ever fired. Stamp `email_sent_at` so it doesn't double-fire later.
- Reactions deliberately fire **no** notifications — that's the point of the "I saw it" pattern.

## Auto-chase (Gmail ingestion)

- **Never guess-attach an email to a job.** Matching is deterministic only; no match goes to the review queue. A bare digit coincidence is not a match — an explicit `#N` / `job N` / `quote N` prefix or a `Quote (N)` PDF filename is required (personal eBay threads once polluted a job timeline).
- **Keep genuine staff→client outbound, skip internal↔internal and our own system sender.** Skipping all own-domain mail also dropped our quotes and replies, leaving the summary and chase draft blind to "we sent five quotes".
- **Ground chase drafts in the INSIDE hire dates** — a hire to the 15th shows `job_end` as the 16th at 09:00; the 16th is the RETURN, not a hire day.
- Any `extractDocument` caller whose output can be long (list extraction) needs an explicit `maxTokens` — the 1024 default truncates JSON mid-array and surfaces as a parse error.
- **Thread-anchoring: a reply inherits its thread's anchor job.** In `gmail-ingestion.ts`, once a thread's first message strong-matches a job, later messages inherit it UNLESS they carry their OWN strong evidence for a *different* job — a `Quote (N)` PDF or an explicit job number in the **SUBJECT**. A job number in the **BODY does NOT override the anchor** (bodies reference other/past hires in passing — that's the drift). Persist `match_method`/`match_confidence` on every ingested email (the matcher computes them; don't discard them).
- **Hidden AND detached ingested emails must be excluded from EVERY AI read.** `hidden_at IS NOT NULL` (confidentiality) → dropped from `comms-summary` + `comms-query` **always** (never feed private content to the summary/dispute AI, even for admin) and from the job timeline for non-admins (admin still sees it — hide preserves the record). `detached_at IS NOT NULL` ("Not this job") is a **tombstone** — the email stays on the timeline as a greyed re-attachable row but is excluded from the AI reads too. Hide is **admin-only**; detach/reattach/move is STAFF_ROLES. Route all through `/api/auto-chase/emails/:id/*`; don't add a parallel path. Move-to-job searches `/hirehop/jobs?search=` (matches job number or name).
- **Manager mailboxes are matched-only; info@ is full.** Multi-mailbox ingestion runs via `runIngestionForAllMailboxes()`; the list is `system_settings.gmail_manager_mailboxes` (admin-only Settings, no deploy). A manager mailbox passes `queueUnmatched:false` — a no-match email is dropped, NOT parked in `gmail_unmatched_inbound`, so a manager's/director's non-job mail never surfaces. Only info@ queues unmatched. Any new mailbox goes through `getManagerMailboxes()` (own-domain only) — never ingest an arbitrary address.
- **Chase-draft TONE needs work before auto-send is turned on (jon, Sep 2026).** Drafts currently read "too AI / too American". Auto-send (`auto_chase_send_enabled`) is deliberately OFF — the module only drafts. Getting the tone to Ooosh's British, understated voice is a dedicated iterative round (tighten the code SYSTEM_PROMPT in `chase-draft.ts`, lean on `chase_voice_instructions` + `learnChaseVoice`, review real drafts with jon) and must land BEFORE Phase 3 suppression + flipping the switch. Full handover: spec §13.6.

## Background work

- **Wrap `setImmediate` post-response work in `runHookWithRecovery`** (retry with backoff, then a loud bell + info@ alert). **Every wrapped hook MUST be idempotent** — it will be retried.
