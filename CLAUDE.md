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

**Server:** Hetzner CAX11 (2 vCPU, 4GB RAM) at `49.13.158.66`
**Domain:** Not yet configured (accessing via IP)

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
│   │   │   ├── dashboard.ts   # Dashboard stats/metrics
│   │   │   ├── search.ts      # Global search
│   │   │   ├── users.ts       # User/team management
│   │   │   ├── files.ts       # File uploads (R2)
│   │   │   ├── notifications.ts
│   │   │   ├── backups.ts     # Database backup management
│   │   │   └── health.ts
│   │   ├── config/
│   │   │   └── hirehop.ts  # HireHop API configuration
│   │   ├── services/
│   │   │   ├── hirehop-sync.ts      # HireHop contact sync (read-only)
│   │   │   └── hirehop-job-sync.ts  # HireHop job sync (read-only)
│   │   ├── middleware/      # Auth, RBAC, validation
│   │   ├── migrations/     # PostgreSQL migrations
│   │   │   ├── 001_foundation.sql
│   │   │   ├── 002_jobs.sql
│   │   │   ├── 003_job_status_tracking.sql
│   │   │   ├── 004_pipeline.sql
│   │   │   ├── 005_fix_interaction_types.sql
│   │   │   └── 006_merge_quoting.sql
│   │   └── seeds/          # Demo data seeder
│   └── .env.example        # Required env vars
├── frontend/               # React SPA (Vite)
│   └── src/
│       ├── pages/          # Login, Dashboard, People, Organisations, Venues, Jobs, Pipeline (Kanban), Team, Settings, Duplicates + detail pages
│       ├── components/     # Reusable UI components
│       └── contexts/       # AuthContext
├── shared/                 # Shared TypeScript types
│   └── types/index.ts      # Person, Organisation, Venue, Job, Interaction, User, etc.
├── deploy/                 # Server deployment scripts
│   ├── setup-server.sh
│   ├── deploy.sh
│   ├── nginx-ooosh-portal.conf
│   └── ooosh-portal.service
└── docs/
    ├── SPEC.md             # Full system specification (v1.1)
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

- [ ] SSL certificate (Let's Encrypt via Certbot) — currently HTTP only
- [ ] Domain name configuration
- [ ] Database backup automation (pg_dump to R2)

### Phase 2 — In Progress

- [x] **HireHop job sync (read-only pull)** — jobs table, sync service, API routes, job_value sync
- [x] **Jobs UI** — jobs list page, job detail view, status badges, filtering by status
- [x] **Enquiry & Sales Pipeline (Phases A–D)** — see docs/PIPELINE-SPEC.md
  - [x] Phase A: Data layer (migrations 003-006, pipeline fields, chase interaction type)
  - [x] Phase B: Backend API (pipeline endpoints, status transitions, chase logic, chase alerts)
  - [x] Phase C: Kanban board UI (6 columns, cards, drag-and-drop, filters)
  - [x] Phase D: Supporting UI (new enquiry form with file staging, chase logging with quick-select & alerts, HireHop links, inline file viewer)
  - [ ] Phase E: HireHop write-back (push status changes, create HH jobs from Ooosh)
- [x] **File management** — authenticated upload/download, inline viewer (images + PDFs), file tags & comments
- [x] **Enquiry/Quoting merge** — New Enquiry + Quoting merged into single "Enquiries" column
- [ ] **Quoting tools integration** ← NEXT PRIORITY
  - [ ] Delivery/collection calculator
  - [ ] Staging calculator
  - [ ] Backline matcher
- [ ] Win/loss analysis dashboard (depends on pipeline — lost_reason basics included in pipeline)
- [ ] Job close-out workflow
- [ ] Command Centre dashboard (live data from jobs + contacts)
- [ ] Xero financial summary integration
- [ ] Cold lead finder (Ticketmaster API)

### Phase 3–5

See docs/SPEC.md for full phased plan.

## HireHop Integration

### Environment Variables

```
HIREHOP_DOMAIN=myhirehop.com        # Domain only, no https:// or trailing slash
HIREHOP_API_TOKEN=your_token_here   # API token from HireHop settings
```

### Current Sync

- **Contacts (Phase 1):** Read-only pull from HireHop into `people` table, matched by email
- **Jobs (Phase 2):** Read-only pull of active jobs (statuses 0-8) into `jobs` table
- Config: `backend/src/config/hirehop.ts`
- Contact sync: `backend/src/services/hirehop-sync.ts`
- Job sync: `backend/src/services/hirehop-job-sync.ts`
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

## Architecture Notes

- **Frontend talks to backend** via `/api/*` — Nginx proxies API requests to Express (port 3001)
- **Auth flow:** Login → JWT access token (short-lived) + refresh token → stored in httpOnly cookies
- **Database:** All IDs are UUIDs. `created_by` on most tables is VARCHAR (seed value), but `interactions.created_by` is a UUID FK to `users(id)`
- **Migrations:** Sequential numbered SQL files run via `backend/src/migrations/run.ts`

## Important Conventions

- Email domain is `@oooshtours.co.uk` (not @ooosh.co.uk)
- The `people` table is the central entity — users, freelancers, contacts are all people first
- `person_organisation_roles` junction table tracks relationships with dates and role metadata
- Frontend uses Tailwind CSS for styling
- API responses follow `{ data, pagination }` or `{ error }` patterns
