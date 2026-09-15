<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
Superseded by the trimmed CLAUDE.md for day-to-day use; kept as the original record
of the repository structure, deployment playbook and Phase 1 / early Phase 2 history.
-->

# Original CLAUDE.md preamble — repo structure, deployment playbook, Phase 1 history

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
# IMPORTANT: install deps before building. `npm install` is fast/no-op when
# nothing changed, but a PR that added a dependency (e.g. qrcode.react in the
# pre-auth PR 3, May 2026) will fail the build with "Cannot find module ..."
# if you skip this. The full deploy.sh always installs; this manual path must too.
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build
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

- [x] **HireHop job sync (read-only pull)** — jobs table, sync service, API routes
  - Automated: runs every 30 minutes via `config/scheduler.ts`
  - Logged to `sync_log` table with status tracking
  - **⚠️ `job_value` is NOT written by the sync (fixed Jul 2026 — do not reintroduce).** HireHop's `MONEY` field from `search_list.php`/`job_data.php`/webhook payloads is empty/0 for most jobs; for months the sync blindly copied it over `jobs.job_value`, clobbering the cached display value back to £0 every 30 minutes (Money-tab visits kept "fixing" it, sync kept re-zeroing — the tug of war behind the "client history values revert to £0" report, Jul 2026). `job_value` is owned by the billing-accrued path: Money tab `/summary` side-effect (instant per-job self-heal) + `services/job-value-sync.ts` gap-filler (hourly scheduler at :40, 20 jobs/pass; also behind `POST /api/money/sync-values`). One-shot repair: `backend/src/scripts/backfill-job-values.ts` (dry-run default, `--commit`). Any future sync/webhook field-mapping work MUST leave `job_value` alone.
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
