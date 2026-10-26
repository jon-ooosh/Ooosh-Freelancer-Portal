# Job projects — "these jobs all belong to the same festival"

**Status: BUILT 21 Oct 2026** (one PR). Born from the quote-options build
(`QUOTE-VERSIONS-SPEC.md` §14): festival-style grouping was parked there as "Phase 2 —
`part_of` groups", and turned out to be a different problem.

## 0. One-line summary

> A festival is quoted as many jobs: the core backline, a couple of outlier stages, a small PA,
> a dozen band spot-hires. A **project** is a named label those jobs share, shown as a panel on
> each of them with the total value, the lead Ooosh-er and every job in it. It owns nothing:
> every member stays an ordinary job.

## 1. Decisions (jon, 20–21 Oct 2026)

1. **Not quote options.** Options are "the client picks ONE"; a project is "all of these
   together". Opposite rules. **Never build this as `job_groups.kind = 'part_of'`**: every read
   path on `job_groups` assumes alternatives, so a festival group would have the portal refuse a
   band's payment once another band confirmed, count the festival once in the headline figures,
   and bell "other options still open". Its own table and column also lets one job be an option
   AND part of a project.
2. **A panel, not a page.** It sits top right on Job Detail, above Client History, and can be
   collapsed. To find a project from elsewhere: its name is in global search (the result opens
   one of its jobs), and Kanban cards carry a project chip.
3. **Name, client, lead, default dates.** The client is the festival or organiser — there is
   always one, even if it's a "festival" org made for the purpose. Member jobs can have other
   clients (a band's spot-hire may be billed to the band). The lead Ooosh-er can be changed.
4. **Dates are defaults for NEW jobs only.** OP's four job dates already fit a festival: Out and
   Return are when kit physically leaves and comes back, Start and End are what HireHop charges
   for ("out for 5 days, charged for 1"). "+ New job in this project" pre-fills all four.
   **Changing the project's dates never touches an existing job** — that would re-price a dozen
   jobs at once (never silently move money).
5. **New job = a blank new enquiry** with the project's client and dates filled in, not a copy.
6. **Retrospective adds** — "+ Add an existing job" on the panel, and "+ Add to a project" on any
   job not in one (header, next to "+ Add an option"). Creating a project starts from a job, so
   the order things happen in doesn't matter.
7. **A job is in one project at most.** Adding a job that is in another project MOVES it (the
   picker says so). Any staff member (`STAFF_ROLES`) can make and manage projects.

## 2. Model

Migration `316_job_projects.sql`:

- `job_projects` — `name`, `client_id` (organisations), `lead_user_id` (users), four DATE
  columns `out_date / job_date / job_end / return_date` (defaults for new jobs), `created_by`,
  timestamps.
- `jobs.job_project_id` → `job_projects(id)` `ON DELETE SET NULL`.

**Not** `jobs.hh_project_id` / `jobs.project_name` (migration 002): those are HireHop's own
projects, never filled — the HireHop sync skips project rows. Mirroring an OP project into a
HireHop project is not built (jon rarely uses HireHop projects).

## 3. Code

| Piece | Where |
|---|---|
| All logic (read + roll-ups, create from a job, update, add/move, remove, candidates) | `backend/src/services/job-projects.ts` |
| Routes `/api/job-projects` (list, create, read, patch, `/:id/job-candidates`, `/:id/jobs`, `DELETE /jobs/:jobId`) | `backend/src/routes/job-projects.ts` |
| Kanban chip data — `job_project_name` on `GET /api/pipeline` | `routes/pipeline.ts` list query |
| Project results in global search | `routes/search.ts` |
| "Quote another option" keeps the new option in the project | `job-groups.ts` `insertOptionCopy()` |
| Panel + modals (edit, add existing, add to a project) | `frontend/src/components/JobProjects.tsx` |
| Every user-facing string | `frontend/src/lib/projectCopy.ts` |
| Header link + panel placement | `pages/JobDetailPage.tsx` |
| Chip (card + list row), New Enquiry `?project=` prefill and link | `pages/PipelinePage.tsx` |

**Roll-ups** (`getProject()`): "Confirmed" sums `job_value` (ex VAT) over confirmed-or-later
jobs; "Still quoted" over pre-confirmation ones. Lost, cancelled and dismissed jobs are left out,
and quote options inside the project count once (the lead option, `resolveLeadJob()` — the same
rule as the pipeline headline counts). Members not counted render greyed in the panel.

Adding or removing a job writes a note on that job's Activity Timeline ("Added to project
\"Bloodstock 2027\"", with "moved from" when it came from another project).

## 4. Not built (deliberately, for now)

- Pushing changed project dates into existing jobs (§1.4) — if ever, as a ticked list for a
  human, never automatic.
- A project page, a project filter on the pipeline, project-level chasing.
- HireHop project mirroring.
- The panel is desktop-only (the right-hand column is `hidden lg:block`, like Client History).
- Archiving or closing a project. The picker lists newest first, so small "trying to win the
  backline" projects (a second job for a client already out on a van) will pile up beside the
  festivals over time (jon, 26 Oct 2026 - noted, not needed yet).

## 5. Verified

Against a scratch database (every migration applied) and the running app with Playwright: create
from a job (client + dates default from the job, lead = creator), add/move/remove with timeline
notes, roll-ups with an options group inside the project, out-of-order dates refused, candidates
by client/dates and by job number, search result, Kanban chip, New Enquiry prefill + banner,
option copy keeps the project. Not yet used on live data.

## 6. After first use (26 Oct 2026)

- **Search text becomes the name.** In "+ Add to a project", whatever is in the search box starts
  as the new project's Name on "Start a new project" (editable). With text in the box and nothing
  found, the picker says `Nothing called "..." - start it below.` rather than "No projects yet".
- **Shorter dates line.** The panel leads with the Start-End span and adds "out" / "back" only
  on a day that differs from Start / End: `10-21 Nov · back 22 Nov`, `out 9 Nov · 10-21 Nov ·
  back 22 Nov`, `28 Nov-2 Dec`. The year shows only when it isn't this (UK) year. Hovering shows
  all four in full. The picker list uses the same span. Helpers: `projectDatesText()` /
  `spanText()` in `JobProjects.tsx`.
