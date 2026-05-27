# CLAUDE.md — Ooosh Operations Platform

## Project Overview

This is the **Ooosh Operations Platform** — a unified business operations hub for Ooosh Tours, replacing Monday.com and wrapping around HireHop (job/equipment management) and Xero (accounting). The repo name says "Freelancer-Portal" but it has evolved into the full operations platform.

**People are the primary entity.** Everything connects back to people and their relationships. A person exists independently of any company, band, or role.

## Tech Stack

| Layer | Technology | Hosting |
|-------|-----------|---------|
| Frontend | React + Vite + TypeScript | Hetzner VPS (served via Nginx) |
| Backend API | Node.js + Express + TypeScript | Hetzner VPS (systemd service) |
| Database | PostgreSQL 16 | Hetzner VPS |
| Cache/Queues | Redis | Hetzner VPS |
| Real-time | Socket.io | Alongside Express |
| File Storage | Cloudflare R2 | Existing |
| Auth | JWT (email + password, bcrypt) | — |
| Scheduling | node-cron | Alongside Express |

**Server:** Hetzner CAX11 (2 vCPU, 4GB RAM) at `49.13.158.66`
**Domain:** `staff.oooshtours.co.uk` (SSL via Let's Encrypt)
**Database name:** `ooosh_operations` (PostgreSQL, access via `sudo -u postgres psql -d ooosh_operations`)

## Repository Structure

```
├── backend/                # Express API server
│   ├── src/
│   │   ├── routes/         # API route handlers
│   │   │   ├── auth.ts     # Login/logout, token refresh
│   │   │   ├── people.ts   # People CRUD
│   │   │   ├── organisations.ts
│   │   │   ├── venues.ts
│   │   │   ├── interactions.ts
│   │   │   ├── duplicates.ts  # Duplicate detection & merge
│   │   │   ├── hirehop.ts  # HireHop sync endpoints
│   │   │   ├── pipeline.ts     # Enquiry & sales pipeline (Kanban)
│   │   │   ├── quotes.ts      # Transport quotes CRUD, calculator settings, crew assignments, ops endpoints
│   │   │   ├── portal.ts     # Freelancer portal API (own JWT auth, replaces Monday.com)
│   │   │   ├── dashboard.ts   # Dashboard stats/metrics
│   │   │   ├── search.ts      # Global search
│   │   │   ├── users.ts       # User/team management
│   │   │   ├── files.ts       # File uploads (R2)
│   │   │   ├── notifications.ts
│   │   │   ├── backups.ts     # Database backup management
│   │   │   ├── email.ts       # Email service admin endpoints
│   │   │   ├── driver-verification.ts  # Public-facing hire form endpoints (own JWT auth)
│   │   │   ├── drivers.ts     # Drivers CRUD
│   │   │   ├── assignments.ts # Vehicle hire assignments
│   │   │   ├── excess.ts      # Insurance excess tracking
│   │   │   ├── hire-forms.ts  # Hire form CRUD, PDF generation, quick-assign
│   │   │   ├── webhooks.ts    # HireHop inbound webhooks + external status transition
│   │   │   └── health.ts
│   │   ├── config/
│   │   │   ├── hirehop.ts     # HireHop API configuration
│   │   │   ├── database.ts    # PostgreSQL pool
│   │   │   ├── redis.ts       # Redis client
│   │   │   ├── r2.ts          # Cloudflare R2 (S3-compatible)
│   │   │   └── scheduler.ts   # Cron jobs: backups, HH sync, chase auto-mover
│   │   ├── services/
│   │   │   ├── hirehop-sync.ts             # HireHop contact sync (read-only)
│   │   │   ├── hirehop-job-sync.ts         # HireHop job sync (read-only) + line items + requirement derivation
│   │   │   ├── hirehop-writeback.ts        # Push pipeline changes to HireHop
│   │   │   ├── crew-transport-calculator.ts # Delivery/collection/crewed cost engine
│   │   │   ├── hirehop-broker.ts          # Centralised HireHop API gateway (rate limit, cache, queue)
│   │   │   ├── hh-requirement-derivation.ts # HH-derived requirements engine (auto-detect vehicles, seats, backline, etc.)
│   │   │   ├── email-service.ts           # Email sending with SMTP, templates, test mode, audit
│   │   │   ├── email-templates/           # HTML email templates (base layout + per-template)
│   │   │   └── hire-form-pdf.ts           # PDF generation for driver hire forms (pdf-lib)
│   │   ├── middleware/      # Auth, RBAC, validation (zod)
│   │   ├── migrations/     # PostgreSQL migrations (hardcoded list in run.ts)
│   │   │   ├── 001_foundation.sql         # Core tables: people, orgs, venues, interactions, users
│   │   │   ├── 002_jobs.sql               # Jobs table, HireHop sync fields
│   │   │   ├── 003_job_status_tracking.sql # Pipeline fields, sync_log, chase tracking
│   │   │   ├── 004_pipeline.sql           # Pipeline status columns, lost reasons
│   │   │   ├── 005_fix_interaction_types.sql
│   │   │   ├── 006_merge_quoting.sql      # Merge enquiry+quoting pipeline columns
│   │   │   ├── 007_calculator.sql         # quotes table, calculator_settings, vehicles
│   │   │   ├── 008_quote_status_assignments.sql # Quote status workflow, quote_assignments (crew)
│   │   │   ├── 009_fix_sync_log_permissions.sql # Grant permissions on sync_log for backups
│   │   │   ├── 010_freelancer_fields.sql  # is_freelancer flag, joined date, review date, document tags
│   │   │   ├── ...                        # 011-015: fleet vehicles, service log, V5, maintenance, details
│   │   │   ├── 016_email_log.sql          # Email audit trail table
│   │   │   └── run.ts                     # Migration runner (hardcoded file list — add new migrations here!)
│   │   └── seeds/          # Demo data seeder
│   └── .env.example        # Required env vars
├── frontend/               # React SPA (Vite)
│   └── src/
│       ├── pages/
│       │   ├── LoginPage.tsx
│       │   ├── DashboardPage.tsx
│       │   ├── PeoplePage.tsx / PersonDetailPage.tsx
│       │   ├── OrganisationsPage.tsx / OrganisationDetailPage.tsx
│       │   ├── VenuesPage.tsx / VenueDetailPage.tsx
│       │   ├── JobsPage.tsx / JobDetailPage.tsx    # Job detail has tabs: Overview, Activity Timeline, Crew & Transport, Drivers & Vehicles, Money, Files
│       │   ├── PipelinePage.tsx                    # Kanban board
│       │   ├── TeamPage.tsx
│       │   ├── SettingsPage.tsx
│       │   ├── ProfilePage.tsx                  # User profile: avatar upload, password change, name edit
│       │   └── DuplicatesPage.tsx
│       ├── components/
│       │   ├── Layout.tsx              # Nav with "Address Book"/"Jobs" submenus + user avatar dropdown
│       │   ├── TransportCalculator.tsx  # Full calculator modal (delivery/collection/crewed)
│       │   ├── FileUpload.tsx
│       │   ├── ActivityTimeline.tsx
│       │   ├── GlobalSearch.tsx
│       │   ├── SlidePanel.tsx
│       │   ├── NotificationBell.tsx
│       │   └── PersonForm / OrganisationForm / VenueForm.tsx
│       └── contexts/       # AuthContext
├── shared/                 # Shared TypeScript types
│   └── types/index.ts      # Person, Organisation, Venue, Job, Interaction, User, Quote, QuoteAssignment, etc.
├── deploy/                 # Server deployment scripts
│   ├── setup-server.sh
│   ├── deploy.sh
│   ├── nginx-ooosh-portal.conf
│   └── ooosh-portal.service
└── docs/
    ├── SPEC.md             # Full system specification (v1.1)
    ├── PIPELINE-SPEC.md    # Pipeline/Kanban specification
    ├── DRIVER-HIRE-EXCESS-SPEC.md  # Driver hire forms & excess calculation spec
    ├── HIRE-FORM-REPOINTING-SPEC.md # Monday.com → OP repointing spec (Phase C)
    └── MAINTENANCE.md      # Health register & maintenance plan
```

## Key Commands

```bash
# Backend
cd backend && npm run dev          # Dev server with hot reload
cd backend && npm run build        # Compile TypeScript
cd backend && npm run db:migrate   # Run migrations
cd backend && npm run db:seed      # Seed demo data

# Frontend
cd frontend && npm run dev         # Vite dev server
cd frontend && npm run build       # Production build

# Server deployment
cd deploy && bash deploy.sh        # Pull, build, restart on server
```

## Deployment Playbook

When the user asks to "deploy" or "merge and deploy", follow these steps. The production server is at `49.13.158.66` and the user SSHs in as root.

### Multi-branch merge & deploy

When work has been done on multiple Claude branches and needs merging to a deployment branch:

1. **Identify branches to merge.** The user will tell you which branches contain new work.
2. **Pick or create a target branch** (usually the branch the server is currently on — check with `git branch` on server).
3. **Provide the user with these commands to run on the server** (Claude cannot SSH):

```bash
# On the production server (ssh root@49.13.158.66)
cd /var/www/ooosh-portal

# Step 1: Fetch the branches
git fetch origin <branch-1>
git fetch origin <branch-2>

# Step 2: Checkout the target branch
git checkout <target-branch>
git pull origin <target-branch>

# Step 3: Merge each source branch
git merge origin/<branch-1>
git merge origin/<branch-2>
# (resolve conflicts if any, then git add + git commit)

# Step 4: Run migrations (if any new ones)
cd backend && npm run db:migrate

# Step 5: Build
cd /var/www/ooosh-portal/backend && npm run build
cd /var/www/ooosh-portal/frontend && npm run build

# Step 6: Restart the service
sudo systemctl restart ooosh-portal

# Step 7: Verify
sudo systemctl status ooosh-portal
# Check logs for errors:
journalctl -u ooosh-portal -n 50 --no-pager
```

### Quick deploy (same branch, just pull latest)

```bash
cd /var/www/ooosh-portal
# Sanity check: if `git status` shows unexpected local changes on the server
# (uncommitted edits, untracked files on tracked paths), the pull below will
# abort with "your local changes would be overwritten". Investigate first
# — those edits are usually leftover from a previous deploy or manual
# hotfix. Once you're sure nothing on the server is precious, clear with
# `git reset --hard origin/<current-branch>` and re-run the pull.
git status
git pull origin <current-branch>
cd backend && npm run build
cd ../frontend && npm run build
sudo systemctl restart ooosh-portal
sudo systemctl status ooosh-portal
```

### Nginx configuration — IMPORTANT

**The live Nginx config is `/etc/nginx/sites-available/default` (NOT `ooosh-portal`).** The repo file `deploy/nginx-ooosh-portal.conf` is a reference copy but is NOT symlinked into `sites-enabled`. The active symlink is `default → /etc/nginx/sites-available/default`.

If you need to change Nginx behaviour (new location blocks, proxy rules, headers, etc.):
1. Edit `deploy/nginx-ooosh-portal.conf` in the repo (so the change is tracked in git)
2. Tell the user to **also apply the change** to `/etc/nginx/sites-available/default` on the server
3. After editing on server: `sudo nginx -t && sudo systemctl reload nginx`

**Do NOT** assume `deploy.sh` or `git pull` will update Nginx — it won't. Nginx changes require manual server-side application.

### Post-deploy checks
- Service should show `active (running)` within a few seconds
- Check `journalctl -u ooosh-portal -n 50` for any startup errors (DB connection, migration issues, missing env vars)
- Test the site at `https://staff.oooshtours.co.uk/`
- If migrations fail, check the error and fix — the migration runner skips already-applied migrations, so re-running is safe

## Login Credentials (Demo Seed)

- **Admin:** admin@oooshtours.co.uk / admin12345
- **Freelancer:** tom@example.com / freelancer123

## Current Status — Phase 2 (started March 2026)

### Phase 1 COMPLETE

- [x] Core data model: People, Organisations, Relationships, Venues, Interactions
- [x] Database migration system (001_foundation.sql)
- [x] JWT authentication (login, logout, token refresh)
- [x] Role-based access control middleware
- [x] Backend API routes: auth, people, organisations, venues, interactions, dashboard, search, users, files, notifications, backups, health
- [x] Frontend pages: Login, Dashboard, People, Organisations, Venues, Team, Settings, Duplicates (+ detail pages)
- [x] Shared TypeScript types
- [x] Server setup: Nginx reverse proxy, systemd service, PostgreSQL, Redis
- [x] Deployment scripts (setup-server.sh, deploy.sh)
- [x] Demo seed data (organisations, people, venues, interactions)
- [x] Live on Hetzner at 49.13.158.66
- [x] HireHop contact sync (read-only pull from HireHop → Ooosh)
- [x] Duplicate detection & merge tooling
- [x] Search and filtering
- [x] Activity timeline UI

### Phase 1 — Deferred / Ongoing

- [x] SSL certificate (Let's Encrypt via Certbot) — live at `https://staff.oooshtours.co.uk/`
- [x] Domain name configuration — `staff.oooshtours.co.uk`
- [x] Database backup automation (pg_dump to R2) — **FIXED 12 Mar 2026**: sync_log permission issue resolved via migration 009. Backups now working (1.10 MB verified). Daily at 02:00 via scheduler.

### Phase 2 — In Progress

- [x] **HireHop job sync (read-only pull)** — jobs table, sync service, API routes, job_value sync
  - Automated: runs every 30 minutes via `config/scheduler.ts`
  - Logged to `sync_log` table with status tracking
  - **Known issue:** job_value (money) not populating from HireHop. Fixed falsy check bug. May need `job_data.php` instead of `search_list.php`. Check `[HH Job Sync] Sample MONEY value:` in server logs.
- [x] **Jobs UI** — jobs list page, job detail view, status badges, filtering by status
- [x] **Enquiry & Sales Pipeline (Phases A–D)** — see docs/PIPELINE-SPEC.md
  - [x] Phase A: Data layer (migrations 003-006, pipeline fields, chase interaction type)
  - [x] Phase B: Backend API (pipeline endpoints, status transitions, chase logic, chase alerts)
  - [x] Phase C: Kanban board UI (6 columns, cards, drag-and-drop, filters)
  - [x] Phase D: Supporting UI (new enquiry form with file staging + service type quick-select, chase logging with quick-select & alerts, HireHop links, inline file viewer)
  - [x] Phase E: HireHop write-back (push status changes to HH via webhooks + write-back service)
  - [ ] Phase E.2: Create HH jobs from Ooosh (deferred)
- [x] **File management** — authenticated upload/download, inline viewer (images + PDFs), file tags & comments
- [x] **Enquiry/Quoting merge** — New Enquiry + Quoting merged into single "Enquiries" column
- [x] **Chase auto-mover** — runs every 15 minutes via `config/scheduler.ts`, moves jobs with `next_chase_date <= NOW()` to "chasing" pipeline status, logs status_transition interactions
- [x] **Chase modal improvements** — shared `ChaseModal.tsx` component used on Pipeline + Job Detail, chase logging moves job from Chasing → Enquiries (auto-mover brings back when due), preset defaults to 5 days (aligned with `chase_interval_days`)
- [x] **Delivery/collection calculator** — full transport quoting tool (see Crew & Transport section below)
- [x] **Crew assignments** — assign people to quotes with role, rate, status tracking (migration 008)
- [x] **Quote status workflow** — draft → confirmed → completed/cancelled with audit trail (migration 008)
- [x] **Navigation restructure** — "Address Book" submenu (People, Organisations, Venues) + "Jobs" submenu (New Enquiry, Enquiries, Upcoming & Out, Returns)

### Phase 2 — Active / Next Up (WORK ORDER)

**The dependency chain determines the order. Do NOT skip ahead — each step depends on the previous.**

#### Step 1: Vehicle Module Integration ← MOSTLY COMPLETE
Integrate the existing Vehicle Module (separate React app) into the OP as a route.

- [x] Add "Vehicles" nav group to Layout.tsx
- [x] Mount VM React components under `/vehicles/*` routes
- [x] Strip VM's own nav/auth shell, use OP session
- [x] Migrate VM's Netlify functions → OP backend API routes
- [x] Migrate Fleet Master off Monday.com → OP database (fleet_vehicles table + Monday xlsx import)
- [x] Vehicle fleet data (fleet_vehicles table with full schema)
- [ ] Driver Hire Forms migration (see Step 2)

See **Vehicle Module Integration** section below for technical details.

#### Step 1b: Vehicle Maintenance & Compliance ✅ PHASES A/C/D/E COMPLETE
Full maintenance tracking, compliance monitoring, and cost reporting for the fleet.

**Phase A — Service Log CRUD + Migration** ✅ COMPLETE
- [x] Migration 014 (fleet_vehicles extensions, vehicle_service_log extensions, vehicle_mileage_log, vehicle_fuel_log, vehicle_compliance_settings)
- [x] Service log CRUD API (list, create, update, delete) + file upload/download
- [x] "Service History" tab on VehicleDetailPage with filter pills + expandable records
- [x] Manual entry form with staged file uploads + comment field on files
- [x] Mileage auto-logged to vehicle_mileage_log on service record creation

**Phase C — Compliance Reminders** ✅ COMPLETE
- [x] Daily compliance scheduler (08:00) with configurable thresholds (warning/urgent days)
- [x] Enhanced Key Dates section: colour coding (green/amber/red), days countdown, "booked in" date fields
- [x] Insurance due date, provider, and policy number fields
- [x] Compliance overview widget on vehicles homepage (fleet-wide overdue/due-soon alerts)
- [x] Notifications targeted to configurable roles (deduped: 7-day for soon, 1-day for overdue)
- [x] Compliance settings API (GET/PUT for vehicle_compliance_settings)
- [x] On-demand compliance check endpoint (GET /api/vehicles/compliance/check)
- [ ] DVSA MOT History API integration (API key applied for 13 Mar 2026, ~5 day turnaround)
- [ ] DVLA Vehicle Enquiry Service for tax status (deferred)

**Phase D — Mileage Tracking** ✅ COMPLETE
- [x] Mileage logged on service record creation
- [x] Mileage API endpoints (GET history with stats, POST manual entry)
- [x] Book-out/check-in/prep events dual-write to vehicle_mileage_log
- [x] Current mileage display on vehicle detail (with last update date)
- [x] "Miles until service" computed indicator with green/amber/red
- [x] Amber warning on service mileage lower than current (in ServiceRecordForm)

**Phase E — Fuel Monitoring + Cost Reporting** ✅ COMPLETE
- [x] Fuel log CRUD endpoints + stats (total cost, litres, fill count, cost per mile)
- [x] "Fuel" tab on vehicle detail page with stats cards and add fuel form
- [x] Fuel fills with mileage also write to vehicle_mileage_log
- [x] Fleet-wide cost report page at `/vehicles/costs` (admin/manager only)
- [x] Per-vehicle service + fuel cost breakdown with sortable table
- [x] Time period selector with presets (YTD, 30d, 90d), CSV export

**Per-Vehicle Settings Page** ✅ COMPLETE
- [x] Admin-only settings route `/vehicles/fleet/:id/settings`
- [x] "Sell vehicle" / "Reactivate" moved to settings danger zone
- [x] Service interval settings (next due mileage, last service)
- [x] Insurance details (due date, provider, policy number)
- [x] Vehicle details (fuel type, MPG, CO2, tyre PSI)
- [x] Finance details (provider, end date)
- [x] Compliance alert thresholds editor (fleet-wide warning/urgent days for MOT, Tax, Insurance, TFL)
- [x] Vehicle detail page uses configurable thresholds (fetched from compliance settings API)

**Service History Enhancements** ✅ COMPLETE
- [x] Sort dropdown (newest/oldest, highest/lowest cost, garage A-Z, type)
- [x] Authenticated file download (JWT-based blob fetch, view images/PDFs in new tab)
- [x] Date display on service record cards (fixed `formatDate` for pg Date objects)

**Fleet Map Enhancements** ✅ COMPLETE
- [x] "Open Traccar" link replaces redundant Dashboard button (links to https://tracking.oooshtours.co.uk/)
- [ ] Nav dropdown z-index fix — `z-50` on header not sufficient, Leaflet map still overlays dropdown (known bug, low priority)

**Vehicle Detail Enhancements** ✅ COMPLETE
- [x] V5/Registration section on detail page (VIN, date first reg, type, body type, mass, category, cylinder capacity)
- [x] Vehicle Specs section (oil type, coolant type, tyre size, fuel type, MPG, CO2, tyre PSI)
- [x] Rossetts service tracking (last date + notes)
- [x] Service Plan Status picker (colour-coded: 0-6 Remaining, WORKINGONIT, NO PLAN)
- [x] Vehicle file uploads (V5 copy, insurance cert, wifi docs, finance docs, etc.) with labels + comments
- [x] Migration 015: oil_type, coolant_type, tyre_size, rossetts fields, service_plan_status, files JSONB

**Phase F — Fleet Turnaround Schedule** ← IN PROGRESS (May 2026)

Van-centric forward-facing view answering "which vans need prep, and when do I need them ready?". Solves the long-standing manual workaround where staff typed regs into job names and eyeballed it. Complements (does NOT replace) AllocationsPage — same data, different lens. AllocationsPage stays the allocation workflow (job-centric); Turnaround is the prep planning surface (van-centric).

**Where it lives:** Collapsible section at the top of `/vehicles/prep` (Prep Queue page). Default expanded, state persisted in localStorage (`turnaround-schedule-collapsed`). Initial mount was on `/vehicles` (HomePage) — moved May 2026 to keep the prep planning concern co-located with the prep workflow. No new top-level nav, keeps in line with the "streamline rather than expand" principle.

**Data:** Read-only from existing tables — no new schema needed.
- `vehicle_hire_assignments` — forward-looking rows per van (`vehicle_id IS NOT NULL`, `status IN ('soft', 'confirmed', 'booked_out', 'active')`, future `hire_end`)
- `fleet_vehicles` — compliance fields (MOT, tax, insurance, TFL, service due) + cached `hire_status`
- Joins to `jobs` via the dual match pattern (vha.job_id OR vha.hirehop_job_id) so V&D staff-allocation rows surface alongside hire-form rows

**Row shape per van** (read as table + mini horizontal strip):

| Column | Source | Notes |
|---|---|---|
| Reg | `fleet_vehicles.reg` | Click → Vehicle Detail |
| State now | `fleet_vehicles.hire_status` | Available / On Hire / Prep Needed / Not Ready / Sold |
| Coming back | Active assignment's `hire_end` + linked job ref | If state = On Hire / Active |
| Prep window (days) | `next_hire_start - return_date` | Colour-coded (see thresholds) |
| Going out next | Next future assignment's `hire_start` + linked job ref | "No next allocation" with green pill if empty |
| Flags | Compliance + breakdown markers | MOT/Tax/Insurance/TFL due within window, mid-tour swap, etc. |

**Prep window colour thresholds** (configurable via `calculator_settings`):
- `> 2 days` 🟢 green — Comfortable
- `1–2 days` 🟡 amber — Standard turnaround, within Ooosh's +1 day buffer
- `< 1 day` 🟠 orange — Eating into the buffer (physical-only window, ~90 min real prep)
- `≤ 0 days` 🔴 red — Stored dates overlap, needs human review

Prep window is computed against `jobs.return_date` (the inflated +1 day buffer), NOT `jobs.job_end`. Matches what staff actually live with.

**Edge cases:**

| Scenario | Display |
|---|---|
| No next allocation | "Available from [return date]" with green pill — positive signal, van could absorb an unallocated hire |
| Deallocations (`status='cancelled'`) | Drop out entirely. Timeline shows current commitment state, not history. Audit lives on Vehicle Detail event history. |
| Mid-tour swap (broken van) | Strip shortens to `swapped_at`, marked "↪ Swapped to RX22XYZ on …". Bubbles into a separate **"Needs assessment"** bucket pinned above prep priority — different team, different urgency (repair, not prep) |
| Mid-tour swap (replacement van) | Strip starts mid-stream from `swapped_at`, marked "↩ Swap-in from RX17ABC". Counts toward replacement's prep window from there on |
| `Sold` / `Not Ready` | Hidden by default, toggleable filter to surface |

**Filter + sort** (per jon's amendment, May 2026):
- **Search by reg** — narrow to one van or a partial match
- **Filter pills:**
  - State: All / On Hire / Prep Needed / Available
  - Compliance: All / Has flag (any of MOT/Tax/Insurance/TFL/Service)
  - Has next allocation: All / Yes / No (lets staff find vans free to take work)
- **Sort modes** (dropdown):
  - **Urgency** (default) — shortest prep window first, "Needs assessment" bucket pinned above
  - **Returning soonest** — what's coming back today vs next week (useful when planning warehouse workload by day)
  - **Going out soonest** — when's the next departure
  - **Reg A–Z** — alphabetical fallback
- **Range presets:** 7 / 14 / 28 days (default 14)

**Non-blocking:** all warnings, no hard gates. Red prep windows don't prevent allocation or book-out. Consistent with the OP convention — dispatch is the only hard gate, and even that has manager override.

**Deep-links** (when staff want to act on what they see):
- Click reg → Vehicle Detail
- Click hire block → Job Detail for that hire
- **"🔧 Prep this van →"** per-row CTA → on-page hash anchor (`#prep-card-<reg>`) that scrolls to the matching card in the Prep Queue below the section. Staff click "Start Prep" on the card explicitly — no surprise auto-actions. CTA hidden on rows where the van is currently out and won't be back in the visible window.

The original "Find a job for this gap →" link (deep to AllocationsPage with date-range hint) was removed May 2026 — the section's home moved to `/vehicles/prep` and the CTA changed to focus exclusively on prep, not allocation. If "fill a gap with an unallocated job" surfaces operationally as a need again, that's a separate Allocations-side feature, not a Turnaround responsibility.

**Compliance pip overlay:** Above each strip's time axis, small chevrons mark MOT / Tax / Insurance / TFL / Service-by-miles thresholds falling in the visible window. Tooltip on hover shows the exact date or mileage. Reuses existing compliance threshold settings (warning/urgent days). This is the bonus the user flagged — same surface answers "should I prioritise prepping this one because the MOT clears tomorrow but it goes out Friday?".

**Backend endpoint:**
```
GET /api/vehicles/turnaround-schedule?days=14&state=all&compliance=all&has_next=all&sort=urgency&q=
```
Returns one row per active vehicle. Cached briefly (5–10s) since the underlying data only changes on assignment writes. Auth: any staff role (STAFF_ROLES).

**Settings (admin-editable):**
- `prep_window_amber_threshold` (default 2 days)
- `prep_window_red_threshold` (default 0 days — i.e. overlap = red)
- `prep_window_orange_threshold` (default 1 day — eats buffer)

Stored on `calculator_settings` for now (or move to `fleet_settings` if other fleet-specific knobs accumulate). Matches the "Allocation turnaround buffer" item flagged in Future Enhancements — both should eventually read from one source.

**Build order:**
1. Backend endpoint with filter/sort
2. Frontend section on `/vehicles` (table + mini-strip)
3. Settings page entries for thresholds
4. Deep-link from gaps to AllocationsPage
5. Compliance pip overlay
6. *(Future)* Drag-to-allocate from the strip, bundled with the deferred van-centric AllocationsPage rebuild

**Dedup contract (May 2026):** Self-drive client hires can land TWO `vehicle_hire_assignments` rows for the same `(vehicle_id, job)` pair — one staff-allocation row (status='confirmed') and one hire-form row (status='booked_out'). Both pass the "forward commitment" filter. Without dedup the booked-out row becomes "current" and the confirmed row becomes "next" — same job appears in both columns. The endpoint dedupes per `(vehicle, jobKey)` where `jobKey = uuid:<job_uuid> | hh:<hh_job_number> | asg:<assignment_id>` (last fallback keeps unlinked rows distinct). Winner is the most-progressed status (active > booked_out > confirmed > soft), tied by latest `status_changed_at`. Any future "forward commitment" SQL touching `vehicle_hire_assignments` that aggregates per van should apply the same dedup rule.

**Out of scope (deliberately):**
- Drag-to-allocate from the Turnaround surface (deferred — would multiply allocation logic surface area)
- Past-history view (not the question staff are asking; audit lives on Vehicle Detail)
- True Gantt with overlapping hires per van (overlaps mean a data error — surfaced via red prep window, not a UI feature)

**Phase B — AI Document Extraction** (deferred — nice-to-have, end of build)
- [ ] POST /extract endpoint: upload invoice/service record → Claude extracts fields → returns JSON
- [ ] "Upload & Extract" mode in service record form — preview extracted data, user confirms
- [ ] Future: receipt uploader integration (general receipts with "is this for a van?" routing)

See **Vehicle Module Integration** section below for technical details.

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
  - `soft`/`confirmed`, van linked → **📋 Book Out** (deep-links BookOutPage with `?vehicle=&job=` pre-fill)
  - `booked_out`/`active` → **↩️ Check In** (deep-links CheckInPage with `?vehicle=` pre-fill)
  - `returned`/`cancelled`/`swapped` → no button, status badge only
- [x] Sibling-staff-allocation inference: when a hire-form-driven row has `vehicle_id IS NULL` but a separate staff-allocation row on the same `van_requirement_index` has a vehicle, the card surfaces "Book Out" (not "Allocate Van") pointing at the inferred vehicle. `loadVehicleAssignments` does two parallel fetches (`?job_id=` + `?hirehop_job_id=`) and composes `effective_vehicle_id` per row. BookOutPage's PATCH cements the link at submit time.
- [x] Quick Assign demoted: prominent primary button → subtle "+ Add driver manually" text link, gated to admin/manager only, tooltip explains when to use. Modal flow itself unchanged — still `/api/hire-forms/quick-assign` on the backend.
- [x] Send / Chase hire form button untouched (lives on Job Requirements vehicle card, mid-tour use case preserved).

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
- Hire form submission with `requires_referral=true` → `referral_status` stays NULL (red Refer to Insurers todo state). Pre-May 2026 `routes/hire-forms.ts` was setting `'pending'` here, jumping the queue and making it look like staff had already actioned something they hadn't. The `referral_alert` email to admins still fires from `requires_referral=true`, independent of `referral_status`.
- Staff clicks "Mark as Referred to Insurer" on DriverDetailPage → `referral_status='pending'`, `referral_date=today` (audit of when the email actually went out). Button only renders when `referral_status IS NULL`.
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

**Phase D3 — Vehicle Swap (Breakdown / Reallocation)** ← IN PROGRESS (May 2026)
When a vehicle breaks down mid-hire and needs swapping to a replacement.

**Full spec:** `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md` — covers the swap UI, the soft check-in primitive (also used by the future freelancer-led handover), Job Issues integration, the orphan dedup root-cause fix, and the sweeper script. Read it before touching swap code.

**Motivation incident (15 May 2026, HH 15378):** staff tried to swap a brake-faulty van for RO23HLU; the swap was blocked because an orphaned `confirmed` `vehicle_hire_assignments` row from a previous hire (15613) still "occupied" HLU in the overlap check, even though the real hire had been checked in hours earlier. Root cause = dual-row pattern (staff-allocation row + hire-form row) not deduplicated at staff book-out time.

*PR 1 — Foundation + cleanup (shipped May 2026):*
- [x] **Orphan dedup at book-out** — `services/vha-dedup.ts` `cancelOrphanSiblingAllocations()`, called from `PATCH /api/hire-forms/:id` book-out completion AND `POST /api/assignments/:id/book-out`. Cancels sibling staff-allocation rows (driver_id NULL, never booked out, soft/confirmed) for the same (vehicle, job) once a hire-form row owns the van. Multi-driver-safe (driver_id IS NULL guard preserves real second drivers).
- [x] **Soft check-in primitive** — `save-event` handles `eventType='soft-check-in'`: sets `fleet_vehicles.hire_status='Not Ready'` (sticky, preserved by the final `syncFleetHireStatusByReg` reconcile), does NOT flip assignment status (caller owns that), no HH writeback, no close-out requirements. Mileage logged generically. `buildConditionReportPdf` gains an `isInterim` flag → "INTERIM VEHICLE ASSESSMENT" title, context banner, no signature block, `-interim.pdf` filename.
- [x] **Sweeper script** — `scripts/cleanup-orphan-vha-rows.ts` (dry-run default, `--commit`, `--vehicle=REG`, `--job=HHNUM`). Cleans historical orphans the live dedup pre-dates. Soft-cancel + fleet status re-sync. Idempotent.

*PR 2 — Swap UI (NOT YET BUILT — next session can pick up from the spec):*
- [ ] "Swap Vehicle" button on Job Detail > Drivers & Vehicles tab (per-assignment, `admin`/`manager`/`weekend_manager` only — see spec §1 RBAC note)
- [ ] Swap modal: reason picklist + details, replacement van picker (live availability check), soft check-in fields for the swapped-out van, Job Issue link-or-create section
- [ ] Multi-driver auto-cascade (all siblings on the van slot move together, single submit)
- [ ] Extend `POST /api/assignments/:id/swap-vehicle` to accept `soft_checkin` + `issue_link` payloads, fire soft check-in event, link/create `job_issues`, post HH job memo note
- [ ] Frontend post-submit redirect → BookOutPage for the replacement van (fresh walkaround + hire agreement PDF email)
- [ ] VE103B regen for replacement if original had `ve103b_ref` (international)
- [ ] Both assignments visible in driver Hire History (audit: "was in GX17DHN → swapped to RX22SWN on 25 Mar")
- [ ] Migration columns `swap_reason`, `swapped_at`, `swapped_to_assignment_id` already exist — no migration needed
- [ ] Future: client notification of vehicle change

*Immediate follow-on after PR 2:* freelancer-led interim check-in UI (reuses the soft check-in primitive shipped in PR 1 — see spec §6 + §9).

#### Step 3: Money System (Unified Financial View) ← IN PROGRESS
The OP becomes the staff's financial view of every job, reading from HireHop for accounting data and adding intelligence on top. HireHop stays the accounting engine; the OP is the operational dashboard.

**Architectural principle:** One "Money" tab per job showing the complete financial picture — hire value, deposits, insurance excess, VAT adjustments, payment history. Excess tracking is a component within the Money system, not a separate silo.

**What each system does:**
| System | Role | Good at | Bad at |
|---|---|---|---|
| HireHop | Accounting engine | Deposits, invoices, Xero sync, billing | Knowing what kind of deposit it is, driver linkage, lifecycle |
| OP | Operational dashboard | Context (this deposit = excess for driver X), lifecycle, gate conditions, VAT intelligence | Accounting / Xero sync |
| Payment Portal | Client-facing collection | Stripe checkout, payment options display | Staff workflow, lifecycle tracking |

**Data flow — how money moves:**
```
Client pays via Payment Portal (Stripe)
  → Stripe webhook fires
  → Portal creates HH deposit (accounting record)
  → Portal calls OP: "payment recorded for job X, type: excess/deposit/balance"
  → OP updates job_excess status if excess payment
  → OP records in job_payments for unified history
  → OP fires email to client
  → Both systems in sync

Staff records manual payment (bank transfer, card in office, cash)
  → Records on OP Money tab: "£1200 bank transfer, type: excess"
  → OP creates HH deposit automatically (via write-back)
  → OP updates job_excess if excess payment
  → One entry point, both systems updated
```

##### Phase A — Insurance Excess (Database + Backend) ✅ COMPLETE
- [x] `job_excess` table with full financial lifecycle fields
- [x] `excess_rules` table (configurable points tiers + referral triggers)
- [x] `client_excess_ledger` view (running balance per Xero contact, includes override count)
- [x] Excess CRUD + payment/claim/reimburse/waive endpoints (`excess.ts`)
- [x] Migration 034: `dispatch_override` fields, `suggested_collection_method`, `person_id` linkage, `notes`
- [x] Override endpoint (`POST /api/excess/:id/override`) — manager+ auth with reason picklist
- [x] Move/reassign endpoint (`POST /api/excess/:id/move`) — move excess to different Xero contact/person
- [x] By-person endpoint (`GET /api/excess/by-person/:personId`) — address book integration
- [x] By-org endpoint (`GET /api/excess/by-org/:orgId`) — address book integration
- [x] Client balance check (`GET /api/excess/client-balance/:xeroContactId`) — for auto-suggest
- [x] Migration 060: stop the `client_excess_ledger` view picking a misleading `MAX(client_name)` for the UNLINKED group — derivation-engine creates leave `xero_contact_id`/`client_name` NULL, all collapse into one bucket, and `MAX(client_name)` was alphabetically pinning a real client (e.g. "Zal Jones") on top of every other unlinked record on the summary table. The drill-in always showed correct per-job clients; only the summary label was wrong. Fix forces the UNLINKED group to display 'Unlinked Records'. Underlying data untouched, no Xero impact.
- [x] **Migration 063: widen ledger grouping key to `client_name` when `xero_contact_id` is NULL** (24 Apr 2026). Partial companion to the 060 display fix. Previously every record without `xero_contact_id` collapsed into the single `'UNLINKED'` bucket, making portal-created excess records for unrelated clients look like they belonged to one shared "Unlinked Records" client on the `/money/excess` summary table. Fix: (a) `hh-requirement-derivation.ts` now populates `client_name` from `jobs.client_name` on auto-create (was inserting NULL); (b) one-shot backfill in migration 063 rescues existing derivation-created records by copying `client_name` across from their linked job; (c) ledger view grouping key is now `CASE WHEN xero_contact_id IS NOT NULL THEN xero_contact_id WHEN client_name IS NOT NULL THEN 'name:' || client_name ELSE 'UNLINKED' END`, so records for distinct clients bundle under their own name; (d) `GET /api/excess/ledger/:xeroContactId` understands all three key forms (real ID / `name:<...>` / `UNLINKED`) and queries `job_excess` accordingly; (e) `ExcessLedgerPage.tsx` URL-encodes the key so names with spaces/special chars round-trip safely. Only records with no `xero_contact_id` AND no `client_name` still fall into UNLINKED.
- [ ] **Proper `xero_contact_id` column on `organisations`** — the remaining follow-up. Migration 063 closed the immediate "everyone is Unlinked" UX gap, but the real fix is: (a) add `xero_contact_id` column on `organisations`; (b) populate from HH contact sync (HH stores the Xero link via its accounting bridge); (c) read it into `job_excess` at creation time so records pair to real Xero contacts from the start; (d) one-shot backfill script for the existing records, reading the linked job's client organisation. Until done, the name-based bundling from 063 works but ties records to a mutable string rather than a stable Xero ID.

**Excess calculation — "Top N Drivers" algorithm:**
The hire form process calculates excess. The principle: charge the excess of the highest-risk drivers, one per van. Sort all drivers by excess descending, take top N (N = van count), sum. If fewer drivers than vans, fill remaining slots with standard £1,200/van. The OP stores the calculated total via `job_excess.excess_amount_required`.

**Excess record lifecycle (16 Apr 2026):**
`job_excess` records are created at three points — each subsequent step absorbs/updates the previous:
1. **Derivation engine** (earliest): When self-drive vehicles detected on HH, auto-creates `job_excess` with `required = van_count × £1,200`, `status = 'needed'`. Gives the Money tab and payment portal a record before any hire form is submitted.
2. **Payment portal** (mid): When portal charges/pre-auths excess before a hire form exists, `payment-event` finds the derivation-created record and updates `amount_taken` + `status` to `'taken'` or `'pre_auth'`. If no record exists (edge case), auto-creates one.
3. **Hire form submission** (latest): When driver submits hire form with calculated excess, `POST /api/hire-forms` checks for an existing unlinked record (`assignment_id IS NULL`). If found, absorbs it: updates `required` to the hire-form-calculated amount while preserving `amount_taken`. This naturally surfaces gaps (e.g. £1,200 taken but £1,800 required → £600 outstanding).

##### Phase B — Excess Gate + Ledger UI ✅ COMPLETE (1 Apr 2026)
- [x] `ExcessGateBanner.tsx` — amber warning on Job Detail Drivers & Vehicles tab with manager override flow
- [x] `ExcessPaymentModal.tsx` — record payment, claim, reimburse, waive, rollover, move to different entity
- [x] `ExcessLedgerPage.tsx` at `/money/excess` — global view with client ledger + all-records views
- [x] `ExcessHistorySection.tsx` — reusable component for address book pages (person/org detail)
- [x] "Excess History" tab on PersonDetailPage and OrganisationDetailPage
- [x] "Money > Excess" nav group in Layout.tsx (admin/manager only)
- [x] 6 email templates for excess lifecycle (payment confirmed, pre-auth confirmed, reimbursed, partial, claimed, pre-auth released)
- [x] Email triggers wired to payment, claim, reimburse actions (excess.ts endpoints)
- [x] Auto-select single pending excess record in MoneyTab payment form
- [x] Move entity UX: org/person search picker instead of raw Xero ID
- [x] Client balance "Applied from Account Balance" option only shows when balance > 0
- [x] Reimburse methods: full list matching payment methods, defaults to original payment method
- [x] `assignment_id` nullable on `job_excess` (migration 037) — excess can be tracked without hire form
- [x] `POST /api/excess/create` — manual excess creation from Money tab
- [x] Insurance Excess section always visible on Money tab (guidance when empty)
- [x] Dispatch check includes job-level excess records (not just hire-form-linked)
- [x] Auto-suggest "client has £X on account" — shown on ExcessGateBanner when client has rolled-over balance (FIXED 3 Apr)
- [x] HH ↔ OP excess reconciliation (migration 039): `hh_deposit_id` on `job_excess`, passive reconciliation on Money tab load, manual link/unlink, create-from-HH endpoint
- [x] Excess ledger filtering: search, status, payment method, sort (date, amount, client), date columns

**Excess status values (migration 038, 1 Apr 2026):**
| Status | Label | When set |
|---|---|---|
| `needed` | Needed | Auto on excess record creation |
| `partially_paid` | Partially Paid | Payment < required amount |
| `taken` | Taken | Payment >= required amount |
| `pre_auth` | Pre-auth Taken | Card hold without charge |
| `waived` | Waived | Admin decision to skip |
| `fully_claimed` | Fully Claimed | Damage — keeping full amount |
| `partially_reimbursed` | Partially Reimbursed | Returning some, claiming rest |
| `reimbursed` | Reimbursed | Full excess returned |
| `rolled_over` | Rolled Over | Held on account for next hire |

**HH reimbursement write-back (1 Apr 2026):** Uses `billing_payments_save.php` (payment application against specific deposit), NOT negative deposits. Finds original HH deposit ID from `job_payments` table or by searching HH billing for excess-classified deposits. Xero sync via `hh_task: 'post_payment'`.

##### Phase C — Money Tab on Job Detail ✅ COMPLETE (27 Mar 2026)
"Money" tab on Job Detail showing the unified financial picture. HireHop is the **source of truth** for all financial data — the OP reads from HH and displays, never maintains a separate copy for display purposes.

**Key architecture decision:** Payment history reads directly from HH `billing_list.php` on every page load. The OP does NOT maintain its own payment history table for display — this prevents sync drift. The `job_payments` table exists only as a write-path audit log (recording what the OP pushed to HH), not as a read-path data source.

**How billing_list.php works:**
- Endpoint: `GET /php_functions/billing_list.php?main_id={jobId}&type=1`
- Returns: `{ rows, subs, banks, page, total, records }`
- Row kinds: `0` = Job total (accrued = ex-VAT hire value), `1` = Invoice, `2` = Credit note, `3` = Payment application, `6` = Deposit/payment
- Hire value comes from `kind=0` row's `accrued` field
- Deposits from `kind=6` rows' `credit` field
- Bank names resolved via `banks[]` array in response (maps `ACC_ACCOUNT_ID` → bank name)
- Excess vs hire classification via keyword detection on description ("excess", "insurance", "xs", "top up")

**HireHop bank account IDs:**
| ID | Name | Used for |
|---|---|---|
| 165 | Amex | Amex card payments |
| 168 | Till (Cash) | Cash payments |
| 169 | Worldpay (all cards EXCEPT AMEX) | Card terminal payments |
| 170 | Lloyds Bank | Bank transfers (legacy) |
| 173 | Paypal | PayPal payments |
| 265 | Wise - Current Account (BACS) | Bank transfers (primary) |
| 267 | Stripe GBP | Payment Portal / online card |

**What's built:**
- [x] `money.ts` route: `GET /:jobId/summary` reads HH billing + OP excess + client balance
- [x] `POST /:jobId/record-payment` creates HH deposit (two-step: `billing_deposit_save.php` + `accounting/tasks.php` Xero sync) + records in OP `job_payments`
- [x] `POST /:jobId/payment-event` receives external payment events (for Payment Portal repointing)
- [x] `job_payments` table (migration 035) — write-path audit log, not display source
- [x] `payment_terms` + `payment_terms_notes` columns on organisations table
- [x] MoneyTab.tsx: financial summary (hire value, VAT, deposits, balance, progress bar)
- [x] MoneyTab.tsx: insurance excess section with manage actions
- [x] MoneyTab.tsx: payment history from HH billing_list (split hire/excess, bank names, refunds)
- [x] MoneyTab.tsx: record payment form (type, amount, HH bank, reference, notes, push-to-HH checkbox)
- [x] MoneyTab.tsx: client balance on account auto-suggest
- [x] Payment methods match HireHop bank accounts exactly (same names, same IDs)
- [x] Smart payment form: quick-click amounts (25% deposit, 50%, full/remaining), auto-detect deposit vs balance
- [x] Deposit calculator: min 25% (floor £100), full payment if <£400
- [x] Job values populated from HH billing_list accrued (side-effect on Money tab view + bulk sync endpoint)
- [x] "Overview" tab (renamed from Job Requirements) with payment progress bar at top
- [x] Email templates: booking confirmed, payment received, excess received/reimbursed/claimed, last-minute alert
- [x] Email branding: purple header (#7B5EA7), footer "Transport - Backline - Rehearsals"
- [x] Method-specific refund timescales (Worldpay 2-3d, Stripe 5-10d, bank transfer hours, PayPal instant)
- [x] Last-minute booking alert: fires on any route to Confirmed when job starts within 3 days (same-day variant)
- [x] Email triggers wired into: money.ts record-payment, excess.ts reimburse/claim, pipeline.ts status change
- [x] Deposit payment auto-confirms booking (OP→Confirmed, HH→Booked status 2)
- [ ] Email logo: real Ooosh logo in email header (logo in R2 at assets/ooosh-logo.png, needs public URL)
- [ ] Wire email triggers into Payment Portal events (when portal repointed)

**Known bugs / remaining polish (1 Apr 2026):**
- [x] Job header status doesn't refresh after payment without page reload — FIXED 3 Apr (onJobChanged callback from MoneyTab → loadJob)
- [x] "Move to Different Entity" UX — now uses org/person search picker (FIXED 1 Apr)
- [x] Excess auto-select — single pending record auto-selected in payment form (FIXED 1 Apr)
- [x] Excess payment method default — was 'payment_portal' (invalid), now defaults to 'worldpay' (FIXED 1 Apr)
- [x] Excess payment should not count toward "Deposits Received" in financial summary (FIXED 31 Mar)
- [x] Excess payments sent generic "Payment Received" email instead of excess-specific template (FIXED 31 Mar)
- [x] HH ↔ OP excess deduplication: migration 039 adds `hh_deposit_id` to `job_excess`, passive reconciliation on Money tab load matches HH excess deposits to OP records, manual link/unlink + create-from-HH for edge cases (FIXED 3 Apr)
- [x] Email recipient: excess emails now fall back to client organisation email when no people contacts found (FIXED 3 Apr)
- [ ] Excess email: "finishes" vs "finished" tense depends on context (payment received = future, reimbursement = past) — FIXED 1 Apr
- [x] **Excess Manage modal silent-failure + idempotency (FIXED May 2026)** — `POST /api/excess/:id/payment` had two distinct gaps: (a) it never pushed to HireHop and never inserted a `job_payments` row, so excesses recorded via Manage > Record Payment never appeared in HH billing or in Money tab payment history; (b) it used additive `excess_amount_taken = previous + amount` semantics, so clicking Save twice doubled the collected amount. Job 15624 incident: £1200 worldpay was saved twice via Manage modal, ending up at £2400 collected against £1200 required, while HireHop showed nothing for the excess. Fix: shared `services/hh-deposit.ts` helper called by both `/excess/:id/payment` and `/money/:jobId/record-payment`. Both endpoints now (a) push to HH and surface `hh_push_error: string | null` in the response (frontend renders amber "Saved in OP — HireHop push failed" banner when set), (b) accept `total_collected` (absolute new total) for idempotent re-submits, (c) auto-find existing excess records on the job when `excess_id` isn't passed (preferring pre-collection records, falling back to most recent for top-ups). The Money tab Record Payment > Excess form also dropped its status filter so `taken` records are visible (previously hidden, leading to a misleading "no excess record exists" banner that promised auto-creation the backend never implemented). See "HireHop Deposit Push" under Shared Utilities for the failure-surfacing contract.
- [x] **HireHop kind=3 dual-publishing — direct invoice payments showing as outstanding (FIXED May 2026)** — HireHop's `billing_list.php` publishes every deposit-applied-to-invoice record as TWO `kind=3` rows: once as a child of the deposit (`parent_is="deposit"`, negative credit) and once as a child of the invoice (`parent_is="invoice"`, positive credit). Both rows carry the same `data.ID`. Our `kind=3` handler in `routes/money.ts` was processing both, doubling `hireDepositAppliedToInvoices`. The reconciliation step `directInvoicePayments = max(totalPaidOnApprovedInvoices − hireDepositAppliedToInvoices, 0)` then clamped to zero, swallowing legitimate direct-to-invoice payments. **Latent on every job**, but only visibly broken on jobs with a side invoice paid directly (shop sales, additional driver fees added post-deposit, ad-hoc damage charges). Skindred job 15577 incident: £23.40 fluoro-tape invoice paid £23.40 by worldpay; HH showed £0 owing on the invoice; OP showed £23.40 outstanding because the £1,710 deposit-applied-to-balance-invoice was being counted twice in the subtraction. Fix: `Set<number>` of seen application IDs scoped per-summary-call; the `kind=3` handler skips any row whose `data.ID` has already been processed and emits a `console.warn` for telemetry. Falls through when `data.ID` is missing so we never lose data. Affects only the deposit-applied-to-invoice case (direct invoice payments and refunds publish as a single row, no dedup fires). The Payment Portal (`get-job-details-v2.js` and friends) implemented the same fix on its side — it computes balance independently from the same `billing_list.php` response, so a fix on either side alone wouldn't have closed the gap on the other.

##### Phase D — VAT Adjustment Display ✅ COMPLETE (30 Mar 2026)
Port the international VAT calculation from the Payment Portal into the OP. Staff now see VAT breakdowns directly on the Money tab instead of visiting the client payment portal.

*Backend service (ported from `vat-adjustment.js`):*
- [x] `services/vat-adjustment.ts` — full port of Payment Portal logic (v4, nominals-based, penny-perfect)
- [x] Read job items from HH `items_to_supply_list.php` via broker
- [x] Read revenue by nominal from HH `job_margins.php` via broker
- [x] Detect trigger item ("Non-standard VAT rules..." with non-UK days as quantity)
- [x] Apply HMRC rules: vehicles (proportional or 0% if 31+ days), equipment (proportional), services (always 20%)
- [x] Return breakdown with penny-perfect figures per category
- [x] Endpoint: `GET /api/money/:jobId/vat-adjustment`
- [x] Summary endpoint includes VAT adjustment — adjusted totals used for balance calculation

*Frontend display:*
- [x] VAT adjustment section on Money tab (only shown when trigger item detected)
- [x] Category breakdown: Vehicles / Equipment & Backline / Services with net/VAT/gross
- [x] Per-category: rule applied shown inline
- [x] Original vs adjusted total with strikethrough, VAT saved in green banner
- [x] Financial summary shows "(adjusted)" label with strikethrough original figures
- [x] Explanation text for context

##### Phase E — Payment Portal Repointing (non-destructive, env var toggle)
The Payment Portal (ooosh-tours-payment-page.netlify.app) currently reads from Monday.com and writes to both Monday.com and HireHop. Repointing to OP, protected by `DATA_BACKEND` env var (default: `monday`, flip to `op` when ready).

*OP endpoints needed for portal:*
- [x] `GET /api/money/:jobId/summary` — hire value, deposits, balance, excess status (built, replaces portal's `get-job-details-v2.js` Monday.com calls)
- [x] `POST /api/money/:jobId/payment-event` — receive payment events from portal (built, replaces Monday.com status updates)
- [x] `GET /api/money/:jobId/excess-info` — excess amount, driver breakdown, pre-auth eligibility (built, replaces `monday-driver-excess.js`)
- [x] `GET /api/money/job-lookup/:hhJobNumber` — resolve HH job number to OP UUID + job details (16 Apr 2026)
- [x] All money endpoints accept HH job number OR OP UUID in `:jobId` param (auto-detect via regex)
- [x] API key auth on all money routes via `authenticateFlexible` middleware (prefix-based `api_keys` table lookup)

*OP-side enhancements for portal go-live (16 Apr 2026):*
- [x] `payment-event` auto-confirms bookings: deposit/balance payment on pre-confirmed job moves to `confirmed` + pushes HH status 2 (Booked)
- [x] `payment-event` handles pre-auth: `payment_type: 'excess_pre_auth'` sets `excess_status = 'pre_auth'` (distinct from `taken`)
- [x] `payment-event` auto-creates `job_excess` record when no `excess_id` provided (portal charges before hire form submitted)
- [x] `payment-event` Zod input validation + email triggers (booking confirmed, excess payment, pre-auth, last-minute alert)
- [x] `payment-event` accepts `hh_deposit_id` for HH ↔ OP reconciliation
- [x] Hire form submission absorbs existing portal-created excess records (updates required amount, preserves amount already taken)
- [x] Derivation engine auto-creates `job_excess` record with standard £1,200/van when self-drive vehicles detected
- [x] Hire form auto-email triggered on confirmation via payment-event (was only in pipeline.ts status change)
- [x] Excess-info response includes portal-compatible field aliases (`excess_amount`, `excess`, `id`)
- [x] **Excess requirement auto-completes (17 Apr 2026):** `syncExcessRequirementStatus()` helper promotes the pre-hire excess requirement to `done` when coverage is met — called from payment-event, record-payment, excess payment/claim/reimburse/waive, and the derivation engine. Forward-only (doesn't un-do on reversal).
- [x] **`all_cleared` semantics tightened (17 Apr 2026):** a record is cleared only if in a terminal state OR `amount_taken >= amount_required`. Previously `pre_auth` alone flipped `all_cleared=true` regardless of amount — underfunded pre-auths now correctly surface as outstanding.
- [x] **Overview card field-name fix (17 Apr 2026):** RequirementCard reads `total_excess_required/collected/outstanding` (matches API), not the old `total_required/collected/outstanding` aliases.

*Portal-side changes (in payment portal repo):*
- [x] Add `DATA_BACKEND` env var to Netlify config (default: `monday`)
- [x] Create `op-backend.js` shared helper (`isOpMode()`, `opFetch()`, retry logic)
- [x] Repoint `get-job-details-v2.js` → `GET /api/money/{jobId}/summary`
- [x] Repoint `get-admin-details.js` → `GET /api/money/{jobId}/summary`
- [x] Repoint `monday-driver-excess.js` → `GET /api/money/{jobId}/excess-info`
- [x] Repoint `monday-integration.js` payment status → `POST /api/money/{jobId}/payment-event`
- [x] Repoint `monday-excess-checker.js` pre-auth status → `GET /api/money/{jobId}/excess-info`
- [x] Repoint `handle-stripe-webhook.js` post-payment → `POST /api/money/{jobId}/payment-event` (passes `hh_deposit_id`)
- [x] Repoint `admin-claim-preauth.js` post-capture → `POST /api/money/{jobId}/payment-event` (passes `hh_deposit_id`)
- [x] Repoint `admin-refund-payment.js` post-refund → `POST /api/money/{jobId}/payment-event` with `payment_type: 'refund'`
- [x] Repoint `validate-job.js` → `GET /api/money/job-lookup/{hhJobNumber}`
- [x] Pre-auth timing: falls back to local `determineExcessPaymentTiming()` when OP doesn't provide `pre_auth.method`
- [x] `DATA_BACKEND=op` deployed on Netlify production (16 Apr 2026)
- [x] Pre-auth display in portal (17 Apr 2026): date, amount, method, Stripe PI reference rendered alongside payment history. All fields already in `excess-info` response per driver (`payment_date`, `payment_reference`, `payment_method`, `excess_amount_taken`, `driver_name`).
- [ ] Monitor for 1-2 weeks, then remove Monday.com fallback code
- [ ] Client ledger balance surfaced in portal (requires `client_balance_on_account` in excess-info response)

*Known gaps / follow-ups (non-blocking, captured 17 Apr 2026):*
- [x] **API key auth vuln — FIXED May 2026:** `authenticateFlexible` in `money.ts` and the inline check in `webhooks.ts` `/external/status-transition` now route through the shared `middleware/api-key.ts` `verifyApiKey()` helper, which pulls all rows with the matching `key_prefix` and `bcrypt.compare`s the full key against each `key_hash`. Previous behaviour matched only the 8-char prefix and accepted any string starting with `ppk_live`. Pre-deploy audit script: `backend/src/scripts/audit-api-key-hashes.ts` (checks every row's hash is bcrypt-shaped — non-bcrypt rows would stop authenticating after the fix, so they need re-issuing first).
- [ ] **Refund path doesn't unwind excess record:** `payment-event` with `payment_type: 'refund'` or `'excess_refund'` records the payment in `job_payments` but doesn't flip `excess_status` back from `pre_auth`/`taken`. Staff must manually mark reimbursed on Money tab.
- [ ] **Pre-auth capture vs release:** portal's `admin-claim-preauth.js` fires `payment_type: 'excess'` to capture a hold as a real charge. Works in common case but on pre_auth records `amount_taken` is REPLACED (not added), so split-capture scenarios could produce odd aggregates.
- [ ] **Stripe pre-auth expiry scheduler — FAIRLY HIGH PRIORITY (21 Apr 2026):** OP currently trusts a stored `excess_status = 'pre_auth'` indefinitely, but Stripe auto-voids holds after ~7 days and Ooosh policy is to re-take inside 4 days. Need a daily scheduler task that scans `job_excess` records with `status = 'pre_auth'` and a `payment_date` (or `updated_at`) older than 4 days, flips them to a new `expired` (or `pre_auth_expired`) status, and fires a bell notification + email to staff prompting re-take. Touches `backend/src/config/scheduler.ts`, `backend/src/routes/excess.ts`, probably a new excess status value in migration. See handoff 21 Apr 2026 open item #3.
- [ ] **Rolled-over balance linking:** recording a payment with method `rolled_over` updates the current job's excess to `taken` but doesn't mark the *previous* job's excess as `rolled_over` — two-step manual process. Could be automated when client ledger integration lands.
- [x] **Rolled-over email template (24 Apr 2026):** recording a payment with method `rolled_over` previously fired the standard `excess_payment_confirmed` email, confusing clients with "we've received your insurance excess payment of £X" when really we'd just moved money across from their last hire. `excess.ts` `/:id/payment` handler now branches on `method === 'rolled_over'`, looks up the previous rolled-over job's HH number for the same `jobs.client_id`, and sends the new `excess_rolled_over_applied` template instead: "We've applied £X from your previous hire #12345 to your upcoming hire #54321. No further action needed." `sendExcessEmail` accepts an optional `previousJobNumber` opt, and the template renders `{{previousJobRef}}` as ` #12345` or empty string when the previous hire can't be determined. Still doesn't auto-mark the previous job's excess as `rolled_over` — that's the open item above.
- [x] **HH job number in client money emails (24 Apr 2026):** `booking_confirmed_deposit` + `payment_received` + `hire_form_request` + `hire_form_chase` previously referenced only `{{jobName}}` in body ("Thank you for your payment for Katatonia - Van & backline hire"). Now include the HH job number ("...for Katatonia - Van & backline hire (job #15607)"). Subject lines for booking/payment also updated to include `(#{{jobNumber}})`. All excess templates already carried `{{jobNumber}}`. `sendPaymentEmail` now passes `jobNumber: String(job?.hh_job_number || '')`; hire form senders already passed it.

*Excess lifecycle — "three births" model (for future reference):*
A `job_excess` row is created exactly once per self-drive slot and enriched through three stages:
1. **Derivation** (earliest) — HH sync detects self-drive vans, auto-creates record with `required = van_count × £1,200` (floor, inc VAT), `status = needed`.
2. **Money collected** (any channel) — portal pre-auth/payment, Worldpay/Amex in-person, cash, bank transfer, PayPal, rolled-over balance. Updates `amount_taken`, flips status to `pre_auth`/`taken`/`partially_paid`. £1,200 is the FLOOR — any DVLA points/referral surcharge gets added on top, never replaces.
3. **Hire form absorbs** (latest) — driver submits form, system finds the existing unlinked record, keeps `amount_taken`, updates `required` to the hire-form-calculated figure (floor + surcharge). Gap between required and taken surfaces as outstanding.

Coverage rule used by `all_cleared` and `syncExcessRequirementStatus`: **covered = terminal status (waived/reimbursed/claimed/rolled_over/not_required) OR amount_taken >= amount_required**.

##### Excess multi-claim "nibble" flow + apply-to-invoice (May 2026)

The Phase B claim endpoint was a single-shot operation that flipped status to `fully_claimed` and didn't push to HireHop at all. Damage-charge accounting drifted because OP showed claimed-£X but HH still held the full deposit. Rewritten to a **multi-claim apply-to-invoice model** where each claim consumes part of the held deposit by paying a HireHop invoice on the current job, and reimbursement of the remainder is a separate later step.

**The model.** A held deposit (vanilla on the same job, or rolled-over from a previous job) sits with an available balance = `taken − claimed − reimbursed`. Each claim is one application of part of that balance to a chosen HH invoice. Multiple claims allowed against the same deposit, each potentially against a different invoice with a different Xero nominal:

```
£1,200 deposit collected
  ↓ Claim £120 → invoice OT-INV-1234 (Vehicle damage nominal)   → balance £1,080
  ↓ Claim £350 → invoice OT-INV-1235 (Premium Splitter hire)    → balance £730
  ↓ Claim £85  → invoice OT-INV-1236 (Cleaning recharge)        → balance £645
  ↓ Reimburse £645 to client                                     → balance £0, status: reimbursed
```

**HireHop side.** Each claim posts a deposit-to-invoice **payment application** via `billing_payments_save.php` with `OWNER=<invoice_id>`, `deposit=<hh_deposit_id>`, `paid=<amount>`, `bank=169` (metadata only — no real cash moves; the deposit is already in the bank). Then triggers Xero sync via `accounting/tasks.php` with `hh_task: 'post_payment'`. The invoice's line items carry the `ACC_NOMINAL_ID` so claims against different categories all route correctly without OP needing to know about nominals — staff create the invoice manually in HH with whatever nominal is appropriate (Vehicle damage 184, Misc income, Premium Splitter hire 185, etc.) and pick it from the OP picker.

**Cross-job linkage.** For rolled-over excess: the deposit lives on the *original* hire's HH job, but the new £120 damage invoice gets created on the *current* hire's HH job. The application then pays Job B's invoice from Job A's deposit. HH supports this natively via the `OWNER` (invoice on B) + `deposit` (deposit on A) pairing.

**Status semantics.**
| Event | Resulting status |
|---|---|
| Claim partial, balance > 0 | `taken` (status doesn't downgrade) |
| Claim consumes full deposit, no reimbursement yet | `fully_claimed` |
| Reimburse, balance > 0 after | `partially_reimbursed` |
| Reimburse, balance = 0 (claims + reimbursed = taken) | `reimbursed` |

`isPartial` on reimburse now factors in claims: `(reimbursed + amount + claimed) < taken`. Without this a £40-claim + £60-reimburse on £100 incorrectly stayed at `partially_reimbursed` even though fully resolved.

**Loud-fail policy** (matches reimburse). For HH-linked records: missing `hh_deposit_id` → 422 (linkage broken, point staff at the link-deposit action), missing `invoice_id` → 400, claim > available → 400, HH application reject → 502. OP record stays untouched on any HH-side failure. OP-only records (no `hirehop_job_id`) accept claims locally and surface `op_only: true` in the response.

**New endpoints.**
- `GET /api/excess/:id/outstanding-invoices` — fresh HH `billing_list.php` fetch (no cache), returns kind:1 invoice rows with `owing > 0` for the picker.
- `GET /api/excess/:id/available-rollover` — walks the client's excess history for a previous record still holding cash (status `taken` / `partially_paid` / `rolled_over` with positive `taken − claimed − reimbursed`, has `hh_deposit_id`), excluding records that have been chained forward via the `NOT EXISTS` guard so we never double-allocate. Returns `{ available, amount_available, source_hh_job, source_hh_deposit_id, suggested_apply_amount }`. Drives the "Apply Rolled Over Excess" UX (see below).

**Rollover UX — incoming vs outgoing sides.** The Manage modal exposes both directions of the rollover lifecycle as distinct top-level actions, instead of forcing staff through "Record Payment → method = Rolled Over from Previous Hire" (which was misleading — no money moves):
- **"Roll Over to Next Hire"** (outgoing) — on the OLD job's record (status `taken`/`partially_paid`/`pre_auth`, `amountHeld > 0`). Marks this excess as held on account for the client's next hire.
- **"Apply Rolled Over Excess"** (incoming) — on the NEW job's record when `/available-rollover` returns `available: true`. Single-purpose form: shows source hire number + available amount, pre-fills `min(required, available)`, one Confirm. Posts to existing `/payment` endpoint with `method='rolled_over'`. Backend's existing rollover linkage (copy `hh_deposit_id` forward, flip previous to `rolled_over`, post HH note) handles the rest.

The legacy "Record Payment → Rolled Over from Previous Hire" dropdown option is preserved as a fallback for edge cases where auto-detect can't find the source.

**HH job note on rollover.** When a payment with `method='rolled_over'` is recorded, OP drops a note on the new HH job: *"£X excess held against deposit #Y on job #Z — rolled over from previous hire."* Best-effort; logged warning if HH note posting fails but doesn't block the rollover. Gives HireHop staff visibility into the linkage without having to dig through OP.

**Payment portal rollover linkage exposure.** `/api/money/:jobId/excess-info` exposes per-driver `is_rolled_over: bool` and `rolled_over_from_hh_job: number | null` (resolves via LATERAL join on `hh_deposit_id` chain, picks the earliest non-rolled-over record). Lets the portal display: *"Your £1,200 excess is already held from your previous hire #15676 — no further excess payment needed."* Portal-side display change is for the portal Claude.

**Reimburse method default sanitisation (frontend).** ExcessPaymentModal's reimburse default was reading `excess.payment_method`, which on rolled-over records is `'rolled_over'` — not in `REIMBURSE_METHODS`. The browser visually fell back to "Worldpay" but kept the underlying state at `'rolled_over'`, and clicking the same displayed option didn't fire onChange (HTML quirk), so submissions silently rejected at the Zod schema. Now defaults to `wise_bacs` when `payment_method` isn't a valid reimburse destination.

**Reimburse loud-fail.** The reimburse endpoint also went through the same loud-fail rewrite: find HH deposit first (priority `excess.hh_deposit_id` → `job_payments` → HH billing keyword search), HH push first, OP UPDATE only on success. 422 on missing linkage (with rolled-over-specific copy pointing at the link-deposit action), 502 on HH reject. OP record left untouched on failure.

**Deferred from this round.**
- Auto-creating invoices in HH from OP (staff create manually for now — they prefer this control anyway).
- Splitting one claim across multiple invoices in a single click (one-claim-per-invoice in the picker is fine until usage proves otherwise).
- Moving deposits between HH jobs (HH doesn't support this; OP linkage handles the conceptual move).
- `/money/excess` summary cards now reflect current filter on the All Records tab — captured separately, also shipped this round.

##### Phase F — Staff Card Payments (future)
Allow staff to take card payments directly from the Money tab, rather than walking to the card terminal.
- [ ] Stripe integration in OP (PaymentIntent creation from backend)
- [ ] "Take Card Payment" button on Money tab → amount, generates Stripe payment link or embedded checkout
- [ ] Webhook receiver for direct OP Stripe payments
- [ ] Auto-record in HH as deposit + OP as job_payment

##### Global Money Views
- [x] `/money/excess` — Insurance excess ledger (client balances, all records, drill-down)
- [ ] `/money/overview` — Global financial dashboard (deposits pending, balances outstanding, excess held) — *replaces Stream 6 dashboard widget*
- [ ] `/money/payments` — All recorded payments across all jobs (future)

#### Step 4: Status Transition Engine ← MOSTLY COMPLETE
Bidirectional job status sync — depends on excess tracking for gate conditions.

- [x] `POST /api/webhooks/external/status-transition` endpoint for external systems
- [x] HireHop write-back via `status_save.php` (with `no_webhook=1`) — `hirehop-writeback.ts` service
- [x] API key / service auth for external callers (`api_keys` table)
- [x] HireHop → Ooosh: inbound webhook receiver (`POST /api/webhooks/hirehop`) with export_key verification
- [x] Ooosh → HireHop: write-back on pipeline status changes (with loop prevention)
- [x] Pipeline ↔ HireHop status mapping (see Status Mapping section)
- [x] Webhook logging (`webhook_log` table, migration 018)
- [x] Full lifecycle statuses: prepped, dispatched (on hire), returned_incomplete (checking in), returned, completed
- [x] Bidirectional sync for operational statuses (prepped=3, dispatched/on_hire=5, returned=6/7, completed=11)
- [x] HH status 5 (Dispatched) inbound maps to OP `prepped` (HH skips to 5 on checkout, no prep-scan distinction). "On Hire" is OP-only — doesn't push back to HH (already at 5).
- [x] Dispatch confirmation prompt from OP ("Mark as On Hire?")
- [x] HH webhook bypass for status changes (no prompt, direct update)
- [x] Returns page at /jobs/returns — "Checking In" and "Completed" sections
- [x] "Returns" added to Jobs nav submenu
- [x] "Back to Returns" navigation link from Job Detail when navigated from Returns page
- [ ] Status mismatch detection in existing sync (backup)
- [ ] Soft gate: warn on dispatch if prep checklist incomplete (non-blocking)
- [ ] Gate conditions: check excess collected before allowing dispatch
- [ ] HH item check-in/out counts for prep progress indicator (needs API research)
- [x] **Job Issues / Problems Register — Stage 2 control panel** (May 2026) — cross-module register at `/operations/problems` + per-issue control panel at `/operations/problems/:id`. Smart-picker panel on Job Detail Overview (vehicles / equipment line items / drivers / job people / client org auto-populated from job context — no typing reg numbers). NeedsAttention bucket. "Has issues" filter on JobsPage + ReturnsPage. Backend `/api/problems/*` (NOT `/api/issues/*` — platform bug tracker). Storage: dedicated `job_issues` table (migration 075) with anchor FKs (`vehicle_id`, `driver_id`, `person_id`, `client_organisation_id`, `hh_stock_item_id`, `barcode`), `job_issue_events` audit timeline, `job_issue_files` attachments table. Categories: damaged / missing / broken / dispute / breakdown / other. Severity: low / normal / urgent. Status: open / investigating / awaiting_quote / quoted / actioned / resolved / written_off / cancelled. Resolution paths: claim_excess / charge_client / write_off / replaced / other. RBAC: any STAFF_ROLES user can progress + close. Stage 3 (file uploads, surface_on rules, auto-create from vehicle damage, severity → notification mapping, Vehicle/Org Detail Issues tabs) and Stage 4 (HH barcode auto-pull, retire standalone `/vehicles/issues`) captured in Future Enhancements.

#### Step 4b: Returns & Close-Out System ← IN PROGRESS (Apr 2026)

When a job returns, there's a sequence of physical and admin tasks before it's truly done. This system extends the existing `job_requirements` framework with **post-hire close-out requirement types** that auto-create when a job enters return status and auto-detect completion from real data sources (HH billing, excess table, interactions).

**Design principle:** Same requirement card system as pre-hire prep, same status tracking, same UI patterns. Post-hire cards appear on the Job Detail "Job Requirements" tab under the Post-Hire toggle. The Returns page aggregates close-out progress across all returning jobs.

**Auto-creation trigger:** Derivation engine creates post-hire close-out requirements when HH status reaches 6 (Returned Incomplete) or 7 (Returned). Some types are conditional — only created when the job has relevant data (crew, excess records, etc.).

##### Close-Out Requirement Types

| Type key | Label | Icon | Condition | Auto-detect source | Status flow |
|----------|-------|------|-----------|-------------------|-------------|
| `vehicle` | Vehicle Check-In | 🚐 | Self-drive vehicles on job | Already exists (post_hire phase) | Not Started → In Progress → Done |
| `backline` | Backline De-Prep | 🎸 | Backline items on job | Already exists (post_hire phase) | Not Started → Working On It → Done |
| `damage_review` | Damage & Issues | ⚠️ | Vehicle `has_damage=true` OR manual add | `vehicle_hire_assignments.has_damage`, manual | Open → Awaiting Quote → Quoted → Resolved |
| `invoice` | Invoice | 🧾 | Always (every returned job) | HH `billing_list.php` kind:1 rows | Not Invoiced → Generated → Sent → Done |
| `payment_reconcile` | Payment Reconciliation | 💷 | Always (every returned job) | HH billing balance check (deposits vs hire value) | Outstanding → Done |
| `excess_resolve` | Excess Resolution | 🛡️ | `job_excess` records exist for this job | `job_excess.excess_status` | Pending → Resolved |
| `freelancer_followup` | Freelancer Follow-Up | 👤 | `quote_assignments` exist (crew on job) | Manual (future: portal integration) | Not Contacted → Chased → Done |
| `client_followup` | Client Follow-Up | 📞 | Always (every returned job) | Interactions table: any interaction logged after return_date | Not Contacted → Done |

##### Status Auto-Detection Logic

Close-out cards are **status-reactive** — they read from real data sources and auto-update their status:

| Type | Auto-detection | Manual override? |
|------|---------------|-----------------|
| `invoice` | Polls HH `billing_list.php` for kind:1 (invoice) rows on Money tab load. If found → status moves to `generated`. `sent` is always manual (button click). | Yes — staff clicks "Sent to Client" |
| `payment_reconcile` | Reads HH billing balance (same as Money tab). If `balance <= 0` → auto-resolves to `done`. | Can manually mark done if balance is within tolerance |
| `excess_resolve` | Reads `job_excess` table. If all excess records are in terminal status (`reimbursed`, `fully_claimed`, `waived`, `rolled_over`) → auto-resolves. | Can manually mark done |
| `client_followup` | Queries `interactions` table for any interaction with `job_id` created after `jobs.return_date`. If found → auto-resolves to `done`. | Can manually mark done |
| `freelancer_followup` | Future: detect from freelancer portal submissions. For now: manual status change. | Yes — staff marks after contact |
| `damage_review` | Created when vehicle assignment has `has_damage=true`, or manually added. Status is always manual (awaiting external quotes, etc.). Supports **chase date** for follow-up reminders. | Fully manual |

##### Damage & Issues — "The Limbo Problem"

The `damage_review` requirement type addresses the most painful post-hire issue: things stuck in limbo (waiting for damage quotes, missing cables, insurance claims, etc.).

**Features:**
- **Chase date field** — "Follow up on this in X days" (reuses the same chase mechanism as pipeline)
- **Notes field** — free-text description of the issue (already exists on all requirements)
- **Activity log** — status changes logged to job interactions timeline
- **Dashboard surfacing** — future: "X jobs with unresolved damage" widget
- **Multi-issue support** — a job can have multiple `damage_review` requirements (one per issue, using `custom_label` to distinguish: "Scratched bumper GX17DHN", "Missing XLR cable")

**Status flow for damage:**
```
Open → Awaiting Quote → Quoted → Claimed (via excess) → Resolved
                                → Written Off → Resolved
                                → Client Paying → Resolved
```
For v1, simplified to: `Open → Awaiting Quote → Quoted → Resolved` (4 steps). Complex flows can be added later.

##### Returns Page Redesign

**Two sections (same as current but enhanced):**

**Active Returns** (HH status 6, 7, 8):
- Each job card shows close-out checklist as coloured dots/pills:
  - Green dot = done, Amber dot = in progress, Red dot = blocked/overdue, Grey dot = not started
- Sort by: return date (default), days since return, outstanding items count
- Filter pills: "Needs Invoice", "Damage Open", "Excess Pending", "Freelancer Outstanding", "All"
- Click job → Job Detail page, Post-Hire tab shows the close-out requirement cards
- Jobs with `status=8` (Requires Attention) get a red highlight

**Completed** (HH status 11):
- Collapsible section (same as current)
- Shows close-out summary (all dots green)

**Close-out progress endpoint:**
```
GET /api/returns/close-out-progress
```
Returns close-out status per job in bulk — reads from requirements (post_hire phase) + HH billing + excess table + interactions. Single endpoint to power the Returns page without N+1 queries.

##### Migration 044: Close-Out Requirement Types

```sql
-- New requirement type definitions for post-hire close-out
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('invoice',              'Invoice',                '🧾', NULL, 200),
  ('payment_reconcile',    'Payment Reconciliation', '💷', NULL, 210),
  ('excess_resolve',       'Excess Resolution',      '🛡️', NULL, 220),
  ('freelancer_followup',  'Freelancer Follow-Up',   '👤', NULL, 230),
  ('client_followup',      'Client Follow-Up',       '📞', NULL, 240),
  ('damage_review',        'Damage & Issues',        '⚠️', NULL, 250)
ON CONFLICT (type) DO NOTHING;
```

No new tables needed — all types use existing `job_requirements` table with `phase = 'post_hire'`.

##### Implementation Phases

**Phase A — Foundation (migration + derivation engine + Returns page)** ✅ COMPLETE
- [x] Migration 044: insert new requirement type definitions
- [x] Extend `hh-requirement-derivation.ts`: auto-create close-out requirements when job status >= 6
- [x] Conditional creation logic (only freelancer_followup if crew exists, only excess_resolve if excess records exist, only damage_review if has_damage flagged)
- [x] Returns page rebuild: close-out dots per job, filter pills, sort options
- [x] `POST /api/requirements/closeout-progress` bulk endpoint

**Phase B — Auto-detection (status-reactive cards)** ✅ COMPLETE
- [x] Vehicle check-in + backline de-prep: auto-done when HH status >= 7 (Returned)
- [x] Invoice detection: read HH billing_list for kind:1 rows, auto-flip `not_started → in_progress` ("Generated") when any non-proforma invoice exists
- [x] Payment reconciliation: auto-resolve `not_started → done` ("Reconciled") when total HH OWING minus OP-side VAT relief (`vatSaved` from `calculateVatAdjustment`) is ≤ £0.01. VAT-aware so international jobs paid through the portal at the adjusted rate reconcile correctly even though HH still shows owing == vatSaved.
- [x] Excess resolution: read job_excess statuses, auto-resolve when all terminal
- [x] Client follow-up: query interactions after return_date, auto-resolve when found
- [x] Invoice "Sent" cascade: marking invoice done auto-resolves client_followup
- [x] Invoice + payment_reconcile auto-detection lives in `hh-requirement-derivation.ts` (per-job-live, fires from 30-min sync, on-page auto-sync, and Sync HH button) — NOT just the Returns-page bulk endpoint. The bulk endpoint at `POST /api/requirements/closeout-progress` retains its own inline check (capped at 10 jobs/req, 5 min cache) for the Returns list view.
- [x] HH billing check rate-limited via broker (low priority, 5 min cache); both billing fetch and VAT lookup wrapped in try/catch so a flaky call leaves status at `not_started` rather than rolling back the derivation transaction
- [x] Invoice card labels revised (1 May 2026): `in_progress="Generated"` (auto-set when invoice detected), `done="Sent"` (manual via "Mark as Sent to Client" button) — so the manual progression lands on the most-progressed state

**Phase C — Invoice Sent + type rendering** ✅ MOSTLY COMPLETE
- [x] "Mark as Sent to Client" button on invoice requirement card (in_progress → done)
- [x] RequirementCard type-specific rendering for close-out types (all 6 types have status labels)
- [x] Damage review shows notes inline + chase date in amber
- [ ] Damage requirement: multi-issue support (custom_label per issue)
- [ ] Chase date on damage_review requirements (follow-up reminders via scheduler)
- [ ] Damage auto-creation from vehicle check-in flow (has_damage → auto-create damage_review requirement)

**Phase D — Dashboard + notifications** ✅ MOSTLY COMPLETE (15 Apr 2026)
- [x] Dashboard widget: "Returns & Close-Out" overview with active counts, outstanding items by type, oldest returns
- [x] Notification escalation: priority-based email (normal=4h, high=1h, urgent=immediate), respects working hours + user preferences
- [x] Damage auto-creation: vehicle check-in with `has_damage=true` auto-creates `damage_review` requirement immediately
- [ ] Chase date notifications: daily scheduler scans due_date on post_hire requirements → bell notification
- [ ] Freelancer portal integration: crew feedback prompts
- [ ] Auto-email: remind freelancers to submit expenses/feedback after job

**Completion retro + hire history** ✅ COMPLETE (15 Apr 2026)
- [x] Completion retro modal with rating (Great/OK/Issues default Great), notes, follow-up
- [x] Outstanding close-out items warning in completion modal
- [x] Retro stored as interaction on job timeline
- [x] Hire History tab on Organisation + Person detail pages
- [x] Lost reason displayed alongside retro in hire history
- [x] Lost detail text visible (not just tooltip) in hire history
- [x] Retro notes + follow-up shown inline (not just hover)
- [x] Task reminders / follow-up scheduling from retro: date picker with 1m/3m/6m presets creates follow_up notification snoozed until due date
- [x] Client's upcoming jobs shown in completion modal (blue info box with future bookings)
- [ ] Show client's upcoming jobs in completion modal (future)

##### Mobile Considerations (Apr 2026)
- Returns page uses card layout (not tables) — already mobile-friendly
- Close-out dots are small enough for mobile viewing
- Job Detail post-hire tab scrollable via existing tab bar mobile fix
- Filter pills use `flex-wrap` for mobile reflow

#### Step 4c: Cancellation System ← FOUNDATION COMPLETE (Apr 2026)

Full cancellation workflow distinguishing **lost enquiries** (never confirmed) from **cancelled bookings** (were confirmed, now cancelled). Replaces the previous approach where both mapped to `lost`.

**Full spec:** `docs/CANCELLATION-SPEC.md`

**Key decisions:**
- `cancelled` is a distinct pipeline status from `lost` (maps to HH status 9 vs 10)
- Cancellation calculator uses post-VAT-adjustment figures for accuracy
- VE103B certs are NOT voided on cancellation — requirements marked as not needed
- Transport & crew costs surfaced in modal for informed decisions
- Admin/manager can action cancellation; other staff see "Refer to Manager"
- Re-opening a cancelled job creates a new booking (via HH `job_duplicate.php`) — original stays cancelled for audit
- Partial cancellation (scope reduction) deferred to future

**Foundation — COMPLETE:**
- [x] Migration 047: cancellation fields on jobs table (`cancelled_at`, `cancelled_by`, `cancellation_reason`, `cancellation_fee`, `cancellation_refund`, `cancellation_notice_days`, `cancellation_notes`, `cancellation_tier`, `reopened_from_job_id`, `reopened_to_job_id`)
- [x] `cancelled` added to `PipelineStatus` type, config, writeback mapping, pipeline labels
- [x] HH status mapping split: `cancelled → 9`, `lost → 10` (was both → lost)
- [x] `cancellation-calculator.ts`: T&Cs clause 7.1 (pre-hire) + 7.3 (early return), three hire types, £25+VAT minimum
- [x] `cancellations.ts` route: calculate, process, transport-crew, list, reopen endpoints
- [x] Cancellation workflow: status update, timeline log, requirements marked done, vehicle assignments cancelled, crew cancelled + emailed, excess flagged, pending refund created, HH write-back
- [x] `CancellationModal.tsx`: calculator display, transport/crew summary, manual override, RBAC
- [x] Per-tier fee breakdown (only shows tiers relevant to hire length), copyable summary sentence
- [x] HH invoice section: net/VAT/gross breakdown with guidance
- [x] `LostCancelledPage.tsx` at `/jobs/lost-cancelled` with Cancelled/Lost tabs, search, pagination
- [x] Job Detail: red cancelled banner with fee/refund summary, "Re-open as New Booking" button
- [x] Crew cancellation + internal notification email templates
- [x] Client cancellation email (refund amount, timescale, invoice note)
- [x] Chase reminders suppressed for lost/cancelled jobs (clear `next_chase_date`, hide UI)
- [x] Pipeline fields (likelihood, chase) hidden for lost/cancelled jobs
- [x] Re-open: full field copy (dates, managers, orgs, venue) + HH `job_duplicate.php` with items/notes/transport
- [x] Cancellation close-out requirements auto-created (invoice, client follow-up, refund, excess) — same pattern as returns
- [x] Dashboard widget: cancellation overview (pending refunds, outstanding close-out items, fees retained)
- [x] "Back to Lost & Cancelled" navigation from Job Detail

**Remaining work:**
- [ ] HH invoice creation on cancellation (auto-create invoice for retained fee via `billing_deposit_save.php`)
- [ ] Refund processing through OP (currently manual via Money tab — future enhancement)
- [ ] Cancellation data surfaced in client hire history (like retro data)
- [ ] Early return calculator frontend integration (clause 7.3 — backend built, UI not yet)
- [ ] Partial cancellation / scope reduction (deferred — noted for future)

#### Lost / Cancelled cleanup pattern (28 Apr 2026)

**Cross-cutting rule for ALL requirement types** — current and future. When a job moves to `lost` or `cancelled`, every open requirement on the job (reminders, hire forms, excess records, vehicle prep, backline, rehearsal, sub-hires, custom — anything in `job_requirements`) is auto-cancelled UNLESS the user has explicitly opted to keep it alive past close-out.

**Why this exists:** Without this rule, requirements stranded on dead jobs keep firing scanner emails forever (orphaned reminders, hire-form chase emails for a hire that's not happening, excess pre-auth chases on a cancelled booking). Original symptom that drove the design: a test reminder on a Lost job kept emailing daily with no way to stop the chase, because the hourly reminder scanner had no `pipeline_status` filter and no way to acknowledge a notification "for good".

**The contract — every requirement type follows this:**

1. **Migration 064** added `keep_after_close BOOLEAN NOT NULL DEFAULT FALSE` on `job_requirements`. Any new requirement type inherits this column automatically.

2. **`CancelOpenRequirementsSection.tsx`** is shown in BOTH the Lost modal (`PipelinePage`, `JobDetailPage`) and the Cancellation modal (`CancellationModal`). It loads ALL open requirements (any type, any phase) on the job and lets staff tick the ones to keep alive. Default is unchecked = cancel. Event-triggered requirements whose trigger matches the target status (e.g. `event_trigger='cancelled'` on a cancellation) are shown with a disabled checkbox + "will fire on the way out" label, since they fire then self-mark done.

3. **Frontend submits `keep_requirement_ids: string[]`** (the ticked-to-keep ones). Empty/absent = cancel everything still open.

4. **Backend cleanup is handled in two places** (mirroring the two transition paths):
   - `PATCH /api/pipeline/:id/status` for `lost` transitions (`backend/src/routes/pipeline.ts`)
   - `POST /api/cancellations/:jobId/process` for `cancelled` transitions (`backend/src/routes/cancellations.ts`)
   Each path: (a) flags kept items with `keep_after_close = true`, (b) lets the event-trigger pass run (fires + self-marks done any reminders triggered on this status), (c) sweeps everything else still open with `status = 'cancelled'` and `notes` annotated `[Auto-cancelled: job marked lost]` / `[Cancelled]`. The order matters — flag first, fire triggers second, sweep last — so triggered requirements fire before cleanup deletes them.

5. **Background scanners check the flag.** Any scheduler task that finds work to do via `job_requirements` MUST gate on `pipeline_status NOT IN ('lost', 'cancelled') OR keep_after_close = true`. Currently applied to:
   - Reminder scanner (`config/scheduler.ts` — hourly)
   - Close-out chase scanner (`config/scheduler.ts` — daily 09:30)
   When adding a new scanner (hire-form reminders, excess pre-auth expiry, carnet chases, etc.), include this gate in the SQL.

**Per-requirement-type expectations (current & future):**

| Type | Cancel-on-close default | Notes |
|---|---|---|
| `reminder` | Cancel | Most common. Kept items survive (e.g. "chase the deposit refund in 2 weeks"). |
| `hire_forms` | Cancel | Auto-emails stop. Kept rare — only if a driver still needs to sign for some retroactive reason. |
| `excess` | Cancel | Pre-auth chases stop. Kept if money still needs collecting/refunding from cancelled job (use `keep_after_close` rather than leaving status open). |
| `vehicle` / `backline` / `rehearsal` | Cancel | Prep work no longer needed. |
| `transport` / `crew` | Cancel | Quote-side cancellation already handled separately by `cancellations.ts` step 5a. |
| `invoice` / `payment_reconcile` / `excess_resolve` / `client_followup` / `freelancer_followup` / `damage_review` | Cancel by default | But these are POST-hire close-out requirements — most cancellations re-create them via the cancellation close-out auto-creation path, so the cancel-then-recreate behaviour is correct. |
| `carnet` / `merch` / `sub_hire` / `custom` | Cancel | Kept rare. |
| **Future types** | **Cancel by default** | Always include the `keep_after_close` gate in any background scanner/auto-emailer for the new type. |

**Acknowledgement cascade:** Clicking "Done" on an inbox notification linked to a `reminder` requirement marks the underlying requirement as `done` too (`POST /api/notifications/:id/acknowledge`). Without this, hourly scanner re-creates a fresh notification 24h later because requirement status is still open. Cascade is currently `reminder`-only — other requirement types keep their full status workflow on the job page.

**Cascade-on-delete:** `DELETE /api/requirements/:id` also removes any pending notifications linked to that requirement (`entity_type='job_requirements' AND entity_id=$1`). Stops orphan notifications haunting the inbox after a requirement has been hard-deleted.

**Phase in `action_url`:** Notification action URLs include `&phase=pre_hire` or `&phase=post_hire` so clicking through from the inbox lands on the correct toggle. Without this, pre-hire reminders are invisible on dispatched+ jobs (which default to post-hire view) and vice versa. JobDetailPage reads `?phase=` from the URL to seed the toggle state.

#### Step 5: Payment Portal Repointing
*Merged into Step 3 Phase E (Money System).* See above for full repointing plan with `DATA_BACKEND` env var toggle.

#### Step 6: Operations Modules (Hire Readiness) ← ARCHITECTURAL REVISION (Apr 2026)

**Paradigm shift (Apr 2026):** The Prep Checklist is now **primarily HH-derived**, not manually created. HireHop line items are the source of truth for *what's on a job*; the OP adds the *operational intelligence* on top — who needs to do what, when, and whether it's done.

**Architecture:** Each confirmed job gets a **Prep Checklist** (the new default tab on Job Detail). Requirements are automatically generated from HireHop line items via the **HH-Derived Requirements Engine** (see section below). Manual requirements still exist for OP-only activities (incoming deliveries, lost property, etc.).

**Key design decisions:**
- Prep Checklist = the job-level dashboard. Always the first tab you see.
- Status system is **non-linear** (any status → any status), styled like pipeline badges (rectangular, coloured).
- **HH-derived requirements auto-update** when HH line items change — no manual re-entry needed.
- **Mismatch flagging:** If HH changes after staff has acted (e.g. marked "done"), surface a warning rather than silently overwriting.
- **Dashboard** (`/dashboard`) is the global overview — aggregates all outstanding items across all jobs, including prep time estimates.
- **Freelancer portal integration** — crew assignments, delivery jobs, studio sitter assignments all need to be readable/writable from the freelancer portal (currently reads from Monday.com, needs repointing to OP).

##### Stream 1: Core Requirements System (FOUNDATION — MOSTLY COMPLETE)
- [x] `job_requirements` table + migration (migration 021)
- [x] Requirements API: CRUD, non-linear status changes, templates
- [x] Wire Prep Checklist to real data (replace dummy prototype)
- [x] Replace Overview tab with Prep Checklist as default job tab (now called "Job Requirements")
- [x] Non-linear status badges (styled like pipeline status dropdowns)
- [x] Progress indicators on Jobs list page + Pipeline kanban cards (real data via bulk endpoint)
- [x] Likelihood badge hidden for confirmed+ jobs (no longer relevant post-booking)
- [x] Full Details tab removed — details/notes now editable inline on Overview tab
- [ ] Deposit/payment progress bar on Prep Checklist (visual: deposit taken vs full fee)
- [x] **HH-Derived Requirements Engine** (see dedicated section below) — auto-create/update requirements from HH line items
  - [x] Migration 041: seat_layout on fleet_vehicles, hh_derived_flags/line_items_synced_at on jobs, mismatch tracking on job_requirements, is_van_and_driver override
  - [x] Line items sync fixed: kind:3 selected prompts preserved (were being filtered out), richer field set stored (kind, AUTOPULL, VIRTUAL, LFT/RGT, TYPE_CUSTOM_FIELDS)
  - [x] Derivation service (`hh-requirement-derivation.ts`): detects vehicles, seats, backline, rehearsals, crew; extracts prep time; auto-creates requirements; respects manual status; flags mismatches
  - [x] On-demand sync endpoint: `POST /api/hirehop/jobs/:jobId/sync` (fresh item fetch + derivation)
  - [x] Derived flags endpoint: `GET /api/hirehop/jobs/:jobId/derived-flags`
  - [x] Van & Driver toggle: `PATCH /api/hirehop/jobs/:jobId/van-and-driver`
  - [x] Wired into 30-min scheduled sync + HH webhook handler (job.updated)
  - [x] Frontend: "Sync now" button on Job Detail + auto-sync on page load
  - [x] Frontend: Seat config display on Prep Checklist + Drivers & Vehicles tab
  - [x] Frontend: `seat_layout` field on vehicle detail page (Premium vans)
  - [x] Frontend: Van & Driver toggle button on Job Detail
  - [x] Reusable `RequirementCard` component (`frontend/src/components/RequirementCard.tsx`)
  - [x] Vehicle card with nested hire_forms + excess (indented under vehicle)
  - [x] Hire form "Send" button with contact picker (email/name checkboxes, send/chase modes)
  - [x] Hire form card status enrichment: sent date badge, received count, referral count
  - [x] Hire form email endpoint: `POST /api/hire-forms/send-email` + `GET /api/hire-forms/email-contacts/:jobId` (contacts from 5 sources: client org, org people, job_organisations, org emails, HH contact name match)
  - [x] Hire form sent badge persists on refresh (derivation engine preserves user-appended notes, send sets status to in_progress)
  - [x] Info badges (Sent, Received, Referral) visually distinct from action buttons (pills vs solid filled buttons)
  - [x] Hire form auto-email scheduler (daily 09:00). Initial fires 8-11 days before hire start (self-healing window), chase fires 4-5 days before. Missed-initial backstop in the 4-5 day window catches jobs that slipped past the initial window for any reason. On-confirmation hook fires from `pipeline.ts`, `money.ts` payment-event, AND `webhooks.ts` HH webhook (no entry-point gaps). Single canonical contact resolver in `services/hire-form-contacts.ts` used by both the auto-emailer and the manual `/email-contacts/:jobId` picker — same 5 sources (client org email, client-org people, `job_organisations` linked entities' people, org-level emails, HH contact-name match). 0-contact resolution fires a `sendConfirmationSilentSkipAlert` to info@ rather than logging-and-moving-on. **May 2026 history:** all five of these were silent gaps until the 15175 incident exposed them — exact `= 10` day match (no recovery if missed), narrow contact lookup (only `client_id` org + people, missed `job_organisations` linked management/promoter contacts), no missed-initial backstop (chase WHERE clause required `notes LIKE 'Hire form email sent'`, so a missed initial meant no chase either — total black hole), HH-webhook-driven confirmations didn't call the on-confirmation hook, 0-contacts silently logged "0/0 sent". 14 jobs in the next 14 days had to be backfilled via `scripts/send-missing-hire-form-emails.ts`. See commit `a3c65c8`.
  - [x] Hire form on confirmation: auto-sends when job confirmed with ≤10 days to start (covers all three confirmation entry points — manual pipeline transition, payment-portal payment-event, inbound HH webhook)
  - [x] Van & Driver toggle: soft-suspends hire_forms/excess requirements AND cascade-waives the matching job-level `job_excess` record (May 2026: status='waived', required=0, `[Suspended: Van & Driver]` marker in notes — only when `amount_taken=0` and status in `('needed','pending')`; records with money attached are skipped). Marker-gated restore on toggle-back. Without the cascade, Money tab + ExcessGateBanner kept showing "£1,200 required" on V&D-only jobs because they read from `job_excess` directly. Mixed-job calc (1 SDH + 1 V&D) was already correct — derivation engine + hire-form top-N-drivers both read `flags.self_drive_count`, not total `vehicle_count`.
  - [x] Requirement deletion: confirmation dialog with required reason for hire_forms/excess, logged to activity timeline
  - [x] Stale requirement cleanup: removes auto-requirements not on HH, flags manual ones
- [x] On-demand job sync ("Sync now" button + auto-sync on Job Detail page open)
- [x] Mismatch flagging (HH changed since requirement was last updated/marked done)

##### Stream 2: Global Operations Dashboard
Aggregate views on the Dashboard page — click through to individual jobs from each widget.
- [ ] Transport overview widget: all jobs with transport needs, who's driving, when, where
- [ ] Crew overview widget: who's assigned where this week, availability gaps
- [x] Backline overview widget: jobs with backline, prep status (going out + returning, item counts, prep times)
- [ ] **Prep time estimates:** "4 vehicles need prepping today, est. 5 hours" (from `preptimemins` custom field on HH items, split by category)
- [ ] Incoming deliveries widget: what's arriving today across all jobs
- [ ] Carnet overview widget: outstanding carnets, return tracking
- [ ] Lost property widget: uncollected items with age
- [ ] Studio/rehearsal schedule widget: upcoming rehearsals, studio sitter assignments
- [ ] Payment summary widget: deposits pending, balances outstanding
- [ ] Hook into freelancer portal (repoint from Monday.com read/write to OP API)

##### Stream 3: Backline Module
Backline detection is HH-derived (items in backline categories auto-create the requirement). Backline *management* (prep status, issues, de-prep) lives in OP.

**"Backline" in Ooosh context = ALL warehouse-prepped equipment** — instruments, PA/sound, DJ, lighting, power, staging, video, accessories. Everything except vehicles (370-371), rehearsal rooms (450), and storage (449).

- [x] Backline requirement auto-detected from HH line items (all equipment categories 372-453 except vehicles/rehearsal/storage)
- [x] Backline status labels: Not Started / Working On It / Done / Problem (type-specific overrides on shared status values)
- [x] Backline prep/de-prep time estimates from `preptimemins` custom field (includes virtual parent items)
- [x] Global backline overview page at `/operations/backline` — going out + returning stats, per-job rows with item counts and prep times
- [x] Backline overview API (`GET /api/backline/overview?days=N`) — configurable period, HH status as primary filter
- [x] Dashboard backline widget — headline summary with progress bar and click-through to backline page
- [x] Period filters: Today & Tomorrow / Next 7 Days / Next 14 Days
- [x] Direction filter: Both / Going Out / Coming Back
- [x] Status filter pills with colour-coded status breakdown
- [x] Inline status editing from overview (click status badge → dropdown, viewport-aware positioning)
- [x] HH job number clickable link to HireHop
- [x] HH status intelligence: jobs with HH status >= Prepped(3) treated as effectively done even if backline card not updated. "HH: Prepped" badge shown.
- [x] Last-minute item changes: amber "Items changed" badge + highlight when HH items modified after prep was actioned
- [x] Prep time rounding: per-job rows round up to 5-minute chunks, overview/dashboard rounds to 15-minute chunks
- [x] Remaining prep time excludes effectively-done jobs (backline Done OR HH Prepped+)
- [x] Returning section only shows dispatched+ jobs (no overlap with going-out for jobs whose return date is in the window)
- [x] RBAC: accessible to all non-freelancer roles (admin, manager, staff, general_assistant, weekend_manager)
- [x] Responsive filter bar (wraps on small screens)
- [x] Sync button triggers full HH job sync + re-derive
- [ ] Backline detail section on job (item list from HH, prep status per item in OP)
- [ ] Backline issues tracking (missing items, damage — similar pattern to vehicle issues)

**Pre-hire / Post-hire Phase System** ✅ COMPLETE (migration 042)
- [x] `phase` column on `job_requirements` (`pre_hire` | `post_hire`, defaults to `pre_hire`)
- [x] Pre-Hire / Post-Hire toggle on Job Detail > Job Requirements section
- [x] Each phase has independent requirement cards with independent statuses
- [x] Auto-generation of post_hire requirements when job reaches dispatched/returned status (backline de-prep, vehicle check-in)
- [x] Derivation engine respects phase — creates/updates pre_hire only, doesn't touch post_hire
- [x] Backline overview: "Going Out" reads pre_hire cards, "Coming Back" prefers post_hire (falls back to pre_hire)

**Threshold convention (May 2026) — read before changing post-hire gating logic:**
Post-hire backline + vehicle requirement creation (`hh-requirement-derivation.ts:529`) and the frontend Pre/Post toggle default (`JobDetailPage.tsx`) both gate on **OP `pipeline_status` ∈ {`dispatched`, `returned_incomplete`, `returned`, `completed`}** — not HH status. HH jumps to 4/5 the moment items get checked out, but OP holds at `prepped` until staff explicitly mark the job dispatched. Earlier code used `hhStatus >= 4` with a "more reliable than pipeline_status which can lag behind" comment — that reasoning is real but the trade-off was wrong here: surfacing post-hire cards before staff are meant to be working post-hire led to misclicks (job 15738 had pre-hire backline at `in_progress` and post-hire backline at `done` 5 seconds apart, classic toggle-confusion). The frontend toggle default also includes `cancelled` (cancelled jobs land on post-hire view for close-out work). The closeout-specific requirements (`invoice`, `payment_reconcile`, `client_followup`, `excess_resolve`, `freelancer_followup`, `damage_review`) keep their **HH-status gate** (`isReturnPhase = hhStatus >= 6`, `isFullyReturned = hhStatus >= 7`) — they're about physical return + auto-resolve on Returned, not the toggle. Don't conflate the two.

**Van & Driver suspension convention (May 2026):**
Requirements with `[Suspended: Van & Driver]` in `notes` (auto-derived `hire_forms` / `excess` rows soft-suspended when every van slot is V&D — see `suspendRequirementForVanAndDriver`) carry `status='blocked'` in the DB but are **not actually blocked** — they're "not required" on this job. Filter them out of any count/aggregate over `job_requirements`:
- Pre-Hire progress counter (`JobDetailPage.tsx`) — drops them from `totalCount` / `doneCount` / `blockedCount` so the bar/meter doesn't go red.
- Dashboard Today strip SQL (`routes/dashboard.ts`) — `WHERE notes IS NULL OR notes NOT LIKE '%[Suspended: Van & Driver]%'` so they don't render as red `prob` pips.
- Jobs page + Returns page progress bars (`routes/requirements.ts` `/bulk` and `/closeout-progress` endpoints) — same SQL filter on the bulk count queries that feed the per-row mini progress bars.

The cards still render in the requirements list as greyed "Not required — Van & Driver mode" stubs (`RequirementCard.tsx` already detects via `isSuspendedByVD`), they just don't move meters or fire alerts. Match this filter when adding any new count/aggregate or pip rendering over `job_requirements` — otherwise V&D-only jobs will look like they have unresolved problems on whatever surface you're building.

**Known issue — OP ↔ HH status sync gap:**
Many jobs confirmed in HH before webhook integration went live (Mar 2026) have stale `pipeline_status` in OP. The backline page works around this by using `jobs.status` (HH integer) as primary filter. Potential fixes for the broader platform:
1. One-time reconciliation script: update `pipeline_status` based on `jobs.status` for all mismatched jobs
2. Add status reconciliation to the 30-min job sync (currently only updates `jobs.status` integer, not `pipeline_status`)
3. HH webhook handler already catches future changes — only historical pre-webhook jobs are affected

##### Stream 3b: Sub-Hires Module (OP-Only)
Sub-hire tracking lives entirely in OP. HH's PO/shortage method is too clumsy (custom items always show short).
- [ ] `job_subhires` table (what, supplier, status, cost, po_ref, due_date, received)
- [ ] Sub-hire tracking: need → sourcing → ordered → received → returned
- [ ] Per-job section + global sub-hire view

##### Stream 4: Incoming Deliveries + Lost Property (OP-Only)
These originate outside HH entirely — client sends stuff to us, or items found post-hire.
- [ ] `incoming_deliveries` table (job_id, description, expected_date, box_count, received_count, status, sender_name)
- [ ] Support for "mystery boxes" — record arrival with unknown association, link to job/client later
- [ ] Merch receiving: request sent → some received → all received → notified client → given to client
- [ ] `lost_property` table (job_id, description, found_date, found_location, photo, client_notified, collected, dispose_after)
- [ ] Auto-reminder: chase client to collect, flag for disposal after X weeks
- [ ] Global pages for both: `/operations/deliveries`, `/operations/lost-property`

##### Stream 5: Rehearsals Module
Rehearsal detection is HH-derived (items in rehearsal category 450 auto-create the requirement). Rehearsal *management* (studio sitter, room prep, handover) lives in OP.
- [ ] Rehearsal requirement auto-detected from HH line items (category 450)
- [ ] Rehearsal prep time from `preptimemins` custom field
- [ ] `rehearsals` table (job_id, venue, date_start, date_end, studio_sitter_id, setup_specs, sound_files, status)
- [ ] Studio sitter assignment (links to people table, freelancer portal integration)
- [ ] Room prep method (similar to vehicle prep checklist)
- [ ] Handover tracking: evening studio sitters → daytime staff
- [ ] Band setup specs + sound file uploads
- [ ] Studio schedule global view (`/operations/rehearsals`) — calendar/timeline format
- [ ] Freelancer portal integration: push rehearsal assignments to studio sitters

##### Stream 6: Payment Tracking (pre-Xero)
*Merged into Step 3 (Money System).* `job_payments` table, per-job financial summary, payment recording, and client payment terms are all part of the unified Money tab on Job Detail. See Step 3 Phases C-F for full spec.

##### Stream 7: Transport & Crew Operations ← FOUNDATION COMPLETE
Global operational view for what's currently happening / about to happen with transport and crew.
**Full spec:** `docs/TRANSPORT-CREW-OPS-SPEC.md` — covers Monday.com board replacement, freelancer portal repointing, completion flow, and implementation plan.
- [x] Migration 024: ops_status, completion tracking, arranging details, run grouping, local delivery on quotes; freelancer confirmation, expense/invoice tracking on quote_assignments
- [x] Backend ops endpoints: PATCH ops-status, PUT ops-details, POST /quotes/local, PUT run-group, POST assignments/ooosh-crew, GET /quotes/ops/overview
- [x] Portal API route (`/api/portal/*`): auth/login, jobs list, job detail, equipment via HireHop broker, completion submission, venue detail
- [x] Cookie-parser middleware for portal session cookies
- [x] Transport operations page (`/operations/transport`): table view grouped by ops_status + calendar view, filter D&C/crewed, expandable rows, inline status dropdown
- [x] Local delivery/collection button + form on Job Detail Crew & Transport tab
- [x] Operations nav menu with "Crew & Transport" child
- [x] Operational status on quotes (`ops_status`: todo → arranging → arranged → dispatched → arrived → completed)
- [x] Completion tracking (signature, photos, notes, customer present toggle)
- [x] Arranging details (key points, client introductions, tolls/accommodation/flight booking status)
- [x] Freelancer portal repointing: feature-flagged DATA_BACKEND=op (auth, jobs, completion, equipment) with Monday.com fallback
- [x] **Freelancer portal go-live repointing (17 Apr 2026)** — see `docs/FREELANCER-PORTAL-REPOINTING.md`. Migration 052 adds portal_verification_codes + portal_password_reset_tokens + portal_fallback_events + completion_reminder_level. New OP endpoints: `/portal/auth/register/start|verify|complete`, `/portal/auth/forgot-password`, `/portal/auth/reset-password`, `/portal/telemetry/monday-fallback`, `/portal/jobs/:id/files`. Completion flow now uploads photos/signature to R2 under `completion/{quote_id}/`, generates delivery-note PDF (port of `src/lib/pdf.ts` → `backend/src/services/delivery-note-pdf.ts`), emails client + staff alert. Completion chaser scheduler every 30 min (2h/6h/14h + staff escalation). `freelancer_assignment` email now fires on new crew assignment + on draft→confirmed transition.
- [ ] **Portal shared files not reaching portal UI (known gap, 17 Apr 2026)** — Flag `share_with_freelancer` persists correctly on `jobs.files` + `venues.files`, and `/api/portal/jobs/:quoteId/files` returns both filtered correctly. The portal Next.js page (`src/app/job/[id]/page.tsx`) expects `venue.files` on the single-job response (Monday-era shape), but OP's `/api/portal/jobs/:quoteId` only exposes job-file `sharedFiles` — venue files are completely missing, and even the job ones are in the wrong shape for `VenueFiles` to render. Fix requires (a) OP single-job response: include `venue.files` + `job.files` filtered + shaped as `{ assetId|null, name, url, fileType }`, and serve content via either presigned R2 URLs or a portal-auth download proxy; (b) portal page: wire OP's shared files into existing `VenueFiles` component or add a dedicated "Job Files" section. Not yet scheduled.
- [x] **Portal reset-password "Invalid or expired link" fix (17 Apr 2026)** — `src/app/api/auth/verify-reset-token/route.ts` only checked the in-memory Monday-era Map. OP-issued tokens live in `portal_password_reset_tokens` so every verify returned `valid: false` → user saw "Invalid or expired link" and couldn't set a password. Added `GET /api/portal/auth/verify-reset-token` on OP + `verifyResetTokenOP()` helper + OP-mode branch in the Next.js route. Monday path preserved as fallback.
- [x] **Portal shared files fix (18 Apr 2026)** — resolves the 17 Apr gap above. OP's `/api/portal/jobs/:quoteId` response now includes `venue.files` and `job.files`, filtered by `share_with_freelancer=true`, shaped as `{ assetId:null, name, url, fileType }` matching the portal's existing `VenueFile` interface. R2 keys get 1h presigned URLs via new `getPresignedDownloadUrl()` helper in `backend/src/config/r2.ts` (added `@aws-sdk/s3-request-presigner` dep); external URLs pass through. Portal `src/app/job/[id]/page.tsx` reuses `VenueFiles` component with a new optional `title` prop — renders separate "Venue Files" and "Job Files" sections.
- [x] **Staff-shared portal account (18 Apr 2026)** — Migration 053 adds `is_portal_shared_account` on people; `info@oooshtours.co.uk` flagged true. Portal auth middleware re-reads the flag on every request (no re-mint needed). Jobs-list query widens for shared accounts to include every `is_ooosh_crew=true` assignment (`WHERE qa.person_id = $1 OR qa.is_ooosh_crew = true`) so local D&C / in-house runs show up in the shared inbox. Per-quote access checks also widened on job detail / equipment / completion / files endpoints. Accountability preserved via the existing `staffName` field on the completion form (shown whenever the logged-in email is `@oooshtours.co.uk`).
- [x] **PORTAL_MONDAY_FALLBACK_ENABLED env flag (18 Apr 2026)** — 10 portal routes (auth/jobs/completion) now gate their Monday fallback behind this env var. Default `true` keeps the silent safety net; setting `false` on Netlify makes failures return a clean 502 (or 401 for credential-rejected login) instead of serving Monday data. `mondayFallbackAllowed()` helper in `src/lib/op-api.ts`. Telemetry (`reportFallback`) still fires in every case so we can measure breakage before the flip.
- [x] **Non-UUID 404 guard on portal quote endpoints (18 Apr 2026)** — Stale portal state sometimes hands the 4 `:quoteId` routes a Monday item ID (11-digit int). Postgres's UUID cast threw, endpoint 500'd, portal silently fell back to Monday with a telemetry alert. Added shared `isUuidLike()` regex guard at the top of the 4 routes (job detail, equipment, complete, files) — legacy IDs now 404 cleanly without touching Postgres.
- [x] **Completion flow — equipment PDF + R2 photos + lightbox (18 Apr 2026)** — (a) Delivery-note PDF was rendering an empty equipment table because completion code called `/api/job_data.php` and read non-existent `DESCRIPTION`/`QUANTITY` fields; now uses `/frames/items_to_supply_list.php` with `title`/`qty` and filters kind:2 non-virtual items. (b) Completion photos + signature moved from base64-in-DB to R2 keys under `completion/{quoteId}/`, with legacy data-URL fallback if R2 is unavailable. `/api/files/download` allowlist extended to `completion/` + `delivery-notes/` prefixes. (c) TransportOpsPage `CompletionImageThumb` component fetches R2 keys authenticated and renders in a portal-rendered lightbox modal with a Download button (Escape + backdrop close). (d) Download filenames now `{hhJob}-{YYYY-MM-DD}-{1|signature}.{ext}` instead of raw UUIDs.
- [x] **Monday → OP data migration scripts (18 Apr 2026)** — `backend/src/scripts/migrate-monday-upcoming.ts` pulls upcoming items from the D&C + Crew Jobs boards and creates `quotes` + `quote_assignments` against existing OP jobs matched by HH number. Never creates new jobs. Idempotent on D&C via Monday tracking column `text_mm2krnzm` (`"yes"` = migrated, `"fail: <reason>"` = blocked). Flags: `--commit`, `--only-dc`, `--only-crew`, `--since YYYY-MM-DD`, `--refresh-venues` (backfills venue_id on already-migrated quotes). Items in D&C group `new_group` ("upcoming / to be arranged") bypass date + status filters and land as unassigned quotes. `backend/src/scripts/migrate-monday-venues.ts` pulls the Venues board (~464 venues), upserts into OP `venues` via external_id_map + name-match, stashes contact info (Contact 1/2, Phone 1/2, Email) into `general_notes` as a clearly-marked idempotent block, populates `default_miles_from_base` / `default_drive_time_mins` / `default_tolls_amount`. Migration 054 adds `default_tolls_amount` column. First live run: 196 upcoming items migrated (148 D&C assigned + 48 unassigned from the "to be arranged" group), 464 venues imported.
- [ ] **D&C venue connect-column parser broken (18 Apr 2026)** — the `--refresh-venues` pass reported `no Monday venue link: 155/155`, but Jon confirms every one of those items actually has its venue linked on Monday via the `connect_boards6` column. The JSON parsing in `migrate-monday-upcoming.ts` (both create-path and refresh-venues path) for `connect_boards6` isn't extracting `linkedPulseIds[0].linkedPulseId`. First task next session: dump one known-linked item's raw column value and fix the parser. Affects both migration of new items and the ~196 already-migrated "No venue" rows on Transport Ops.
- [x] Inline crew assignment on Transport Ops page (same picker as Job Detail, bidirectional)
- [x] Local D/C form improvements: venue address book lookup, smart date defaults, amber warning on change
- [x] Quote editing: Edit Quote modal on Transport Ops page + Job Detail page (venue, date, time, fees, notes)
- [x] Inline-editable arranging details: client intro status picker, key points, tolls/accom/flights clickable pills, notes
- [x] Run grouping UI: letter-based display (Run A/B/C), coloured side bands, join/create run buttons per job
- [x] Colour-matched status dropdown (replaces plain select)
- [x] Completion details view: photos, signature, timestamp, customer present, notes
- [x] Separate completed/cancelled toggles
- [x] Reminder system (unassigned deliveries approaching, overdue completions) — overdue-completion chaser live 17 Apr 2026 (every 30 min, 2h/6h/14h + staff escalation). **Arranging chaser** live for "Needs arranging" reminders on quotes still in `ops_status='todo'` as the job date nears: `services/arranging-chaser.ts`, ladder fires at 5/3/1 days out via `arranging_reminder_level` (idempotent — bumped before send, capped at 3). Business hours only (07:00-22:00 London). Gated on operational `pipeline_status` — never chases enquiries / provisional / lost / cancelled (May 2026 fix; mirrors the Crew & Transport page default).
- [x] Change notifications to freelancers (date/time/venue changes → email alert) — fires from `quotes.ts` PUT via `job_change_notification` template
- [ ] Issues on road reporting (breakdowns, delays, problems)
- [x] PDF delivery note generation (migrate from Netlify function to OP backend) — `backend/src/services/delivery-note-pdf.ts` (17 Apr 2026)
- [x] Client delivery note emails via OP email service — `delivery_note` template, fires on completion of `job_type = 'delivery'` quotes
- [x] **Last-mover auto-dispatch on portal completion (5 May 2026)** — when a freelancer marks the FINAL outstanding delivery quote on a job complete via the portal, OP flips `jobs.pipeline_status = 'dispatched'` + writes back HH status 5. Mirrors the warehouse module's auto-dispatch but at quote-aggregate level. Only fires for `job_type='delivery'` (collections + crewed bypass). Only fires when current `pipeline_status IN ('confirmed', 'prepped', 'prepping')` — never regresses a job past dispatch. Adding a new delivery later (e.g. mid-tour bass amp swap) won't un-dispatch: the pipeline_status whitelist + HH writeback's "skip if already at target" guard make this idempotent. Lives in `routes/portal.ts` completion handler's background IIFE; logs a `🚚 Job dispatched — final delivery completed by ...` interaction on the timeline with `created_by = SYSTEM_USER_ID`. Removes a chronically-forgotten manual step (was Monday, now OP).
- [ ] Invoice comparison (freelancer invoice vs expected cost, overcharge flagging) — nice-to-have, post go-live
- [ ] **Arrangement pills → dashboard integration**: Surface arrangement statuses on Dashboard and Job Requirements
  - [x] **Transport Introductions dashboard bucket (May 2026)** — quotes in next 7 days where `client_introduction IN ('todo', 'working_on_it')` AND linked job is `pipeline_status IN ('confirmed', 'prepping', 'prepped')`. Click-through to `/operations/transport?needs_intro=1`. See "Transport Introductions bucket + chase-date clearing" section under Dashboard for full detail.
  - Dashboard widget: "X jobs with outstanding tolls/accommodation/flights" (query `*_status = 'todo'` on active quotes)
  - Job Requirements integration: arrangement items auto-create as requirements on prep checklist
  - Freelancer portal: show arrangement status in job details (e.g. "accommodation: booked")
  - Notifications: auto-alert when job approaching and arrangements still outstanding
- [x] **Run group pricing (23 Apr 2026)**: Migration 062 promotes `run_groups` to a first-class table with `combined_freelancer_fee` + `combined_client_fee` + `notes` + `run_date`. `quotes.run_group` is now an FK with `ON DELETE SET NULL` = non-destructive ungroup. Individual `quotes.freelancer_fee` is never touched — grouping/ungrouping is purely metadata. Backend CRUD on `/api/quotes/runs` (POST create with quote_ids, PATCH fees, DELETE to ungroup, GET with standalone-total reference). Transport Ops expanded panel has inline combined-fee editors with placeholder showing the standalone sum. Job Detail "Crew & Transport" cards show a "🔗 Part of a run" badge + combined fee with the individual fee struck through. Legacy `quotes.run_group_fee` kept for now, unused by new code.
- [x] **Run group → freelancer portal alignment (23 Apr 2026)**: Portal's `/api/jobs/route.ts` `groupJobs()` prefers `runCombinedFreelancerFee` over summing `driverPay` when set, exposes `hasCombinedFee` + `standaloneTotalFee` + `runNotes` on the grouped run payload. Portal Next.js dashboard card shows combined fee with standalone struck through + "combined run fee" label. `/api/jobs/run` has an OP mode that filters by run_group UUID + date, fetches venue details via `getJobDetailFromOP`, returns combined fee + standalone total. Job detail page shows combined fee prominently with standalone reference. Monday path preserved behind `PORTAL_MONDAY_FALLBACK_ENABLED` for the transition window.
- [x] **Freelancer book-out token repoint (23 Apr 2026, foundation)**: Portal's `/api/jobs/:id/bookout-token` now mints an HMAC token in OP format (`{expiry}.op.{quoteId}.{email}.{sig}`) and redirects to OP's `/vehicles/book-out` when `DATA_BACKEND=op`. OP exposes `POST /api/vehicles/freelancer-bookout/resolve` (public, HMAC-authenticated) which verifies the token, confirms the freelancer is on a `quote_assignments` row for the quote, locates the staff-allocated `vehicle_hire_assignments` row, and mints a narrow-scoped `freelancer_bookout` session JWT (4h TTL, scoped to one assignment). New middleware `authenticateFreelancerBookout` validates that JWT on protected routes. The embedded VM's existing `exchangeFreelancerToken` (in `useAuth.tsx`) was repointed from the legacy `/validate-freelancer-token` Netlify function to the new OP endpoint; returns `hhJobNumber` as `jobId` so downstream `BookOutPage` flow (which expects an integer) keeps working. Monday `VEHICLE_APP_URL` redirect preserved behind `PORTAL_MONDAY_FALLBACK_ENABLED` for the transition window.
  **Known gap — D&C allocation-to-freelancer linkage:** The resolve endpoint's assignment lookup is permissive (matches by `drivers.person_id` OR any NULL-driver D&C assignment on the job). D&C freelancers don't usually have a `drivers` row, and `vehicle_hire_assignments` was designed for client self-drive hires. A proper freelancer→vehicle linkage (so the resolve picks the right van when multiple D&C allocations exist on a job) still needs firming up. For single-allocation D&C jobs the current logic works; for multi-crew runs it may need refinement.
- [x] **Freelancer book-out Round 4 — hire-form integration + smart resolve + email fallback (30 Apr 2026):**
  - **Smart resolve** in `POST /api/vehicles/freelancer-bookout/resolve`: a D&C self-drive job typically lands two `vehicle_hire_assignments` rows on arrival — Row A from the staff Allocations page (`vehicle_id` set, `driver_id` NULL, "this van's going to this delivery"), and Row B from `POST /api/hire-forms` when the customer signs (`driver_id` set, `vehicle_id` NULL, "this is who'll drive once it lands"). They're the same logical hire and need merging before book-out so the condition PDF carries the customer name and the post-book-out hire-agreement PDF chain can fire. The resolve endpoint now atomically (a) copies `vehicle_id` from Row A onto Row B, (b) cancels Row A with an `[Auto-merged] …` audit note in `notes`, (c) mints the freelancer's session against Row B (the merged row). Idempotent — second call finds the merged row directly and returns it. Replaces the manual SQL we hand-ran for jobs 15378 / 15793 / 15819 / 15820. Multi-van scope deferred (covered by the D&C allocation linkage gap above) — for now the merge picks one allocation × one customer (lowest `van_requirement_index`) per resolve and leaves siblings alone.
  - **Hire-forms routes accept freelancer JWT.** `GET /api/hire-forms/by-job/:hirehopJobId`, `PATCH /api/hire-forms/:id`, and `POST /api/hire-forms/:id/generate-pdf` swapped from `authenticate` (staff-only) to `authenticateVehicleFlexible` (staff OR freelancer-bookout session). Each handler checks `isFreelancerBookout(req)`, looks up `getBookoutScope(req)`, and confirms the target hire form sits on the freelancer's own job (`scope.jobId` or `scope.hhJobNumber` match). Without these, the freelancer's `BookOutPage` couldn't load the customer's hire form to populate the condition PDF, write back vehicle reg + status='booked_out', or trigger the auto-PDF chain.
  - **`getBookoutScope` extracted.** Moved out of `routes/vehicles.ts` into `middleware/freelancer-bookout-auth.ts` so the hire-forms routes can import it. Same shape, also returns `jobId` now.
  - **Freelancer PATCH whitelist (silent-strip).** `PATCH /api/hire-forms/:id` clamps freelancer payloads to `{vehicle_id, hire_end, start_time, end_time, return_overnight, status, ve103b_ref}` — anything else (notes, client_email) gets dropped silently rather than 403'd. `vehicle_id` is also clamped to `scope.vehicleId` (if a freelancer's client tries to send a different one we override + warn). `status` is locked to `'booked_out'`. Empty post-strip payloads return 200 idempotent rather than 400 — Round 4 design rule per jon: never block a freelancer mid-handover with a "you can't change that" error. If the writeback's `updateDriverHireForm` ever ships a new field, the silent-strip is the safety net while the whitelist catches up.
  - **Frontend re-enables hire forms in freelancer mode.** `BookOutPage`'s `useDriverHireForms({ enabled: !isFreelancer })` guard is gone — freelancers now load the customer's hire form, see the customer's name + email pre-filled on the Driver & Hire step, and the writeback loop fires for every customer hire form on the job (multi-driver-on-one-van case). A new `canAdvance` branch blocks the Driver & Hire step in freelancer mode unless at least one customer hire form exists, with copy "Customer hire form not received yet — please contact the Ooosh office before continuing." Cross-job driver fallback is hidden in freelancer mode (irrelevant + their session is scoped). The post-book-out hire-agreement PDF chain happens server-side via the existing `setImmediate` in the PATCH handler — no frontend change needed.
  - **Email fallback wired into 2 endpoints.** `POST /api/vehicles/send-email` (condition report) and `POST /api/hire-forms/:id/generate-pdf?send_email=true` (hire agreement PDF) now route through `resolveClientEmailTarget` when no driver/customer email is on file. Recipient chain: hire-form driver email → job-level client contacts → `info@oooshtours.co.uk` with amber "no client email on file" banner + `email`-type interaction logged on the job timeline. Frontend (`sendConditionReportEmail`) now passes `to` as nullable + always includes `hireHopJob` so the backend has the lookup key for the fallback. Stops condition reports being silently dropped on HH-synced sole-trader jobs (e.g. RX22SWU class incidents) and aligns the freelancer flow with the existing `money-emails.ts` safety net.
  - **Tidy.** `GET /get-checklist-settings` and `GET /get-events` added to `FREELANCER_BOOKOUT_ALLOW`. `/get-events` gains a scope check that clamps the query to the session's allocated reg (no fleet-wide enumeration). Kills the 403 console noise the freelancer was hitting on every walkaround load.
  - **Still TODO (Round 5+):** Vehicle swap mid-hire (Phase D3 — UI; soft check-in primitive shipped May 2026, see `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md`). Multi-van D&C (drivers × vans expansion of the resolve merge). Freelancer-led interim check-in (reuses the soft check-in primitive).

##### Carnets (inline on Prep Checklist, with global overview)
- [ ] Carnet fields on `job_requirements` with step tracking: applied → received → items listed → stamped out → returned → closed
- [ ] Global carnet overview page (`/operations/carnets`) — outstanding carnets, post-hire returns pending
- [ ] Reminder automation: chase for return after hire ends

**Parallelisation notes:** Streams 2-7 can all run simultaneously — they touch different tables, routes, and pages. Stream 1 + the HH-Derived Requirements Engine are the foundation and should complete first, as all other streams plug into it.

##### HH-Derived Requirements Engine ← NEW (Apr 2026)

**Core concept:** HireHop is the source of truth for *what's on a job*. The OP reads HH line items and automatically derives operational requirements — what prep is needed, what configuration changes are required, what workflows to trigger. This eliminates the "same thing twice in two places" problem and ensures OP stays in sync when HH changes.

**Proven via API testing (9 Apr 2026):** The `items_to_supply_list.php` endpoint returns all items on a job including:
- Standard items (`kind: 2`) with category, stock ID, quantity
- **Selected prompt items (`kind: 3`)** — only the chosen option appears (e.g. if "forward-facing" is selected, only that prompt shows; "round a table" is absent)
- **Custom fields** including `TYPE_CUSTOM_FIELDS.preptimemins` — prep time in minutes per item (same figure for de-prep)
- Parent-child relationships via `LFT`/`RGT` nested set values and `▶` prefix on parent items
- `AUTOPULL` as stable identifier for prompt options (e.g. 2822 = round-a-table, 2823 = forward-facing for rear seats)

**Three-tier detection model:**

| Tier | Detection Method | Examples |
|---|---|---|
| **Category check** | Items in specific HH categories | Backline (backline cat), Rehearsal (cat 450), Vehicle (cat 370), Vehicle accessories (cat 371) |
| **Category + keyword** | Category match + item name parsing | "Premium LWB" → Premium van, "manual gearbox" / "auto gearbox" → transmission type |
| **Prompt parsing** | `kind:3` selected prompts under parent items | Seat configuration (AUTOPULL 2822/2823), other accessory options |

**HH-derived requirement types:**

| Requirement | HH Signal | Detection | OP Action |
|---|---|---|---|
| **Vehicle (Self-Drive)** | Item in category 370 (Vehicles) | Category check | Auto-create vehicle requirement. Default is self-drive; "Van & Driver" button overrides (flips off hire-forms/excess chain) |
| **Seat configuration** | `kind:3` child of "Rear seats:" parent (LIST_ID 1645) | Prompt parse + AUTOPULL ID | Flag on prep checklist. Cross-ref `fleet_vehicles.seat_layout` to show which vans need turning |
| **Backline** | Items in backline category | Category check | Auto-create backline requirement with item list + prep time |
| **Rehearsal** | Items in category 450 | Category check | Auto-create rehearsal requirement |
| **Hire forms** | Derived: self-drive vehicle detected (no "van & driver" override) | Chained from vehicle | Auto-create hire forms requirement |
| **Insurance excess** | Derived: hire forms requirement exists | Chained from hire forms | Auto-create excess requirement |
| **Carnet** | International venue + equipment on job | Venue location + items exist | Auto-create carnet requirement (multi-step workflow in OP) |
| **Prep time totals** | `TYPE_CUSTOM_FIELDS.preptimemins` summed across all items | Custom field read | Dashboard: "4 vehicles need prepping today, est. 5 hours". Split by category (vehicles, backline, rehearsals). Same figure for de-prep |

**Sanity-check flags (OP is source of truth, HH used for cross-check):**

| Check | Logic | Surface |
|---|---|---|
| **Crew mismatch** | `kind:4` crew items on HH but no crew quote in OP (or vice versa) | Amber warning on prep checklist |
| **Transport mismatch** | Delivery quote in OP but no corresponding HH item (or vice versa) | Amber warning: "delivery quote exists but not on HH" / "delivery on HH but no OP quote" |
| **Van & driver vs self-drive** | Van + crew detected but marked as self-drive (or vice versa) | Edge case flag |
| **HH changed after action** | HH line items changed since staff marked requirement as "done" | Warning: "HH has changed since you marked this done" — does NOT overwrite status |

**OP-only requirement types (no HH equivalent):**

| Type | Notes |
|---|---|
| Incoming deliveries / merch receiving | Client sends stuff — nothing in HH |
| Lost property | Post-hire discovery |
| Sub-hire | Migrated fully to OP (HH PO/shortage method too clumsy for custom items) |
| On-road issues | Real-time operational — breakdowns, delays |
| Post-hire problems | Damage, missing items — after HH lifecycle |
| General tasks / reminders | Not job-specific |
| Custom requirements | Free-text, user-defined |

**Removed requirement types (were speculative, not needed):**
- ~~Stage Plot / Tech Spec~~ — lives in job files if needed
- ~~Special Permits~~ — not part of day-to-day process

**Sync triggers:**
1. **Background sync** (every 30 min) — existing job sync, now also processes line items for requirement derivation
2. **Webhook** — `job.updated` webhook from HH triggers immediate line item re-fetch for that job
3. **On-demand** — "Sync now" button on Job Detail page, fetches fresh items from HH
4. **Auto on page load** — navigating to Job Detail triggers background item refresh (non-blocking, updates reactively when data arrives)

**Requirement lifecycle with HH sync:**
1. HH item detected → OP auto-creates requirement with `is_auto: true`, `source: 'hirehop_sync'`
2. Staff works the requirement (changes status, adds notes, marks done)
3. Next sync: if HH items unchanged, requirement untouched. If HH items changed, flag mismatch for staff review
4. If HH item removed: requirement flagged "HH item removed — review needed" (not silently deleted, in case staff already did prep work)

**Vehicle seat configuration — end-to-end example:**
1. Sales adds Premium Van to job in HH, selects "Rear seats all forward-facing" prompt
2. Sync detects: category 370 item + `kind:3` "forward-facing" prompt (AUTOPULL 2823)
3. OP auto-creates vehicle requirement + sets `seat_config: 'forward_facing'`
4. OP cross-refs `fleet_vehicles` WHERE `simple_type = 'Premium'` AND `is_active = true`: checks `seat_layout` field on each
5. Prep checklist shows: "Seats: Forward-facing. GX17DHN already forward-facing, others need turning"
6. Client changes mind → sales updates HH prompt to "round a table"
7. Next sync: OP detects change, updates requirement, flags if staff already prepped

**Fleet vehicle seat tracking:**
- New field `seat_layout` on `fleet_vehicles` table: `'round_table'` | `'forward_facing'`
- Populated via vehicle prep forms — by the time each van has been prepped once in OP, we'll have the data
- Displayed on vehicle detail page (quick reference for van team)
- Cross-referenced during job prep to identify which vans need seat changes

**Van & Driver toggle:**
- Default assumption: self-drive (most common case)
- "Van & Driver" button on Job Detail / Drivers & Vehicles tab — overrides self-drive assumption
- When toggled: hire forms + excess requirements are NOT auto-created
- Persisted on job or quote level

**Requirement type redesign (Apr 2026):**

The Prep Checklist merges HH-derived detection with OP workflow tracking. Each requirement card shows HH context inline — no separate "Detected from HireHop" panel needed long-term.

| Type | Source | Steps | Card content |
|---|---|---|---|
| **vehicle** | HH-derived (cat 370) | Not started → Prepping → Prepped → De-prepped | Van type, count, prep time (from `preptimemins`), seat config + fleet availability. Nested: hire_forms + excess chain for self-drive |
| **hire_forms** | Derived from vehicle (self-drive) | Not started → Sent → Signed → Complete | Auto-email 10 days before hire start (or on confirmation if <10 days). Reminder at 5 days if no response. On-demand email to choosable contacts. Hire form URL construction. Shows which drivers have submitted |
| **excess** | Derived from hire_forms | Needed → Taken → Held → Resolved | Links to Money tab. Shows if excess already held for client/driver. Top-N-drivers calculation |
| **transport** | OP-only (from quotes) | Mirrors ops_status from Crew & Transport tab | Overview card shows quote summary + progress. No duplicate steps — reads from quotes.ops_status |
| **crew** | Sanity flag (HH kind:4 vs OP) | N/A — flag only | Amber warning if crew on HH but no OP quote, or vice versa |
| **backline** | HH-derived (cats 372-410) | Not started → Working on → Finished | Item count + prep/de-prep time from `preptimemins` |
| **rehearsal** | HH-derived (cat 450) | Detected → Booked → Sitter assigned → Setup complete | Prep time from `preptimemins` |
| **carnet** | HH-derived (international + equipment) | Applied → Received → Items listed → Stamped out → Returned → Closed | Multi-step workflow, OP-managed |
| **merch** | OP-only | Request sent → Some received → All received → Notified → Given to client | Incoming deliveries from bands/clients |
| **sub_hire** | OP-only | Need identified → Sourcing → Ordered → Received → Returned | OP-only, HH PO method too clumsy |
| **custom** | Manual | N/A | Free-text one-offs |

**Removed types:** accommodation (→ arranging details pills), permits, stage_plot (→ files)

**Hire form auto-email logic:**
- 10 days before `job_date`: send hire form email to client contacts (self-drive jobs only)
- If confirmed with <10 days to go: send on confirmation
- 5 days before `job_date` (or 4 days if last sent <24h ago): reminder email if no forms received
- On-demand: "Send hire form" button on requirement card with contact picker
- Hire form URL constructed from job data + driver verification flow

**Vehicle requirement card layout (target):**
```
🚐 Vehicle (Self-Drive)                    [Status: Not started ▾]
   1x Premium LWB (M) — manual gearbox
   ⬆️ Forward-facing seats
   Est. prep: 1h 15m
   Fleet: 3 Premium available (GX17DHN forward-facing, 2 others need turning)
   ────────────────────
   ↳ 📋 Hire forms: Not started    [Send ✉]
   ↳ 💰 Excess: Needed
```

**Fleet availability:** Mirrors existing vehicle module allocation logic (what's available vs what's on the job). Read from same source to avoid duplicate API calls.

#### Pipeline & Enquiry Cleanup ← IN PROGRESS

Two streams of work to improve the pipeline/enquiry/jobs experience:

**Stream A: Job Detail Editing** ✅ COMPLETE
The Job Detail page has inline editing for all key fields.
- [x] **HH Job Number** — Clickable/editable "NEW" badge. Accepts pasted HH URLs (`https://myhirehop.com/job.php?id=15564`) and extracts the number. Once linked, sync takes over.
- [x] **Dates** — Four-date linked editor (Outgoing↔Job Start, Returning↔Job Finish toggleable links, date constraints enforced)
- [x] **Client** — Editable with org search picker
- [x] **Job name** — Inline editable
- [x] **Pipeline fields** — Likelihood, next chase date, job value — all inline editable on Job Detail
- [x] **Create in HireHop** button — Push Ooosh-native enquiry to create HH job, write back the number. HH user/manager mapping via `hh_user_id` on users table (migration 028). Uses `/api/save_job.php` with confirmed field names: `out`/`start`/`end`/`to` for dates, `duration_days`/`duration_hrs` for charge period, `duration_locked: 0`. Default times 09:00 when DatePicker sends date-only. Details field is NOT pushed to HH job memo.

**Stream B: Band-Centric Data Model** ✅ COMPLETE
Organisation-to-organisation relationships and multi-org job links. Makes "bands" a first-class concept.
- [x] Migration: `organisation_relationships` table (org-to-org links with typed relationships: manages, books_for, does_accounts_for, promotes, supplies)
- [x] Migration: `job_organisations` junction table (band, client, promoter, venue_operator, supplier roles per job)
- [x] Backend: Org relationships CRUD endpoints
- [x] Backend: Job-organisation links CRUD endpoints
- [x] Frontend: "Relationships" section on Organisation Detail page (add/remove/view linked orgs with bidirectional display)
- [x] Frontend: Band/org links on Job Detail page (add band, client, promoter etc.)
- [x] Frontend: Band picker on New Enquiry form with org search
- [x] Frontend: Service type quick-select buttons on New Enquiry form (Self-drive van, Backline, Rehearsal) — auto-creates matching job requirements (vehicle+hire_forms+excess, backline, rehearsal), description optional when service types selected
- [x] Auto-generated job names in "Band - Client - Selection" format (e.g. "Arctic Monkeys - ATC Live - Van, Backline")
- [x] Person-to-org role picker (dropdown instead of free text) with standard roles
- [x] End role confirmation dialog with optional reason and repoint flow
- [x] Frontend: Person context surfacing in pickers (show org connections when selecting a person — crew picker shows "role at Org Name")
- [x] Frontend: Smart suggestions from org graph (select band → auto-suggest management company as client on Job Detail + auto-populate client on New Enquiry)
- [x] Org-to-org relationship types: manages↔managed_by, books_for↔booked_by, does_accounts_for↔accounts_done_by, promotes↔promoted_by, supplies↔supplied_by, represents↔represented_by
- [x] Person-to-org role types: Tour Manager, Manager, Production Manager, Engineer, Accountant, Promoter, Crew, Band Member, Driver, Agent, Site Contact, Owner, General Contact, Other

**Stream C: HireHop Data Cleanup** (depends on Stream A "Create in HireHop" button)
HireHop sync imported contacts literally — bands became people, management companies got typed as "client", etc.
The cleanup strategy is: OP becomes master for relationship data, HH gets what it needs via push.

*Step 1: OP→HH job creation* ✅ COMPLETE (part of Stream A)
- [x] `POST /api/pipeline/:id/push-hirehop` — create job in HH via `/api/save_job.php`
- [x] Map OP fields → HH: contact person → `name`, client org → `company`, dates → `out`/`start`/`end`/`to`, job name → `job_name`, charge period → `duration_days`/`duration_hrs` with `duration_locked: 0`
- [x] Date-only values default to 09:00 time; details field NOT pushed to HH memo
- [x] Write back HH job number to OP `jobs.hh_job_number`
- [x] Include `no_webhook=1` to prevent sync loops
- [x] Band stays in OP only (HH has no band field)
- [x] Frontend: "Create in HireHop" button on Job Detail + optional checkbox on New Enquiry form

*Step 2: Sync guard rails* ✅ COMPLETE
- [x] HH contact sync: when new person name matches existing *organisation*, flag as `name_conflict` → review queue
- [x] HH contact sync: when new org typed 'client' doesn't look like a company name, flag as `possible_band` → review queue
- [x] HH contact sync: type mismatches flagged as `type_mismatch` → review queue (preserves manually-set types, only overwrites HH-derived types: client/venue/supplier/unknown)
- [x] HH contact sync: tags merged (not replaced) on existing orgs
- [x] HH job sync: only updates HH-owned fields (status, dates, names), uses COALESCE for org links, never touches pipeline_status/org types/relationships/job_organisations
- [x] Surface "needs review" items on Data Cleanup page (Sync Review Queue tab with resolve/dismiss actions)

*Step 3: Data cleanup tools* ✅ MOSTLY COMPLETE
- [x] "Convert Person to Organisation" — transactional: creates org, copies external IDs, moves interactions + job links, soft-deletes person
- [x] **Organisation merge** (May 2026) — admin/manager-only "Merge" button on Org Detail header. `GET /api/organisations/:id/merge-preview?keep_id=…` returns counts of what will move (people, jobs, job-org links, venues, interactions, relationships, child orgs, job issues) + external ID conflicts. `POST /api/organisations/:id/merge` runs in a single transaction (BEGIN/COMMIT/ROLLBACK on failure): reassigns FK rows to keeper, dedups against unique constraints (`job_organisations(job_id, org, role)`, `organisation_relationships(from, to, type, status)`, `external_id_map(entity_type, entity_id, system)`), drops self-referencing relationship edges, fills keeper's null scalars from loser, unions tags + files, appends backref note both directions for audit (`[Merged from "X" on YYYY-MM-DD by user]` on keeper, `[Merged into "Y"]` on loser). Loser is soft-deleted (`is_deleted=true`); audit_log gets entries on both records. External ID conflicts (e.g. both orgs have a HireHop ID) are resolved keeper-wins; discarded IDs are recorded in keeper notes. Frontend modal: org search picker, count preview, type-the-loser-name confirmation guard, redirect to keeper on success. Stays on the same branch as the people merge (transactional was an upgrade — original people-merge in `routes/duplicates.ts` is NOT transactional, latent risk for that flow). **Companion display change:** the Job Detail sidebar Client History "Internal Notes" block (`JobDetailPage.tsx`) is now `line-clamp-2` with a Show more / Show less toggle when content exceeds 120 chars or 2 lines. Merge backref notes + external-ID-conflict logs accumulate on the keeper's `notes` field over time, so the always-fully-rendered display was visibly bloated post-first-merge.
- [ ] **Person+org merge** — for the case where one record is a person and the other is an org representing the same entity. Person→Org conversion exists already (`/api/data-cleanup/convert-person-to-org`); a true merge would be the conversion path + org-merge path stitched. Lower priority since converting first then merging works.
- [x] Bulk type correction — multi-select orgs by type, change type in bulk (auto-resolves pending type_mismatch reviews)
- [x] "Needs review" page — Data Cleanup page (`/data-cleanup`) with Sync Review Queue, Org Types, Convert Person tabs
- [x] Organisation type stats breakdown with click-through to orgs of each type

*Step 4: Smart relationship suggestions* ✅ COMPLETE
- [x] When viewing a "Contact" at a "client" org, system suggests: "Is this actually a Band?" (amber banner on Org Detail)
- [x] When new HH sync creates entities, surface for review before they pollute the graph (sync flagging → review queue)

#### Remaining Phase 2 work (no strict ordering)

- [x] **Address Book Enhancements** (24 Mar 2026)
  - [x] Do Not Hire flag on People + Organisations (red banner, admin set/lift, audit logged, non-blocking)
  - [x] Working Terms dropdown on People + Organisations (USUAL/FLEX BALANCE/NO DEPOSIT/CREDIT/CUSTOM + credit days)
  - [x] AI text panels on all address book entities: Internal Notes (always shown), AI Summary (placeholder), AI Research (placeholder)
  - [x] File sharing flag (`share_with_freelancer`) on venue files and job files (green Shared badge, hover toggle, persisted via `PATCH /api/files/update-metadata`)
  - [x] Google Maps link on venue addresses (map pin icon)
  - [x] Organisation picker on venue form + org display on venue detail
  - [x] Pagination on Organisations and Venues pages
  - [x] Missing org type "client" added to form dropdown + filter (was causing default-to-band bug)
  - [x] Multi-filter on People: has email, has phone, freelancers, approved
  - [x] Multi-filter on Organisations: has email, has people, type
  - [x] Multi-filter on Venues: linked to org
  - [x] Sort options on all list pages: name, recently added, recently updated, last contacted
  - [x] "Last Contact" column on People + Organisations (colour-coded: green <30d, amber 30-90d, red >90d)
  - [x] Smart suggestions on Org Detail (suggest band retype for misclassified clients)
  - [x] Data Cleanup page restricted to admin/manager roles in nav
  - [x] Client info surfacing on New Enquiry form + Job Detail sidebar: Do Not Hire warning (red banner), Working Terms, Internal Notes — via enhanced `/pipeline/client-history` endpoint returning `client_info` from organisations table
  - [x] Band trading history on New Enquiry form sidebar (shows band's job history alongside client history)
  - [x] Band trading history on Job Detail sidebar (when band linked via job_organisations)
  - [x] Separate stacked sections: client history above, band history below, each with 4-square stats grid
- [x] **Per-job Contact Linkage** (May 2026, rounds 1-6) — full spec under "Per-job contacts (`job_contacts`)" in Shared Utilities. Six PRs (#547, #549, #550, #551, #554, #559, #561) split into a data layer + routing graduation + management UI:
  - [x] Round 1 (#547): picklist tidy + cascade contact picker on New Enquiry form
  - [x] Round 2 (#549): tickable contacts + search-first add + `job_contacts` table (migration 086)
  - [x] Round 3 (#550): +1 button on Returning, auto-tick of default contact on cascade load
  - [x] Round 4 (#551, #554): dangling-form auto-save on submit failure + loud failure alerts, validation-error clear-on-recover
  - [x] Round 5 (#559): sender helpers (money-emails, hire-form-contacts, has_client_email banner) read `job_contacts` first; HH push enrichment uses primary contact's name as `NAME` + email/phone, org as `COMPANY`
  - [x] Round 6 (#561): `JobContactsCard` on Job Detail header — tickable chips with primary star, debounced autosave, "+ Add" with search-first / create-new fallback; opt-in promote-to-job-contacts checkbox on the hire-form picker; three new endpoints under `/api/pipeline/:jobId/contacts` (GET / PUT / POST add-person)
- [x] **Mobile Responsiveness & UX** (15 Apr 2026)
  - [x] Job Detail header: responsive job name (text-lg/text-2xl), stacked action buttons on mobile, flex-wrap badges
  - [x] Details & Notes collapsed into header card with truncated snippets, click-outside-to-close
  - [x] Tab bar horizontally scrollable on mobile with shorter labels (scrollbar-hide CSS utility)
  - [x] Activity timeline: fixed raw Date objects in change logs, human-readable field labels
  - [x] overflow-x-auto on all list page tables (People, Orgs, Drivers, Team, Excess, Org Detail, Driver Detail)
  - [x] "Open in HireHop" hidden on mobile (redundant with #number link)
  - [x] Header card padding reduced on mobile (p-4 sm:p-6)
- [x] **Hire History Tab** (15 Apr 2026)
  - [x] `GET /api/organisations/:id/hire-history` — paginated jobs via job_organisations, retro + lost reason parsing
  - [x] `GET /api/people/:id/hire-history` — jobs via org memberships UNION crew assignments
  - [x] Reusable `HireHistoryTab.tsx` component with stats cards (total, confirmed, value, retro breakdown)
  - [x] Retro rating badge + notes + follow-up shown inline (not just hover)
  - [x] Lost reason shown for lost jobs (grey "Lost" badge + reason text)
  - [x] Person hire history shows "Crew" label for crew assignment links
  - [x] Organisation Detail: "Hire History" tab between Relationships and Activity Timeline
  - [x] Person Detail: "Hire History" tab after Activity Timeline
- [x] **Completion Retro** (15 Apr 2026)
  - [x] Retro modal on status transition to Completed (like Lost reason modal)
  - [x] Three-button rating: Great (default) / OK / Issues
  - [x] Notes + follow-up fields, stored as interaction on activity timeline
  - [x] Outstanding close-out items warning in modal (amber, non-blocking)
  - [x] Retro data surfaced in Hire History tabs with breakdown stats
- [x] **UX Polish** (15 Apr 2026)
  - [x] Date editor: End Time only shown for single-day hires, Job End Time for multi-day
  - [x] Jobs page: simplified status filter (removed Returned/Completed/Cancelled — they have dedicated pages)
  - [x] Do Not Hire button moved next to Edit/Delete on Person + Org detail pages (was standalone section)
  - [x] Invoice "Mark as Sent" cascades to auto-resolve client follow-up
  - [x] Activity Timeline interaction refresh triggers prep checklist update
- [ ] **Crew & Transport refinements**
  - [x] `is_freelancer` flag + freelancer filtering in crew assignment
  - [x] Tab badge count fix (show quote count on initial load)
  - [x] People page freelancer/approved filter
  - [x] Freelancer document management (DVLA check, licence front/back, passport)
  - [x] Freelancer joined date + next review date fields
  - [ ] Quote editing (currently create-only, no edit mode)
  - [ ] Quote status transition validation (prevent invalid transitions)
  - [ ] RBAC on calculator settings (currently any auth user can change)
- [ ] **Vehicle delivery reminders** — reminder system for upcoming deliveries (depends on vehicle module)
- [x] **HireHop webhooks** — bidirectional real-time sync via webhooks (live 16 Mar 2026)
  - [x] Inbound webhook receiver: `POST /api/webhooks/hirehop` with export_key verification
  - [x] Handles: `job.status.updated`, `job.updated`, `job.created`, `contact.*` events
  - [x] Webhook logging to `webhook_log` table (migration 018)
  - [x] Write-back service: pushes pipeline changes to HireHop with `no_webhook=1` loop prevention
  - [x] External status transition API with API key auth (`api_keys` table)
  - Polling sync still runs as fallback (every 30 min) for catch-up
- [x] **Jobs page improvements** (live 16 Mar 2026)
  - [x] "Happening Today" section split into Going Out / Out Now / Returning sub-sections
  - [x] Return window logic (midday day before through return_date)
  - [x] Time-based filter dropdown (Out Now / Next 2 Weeks / Over 2 Weeks)
  - [x] Prep Checklist prototype tab on Job Detail (dummy data, interactive demo)
- [x] **User profiles & nav redesign** (17 Mar 2026)
  - [x] Migration 023: avatar_url, force_password_change, password_changed_at on users
  - [x] Profile page (`/profile`): edit name, upload avatar photo, change password
  - [x] Nav bar redesign: user avatar + name as dropdown with My Profile / Settings / Sign out
  - [x] Settings link removed from main nav, now in user dropdown (admin/manager only)
  - [x] Admin force-password-reset from Settings page (sets temp password + force_password_change flag)
  - [x] Avatar stored in R2 under `avatars/{userId}/`, displayed in nav bar and user lists
- [ ] **Inbox & Notification System** — see dedicated section below (Step 7)
- [ ] Win/loss analysis dashboard (depends on pipeline — lost_reason basics included in pipeline)
- [ ] ~~Job close-out workflow~~ → See **Step 4b: Returns & Close-Out System** below
- [ ] Xero financial summary integration

#### Step 7: Inbox & Notification System ← IN PROGRESS (Apr 2026)

Unified messaging, notification, and follow-up system. Replaces Monday.com's @mention/update system. The existing interaction/timeline system is the conversation layer; the inbox surfaces conversations and system alerts to the right people.

**Phases A-E shipped Apr 2026 are the inbox foundation. The threaded-messaging upgrade (Phase F) is mostly shipped May 2026 — full thread view in inbox, attachments, paste-to-attach, render polish, actionable notifications. Problems-system integration (issue comments through interactions) is the remaining piece. Spec: `docs/MESSAGING-SPEC.md`.**

**Design principles:**
- @mention in timelines IS the messaging system — conversations happen on entities (jobs, people, orgs)
- Chase pattern for follow-ups: set a date, get reminded, snooze/action/dismiss
- Sender can see read/unread status and nudge recipients
- Escalation respects working hours (staff calendar when built, defaults 08:00-18:00 Mon-Fri until then)
- Users choose their reminder delivery: in-app notification, email, or both

**Navigation:** Inbox link in user avatar dropdown (above "My Profile").

##### Database Changes (migration 045)

```sql
-- Extend notifications table
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_user_id UUID REFERENCES users(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS interaction_id UUID REFERENCES interactions(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT;

-- User notification preferences
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,   -- mention, chase_alert, compliance, follow_up, etc.
  delivery_method VARCHAR(20) DEFAULT 'both'
    CHECK (delivery_method IN ('notification', 'email', 'both', 'none')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);
```

##### Notification Types (extended)

| Type | Source | Default Priority | Default Delivery | Escalates? |
|------|--------|-----------------|------------------|------------|
| `mention` | @mention in interaction | normal | both | Yes (4h) |
| `chase_alert` | Chase date due | normal | notification | Yes (4h) |
| `compliance` | Scheduled check | high | both | Yes (1h) |
| `hire_form` | Mid-tour driver submission | high | both | Yes (1h) |
| `referral` | Driver requires referral | high | both | Yes (1h) |
| `follow_up` | Retro / manual reminder | normal | notification | Yes (4h) |
| `system` | General system alerts | low | notification | No |

##### Escalation Scheduler

Runs every 15 minutes. Checks unread notifications and escalates based on priority:

| Priority | Email after | Notes |
|----------|------------|-------|
| Low | Never | Informational only |
| Normal | 4h (working hours) | Standard escalation |
| High | 1h (working hours) | Faster escalation |
| Urgent | Immediately | Pushes through regardless of working hours |

"Working hours" defaults to 08:00-18:00 Mon-Fri until staff calendar is built.
Respects `user_notification_preferences.delivery_method` — if user has set `notification` only for a type, email escalation is skipped.

##### @Mention Flow

1. User writes interaction on a job/person/org timeline, @mentions colleagues
2. System creates notification per mentionee: `type=mention`, `source_user_id=author`, `interaction_id=the interaction`
3. Mentionee sees it in bell dropdown + inbox page
4. Click → navigates to entity timeline, scrolled to that interaction
5. Reply = new interaction on same entity → original author gets notification
6. Sender can see read status in their "Sent" inbox view, and can "Nudge" unread recipients

##### Follow-Up Reminder Flow (Chase Pattern)

1. User creates follow-up (from retro modal, interaction form, or inbox "Remind me" button)
2. System creates notification: `type=follow_up`, `due_date=chosen date`, `snoozed_until=due_date`
3. Notification hidden from inbox until `snoozed_until` passes
4. On due date: notification appears in inbox + bell
5. User can: action it (acknowledge), snooze again (pick new date), or dismiss
6. Delivery method per user preference (notification, email, or both)

##### Nudge Flow

1. Sender opens "Sent" view in inbox → sees who has/hasn't read their mentions
2. Clicks "Nudge" on unread recipient → updates `nudged_at`, re-surfaces in recipient's bell
3. Nudge is manual only — no auto-nudge

##### Inbox Page (`/inbox`)

**Tabs:**
- **All** — everything unread + recent
- **Mentions** — @mentions from colleagues (type=mention)
- **Follow-ups** — reminders with due dates (type=follow_up), including upcoming ones
- **System** — compliance, chase alerts, hire form alerts

**Features:**
- Filter by read/unread, priority
- Acknowledge button (stronger than "mark read" — records `acknowledged_at`)
- Snooze button on any notification (pick future date)
- Reply to mentions inline (creates interaction on the linked entity)
- "Sent" section: mentions you've sent, with read/unread status per recipient + nudge button
- Notification preferences: per-type delivery method (notification / email / both / none)

**Badge:** Unread count shown on inbox link in user dropdown + bell icon (existing).

##### Implementation Phases

**Phase A — Migration + Backend Foundation** ✅ COMPLETE
- [x] Migration 045: extend notifications, create user_notification_preferences
- [x] Backend endpoints:
  - `GET /api/notifications/inbox` — paginated, filterable, supports tabs
  - `POST /api/notifications/:id/acknowledge` — mark as acknowledged
  - `POST /api/notifications/:id/snooze` — snooze with new due_date
  - `POST /api/notifications/:id/nudge` — sender nudges unread recipient
  - `GET /api/notifications/sent` — notifications created by current user, with read status
  - `POST /api/notifications/follow-up` — create follow-up reminder
  - `GET /api/notifications/preferences` — user's delivery preferences
  - `PUT /api/notifications/preferences` — update preferences
- [x] Extend existing notification creation points to populate new fields (source_user_id, interaction_id, action_url)

**Phase B — Inbox Page + Nav** ✅ COMPLETE
- [x] Inbox page at `/inbox` with All / Mentions / Follow-ups / System tabs
- [x] Inbox link in user avatar dropdown (above "My Profile")
- [x] Unread badge on inbox link
- [x] Acknowledge, snooze, dismiss actions
- [x] Click-through navigation to linked entities (action_url with entity fallback)

**Phase C — @Mention Improvements** ✅ COMPLETE
- [x] @mention autocomplete in interaction forms (type `@` → user picker dropdown) — already built in ActivityTimeline.tsx
- [x] Mention notifications include interaction content preview
- [x] Reply from inbox (creates interaction on linked entity)
- [x] "Sent" view with read receipts + nudge
- [x] Priority selector on @mentions (Normal / Important / Urgent) — controls escalation timing
- [x] Reply marks notification as Done + reply text shown inline on notification card

**Phase D — Escalation Scheduler** ✅ COMPLETE
- [x] Scheduler task (every 15 min): check unread notifications, send email based on priority + working hours
- [x] Respect user_notification_preferences for delivery method
- [x] Default working hours 08:00-18:00 Mon-Fri (configurable when staff calendar built)
- [x] Urgent priority bypasses working hours
- [x] Close-out requirement chase scanner (daily 09:30): scans overdue post-hire requirements, creates notifications, 24h dedup

**Phase E — Retro & Chase Integration** ✅ COMPLETE
- [x] Completion retro "follow up in X" creates follow_up notification with due_date (with date picker + 1m/3m/6m presets)
- [x] Client's upcoming jobs shown in completion modal (blue info box with future bookings)
- [x] Multi-reminder support: add multiple reminders, each with text, date, delivery method, priority, assigned user
- [x] Chase auto-mover creates inbox notifications with snooze support (targets last chase assignee or admins)
- [x] Reminder job requirement type (migration 047): add reminders to prep checklist with date, delivery, event triggers, multi-user assignment
- [x] Event trigger reminders (migration 048): `event_trigger` + `delivery_method` columns on `job_requirements`, fire notifications when job status matches trigger (confirmed/cancelled/lost), triggers fire in both pipeline.ts status changes and cancellations.ts cancellation flow
- [x] Per-reminder delivery enforcement: `delivery_method` (notification/email/both) respected when creating and escalating notifications — notification-only uses low priority (skips email escalation), email-only sends immediately, both uses normal escalation
- [x] Dedicated "+ Reminder" button at top of prep checklist (next to "+ Add Job Requirement")
- [x] Close-out chase scanner respects per-requirement delivery_method

**Phase F — Threaded Messaging Upgrade** ← MOSTLY SHIPPED (May 2026)

Closes the "one-way" gap in the current inbox: rolling conversations with replies, attachments, rich rendering, actionable system notifications, and integration with the Problems register. Full spec lives in `docs/MESSAGING-SPEC.md` — read that before touching code. Headline shape:

- **Threading on interactions** via `parent_interaction_id` (no parallel `conversations` table — extend what's there).
- **Attachments on interactions** via the existing `interactions.files` JSONB (already in migration 001, just needs wiring through the create endpoint and render layer).
- **Actionable notifications** via a new `notifications.actions` JSONB carrying a small whitelist of `kind`s (`mark_chased`, `complete_requirement`, `resend_email`, `snooze`, `mark_handled`).
- **Issue messaging** via `interactions.issue_id` — comments on `job_issues` move from `job_issue_events.comment` to real interactions, gain mentions / attachments / replies / escalation. IssueDetailPage merges typed events + interactions at render time.
- **Markdown-lite rendering** at display time: URL → link, `@user` → pill, `#NNNNN` → job link. Storage stays plain text.
- **Working agreements** (jon, May 2026): notify ALL prior thread participants on a reply (low priority, no email); per-recipient acknowledgement; issue messages do NOT bubble to vehicle / driver / org timelines; staff-only — no freelancer participation; no backfill of historical replies.

**What's shipped:**
- [x] **Phase A (foundation)** — migration 076 (parent_interaction_id, issue_id, actions); `POST /api/interactions` accepts `parent_interaction_id` + `attachments` + flattens to thread root + thread re-notify (low priority); new `GET /api/interactions/:id/thread`; `POST /api/files/upload?attachment_only=true` mode.
- [x] **Phase B (attachments + render polish)** — composer drag/drop + paste-to-attach for clipboard images (any composer surface); inline image thumbnails (authenticated via api.blob), file pills for non-images; URL / `@user` / `#NNNNN` linkification at render time. Shared primitives in `frontend/src/components/messaging/Attachments.tsx` (types + components + `useAttachments()` hook).
- [x] **Phase C (threaded ActivityTimeline)** — replies render nested under root, > 2 collapsed by default, inline Reply composer per thread with @mentions + attachments + paste.
- [x] **Phase D (Inbox thread view)** — `frontend/src/components/messaging/ThreadView.tsx` is the shared full-thread render (used by Inbox now, will be reused by IssueDetailPage in Stage 3). Replaces the old single-line `<input>` reply with a persistent threaded view: fetches `GET /api/interactions/:id/thread`, renders root + replies oldest-first with attachments, persistent reply composer at bottom with @mentions + paste + drop. Triggered by a "View thread" button on any notification with `interaction_id`.
- [x] **Phase E (actionable notifications)** — `POST /api/notifications/:id/action` endpoint with whitelist of internal handlers; first cut ships **3 server-side kinds**: `mark_chased` (logs a chase interaction + bumps next_chase_date with the sacred-future rule), `complete_requirement` (flips `job_requirements` → status=done with audit note), `mark_handled` (optional note → interaction). `snooze` and `resend_email` are deliberately NOT server kinds — `snooze` is a UI affordance handled client-side via the existing modal; `resend_email` deferred until we have a clear template list. Wired into the chase-alert scheduler (`mark_chased`) and the close-out / reminder requirement scanner (`complete_requirement`). Inbox renders the full action list inline with per-button loading state; NotificationBell renders the first action only (compact dropdown — full list is in the inbox).

**Round 2 polish shipped (May 2026, post-launch):**
- [x] **In-page image lightbox** — `<AttachmentImage>` was wrapping thumbnails in a plain `<a target=_blank>` to `/api/files/download`, which 401'd because browsers don't send the JWT on direct navigations. Replaced with an in-page modal using the same blob URL the thumbnail already has. `<AttachmentPill>` (non-image attachments) gained an authenticated `api.blob` fetch on click — PDFs preview in a new tab, other types trigger a real download with the proper filename.
- [x] **Mention emails fire at creation time** — bug: mentions get marked `is_read=true` within seconds when the user glances at the bell, so the 15-min escalator's `WHERE is_read=false` filter then skipped them and no email ever fired. Fix: send the mention email IMMEDIATELY at notification creation when the recipient's pref allows (`email` or `both`), and stamp `email_sent_at = NOW()` so the escalator doesn't double-fire later. Conversations always get the email, regardless of how quickly the bell was cleared. Thread re-notifies stay priority='low' / no email per spec.
- [x] **Lightweight emoji reactions** — migration 077: `reactions JSONB` on `interactions`. Curated 6-emoji palette (👍 ❤️ ✅ 😂 🎉 👀) enforced server-side via Zod. Toggle on/off per user via `POST /api/interactions/:id/reactions { emoji }`. **No notifications fire** — that's the point of the "I saw it, no further action needed" pattern. Shared `<Reactions>` component used in both ActivityTimeline (InteractionRow) and ThreadView.
- [x] **Inbox organisation** — search across title + content (debounced ILIKE), sort dropdown (Priority / Newest / Oldest), acknowledged-hidden by default with "Show done" toggle, "Clear read" button (bulk-acknowledges every read item in the current tab via `POST /api/notifications/bulk-acknowledge`, scope='read' so unread items are never touched).

**Round 3 polish shipped (May 2026):**
- [x] **Real-time inbox via Socket.io** — InboxPage now subscribes to the same `notification` socket channel the bell does. New mentions / chases / system alerts splice into the visible list when on page 1, no active search, and tab matches; tab counts update regardless. Subtleties: avoid double-insert on echo; only splice when conditions match (otherwise the user sees a count bump but the visible list stays predictable).
- [x] **Thread root preview in re-notify cards** — "Pete replied in a thread you're in" used to show only Pete's reply, leaving the user no idea what the thread was *about* without expanding. The inbox query now LEFT JOINs `interactions reply` → `interactions root` (via `parent_interaction_id`) and surfaces `thread_root_preview` + `thread_root_author`. Rendered as a dim italic quote above the reply preview. Skipped when the notification points at the root itself (no quote needed).
- [x] **Date headings on inbox** — "Today / Yesterday / Earlier this week / Earlier this month / Older" sticky-style section labels. Only when sort is `newest` or `oldest` (priority sort interleaves dates so headings would mislead). Bucket calculated from `created_at`, single pass through the array during render.
- [x] **Smarter snooze presets** — "2 hours / Tomorrow morning / Monday morning / 3 days / 1 week / 2 weeks" plus a `<input type="datetime-local">` for "pick exact moment". `nextWorkdayMorningISO()` helper resolves "next 8am" / "next Monday 8am" in local time. The `snooze_until` endpoint already accepted any ISO string — backend unchanged.
- [x] **Group by entity (toggle)** — `Group by job` checkbox in the toolbar. When on, adjacent runs of notifications sharing `entity_type+entity_id` collapse into one card showing "5 notifications on this job [3 unread]" with show/hide. Adjacency-only — sort changes can split a group apart, intentional (avoids reordering surprises). Off by default.
- [x] **Mute thread** — migration 080: `user_muted_threads` table, primary key `(user_id, root_interaction_id)`. New `POST /api/interactions/:id/mute { muted: bool }` walks to the thread root and toggles. The thread re-notify path checks `user_muted_threads` per-recipient and skips muted users. **Direct @mentions still fire** even on muted threads — if someone calls for your attention, you see it. `<ThreadView>` renders a 🔔 Mute / 🔕 Muted toggle next to the Done/Snooze buttons.
- [x] **Undo toast for Done + Clear-read** — 5-second toast at the bottom of the inbox with `[Undo]` button. Single-Done undo via new `POST /api/notifications/:id/unacknowledge` (also reverses the reminder-requirement cascade). Bulk-Clear undo via `POST /api/notifications/bulk-unacknowledge { ids }`. Bulk-acknowledge endpoint now returns the actual `ids` array so the frontend can hand them back. Idempotent — replaying undo on an already-unacknowledged row is safe.
- [x] **Composer textarea resize handle** — `resize-y` + `min-h-[64px]` on the three message composers (top-level + reply on ActivityTimeline, ThreadView reply). Drag the bottom-right corner to expand for long replies.

**Still TODO under Phase F:**
- [ ] **Problems integration** — `POST /api/problems/:id/comments` repointed to write through `interactions` (with `issue_id` set). IssueDetailPage merges typed events + interactions at render time, reusing `<ThreadView>`. Concrete plan:
  1. Migration: no schema changes needed (migration 076 already added `interactions.issue_id`).
  2. **Repoint** `routes/problems.ts:/:id/comments` POST handler: instead of writing a row to `job_issue_events` directly, do `POST /api/interactions` (server-internal call or shared helper) with `{ type: 'note', issue_id, job_id (inherited from issue), content, mentioned_user_ids, attachments }`. Then write a marker row to `job_issue_events` with `event_type='comment'` and `metadata: { interaction_id: <new uuid> }` for audit continuity.
  3. **IssueDetailPage** merges streams: fetches `GET /api/interactions?issue_id=:id` alongside the existing `job_issue_events` query. Render in chronological order — typed events render as terse pill rows (status_change, severity_change), interactions render via `<ThreadView>` for the most recent comment thread + collapsed older ones. The `interactions.ts` GET already exposes `issue_id` as a filter.
  4. **Critical scoping rule (already in place):** `GET /api/interactions` filters `issue_id IS NULL` on person/org/venue/job-without-include_issues reads. Issue chatter does NOT bubble to the linked vehicle / driver / organisation timelines. Verify before shipping that no entity-timeline reads have been added since Phase A without that guard.
  5. **Notifications:** mention notifications already work for issue interactions (entity_type='job_issues', entity_id=issue.id, action_url='/operations/problems/<issue.id>'). No additional wiring needed — the `interactions.ts` POST handler already routes correctly when `issue_id` is set.
  6. **Don't break existing comments:** the `job_issue_events.comment` column stays — historical comments stay readable. New comments live in `interactions`; the IssueDetailPage merge handles both.
- [ ] **`resend_email` action kind** — once a clear set of templates benefit from a one-click resend (hire form, OOH info, payment confirmation, etc.).

Phased plan in `docs/MESSAGING-SPEC.md`. Phase G (email reply ingestion via `reply+<id>@oooshtours.co.uk`) is captured in spec but deferred.

**Round 4 backlog (captured, not shipped):**
- Real-time updates in Inbox for the Sent tab (currently Sent doesn't refresh on socket events — minor).
- Sender-side reply tracking from Sent tab using `<ThreadView>` (currently Sent shows only nudge button, not the thread).
- Keyboard shortcuts (j/k/e/s) — power-user nicety, defer until volume justifies it.
- Per-channel notification preferences (bell-only / email-only toggles instead of the 4-option dropdown).

##### Future Enhancements
- Staff working calendar integration (escalation timing based on actual schedules)
- Group mentions (@warehouse, @office — mention a role/team, not just individuals)
- File attachments in interaction messages (interactions already support files)
- Notification digest email (daily summary instead of per-notification)
- Mobile push notifications (if mobile app/PWA built)
- Tasks system (general-purpose tasks linked to inbox — freelancer application review, annual reviews, admin tasks)

#### Step 8: Warehouse Module — Customer Collections ✅ LIVE (May 2026)

In-person sign-off tool for clients picking up equipment at the warehouse. Replaces the standalone Monday-driven module that previously lived in the Next.js freelancer portal at `ooosh-freelancer-portal.netlify.app/warehouse`. Single OP module now, single auth, single deploy.

**Where:** `staff.oooshtours.co.uk/warehouse` — three kiosk-mode routes mounted **outside** the `<Layout>` wrapper (no nav shell, tablet-friendly):
- `/warehouse` — PIN entry (`WarehousePinPage.tsx`)
- `/warehouse/collections` — list of jobs ready for pickup (`WarehouseCollectionsPage.tsx`)
- `/warehouse/collections/:jobId` — equipment review + signature + complete (`WarehouseCollectionDetailPage.tsx`)

**Auth:** `POST /api/warehouse/auth/pin` validates the kiosk PIN (`WAREHOUSE_PIN` env var) and returns a 12h `warehouse_session` JWT, stored in `sessionStorage` via `services/warehouseSession.ts`. Staff JWTs also accepted on the same routes — desk users can drive it from desktop without re-PINning. Distinct from the staff Zustand store so kiosk and staff sessions don't pollute each other.

**Backend:** `backend/src/routes/warehouse.ts` mounted at `/api/warehouse`. Four endpoints:
- `POST /auth/pin` — public, exchanges PIN for warehouse session JWT
- `GET /collections` — list candidates (PIN or staff JWT)
- `GET /collections/:jobId` — job + equipment list
- `POST /collections/:jobId/complete` — sign-off action

**Candidate filter** (Monday Q&H board → OP `jobs` table):
```
pipeline_status IN ('confirmed', 'prepped', 'prepping')
  AND out_date BETWEEN today-1 AND today+1
  AND HireHop COLLECT = 0
```
The `prepping` (HH 4 / Part Dispatched) inclusion handles the edge case of a job already being part-scanned when the customer signs. The OP↔HH semantic gap (HH jumps to 5 on physical checkout but OP holds at `prepped` until staff explicitly dispatches) is exactly what this list covers — anything in `prepped` with HH at 5 is "ready for sign-off". Customer-collect filter via per-candidate `job_data.php` call (broker-cached, fail-open if HH unreachable).

**On sign-off:**
1. Signature → R2 at `warehouse-collections/{jobId}/signature-{ts}.png`
2. Delivery note PDF (reuses `services/delivery-note-pdf.ts` — same artefact the freelancer portal D&C completion uses) → R2 + appended to `jobs.files` JSONB so it appears on the **Files tab** of the job
3. PDF emailed to recipients via `emailService.send('delivery_note')` (existing template)
4. `pipeline_status` → `dispatched` + HH writeback to status 5 (no-op if already at 5)
5. `interaction` logged on the Activity Timeline (`type='note'`, content `📦 Equipment collected at HH:MM by [name]. Delivery note emailed to [recipients].`)

**Writeback addition:** `PIPELINE_TO_HH` map in `services/hirehop-writeback.ts` gained `dispatched: 5`. Previously absent because HH normally auto-jumps to 5 on physical checkout; the warehouse flow is the origin event, not a mirror, so the push is needed. The "skip if already at target" guard makes this safe for all callers.

**Env vars:**
- `WAREHOUSE_PIN` — required (4-8 digit PIN, set in OP backend `.env`); endpoint returns 503 without it.

**Audit attribution:** PIN-only sessions log interactions as the system service user (UUID `00000000-0000-0000-0000-000000000000` from migration 031). Staff JWT sessions attribute to the actual user.

**Tear-down:** Legacy `src/app/warehouse/*` and `src/app/api/warehouse/*` pages + routes deleted from the Next.js portal. `netlify.toml` has a 301 redirect from `/warehouse[/*]` → `https://staff.oooshtours.co.uk/warehouse` for any latent tablet bookmarks. `MONDAY_API_TOKEN` in the Next.js portal is now warehouse-unused (still used by other freelancer-portal flows pre-repoint).

**Nav:** "Warehouse Collections" link added to Operations submenu (between Backline and Issues). Clicking takes staff to the same kiosk-style page the iPad uses — they're already authenticated via staff JWT so no PIN needed. To return to the OP nav, use browser back.

**Future enhancements (deferred):**
- "Recent collections" / "Customer-collected" filter on Jobs + Returns pages — would surface a `collect_method` column on `jobs` (HH `COLLECT` field synced down: 0=customer, 1=we deliver, 2=courier, 3=other) and add a filter pill + Job Detail header pip. Discussed May 2026, parked in favour of higher-value work.

### External Tools (already built, need repointing from Monday.com → Ooosh API)

These are existing standalone tools that currently push to Monday.com. They need repointing to our status-transition API when ready (Step 5 above):

- **Payment Portal** — Stripe payment processing, currently updates Monday.com. HIGH PRIORITY to repoint (after Steps 1-4).
- **Staging Calculator** — stage/riser quoting tool (standalone, low priority)
- **Backline Matcher** — match client requirements to inventory (standalone, low priority)
- **Cold Lead Finder** — Ticketmaster API integration (standalone, low priority)

### Future Enhancements (captured, not scheduled)

- **Cancellation analytics dashboard (May 2026)** — every cancellation already captures `cancellation_reason`, `cancellation_tier`, `cancellation_notice_days`, `cancellation_fee` + `cancellation_refund` on `jobs`. No more data needed. Build a dashboard widget / `/jobs/lost-cancelled` summary that aggregates: (a) cancelled-job count + £ retained per month, segmented by `cancellation_reason`; (b) lost vs cancelled split (different concepts, see Step 4c spec); (c) average notice period by reason — flags whether "Client cancelled" trends short-notice (revenue-protecting tier work) or long-notice (signals quote-stage friction); (d) £ refunded YTD vs £ retained YTD as a "cancellation P&L" line. Could surface as a tab on the Lost & Cancelled page (`/jobs/lost-cancelled`) above the existing list, with a date range picker. Pie chart of reasons + a small `<Sparkline>` over the last 12 weeks would be enough — no new infrastructure, just a SQL aggregate endpoint and a new widget that follows the dashboard section registry pattern (`frontend/src/components/dashboard/v2/`). Discussed in cancellation-modal-cleanup session, parked because the dataset is still small and the calculator/email work was higher value.

- **Refund processing direct from OP (May 2026)** — currently a cancellation creates a `pending` `job_payments` row and staff process the actual refund in HireHop / out-of-band. End state: a "Process refund" button on the Money tab next to any `pending refund` row in `job_payments` that (a) defaults to the original payment method (lookup via `billing_list.php` if `hirehop_deposit_id` is set on the original deposit), (b) for Stripe-paid deposits triggers the refund through Stripe API + posts the negative deposit application in HireHop in lockstep (mirrors the existing excess reimburse two-step), (c) for bank-transfer / cash / Worldpay records the refund metadata only and leaves the actual money movement to staff. Touches `routes/money.ts` (new `/refund` endpoint), `MoneyTab.tsx` (button + flow), `services/hh-deposit.ts` (already does the two-step for taken deposits — extend for refunds). Companion to the cancellation flow but useful for any pending refund. The cancellation modal's "Refund to client: £X" line could open this modal pre-filled. Discussed and parked May 2026 — "future enhancement, not for right now" per jon.

- **Fill-a-Gap replacement finder** — Phase 1 shipped May 2026. When a job goes to `cancelled` OR `lost`, the banner exposes "Find replacement booking →" linking to `/operations/fill-gap/:jobId`. Page summarises the freed slot (dates, value, resources) and lists scored candidates from `paused` / `new_enquiry` / `quoting` jobs with overlapping dates. Trigger covers both terminal states because a `provisional → lost` is just as much "a slot freed up" as a `confirmed → cancelled` (jon's observation, May 2026); irrelevant lost-from-soft-enquiry cases just hit a zero-candidate page, which is cheap. Backend `GET /api/fill-gap/:jobId/candidates` in `routes/fill-gap.ts` — deterministic SQL match, no AI yet. Scoring components (composite 0-100): bundle match (both have van + backline) +35, vehicle-only +25, backline-only +15, rehearsal match +8, date-overlap up to +30, tour-length up to +15, paused-bucket bonus +8, value bonus up to +10. Hard cap of 25 candidates (sorted by score desc, then job_date asc within tied scores), ordered with a 100-row prefilter. Resource flags come from `deriveFlags()` over the cached `jobs.line_items` JSONB — same engine the requirements derivation uses, so the freed slot's bundle status is "for free". Skip provisional candidates (provisional ≈ confirmed, capacity-needing, not capacity-seeking). Future-facing: candidates with `job_end < today - 1 day` are filtered out at SQL level. **Phase 2 (deferred — needs `ANTHROPIC_API_KEY`):** Claude ranks the top 10 SQL candidates with structured rationale + drafts a re-engagement email per. Use Haiku for ranking + Sonnet for email-drafting on click. Prompt-cache the system prompt + freed-slot context (same context across all candidate calls in one cancellation event). **Phase 3 (deferred):** dashboard widget aggregating freed slots across recent terminal-transitions, weekly "fill rate" stat. **Recovery tracking (nice-to-have, deferred):** add `replaced_cancelled_job_id UUID` on `jobs` so a confirmed booking can be linked back to the freed slot it filled — could auto-set when a candidate's `pipeline_status` flips to `confirmed` within N days of staff sending a re-engagement email, or manual via the fill-a-gap page. Enables "we lost £X this quarter, recovered £Y via fills" analytics on the cancellation analytics dashboard above. Jon's view: "great ideas if we can track it cleanly. Not a biggie if not."

- **Portal Stripe webhook hardening (8 May 2026)** — `handle-stripe-webhook.js` in the payment portal repo (separate Netlify app, not this codebase) silently swallows HireHop transient errors during `Step 1: Creating HireHop deposit` and proceeds to call OP's `/api/money/:jobId/payment-event` regardless. Result: client gets the OP "Payment Received" email, OP records an orphan `job_payments` row with `hirehop_deposit_id=NULL`, but the deposit never lands in HireHop and the Money tab shows the balance as still outstanding (Money tab reads `billing_list.php` live). Surfaced 8 May 2026 by job 15175: HH returned error 327 (rate limit, max 60 req/min × 3/sec — a 5-second prior webhook tipped us over), portal logged `❌ Deposit creation failed: { error: 327 }`, kept marching, claimed `✅ OP payment event recorded` and `✅ Job status updated`. The very next call succeeded — pure transient blip a retry would have caught. **Fix in portal repo:** detect transient HH errors (327, 329, 429, 5xx), retry with exponential backoff (3 attempts at 2s/4s/8s), and on persistent failure return non-200 to Stripe so its built-in webhook retry takes over (Stripe retries for ~3 days at increasing intervals — gives HH plenty of recovery room). Do NOT call OP's payment-event with `hh_deposit_id=null` after a Step 1 failure. **Companion OP-side hardening** (in this repo, when portal is fixed): passive reconciliation pass that polls HH `billing_list.php` for any portal-source `job_payments` row with NULL `hirehop_deposit_id` older than ~10 min, retro-links matched deposits, alerts info@ for unmatched. Closes the loop if the portal's retries themselves fail. The 14 hire-form silent skips found alongside this incident were a separate issue — fixed OP-side in commit `a3c65c8`.

- **Post-hook outbox pattern (7 May 2026)** — proper long-term fix for the fragility of `setImmediate` fire-and-forget blocks across the codebase (~12 of them, mostly post-PATCH side-effects). Today's pattern: route handler responds 200, then queues async work with `setImmediate(...)`. If the DB pool blips, network burps, or — most commonly — the server restarts during a deploy, the in-flight hook is lost silently. The 7 May 2026 RX72TKO incident saw all 5 post-book-out hooks (hire form PDF + email, OOH info email, auto-dispatch, requirement advance, vehicle requirement sync) die simultaneously on a single Postgres connection timeout coinciding with a deploy restart. Short-term mitigation shipped same day: `services/post-hook-recovery.ts` adds `withHookRetry` (3 attempts, 1s/4s/16s exponential backoff) + `alertHookFailure` (bell to admins/managers + email to info@ when retries exhausted). Catches transient blips and surfaces permanent failures within minutes. **Doesn't survive server restarts** — that's what the outbox pattern is for. Sketch:
  - **Storage:** new `pending_hooks` table (`id`, `kind`, `payload JSONB`, `attempts`, `next_run_at`, `last_error`, `completed_at`, `created_at`). One row per pending side-effect.
  - **Write path:** inside the same DB transaction as the route's primary UPDATE, INSERT one row per hook to `pending_hooks`. Survives commit boundary atomically with the state change that triggered it.
  - **Read path:** worker (cron every 30s, plus on-demand kick after the route responds) selects rows with `next_run_at <= NOW() AND completed_at IS NULL`, dispatches by `kind` to the registered handler, marks `completed_at` on success or bumps `attempts` + `next_run_at` on failure. Final-failure threshold (e.g. 5 attempts) fires the same `alertHookFailure` flow, then leaves the row in place for manual retrigger.
  - **Observability:** `/operations/pending-hooks` admin page lists in-flight + failed rows, with re-run / dismiss actions.
  - **Migration path:** keep `runHookWithRecovery` working in parallel; convert hooks to outbox-style one at a time. Start with the 5 post-book-out hooks (highest blast radius), then sweep `setImmediate` callsites in the rest of the codebase.
  - Pairs naturally with future patterns where reliable post-action work is needed (post-checkin emails, scheduled-job nudges, etc.). New `setImmediate` blocks become `enqueueHook(kind, payload)` one-liners.

- **Server-startup hook recovery sweep (7 May 2026)** — belt-and-braces alternative to the full outbox above, specifically targeting the deploy-killed-in-flight case (which is probably the most common real-world trigger). On process boot, scan for assignments that look like they had post-book-out hooks die mid-flight: `status='booked_out' AND vehicle_id IS NOT NULL AND booked_out_at > NOW() - INTERVAL '24 hours' AND (hire_form_emailed_at IS NULL OR (return_overnight = TRUE AND ooh_info_sent_at IS NULL) OR pipeline_status NOT IN ('dispatched','returned_incomplete','returned','completed'))`. Re-fire whichever hook is still missing. Cheap because the existing hooks are already idempotent (so a re-fire on a healthy job is a no-op). Probably 1 hour of work; useful even after the outbox lands as a final safety net for the very-edge case where a hook fails on its 3rd retry attempt during shutdown. Not urgent given the retry + alert combo we just shipped.

- **Dashboard polish (5 May 2026)** — small follow-ups from the Today dashboard redesign session, captured but not scheduled:
  - **Drag-to-reorder UI for sections.** Section registry already has `pinnable: true/false` per section, and `useSectionOrder()` reads/writes a localStorage array of section IDs. UI to actually let users drag sections around isn't built. When/if added, just bind it to `useSectionOrder().setOrder(newIds)`. `needs` is hard-pinned first regardless of order.
  - **Server-side persistence of section ordering.** Currently localStorage only — preference doesn't follow the user across browsers/devices. Add `dashboard_section_order TEXT[]` on `users`, then swap `useSectionOrder` to GET/PUT through `/api/users/me/preferences` with localStorage as fast-path fallback.
  - **Sparklines on additional stat cards.** Only "On Hire" has a 14-day trend line (`stat_cards.on_hire_spark`). The same SQL pattern (CTE generating 14 days × LEFT JOIN counting jobs overlapping each day) would extend cleanly to "Going out today" / "Coming back" / "Open enquiries". `<StatCard>` already accepts a `sparkline?: number[]` prop, so it's purely a backend addition.
  - **Stat row column-wrap cosmetic.** At the 6-col → 3-col → 2-col breakpoints, longer labels ("Going out today", "Open enquiries") can wrap to 2 lines while shorter ones stay single-line, making row heights inconsistent for a moment. Either give cards a `min-height`, or shorten labels at narrow widths via media queries. Cosmetic, low priority.
  - **Role view (Warehouse / Ops / Sales / Everything).** Brief §2 specced a role dropdown that re-orders sections by role priority. Deferred during the redesign — single-view-for-everyone is fine at current team size. To revisit when the team grows or operational roles diverge enough to warrant it. Default order in the registry already reflects an "Everything" view; per-role default orders would live alongside `defaultOrder` in `SECTIONS`.
  - **"Banner" overdue variant.** Brief §4 included an alternative "Banner" layout for the overdue strip as a stress-test option (full-width red banner with bullet list rather than 4-up cards). We shipped the Cards layout per brief. Banner variant never made it into the codebase. Easy to add as a per-section render-mode toggle if a future module wants the louder treatment.

- **HH ↔ OP excess refund-leg passive reconciliation (5 May 2026)** — Migration 039 added passive matching of HH excess deposits → OP `job_excess.hh_deposit_id` so taken-side records auto-link without staff action. The **refund leg is not passively reconciled the same way**: if someone refunds an excess directly in HireHop (rather than via OP's "Reimburse" flow), HH knows it's gone but OP still shows the record as `taken`, and any subsequent OP-side reimburse push will fail with HH error 370 (because the deposit is already fully refunded in HH). Surfaced 5 May 2026 by Pom Poko (HH job 12803, refunded 31/03/2025 in HH, still showing as Taken in OP). Workaround: staff click "Unlink HireHop deposit" on the excess record, then run OP-only Reimburse (no HH push). Proper fix: add a passive reconciliation pass that scans HH billing for refund payments matching linked deposits and flips OP records to `reimbursed` automatically. Affects a small number of historical records — not urgent.

- **Pre-auth expiry NeedsAttention bucket (5 May 2026)** — The Step 3 Phase E "Stripe pre-auth expiry scheduler" TODO will fire notifications when a `job_excess` record sits in `pre_auth` past Ooosh's 4-day re-take policy. When that scheduler ships, it should ALSO populate a new bucket on the dashboard's NeedsAttention secondary row (purple accent suggested). Registry + bucket pattern is ready: extend `/api/dashboard/operations` `needs_attention` with `pre_auth_expiring` count + items, add a `NABucket` definition in `NeedsAttention.tsx`, no other plumbing needed.

- **Post-hire pill rethink + central "Problems" register (5 May 2026)** — the Today block's per-job progress strip currently shows the same pill set across both phases (Backline · Hire Form · Excess · Vehicle pre-hire; De-prep · Client · Excess · Freelancer · Invoicing · Payment · Vehicle post-hire). The post-hire pills are of limited operational value: as soon as staff starts checking the hire in, the job drops off the "Returning Today" pile, so most of those pills never have time to shift to a useful state. More useful would be an at-a-glance summary of any **on-the-road problems** aggregated across the vehicle / backline / transport modules — but there's no central "problems" register today. Each module has its own ad-hoc problem-tracking (vehicle has_damage flag, backline has manual notes, transport has internal_notes / freelancer_notes etc.) but nothing unified. New module-shaped piece: needs a design pass for what "problem" means cross-module, where it gets logged from, and how it surfaces (Today block, Job Detail header alert, dashboard widget, notifications). Until that lands, the post-hire pill strip stays as-is.

- **Job Issues / Problems register — Stage 2 control panel (May 2026)** — Stage 1 (Apr 2026) lived on `job_requirements` with `requirement_type='issue'`. Stage 2 (May 2026, migration 075) **promoted storage to a dedicated `job_issues` table** with proper FK anchors and a structured event timeline. The public API stayed at `/api/problems/*` so callers didn't notice the storage swap. Migration auto-translated existing Stage 1 rows into the new table (preserving UUIDs), then soft-cancelled the originals.

  **Storage shape (migration 075):**
  - `job_issues` — anchors (`job_id` mandatory + optional `vehicle_id`, `driver_id`, `person_id`, `client_organisation_id`, `hh_stock_item_id`, `hh_stock_item_name`, `barcode`), classification (`category`, `source_module`, `severity`), lifecycle (`status`, `resolution_path`), accountability (`reported_by`, `assigned_to`, `watchers UUID[]`), timing (`due_date`, `surface_on`), money (`estimated_cost`, `actual_cost`, `excess_id` — informational, no HH/Xero double-write), `resolved_at` clock auto-managed by route handler.
  - `job_issue_events` — typed audit trail (`event_type`: created / comment / status_change / assignment / severity_change / due_date_change / cost_estimate / resolved / reopened / mention / file_added / etc.), plus `body` text and `metadata JSONB`. Drives the issue detail page timeline and unlocks future reporting (avg time-to-resolve by category, by vehicle).
  - `job_issue_files` — attachments per issue (R2 keys, file_type, comment). Backend endpoints not yet wired in Stage 2 — Stage 3 work.

  **Categories:** `damaged | missing | broken | dispute | breakdown | other` (added `breakdown` over Stage 1). **Severity:** `low | normal | urgent`. **Status:** `open | investigating | awaiting_quote | quoted | actioned | resolved | written_off | cancelled`. **Resolution paths:** `claim_excess | charge_client | write_off | replaced | other`. **`surface_on` rules** (column reserved, behaviour wired in Stage 3): `vehicle_check_in | next_hire | next_book_out | job_close_out`.

  **API endpoints under `/api/problems/`:** `GET /` (filtered list with status/category/severity/source/search/assigned_to + pagination), `GET /:id` (issue + events + files), `POST /` (create), `PATCH /:id` (update — every field change emits a typed event), `POST /:id/comments`, `POST /:id/watch` + `/unwatch`, `GET /summary` (dashboard bucket + counts by category/severity), `GET /picker/:jobId` (returns vehicles + drivers + people + line_items + client org for the smart-picker UI), `GET /by-vehicle/:id`, `GET /by-organisation/:id`, `GET /by-person/:id`. RBAC: any STAFF_ROLES user can create / progress / close (event log records who did what).

  **Smart picker on Job Detail panel** (`JobProblemsPanel.tsx`): "What's it about?" toggle (Vehicle / Equipment / Driver / Person / Client / Job-itself) populates per-kind dropdowns from the actual job context. Vehicles come from `vehicle_hire_assignments`, equipment from `jobs.line_items` (HH-derived, kind:2 only — prompts/headers/virtuals filtered), drivers from `vehicle_hire_assignments`, people from `job_organisations` × `person_organisation_roles`. Removes typing-the-reg friction. **Barcode input** is a free-text field for now — staff types it from the actual checked-out item. Stage 4 work: pull live barcode-to-stock-item mapping from HH check-out endpoint so the field auto-populates from a scan-at-fault flow.

  **Issue Detail page** (`/operations/problems/:id`, `IssueDetailPage.tsx`): full control panel — header with subject chips (clickable: Job / Vehicle / Driver / Person / Org), event timeline (created → status changes → comments), inline comment box, sidebar with status / severity / assignee / due date / surface_on / resolution_path / cost (with amber "Cost is informational only" note as agreed), watchers count, "Mark as resolved" / "Reopen" buttons.

  **Stage 3 (May 2026) — SHIPPED via PR #508 + follow-up:**
  - [x] Migration 081: `job_id` nullable, new `component_key` column, partial index for dedup, CHECK constraint requiring at least one anchor (job_id OR vehicle_id).
  - [x] Phase F — comments on issues write to `interactions` (with `issue_id` set), render via `<ThreadView>` on IssueDetailPage. Critical scoping in place: `WHERE issue_id IS NULL` on vehicle/driver/org/people timeline reads via `ActivityTimeline` so issue chatter doesn't bubble. `POST /api/problems/:id/comments` legacy route untouched as a stable surface; no current callers.
  - [x] Issue-level file attachments via `job_issue_files`. `POST/DELETE /api/problems/:id/files` endpoints + `IssueFilesCard` on IssueDetailPage. Distinct from interaction attachments — these are documents/photos attached to the issue itself (contractor quote PDFs, insurer letters) rather than to a specific message thread.
  - [x] Auto-create dedup helper via `POST /api/problems/auto-create`. Matches on `(vehicle_id, component_key, status NOT IN terminal)`; appends `reflagged` event to existing row or inserts fresh. PrepPage + CheckInPage + NewIssuePage all route through it. `mapPrepItemToComponentKey` / `mapPrepItemToOpCategory` / `mapSeverityToOpSeverity` helpers in `frontend/src/modules/vehicles/lib/op-issue-mapping.ts`.
  - [x] VehicleDetailPage Issues section + vehicle-module HomePage open-issues widget both on OP data. Legacy `useVehicleIssues` / `useAllIssues` hooks no longer referenced; legacy `/vehicles/issues` + `/vehicles/issues/:reg/:id` routes redirect to `/operations/problems`. VehicleIssuesBanner (used at top of PrepPage) repointed to OP, takes `vehicleId` (UUID) not `vehicleReg`.
  - [x] Organisation Detail Issues tab. Reusable `frontend/src/components/IssuesListSection.tsx` — same shape works for organisation, person, vehicle reads against the existing `/by-{type}/:id` backend endpoints. PersonDetail Issues tab is a two-line mount when needed.
  - [x] R2 → job_issues one-shot import script (`backend/src/scripts/import-r2-issues-to-op.ts`). Dry-run by default, `--commit` to apply, `--reset --commit` for idempotent re-runs (wipes any `metadata.imported_from_r2 = true`-tagged rows first via CASCADE on events/files). `--vehicle REG` filter for incremental import. **Important:** without `--reset` the script is not idempotent across invocations — re-running creates duplicates. Header comment documents the diagnostic SQL that catches this.
  - [x] Severity → notification priority mapping. `urgent`/`normal`/`low` → `urgent`/`normal`/`low` priority. Notifications fire on creation, reflag, status change, severity change, assignment. Recipients = watchers + assignee, optionally + reporter. Best-effort: failure to fire doesn't roll back the issue write.
  - [x] `<MentionComposer>` shared primitive (`frontend/src/components/messaging/MentionComposer.tsx`). Wraps textarea + @-mention picker + paste/drop-to-attach + pending-attachment strip. Used on IssueDetailPage top-level composer. ThreadView reply composer + two ActivityTimeline composers still have inline copies — pure-cleanup migration deferred to a separate PR (functional behaviour unchanged, just dedup).
  - [x] Migration 082 — `vehicle_issue_default_watchers` row in `system_settings`. JSON array of user UUIDs; auto-create + manual create both seed `watchers[]` from this list. `notifyIssueRecipients` also merges defaults at notify time as a safety net for pre-migration-082 rows. Settings UI: `VehicleIssueSettingsSection` on SettingsPage.
  - [x] `surface_on` picker exposed on NewIssuePage manual create (JobProblemsPanel already had it). Banner component `VehicleIssuesSurfaceBanner` reads filtered open issues for a vehicle + given surface_on context. Wired into CheckInPage above step content (`surface_on='vehicle_check_in'`). Amber by default, flips RED if any surfaced issue has `severity='urgent'`.

  **Stage 3 follow-ups (deferred to follow-up PRs):**
  - Migrate ThreadView reply composer + both ActivityTimeline composers to use `<MentionComposer>`. Pure cleanup — functional behaviour unchanged — but blast radius across every detail page warrants a separate isolated PR.
  - Mount `VehicleIssuesSurfaceBanner` on AllocationsPage row (`surface_on='next_hire'`), BookOutPage (`surface_on='next_book_out'`), job close-out modal (`surface_on='job_close_out'`). Component is ready; just needs the three other surface points wired.
  - PersonDetail Issues tab mount via `IssuesListSection` (endpoint `/by-person/:id` already exists).

  **Stage 4 (later):**
  - Barcode auto-pull from HireHop check-out data (needs HH endpoint research — `items_to_supply_list.php` returns line items not barcodes).
  - Auto-create from backline missing-items at de-prep.
  - Auto-create from transport on-road flags.
  - **Legacy code sweep.** Remove `useVehicleIssues`, `useAllIssues`, `IssueCard`, vehicle-module `ActivityTimeline` (the one under `modules/vehicles/components/issues/`), `AddActivityForm`, `IssueDocuments`, `issues-r2-api`, plus the four legacy `/api/vehicles/get-all-issues|get-vehicle-issues|get-issue|save-issue` endpoints. Pure cleanup after a quiet period verifies nothing surprising surfaces.
  - Cross-vehicle / cross-stock-item recurrence reporting ("RX22SXL had 3 clutch issues in 6 months").
  - **Returns & Completed close-out gate.** When a returned job has open issues, it can't auto-complete. Stage 2 doesn't enforce this — completion modal could be extended to warn ("1 open issue, complete anyway?"). Stage 4 promotes to a hard block. Existing close-out warning pattern fits.

- **Data-aware suggested-next-status hint (5 May 2026)** — the bold + asterisk on the suggested next status in the Job Detail status dropdown is currently pure date-based: `confirmed`/`prepped` + on-or-past `out_date` → bold `dispatched`, etc. Could be smarter:
  - Bold `prepped` (rather than skipping straight to `dispatched`) only when the prep checklist is complete — i.e. all pre-hire `job_requirements` are `done`.
  - Bold `completed` only when all post-hire close-out items are done (the existing completion modal already warns about outstanding items, but the dropdown itself doesn't reflect close-out state).
  Needs the requirements list lifted out of the JobRequirementsSection child component to JobDetailPage level, OR a small dedicated summary endpoint. Low priority — current behaviour isn't wrong, just not as smart as it could be. The page-level `loadRequirementsSummary()` added for header alerts could be extended to feed this too.

- **More job-header banner patterns (5 May 2026)** — `JobAlertBanner` shell on Job Detail is intentionally reusable: any "date threshold + data condition = banner" alert can drop in. Currently fires for: overdue dispatch, overdue return, hire form missing, crew unassigned, crew not introduced, close-out overdue. Candidates for future:
  - Carnet outstanding close to international job start
  - Sub-hire ordered but not received with hire approaching
  - Pre-auth excess about to expire (Stripe ~7d auto-void; Ooosh policy re-take inside 4d) — listed elsewhere as "Stripe pre-auth expiry scheduler" but the same data could surface as a banner.
  - On-road issue logged on the job (depends on the central "Problems" register above).
  Easy one-at-a-time additions when concrete needs come up.

- **HH job sync overwrites OP date columns but ignores OP time columns (29 Apr 2026)** — `hirehop-job-sync.ts:354` writes `OUT_DATE`/`JOB_DATE`/`JOB_END`/`RETURN_DATE` from HH directly into OP's TIMESTAMPTZ date columns, but does NOT touch the separate `out_time`/`return_time`/`end_time` TIME columns. So if you set `out_time=15:30` in OP and HH stored 09:00, after the next 30-min sync the date column has 09:00 baked in but `out_time` still says 15:30 — drift. Not blocking the duration-sync fix, but worth tidying. Two options: (a) parse the time portion out of HH's response and write it into the matching `*_time` column, or (b) stop sync touching the time portion of date columns (preserve OP's time; only update the date part). (b) is cleaner — OP becomes the source of truth for times once a job is created from OP. Pre-existing behaviour, flagged during the duration-fix investigation.

- **Non-SDH book-out — Van & Driver shipped May 2026 (Phase 1A); D&C / delivery / collection still TODO.** V&D flow (Ooosh supplies van AND a freelancer driver to the customer) is now live (PR #460). BookOutPage takes `?mode=van_and_driver` (Job Detail purple "🚐 Soft Book Out (V&D)" button) OR auto-detects from slot mode when entering via `?vehicle=X&job=Y` (Allocations page Book Out button) — every entry point Does The Right Thing™ without each one having to compose the URL. Step 2 swaps the customer hire-form picker for a freelancer picker reading the job's `quote_assignments` (no `is_ooosh_crew` filter — the standard "+ Assign" picker on a Crewed quote doesn't set that flag, so requiring it was hiding crew staff had clearly assigned; the flag still drives calculator billing semantics, just not picker visibility). Reuses the existing Vehicle Condition Report PDF + email exactly — sent to the freelancer instead of a customer. At submit, promotes the assignment row to `assignment_type='driven'` + `freelancer_person_id` via the existing `POST /api/assignments/:id/book-out` endpoint (extended with optional V&D fields — backwards-compat with self-drive callers). Skips the hire-form write-back + VE103B tracks (neither apply for V&D). The Job Detail card detection uses `assignment.assignment_type === 'driven'` OR matching `vehicle_slots[].mode === 'van_and_driver'` OR (job-level fallback) any slot is V&D and assignment is still self_drive — covers existing pre-V&D allocations that were created before the promotion path existed. `loadVehicleAssignments` filter widened to surface staff-allocation rows on V&D slots — they used to be filtered out as "plumbing" because in self-drive mode the customer hire form creates the visible card, but for V&D no hire form ever lands so the staff-allocation row IS the hire. `/api/hirehop/jobs/:jobId/derived-flags` widened to accept HH job number alongside OP UUID (staff allocations only carry `hirehop_job_id`; `job_id` stays NULL until a hire form is submitted, which never happens for V&D). New `GET /api/quotes/job/:jobId/ooosh-crew` returns DISTINCT crew on the job's quotes for the picker. **No DB migration needed** — `assignment_type='driven'` and `freelancer_person_id` already existed on `vehicle_hire_assignments` (migration 017). **D&C / delivery / collection still uses Crew & Transport ops flow** — the BookOutPage mode switch is positioned to extend to those when needed (the `assignment_type` enum values `delivery` and `collection` are already in the schema). **Phase 2 (freelancer-led V&D handover from the portal)** maps cleanly onto the existing freelancer-bookout JWT flow with this mode switch in place — should be a small follow-up.

- **Book-out photo upload reliability for low-signal areas.** First IRL V&D book-out (job 15738, May 2026) reported "9 uploaded, 5 failed" on photo upload while the PDF correctly embedded all 14 photos — the PDF embed and R2 audit upload are two separate pipelines (PDF uses locally-resized base64s and always works; R2 upload depends on network). Net effect: PDF Alex received was a complete legal record, but the R2 audit trail is missing 5 photos and the "View full size" links in the PDF point at 404s for those 5. Most likely cause: 4/5G signal at a warehouse handover. Captured as a future hardening pass — possible levers: serialise uploads instead of parallelising (slower but more resilient on poor signal), add a "retry failed uploads" button on the success screen so staff can re-attempt without redoing the whole walkaround, pre-upload size warning if photos are particularly large, or treat R2 upload as fully background/queueable so it can complete after the user has left the page. Not pressing — happens rarely, doesn't compromise the PDF, and the workaround "leave it, the PDF is the legal record" is acceptable. Touches `frontend/src/modules/vehicles/lib/photo-upload.ts` (`uploadAllPhotos`) and the `pdfData` r2Url construction in `BookOutPage.tsx`.

- **Non-SDH book-out — D&C / delivery / collection mode (Phase 1B).** V&D shipped May 2026 (see entry above); the same pattern can extend to delivery / collection / D&C book-outs (freelancer collects van from base → delivers to customer site, or the reverse on collection). The schema already supports `assignment_type` values of `delivery` and `collection`, and the BookOutPage mode switch is positioned to add these — the picker would still pull from the job's crew assignments, the PDF + email flow stays the same, and the only new wiring is the assignment_type promotion at submit time. Trigger from Crew & Transport ops cards / Allocations page when slot is non-self-drive non-V&D. Defer until V&D is proven in live use across more hires.

- **Mid-hire breakdown swap UI (27 Apr 2026, now spec'd May 2026)** — `POST /api/assignments/:id/swap-vehicle` endpoint already exists (creates a new assignment for the replacement van, marks the original as `swapped`, copies excess across). The UI + supporting flow is now fully spec'd in `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md`. PR 1 (soft check-in primitive, orphan dedup at book-out, sweeper script) shipped May 2026; PR 2 (the swap modal + Job Issues link + redirect to BookOutPage + VE103B regen) is the next build. See Step 2 Phase D3 above for the current checklist. The `match-job-dates` and book-out in-flight swap shipped 27 Apr handle the simpler cases (date drift, last-minute van issue before book-out).

- **Driver document validity expansion (27 Apr 2026)** — the assign-driver picker on Job Detail computes a green/amber/red traffic light from `licence_valid_to`, `dvla_valid_until`, `poa1_valid_until`, `poa2_valid_until`, plus `requires_referral`/`referral_status`. Backend gate at `POST /api/hire-forms/quick-assign` mirrors the same rules. Future additions: passport expiry for international hires (driver flag), insurance company carve-outs (some clients have alternate excess rules that survive longer than DVLA cycles). Currently passport / international flag isn't part of the gate.

- **Allocation turnaround buffer (24 Apr 2026)** — overlap detection currently uses `jobs.job_end` (Job Finish) as the hire-end date, matching the "real" end-of-charge. Ooosh in practice reserves a 1-day turnaround buffer by artificially inflating `return_date` to `job_end + 1`. Today's overlap rule is "can the same van do two hires with same-day turnaround?" — NO, because same-day counts as overlap. That's fine for same-day, but doesn't model the real prep-day the warehouse needs. Future: add a `allocation_turnaround_buffer_days` setting to `calculator_settings` (default 0, Ooosh sets to 1), and change the overlap predicate to `existing.hire_end + buffer_days >= new.hire_start`. Applies in `backend/src/services/assignment-overlap.ts` (`findOverlappingAssignments` query) and `backend/src/routes/assignments.ts` (`/availability` endpoint). Defer until the base overlap model is proven in live use.
- **Overlap query LEFT JOIN — dual match on hh_job_number (May 2026)** — both `assignment-overlap.ts` and the `/availability` endpoint LEFT JOIN to `jobs` via `(vha.job_id IS NOT NULL AND j.id = vha.job_id) OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)`. Without the second clause, V&D staff-allocation rows (which carry only `hirehop_job_id` because no hire form ever submits) drop out of overlap checks entirely — `j.job_date` / `j.job_end` come back NULL, the COALESCE returns NULL, the date predicate filters the row, and the van shows as Available for any other job. Live bug surfaced 9 May 2026: RX22SWU allocated to V&D job 15552 (11–16 May) was offered as Available on 14 May for job 15422. Any future overlap-style query joining `vehicle_hire_assignments` to `jobs` MUST use the dual match — same applies to AllocationsPage's lookahead-related queries if/when they go via SQL.
- **Client email safety net (22-23 Apr 2026)** — five-layer defence against silent email skips when OP can't reach a client contact. Built incrementally over 22-23 Apr after portal payments on HH-synced sole-trader jobs were silently skipping confirmation emails:
  1. **`resolveClientEmailTarget(jobId)` helper** in `backend/src/services/money-emails.ts` — wraps `getJobEmailRecipients` with an info@oooshtours.co.uk fallback when nothing's reachable. Always returns a recipient + `isFallback` flag.
  2. **Three-level recipient lookup** in `getJobEmailRecipients`: (a) people linked via `person_organisation_roles` to client_id / job_organisations; (b) the client org's own email column; (c) `jobs.client_name` string exact-matched against `people.first_name + last_name` (covers HH "CLIENT set, COMPANY blank" sole-trader pattern where no client_id exists, e.g. job 15617 Danny Stevens).
  3. **Amber `prependBanner` injected** into fallback emails reading "No client email on file" with the client name, job ref, and a link back to the Job Detail page so info@ recipients can forward + update the address book.
  4. **Activity Timeline `email`-type interaction** logged via `logFallbackToTimeline` whenever a fallback fires — gives a per-job audit trail visible on the Activity Timeline tab.
  5. **`has_client_email` boolean** computed on `GET /api/hirehop/jobs/:id` (mirrors the recipient lookup exactly), surfaces an amber warning banner on the Job Detail header BEFORE payments arrive.

  **Wired into all known client-facing senders:** `sendPaymentEmail` + `sendExcessEmail` (money-emails.ts), `job_cancelled_client` (cancellations.ts), `vehicle_checked_in` (vehicle-emails.ts), hire form auto-emails (hire-form-auto-email.ts), portal `delivery_note` + `collection_confirmation` (portal.ts completion flow). Internal/staff/freelancer-routed emails (referral_alert, mid_tour_driver, freelancer_assignment, etc.) deliberately untouched — info@ fallback isn't appropriate for those.

  **Plus structural fix for the duplicate-org pattern:** HH job sync (`hirehop-job-sync.ts`) now name-matches new shell client orgs against active People and auto-links unambiguous matches via `person_organisation_roles` (role='Main Contact'). Multi-candidate matches go to `sync_review_queue` with `review_type='person_link_ambiguous'`. Same logic applied in reverse on contact sync (`hirehop-sync.ts`) — `name_conflict` now auto-links shell orgs instead of just flagging. Backfill script `backend/src/scripts/backfill-shell-org-person-links.ts` covers historical data (dry-run by default, `--commit` to apply).

- **Job-level people + role junction (`job_person_roles`) for role-based email routing — per SPEC.md §2.3 and §3.4** (flagged 22 Apr 2026, partially addressed May 2026). The safety net + the May 2026 `job_contacts` model (rounds 1-6, see "Per-job contacts" under Shared Utilities) are stepping stones — they keep comms working and let staff manage per-hire contacts, but it's a SINGLE-LIST model with one primary. The real SPEC vision is role-keyed: per-job roles (Enquirer, Authoriser, Payer, Site Contact, Driver, Booker) routing automated emails to the right role (`payment_received → Payer`, `delivery_confirmed → Site Contact`, etc.). Current state (post-round-6): every job CAN have its contact list managed, and primary lands as `to` for all client emails — but it's one bucket for everyone. Proper build needs: either (a) extend `job_contacts` with a per-row `role` enum, or (b) build a separate `job_person_roles` table (`job_id, person_id, role, is_primary, notes, start_date, end_date`); population path from HH sync (default `CLIENT` contact → Enquirer/Main Contact role) + New Enquiry form + hire form submission; role-keyed recipient helpers per template (replace `getJobEmailRecipients` with `getRoleRecipient(jobId, 'payer')` + fallback chain); Job Detail UI to add/edit roles per job. Open design question: extend `job_contacts` (smaller migration, reuses existing UI + endpoints) vs. fresh table (cleaner if roles need start/end dates per booking phase). Issue logged in platform tracker: search "job-level people" in /operations/issues.
- ~~**Vehicle condition report PDF failure (C3, 22 Apr 2026)**~~ — **RESOLVED 22 Apr 2026** (initially with a pdf-lib Roboto port, then **superseded 23 Apr 2026** by restoring the original jsPDF template). Root cause of the crash was `drawText` drawing `✓` (U+2713) with `StandardFonts.Helvetica` (WinAnsi), which throws `WinAnsi cannot encode "✓" (0x2713)`. The first fix ported the logic to pdf-lib with Roboto via fontkit and looked functional but plain, losing the navy-branded header + clickable photo links from the original standalone Vehicle Module template. Second fix ported the original `netlify/functions/generate-pdf.mts` from the pre-integration VM codebase verbatim into `buildConditionReportPdf` — it uses **jsPDF** (not pdf-lib) because jsPDF provides `textWithLink()` for hyperlink annotations and renders bullets as filled rounded rectangles instead of Unicode ticks, sidestepping the WinAnsi issue entirely. Logo loads from the existing R2 asset via `fetchLogo()` converted to a data URI at runtime (cached in-module), so no hardcoded `LOGO_BASE64` string. StandardFonts fallback removed from `hire-form-pdf.ts` as well — missing Roboto now throws instead of silently degrading. Also added `POST /api/vehicles/events/:eventId/regenerate-pdf` for mis-fire backfills + damage-dispute re-sends, surfaced in the Event History section of VehicleDetailPage. `save-event` persists signature base64 as a separate R2 png (`vehicle-events/{REG}/{id}_signature.png`) and `briefingItems` on the event JSON so regenerations have full fidelity.
- ~~**Photo clickability — photos in private bucket (23 Apr 2026)**~~ — **RESOLVED 23 Apr 2026.** `backend/src/config/r2.ts` now exports `uploadToPublicR2` / `getFromPublicR2` / `listPublicR2Objects` targeting `R2_PUBLIC_BUCKET_NAME` (`ooosh-vehicle-photos`). In `vehicles.ts`: `/upload-photo` branches on the `events/` prefix and writes condition photos to the public bucket (everything else stays private); `/list-photos`, `/photo/*`, and `/events/:id/regenerate-pdf` all read from the public bucket for `events/` keys. Signatures + event JSON stay in the private bucket (embedded in the PDF, not linked from it). Env vars required: backend needs `R2_PUBLIC_URL=https://pub-<hash>.r2.dev` + `R2_PUBLIC_BUCKET_NAME=ooosh-vehicle-photos`; frontend needs `VITE_R2_PUBLIC_URL=https://pub-<hash>.r2.dev` (live book-outs pre-build the `r2Url` client-side, so Vite needs the value baked in at `npm run build`). Historical book-outs before this fix have photos stranded in `ooosh-operations` — accept as lost (one-off, only Desmond's RX24SZC 22 Apr hire was affected). **Future hardening** (non-urgent): the `pub-<hash>.r2.dev` dev URL is rate-limited and bypasses Cloudflare caching. At Ooosh's current volume (handful of PDFs/week × handful of clicks each) this doesn't matter. If traffic ever grows, connect a custom domain (e.g. `photos.oooshtours.co.uk`) to the bucket via Cloudflare dashboard and swap the env var values — no code change required.
- ~~**Allocations booked-out UX (22 Apr 2026)**~~ — **PARTIALLY RESOLVED 24 Apr 2026.** AllocationsPage now hides "Book Out" on `booked_out`/`active` cards and shows a "Booked Out" / "On Hire" pill in its place (`AllocationsPage.tsx:721-733`). Still missing: an explicit "Mark as Returned" action directly on booked-out cards (currently staff action check-in from the CheckInPage). Tracked alongside the van-centric rebuild — worth bundling into that pass.
- **Check-in didn't flip assignment status for stuck historical data (22 Apr 2026 fix deployed but stuck rows remain)** — eventType mismatch bug (`'Check In'` vs `'check-in'`) meant the save-event check-in side effects never ran between ~20 Apr and 22 Apr. Any assignments that went through book-out → check-in during that window are stuck at `status='booked_out'` in the DB, causing Allocations to still show them as allocated. **SQL remediation** (safe — preserves audit):
  ```sql
  UPDATE vehicle_hire_assignments
  SET status = 'returned',
      checked_in_at = COALESCE(checked_in_at, NOW()),
      status_changed_at = NOW(),
      updated_at = NOW()
  WHERE hirehop_job_id = 15746        -- replace with affected HH job number
    AND vehicle_id IS NOT NULL
    AND status = 'booked_out';
  ```
  Run against `sudo -u postgres psql -d ooosh_operations`. Confirm which HH jobs are affected first — cross-reference fleet_vehicles.hire_status='Prep Needed' against booked_out assignments. For future check-ins, the fix at `vehicles.ts:1562` matches eventType case-insensitively and widens the status match to `('booked_out', 'active')`.
- **Express `trust proxy` setting** — backend logs show `ValidationError: The 'X-Forwarded-For' header is set but the Express 'trust proxy' setting is false` from `express-rate-limit`. Because we sit behind nginx, every request looks like it's from `127.0.0.1` and rate limits effectively apply globally rather than per-user-IP. Fix: `app.set('trust proxy', 1)` in the Express bootstrap (backend/src/index.ts or equivalent). Non-blocking but correctness/security issue — flagged 22 Apr 2026.
- ~~**vehicle_id NULL on hire-form-driven assignments — RX22SWU stuck-on-hire incident (28 Apr 2026)**~~ — **RESOLVED 28 Apr 2026** (PR #371 + follow-ups). RX22SWU was booked out via Quick Assign → BookOutPage but vanished from the on-hire filter and refused check-in (`Not currently booked out`). Three connected causes: (a) Quick Assign / hire-form path created the row with `vehicle_id` NULL — vehicle stays optional all the way through; (b) BookOutPage's `updateDriverHireForm` PATCH took `vehicleReg` as a parameter but never put it in the body, so the post-walkaround PATCH flipped `status='booked_out'` without ever populating `vehicle_id`; (c) `vehicles.ts` save-event book-out + check-in side-effects joined through `vha.vehicle_id = fv.id`, so null-vehicle rows were invisible to the matcher. The 27 Apr `syncFleetHireStatus` centralisation correctly demoted `fleet_vehicles.hire_status` → 'Prep Needed' because no active assignment existed for the van's UUID — surfaced the data integrity gap rather than caused it. **Three fixes shipped together (PR #371):** (1) `frontend/src/modules/vehicles/lib/driver-hire-api.ts` + `BookOutPage.tsx` — `updateDriverHireForm` now accepts `vehicleId` (UUID) and includes it in the PATCH body; BookOutPage passes `form.vehicleId`. (2) `backend/src/routes/vehicles.ts` save-event book-out + check-in side-effects gain a 2-pass match: Pass 1 keeps the existing JOIN for already-linked rows, Pass 2 falls back to a null-vehicle row on the same HH job — disambiguated by driver name on book-out (where the event carries `driverName`), single-unique on check-in. The UPDATE COALESCEs `vehicle_id` from `(SELECT id FROM fleet_vehicles WHERE reg = $reg)` so the link is backfilled at the same time as the status flip. (3) `backend/src/routes/hire-forms.ts` PATCH emits a `console.warn` when `nowBookedOut && !updated.vehicle_id` so this class of bug is visible in the journal next time. **Three orphaned rows manually backfilled:** Nicholas Hale HH#15819 RX22SWU (live unstick), Danny Washington HH#15793 (returned, fleet UUID `15350386-d485-4fb3-beee-7ecbc2a09877`), Cameron Williams-Hill HH#15820 (returned, fleet UUID `37e20b7e-7c12-4e89-bbee-37f116501673`). **Companion UX fix (PR #374 + follow-up):** Job Detail Drivers & Vehicles tab replaced the prominent `+ Assign Driver` button with state-aware next-action buttons per card (Allocate / Book Out / Check In) and added sibling-staff-allocation inference so a hire-form row with `vehicle_id` NULL still surfaces "Book Out" if a sibling staff allocation has already picked the van. See Phase D1.5 above for the full UX spec.
- **Allocations UI — van-centric rebuild** — current layout renders one card per hire-form assignment (per-driver), which misrepresents the model where N drivers share one van on one slot. Tactical fixes in place (cascade van pick across sibling drivers, single unlink button, "No van selected yet" placeholder on cards awaiting a van). Target end state: one card per van slot, with all drivers assigned to that slot listed nested inside, ONE van picker per slot rather than per driver. See "Scope rules" block in Step 2 for the model this should reflect.
- **Vehicle book-out / check-in HireHop auto-push** — both directions now deferred. Book-out side (`barcodeCheckout` → `items_barcode_save.php?action=1` to flip HH → Dispatched 5) was pulled from `BookOutPage.tsx` on 21 Apr 2026; check-in side (`barcodeCheckin` → same endpoint `action=2` to flip HH → Returned 7) was pulled from `CheckInPage.tsx:740-752` on 28 Apr 2026 for the same reason — wasn't behaving smoothly in practice and was producing noisy "HireHop return" failures in the staff results panel. Staff now advance HH status manually on both sides. Helper functions (`barcodeCheckout` / `barcodeCheckin` in `frontend/src/modules/vehicles/lib/hirehop-api.ts`) are kept in the lib for future revival. Revisit once we've proven the broader HireHop write-back behaviour end-to-end. See `backend/src/services/hirehop-writeback.ts` for the pattern we'd reuse.
- **Hard book-out gate on vehicle prep status with admin override** — currently the book-out gate only enforces referral + excess (and even those are amber warnings, non-blocking). `fleet_vehicles.hire_status` is observed but not gated. Target ~May 2026: add a hard gate blocking book-out unless the van is `hire_status='Available'` OR the user is `admin`/`manager` and supplies an override reason (logged to audit). Keep the existing amber warnings in place through the transition.
- **"Your van is ready for pickup" email** — trigger when vehicle is allocated + prep complete. Considered 21 Apr 2026 and declined as too much noise for the current hire volume. Reopen if/when volume grows and clients start asking.
- **Vehicle swap mid-hire (Phase D3) — formal flow** — Currently PATCH /api/hire-forms/:id with vehicle_id changes the van silently (no PDF regen, no driver email, no audit reason). Spec'd in Step 2 Phase D3 but not built. End state: staff picks replacement van → each driver on the assignment receives a new hire agreement PDF + email with the new reg, VE103B regenerated if international, swap reason recorded. Needs migration for `swap_reason`, `swapped_at`, `swapped_to_assignment_id` columns on `vehicle_hire_assignments`.
- **Mobile book-out handoff (QR code)** — After desktop setup (allocate van, select hire forms, overnight toggle), staff switch to mobile for the walkaround. Planned flow: "Continue on mobile" button generates a short-lived magic-link token, renders as QR, mobile device redeems → staff JWT cookie → deep-link to `/book-out/:assignmentId?step=walkaround`. Needs new `mobile_handoff_tokens` table + generate/redeem endpoints + UI component. Deferred from 21 Apr sprint; book-out screens are responsive enough to work via direct mobile login as a fallback.
- **Mobile check-in handoff (QR code)** — Same pattern as book-out above, but for the check-in flow. Staff start on laptop (select vehicle, confirm job, review book-out summary) then switch to mobile for the walkaround / photo comparison. Share the `mobile_handoff_tokens` plumbing with book-out — only the redeem target URL differs (`/check-in/:eventId?step=walkaround`). Flagged 22 Apr 2026. Non-blocking, staff can currently log in on mobile directly.
- **Dashboard driver pills reflect driver status** — "Going Out Today" / "Coming Back" widgets on Command Centre currently render every driver-name pill in blue. Should use `deriveDriverStatus` (green/amber/blue/red) so staff can see at a glance whether the driver is Approved / In Progress / Expired / needs Referral. Needs the Dashboard widget to either receive driver status in its payload or fetch it. Flagged 22 Apr 2026.
- ~~**Allocations: recognise booked-out state**~~ — **RESOLVED 24 Apr 2026.** AllocationsPage hides "Book Out" on cards where `rawStatus` is `booked_out` or `active` and renders a "Booked Out" / "On Hire" pill instead. `GET /api/vehicles/jobs/upcoming-due-back` now includes jobs whose vehicle assignments are in `booked_out`/`active` status, so vans whose HH status is stale still surface in Due Back via their OP assignment status. Van-centric layout rebuild still pending.
- **Book-out "Resume where you left off" improvements (22 Apr 2026)** — The draft-resume prompt on `BookOutPage` currently appears any time IndexedDB has a saved autosave entry for the book-out flow, regardless of whether the picked vehicle is already `hire_status='On Hire'`. Two improvements wanted: (a) **suppress the prompt** when the draft's vehicle is currently On Hire (there's nothing to resume — the hire already completed, the draft is stale leftover), and (b) when the prompt does show, **surface the driver name + HireHop job** inside it (currently just "You have an unsaved session for RX24SZC · Step 1 of 6 · 0 photos captured"). Staff should be able to glance at it and know "ah, that's the one I was just doing for Desmond / job 15746, discard" vs "oh I genuinely abandoned something mid-walkaround, resume". Touches `frontend/src/modules/vehicles/components/shared/DraftResumePrompt.tsx` (add fields) and `useFormAutosave.ts` (include driverName + hireHopJob in the stored payload + surface on read) and `BookOutPage.tsx` (cross-check vehicle hire_status before rendering).
- Crew availability calendar (check if freelancer is already assigned to overlapping dates)
- Skills-based crew matching (auto-suggest freelancers with matching skills for job type)
- Freelancer application inbound form (public form → creates person with `is_freelancer=true`, `is_approved=false`, generates review task)
- **Mileage-based service threshold notifications** — add to daily compliance check, alert when vehicle within configurable miles of `next_service_due`
- ~~**Email notifications**~~ → Now part of Step 7 Inbox & Notification System (escalation scheduler)
- ~~**Per-user notification preferences**~~ → Now part of Step 7 Inbox & Notification System (user_notification_preferences table)
- **Freelancer portal repointing** — switch freelancer-facing app from Monday.com read/write to OP API for crew assignments, delivery jobs, studio sitter assignments, hire form status. **Note:** `share_with_freelancer` flag exists on venue files and job files — portal should filter files by this flag when serving to freelancers (only show files where `share_with_freelancer = true`). Backend endpoint: `PATCH /api/files/update-metadata` persists the toggle.
- **Address Book CRM & Filtering Enhancements:**
  - *Tier 1 (quick wins):*
    - [x] Multi-filter on People page: has email, has phone, linked org type, tags, location/city
    - [x] Multi-filter on Organisations page: tags, location, has email, has people
    - [x] Multi-filter on Venues page: city, has org link
    - [x] Sort options on all list pages: alphabetical, recently added, recently updated
    - [x] "Last contacted" indicator on People/Orgs — show most recent interaction date, flag overdue contacts
    - [x] **Freelancer-aware People page** — when `is_freelancer` filter is on, swap "Organisations & Roles" column for "Skills" + "Next Review" (with overdue/due/OK pip), add "Sort: Review due soonest", trait chips (Insured / Has T-shirt), review-status segmented chips (All / Overdue / Due ≤30d / OK / No date), skills multi-select, and group-by-review toggle. Skills list endpoint: `GET /api/people/skills` (distinct skills across all freelancers).
  - *Tier 2 (medium effort):*
    - [ ] Saved filters / smart lists — save filter combinations as named views (e.g. "London promoters", "Bands without management link", "Contacts not chased in 90 days")
    - [ ] Bulk tagging — select multiple orgs/people, apply tag in one click (campaign prep)
    - [ ] Export to CSV — filtered results exportable for mailouts or spreadsheet work
    - [ ] "Related to jobs" filter — show orgs/people involved in jobs within a date range, or who've never had a job (partially available via job_organisations links already)
    - [ ] **Active jobs column for freelancers** — when freelancer filter is on, show count of in-progress assignments per person (joins `vehicle_hire_assignments` + `quote_assignments`). Heavier query so left as a per-row aggregate or a separate endpoint rather than baking into the bulk list.
  - *Tier 3 (larger lift):*
    - [ ] Pipeline-style contact nurturing — track where leads/contacts are in a relationship lifecycle
    - [ ] Campaign/mailout integration — tag contacts for a promo, send via email service
    - [ ] Activity scoring — surface who's most engaged / least contacted

- **Bulk file import from Monday.com** — Monday's freelancer board has DVLA / licence / passport scans as attachments. Bulk migration to OP needs:
  1. Iterate Monday API for each freelancer's file column.
  2. Download each file (Monday gives short-lived signed URLs).
  3. Upload to R2 under `freelancers/<person-id>/<labelled-filename>` (e.g. `licence-front.pdf`).
  4. Append entry to `people.files` JSONB: `{name, url, type, uploaded_at, uploaded_by}`.
  5. Match Monday rows to OP people by email.

  Best done from Claude Desktop (has Monday + R2 + OP credentials). Volume: ~50 freelancers × 2-4 files. The CSV importer (`backend/src/scripts/import-freelancers-csv.ts`) deliberately ignores file columns — files come across separately via this manual / desktop flow.

### Phase 3–5

See docs/SPEC.md for full phased plan.

## Shared Utilities (BUILT)

These are reusable services that ALL modules must use. Do NOT make direct HireHop API calls or send emails from individual modules — use the broker/service.

### HireHop Request Broker ✅ COMPLETE

**File:** `backend/src/services/hirehop-broker.ts`

Central gateway for ALL HireHop API communication. Prevents rate limit issues when multiple users/modules hit HireHop simultaneously.

**Architecture:**
```
Module A ──┐
Module B ──┤──→ [HH Request Broker] ──→ HireHop API
Module C ──┘     ├─ Request queue (priority-based)
                 ├─ Response cache (Redis, configurable TTL)
                 ├─ Rate limiter (token bucket, ≤50 req/min)
                 └─ Deduplication (same request within TTL = cache hit)
```

**Key features:**
- **Priority queue:** User-initiated requests (high) vs background sync (low)
- **Redis cache:** Per-endpoint configurable TTL:
  - Static data (contacts, stock list): 30 min TTL
  - Job data: 5 min TTL
  - Status updates (POST/PUT): no cache, write-through
- **Deduplication:** Same GET request within TTL returns cached response
- **Token bucket rate limiter:** Max 50 req/min (leaving 10 req/min headroom from HH's 60 limit)
- **Metrics:** Cache hit rate, queue depth, rate limit headroom logged

**Usage pattern (all modules):**
```typescript
import { hhBroker } from '../services/hirehop-broker';

// GET with caching
const job = await hhBroker.get('/api/job_data.php', { job: 1234 }, { priority: 'high', cacheTTL: 300 });

// POST (bypasses cache, still rate-limited)
await hhBroker.post('/frames/status_save.php', { job: 1234, status: 2 }, { priority: 'high' });

// Batch (sequential with rate limiting)
const results = await hhBroker.batch([
  { endpoint: '/api/job_data.php', params: { job: 1234 } },
  { endpoint: '/api/job_data.php', params: { job: 1235 } },
], { delayMs: 350 });
```

**Migration plan:** ~~Existing `hirehop-sync.ts` and `hirehop-job-sync.ts` should be refactored to use the broker instead of calling `hireHopGet()` directly.~~ DONE — both sync services and vehicles route now use broker. `config/hirehop.ts` exports (`hireHopGet`/`hireHopPost`) kept for backward compatibility, internally delegate to broker.

### Email Service ✅ COMPLETE

**File:** `backend/src/services/email-service.ts`
**Templates:** `backend/src/services/email-templates/`
**Routes:** `backend/src/routes/email.ts`
**Migration:** `016_email_log.sql` (audit trail)

Centralised email sending with branded templates, test mode routing, and audit logging.

**Sending method:** Google Workspace SMTP via app password (existing infrastructure).

**Architecture:**
```typescript
import { emailService } from '../services/email-service';

// Send a branded client email
await emailService.send('booking_confirmation', {
  to: 'client@example.com',
  variables: { clientName: 'John', jobNumber: 'J-1234', amount: '£500' },
});

// Send an internal notification email
await emailService.send('compliance_reminder', {
  to: 'jon@oooshtours.co.uk',
  variables: { vehicleReg: 'RX22SXL', dueType: 'MOT', daysRemaining: 7 },
});
```

**Key features:**
- **Template registry:** Each email type registered with subject template + HTML body template
- **Two template categories:**
  - Client-facing: Polished, Ooosh-branded (logo, colours, professional footer)
  - Internal/operational: Simpler but consistent styling
- **Test mode:** Global `EMAIL_MODE` setting (`test` | `live`)
  - In test mode: emails redirect to `EMAIL_TEST_REDIRECT` address by default
  - Test emails include banner: "TEST MODE — would have been sent to: client@example.com"
  - One-click admin toggle in Settings page to switch to live
- **Per-template allowlist** (`EMAIL_LIVE_TEMPLATES`): comma-separated template
  IDs that bypass the test-mode redirect even while `EMAIL_MODE=test`. Lets us
  release individual templates to real recipients (no banner, no `[TEST]`
  prefix, CCs honoured) without flipping the whole system live. Ignored when
  `EMAIL_MODE=live`. `sendRaw()` is NOT covered (no template ID to match) —
  raw sends always honour the global mode.
  - `email_log.mode` stores the **per-message effective** routing (`live` if it
    went to the real recipient, `test` if it was redirected), not the env mode.
- **Audit trail:** Every email logged to `email_log` table (recipient, template, sent_at, status)
- **No unsubscribe:** These are transactional/operational emails, not marketing

**Environment variables:**
```
EMAIL_MODE=test                           # 'test' or 'live'
EMAIL_TEST_REDIRECT=jon@oooshtours.co.uk  # Where redirected test emails go
EMAIL_LIVE_TEMPLATES=                     # Comma-separated template IDs to release
                                          # while in test mode (e.g.
                                          # booking_confirmed_deposit,payment_received)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=notifications@oooshtours.co.uk
SMTP_PASS=xxxx-xxxx-xxxx-xxxx            # Google Workspace app password
SMTP_FROM=Ooosh Tours <notifications@oooshtours.co.uk>
```

**Template structure:**
- Base layout: `backend/src/services/email-templates/base.ts` — Ooosh branding wrapper
- Per-template: `backend/src/services/email-templates/{template-id}.ts` — subject + body
- Variables injected via `{{variableName}}` substitution

**Convention: include the HH job number on every job-scoped template** (May 2026). Any new email template that relates to a specific job MUST surface the HH job number in BOTH the subject line and the body, using the Katatonia pattern:

| Surface | Format | Example |
|---|---|---|
| Subject | `<Headline> — <Job Name> (#{{jobNumber}})` (or `(job #{{jobNumber}})` if no jobName in subject) | `Payment Received — Katatonia - Van & backline hire (#15607)` |
| Body (first mention of the job) | `<strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>)` | "Thank you for your payment for **Katatonia - Van & backline hire** (job **#15607**)" |

The HH job number is the thread that ties any email back to the job in HireHop / OP without the recipient needing to click through. Without it, internal staff (and clients) end up hunting for the job ref every time they want to action a message. The convention is enforced across every existing job-scoped template — match it on new ones.

**Caller responsibility:** the sending route must pass `jobNumber: String(job.hh_job_number || '')` in the `variables` object. If the job-scoped sender has no HH number to hand (e.g. an OP-only enquiry not yet pushed to HireHop), pass an empty string — the templates degrade gracefully to `(#)` / `(job #)`. Don't omit the variable entirely (renders as the literal `{{jobNumber}}` placeholder).

**Templates this does NOT apply to:** auth flows (`portal_verification_code`, `portal_password_reset`), system alerts not tied to a specific job (`hire_form_fallback_alert`, `monday_fallback_alert`, `platform_issue_reported`), vehicle-scoped templates (`compliance_reminder`), and multi-entity templates (`file_resend`). Use judgement — if the email is about one job, the number goes in; if it's about a person/vehicle/system event with no job context, it doesn't.

### Fleet Hire-Status Sync ✅ COMPLETE

**File:** `backend/src/services/fleet-hire-status-sync.ts`

Single source of truth for `fleet_vehicles.hire_status`. The column is a CACHED projection of assignment state — derived, not authoritative. The authoritative truth is `vehicle_hire_assignments.status`.

**Why this exists:** Before centralisation, five different places (`assignments.ts` book-out + check-in + swap, `hire-forms.ts` PATCH, `vehicles.ts` save-event) each ran their own `UPDATE fleet_vehicles SET hire_status = ...`. When the frontend forgot to send `event.hireStatus` (e.g. the 22 Mar eventType case bug, the 20-22 Apr stuck-booked-out historical data), the column drifted from reality. Funnel everything through one helper and drift becomes impossible.

**Decision rules:**
- Sticky values (`'Sold'`, `'Not Ready'`) preserved — these are explicit manual overrides for damage repair, finance return, etc. The helper does not clobber them.
- Any assignment in `('booked_out', 'active')` for the vehicle → `'On Hire'`.
- Otherwise, if current value is `'On Hire'` (van WAS out, now no active assignment — i.e. just came back) → `'Prep Needed'`.
- `'Prep Needed'` → `'Available'` transition is NOT handled here. That happens when prep is completed via `PATCH /api/vehicles/fleet/by-reg/:reg/hire-status`.
- All other cases: preserve current value.

**Usage pattern:**
```typescript
import { syncFleetHireStatus, syncFleetHireStatusByReg } from '../services/fleet-hire-status-sync';

// After flipping an assignment status, recompute fleet status:
await syncFleetHireStatus(vehicleId);

// For event handlers that work with regs:
await syncFleetHireStatusByReg(reg);
```

**Wired into:**
- `assignments.ts` book-out (`POST /:id/book-out`)
- `assignments.ts` check-in (`POST /:id/check-in`)
- `assignments.ts` swap-vehicle (`POST /:id/swap-vehicle` — syncs both old + new)
- `hire-forms.ts` PATCH on transition to `booked_out`
- `vehicles.ts` save-event end-of-handler (after assignment status flips)

**NOT wired into:** the manual override paths (`PATCH /api/vehicles/fleet/:id`, `PATCH /api/vehicles/fleet/by-reg/:reg/hire-status`, bulk import). These are explicit user actions that should stand as written.

**Backfill:** `backend/src/scripts/backfill-fleet-hire-status.ts` runs the same rules across the entire fleet to clean up historical drift. Dry-run by default; `--commit` to apply.

### HireHop Deposit Push ✅ COMPLETE

**File:** `backend/src/services/hh-deposit.ts`

Centralised two-step HireHop deposit push (`billing_deposit_save.php` + Xero sync via `accounting/tasks.php`). Used by `POST /api/money/:jobId/record-payment` and `POST /api/excess/:id/payment`. Returns a structured `{hhDepositId, xeroSynced, error}` so callers can surface failures rather than silently logging "non-fatal".

**Why this exists:** Before May 2026 the Money tab's Record Payment endpoint had its own inline HH push, and the Excess Manage modal's `/payment` endpoint had no HH push at all — excesses recorded via Manage never appeared in HireHop billing. Job 15624 incident: £1200 worldpay was recorded twice via the Manage modal, doubling the OP-side `excess_amount_taken` to £2400, while HireHop showed nothing for the excess. The shared helper closes both gaps and standardises the failure-surfacing contract.

**Failure surfacing contract:** any caller hitting this helper should bubble `error` back to the client as `hh_push_error: string | null` in the JSON response. Frontend renders an amber "Saved in OP — HireHop push failed" banner that keeps the modal open so staff can decide whether to retry or record manually in HH and use Manage > Link to HH. Three failure modes covered:
1. HireHop returns `success: false` (rate-limit / validation error)
2. HireHop returns 200 but no extractable deposit ID (the "silent success" case that bit 15624)
3. Network throw / timeout

**Idempotency contract on excess:** both `/excess/:id/payment` and `/money/:jobId/record-payment` accept `total_collected` (absolute new total on the excess record) alongside `amount` (delta-add legacy). Frontend now sends `total_collected` for excess flows, so re-clicking Save with the same value is a no-op rather than doubling. Lowering `total_collected` is treated as a correction (allowed, no HH push). The Money tab's Record Payment > Excess form also auto-finds existing excess records on the job (any status — including `taken` for top-ups), replacing the previous filter that excluded `taken` records and led to a misleading "no excess record exists" banner.

**Top-ups against records that already have `hh_deposit_id`:** the helper deliberately skips the HH push and returns `hh_push_error` set to a descriptive message. Reason: the existing HH deposit row would need a separate top-up entry, not an additive update. Staff create the top-up deposit manually in HH and use Manage > Link to HH (or a future change splits the OP record).

**Don't bypass:** route handlers should NOT call `billing_deposit_save.php` directly from inline code — that bypasses the failure-surfacing contract. The previous direct call in `money.ts` was the source of the silent-failure problem.

### API Key Verification ✅ COMPLETE

**File:** `backend/src/middleware/api-key.ts`

Single source of truth for verifying the `X-API-Key` header against the `api_keys` table. Pulls all rows with the matching `key_prefix` and `bcrypt.compare`s the full key against each row's `key_hash`. Bumps `last_used_at` on success.

Used by:
- `POST /api/money/*` (`authenticateFlexible` in `money.ts`) — Payment Portal
- `POST /api/webhooks/external/status-transition` — external status pushes

**Why this exists:** the original inline implementation in both files only matched the first 8 chars of the supplied key against `api_keys.key_prefix`, accepting any string starting with a known prefix (e.g. `ppk_live`) as authenticated. Bypassed the bcrypt hash entirely. Fixed May 2026.

**Routes that DON'T use this:** routes authenticating against a single env-var key (`hire-forms.ts`, `driver-verification.ts`) use `crypto.timingSafeEqual` directly — different pattern, not vulnerable.

**Audit script:** `backend/src/scripts/audit-api-key-hashes.ts` checks existing rows have bcrypt-shaped `key_hash` values. Run before deploying changes that affect API key auth, or whenever a new row is added. Reports non-bcrypt / missing hashes per row, and the deploy-safety summary only counts active rows (inactive rows can have any garbage in `key_hash` — `verifyApiKey` won't query them).

**Creating a new api_keys row:** never insert plaintext or non-bcrypt values into `key_hash`. The May 2026 audit revealed two historical rows had been inserted incorrectly — one with a SHA-256 hex string in `key_hash`, one with `key_hash = NULL`. Both authenticated under the old prefix-only code despite the wrong hash format; both broke under the new bcrypt-strict code. Standard creation pattern:

```ts
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const key = `ppk_live_${crypto.randomBytes(24).toString('hex')}`;
const hash = await bcrypt.hash(key, 12);
// INSERT INTO api_keys (name, key_hash, key_prefix, service, is_active)
//   VALUES ('Foo Service', $hash, key.substring(0, 8), 'foo_service', true);
// Then store `key` in the consuming integration's env var (Netlify, Vercel, etc.)
// — that's the only time you'll see the full plaintext value.
```

The `key_prefix` should be the first 8 chars of the plaintext key (used as a fast lookup index — `verifyApiKey` matches on prefix, then bcrypt-compares the full key against each candidate's `key_hash`).

### Post-Hook Recovery ✅ COMPLETE (7 May 2026)

**File:** `backend/src/services/post-hook-recovery.ts`

Hardening for the fire-and-forget `setImmediate` blocks that run after a route has already responded (post-PATCH side-effects: PDF generation, status writebacks, requirement syncs, email sends, etc.). Wrap the inner work with `runHookWithRecovery({...}, async () => { ... })` instead of bare try/catch.

**What it does:**
1. **Retry with exponential backoff** — 3 attempts at 1s / 4s / 16s. Catches transient DB pool exhaustion, network blips, momentary HH 429s.
2. **Loud failure alert** — when retries are exhausted, writes a `notifications` row (priority=high, type=`system`) for every active admin/manager + emails `info@oooshtours.co.uk` with the hook label, job ref, error message, and a click-through to the job. Means a permanent failure is visible in minutes instead of "next time someone notices an email didn't arrive".

**Idempotency contract:** every consumer hook MUST be safe to retry. Current consumers all have natural idempotency markers (`hire_form_emailed_at`, `ooh_info_sent_at`, "skip if HH already at target status" guards in auto-dispatch, forward-only requirement sync helpers). Any new hook wrapped with `runHookWithRecovery` must satisfy the same property — adding it to a non-idempotent operation will double-send / double-write.

**Wired into:** the 5 post-book-out hooks in `routes/hire-forms.ts` PATCH handler — vehicle requirement sync, post-book-out requirement advance, hire form PDF + email, OOH info email, auto-dispatch. The 7 May 2026 RX72TKO incident lost all 5 simultaneously to a single Postgres connection timeout that coincided with a deploy restart; after this hardening, the same blip would have been retried + recovered automatically, or surfaced via bell + email if the retries also failed.

**NOT a replacement for the eventual outbox pattern** (see "Future Enhancements" — outbox would survive server restarts and give full observability over pending work). This is the cheap fix that closes ~90% of the gap until that work is scheduled. New `setImmediate` blocks added to the codebase should use `runHookWithRecovery` until the outbox lands.

**Usage:**
```ts
import { runHookWithRecovery } from '../services/post-hook-recovery';

setImmediate(() => {
  runHookWithRecovery(
    {
      hookLabel: 'Some background task',
      jobId,                  // OP UUID — drives the action_url
      hhJobNumber: hhJobId,   // human-readable in the alert title
      assignmentId: id,       // optional — included in alert body
    },
    async () => {
      // Do the actual work. Throw on failure.
    }
  ).catch((err) => {
    console.error('[my-route] background task failed (after retries):', err);
  });
});
```

The outer `.catch` is for the post-alert rethrow — the alert has already fired by then, this is just for log visibility.

### Vehicle Notification Recipients ✅ COMPLETE

**File:** `backend/src/services/vehicle-notify.ts`

Centralised recipient helper for vehicle-related alerts (insurance referrals, mid-tour drivers, fleet compliance — MOT/Tax/Insurance/TFL). Returns `{ to: 'info@oooshtours.co.uk', cc: ['will@oooshtours.co.uk'], bellUserIds: [<Will's UUID>] }` with 5-min in-process cache.

**Why this exists:** Pre-May 2026, vehicle bell notifications fanned out to every active `role IN ('admin', 'manager')` user (~5 staff). High-priority bells escalating to email after 1h meant one referral generated 5+ emails to staff who don't look after vehicles. Most managers cover other areas of the business and shouldn't be in this loop. Hardcoded info@ + will@ for now (can move to env vars if recipients ever need to differ across environments).

**Usage:**
```typescript
const { getVehicleNotificationTargets } = await import('../services/vehicle-notify');
const targets = await getVehicleNotificationTargets();

// Direct email
await emailService.send('referral_alert', {
  to: targets.to,        // info@
  cc: targets.cc,        // will@
  variables: { ... },
});

// Bell — only the vehicle manager. Set email_sent_at = NOW() if a direct
// email was also sent, so notification-escalation doesn't double-fire.
for (const userId of targets.bellUserIds) {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, priority, email_sent_at, ...)
     VALUES ($1, 'compliance', $2, $3, 'normal', NOW(), ...)`,
    [userId, ...]
  );
}
```

**info@ as guaranteed fallback:** if Will's user record is missing or `is_active = false`, `bellUserIds` is empty (no bell fires) but emails still send. info@ never goes silent.

**Wired into:**
- `routes/driver-verification.ts` — referral bell when flag set mid-flow (no email here; the proper email fires from hire-forms.ts when the form is submitted)
- `routes/hire-forms.ts` — `referral_alert` email + mid-tour driver bell + `mid_tour_driver` email
- `services/compliance-checker.ts` — daily compliance bells + per-alert `compliance_reminder` email (added direct email path; previously relied on bell→escalation fanout for delivery)

**Don't bypass:** any future vehicle alert path (e.g. issues register notifications, vehicle swap alerts, breakdown notifications) MUST use this helper rather than reverting to `WHERE role IN ('admin', 'manager')`. The legacy `vehicle_compliance_settings.notification_roles` setting is intentionally ignored — kept in the DB for backwards-compat reads but no longer drives recipients.

**Escalation duplicate-prevention pattern:** when both a direct email AND a bell fire for the same event, set `email_sent_at = NOW()` on the bell INSERT. The 15-min escalation scheduler skips notifications where `email_sent_at IS NOT NULL`, so Will doesn't get the same content twice.

### Portal Notification Preferences ✅ COMPLETE (May 2026)

**File:** `backend/src/services/portal-notification-prefs.ts`

Single source of truth for "should this informational portal notification be sent?". The freelancer/staff D&C portal splits notifications into two classes with distinct mute behaviour:

| Class | Examples | Respects mute? |
|---|---|---|
| **Informational** | `freelancer_assignment` (new allocation), `job_change_notification` (date / time / venue change) | Yes — global mute (`people.portal_notifications_paused_until`) AND per-job mute (`people.portal_muted_quote_ids`) |
| **Accountability** | completion-chaser ladder (2h / 6h / 14h), staff L3 escalation | **No — always sends, by design** |

**Why two classes:** the staff shared account (info@) keeps its global mute set permanently to suppress new-allocation/time-change spam (D&C is a high-volume internal flow). But "you haven't marked the job complete yet" chases MUST still land — that's the accountability loop. A single all-or-nothing mute couldn't do both. Same applies to freelancers going on holiday — they can mute informational comms but completion accountability survives.

**Usage pattern:**
```typescript
import { shouldSuppressInformational } from '../services/portal-notification-prefs';

const { suppress } = await shouldSuppressInformational(personId, String(quoteId));
if (suppress) return;  // or `continue` inside a loop
```

**The rule:** every NEW informational sender to the portal MUST call this helper before sending. Accountability senders MUST NOT — chases bypass mute by design. The helper logs every suppression to console for debugging (`[notify] suppressed for person {id}: {reason}`).

**Wired into:**
- `routes/quotes.ts` PUT `/:id` — `job_change_notification` (refactored from inline mute check)
- `routes/quotes.ts` PATCH `/:id/status` — `freelancer_assignment` on draft → confirmed (also sets `qa.confirmed_at` on suppression so a future re-confirm doesn't replay if mute later expires)
- `routes/quotes.ts` POST `/:id/assignments` — `freelancer_assignment` on new assignment to confirmed quote

**NOT wired into (deliberately):**
- `services/completion-chaser.ts` — accountability class, always fires. Also dropped its `qa.is_ooosh_crew = false` filter so info@ assignments get chased on the same ladder. L3 staff escalation is suppressed when chasee email IS info@oooshtours.co.uk (avoids self-CC since L1+L2+L3 already landed there).
- `src/app/api/webhooks/monday/job-updated/route.ts` — Next.js, Monday-shaped data (comma-separated string, not UUID array), on the deprecation path under `PORTAL_MONDAY_FALLBACK_ENABLED`. Refactoring would create new cross-service coupling that's about to be torn down.

**Storage** (migration 067):
- `people.portal_notifications_paused_until` — TIMESTAMPTZ, future = muted, year-2125 sentinel = "indefinite". info@ seeded muted indefinitely.
- `people.portal_muted_quote_ids` — UUID[], per-job mutes for "stop bugging me about THIS specific hire I already know about".

**UI surfaces:**
- **Portal banner:** `src/components/MuteBanner.tsx` mounted in root portal layout (`src/app/layout.tsx`). Sticky red strip across top of every authenticated page with inline Resume button. Mobile-first (44px tap targets). Hidden on 401 / no mute / fetch error.
- **Portal settings:** `src/app/settings/page.tsx` — 4 mute durations (end of today / 7 days / specific date / indefinite), per-job mutes managed from each job's detail page.
- **Staff address book:** `frontend/src/pages/PersonDetailPage.tsx` — small amber 🔕 chip in the freelancer details block when `portal_notifications_paused_until` is in the future. Read-only context for staff.

**Watch list:**
- Staff report "stopped getting allocation emails" → check `portal_notifications_paused_until` on their `people` row. Pre-May-2026, `freelancer_assignment` ignored mute entirely; the May 2026 fix correctly stops sending when muted.
- Staff report "didn't get a completion chase" → NOT mute-related. Check `qa.is_ooosh_crew`, `qa.status`, `q.ops_status`, `q.completion_reminder_level` and the `completion-chaser.ts` query.

### Hire Date Resolution

**Canonical hire-window source for PDFs / emails / overlap checks:**

| Field | Authoritative source | Fallback |
|---|---|---|
| Hire start date | `vehicle_hire_assignments.hire_start` (set at book-out, optional override) | `jobs.job_date` (Job Start) |
| Hire end date | `vehicle_hire_assignments.hire_end` (set at book-out, optional override) | `jobs.job_end` (Job Finish — the REAL end of charge) |

**Important:** The fallback for hire end is `jobs.job_end`, **NOT `jobs.return_date`**. The `return_date` field is the artificial +1-day turnaround buffer used for warehouse scheduling — it's not when the hire actually ends.

This was a real bug: `hire-forms.ts` PDF generation at lines 1173 + 1424 was using `j.return_date` as the fallback, while `assignment-overlap.ts` used `j.job_end`. Hire agreement PDFs would show a different end date than the overlap check expected. Fixed Apr 2026 — both now use `j.job_end`.

**The four-layer date model:**
1. `jobs.job_date / job_end / out_date / return_date` — HH-synced job dates (canonical for the JOB)
2. `vehicle_hire_assignments.hire_start / hire_end` — per-van actual hire window (CAN drift from job dates intentionally — e.g. client picks up the night before)
3. `vehicle_hire_assignments.booked_out_at / checked_in_at` — when book-out / check-in physically happened (event timestamps)
4. Vehicle event history — full audit trail

Book-out is the canonical moment dates get LOCKED on the assignment. Before book-out, `hire_start/hire_end` are tentative (mirror job dates if not set). At book-out, staff can adjust them on the BookOutPage form. Mid-tour drivers added after book-out get THEIR own `hire_start = NOW()`.

### Per-job contacts (`job_contacts`)

**The convention:** each hire has its own contact list — who's actually involved in THIS booking — distinct from the org-wide "who works at this company" model in `person_organisation_roles`. Rounds 1-6 (May 2026) built this end-to-end: the storage layer, the routing graduation, the management UI, and the HH push enrichment. **All new client-facing email senders, and any new HH push surface, MUST follow this convention.**

**Storage** (migration 086):

`job_contacts (job_id, person_id, is_primary, role_override, notes, created_by, created_at, updated_at)`
- `UNIQUE (job_id, person_id)` — one row per person per job
- Partial unique index `WHERE is_primary = true` — at most one primary per job (enforced; passing two would 23505)
- `role_override` reserved for the edge case where a person's per-job role differs from their org-level role; NULL = inherit. Most rows leave it NULL.

**Why a new table rather than `person_organisation_roles.is_primary`:** `is_primary` is org-wide. "Sarah is primary at ATC Live" means she's primary on every job for ATC Live. We need per-job selection where some hires have Sarah as lead, others Tom, some both ticked with Sarah as lead. `job_contacts` lets that vary independently per job without polluting the org-level "who's the main rep here" signal.

**The routing rule (single source of truth):**

Every client-facing email sender resolves recipients in this exact order:

```
1. job_contacts            ← primary = `to`, rest = CC (REPLACES org-level when non-empty)
2. person_organisation_roles  via client_id OR any job_organisations link
3. organisations.email     (client org's own column, then any linked org)
4. people name-match       (jobs.client_name → people.first_name + last_name)
5. info@oooshtours.co.uk   (safety net, banner injected)
```

When `job_contacts` has rows for a job, they ARE the recipient list. The org-level lookup is NOT merged — that's the point of per-job selection ("Sarah's at this org but THIS hire is Tom"). Steps 2-5 only run when the job has zero `job_contacts` rows.

**Implementations:**
- `getJobEmailRecipients` (`services/money-emails.ts`) — used by `resolveClientEmailTarget`, drives payment/excess/cancellation/portal/vehicle/hire-form-auto emails
- `resolveHireFormContacts` (`services/hire-form-contacts.ts`) — used by the manual hire-form picker. **Differs from above:** stays additive (shows all reachable contacts as candidates) but lands `job_contacts` rows at the top tagged `job_contact_primary` / `job_contact`. Surfaces `person_id` on every source backed by a known person row.
- `has_client_email` banner check (`routes/hirehop.ts`) — mirrors the same priority order so the Job Detail amber warning matches send behaviour. Must stay in sync with `getJobEmailRecipients`.

**Don't write a parallel path.** Any new client-facing sender must route through one of the helpers above, or follow the same five-level fallback. The May 2026 round-3 RX22SWU sole-trader incident is the cautionary tale — multiple senders had drifted from `getJobEmailRecipients` and were silently failing on edge-case data shapes.

**Write paths (where `job_contacts` rows come from):**
1. **New Enquiry form** (`POST /api/pipeline/enquiry`) — `contact_person_ids[]` + `primary_contact_person_id` from the cascade picker
2. **Job Detail `<JobContactsCard>`** (round 6) — three endpoints under `/api/pipeline/:jobId/contacts`:
   - `GET` → `{ ticked, candidates }` (candidates = people from `client_id` + any `job_organisations` linked org, deduped by `person_id`, client wins tie)
   - `PUT` → idempotent replace `{ person_ids, primary_person_id }`. Transactional delete-all-insert-new.
   - `POST /add-person` → one-shot: link existing person OR create-and-link to client org + tick on job. Honours `set_as_primary` by clearing any current primary first (partial unique index would 23505 otherwise).
3. **Hire-form picker promote checkbox** (round 6) — when staff sends a hire-form email via `<RequirementCard>`, an opt-in checkbox "Also save these N contacts to the job" POSTs each promotable selected contact (one with a `person_id` not already in `job_contacts`) to `/add-person`. Fire-and-forget; doesn't block the send.

**HireHop push enrichment** (round 5):

`POST /:id/push-hirehop` + `POST /:id/sync-client-to-hh` (both in `routes/pipeline.ts`) look up the primary `job_contacts` row and use it for the HH `job_save_contact.php` payload:

| HH field | Value |
|---|---|
| `NAME` | Primary contact's full name (fallback: org name) |
| `COMPANY` | Org name (fallback: primary contact's name) |
| `EMAIL` | Primary contact's email if set, else org email |
| `TELEPHONE` | Primary contact's phone if set, else org phone |
| `CLIENT_ID` | `external_id_map` lookup — UPDATE in place, not duplicate |

Because we pass `CLIENT_ID`, HH updates the existing contact record in place — including its `NAME` field. That's the intended cleanup direction (evolves "ATC Live" → "Sarah Smith / ATC Live") and matches the SPEC's Stream C cleanup notes. New jobs for the same client will show the most recent push's NAME until their own push overwrites it.

**`person_id` on `resolveHireFormContacts` results:**
- Present for: `job_contact`, `job_contact_primary`, `client_person`, role-derived linked-org sources, `client_name_match`
- Absent for: `client_org`, `linked_org`-style org-level rows, `manual_entry`

The picker promote checkbox keys off this — it only renders for selected contacts where `person_id` is set AND `source !== 'job_contact*'`.

**Watch list:**
- Staff report "I picked Tom but the email still went to Sarah" → check `job_contacts.is_primary` for the job. The partial unique index means only one row should have `is_primary=true`; if zero rows have it, routing falls through to step 2+. The amber "No primary contact picked" hint on `<JobContactsCard>` is the heads-up.
- Staff add a contact via the Job Detail UI but the banner doesn't clear → make sure the parent component is wired to refresh on the `onChanged` callback (re-runs `loadJob()` which re-fetches `has_client_email`).
- New email sender added but recipients are wrong → confirm it routes via `resolveClientEmailTarget` / `getJobEmailRecipients`. Don't write a fresh `SELECT email FROM organisations WHERE id = $client_id` — that bypasses the rule.
- Future `job_person_roles` work (SPEC §2.3 — Enquirer / Authoriser / Payer / Site Contact / Driver / Booker per-job roles) will extend or replace this. `job_contacts` was the round-1-to-6 stepping stone; the role-keyed routing model is captured in "Future Enhancements".

## Security

### Current Security Posture (as of 15 Mar 2026)

**Authentication & Authorization:**
- [x] JWT access tokens (15 min) + refresh tokens (7 days)
- [x] Bcrypt password hashing (12 salt rounds)
- [x] RBAC middleware (`authorize()`) on sensitive routes — 6 roles: `admin`, `manager`, `staff`, `general_assistant`, `weekend_manager`, `freelancer`. **For staff-wide gates** (anything the whole non-freelancer team needs), use the shared `STAFF_ROLES` constant from `middleware/auth.ts` and spread it: `router.use(authorize(...STAFF_ROLES))`. Do NOT hardcode `authorize('admin', 'manager', 'staff')` — it silently locks out `weekend_manager` and `general_assistant` (this caused a live bug on `/pipeline` + `/requirements` post-go-live, fixed 26 Apr 2026). For narrower gates (e.g. only admin/manager can waive excess), keep the explicit role list — `STAFF_ROLES` is only for "everyone except freelancer".
- [x] Account locking — `is_active = false` nulls refresh token via DB trigger, locks user out within 15 min (access token expiry)
- [x] Optimistic locking — `version` column on people, organisations, venues, jobs tables. PUT requests can send `version` to detect concurrent edits (409 Conflict if stale). Backwards compatible — omitting `version` skips the check.
- [x] JWT_SECRET required via env var (no default fallback) — app won't start without it
- [x] Startup validation: JWT_SECRET must be set and ≥32 characters, DATABASE_URL required
- [x] Rate limiting on login (10 attempts per 15 min per IP) and token refresh (20 per 15 min)
- [x] Logout endpoint (`POST /api/auth/logout`) — nulls refresh token
- [x] Password change (self-service `POST /auth/change-password`, admin force-reset `POST /users/:id/force-password`)
- [x] User profile page with avatar upload, name editing
- [x] Socket.io JWT authentication middleware — connections require valid token

**Data Security:**
- [x] All SQL queries parameterised (no injection risk)
- [x] File uploads: authenticated, type-whitelisted, 10MB limit, UUID-named R2 keys
- [x] R2 `operations` bucket: private only (no public access)
- [x] R2 `ooosh-vehicle-photos` bucket: public access (client-facing vehicle photos only, no PII)
- [x] File downloads via authenticated `/api/files/download` endpoint with path traversal prevention
- [x] Zod input validation on all POST/PUT endpoints
- [x] Helmet middleware for Express security headers

**Infrastructure:**
- [x] SSL/TLS via Let's Encrypt (HTTPS enforced)
- [x] Nginx security headers: X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy
- [x] Nginx reverse proxy (Express not directly exposed)
- [x] CORS restricted to configured FRONTEND_URL

**Known gaps (to address):**
- [ ] Field-level encryption for sensitive PII (DVLA data, passport numbers) — need application-level AES-256 encryption with key in env var. Data encrypted at rest, decrypted on read by authorised users only.
- [ ] RBAC on PUT endpoints for people/organisations (currently any authenticated user can edit)
- [ ] Data retention/expiry policy for PII (GDPR compliance)
- [ ] Secrets rotation documentation

**Encryption approach for PII:**
When implemented, sensitive fields will use AES-256-GCM encryption:
```
ENCRYPTION_KEY=<64-char-hex-key>  # In .env, generated via: openssl rand -hex 32
```
- Encrypted fields stored as `encrypted_<fieldname>` in DB (TEXT column with IV prepended)
- Decryption only happens in API response layer, never in SQL queries
- Key stored only in `.env` on server (not in repo, not in R2)
- Yes — we hold the key, so we can always read data back. If the key is lost, encrypted data is unrecoverable.

## Crew & Transport System

This is the quoting/costing system for delivery, collection, and crewed jobs. It lives in the **"Crew & Transport" tab** on the Job Detail page.

### Architecture

| Component | File | Purpose |
|-----------|------|---------|
| Calculator engine | `backend/src/services/crew-transport-calculator.ts` | Core cost calculation logic |
| Quotes API | `backend/src/routes/quotes.ts` | CRUD for quotes, settings, assignments |
| Calculator UI | `frontend/src/components/TransportCalculator.tsx` | Full modal calculator form |
| Job detail tab | `frontend/src/pages/JobDetailPage.tsx` | "Crew & Transport" tab renders quotes list + crew |
| DB: quotes | `007_calculator.sql` | quotes table, calculator_settings, vehicles |
| DB: assignments | `008_quote_status_assignments.sql` | quote_assignments table, quote status fields |

### How It Works

1. **Three job types:** delivery, collection, crewed (delivery + crew stays on site + collection)
2. **Two pricing modes:** hourly (uses time-based rates), dayrate (flat day rate with markup)
3. **Calculator settings** stored in `calculator_settings` table (admin-editable): hourly rates, fuel price, markup percentages, etc.
4. **Quotes** are saved to the `quotes` table, linked to a job and optionally a venue
5. **Crew assignments** via `quote_assignments` junction table — links people to quotes with role, agreed rate, and status
6. **Quote status lifecycle:** draft → confirmed → completed/cancelled (with `cancelled_reason`)

### Key Types (shared/types/index.ts)

- `QuoteJobType`: 'delivery' | 'collection' | 'crewed'
- `QuoteCalcMode`: 'hourly' | 'dayrate'
- `QuoteWhatIsIt`: 'vehicle' | 'equipment' | 'people'
- `QuoteStatusType`: 'draft' | 'confirmed' | 'cancelled' | 'completed'
- `QuoteAssignmentStatus`: 'assigned' | 'confirmed' | 'declined' | 'completed' | 'cancelled'
- `SavedQuote`: full quote record including expenses, calculated costs, crew assignments
- `QuoteAssignment`: person linked to a quote with role and rate info
- `QuoteExpenseItem`: expense line items (fuel, parking, tolls, hotel, per_diem, etc.)

### Calculator Settings Keys

Settings live in `calculator_settings` table. Key values include:
- `freelancer_hourly_day/night` — what we pay freelancers
- `client_hourly_day/night` — what we charge clients
- `driver_day_rate` — flat day rate for drivers
- `admin_cost_per_hour` — office overhead per hour
- `fuel_price_per_litre`, `fuel_efficiency_mpg`
- `handover_time_mins`, `unload_time_mins` — standard overhead times
- `expense_markup_percent` — markup on expenses
- `min_hours_threshold`, `min_client_charge_floor` — minimum charge rules
- `day_rate_client_markup` — markup for day rate pricing mode

### Freelancer Workflow

Two-tier freelancer identification:
1. **`is_freelancer = true`** — person is a freelancer (may be new applicant, not yet vetted)
2. **`is_approved = true`** — freelancer has been reviewed and cleared for assignment to jobs

**Crew assignment only shows approved freelancers** (`is_freelancer = true AND is_approved = true`).

**Freelancer document types** (tagged via existing file upload system):
- DVLA Check
- Licence Front
- Licence Back
- Passport

**Freelancer fields on `people` table:**
- `is_freelancer` BOOLEAN — explicit flag
- `freelancer_joined_date` DATE — when added as freelancer
- `freelancer_next_review_date` DATE — annual review trigger for licence/details

### Vehicles Table

`vehicles` table stores vehicle fleet data (name, registration, fuel type, MPG). Used by the transport calculator to auto-populate fuel efficiency.

## Vehicle Module Integration

The Vehicle Module (VM) is an existing standalone React app that manages fleet vehicles, driver hire forms, and insurance excesses. It needs integrating into the OP as a route, not a separate app.

### Integration Approach

1. VM loses its own nav bar, auth screen, and layout wrapper
2. VM exports its pages/routes as components the OP mounts
3. OP's nav shell stays on screen at all times (add "Vehicles" to `navItems` in `Layout.tsx`)
4. URL: `staff.oooshtours.co.uk/vehicles/...`
5. VM's Netlify functions migrate to OP backend Express routes
6. Auth: VM drops STAFF_PIN, uses OP JWT session. Freelancer token flow stays separate.

### OP Tech Stack (for VM integration reference)

| Aspect | Detail |
|--------|--------|
| Framework | React 18 + Vite + TypeScript (plain SPA, no Next.js/Remix) |
| Hosting | Hetzner VPS, Nginx serves static build, reverse-proxies `/api/*` to Express port 3001 |
| Auth | JWT Bearer tokens via `Authorization` header. Zustand store (`useAuthStore`). Session: `{ id, email, role }` |
| Router | React Router v6. Routes defined in `App.tsx`. |
| CSS | Tailwind CSS |
| API base | `/api/*` — Express backend. HireHop proxy exists at `backend/src/config/hirehop.ts` |
| Build/deploy | `deploy/deploy.sh` — git pull, npm build, systemctl restart. No Docker, no CI/CD. |
| Nav | `frontend/src/components/Layout.tsx` — `navItems` array with optional `children` for dropdown submenus |

### Nav Structure (Layout.tsx)

```typescript
const navItems: NavItem[] = [
  {
    path: '/address-book',
    label: 'Address Book',
    children: [
      { path: '/people', label: 'People' },
      { path: '/organisations', label: 'Organisations' },
      { path: '/venues', label: 'Venues' },
    ],
  },
  {
    path: '/jobs-menu',
    label: 'Jobs',
    children: [
      { path: '/pipeline/new', label: 'New Enquiry' },
      { path: '/pipeline', label: 'Enquiries' },
      { path: '/jobs', label: 'Upcoming & Out' },
      { path: '/jobs/returns', label: 'Returns' },
    ],
  },
  // Add: { path: '/vehicles-menu', label: 'Vehicles', children: [...] }
];
```

### HireHop Consolidation

The OP already has HireHop integration (`backend/src/config/hirehop.ts`). The VM's HireHop cache in R2 (`hirehop-cache/jobs.json`) should be replaced by calling the OP's backend API instead. The OP backend becomes the single HireHop proxy.

### Insurance Excess Lifecycle

Self-drive hires require an insurance excess. The amount is calculated by the driver hire form process (based on DVLA licence points / insurance referral). The excess lifecycle:

1. **Calculated** — hire form determines amount based on driver's DVLA record
2. **Taken** — collected via payment portal (Stripe) OR manually (bank transfer, card in office)
3. **Held** — excess sits with us for the duration of the hire (repeat clients may roll over across multiple hires)
4. **Resolved** — either reimbursed to client OR partially/fully claimed against damage

**Key complication:** HireHop records excess as a deposit. The HH→Xero link is cemented at job creation time, but the HH client name can change later. We need to track "which Xero contact holds this money" separately from "who is the current HH client".

**Repeat client excess:** Some clients leave their excess with us across multiple hires. Need a running ledger per client showing total held, claimed, reimbursed.

**Gate condition:** A job with a self-drive vehicle should not move from "Upcoming" to "Out Now" until the excess is collected. This is enforced in the status transition engine (Step 4).

## Scheduled Tasks (config/scheduler.ts)

| Task | Schedule | Description |
|------|----------|-------------|
| Database backup | Daily at 02:00 | pg_dump → gzip → upload to R2 |
| HireHop job sync | Every 30 minutes | Pull active jobs from HireHop + sync line items + derive requirements |
| Chase auto-mover | Every 15 minutes | Move overdue-chase jobs to "chasing" column |
| On-demand job sync | On page load / button | Per-job: fresh line item fetch from HH, re-derive requirements (non-blocking) |
| OOH return reminders | Daily at 10:00 | Send T-1 day reminder for vehicles with `return_overnight=true` and `hire_end=tomorrow`. See "Out-of-Hours Returns" section. |
| Pre-auth expiry check | Daily (TODO — not yet built, fairly-high priority) | Scan `job_excess` with `status='pre_auth'` older than 4 days, flip to expired + notify staff to re-take. Stripe auto-voids at ~7 days; Ooosh policy re-takes inside 4. |
| Stale enquiry auto-lose | Daily at 09:00 | Mark unconfirmed enquiries / provisional as lost when `job_date::date < CURRENT_DATE`, `pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')`, `status < 2`. Runs at office start so staff don't open the day to phantom enquiries cluttering operational lists (backline prep, overdue departures, etc.). Also pushes status 10 (Not Interested) to HireHop. Was 10:00 pre-May 2026 — moved to 09:00 to land before staff start their day. |

## HireHop Integration

### Environment Variables

```
HIREHOP_DOMAIN=myhirehop.com        # Domain only, no https:// or trailing slash
HIREHOP_API_TOKEN=your_token_here   # API token from HireHop settings
HIREHOP_EXPORT_KEY=your_export_key  # Export key for webhook verification (from HireHop settings)
```

### Current Sync

- **Contacts (Phase 1):** Read-only pull from HireHop into `people` table, matched by email
- **Jobs (Phase 2):** Read-only pull of active jobs (statuses 0-8) into `jobs` table, every 30 min
- **Line items (Phase 2):** Stored in `jobs.line_items` JSONB column via `items_to_supply_list.php`. **IMPORTANT:** Must preserve `kind:3` items (selected prompts) — these are the source for HH-derived requirements (seat config, accessory options, etc.). Current sync filters them out — needs fixing.
- **Webhooks (Phase 2):** Real-time bidirectional sync via HireHop webhooks (live 16 Mar 2026)
  - Inbound: `POST /api/webhooks/hirehop` — receives `job.status.updated`, `job.updated`, `job.created`, `contact.*`
  - Outbound: `hirehop-writeback.ts` — pushes pipeline status changes back to HireHop
  - Polling sync still runs as fallback every 30 min
- **On-demand sync:** Job Detail page triggers fresh item fetch on load (non-blocking). "Sync now" button for immediate refresh.
- Config: `backend/src/config/hirehop.ts`
- Contact sync: `backend/src/services/hirehop-sync.ts`
- Job sync: `backend/src/services/hirehop-job-sync.ts`
- Write-back: `backend/src/services/hirehop-writeback.ts`
- Webhooks: `backend/src/routes/webhooks.ts`
- Routes: `backend/src/routes/hirehop.ts`

### HireHop Line Item Fields (items_to_supply_list.php)

Key fields returned per item on a job:

| Field | Example | Use |
|---|---|---|
| `kind` | 0=header, 2=item, 3=**selected prompt**, 4=service/crew | Item classification. `kind:3` = the selected option from a prompt set |
| `title` | "Premium LWB Splitter Van - manual gearbox" | Item name. `▶` prefix = has child prompts |
| `LIST_ID` | "1645" | HH stock item ID (stable across jobs) |
| `AUTOPULL` | "2823" | Prompt option ID (stable identifier for specific prompt selections) |
| `CATEGORY_ID` | "370" | Category: 370=Vehicles, 371=Vehicle accessories, 450=Rehearsal |
| `VIRTUAL` | "1" | Virtual item (prompt parent, no physical stock) |
| `TYPE_CUSTOM_FIELDS` | `{"preptimemins":{"type":"integer","value":"75"}}` | Custom fields per stock type — includes prep time in minutes |
| `LFT`/`RGT` | "2"/"5" | Nested set tree position — child items sit inside parent's LFT-RGT range |
| `qty` | "1.00" | Quantity on job |

**Prompt detection pattern:**
1. Parent item: `kind:2`, `VIRTUAL:1`, title starts with `▶` (e.g. "▶ Rear seats:")
2. Selected child: `kind:3`, positioned inside parent's LFT/RGT range
3. Only the selected prompt appears — unselected options are absent from the response
4. `AUTOPULL` on the child is the stable ID for the specific option chosen

### HireHop Job Status Codes

| Code | Status | Description |
|------|--------|-------------|
| 0 | Enquiry | Initial enquiry/lead |
| 1 | Provisional | Tentative booking |
| 2 | Booked | Confirmed booking |
| 3 | Prepped | Being prepared |
| 4 | Part Dispatched | Partially dispatched |
| 5 | Dispatched | Out on hire |
| 6 | Returned Incomplete | Partially returned |
| 7 | Returned | All equipment back |
| 8 | Requires Attention | Needs manual review |
| 9 | Cancelled | Job cancelled |
| 10 | Not Interested | Lost lead |
| 11 | Completed | Job fully completed |

### HireHop Rate Limits

- Max 60 requests/minute, max 3/second
- 429 response or HireHop error 327 when exceeded
- Job sync uses 5-second delay between pages (as recommended by HH docs)
- Contact sync uses 350ms delay between pages
- Headers: `X-Request-Count` (requests in last 60s), `X-RateLimit-Available` (next available)

### HireHop API Patterns

- **GET contacts:** `https://{domain}/api/contact_list.php?token={token}`
- **Search jobs:** `https://{domain}/php_functions/search_list.php?token={token}&jobs=1&status=0,1,2,...&page=1&rows=100`
- **GET single job:** `https://{domain}/api/job_data.php?token={token}&job={id}`
- **POST status update:** `https://{domain}/frames/status_save.php` (POST, form-encoded) — always include `no_webhook=1` to prevent loops
- **POST create/update job:** `https://{domain}/api/save_job.php` (POST, form-encoded) — confirmed field names from HH API docs:
  - Dates: `out` (compulsory new), `start` (compulsory new), `end`, `to` — format `YYYY-MM-DD HH:MM`
  - Charge period: `duration_days` ("How many chargeable days from JOB_DATE"), `duration_hrs`, `duration_locked` (0=unlocked)
  - Identity: `job_name`, `name` (contact), `company` (client org)
  - Also aliased as `/php_functions/job_save.php` in some docs
- **Add note:** `https://{domain}/api/job_note.php?job={id}&note={text}&token={token}` (GET)

### HireHop sub-jobs / project prefix on JOB_NAME (May 2026)

HireHop's `search_list.php` and inbound webhook payloads decorate `JOB_NAME` for sub-jobs as `"<Project Name> ► <Leaf Job Name>"` — a *display* string. The actual stored field on the job (visible in HH UI's Job Name field, and via `job_data.php`) is just the leaf. `job_data.php` exposes `PROJECT_NAME` and `PROJECT_ID` as separate fields when the job belongs to a Project; both are empty/`"0"` for top-level jobs.

**OP convention: always store the leaf only** in `jobs.job_name`. The 30-min sync (`hirehop-job-sync.ts`) and inbound webhook (`webhooks.ts handleJobUpdate`) call `stripProjectPrefix()` to drop everything up to and including the last ` ► ` before writing. Without this, OP renames on sub-jobs revert on the next sync — the writeback successfully sets the leaf in HH, but the next inbound pulls the prefixed display string and clobbers it.

`►` (U+25B6) is HH's path separator and won't appear in genuine job names. Migration 078 ran a one-shot strip on existing rows. If a future inbound source is added (a different HH endpoint, a new webhook event), apply `stripProjectPrefix()` there too.

PROJECT_NAME / PROJECT_ID are currently ignored on inbound — Projects are rarely used at Ooosh and surfacing them isn't worth the column. Easy to add later if the project context is wanted in the UI.

## Pipeline ↔ HireHop Status Mapping

| Ooosh Pipeline Status | HireHop Code | HH Name | Trigger Examples |
|---|---|---|---|
| `new_enquiry` | 0 | Enquiry | New enquiry created |
| `quoting` | 0 | Enquiry | Quote being prepared (HH stays Enquiry) |
| `paused` | 0 | Enquiry | Paused enquiry (HH stays Enquiry) |
| `provisional` | 1 | Provisional | Awaiting deposit / held pending |
| `confirmed` | 2 | Booked | Deposit/full payment received |
| `prepped` | 5* | Dispatched | HH status 5 inbound → OP `prepped` (HH skips to 5 on checkout) |
| `dispatched` (on hire) | 5 | Dispatched | OP-only distinction — doesn't push to HH (already at 5) |
| `returned_incomplete` | 6 | Returned Incomplete | Partial return / checking in |
| `returned` | 7 | Returned | All equipment back |
| `completed` | 11 | Completed | Job fully completed |
| `lost` | 10 | Not Interested | Client declined |
| _(cancelled)_ | 9 | Cancelled | Job cancelled after booking |

*\*Note: HH has no "prepped" status (code 3 exists but HH skips it). HH jumps to 5 (Dispatched) on item checkout. The OP treats inbound HH status 5 as `prepped`, and the separate `dispatched` (on hire) status is OP-only.*

**Status change API for external systems:**
```
POST /api/webhooks/external/status-transition
Headers: X-API-Key: {service_api_key}
Body: { hirehop_job_id, new_status, trigger, source, metadata }
```

**HireHop write-back:** Uses `POST status_save.php` with `no_webhook=1` to prevent loops.

## Pipeline Chase Model (May 2026)

**Read this before touching anything chase-related.** Re-introducing the bug we killed in May 2026 is easy if you don't know the rules.

### "Chasing" is a derived view, not a stored status

`pipeline_status` NEVER holds the value `'chasing'`. The Kanban's "Chasing" column is rendered from a server-derived flag `is_chasing` on each Job, computed as:

```
is_chasing = (next_chase_date <= CURRENT_DATE
              AND pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional'))
```

The legacy auto-mover scheduler is gone. Setting a future `next_chase_date` is enough to drop a card out of the Chasing pile on the next fetch — no status writes, no scheduler, no cleanup. When the date arrives, the card surfaces automatically.

The `'chasing'` value is kept in the `PipelineStatus` TypeScript union for legacy compatibility but is filtered out of selectable status dropdowns and the Zod enum on PATCH/POST. Migration 071 unwound every row that historically held it. Future migrations should NOT add `'chasing'` back.

### Daily 08:00 alert scanner (opt-in only)

`config/scheduler.ts` has a daily 08:00 task that fires bell/email notifications for jobs that have crossed their `next_chase_date` AND have an explicit `chase_alert_user_id` set (via the ChaseModal). No status writes. No admin-spray fallback. No info@ noise. Default behaviour for chase dates is silent — cards just appear in the Chasing pile.

This means: **chase dates are date-granular, not timestamp**. Anything with intra-day precision ("chase me in 2 hours") is not supported by the model. The "2 hrs" preset on the chase modal/forms was removed in May 2026 because it was misleading (it set today's date, not a 2-hour timer). Same-day chases are visible on the Kanban immediately but won't ping until the next 08:00 scanner run.

### Auto-bump rules — and the "sacred future" rule

Two paths automatically push `next_chase_date` forward:

1. **Enquiry → Provisional transition** (`pipeline.ts` PATCH `/:id/status`). When target is `provisional` from a pre-confirmed stage (`new_enquiry` / `quoting` / `paused`), bump by `chase_interval_days` (default 5).
2. **Contact-type interactions on a job** (`interactions.ts` POST). Types `call` / `email` / `meeting` bump by `chase_interval_days`. Types `note` and `mention` deliberately do NOT bump — notes are too varied (could be internal observations, not contact events) and mentions are internal collaboration.

**The sacred-future rule:** auto-bumps only fire when `next_chase_date` is null, today, or in the past. **Never shorten a future-dated chase.** A future date is a deliberate user decision (e.g. "chase Friday because client said they'd reply then") and must survive an unrelated email logged on Wednesday. Both code paths use:

```sql
next_chase_date = CASE
  WHEN next_chase_date IS NULL OR next_chase_date <= CURRENT_DATE
    THEN (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date
  ELSE next_chase_date
END
```

When you wire a new auto-bump source (e.g. for a new interaction type or status transition), use this CASE expression. Don't write a plain UPDATE.

### `skip_chase_bump` opt-out

The contact-type interaction path accepts `skip_chase_bump: true` on the request body to bypass the bump for that single call. The `ActivityTimeline` form surfaces this as a "Don't update chase date" checkbox, only shown when the type is call/email/meeting AND the entity is a job. Use for backdated entries (logging a call from last week) or non-consequential events (CC of an email thread that happens to be about something else).

### Chase-date clearing on lifecycle moves

`next_chase_date` is auto-nulled when a job moves to `confirmed` / `lost` / `cancelled` (`pipeline.ts` `/:id/status`). Same applies on inbound HireHop webhooks via `webhooks.ts`. Migration 070 was the historical backfill for jobs that had drifted before this rule landed.

### Watch list

If staff complain "my chase keeps moving when I don't want it to" → point them at the "Don't update chase date" checkbox.

If they complain "I logged a call but the chase didn't move" → it's the sacred-future rule. The chase was already future-dated; auto-bump correctly skipped it. They can manually reschedule via the chase modal if they actually want it shortened.

## Database Tables Overview

### Core (migration 001)
`people`, `organisations`, `person_organisation_roles`, `venues`, `interactions`, `users`, `external_id_map`, `picklist_items`, `notifications`, `audit_log`

### Jobs (migration 002-006)
`jobs` — synced from HireHop, pipeline fields (status, likelihood, chase dates, lost_reason)
`sync_log` — tracks automated sync runs

### Quotes & Transport (migration 007-009)
`quotes` — transport/delivery quotes linked to jobs, with calculated costs
`calculator_settings` — admin-editable pricing parameters
`vehicles` — fleet vehicles with fuel data
`quote_assignments` — crew/freelancer assignments per quote (role, rate, status)

### Email (migration 016)
`email_log` — audit trail for all outbound emails (template, recipient, status, mode)

### User Profiles (migration 023)
`users.avatar_url` — R2 key for profile photo
`users.force_password_change` — admin-set flag, prompts user on next login
`users.password_changed_at` — tracks when password was last changed

### System Settings (migration 072)
`system_settings` — generic key/text-value store for operational config (gate codes, addresses, URLs, feature toggles). Distinct from `calculator_settings` (DECIMAL only) and `picklist_items` (lists). Categorised via `category` column for UI grouping; admin/manager-editable from the Settings page. Read via `getSystemSetting(key)` / `getSystemSettings([keys])` helpers in `routes/system-settings.ts` (60-second in-process cache, invalidated on PUT).

Use this for any future "one global value" config — gate codes, default email signatures, URLs to shared docs, feature flags. Don't add new ad-hoc env vars when the value needs to be staff-editable without a deploy.

### Out-of-Hours Returns (migration 072 + 073)

End-to-end OOH return automation around the existing `vehicle_hire_assignments.return_overnight` flag. Per-van scope (one info email per vehicle, addressed to every driver on that van's assignments). Self-drive only — Ooosh-driven D&C deferred.

**Tracking columns on `vehicle_hire_assignments`:**
- `ooh_info_sent_at` — initial info email timestamp (idempotency)
- `ooh_reminder_sent_at` — day-before reminder timestamp
- `ooh_returned_at` — when the driver submitted the parking-confirmation form
- `ooh_parking_lat / ooh_parking_lng` — confirmed location (Traccar-prefilled, driver-confirmed)
- `ooh_parking_notes` — free-text notes
- `ooh_parking_token` — random token for the public parking-form URL

**Three trigger paths** (all in `services/ooh-return.ts`):
1. **Book-out**: `hire-forms.ts` PATCH detects `return_overnight=true` on a `booked_out` transition and fires `sendOohInfoEmailsForJob(jobId)` non-blocking.
2. **Day-before reminder**: scheduler at 10:00 daily, finds assignments with `hire_end = tomorrow` and `ooh_reminder_sent_at IS NULL`.
3. **Manual / toggle**: Job Detail > Drivers & Vehicles tab moon pill → `OohReturnModal` flips the flag and optionally fires (or resends) the email. Endpoint: `PATCH /api/ooh-return/assignments/:id/toggle` with `send_email_now`.

**Token validity is status-bound, NOT time-bounded.** `resolveParkingToken` rejects tokens whose assignment has flipped to `returned` or `cancelled`. This means OOH links work for any hire length and auto-expire on check-in — no TTL juggling.

**Public parking form** (`/return-parking/:token`, no auth, mounted outside `Layout`):
- Backend `routes/ooh-return.ts` exposes 3 public token endpoints (`by-token/:token` for context, `/prefill` for Traccar position, `/submit` for the write).
- Frontend `OohReturnParkingPage.tsx` renders Leaflet + OpenStreetMap (no API key needed) with the marker pre-positioned at the latest Traccar fix. Stale-position warning when fix > 30 min. Driver drags or taps to adjust + submits.
- `services/traccar-server.ts`: server-side Traccar lookup so the public page doesn't need a staff JWT proxy. 5-minute device cache.
- On submit: writes lat/lng/notes to assignment, logs an `📓 OOH return: …` interaction on the job timeline (`SYSTEM_USER_ID`), optionally emails `info@oooshtours.co.uk` per the `ooh_cc_info_email` setting.

**Settings keys (in `system_settings`, category `ooh_returns`):**
- `ooh_gate_code` (text), `ooh_yard_address`, `ooh_yard_maps_url`, `ooh_keydrop_photo_url`, `ooh_what3words`, `ooh_cc_info_email` (bool string)
- All edited via the "Out-of-Hours Returns" section of the Settings page (admin/manager only).
- Migration 073 dropped `ooh_overflow_photo_url` — the seafront mention in the email is plain text, no photo link.

**Discoverability:**
- Jobs list (`/api/hirehop/jobs`) returns `has_ooh_return` per row + accepts `?ooh_only=true`. JobsPage renders a 🌙 OOH only checkbox + a moon pill next to flagged job names.
- Dashboard "Returning Today" rows render a 🌙 OOH badge when any assignment on the job has `return_overnight=true`. Note: "Returning Today" includes `return_date = tomorrow`, so an OOH return where the driver drops the van TONIGHT for a 9am-tomorrow official return appears in tonight's list.
- Job Detail Drivers & Vehicles: per-card moon pill shows Yes/No/—, click to edit.

**Email templates** (in `email-templates/index.ts`):
- `ooh_return_info` — full instructions (gate code, yard address, key-drop, parking-form CTA). Sent at book-out + on manual resend.
- `ooh_return_reminder` — shorter T-1 day reminder, same parking-form CTA.
- `ooh_return_received_internal` — info@ alert when driver submits the parking form (when `ooh_cc_info_email` is true).

**Deferred / future:**
- Crewed and D&C (Ooosh-driven) van returns — toggle currently only renders for self-drive cards. Settings + email infra ready when scope expands.
- Daily summary email integration — when the daily summary template is built, it should query for OOH returns expected tonight/tomorrow and surface them.

## Dashboard (Today) — Section registry & extension points

The home dashboard (mounted at `/`, file `frontend/src/pages/DashboardPage.tsx`) is rebuilt around two extensible patterns. **All future modules that surface a "needs human action" signal or a per-job status pip should plug into these patterns rather than building a parallel surface on the dashboard.**

### Section registry — `frontend/src/components/dashboard/v2/`

| File | Purpose |
|---|---|
| `registry.ts` | The `SECTIONS` array — single source of truth for what blocks render and in what default order |
| `sections.ts` | `applyOrder()` helper + `DashboardSection` interface |
| `usePrefs.ts` | Density / theme / section-order persistence (localStorage now; backend column later) |
| `primitives.tsx` | `<Card>`, `<SectionHd>`, `<StatCard>`, `<Sparkline>`, `<ProgressStrip>`, `<ProgressBar>`, `<SegBar>` |
| `progress-strip.ts` | Frontend mirror of the per-job progress strip type contract |
| `sections/<Name>.tsx` | One file per section (Needs / Today / ComingUp / Operations / Pipeline / Activity) |

**Adding a new section** (e.g. "Carnets due", "Open damage cases"):

1. Build `sections/<YourSection>.tsx` accepting `DashboardSectionProps` (`{ data, backline, refresh }`). Use `<Card>` + `<SectionHd>` for visual consistency.
2. Add an entry to `SECTIONS` in `registry.ts` with a `defaultOrder` slot and `pinnable: true`.
3. If the section needs new aggregate data, extend `GET /api/dashboard/operations` (`backend/src/routes/dashboard.ts`) — keep the response shape backwards-compatible.
4. **Do not** build a separate "things to action" UI on the dashboard. Overdue / action items belong in `<NeedsAttention>` as a new bucket (see below).

### Per-job progress strip — extension contract

The Today block renders a 7-slot status strip per job (De-prep · Client · Excess · Freelancer · Invoicing · Payment · Vehicle). Mapping lives in `backend/src/services/job-progress-strip.ts` and is mirrored on the frontend in `frontend/src/components/dashboard/v2/progress-strip.ts`.

**Phase rule:** "Going Out Today" jobs render the `pre_hire` mapping; "Returning Today" jobs render the `post_hire` mapping. Slot 0's label changes per phase (Prep / De-prep).

**Status precedence (worst wins):** `prob > todo > wip > done > na`.

**Adding a new module to the strip:**

- **Option A — extend an existing slot.** If your new requirement type is conceptually part of an existing concept (e.g. a `damage_review` post-hire requirement → "Vehicle" slot), append the requirement_type string to the relevant slot array in `STRIP_MAPPING`. Worst-status precedence handles the merge.
- **Option B — add a new slot.** Add a `ProgressStripCategory` key, an entry in `STRIP_CATEGORY_LABELS` (per phase), and an entry in `STRIP_MAPPING`. Update the frontend mirror, the rendering order in `<ProgressStrip>`, and add a column to the future-module checklist (CLAUDE.md §11).

The slot resolves by fetching `job_requirements` rows and mapping `requirement_type → status`. To wire a new requirement type into the dashboard, you only need to (a) make sure the requirement type writes a row to `job_requirements` and (b) add it to `STRIP_MAPPING`.

### NeedsAttention buckets — extension contract

`<NeedsAttention>` (`sections/NeedsAttention.tsx`) is the canonical "things that need a human" surface. It has two rows:

- **Overdue (red):** Returns / Departures / Backline / Transport. Empty cards still render in this row when overdue total ≥ 1 (so layout doesn't shift as items resolve).
- **Secondary (amber/blue/purple):** Referrals / Excess (held unreimbursed) / Transport Introductions / Fleet Compliance. Cards in this row hide when count = 0 (and the whole row disappears if all four are empty).

When overdue total = 0, the overdue row collapses to a thin green "All clear" line and only the populated secondary cards render.

**Adding a new bucket:**

1. Extend `GET /api/dashboard/operations` to return the new bucket data under `needs_attention`.
2. Add a corresponding `NABucket` in `NeedsAttention.tsx` with the right accent (red for time-critical, amber for action-needed, blue for informational, purple for special category).
3. Add a `viewAllHref` to deep-link into the full list view for that bucket.

### Excess bucket semantics (Apr 2026, refined May 2026)

The `needs_attention.excess_*` fields mean "**money is actually held with us and the hire ended 5+ days ago**". Rule:

- `job_excess.excess_status IN ('taken', 'partially_paid')` — whitelisted, not blacklisted. `pre_auth` deliberately excluded (Stripe holds auto-release; pre-auth chasing belongs in its own scheduler — see TODO for pre-auth expiry scheduler). `needed` / `pending` excluded because they're "system thinks one is required" not "money is here".
- `jobs.pipeline_status IN (returned_incomplete, returned, completed)` OR `jobs.status IN (6, 7, 11)`
- `COALESCE(jobs.return_date, jobs.job_end) <= CURRENT_DATE - INTERVAL '5 days'`

Sorted oldest finished first. Replaces the earlier "excess awaiting collection" rule (we're good at taking excess up front, slack at returning it). The "needs collecting" gate signal still lives on `<ExcessGateBanner>` per-job.

**Important:** when adding a future "money-held" bucket, prefer whitelisting on `excess_status` over blacklisting. The status set has grown over time (`needed` was added by the derivation engine to seed pre-collection records; future statuses may be added too) and a blacklist accidentally includes them all. The May 2026 refinement caught the original bucket showing 41 "needed" derivation-created rows masquerading as held money.

### Transport Introductions bucket + chase-date clearing (May 2026)

Replaced the old "Chases Due" NeedsAttention bucket with **Transport Introductions** — surfaces transport quotes in the next 7 days where `client_introduction IN ('todo', 'working_on_it')` AND the linked job is `pipeline_status IN ('confirmed', 'prepping', 'prepped')`. Enquiries / provisional / dispatched / lost / cancelled all drop out.

Local D&C quotes default to `client_introduction = NULL` (rendered as "n/a") so they're naturally excluded. Full-calculator quotes default to `'todo'` (hardcoded in `routes/quotes.ts:278`). This is the deliberate split: anything further afield 9/10 needs a client intro, local stuff usually doesn't.

Click-through (per-item + "View all"): `/operations/transport?needs_intro=1` — TransportOpsPage has a `needsIntroOnly` filter pill mirroring the `needsCrewOnly` pattern, with URL param round-tripping.

**Chase-date clearing rule (companion change):** `next_chase_date` now nulls automatically on any pipeline transition out of an enquiry stage. Pre-confirmation stages where a chase is meaningful: `new_enquiry`, `quoting`, `chasing`, `paused`, `provisional`. Anything else clears the date.

Three write paths handle this:
1. `PATCH /api/pipeline/:id/status` — explicitly clears on `confirmed` (alongside `lost` and `cancelled` which already cleared it).
2. Both HH webhook handlers in `routes/webhooks.ts` — generic `enquiryStages` check applies to inbound HH status changes.
3. Migration `070_clear_stale_chase_dates.sql` — one-shot backfill for historical drift (jobs that had progressed to confirmed/dispatched/returned/completed before the clearing logic landed kept their stale chase dates, inflating the dashboard chase count with completed jobs).

The chases-due stat card (top of dashboard) is preserved — its count is now accurate because the underlying data is clean. Chases that genuinely need to happen post-confirmation belong to the reminders system, not the enquiry chase pipeline.

### On-hire sparkline (14 days)

`stat_cards.on_hire_spark` is a 14-element array (oldest first) computed by counting jobs where `out_date <= day AND return_date >= day` for each of the last 14 days. Cancelled / lost jobs and pre-deposit enquiries are excluded via status filter. No status-history table needed — derived from the existing date columns.

### Status filter alignment across dashboard surfaces

Multiple dashboard queries answer "what's going out / has gone out / is overdue to go out" — they MUST all use the same status filter or the headline stat card, the Today section, the Coming Up heat strip, and the Overdue Departures bucket disagree.

The canonical **"operationally pre-dispatch"** filter (May 2026):
```
(status IN (2, 3, 4) OR (status = 5 AND pipeline_status = 'prepped'))
AND pipeline_status NOT IN ('lost', 'cancelled')
```

The status-5+prepped clause is the OP↔HH semantic gap: HH jumps to status 5 the moment items get checked out, but OP holds `pipeline_status='prepped'` until staff clicks "Mark as Dispatched". A job in this state is physically prepped in the yard, hasn't actually rolled out the gate, and SHOULD count as "going out today" / "overdue if it hasn't left yet".

**Provisional (HH 1) and Enquiry (HH 0) are deliberately excluded.** No warehouse work should happen until a hire is actually booked (HH 2 = Booked). Stale enquiries / provisional are swept by the daily 09:00 stale-enquiry auto-lose scheduler — they don't surface as "overdue" warehouse work, they surface as a separate "auto-lost" log entry. Pre-May 2026 the operational filter included `status IN (1, ...)` and a small `pipeline_status NOT IN (lost, cancelled, ...)` blacklist, which let provisional + enquiry through; the backline page + dashboard overdue widgets started showing speculative work as "to-do" and "overdue" — fixed by tightening to the whitelist above.

Surfaces that use this filter:
- `going_out_count` stat card
- "Going Out Today" section query
- Overdue Departures bucket query
- Coming Up heat strip departures query
- Overdue Backline widget (dashboard) + `routes/backline.ts` overdue-out + going-out queries

When adding a new departure-related warehouse surface, use the same filter or the dashboard will visibly disagree with itself. The May 2026 refinement caught a 5-vs-3 mismatch between Today and Coming Up, plus a `prepped` job sitting overdue for 2 days that the Overdue Departures bucket missed entirely. The follow-up refinement (also May 2026, post BLK KACTUS / Chip Bernal report) dropped provisional from the same set of surfaces.

**Heads-up planning views** (e.g. `routes/backline.ts` `?include_provisional=true&include_enquiry=true`, `routes/quotes.ts` `/ops/overview` `?include_provisional=true&include_enquiry=true&include_lost=true&include_cancelled=true`) deliberately bypass the operational filter to surface speculative work in a separate visually-distinct bucket. Headline stats stay scoped to operational; unconfirmed jobs render below the main lists labelled "Provisional — Awaiting Deposit" / "Enquiries — Speculative" so warehouse staff can input on capacity without the speculative figures contaminating "remaining prep time" totals. New views adopting this pattern should follow the same shape: separate `unconfirmed: { provisional, enquiry }` block on the response (or for the quotes-overview style, return everything in one list with `pipeline_status` + `job_status` so the frontend can split it), opt-in via query params, frontend renders below operational sections with a "Not counted in headline stats" note. **Background scanners reading the same tables MUST gate on the same operational filter** — the page filter alone doesn't reach schedulers (e.g. `services/arranging-chaser.ts` was unfiltered until May 2026 and was emailing "needs arranging" reminders for unconfirmed jobs that hadn't even been booked).

### "Overdue returns" vs "Overdue completions" (May 2026)

Two distinct overdue concepts on the dashboard, easy to conflate, deliberately split:

- **Stat-card "Overdue returns"** = jobs that should physically be back. Filter: `status IN (4, 5) AND return_date::date < CURRENT_DATE`. Click-through: `/jobs?overdue=1` (Out Now filtered to overdue rows). The van is out, the return date has passed, it should be on the forecourt. Renders a red row + "⚠ Nd overdue" badge in the JobsPage Out Now section.
- **NeedsAttention bucket "Overdue Completions"** = jobs that came back but didn't get closed out. Filter: `status IN (6, 7, 8) AND return_date::date < CURRENT_DATE`. Click-through: `/jobs/returns?overdue=1`. The van's already returned (HH 6/7/8) but invoice / payment / excess / damage / etc. are still open with the return date receding into the past. Mostly an admin-overhead bucket.

Pre-May 2026 the bucket query was `status IN (1, 2, 3, 4, 5, 6, 8)` which conflated both meanings AND included stale enquiries (status 1-3 with old return_dates that were never going out). The narrow 6/7/8 query drops the noise and the rename ("Returns" → "Completions") makes the distinction explicit. Backend exposes the new bucket data under both `na.overdue_completions` (canonical) and `na.overdue_returns` (back-compat alias kept for one release; drop after).

When adding similar dashboard concepts, prefer two narrow buckets over one wide ambiguous one.

### Phase-aware progress bars (May 2026)

Per-job requirement progress is **phase-aware** to keep the bar meaningful for its surface:

- **JobsPage** (Going Out / Out Now / regular sections) reads `pre_hire` only — "is this hire ready to go".
- **ReturnsPage** (Returns & Completed) reads `post_hire` only — "is the close-out done".

Backend: `POST /api/requirements/bulk` accepts an optional `phase` body field (`pre_hire | post_hire`). Omitted = both (legacy callers get original behaviour). The previous "sum everything" mode was useless for either question — an Out Now job's bar was a 50/50 mix of "did I prep this properly" and "have I de-prepped/invoiced yet".

ReturnsPage now uses the same shaped progress **bar** as JobsPage (was per-requirement coloured **dots**). Drilling into a job still shows per-requirement detail on the Job Detail Overview tab.

## Files tab — actions registry (May 2026)

The Files tab on Job Detail (and the same `JobFilesTab` component reused on Person/Org/Venue detail pages) supports four per-file actions beyond download/delete. **Anything new touching files-on-entities should slot into the same pattern, not invent its own.**

| Action | Backend | Notes |
|---|---|---|
| **Toggle Share with freelancers** | `PATCH /api/files/update-metadata` (`share_with_freelancer`) | Existing flag the freelancer portal reads when filtering shared files |
| **Email file to recipients** | `POST /api/files/email` | Generic — any file type (PDF, JPG, etc.). Loads job contacts from `/api/hire-forms/email-contacts/:jobId` (reused for the picker — same shape: client org email, linked people, band/promoter contacts, HH contact-name match). Free-text "add another email" too. Mandatory "I'm sending externally" sanity tick before Send enables. STAFF_ROLES only. Logs an `email`-type interaction on the entity timeline. Uses the `file_resend` template. |
| **Edit tag / comment** | `PATCH /api/files/update-metadata` (`label`, `comment`) | Inline edit on the file row. Replaces the previous "set at upload time only" limitation. |
| **View** | (no backend — opens FileViewerModal) | Inline preview for images + PDFs |

**Backend endpoint contract for `POST /api/files/email`:**
```
{
  entity_type: 'jobs' | 'people' | 'organisations' | 'venues' | 'drivers',
  entity_id: uuid,
  file_url: string,                 // R2 key — must start with files/ or delivery-notes/
  recipients: [{ email, name? }],   // 1-10
  message?: string,                 // optional, max 2000 chars
  external_share_acknowledged: true // literal — request fails without it
}
```
Returns `{ success, sent, failed, results: [{ email, success, error? }] }`. Per-recipient sends are parallel via Promise.all. The R2 path-prefix check (`files/` or `delivery-notes/`) prevents anyone passing a key from outside the file system (e.g. a backup key).

**Frontend component:** `frontend/src/components/FileEmailModal.tsx` — currently wired into `JobFilesTab` only. To enable on Person/Org/Venue detail pages later, mount the same modal with `entityType` set appropriately. The contact picker is hidden for non-job entities (the picker logic lives in `/api/hire-forms/email-contacts/:jobId` which is job-scoped); free-text recipient entry still works.

**Email template:** `file_resend` in `email-templates/index.ts`. Plain-text variables only (the substituter HTML-escapes), so optional sections like the message body and job ref line are composed in the caller as either a real string or `''`.

**Why no automatic CC/BCC of internal team:** explicit recipient list keeps the audit trail clean — every send shows up as one interaction with a known target list. If staff want a record they pick `info@oooshtours.co.uk` themselves.

## Architecture Notes

- **Frontend talks to backend** via `/api/*` — Nginx proxies API requests to Express (port 3001)
- **Auth flow:** Login → JWT access token (short-lived) + refresh token → stored in Zustand store (`useAuthStore`), sent as `Authorization: Bearer` header
- **Database:** All IDs are UUIDs. `created_by` on most tables is VARCHAR (seed value), but `interactions.created_by` is a UUID FK to `users(id)`
- **Migrations:** Sequential numbered SQL files, **hardcoded list in `run.ts`** — new migrations must be added to the array manually!
- **Navigation:** Two-level nav with "Address Book" (People, Organisations, Venues) and "Jobs" (New Enquiry, Enquiries, Upcoming & Out, Returns) submenus
- **Job Detail tabs:** Overview (details + notes with inline editing) | Activity Timeline | Crew & Transport | Drivers & Vehicles | Money | Files

## Important Conventions

- Email domain is `@oooshtours.co.uk` (not @ooosh.co.uk)
- The `people` table is the central entity — users, freelancers, contacts are all people first
- `person_organisation_roles` junction table tracks relationships with dates and role metadata
- Frontend uses Tailwind CSS for styling
- API responses follow `{ data, pagination }` or `{ error }` patterns
- **Migration runner has a hardcoded file list** — when adding a new migration, you MUST also add the filename to the `migrations` array in `backend/src/migrations/run.ts`
- **Detail pages must reset tab state on `id` change.** React Router reuses the same component instance across `/jobs/A` → `/jobs/B`, so `useState(initialTab)` only initialises once and the active tab "drags across" to the new entity. Every `*DetailPage` with tabs needs a `useEffect(() => setActiveTab(default), [id])`. Currently applied on Job, Driver, Person, Organisation, Venue, Vehicle. Add the same pattern to any new detail page (and clear per-tab caches in the same effect if the tabs hold previously-loaded data, e.g. DriverDetailPage clears `hireHistory` / `excessHistory` on driver switch).
- **`vehicle_hire_assignments` is soft-cancel only.** Every removal path in the application sets `status = 'cancelled'` rather than physically deleting the row. `DELETE /api/assignments/:id`, the cancellation flow, lost-cleanup, swap-vehicle — all soft. There is **no `DELETE FROM vehicle_hire_assignments` anywhere in the codebase**, and there shouldn't be: the row is the source of truth for an actual hire that physically happened, so destroying it loses audit trail (book-out/check-in events in R2 still reference it). If a future Claude needs to "remove" an assignment, soft-cancel is the path. The same applies to `job_excess` and the broader hire-tracking chain — soft state changes preferred over physical deletion. (See May 2026 incident: HH job 15862 had its `vehicle_hire_assignments` row hard-deleted out from under it by direct SQL during an earlier cleanup pass; we had to rebuild the row from the R2 book-out event so the weekend team could check the van back in normally. Soft-cancel would have avoided that whole detour.)
