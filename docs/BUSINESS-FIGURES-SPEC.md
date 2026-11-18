# Business figures — enquiries, conversion and response times

**Status: Steps 1–2 BUILT (Nov 2026). Step 3 (reply speed against booking, properly) waits for ~a month of recording. §7 (where enquiries came from) BUILT; §8 is the agreed marketing roadmap.**
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

## 7. Where enquiries came from — marketing step 1 (BUILT Nov 2026)

jon is expanding marketing in 2027 (print in music listings first, then Google / Meta ads) and wants
one place to see what each effort produces. Two questions, deliberately kept apart:

- **Came in by** (`jobs.enquiry_source`, required on New Enquiry): Phone / Email / Website / In person /
  Other. Referral, Returning client and Forum used to be in this list; they answer the other question,
  so they're no longer offered (old enquiries keep their label). `in_person` is new.
- **Heard about us** (`job_marketing_source.heard_about`): Google search · Google ad · Facebook /
  Instagram · Magazine / print · Recommendation · Used us before · Asked an AI · Saw us at a venue ·
  Other · Didn't ask. Recommendation ("Who recommended us?") and Other ("Where?") take a short note
  (`heard_about_detail`) — the start of referral tracking. **Required on New Enquiry for a NEW client
  only** (jon, 13 Nov 2026 — it was optional, and a returning client was being asked again); "Didn't
  ask" is an answer, so a missed question is recorded as missed and never guessed — Business figures
  counts it with the blanks ("Not asked / not answered"). The form asks `GET /pipeline/returning-client`
  as the client and contacts are picked; not known yet = asked as new. Optional everywhere else (job
  page, website form).
- **What the website saw** (same table, migration 341): the FIRST visit's `utm_*` tags, `gclid`,
  `fbclid`, `ol` (an Ooosh tracked link — coming with the Marketing page), referrer (site + path only,
  never our own site) and landing path; plus `last_touch` when the visit they enquired on carried its
  own tags (so a fresh ad click isn't lost to first-visit credit). Sent by the enquiry form (an iframe
  on oooshtours.co.uk) through its Cloudflare Worker; the parent site stores the first visit only with
  cookie consent, so expect blanks — the dropdown is the safety net. Cleaned and capped in
  `services/marketing-source.ts` (`cleanAttribution()`), read off the raw body so a bad value never
  costs the enquiry (`saveMarketingSource()` never throws). `trackedSource()` turns it into one label.
- **Returning client** is never asked: worked out from history by ONE rule,
  `services/returning-client.ts` — the client organisation OR anyone named on the enquiry as a contact
  had a booked (or booked-then-cancelled) job before it (a tour manager with a new band counts; a lost
  enquiry doesn't). New Enquiry and Business figures both use it (Business figures counted the
  organisation only until 13 Nov 2026).

Where it shows: New Enquiry (two rows of chips), the job page (both selects + "Website: …"),
`GET /api/pipeline/:id/marketing-source`, and Business figures ("Where they heard about us", "What the
website saw", "New or returning clients").

The website half lives in the enquiry form's own repo (a separate Claude, Nov 2026): the parent-site
snippet (site-wide header, put in by webboutiques), the form reading the tags from its iframe URL, the
optional dropdown, and the Worker passing `attribution`, `attribution_last`, `heard_about`,
`heard_about_detail` through.

## 8. The marketing roadmap

### 8a. Marketing page — step 2 (BUILT Nov 2026, migration 342)

Jobs › Marketing (`/jobs/marketing`). Built admin-only; **since 18 Nov 2026 (jon) the page is open to every
staff login for the Content tab (§8e), and Adverts, Tracked links, Review emails and Referrals are manager-tier**
(`/api/marketing` and the two `/overview` routes take `MANAGER_ROLES`). Turning the review / referral emails on or
off, "Send me a test" and the referral offer stay admin-only.

- **Adverts** (`marketing_placements`): name, type (print / online / social / search ads / event /
  sponsorship / other), who with, cost, runs from–until, status (planned / live / ended / cancelled —
  never deleted), next thing due + what's due, proof received date, artwork link (the file stays in
  Google Drive), notes. **The "next thing due" is a To Do** for whoever saved it
  (`source_type = 'marketing_placement'`, `services/marketing.ts` `syncDueReminder()`): one open reminder
  per advert, replaced when the date / note / name changes, cancelled when the date is cleared or the
  advert ends or is cancelled. Never fails the save.
- **Tracked links** (`marketing_links`): `go.oooshtours.co.uk/<code>` (also `/api/go/<code>`,
  `routes/go.ts`, public, 60 a minute per address). **The code never changes once made** — it's printed;
  the destination can, even after printing. A paused, unknown or broken code goes to the home page — a
  printed code never dead-ends. A scan is stored as time + rough device only (`marketing_link_scans`, no
  address, no cookie); link previews and crawlers (WhatsApp, Facebook, empty user agent…) are kept as
  `bot` and not counted. **QR** per link as SVG (for print) and a 1200px PNG — **with the Ooosh record
  in the middle** by default (jon, 13 Nov 2026): error correction H, the record drawn as shapes on a
  white square of whole modules ~27% across (~7% of the area; `marketing-links.ts` `withCentreLogo()`),
  checked by decoding renders at 110–800px. "With the Ooosh logo" untick gives the plain code (M) for
  very small print. The PNG is drawn by the browser (no image library on the server). Print at least
  2.5 cm with the logo (3 cm for a code over 30 characters — a long code makes a denser QR).
- **Forwarding** (`services/marketing-links.ts`, pure, tested): on our own site the link adds
  `utm_source` (the link's, else the advert's "who with" as a slug, else `ooosh-link`), `utm_medium`
  (the link's, else the advert's type, else `qr`), `utm_campaign=<code>` and `ol=<code>` — never
  overwriting tags already in the destination. Any other site (e.g. the Google review box) gets the
  address as it is, so only the scan is counted.
- **What each advert brought in**: scans → enquiries → booked (+ value) → cost per enquiry / booking.
  An enquiry counts for a link when its `job_marketing_source.link_code` **or** `utm_campaign` is the
  link's code (the enquiry form hands both back); outcomes use `job-outcomes.ts`. Someone who saw the
  advert and phoned is NOT counted here — they show under "Heard about us: Magazine / print" on
  Business figures.
- **Server (by hand, once the DNS record exists)** — a second nginx server block in
  `/etc/nginx/sites-available/default` (reference copy at the end of `deploy/nginx-ooosh-portal.conf`),
  then `certbot --nginx -d go.oooshtours.co.uk`. Until then the links work as
  `https://staff.oooshtours.co.uk/api/go/<code>`; don't print anything until `go.` answers.
- Tip for print: a QR that lands straight on a page with the form survives no-consent visitors best
  (the cookie banner can't strip `ol`).

### 8b. Next — agreed in outline, not built

- **Review requests** — BUILT, §8c below. Still to do by hand: QR posters to the review box around
  the building (rehearsal rooms, the back of the loo door — a tracked link on the Marketing page whose
  destination is the review box counts the scans) and postcards.
- **Referrals** — BUILT, §8d below, with real vouchers since 17 Nov (GOODWILL-CREDIT-SPEC §16). Still to do:
  the van / kit-case postcards (§8d, "Cards") — parked, in `docs/reference/BACKLOG.md`.
- **Content library** — BUILT with the social media planner, §8e. Still to do: the studio sitters sending
  their photos / videos in from the portal (§8e "Next").

### 8c. Jon's review request email (BUILT 13 Nov 2026, migration 344)

**Off until jon turns it on** — Marketing › Review emails (`system_settings.review_requests_enabled`).
Production sends every template for real, so that switch is the only guard. The tab also has "Send me a
test" (the real email to the person pressing it, subject "[Test] …", greeting as the most recent
completed job's client would see it; writes no row) and the last 50 jobs: sent, or why not.

- **When:** daily 10:15 UK (`config/scheduler.ts`), for hires whose status went to Completed the day
  before (UK date of `jobs.pipeline_status_changed_at` — every path to Completed stamps it). It looks back
  3 days so a missed run catches up, and never further: switching it on emails at most ~3 days of hires.
- **Not sent** (a `not_sent` row with the reason, `services/review-requests.ts` `reviewDecision()`):
  completed more than **10 days** after the return (`return_date`, else `job_end` — jon's call, 13 Nov
  2026: a long close-out usually means a claim; he knows Google frowns on asking selectively); no return
  date; internal job; no client email (the resolver fell back to info@); the address used "Don't ask me
  again"; the client **organisation or the address** was sent one in the last **365 days** (two jobs for
  one client in one run send once).
- **"Don't send":** the **Completion modal**'s "Send Jon's review email tomorrow" tick (moved there from the
  job header, jon 16 Nov 2026 — the header was busy). Saved with the status change (`send_review_email`
  on `PATCH /pipeline/:id/status` → `setJobReviewSkip()`); unticked = a `skipped` row, ticked removes one.
  Hidden on an internal job or once one was sent; a sent email is never undone. A job completed in
  HireHop has no modal, so it sends. What happened lands on the job's Activity Timeline — "sent to …" or
  "not sent: <reason>" — and on Marketing › Review emails.
- **Who:** `resolveClientEmailTarget(jobId, 'review_request')` — the PRIMARY only, never the CCs. Greeting
  = the resolver's name for the primary; none (an org mailbox) → "Hi there," and the subject "How did it
  go?" — never a placeholder. From **"Jon at Ooosh Tours"** on the usual sending address,
  **Reply-To jon@oooshtours.co.uk** (`SendEmailOptions.fromName` / `replyTo`, new in `email-service.ts`).
  The job number is in the small print, not the subject (a personal note).
- **One row per job** (`review_requests`, UNIQUE job), written BEFORE the send; a failed send becomes
  `not_sent` "Email failed: …" and is never retried. The job timeline gets "Jon's review request email
  sent to …".
- **Links:** the review box through the tracked link **go.oooshtours.co.uk/google-review** (migration 346
  makes it, `REVIEW_LINK_CODE`), so its clicks show on Tracked links — read them as "up to", mail scanners
  that open links count unless they say they're a bot. Pausing that link sends the button to the home page; the Mailchimp form with their email, first and last
  name filled in (`mailingListUrl()` — the classic form, `legacy_form=1`, which fills MERGE0/1/2 from the
  link; checked 13 Nov 2026 — it's still one press of Subscribe, so Mailchimp keeps their consent); and
  **"Don't ask me again"** → `/api/review-requests/stop?t=…` (token audience `review_optout`, 2 years),
  a page with a **button** — never on the click alone, because mail scanners open every link in an email.
  Opt-outs are by address (`review_request_optouts`) and stop only this email.
- The referral line ("ask them to mention your name") feeds New Enquiry's "Recommendation → who?" until
  the referral scheme exists.

### 8d. The referral scheme (BUILT 17 Nov 2026, migration 347)

Decisions (jon, 16–17 Nov 2026): **a referral belongs to a PERSON, never a band**; the thank-you is due
when the friend's hire is **Completed** (never on booking — no rewarding a booking that then cancels); a
**person** sends it, nothing is automatic; **the friend gets something too** — the welcome credit — and only
a genuinely new client counts, **once** (no stacking); a code shared widely is fine (jon: let it spread).
Offers are plain text jon rotates; each referral keeps the offer that was live.

- **Personal links** (`referral_links`, one per person, the code never changes): `go.oooshtours.co.uk/r/<code>`
  (`routes/go.ts` → `services/referrals.ts` `resolveReferralScan()`), counted like a tracked link (previews and
  crawlers not), forwarded to the website's enquiry page **oooshtours.co.uk/contact** (jon, 17 Nov 2026 — straight onto
  the form, so the tag doesn't depend on cookie consent) tagged `ol=ref-<code>`. Codes are the first name + four characters
  without 0/o/1/l/i (`referral-rules.ts`). Made automatically for the client in Jon's review email; "Make a
  referral link" on a person's page for anyone else. Marketing codes may not start `ref-`.
- **How a referral is recorded** (`referrals`, one per job):
  - the website enquiry came through a personal link — `routes/enquiry-intake.ts` →
    `referralFromMarketingSource()` reads `ol` from the visit they enquired on, else the first visit;
  - staff: **"Referred by"** on the job — in the enquiry row (amber when "Heard about us" is Recommendation),
    and under Details & Notes once booked — pick the person, "They named them" or "Referral card".
  `referralBlockReason()` is every rule: not internal; not the referrer's own booking (a contact on it, or a
  member of its client org); a NEW client by `returning-client.ts` at the time the enquiry arrived; and not
  already referred (same client org or a shared contact). The link path skips quietly; staff see the reason.
- **Both rewards are VOUCHERS** (`GOODWILL-CREDIT-SPEC.md` §16–17, source `'referral'`), amounts **inc VAT** on the
  offer (`referral_offers.friend_voucher_inc_vat` / `referrer_voucher_inc_vat`, mig 349 — the old
  `friend_credit_ex_vat` is no longer read), and **both are automatic** (jon, 18 Nov 2026 — they replaced a manager's
  "Give the voucher" and an admin's "Thank-you given…"):
  - **The friend's welcome voucher** is made the moment a referral is linked (link or "Referred by"), for the job's
    band / client and held for their enquiry; while the referral emails are on, `referral_welcome_voucher` goes to the
    job's client (`resolveClientEmailTarget()`, never info@) in Jon's words: "Hi {name}, thanks for getting in touch -
    {Sam} recommended us! As a welcome, there's a £20 voucher waiting for you, already set against your hire (on
    bookings over £100). Your voucher code is K7QM-4XWP-C9TR, valid until {date}. Any questions, just reply to this
    email. Jon". Once (`welcome_email_sent_at`, un-stamped if the send fails); "Email them the code" on the job sends
    it by hand. "Over £100" is staff's check, never OP's. **Taking the referral off (✕), or declining it, withdraws
    an unused welcome voucher.** "Give the £20 voucher" stays on the job only for a referral linked before the offer
    had an amount.
  - **The referrer's thank-you voucher** is made when the friend's hire is **Completed** — at once on OP's Completed
    (`routes/pipeline.ts` → `rewardReferralForJob()`); the 10:20 run (`runReferralRewardsDue()`) catches a completion
    from HireHop or a missed one. `rewardReferral()` claims the referral first (→ `rewarded`), makes the voucher for
    the referrer person (`reward_credit_id`), and — while the emails are on — sends email 3 with its code; the timeline
    says whether it was emailed. If the voucher can't be made the claim is undone and the next run tries again. No To
    Do, no thank-you window; a manager **Declines** a referral that shouldn't count (Marketing › Referrals). Before then
    a referral reads its stage off the job (Enquired / Booked / Didn't book) — never stored.
- **Emails**, from "Jon at Ooosh Tours", replies to jon@, never naming the friend:
  - the review email's referral line becomes their own link + the offer (jon, 18 Nov 2026): "Know a band who needs
    vans, backline or rehearsal space? Send them your unique link - go.oooshtours.co.uk/r/sam-7k2p - and they'll get
    a £20 discount voucher off their first hire worth over £100. If they book, we'll send *you* a £20 discount voucher
    for shop sales or hires too, to say thanks." ("you" in italics; no person → "mention your name");
  - **email 2** `referral_enquiry_thanks` — "someone you recommended has just been in touch with us!", once per
    referral, only while the friend's job is still an enquiry, **OFF until Marketing › Referrals turns it on**
    (`referral_emails_enabled`). It promises "We'll keep you updated if they confirm and complete a booking";
  - **email 2b** `referral_booked` — "Good news - the person you recommended has booked with us! Once their hire is
    done, we'll send you {reward} as promised." Daily 10:20, once per referral (`booked_email_sent_at`, mig 348),
    while the job is booked and not finished; same switch as email 2;
  - **email 3** `referral_reward_thanks` — the thank-you itself, sent automatically when the friend's hire is Completed, ending with
    their referral link and "You can use the same link as many times as you like!". "Here's a little thank-you:
    {what they got}", then, with a voucher: "Your voucher code is H3MU-ZXCB-86TU - £20 off a hire with us or in
    our shop, valid until 17th Nov 2027. It's single use, so just quote the code when you book or pay."
  Wording agreed with jon, 17 Nov 2026 (plain dashes). "Send me a test" sends all four (2, 2b, 3 and the friend's
  welcome, with sample codes) to the person pressing it.
- **Cards** (not built — jon, later): one QR per card design (a tracked link, e.g. `van-card`) plus a
  "Recommended by: ______" line the client fills in; the friend's form "Who recommended us?" catches the name and
  staff link it with "Referred by" → "Referral card". Unique per-card codes were rejected (somebody would have to
  record which card went in which van).

### 8e. The social media planner — Marketing › Content (BUILT 18 Nov 2026, migration 351)

jon, 17–18 Nov 2026. **OP plans; Meta Business Suite schedules and posts** (OP can't post to Meta without an app
review). Mostly Matt's; **every staff login** sees it (the other Marketing tabs are manager-tier, §8a). All logic in
`services/marketing-content.ts`, routes `routes/marketing-content.ts` (`/api/marketing-content`, `STAFF_ROLES`),
screens `frontend/src/components/marketing/` (`ContentPlanner.tsx`, `PostEditor.tsx`, words and colours
`contentCopy.ts`).

- **A post** (`marketing_posts`) is one entry with its channels ticked (Instagram, Facebook, Newsletter, Blog — IG + FB
  are usually the same post): name, goes-out date and time (UK; stored as `publish_at`, default 18:00; **no date = an
  idea**), format (Reel / carousel / image / story / video / text post / newsletter issue / blog article — the editor
  offers the ones that fit the channels), caption with the call to action (Instagram's 2,200 counted), hashtags and
  mentions (counted; Instagram allows 30), a theme (free text, suggestions from the themes used before), status, owner
  (assignable staff, stored as their person), the band / job / credited person, a **tracked link** for the call to
  action (picked from Marketing › Tracked links, `GET /marketing-content/links` — so staff can pick one without seeing
  the Links tab), the live post link once it's up, notes, and its content. **Never deleted** — "Drop it" sets
  `dropped` (off the calendar, board and ideas).
- **Statuses:** Idea → In progress → Review → Approved → Scheduled (in Meta) → Published, plus Dropped. A new post with a
  date starts In progress, without one Idea. Moving a card on the board is a status change.
- **The owner's To Do:** two days before a post goes out (from `REMIND_DAYS_BEFORE` days ahead to the day itself), if it is
  still Idea / In progress / Review, its owner gets ONE To Do — "Get it approved: "…" goes out Thu 19 Nov at 19:30", due
  today, `source_type = 'marketing_post'`, linking to `/jobs/marketing?tab=content&post=<id>` (opens the post). It's
  re-checked on every save and daily at **09:16** (`runPostReminders()`): cancelled once the post is approved /
  scheduled / published / dropped, moved further out, made an idea, its owner changes (the new owner gets it), or its
  day has gone by. Never fails a save.
- **The content library** (`marketing_assets`): photos, videos and graphics as **Google Drive links** (the files stay in
  the shared Drive; `https://` only), with a kind, notes, the band / job / who took it, who added it and how many posts
  use it. Archived, never deleted. A post's content is `marketing_post_assets`; a Drive link added from a post carries
  the post's band / job / credit. `source` is `staff` or `sitter` (the sitter intake, below; shown as "from a sitter").
- **Saved hashtag sets** (`marketing_hashtag_sets`, a name + the tags; same name replaces) — "Add a saved set" appends
  one to the post, "Save these as a set" saves the post's.
- **Views:** a month calendar (Monday first, UK days, click a day to plan a post on it), a board by status (published
  posts leave it after 30 days), the ideas (no date) and the content library. "Copy for Meta" puts the caption and
  hashtags on the clipboard. The view is remembered per browser.
- **On a phone** (under 640px, `hooks/useIsPhone.ts`; jon, 18 Nov 2026 — "it'll be used on a mobile a fair bit"): the
  calendar is **Coming up** — a week at a time, a row per day (today marked, empty days one line with a "+"), ‹ › step
  a week, "Show the week after too" adds the next week below, and each post card has its own "Copy for Meta". The board
  is one status at a time (pills with counts). The library is a list. The post editor fills the screen with **Save,
  Close and Copy for Meta pinned to the bottom** (pinned on a laptop too); owner, theme, band, job, credit, tracked
  link, live link, notes and "Drop it" fold under **More details**, which says what's filled in while closed. "+ New"
  is a round button in the corner. Same data and routes as the laptop — layout only.
- **Not built, on purpose:** reach / likes typed in (jon: the tracked links show the enquiries, which is what counts),
  posting or scheduling from OP, file uploads (Drive holds the files).

**Next (agreed in outline, jon 18 Nov 2026):** the studio sitters make a lot of the content — let them send photos /
videos in from the portal (a Drive link or an upload, with a line on what it is), landing in the library as
`source = 'sitter'` with `added_by_person_id`. The table already carries both columns.

