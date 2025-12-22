# Ooosh Freelancer Portal

A web-based portal for managing freelancer job assignments, delivery/collection tracking, and cost management for Ooosh Tours.

## Overview

This portal provides Ooosh Tours' freelancers with a mobile-friendly interface to:
- View upcoming, current, and past job assignments
- See grouped multi-drop runs as unified tasks
- Complete deliveries/collections with signature and photo capture
- Track earnings and manage invoicing

The portal integrates with Monday.com as the source of truth for all job data.

## Tech Stack

- **Frontend:** Next.js 14 (React)
- **Hosting:** Netlify
- **Database:** Monday.com (via API)
- **Authentication:** Email/password with secure sessions
- **Notifications:** Email (SendGrid)

## Project Structure

```
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── (auth)/            # Auth pages (login, register, reset)
│   │   ├── (portal)/          # Main portal pages (dashboard, jobs, etc.)
│   │   ├── api/               # API routes
│   │   └── layout.tsx         # Root layout
│   ├── components/            # Reusable React components
│   │   ├── ui/               # Base UI components
│   │   └── ...               # Feature-specific components
│   ├── lib/                   # Utility functions and services
│   │   ├── monday.ts         # Monday.com API client
│   │   ├── auth.ts           # Authentication utilities
│   │   └── ...
│   └── types/                 # TypeScript type definitions
├── public/                    # Static assets
├── docs/                      # Documentation
│   └── SPEC.md               # Technical specification
└── ...
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Monday.com API token
- Netlify account (for deployment)

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/jon-ooosh/Ooosh-Freelancer-Portal.git
   cd Ooosh-Freelancer-Portal
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create environment file:
   ```bash
   cp .env.example .env.local
   ```

4. Configure environment variables (see below)

5. Run the development server:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000)

### Environment Variables

Create a `.env.local` file with the following:

```env
# Monday.com API
MONDAY_API_TOKEN=your_monday_api_token
MONDAY_BOARD_ID_DELIVERIES=your_dc_board_id
MONDAY_BOARD_ID_FREELANCERS=your_freelancers_board_id
MONDAY_BOARD_ID_COSTINGS=your_costings_board_id
MONDAY_BOARD_ID_VENUES=your_venues_board_id

# Authentication
SESSION_SECRET=generate_a_secure_random_string_here
BCRYPT_ROUNDS=12

# Email (SendGrid)
SENDGRID_API_KEY=your_sendgrid_api_key
EMAIL_FROM=noreply@oooshtours.com

# App Config
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Development only (NEVER set in production)
# ENABLE_DEBUG=true
```

**⚠️ NEVER commit `.env.local` to Git. It's already in `.gitignore`.**

## Deployment

The app is configured for automatic deployment via Netlify:

- **Production:** Pushes to `main` branch deploy to production
- **Preview:** Pull requests get preview deployments

### Netlify Configuration

1. Connect the GitHub repo to Netlify
2. Set environment variables in Netlify dashboard (Site settings > Environment variables)
3. Build settings are configured in `netlify.toml`

## Documentation

- [Technical Specification](docs/SPEC.md) - Full project specification
- [Progress Tracker](PROGRESS.md) - Current development status

## Security

See the Technical Specification for full security details. Key points:

- All API routes require authentication
- Passwords stored as bcrypt hashes
- Monday API token is server-side only (never exposed to browser)
- Client PII (phone numbers) only visible within 48 hours of job date
- Rate limiting on authentication endpoints

### Reporting Security Issues

If you discover a security vulnerability, please contact us directly rather than opening a public issue.

## License

Proprietary - Ooosh Tours Ltd. All rights reserved.
