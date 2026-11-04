# Cash forecast — mockup

Design reference for `docs/CASHFLOW-FORECAST-SPEC.md` (3 Nov 2026). **The spec wins wherever the two differ.**

- `mockup.html` — open in a browser. Static HTML, no build; the figures are computed in the page from the arrays in its script, so the table, tiles and chart always agree.
- `screenshots/cash-forecast-mockup.png` — the same page at 1440px wide.

**The figures are invented**, except the opening bank balances (Lloyds, Wise, savings), which are jon's Xero statement balances on 3 Nov 2026. Job numbers and client names are made up.

What it shows, top to bottom: the four tiles (cash in the bank, cash that's yours, lowest point, next 13 weeks), the warnings strip, the chart with the committed line and the likely/possible band against the £0 target and the −£22k overdraft limit, "What would fix it" for the lowest week, the week-by-week table (purple = client money), and the drill-down for one selected cell.

Rebuild it in the React frontend with OP's own components and colours, not by copying this file.
