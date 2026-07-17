# Rehearsal Info & Client Profile — Build Spec (v1)

**Status:** proposed — awaiting sign-off before build.
**Branch:** `claude/awesome-planck-0a8u19`.
**Next free migration:** 174 (173 is the latest in `run.ts`).

Companion to `docs/REHEARSALS-SPEC.md` (studio-sitter cover). This spec covers the
*next* chunk: growing Rehearsals from "sitter cover" into the single place for a
studio job — an Operations hub, a lightweight per-job details card, a client-facing
pre-hire **info pack** email, and a persistent **band rehearsal profile** (the
"hotel book" that surfaces preferences next time they're in).

**General Tasks system is explicitly DEFERRED** (was Stream 5's other remaining piece).

---

## 1. Design decisions (locked with jon)

- **Rehearsals becomes an Operations hub.** Studio Sitters moves *inside* it — it's one
  facet of the same work. Supersedes the earlier "card-on-Job-Detail, no new nav" note.
- **Keep it lightweight.** Lots of variation between bookings → lean first-class fields
  + a flexible preferences list + free-form notes, not a rigid schema.
- **Info pack is per-JOB, not per-room.** A site-evening with two bands = two jobs =
  two packs (one per client). One band booking both rooms = one pack. Per-job covers all.
- **Client-facing content is STATIC boilerplate only** for v1 (directions, parking, wifi,
  local amenities, house rules) + per-job merge (dates/room/session times). Personalised
  notes stay **staff-internal** prep — we do NOT tell the client "we stocked your oat milk"
  yet.
- **Info-pack "last sent" is band-level.** Surface *"last sent to [Band] on 3 Jul (#15xxx)"*
  so a run of day-bookings over several weeks doesn't get spammed. Manual send only; the
  last-sent line is the manual-era stand-in for auto-send.
- **Profile anchors on the BAND organisation** (`job_organisations.role='band'`), falling
  back to the job's client org when no band is linked. Preferences move with the band.
- **No per-person prefs.** Most band/crew members aren't `people` in the address book;
  "James drinks soya" lives as a free-form row in the preferences list on the band profile.
- **Capture = staff-entered (level A).** The client-facing intake form (level B) is the
  flagged phase-2 "hotel" experience, easy to bolt on once the profile store exists.
- **Boilerplate settings editor lives in the hub** (Rehearsals → Info Pack tab, admin/manager),
  stored in `system_settings` category `rehearsals`. Same storage layer as OOH/carnet/storage;
  editor placed where the rehearsal manager works rather than bloating global Settings.

---

## 2. Data model — Migration 174 (`rehearsal_details_and_profile`)

### 2.1 `rehearsal_job_details` — per-job intake (one row per job)

```sql
CREATE TABLE IF NOT EXISTS rehearsal_job_details (
  job_id            UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  pa_setup          TEXT,          -- what PA the band wants
  backline_notes    TEXT,          -- backline they want FROM US (HH-derived backline shown
                                   --   read-only on the card; this is the intake note on top)
  cars_count        INTEGER,       -- how many cars the band is bringing (parking/space)
  dropoff_pickup    TEXT,          -- lorry/truck/van drop-off & pickup (who/when), free-form
  notes             TEXT,          -- general free-form
  info_pack_sent_at TIMESTAMPTZ,
  info_pack_sent_by UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2.2 `organisation_rehearsal_profile` — persistent band profile (one row per org)

```sql
CREATE TABLE IF NOT EXISTS organisation_rehearsal_profile (
  organisation_id   UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  room_setup        TEXT,          -- layout preference (round-a-table / forward / their own)
  mic_list          TEXT,          -- mics they usually ask for
  power_notes       TEXT,          -- power / distro needs
  pa_monitoring     TEXT,          -- PA & monitoring preferences (wedges/IEMs, mix quirks)
  usual_backline    TEXT,          -- what they hire from us vs bring
  desk              TEXT,          -- which in-house digital desk they use
  load_in_access    TEXT,          -- early in / late finish / loading quirks
  regular_contact   TEXT,          -- regular TM/engineer + comms preference (free-form, no FK)
  preferences       JSONB NOT NULL DEFAULT '[]',   -- [{label,value}] hotel prefs: milk, catering,
                                   --   room temperature, "watch-outs" (don't move the piano) …
  internal_notes    TEXT,          -- "last time…" observations
  files             JSONB NOT NULL DEFAULT '[]',   -- desk files / saved mixes:
                                   --   [{r2_key, filename, content_type, size_bytes, label,
                                   --     uploaded_at, uploaded_by}]
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2.3 Info-pack boilerplate — `system_settings` category `rehearsals`

```sql
INSERT INTO system_settings (key, value, label, category, value_type, sort_order) VALUES
  ('rehearsal_directions',  '', 'How to find us (directions)',   'rehearsals', 'text', 10),
  ('rehearsal_parking',     '', 'Parking info',                  'rehearsals', 'text', 20),
  ('rehearsal_wifi',        '', 'WiFi network & password',       'rehearsals', 'text', 30),
  ('rehearsal_amenities',   '', 'Local shops & takeaways',       'rehearsals', 'text', 40),
  ('rehearsal_house_rules', '', 'House rules / good to know',    'rehearsals', 'text', 50),
  ('rehearsal_contact',     '', 'Studio contact (on the day)',   'rehearsals', 'text', 60)
ON CONFLICT (key) DO NOTHING;
```

**Remember:** add `174_rehearsal_details_and_profile.sql` to the `migrations` array in
`backend/src/migrations/run.ts`.

---

## 3. Backend

### 3.1 `services/rehearsal-details.ts`

- `resolveRehearsalAnchorOrg(jobId)` → `{ id, name } | null`. Band-role org from
  `job_organisations` (LIMIT 1), else `jobs.client_id`'s org. Single source of truth for
  "whose profile applies to this job".
- `getRehearsalJobDetails(jobId)` / `upsertRehearsalJobDetails(jobId, fields, userId)`.
- `getRehearsalProfile(orgId)` / `upsertRehearsalProfile(orgId, fields, userId)`.
- `addProfileFile(orgId, file, userId)` / `removeProfileFile(orgId, r2Key)` — desk files,
  reuses the standard attachment shape.
- `getLastInfoPackSent(anchorOrgId)` → `{ sentAt, jobId, hhJobNumber } | null`. Most recent
  `rehearsal_job_details.info_pack_sent_at IS NOT NULL` across jobs whose **anchor** =
  `anchorOrgId` (join `rehearsal_job_details → jobs`, match band-role org OR `client_id`),
  newest first.
- `sendInfoPack(jobId, userId)` → composes the pack (boilerplate from `system_settings` +
  per-job merge), sends via `emailService.send('rehearsal_info_pack', …)` with the recipient
  from `resolveClientEmailTarget(jobId, 'rehearsal_info_pack')`, stamps `info_pack_sent_at`/
  `_by`, logs an `email`-type interaction on the job timeline. Returns recipient + fallback flag.

**Session times / dates for the merge** come from the existing rehearsal detection
(`hh_derived_flags.rehearsal_detail` / `getJobCoverage(jobId)`), falling back to
`jobs.job_date`/`job_end`. Reuse — do not re-derive.

### 3.2 `routes/rehearsals.ts` (mount `/api/rehearsals`, STAFF_ROLES)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/job/:jobId` | `{ details, anchorOrg, profile, lastInfoPackSent }` |
| PUT  | `/job/:jobId` | upsert per-job details |
| GET  | `/profile/:orgId` | band profile |
| PUT  | `/profile/:orgId` | upsert profile |
| POST | `/profile/:orgId/files` | attach desk file (body = R2 key from `attachment_only` upload) |
| DELETE | `/profile/:orgId/files/:key` | remove desk file |
| POST | `/job/:jobId/send-info-pack` | send + stamp; returns recipient/fallback |

Boilerplate settings read/written through the existing `/api/system-settings` endpoints
(category `rehearsals`) — no new settings endpoint.

### 3.3 Email — `rehearsal_info_pack` template + `rehearsal_info` routing bucket

- New template `rehearsal_info_pack` in `email-templates/index.ts`, client-branded base
  layout. Subject follows the job-number convention:
  `"Your rehearsals with Ooosh — {{dates}} (#{{jobNumber}})"`. Body renders only the
  non-empty boilerplate blocks + a per-job block (room(s), dates, session start/end).
  Caller passes `jobNumber: String(job.hh_job_number || '')`.
- `services/email-routing.ts`: add `'rehearsal_info'` to the `EmailBucket` union + the
  canonical bucket list (label "Rehearsal info pack"), and map
  `rehearsal_info_pack: 'rehearsal_info'` in `TEMPLATE_BUCKETS`. Ships OFF the
  `EMAIL_LIVE_TEMPLATES` allowlist so it test-redirects until released.

---

## 4. Frontend (OP React/Vite)

### 4.1 Operations → Rehearsals hub (nav + IA)

- `Layout.tsx`: replace the `{ path:'/operations/studio-sitters', label:'Studio Sitters' }`
  Operations child with `{ path:'/operations/rehearsals', label:'Rehearsals' }`.
- `App.tsx`: add route `/operations/rehearsals` → new `RehearsalsPage`; keep
  `/operations/studio-sitters` as a **redirect** to `/operations/rehearsals?tab=sitters`
  (bookmarks + existing deep-links survive).
- `RehearsalsPage` = tab shell:
  - **Studio Sitters** tab — renders the existing roster (mount `StudioSittersPage`'s
    content; minimal refactor — import + render inside the tab).
  - **Info Pack** tab (admin/manager) — the `rehearsals` `system_settings` editor
    (pattern of `StudioSitterSettingsSection` / `CarnetSettingsSection`).
  - *(Future: an "Upcoming rehearsals" overview tab — out of scope for v1.)*

### 4.2 Job Detail — `RehearsalDetailsCard` (Overview tab, rehearsal jobs only)

Gated on the existing `has_rehearsal` flag; sits near `StudioHandoverCard`. Contains:
- Lightweight details edit (PA setup, backline notes, cars, drop-off/pickup, notes).
- **Read-only HH-derived backline** (from existing detection) — shown, not re-keyed.
- **Known preferences** — read from the resolved band profile (room setup, mics, power,
  desk file names, preference rows) as a prep aide. Empty when no profile yet.
- **Send info pack** button with the band-level *last-sent* line + a confirm when it was
  sent recently; shows the sent indicator after.

### 4.3 Org Detail — `RehearsalProfileSection` ("Rehearsals" tab)

Mirrors the `ExcessHistorySection` / `StorageHistorySection` mount pattern. The profile
editor: first-class fields, the preferences list (add/remove label→value rows), desk-file
upload/list (via `attachment_only` upload → `/profile/:orgId/files`), internal notes.
Optionally the band's rehearsal booking history (nice-to-have, can defer).

### 4.4 Band profile files surface on the Job Files tab (read-only)

Once a job has a resolved band anchor, the band's rehearsal-profile files (mix files, stage
plots) **surface automatically** in the Job Detail **Files tab** as a distinct read-only
group — *"From [Band]'s rehearsal profile"* — so staff don't re-attach a stage plot on every
booking. **Surfaced, not copied:** the files stay owned by `organisation_rehearsal_profile.files`
(single source of truth), so updating/removing a profile file reflects on every job live; the
job's own `jobs.files` are untouched. Same authenticated view/download affordances as job
files; the profile-group rows have no delete/share toggle (managed on the Org Rehearsals tab).
Backend: `GET /api/rehearsals/job/:jobId` already returns the resolved profile — the Files tab
reads `profile.files` from it and renders the extra group when non-empty.

*(Future: a `share_with_freelancer`-style flag on profile files so a stage plot can reach the
sitter portal — deferred; the sitter portal already surfaces `share_with_freelancer` job files.)*

---

## 5. Out of scope (phase 2 / deferred)

- **Client-facing intake form (capture level B)** — public token form linked from the pack,
  TM answers prefs → feeds the profile. The "hotel" experience; bolt-on once the store exists.
- **Auto-send** the info pack at T-N days (like hire forms/carnet). Manual + last-sent line
  for now.
- **Personalised lines in the client email** ("your oat milk is stocked"). Profile stays
  internal prep in v1.
- **Per-person preferences** tied to person records.
- **Hub "upcoming rehearsals" overview** list.
- **General Tasks system** (separate build, deferred entirely).

---

## 6. Build order

1. Migration 174 (both tables + settings seed) + add to `run.ts`.
2. `services/rehearsal-details.ts` + `routes/rehearsals.ts` (mount in `routes/index.ts`).
3. `rehearsal_info_pack` template + `rehearsal_info` routing bucket.
4. Nav re-home + `RehearsalsPage` hub (Sitters tab + Info Pack settings tab) + redirect.
5. `RehearsalDetailsCard` on Job Detail Overview.
6. `RehearsalProfileSection` "Rehearsals" tab on Org Detail.
7. Wire desk-file upload; verify info-pack send end-to-end (test-mode redirect first).
