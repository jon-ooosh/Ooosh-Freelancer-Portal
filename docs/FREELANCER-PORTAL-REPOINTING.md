# Freelancer Portal Repointing — Working Doc

**Status:** IN PROGRESS
**Date opened:** 17 Apr 2026
**Branch:** `claude/ooosh-operations-platform-KMIQj`
**Target:** Go live off Monday.com for freelancer crew / D&C / collection work by EOD 17 Apr 2026

## Goal

The freelancer-facing Next.js portal at `freelancer.oooshtours.co.uk` reads/writes from the OP backend (`staff.oooshtours.co.uk`) exclusively. Monday.com stops being the source of truth for freelancer assignments, job details, and completion.

## What was already built before this session

- `backend/src/routes/portal.ts` — portal session JWT, jobs list, job detail, equipment via HireHop broker, completion submission (photos as base64 in JSONB), venue detail
- Migration 025 — `portal_password_hash`, `portal_email_verified`, `portal_last_login` on `people` table
- `src/lib/op-api.ts` — Next.js helper with `isOpMode()` feature flag (`DATA_BACKEND=op`) wrapping login, jobs, job detail, equipment, completion
- Next.js routes with OP-mode branch + Monday fallback: `/api/auth/login`, `/api/jobs`, `/api/jobs/[id]`, `/api/jobs/[id]/complete`
- Migration 024 — `ops_status` lifecycle on quotes, crew confirmation fields, `is_ooosh_crew` flag
- Email templates `freelancer_assignment` and `job_change_notification` exist (but `freelancer_assignment` is never fired)
- `quotes.ts` PUT endpoint sends `job_change_notification` when date/time/venue change on a confirmed quote

## Gaps addressed in this session

1. **Registration / password reset on OP** — none existed. Existing 12 freelancers need to reset on first OP login; new signups need the "two-tick" gate (`is_freelancer=true AND is_approved=true`) against the `people` table, same as the Monday board check.
2. **Assignment email not fired** — template exists but trigger is missing in `assignments.ts`.
3. **Completion flow incomplete** — no delivery-note PDF, no client email, no staff alert, photos in base64 instead of R2.
4. **No completion chase scheduler** on OP (Netlify `completion-reminders.ts` not ported).
5. **No portal files endpoint** honouring `share_with_freelancer`.
6. **Silent Monday fallback** — portal routes fall back to Monday on OP error with only a `console.log`; we can't tell if it's working or regressing silently.

## Out of scope for this session

- **Van book-out token + hire form from portal** — will be handled by a parallel session (Jon running another Claude). When this is done, the portal's van-specific flow wires into OP's hire-form endpoints instead of the Netlify `SignaturePage.js`.
- **Resources page** — still on Monday for now. Low urgency. Will use the same `share_with_freelancer` pattern when ported.
- **Staff / warehouse / hirehop-items / settings-notifications** portal sub-routes — stay Monday-wired for go-live.

---

## Decisions

### Password migration (existing 12 users)
No bulk import. Existing freelancers hit "Forgot Password" on first OP login. Email contains a signed reset token (JWT, 1h expiry). They set a new password.

### Registration gate — "two ticks" on OP
`POST /portal/auth/register/start` looks up `people WHERE lower(email)=$1 AND is_freelancer=true AND is_approved=true`. If not found → "your email isn't on our approved list, please contact us". If found and already has `portal_password_hash` → "you already have an account". Otherwise → send 6-digit verification code, on verify + complete → set hash + `portal_email_verified=true`.

### Delivery-note PDF
Port `src/lib/pdf.ts::generateDeliveryNotePdf` as-is to `backend/src/services/delivery-note-pdf.ts`. Same pdf-lib output, branded layout, equipment list, photos + signature embedded. Equipment is pulled from HireHop via the broker (not from the portal payload).

### Photos & signature → R2
Under `completion/{quote_id}/photo-N.jpg` and `completion/{quote_id}/signature.png`. PDF at `delivery-notes/{quote_id}/delivery-note.pdf`. Existing `completion_photos` JSONB will now hold R2 keys; `completion_signature` will hold an R2 key. Old base64 records stay valid for historical display.

### Chase cadence (ported from Netlify)
- 2h / 6h / 14h after job time (first/second/third reminder to the freelancer)
- After level 3 → staff escalation email to `info@oooshtours.co.uk`
- Business hours 07:00–22:00 local only
- `quotes.completion_reminder_level` column tracks (0→3). Bump **before** send to prevent duplicates on scheduler restart.
- Cron: every 30 min

### Monday fallback alerting
Every Monday-fallback path in the Next.js portal calls a new OP telemetry endpoint:

```
POST /api/portal/telemetry/monday-fallback
Headers: X-Portal-Telemetry-Key: <shared secret>
Body: { operation: 'login' | 'jobs' | 'job-detail' | 'equipment' | 'completion' | 'register' | 'forgot-password' | 'reset-password',
        email?: string, errorMessage: string, stack?: string }
```

Endpoint behaviour:
- Writes an in-app inbox notification to all admin/manager users (`type = 'portal_fallback'`, priority `high`)
- Dedup within a 1-hour window per `operation` (so a sustained incident doesn't spam inboxes)
- Fires an email to `info@oooshtours.co.uk` via `monday_fallback_alert` template for the first event of each dedup window
- Logs to server console with a consistent `[PORTAL FALLBACK]` tag

Goal: if something breaks on OP and freelancers silently drop back to Monday, we find out within minutes. When `EMAIL_MODE=live` this arrives as a real alert.

### Email templates added this session
- `portal_verification_code` — 6-digit code, internal style
- `portal_password_reset` — reset link (1h TTL), internal style
- `delivery_note` — client-facing, Ooosh branded, PDF attached (for deliveries)
- `collection_confirmation` — client-facing, no PDF (for collections)
- `completion_driver_notes` — staff alert with driver's free-text notes + job context
- `monday_fallback_alert` — internal alert when portal falls back

### Domain + sender
- Reset link: `https://freelancer.oooshtours.co.uk/reset-password?token=…`
- From: `SMTP_FROM` (currently `notifications@oooshtours.co.uk`)
- `EMAIL_MODE=test` during build; Jon flips to `live` at cutover.

---

## Build order (each step commits + pushes)

1. **Migration 052** — `portal_password_reset_tokens` table, `completion_reminder_level INTEGER DEFAULT 0` on `quotes`
2. **OP backend portal auth** — `POST /portal/auth/register/start|verify|complete`, `POST /portal/auth/forgot-password`, `POST /portal/auth/reset-password`; new email templates; verification code storage reusing the OP's existing verification pattern where possible
3. **OP backend portal telemetry** — `POST /portal/telemetry/monday-fallback` endpoint + inbox notification + email (internal)
4. **Next.js portal repointing** — `register/start|verify|complete`, `forgot-password`, `reset-password` all get `isOpMode()` branch with fallback; shared `src/lib/fallback-alert.ts` helper that reports every fallback to OP telemetry
5. **Assignment email** — fire `freelancer_assignment` in `POST /api/assignments`; also change-notify path stays as-is
6. **Delivery-note PDF service** — port from `src/lib/pdf.ts`; add `delivery_note`, `collection_confirmation`, `completion_driver_notes` templates
7. **Completion flow overhaul** — R2 for photos + signature + PDF; PDF generation for deliveries; client email; staff alert
8. **Portal files endpoint** — `GET /api/portal/jobs/:id/files` returning `jobs.files + venues.files` filtered by `share_with_freelancer=true`; Next.js side gets OP-mode branch
9. **Completion chase scheduler** — cron every 30 min, 2/6/14h thresholds, level column, staff escalation
10. **Docs** — update CLAUDE.md Phase 2 checkboxes + AGENT_MAP.md

## Flip-the-switch checklist (end of session)

- [ ] All 10 build steps merged to main and deployed to server
- [ ] Migration 052 applied on production DB
- [ ] Env vars on OP server: `PORTAL_TELEMETRY_SECRET` (new), `FRONTEND_PORTAL_URL=https://freelancer.oooshtours.co.uk`
- [ ] Env vars on Netlify portal: existing `DATA_BACKEND=op`, `OP_BACKEND_URL`, plus new `PORTAL_TELEMETRY_SECRET` (matching)
- [ ] Test login → reset password → login → see jobs flow with test freelancer account
- [ ] Test completion with photos + signature → verify R2 objects, PDF, client email, staff alert
- [ ] Flip `EMAIL_MODE=live` when Jon's ready
- [ ] Monitor inbox for any `monday_fallback_alert` events — investigate each one

## Known risks / edge cases

- **Token in reset link** — signed JWT (not opaque token) so no DB read needed for basic validation, but we write a `portal_password_reset_tokens` row to record which tokens have been used (prevents replay). Tokens are single-use and marked used_at on consumption.
- **Monday fallback loops** — if the OP is down, we'll log each fallback. Dedup is per-operation per-hour so we won't flood the inbox.
- **Email mode test redirect** — while `EMAIL_MODE=test`, reset emails redirect to `EMAIL_TEST_REDIRECT`. Before go-live Jon flips to `live`.
- **Completion chase skipping to staff** — only after 3 failed reminders; staff must not get chased if business hours haven't allowed 3 windows to pass.
- **Timezone** — scheduler runs in server time (UTC on Hetzner). "Business hours 07:00–22:00" should use `Europe/London`. Need to convert carefully (see `toLocaleString` with tz option).

## Files touched in this session (running list)

See commit history on `claude/ooosh-operations-platform-KMIQj`.
