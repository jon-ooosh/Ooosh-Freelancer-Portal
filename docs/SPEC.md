# OOOSH TOURS — Operations Platform

## System Specification & Module Architecture

**Version 1.1 • March 2026**
**CONFIDENTIAL** — Prepared for internal planning purposes

---

## 1. Vision & Core Philosophy

This document defines the Ooosh Operations Platform — a unified system replacing Monday.com and wrapping around HireHop and Xero. It is not a CRM with bolt-ons; it is a complete business operations hub with relationship intelligence woven through every layer.

### The Governing Principle

People are the primary entity. Everything — jobs, quotes, deliveries, payments, problems, lost property, carnets — connects back to people and their relationships. A person exists independently of any company, band, or role. When relationships change, history is preserved and new opportunities are surfaced.

### What This System Replaces

- **Monday.com entirely** — all boards, automations, and workflows migrate into the platform
- **Standalone tools** currently hosted on Netlify/GitHub (payment portal, hire forms, vehicle manager, staging calculator, backline matcher, PCN manager, delivery portal) — these become modules within or connected to the platform
- **Jotform** — all client-facing forms become native to the platform
- **Zapier** — already mostly replaced; remaining automations become platform-native

### What This System Sits Alongside

- **HireHop** — remains the operational engine for jobs, equipment, stock, invoicing, and Xero sync. The platform reads from and writes to HireHop via API but never duplicates its core logic
- **Xero** — remains the accounting system. Financial data flows through HireHop's existing Xero integration. The platform reads financial summaries for display and intelligence
- **Traccar / GPS** — continues to run independently; the platform pulls location data where relevant

---

## 2. Core Data Model

The data model is the foundation everything is built on. Getting this right is the single most important architectural decision. The following entities and their relationships form the backbone of the entire platform.

### 2.1 Primary Entities

#### People

The central entity. Every person — client, freelancer, staff member, venue contact, agent, accountant — is a Person. A person exists independently and can hold multiple simultaneous roles at multiple organisations. Personal contact details, communication preferences, and a unified activity timeline live here.

#### Organisations

Companies, bands, management firms, labels, agencies, promoters, venues, festivals. Typed and categorisable. Can have parent/subsidiary relationships (e.g. Label X owns Imprint Y). An organisation links to many People via role-based associations.

#### Jobs

Synced from HireHop. A Job is the operational record of a hire — dates, equipment, status, financial totals. The platform enriches this with relationship context (who enquired, who authorised, who pays, who's on site) and operational metadata that HireHop doesn't track.

#### Opportunities

The pre-job sales pipeline. An Opportunity tracks an enquiry from first contact through to won/lost, with stage, value, probability, source attribution, and win/loss reason. When won, an Opportunity links to a Job in HireHop.

#### Venues

First-class entities, not just address fields. A Venue accumulates institutional knowledge: loading dock hours, access codes, parking, best approach routes, site contacts, photos. Persists across all clients and jobs.

#### Interactions

Every touchpoint: emails, calls, meetings, notes, @mentions. Each Interaction links to one or more People, Organisations, Jobs, or Opportunities. Forms the unified activity timeline.

#### Deliveries

Delivery, collection, and crewed transport records. Links to Jobs, Vehicles, People (driver, crew), and Venues. Carries logistics details, costs, and status.

#### Vehicles

The fleet. Each vehicle has a profile: registration, type, MOT dates, telematics link, maintenance history, current assignment. Syncs with the existing Vehicle Manager.

#### Equipment Issues

Problems reported on the road or in the warehouse — with backline, staging, or vehicles. Linked to Job, People, and Equipment. Tracked through to resolution.

#### Tasks

General to-do items. Can be standalone (building maintenance, ad-hoc jobs) or linked to any other entity (follow up with Client X, chase carnet return).

### 2.2 The Relationship Model

The relationship between People and Organisations is the most critical data structure. Rather than a simple foreign key, it uses a junction table with rich metadata:

| Field | Description |
|-------|-------------|
| `person_id` | The Person in the relationship |
| `organisation_id` | The Organisation they're associated with |
| `role` | Their role: Tour Manager, Manager, Agent, Accountant, Label Rep, Production Manager, Driver, Merch Manager, Site Contact, etc. Extensible picklist. |
| `status` | Active or Historical |
| `start_date` / `end_date` | When the association started and (if ended) when it finished |
| `is_primary` | Whether this is the person's primary current association |
| `notes` | Freeform context about the relationship |

This model allows the system to answer questions like: "Show me every tour manager we've worked with who has moved to a new management company in the last six months" or "Who are all the people associated with Band X, including historical relationships?"

#### Relationship Movement Detection

When a Person's association with an Organisation is marked as historical and a new one is created, the system automatically flags this as a potential lead opportunity. If Tour Manager Sarah moves from Band A to Band B, the team is alerted that Band B might now be a warm lead — without anyone having to notice the change manually.

### 2.3 Job Roles on Bookings

Every Job/Opportunity can have multiple People assigned with specific roles for that particular booking. These are separate from the person's organisational role:

| Role | Description |
|------|-------------|
| **Enquirer** | Who made the initial enquiry |
| **Authoriser** | Who approves the spend / signs off |
| **Payer** | The entity or person who pays the invoice (may be a label, accountant, or management company) |
| **Site Contact** | Who to call on the day for delivery/collection |
| **Driver / Crew** | Internal staff or freelancers assigned to the delivery |
| **Booker** | If different from enquirer — the person who formally confirmed |

This separation means that when analysing "lifetime value" we can track it at the right level: by the Enquirer/Booker (the relationship holder), by the Payer (the financial entity), or by the Organisation — giving much more accurate intelligence than HireHop's single company/person per job.

---

## 3. Platform Modules

The platform is organised into interconnected modules. Every module connects back to the core data model — particularly People and Jobs. Below is the complete module architecture, organised by functional area.

### 3.1 Command Centre (Dashboard)

**Purpose:** A single screen showing the state of the business right now. Replaces the need to check multiple Monday boards, HireHop's calendar, and email to understand what's going on.

#### What's Happening Today / This Week

- Active hires out on the road — pulled from HireHop job statuses
- Deliveries and collections scheduled — with vehicle, driver, venue, and time
- Crewed jobs in progress
- Equipment due back today / this week (check-in prep list)
- Equipment due out (prep list for upcoming dispatches)

#### What Needs Attention

- Enquiries awaiting response — with age and urgency flagging (response time tracking)
- Quotes sent but not yet confirmed — with follow-up due dates
- Overdue invoices — pulled from Xero via HireHop
- Outstanding equipment issues / road problems
- Unread emails requiring action
- Tasks due today or overdue
- Carnets requiring attention (see Module 3.10)
- Insurance deposits due for return or follow-up

#### What's Coming Up

- Hires starting in the next 7 days that still need prep
- Vehicles due for MOT, service, or garage visits
- Staff holidays or absences that might create coverage gaps

#### Filters & Views

- Filterable by: Everyone, My Items, specific team member, department
- Toggle between daily and weekly views
- Department views: Operations, Sales, Accounts, Warehouse

### 3.2 Relationship Intelligence

**Purpose:** The person-first CRM layer. Not a standalone module but the connective tissue running through the entire platform. This is where contact management, relationship mapping, communication history, and customer intelligence live.

#### Contact Management

- Master contact directory for all People and Organisations
- People displayed with all current and historical organisational associations and roles
- Organisation profiles showing all associated People, with role and status
- Relationship graph view — visual map of how People and Organisations connect
- Duplicate detection and merge tools
- Sync to HireHop address book (CRM is master, pushes to HireHop)

#### Activity Timeline

- Unified chronological feed per Person and per Organisation
- Shows: emails, calls, notes, meetings, quotes sent, jobs completed, payments, issues, @mentions
- Team members can @mention colleagues within any entity's timeline to discuss or flag issues
- All interactions are timestamped and attributed to the logged-in user (audit trail)

#### Customer Intelligence

- Customer Lifetime Value (CLV) calculated from HireHop job history and Xero payment data
- RFM scoring (Recency, Frequency, Monetary) with automatic tier assignment: Platinum, Gold, Silver, Bronze
- Referral chain tracking — who referred whom, and the downstream revenue that generated
- Influencer scoring — identifying People whose referrals generate disproportionate value
- Payment behaviour indicators from Xero — average payment days, outstanding balance, overdue history
- Dormant client alerts with automated re-engagement suggestions
- Seasonal booking pattern analysis — surfacing "Client X hired vans every May for the last 3 years but hasn't enquired yet"

#### Relationship Movement Alerts

- Automatic detection when a Person changes Organisation
- Alert generated for the account owner with context: "Sarah Jones has moved from Band A Management to Festival Productions Ltd — potential new lead"
- Historical relationship preserved; new association created with current date

### 3.3 Enquiry & Sales Pipeline

**Purpose:** Tracking every potential booking from first contact through to won/lost, replacing the Monday.com Quotes board. Tightly integrated with HireHop for quote generation and equipment availability.

#### Pipeline Stages

| Stage | Description |
|-------|-------------|
| **New Enquiry** | Captured from phone, email, web form, cold outreach, or referral. Source attribution recorded. Time-to-first-response clock starts. |
| **Qualified** | Dates confirmed viable, equipment broadly available, budget discussed, decision-maker identified. Basic fit established. |
| **Quote Sent** | Formal quote generated in HireHop, linked here. Quote value, equipment list, and delivery requirements recorded. Follow-up schedule begins. |
| **Negotiation** | Active discussion — price adjustments, date changes, scope modifications, competitor comparison. Each revision tracked. |
| **Won** | Booking confirmed. Opportunity links to HireHop Job. Operational handover triggers. |
| **Lost** | Mandatory: structured loss reason (Price, Availability, Competitor, Timing, No Decision, Cancelled Event) plus freeform notes. Feeds win/loss analysis. |

#### Key Features

- Pipeline board view (Kanban) and list view with filtering
- Time-to-quote tracking with alerts when approaching target thresholds
- Follow-up scheduling with reminders — automatic escalation if overdue
- Automated seasonal outreach campaigns — contacting past clients before peak periods based on their historical booking patterns
- Integration with cold lead finder (Ticketmaster API scraper) — AI-identified touring acts appear as new Opportunities with enriched context
- AI band/artist summaries: Each cold lead includes an AI-generated brief — who they are, genre, typical touring setup, likely equipment needs, recent activity — saving 20 minutes of research per lead
- Blind / forum leads: Quick-capture mechanism for ad-hoc leads spotted on touring forums, social media, or via word of mouth. Paste a link or type a quick note, tag as 'Forum Lead' or 'Ad-hoc', and it enters the pipeline with a follow-up reminder. Zero friction capture.
- Document sharing — ability to share relevant photos, fleet info, testimonials with prospects directly from the platform
- Quote versioning — track multiple revisions of a quote with what changed
- Win/loss dashboard — aggregated analytics on why deals are won or lost, trends over time, and conversion rates by source

### 3.4 Job Operations Hub

**Purpose:** The operational wrapper around HireHop jobs. HireHop manages the equipment, dates, and invoicing; this module adds the context, coordination, and intelligence that HireHop doesn't provide.

#### Job Enrichment

- Every HireHop job gets a mirrored record in the platform, synced via API
- Additional fields not in HireHop: assigned team members, internal notes, client satisfaction rating, issue log, linked Opportunity, all People with their booking roles (Enquirer, Authoriser, Payer, Site Contact)
- @mention conversations within the job context — team members discussing prep, logistics, client requests
- File attachments: photos, rider documents, tech specs, signed hire forms — all searchable and linked

#### Role-Based Automated Communications

Every automated email is routed to the right person based on their role on the job, not just the primary contact:

- "Payment received" → sent to the Payer
- "Here's your hire form link" → sent to the Driver / Collector
- "We're still waiting for your response" → sent to the Enquirer
- "Your deposit is being returned" → sent to the Payer
- "Delivery confirmed for tomorrow" → sent to the Site Contact
- Fallback: if no specific role is assigned, defaults to the Enquirer

#### Job Requirements Checklist

Replaces the Monday.com Reminders sub-item system. When creating or confirming a job, the team flags what this job needs. Each flag triggers creation of the relevant record in the correct module:

- **Vehicle (self-drive)** → triggers vehicle assignment in Module 3.7, hire form in Module 3.11
- **Vehicle AND driver** → triggers delivery record in Module 3.5 with driver assignment
- **Local delivery / collection** → triggers delivery record in Module 3.5
- **Crew needed** → triggers crew assignment in Module 3.5
- **Backline** → flags for backline prep; optionally triggers backline matcher
- **Carnet required** → creates carnet record in Module 3.10
- **Forward facing seats** → flags vehicle selection constraint
- **Rehearsal** → triggers rehearsal booking workflow
- **Sub-hire needed** → flags for procurement
- **Something being sent to us** → creates advance receiving record in Module 3.6a

#### Lifecycle Tracking Beyond HireHop

- **Pre-hire:** Advance merch/equipment receiving (see Module 3.6), carnet processing, vehicle assignment
- **On-hire:** Issue tracking, road problem management, real-time status
- **Post-hire:** Equipment condition check, damage reporting, lost property logging, satisfaction follow-up
- **Settlement:** Deposit status, damage charges, credit notes, final invoice status from Xero

#### Job Close-Out Workflow

A job cannot be marked "Complete" until all settlement items are resolved. The system tracks each requirement and shows a clear summary:

- Van return status confirmed (All Good / Problem logged)
- Equipment condition checked
- Insurance excess resolved (returned, applied to damage, or not applicable)
- Invoice created and sent (confirmed from HireHop/Xero)
- Payment received (or payment plan agreed)
- Finalised in HireHop
- Any linked records resolved: lost property returned, damage claims processed, sub-hire POs settled

Jobs with outstanding items surface in the Command Centre as "Needs closing out" with clear indication of what's still open.

### 3.5 Delivery, Collection & Crew Management

**Purpose:** Creating, quoting, managing, and tracking all transport and crewed operations. Replaces the delivery/collection workflows currently split between Monday and standalone tools.

#### Creating Runs

- Pull job details automatically from HireHop — equipment list, dates, venue
- Assign vehicle from available fleet (checking against other bookings)
- Assign driver and crew — from internal staff or freelancer pool
- Add/select venue with auto-populated site intelligence (loading bay, access codes, parking)
- Easy venue creation for new locations, with fields pre-structured for key info

#### Quoting & Costing

- Generate transport quotes pulling from default rates, distance calculations, and crew costs
- Track expected cost (driver pay, fuel estimate, tolls, congestion charges) vs actual cost vs client charge
- Freelancer cost expectations clearly communicated — what they'll be expected to front, what to invoice

#### Communication & Execution

- Crew portal — freelancers and drivers log in to see their assigned runs with all info they need: venue details, access notes, contact numbers, equipment list, timing
- Push notifications for schedule changes
- Real-time status updates: en route, arrived, loaded, departed, delivered
- GPS tracking integration from Traccar for live vehicle position

#### Freelancer Invoice Management

- Automated means of ingesting freelancer invoices (email parsing or upload)
- Validation against expected costs — flagging discrepancies
- Approval workflow before pushing to Xero
- Cost vs income reporting per delivery, per job, per client, per period

### 3.6 Client Services

#### 3.6a Advance Receiving (Merch & Equipment)

**Purpose:** Tracking items sent to Ooosh by clients in advance of tours — merch boxes, flight-cased equipment, production supplies.

- Client-facing form to notify us: how many boxes/items, when arriving, any import charges, special handling
- System generates a unique label/reference for each consignment for the client to attach
- On arrival: staff log receipt, note condition, flag any missing or damaged items
- Client notification: automatic email/notification when items arrive, with condition notes
- Ad-hoc arrivals: when unlabelled boxes turn up, staff can log them and the system helps identify the likely owner based on upcoming jobs
- Storage tracking: if items need to be stored beyond the job dates, track duration and charges
- Everything linked to the Job and the People involved

#### 3.6b Lost Property

**Purpose:** Tracking items left behind in vans, amps, or at the warehouse.

- Log found items with description, photo, location found (which van/amp/location), date
- System automatically suggests likely owner based on recent job using that vehicle or equipment
- Client notification with photo: "We found this in Van 12 after your hire"
- Status tracking: Awaiting Collection, Collection Arranged, Collected, Unclaimed (with time-based escalation)
- All linked to Job, Vehicle/Equipment, and People

### 3.7 Fleet & Equipment Management

**Purpose:** Extends the existing Vehicle Manager into the platform and adds equipment issue tracking. Covers vehicle profiles, maintenance scheduling, and on-road problem resolution.

#### Vehicle Profiles

- Registration, type, MOT dates, insurance, current mileage, condition rating
- Maintenance history and upcoming scheduled work
- Garage visit scheduling and tracking
- Current assignment (which job, which driver)
- GPS/telematics data from Traccar
- Integration with existing Vehicle Manager and congestion/Eurotunnel geofencing

#### Equipment Issue Tracking

- Report problems on the road — staff, drivers, or clients can log issues via the app
- Issue categorisation: Vehicle breakdown, Equipment malfunction, Damage, Missing item, Other
- Immediate notification to relevant team members
- Status tracking: Reported → Acknowledged → Action Taken → Resolved
- Linked to Job, Vehicle, Equipment, and People
- Response time tracking — aiming for exceptional, rapid problem resolution
- Post-resolution review: what happened, what did it cost, how can we prevent recurrence

#### Outstanding Issues Dashboard

- Cross-departmental view of all open issues
- Filterable by: type, severity, age, assigned team member, department
- Escalation rules: issues not acknowledged within X hours auto-escalate

### 3.8 Financial Operations

**Purpose:** Tracking deposits, insurance excesses, and payment status across jobs and people. Provides the financial visibility layer that sits between HireHop/Xero and the team.

#### Insurance Deposits & Excesses

- Track deposits held per client: amount, date received, associated job(s), payment method (Stripe, bank transfer, PayPal, cash, card in person)
- Status: Held, Partially Used (with amount remaining), Returned, Applied to Damage
- Returning clients with rolling deposits: clear view of total held, what it's earmarked against, when to return
- Automated reminders to return unused deposits after job completion
- Links to existing payment portal and Stripe integration

#### Financial Summaries per Entity

- Per Person/Organisation: total lifetime revenue, outstanding balance, overdue invoices, average payment days, deposit status
- Per Job: quoted vs actual revenue, costs (transport, crew, sub-hire), margin, payment status
- Credit ledger concept: tracking overpayments and allocations across jobs for regular clients
- All pulled from HireHop and Xero — displayed in the platform but not duplicated

### 3.9 Staff & HR Management

**Purpose:** Basic workforce management. Not a full HR system, but enough to track availability, leave, and accountability.

- **Who's working today:** Dashboard showing who's in, who's on holiday, who's off sick, who's on a delivery
- **Holiday management:** Staff submit holiday requests via the platform. Manager approval workflow. Calendar view showing coverage. Clash detection: "If you approve this, there will be no warehouse staff on Thursday"
- **TOIL tracking:** Overtime hours logged. TOIL accrual and usage. Manager approval for TOIL days.
- **Sick leave logging:** Simple record-keeping with return-to-work notes
- **Availability view:** Integrated with delivery scheduling — can't assign a driver who's on holiday

### 3.10 Carnet Management

**Purpose:** Tracking ATA carnet applications, processing, usage, and return for international hires.

- Which upcoming jobs need a carnet
- Application status: Not Started → Application Submitted → Issued → With Client → Returned → Discharged
- Key dates: application deadline, issue date, expiry date, return deadline
- Document storage: scanned carnet pages, customs stamps
- Alerts: approaching deadlines, overdue returns
- Cost tracking: application fees, deposits
- Linked to Job, Client, and relevant People

### 3.11 Self-Drive Hire Forms

**Purpose:** Integrates the existing hire form system into the platform. Handles driver verification, condition reports, and handover documentation.

- Client-facing hire form with driver details, licence verification, insurance acknowledgement
- Vehicle condition report with photos (existing system)
- Digital signature capture
- Automatic link to HireHop job and vehicle record
- Return condition comparison — before/after
- Feeds into deposit management and damage tracking

### 3.12 Training & Documentation Centre

**Purpose:** Every page in the platform has contextual help, and there's a central training hub for onboarding and ongoing staff development.

#### Contextual Help

- Every page/module has a "How to use this" tab
- Detailed explanations with screenshots, short video tutorials, or GIFs
- Explains not just "how" but "why" — how each function ties into the bigger picture

#### Training Hub

- Central page listing all training guides, organised by module/department
- Assignable: admins can assign specific guides to specific staff members
- Completion tracking: who has viewed/completed which guides, when
- Reminders: if assigned training isn't completed within X days, automatic nudge
- Review schedule: periodic reminders to review and update guides for accuracy
- Access control: some guides visible to all, others restricted by role (e.g. financial procedures only visible to senior staff)

### 3.13 Task Management

**Purpose:** A lightweight, flexible task system for anything that doesn't fit into the structured modules above.

- Ad-hoc to-do lists for individuals or teams
- Recurring tasks: building maintenance checks, weekly stock counts, monthly reports
- Tasks can be standalone or linked to any entity (Person, Job, Vehicle, etc.)
- Due dates, assignees, priority levels, status tracking
- Visible in the Command Centre dashboard

### 3.14 Administration & Settings

#### User Management

- Individual logins for every user — creates accountability and enables per-user audit trails
- Role-based access levels: Administrator, Manager, Staff, Warehouse, Driver, Freelancer (view-only delivery info), Client (portal access)
- Granular permissions: which modules each role can see, which actions they can perform
- Activity logging: who did what, when, providing the "who changed this?" transparency

#### System Settings

- Item defaults and configuration per module (mirroring the Settings Board pattern used in existing apps)
- Notification preferences: who gets alerted for what, via which channel (in-app, email, push)
- Integration settings: HireHop API credentials, Xero connection, Ticketmaster API, Traccar
- Custom field management: ability to add fields to entities without code changes
- Picklist management: loss reasons, issue categories, job types, relationship roles — all editable

### 3.15 Tour Supplies Shop (POS)

**Purpose:** A lightweight point-of-sale interface for ad-hoc shop sales of tour supplies (strings, batteries, tape, consumables etc). HireHop is not well suited to quick retail-style transactions, so this module provides a simple, fast way to record shop sales.

- Simple product catalogue with prices, categories, and stock levels
- Quick sale interface: select items, record payment method (card, cash, bank transfer, account)
- Option to link a sale to an existing Job and Person (e.g. touring client buys supplies while collecting van)
- Option for anonymous/walk-in sales
- Push to Xero as invoice or to HireHop as minimal job — TBD based on accounting preference
- Basic stock management: alerts when items run low, reorder reminders
- Sales reporting: daily/weekly/monthly totals, popular items, revenue by category

**Phase:** Phase 5+. Lower priority but captures revenue currently tracked informally.

---

## 4. Cross-Cutting Capabilities

These features span all modules and define the overall experience of using the platform.

### 4.1 Search

- Global search across all entities: People, Organisations, Jobs, Vehicles, Opportunities, Venues
- Fuzzy matching for names and companies
- Filters: entity type, date range, status, assigned user, tags
- Recent searches and frequently accessed records
- Deep search into notes, timeline entries, and file attachments

### 4.2 Notifications & @Mentions

- In-app notification centre showing all items requiring attention
- @mention any team member within any timeline/conversation — they receive an in-app and email notification
- Configurable notification preferences per user
- Scheduled follow-up reminders that surface at the right time
- Escalation rules: if a notification isn't acknowledged within X hours, escalate to manager
- Working hours enforcement: standard notifications respect staff working hours from Module 3.9. Emergency flags (road breakdowns, urgent client issues) can override this.
- Holiday-aware routing: if the intended recipient is on leave, notifications auto-divert to their designated cover from the staff module

### 4.3 Audit Trail

- Every create, update, and delete operation logged with user, timestamp, and before/after values
- Viewable per entity: "Show me everything that changed on Job 4521"
- Filterable by user: "Show me everything Sarah did today"
- Immutable — audit entries cannot be edited or deleted

### 4.4 AI Integration

Claude's API woven into the platform to assist with daily operations:

- **Email parsing:** Incoming enquiry emails automatically parsed to pre-populate Opportunity fields (dates, equipment, venue, budget signals)
- **Backline matching:** Existing tool integrated — AI suggests equipment alternatives from live HireHop inventory
- **Cold lead enrichment:** Ticketmaster-sourced touring acts enriched with AI analysis of hire likelihood, routing patterns, and equipment needs
- **Smart follow-ups:** AI suggests optimal follow-up timing and messaging based on communication history and deal stage
- **Issue resolution assistance:** When a road problem is reported, AI suggests resolution steps based on similar past issues
- **Natural language querying:** "Show me all festival clients from last summer who haven't booked yet this year" — AI translates to database query

### 4.5 Mobile / Responsive Access

- Progressive Web App (PWA) — works on any phone/tablet via browser
- Installable to home screen for app-like experience
- Push notifications via service worker
- Key mobile use cases: crew viewing delivery details, drivers updating status, warehouse staff logging equipment returns, managers checking dashboard on the move
- Offline capability for critical functions (viewing assigned delivery details)

### 4.6 Reporting & Dashboards

- Pre-built reports: pipeline conversion, revenue by client tier, win/loss analysis, time-to-quote, seasonal trends, fleet utilisation, cost vs income per delivery
- Custom report builder for ad-hoc queries
- Scheduled report delivery via email (weekly pipeline summary, monthly financials)
- Exportable to CSV/PDF for sharing

---

## 5. Integration Architecture

Each external system has a clearly defined role. The platform never duplicates business logic that belongs in another system.

### HireHop → Platform

Job data sync (webhook on status change + periodic batch). Stock availability queries on demand. Contact sync (platform is master, pushes to HireHop). Quote generation triggered from platform, created in HireHop. Billing summaries pulled for display.

### Platform → HireHop

New job creation when Opportunity converts. Contact create/update push. Status changes. Custom field updates. Items added to jobs (via staging calculator, backline matcher, etc.)

### Xero → Platform

Financial summaries: outstanding balance, overdue invoices, payment history, average payment days. Invoice status for jobs. Read-only — the platform never writes to Xero directly.

### Ticketmaster API

Touring act data feeding the cold lead finder. Venue routing data. Event scheduling intelligence.

### Traccar GPS

Live vehicle positions. Geofence alerts (congestion zone, Dover, Eurotunnel). Historical route data.

### Stripe

Payment portal integration for deposits and excess payments. Payment status webhooks.

### Email (IMAP/SMTP)

Inbound email parsing for enquiries and communication logging. Outbound notifications and campaigns.

### The Cross-Reference Map

A central ID mapping table links every entity across systems: CRM Person ID ↔ HireHop Contact ID ↔ Xero Contact ID. This is the backbone that prevents duplication and enables clean data flow. Primary match key: email address. Secondary: company name + person name.

---

## 6. Existing Tools Migration Map

Current standalone tools and where they land in the new platform:

| Current Tool | Destination | Notes |
|---|---|---|
| **Payment Portal** | Module 3.8 (Financial Operations) | Core Stripe/HireHop/Monday logic migrates. Insurance deposit tracking becomes native. |
| **Vehicle Manager** | Module 3.7 (Fleet & Equipment) | Vehicle profiles, PCN tracking, maintenance scheduling integrate. |
| **PCN Manager** | Sub-module of 3.7 | Claude vision AI processing continues; results logged against Vehicle and Job records. |
| **Staging Calculator** | Standalone, accessed from 3.4 | Pushes to HireHop jobs. Continues as-is. |
| **Backline Matcher** | AI integration within 3.4 | Demand logging moves from Monday to platform database. |
| **Delivery Portal** | Module 3.5 | Freelancer/driver view becomes a role-restricted login. |
| **Hire Forms** | Module 3.11 | Existing form logic integrates into vehicle handover workflow. |
| **Cold Lead Finder** | Module 3.3 | Ticketmaster scraper feeds Opportunities with AI enrichment. |
| **Crew Transport Wizard** | Module 3.5 | Quoting and costing logic becomes native. |
| **Rehearsal Studio Sitters Portal** | Future module | Communication and task management using platform patterns. |

---

## 7. Phased Build Approach

Build starts immediately (March 2026). Each phase delivers standalone value. Soft deadline: Monday.com subscription expires July 2026. Target is operational parity by Phase 4, allowing Monday switch-off.

### Phase 1: Foundation & CRM Core (March–April 2026)

- Core data model: People, Organisations, Relationships, Venues
- User authentication and role-based access (JWT)
- Contact management with relationship mapping
- Activity timeline with @mentions and notes
- Basic search and filtering
- HireHop contact sync (two-way)
- Command Centre dashboard (initial version with HireHop data)
- Built with dummy data. Internal testing only.

### Phase 2: Sales Pipeline & Job Integration (April–May 2026)

**Milestone:** Begin parallel-running alongside Monday. Bring in team testers.

- Opportunity pipeline with stages, Kanban view, and follow-up scheduling
- HireHop job sync — jobs mirrored with enriched context and Job Requirements checklist
- Job close-out workflow
- Role-based automated email routing
- Win/loss tracking and analytics
- Xero financial summary integration (read-only)
- Cold lead finder integration (Ticketmaster API + blind/forum leads)
- Time-to-quote tracking

### Phase 3: Operations Modules (May–June 2026)

- Delivery, collection & crew management (absorb freelancer portal)
- Vehicle management (migrate from standalone Vehicle Manager)
- Equipment issue tracking
- Insurance deposit & excess tracking (payment-method-agnostic: Stripe, bank transfer, PayPal, cash)
- Staff HR basics (holidays, TOIL, availability, shift coverage)
- Migrate standalone tools: payment portal, hire forms, PCN manager

### Phase 4: Client Services, Polish & Migration (June–July 2026)

**Milestone:** Monday.com switch-off. Data migration from Monday boards.

- Advance receiving (merch/boxes)
- Lost property tracker
- Carnet management
- Training & documentation centre
- Reporting suite
- Data migration: import Monday board exports (CSV), map relationships, validate
- Team fully transitioned to new platform

### Phase 5: Intelligence Layer (August 2026 onwards)

- AI email parsing and enquiry pre-population
- CLV calculation and RFM segmentation
- Relationship movement detection
- Referral chain tracking and influencer scoring
- Seasonal outreach automation
- Natural language querying
- Tour supplies shop / POS module
- Predictive analytics
- Continuous improvement and feature expansion

### Monday.com Transition Strategy

Phase 1–2: Both systems run in parallel. Monday remains the working tool while the platform is built and tested with dummy data, then with real data alongside Monday. Phase 3: Team begins using the platform for new operations modules while Monday continues for pipeline. Phase 4: Full data migration from Monday (boards export to CSV; import scripts map data to new schema with manual relationship validation for older records). Monday subscription cancelled at expiry (July 2026). Free-tier Monday retained for any ad-hoc non-work use.

---

## 8. Key Design Principles

### 8.1 Speed Wins Deals

Research shows 78% of customers buy from the first company to respond. The platform must never create friction before a quote goes out. The workflow is: enquiry arrives → quick quote out of HireHop using whatever name/company details are available → platform handles the "actually it's for Band Y not X" correction after the quote is sent. Relationship enrichment happens in parallel with the sales process, never as a gate before it.

### 8.2 People Are the Primary Entity

The touring industry runs on freelance individuals who change roles and organisations constantly. The system must track people independently of any company, with multiple simultaneous role-based associations that carry dates and history. When a tour manager moves from Band A to Band B, that's a lead opportunity — and the system should surface it automatically.

### 8.3 Each System Owns Its Domain

HireHop owns jobs, equipment, stock, availability, and invoicing. Xero owns financial records and accounting. The platform owns relationships, pipeline intelligence, communication history, operational coordination, and analytics. No system duplicates another's business logic. Data flows between them via API with clear rules about which system is authoritative for each data type.

### 8.4 One Roof, One Brain

The platform is a single unified system, not a collection of separate tools. Staff HR data informs notification routing. Job requirements trigger workflows across multiple modules. The delivery schedule knows who's on holiday. The pipeline knows what equipment is on the road. Everything connects, and that interconnection is the core value proposition over the current Monday + HireHop + standalone tools setup.

### 8.5 Capture Now, Enrich Later

Every piece of data capture should be as frictionless as possible. A blind lead from a touring forum should take 10 seconds to log. A found item of lost property should take one photo and two taps. A road problem report should be a quick form, not a 15-field bureaucratic exercise. The system handles enrichment, linking, and follow-up workflows after the initial capture.

### 8.6 From Rehearsal Room to Main Stage

The company mission guides the platform design. Ooosh Tours provides a complete touring rental solution — rehearsal, transport, equipment, crew — and the platform should reflect that breadth. A single client journey might touch rehearsal booking, van hire, backline rental, crewed delivery, and tour supplies — and the system should make that seamless, with every touchpoint enriching the overall picture of the relationship.

---

## 9. Technical Architecture

### 9.1 Stack

| Layer | Technology | Hosting |
|-------|-----------|---------|
| **Frontend** | React (Vite) | Netlify (auto-deploys from GitHub) |
| **Backend API** | Node.js + Express | Hetzner VPS (CAX11: 2 vCPU, 4GB RAM) |
| **Database** | PostgreSQL | Hetzner |
| **Caching / Queues** | Redis | Hetzner |
| **Real-time** | Socket.io | Alongside Express |
| **File Storage** | Cloudflare R2 | Existing |
| **Authentication** | JWT | Email + password login |
| **Email** | Gmail API (Google Workspace) | Reads inbound, sends outbound |
| **Version Control** | GitHub | Monorepo |

### 9.2 Infrastructure Diagram

```
User's browser → React app (Netlify)
                    → API calls to Hetzner backend
                        → Express server
                            → PostgreSQL
                            → Redis
                            → Socket.io
                        → External APIs:
                            → HireHop
                            → Xero
                            → Gmail
                            → Stripe
                            → Traccar
                            → Ticketmaster
                            → Claude AI
```

### 9.3 HireHop API Considerations

- **Rate limit:** 60 requests/minute, 3/second. Redis caching mitigates this for read operations.
- Dedicated API user account required (tokens invalidate on browser login).
- Webhook-first for real-time sync (job status changes, invoice events). Batch sync nightly for derived data.
- **Known pinch point:** HireHop cements the Person + Company → Xero link at job creation. Investigate API capability to update job company/contact association post-creation, and whether this cascades to Xero. If not, platform should resolve the 'who's paying' question before pushing jobs to HireHop where possible, or handle Xero corrections separately.

### 9.4 Hosting Notes

- Current Hetzner CAX11 (4GB RAM) is adequate for initial build and early usage (6–8 concurrent users).
- Hetzner allows in-place resize (brief reboot) — upgrade to CX22 (8GB) or CX32 if needed, with zero migration.
- Automated daily PostgreSQL backups to R2. Hetzner snapshots also enabled for belt-and-braces.
- All services (backend, database, Redis, Traccar) run on the same box for minimal latency and cost.
- Frontend on Netlify remains separate — independent scaling, familiar deployment pipeline, free tier sufficient.

---

## 10. Monday.com Board Migration Map

Every current Monday board mapped to its destination in the new platform. Data migration via CSV export with import scripts.

### Core Boards

| Monday Board | Platform Destination |
|---|---|
| Quotes & Hires | Modules 3.3 (Pipeline), 3.4 (Job Operations) |
| Completed Hires (2023–2025) | Historical Job records → CLV/RFM in Phase 5 |
| Lost / Cancelled Hires | Module 3.3 win/loss tracking |
| Deliveries / Collections | Module 3.5 |
| Crewed Jobs | Module 3.5 |

### People & Places

| Monday Board | Platform Destination |
|---|---|
| Address Book – Clients | People & Organisations (Module 3.2) |
| Address Book – Venues | Venues entity |
| Address Book – Suppliers | Organisations (Supplier type) |
| Freelance Crew | People (Freelancer role) |
| Driver Database | People (Driver role) |

### Operations Boards

| Monday Board | Platform Destination |
|---|---|
| Driver Hire Forms | Module 3.11 |
| Things Being Sent To Us | Module 3.6a |
| Lost Property & Temp Storage | Module 3.6b |
| Carnets | Module 3.10 |
| Fleet Management | Module 3.7 |
| Vehicles on Hire / Need Prepping | Module 3.7 + Command Centre |
| Vehicle Repairs / Insurance Claims | Module 3.7 (Issue Tracking) |
| Storage Clients | Module 3.8 |
| Receipts to Recharge | Module 3.8 |

### Admin & Reference Boards

| Monday Board | Platform Destination |
|---|---|
| Staff Leave Calendar | Module 3.9 |
| What To Do and How To Do It! | Module 3.12 |
| Tasks – Unrelated to Hires | Module 3.13 |
| Overview Dashboard | Module 3.1 (Command Centre) |

### The Reminders System Translation

Monday's Reminders column with colour-coded labels (Vehicle–SDH, Carnet, Crew, Backline, Delivery, Rehearsal, Forward Facing Seats, Sub Hires, etc.) becomes the **Job Requirements Checklist** in Module 3.4. Instead of labels that trigger sub-items which mirror to linked boards, each requirement flag creates a proper record in the correct module. The job's status summary panel replaces the 'Boards status' mirror columns — showing green/amber/red for each requirement at a glance.

---

*— End of Specification v1.1 —*
