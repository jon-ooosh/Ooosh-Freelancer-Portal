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
│   │   │   ├── quotes.ts      # Transport quotes CRUD, calculator settings, crew assignments
│   │   │   ├── dashboard.ts   # Dashboard stats/metrics
│   │   │   ├── search.ts      # Global search
│   │   │   ├── users.ts       # User/team management
│   │   │   ├── files.ts       # File uploads (R2)
│   │   │   ├── notifications.ts
│   │   │   ├── backups.ts     # Database backup management
│   │   │   ├── email.ts       # Email service admin endpoints
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
│   │   │   ├── crew-transport-calculator.ts # Delivery/collection/crewed cost engine
│   │   │   ├── hirehop-broker.ts          # Centralised HireHop API gateway (rate limit, cache, queue)
│   │   │   ├── email-service.ts           # Email sending with SMTP, templates, test mode, audit
│   │   │   └── email-templates/           # HTML email templates (base layout + per-template)
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
│       │   └── DuplicatesPage.tsx
│       ├── components/
│       │   ├── Layout.tsx              # Nav with "Address Book" and "Jobs" submenus
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

#### Step 2: Driver Hire Forms & Excess Calculation
Driver hire forms calculate the insurance excess amount based on DVLA record points.

- [ ] Driver hire form process in OP (captures DVLA data, calculates excess)
- [ ] Excess amount flows into job record
- [ ] Links to vehicle assignment on the job

#### Step 3: Insurance Excess Tracking
Financial lifecycle tracking for insurance excesses — NOT a pipeline status, but a **gate condition** (can't move to "Out" without excess collected).

- [ ] `job_excess` table or fields on jobs:
  - `excess_amount_required` — calculated from hire form
  - `excess_amount_taken` — what we've actually collected
  - `excess_status` — `pending` | `taken` | `partial_claim` | `full_claim` | `reimbursed`
  - `excess_taken_method` — `payment_portal` | `manual` | `bank_transfer`
  - `excess_xero_contact` — Xero contact cemented at creation (won't change even if HH client name changes)
  - `excess_client_name` — current client name (may differ from Xero contact)
- [ ] Manual excess recording (not everything goes through payment portal)
- [ ] Excess gate on job status: block "Upcoming → Out" if excess not collected
- [ ] Client excess ledger — running balance per client across multiple hires (repeat clients leave excess with us)
- [ ] Excess claim/reimbursement workflow
- [ ] HireHop records excess as a deposit — sync this data

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
- [ ] **Tasks system** — general-purpose task management (not tied to specific jobs)
  - Freelancer application review workflow
  - Annual licence/detail review reminders
  - General admin tasks
  - Linked optionally to person_id or job_id
- [ ] Win/loss analysis dashboard (depends on pipeline — lost_reason basics included in pipeline)
- [ ] Job close-out workflow
- [ ] Command Centre dashboard (live data from jobs + contacts)
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
- [x] RBAC middleware (`authorize()`) on sensitive routes
- [x] JWT_SECRET required via env var (no default fallback) — app won't start without it
- [x] Startup validation: JWT_SECRET must be set and ≥32 characters, DATABASE_URL required
- [x] Rate limiting on login (10 attempts per 15 min per IP) and token refresh (20 per 15 min)
- [x] Logout endpoint (`POST /api/auth/logout`) — nulls refresh token
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
