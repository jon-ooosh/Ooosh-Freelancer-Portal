# Changing hire prices — how we do it

Status: **decided 10 Nov 2026 after testing in HireHop: change Price A on the day.** First used for the
1 Jan 2027 van prices; backline and the rest follow the same steps.

## 1. Decisions (jon, Nov 2026)

1. **HireHop holds every price.** OP never stores or calculates a hire price.
2. **The rule is the booking date.** Anything quoted *and* booked in 2026 keeps 2026 prices. Anything quoted
   or booked from 1 Jan 2027 pays 2027 prices. A 2026 quote still not booked at the end of the year is
   re-quoted at 2027 prices.
3. **Prices change in Price A, on the day** (§4 is why). The new figures and structures are prepared ahead
   in Price B, tested on a Price-B scratch job, then copied into Price A on the first working day of the
   new prices. Jobs already made keep the prices on their lines.
4. **Panel vans keep their 2026 prices.** The eTransit is in-house only.
5. **The OP price-list switch stays OFF** (Settings › HireHop prices = HireHop's default, no date). It was
   built for the Price-B route (§5), which the tests ruled out.

## 2. How HireHop prices a van

Price A/B/C on the van is the **one-day rate**. A *custom price structure* (one per van class) holds a
**multiplier per number of days**, and HireHop charges `day rate × multiplier`. The multiplier for *d* days is
`d × (that length's daily rate) ÷ (one-day rate)`. Beyond the last row (8 days), HireHop carries on at the
last day's step, which is the 7+ day rate.

A structure is per price list: `PRICES._1.TYPE` / `_2.TYPE` / `_3.TYPE` on the stock item are separate.
**Never edit a structure in place** — make a new one and point the price at it.

## 3. The 2027 vans

| Van class | 1–2 days | 3–4 days | 5–6 days | 7+ days |
|---|---|---|---|---|
| Premium LWB | £200 | £190 | £175 | £165 |
| Standard MWB (new) | £170 | £155 | £140 | £130 |
| Basic MWB | £150 | £135 | £125 | £120 |
| Mini (Vito) | £130 | £120 | £110 | £100 |

**New price structures** (Period: Days). Checked: day rate × multiplier gives the table's total to the penny
for 1–8 days. Built in HireHop as the "… 27 rates" structures (10 Nov 2026).

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

**State on 10 Nov 2026:** Price B on Premium (1130, 10), Basic (1129, 11) and Vito (1016, 1303) holds the
2027 one-day rate on its 2027 structure, tested on a Price-B job across hire lengths. Standard (2065, 2066)
has the 2027 figures in both A and B. Trailer: in Vehicle accessories, Price A and B set.

**The changeover — first working day of 2027, before anyone quotes:** on each of the six items above, set
**Price A = its Price B figure** and **Price A's structure = its "27 rates" structure**. That's all.

## 4. What the HireHop tests showed (10 Nov 2026)

1. **A Price-B job prices EVERY line from Price B.** Backline on a Price-B scratch job came out at £0. So a
   job on a list prices everything from it, including the lines OP adds by stock number (additional driver
   1324, VE103B 1023, staging items). There is no fallback to Price A.
2. **A line keeps its own price.** A test item at £10/day was put on a job for 3 days, its stock price changed
   to £20, then the job changed to 4 days: the line went to £40. Old quotes are safe when Price A changes.
3. **A line follows a changed STRUCTURE but keeps its own day rate** (jon, confirmed from experience,
   10 Nov 2026). So once Price A points at the 2027 structures, any 2026-priced job whose dates are edited
   is re-multiplied with the 2027 multipliers on its 2026 day rate: a 3-day Premium becomes £513 instead
   of £510, 7 days £1,039.50 instead of £1,050. Unbooked quotes are re-quoted anyway. **Booked jobs we
   honour at 2026 prices need their van line checked by hand whenever their dates change in 2027.**

After the changeover:
- **A job copied by HireHop keeps its source's prices.** That covers "Quote another option" and Re-open, so an
  option added in January to a December quote is at 2026 prices; re-add the vans if it should be 2027.
- **Unbooked 2026 quotes are re-quoted by hand** in early January (pipeline: enquiry / quoting / paused /
  provisional, created before 2027): re-add the vans so they take the new price.

## 5. The OP price-list switch (built, not used)

**Settings › HireHop prices** (admin) picks the list (A/B/C) jobs OP creates are born on, from a UK date
(`services/hh-price-group.ts`, read once per create in `routes/pipeline.ts`; settings `hh_price_group`,
`hh_price_group_from`, migration 338). Empty = OP sends nothing and HireHop uses Price A. **It is off.**
Turning it on needs EVERY item a job can carry priced in that list first (§4.1), or those lines quote £0.

## 6. Next year, and backline

The same as §3: prepare new figures in Price B (new structures where the multipliers change), test on a
Price-B scratch job, copy into Price A on the day. Price B is a staging area only — nothing quotes from it.

**OP readers of Price A:** the Backline Matcher (`services/backline-stock.ts`, `PRICE_1`) and the Shop Till
(sale items, `PRICES._1`). Both stay right, because Price A is always the live price.

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
