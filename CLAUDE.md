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
│   │   │   ├── hirehop-job-sync.ts         # HireHop job sync (read-only)
│   │   │   ├── hirehop-writeback.ts        # Push pipeline changes to HireHop
│   │   │   ├── crew-transport-calculator.ts # Delivery/collection/crewed cost engine
│   │   │   ├── hirehop-broker.ts          # Centralised HireHop API gateway (rate limit, cache, queue)
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
│       │   ├── JobsPage.tsx / JobDetailPage.tsx    # Job detail has tabs: Details, Activity, Crew & Transport
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
git pull origin <current-branch>
cd backend && npm run build
cd ../frontend && npm run build
sudo systemctl restart ooosh-portal
sudo systemctl status ooosh-portal
```

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
  - [x] Phase D: Supporting UI (new enquiry form with file staging, chase logging with quick-select & alerts, HireHop links, inline file viewer)
  - [x] Phase E: HireHop write-back (push status changes to HH via webhooks + write-back service)
  - [ ] Phase E.2: Create HH jobs from Ooosh (deferred)
- [x] **File management** — authenticated upload/download, inline viewer (images + PDFs), file tags & comments
- [x] **Enquiry/Quoting merge** — New Enquiry + Quoting merged into single "Enquiries" column
- [x] **Chase auto-mover** — runs every 15 minutes via `config/scheduler.ts`, moves jobs with `next_chase_date <= NOW()` to "chasing" pipeline status, logs status_transition interactions
- [x] **Delivery/collection calculator** — full transport quoting tool (see Crew & Transport section below)
- [x] **Crew assignments** — assign people to quotes with role, rate, status tracking (migration 008)
- [x] **Quote status workflow** — draft → confirmed → completed/cancelled with audit trail (migration 008)
- [x] **Navigation restructure** — "Address Book" submenu (People, Organisations, Venues) + "Jobs" submenu (Enquiries, Upcoming & Out)

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

**Phase B — AI Document Extraction** (deferred — nice-to-have, end of build)
- [ ] POST /extract endpoint: upload invoice/service record → Claude extracts fields → returns JSON
- [ ] "Upload & Extract" mode in service record form — preview extracted data, user confirms
- [ ] Future: receipt uploader integration (general receipts with "is this for a van?" routing)

See **Vehicle Module Integration** section below for technical details.

#### Step 2: Driver Hire Forms & Excess Calculation ← PHASE C IN PROGRESS
Driver hire forms calculate the insurance excess amount based on DVLA record points.
See `docs/DRIVER-HIRE-EXCESS-SPEC.md` for full spec.

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
- [ ] **`monday-integration.js` `copy-a-to-b` action** — needs updating for OP mode: must call `POST /api/hire-forms` with driver data + excess amount from DVLA check. Currently sends data that doesn't match the schema (was returning 400).
- [ ] **`SignaturePage.js`** — after successful `copy-a-to-b` in OP mode, needs to trigger `generate-hire-form.js` directly (no Monday.com automation to trigger it)
- [ ] `generate-hire-form.js` (v5.6) → `GET /api/hire-forms/:id` + `POST /api/files` (logo still from Monday.com templates board) — verify `fetchDriverDataFromOP` handles null vehicle_reg gracefully

*Phase C4: Go-live cutover:*
- [x] Set env vars on OP server (`HIRE_FORM_VERIFICATION_SECRET`, `HIRE_FORM_API_KEY`) — confirmed present
- [x] Run migration 020 on production (`npm run db:migrate`) — done
- [ ] Fix `monday-integration.js` copy-a-to-b + SignaturePage trigger (see Phase C3 above)
- [ ] Test end-to-end with `DATA_BACKEND=op` on Netlify deploy preview
- [ ] Flip `DATA_BACKEND=op` on Netlify production
- [ ] Monitor for 1-2 weeks, then remove Monday.com fallback code

**Phase D — Allocations Migration** ✅ MOSTLY COMPLETE
- [x] Switch AllocationsPage to read from `vehicle_hire_assignments` (compat layer)
- [x] Keep compatibility API for existing book-out/check-in flows
- [x] Book-out flow: driver selection from hire forms, token refresh, draft autosave
- [ ] Remove R2 allocation writes (R2 becomes read-only fallback)

#### Step 3: Insurance Excess Tracking
Financial lifecycle tracking for insurance excesses — NOT a pipeline status, but a **gate condition** (can't move to "Out" without excess collected).

**Database layer** ✅ COMPLETE (built in Step 2 Phase A)
- [x] `job_excess` table with full financial lifecycle fields
- [x] `excess_rules` table (configurable points tiers + referral triggers)
- [x] `client_excess_ledger` view (running balance per Xero contact)
- [x] Excess CRUD + payment/claim/reimburse/waive endpoints (`excess.ts`)

**Phase E — Excess Gate + Ledger UI** (after Phase D)
- [ ] Excess gate UI — warning banners on Job Detail when excess pending
- [ ] Wire gate into status transition engine (block dispatch)
- [ ] Excess ledger page (`/excess`) — client balances, history, actions
- [ ] Payment recording UI (record payment, claim, reimburse)
- [ ] HireHop excess-as-deposit sync

#### Step 4: Status Transition Engine ← MOSTLY COMPLETE
Bidirectional job status sync — depends on excess tracking for gate conditions.

- [x] `POST /api/webhooks/external/status-transition` endpoint for external systems
- [x] HireHop write-back via `status_save.php` (with `no_webhook=1`) — `hirehop-writeback.ts` service
- [x] API key / service auth for external callers (`api_keys` table)
- [x] HireHop → Ooosh: inbound webhook receiver (`POST /api/webhooks/hirehop`) with export_key verification
- [x] Ooosh → HireHop: write-back on pipeline status changes (with loop prevention)
- [x] Pipeline ↔ HireHop status mapping (see Status Mapping section)
- [x] Webhook logging (`webhook_log` table, migration 018)
- [ ] Status mismatch detection in existing sync (backup)
- [ ] Gate conditions: check excess collected before allowing dispatch

#### Step 5: Payment Portal Repointing
Repoint payment portal from Monday.com → Ooosh status-transition API.

- [ ] Payment portal calls Ooosh webhook instead of Monday.com
- [ ] Excess payment events recorded in Ooosh (financial record, not pipeline change)
- [ ] Payment confirmation → pipeline status change (deposit = confirmed)

#### Step 6: Operations Modules (Hire Readiness) ← STREAM 1 FOUNDATION MOSTLY COMPLETE

**Architecture:** Each confirmed job gets a **Prep Checklist** (the new default tab on Job Detail, replacing the old Overview). Each checklist item is a *requirement* — things that need doing before a job can go out. Requirements link into deeper per-job tabs, global overview pages, or expand inline for simple items.

**Key design decisions:**
- Prep Checklist = the job-level dashboard. Always the first tab you see.
- Status system is **non-linear** (any status → any status), styled like pipeline badges (rectangular, coloured).
- Each requirement type has its **own status flow** (not a global linear flow). E.g. Merch: "Request sent → Some received → All received → Notified client → Given to client".
- **Templates** for common job types (one click adds multiple requirements).
- **Dashboard** (`/dashboard`) is the global overview — aggregates all outstanding items across all jobs.
- **Freelancer portal integration** — crew assignments, delivery jobs, studio sitter assignments all need to be readable/writable from the freelancer portal (currently reads from Monday.com, needs repointing to OP).

##### Stream 1: Core Requirements System (FOUNDATION — do first)
- [x] `job_requirements` table + migration (migration 021)
- [x] Requirements API: CRUD, non-linear status changes, templates
- [x] Wire Prep Checklist to real data (replace dummy prototype)
- [x] Replace Overview tab with Prep Checklist as default job tab (now called "Job Requirements")
- [x] Non-linear status badges (styled like pipeline status dropdowns)
- [x] Progress indicators on Jobs list page + Pipeline kanban cards (real data via bulk endpoint)
- [ ] Deposit/payment progress bar on Prep Checklist (visual: deposit taken vs full fee)
- [ ] "Compare" function: what we've said we need vs what HH tells us (flag discrepancies)

##### Stream 2: Global Operations Dashboard
Aggregate views on the Dashboard page — click through to individual jobs from each widget.
- [ ] Transport overview widget: all jobs with transport needs, who's driving, when, where
- [ ] Crew overview widget: who's assigned where this week, availability gaps
- [ ] Backline overview widget: jobs with backline, prep status
- [ ] Incoming deliveries widget: what's arriving today across all jobs
- [ ] Carnet overview widget: outstanding carnets, return tracking
- [ ] Lost property widget: uncollected items with age
- [ ] Studio/rehearsal schedule widget: upcoming rehearsals, studio sitter assignments
- [ ] Payment summary widget: deposits pending, balances outstanding
- [ ] Hook into freelancer portal (repoint from Monday.com read/write to OP API)

##### Stream 3: Backline + Sub-hires Module
- [ ] `job_backline` table (job_id, status, notes, item_count, checked_out_count)
- [ ] `job_subhires` table (what, supplier, status, cost, po_ref, due_date, received)
- [ ] Backline status flags: not started / in progress / prepped / checked out / returned / issues
- [ ] Backline issues tracking (missing items, damage — similar pattern to vehicle issues)
- [ ] Sub-hire tracking: need → sourcing → ordered → received → returned
- [ ] Per-job sections + global backline board view
- [ ] Optional HH integration: pull item counts from `job_data.php` to auto-populate (if API supports checked-out counts)

##### Stream 4: Incoming Deliveries + Lost Property
- [ ] `incoming_deliveries` table (job_id, description, expected_date, box_count, received_count, status, sender_name)
- [ ] Support for "mystery boxes" — record arrival with unknown association, link to job/client later
- [ ] Status flow: expected → some received → all received → notified client → given to client
- [ ] `lost_property` table (job_id, description, found_date, found_location, photo, client_notified, collected, dispose_after)
- [ ] Auto-reminder: chase client to collect, flag for disposal after X weeks
- [ ] Global pages for both: `/operations/deliveries`, `/operations/lost-property`

##### Stream 5: Rehearsals Module
- [ ] `rehearsals` table (job_id, venue, date_start, date_end, studio_sitter_id, setup_specs, sound_files, status)
- [ ] Studio sitter assignment (links to people table, freelancer portal integration)
- [ ] Room prep method (similar to vehicle prep checklist)
- [ ] Handover tracking: evening studio sitters → daytime staff
- [ ] Issues tracking (similar to vehicle issues)
- [ ] Band setup specs + sound file uploads
- [ ] Studio schedule global view (`/operations/rehearsals`) — calendar/timeline format
- [ ] Freelancer portal integration: push rehearsal assignments to studio sitters

##### Stream 6: Payment Tracking (pre-Xero)
Per-job financial tracking, summarised on Dashboard rather than its own global page.
- [ ] `job_payments` table (job_id, type: deposit/balance/refund, amount, method, status, date, reference)
- [ ] Per-job payment summary on Prep Checklist (progress bar: deposit → balance → paid in full)
- [ ] Client payment terms on `organisations` table (upfront / credit / credit up to £X)
- [ ] Address Book UI for managing client payment terms
- [ ] Payment status feeds into gate conditions (deposit required before dispatch)
- [ ] Dashboard payment summary widget (deposits pending, balances outstanding across all jobs)

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
- [x] Inline crew assignment on Transport Ops page (same picker as Job Detail, bidirectional)
- [x] Local D/C form improvements: venue address book lookup, smart date defaults, amber warning on change
- [x] Quote editing: Edit Quote modal on Transport Ops page + Job Detail page (venue, date, time, fees, notes)
- [x] Inline-editable arranging details: client intro status picker, key points, tolls/accom/flights clickable pills, notes
- [x] Run grouping UI: letter-based display (Run A/B/C), coloured side bands, join/create run buttons per job
- [x] Colour-matched status dropdown (replaces plain select)
- [x] Completion details view: photos, signature, timestamp, customer present, notes
- [x] Separate completed/cancelled toggles
- [ ] Reminder system (unassigned deliveries approaching, overdue completions)
- [ ] Change notifications to freelancers (date/time/venue changes → email alert)
- [ ] Issues on road reporting (breakdowns, delays, problems)
- [ ] PDF delivery note generation (migrate from Netlify function to OP backend)
- [ ] Client delivery note emails via OP email service
- [ ] Invoice comparison (freelancer invoice vs expected cost, overcharge flagging) — nice-to-have, post go-live
- [ ] **Arrangement pills → dashboard integration**: Surface arrangement statuses on Dashboard and Job Requirements
  - Dashboard widget: "X jobs in next 7 days need client intros" (query `client_introduction = 'todo'` where `job_date` within 7 days)
  - Dashboard widget: "X jobs with outstanding tolls/accommodation/flights" (query `*_status = 'todo'` on active quotes)
  - Job Requirements integration: arrangement items auto-create as requirements on prep checklist
  - Freelancer portal: show arrangement status in job details (e.g. "accommodation: booked")
  - Notifications: auto-alert when job approaching and arrangements still outstanding
- [ ] **Run group pricing**: Combined run pricing (individual prices crossed through, single run total displayed)
- [ ] **Run group → freelancer portal alignment**: Ensure run groups display correctly as multi-drop runs in portal (group by run_group UUID + date, ±4h tolerance for overnight grouping)

##### Carnets (inline on Prep Checklist, with global overview)
- [ ] Carnet fields on `job_requirements` with step tracking: applied → received → items listed → stamped out → returned → closed
- [ ] Global carnet overview page (`/operations/carnets`) — outstanding carnets, post-hire returns pending
- [ ] Reminder automation: chase for return after hire ends

**Parallelisation notes:** Streams 2-7 can all run simultaneously — they touch different tables, routes, and pages. Stream 1 is the foundation and should complete first (or at least the migration + API), as Streams 2-7 plug requirements into it. Streams 3-5 are fully independent of each other. Stream 6 has a dependency on the organisations table (payment terms) but is otherwise standalone.

#### Pipeline & Enquiry Cleanup ← IN PROGRESS

Two streams of work to improve the pipeline/enquiry/jobs experience:

**Stream A: Job Detail Editing** (next chunk after Stream B)
The Job Detail page needs inline editing for key fields. Currently status changes are Kanban-only and most fields are read-only.
- [ ] **HH Job Number** — Where it says "NEW", make clickable/editable. Accept pasted HH URLs (`https://myhirehop.com/job.php?id=15564`) and extract the number. Once linked, sync takes over.
- [ ] **Dates** — Reuse the four-date linked editor from New Enquiry form (Outgoing↔Job Start, Returning↔Job Finish toggleable links, date constraints enforced)
- [ ] **Client** — Editable with org/person search picker
- [ ] **Job name** — Inline editable
- [ ] **Pipeline fields** — Likelihood, next chase date, job value — all inline editable on Job Detail
- [ ] **Create in HireHop** button — Push Ooosh-native enquiry to create HH job, write back the number (follow-up after initial editing)

**Stream B: Band-Centric Data Model** ← ACTIVE
Organisation-to-organisation relationships and multi-org job links. Makes "bands" a first-class concept.
- [x] Migration: `organisation_relationships` table (org-to-org links with typed relationships: manages, books_for, does_accounts_for, promotes, supplies)
- [x] Migration: `job_organisations` junction table (band, client, promoter, venue_operator, supplier roles per job)
- [x] Backend: Org relationships CRUD endpoints
- [x] Backend: Job-organisation links CRUD endpoints
- [x] Frontend: "Relationships" section on Organisation Detail page (add/remove/view linked orgs with bidirectional display)
- [x] Frontend: Band/org links on Job Detail page (add band, client, promoter etc.)
- [x] Frontend: Band picker on New Enquiry form with org search
- [x] Person-to-org role picker (dropdown instead of free text) with standard roles
- [x] End role confirmation dialog with optional reason and repoint flow
- [ ] Frontend: Person context surfacing in pickers (show org connections when selecting a person)
- [ ] Frontend: Smart suggestions from org graph (select band → auto-suggest management company as client)
- [ ] Org-to-org relationship types: manages↔managed_by, books_for↔booked_by, does_accounts_for↔accounts_done_by, promotes↔promoted_by, supplies↔supplied_by
- [ ] Person-to-org role types (already exist, confirm complete): Tour Manager, Manager, Production Manager, Engineer, Accountant, Promoter, Crew, Band Member, Driver

**Stream C: HireHop Data Cleanup** (depends on Stream A "Create in HireHop" button)
HireHop sync imported contacts literally — bands became people, management companies got typed as "client", etc.
The cleanup strategy is: OP becomes master for relationship data, HH gets what it needs via push.

*Step 1: OP→HH job creation* (part of Stream A)
- [ ] `POST /api/pipeline/:id/push-hirehop` — create job in HH via `job_save.php` API
- [ ] Map OP fields → HH: contact person → `name`, client org → `company`, dates → `out`/`start`/`end`/`to`, job name → `job_name`, details → `details`
- [ ] Write back HH job number to OP `jobs.hh_job_number`
- [ ] Include `no_webhook=1` to prevent sync loops
- [ ] Band stays in OP only (HH has no band field)

*Step 2: Sync guard rails*
- [ ] HH contact sync: when Contact Name matches existing *organisation* (not person), flag as conflict → "needs review" queue
- [ ] HH job sync: never overwrite OP-enriched org types or relationships
- [ ] Surface "needs review" items on Dashboard or Settings page

*Step 3: Data cleanup tools*
- [ ] "Convert Person to Organisation" — reclassify a person as an org (e.g. "10cc" person → "10cc" band org), preserve relationships
- [ ] "Merge duplicates" — merge person+org that represent the same entity
- [ ] Bulk type correction — change org types (e.g. all "client" orgs that are actually bands)
- [ ] "Needs review" page for sync conflicts

*Step 4: Smart relationship suggestions*
- [ ] When viewing a "Contact" at a "client" org, system suggests: "Is this actually a Band?"
- [ ] When new HH sync creates entities, surface for review before they pollute the graph

#### Remaining Phase 2 work (no strict ordering)

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
- [ ] **Tasks system** — general-purpose task management (not tied to specific jobs)
  - Freelancer application review workflow
  - Annual licence/detail review reminders
  - General admin tasks
  - Linked optionally to person_id or job_id
- [ ] Win/loss analysis dashboard (depends on pipeline — lost_reason basics included in pipeline)
- [ ] Job close-out workflow
- [ ] Xero financial summary integration

### External Tools (already built, need repointing from Monday.com → Ooosh API)

These are existing standalone tools that currently push to Monday.com. They need repointing to our status-transition API when ready (Step 5 above):

- **Payment Portal** — Stripe payment processing, currently updates Monday.com. HIGH PRIORITY to repoint (after Steps 1-4).
- **Staging Calculator** — stage/riser quoting tool (standalone, low priority)
- **Backline Matcher** — match client requirements to inventory (standalone, low priority)
- **Cold Lead Finder** — Ticketmaster API integration (standalone, low priority)

### Future Enhancements (captured, not scheduled)

- Crew availability calendar (check if freelancer is already assigned to overlapping dates)
- Skills-based crew matching (auto-suggest freelancers with matching skills for job type)
- Freelancer application inbound form (public form → creates person with `is_freelancer=true`, `is_approved=false`, generates review task)
- **Mileage-based service threshold notifications** — add to daily compliance check, alert when vehicle within configurable miles of `next_service_due`
- **Email notifications** — add SMTP/transactional email channel alongside in-app bell notifications (needs email service config)
- **Per-user notification preferences** — allow users to opt in/out of specific notification categories (compliance, chase reminders, etc.)
- **Freelancer portal repointing** — switch freelancer-facing app from Monday.com read/write to OP API for crew assignments, delivery jobs, studio sitter assignments, hire form status

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
  - In test mode: ALL emails redirect to `EMAIL_TEST_REDIRECT` address
  - Test emails include banner: "TEST MODE — would have been sent to: client@example.com"
  - One-click admin toggle in Settings page to switch to live
- **Audit trail:** Every email logged to `email_log` table (recipient, template, sent_at, status)
- **No unsubscribe:** These are transactional/operational emails, not marketing

**Environment variables:**
```
EMAIL_MODE=test                           # 'test' or 'live'
EMAIL_TEST_REDIRECT=jon@oooshtours.co.uk  # Where test emails go
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

## Security

### Current Security Posture (as of 15 Mar 2026)

**Authentication & Authorization:**
- [x] JWT access tokens (15 min) + refresh tokens (7 days)
- [x] Bcrypt password hashing (12 salt rounds)
- [x] RBAC middleware (`authorize()`) on sensitive routes — 6 roles: `admin`, `manager`, `staff`, `general_assistant`, `weekend_manager`, `freelancer`
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
      { path: '/pipeline', label: 'Enquiries' },
      { path: '/jobs', label: 'Upcoming & Out' },
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
| HireHop job sync | Every 30 minutes | Pull active jobs from HireHop |
| Chase auto-mover | Every 15 minutes | Move overdue-chase jobs to "chasing" column |

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
- **Webhooks (Phase 2):** Real-time bidirectional sync via HireHop webhooks (live 16 Mar 2026)
  - Inbound: `POST /api/webhooks/hirehop` — receives `job.status.updated`, `job.updated`, `job.created`, `contact.*`
  - Outbound: `hirehop-writeback.ts` — pushes pipeline status changes back to HireHop
  - Polling sync still runs as fallback every 30 min
- Config: `backend/src/config/hirehop.ts`
- Contact sync: `backend/src/services/hirehop-sync.ts`
- Job sync: `backend/src/services/hirehop-job-sync.ts`
- Write-back: `backend/src/services/hirehop-writeback.ts`
- Webhooks: `backend/src/routes/webhooks.ts`
- Routes: `backend/src/routes/hirehop.ts`

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
- **Add note:** `https://{domain}/api/job_note.php?job={id}&note={text}&token={token}` (GET)

## Pipeline ↔ HireHop Status Mapping

| Ooosh Pipeline Status | HireHop Code | HH Name | Trigger Examples |
|---|---|---|---|
| `new_enquiry` | 0 | Enquiry | New enquiry created |
| `quoting` | 0 | Enquiry | Quote being prepared (HH stays Enquiry) |
| `chasing` | 0 | Enquiry | Following up (HH stays Enquiry) |
| `paused` | 0 | Enquiry | Paused enquiry (HH stays Enquiry) |
| `provisional` | 1 | Provisional | Awaiting deposit / held pending |
| `confirmed` | 2 | Booked | Deposit/full payment received |
| `lost` | 10 | Not Interested | Client declined |
| _(cancelled)_ | 9 | Cancelled | Job cancelled after booking |

**Status change API for external systems:**
```
POST /api/webhooks/external/status-transition
Headers: X-API-Key: {service_api_key}
Body: { hirehop_job_id, new_status, trigger, source, metadata }
```

**HireHop write-back:** Uses `POST status_save.php` with `no_webhook=1` to prevent loops.

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

## Architecture Notes

- **Frontend talks to backend** via `/api/*` — Nginx proxies API requests to Express (port 3001)
- **Auth flow:** Login → JWT access token (short-lived) + refresh token → stored in Zustand store (`useAuthStore`), sent as `Authorization: Bearer` header
- **Database:** All IDs are UUIDs. `created_by` on most tables is VARCHAR (seed value), but `interactions.created_by` is a UUID FK to `users(id)`
- **Migrations:** Sequential numbered SQL files, **hardcoded list in `run.ts`** — new migrations must be added to the array manually!
- **Navigation:** Two-level nav with "Address Book" (People, Organisations, Venues) and "Jobs" (Enquiries/Pipeline, Upcoming & Out) submenus
- **Job Detail tabs:** Details | Activity | Crew & Transport

## Important Conventions

- Email domain is `@oooshtours.co.uk` (not @ooosh.co.uk)
- The `people` table is the central entity — users, freelancers, contacts are all people first
- `person_organisation_roles` junction table tracks relationships with dates and role metadata
- Frontend uses Tailwind CSS for styling
- API responses follow `{ data, pagination }` or `{ error }` patterns
- **Migration runner has a hardcoded file list** — when adding a new migration, you MUST also add the filename to the `migrations` array in `backend/src/migrations/run.ts`
