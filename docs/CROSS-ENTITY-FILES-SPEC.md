# Cross-Entity Files — Spec

Two related pieces of work, plus a unification, agreed Sep 2026.

**Phases 3 and 4 were swapped after Phase 2 shipped.** As originally written,
Phase 3 removed `RehearsalProfileFiles` from Job Detail on the strength of a
general org→job derivation that Phase 4 hadn't built yet — pulling down the
ladder before the staircase existed, and leaving every band's desk files
invisible from jobs between the two deploys. Phase 4 went first instead, so
Phase 3 is now a clean cutover: the copied files surface through the general
mechanism the moment they land.

1. **Client enquiry-form attachments → the Job's Files tab** (Phase 1, shipped).
2. **One Files surface per organisation, linked bidirectionally with job files** — a
   band's rider/spec uploaded once is reusable across every hire (Phases 2–4).
3. **Fold the Rehearsals-profile "desk files" into the general org Files store** so
   there is exactly one place to put/find an org's files (Phase 3).

## Current state (why this is mostly wiring, not new storage)

- **`organisations.files` JSONB has existed since migration 001** — org file storage
  is already there, just buried at the bottom of the org **Details** tab with a basic
  uploader. Piece 2 gives it a real home; it doesn't build storage.
- **The "windows onto the same file" pattern already exists in miniature.** A band's
  Rehearsals **profile** (`organisation_rehearsal_profile.files`, migration 176) holds
  files that already surface **read-only on that band's Job Files tabs** via
  `RehearsalProfileFiles` — "surfaced, not copied; the bytes stay owned by the org."
  Phases 3–4 generalise this and retire the bespoke component.
- **The rich Files UI is not actually reusable yet.** It's an inline `JobFilesSection`
  inside `JobDetailPage.tsx` (not the `<FileUpload>` used elsewhere). Phase 2 extracts it.
- **Enquiry-form files never reached the job.** The public form uploads to a separate
  Cloudflare Worker R2 bucket; the intake endpoint accepted the file refs but dropped
  them (filenames listed in notes only). Phase 1 closes that.

## The model — "windows onto the same file", not copy/move

A file's bytes live in R2 **exactly once**, owned by whichever entity it was first
uploaded to (a job, or an org). Extra "windows" onto it are **links**, never copies.
Two deliberately asymmetric directions:

- **Org file → seen on the job (automatic, derived).** For each org on a job (from
  `job_organisations` + the `jobs.client_id` accounting client), that org's files
  surface read-through on the Job Files tab, grouped **"From [Org]"**. No link rows —
  derived from org membership, so **changing a job's orgs re-derives the set for free.**
  This is the reuse win: a rider on the band appears on every hire for that band.
- **Job file → linked up to an org (explicit, opt-in).** A file uploaded on a job stays
  job-owned; **"Link to org"** creates a `file_links` row to the chosen org (org picker
  on multi-org jobs). Because the link targets a *specific* org, it **persists even if
  the job's client later changes** — the rider stays with the band. Once linked, the
  org→job derivation then surfaces it on that band's *other* jobs too.

Net: bytes never duplicated. A job's Files tab = its own files + "From [Org]" group(s);
an org's Files tab = its own files + a "Linked from jobs" group.

### Decisions (from discussion)

- **Surface scope:** *all* of an org's files surface on its jobs, with a per-file
  `show_on_jobs` toggle (default `true`) so internal docs (a contract) can be hidden
  while riders/specs surface.
- **Share toggle** (`share_with_freelancer`) is settable from either surface (job or
  org). A freelancer only ever sees a file via a job anyway, so this is mostly cosmetic.
- **Delete guard:** deleting a file that still has links is **blocked with an
  explanation** ("linked to [Band] — unlink there first"), not silently unlinked.
- **Rehearsal desk files are unified in, not kept separate** — barely used, so migrate
  now rather than run two file surfaces. No separate filtered rehearsal-files view; one
  Files banner is the whole point.

## Data model (Phase 4)

- **New table `file_links`**: `(id, r2_key, owner_entity_type, owner_entity_id,
  linked_entity_type, linked_entity_id, created_by, created_at)`. Generic; only
  `organisations` used as `linked_entity_type` for now.
- **New per-file flag `show_on_jobs`** (default `true`) on the `FileAttachment` object,
  added to the `PATCH /api/files/update-metadata` allowlist (alongside
  `share_with_freelancer`, `label`, `comment`).
- No change to how bytes are stored (`files/<entity>/<id>/<uuid>.<ext>`; the download
  endpoint already allowlists any `files/` key).

`FileAttachment` shape (existing, `shared/types/index.ts`):
`{ name, url (R2 key or external URL), type, uploaded_at, uploaded_by, label?, comment?,
share_with_freelancer? }` — note `url` is the key and `name` is the filename (there is
no `r2_key`/`filename`/`content_type`/`size_bytes`).

---

## Phase 1 — Enquiry-form files → Job Files (SHIPPED)

**Decision: the Worker uploads the bytes into OP's R2; email attachments stay untouched.**

Flow:
1. Client attaches files on the public form → the Worker's `/upload` stores them in the
   Worker's R2 (unchanged — the Resend notification email still attaches from there).
2. On `/submit`, the Worker **also** pushes each file to OP via
   `POST /api/enquiry-intake/files` (API-key auth), which stores the bytes at
   `files/enquiry-intake/<uuid>.<ext>` in OP's R2 and returns `{ key }`. The Worker adds
   `op_key: <key>` to each entry in the `files[]` it forwards to `/api/enquiry-intake`.
3. `POST /api/enquiry-intake` creates the job as before, then appends each file with a
   valid `op_key` (under the `files/enquiry-intake/` prefix) to `jobs.files` as a
   `FileAttachment` (`label:'From enquiry form'`, `uploaded_by:'enquiry form'`).

Result: the client's rider/spec appears on the Job Detail Files tab the moment the
enquiry lands — **and** still arrives as an email attachment.

**Safety:** only keys under `files/enquiry-intake/` are ever attached, so a payload can't
reference arbitrary R2 objects. Files are re-validated (25MB, extension whitelist) on the
OP side. Attach happens on fresh-create only; the intake dedup guard (same email /
`new_enquiry` / `web_form` within 15 min) means a double-submit's first pass already
attached. Orphaned staging objects from a deduped retry are harmless R2 litter.

**Backend (this repo):** all in `backend/src/routes/enquiry-intake.ts` — new
`POST /files` route + `enquiryFileAttachments()` helper + the attach step. No migration
(uses existing `jobs.files`). No frontend change (the Files tab already renders
`jobs.files`).

**Worker (Cloudflare, `ooosh-enquiry-form`):** add a push-to-OP step in `/submit` before
the OP forward; add env vars `OP_FILES_URL` (= `https://staff.oooshtours.co.uk/api/enquiry-intake/files`)
reusing `OP_API_KEY`; remove the dead duplicate OP-forward block near the bottom of
`handleSubmission` (a leftover `Authorization: Bearer` re-POST — latent double-enquiry
risk). The public `enquiryform.html` needs **no** change.

---

## Phase 2 — Org Files tab + reusable component (SHIPPED)

**Frontend only — no migration, no backend change.** The `/api/files/*` routes
(`upload`, `add-link`, `delete`, `update-metadata`, `email`) were already generic over
`entity_type` and already accepted `organisations`, and `organisations.files` has
existed since migration 001. Phase 2 is purely a UI wiring job.

- The inline `JobFilesSection` moved out of `JobDetailPage.tsx` into
  `frontend/src/components/EntityFilesSection.tsx` as
  `<EntityFilesSection entityType entityId files onChanged>` — upload, drag & drop,
  external links, tag + comment, freelancer share toggle, inline view, email, delete.
  Job Detail mounts it with `entityType="jobs"`.
- The extraction had to take its private dependencies with it, or they'd have been
  duplicated: `FILE_TAGS`, `fileTagColour()`, `isPreviewable()`, `SpreadsheetPreview`
  and `FileViewerModal` now live in (and are exported from) the same component file.
  Phase 3's new tags go in `FILE_TAGS` there. `PipelinePage.tsx` still has its own
  older copy of `FILE_TAGS` — left alone, out of scope.
- `OrganisationDetailPage` gains a first-class **"Files"** tab (deep-linkable as
  `?tab=files`, count in the tab label) mounting the same component over
  `organisations.files`. `onChanged` refetches the org *and* its interactions, because
  the upload route writes a companion `📎 Uploaded file` timeline entry.
- `OrgDetail.files` is now typed as the shared `FileAttachment[]` rather than a local
  narrower shape, so tags, comments, share state and `type: 'link'` entries render.
- The buried `FileUpload` in the org **Details** tab is retired; a one-line signpost
  pointing at the Files tab replaced it. `FileUpload` is untouched and still in use on
  Person and Venue detail pages.
- Copy fix carried along: the uploader said "Max 10MB" while multer has always
  allowed 25MB. Now says 25MB.

## Phase 3 — Unify rehearsal desk files into org files (SHIPPED)

Ran last, after Phase 4/4b, so the general org→job surfacing already existed and the
bespoke component could be removed with nothing lost in between.

- Tags `Desk settings`, `Saved mix`, `Tech spec` added to `FILE_TAGS` (+ chip colours).
- **Migration 204** maps each `organisation_rehearsal_profile.files` entry into that
  org's `organisations.files`. It's a MAPPING, not a copy — the two shapes differ:

  | profile file | `FileAttachment` |
  |---|---|
  | `r2_key` | `url` |
  | `filename` | `name` |
  | *(nothing)* | `type` — derived from the extension |
  | `uploaded_by` = a **user UUID** | `uploaded_by` = that user's **email** |
  | `label` (usually absent) | `label`, defaulting to `Desk settings` |

  `content_type` / `size_bytes` are dropped — `FileAttachment` has no home for them and
  nothing read them. Entries already on the org (matched by R2 key) are skipped, so the
  migration is idempotent and can't double up.
- `RehearsalProfileFiles` is deleted; Job Detail no longer fetches
  `/rehearsals/job/:id` for files, and the Files tab badge counts the job's own files.
- `RehearsalProfileSection` keeps its structured fields, preferences and internal notes;
  its uploader/viewer is replaced by a signpost to the org Files tab.
- `RehearsalDetailsCard` stopped counting profile files in its "N things" badge and its
  band-extras summary — those files are counted on the Files tab now, so leaving them
  would have double-counted them.

**Deliberately left behind, for a later cleanup migration once this has been live a
while:** the `organisation_rehearsal_profile.files` column itself (still populated, no
longer read) and the `POST`/`PATCH`/`DELETE /api/rehearsals/profile/:orgId/files`
routes, which now have no caller.

**One behaviour change worth knowing.** Desk files used to surface only on jobs where
that band was the *rehearsal anchor*. As ordinary org files they surface on **every** job
the org is on — so a band's saved desk file will also appear on their van hire. That
follows from having one Files store rather than two, and the per-file **Hidden on jobs**
toggle is the escape hatch.

## Phase 4 — The link layer + both surfacing directions (SHIPPED)

Built **before** Phase 3 — see the note at the top of this doc.

- **Migration 202** creates `file_links` (registered in the runner's hardcoded list).
  `show_on_jobs` needed no migration: it's a key inside the existing `files` JSONB,
  added to the `PATCH /files/update-metadata` allowlist. **Absent means `true`** —
  a rider is reusable the moment it's uploaded, without anyone ticking anything.
- **Org → Job (derived):** `GET /api/files/for-job/:jobId` resolves the job's orgs from
  `job_organisations` UNION `jobs.client_id`, returns their files grouped per org,
  filtered to `show_on_jobs`, deduped by R2 key against the job's own files (and against
  each other, so a file on two of the job's orgs shows once). Rendered as collapsible
  "From [Org]" cards with a "manage on [Org] →" link. Derived server-side, not in the
  browser: doing it client-side would mean N requests *and* shipping hidden files to the
  client where they'd be readable in the network tab.
- **Job → Org (explicit):** `POST /api/files/link` writes one row; the per-file
  "Link to org" action picks from the orgs on that job (skipping straight past the
  picker when there's only one candidate). Linked files then surface on that org's
  *other* jobs through the same derivation — the reuse win. The Org Files tab grows a
  "Linked from jobs" group with an Unlink action.
- **Delete guard:** deleting a file with live `file_links` rows returns 409 naming the
  orgs. **Only the explicit direction is guarded** — the derived org→job direction has
  no rows to check, so deleting an org's own file does remove it from every job it was
  surfacing on. That's correct (the org owns it) but it's the opposite of what the
  guard's wording suggests, so it's worth knowing.
- A link row **is** the decision to surface, so `show_on_jobs` is deliberately *not*
  re-checked on linked job files — the flag only gates the derived direction, where
  nobody opted in file-by-file.
- The three new read/write routes are `authorize(...STAFF_ROLES)`; the older `/files/*`
  routes remain authenticate-only, which is pre-existing.
- One thing left alone: the Job Detail **Files tab badge** still counts the job's own
  files (plus rehearsal-profile files) and not the derived org files. Surfaced files
  are labelled as someone else's, so inflating the job's own count would mislead.

## Phase 4b — one flat Files list (SHIPPED)

Phase 4 shipped surfaced files as separate cards — "From [Org]" groups on a job,
a "Linked from jobs" group on an org. In use that was wrong three ways, so it was
flattened immediately:

1. **Separate surfaces re-created the problem the project exists to solve.** The
   whole premise is ONE Files place per entity; three cards is three places.
2. **Borrowed files had a crippled action set** (view only) for no reason anyone
   could state — a file's provenance shouldn't decide whether you can email it.
3. **A file could appear twice.** Two cards meant two dedupe scopes.

**Now:** one `Files (n)` list per surface, owned and borrowed rows together,
deduped by R2 key in a single pass with **owned winning**. Provenance moved from
a card heading to a per-row **origin chip** — muted and outlined, visually
distinct from the coloured staff tag, so "Rider" and "From Bandy McBandface" sit
side by side. The chip links to the owner. The filter row carries tags **and**
origins, which gives back the grouping affordance for one click and no cards.

**Actions are unified except one.** View, Email, Share and Edit work on every
row and are aimed at the file's OWNER (`owner_entity_type` / `owner_entity_id`,
now returned by both surfacing endpoints) — the tooltips say so, because editing
a band's tag from a job page changes it everywhere. **Delete stays owner-only**:
a borrowed row offers Unlink (where this surface holds the link) or nothing.
Deleting someone else's file from a borrowed view is the one irreversible action,
and flattening removes the visual "this isn't yours" cue that a separate card gave.

**Migration 203 frees the `label` field.** Phase 1 wrote provenance into the
staff tag (`label: 'From enquiry form'`), so a client's rider could be marked as
*from the enquiry form* or as a *Rider*, never both — and the tag filter row
carried a pseudo-tag forever. Provenance is now derived from the
`uploaded_by = 'enquiry form'` that Phase 1 already stored, so no replacement
column was needed: the migration just clears the squatted label, and
`routes/enquiry-intake.ts` stops writing it.

## Edge cases

- **Enquiry files with no firm org yet** — Phase 1 just lands them on the job; linking to
  the band is a later manual action (Phase 4). Clean separation.
- **Share of a surfaced org file** — allowed from either surface; only visible to a
  freelancer through a job regardless.
- **Owner file deleted while linked** — blocked with an explanation (above).
