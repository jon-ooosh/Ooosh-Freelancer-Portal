<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# External Tools, Integrations & Staff-Facing Modules — reference

PCN manager, staging calculator, backline matcher, leads/tour finder, auto-chase, freelancer onboarding, staff documents.

### External Tools (already built, need repointing from Monday.com → Ooosh API)

These are existing standalone tools that currently push to Monday.com. They need repointing to our status-transition API when ready (Step 5 above):

- **Payment Portal** — Stripe payment processing, currently updates Monday.com. HIGH PRIORITY to repoint (after Steps 1-4).
- **Staging Calculator** — ✅ **INTEGRATED into OP (Jun 2026)** — see "Staging Calculator Integration" below.
- **Backline Matcher** — ✅ **INTEGRATED into OP (Jun 2026)** — see "Backline Matcher Integration" below.
- **PCN Manager** — ✅ **INTEGRATED into OP (Jun 2026)** — see "PCN Manager Integration" below.
- **Cold Lead Finder** — ✅ **INTEGRATED into OP as the Leads module (Jul 2026)** — see "Leads Module (Tour Finder)" below.

#### PCN Manager Integration (Jun 2026)

Penalty Charge Notice module, re-homed from the standalone `PCN-Management-System`
Netlify app (Monday PCN Tracker board + PCN Settings board + Jotform/extraction
flow) into OP under Vehicles. **Spec:** `docs/PCN-MODULE-SPEC.md`. Migrations
130/131/136/138/**140**.

**Storage:** `pcns` (the tracker record, replaces the Monday board) + `pcn_events`
(typed audit timeline) + `documents` JSONB (multi-doc: notice front/back,
correspondence, responses, receipts — migration 136). Settings live in
`system_settings` (category `pcn`), replacing the Monday PCN Settings board.

**Build order (spec §12) — all shipped:** CRUD + `/match` + AI `/extract`
(`pcn-extract.ts`, Claude Haiku via `config/anthropic.ts`); list (`PcnsPage`) +
detail (`PcnDetailPage`) + Vehicles nav; extraction-first Log PCN modal +
`/quick` tile; pay-direct flow + public receipt upload (`PcnReceiptUploadPage`,
`mobile_upload_tokens` `pcn_receipt` purpose); receipt-chase scheduler
(`pcn-chase.ts`, runs in `scheduler.ts`) + deadline/NIP nudges (`pcn-attention.ts`,
silent info@ alerts); `PcnHistorySection` (Vehicle/Driver/Org/**Person**) +
conditional Job Detail card; dashboard NeedsAttention buckets; all 8 email
templates + the conditional £35+VAT HireHop handling charge (`pcn-actions.ts`,
item `b1744`). **RBAC:** money-moving actions (transfer_liability, pay_recharge)
are MANAGER_ROLES; pay-direct / ID-request / internal / query are STAFF_ROLES.

**Monday import (`scripts/migrate-monday-pcns.ts`):** one-pass importer modelled
on `migrate-monday-driver-files.ts`. Paginates the PCN Tracker board
(`18390180140`), maps columns → `pcns` scalars (column IDs lifted from the legacy
`create-pcn.js`), downloads the attached notice scan(s) via each asset's
`public_url` → R2 (`files/pcn-documents/<uuid>/`) → `documents` JSONB. Email-silent
(direct DB writes, never the action endpoints; historical deadlines are in the
past so the info@-only nudges don't fire). Idempotent: upsert on `reference`, fills
NULL gaps only, skips docs whose Monday asset-id is already present (`--force` to
re-import). Best-effort anchoring: vehicle (reg parsed from the notice filename →
`fleet_vehicles`), job (`JOB_NUMBER` → `jobs.hh_job_number`). Reports unmapped
status/type/action labels so the enum maps can be extended before committing.
**First live run: 67 PCNs imported with scans.** NB: any new script that needs the
Monday token must `import dotenv` + `dotenv.config()` — importers that only import
`pg` never load the backend `.env` and `MONDAY_API_TOKEN` reads as unset (the PCN
import worked only because it transitively imports `config/r2`, which calls
`dotenv.config()`).

**Driver backfill (`scripts/backfill-pcn-drivers.ts`):** the import couldn't anchor
drivers — OP `drivers.monday_item_id` comes from the global driver board
(`9798399405`) but the PCN board's driver link points at the Driver Hire Form board
(`841453886`), different pulse-id spaces. The PCN board's `board_relation` turned
out to be an **empty mirror**, so the backfill matches by **name/email** against a
text column (`--name-column <colId>` — jon copied the mirrored names into
`text_mm4fh7s4`): drivers table first (email → name), then freelancer **people**
(→ `driver_person_id`). Dry-run default, `--commit`, sets `driver_id`/
`driver_person_id` only where both are NULL, logs a `matched` event.

**Assign-driver-after-the-fact (this session):** a PCN's responsible driver can be
set/changed/unassigned from `PcnDetailPage` after creation (multi-driver jobs,
"which of three freelancers was in the van"). Migration **140** added
`pcns.driver_person_id` (FK → `people`) so the driver can be a **freelancer/crew
person** with no `drivers` row, alongside the existing `driver_id` (client
self-drive). Exactly one of the two is set; the picker clears the other. Picker
sources: drivers + crew candidates who were on the job around the offence date
(from `/pcns/match` `crew_candidates`), plus a **Drivers | Freelancers** search
toggle (`/drivers` / `/people?is_freelancer=true`). PATCH `/pcns/:id` accepts both
ids and logs a `matched` event on change. List + detail render the person (with a
"crew" tag, link to `/people/:id`); the Person PCN tab (`by-person`, gated to
freelancers) shows their PCN history.

**Recipient routing — `services/pcn-recipient.ts` is THE definition (Sep 2026, job
16373).** A PCN's responsible driver lives in one of TWO columns: `pcns.driver_id`
→ `drivers` (a client's self-drive hirer) or `pcns.driver_person_id` → `people` (a
freelancer/crew member in one of our vans, migration 140). The READ path
(`SELECT_WITH_JOINS`) always joined both; the SEND path in `pcn-actions.ts` joined
only `drivers`, so for a freelancer driver `driver_email` came back NULL, the
driver-facing branch was skipped, and it fell **silently** through to
`resolveClientEmailTarget` — emailing the CLIENT about a PCN their hirer never
incurred. `pcn-chase.ts` carried the identical bug, so all three rungs of the
3/5/7-day receipt ladder would have chased the client for proof of a payment
nobody had asked them to make.

- **Route every PCN recipient decision through `resolvePcnRecipient`** — never
  re-derive it, and never join `drivers` alone. `PCN_RECIPIENT_JOINS` /
  `PCN_RECIPIENT_FIELDS` / `loadPcnWithDrivers` exist so a new query gets both
  identities for free. Three consumers today: the action sender, the chase
  ladder, and the preview endpoint.
- **`audience` is set per action in `ACTION_MAP`**: `driver` (override → driver →
  freelancer → client → info@), `client` (override → client → info@), or
  `freelancer_only`. **`freelancer_only` has NO client / info@ fallback by
  design** — an "Internal — Freelancer" notice is our business, not the client's,
  so no freelancer on file must mean *no email*, not "send it to whoever
  answers". Don't add a fallback arm to it.
- **The fall-through is now loud, not silent.** `GET /pcns/:id/recipient` runs the
  same resolver pre-send and feeds the confirm panel, so staff see the resolved
  address *and where it came from* before committing. A driver-facing action that
  lands on the client raises an amber warning + a tick that gates Confirm
  (warn-not-block, per house convention — a client self-drive hire with no driver
  record legitimately does go to the client), and offers the assign-driver picker
  inline. The timeline records the recipient KIND ("emailed x@y (CLIENT — no
  driver contact on file)"), not just a bare address.
- **`internal_freelancer` can now email, opt-in** (`notify_freelancer` +
  `pcn_internal_freelancer`). Its optional `freelancer_message` is deliberately
  SEPARATE from `resolution_note` — the note is an internal record and must never
  leave the building.
- **`{{noticeContext}}`** swaps "a vehicle hired to you" for "one of our vehicles
  you were driving" on the driver-facing templates when the recipient is a
  freelancer. Both senders supply it; a new sender of `pcn_pay_direct` /
  `pcn_transfer_liability` must too, or the placeholder renders literally.
- **`{{driverName}}` and `{{clientName}}` are not interchangeable** — driver-facing
  templates greet the person (`rcpt.name`), client-facing ones greet the
  organisation (`rcpt.clientName`).

**Extracted date/time must be normalised before it's glued into a timestamp
(Sep 2026, RX21UOB / job 16261).** `pcn-extract.ts` had NO post-parse repair
(unlike its sibling `cost-receipt-extract.ts`), and `PcnsPage.tsx` built
`offence_at` by concatenating the two form fields with a `:00` seconds suffix.
A notice printing the offence time to the second gave `07:54:33` → the glue
produced `07:54:33:00` → invalid moment → `/pcns/match` 400 → the UI's catch-all
**"Driver match failed"**, which pointed staff at hire data that was perfectly
correct. The trap that hides it: an `<input type="date"|"time">` silently
refuses to DISPLAY a value it can't parse while React still holds the bad string
underneath, so the field looks empty and the junk is invisible.
- **`toIsoDate` / `toHhMm` in `pcn-extract.ts` repair every extracted date field
  + the time; unrepairable values are NULLED, confidence downgraded, and the
  original noted.** Never trust an AI-returned date/time to match the format the
  prompt asked for.
- **`buildOffenceAt` in `PcnsPage.tsx` is the ONE builder** for the timestamp the
  matcher AND the save send — it can only return a valid ISO string or null.
  Don't rebuild it inline; that's how the two drifted.
- **`offence_time_raw` keeps the time exactly as printed** (seconds and all) for
  `offence_time_text`, the client-facing figure — we normalise for machine use,
  never tidy up what we quote back. Cleared when staff edit the time by hand.
- **`/pcns/match` reads the calendar date off the leading `YYYY-MM-DD`**, not via
  `toISOString()` — the UTC round-trip put a 00:30 BST offence on the previous
  day and missed its hire.
- **`offence_at` is validated in `createSchema`** — a malformed value used to
  reach Postgres and 500 on the timestamptz cast, losing the whole entry.
- Unit-covered in `backend/src/services/__tests__/pcn-extract.test.ts`.

**List UX (this session):** click-to-sort column headers (a `<field>_asc/_desc`
pair per column in the `/pcns` SORTS whitelist) + last-used sort/filter persisted
to localStorage (`ooosh_pcns_prefs`; dashboard deep-link URL params still win on
load).

**Pay & recharge (Jun 2026):** `pay_recharge` now recharges the actual fine amount
to the client as a **custom-priced HireHop billable line** (`services/pcn-recharge.ts`
`addPcnFineLine`, stock id from `pcn_hh_charge_item`, mirrors the proven
`cost-recharge-hh.ts` add-line→price dance), alongside the separate £35+VAT handling
charge. Because it's a real HH billable line it **auto-surfaces on the Money tab**
(which reads HH billing live) — no extra Money-tab wiring. Tracked on
`pcns.fine_recharge_amount / fine_recharged_at / fine_recharge_hh_item_id`
(migration **143**, idempotent — won't double-recharge). VAT: the fine line uses the
same stock item as the handling fee (1744, 20%-rated via `vat_rate:0` → HH derives),
so a recharged fine carries the same treatment as the admin fee; point at a dedicated
stock item if a fine should ever be zero-rated/disbursement. **Closed-job handling:**
`addPcnFineLine` reads `job_data.php` at push time — pushes if the job is open; if it's
`LOCKED` or terminally closed (Cancelled 9 / Not Interested 10 / Completed 11) it
returns `manualActionRequired` advising staff to recharge manually in HireHop or raise
a separate invoice (status + email still proceed; the email won't claim the fine
landed). Deliberately LOOSER than cost-recharge's `[7,9,10,11]` block — PCNs typically
arrive after the hire RETURNS (status 7, invoice usually still open), so Returned jobs
are allowed to attempt; `LOCKED` is the real gate. The `pcn_pay_recharge` email states
what actually landed. Only fires for `pay_recharge` (transfer_liability doesn't — there
Ooosh never pays the issuer).

**Shared extractor (Jun 2026):** `services/document-extract.ts` is the common
Claude-vision primitive (prompt-cached system prompt, json_schema structured output,
image/PDF blocks single or multi-page, parse-with-fence-fallback, cache telemetry).
`pcn-extract.ts` + `cost-receipt-extract.ts` call `extractDocument<T>()` and keep only
their prompt/schema/post-processing; the deferred vehicle service-record extractor
reuses it.

**Hire-agreement PCN compliance (Jun 2026).** Councils began rejecting PCN
liability-transfer representations because the hire form didn't name the vehicle's
exact make + model — which is a **prescribed statutory particular** of a valid
"hiring agreement" (Sch 2, Road Traffic (Owner Liability) Regs 2000 **SI 2000/2546**,
cross-referenced by RTOA 1988 s66(8); and SI 2005/2757 reg 5(2) for bus lanes outside
London). A missing applicable particular is "fatal to the hire agreement" — liability
stays with us (London Tribunals, *Camden v Europcar*). Two pieces shipped:
- **Make/model on the hire form PDF.** `hire-form-pdf.ts` vehicle line is now
  `reg - type - make/model` (e.g. `RX73TCJ - PREMIUM LWB (M) - MERCEDES-BENZ SPRINTER
  317`), wrapping if long, each segment included only if present (records without
  make/model fall back to the old `reg - type`). `composeMakeModel(make, model)` helper
  (dedupes when model already leads with make); `HireFormData.vehicleMakeModel`
  populated from `fleet_vehicles.make`/`.model` in `loadHireFormData` + the cross-van
  path. Takes effect on newly-generated PDFs only.
- **Transfer-liability soft pre-flight** (`services/pcn-transfer-check.ts`,
  `GET /api/pcns/:id/transfer-check`, surfaced in `PcnActionChooser` when staff pick
  "Transfer liability"). **Advisory only — never blocks.** Warns when a representation
  is likely to be rejected so staff can fall back to Pay & recharge: no driver linked,
  no signed hire agreement on file, **make/model missing on the fleet record**, missing
  driver particulars (DOB/address/licence), offence date outside the recorded hire
  window, or a **London bus-lane PCN** (can't be transferred at all — London Local
  Authorities Act 1996 lacuna; outside London bus lanes transfer fine via SI 2005/2757).
  Bus-lane + London detection is a keyword heuristic (free-text `issuing_authority`,
  `fine_type` doesn't separate bus lanes from other council PCNs).

**⏳ PENDING — hire-form T&Cs wording tweaks (jon to action in a quiet window, not
mid-busy-period).** The full T&Cs (embedded in `hire-form-pdf.ts` `TERMS_AND_CONDITIONS`
+ live at oooshtours.co.uk/files/Ooosh_vehicle_hire_terms.pdf) are substantively strong
— §4.2 already covers fine transfer + £35+VAT handling fee + **post-hire liability**
("some fines may not be received… until after your hire has ended: you remain liable
regardless"), §10.1 covers data protection comprehensively, and the page-1 declaration
cites s66 RTOA 1988 / Sch 6 RTA 1991 / TMA 2004 / POFA 2012. Belt-and-braces tweaks to
make when convenient (legal text — worth a solicitor / BVRLA-template check first):
  1. **Name the modern charge types explicitly** in the page-1 liability declaration and
     §4.2 — currently "parking or traffic fines / penalty charge notice" (a fair
     catch-all). Add **Congestion Charge, ULEZ / Clean Air Zone, and tolls (Dart Charge,
     Mersey Gateway, foreign vignettes)** by name to shut down "that's not a parking fine".
  2. **Add an s172 driver-identification clause** — hirer authorises us to disclose their
     identity to police/authority as the driver for camera/speeding NIPs, and remains
     responsible for the consequences. Not currently explicit.
  3. *(Optional polish)* Lift the road-traffic statement of liability out of the insurance
     proposal declaration into its own clearly-headed, separately-signed block. The
     current version is signed and cites the statutes, so substance is fine — only worth it
     if reprinting the form anyway.
NB the substitute-vehicle statutory particulars (Sch 2 B3–B5) and "actual return date/time"
(B10) need NO form change: each van swap generates a fresh self-contained agreement naming
its own reg+make/model, and B10 is a firm's-copy particular already captured at check-in
(don't re-issue/re-email a form post-hire).

#### Staging Calculator Integration (Jun 2026)

Brought into OP from `ooosh-utilities` (was a static page + 4 Netlify functions). It had
**zero Monday dependency** — purely HireHop-driven — so this was a host-it-in-OP job, not a
Monday repoint.

**Approach: embed, don't rewrite.** The calculator is ~114KB of working vanilla JS + a 42KB
three.js 3D viewer. Rather than port to React, the static assets live in `frontend/public/`
(`staging-calculator.{html,css,js}`, `stage-view.html`) and are served same-origin. It's
launched in an **iframe modal** from the **Job Requirements → "🛠 Tools" dropdown** (which
replaced the dead manual requirement-add picker — templates + individual types were never used;
"+ Reminder" stayed). Same-origin means the embedded app reuses the OP staff JWT
(`localStorage.ooosh_access_token`) and calls `/api/staging/*`.

- **Backend:** `routes/staging.ts` (mounted `/api/staging`) + `services/staging-stock.ts` (the
  HireHop bulk-export parse, ported verbatim). Endpoints: `GET /stock`, `GET /job?job=<hh>`
  (reads OP `jobs`, no HH round-trip), `POST /availability`, `POST /push`, `GET/PATCH/DELETE
  /plans/:id`, and **public** `GET /plan/:slug` (no auth — the 3D viewer link clients open).
  API-token calls go through the broker; the stock export uses its own export ID+key (direct fetch).
- **The gaffa-tape bug — FIXED.** The old push hardcoded the `b` (hire) prefix on every item, so
  the gaffa tape (`hirehopId: 740`, a *consumable*) pushed as `b740` = a Pioneer DJM900 (rental
  stock #740). Consumables live in HireHop's consumables table, addressed with `s<id>`. The
  calculator now tags consumables `saleItem: true` (gaffa tape #740 + velcro hook tape #1013) and
  the push builds `s<id>` for them, `b<id>` for hire. **⚠️ The sale prefix `s` is the documented
  convention but was NOT live-verified — do ONE test push of just the gaffa tape (and velcro) to a
  scratch job and confirm it adds the tape, not a random hire item, before trusting it. The knob is
  `SALE_ITEM_PREFIX` in `routes/staging.ts`.**
- **Short 3D links (migration 121, `staging_plans`).** The old 3D viewer link encoded the whole
  stage config in the URL (huge + ugly). Now `POST /push` stores the config and mints a short slug;
  the link is `/stage-view.html?p=<slug>`, resolved via the public `GET /plan/:slug`. `stage-view.html`
  still decodes legacy `?c=`/`?config=` inline links for backward-compat. The HH job note uses the
  short link.
- **Staging tab on Job Detail** — conditional (only appears once a `staging_plans` row exists for
  the job). Lists each plan's short link with **Open / Copy / Share-with-freelancer / Delete**
  (delete is a hard delete behind a confirm — disposable calc artefact, not hire-tracking). Share
  toggles `share_with_freelancer` (same methodology as files-to-share; portal surfacing is a
  follow-up — the flag is stored, the portal read isn't wired yet). On push-complete the embedded
  app `postMessage`s the parent, which reveals + switches to the Staging tab.
- **Deploy requirement:** `HIREHOP_EXPORT_ID` (+ the stock-export `HIREHOP_EXPORT_KEY` value) must
  be set on the server `.env` — copy both from the retired ooosh-utilities Netlify env. The stock
  endpoint 502s with a clear message until they're set.
- **Live config (confirmed Jun 2026, on prod `.env`):** `HIREHOP_EXPORT_ID=2346` (the NUMERIC id
  only — NOT the full URL), `HIREHOP_EXPORT_KEY=3tsdqih9hpj9` (the stock-export key; the code prefers
  a dedicated `HIREHOP_STOCK_EXPORT_KEY` and falls back to `HIREHOP_EXPORT_KEY`). `services/staging-stock.ts`
  fetches `modules/stock/export_data.php?id=…&key=…&depot=1&cat=444&sidx=TITLE&sord=asc` — i.e. the
  **STAGING parent category 444 with `depot=1`** (a no-cat or no-depot fetch returns a truncated/empty
  list — proven during go-live). It then splits children by CATEGORY_ID (445 decks / 446 legs+hardware /
  447 screwjacks / 448 accessories). `[Staging] export id=… returned N items` logs aid diagnosis.
- **Asset cache-busting:** `staging-calculator.html` loads the JS/CSS with a manual `?v=N` query
  (currently `?v=2.6`). **Bump it on every edit to `staging-calculator.{js,css}`** or browsers serve
  the stale cached copy (cost us a confused deploy — new code on server, old code in browser).
- **⚠️ OUTSTANDING — gaffa tape (consumable) not landing in HireHop.** Diagnosed live 16 Jun 2026.
  The DJM900 bug is fixed (no longer `b740`). The tape now pushes as **`s740`** and the log confirms
  `itemsMap: {"b1708":1,"b1518":4,"b801":4,"s740":1}` is sent and `save_job` returns
  `{"success":true,…}` — but the `b…` hire items land while **`s740` is silently ignored**. So the
  `s` (sale/consumable) prefix is NOT how HireHop's `save_job.php` `items` adds a consumable. There's
  no prior working example (the old utilities tool always pushed `b740` = wrong item), so the correct
  syntax must be found from HireHop API docs / support, or by inspecting how the **backline matcher**
  (`alternative-hirehop-stock`) adds sale stock. **Next-session steps:** (1) determine HireHop's
  consumable add-to-job mechanism — likely either a different `items` key prefix, or consumables go on
  **billing** (`billing_*.php` sale line) not the supply list; (2) set `SALE_ITEM_PREFIX` in
  `routes/staging.ts` accordingly, or branch sale items to a billing call. Tape ID **740 is correct**
  ("MagTape white gaffa tape", consumables table) — ID 21 is a *different* tape (ProGaff, cat 338),
  don't use it. Velcro #1013 has the same issue. **Interim:** staff add the tape to the job manually
  in HireHop. The calc's "Short 1 / owned 0" on the tape is cosmetic (tape is cat 338, outside the
  staging 444 stock fetch — no stock lookup, hardcoded "needs ordering").
- **Job note endpoint (fixed 16 Jun 2026):** the post-push HH job note (carrying the short 3D link)
  was hitting `/api/job_note.php` which 404s; repointed to `/php_functions/notes_save.php`
  (`main_id`/`type=1`/`note`, POST) — the endpoint the original `staging-push.js` used. NB: the
  additional-driver-charge flow in `hire-forms.ts` still uses `/api/job_note.php` (best-effort) — it
  may be silently 404ing there too and should likely move to `notes_save.php` as well.
- **Deferred:** UX/UI polish of the (admittedly cramped) calculator layout — second pass once it's
  live and jon's clicked around. Portal surfacing of shared staging links. Full React rewrite (only
  if it earns its keep — low frequency).

#### Backline Matcher Integration (Jun 2026)

Brought into OP from the standalone `alternative-hirehop-stock` Netlify app
(2 functions + a vanilla-JS `app.html`, password / `?hubToken=` auth). Like the
Staging Calculator it had **no Monday _read_ dependency** — it pulled stock from
the same HireHop bulk-export endpoint OP already wraps — but it _wrote_ every
search to a Monday demand board, which Monday's shutdown was killing. So this was
a host-in-OP + replace-the-Monday-write job. **Native React, not an iframe** (the
UI is a textarea + result cards — trivial to rebuild, and going native gets OP's
JWT auth for free, which is what locks out the old direct-URL access).

- **Where:** Operations submenu → "Backline Matcher" (`/operations/backline-matcher`)
  AND the Job Detail "🛠 Tools" dropdown (`BacklineMatcherModal`, job number
  pre-filled so availability checks against the real hire dates).
- **Backend:** `routes/backline-matcher.ts` (`/api/backline-matcher/*`, STAFF_ROLES) +
  `services/backline-stock.ts` (export fetch, mirrors `staging-stock.ts` — same
  `HIREHOP_EXPORT_ID`/`HIREHOP_EXPORT_KEY`; fetches the 5 backline parent cats
  372/379/385/399/406 with `depot=1`, deduped) + `services/backline-matcher.ts`
  (the Claude call). Endpoints: `POST /match`, `GET /stock`, `GET /demand`,
  `PATCH /demand/:id`.
- **Matcher upgrades over the original:** Claude returns **structured JSON**
  (have-it verdict + ranked alternatives carrying `stock_id`) via the
  `output_config` json_schema pattern (same as `cost-receipt-extract.ts`), so the
  UI renders proper cards with availability pills instead of a markdown blob. The
  well-tuned domain prompt (FT/RT/BD abbreviations, "different model number ≠
  variant" precision) is ported verbatim. **Prompt caching** on the system prompt.
  Model: `claude-sonnet-4-6`. When a HH job is attached, per-item availability is
  checked via the broker (`items_picklist_avail.php`, chunked 50s, cached) and
  folded into the prompt so Claude prioritises what's free for the dates.
- **Demand tracker** (migration 137, `backline_demand`): replaces Monday board
  2227909940. Every `/match` upserts on the normalised request — bumps count, adds
  potential hire-days, records the job ref, stores Claude's have-it verdict. The
  verdict is a **per-search snapshot** (last-known), NOT live truth — live
  availability happens at search time inside `/match`; the table never re-polls
  HireHop. Surfaced as a sortable/searchable table on the Operations page
  (most-requested / do-we-stock-it / hire-days) = purchasing intelligence.
- **Monday pull:** `scripts/migrate-monday-backline-demand.ts` (dry-run default,
  `--commit`) pulls the ~30 board rows into `backline_demand`. Idempotent (counts
  SET from Monday, not incremented). Needs `MONDAY_API_TOKEN`; board id defaults
  to 2227909940 (`MONDAY_BOARD_ID_BACKLINE_DEMAND` overrides).
- **Lock-down (in `alternative-hirehop-stock` repo):** both Netlify functions
  return **410 Gone**; `app.html`/`index.html` are meta-refresh redirects to the
  OP route; `netlify.toml` 301s `/app` + `/app.html`. Kills the
  `?hubToken=...backline-matcher...` deep-link — everyone comes through OP's JWT.
- **Deploy requirement:** `ANTHROPIC_API_KEY` (already on prod — PCN + cost
  extraction use it) + `HIREHOP_EXPORT_ID`/`HIREHOP_EXPORT_KEY` (already on prod
  for Staging). No new server config beyond running migration 137.
- **Deferred:** stock deep-links from alternatives to HireHop (uncertain stock-item
  URL — left out rather than guess); availability-into-prompt for the no-job case
  (skipped — only checks when a job is attached). Cross-link demand → Fill-a-Gap /
  purchasing if it earns its keep.

#### Leads Module (Tour Finder) — cold + warm lead finder (LIVE, Jul 2026)

The old standalone `ooosh-tour-finder` (Python CLI → dead Monday board) re-homed into
OP as the **Leads module**, under **Jobs → Leads** (`/jobs/leads`). Finds touring
artists coming to the UK (Ticketmaster Discovery API over a fixed 24-venue list),
AI-scores them for Ooosh relevance, address-book-matches to spot existing clients
(warm/remarketing), and researches management/booking contacts for cold leads.
**Spec: `docs/TOUR-FINDER-SPEC.md`.** Deliberately mounted under Jobs, NOT a new
top-level nav group (jon's call — "streamline rather than expand"). Migration **175**.

**Where it lives:**
- Backend pipeline: `backend/src/services/leads/*` — `venues.ts` (the 24 MONITORED_VENUES
  + exclusion lists), `ticketmaster.ts` (throttled TM client, per-run call budget),
  `collector.ts` (venue resolution + event collection into `tf_events`), `detector.ts`
  (tour detection + the lookahead-window drop), `scorer.ts` (Claude relevance scoring),
  `matcher.ts` (pg_trgm address-book matching + org AI-Summary enrichment), `researcher.ts`
  (Claude web-search contact research), `pipeline.ts` (orchestrator + zombie-run recovery).
- Routes: `backend/src/routes/leads.ts` (`/api/leads/*`).
- Frontend: `frontend/src/pages/LeadsPage.tsx` (Cold/Warm tabs, scored table, expandable
  row detail, partial-match confirm/reject, run banner, search + click-to-sort).

**Storage (migration 175):**
- `tf_events` — raw Ticketmaster event cache (dedup on TM event id).
- `leads` — the lead record: artist + UK dates/venues, scoring
  (`relevance_score`/`client_tier`/`origin_country`/`is_international`/`reasoning`/`ai_summary`),
  address-book match (`matched_organisation_id`/`match_confidence` [`exact`|`partial`|`none`]/`match_candidates`),
  `stream` (`cold`|`warm`), `contacts` JSONB, lifecycle
  (`status` [`new`|`reviewing`|`contacted`|`converted`|`dismissed`|`not_relevant`]/`assigned_to`/`converted_job_id`).
  Dedup unique index on `(lower(artist_name), first_date)`.
- `lead_runs` — pipeline run log (`status`/`counts`/`error`/timestamps).
- `system_settings` category `leads` — the config knobs (all staff-editable, no deploy):
  `lead_lookahead_min_weeks` (default 3 — the "don't surface tours already running / too
  imminent to sell" floor), `lead_lookahead_max_weeks` (17), `lead_tour_min_dates` (3),
  `lead_tour_window_weeks` (6), `lead_min_relevance_score` (6), `lead_contact_research_cap`
  (20), `lead_auto_run_enabled` (false — the future scheduled-run toggle, not yet wired).

**The pipeline** (`runPipeline`): collect → detect → score → match → research, run as one
background `setImmediate` job writing progress/counts to `lead_runs`.
- **Lookahead fix** (the headline value over the old tool): `detector.ts` drops any tour
  whose earliest *visible* UK date is under `today + lead_lookahead_min_weeks` — no point
  surfacing a tour that's already on the road or too soon to sell into.
- **Scoring** (`scorer.ts`): ported ai_filter prompt (Tier 1 international / Tier 2 within
  70mi of Shoreham / Tier 3), Claude `claude-sonnet-5` with forced tool-use for structured
  output + prompt caching, batched 30.
- **Matching** (`matcher.ts`): `pg_trgm` fuzzy match of the artist name against
  `organisations` (the `%` operator + `similarity()`; `CREATE EXTENSION pg_trgm` in migration
  175, though the existing trgm index already required it). Exact (normalised equality) →
  auto-links + enriches the org's AI Summary; partial (≥ threshold) → surfaces "could this be
  [Org]?" candidates for a human confirm/reject; none → stays cold. Warm summary
  (`getWarmSummary` → `composeWarmSummary`) writes a dated `[Lead Finder YYYY-MM-DD] …` block
  into `organisations.ai_summary` (`appendOrgSummary`).
- **Contact research** (`researcher.ts`): cold/unmatched leads ≥ min score with no contacts →
  Claude + the **web-search tool** (`{ type: 'web_search_20250305', name: 'web_search',
  max_uses: 5 }`) finds management/booking contacts, 90s request timeout, capped per run,
  JSON-parsed with a fence/brace fallback. Errors surface on the run banner (`lastError`).

**Endpoints** (`routes/leads.ts`): `GET /` (list, filter stream/status/min-score),
`GET /runs/latest`, `GET /settings`, `POST /run` (MANAGER_ROLES — full crawl),
`POST /process-existing` (MANAGER_ROLES — match+research existing leads only, no TM crawl —
the fast reprocess path), `POST /cancel` (stop/reset a stuck run), `PATCH /:id` (lifecycle),
`POST /:id/confirm-match` + `POST /:id/reject-match` (partial-match resolution).

**Zombie-run recovery (the `setImmediate` convention):** the pipeline runs in-process, so a
deploy restart mid-run kills it while the `lead_runs` row stays `status='running'` forever —
which both blocks new runs and means the deferred stages never ran. Guards:
`sweepZombieLeadRuns()` marks any orphaned `running` rows failed and is called at **boot**
(`index.ts`, after `startScheduler()`); `isRunActive()` has a **30-min stale guard** so an
old row can't block indefinitely; `POST /leads/cancel` is the manual Stop. Any future
in-process background job should follow the same boot-sweep + stale-guard + manual-stop shape.

**Env needed on the server:** `TICKETMASTER_API_KEY` (the Ticketmaster **consumer key** only —
the Discovery API doesn't need the secret) + the existing `ANTHROPIC_API_KEY`. The old
tour-finder key was reused (found on the server, not regenerated).

**Shipped in three validated PRs:** #997 (PR 1 — collect→detect→score + lookahead fix),
#1000 (PR 2 — pg_trgm matching, Cold/Warm split, partial confirm/reject, org enrichment,
web-search contact research), #1002 (PR 3 — zombie-run recovery, "Match & research existing"
fast path, research timeout/error surfacing, table search + click-to-sort). jon merges each
to main + deploys manually + validates against a test list before the next.

**Deferred slices (agreed, not built):** scheduled weekly run (`lead_auto_run_enabled` toggle
is seeded but unwired); dashboard surfacing of new high-score leads; "Create band + link" for
cold leads (staff-gated address-book create + convert-to-job); outreach-email drafting via the
Gmail auto-chase infra ("here's a lead + a ready-to-send intro"). **Open discussion:** deepen
warm matching beyond org-name — some bands are booked under a management/agency org rather than
a "The Band" org, so a future pass could also match band-role links / people, not just org names.

#### Auto-Chase — Gmail ingestion + AI chase drafts (LIVE, Jul 2026)

The auto-chase feature — ingest the `info@oooshtours.co.uk` inbox (Google Workspace domain-wide delegation), log client emails onto job timelines as `interactions` (feeds the Pipeline Chase Model for free), and AI-draft "just checking in" chases as Gmail drafts staff review + send. **Full spec: `docs/AUTO-CHASE-SPEC.md`** (§13.1 = Phase 1 as-built, §13.2 = Phase 2 progress + remaining checklist). Branch `claude/auto-chase-feature-design-tiknf2`.

**Deployed INERT until configured.** Everything is gated on `isGmailConfigured()` (`Boolean(GMAIL_SERVICE_ACCOUNT_JSON && GMAIL_DELEGATED_USER)`). Without those env vars the scheduler crons are skipped and every endpoint returns `configured: false` cleanly — the migration + code are safe to deploy ahead of the Google setup. Mirrors the `isStripeConfigured()` / `isAnthropicConfigured()` guard pattern.

**What's built:**
- `config/gmail.ts` — DWD JWT (`google-auth-library`, cached per mailbox, scope `gmail.readonly`, `subject` = impersonated mailbox), then plain `fetch` against the Gmail REST API (deliberately avoids the heavy `googleapis` package). `loadServiceAccountKey()` **auto-detects inline JSON vs a filesystem path** — a value starting with `{` is treated as inline JSON, anything else as a path to read.
- `services/email-matcher.ts` — `matchEmailToJob()`, deterministic only: HH job# in attached PDF filename → HH job# in subject/body (validated against `jobs.hh_job_number`) → sender/recipient email → single OPEN job. No match ⇒ `gmail_unmatched_inbound` review queue. **Never guess-attach.** AI fuzzy layer deferred.
- `services/gmail-ingestion.ts` — first run establishes a baseline `historyId` and ingests NOTHING historic (starts from go-live forward); thereafter incremental via the Gmail History API. Dedup on RFC822 Message-ID (partial-unique index) so the same email across future manager mailboxes = one interaction. Matched → `interactions` (`type='email'`, `created_by=SYSTEM_USER_ID`); unmatched → review queue.
- **⚠️ Internal / automated sender guard (critical — info@ is a firehose of our OWN mail). REVISED Jul 2026 — now KEEPS genuine outbound to clients.** `ingestGmailMessage` skips (no log, no queue): automated mail (`Auto-Submitted` ≠ `no`, `Precedence: bulk/list/junk`); our **system/template sender** (`notifications@oooshtours.co.uk` — booking/payment confirmations, hire-form requests, delivery notes, referral alerts, digests, the client-no-email fallback); and **internal↔internal** mail (from our domain with NO external recipient). But it now **KEEPS genuine staff→client outbound** (from us WITH an external `To`/`Cc` recipient, tagged `direction=outbound`) and inbound client mail. `hasExternalRecipient()` is the discriminator. The original cut skipped ALL own-domain mail, which also dropped our quotes/replies to clients — leaving the conversation summary + chase draft one-sided and blind to "we sent 5 quotes" (the job-16274 "no quote sent yet" incident). Stays correct into Phase 1.5 manager mailboxes. Only loss: a staff FORWARD of a client thread into info@ with no external recipient. **Decision: filter smartly, do NOT move internal mail off info@.**
- **⚠️ Backfill + matcher tightening (Jul 2026 — the eBay-labels incident).** The cold-start backfill searched `q="16274"` and force-attached whole matching threads with no validation, so Jon's personal eBay postage-label threads (coincidentally containing those digits) polluted job 16274's timeline. `threadBelongsToJob()` now gates each thread — needs a `Quote (N)` PDF, an explicit `#N`/`job N`/`quote N` reference, or a known job-contact address; a bare digit-coincidence is rejected. The live matcher's body-number layer (`extractReferencedJobNumbers`) likewise now requires an explicit `#`/`job`/`ref`/`quote` prefix (filenames keep the precise `Quote (N)` key). Cleanup: `scripts/reingest-emails.ts` (dry-run default, `--commit`, `--rebackfill`) resets ONLY Gmail-ingested emails (`gmail_message_id IS NOT NULL`) and re-runs the tightened backfill. **Chase-draft tone** is now silence-aware: `unansweredOutbound` (emails we've sent since the client last replied) drives a persistent-non-response register at ≥2 (acknowledge repeated contact, ask if still interested, offer a gracious out) that overrides the "dates far → relax" default.
- `services/email-retention.ts` — weekly sweep strips bodies older than `system_settings.email_retention_months` (default 24), keeps metadata + `body_stripped_at`, idempotent.
- `routes/auto-chase.ts` (`/api/auto-chase`) — `GET /status`, `POST /ingest`, `POST /retention-sweep`, `GET /unmatched`.
- **Migration 157** — email metadata + dedup index on `interactions`; `gmail_sync_state` (per-mailbox `historyId` cursor); `gmail_unmatched_inbound`; `jobs.auto_chase_mode/count/last_at`; seeds `chase_voice_instructions` / `email_retention_months` / `auto_chase_max_silent` (category `chase`).
- **Scheduler crons** (both `isGmailConfigured()`-guarded): ingestion `*/10 * * * *`, retention sweep weekly `0 4 * * 0` (Europe/London).

**⚠️ The `.env`-as-file gotcha:** systemd/dotenv can't parse multi-line JSON — pasting the raw service-account JSON straight into `.env` fails (`Ignoring invalid environment assignment`, `injected env (0)`). Store it as a FILE: `/var/www/ooosh-portal/backend/gmail-sa.json` (`chmod 600`), and set `GMAIL_SERVICE_ACCOUNT_JSON=<that path>`. The loader auto-detects. `gmail-sa.json` / `backend/gmail-sa.json` / `*-sa.json` are git-ignored.

**⚠️ Credential hygiene:** the private key pasted into chat during setup is compromised — it must be revoked in GCP (delete key) and reissued. Domain-wide-delegation consent survives a key rotation (it's tied to the Client ID). Never paste a service-account private key into chat/logs.

**Jon's locked-in design decisions** (all in `system_settings`, tunable without a deploy): retention = 24 months full body then strip (`email_retention_months`); cold dead-end = 3 silent chases then escalate to a human (`auto_chase_max_silent`); multi-mailbox staleness accepted as a Phase 1 cost (draft-not-send is the mitigation, fast manager-mailbox rollout is the fix — NO "always CC info@" mandate).

**GO-LIVE STATE (Jul 2026): Phase 1 + most of Phase 2 are LIVE and working on prod.** Emails are ingesting onto job timelines; chase drafts create real Gmail drafts in info@. The service account key is a FILE at `/var/www/ooosh-portal/backend/gmail-sa.json` owned by the service user (`chown --reference=.env` — a `chmod 600` root-owned file gave `EACCES`; match `.env`'s owner). Both `gmail.readonly` + `gmail.compose` scopes are authorised on the DWD client. Baseline established, 10-min ingestion cron running.

**Phase 2 — AI drafts + real Gmail draft creation + search/backfill (Jul 2026):**
- `services/chase-draft.ts` drafts a "just checking in" chase with Claude Sonnet 5 (`claude-sonnet-5`), forced tool-use, grounded in the quote line items (`jobs.line_items`), repeat-vs-first-contact history, prior ingested email thread, prior chase count, **days-until-hire (urgency/tone)**, and **the INSIDE hire dates**. The "checking-in NOT renegotiating" guardrails live in the code SYSTEM_PROMPT; the `chase_voice_instructions` system-setting is appended (tunable without a deploy). `POST /api/auto-chase/preview-draft/:jobId` returns the draft as JSON without touching Gmail.
- **INSIDE hire dates (critical grounding rule).** Read from OP's `jobs` (synced from HH). Hire START = `job_date` (fallback `out_date`); last hire DAY = `job_end` date **minus 1 when `job_end`'s time-of-day is a morning marker (`getUTCHours() < 12`)** — Ooosh books `job_end` ~09:00 the morning *after* the last hire day (a hire to the 15th shows `job_end` 16th 09:00; the 16th is the RETURN, not a hire day). Matches OP's own "N days" figure. Fixes both 1-day-as-2-day AND multi-day overstatement. A HARD RULE forbids describing the hire as running to the return date. This is code-only — the voice setting can't reach a factual date calc.
- `config/gmail.ts` — `gmail.compose` scope on a **separate** JWT client (`getGmailComposeClient`) so ingestion stays strictly read-only; `createGmailDraft()` (`POST /users/{mailbox}/drafts`, base64url RFC822 + optional `threadId`); `gmailSearchMessageIds()` (readonly `messages.list?q=`). **OP only creates drafts — never sends; staff send from Gmail.**
- `services/gmail-draft.ts` `createChaseDraftForJob()` — AI draft → resolve recipient + thread latch → MIME → create draft. `POST /api/auto-chase/create-draft/:jobId`. Latch order: most recent ingested INBOUND client email on the job (reply into their thread) → else primary `job_contacts` email + a **Gmail search on the HH job number** to latch onto the original sent-quote thread even when the client never replied → else 422 no client email.
- **Cold-start backfill** — `services/gmail-backfill.ts` + `POST /api/auto-chase/backfill` (admin, `{limit?≤200 default 50, dryRun?}`): for each OPEN-pipeline job with an HH number, search the mailbox for the number, pull the matching thread(s), ingest every message onto the KNOWN job. Idempotent (RFC822 dedup) — run repeatedly a limit at a time. Shared `ingestGmailMessage()` extracted from `processMessage()` (live = matcher; backfill = forced known job).
- **Frontend:** "✨ Draft chase" button in `ChaseModal` (manager-tier, calls create-draft, shows recipient + threaded/standalone inline). Chase-voice Settings UI (`ChaseVoiceSettingsSection` on SettingsPage, edits `chase_voice_instructions`, category `chase`). **Timeline email collapse** (`InteractionBody` in `ActivityTimeline.tsx`) — ingested emails hide the quoted reply chain (`>` / "On … wrote:" / Original-Message dividers) behind a "··· show quoted text" toggle; long non-email bodies clamp to 12 lines. Render-only, stored content untouched.

**Phase 2 — automation loop + summary + voice tuning (Jul 2026, SHIPPED — spec §13.2 slices 5-6):**
- **Per-job conversation SUMMARY** (§7.1) — `services/comms-summary.ts` (Haiku) digests a job's ingested `type='email'` interactions, cached in `job_comms_summaries` (migration 163). `GET`/`POST /api/auto-chase/job-summary/:jobId` (STAFF_ROLES); `ConversationSummary.tsx` at the top of the Activity Timeline (jobs only), auto-generates on a missing/stale cache, renders nothing when Anthropic off / no emails. Staleness is COMPUTED at read time (live count/newest vs stored) — no coupling into the ingest hot path; regeneration is lazy (next viewer of a stale job). Falls back to snippets for retention-stripped bodies.
- **Example-driven voice tuning** (§9.3) — `learnChaseVoice()` (Sonnet) distils pasted client emails + our replies into a PROPOSED `chase_voice_instructions` note (style only). `POST /api/auto-chase/voice/learn` (manager-tier) returns the proposal; "Teach the voice from real examples" panel in Settings → Auto-Chase reviews + saves it. Distil-into-instructions, NOT raw few-shot (keeps the runtime prompt small + transparent).
- **Dispute helper** (§7.2) — `services/comms-query.ts` `answerCommsQuery(jobId, question)` (Sonnet) answers a natural-language question strictly from a job's ingested email chain (quotes + dates, "can't find it" when absent, never guesses); the chain is a prompt-cached block so repeat questions on a job reuse it. `POST /api/auto-chase/comms-query/:jobId` (STAFF_ROLES); surfaced as a "🔎 Ask about these emails" box folded into `ConversationSummary.tsx`. The line-item-diff history table (auto-assembled audit trail) is the still-deferred Phase 4 companion.
- **Automation loop** (§9-§10, migration 165 master switch, 166 default sender) — the reply-bump + suppression gate + scheduled draft/send:
  - **Reply-bump** (`gmail-ingestion.ts`): a LIVE inbound client email pushes `next_chase_date` forward (sacred-future) + resets `auto_chase_count` (auto-unenrol on reply). Backfill (`forceJobId`) exempt so historical replays never move live chase dates.
  - **Suppression** (`services/chase-suppression.ts`): Do-Not-Hire / internal → suppress; cold dead-end (≥ `auto_chase_max_silent`) → escalate to a human (turns the job's auto-chase off + bell); client emailed since our last chase → suppress. OOO/bounce/hot-inbound deferred.
  - **Runner** (`services/auto-chase-runner.ts`, cron 08:10 Europe/London + `POST /api/auto-chase/run-due`): due jobs with `auto_chase_mode IN ('draft','send')` → gate → Gmail draft (draft) or send (send). **`auto_chase_send_enabled` master switch defaults OFF** → a 'send' job only drafts until flipped (graduation). Every action logs a `source='system'` chase interaction; failures/suppressions defer the chase. Sign-off: whoever SET the auto-chase (`jobs.auto_chase_set_by`, stamped on the pipeline PATCH, migration 167) → job's manager1 first name → `chase_default_sender_name` setting → "the Ooosh team" (manual "Draft chase" button uses the clicker's name). The ChaseModal offers "Send" only when the global switch is on, so there's no confusing per-job "Send" that silently only drafts; the auto-chase box is hidden in reschedule mode.
  - **Thread latch** (`gmail-draft.ts`): replies to the NEWEST message in the thread (`latestThreadMessageId` via `threads.get`), not the latest *inbound* — fixes drafts landing mid-conversation after an unanswered outbound.
  - **Per-job control**: `auto_chase_mode` on the pipeline PATCH; ChaseModal Off/Draft/Send toggle (manager-tier); Settings master switch + default-sender field.
- **Gmail send** (`config/gmail.ts` `sendGmailDraft` via `drafts/send`, compose scope) — used ONLY by the gated auto-send path.

**Still deferred (see spec §13.2 for the live checklist):**
- Passive draft-vs-sent diff capture (§9.3 — the automated sibling of the paste-box voice tuner); "learn from this thread" timeline affordance pre-filling the paste box; creation-time auto-chase selector on the New Enquiry / quote forms (ChaseModal covers per-job now).
- Phase 3 suppression signals: OOO autoresponder / bounce / hot-inbound content parsing; multi-step cadences.
- Phase 4: the §7.2 dispute helper is SHIPPED. **Quote-PDF version diff — SHIPPED (spec §7.3; PRs #984, #987, #989, Jul 2026).** `migration 170` (`job_quote_versions` + per-job harvest cursor). Because our sent quotes are filtered out of live ingestion (§5.4a), harvest is **search-based**, NOT ingestion-piggyback: `services/quote-harvest.ts` searches the mailbox for the HH job number (`gmail.readonly` — no new scope), keeps ONLY attachments whose filename is `Quote (<thisJob>)` (so a multi-quote email routes each PDF to its own job), two-layer dedup (message id + SHA-256 content hash), bytes → private R2 (`email-quotes/`). `services/quote-versions.ts` vision-extracts line items (`extractDocument`, Haiku) + diffs consecutive versions by normalised description; version ORDER is the full message timestamp (the `(1)/(2)` filename suffix is download-order noise). Surfaced on the **Activity Timeline** (`QuoteVersions.tsx`, NOT the Money tab) + fed into the dispute helper's grounding (`comms-query.ts`). **Loading is non-blocking + polled:** `getJobQuoteVersions` returns cached state instantly + kicks a single guarded BACKGROUND run (`jobsWorking` set) that harvests-then-extracts newest-first; the frontend polls (`working` flag + `pending` versions) so items/diffs fill in live; a PDF whose extraction throws is marked `failed` (`failedVersions` set) → "couldn't read this PDF" not eternal "reading…", retried by the Refresh button. Both the summary + quote boxes are pre-collapsed by default. `GET/POST /api/auto-chase/quote-versions/:jobId[/refresh]` + a background `quote-versions-sweep`.
  - **Extraction truncation FIXED (Jul 2026, job 16274).** Symptom: only the LATEST of 5 quote PDFs extracted; the older 4 showed "couldn't read this PDF". Root cause was NOT the PDFs/R2/vision — it was `document-extract.ts` `JSON.parse` failing (`Expected ',' or ']' … at position ~2777`) because the model's line-item JSON overflowed the default `max_tokens=1024` and truncated mid-array. The older quotes had MORE items (items were trimmed over time; #5 at 19 items just fit). Fix: `extractQuoteVersion` passes `maxTokens: 8192`, and `extractDocument` now throws a clear "hit the output token limit — raise maxTokens" error on `stop_reason === 'max_tokens'` instead of a cryptic JSON-parse failure. Re-extract is automatic (failed rows have `items=NULL`; the in-memory `failedVersions` set clears on restart, so the background run re-attempts on next view). **Lesson: any `extractDocument` caller whose output can be long (list extraction) needs an explicit `maxTokens` — the 1024 default is only safe for small fixed-shape outputs (PCN/cost receipts).**
- **Timeline email collapse is CHARACTER/inline-based** (`InteractionBody` in `ActivityTimeline.tsx`, Jul 2026 fix). Ingested HTML emails have newlines flattened to spaces at storage (`extractBodyAndAttachments` in `gmail-ingestion.ts` does `\s+→' '`), so the whole quoted thread is one giant line — the old line-anchored `wrote:$` detector never matched and walls of text rendered in full. `findQuoteBoundaryChar` now scans the raw text for the earliest inline marker (`On … wrote:` / Outlook `From:…Sent:` / `--- Original Message ---` / `>`) and collapses from there; a char/line long-clamp catches quote-less long bodies. Display-only — full bodies stay stored (the dispute helper needs them). Don't "fix" this by stripping quotes at ingestion — that would starve §7.2/§7.3.
- Phase 1.5 manager mailboxes (dedup already handles it); AI fuzzy matcher (layer 4 in `email-matcher.ts`); attachment→R2 harvest; ingest-time quote-stripping (only if stored bodies get heavy — display collapse already solves the UX); **website-enquiry direct integration** (form→OP webhook with address-book search-or-create — NOT email scraping; enquiry form sends From `info@`, so it can't be sender-allowlisted; jon spinning up a dual-repo session for this; see spec §5.4a + §11).

#### Freelancer Onboarding (Phases A–C SHIPPED, Phase D next, Jul 2026) — see `docs/FREELANCER-ONBOARDING-SPEC.md`

Staff-driven `invite → apply → review → approve → onboard` lifecycle for taking a new freelancer from "someone we might use" to "approved, ready to be crewed onto jobs". Replaces the old "just tick `is_freelancer` and hope" flow. **Migration 184** (`freelancer_applications` table + `people.freelancer_status` denorm column). Routes `routes/freelancers.ts` (`/api/freelancers/*`). Frontend `InviteFreelancerModal.tsx` (invite), `FreelancerPanel.tsx` (the consolidated per-person freelancer surface), `FreelancerHistorySection.tsx` (assignment history — see Crew & Transport).

- **Storage:** `freelancer_applications` — `person_id` FK, `form_token` (UNIQUE, drives the token-gated public apply form — NOT open to the public), `status` (`invited`/`applied`/`more_info`/`approved`/`declined`), audit (`invited_by` → users, `invited_at`, `submitted_at`, `reviewed_by`, `reviewed_at`, `decision_notes`), payload JSONB (`submission`/`insurance_answers`/`references`), `signature_r2_key`, `tcs_version`. `people.freelancer_status` mirrors the latest application status for cheap list reads; `is_freelancer` / `is_approved` are the operational flags.

- **How a person becomes a freelancer (post-toggle-removal, Jul 2026):** the Edit-person form's "This person is a freelancer" checkbox was **removed** as redundant — three real entry points already set the flag: (1) the Person Detail header **"Invite to freelance"** button (renders for any `!is_approved` person → flags `is_freelancer=true`, opens a `freelancer_applications` row, mints the token, optionally emails the link); (2) an **inbound submitted apply-form** flips `is_freelancer=true` + `status='applied'`; (3) the PeoplePage **"+ New Freelancer"** quick-add. The passive path (wait for the form, then approve) and the active path (invite proactively) both converge on the same application record. The **Freelancer tab / `FreelancerPanel`** only shows once `is_freelancer=true`, so the header button is the discoverable "make this person a freelancer" action.

- **Invite flow (`InviteFreelancerModal` + `POST /freelancers/invite`, STAFF_ROLES):** existing-person mode (one click flags + opens application) or new-shell mode (name + **required email** + optional phone → creates the person + application in one step). **Email is mandatory in new mode** (the sign-up link is emailed there; Zod `.refine` enforces it server-side for a new freelancer). Phone is stored on the new shell if given. On success surfaces the tokenised form link (copy button) + whether the intro email went out.

- **Invite audit surfacing:** `GET /freelancers/by-person/:personId` returns the latest application's `status` / `invited_at` / `submitted_at` / `invited_by` + a resolved `invited_by_name` (**join `people` via `users.person_id`** — `users` has no name columns; `COALESCE(NULLIF(TRIM(...)), u.email)`). `FreelancerPanel` shows "Invited by <name> on <date at time> · applied <date>" under the status line, refetched whenever `person.freelancer_status` changes.

- **Review / decide (Phase C, Jul 2026):** `GET /freelancers/applications/:id` (full submission / insurance answers / references, STAFF_ROLES) + `POST /applications/:id/{approve|decline|request-info}` (**MANAGER_ROLES**). Approve → `is_approved=true` + `freelancer_status='approved'`, stamps `freelancer_joined_date` (first time) + `freelancer_next_review_date` (+1yr) + `onboarding.approved_at`, sends `freelancer_approved`. Decline → `freelancer_declined`. Request-info → `more_info` (re-opens the token — `more_info` is a LIVE_TOKEN_STATUS) + `freelancer_more_info` (pre-filled form link). All audit-logged + timeline note. Frontend `ReviewPanel` on the Freelancer tab (submission + insurance Q&A + references + decision buttons; decline/request-info take a reason); decision gated to managers (`hasManagerRole`), STAFF see a "manager needs to approve" note. All three email templates ship OFF `EMAIL_LIVE_TEMPLATES`.

- **Onboarding checklist (Phase C):** `OnboardingChecklist` card (shown once approved) — Reviewed & approved (auto) · Vehicle insurance (`is_insured_on_vehicles`) · T-shirt (`has_tshirt`) · Portal access sent (`onboarding.portal_invite_sent`, **manual tick** — portal Resources is Phase D, no auto-email yet) · Training docs shared (`onboarding.resources_shared`) · Payments policy (informational, covered by signed T&Cs). Toggles via `PATCH /freelancers/:personId/onboarding` (STAFF_ROLES — reuses the two booleans + merges the columnless items into the `onboarding` JSONB).

- **Greyed pickers (Phase C):** `GET /api/people` gained an opt-in **`include_pending=true`** — with `is_freelancer=true&is_approved=true` it returns approved AND pending (invited/applied/more_info, not declined/removed) freelancers, `is_approved`/`freelancer_status` per row (strict-approved callers unchanged). The two crew pickers (`JobDetailPage` + `TransportOpsPage`) pass it and render pending freelancers **disabled with an amber "Pending approval" pill**. `quotes.ts:1887` crew-*history* left strict (those were approved when assigned).

**Roadmap:** Phase A (data + invite) + Phase B (apply form) + Phase C (consolidated Freelancer tab + toggle removal + invite email/phone/audit + review/approve/decline/more-info + onboarding checklist + greyed pickers) are SHIPPED. **Phase D — NEXT:** document-expiry reminder scanner + portal Resources surface + the §14 doc-expiry **eligibility** greying (an approved freelancer with an expired licence/DVLA/passport greyed "expired" for driving — pairs with the reminder scanner's expiry logic) + a "Send portal invite" button that fires the register email (vs the current manual tick). **Phase E** (iDenfy identity verification) is deferred to the Christmas iDenfy migration.

#### Staff Documents & Training (LIVE, Jul 2026) — see `docs/STAFF-DOCUMENTS-SPEC.md`

Staff-facing module for policies / agreements / training / official docs / contracts that staff **read, tick-acknowledge, or sign** — versioned, assignable, renewable, chased. First pillar of a future "Staff" section (holiday/TOIL to follow). Migrations **178** (foundation) / **179** (COT card wording) / **180** (approval workflow) / **181** (freelancer shareable flag) / **185** (tags, owners, content-review cadence). Routes `routes/staff-documents.ts` (`/api/staff-documents/*`); services `services/staff-documents.ts` (assignment resolver) + `staff-document-reminders.ts` (daily 09:35 scheduler) + `staff-document-pdf.ts` (signed snapshot). Frontend `pages/StaffDocumentsPage.tsx` (staff "My Documents") + `StaffDocumentsAdminPage.tsx` (admin) + `components/MarkdownLite.tsx`.

- **Storage:** `staff_documents` (the doc + completion/chase/approval config) → `staff_document_versions` (versioned content; editing = new version) → `staff_document_assignments` (per-user tracker + dedup stamps) → `staff_document_completions` (immutable log, one row per tick/sign event — keeps every historical signature + PDF). Generalises the Storage T&Cs signature machinery, pointed at `users` instead of clients.
- **Completion modes (per instance):** `read_only` (library reference, never tracked) / `tick` (acknowledge) / `sign` (drawn signature via the shared `SignatureCapture` pad). Signable docs render a branded snapshot PDF (logo top-left) to **private R2** `files/staff-documents/…`; downloaded via an **ownership-checked** endpoint (`GET /:id/completions/:id/pdf` — own only, managers any; never a raw key).
- **Targeting:** `all_staff` / `role` / `list` / `cot_card_holders` (a derived set — issuing a `cot_card_label` on the COT Card Register auto-assigns card-holder docs via `syncCotCardHolderDocuments`). Resolver is **additive/idempotent** — only ever *adds* missing assignments, never edits existing ones; gates on `is_active AND approval_status='approved' AND completion_mode<>'read_only'`.
- **Chase / escalate / renew** (per doc, default **7 / 14 / 12**, overwritable): daily scanner lapses expired completions, nudges approaching-renewal, chases pending/lapsed per `chase_interval_days`, escalates stale-pending to managers **once** (no repeat ladder yet). Bells; Step-7 escalation emails per prefs. Soft nudges, never a gate. Dashboard "Staff Documents" NeedsAttention bucket (managers only).
- **Two-stage authoring (mig 180, Option A):** ANY staff create; **managers** publish immediately (or "save as draft"); **everyone else** → `draft` → **Submit for approval** → manager **Approve** (materialise + notify author) / **Request changes** (→ draft + note). Drafts/pending invisible to non-authors (resolver + `/mine` library + `/:id/view` all gate on `approved`). Bell **+ immediate email** both ways. Surfaces: **"New document" + "My proposals"** on My Documents (all staff); **Manage Documents** admin (avatar dropdown, `MANAGER_ROLES`) with pending-first list, per-row **View** (read-only render, inline Approve/Request-changes) / Edit / New version (pre-filled from current) / Who's done / **Delete** (hard-delete only when no signed records exist, else 409 → retire via `is_active=false`).
- **Authoring:** markdown-lite typed in-app (bold/headings/lists/links, `MarkdownLite`, live preview + a formatting-help dropdown) **OR** upload a finished PDF (`file_r2_key` — for anything graphic/laid-out; author in Google Docs, export, upload). Signable docs stay text (the snapshot PDF is text-only). **Slug auto-generated** from the title (`slugify` + `uniqueSlug`, not a visible field). Unsaved-changes guard on the editor modals.
- **Freelancer shareable (mig 181):** `shareable_with_freelancers`, settable ONLY for **policy / training / other** (agreement/contract/official_doc internal-only — backend-enforced in create/patch) with an on-form signal. **Portal Resources display LIVE (PR #1027):** the Next.js portal `/resources` page reads shareable staff docs from OP (`GET /api/portal/resources` + `/:id`, portal auth) — file docs → presigned R2 url, markdown docs → in-portal reader. Monday retired, no fallback.
- **Tags / owners / author / content-review (mig 185):** `tags TEXT[]` (freeform categories — vehicles/money/staging — search + filter on the admin Manage page); author surfaced from `created_by`; `owner_user_ids UUID[]` (responsible for keeping it current). **Owner content-review cadence** is distinct from the assignee re-sign cadence: `content_review_interval_months` + `content_review_due_date` — when due, the daily scanner chases owners/author weekly (escalating to managers, laddered, once overdue by `escalate_after_days`) until they **mark reviewed** (`POST /:id/mark-reviewed` — knocks the due date forward, does NOT disturb assignees) OR **publish a new version** (a significant change — advances the clock AND re-arms assignees via the existing new-version flow). Surfaced in My Documents ("Documents you look after — review due") + on the admin list. The assignee manager-escalation is now **laddered** (re-fires every `escalate_after_days`, was once).
- **COT card agreement** is the seeded first instance (`slug='cot-card-agreement'`, sign, annual, targets card-holders); the COT Card Register (Settings) shows a "Card agreement" Signed/Outstanding/Renewal-due column.
- **Receipt-chaser companion fix:** `/my-receipts` (all staff, own COT costs missing receipts, upload — the `/money/costs` page is manager-gated so non-manager card-holders had nowhere to go; `cost-receipt-chaser.ts` email repointed there).
