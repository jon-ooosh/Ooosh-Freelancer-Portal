---
paths:
  - "backend/src/routes/{drivers,hire-forms,driver-verification,assignments,ve103b}.ts"
  - "backend/src/services/{driver-*,identity-review,referral-alert,unsigned-hire-form-nudge,hire-form-*,vha-dedup,assignment-overlap,excess-topn}.ts"
  - "frontend/src/pages/{DriversPage,DriverDetailPage}.tsx"
  - "frontend/src/lib/driverStatus.ts"
---

# Drivers, hire forms & referrals — load-bearing rules

Full model, incident forensics and worked examples: `docs/reference/DRIVERS-AND-HIRE-FORMS.md`.

## Scope — per-driver vs per-van vs per-job

Every Claude gets this wrong on first pass. A hire can have multiple drivers on one van, and a job multiple vans.

| Artefact | Scope |
|---|---|
| Hire form PDF, hire agreement email | **per-driver** (each signs their own; all carry the same van reg) |
| VE103B certificate | **per hire** — one cert, LEAD driver only; `ve103b_ref` writeback scoped to that row |
| Insurance excess | **per job** — top-N drivers by liability, N = van count, £1,200 floor per slot |
| Additional driver charge (HH stock 1324) | **per job** — `max(0, drivers − 2 × vans) × £20+VAT` |
| Book-out / check-in | **per van** (physical — the van leaves and returns once, with all its drivers) |

`vehicle_hire_assignments` has one row per **(driver, van, job)**. Several drivers on one van = several rows with the SAME `vehicle_id`. **Any "count of vans" rendering must dedupe by `vehicle_id`**, never count rows.

## Document validity

- **`services/driver-validity.ts` is THE definition — never re-implement it.** Humans set only a FROM date; OP derives every expiry into the `*_valid_until` columns on every driver write.
- **NEVER write a `*_valid_until` column directly, and never add a new writer.** Set the FROM date and let the derivation run. Six consumers were split across two column families with nothing keeping them in step — every staff-side fix moved the displayed pill and left the hard gate reading a stale value.
- **Integrity guard:** a check date with no licence identity behind it (`licence_issued_by` blank) yields NO window. A DENIED iDenfy check writes a bare check date, and that was rendering as a confident green expiry for a driver with no licence and no files. Any new surface reading licence validity must go through the service so it inherits this.
- **Gate policy is separate from the date model and deliberately unchanged:** the picker and book-out gate red-flag on `licence_valid_to` (the physical licence expiry), NOT on `licence_check_valid_until`. A dead licence is **red**; a stale *check* is **amber**. Flipping the check window into the red tier would newly block ~186 drivers — over half the signed roster.
- **POA1 and POA2 are independent** — both must be valid, and a MISSING POA date is red. `missingIsRed` is POA-only: licence expiry stays amber-on-missing because iDenfy frequently fails to extract it.
- **Validity is derived from DATES only — document presence is a separate question.** `services/driver-documents.ts` is THE answer to "is this document on file" (`drivers.files`, matched on a normalised tag/label token — the same lists the snapshot PDF resolves through). It changes what staff are TOLD, never a window: the hire-form router is date-based too, so making a missing file invalidate a window would have OP and the driver's own form disagreeing about the same driver. `frontend/.../EvidenceGroup.tsx` `filesForSlot()` holds the same spellings for a different job (which thumbnail goes where) — **add a new spelling to both**.
- `frontend/src/lib/driverStatus.ts` `deriveDriverStatus()` mirrors the SQL CASE in `routes/drivers.ts`. **Keep the two in step** — the `/drivers` filter pills run through the SQL, so a mismatch means clicking "Expired" returns rows badged "Approved". Both now lead on `identity_check_status` (`ID Check Needed` / `ID Rejected`), and both treat an expired **passport** as expired for non-UK drivers only. A **missing** date is still not "expired" anywhere — that is deliberate and unchanged (iDenfy frequently fails to extract one); missing documents surface in "What needs doing".

## Identity review

- **Route every new "is this driver authorised" surface through `isIdentityAuthorised()`** (`services/identity-review.ts`) rather than re-deriving inline.
- **It fails OPEN** on an unknown/absent status — a data gap must never silently block a driver.
- **`idenfyNeedsReview()` is THE trigger — key on `overall`, not just the face.** It flags `DENIED`/`SUSPECTED` **or** an explicit face non-match. Until Sep 2026 only the face result was consulted, so `idenfy_overall` and `idenfy_doc_result` were stored and read by nothing but the alert email: Jo Walker (16249, `DOC_SPOOF_DETECTED`) and Simon Halliday (15551, `DOC_SIDE_MISMATCH`) were both `DENIED` with a **perfect `FACE_MATCH`** and sailed through to a green 90-day licence window. Key on `overall` because it's independent of iDenfy's tag vocabulary — a spoof may surface in `fraudTags`, `mismatchTags` or `autoDocument`, but a rejection is always `DENIED`.
- **`EXPIRED` must NEVER trip review.** It is a session timeout ("the user never completes the verification"), not a rejection — an expired *document* is `DENIED`. Flagging abandoned tabs would raise false reviews weekly and the flag would stop being believed. What an expired session must not do is leave EVIDENCE, and that is enforced in the hire-form app (`isIncompleteVerification`), which writes no check date and no identity field for one.
- **An absent verdict is NOT a failure** (a step posting only POA dates carries none; a passport-only session runs no face comparison).
- **A staff decision wins** — a repeat webhook carrying the same stale verdict does not re-open it.
- **The hire-form app cannot set `identity_check_status`** — it reports what iDenfy said, OP decides what that means.
- **The flag outranks every date.** `next-step` checks `identity_check_status` BEFORE `calculateNextStep` runs, and `isDriverAuthorisedForAgreement` / quick-assign gate on the flag, not on `*_valid_until`. So a driver in review cannot be released by extending a date — which is why the review panel offers Accept/Reject only and deliberately has **no date field**: one click must not both accept the ID and mint a validity window.
- ⚠️ **`ProcessingHub.js` does `stepMapping[nextStep] || 'poa1'` in TWO places** — an unrecognised router step silently dumps the driver on the POA upload page. Add any new step to BOTH maps.

## "Signed for THIS hire"

- **A signature never expires, so `signature_date` cannot answer "are they on the hire in front of them?"** The only thing joining a driver to a hire is the `vehicle_hire_assignments` row, created at exactly one moment: the Signature step.
- **`services/driver-hire-progress.ts` `unsignedJobNumberSql(alias)` is THE derivation.** Every "is this driver joined to the hire" surface reads `unsigned_job_number`; **never re-derive from `signature_date`**.

## Referrals

- **`services/referral-alert.ts` `sendReferralAlert` is the single sender** — fired from three paths, deduped by an atomic claim on `referral_alert_sent_at` (released on failure). **Do NOT add a local referral-alert sender** anywhere else.
- **⚠️ `POST /api/driver-verification/update` must NEVER write `referral_status` / `referral_date`.** The hire-form app sends `referralStatus: 'pending'` unconditionally; whitelisting those columns leaked a false amber "Referred & Waiting" when nobody had referred anything. Same reason `identity_check_status` is stripped.
- Status hierarchy: `requires_referral=true` + `referral_status NULL` = red **to-do** (nobody has acted). `'pending'` = amber, staff emailed the insurer. `'approved'`/`'waived'` = green. `'declined'` = red.
- **`'waived'` counts as authorised everywhere** — same operational effect as approved, distinct only for audit ("we saw the flag, here's why we cleared it without contacting the insurer").

## Per-driver referral gate at book-out

- **`isDriverAuthorisedForAgreement(assignmentId)` is the gate** — route ALL new agreement / authorisation / condition-report surfaces through it. Don't re-derive `requires_referral && referral_status NOT IN (…)` inline.
- **It fails OPEN** (a missing row is a data gap, not a referral hold).
- **Return the distinct `'held_back'` sentinel, never `'failed'`** — a deliberate skip must not trip `runHookWithRecovery`'s retry/alert. Check BEFORE the atomic email claim so a later authorise can re-fire cleanly.
- **Book-out stays per-VAN and non-blocking.** The gate withholds only the per-driver paperwork; the van still goes out on its approved drivers, and a held-back driver stays visibly ON the job.
- **Never auto-bump excess on authorise** — surface the figure, let staff collect.

## iDenfy

- **NEVER derive a driver's email from the iDenfy clientId.** The encoding is lossy (strips anything outside `[a-z0-9_]`), so a hyphenated domain decoded to a different address and find-or-created a phantom driver record, looping the real driver back into iDenfy forever. Resolve via `GET /driver-verification/driver-by-scan-ref`.
- **iDenfy return URLs must be same-origin with the driver's browser** — the session token lives in per-origin sessionStorage, and the app serves on two origins.
- **`isUkLicence()` (`services/driver-validity.ts`) is THE "is this a DVLA driver?" test** — it decides which document regime applies (DVLA check vs passport), so never re-derive it inline. It accepts the country as a **code or a name**: the webhook writes `licence_issue_country` through `getCountryName()`, i.e. `"United Kingdom"`, while every consumer compared it to `"GB"` — so that half of the test never once matched and UK detection rested entirely on `licence_issued_by === 'DVLA'`. That mattered the day an expired PASSPORT session leaked into the licence path and overwrote `licence_issued_by` with `HMPO` (Charlie McWilliams / 15727): nothing was left to recognise him by, his passed DVLA check stopped counting, and OP demanded a passport he didn't need.

## Data handling

- **`vehicle_hire_assignments` is soft-cancel only.** Set `status='cancelled'`; there is no `DELETE FROM vehicle_hire_assignments` in the codebase and there shouldn't be — the row is the record of a hire that physically happened, and R2 book-out/check-in events reference it.
- **JSONB columns in `/driver-verification/update` MUST be in `JSONB_FIELDS`** — node-postgres sends a JS array as an ARRAY literal which JSONB rejects, but an EMPTY array survives, so this fails silently for exactly the drivers who have data.
- **⚠️ Every date leaving OP for the hire form must be `YYYY-MM-DD` — use the response's `toYmd`, NEVER `String(v).split('T')[0]`.** node-postgres returns a DATE column as a **JS Date object**, so `String(d)` gives `"Mon Dec 27 2021 00:00:00 GMT+0000 (…)"` and `.split('T')[0]` splits on the **T in "GMT"**. The result is **truthy**, so it survives every `|| ''` fallback, and an `<input type="date">` **silently refuses to render a value it can't parse** — the field just looks empty, with no error anywhere. This class has surfaced three times (iDenfy passport `BAD_VALUE`; the hire-agreement PDF printing `"Sun Jan 09 1983 00:00:00 GM"`; `datePassedTest` on `/driver-verification/status`, making returning drivers retype it every hire). `routes/__tests__/driver-status-response.test.ts` asserts EVERY date on that payload matches `YYYY-MM-DD` — **add new ones to it**.
- **Document matching is on a NORMALISED token** (lowercase, strip non-alphanumerics; tag first then label). Upload paths spell things `licence_front` / `license_front` / `Licence Front`, so exact-string matching silently drops images. **`services/driver-documents.ts` owns the token lists** — the snapshot PDF resolves its pages through `resolveDocumentKey()` and the cockpit asks `documentPresence()`; neither keeps its own copy. Kept as a backend module rather than a `shared/` constant because the backend doesn't import `shared/` at runtime.
- **Hire-window fallback is `jobs.job_end`, NOT `jobs.return_date`.** `return_date` is the artificial +1-day turnaround buffer, not when the hire ends.
