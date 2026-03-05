# Ooosh Operations Platform — Maintenance & Health Register

**Purpose:** A living document tracking everything that will need ongoing attention, scheduled maintenance, likely failure points, and upgrade paths. The goal is to predict and prevent problems rather than react to them.

**Last reviewed:** March 2026

---

## 1. Scheduled Maintenance Items

These are things that **will** need doing on a known schedule. Non-negotiable.

### 1.1 SSL Certificate (Let's Encrypt)

| Item | Detail |
|------|--------|
| **What** | SSL certificate for the API domain on Hetzner |
| **Frequency** | Auto-renews every 90 days via Certbot |
| **Failure mode** | If renewal fails, API becomes unreachable over HTTPS |
| **Mitigation** | Certbot cron job + monitoring alert if cert expiry < 14 days |
| **Action if broken** | SSH to Hetzner, run `sudo certbot renew --force-renewal` |
| **Status** | [ ] Not yet configured |

### 1.2 Database Backups

| Item | Detail |
|------|--------|
| **What** | Daily PostgreSQL backups to Cloudflare R2 |
| **Frequency** | Daily automated, plus Hetzner snapshots |
| **Failure mode** | Backup script fails silently; data loss if DB corrupts |
| **Mitigation** | Backup script sends success/failure notification. Weekly test restore. |
| **Action if broken** | Check cron job, verify R2 credentials, run manual `pg_dump` |
| **Status** | [ ] Not yet configured |

### 1.3 Node.js Runtime Updates

| Item | Detail |
|------|--------|
| **What** | Node.js LTS version on Hetzner server |
| **Frequency** | LTS releases every 12 months (even-numbered: 18, 20, 22, etc.). Security patches more frequently. |
| **Failure mode** | Running an EOL version means no security patches |
| **Mitigation** | Use `nvm` for easy version switching. Calendar reminder when current LTS enters maintenance mode. |
| **Current version** | TBD (will use Node 20 LTS at launch) |
| **Next action date** | October 2026 — Node 22 LTS becomes active; evaluate upgrade |
| **Status** | [ ] Not yet configured |

### 1.4 npm Dependency Updates

| Item | Detail |
|------|--------|
| **What** | All npm packages in backend and frontend |
| **Frequency** | Monthly review. Security patches immediately. |
| **Failure mode** | Vulnerabilities in outdated packages; breaking changes if left too long |
| **Mitigation** | `npm audit` in CI pipeline. Dependabot or Renovate on GitHub for automated PRs. Monthly manual review. |
| **Automated tooling** | GitHub Dependabot (enable on repo) — creates PRs for outdated/vulnerable dependencies |
| **Action** | Review and merge Dependabot PRs monthly. Run test suite before merging. |
| **Status** | [ ] Not yet configured |

### 1.5 PostgreSQL Version Updates

| Item | Detail |
|------|--------|
| **What** | PostgreSQL major version on Hetzner |
| **Frequency** | Major release annually. Minor/security patches quarterly. |
| **Failure mode** | EOL version = no security patches |
| **Mitigation** | Minor updates: `apt upgrade`. Major updates: dump/restore with testing. |
| **Current version** | TBD (will use PostgreSQL 16 at launch) |
| **Status** | [ ] Not yet configured |

### 1.6 Hetzner Server OS Updates

| Item | Detail |
|------|--------|
| **What** | Ubuntu/Debian security patches on VPS |
| **Frequency** | Monthly `apt update && apt upgrade` for security patches |
| **Failure mode** | Unpatched OS vulnerabilities |
| **Mitigation** | Unattended-upgrades for security patches. Monthly manual review for non-security. |
| **Status** | [ ] Not yet configured |

---

## 2. External API Dependencies

Things we don't control that **will** change or break eventually.

### 2.1 HireHop API

| Item | Detail |
|------|--------|
| **Risk level** | HIGH — core dependency |
| **What can go wrong** | API changes/deprecation, rate limit changes, authentication changes, downtime |
| **Rate limit** | 60 req/min, 3/sec — we cache via Redis to stay well under |
| **Auth concern** | Token invalidates when user logs into browser. Dedicated API-only user account required. |
| **Monitoring** | Log all API call success/failure rates. Alert if error rate > 5% in 10 minutes. |
| **Mitigation** | Redis cache for reads (reduces API calls by ~80%). Graceful degradation — platform remains usable if HireHop is down, just with stale data. |
| **Versioning** | HireHop doesn't version their API — changes can arrive without notice. Pin our integration to known response shapes and validate. |
| **Action plan** | If API breaks: check HireHop changelog/status, adapt integration code, fall back to cached data. |

### 2.2 Xero (via HireHop)

| Item | Detail |
|------|--------|
| **Risk level** | MEDIUM — read-only, flows through HireHop |
| **What can go wrong** | HireHop's Xero integration breaks, OAuth token expires |
| **Monitoring** | Track freshness of financial data. Alert if last sync > 24 hours old. |
| **Mitigation** | Financial data is display-only in our platform. If stale, show "last updated" timestamp. |

### 2.3 Stripe

| Item | Detail |
|------|--------|
| **Risk level** | MEDIUM |
| **What can go wrong** | API version deprecation (Stripe gives 2+ years notice), webhook endpoint changes |
| **Monitoring** | Stripe dashboard alerts for API deprecation. Webhook failure notifications. |
| **Mitigation** | Pin Stripe API version in code. Monitor Stripe's deprecation announcements. |
| **Frequency** | Review Stripe API version annually. |

### 2.4 Gmail API (Google Workspace)

| Item | Detail |
|------|--------|
| **Risk level** | MEDIUM |
| **What can go wrong** | OAuth refresh token expires (rare but possible), API quota exceeded, Google policy changes |
| **Monitoring** | Alert on failed email send/receive operations. Track quota usage. |
| **Mitigation** | Robust OAuth refresh handling. Queue outbound emails in Redis (retry on failure). |

### 2.5 Ticketmaster API

| Item | Detail |
|------|--------|
| **Risk level** | LOW — used for cold lead enrichment only |
| **What can go wrong** | Rate limits, API key expiry, data format changes |
| **Monitoring** | Log enrichment success rate. |
| **Mitigation** | Non-critical feature. If API fails, cold leads just don't get auto-enrichment. |

### 2.6 Traccar GPS

| Item | Detail |
|------|--------|
| **Risk level** | LOW — self-hosted, display-only |
| **What can go wrong** | Traccar server goes down, API changes on major update |
| **Monitoring** | Ping check on Traccar endpoint. |
| **Mitigation** | GPS data is nice-to-have, not business-critical. |

### 2.7 Claude AI API (Anthropic)

| Item | Detail |
|------|--------|
| **Risk level** | LOW — Phase 5 feature |
| **What can go wrong** | Model deprecation, pricing changes, rate limits |
| **Monitoring** | Track API call costs and success rates. |
| **Mitigation** | All AI features are assistive, not blocking. Platform works without them. |

---

## 3. Infrastructure Failure Points

### 3.1 Hetzner VPS (Single Server)

| Item | Detail |
|------|--------|
| **Risk** | Single point of failure — all backend services on one box |
| **Failure mode** | Server goes down = API, DB, Redis, Socket.io all unavailable |
| **Mitigation (Phase 1-4)** | Hetzner has 99.9% SLA. Automated snapshots. Daily DB backups to R2 (off-site). Recovery: spin up new VPS, restore from backup. Expected recovery time: 30-60 minutes. |
| **Mitigation (Phase 5+)** | Consider separating DB to managed PostgreSQL if usage grows. But for 6-8 users, single server is fine. |
| **Monitoring** | External uptime monitor (UptimeRobot or similar) pinging API health endpoint every 60 seconds. |

### 3.2 Netlify (Frontend)

| Item | Detail |
|------|--------|
| **Risk** | LOW — Netlify has excellent uptime |
| **Failure mode** | Frontend unreachable |
| **Mitigation** | Netlify's built-in CDN and redundancy. Nothing to manage. |

### 3.3 Cloudflare R2 (File Storage)

| Item | Detail |
|------|--------|
| **Risk** | LOW — Cloudflare infrastructure |
| **Failure mode** | Files (photos, documents, backups) unavailable |
| **Mitigation** | Cloudflare's built-in redundancy. Critical backups should also have a secondary copy (e.g. Hetzner snapshot includes a recent DB dump on disk). |

---

## 4. Security Maintenance

### 4.1 JWT Secret Key

| Item | Detail |
|------|--------|
| **What** | The secret used to sign authentication tokens |
| **Rotation** | Rotate annually or immediately if suspected compromise |
| **Impact of rotation** | All active sessions are invalidated — users must re-login |
| **Procedure** | Update `.env` on server, restart backend, notify team |

### 4.2 API Keys & Secrets

All stored in `.env` on Hetzner, never in code. Inventory:

| Key | Rotation frequency | Notes |
|-----|-------------------|-------|
| `DATABASE_URL` | On password change | PostgreSQL connection string |
| `REDIS_URL` | On password change | Redis connection string |
| `HIREHOP_API_TOKEN` | If compromised | Dedicated API user |
| `STRIPE_SECRET_KEY` | If compromised | Rotate via Stripe dashboard |
| `GOOGLE_CLIENT_SECRET` | If compromised | OAuth credentials |
| `CLOUDFLARE_R2_ACCESS_KEY` | Annually | Storage access |
| `CLAUDE_API_KEY` | If compromised | Phase 5 |
| `TICKETMASTER_API_KEY` | If compromised | Phase 2+ |
| `TRACCAR_API_TOKEN` | If compromised | Phase 3+ |

### 4.3 OWASP Top 10 Checklist

Built into the codebase from day one:

- [ ] SQL injection — parameterised queries only (never string concatenation)
- [ ] XSS — React handles output encoding; CSP headers configured
- [ ] CSRF — SameSite cookies + CSRF tokens for state-changing requests
- [ ] Authentication — bcrypt password hashing, JWT with expiry, refresh token rotation
- [ ] Access control — RBAC middleware on every route
- [ ] Input validation — Zod schemas on all API inputs
- [ ] Rate limiting — Express rate limiter on auth endpoints
- [ ] Logging — Audit trail captures all changes

---

## 5. Monitoring & Alerting (To Be Set Up)

### 5.1 Health Check Endpoint

`GET /api/health` returns:

```json
{
  "status": "ok",
  "database": "connected",
  "redis": "connected",
  "hirehop": "reachable",
  "uptime": "3d 14h 22m",
  "version": "1.0.0"
}
```

### 5.2 External Monitoring

| Tool | Purpose | Cost |
|------|---------|------|
| UptimeRobot (free tier) | Ping `/api/health` every 60s, alert on downtime | Free |
| GitHub Dependabot | Automated dependency vulnerability PRs | Free |
| Sentry (free tier) | Frontend + backend error tracking | Free for 5k events/month |

### 5.3 Log Monitoring

- PM2 logs for backend process health
- PostgreSQL slow query log enabled
- Nginx access/error logs
- Failed API call tracking (HireHop, Stripe, etc.)

---

## 6. Capacity Planning

### 6.1 Current Sizing

| Resource | Spec | Adequate for |
|----------|------|-------------|
| Hetzner CAX11 | 2 vCPU, 4GB RAM | 6-8 concurrent users, ~10k records |
| PostgreSQL | On same box | Fine for this data volume |
| Redis | On same box | Fine for caching + sessions |

### 6.2 Growth Triggers (When to Upgrade)

| Signal | Action |
|--------|--------|
| RAM consistently > 80% | Upgrade to CX22 (8GB). Hetzner in-place resize, brief reboot. |
| DB size > 10GB | Consider dedicated PostgreSQL (Hetzner managed or separate VPS) |
| > 20 concurrent users | Consider load balancing / horizontal scaling |
| API response time > 500ms P95 | Profile queries, add indexes, consider read replicas |

*Note: These thresholds are unlikely to be reached with the current team size. This is future-proofing.*

---

## 7. Disaster Recovery

### 7.1 Backup Strategy

| What | How | Where | Frequency | Retention |
|------|-----|-------|-----------|-----------|
| PostgreSQL | `pg_dump` via cron | Cloudflare R2 | Daily | 30 days |
| Hetzner VPS | Hetzner snapshot | Hetzner | Weekly | 4 snapshots |
| Uploaded files | Already on R2 | Cloudflare R2 | N/A (source of truth) | Indefinite |
| Code | Git | GitHub | Every push | Indefinite |
| `.env` / secrets | Manual copy | Secure off-site location | On change | Current only |

### 7.2 Recovery Procedure

1. Spin up new Hetzner VPS (same spec or larger)
2. Install dependencies (Node, PostgreSQL, Redis, Nginx, PM2, Certbot)
3. Restore PostgreSQL from latest R2 backup
4. Clone code from GitHub, install npm packages
5. Restore `.env` from secure backup
6. Configure Nginx + SSL
7. Start with PM2
8. Update DNS if IP changed
9. Verify health endpoint
10. **Estimated recovery time: 30-60 minutes** (assuming familiarity with the process)

### 7.3 Recovery Testing

- [ ] Test restore from backup quarterly
- [ ] Document any deviations from the procedure above
- [ ] Keep this procedure up to date as the stack evolves

---

## 8. Annual Review Checklist

Run through this every January (or more frequently if desired):

- [ ] Node.js version — still in LTS support?
- [ ] PostgreSQL version — still in support?
- [ ] All npm dependencies — `npm audit` clean?
- [ ] SSL certificate — auto-renewal working?
- [ ] Hetzner VPS — right size for current usage?
- [ ] External API integrations — any deprecation notices?
- [ ] Backup restoration — tested recently?
- [ ] JWT secret — due for rotation?
- [ ] API keys — any due for rotation?
- [ ] Monitoring — alerts still working? (Send a test alert)
- [ ] This document — still accurate?

---

## 9. Automated Health Checker (Phase 5+)

**Future goal:** A built-in system health page accessible to admins that runs automated checks:

- [ ] Database connection and response time
- [ ] Redis connection and memory usage
- [ ] HireHop API reachability and response time
- [ ] SSL certificate expiry date
- [ ] Node.js version vs latest LTS
- [ ] npm audit summary (vulnerabilities found)
- [ ] Disk space on Hetzner
- [ ] Backup age (time since last successful backup)
- [ ] Uptime and restart history
- [ ] Error rate over last 24 hours

This gives you a single dashboard showing the health of the entire platform — no SSH required. We'll build this into the Admin module when we reach Phase 5.

---

## 10. Known Technical Debt & Watch Items

*Items added during development that need future attention.*

| Date Added | Item | Priority | Notes |
|-----------|------|----------|-------|
| Mar 2026 | HireHop API has no versioning | HIGH | Monitor for breaking changes. Validate response shapes. |
| Mar 2026 | Single-server architecture | LOW | Fine for current scale. Revisit if team grows significantly. |
| Mar 2026 | Monday.com data migration | MEDIUM | CSV imports need manual relationship validation for older records. |

---

*This document should be updated whenever: a new dependency is added, an integration is changed, infrastructure is modified, or a new failure mode is discovered.*
