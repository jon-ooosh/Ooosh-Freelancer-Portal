# Cross-Entity Files — Spec

Two related pieces of work, plus a unification, agreed Sep 2026.

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

## Phase 2 — Org Files tab + reusable component

- Extract the inline `JobFilesSection` (in `JobDetailPage.tsx`) into a shared
  `<EntityFilesSection entityType entityId files onChanged>` — upload, tag, comment,
  share toggle, view, email, delete, add-link. Job Detail switches to it.
- Add a first-class **"Files" tab** on `OrganisationDetailPage` mounting
  `<EntityFilesSection entityType="organisations">` on `organisations.files`. Retire the
  buried uploader in the Details tab.

## Phase 3 — Unify rehearsal desk files into org files

- Add tags `Desk settings`, `Saved mix`, `Tech spec` to `FILE_TAGS`.
- **One-shot data migration:** copy each `organisation_rehearsal_profile.files` entry
  into that org's `organisations.files`, defaulting `label` to `Desk settings`
  (preserving any existing label). Leave the old column in place but unused; drop it in a
  later cleanup migration.
- Remove `RehearsalProfileFiles` from Job Detail and the file uploader/viewer from
  `RehearsalProfileSection` (it keeps its structured fields + hotel-book preferences).
  Those files now surface on jobs via the general org→job derivation (Phase 4).

## Phase 4 — The link layer + both surfacing directions

- Create `file_links` + the `show_on_jobs` flag (see Data model).
- **Org → Job (derived):** the Job Files tab renders a collapsible "From [Org]" group per
  org on the job (`job_organisations` + `client_id`), filtered to `show_on_jobs`, deduped
  by `r2_key` against the job's own files. View/download + "manage on [Org] →" link.
- **Job → Org (explicit):** a per-file "Link to org ▾" action (org picker for multi-org
  jobs) creates a `file_links` row. The Org Files tab renders its own files + a "Linked
  from jobs" group.
- **Delete guard:** block deleting an owned file while `file_links` rows reference it.

## Edge cases

- **Enquiry files with no firm org yet** — Phase 1 just lands them on the job; linking to
  the band is a later manual action (Phase 4). Clean separation.
- **Share of a surfaced org file** — allowed from either surface; only visible to a
  freelancer through a job regardless.
- **Owner file deleted while linked** — blocked with an explanation (above).
