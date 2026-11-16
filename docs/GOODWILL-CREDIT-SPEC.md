# Goodwill credit — spec

Status: **phase 1 BUILT (16 Nov 2026) — §13 is what shipped and where it differs; phase 2 (the
HireHop read-back) waits on the probe in §13.3.** Decisions: jon, 16 Nov 2026. Mockups: the "Goodwill credit
mockups" canvas (claude.ai artifact, private to jon) — screens 1a–1d, 2–6 below refer to it.

Born from job 16815: a support band lost a tour when the headliner cancelled. We kept the
cancellation fee and wanted to say sorry with money off their next hire — **not** a refund.
OP had no way to record a promise like that, so it would have lived in someone's head.

## 1. Settled

1. **It is a promise, not money.** Offering a credit changes nothing in HireHop or Xero. There
   is no credit note and no credit balance on the account on the day it is offered. The books move
   only when it is USED: a discount line on a hire, or a credit note on an invoice already raised.
   Reason: a credit on account is the client's money (refundable, a liability with no end date),
   which is exactly what we don't want. A conditional offer with an expiry is not.
2. **A fixed £ amount, entered ex VAT, always shown as "£X + VAT = £Y total"** (20%).
3. **It belongs to an organisation** — the job's band when there is one, else the client org
   (or, if §12 is agreed, a person when there is no org).
   It shows whenever that org is the client or the band on a later job, whoever books.
4. **Use by: 12 months from the offer** by default; a manager can change it.
5. **Managers only** (`MANAGER_ROLES`) to offer, edit, withdraw, or take a reservation off a job.
   **Any staff role** (`STAFF_ROLES`) can apply it to a job — it's the client's entitlement and the
   person quoting is the one who'll see it (jon, 16 Nov 2026).
6. **Used once, "up to £X".** One hire or one invoice takes what it can; anything left lapses.
7. **It can go against money already owed**, not only a future hire (jon, 16 Nov 2026) — and
   that may well be the common use.
8. **OP never writes it to HireHop — applying it is manual.** What gets discounted depends on what
   the goodwill is for, so staff apply it however suits in HireHop: usually a **discount on an
   existing line** equal to the goodwill (a negative line is awkward in HireHop), or a credit note
   on an invoice already raised. Every credit has a reference code (`GW-0012`) that staff type into
   that line's note or the credit note's description; OP READS HireHop to see the code is there (§6)
   (jon, 16 Nov 2026).
9. **OP sends no email.** The offer form shows the points to put in your own wrap-up email (§5),
   with a Copy button. The cancellation email is NOT changed.
10. **Started from a menu item, never a button on the page** — it isn't the norm (§4).
11. **Nothing is ever deleted.** Withdrawn, expired and used credits stay on the org's tab.
12. **Not a discount in the `DISCOUNTS-SPEC.md` sense.** That spec is % rates by group of things;
    goodwill is a fixed sum owed to one band. It does not count towards the 50% discount cap.

## 2. States

| State | Meaning | Stored? |
|---|---|---|
| `offered` ("To use") | Offered, not on any job | yes |
| `reserved` | Held for ONE job (a hire) or ONE invoice. Can't be reserved anywhere else | yes |
| `used` | The code was found in HireHop on that job, or staff marked it applied (§6.4) | yes |
| `withdrawn` | A manager took it back before use, with a reason | yes |
| expired | `offered` and the use-by date has passed | **derived on read**, never stored — no sweep needed |

Moves:
- offered → reserved: "Use on this job" (§4.3).
- reserved → offered: the job goes lost / cancelled, or a manager takes it off. The use-by date
  does not move. (Built as a DERIVED read, not a write — §13.1. A reservation against an
  INVOICE is not freed by a cancellation: a cancelled job still owes its fee invoice.)
- reserved → used: the check finds the code (§6), or staff mark it applied (§6.4).
- offered / reserved → withdrawn: manager, reason required.
- **A hire counts if it was reserved before the use-by date** — a booking made in October for a
  January hire, with the credit expiring in November, still gets it.

## 3. Data (one table, migration 344 or next free)

`goodwill_credits`

| Column | Notes |
|---|---|
| `id` uuid | |
| `ref` text unique | `GW-0001`… from a sequence (`goodwill_credit_ref_seq`), zero-padded to 4. Never reused |
| `organisation_id` uuid → organisations | who it's for |
| `amount_ex_vat` numeric(10,2) | > 0 |
| `reason` text | staff-only, required |
| `source_kind` text | `close_out` · `problem` · `cancellation` · `organisation` |
| `source_job_id` uuid null → jobs | |
| `source_issue_id` uuid null → job_issues | when offered from a Problem |
| `offered_by` uuid → users, `offered_at` timestamptz | |
| `expires_on` date | default `ukDatePlus(365)` |
| `status` text | `offered` · `reserved` · `used` · `withdrawn` (CHECK) |
| `reserved_job_id` uuid null → jobs | the job it's held on |
| `reserved_for` text null | `hire` (a discount line) · `invoice` (a credit note) |
| `reserved_invoice_number` text null | `OT-INV-…` when `reserved_for = 'invoice'` |
| `reserved_by`, `reserved_at` | |
| `used_amount_ex_vat` numeric(10,2) null | what the line / credit note actually took (≤ amount) |
| `used_at`, `used_how` text null | `line` · `credit_note` · `manual` |
| `used_hh_ref` text null | the line id or credit note number OP found |
| `withdrawn_by`, `withdrawn_at`, `withdrawn_reason` | |
| `last_checked_at` timestamptz null, `check_problem` text null | §6 — what the last read found wrong, shown as the flag |
| `created_at`, `updated_at` | |

Indexes: `(organisation_id, status)`, `(reserved_job_id)`. A partial unique index on
`reserved_job_id` is NOT wanted — a job could take two different credits.

Every change writes `audit_log`, and a line on the job's Activity Timeline (source job when offered,
reserved job when reserved / used / released) and the Problem's timeline when it came from one.

All logic in **`services/goodwill-credits.ts`**; copy in **`frontend/src/lib/goodwillCopy.ts`**.

## 4. Screens

### 4.1 Where you start it (screens 1a–1d) — one shared modal behind each

| Door | Where | Prefills |
|---|---|---|
| 1a | Money tab close-out panel (`CloseOutMoneyPanel.tsx`) — a new small **More** menu, top right of the panel | band (else client), source job |
| 1b | Problem page Money card (`DamageMoneyCard.tsx`) — a "⋯" menu | band / client of the Problem's job, source job + issue |
| 1c | Organisation page **Actions** menu (beside Edit / Merge / Delete) | that org, no source job |
| 1d | Cancel Job modal (`CancellationModal.tsx`) — a tick under "Watch this band" with just an amount | band (else client), source job; saved when the cancellation saves, reason defaults to the cancellation reason |

Managers only see the menu item / tick. 1b sits on the Money card, **not** in "How was it
resolved?" — that list says what happened to the thing (repaired, written off); goodwill is money,
and "Repaired" + a goodwill credit can both be true.

### 4.2 The offer modal (screen 2)

For (org picker, prefilled, "Change") · Amount ex VAT → "+ VAT = £Y total" · Why (staff only,
required) · Came from (read-only) · Use by (default +12 months) · **"Put these in your email"**
box (§5) with Copy · Cancel / "Offer £Y credit". The ref is shown once saved.

### 4.3 Their next job (screens 3, 4)

**Client History sidebar** — New Enquiry (`PipelinePage.tsx`) and Job Detail
(`JobDetailPage.tsx`), above Endorsed artists, the same pattern as `EndorsementsNote`. The
`/pipeline/client-history` response gains `goodwill: GoodwillCredit[]` for the client_id and
band_id it already receives — `offered` and not expired, plus any `reserved` on THIS job.

Green note: amount, offered date + source job + who, use-by, the reason in italics,
**Use on this job** · **Not this time** (hides it on this job only — `localStorage`, it's a
per-viewer convenience).

**Use on this job** (screen 4): *Where does it go?*
- **Off this job's hire** (not invoiced yet) → the amount to take off (defaults to the credit,
  capped at the job's ex-VAT value — warn when the hire is smaller: the rest lapses) and the
  instruction "discount the line(s) it's for by £X in HireHop and add **Goodwill credit GW-0012**
  to that line's note" — Copy (the note text) + Open in HireHop. The note shows on the client's
  quote and invoice, which is no bad thing: they see the goodwill applied.
- **Against money they already owe** → pick one of the job's approved invoices with something
  owing (`hh_invoice_index` / the Money summary's own read); the instructions say "raise a
  credit note on OT-INV-… in HireHop with GW-0012 in its description".

"Reserve for this job" → `reserved`. A reserved credit then shows on the job as an amber chip
"Goodwill GW-0012 reserved — waiting for the line in HireHop" until it's used, and in the
close-out panel's ledger as "Goodwill GW-0012: −£X + VAT" once used.

### 4.4 The org's Goodwill tab (screen 5)

An `EntityTabs` secondary tab ("Goodwill", under More until the org has one — `useTabPresence`).
Rows: amount, offered (date + source link), why, use by, status pill (To use / Reserved on job N /
Used on job N / Expired / Withdrawn), and for managers Edit · Withdraw · Take off job. The email
points (§5) are re-copyable from a row.

## 5. The points for your own email (`goodwillCopy.ts`)

- £X + VAT (£Y) off a future hire with Ooosh, or towards anything you still owe us, for [org]
- Use it by [use by] (for a hire, the booking must be made by then)
- Used once, up to £X + VAT — anything unused lapses
- Not exchangeable for cash
- Quote GW-0012 when you book

## 6. Making sure it's used up — the read-back check

### 6.1 Why a separate check
The hourly line-item sync (`hirehop-job-sync.ts` `syncLineItemsForActiveJobs()`) stores each
line's NAME but **not its price**, and only for HireHop statuses 1–6 — not enquiries. So:

- **Reserved credits: their own read.** For each `reserved` credit, read the job from HireHop
  through the broker (low priority): for `hire`, `items_to_supply_list.php`, looking for a line
  whose name or note contains the ref; for `invoice`, the job's `billing_list.php`, looking
  for an APPROVED credit note (`kind = 2`) whose description contains the ref.
- **PRE-REQUISITE, check before building phase 2:** that `items_to_supply_list.php` returns a line's
  note text (the `add` field OP writes in `shop-drain.ts` `setLinePrice()`; OP has never READ it).
  Test on one real job with a note typed in. If it doesn't, the hire case stays on the manual
  "Mark as applied" (§6.4) and only the credit-note case is checked automatically.
- **The amount is the staff member's word, not HireHop's.** A goodwill discount on a line looks
  exactly like any other discount, so OP can't read "how much of this was goodwill". It records the
  amount entered when the credit was applied; the read-back only proves the code is on the job.
  For a credit note the amount IS readable (its value) and is checked against the credit. Reuse the existing
  parsers (the line-item fetch in `hirehop-job-sync.ts`, the billing read behind the Money summary)
  — never a second copy.
- **Unreserved use: piggy-back on the stored lines.** After the hourly sync, look for
  `GW-\d{4,}` in `jobs.line_items` names — cheap, no extra HireHop calls.

Runs every 60 minutes (`config/scheduler.ts`), and on demand from the job's chip ("Check now").
Gated on the job not being lost / cancelled; `is_internal` jobs are skipped.

### 6.2 What it does

| Found | Result |
|---|---|
| Reserved, code found | `used`, `used_amount_ex_vat` = the amount entered when applied (hire) or the credit note's ex-VAT value (invoice), timeline line |
| Reserved for an invoice, credit note bigger than the credit | stays `reserved`, `check_problem` = "credit note is bigger than the credit" (amber) |
| Reserved, nothing found, reserved > 24h ago | stays `reserved`, `check_problem` = "no goodwill line in HireHop yet" (amber on the job + close-out panel) |
| Reserved job now lost / cancelled | back to `offered`, timeline line on both jobs |
| Code found on a job it isn't reserved on, credit `offered` | reserved on that job and checked as above; FYI bell to whoever offered it |
| Code found on a second job while reserved / used elsewhere | red flag on both jobs + bell to managers (`resolve_key`, rule in `bell-rules.ts`: still open while the code is on two jobs) |
| Code doesn't exist | flag on the job ("unknown goodwill code") |

All of these are **warnings, never gates** — nothing stops a job being confirmed, invoiced or
closed out.

### 6.3 The weak point
OP can only find a line or credit note that carries the code. A goodwill discount given without it
is invisible, and on a hire OP can't check the amount (§6.1). The reservation (held at once, so nobody re-uses it) and the "no line after 24h" flag
narrow that gap; they can't close it.

### 6.4 "Mark as applied" (manual)
Any staff, on the reserved chip, once they've put it in HireHop: the amount taken off (defaults to
what was entered at Reserve) → `used`, `used_how = 'manual'`. In phase 1 this is the ONLY way a
credit becomes used; phase 2's check then does it by itself when it finds the code, and this
stays for whatever the check can't see (a job never in OP, a note it can't read, §6.1).

## 7. VAT
**The credit is the net amount** (jon, 16 Nov 2026): £X ex VAT comes off, and VAT follows whatever
it comes off. "£Y total" is shown for the usual 20% case; on a zero-rated part of an EU hire the
client simply gets £X off with no VAT on top.

## 8. RBAC
Offer / edit / withdraw / take off a job: `MANAGER_ROLES`. Reserve, mark as applied and read:
`STAFF_ROLES`. Routes under `/api/goodwill` (`routes/goodwill-credits.ts`), ids validated with
`z.string().guid()`, edits through `partialForUpdate()`.

## 9. Phases

1. **Record + offer + see it.** Migration, service, routes; the modal and doors 1a–1d; the
   Client History note; Reserve; the org tab; "Mark as applied" (§6.4); "back to offered" when the
   reserved job is lost / cancelled (`job-close-cascade.ts`). Usable on its own.
2. **The read-back check** (§6): reserved jobs read from HireHop, the stored-lines scan, the
   flags and bells, the close-out ledger line.
3. *Maybe later:* Money › Goodwill — an admin list of every credit out there and its total
   (what we've promised). Not before someone asks for it.

## 10. Not built, on purpose
- OP writing the line or credit note to HireHop.
- OP emailing the offer.
- Carrying an unused remainder over.
- Turning a credit into cash.

## 11. Open questions
1. ~~Reserve: any staff?~~ Yes — any staff applies, managers create (§1.5).
2. ~~Nominal?~~ Settled by §1.8: it's a discount on the line it's for, so it sits on that line's
   own nominal. The accounts won't show "what goodwill cost" as one figure; OP's own list
   (§9.3) can.
3. ~~VAT?~~ Net (§7).
4. A client who is a person with no organisation — person-held credits (§12, proposed).

## 12. Credits held by a person (proposed, 16 Nov 2026 — not yet agreed)

For a client who is a person with no organisation: a self-drive hirer, a sole trader booked
under their own name. `jobs.client_id` is always an organisation, so today such a job has no org
to hold a credit. The person must be in the address book (a contact on the job); if they aren't,
add them first. OP won't hold a credit against a bare name.

How hard: **about a day on top of phase 1**, because endorsements already do "a person OR an org"
and the shapes can be copied:
- `goodwill_credits` gets `person_id` beside `organisation_id`, with a CHECK that exactly one is set
  (the same shape as `artist_endorsements`).
- **The offer modal's "For"** picks an org or a person. The default order is band, then client
  org, then the job's primary contact when there's no org.
- **Where it shows:** the Client History note also includes credits held by any person who is a
  contact on the job (`job_contacts`; on New Enquiry, the contacts picked so far). It also includes
  a person who is a current member of the client or band org, which is the same membership join
  `endorsements.ts` `forClientContext()` uses.
- **The person page** gets the same Goodwill tab and an Actions menu item as the org page.

What it doesn't change: the GW code, states, read-back and RBAC are identical.

## 13. Phase 1 — what shipped (16 Nov 2026)

### 13.1 Built
- **Migration 345** `goodwill_credits` + `goodwill_credit_ref_seq` (refs `GW-0001`…, from the
  column default). One owner: org OR person (CHECK). `reserved_amount_ex_vat` added beside §3's
  columns (what staff entered at Reserve; "Mark as applied" defaults to it).
- **`services/goodwill-credits.ts`** — every read and write. `EFFECTIVE_STATUS_SQL` derives
  *expired* and *a hire reservation on a lost / cancelled job reads as offered*, so there is **no
  sweep and no hook on the four job-closing paths**; reserving it again just overwrites. The
  reserve UPDATE repeats the "still free" test in its WHERE, so two people can't both win (409).
  Timeline notes on the job(s), the org / person, and the Problem (event `money`); never fail the
  action.
- **`routes/goodwill-credits.ts`** at `/api/goodwill`: `GET /` (owner), `GET /context` (the note —
  a saved job adds its own contacts), `GET /owner-choices/:jobId` (band, client, contacts),
  `POST /` · `PATCH /:id` · `POST /:id/unreserve` · `POST /:id/withdraw` (managers),
  `POST /:id/reserve` · `POST /:id/applied` (any staff).
- **Cancellation**: `POST /cancellations/:jobId/process` takes `goodwill` and offers it AFTER the
  job is cancelled — a failure is logged, never fails the cancellation.
- **Frontend** (`components/goodwill/`, copy in `lib/goodwillCopy.ts`):
  - **The offer form** `OfferGoodwillModal`, opened from four places: the close-out panel's ⋯
    menu, the Problem Money card's ⋯ menu (Problems only, not the claim page), and the org and
    person pages' ⋯ menu. All four reuse `RecordActionsMenu`.
  - **The Cancel Job modal** has a tick, `GoodwillTick`.
  - **The Client History note** `GoodwillNote`, with "Use on this job", sits on New Enquiry and Job
    Detail.
  - **The Goodwill tab** `GoodwillTab` is on org and person pages, under More until there's one
    (`useTabPresence`).

### 13.2 Where it differs from the plan above
- **No release hook**: §2's "back to offered" is a read (13.1).
- **Expiry wording**: "Use it by X (for a hire, the booking must be made by then)". This matches
  the rule that a reservation made before the use-by date still counts.
- **New Enquiry can SHOW a credit but not reserve it**: there's no job yet. The note says "Save the
  enquiry to use it".
- **Where the note can appear:** it lives inside the Client History panel, so it shows only where
  that panel does. On New Enquiry that means a client or band with history; on Job Detail, any
  job with a client.
- **Not built in phase 1:** the reserved chip on the job header and the close-out ledger line.
  Both come with the phase 2 check. The note in the sidebar carries the reserved state for now.

### 13.3 The read-back probe — run BEFORE phase 2
`backend/src/scripts/goodwill-readback-probe.ts`, read-only. On a test enquiry in HireHop, put a
discount on a line and type `Goodwill credit GW-TEST` in that line's note; then on the server:

    cd /var/www/ooosh-portal/backend
    npx tsx src/scripts/goodwill-readback-probe.ts <job number>

It lists every supply-list line and billing row, marks the field that holds the code (★), and
prints every field name HireHop sent. The answer decides phase 2:
- **Found:** the hire check reads the line note.
- **Not found:** hires stay on "Mark as applied", and only credit notes are checked automatically.

