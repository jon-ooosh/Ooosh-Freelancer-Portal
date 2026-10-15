# Discounts — spec (DRAFT, not built)

Status: **decisions captured, nothing built** (jon, 15 Oct 2026). Written down so the
answers aren't lost before the build starts. Also the groundwork for AI quoting
(`docs/AI-QUOTING-SPEC.md`) — whatever drafts a quote must read the SAME rules a person does.

## 1. Two kinds of information, kept apart

| Kind | Examples | Where |
|---|---|---|
| **Rules for people** (judgement, prose) | when to push the discount up, when not to discount, how to handle quiet times | written policy, on the same OP page as the numbers; staff docs LINK to it, never copy it |
| **Numbers for the system** (machine-readable) | % by group / hire length / job value, quiet-period dates, endorsement rates | structured tables in OP, editable by managers |

## 2. Settled so far

1. **Discount is worked out per GROUP of things on a job**, never one flat % on the whole job:
   backline · vans · rehearsals · transport · shop. Lines are grouped by their HireHop
   category (the way `vat-adjustment.ts` already tells vehicles from the rest).
2. **Backline** is the usual discounted group. **Vans** are rarely discounted: only for a few
   named clients, or on a hire over 30 days. **Rehearsals, transport and shop sales**: rarely if ever.
3. **Starting rate** = a table of group × hire length, adjusted by context:
   - backline **with a van** — the client is hiring a van AND backline for the gig/tour.
     NOT a van we put on to deliver or collect.
   - backline **used in-house in rehearsals** — its own rate.
4. **Job value also pushes the rate up.** A large overall job earns a bit more, on top of hire length.
5. **Quiet periods** (date ranges) **add** to the other discounts; they don't replace them.
6. **Cap: 50%** combined. A **manager** may go past it ("sometimes you've got to seal a deal");
   record who and why.
7. **Endorsements** are per **PERSON** (the artist), not per band — they go with the artist.
   One brand's items only (e.g. DW: 70% on DW kit, subject to a minimum hire charge),
   the rest of the backline at its normal rate. The endorsed rate REPLACES the others for that
   brand's items, and is the only thing allowed past 50% without a manager.
   - **Minimum hire charge** is on the overall job value.
   - Needs an **endorsements table**: artist, brand, rate, minimum charge, authorised by + date,
     last checked, notes.
8. **Client tier** (e.g. "select client: vans discounted") is a label on the org/person that
   switches them to a different row of the table — not bespoke percentages per client.
   "Custom" stays available for the odd exception.

## 3. Open

- **Which items are which brand?** Items are organised by name only, and a name search is
  unsafe ("Ludwig" contains "DW"). Not a blocker for phases 1–2. Likely answer: tag items with a
  brand once (a small item→brand table maintained in OP), not text matching.
- How big a job counts as "large" — thresholds for the job-value adjustment.
- Exact numbers for every table — jon to fill in once the page exists.

## 4. Phases

| Phase | What |
|---|---|
| 1 | Endorsements table (on the person, shown on their bands) |
| 2 | Discount policy page: rate tables (group × length × context), job-value steps, quiet periods, client tiers, written rules |
| 3 | "Suggested discount" box on a job: reads the job's HireHop lines, shows each group's % and why. Display only — staff apply it in HireHop |
| later | AI quoting reads the same calculation (one service, THE definition). Writing discounts into HireHop optional |
