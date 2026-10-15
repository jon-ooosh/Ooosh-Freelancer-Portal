# AI Quoting — Claude drafts the quote (PRE-SPEC, PARKED)

**Status (15 Oct 2026): PARKED.** Findings and settled decisions only; nothing is built.
Parked until the building blocks in §6 exist — the module is only as good as the house
knowledge it can read, and most of that is not written down yet.

Not to be confused with **quote versions** (the quote-PDF diff on the Activity Timeline,
`AUTO-CHASE-SPEC.md` §7.3) or **options** (alternative quotes as a group of jobs,
`QUOTE-VERSIONS-SPEC.md`). This module USES options; it does not replace either.

## 1. What it is

Claude reads a client's request (an email, the website enquiry form, later a PDF spec),
works out what they want, builds the quote on the HireHop job, and drafts the reply in
the house voice. A person checks it and sends it.

It follows directly on from the auto-responder voice / chase-tone work
(`AUTO-CHASE-SPEC.md` §13.6) — the reply half of this module is that voice.

## 2. Settled so far

- **A person sends every quote.** Phase 1 is never hands-off. The reply is a Gmail draft
  in the client's own thread (as AI chase drafts already are); the staffer checks the
  HireHop lines, attaches the quote PDF and sends.
- **HireHop's quote document stays THE quote.** It carries the payment-portal link
  (`payment-portal-link.ts`) and our T&Cs. OP does not make its own quote PDF — a second
  copy of the document would drift (decision deferred, not ruled out forever: §4).
- **Vans first.** Self-drive vans are the simple case — what the client wants is usually
  obvious. Backline (substitutes, availability, PDF specs) comes later.
- **Alternatives are options.** "Basic and Premium over the same dates" or "ending the
  15th vs the 19th" is an option group (`services/job-groups.ts`, `job_duplicate.php`),
  never one job with both on it.
- **Recorded in OP.** What Claude understood, what it proposed, what it asked, and what
  was actually sent all land on the job.

## 3. The quote PDF — what we found (14–15 Oct 2026)

**Short version: HireHop will not let us generate the PDF from OP.** A person downloads it.

- The browser fetches it with
  `GET /modules/docmaker/merge-pdf-CHROMIUM.php?main_id=<job>&type=1&sub_id=0&sub_type=16&doc=28&local=<YYYY-MM-DD HH:MM:SS>&tz=Europe/London&format=pdf&stn=0&or=0&ps=a4&nums=0&engine=1`,
  preceded by `doc_list.php?type=1&sub_type=16&depot=1&…` (the template list). `doc=28`
  is our Quote template. The response is the file, `Quote (<job>).pdf`, rendered
  server-side by HireHop (headless Chromium). Auth in the browser is session cookies only.
- With `&token=<API token>` it returns **500, empty body** — with no token it redirects
  to `/logout.php`, so the token passes the login check and the script then fails. Same
  with minimal params, `format=html` and `engine=0`. `doc_list.php` rejects the token
  outright ("login again [1212]").
- **HireHop support, 15 Oct 2026: "we don't allow external use of our document
  generator, even via the API, as it could be open to abuse."**
- **Do not work around this** (e.g. using HireHop's Email button to send the quote to
  ourselves and harvesting the attachment, or logging in as a staff user). It is the
  same generator by a side door, and the API token it would put at risk also carries the
  payment portal, sync, close-out and the shop.
- **Asked, awaiting an answer (15 Oct):** (a) may HireHop's own "email document"
  function be triggered via the API, sending to the client; (b) is HireHop's client-facing
  online quote viewer (the "Share" option off the print menu) reachable via the API, so
  the email could carry a link instead of an attachment. Record the answer here.

## 4. Phase 1 working method

1. A request arrives (email into ingestion, or `POST /api/enquiry-intake`).
2. Claude proposes: van type(s), dates/times, options, anything missing.
3. Where something is missing it drafts a question instead of a quote.
4. On a staffer's say-so the lines go onto the HireHop job (option group if more than one).
5. Claude drafts the reply as a Gmail draft in the client's thread.
6. The staffer opens the job's quote in HireHop (OP gives a one-click link), checks it,
   downloads the PDF, attaches, sends.

If the manual PDF step later proves to be the bottleneck: a link to HireHop's online
quote viewer (if §3(b) comes back yes), a quote summary in the email body plus the
payment link, or — last — an OP-made document built from HireHop's live lines.

## 5. Decisions (jon, 15 Oct 2026)

1. **Manual, admin-only to start.** A "Draft quote" button, used by admins while it is
   tuned; staff get it later. Automatic on every enquiry is the long-term goal.
2. **Built onto incoming enquiries.** OP links email threads to a job by its HireHop job
   number, so before a HireHop job exists there is no thread in OP to work from. The
   website enquiry (`POST /api/enquiry-intake`) already has dates, a contact and the
   client's own words — that is the starting point. Claude's proposal lives in OP; the
   HireHop job is created only when a person accepts it.
3. **HireHop's rate card sets the price.** Vans and rehearsals are rarely discounted.
   Backline and staging usually get a deal beyond a couple of days — not written down
   yet (§6).
4. **HireHop is the truth for availability.**
5. **The minimum to quote a van:** dates, van type, collection or delivery, UK or abroad,
   drivers. Times default to 9am–9am (our van pricing). The reply is our Gmail T&Cs
   template in the body with the quote attached.

Still open: learning from past enquiry → quote pairs (`job_quote_versions` holds the
extracted lines of every quote PDF we sent), and measuring Claude's proposal against
what was actually sent.

## 6. Building blocks first (why this is parked)

What a good reply needs, and where it lives today:

- **How we quote and talk to clients** — what is safe to assume, what to ask, what never
  to promise, how discounts work. Lives in people's heads. → How-to guides in Staff
  Documents, with an admin-only "share with Claude" switch so the same approved,
  versioned, owner-reviewed text guides staff and Claude alike.
- **This client's terms** — discounts, trading terms. Partly in OP already
  (`working_terms_*`, `payment_terms*`, `notes` on people and organisations), used
  unevenly. → Audit and fill those before adding anything new.
- **This client's history** — past jobs, outcomes, threads. Mostly in OP already
  (`services/leads/history.ts` `getClientHistory()`, the email timeline). → One short
  "client brief" assembled for each draft, shared with the chase drafts.
- **The voice** — the chase-tone round already planned (`chase-draft.ts` voice
  instructions, `AUTO-CHASE-SPEC.md` §13.6).
