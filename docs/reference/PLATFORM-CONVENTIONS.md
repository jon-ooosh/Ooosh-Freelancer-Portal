<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
The distilled rules live in `.claude/rules/*.md`; this is the full record.
-->

# Platform conventions & reference

Security posture · dependency policy · crew & transport calculator · vehicle module
integration · scheduled tasks · HireHop API reference · pipeline chase model · enquiry
dismissal · database tables · out-of-hours returns · dashboard extension points ·
files tab · architecture notes.

## Security

### Current Security Posture (as of 15 Mar 2026)

**Authentication & Authorization:**
- [x] JWT access tokens (15 min) + refresh tokens (7 days)
- [x] Bcrypt password hashing (12 salt rounds)
- [x] RBAC middleware (`authorize()`) on sensitive routes — 6 roles: `admin`, `manager`, `staff`, `general_assistant`, `weekend_manager`, `freelancer`. **For staff-wide gates** (anything the whole non-freelancer team needs), use the shared `STAFF_ROLES` constant from `middleware/auth.ts` and spread it: `router.use(authorize(...STAFF_ROLES))`. Do NOT hardcode `authorize('admin', 'manager', 'staff')` — it silently locks out `weekend_manager` and `general_assistant` (this caused a live bug on `/pipeline` + `/requirements` post-go-live, fixed 26 Apr 2026). **For manager-tier gates** (money out the door, hard-gate overrides, PII reads), use the `MANAGER_ROLES` constant (admin + manager + weekend_manager) — don't hardcode `authorize('admin', 'manager')`, which silently locks out the weekend manager from actions they should be able to take when admin/manager are off. Use `authorize('admin')` alone only for absolute / irreversible decisions (e.g. waiving an excess to £0). For other narrower gates, keep the explicit role list. **`weekend_manager` ≡ `manager` (one privilege level, jon Jun 2026).** The backend enforces this STRUCTURALLY: `authorize()` (`middleware/auth.ts`) accepts a `weekend_manager` anywhere `manager` is allowed, so you **never** need to list `weekend_manager` alongside `manager` — `authorize('admin', 'manager')` already grants the weekend manager. The only thing that excludes a weekend manager is a gate that omits `manager` entirely (e.g. `authorize('admin')`). **Frontend mirrors this:** use `hasManagerRole(role)` / `roleAllowed(role, [...])` from `frontend/src/lib/roles.ts` for any manager-tier UI gate — NEVER bare `role === 'manager'` (that silently hides manager UI from the weekend manager). When adding a new manager-tier role in future, update those two chokepoints (backend `authorize` alias + the frontend helper) rather than every call site.
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
- [~] Field-level encryption for sensitive PII (AES-256-GCM, `services/encryption.ts`, key in `ENCRYPTION_KEY` env). **Live:** client bank details + driver PII Phase 1 (DOB, addresses, DVLA check code — see the Retrofit checklist under Shared Utilities). **Remaining:** driver PII Phase 2 (null plaintext), passport numbers, the searched fields (`licence_number`/`postcode` — need a blind-index), freelancer PII, receipt scans.
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

### Dependency Security (npm audit / Dependabot)

**Dependabot is live (June 2026).** Security updates are enabled in repo Settings (auto-PRs for new CVEs), and `.github/dependabot.yml` drives weekly grouped version-update PRs for `/`, `/backend`, `/frontend`, and the `github-actions` ecosystem. Routine minor/patch bumps arrive grouped per project; majors come as individual PRs. **Always let a Dependabot PR `npm install && npm run build` in the affected dir before merging** — a bump occasionally needs a code tweak.

**Do NOT run `npm audit fix --force`.** The plain `npm audit fix` (semver-safe) is fine and already applied. `--force` pulls breaking majors that break the build. Two vulnerabilities are **deliberately left in `backend/` and must not be "fixed"**:

| Package | Severity | Why left |
|---|---|---|
| `xlsx` (sheetjs) | high | No npm fix exists (SheetJS publish fixed builds via their own CDN, not npm). Only parses **trusted admin xlsx uploads** (Monday → Fleet Master import, a one-shot), never arbitrary user input. Migrating to the CDN build is a separate deliberate job, not an `audit fix`. |
| `uuid` | moderate | Only fixable via `--force` → uuid@14, a breaking major. Not worth a breaking change for a buffer-bounds issue we don't hit. |

**The "critical" npm sometimes reports is dev-only.** It's `handlebars`, pulled in transitively by `ts-jest` (a devDependency / test tooling) — **not shipped to production**, requires compiling attacker-controlled templates, zero runtime exposure. Don't panic over the severity label; npm doesn't know it's dev-only.

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

**Freelancer History tab (Jul 2026).** Person Detail gains a "Freelancer History" tab (rendered only when `is_freelancer`, sits after Hire History) — the ASSIGNMENT-grained view of everything ever booked against a freelancer, past + upcoming, **including cancelled/declined** (shown muted, not hidden). Deliberately distinct from the job-grained Hire History tab (which shows the JOB's status + whole-job value and filters cancelled crew out — both tabs stay). Backend: `GET /api/people/:id/freelancer-history` (`routes/people.ts`, after hire-history) — three sources merged in JS into one normalised item shape: (1) crew/transport via `quote_assignments` + `quotes` (no status filter, LEFT JOIN jobs so local D&C with NULL `job_id` survive, `run_groups.combined_freelancer_fee` surfaced); (2) studio sitter shifts (ALL statuses — unlike `getSitterShifts`, which drops declined/cancelled); (3) driven vehicle assignments via `vehicle_hire_assignments.freelancer_person_id` with the dual-match job join. Fee rule: `agreed_rate ?? freelancer_fee_rounded ?? freelancer_fee` for crew, `a.fee` for sitter, null for vehicle (pay lives on the crew quote). Summary stats: total gigs (excl. cancelled/declined), upcoming, declined, cancelled, fees YTD (`date_start` in current calendar year, booked-ahead counts). Frontend: `FreelancerHistorySection.tsx` — self-contained `{entityId}` section per the ExcessHistorySection convention; stat cards + filter pills + "Upcoming & Pending" (soonest first) above "History". When adding a new per-freelancer assignment source in future (e.g. a tasks system), union it into this endpoint rather than building a parallel surface.

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
| Pre-auth expiry reconciliation | Daily at 09:40 (Europe/London) | Scan `job_excess` with `excess_status='pre_auth'` past `held_expires_at`. Stripe holds → release only if Stripe reports the PI `canceled`; card-machine/cash holds → release after the 5-day window. SILENT (no emails/bells) — dashboard bucket is the surface. Shipped PR 4 (May 2026). |
| Stale enquiry auto-lose | Daily at 09:00 | Mark unconfirmed enquiries / provisional as lost when `job_date::date < CURRENT_DATE`, `pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')`, `status < 2`. Runs at office start so staff don't open the day to phantom enquiries cluttering operational lists (backline prep, overdue departures, etc.). Also pushes status 10 (Not Interested) to HireHop. Was 10:00 pre-May 2026 — moved to 09:00 to land before staff start their day. |
| Carnet request-form auto-email | Daily at 09:15 | We-supply carnets: initial send at T-28 days of needed-by on confirmed jobs, chase at T-14 if not back. Obeys the `carnet` email-routing bucket + lost/cancelled/internal gates. `services/carnet-auto-email.ts`. |

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

## The status-6 no man's land — mid-hire partial returns (Jul 2026)

**Read this before touching anything that keys off "is this job returning".**

HireHop status **6 ("Returned Incomplete")** is ambiguous — it fires in two completely different situations that HH can't distinguish (its status is job-level and binary):

- **(A) Genuine end-of-hire:** the tour's back and staff are checking items in. This IS the start of the returns process.
- **(B) Mid-hire partial return:** a client hands back ONE element mid-tour (e.g. two keyboard stands) while the rest of the hire stays out for another week. Warehouse checks the returned items in on HireHop (stock accuracy), which flips the whole job to 6 — **but the hire is still on.**

Without a discriminator, case (B) trips the whole returns machinery: OP spins up close-out requirements (invoice / payment-reconcile / client-followup), the daily chase scanner starts nagging you to invoice a job that's still on the road, the dispatch excess/referral gate switches off, and the badge flips to "Checking In".

**The discriminator is the hire-END DATE.** A status-6 job is only "genuinely returning" once its expected return date has arrived (± `HIRE_END_TOLERANCE_DAYS`, default 1 — and `return_date` is already the +1 buffer, so this is effectively "on or after the real job end"). HH status **7 / 8 / 11** mean everything is physically back, so they're always genuinely returned regardless of date.

**Single source of truth:** `backend/src/services/hire-lifecycle.ts` — `hireGenuinelyReturning(hhStatus, returnDate, jobEnd)` (JS) and `hireGenuinelyReturningSql(alias)` (SQL fragment). **Any new surface that decides "is this job in returns" MUST route through one of these** rather than testing `status >= 6` / `status IN (6,7,8)` raw.

**How it's wired (the "hold + reconcile" model):**
1. **Hold** — the inbound HH webhook (`webhooks.ts handleJobStatusChange`) holds `pipeline_status` at its current out-on-hire value when HH reports 6 but the hire isn't genuinely returning. It only holds a job that's still out (`HELD_OUT_PIPELINE_STATUSES` = dispatched/prepped/prepping) — **never a job already advanced into the returns process**, so a status staff moved manually is never wound back (the "sacred decision" rule). `jobs.status` is still written truthfully to 6. Drops a one-line timeline note on the transition. NB the 30-min polling sync already never touches `pipeline_status`, so a partial arriving via polling is naturally held.
2. **Gate** — the close-out requirement factory (`hh-requirement-derivation.ts` `isReturnPhase`) and the daily close-out chase scanner (`scheduler.ts`) require `hireGenuinelyReturning`, so no close-out cards / nagging on a mid-hire partial.
3. **Reconcile** — an hourly scheduler task (`reconcileHeldReturns` in `hire-lifecycle.ts`) advances a held job into the returns process (`pipeline_status='returned_incomplete'` + timeline note + fires derivation) once its return date arrives. **This is load-bearing** — without it a held job would stick "On Hire" forever, because HH already sent its 6 and won't re-send. It's forward-only (never winds back) and also fixes the general webhook-gap case (HH says 6, no returned webhook ever landed).
4. **List membership** — the Returns page (`/api/hirehop/jobs?genuinely_returning=1`) and the dashboard returns-overview counts drop mid-hire partials, so they stay in Out Now, not Returns.

**Manual override is safe:** staff can move a job to Checking In / Returned early and it sticks — the hold ignores any job already in a returns/terminal `pipeline_status`, and reconcile only ever moves forward. Worst case of the date heuristic is a genuine return recognised a day or two late (close-out cards delayed, self-heals) — the safe error, vs. falsely closing out a live tour.

**NOT surfaced anywhere in OP:** the fact that an item came back early (that lives in HireHop, where warehouse checks it in). A future light "early returns" note on the job would be additive.

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

### Paused enquiries — revisit date, and the "Under 4-day window" default

Pausing an enquiry clears `next_chase_date`, so the card drops out of the derived Chasing pile entirely. The **revisit date** on the pause modal is what puts it back: it writes `next_chase_date`, so the card resurfaces on that day.

**`under_minimum` ("Under 4-day window") pre-fills that date to `hire start − 14 days`** (`REVISIT_LEAD_DAYS_UNDER_MINIMUM` in `frontend/src/lib/revisitDate.ts`). The reasoning is that this pause reason is the one with a predictable comeback — we can't take a short hire while the diary is tight, but it's worth another swing once it loosens. Every other reason (`fully_booked`, `other`) is a judgement call and stays blank + opt-in.

Conventions:
- **`defaultRevisitDate()` is the single source** — both pause modals (`JobDetailPage` `StatusTransitionModal` and `PipelinePage` `TransitionModal`) call it, so they can't drift. Hire start = `job_date || out_date`.
- **Returns `''` when the computed date is today or past.** A revisit date that's already due would drop the job straight back into Chasing the moment it was paused — the opposite of pausing. Short-notice enquiries therefore get no default and staff pick (or don't).
- **Date-only arithmetic anchored to UTC midnight**, never `new Date()` + local `toISOString()` — the stored timestamps carry a 09:00 time and only the calendar day matters, so this stays stable under BST.
- **A `revisitTouched` flag suppresses re-defaulting** once staff edit either field; switching reason away from `under_minimum` clears an untouched default so a stale date can't be submitted by accident. `PipelinePage`'s modal stays mounted between opens (it early-returns on `!isOpen`), so it re-arms the flag on open — without that, one manual edit would kill the default for the rest of the session.

### Chase-date clearing on lifecycle moves

`next_chase_date` is auto-nulled when a job moves to `confirmed` / `lost` / `cancelled` (`pipeline.ts` `/:id/status`). Same applies on inbound HireHop webhooks via `webhooks.ts`. Migration 070 was the historical backfill for jobs that had drifted before this rule landed.

### Watch list

If staff complain "my chase keeps moving when I don't want it to" → point them at the "Don't update chase date" checkbox.

If they complain "I logged a call but the chase didn't move" → it's the sacred-future rule. The chase was already future-dated; auto-bump correctly skipped it. They can manually reschedule via the chase modal if they actually want it shortened.

## Enquiry dismissal ("dud-ing") — overlay flag, NOT a status (migration 197)

A dud / spam / orphan enquiry is dismissed via `POST /api/pipeline/:id/dismiss`, which stamps `jobs.dismissed_at` (nullable TIMESTAMPTZ) plus `dismissed_by` / `dismissal_reason` / `dismissal_notes`. **`pipeline_status` is deliberately left untouched** — a dismissed enquiry keeps its pre-confirmation value (`new_enquiry` / `quoting` / `paused`). Dismissal is an OVERLAY flag, not a new `pipeline_status` enum value.

**So the dismissal test EVERYWHERE is `dismissed_at IS NOT NULL`, never a `pipeline_status` check.** `DISMISSABLE_STAGES = ['new_enquiry', 'quoting', 'paused']` — only pre-confirmation enquiries can be dud-ed.

**⚠️ Any surface that derives display/eligibility from `pipeline_status` alone must ALSO check `dismissed_at`**, or it silently mislabels a dud as a live enquiry. This exact bug hit global search: `search.ts` exposed no dismissal column and `GlobalSearch.tsx`'s `jobBadge()` derived the blue "Enquiries" badge purely from `pipeline_status`, so a dud-ed enquiry kept showing "Enquiries". Fix: `search.ts` exposes `(dismissed_at IS NOT NULL) AS is_dismissed` and `jobBadge()` short-circuits to a grey "Dismissed" pill (`#6B7280`) before the `pipeline_status` derivation (Sep 2026).

NB the `pipeline.ts` code comments still say "migration 196" for dismissal — the actual migration file is `197_enquiry_dismissal.sql` (renumbered to avoid a collision with main's `196_unsigned_hire_form_nudge.sql`). Cosmetic; the runner keys off the filename array in `run.ts`.

## Database Tables Overview

### Core (migration 001)
`people`, `organisations`, `person_organisation_roles`, `venues`, `interactions`, `users`, `external_id_map`, `picklist_items`, `notifications`, `audit_log`

### Jobs (migration 002-006)
`jobs` — synced from HireHop, pipeline fields (status, likelihood, chase dates, lost_reason)

**`jobs.lost_reason` stores the display LABEL verbatim** — it's free text (`z.string()`, no enum, no lookup table) sourced from `LOST_REASON_OPTIONS` in `shared/types/index.ts`, and `/jobs/lost-cancelled` filters on exact string match. **So renaming an option REQUIRES a data migration** rewriting the stored rows, or every historic job tagged with the old label silently stops matching the new filter value and vanishes from the filtered view. Precedent: migration 191 (`Confirmed Alternative Quote` → `Confirmed Alternative Quote (from us)`, Aug 2026 — the "(from us)" makes it explicit that the client took a different job from US, i.e. the revenue moved rather than was lost; `Competitor` covers the someone-else case). Same applies to `CANCELLATION_REASON_OPTIONS` and any other label-as-value picklist.
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

- `job_excess.excess_status IN ('taken', 'partially_paid')` — whitelisted, not blacklisted. `pre_auth` deliberately excluded (holds auto-reconcile via the webhook + daily scheduler — see "Stripe pre-auth expiry scheduler", shipped PR 4). `needed` / `pending` excluded because they're "system thinks one is required" not "money is here".
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
- **No top-of-page "Back to …" breadcrumb on entity detail pages (Jul 2026 decision).** Removed from Job / Person / Organisation / Venue / Vehicle / PCN detail pages. They were usually *wrong*: a hardcoded destination (e.g. `<Link to="/people">`) ignores where you actually came from, and JobDetailPage's "smart" `location.state.from || '/jobs'` variant only worked from the two pages that bothered to pass `state.from` (Pipeline + Lost & Cancelled) — every other entry point (dashboard, global search, Jobs/Returns/Backline/Transport lists, notifications, hire-history links, direct URL, refresh) silently defaulted to "Back to Jobs". A wrong back button is worse than none; the browser's own back button is always correct, and the nav bar + page title already orient the user. **Don't re-add them.** What was deliberately KEPT: (a) **contextual deeplinks that reflect a real parent relationship** — Issue detail → its job (`Back to job #NNNNN`), Carnet detail → carnets list + its job, Fill-a-Gap → its job, Excess Ledger → Ledger; (b) **"not found" / dead-end recovery buttons** inside error states (e.g. DriverDetailPage's "Driver not found → Back to Drivers", VehicleDetailPage's not-found "Back to vehicles") — those are the only way out of a dead-end page, so they stay; (c) **vehicle-module kiosk/workflow exits** (BookOut / CheckIn / Collection / Prep "Back to Dashboard/Fleet/Queue") — these are deliberate "exit this workflow" actions and, in freelancer kiosk mode, the *only* navigation available (no nav shell), so removing them would strand freelancers. NB `JobDetailPage.tsx` keeps the `backTo` variable purely as the redirect target in `loadJob`'s catch (job failed to load), not as a rendered breadcrumb. **Alignment side-effect (fixed Jul 2026):** removing the breadcrumb exposed a pre-existing ~16px spacer in the Job Detail sidebar — the "📦 Also holding (FYI)" `HeldItemsSection` wrapper kept its `mb-4` even when the section rendered nothing, so the Client History card sat lower than the main card. Fixed with `empty:hidden` on that wrapper. If a future sidebar section is added above the Client History card with a conditional/`hideWhenEmpty` component inside a margined wrapper, use the same `empty:hidden` pattern so an empty render doesn't leave a phantom gap.
- **`vehicle_hire_assignments` is soft-cancel only.** Every removal path in the application sets `status = 'cancelled'` rather than physically deleting the row. `DELETE /api/assignments/:id`, the cancellation flow, lost-cleanup, swap-vehicle — all soft. There is **no `DELETE FROM vehicle_hire_assignments` anywhere in the codebase**, and there shouldn't be: the row is the source of truth for an actual hire that physically happened, so destroying it loses audit trail (book-out/check-in events in R2 still reference it). If a future Claude needs to "remove" an assignment, soft-cancel is the path. The same applies to `job_excess` and the broader hire-tracking chain — soft state changes preferred over physical deletion. (See May 2026 incident: HH job 15862 had its `vehicle_hire_assignments` row hard-deleted out from under it by direct SQL during an earlier cleanup pass; we had to rebuild the row from the R2 book-out event so the weekend team could check the van back in normally. Soft-cancel would have avoided that whole detour.)
