# AI Quoting — Claude drafts the quote (PRE-SPEC)

**Status (15 Oct 2026): PRE-SPEC.** Findings and the decisions settled so far; the open
questions in §5 come before a full spec. Nothing is built.

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

## 5. Open questions (before the full spec)

1. **What starts it** — every new enquiry automatically, or a "Draft a quote" button?
2. **When the HireHop job is created** — today the enquiry intake never pushes to
   HireHop (an explicit staff action, `AUTO-CHASE-SPEC.md` §11). Does Claude's proposal
   live in OP until a person accepts it?
3. **Who sets the price** — HireHop's rate card as-is, or does Claude ever adjust
   (multi-week, repeat clients)?
4. **Availability** — which is the truth for "is a Premium free those dates": HireHop
   availability or OP's fleet allocations?
5. **The minimum to quote a van** — which facts must be known, and which get a question?
6. **Learning how we quote** — past enquiry → quote pairs already exist
   (`job_quote_versions` holds extracted lines of every quote PDF we sent).
7. **Measuring it** — compare Claude's proposal with what was actually sent.
