---
paths:
  - "backend/src/routes/{vehicles,assignments,warehouse}.ts"
  - "backend/src/services/{fleet-hire-status-sync,vehicle-*,vha-dedup,quote-completion,condition-report-email,compliance-checker,sanity-check-scanner}.ts"
  - "backend/src/middleware/freelancer-bookout-auth.ts"
  - "frontend/src/modules/vehicles/**"
  - "frontend/src/lib/vehiclePrep.ts"
---

# Vehicles, book-out & check-in — load-bearing rules

Full detail: `docs/reference/VEHICLES-AND-FLEET.md`, plus the book-out/check-in
invariants and multi-van scramble write-up in `docs/reference/SHARED-UTILITIES.md`.

## Fleet status is DERIVED, not authoritative

- **`services/fleet-hire-status-sync.ts` is the single writer of `fleet_vehicles.hire_status`.** It is a cached projection; the truth is `vehicle_hire_assignments.status`. Five hand-rolled `UPDATE fleet_vehicles SET hire_status` sites is exactly how it drifted.
- Sticky values (`Sold`, `Not Ready`) are explicit manual overrides and are never clobbered. `Prep Needed → Available` happens only via the prep-completion endpoint.
- Manual override paths (fleet PATCH, bulk import) deliberately do NOT call it — those are explicit user actions.

## Book-out / check-in invariants

1. **Any path that sets `status='booked_out'` MUST also stamp `booked_out_at`.** A `booked_out` row with a NULL timestamp is a bug — it means the status flip and the vehicle event were split and the event never landed.
2. **Check-in resolves the hire from the authoritative assignment, NOT the latest R2 book-out event.** When invariant 1 was broken, the event query returned a STALE book-out from a previous hire and the check-in was stamped against the wrong job. The DB assignment is the source of truth for "which hire is this van on".
3. **Book-out partitions driver rows BY VAN.** On a multi-van "everyone drives everything" job all drivers share one row set; re-pointing `vehicle_id` on a row already booked out to a *different* van scrambles the data (last-write-wins on `vehicle_id`, first-write-wins on `mileage_out` and the PDF key) and leaves the second van with zero rows. Clone a per-van row instead. A genuine van change goes through Swap Vehicle.
4. **Damage flagged at check-in must always be posted** to `POST /api/problems/auto-create` — never gate on a non-empty description (the PDF renders a description-less damage item happily, so any gate the PDF doesn't share splits the two records). Damage lives in `job_issues`, **not** the event JSON.
5. **`has_damage` is forward-only:** `COALESCE(has_damage, false) OR $n`. `COALESCE(has_damage, $n)` on a `NOT NULL DEFAULT false` column can only ever return the existing `false` — that card never once fired in production.
6. **A post-submit step that can no-op MUST report itself.** The results panel renders the damage line whenever there were damage items, saying "0 logged from N" in the bad case. A silent success screen over a fully-skipped side-effect is what cost a day.

## Joining assignments to jobs

- **Use the dual match: `vha.job_id = j.id OR vha.hirehop_job_id = j.hh_job_number`.** Staff-allocation and Van&Driver rows carry ONLY `hirehop_job_id` until a hire form is submitted, so a single-column join silently drops them — that made an allocated van show as Available for another job.
- **Don't re-window job-discovery queries to a plain `out_date >= today`.** A multi-van job whose vans leave on different days has one `out_date`; once van 1 goes, the job vanishes and the remaining van is unbookable. Both discovery endpoints also retain a started-but-not-back job that still has a pre-book-out van slot.
- Forward-commitment SQL that aggregates per van must apply the **dedup contract**: dedupe per `(vehicle, jobKey)`, winner = most-progressed status (`active > booked_out > confirmed > soft`), tie-broken by latest `status_changed_at`. Otherwise the same job appears as both "current" and "next".

## Freelancer mode

- **Any vehicle-module page that runs in freelancer mode MUST seed its form from `freelancerContext`.** The staff data hooks (`useAllocations`, `useDriverHireForms`, `useVehicleIssues`) are 403-gated for freelancer sessions, so gating a hook off without adding the context pre-fill silently strands the flow on "Waiting for vehicle allocation…".
- **A freelancer collection is a SOFT check-in** — stamp `soft_checked_in_at`, do NOT flip status to `returned`. The warehouse owns the final check-in, and the server enforces this per session mode.
- **Any new leg-completion path MUST call `maybeCloseQuote`** — quote closure is server-side and independent of the freelancer's browser making it back across the domain boundary.
- The two entrypoints are `/vehicles/book-out` and `/vehicles/check-in`; both share one HMAC token format, and the **resolve endpoint** (not a discriminator in the token) sets the session mode.
- **Neither resolver may answer "THE van on this job" — a job can have several.** Both used to take the top row with a `LIMIT 1`, so every freelancer on a multi-van job got the same one: HH 15307 (8 Sep) showed Lewis the van Charlie had already collected, and the van Lewis was standing at never got collected on the system. When more than one van is in play the resolver returns `needsVehicleSelection` + `candidates` and mints no session until the freelancer picks. A resolver may never widen this to trust a client-supplied `assignmentId` without re-deriving that job's candidate set.
- **Candidates are deduped per VEHICLE, not per assignment row.** One van routinely has several live rows on a job (HH 15307 carried three for RX24SZG). The freelancer is reading a number plate, so offering the same reg three times is worse than offering it once.
- **On a multi-van job the customer hire-form rows are NOT interchangeable.** Pair the allocation row to its customer row by `van_requirement_index` before falling back to lowest-index-first, or van #2 gets van #1's hirer, excess and hire agreement stapled to it.

## Condition report PDFs

- **Thread `eventId` through every generation path so the PDF is FROZEN to R2** at `condition-reports/{REG}/{eventId}.pdf`. That frozen copy is the real record.
- Retrieval is **stored-first, reconstruct-fallback**. Reconstructions are deliberately NOT re-stored — they read live/mutable sources and would otherwise pin a stale copy.
- The event JSON is a THIN record: it stores neither the damage items, the vehicle descriptor, nor the book-out comparison. Reconstruction pulls damage from `job_issues` and the descriptor from `fleet_vehicles`.

## Photos — memory and speed (do not regress)

- Decode via `URL.createObjectURL` and **revoke immediately after the canvas draw**; never hold a full-resolution base64 through decode. Revoke a photo's preview URL on retake/remove.
- **Resize sequentially, never `Promise.all`** — keep one decoded bitmap alive at a time.
- Produce the stored image AND the PDF thumbnail in ONE decode pass at capture time (`compressImageWithThumb`), not at submit.
- **Capture resolution stays high deliberately** — these photos are damage-dispute evidence. Fix memory with the lifecycle rules above, not by lowering resolution.
- Condition reports are built and emailed **server-side**; multi-MB PDFs must not round-trip through the phone.

## Dates

- **Never call `toISOString()` on a Date you haven't range-checked.** Guard with `Number.isNaN(d.getTime())` both after parsing and after shifting, then return `null` and render `—`. A mistyped year (`0006-08-25`) threw inside a row `.map()` and blanked the whole SPA.
- **Zero-pad the year when hand-building `YYYY-MM-DD`.** Any year that isn't exactly 4 digits is an Invalid Date in JS, and Postgres will happily store year 6.

## UI conventions

- **`frontend/src/lib/vehiclePrep.ts` `vehiclePrepPill()` is the single source** for prep-status pills. Only two states render: `Prep Needed` → amber, `Available` → green. Everything else returns null. **Do not re-add "On Hire" as a pill.**
- The van reg is shown **once**, in the "Vehicles on this job" strip — **don't re-add a prominent per-card reg.** Every driver on a job can drive any van on it, so a per-card reg conveyed nothing and repeated on every card.
- Derive the strip from the raw assignment rows (including driverless staff-allocation rows), not from the filtered/displayed list.

## Migrations

- **Never edit a migration once it could have been applied anywhere** — the runner skips it and the change silently never lands in production. Always add a new one.
