# Goodwill credit — spec (DRAFT, not built)

Status: **decisions captured, nothing built** (jon, 16 Nov 2026). Mockups: the "Goodwill credit
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
3. **It belongs to an organisation** — the job's band when there is one, else the client org.
   It shows whenever that org is the client or the band on a later job, whoever books.
4. **Use by: 12 months from the offer** by default; a manager can change it.
5. **Managers only** (`MANAGER_ROLES`) to offer, edit, withdraw, or take a reservation off a job.
   Reserving it on a job: any staff role (`STAFF_ROLES`) — it's the client's entitlement and the
   person quoting is the one who'll see it. *(open — §11)*
6. **Used once, "up to £X".** One hire or one invoice takes what it can; anything left lapses.
7. **It can go against money already owed**, not only a future hire (jon, 16 Nov 2026) — and
   that may well be the common use.
8. **OP never writes it to HireHop.** Staff add the discount line / credit note by hand; OP
   READS HireHop to see that it's there (§6). Every credit has a reference code (`GW-0012`) that
   staff put in the line or credit note — the code is how OP finds it.
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
| `used` | The code was found in HireHop on that job (or a manager marked it used, §6.4) | yes |
| `withdrawn` | A manager took it back before use, with a reason | yes |
| expired | `offered` and the use-by date has passed | **derived on read**, never stored — no sweep needed |

Moves:
- offered → reserved: "Use on this job" (§4.3).
- reserved → offered: the job goes lost / cancelled, or a manager takes it off. The use-by date
  does not move.
- reserved → used: the check finds the code (§6), or a manager marks it used.
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
- **Off this job's hire** (not invoiced yet) → the discount line text `Goodwill credit GW-0012`
  and the amount, capped at the job's ex-VAT value (warn when the hire is smaller: the rest
  lapses), Copy + Open in HireHop.
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
- The hire must start by [use by] *(for money owed: used by [use by])*
- Used once, up to £X + VAT — anything unused lapses
- Not exchangeable for cash
- Quote GW-0012 when you book

## 6. Making sure it's used up — the read-back check

### 6.1 Why a separate check
The hourly line-item sync (`hirehop-job-sync.ts` `syncLineItemsForActiveJobs()`) stores each
line's NAME but **not its price**, and only for HireHop statuses 1–6 — not enquiries. So:

- **Reserved credits: their own read.** For each `reserved` credit, read the job from HireHop
  through the broker (low priority): for `hire`, `items_to_supply_list.php`, looking for a line
  whose name contains the ref, and its price; for `invoice`, the job's `billing_list.php`, looking
  for an APPROVED credit note (`kind = 2`) whose description contains the ref. Reuse the existing
  parsers (the line-item fetch in `hirehop-job-sync.ts`, the billing read behind the Money summary)
  — never a second copy.
- **Unreserved use: piggy-back on the stored lines.** After the hourly sync, look for
  `GW-\d{4,}` in `jobs.line_items` names — cheap, no extra HireHop calls.

Runs every 60 minutes (`config/scheduler.ts`), and on demand from the job's chip ("Check now").
Gated on the job not being lost / cancelled; `is_internal` jobs are skipped.

### 6.2 What it does

| Found | Result |
|---|---|
| Reserved, code found, amount ≤ credit | `used`, `used_amount_ex_vat` = the line / credit note's ex-VAT value, timeline line |
| Reserved, code found, amount > credit | stays `reserved`, `check_problem` = "line is bigger than the credit" (amber) |
| Reserved, nothing found, reserved > 24h ago | stays `reserved`, `check_problem` = "no goodwill line in HireHop yet" (amber on the job + close-out panel) |
| Reserved job now lost / cancelled | back to `offered`, timeline line on both jobs |
| Code found on a job it isn't reserved on, credit `offered` | reserved on that job and checked as above; FYI bell to whoever offered it |
| Code found on a second job while reserved / used elsewhere | red flag on both jobs + bell to managers (`resolve_key`, rule in `bell-rules.ts`: still open while the code is on two jobs) |
| Code doesn't exist | flag on the job ("unknown goodwill code") |

All of these are **warnings, never gates** — nothing stops a job being confirmed, invoiced or
closed out.

### 6.3 The weak point
OP can only find a line or credit note that carries the code. A goodwill line typed without it is
invisible. The reservation (held at once, so nobody re-uses it) and the "no line after 24h" flag
narrow that gap; they can't close it.

### 6.4 Manual "Mark as used"
For a manager, on the reserved chip: amount + a note, `used_how = 'manual'`. For the odd case the
check can't see (a job never in OP, a credit note raised in Xero by mistake).

## 7. VAT
Entered and shown ex VAT with 20% on top. On a hire that isn't 20% (an EU hire's zero-rated
part), the line still takes £X ex VAT — the client simply gets less VAT back off; the "£Y total"
is illustrative. *(open — §11.3)*

## 8. RBAC
Offer / edit / withdraw / take off a job / mark used manually: `MANAGER_ROLES`. Reserve and read:
`STAFF_ROLES`. Routes under `/api/goodwill` (`routes/goodwill-credits.ts`), ids validated with
`z.string().guid()`, edits through `partialForUpdate()`.

## 9. Phases

1. **Record + offer + see it.** Migration, service, routes; the modal and doors 1a–1d; the
   Client History note; Reserve; the org tab; manual "Mark as used"; "back to offered" when the
   reserved job is lost / cancelled (`job-close-cascade.ts`). Usable on its own.
2. **The read-back check** (§6): reserved jobs read from HireHop, the stored-lines scan, the
   flags and bells, the close-out ledger line.
3. *Maybe later:* Money › Goodwill — an admin list of every credit out there and its total
   (what we've promised). Not before someone asks for it.

## 10. Not built, on purpose
- OP writing the line or credit note to HireHop.
- OP emailing the offer.
- Credits held by a person rather than an org.
- Carrying an unused remainder over.
- Turning a credit into cash.

## 11. Open questions
1. Reserve: any staff, or managers only? (proposed: any staff — §1.5)
2. The discount line's nominal in HireHop — the same nominal as what it's taken off, or one
   "Goodwill" nominal so the accounts show what goodwill cost? Ask the accountant; it decides what
   the "Copy line" instructions say.
3. VAT on a non-20% hire (§7) — fine as described?
4. A self-drive client with no organisation — does it need person-held credits after all? (§10)
