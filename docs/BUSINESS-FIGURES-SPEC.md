# Business figures — enquiries, conversion and response times

**Status: Steps 1–2 BUILT (Nov 2026). Step 3 (reply speed against booking, properly) waits for ~a month of recording.**
Admin-only, its own tab beside the cash forecast (not on the cash page). Raised by jon
alongside the cash forecast (`CASHFLOW-FORECAST-SPEC.md`), Nov 2026.

## 1. What jon asked for

Enquiry-to-booking conversion, "and some data around that, ie response times by phone and
email vs conversions". Later in the same tab: monthly utilisation by service type and
repeat-client rate (`reference/BACKLOG.md`).

Volume: ~20 enquiries a day out of season, 50+ in peak — 600+ a month, so a month of
recording is enough to read.

## 2. What OP could NOT tell us (Nov 2026 audit) — and why step 1 exists

- **Arrival time.** Only website forms are timed for real (`enquiry-intake.ts` posts
  straight in). Staff-typed enquiries are timed when typed; HireHop-made jobs when the
  30-minute sync saw them (`jobs.created_date` is HireHop's, and it becomes the PUSH time
  for an OP-native job once pushed).
- **Channel.** `jobs.enquiry_source` was optional, hidden under "+ More fields" and never
  editable afterwards — blank on almost everything but `web_form`. The timeline's
  call/email/meeting types are logged contacts, not how the enquiry arrived.
- **Reply time.** Ingested emails were stamped with the time OP PULLED them
  (`interactions.created_at`, `gmail_unmatched_inbound.received_at`), not when sent. A new
  enquiry's first email — and our first reply — usually land in the unmatched queue
  (no job yet), with no direction stored. Phones: nothing from Voipfone; Twilio
  (`call_records`) isn't matched to people or jobs yet (CALL-INTELLIGENCE-SPEC §I-b).
- **Outcome.** The 09:00 auto-loser (`config/scheduler.ts`) wrote `lost_reason = 'No
  Decision'` — the same label staff pick — and no `lost_at`, so a forgotten enquiry read
  as a lost sale. HireHop "Not interested" (webhook) set no `lost_at` either.

## 3. Decisions (jon, 6 Nov 2026)

1. **Record first, report later.** Start recording now so the data exists when the
   joined-up system (Twilio, phone matching) is in place.
2. **"How did they get in touch?" is REQUIRED on New Enquiry** — one tap
   (Phone / Email / Website / Referral / Returning client / Forum / Other), and changeable
   on the job while it's an enquiry (amber when blank — HireHop-made jobs arrive without
   it). The website form sets `web_form`, Leads sets `repeat` / `cold_lead`.
   Labels: `frontend/src/lib/enquirySource.ts`.
3. **Emails are never attached to a new enquiry by guesswork** (the matching rule in
   `.claude/rules/email-and-notifications.md`). Instead the unmatched queue keeps each
   email's real time and direction, and the REPORT works out "this client's first email"
   from the job's contact addresses when it runs. Nothing on a timeline changes.
4. **Auto-lost is its own outcome** — "not followed up", never counted as a lost sale.
   Kept as a flag (`jobs.auto_lost`), so `lost_reason` and the Lost & Cancelled page are
   unchanged. The cash forecast's booking-rate learning still counts it as "didn't book"
   (it didn't).
5. **Time to quote** (enquiry → first `Quote (N).pdf` sent, `job_quote_versions.received_at`,
   the one true sent time OP has) goes in step 2, from history.

## 4. Step 1 — what was built (migration 337)

| What | Where |
|---|---|
| Real sent/received time of every ingested email | `interactions.message_at`, `gmail_unmatched_inbound.message_at` (Gmail `internalDate`), set in `gmail-ingestion.ts`. NULL before Nov 2026 and on hand-logged emails — **no backfill** (the reply-time comparison is forward-looking; `scripts/email-response-times.ts` reads Gmail directly for history if ever needed) |
| Direction of an unmatched email | `gmail_unmatched_inbound.email_direction` ('inbound' / 'outbound') |
| Channel | `jobs.enquiry_source`, required on New Enquiry (`PipelinePage.tsx`), editable on Job Detail (`PATCH /pipeline/:id`) |
| Not followed up | `jobs.auto_lost` (+ `lost_at`) set by the 09:00 sweep; past sweeps backfilled from their "Auto-marked as Lost" timeline notes; cleared when a person marks it lost (`routes/pipeline.ts`) or HireHop says Not interested (`routes/webhooks.ts`, which now stamps `lost_at` too) |

Only info@ queues unmatched mail; manager mailboxes are matched-only (an unmatched
manager email is dropped), so a first reply from a manager's own address before the job
exists is not seen. Known gap, accepted.

## 5. Step 2 — the booking-rate tab (next)

By month of arrival: enquiries in, booked, lost (by reason), not followed up, still open;
booking rate by likelihood, value band, service (vans / backline / rehearsals — from
`job_requirements.requirement_type` / `hh_derived_flags`) and channel (only `web_form`
trustworthy before Nov 2026). Time to quote from history (sweep lost jobs' quotes too —
`quote-versions.ts` only harvests open and confirmed ones).

Counting rules (reuse, don't re-derive): a quote-option group counts once
(`job-groups.ts` `nonLeadMemberIds()`); alternative-quote losses are not losses
(`notAltQuoteLossSql`); dismissed enquiries (`dismissed_at`) never count; re-opens
(`reopened_from_job_id`) and Leads outreach (`cold_lead`) are not arrivals; booked =
`job-outcomes.ts` `JOB_BOOKED_SQL` or cancelled-after-booking. Arrival time = the
earliest of the job's creation and the client's first inbound email (`message_at`)
from a contact address in the days before.

## 5a. Step 2 — what was built (Nov 2026)

**Money › Business figures** (`/money/business`, `pages/BusinessFiguresPage.tsx`), admin only, linked
both ways with the cash forecast. `GET /api/business-figures/enquiries?from=&to=`
(`routes/business-figures.ts`, admin) → `services/business-figures.ts` `buildEnquiryFigures()`;
the counting and timing is pure, in `services/business-figures-maths.ts` (tested).

- **Window:** defaults to the later of 12 months ago and 1 April 2026 (`FIGURES_EARLIEST` — OP came
  into real use around then, jon), to today; any range can be picked.
- **One row per enquiry:** a quote-option group once (its lead; arriving with its first option);
  dismissed, internal, re-opened and `cold_lead` jobs left out; an alternative-quote loss is not an
  enquiry. Arrival = the earlier of OP's `created_at` and HireHop's `created_date`, or the client's
  first email (job timeline, or unmatched to a contact address) up to 3 days before.
- **Outcomes** from `job-outcomes.ts`: booked (confirmed / returned), booked-then-cancelled (counted
  as booked, shown separately), lost (by a person), not followed up (`auto_lost`), open.
  **Booking rate = booked ÷ (booked + lost + not followed up)** — open ones wait.
- **First reply** = office minutes (09:00–18:00 UK, every day — the same hours as
  `scripts/email-response-times.ts`) from first contact to our first email to the client within 30
  days: on the job (any option), or unmatched to one of the job's contact addresses. Real time
  (`message_at`) where recorded, else when OP pulled it in — up to ten minutes late live; backfilled
  emails (`backfill_forced`) are skipped because their pull time is the run date. Replies from info@
  can't be put to a person ("info@ (shared inbox)"); a personal address is named by its user.
- **To quote** = office minutes to the first `Quote (N).pdf` sent (`job_quote_versions.received_at`).
  `scripts/harvest-quote-history.ts --run` searches info@ for every job since April that OP never
  searched (mostly lost ones) — one job a second, safe to re-run.
- **Breakdowns:** month (with booked value), how they got in touch, likelihood, value band, service
  (vans / backline / rehearsals from requirements + HireHop flags; a job can be in several), reply
  speed (under 1 hr / 1–4 hrs / 4 hrs–1 day / over a day), who took it (`manager1_person_id`, else the
  OP creator), who sent the first reply, and lost reasons. Every row shows how many enquiries each
  median rests on.
- **Caveats on the page itself:** channel coverage, how many have a reply / quote found, that
  HireHop-made jobs are dated when keyed in, that a phone call back doesn't show, and that fast
  replies go to easy enquiries (compare within channel or likelihood).

## 6. Step 3 — reply speed against booking (about a month after step 1)

First reply by email (our first outbound to the client after their first inbound, from
`message_at`), against outcome, compared within channel and likelihood — fast replies
also go to the easy enquiries, so a raw "fast = books" chart proves nothing. Phone joins
once the number is ported to Twilio and calls are matched (CALL-INTELLIGENCE-SPEC §I-b);
the useful phone figures are missed calls and call-back time, not "reply time" (a call
answered live has none).
