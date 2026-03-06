# Ooosh Operations Platform

A unified business operations hub for Ooosh Tours — replacing Monday.com and wrapping around HireHop and Xero. Manages people, organisations, venues, jobs, deliveries, fleet, and the full sales pipeline.

## Tech Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL 16
- **Cache:** Redis
- **Auth:** JWT (bcrypt password hashing)
- **Hosting:** Hetzner VPS (backend + DB), Nginx reverse proxy

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis

### Setup

```bash
# Clone
git clone https://github.com/jon-ooosh/Ooosh-Freelancer-Portal.git
cd Ooosh-Freelancer-Portal

# Backend
cd backend
cp .env.example .env    # Configure database URL, JWT secret, etc.
npm install
npm run db:migrate      # Create tables
npm run db:seed         # Seed demo data
npm run dev             # Start dev server on port 3001

# Frontend (in another terminal)
cd frontend
npm install
npm run dev             # Start Vite dev server on port 5173
```

### Demo Login

- **Admin:** admin@oooshtours.co.uk / admin12345
- **Freelancer:** tom@example.com / freelancer123

## Documentation

- [System Specification](docs/SPEC.md) — Full module architecture and phased build plan
- [Maintenance & Health Register](docs/MAINTENANCE.md) — Infrastructure, dependencies, and disaster recovery
- [CLAUDE.md](CLAUDE.md) — Development guide, current status, and conventions

## Deployment

Server deployment scripts are in `deploy/`. See `deploy/setup-server.sh` for initial server provisioning and `deploy/deploy.sh` for updates.

## License

Proprietary — Ooosh Tours Ltd. All rights reserved.
