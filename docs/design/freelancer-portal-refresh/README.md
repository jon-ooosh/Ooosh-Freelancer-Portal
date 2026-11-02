# Handoff: Freelancer Portal visual refresh (mobile)

## Overview
A visual refresh of the Ooosh freelancer portal (Next.js app at the root of `jon-ooosh/Ooosh-Freelancer-Portal`, `src/app/**`) plus the **freelancer-facing** view of the van book-out / collection flow (`frontend/src/modules/vehicles/pages/BookOutPage.tsx`, `CollectionPage.tsx`, reached via `FreelancerBookoutShell.tsx` / `FreelancerCheckinShell.tsx`).

Goal: bring the portal in line with the Oct-2026 hire-form / payment-portal redesign (DM Sans, plum `#A75390`, warm neutrals) **without changing usability**. Routes, flows, business rules, API calls, step order and validation stay exactly as they are. This is a reskin + a small number of layout/IA changes listed under "Behaviour changes".

~99% of use is on phones. Design at 390px wide; content column `max-width: 32rem` (`max-w-lg`, as today) centred on larger screens.

## About the design files
`Freelancer Portal Refresh.dc.html` is a **design reference built in HTML** — not production code. Recreate the designs in the existing codebases (Next.js + Tailwind for the portal; React + Tailwind for the vehicles module) using their established patterns. Open the HTML in a browser to inspect exact values (all styles are inline). Screens are grouped by round; the newest round is at the top. Where a screen exists in two rounds, **the later round wins** (e.g. use 2a Jobs, not 1b).

## Fidelity
**High-fidelity.** Final colours, type, spacing, radii and copy. Recreate pixel-accurately. Data in the mocks is sample data.

## Screens (see `screenshots/`)
| # | Screen | Route / source file | Mock id |
|---|---|---|---|
| 01 | Login | `src/app/login/page.tsx` | 1a |
| 02 | Jobs — by date (default) | `src/app/dashboard/page.tsx` | 2a |
| 03 | Jobs — by type | same | 2a (toggle) |
| 04 | Job detail | `src/app/job/[id]/page.tsx` | 1c |
| 05 | Start ("What are you delivering today?") | `src/app/job/[id]/start/page.tsx` | 2b |
| 06 | Complete delivery / collection | `src/app/job/[id]/complete/page.tsx` | 2c |
| 07 | Studio shift | `src/app/shift/[date]/page.tsx` | 2d |
| 08 | Lock-up | `src/app/shift/[date]/lockup/page.tsx` | 2e |
| 09 | Shop till (token swap only) | `src/app/shift/[date]/till/page.tsx` | 2f |
| 10 | Earnings (**not built yet — style mockup only**) | `/earnings` (new) | 1d |
| 11 | Resources | `src/app/resources/page.tsx` | 2g |
| 12 | Settings | `src/app/settings/page.tsx` | 2h |
| 13 | Book-out: confirm van | `FreelancerVanPicker.tsx` / BookOutPage freelancer confirm | 3a |
| 14 | Book-out step 1: Fuel & mileage | BookOutPage `StepVehicleState` | 3b |
| 15 | Book-out step 2: Photos | BookOutPage `StepPhotos` / `PhotoCapture.tsx` | 3c |
| 16 | Book-out step 3: Briefing | BookOutPage `StepBriefing` | 3d |
| 17 | Book-out step 4: Check & sign | BookOutPage `StepConfirm` / `SignatureCapture.tsx` | 3e |
| 18 | Book-out done | BookOutPage success state | 3f |
| 19 | Collection: Notes & sign | CollectionPage `StepConfirm` | 3g |

Collection steps 1–2 (vehicle state, photos) reuse the 3b / 3c patterns with a 3-segment progress bar.

## Design tokens
Mirror `ooosh-driver-verification-/src/styles/hireform.css` (`--hf-*`). Add to Tailwind theme (e.g. `theme.extend.colors.hf`) and swap the portal off `ooosh-*` sky blue + Inter.

**Colour**
- accent `#A75390` · accent-pressed `#8f4a7c` · link `#8c3f77` · link-hover `#6e2f5d`
- accent tint (bg) `#f6eaf2` · tint text `#7d3569` · tint text strong `#5e2a50`
- ink `#1d1a1c` · body `#3d373a` · muted `#6f6569` · placeholder `#9a9094`
- page `#f6f4f2` · inset `#f8f6f4` · track `#f3f0ed` · segmented bg `#ece8e4` · card `#ffffff`
- border-card `#e8e3df` · border-control `#e3ddd8` · divider `#f0ece9` · chevron/ring `#b9b0ab` · dashed `#cfc6c0` · toggle-off `#d9d2cc`
- green `#3f9b6b` · green-text `#2a7049` · green-tint `#e4f3ea` · green-strong text `#1f4f35`
- amber bg `#fff8e6` · amber border `#f2dca6` · amber text `#8a5a10` · amber tile `#fff4dc`
- error `#a2341f` · disabled button `#cdbfc8`
- Job-kind tiles (bg / fg): Backline `#f6eaf2`/`#8c3f77` · Van `#e7eef4`/`#2f5573` · Crew `#e4f3ea`/`#2a7049` · Studio `#ecebf6`/`#4b4790` · Yard `#f3f0ed`/`#3d373a`

**Type** — DM Sans (Google Fonts, opsz 9..40, weights 400/500/600/700). `-webkit-font-smoothing: antialiased`.
- Page title 26–28 / 700 / −0.02em / lh 1.15–1.2
- Greeting 22 / 700 / −0.02em
- Card title 17 / 600 / lh 1.3 (job cards: **clamp to 2 lines**, `-webkit-line-clamp: 2`)
- List title 16 / 600 · body 15–16 / 400 · meta 14 / 400 muted
- Section label 13 / 700 / uppercase / 0.07em / muted
- Kind label 12 / 700 / uppercase / 0.06em / kind fg colour
- Chip 12–13 / 600–700 · nav label 12 / 500 (active 700)
- Money: `font-variant-numeric: tabular-nums`, 16 / 600 ink (not green)
- Never below 12px.

**Radii** — phone-frame n/a · card 16 · hero/summary card 18 · primary button 14 · secondary/inline button 12 · input 12 · tile 11 (40px) / 12 (44px) · chip 999 · small badge 6.

**Spacing** — page gutter 16 · card padding 16 (list rows 14×16) · stack gap between cards 10 · between sections 26–28 · inside cards 10–14.

**Shadows** — cards: none (1px border only). Primary sticky CTA on job detail: `0 8px 20px -8px rgba(167,83,144,.6)`. Segmented active: `0 1px 2px rgba(0,0,0,.08)`. Focused input: `border 1.5px #A75390` + `box-shadow 0 0 0 4px #f6eaf2`.

**Hit targets** — primary CTA 54–56px · in-card full-width action 52 · two-up buttons 50 · Yes/No/N/A 46 · fuel eighths 44 · icon buttons 44×44 · list rows ≥56 · nav item 54.

## Shared components
- **Card**: white, 1px `#e8e3df`, r16. Grouped list = one card with 1px `#f0ece9` dividers inset to text start (68–72px).
- **Icon tile**: 40×40 r11, kind bg/fg, 20px stroke icon (1.8 stroke, round caps/joins). Replaces all emoji.
- **Chevron**: 18px, stroke `#b9b0ab` 2px. Indicates the whole card/row is tappable.
- **Primary button**: `#A75390`, white 16–17/600. Pressed `#8f4a7c`. Disabled `#cdbfc8` + label that says what's missing (e.g. "12 photos to go").
- **Confirm/finish button**: green `#3f9b6b` (Complete delivery, Book out van, Van collected, Take £x, Yes I can do it).
- **Dark button**: `#1d1a1c` for lock-up actions (Lock up, Finish for the night, Submit).
- **Secondary**: white, 1.5px `#e3ddd8`, ink/body text.
- **Segmented control**: track `#ece8e4`/`#f3f0ed` r12 p4, active pill white r9 + shadow.
- **Chips (selectable)**: 40h r999; selected = `#f6eaf2` bg, 1.5px `#A75390`, `#7d3569` 600; unselected = 1.5px `#e3ddd8`.
- **Checkbox row**: 26px r8; ticked `#3f9b6b` with white check; unticked 2px `#cfc6c0`.
- **Signature pad**: dashed 1.5px `#cfc6c0`, `#f8f6f4` bg, r12, **~195–210px tall** (≈50% taller than before), hint text bottom-centre, "Clear" link top-right.
- **Banners**: info = `#f6eaf2` / `#5e2a50`; warning = `#fff8e6` + `#f2dca6` / `#8a5a10`; success = `#e4f3ea` / `#2a7049`. r14, no left-border accent.
- **Bottom nav** (Jobs · Earnings · Resources · Settings — order unchanged): white 94% + top border, 4 equal columns, active = icon in 52×30 `#f6eaf2` pill + `#8c3f77` label 700.
- **Sticky footer** (multi-step flows): white, top border, padding 12/16/32 (safe-area), grid `1fr 2fr` Back + Next. Scroll content needs bottom padding ≥ footer height.
- **Step header** (book-out/collection): "‹ Exit" · "Book out · REG" · "n of N"; below it an N-segment progress bar (4px, r999, done = accent, todo = `#e3ddd8`).

## Behaviour changes (the only functional changes)
1. **Job cards**: whole card links to details (remove "View details →"). Only on **Today**, non-completed items get a full-width in-card action: "Start delivery/collection/run" (primary) or "Lock up" (dark, studio shift tonight). Crew jobs: no Start (unchanged rule).
2. **Job kind label + travel chip** (2a). Label from existing `whatIsIt`: `equipment` → "Backline delivery/collection", `vehicle` → "Van delivery/collection", null → "Delivery/Collection" (no chip). Chip (derived rule of thumb, not stored data): Backline → "Driving there & back"; Van delivery → "One way · train back"; Van collection → "Train there · drive back". Multi-drop → "Backline run · N stops".
3. **Sort toggle** on Jobs: "By date" (default) | "By type". Persist choice in `localStorage` (`ooosh_portal_jobs_sort`). By date groups: **Today · {date}**, **Tomorrow · {date}**, **Later** (compact rows with day/date block). By type groups: Deliveries & collections, Studio shifts, Crew. In both views **yard-day offers needing an answer are pinned on top** ("Needs your answer"); Completed / Cancelled become two tappable rows at the bottom.
4. **Complete page**: add helper under "Equipment checklist": *"Tick every item you've handed over — or leave them all unticked if you didn't check."* (open question: whether to relax the all-or-none rule).
5. **Settings**: "Job emails" status (On badge) and pause options live in **one card** so it's clear what is being paused.
6. **Copy removals**: login subtitle removed; Start page subtitle removed.
7. Fees shown in ink, right-aligned, tabular; combined run fee shows strike-through standalone total beneath.

Everything else — Start "Expected" steer & ordering, lock-up soft-submit ("Submit anyway (n left)"), off-expected "Why?" box, draft persistence, lost property, handover notes, till flow, book-out step logic, fuel-reduction warning, multi-van picker — is **unchanged in behaviour**; only restyled.

## Vehicles module (book-out / collection)
Apply the new look **only in freelancer scope** (`scope === 'freelancer'`), e.g. a `data-theme="freelancer"` wrapper in the two shells, so the staff navy UI is untouched.
- Fuel: keep the 9 `FUEL_LEVELS`; render as a gauge bar + one row of 9 × 44px buttons (E,1–7,F), selected = ink fill.
- Mileage: large 26px tabular input with "mi" suffix + helper "Read it off the dashboard display".
- Photos: keep `REQUIRED_PHOTOS` order (18). Dark "Next up · n of 18" card with angle name, framing-guide area and white "Take photo" button; 4-col thumbnail grid below (done = green dot, current = accent outline, todo = dashed). Next button disabled with "{n} photos to go".
- Briefing: items from settings by van type; checkbox rows ≥56px; optional notes.
- Confirm: summary rows (Driver, Mileage, Fuel, Photos, Hire ends) + signature pad; green "Book out van".
- Done: green check, "Van booked out", line about the emailed condition report, info banner for the "Both" path, primary "Back to the portal" (→ `returnUrl`).
- Collection confirm: amber fuel-drop banner (existing `isFuelReduction`), mileage delta, damage notes, signature, green "Van collected".

## Earnings (new, mockup only)
Segmented September | October | Tax year; summary card (big total 40/700, jobs/shifts count, stacked bar Paid green / Invoiced amber / To invoice grey, three figures); "N jobs need an invoice" card with "Send invoice" primary; "This month" list with status chips (To invoice / Invoiced / Paid {date}). Data source and invoice flow TBD.

## Assets
- `public/ooosh-tours-logo-small.png` (from the portal repo).
- Icons: simple 24px stroke icons drawn inline in the mock (Lucide-style). Use the codebase's icon set if one exists (e.g. `lucide-react`) — equivalents: upload/download arrows, truck/van, users, mic, wrench, route, lock, map-pin, navigation, phone, file, paperclip, shopping-cart, book-open, settings, briefcase, pound.
- Font: DM Sans via `next/font/google`.

## Files
- `Freelancer Portal Refresh.dc.html` — all screens (open in a browser; needs `support.js` alongside).
- `screenshots/` — 2× PNGs of every final screen, numbered as in the table above.
