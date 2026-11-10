# Changing hire prices — the yearly price list switch

Status: **built Nov 2026, first used for the 1 Jan 2027 van prices.** Backline and the rest follow
the same steps later.

## 1. Decisions (jon, 9 Nov 2026)

1. **HireHop holds every price.** OP never stores or calculates a hire price; it only chooses which of
   HireHop's price lists (Price A, B or C) a new job uses.
2. **The rule is the booking date.** Anything quoted *and* booked in 2026 keeps 2026 prices. Anything quoted
   or booked from 1 Jan 2027 pays 2027 prices. A 2026 quote still not booked at the end of the year is
   re-quoted at 2027 prices.
3. **The new prices go into a spare list (Price B) ahead of time.** On the day, OP starts creating jobs on
   it. Nobody edits HireHop on New Year's Eve, and a job already made keeps the prices on its lines.
4. **The old prices stay in Price A as the reference** until next year's change overwrites them.
5. **Panel vans keep their 2026 prices.** The eTransit is in-house only.

## 2. How HireHop prices a van

Price A/B/C on the van is the **one-day rate**. A *custom price structure* (one per van class) holds a
**multiplier per number of days**, and HireHop charges `day rate × multiplier`. The multiplier for *d* days is
`d × (that length's daily rate) ÷ (one-day rate)`. Beyond the last row (8 days), HireHop carries on at the
last day's step, which is the 7+ day rate.

A structure is per price list: `PRICES._1.TYPE` / `_2.TYPE` / `_3.TYPE` on the stock item are separate, so
Price B can point at a new structure while Price A keeps the old one.

**Never edit a structure that existing jobs use.** A job whose dates change can re-multiply with whatever
the structure says *then* (test 3 in §4 confirms it), so changing the 2026 multipliers in place could quietly
re-price 2026 quotes. Make new structures.

## 3. The 2027 vans — what to set up in HireHop

| Van class | 1–2 days | 3–4 days | 5–6 days | 7+ days |
|---|---|---|---|---|
| Premium LWB | £200 | £190 | £175 | £165 |
| Standard MWB (new) | £170 | £155 | £140 | £130 |
| Basic MWB | £150 | £135 | £125 | £120 |
| Mini (Vito) | £130 | £120 | £110 | £100 |

**New price structures** (Period: Days). Checked: day rate × multiplier gives the table's total to the penny
for 1–8 days.

| Days | Premium 2027 | Standard 2027 | Basic 2027 | Mini 2027 |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 |
| 2 | 2 | 2 | 2 | 2 |
| 3 | 2.85 | 2.7352941 | 2.7 | 2.7692308 |
| 4 | 3.8 | 3.6470588 | 3.6 | 3.6923077 |
| 5 | 4.375 | 4.1176471 | 4.1666667 | 4.2307692 |
| 6 | 5.25 | 4.9411765 | 5 | 5.0769231 |
| 7 | 5.775 | 5.3529412 | 5.6 | 5.3846154 |
| 8 | 6.6 | 6.1176471 | 6.4 | 6.1538462 |

**On each van item, Price B** = the 1–2 day rate above, with its 2027 structure:
Premium auto + manual (1130, 10), Standard auto + manual (2065, 2066), Basic auto + manual (1129, 11),
Vito auto + manual (1016, 1303). **Panel vans: Price B = Price A, same structure** (prices unchanged).
Anything else a van job can carry (Towbar, trailer, accessories) also needs its **Price B filled in**: an item
whose Price B is £0 quotes at **£0** on a 2027 job.

**Standard MWB** has no 2026 price. Its Price A and Price B are both the 2027 figures, and both must use the
**Standard 2027** structure. It was created on structure 101; if that is the Basic one, a 3-day Standard
quotes £457.24 instead of £465.

## 4. Test before the switch (in HireHop, on a scratch job)

1. Set a scratch job's price group to **B**, add each van, and check the totals against the table at 1, 3, 5,
   7 and 10 days (e.g. Premium: £200, £570, £875, £1,155, £1,650).
2. On a job with a van already on it, **change the price group** from A to B. Do the lines re-price, or keep
   their prices? (OP never changes a job's group, but it is worth knowing.)
3. On a group-A job, **change the dates**. The van must re-price with the 2026 structure, not the 2027 one.
4. Optional, OP end to end: set Settings › HireHop prices to B with no date, create one test enquiry in
   HireHop from OP, check it is on Price B, then put the date back.
5. **On the Price-B scratch job, add a backline item whose Price B is £0.** £0 means every non-van item
   needs a Price B (see the warning in §5). The Price A figure means HireHop falls back to A and nothing
   more is needed.
6. **Does an existing line re-price from the stock item?** Make a throwaway item (Price A £10/day), put it on
   a scratch Price-A job for 3 days, then change the item's Price A to £20. Change the job's dates to 4 days:
   £40 means the line keeps its own £10 rate (old quotes are safe); £80 means it re-reads the stock price.

## 5. The switch (OP)

**Settings › HireHop prices** (admin): *Price list for new jobs* = **B**, *From* = **2027-01-01**. From that UK
date every job OP creates in HireHop is born on Price B (`price_group: 1` on `save_job.php`). Before it, OP
sends nothing and HireHop uses Price A, as always. Code: `services/hh-price-group.ts`, read once per create in
`routes/pipeline.ts`. Settings `hh_price_group`, `hh_price_group_from` (migration 338).

> **⚠ OPEN, 10 Nov 2026 — do not let the switch go live until this is settled.** A job takes EVERY
> line's price from its one list, not just the vans'. As of 10 Nov 2026 Price B is £0 on everything but the
> vans and trailer, so a Price-B job would quote £0 for all backline, rehearsal rooms, storage and sale
> items. That includes the lines OP adds by stock number without a price of its own: additional driver
> (1324), VE103B cert (1023) and the staging calculator's items. Either every item gets a Price B
> before 1 Jan (a copy of A, with the same price structure), or the switch is dropped and the 2027 van
> rates go into Price A on the first working day. Which one depends on HireHop's behaviour (§4 tests
> 5–6, in the reply of 10 Nov 2026).

What it does **not** do:
- **A job copied by HireHop keeps its source's list and line prices.** That covers "Quote another option" and
  Re-open. An option added in January to a December quote is at 2026 prices; re-add the vans if it should be
  2027.
- **A job made directly in HireHop** (not through OP) is on Price A, the old prices.
- **It does not touch any existing job.** In early January, re-quote the 2026 quotes that were never booked
  (pipeline: enquiry / quoting / paused / provisional, created before 2027).

## 6. Next year

Leapfrog. In late 2027, overwrite **Price A** with the 2028 prices (and new structures), test, then set the
switch to **A** from 2028-01-01. Price B then holds 2027 as the reference. Until then, **a new stock item needs
the same price in A and B**, or it quotes £0 on whichever list is live.

**OP readers of Price A:** the Backline Matcher (`services/backline-stock.ts`, `PRICE_1`) and the Shop Till
(sale items, `PRICES._1`). Neither touches vans. Before backline prices move to B, point the Matcher at the
live list; leave the shop's sale items alone.

## 7. Built with it: Standard MWB and towbars (Nov 2026)

- **Standard MWB** (HireHop 2065 auto, 2066 manual) is the fleet type `Standard`. It is in the van mappings
  (`HIREHOP_STOCK_MAPPINGS`), the type pickers, and the name fallback, which tests "standard" before "mwb" or
  a Standard reads as a Basic.
- **Towbar** (HireHop 2064, a virtual autopull in Vehicles) is **never a van**. Before this, the vehicle
  module would have counted it as an extra Premium. Excluded by id in `extractVanRequirements()`,
  `deriveFlags()` and the hire-form driver count.
- **A van line with a Towbar under it needs a towbar.** The towbar sits inside the van's LFT/RGT range;
  if that can't be read, every van on the job is assumed to need one.
- **`fleet_vehicles.has_towbar`** (migration 338) — "Towbar fitted" on the van's page. Allocations lists
  towbar vans first for a towbar job and last for any other, tags "Towbar" / "No towbar", and warns on an
  allocated van with no towbar. Never a block. Job Detail's vehicle card shows a Towbar chip, and its notes
  say "Towbar needed".
- **The trailer** (optional under the Towbar) must NOT be in the Vehicles category (370). Anything
  non-virtual there is counted as a van, with an excess and a hire form. Put it in Vehicle accessories (371).
- **Not built:** a warning when more towbar vans are wanted on the same dates than you have. Five arrive in
  April; see how demand goes first.
