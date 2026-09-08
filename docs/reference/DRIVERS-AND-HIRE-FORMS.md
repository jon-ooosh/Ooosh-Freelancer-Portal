<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Drivers, Hire Forms & Insurance Excess — module reference

Driver verification, document validity, identity review, referrals, allocations, vehicle swap.

#### Step 2: Driver Hire Forms & Excess Calculation ← PHASE C IN PROGRESS
Driver hire forms calculate the insurance excess amount based on DVLA record points.
See `docs/DRIVER-HIRE-EXCESS-SPEC.md` for full spec.

##### ⚠️ Scope rules — what is per-driver vs per-van vs per-job

A hire can have multiple drivers on a single van, and a job can have
multiple vans. Different artefacts scope differently and every Claude
tends to get this wrong on first pass, so it's pinned here:

| Artefact | Scope | Rule |
|---|---|---|
| **Hire form PDF** | **Per-driver** | Each driver signs their own agreement; each gets their own PDF, all with the same van reg on them |
| **Hire agreement email** | **Per-driver** | Each driver gets emailed their own PDF at book-out |
| **VE103B certificate** | **Per hire (1 cert, lead driver only)** | One cert number per job regardless of driver count; `ve103b_ref` writeback is scoped to the LEAD driver's `vehicle_hire_assignments` row only |
| **Insurance excess** | **Per job (top-N-drivers algorithm)** | Sort all drivers by individual calculated excess descending, take the top N where N = HH van count, SUM those. £1,200 floor per slot. Drivers beyond N get `excess_status='not_required'`, £0 |
| **Additional driver charge (HH stock 1324)** | **Per job** | `max(0, totalDrivers - 2 × vanCount) × £20+VAT`. 2 drivers per van are free; anything above is billable |
| **Book-out** | **Per van** | Physical, once per van — the van leaves with all its drivers at the same time |
| **Check-in** | **Per van** | Physical, once per van — all drivers on the van flip to `returned` at the same time |

**Worked excess examples:**

| Scenario | Excess outcome |
|---|---|
| 1 van, 2 drivers each £1,200 standard | £1,200 total (top 1 × 1 slot) |
| 1 van, 3 drivers all £1,200 | £1,200 total, + 1 additional driver charge |
| 1 van, 3 drivers (one £1,800 via referral, two £1,200) | £1,800 total (top 1 wins), + 1 additional driver charge |
| 2 vans, 3 drivers all £1,200 | £2,400 total (top 2 × 2 slots), 0 additional driver charges |
| 2 vans, 4 drivers all £1,200 | £2,400 total, 0 additional driver charges |
| 2 vans, 5 drivers all £1,200 | £2,400 total, + 1 additional driver charge |

**Data-model corollary:** `vehicle_hire_assignments` has one row per
(driver, van, job). Multiple drivers sharing one van = multiple rows
with the SAME `vehicle_id`. The Allocations UI cascades van picks
across siblings so staff only picks once per van slot.

##### Document validity: FROM dates in, derived expiry out (migration 192, Aug 2026)

**Staff and the hire form set ONLY a FROM date** — the date on the document, or
the day the check was run. OP derives every expiry and writes it to the
`*_valid_until` columns on **every** driver write. Both dates are displayed.

| group | FROM (input) | doc's own expiry (input) | derived window (OP-written) |
|---|---|---|---|
| licence | `idenfy_check_date` | `licence_valid_to` | `licence_check_valid_until` |
| dvla | `dvla_check_date` | — | `dvla_valid_until` |
| poa1 | `poa1_doc_date` | — | `poa1_valid_until` |
| poa2 | `poa2_doc_date` | — | `poa2_valid_until` |
| passport | `passport_check_date` | `passport_expiry` | `passport_valid_until` |

Windows: licence = `min(from+90d, licence_valid_to)`; dvla = `from+30d`;
poa = `from+90d`; passport = `min(from+30d, passport_expiry)`.

**`services/driver-validity.ts` is THE definition — never re-implement it.**
`computeDriverValidity()` computes the windows, `persistableWindows()` returns
the columns to store, `touchesValidity()` says whether a write needs
re-deriving, `backfillFromDates()` reconciles a caller that knows only the
expiry. The hire-form router (`analyzeDocuments`) delegates to it, so the router
and the staff UI physically cannot disagree.

**NEVER write a `*_valid_until` column directly, and never add a new writer.**
Set the FROM date and let the derivation run. They stay real stored columns
(rather than moving the arithmetic into the app) so the SQL consumers — the
drivers-list status CASE, the assign picker, the quick-assign gate — keep
working unchanged and simply become correct.

**The incident (job 16291, Peter Christopherson, 19 Aug 2026).** Validity was
stored in two families of columns with six consumers split across them and
nothing keeping them in step: the router and the driver-detail pills read the
CHECK dates, while the drivers list, the assign picker and the hard book-out
gate read the VALID-UNTIL columns. Neither `dvla_valid_until` nor
`licence_valid_to` was editable anywhere in the OP UI, and nothing except the
driver's own DVLA upload ever wrote `dvla_valid_until` — so every staff-side fix
moved the displayed pill and left the gate reading a stale value. Peter showed
green pills on his own page and was hard-400'd out of the assign picker, with no
field in the UI able to reconcile them.

**Integrity guard.** A check date with no licence identity behind it
(`licence_issued_by` blank) yields **no window** — `trusted: false`, and
`licence_check_valid_until` NULL. A DENIED iDenfy check writes a checkDate with
no document data, and the detail page was rendering that as a confident green
expiry for a driver with no licence, no name and no files
(`manjagoproduction@`, Aug 2026). Any new surface reading licence validity must
go through the service so it inherits this.

**Frontend mirror:** `frontend/src/lib/driverStatus.ts` `deriveDriverStatus()`
is the single status-badge definition, mirroring the SQL CASE in
`routes/drivers.ts`. It was implemented twice and the copies disagreed (the list
checked DVLA, the detail page didn't). Keep the two in step — the `/drivers`
filter pills run through the SQL, so a mismatch means clicking "Expired" returns
rows badged "Approved".

**Gate policy is separate from the date model, and deliberately unchanged.** The
picker and book-out gate still red-flag on `licence_valid_to` (the physical
licence expiry), NOT on `licence_check_valid_until`. Tightening that would
newly block **186** drivers whose iDenfy check has aged past 90 days — over half
the signed roster, because most people hire once and never return. The honest
split, per jon: a dead licence is **red** (they cannot drive); a stale *check* is
**amber** ("send them a hire form"). Don't flip the check window into the red
tier.

##### Identity review — staff adjudication of a failed face match (migration 193, Aug 2026)

`drivers.identity_check_status`: `NULL` (never flagged — the overwhelming case)
/ `needs_review` / `accepted` / `rejected`. Owned by
`services/identity-review.ts`.

**What was thrown away.** `idenfy-webhook.js` computed the full verdict —
`faceValid`, `autoFace`/`manualFace`, `autoDocument`/`manualDocument`,
`mismatchTags`, `fraudTags`, `suspicionReasons` — into a local object and
persisted none of it, and saved only `fileUrls.FRONT`/`BACK` while discarding
the **selfie** in the same payload. The face-match result, the entire point of
the check, had zero effect on anything. Two opposite failures:

- **DENIED** → no document data, so OP got a bare check date +
  `overall_status='Stuck'`. The router refuses to trust that shape, and
  `calculateNextStep` has **no branch for "we tried and it failed"** — every
  such path falls through to `{ step: 'idenfy' }`. The driver re-verified,
  failed identically, and was sent again, indefinitely. `'Stuck'` was written
  and never read by the router.
- **SUSPECTED** → document data IS returned, so everything wrote and the driver
  sailed through despite the face not matching.

**The gate.** `needs_review`/`rejected` blocks `POST /hire-forms/quick-assign`
(`driver_identity_unverified`) and withholds the hire agreement via
`isDriverAuthorisedForAgreement` — the same treatment as a pending insurance
referral, so staff meet ONE pattern for "a human must decide". It is a
**separate flag, not `requires_referral`**, because the decider differs: an
insurer answering over days about risk, versus whoever is on the desk comparing
two photographs. Alert to info@ + will@ fires **once** (atomic claim on
`identity_alert_sent_at`, released on failure — same discipline as
`sendReferralAlert`).

**Conventions:**
- **Route every new "is this driver authorised" surface through
  `isIdentityAuthorised()`** rather than re-deriving the status inline.
- **It fails OPEN** on an unknown/absent status, matching the referral arm — a
  data gap must never silently block a driver.
- **Only an explicit non-match trips review** (`faceNeedsReview`). An absent
  face result is NOT a failure: a passport-only session runs no comparison, so
  treating "no result" as a mismatch would flag every second-document upload.
- **A staff decision wins.** Once accepted/rejected, a repeat webhook carrying
  the same stale verdict does not re-open it.
- **The hire-form app cannot set the status** — it reports what iDenfy said, OP
  decides what that means. `identity_check_status` is stripped from the
  `/driver-verification/update` whitelist for the same reason `referral_status`
  is (Meadham / HH 16330).
- Resolution (`POST /drivers/:id/resolve-identity`) is **STAFF_ROLES, not
  manager-only** — it is a visual comparison anyone on the desk can make, and
  gating it narrowly would rebuild the bottleneck the selfie capture exists to
  remove.

**The loop-breaker.** `POST /driver-verification/next-step` returns a terminal
**`manual-review`** step BEFORE `calculateNextStep` runs, so a flagged driver
stops rather than being handed back to the machine that just rejected them.
`/status` reports `manual_review` so ProcessingHub stops polling for a state
only a human can change. ⚠️ **ProcessingHub's `stepMapping[nextStep] || 'poa1'`
silently sends an unrecognised step to the POA upload page** — any new router
step MUST be added to BOTH map sites in `ProcessingHub.js`.

**`drivers.current_job_number`** — the HH job whose form the driver is currently
completing, captured at iDenfy session creation. Closes the blind spot where a
driver part-way through has no `vehicle_hire_assignments` row yet (created on
signature), so Hire History is empty and nothing said which hire a stuck driver
belonged to. Surfaces as `In Progress · #16291` on `/drivers`.

**Open / deliberately left:** the passport branch
(`updateBoardAWithPassportData`) returns early when not approved, so a failed
**passport** face check still writes nothing to OP. POA policy is "both must be
valid, independently" (jon, Aug 2026) — the router already enforces it, but the
picker/gate only red-flag when BOTH have lapsed, so they are currently too
lenient; tightening would newly red-flag 35 drivers.

##### Driver verification cockpit ✅ SHIPPED (Aug 2026)

The DriverDetailPage Overview tab, rebuilt so staff see what the driver and the
router see. `services/driver-verification-state.ts` derives the stage tracker
(Contact → Insurance Qs → Identity → POA1 → POA2 → DVLA/Passport → Signature)
and the "what needs doing" list from the SAME `driver-validity` engine the
hire-form router uses — that equivalence is the point, and any new surface
answering "where is this driver up to" must go through it rather than re-deriving.

**Page order mirrors the hire form**, which mirrors the tracker: contact →
insurance questionnaire → identity evidence → licence details → addresses →
POA1/POA2 → DVLA → passport → signature. Evidence groups are rendered
individually (`renderGroup(key)`), NOT mapped, precisely so the cards that
describe a document sit with it. Keep that shape if you add a group.

**Evidence groups are keyed by the WINDOW they share**, not one row per file:
licence front + back + selfie sit behind a single identity check, so the date is
asked once. POA1 and POA2 stay separate — both required, independently lapsing.

**Conventions:**
- **Slot matching is on a normalised token** (tag first, then label) — the same
  lesson as `DOC_MATCH_TOKENS`: upload paths spell things `licence_front` /
  `license_front` / `Licence Front`, and exact-string matching silently drops
  images. `buildEvidenceGroups` is now the single source of those spellings; the
  "Other Files" list derives from it, so a new slot can't orphan its files.
- **`DocumentThumb` decides image-vs-file from the fetched blob's MIME type**,
  never the filename. DVLA checks arrive as PDFs (sometimes with no extension),
  so an extension test rendered a broken `<img>`. PDFs preview their first page
  through the browser's own viewer (`<embed>` at page size, CSS-scaled into the
  80px box) — no pdf.js dependency, with the generic icon underneath as the
  fallback.
- **Uploading prompts for the FROM date — amber, with a Skip.** Refusing to
  store a document because someone can't read a date off it would repeat the
  hard-gate mistake. A licence front also prompts for the back.
- **Document dates are STAFF-editable via `PATCH /drivers/:id/document-dates`**,
  while the rest of the record stays manager-tier on `PUT /drivers/:id` (which
  can also move penalty points, insurance status and referral flags). That split
  is deliberate: whoever uploads a replacement must be able to date it, or the
  date gets left for someone else and forgotten — the original complaint. Don't
  "simplify" by widening the whole PUT.
- **A stale identity check raises an AMBER action, never red** — there is a test
  asserting this. See the gate-policy note above: red would block 186 drivers.

**Sep 2026 follow-ups:**
- **A missing DVLA document is a HIRE-FORM upload gap, not a rendering bug.** Steven
  Aldridge (job 16116) had a check date, code and points but no file and no "Other
  Files" entry — the file was never sent. The hire form uploaded the DVLA evidence
  copy only on its Continue click, while the DATA landed server-side during
  validation, so the router already treated the step as done; a reload between the
  two skipped straight to Signature. Fixed on the hire-form side (upload fires at
  validation). Diagnostic: `drivers.files` has no `dvla%` tag AND the Netlify
  `monday-integration` log shows no `upload-file-board-a` for the driver. The
  cockpit cannot render what was never stored; check the index before the UI.
- **Single-slot groups render no caption under the thumbnail** — it repeated the
  card title. The Identity group keeps Front / Back / Selfie because there it
  disambiguates.
- **POA provider is STAFF-editable** (`PATCH /drivers/:id/document-dates` also
  takes `poa1_provider` / `poa2_provider`, via `textField` on the group spec). The
  hire form sets it when the driver's document is read, but a staff Replace only
  stores a file, so "— Barclays" stayed put after a different statement was
  uploaded over it.
- **`addressesDiffer` tests the MATERIAL difference** — same UK postcode and same
  leading house number — because the home and licence addresses are two AI reads
  of two different documents and the licence read tends to repeat the postcode.
  No postcode on either side falls back to a de-duplicated word-set comparison.
  Display only; nothing gates on it.
- **⚠️ Every date the hire form consumes must leave OP as `YYYY-MM-DD` — use the
  response's `toYmd`, never `String(v).split('T')[0]`.** node-postgres returns a
  DATE column as a **JS Date object**, so `String(d)` gives
  `"Mon Dec 27 2021 00:00:00 GMT+0000 (…)"` — and `.split('T')[0]` splits on the
  **T in "GMT"**, yielding `"Mon Dec 27 2021 00:00:00 GM"`. That value is
  **truthy**, so it sails through every `|| ''` fallback between OP and the
  browser, and an `<input type="date">` **silently refuses to render a value it
  cannot parse** — the field just looks empty, with no error anywhere. This bug
  class has now surfaced three times: the Idenfy passport `BAD_VALUE` (Ernie, job
  15644), the hire-agreement PDF printing `"Sun Jan 09 1983 00:00:00 GM"`
  (`hire-forms.ts` `toISODate`), and `insuranceData.datePassedTest` on
  `/driver-verification/status` — the one field on that response that didn't go
  through `toYmd`, so returning drivers had to retype "Date passed driving test"
  on every hire while the value sat correctly in `drivers.date_passed_test`
  (Sep 2026). Pinned by `routes/__tests__/driver-status-response.test.ts`, which
  asserts EVERY date on that payload matches `YYYY-MM-DD`; add new ones to it.
  The hire form's `driver-status.js` also now blanks any non-`YYYY-MM-DD` date as
  a tripwire, so a future regression shows as a missing value rather than an
  invisible one.

**Fixed in the same pass:** `{value || '—'}` rendered 0 penalty points as a
dash (0 is falsy) — a clean licence looked like missing data. `licence_type` and
`licence_categories` now come from iDenfy's `driverLicenseCategory`, which the
webhook has always read (to test for PROVISIONAL/LEARNER) and always discarded,
which is why "Type" read "—" on every driver. `licence_restrictions` still has
no writer and is dropped from the UI rather than shown as a permanent dash —
categories (what you may drive) and restrictions (conditions on you) are
different things and must not share a column.

##### "Signed FOR THIS HIRE" — the unsigned-form derivation (Sep 2026, migration 196)

**A signature never expires, so `signature_date` cannot answer "are they on the hire in
front of them?"** The only thing that joins a driver to a hire is the
`vehicle_hire_assignments` row, created at exactly one moment: the Signature step of the
hire form. Every earlier step (iDenfy, POA, DVLA) writes only to the driver record.

**The incident (Cameron Williams-Hill / job 16618, 3 Sep 2026).** Returning driver, April
signature on file. Re-verified iDenfy + both POAs + DVLA in 15 minutes, then closed the tab
on the DVLA "validated" screen (it renders before Continue is pressed). No assignment row.
Every surface read green — "Approved" pill, "Last signed 24 Apr", cockpit Signature ✓ —
because all of them keyed off the April signature, and the blue "currently completing a
form for #N" banner keyed off `!signature_date`. Staff had to reason it out by hand.

**`services/driver-hire-progress.ts` `unsignedJobNumberSql(alias)` is THE derivation** —
`current_job_number` when (a) the job is live (not lost/cancelled/returned/completed) and
(b) no non-cancelled assignment exists for (driver, that job); else NULL. Exposed as
`unsigned_job_number` on the drivers list, `GET /drivers/:id`, the verification-state
payload, and `GET /drivers/unsigned-for-job/:hh`. **Every "is this driver joined to the hire"
surface reads it; never re-derive from `signature_date`:**
- `/drivers` status CASE + `deriveDriverStatus` → **In Progress · #N** (was "Approved").
- Cockpit Signature stage → todo, "Signed before — not yet for #N", amber action. Test in
  `__tests__/driver-verification-state.test.ts`.
- DriverDetailPage: amber banner + the Signature card's header (no fake "No expiry set"
  pill — it says "Signed 24 Apr 2026" or "Not yet signed for #N").
- Job Detail Drivers & Vehicles: **greyed dashed "⏳ Started hire form — not signed" card**
  above the assignments (also on the empty state), with a copy-link button.
- `services/unsigned-hire-form-nudge.ts` (hourly at :20, business hours): emails the DRIVER
  the form link once per (driver, hire) after 2h quiet — `hire_form_unsigned_nudge`,
  claimed on `drivers.unsigned_nudge_job_number` BEFORE the send, released on failure.
  No staff bell; the card + cockpit action are the staff signal.

**`current_job_number` is written at OTP verification** (`verify-code.js` in the hire-form
app), not only at iDenfy session creation — a returning driver with a valid licence check
skips iDenfy, so the old write point never fired for exactly the drivers this is for.
`current_job_started_at` is stamped by the `/update` handler when the number CHANGES.

**JSONB columns in `/driver-verification/update` MUST be in `JSONB_FIELDS`.** node-postgres
sends a JS array as a Postgres ARRAY literal (`{"…"}`), which JSONB rejects — but an EMPTY
array survives (`{}` is valid JSON), so `licence_endorsements` failed only for drivers WITH
points, silently, from the Apr 2026 cutover until Sep 2026. That write also carries any
DVLA-points-triggered `requires_referral`, and `copy-a-to-b` builds the hire-form payload
from the OP driver record, so a points-triggered referral could be lost end to end.
Deterministic (3 retries, same payload), and the DVLA page never read the response — it
now `reportError`s at `critical`. Points/endorsements on affected drivers are NOT
backfilled: the data only exists in Netlify function logs; check `licence_points` against
the DVLA PDF on any driver whose check landed in that window.

##### Phase 4 — extraction ← NEXT (not built)

##### Cockpit brief as specced (delivered — kept for the deferred items below)

Rebuild the DriverDetailPage **Overview tab** (replace it — a second tab
recreates the disconnection this is meant to kill) into one surface that shows
what the driver and the system see, rather than making staff reassemble it.
jon's framing: *"make us see what they/the system sees, rather than try to bodge
it together."*

**Why:** staff kept forgetting to update validity dates because the layout is
spread out and disconnected — "Document Validity" is one card, "Documents" is a
separate card 400px below, and nothing ties an image to its date. Phases 1–2
made the data honest and complete; Phase 3 makes it usable.

- **Stage tracker** across the top: Contact → Insurance Qs → Identity → POA1 →
  POA2 → DVLA → Signature, each ✅/⏳/❌. **Drive it from the same
  `analyzeDocuments`/`driver-validity` the router uses**, so the tracker and the
  driver's actual journey cannot disagree — that equivalence is the whole point.
- **Evidence groups, not 8 flat rows** — image + FROM date + derived expiry +
  status together in one block per group: Identity (licence front + back +
  selfie → one window, plus the licence's own expiry), DVLA, POA1, POA2
  (**independent of each other** — one may lapse while the other stands),
  Passport, Signature.
- **"What needs doing?" panel** off the same analysis, each line a single-click
  action: *"❌ Selfie didn't match licence — compare below"*, *"⚠ DVLA check
  expired 12 Sep — request new"*.
- **Soft-forced date on manual upload** — uploading a document prompts for its
  FROM date, and uploading a licence front prompts for the back. **Amber, not
  red** (jon's standing preference, and the lesson of the 16291 hard gate):
  saving without a date is allowed but leaves a visible "no expiry set" marker.
- **Phase 4 — extraction:** point the existing `services/document-extract.ts`
  (already doing PCN notices + cost receipts) at driver documents so the FROM
  date pre-fills from the DVLA summary / POA / licence and staff only confirm.

**Both shipped together, Aug 2026** — deliberately in one PR, because
tightening POA alone would have blocked 35 drivers with no route through,
recreating the dead end that caused this whole body of work:

- **POA gate: BOTH proofs must be valid, independently.** The picker and
  quick-assign previously red-flagged only when BOTH had lapsed, so a driver
  with one dead POA looked assignable while the router (reading the policy
  correctly) sent them off to re-upload. They are now named separately —
  `Proof of address 1` / `Proof of address 2` — so staff ask for the one that
  actually lapsed rather than re-collecting both. A MISSING POA date is red too,
  and the frontend `check(label, raw, missingIsRed)` mirrors that exactly.
  ⚠️ `missingIsRed` is POA-only: licence expiry stays amber-on-missing because
  iDenfy frequently fails to extract it, and reding that would block drivers
  over an extraction gap rather than a real problem.
- **Manager override** — `override_reason` on `POST /hire-forms/quick-assign`
  (min 10 chars, `MANAGER_ROLES`). Audit-logged as `override_document_gate` with
  the expired list + reason, and `console.warn`ed. The 400 returns
  `can_override` so the UI offers the hatch only to someone who can open it.
  **It covers the DOCUMENT gate ONLY** — identity review and insurance referral
  are somebody else's decision, and a manager must not be able to self-serve
  past "the insurer hasn't answered" or "nobody has confirmed this is the person
  on the licence".

**`api.ts` errors now carry the parsed response `body`** so callers can branch
on a machine-readable field. NB the long-standing `code` property on those
errors is the error MESSAGE, not a code — read `body.code`.

**Already delivered from the earlier queue:** the amber tier for a stale
identity check now lives in `driver-verification-state.ts` as an amber action
("Identity check lapsed … — send a hire form to re-verify"), with a test
asserting it can never be red.

##### Driver-level liability model (migration 065, Apr 2026)

**Two distinct concepts, separated:**

| Layer | Where it lives | What it represents |
|---|---|---|
| **Driver liability** | `drivers.calculated_excess_amount` | Individual liability of THIS person. £1,200 floor, higher with referral. Set by hire form submission, editable from `/drivers`. Never goes to £0. The SOURCE OF TRUTH for the `/drivers` display. |
| **Job-level excess record** | `job_excess` (one per assignment) | Realisation of the liability for a specific hire. Carries payment state, claims, reimbursements, top-N "covered" status. |
| **Money / payer linkage** | `job_excess.xero_contact_id` + `client_excess_ledger` view | Who paid, for refund / rollover routing. Already in place. |

The driver liability **flows in** to the per-job calculation (top-N drivers' liabilities, where N = van count). The per-job record is the **realisation**. Editing a driver's individual liability does NOT auto-propagate to live job_excess records — staff bump per-job excess on `/money/excess` if needed. This was a deliberate design decision (Apr 2026, jon agreed): bulk auto-propagation is too edge-case-risky for the value it provides.

**`drivers.excess_locked` flag:** When `true`, hire form re-submissions and the driver-verification signature side-effect will NOT auto-overwrite `calculated_excess_amount`. Use for insurer-imposed manual overrides (e.g. post-incident bump that should survive a future hire form re-fetch).

**Three write paths:**
1. **`POST /api/hire-forms`** — writes `calculated_excess_amount = max(hireFormCalculated, £1,200)` on the driver, alongside creating the per-job excess record. Skipped if `excess_locked = true`.
2. **`POST /api/driver-verification/update`** — when `signature_date` is set in the update and the driver has no calculated_excess_amount yet, seed it with £1,200. Covers the case where the SignaturePage chain doesn't reach `POST /api/hire-forms` (a known intermittent gap).
3. **`PATCH /api/drivers/:id/calculated-excess`** — staff-edit endpoint (admin/manager only). Audit-logged.

**Which surface actually changes a LIVE hire's excess (Sep 2026).** Easy to misremember, so: `PATCH /api/drivers/:id/calculated-excess` (the Drivers board) writes ONLY `drivers.calculated_excess_amount` and deliberately does not propagate — its own comment says so. The paths that DO change a live hire are `PUT /api/excess/:id` (the "Edit" on the Job Detail driver card and the `/money/excess` Manage modal) and referral resolution with `adjusted_excess`. Since Sep 2026 a Drivers-board edit also reaches a live hire INDIRECTLY: `services/excess-topn.ts` reads that column, so the next driver write on the job re-ranks and can raise the charge to it — but it can never lower a figure set on the job record itself (see the `effective` note under Top-N reconciliation).

**For "In Progress" drivers (no `signature_date` yet):** display shows "—" (their actual liability hasn't been determined — might land on referral and need higher). The edit affordance is still present — staff can pre-set if needed.

**Why this matters:** Before migration 065, the `/drivers` EXCESS column LATERAL-joined `job_excess` via `vehicle_hire_assignments.driver_id`. Drivers without an assignment row (e.g. signed but POST /api/hire-forms didn't fire, or migrated from Monday with no assignment) showed "—" with no edit affordance. Drivers WITH a `not_required` per-job record showed "£0 / Covered" — misleading because their personal liability is £1,200, just covered by another driver on that specific hire. The new model separates "what is this person liable for individually" from "what's the per-job realisation", so the Drivers page always shows the personal liability (£1,200+ for approved + non-referral, higher for referrals).

Backfill: `backend/src/scripts/backfill-driver-calculated-excess.ts` (dry-run / `--commit`). Sets approved + non-referral + signed drivers to £1,200. Referrals are skipped — manual review required for insurer-imposed amounts.

**Phase A — Database + API** ✅ COMPLETE
- [x] Migration 017: `drivers`, `vehicle_hire_assignments`, `job_excess`, `excess_rules`, `client_excess_ledger` view
- [x] Migration 018: `webhook_log`, `api_keys` tables
- [x] Migration 019: `files` JSONB on `drivers` table
- [x] Backend routes: `drivers.ts`, `assignments.ts`, `excess.ts`, `hire-forms.ts`
- [x] Transactional hire form submission (`POST /api/hire-forms`)
- [x] Excess calculation engine (points tiers + referral trigger detection)
- [x] Dispatch gate check endpoint (`GET /api/assignments/dispatch-check/:jobId`)
- [x] Compatibility layer for existing allocations page
- [x] All shared TypeScript types

**Phase B — Drivers Page** ✅ COMPLETE
- [x] DriversPage.tsx — list, search, filters, add driver slide panel
- [x] DriverDetailPage.tsx — tabs: Details (editable), Files, Hire History, Excess History
- [x] "Drivers" in Vehicles nav submenu
- [x] Routes wired in App.tsx

**Phase C — Hire Form Repointing (Monday.com → OP backend)**
Existing hire form app is NOT being rebuilt — just repointing its data layer from Monday.com to OP.
**Full spec:** `docs/HIRE-FORM-REPOINTING-SPEC.md` — covers Monday.com board mapping, document validity backbone, routing engine, gap analysis, and migration plan.

*Phase C1: Database + Backend* ✅ COMPLETE
- [x] Migration `020_driver_hire_form_fields.sql` — document expiry dates, POA providers, insurance questionnaire booleans, identity gaps on `drivers` table
- [x] `driver-verification.ts` route — public-facing endpoints with own JWT auth (not OP user JWT):
  - `POST /api/driver-verification/auth/verify` — issue session JWT after OTP verification
  - `GET /api/driver-verification/status` — driver status + document validity (replaces `driver-status.js`)
  - `POST /api/driver-verification/next-step` — routing engine (replaces `get-next-step.js`)
  - `POST /api/driver-verification/update` — partial driver field updates (upsert, whitelisted fields)
  - `GET /api/driver-verification/check-hire-form` — check if hire form exists for job
  - `GET /api/driver-verification/driver-by-scan-ref?scan_ref=` — resolve driver email from iDenfy scanRef (Jul 2026, see "iDenfy identity resolution" below)
- [x] Auth: API key (`X-API-Key`), Bearer JWT (hire_form_session type), shared verification secret
- [x] Document analysis engine + routing engine ported from `get-next-step.js`
- [x] Mounted in routes/index.ts at `/driver-verification`
- [x] Env vars needed: `HIRE_FORM_VERIFICATION_SECRET`, `HIRE_FORM_API_KEY`

*Phase C2: Read path (OP vehicle module pages):* ✅ COMPLETE
- [x] Repoint `driver-hire-api.ts` — Monday.com GraphQL → OP backend (`GET /api/hire-forms/by-job/:id`)
- [x] Repoint `useDriverHireForms.ts` — follows automatically (imports from driver-hire-api)
- [x] OP backend returns data in `DriverHireForm` shape consumers expect
- [x] Hire form PDF generation backend service (`services/hire-form-pdf.ts`) + endpoint (`POST /api/hire-forms/:id/generate-pdf`)
- [x] PDF stored in R2, emailed to driver via email service
- [x] Quick-assign driver+vehicle button on Job Detail > Drivers & Vehicles tab (auto-populates job dates)
- [ ] Wire into BookOutPage, AllocationsPage, CheckInPage, CollectionPage (currently Job Detail only)

*Phase C3: Write path (standalone hire form app)* — IN PROGRESS
Netlify functions being repointed with `DATA_BACKEND` feature flag (default: `monday`, switch to `op` when ready):
- [x] `functions/op-backend.js` — shared helper with `opFetch()`, `opUpload()`, `isOpMode()`, retry logic
- [x] `driver-status.js` (v3.2) → `GET /api/driver-verification/status?email=` (returns "new driver" on 404)
- [x] `get-next-step.js` (v2.7) → `POST /api/driver-verification/next-step` (falls back to local routing + Monday.com on failure)
- [x] `validate-job.js` (v2.0) → `GET /api/jobs/:jobId` (falls back to Monday.com Q&H Board)
- [x] `send-verification-code`, `verify-code`, `create-idenfy-session`, `document-processor` — NO CHANGE
- [x] Netlify env vars: `DATA_BACKEND` (monday|op), `OP_BACKEND_URL`, `OP_API_KEY`
- [x] OP backend `POST /api/hire-forms` accepts API key auth (X-API-Key), camelCase field names, optional vehicle_id
- [x] OP backend excess: passed through from hire form app (not recalculated from excess_rules table)
- [x] **`monday-integration.js` `copy-a-to-b` action** — SUPERSEDED in OP mode. `POST /api/hire-forms` creates the assignment directly. No Board B needed. String→number coercion fixed (23 Mar 2026).
- [ ] **`SignaturePage.js` OP mode repointing** (hire form app side) — In OP mode, after signature:
  1. Call `POST /api/hire-forms` (already working — creates assignment)
  2. Call `POST /api/hire-forms/:id/generate-pdf` (OP endpoint exists, needs triggering from SignaturePage)
  3. Call `POST /api/hire-forms/:id/post-signature` (OP endpoint exists, needs triggering from SignaturePage)
  4. Confirmation email already handled by hire form app (no OP duplication needed)
- [x] **Post-signature automations (OP backend)** — `POST /api/hire-forms/:id/post-signature` BUILT:
  - Count `vehicle_hire_assignments` for job → count vehicles in HH → add additional driver charge (item 1324, £20+VAT per extra driver beyond 2 per vehicle)
  - Check if job is dispatched (HH status 5/6) → mid-tour driver flow:
    - Set hire_start to NOW (not original job start — driver shouldn't have been driving before form submission)
    - Send mid-tour notification email to team (bell notification + email)
    - Driver appears on Job Detail > Drivers & Vehicles with "Hire form complete — not yet booked out" status
    - Badge on Fleet page on-hire cards: "New driver pending" when assignment exists without book-out event
  - Return result summary (charges added, mid-tour detected, etc.)
- [ ] `generate-hire-form.js` (v5.6) → repoint to `POST /api/hire-forms/:id/generate-pdf` in OP mode (hire form app side)

*Phase C4: Go-live cutover:* ✅ LIVE (21 Apr 2026)
- [x] Set env vars on OP server (`HIRE_FORM_VERIFICATION_SECRET`, `HIRE_FORM_API_KEY`) — confirmed present
- [x] Run migration 020 on production (`npm run db:migrate`) — done
- [x] Repoint `SignaturePage.js` to OP endpoints — hire form Claude chained steps A→B→C: `POST /api/hire-forms` → `POST /:id/generate-pdf?send_email=true` → `POST /:id/post-signature`
- [x] `POST /api/hire-forms/:id/post-signature` built (additional driver charge + mid-tour notification)
- [x] `generate-hire-form.js` Netlify function: early 410 return in OP mode (redundant, OP endpoint replaces it)
- [x] **Hire form PDF generation trigger (21 Apr 2026):** PDF is now ONLY generated at book-out (when a real vehicle reg is known) or ad-hoc by staff via the "Generate PDF" button on Job Detail. Signature-time calls to `POST /:id/generate-pdf` from the hire form app chain return `skipped: true, reason: 'no_vehicle_assigned'` — no PDF, no email, no R2 pollution. The book-out trigger lives in the PATCH /api/hire-forms/:id handler: when `status` transitions to `booked_out` AND `vehicle_id` is set AND `hire_form_emailed_at IS NULL`, `generateAndEmailHireFormPdf(id, 'book-out')` runs in `setImmediate` and emails the driver the definitive agreement. NOT to be confused with the driver verification snapshot PDF (`driver-snapshot-pdf.ts`) which is an insurance-referral-specific document attached to the referral alert email — different artefact, different trigger.
- [x] Monday-fallback telemetry: `POST /api/driver-verification/telemetry/monday-fallback` on OP side + `reportFallback` helper in hire form app's `op-backend.js` → `hire_form_fallback_events` table + admin inbox notification + email to info@ (dedup per-operation-per-hour)
- [x] Migration 055: `hire_form_fallback_events` table
- [x] Excess gate override bug fixed: book-out now respects `job_excess.dispatch_override` (manager override previously recorded but didn't unblock)
- [x] `POST /api/hire-forms` response shape normalised — dedup path returns the same `{ data: { assignment: { id } } }` shape as fresh-create so SignaturePage's `copyResult.assignmentId` extraction is reliable
- [x] Flip `DATA_BACKEND=op` on Netlify production (21 Apr 2026, 14:00 BST)
- [x] Monday Board A driver migration: 145 new drivers + 1 updated via `backend/src/scripts/migrate-monday-drivers.ts` — upsert by email, derives `dvla_check_date` from `dvla_valid_until - 30d`, migrates "Manual review needed" from Monday overall_status into proper OP `requires_referral=true/status=pending` so staff can resolve via the existing Phase D2 referral panel
- [x] Monday Board A driver files migration: 857 files across 146 drivers via `backend/src/scripts/migrate-monday-driver-files.ts` — downloads assets via Monday GraphQL, uploads to R2 under `files/drivers/<uuid>/<tag>-<assetId>.<ext>`, appends to `drivers.files` JSONB with matching DriverDetailPage labels
- [x] `hire-forms/quick-assign`: searchable driver + vehicle pickers, vehicle is optional, active fleet only (`is_active=true AND fleet_group != 'old_sold'`), £1,200 floor (no longer reads excess_rules), absorbs HH derivation orphan records, implements top-N-drivers (additional drivers beyond van count → `excess_status='not_required'`)
- [x] Driver names on Job Detail > Drivers & Vehicles tab click through to DriverDetailPage
- [ ] Add "Generate Snapshot PDF" button on Insurance Referral panel (DriverDetailPage)
- [ ] Mid-tour driver surfacing: badge on Fleet on-hire cards + status on Job Detail Drivers tab
- [ ] Vehicle swap flow (see Phase D3 below)
- [ ] Monitor for 1-2 weeks, then remove Monday.com fallback code

**iDenfy identity resolution + same-origin return URLs (Jul 2026, Mae/mae-hill.com incident):**
Two hire-form-app bugs fixed together — full detail in the hire form repo's CLAUDE.md (`ooosh-driver-verification-`).
- **Never derive a driver's email from the iDenfy clientId.** The clientId encoding is lossy (strips chars outside `[a-z0-9_]` — hyphens pre-fix, still `+`/apostrophes), so the webhook decoded `team@mae-hill.com` as `team@maehill.com` and find-or-created a **phantom driver record**; the real record never got the licence data and the router looped the driver back into iDenfy forever. Convention now: `create-idenfy-session.js` writes the scanRef onto the OP driver row keyed by the RAW email (via `POST /driver-verification/update`); `idenfy-webhook.js` resolves the authoritative email via `GET /driver-verification/driver-by-scan-ref` (clientId decode kept only as fallback for in-flight sessions / OP outage). Watch for phantom records (same driver, hyphen-stripped email variant) if the fallback ever fires for a dash-domain driver on a pre-fix session.
- **iDenfy success/error URLs must be same-origin with the driver's browser.** The app serves on BOTH `hireforms.oooshtours.co.uk` (what OP's hire-form emails link to) and `ooosh-driver-verification.netlify.app`, with no redirect between them; the session token lives in per-origin sessionStorage. The return URLs were hardcoded to netlify.app, so hireforms-origin drivers came back tokenless → driver-status 401 loop → the "spinning wheel of death" (ProcessingHub also now stops polling on 401 and offers re-verification, and the processing-hub URL handler validates the session like every other step).

**Phase C5 — VE103B Certificate Generation** ✅ COMPLETE (9 Apr 2026)
VE103B is a UK document authorising a named driver to take a hired vehicle abroad. Printed as text-only overlay onto pre-printed official forms. Replaces manual process + Google Sheets log.
**Full spec:** `docs/VE103B-SPEC.md`

- [x] Migration 040: `ve103b_certificates` table (cert number, vehicle/driver/job links, status lifecycle, PDF storage, BVRLA fields)
- [x] PDF overlay generation (`services/ve103b-pdf.ts`) — pdf-lib, calibrated coordinates matching existing Netlify function exactly
- [x] Calibration mode via `VE103B_CALIBRATION_MODE=true` env var (guide lines for alignment testing on plain paper)
- [x] API route (`routes/ve103b.ts`): generate, test-generate (manual entry), void, list, get, download PDF, BVRLA CSV export
- [x] Trigger from book-out flow — VE103B track fires in parallel when cert number entered, generates for lead driver only (not all drivers)
- [x] `ve103b_ref` write-back scoped to lead driver's assignment only (other drivers don't get the cert number)
- [x] Manual/standalone generation from VE103B Certificates page (vehicle picker + driver name/address entry)
- [x] Email PDF to `info@oooshtours.co.uk` on generation
- [x] PDF stored in R2 (`ve103b/{reg}/{filename}`)
- [x] Certificate tracking replaces Google Sheets log — unique cert numbers, issued/void lifecycle
- [x] BVRLA monthly report: auto-emailed CSV on 1st of each month at 08:00 to `will@` CC `jon@`
- [x] BVRLA report includes voided certs with "VOID" in REG. NO. column
- [x] Certificate browser page at `/vehicles/ve103b` — table, search, filter pills, void action, PDF download, BVRLA report download
- [x] VE103B badge on Job Detail > Drivers & Vehicles assignment cards
- [x] Escape key closes modals
- [x] BVRLA Member Number hardcoded as `10864`
- [ ] IRL end-to-end testing via actual book-out flow (when hire form system is live)

**Phase D — Allocations Migration** ✅ MOSTLY COMPLETE
- [x] Switch AllocationsPage to read from `vehicle_hire_assignments` (compat layer)
- [x] Keep compatibility API for existing book-out/check-in flows
- [x] Book-out flow: driver selection from hire forms, token refresh, draft autosave
- [x] Compat layer persists driverName (notes column + driver_id lookup), debounced input (23 Mar 2026)
- [x] LEFT JOIN fleet_vehicles across all assignment/hire-form queries (nullable vehicle_id support)
- [x] Compat layer cancel includes hire-form-created assignments (was excluding them, causing "remove" to re-attach)
- [x] Removed DebouncedDriverInput from Allocations — linked driver shown read-only from hire form data
- [ ] Remove R2 allocation writes (R2 becomes read-only fallback)

**Phase D1.5 — Job Detail cockpit for self-drive lifecycle** ✅ COMPLETE (28 Apr 2026)
Replaces the prominent "+ Assign Driver" Quick Assign button with per-card next-action buttons that drive the whole self-drive lifecycle from Job Detail without leaving the page. The hire-form URL is the primary path for joining drivers to a hire (auto-emailed T-10 days, manually chase-able from the Job Requirements vehicle card); Quick Assign survives only as an admin/manager-only "+ Add driver manually" subtle text link for the rare "someone slipped through the net" case.

- [x] Per-card state-aware next-action button on each Drivers & Vehicles assignment card. Self-drive only; D&C / driven lifecycles stay in Crew & Transport:
  - `soft`/`confirmed`, no van → **🚐 Allocate Van** (deep-links `/vehicles/allocations?job=<hh>`, job auto-expanded + scrolled into view + page filter forced to `'all'` so jobs beyond the current week are still visible. AllocationsPage's data-fetch lookahead is 30 days; deep-links to jobs further out won't surface — they need the page opened directly with the filter set wider, or a future on-demand widening.)
  - `soft`/`confirmed`, van linked, van still in the warehouse → **📋 Book Out** (deep-links BookOutPage with `?vehicle=&job=` pre-fill)
  - `soft`/`confirmed`, **the van is already `booked_out`/`active` on this job** → **🚐 Add to Hire** (mid-tour link, no walkaround). ⚠️ Keyed on *"is the van already out?"*, NOT *"has this driver got a van?"* — quick-assign offers a vehicle picker, so a late driver added to a departed van arrives WITH a `vehicle_id`; the original `!a.vehicle_id` test skipped this branch and offered Book Out, inviting a walkaround on a van 200 miles away, while the backend rejected the same case with a 400 (job 16291, Aug 2026). The backend now refuses only a move to a *different* van — that is Swap Vehicle's job.
  - `booked_out`/`active` → **↩️ Check In** (deep-links CheckInPage with `?vehicle=` pre-fill)
  - `returned`/`cancelled`/`swapped` → no button, status badge only
- [x] Sibling-staff-allocation inference: when a hire-form-driven row has `vehicle_id IS NULL` but a separate staff-allocation row on the same `van_requirement_index` has a vehicle, the card surfaces "Book Out" (not "Allocate Van") pointing at the inferred vehicle. `loadVehicleAssignments` does two parallel fetches (`?job_id=` + `?hirehop_job_id=`) and composes `effective_vehicle_id` per row. BookOutPage's PATCH cements the link at submit time.
- [x] Quick Assign demoted: prominent primary button → subtle "+ Add driver manually" text link, gated to admin/manager only, tooltip explains when to use. Modal flow itself unchanged — still `/api/hire-forms/quick-assign` on the backend.
- [x] Send / Chase hire form button untouched (lives on Job Requirements vehicle card, mid-tour use case preserved).

**Drivers & Vehicles tab — "Vehicles on this job" strip + card layout convention (Jul 2026).** The reg is shown **once**, in a header strip at the top of the tab — NOT repeated prominently on every driver card. The strip (`JobDetailPage.tsx`) lists every distinct van allocated to the job, deduped across **all** assignment rows **including driverless staff-allocation rows** that never surface as a driver card (a van picked on Allocations before a driver is bucketed onto its slot — previously invisible on the job card). Source: `jobAssignedVehicles` state, built in `loadVehicleAssignments` from the raw `allRows` (the shaped/displayed `vehicleAssignments` filters those driverless rows out, so DON'T derive the strip from it). Each HH-detected van type with no van allocated shows a dashed **"<type> — unassigned"** chip (detected slots from `hhSyncResult…vehicle_slots` minus assigned, matched via the `normVanType` helper). Strip chips are links: assigned → `/vehicles/fleet/:id` (Vehicle Detail); unassigned → `/vehicles/allocations?job=<hh>` (a shortcut — allocation itself stays per driver-slot, so a chip can't one-click assign). Per-driver cards therefore carry **no reg at all** (since every driver on a job can drive any van on it, a per-card reg conveyed nothing meaningful and just repeated on every card — the strip is the single source, and Book Out / Check In read the van off the row internally via `effective_vehicle_id`, never from a visible chip). Cards lead with the driver name (no "DRIVER" label) and fold the excess (£ / status / Edit / Manage) inline to the right of the name (`flex-col` on mobile so long names don't wrap mid-word, `sm:flex-row` inline on desktop). Hire-form actions (Generate PDF / +Email / View / Re-send) are collapsed into a **"Hire form ▾"** dropdown so the state-aware primary button (Allocate / Book Out / Check In) stays the focus. **Don't re-add a prominent per-card reg** — the strip is the single source. On the **Overview** vehicle requirement card (`RequirementCard.tsx`): the allocated reg(s) + seat config (Round a table / Forward-facing) live on the **headline** ("Vehicle — RO23HLU  🔄 Round a table"), the headline mode qualifier shows **only for mixed jobs** (pure self-drive/V&D rely on the per-slot toggles — don't say "Self-Drive" twice), the prep estimate is right-aligned to use the card's width, and the old "which fleet vans already have this layout / need turning" reg cross-reference was **removed** (staff found the unrelated regs confusing). `RequirementCard` takes `assignedVehicleRegs` (threaded from `JobPrepChecklist`); the legacy `seatAvailability` prop is kept in the type but unused.

**Van prep-readiness pill on the strip + dashboard Today (Aug 2026).** Each allocated van in the "Vehicles on this job" strip AND on the dashboard "Going Out Today" rows shows a small prep-status pill derived from `fleet_vehicles.hire_status` (the cached physical-readiness projection — "is this van clean/checked, or full of litter from the last hire?"). Shared helper `frontend/src/lib/vehiclePrep.ts` `vehiclePrepPill(hireStatus)` is the single source so the two surfaces can't drift — **only two states render a pill: `Prep Needed` → amber "Prep needed", `Available` → green "Ready"; every other state (`On Hire` / `Not Ready` / `Sold`) returns null (just the reg, no pill).** "On Hire" is deliberately dropped — jon's call, it reads as clutter on a going-out row. The **dashboard** side needs a backend piece: `routes/dashboard.ts` enriches `today.going_out`/`returning` via `attachVehicles` (distinct allocated vans per job, dual-match join `vha.job_id OR hirehop_job_id`, status `IN ('soft','confirmed','booked_out','active')`, `[Suspended:` filter on the van-required check) → `vehicles[]` + `van_unassigned` on each `ScheduleJob`; the Today section renders reg `+N` for multiples and a faint "🚐 van unassigned" (going-out only) when a job has a live pre-hire `vehicle` requirement but no allocation. Returning rows show reg only (no prep pill — prep isn't the question on the way back). **Any new surface showing an allocated van's prep state MUST use `vehiclePrepPill`** rather than hand-writing the states, and MUST NOT re-add "On Hire" as a pill.

**Staggered multi-van job discovery (Jun 2026).** A job with more than one van whose vans leave on **different days** must stay reachable in the book-out + allocation pickers after the first van has gone out. The trap: a job has a single `out_date`, so once van 1 leaves, `out_date` is in the past — and both job-discovery endpoints (`GET /api/vehicles/jobs/going-out` → Fleet ▸ Van ▸ Book Out picker; `GET /api/vehicles/jobs/upcoming` → Allocations "Going Out") window strictly on `out_date >= today`, dropping the job and making the remaining van unbookable except via the BookOutPage "enter job # manually" escape hatch. **Incident: job 15411 (Jabir – HLR & HLU), Jun 2026** — RO23HLR out day 1, RO23HLU collected day 2, only HLR showed. The recent multi-van work was all in the slot/assignment layer (assignment rows, allocation cascade, per-card buttons), which operates on a job you can already *see*; this is one layer upstream in job discovery, which had assumed a job goes out on one day. **Fix:** both endpoints also retain a job that has already started (`out_date < today`), isn't back yet (`COALESCE(return_date, job_end) >= today`), is still `ACTIVE_STATUSES`, AND still has a van slot in a pre-book-out state — a `soft`/`confirmed` `vehicle_hire_assignments` row found via the **dual-match join** (`vha.job_id = j.id OR vha.hirehop_job_id = j.hh_job_number`, because staff-allocation rows carry only `hirehop_job_id` until a hire form is submitted). Mirrors the `/jobs/upcoming-due-back` widening pattern. **Don't re-window these queries to a plain `out_date >= today`** or you reintroduce the bug. Limitation: this keys off an *existing* un-booked-out assignment row for the late van (the common case — vans are pre-allocated/hire-formed); a started multi-van job where the second van has *no* assignment row at all still relies on the manual-entry fallback. The "enter job # manually" field stays as belt-and-braces.

**Deferred from this pass:**
- [ ] **Inline "Allocate Van" modal scoped to job** — replaces the AllocationsPage hop with a focused job-context picker, conflicts hidden rather than warned, single-modal sibling cascade. Decided 28 Apr 2026 the AllocationsPage hop is acceptable for now (`?job=` auto-expand makes it close to one click). Revisit when the inline experience starts hurting.
- [ ] **Slot-grouped cards (one card per van with sibling drivers nested)** — captured below as the Allocations van-centric rebuild item. The Job Detail cockpit currently still renders one card per driver-bearing assignment row, which over-counts when multiple drivers share a van. Both Allocations and Job Detail should pick up the same slot-shaped rebuild together.
- [ ] **Auto-cascade staff allocations onto matching hire forms at hire-form arrival** — today the cascade is a manual click on AllocationsPage. Could be backend-side: when POST /api/hire-forms creates an assignment for a job that already has a staff allocation on the matching `van_requirement_index`, automatically inherit the `vehicle_id`. Removes the temporary "Allocate Van" surfacing entirely for the common case. Not pressing.

**Phase D2 — Insurance Referral Workflow** ✅ COMPLETE (23 Mar 2026)
Joined-up referral management: flag → email → review → resolve → date extension.

- [x] Referral action panel on DriverDetailPage: shows reasons, status, resolve form
- [x] `POST /api/drivers/:id/resolve-referral` — approve/decline with date extensions + adjusted excess
- [x] Contextual warning banner: amber (pending), green (approved), red (declined)
- [x] Referral email notification (`referral_alert` template) on hire form submission when `requires_referral=true`
- [x] Driver verification snapshot PDF generation (`driver-snapshot-pdf.ts`) — ported from Monday.com Netlify function
- [x] **Snapshot document matching — tag/label variants (Jul 2026 fix).** `loadDriverDocuments` used to match each file against an exact-string label map (`'licence front'`, `'poa 1'`, …). The live hire-form / iDenfy upload path writes tags like `licence_front` and labels like `license_front` / `poa1` (American spelling, underscores, no spaces — the Monday migration used yet another form, `Licence Front` / `POA 1`). So snapshots silently dropped the licence + POA images; only `passport` / `signature` happened to match (Adam Coelho / job 16063 incident). Now matches on a NORMALISED token (lowercase, strip non-alphanumerics) against `tag` first then `label`, via `DOC_MATCH_TOKENS` — mirrors the frontend `DriverDetailPage` `DOCUMENT_CATEGORIES` fileLabels lists. **Kept as a backend module, NOT a `shared/` constant:** the backend doesn't import `shared/` at runtime (its `rootDir` excludes `../shared`), so a shared value would need build-config surgery. **Moved out of this file into `services/driver-documents.ts` (Sep 2026)** when the staff cockpit needed the same lists to answer "is this document on file" — a third copy would have been the same drift again. The snapshot now calls `resolveDocumentKey()`. Only `filesForSlot()` on the frontend still mirrors it; keep the two in step when a new upload path invents another variant.
- [x] Snapshot PDF attached to referral notification email
- [x] Date extension on approval: mirrors driver's existing dates exactly. **Empty stays empty** — no `today` / `today+90d` fallbacks. Backend skips empty values on the UPDATE so blank pickers leave the underlying date untouched. Stops staff inadvertently fabricating a check date that never happened (e.g. DVLA date for a non-UK driver) or shortening an existing future date by accepting a defaulted "today" without realising. Pre-May 2026 the form pre-filled today / today+90d on every null field — flagged by Mads Antonsen referral 7 May 2026 (HH 15207) where DVLA picker showed today's date for a non-UK driver. Help text reads "Mirrors the driver's current dates — leave blank to leave a date untouched."
- [x] Adjusted excess field on resolution (for insurer-imposed excess increases, stored on `job_excess` records)
- [x] Audit trail for referral resolution (`resolve_referral` action in audit_log)

**Referral status hierarchy (May 2026, after `referral_status='pending'` initial-write fix):**

| `requires_referral` | `referral_status` | Pill | Colour | Meaning |
|---|---|---|---|---|
| `true` | `NULL` | Refer to Insurers | red | TODO — flagged but no-one's actioned anything yet |
| `true` | `'pending'` | Referred & Waiting | amber | Insurer email sent, awaiting reply |
| `false` | `'approved'` | Approved | green | Referred, insurer approved |
| `false` | `'waived'` | Approved | green | Staff judgement — no referral needed (e.g. no-fault accident) |
| `true` | `'declined'` | Not Approved | red | Referred, insurer declined |

**The transitions:**
- Hire form submission with `requires_referral=true` → `referral_status` stays NULL (red Refer to Insurers todo state). Pre-May 2026 `routes/hire-forms.ts` was setting `'pending'` here, jumping the queue and making it look like staff had already actioned something they hadn't. The `referral_alert` email still fires from `requires_referral=true`, independent of `referral_status` (see the "referral alert" note below).
- **⚠️ `POST /api/driver-verification/update` MUST NEVER write `referral_status` / `referral_date` (Jul 2026 fix).** The standalone hire-form app sends `referralStatus: 'pending'` (pre-fix behaviour that was never corrected on the app side); `driver-verification.ts` used to whitelist those two columns and write them verbatim, so a driver whose flow terminated at `driver-verification/update` (a known intermittent gap where `POST /api/hire-forms` never runs) leaked a false amber "Referred & Waiting" when nobody had referred anything. Both columns are now stripped from the `allowedFields` whitelist (and the `referralStatus`/`referralDate` field-map entries removed), so the app can only set `requires_referral` + `referral_notes` — mirroring `hire-forms.ts`, which never writes `referral_status`. Meadham / HH 16330 incident.
- Staff clicks "Mark as Referred to Insurer" on DriverDetailPage → `referral_status='pending'`, `referral_date=today` (audit of when the email actually went out). Button only renders when `referral_status IS NULL`.

**Referral alert email — idempotent, three trigger paths (Jul 2026, migration 186).** The `referral_alert` email (driver snapshot PDF attached, to info@ + will@ via `getVehicleNotificationTargets`) lives in **`services/referral-alert.ts` `sendReferralAlert(driverId, opts)`** — the single sender. It's fired from THREE places, deduped by `drivers.referral_alert_sent_at` (a conditional-UPDATE claim before the send; the claim is released on send-failure so a retry / later path can re-attempt):
  1. **`POST /api/hire-forms`** — full form submitted (was the ONLY path pre-fix).
  2. **`POST /api/driver-verification/update` signature step** — fired when `signature_date` is set, self-gated on `requires_referral` (no-op otherwise). **This is the path that was missing:** a driver whose SignaturePage chain reached only `driver-verification/update` set the flag + got a Will-addressed *bell* (`fireReferralNotification`, no email) but no info@ email ever went out. Catches the case where the flag was set in an *earlier* update and the signature lands later (the exact Meadham timeline).
  3. **Daily 09:18 safety-net scanner** (`runReferralAlertScan`, `config/scheduler.ts`) — sweeps `requires_referral=true AND referral_alert_sent_at IS NULL AND signature_date >= today-14d` and fires the alert for any that both paths above missed.
  **Do NOT re-add a local referral-alert sender** in `hire-forms.ts` or elsewhere — route every send through `sendReferralAlert` so the once-only claim holds across all paths. `fireReferralNotification` in `driver-verification.ts` stays as the early *bell-only* nudge (mid-flow visibility for the vehicle manager) and deliberately sends no email.
- Staff resolves via "Resolve Referral" form → one of three outcomes:
  - `'approved'` (insurer said yes): clears `requires_referral`, `insurance_status='Approved'`, allows date extensions
  - `'waived'` (no referral needed): same effect as `'approved'` but distinct in `referral_status` for audit clarity. UI label "Approved without referral (waived)"
  - `'declined'` (insurer said no): keeps `requires_referral=true` so the "Not Approved" red pill stays accurate, `insurance_status='Failed'`, no date extensions

**`'waived'` design rationale:** Forging "Approved by insurer" when staff judgement was actually "no referral needed" loses the audit. Distinct enum value preserves "yes we noticed the flag, here's why we cleared it without contacting the insurer" in `referral_status` + `referral_notes`. Clears `requires_referral=false` so downstream UX (assignment guards, `deriveDriverStatus` fall-through to default green Approved) treats the driver as a normal approved hire — same operational effect as `'approved'`, only the audit trail differs. Defensive `'waived'` branch in `deriveDriverStatus` renders "Approved (Waived)" green pill if a row ever surfaces with `requires_referral=true && referral_status='waived'` (shouldn't happen post-resolve, but covers any weird state).

**Resolution form button:** label + colour branch on `outcome` value — `'declined'` is red "Decline Referral", everything else (approved, waived) is green ("Approve Referral" / "Approve (Waive Referral)"). Mirror the same gating on any future outcome additions; defaulting unknown outcomes to red makes the form look hostile to clean resolutions (the original "Approved by insurer | Decline by insurer" branched on `outcome === 'approved'`, leaving waived stuck on the red button until 7 May 2026).

**Snapshot PDF UI:**
- [ ] "Generate Snapshot PDF" button on Insurance Referral panel (DriverDetailPage) for drivers with `requires_referral = true`
- [x] Backend: `driver-snapshot-pdf.ts` service already built
- [ ] Wire button → call snapshot endpoint → download/attach PDF

**Future referral integration (not yet built):**
- [ ] Dashboard widget: "X drivers awaiting referral" with click-through to driver list
- [ ] Pipeline/Job Detail: referral status shown per-job where driver has pending referral (blocks dispatch)
- [ ] `post-signature-notifications.js` repointing: currently reads from Monday.com to check referral — needs OP backend repoint (reads from driver-verification status endpoint instead)
- [ ] Excess module integration: adjusted excess from referral resolution flows into excess tracking/payment portal

**Phase D2b — Per-driver referral gate at book-out ✅ SHIPPED (Jul 2026)**

**Motivation incident (29 Jul 2026, HH 15075 "My Generation - Van hire"):** 1 van (RO23HLV), 3 drivers. James O'Dell + Sam Bryant approved; **Joseph Hilton `requires_referral=true, referral_status='pending'`** (Referred & Waiting — insurers not yet responded). The van was correctly booked out on the two approved drivers, but Joseph **also** got a Vehicle Condition Report AND a "Your vehicle hire agreement for RO23HLV" email (confirmed in Resend) — i.e. the system treated a driver we're not yet cleared to insure as authorised. jon's rule: **"so long as we have one driver verified we can book out, but a referral-pending driver shouldn't be included automatically."**

**Root cause: there is NO referral gate anywhere on the physical book-out path.** The only "gate" signals are informational and enforce nothing:
- `POST /api/assignments/:id/book-out` (`assignments.ts` ~483) pushes `"Driver referral pending"` into a `warnings[]` array then books out regardless.
- `GET /api/assignments/dispatch-check/:jobId` returns `canDispatch: true` always (feeds the amber `ExcessGateBanner` "referral pending" text — a nudge, not a block).
- `PATCH /api/hire-forms/:id → booked_out` (the path BookOutPage actually uses) has **no referral check**; it fires `firePostBookOutHooks`, which emails the agreement.
- The ONLY hard referral gate in the codebase is `hire-forms.ts` `/quick-assign` (~880) — a different entry point Joseph didn't come through.

**How the agreement reached Joseph:** `firePostBookOutHooks` emails a hire agreement per-driver via two paths, **neither of which filters on referral status**:
1. **Own-van** `generateAndEmailHireFormPdf(assignmentId)` (`hire-forms.ts` ~2034) — fires per booked-out assignment. **This is the path that emailed Joseph** (on a single-van job all drivers share the one van, so the fan-out below is a no-op and the own-van path emails everyone).
2. **Cross-van fan-out** `fanOutVanHireForms` → `generateAndEmailCrossVanHireForm` (~2159) — targets signed self-drive drivers on a *different* van (`vehicle_id IS DISTINCT FROM` the booked-out van). No-op on single-van jobs; the leak path on **multi-van** jobs.

**The design (agreed with jon):** book-out is **per-van** (the van legitimately goes out on its approved drivers); a referral is **per-driver**. So gate the *paperwork/authorisation* per driver, never the whole van. Model it on the existing **mid-tour driver flow** — a referral-pending driver is "held back" and authorised later exactly like a driver whose hire form lands after book-out.

- **Referral-authorised set:** a driver may receive an agreement / be treated as authorised only when `referral_status IN ('approved','waived')` OR the driver was never flagged (`requires_referral=false`). `'waived'` counts (jon's flag — downstream UX already treats it as approved). A driver with `requires_referral=true AND referral_status NOT IN ('approved','waived')` is **held back**.
- **The skip guard lives in BOTH agreement generators** (own-van + cross-van), NOT only one — single-van jobs leak via own-van, multi-van via fan-out. Cleanest shape: one shared helper `isDriverAuthorisedForAgreement(assignmentId)` called at the top of `generateAndEmailHireFormPdf` AND `generateAndEmailCrossVanHireForm`. **Return a distinct `'held_back'` sentinel, never `'failed'`** — a deliberate skip must not trip `runHookWithRecovery`'s retry/alert (which treats `'failed'` as a transient error). For the own-van path, check BEFORE the atomic `hire_form_email_claimed_at` claim so a later authorise can re-fire cleanly (no burnt claim). The Condition Report send path (`/send-condition-report` recipients loop) needs the same per-recipient filter so a held-back driver gets neither artefact.
- **Held-back driver keeps a distinct card state** on Drivers & Vehicles — "⏳ Referral pending — not authorised to drive" — visibly ON the job (NOT deleted), keying off `drivers.requires_referral`/`referral_status` (confirmed: Joseph's pending state lives on the `drivers` row; his `job_excess` row is untouched `not_required` £0). This is a card-render change only — no new column needed (the pending state is already on `drivers`).
- **Authorise action (mid-tour rails):** on referral resolution to `approved`/`waived`, staff get a one-click "Authorise & send agreement" on that card. It: stamps `hire_start = NOW()` (the driver wasn't authorised to drive during the wait — same as the mid-tour `post-signature` branch), fires the agreement via `generateAndEmailHireFormPdf` for that one assignment, and drops the mid-tour-style team notification. Human-in-the-loop (staff click confirms the insurer actually cleared them) — do NOT auto-fire on resolution.
- **Increased-excess-on-referral is a warning at authorise time, never an auto-bump.** The referral-resolution form already writes an insurer-imposed adjusted excess to `job_excess` (Phase D2). Top-N is deliberately NOT auto-recomputed (documented design — money may already be collected). So on 15075: Joseph currently `not_required` £0 (James holds the single £1,200 slot). If Joseph resolves at £1,800 he becomes the new top-1 and the job excess *should* rise to £1,800 (£600 top-up). The authorise step **surfaces the recomputed top-N figure vs what's held** and lets staff collect/decide — consistent with the OP convention (excess is a warning, not a hard gate; book-out itself is non-blocking on excess). Never silently move money; on multi-van jobs a bumped driver only changes the job total if they'd land in the top-N.

**Build checklist (all shipped):**
- [x] `isDriverAuthorisedForAgreement(assignmentId)` shared helper in `hire-forms.ts` (`requires_referral && referral_status NOT IN ('approved','waived')` → held back; **fails OPEN** — a missing assignment/driver row returns authorised, since that's a data gap not a referral hold, and the referral-alert path surfaces genuine pending referrals loudly elsewhere).
- [x] Guard at top of `generateAndEmailHireFormPdf` (own-van, `Promise<void>`) — early `return` (void) BEFORE the atomic `hire_form_email_claimed_at` claim, so a later authorise re-fires cleanly (no burnt claim). Void early-return is the "held_back" equivalent for a void fn — `runHookWithRecovery` only retries on a THROWN error, so a deliberate skip never trips retry/alert.
- [x] Guard at top of `generateAndEmailCrossVanHireForm` (cross-van fan-out) — returns the distinct `'held_back'` sentinel (union widened to `'sent' | 'skipped' | 'failed' | 'held_back'`) BEFORE the `hire_form_documents` INSERT claim. `fanOutVanHireForms` only escalates `=== 'failed'`, so `'held_back'` never throws/retries.
- [x] Per-recipient filter in `vehicles.ts` `/send-condition-report` — resolves the job's held-back drivers (by email + `full_name`, dual job-match on `hirehop_job_id`/`hh_job_number`) once, skips any matching recipient with a "Referral pending — withheld" result line. Held-back driver gets neither the agreement nor the condition report.
- [x] Held-back card state "⏳ Referral pending — not authorised to drive" on JobDetailPage Drivers & Vehicles (render-only, off the assignment row's `requires_referral`/`referral_status`, aliased `driver_requires_referral`/`driver_referral_status` from `assignments.ts` `BASE_SELECT`). Suppresses the Allocate/Book Out/Soft-Book-Out CTAs while held back.
- [x] "✅ Authorise & send agreement" action (`POST /api/hire-forms/:id/authorise-agreement`, MANAGER_ROLES) — shows on a card once `referral_status IN ('approved','waived')` AND no agreement produced yet (`!hire_form_pdf_key`) AND a van is linked. Stamps `hire_start = NOW()` (mid-tour rails), fires `generateAndEmailHireFormPdf` for that one assignment, drops a mid-tour-style team bell to the vehicle manager. Human-in-the-loop — NOT auto-fired on resolution.
- [x] Authorise step surfaces excess required vs held in the response (`results.excess = { requiredTotal, heldTotal, outstanding }`, summed over non-terminal `job_excess` on the job); the frontend alerts a "£X outstanding — collect on the Money tab if needed" heads-up. Warning only, NEVER an auto-bump. **⚠️ This is NOT a top-N recompute** (it was described as one until Sep 2026): it sums the records that are ALREADY chargeable and excludes `not_required`, so a higher-liability driver sitting at £0 is invisible to it. Genuine top-N ranking lives in `services/excess-topn.ts` — see "Top-N excess reconciliation" below.

**Conventions worth remembering:**
- **The referral gate lives in `isDriverAuthorisedForAgreement` — route ALL new agreement/authorisation surfaces through it** (both agreement generators + the condition-report loop already do). Don't re-derive `requires_referral && referral_status NOT IN (…)` inline.
- **`'waived'` counts as authorised** everywhere (matches `deriveDriverStatus` + the resolve-referral flow).
- **Book-out stays per-VAN, non-blocking.** The gate withholds only the per-driver PAPERWORK/authorisation — the van still goes out on its approved drivers. A held-back driver stays visibly ON the job (card render off `drivers` fields; no new column).
- **Never auto-bump excess on authorise.** The referral-resolution form already writes any insurer-imposed adjusted excess to `job_excess`; the authorise step only SURFACES the recomputed top-N vs held so staff decide whether to collect.

**Phase D3 — Vehicle Swap (Breakdown / Reallocation)** ← IN PROGRESS (May 2026)
When a vehicle breaks down mid-hire and needs swapping to a replacement.

**Full spec:** `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md` — covers the swap UI, the soft check-in primitive (also used by the future freelancer-led handover), Job Issues integration, the orphan dedup root-cause fix, and the sweeper script. Read it before touching swap code.

**Motivation incident (15 May 2026, HH 15378):** staff tried to swap a brake-faulty van for RO23HLU; the swap was blocked because an orphaned `confirmed` `vehicle_hire_assignments` row from a previous hire (15613) still "occupied" HLU in the overlap check, even though the real hire had been checked in hours earlier. Root cause = dual-row pattern (staff-allocation row + hire-form row) not deduplicated at staff book-out time.

*PR 1 — Foundation + cleanup (shipped May 2026):*
- [x] **Orphan dedup — two layers** (`services/vha-dedup.ts`):
  - `cancelOrphanSiblingAllocations()` fires at **book-out** (`PATCH /api/hire-forms/:id` + `POST /api/assignments/:id/book-out`). Cancels sibling staff-allocation rows (**`driver_id IS NULL`**, never booked out, soft/confirmed) for the same (vehicle, job) once a hire-form row owns the van. Conservative guard — never cancels a real second driver pending their own book-out.
  - `cancelStaleVanAllocationsOnReturn()` fires at **check-in** (save-event check-in side-effect + `POST /api/assignments/:id/check-in`). Cancels ANY soft/confirmed + `booked_out_at IS NULL` row on the same (vehicle, job) — **driver-agnostic**, because once the van's back the hire is over and nothing un-booked-out is going anywhere. This is the actual prevention for the 15613/HLU incident: that orphan carried a `driver_id`, so the book-out dedup alone would have missed it (confirmed against live data — the sweeper found 0 because the row had already been hand-cancelled, but it had a driver_id).
- [x] **Soft check-in primitive** — `save-event` handles `eventType='soft-check-in'`: sets `fleet_vehicles.hire_status='Not Ready'` (sticky, preserved by the final `syncFleetHireStatusByReg` reconcile), does NOT flip assignment status (caller owns that), no HH writeback, no close-out requirements. Mileage logged generically. `buildConditionReportPdf` gains an `isInterim` flag → "INTERIM VEHICLE ASSESSMENT" title, context banner, no signature block, `-interim.pdf` filename.
- [x] **Sweeper script** — `scripts/cleanup-orphan-vha-rows.ts` (dry-run default, `--commit`, `--vehicle=REG`, `--job=HHNUM`). Cleans historical orphans the live dedup pre-dates — both pure staff-allocation rows (`driver_id IS NULL`) and driver-bearing rows whose sibling has `returned`. Soft-cancel + fleet status re-sync. Idempotent.

*PR 2 — Swap UI (shipped May 2026):*
- [x] "Swap Vehicle" button on Job Detail > Drivers & Vehicles tab — only on `booked_out`/`active` cards with a van linked, gated to `admin`/`manager`/`weekend_manager` (frontend role check + backend `authorize('admin','manager','weekend_manager')` on the route)
- [x] Swap modal: reason picklist + details, replacement van picker, soft check-in fields (mileage/fuel/location/notes, all optional), Job Issue link-or-create section (defaults to first open issue on the van, else create-new)
- [x] Multi-driver auto-cascade — backend swaps EVERY occupying assignment sharing the old van on the job (target row + siblings) to the new van in one call; excess copied per row
- [x] `POST /api/assignments/:id/swap-vehicle` extended: `soft_checkin` + `issue_link` payloads, sets old van `fleet_vehicles.hire_status='Not Ready'`, logs soft-checkin mileage, links/creates `job_issues` (via shared `services/job-issues.ts`) with a `swap_logged` event, posts HH job memo note, logs a `🔄 Vehicle swapped` job-timeline interaction. Returns `redirect_to` (BookOut for the replacement), `issue_id`, `ve103b_regen_needed`.
- [x] Frontend post-submit redirect → BookOutPage for the replacement van (`redirect_to` from the response)
- [x] VE103B: detects `ve103b_ref` on any swapped row → returns `ve103b_regen_needed` + flags the user to generate a new cert manually (can't auto-regen — a new pre-printed cert number is required). NOT auto-generated.
- [x] Both assignments visible in driver Hire History (original → `swapped`, replacement created)
- [x] Migration columns `swap_reason`, `swapped_at`, `swapped_to_assignment_id` already existed — no migration needed
- [x] Shared `services/job-issues.ts` extracted (logIssueEvent / notifyIssueRecipients / getDefaultVehicleIssueWatchers / createJobIssue); `routes/problems.ts` refactored to import them — one source of truth for issue create + event + notify

*Deferred from PR 2 (deliberate, noted in spec §2):*
- [ ] **Auto-generated Interim Assessment PDF + vehicle Event-History entry for the swapped-out van.** The soft check-in's durable effects (Not Ready, mileage log, soft-checkin data on the Job Issue + job timeline) all happen, and the `isInterim` PDF variant + `save-event` soft-check-in branch exist (PR 1). The swap endpoint just doesn't fire them — the breakdown's system of record is the Job Issue. Wiring the interim PDF into the swap flow (or surfacing a "Generate interim PDF" button on the issue) is a small follow-up.
- [ ] Client notification of vehicle change

*Immediate follow-on after PR 2:* freelancer-led interim check-in UI (reuses the soft check-in primitive shipped in PR 1 — see spec §6 + §9).
