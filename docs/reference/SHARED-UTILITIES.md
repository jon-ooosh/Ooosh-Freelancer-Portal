<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Shared Utilities — full reference

Broker, email, Stripe, encryption, costs/Xero, contacts, scanners, lifecycle invariants.

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

**Rate-limit tuning + 327 cooldown (Aug 2026) — read before touching the broker's throttle.** HireHop's 60/min is **per API token** (confirmed by HH support) AND **shared with every other caller on that token** — the Netlify payment portal hits the SAME token from a US IP (AWS us-east-2, `3.142.143.12`), ~1s offset from OP's Hetzner IP (`49.13.158.66`). HireHop emailed + phoned about sustained 327 rejections; the journal showed the cause plainly (e.g. `05:00:27→05:02:04`, ~95s of solid `items_to_supply_list` failures). Two self-inflicted problems:
1. **Opening burst.** The bucket starts full (50) and spacing was only **350ms**, so each 30-min sync fired ~50 requests in ~18s = **~170/min instantaneous** — enough to trip the rolling-minute limit on its own, before the portal even factored in.
2. **327 retry storm.** HH's limit is a ROLLING minute, so retrying a rejected call 1s/3s later is near-guaranteed to 327 again; each rejected call spawned 2 more, keeping the window saturated.

Fixes (both in `hirehop-broker.ts` → `RATE_LIMIT` + `TokenBucketRateLimiter`):
- **`minDelayMs` 350 → 1800.** This — NOT `maxTokens` — is the real throttle: it's enforced on EVERY call regardless of tokens, so a full bucket can't burst. Hard ~33/min, no spike, leaving ~27/min for the portal. `maxTokens` (50) is now non-binding; **do NOT "restore" 350ms.**
- **327/329 cooldown circuit-breaker (`cooldownMs` 30s).** On any 327/329, `TokenBucketRateLimiter.triggerCooldown()` pauses the WHOLE queue (the wait lives at the top of `acquire()`, so it blocks queued requests AND retries) for 30s to let HH's rolling window drain, then resumes. Makes the broker **adaptive** — it self-paces to just under HH's live ceiling regardless of what the portal is doing. Retries are KEPT but are now paced by the cooldown (a retry's `acquireToken()` waits it out), so they're useful (fire post-drain) instead of amplifying. Wired via `withRetry` → `isRateLimitSignal(resp)` → `queue.notifyRateLimited(RATE_LIMIT.cooldownMs)`.
- **Trade-off:** a user-facing request that lands during an active cooldown waits up to 30s for its HH refresh. The Job-Detail auto-sync is non-blocking (UI shows cached data meanwhile), so this is acceptable; background sync just runs slower. Any NEW HH rate-limit surface should route through `isRateLimitSignal`/`notifyRateLimited` rather than re-deriving 327 handling.

**Still TODO — the durable fix (Tier 2/3, captured Aug 2026):** the tuning above ABSORBS the storm; these remove it at source.
- **Lean on webhooks, gut the bulk poll.** The 30-min sync re-fetches `items_to_supply_list.php` for up to **80 jobs every cycle** — the single biggest volume source — and the line-item cache (10-min TTL) has always expired by the next 30-min cycle, so every sync is a full cold re-fetch. But HH `job.updated` / `job.status.updated` webhooks already fire on change (confirmed flowing — ~40 in 2 days) and cost **ZERO** against our 60/min (they're HH pushing to US; the follow-up per-job re-fetch is 1 throttled call for ONLY the job that changed). So freshness should come from webhooks; the poll should shrink to a gentle backstop (only imminent/active jobs, spread over 10-20 min, or only jobs with no recent webhook). "Sync now" + the Job-Detail on-page sync stay as the manual force-fresh escape hatch, so trimming the background poll never leaves staff on stale data for the job they're looking at.
- **Consolidate the OTHER callers behind one throttle.** The Netlify payment portal (`netlify-functions` repo: `get-job-details-v2.js` = 3 HH calls/view, `handle-stripe-webhook.js` = ~5 + its own 327 retry) and the Next.js portal (`src/lib/hirehop.ts`) hit HH directly with NO shared limiter. Options: **(a)** route the portal's money/job reads through OP's cached/throttled broker (plumbing partly exists — `op-backend.js`, `fetchMoneySummary` exported-but-unused, `DATA_BACKEND=op` partly done) — free, gives ONE coordinated throttle; **(b)** put all client-facing traffic on a SECOND HH token (£23/mo/user; per-token limit CONFIRMED, so it genuinely decouples the two callers) — less effort, ongoing cost, still two uncoordinated callers each of which can still storm HH. Also: on persistent 327 the Stripe webhook should return non-200 so Stripe's own retry (spread over hours) takes over instead of hammering.
- **Global (Redis-backed) rate limiter.** The token bucket is per-process in-memory today. Fine for the single OP systemd process, but if OP ever clusters, each worker gets its own bucket and the ceiling multiplies — promote to a Redis-backed distributed bucket when consolidating callers (end-state: HH only ever sees traffic from OP, throttled globally).
- **Stock-export bypasses** (`services/staging-stock.ts`, `services/backline-stock.ts`) raw-`fetch` `modules/stock/export_data.php` using the **export key**, not the API token — so they may be on a SEPARATE budget; verify before wiring through the broker. Low-frequency + user-triggered, so likely minor.

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
  - In test mode: emails redirect to `EMAIL_TEST_REDIRECT` address by default
  - Test emails include banner: "TEST MODE — would have been sent to: client@example.com"
  - One-click admin toggle in Settings page to switch to live
- **Per-template allowlist** (`EMAIL_LIVE_TEMPLATES`): comma-separated template
  IDs that bypass the test-mode redirect even while `EMAIL_MODE=test`. Lets us
  release individual templates to real recipients (no banner, no `[TEST]`
  prefix, CCs honoured) without flipping the whole system live. Ignored when
  `EMAIL_MODE=live`. `sendRaw()` is NOT covered (no template ID to match) —
  raw sends always honour the global mode.
  - `email_log.mode` stores the **per-message effective** routing (`live` if it
    went to the real recipient, `test` if it was redirected), not the env mode.
- **Audit trail:** Every email logged to `email_log` table (recipient, template, sent_at, status)
- **No unsubscribe:** These are transactional/operational emails, not marketing

**Environment variables:**
```
EMAIL_MODE=test                           # 'test' or 'live'
EMAIL_TEST_REDIRECT=jon@oooshtours.co.uk  # Where redirected test emails go
EMAIL_LIVE_TEMPLATES=                     # Comma-separated template IDs to release
                                          # while in test mode (e.g.
                                          # booking_confirmed_deposit,payment_received)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=notifications@oooshtours.co.uk
SMTP_PASS=xxxx-xxxx-xxxx-xxxx            # Google Workspace app password
SMTP_FROM=Ooosh Tours <notifications@oooshtours.co.uk>
```

**Template structure:**
- Base layout: `backend/src/services/email-templates/base.ts` — Ooosh branding wrapper
- Per-template: `backend/src/services/email-templates/{template-id}.ts` — subject + body
- Variables injected via `{{variableName}}` substitution (HTML-escaped — so a `{{var}}`
  can't inject raw HTML; a URL is fine, `&` → `&amp;` is valid in `src`/`href`)
- Conditional sections via `{{#if var}}…{{/if}}` — **single level only, NEVER nest them.**
  `substituteVariables` uses a non-greedy single-level regex; a nested
  `{{#if a}}…{{#if b}}…{{/if}}…{{/if}}` matches to the FIRST `{{/if}}`, leaving a literal
  `{{/if}}` / `{{#if b}}` artifact in the sent email. Render e.g. an image and its caption
  as two SEPARATE top-level `{{#if}}` blocks. (Bit `rehearsal_info_pack` photos, Jul 2026.)

**Convention: include the HH job number on every job-scoped template** (May 2026). Any new email template that relates to a specific job MUST surface the HH job number in BOTH the subject line and the body, using the Katatonia pattern:

| Surface | Format | Example |
|---|---|---|
| Subject | `<Headline> — <Job Name> (#{{jobNumber}})` (or `(job #{{jobNumber}})` if no jobName in subject) | `Payment Received — Katatonia - Van & backline hire (#15607)` |
| Body (first mention of the job) | `<strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>)` | "Thank you for your payment for **Katatonia - Van & backline hire** (job **#15607**)" |

The HH job number is the thread that ties any email back to the job in HireHop / OP without the recipient needing to click through. Without it, internal staff (and clients) end up hunting for the job ref every time they want to action a message. The convention is enforced across every existing job-scoped template — match it on new ones.

**Caller responsibility:** the sending route must pass `jobNumber: String(job.hh_job_number || '')` in the `variables` object. If the job-scoped sender has no HH number to hand (e.g. an OP-only enquiry not yet pushed to HireHop), pass an empty string — the templates degrade gracefully to `(#)` / `(job #)`. Don't omit the variable entirely (renders as the literal `{{jobNumber}}` placeholder).

**Templates this does NOT apply to:** auth flows (`portal_verification_code`, `portal_password_reset`), system alerts not tied to a specific job (`hire_form_fallback_alert`, `monday_fallback_alert`, `platform_issue_reported`), vehicle-scoped templates (`compliance_reminder`), and multi-entity templates (`file_resend`). Use judgement — if the email is about one job, the number goes in; if it's about a person/vehicle/system event with no job context, it doesn't.

**Transient-failure retry + outage canary (Jul 2026).** Gmail SMTP on port 587 sporadically rejects auth on a fresh STARTTLS connection with `535-5.7.8 Username and Password not accepted … BadCredentials` **even when the credentials are valid** — a known flaky behaviour when every send opens a brand-new authenticated connection (which we do; the transporter is a non-pooled singleton). Proven live 8 Jul 2026 (job 16251): same `info@` account, same password, two 535s minutes apart while other sends went through fine. The password was never wrong.

- **`isTransientSmtpError()` + `sendMailWithRetry()`** (`services/email-service.ts`) wrap every `send()` and `sendRaw()`. Transient = SMTP `421` / `45x` / **`535`** (treated as transient on the deliberate assumption the app password is valid), socket-level codes (`ECONNECTION`/`ETIMEDOUT`/`ESOCKET`/`ECONNRESET`/`EAI_AGAIN`), or a message matching Gmail's auth-rejection text. **3 attempts total** — immediate, +2s, +5s (`RETRY_BACKOFF_MS`). Permanent errors (bad recipient `550`, unknown template) throw immediately, no retry. This alone kills ~all of these incidents.
- **Outage canary — `raiseEmailHealthAlert()`.** When a send fails AFTER all retries, it writes a **bell notification to admins** (`type='system'`, title `'Email delivery is failing'`, `priority='urgent'`, `email_sent_at=NOW()` so the escalator never tries to *email* the alert). **Deduped to at most one per hour.** This is the answer to "if email genuinely broke, how would we know?" — the failure signal MUST NOT travel over the channel that's failing, so it goes to the DB-backed inbox, not email. A truly-revoked password is still caught here (every send fails all retries → canary fires), just after the retries.
- **Silent-skip alert also writes an admin bell** (`sendConfirmationSilentSkipAlert`, `services/confirmation-hooks.ts`) — job-specific (`entity_type='jobs'`, links to `/jobs/<uuid>`), so "the confirmation for job X didn't fire" is actionable in the inbox even if the alert *email* can't get out. Its copy is now conditional: the "no client email on record" guidance only shows when an issue actually indicates a missing recipient; an SMTP-shaped `context` gets "transient SMTP failure, recipient is fine" copy instead (the old boilerplate sent staff hunting through a perfectly-fine address book on 16251).
- **Manual re-fire:** `POST /api/money/:jobId/resend-confirmation` (STAFF_ROLES) re-sends the booking/payment confirmation for any confirmed job — reads live data, so it works regardless of when the job confirmed or whether the original auto-send failed. Surfaced as a **"Resend confirmation" button on the Money tab Payment History header**, with an inline result banner (sent / went-to-info@ fallback / SMTP failure). This is the staff recovery path when an email slips through.
- **Root cause is CONCURRENCY, and the transporter is now POOLED (Jul 2026).** The `email_log` over 8 Jul showed failures clustering in bursts — the daily 08:00 batch fired 5 sends in ~2s and Gmail `535`'d 2 while sending the other 3 (same account, same valid password). A non-pooled transport opens a fresh authenticated connection per send, so a burst = a concurrent-AUTH storm = random 535s on the surplus logins. The transporter now uses `pool: true, maxConnections: 1` (+ `maxMessages: 50`, `rateLimit: 5`/`rateDelta: 1000`, socket timeouts) so every send funnels through ONE reused, already-authenticated connection — there is never more than one AUTH in flight. Retry + pooling together: pooling prevents the storm, retry mops up any residual blip. **This runs in a single systemd process = one pool; if the API is ever clustered, each worker gets its own pool and the concurrency ceiling multiplies — revisit then.** Our volume is low (dozens/day) so serialising costs nothing.
- **ALL outbound email now funnels through `emailService` (Jul 2026).** Two call sites in `routes/vehicles.ts` (the `/send-email` attachment branch + the `/send-condition-report` loop) used to `nodemailer.createTransport(...)` directly for attachment emails, bypassing pooling/retry/canary/audit entirely — which is why the book-out condition report kept 535ing after the first fix (job 16125). Both now call `emailService.sendRaw({ ..., attachments, skipLayout: true })` (`skipLayout` sends their already-complete HTML without the base-layout wrap). **Never `createTransport` outside `email-service.ts`** — there is exactly one transport (the pool) and every send must go through it, or it silently misses the reliability layer.
- **Provider abstraction — SMTP or Resend, `EMAIL_PROVIDER` flag (Jul 2026).** The likely TRIGGER for the sudden onset was the auto-chase **Gmail API / domain-wide-delegation setup on 7 Jul** — granting a service account access to the mailboxes put Google's security into a heightened state that intermittently 535-rejects the `info@` app-password SMTP logins (valid password, account flagged). Pooling+retry mitigate the symptom but don't cure a Google-flagged account, so `emailService` gained a provider layer: `EMAIL_PROVIDER=smtp` (default, Gmail) or `EMAIL_PROVIDER=resend`. Resend sends over the already-verified `oooshtours.co.uk` domain via its own infra — **completely independent of the `info@` Google account credentials**, so immune to whatever Google does to that account's auth. Everything ABOVE the transport is provider-agnostic (templates, retry, outage canary, audit log, test-mode redirect, `skipLayout`); only `EmailService.deliver()` branches (`sendViaResend()` uses the REST API via global fetch — no SDK dep; `httpStatus` 429/5xx classified transient by the retry). `reply_to` forced to `info@`. Env: `EMAIL_PROVIDER`, `RESEND_API_KEY`. Deploy-dark then flip, same pattern as `DATA_BACKEND`; instant rollback by flipping back to `smtp`. **Note:** Resend sends do NOT appear in the `info@` Gmail Sent folder (they're in the Resend dashboard log + our `email_log`); replies still land in the Gmail inbox via `reply_to`. Watch the shared Resend account's plan limits — OP + the enquiry-forms app both send from it.
- **Client email signature (Jul 2026).** The `client` base-layout footer (`email-templates/base.ts` `renderClientSignature()`) carries the company signature — shop promo + contact + socials + legal + confidentiality disclaimer — mirroring the Gmail signature. Applied to client-facing sends ONLY: NOT the `internal` variant (ops alerts to info@/will@ don't need it) and NOT the auto-chase Gmail drafts (plain-text, built outside `wrapInBaseLayout`; Gmail appends its own signature when a human sends them, so ours would double up). Social-icon images are on the existing signature CDN; the two company logos (`OOOSH_LOGO_URL` = purple disc, `ONE_PERCENT_LOGO_URL` = 1% for the Planet) are constants left blank until their image URLs are pasted in — each renders only when its URL is set, so a blank never shows a broken image. All images have alt text so the block reads with images blocked.
- **Gmail API alternative (not taken):** we already have service-account DWD infra in `config/gmail.ts`; adding a `gmail.send` scope + `info@` impersonation would send as the real mailbox (shows in Sent). Rejected in favour of Resend because it keeps us on the same Google rails that are being flaky / deprecating password auth — Resend decouples us entirely.
- **`role='admin'` targets the admin inbox** for both the canary and the silent-skip bell (jon's call — nobody else can action email/tech issues). Self-maintaining if the admin set changes. All these bell notifications set `email_sent_at=NOW()` so the escalation scheduler never double-emails them.

### Fleet Hire-Status Sync ✅ COMPLETE

**File:** `backend/src/services/fleet-hire-status-sync.ts`

Single source of truth for `fleet_vehicles.hire_status`. The column is a CACHED projection of assignment state — derived, not authoritative. The authoritative truth is `vehicle_hire_assignments.status`.

**Why this exists:** Before centralisation, five different places (`assignments.ts` book-out + check-in + swap, `hire-forms.ts` PATCH, `vehicles.ts` save-event) each ran their own `UPDATE fleet_vehicles SET hire_status = ...`. When the frontend forgot to send `event.hireStatus` (e.g. the 22 Mar eventType case bug, the 20-22 Apr stuck-booked-out historical data), the column drifted from reality. Funnel everything through one helper and drift becomes impossible.

**Decision rules:**
- Sticky values (`'Sold'`, `'Not Ready'`) preserved — these are explicit manual overrides for damage repair, finance return, etc. The helper does not clobber them.
- Any assignment in `('booked_out', 'active')` for the vehicle → `'On Hire'`.
- Otherwise, if current value is `'On Hire'` (van WAS out, now no active assignment — i.e. just came back) → `'Prep Needed'`.
- `'Prep Needed'` → `'Available'` transition is NOT handled here. That happens when prep is completed via `PATCH /api/vehicles/fleet/by-reg/:reg/hire-status`.
- All other cases: preserve current value.

**Usage pattern:**
```typescript
import { syncFleetHireStatus, syncFleetHireStatusByReg } from '../services/fleet-hire-status-sync';

// After flipping an assignment status, recompute fleet status:
await syncFleetHireStatus(vehicleId);

// For event handlers that work with regs:
await syncFleetHireStatusByReg(reg);
```

**Wired into:**
- `assignments.ts` book-out (`POST /:id/book-out`)
- `assignments.ts` check-in (`POST /:id/check-in`)
- `assignments.ts` swap-vehicle (`POST /:id/swap-vehicle` — syncs both old + new)
- `hire-forms.ts` PATCH on transition to `booked_out`
- `vehicles.ts` save-event end-of-handler (after assignment status flips)

**NOT wired into:** the manual override paths (`PATCH /api/vehicles/fleet/:id`, `PATCH /api/vehicles/fleet/by-reg/:reg/hire-status`, bulk import). These are explicit user actions that should stand as written.

**Backfill:** `backend/src/scripts/backfill-fleet-hire-status.ts` runs the same rules across the entire fleet to clean up historical drift. Dry-run by default; `--commit` to apply.

### Driver Document Validity ✅ COMPLETE (Aug 2026)

**File:** `backend/src/services/driver-validity.ts`
**Frontend mirror:** `frontend/src/lib/driverStatus.ts` (status badge only)

THE single definition of "is this driver's paperwork valid". Full model,
incident history and conventions under **Document validity: FROM dates in,
derived expiry out** in Step 2 above. Headline: humans set a FROM date, OP
derives the expiry into the `*_valid_until` columns on every write, and the
hire-form router delegates here so it can never disagree with the staff UI.

Call `persistableWindows()` from any new driver write path; never set a
`*_valid_until` column by hand. `computeDriverValidity()` carries the integrity
guard that stops a check date with no licence identity rendering as a valid
window. Unit-tested (`src/services/__tests__/driver-validity.test.ts`) — the
first tests in the backend; `jest.config.js` exists for exactly this class of
pure, high-risk helper and does not attempt a broad suite.

### Identity Review ✅ COMPLETE (Aug 2026)

**File:** `backend/src/services/identity-review.ts`

Staff adjudication of a failed iDenfy face match, modelled on the insurance
referral. `isIdentityAuthorised()` is the gate helper — route every new "may
this driver be assigned / receive paperwork" surface through it rather than
re-deriving the status. Fails OPEN on an unknown status. Full detail under
**Identity review** in Step 2 above.

### HireHop Deposit Push ✅ COMPLETE

**File:** `backend/src/services/hh-deposit.ts`

Centralised two-step HireHop deposit push (`billing_deposit_save.php` + Xero sync via `accounting/tasks.php`). Used by `POST /api/money/:jobId/record-payment` and `POST /api/excess/:id/payment`. Returns a structured `{hhDepositId, xeroSynced, error}` so callers can surface failures rather than silently logging "non-fatal".

`pushDepositToHH` accepts an optional explicit `bankId` (overrides the method→bank mapping) so a deposit can be recreated on the exact original bank. **`reverseDepositOnHH`** (same file) is the "out" leg for moving a deposit off a job (Combine Bookings): it does NOT post a negative deposit — HireHop rejects those and the rejected row never reaches Xero — it posts a **refund payment application** against the specific deposit (`billing_payments_save.php` with `deposit=<id>, OWNER=0, paid=<amount>`) + `post_payment` Xero sync, exactly like excess reimbursement. To reduce/remove a HireHop deposit from anywhere, use a payment application, never a negative deposit. `getMethodForBankId` is the inverse of the bank map for recreating a deposit read back from billing.

**Why this exists:** Before May 2026 the Money tab's Record Payment endpoint had its own inline HH push, and the Excess Manage modal's `/payment` endpoint had no HH push at all — excesses recorded via Manage never appeared in HireHop billing. Job 15624 incident: £1200 worldpay was recorded twice via the Manage modal, doubling the OP-side `excess_amount_taken` to £2400, while HireHop showed nothing for the excess. The shared helper closes both gaps and standardises the failure-surfacing contract.

**Failure surfacing contract:** any caller hitting this helper should bubble `error` back to the client as `hh_push_error: string | null` in the JSON response. Frontend renders an amber "Saved in OP — HireHop push failed" banner that keeps the modal open so staff can decide whether to retry or record manually in HH and use Manage > Link to HH. Three failure modes covered:
1. HireHop returns `success: false` (rate-limit / validation error)
2. HireHop returns 200 but no extractable deposit ID (the "silent success" case that bit 15624)
3. Network throw / timeout

**Idempotency contract on excess:** both `/excess/:id/payment` and `/money/:jobId/record-payment` accept `total_collected` (absolute new total on the excess record) alongside `amount` (delta-add legacy). Frontend now sends `total_collected` for excess flows, so re-clicking Save with the same value is a no-op rather than doubling. Lowering `total_collected` is treated as a correction (allowed, no HH push). The Money tab's Record Payment > Excess form also auto-finds existing excess records on the job (any status — including `taken` for top-ups), replacing the previous filter that excluded `taken` records and led to a misleading "no excess record exists" banner.

**Top-ups against records that already have `hh_deposit_id`:** the helper deliberately skips the HH push and returns `hh_push_error` set to a descriptive message. Reason: the existing HH deposit row would need a separate top-up entry, not an additive update. Staff create the top-up deposit manually in HH and use Manage > Link to HH (or a future change splits the OP record).

**Soft-enforce reimburse-after-nibble (Jun 2026):** `POST /excess/:id/payment` now returns **409 `chain_break_warning`** when a payment would top up a record whose `hh_deposit_id` is already set (i.e. it's been linked to a chain via the rollover auto-match). Frontend ExcessPaymentModal catches the 409 and renders an amber warning + explicit "I understand the top-up won't be tied to the HireHop chain" tick before re-submit. Bypass: send `acknowledge_chain_break: true` on the second attempt. Skipped for the rollover write itself (`method='rolled_over'`) since that IS the chain extension, and for records in `needed`/`pending` state (legit initial collection). Solves the 15047 scenario — staff rolls forward £1,148, can't blindly top up £52 without the system flagging that the £52 won't follow future rollovers. The "proper fix" for actually-chaining top-ups would be a junction-table model (Option A in jon's nibble-vs-top-up discussion); soft-enforce is the operational alternative.

**Don't bypass:** route handlers should NOT call `billing_deposit_save.php` directly from inline code — that bypasses the failure-surfacing contract. The previous direct call in `money.ts` was the source of the silent-failure problem.

### Stripe Client ✅ COMPLETE (May 2026)

**File:** `backend/src/config/stripe.ts`

Singleton Stripe SDK client for OP's direct Stripe operations (pre-auth capture, refund, void). OP is now the staff-facing control surface for everything post-collection; the Payment Portal stays the client-facing collection surface (initial pre-auth + checkout).

**Exports:**
- `getStripeClient()` — returns the singleton. Throws if `STRIPE_SECRET_KEY` unset.
- `isStripeConfigured()` — guard before calling, so routes can 503 cleanly on a server missing the key rather than throwing (the app boots fine without it; only capture/release/refund need it).
- `isStripeError(err)` — type guard for Stripe-thrown errors (matches `.type` starting with `Stripe`).

**Env vars:** `STRIPE_SECRET_KEY` (restricted key — scopes: PaymentIntents R/W, Refunds R/W, Charges R, Disputes R). `STRIPE_WEBHOOK_SECRET` for the PR 4 webhook receiver. Both already set on the production server (May 2026). SDK pins to its bundled `LatestApiVersion`.

**Used by:** `routes/excess.ts` capture/release/**reimburse** endpoints (reimburse with `method='stripe_gbp'` AND `stripe_payment_intent_id` set originates the Stripe refund directly via `stripe.refunds.create()` — Jun 2026, closes the "OP first" loop so staff don't have to bounce out to the Stripe dashboard). PR 4 added the `routes/webhooks.ts` `/stripe` receiver for incoming events. **Don't instantiate `new Stripe()` elsewhere** — go through `getStripeClient()` so key handling lives in one place.

**Refund dedup with the Stripe webhook (Jun 2026):** OP-initiated refunds and the corresponding `charge.refunded` webhook both fire for one logical refund event. The reimburse endpoint pre-records a `refund_legs` entry keyed `stripe_refund_<refund.id>` immediately after the Stripe API call succeeds; the webhook handler extracts the latest refund's id from `charge.refunds.data` (sorted by `created` desc) and constructs the same key. `unwindRefundOnExcess()` dedups on `(source, ref)` — whichever path arrives second is a no-op. Falls back to `stripe_charge_<id>` only when the webhook payload's refunds list is missing (defensive — Stripe always includes it on `charge.refunded`).

**Webhook handles both excess and hire payment refunds (Jun 2026 hotfix):** the `charge.refunded` handler first tries `findExcessByPaymentIntent` (existing excess flow via `unwindRefundOnExcess`). If no excess match, it looks up `job_payments` by the original PI for hire payment refunds. For hire payments: dedups on `payment_reference = stripe_refund_id` (OP-initiated path stores the refund id there); if no existing refund row, auto-INSERTs one with `source='stripe_webhook'`. Email subject differentiates: *Stripe excess refund recorded* / *Stripe hire payment refund recorded* / *...already on OP*. The webhook deliberately does NOT push HH paperwork (no auth context + risk of double-push) — surfaces the gap in the email for staff to verify HH manually. Note for `job_payments` refund rows: `stripe_payment_intent` holds the ORIGINAL PI (for cross-reference + webhook lookup), and `payment_reference` holds the Stripe refund id (for dedup). Don't conflate them.

### Stripe webhook idempotency + Booked split-brain (Aug 2026) — job 16513

**Two failure modes, both triggered by a HireHop 327 rate-limit storm (11 Aug 2026), fixed together (OP PR #1085 / portal PR #23).** A single £146.83 Stripe payment created **two** HireHop deposits AND the job never moved Enquiry→Booked. Files: `services/stripe-event-claim.ts` (migration 188 `stripe_events` claim columns), `services/booked-status-reconciler.ts`, `services/sanity-check-scanner.ts` `runBookedSplitScan` (migration 189), plus the two status-push blocks in `routes/money.ts`.

- **⚠️ The HireHop broker RESOLVES `{success:false}` on a 327/329 — it does NOT throw.** `hirehop-broker.ts` `post()` returns the last response via `withRetry` rather than throwing on a rate-limit failure. So a bare `try { await hhBroker.post(...); UPDATE jobs SET status=2 ... } catch {}` **never enters the catch on a 327** and runs the UPDATE off a failed push — the job's `jobs.status` gets falsely mirrored to Booked while HireHop stays at Enquiry, and the 30-min sync then reverts it. **The fix is to CHECK the result, not to make the broker throw** (throwing would change the contract for every caller). Both status-push blocks in `money.ts` (record-payment "updated to Booked" ~line 2020 + payment-event ~line 2937) now capture `const pushResult = await hhBroker.post(...)` and only `UPDATE jobs SET status=2, status_name='Booked', hh_status=2` when `pushResult.success`; on failure they log a real failure and leave `jobs.status` untouched. **Any new "push HH status then mirror it locally" path MUST gate the local mirror on `pushResult.success`** — the broker's resolve-not-throw is the trap.
- **Cross-repo Stripe-event idempotency lives in OP's `stripe_events` table** (`services/stripe-event-claim.ts`). The Netlify payment portal (`netlify-functions/handle-stripe-webhook.js`) claims the Stripe event id **BEFORE** it creates the HireHop deposit (`POST /api/money/stripe-event/claim`), records the deposit id back (`/record-deposit`), and OP's `payment-event` marks it processed at the end. A Stripe re-delivery of the SAME event then no-ops (duplicate deposit / OP record / client email all prevented). **Why OP's Postgres and not the portal:** Netlify functions are stateless, and a Postgres atomic claim is **immune to the 327 storm** (the storm only slows HH calls, never OP's own DB) — so the claim is always fast. The claim is a single-statement `INSERT … ON CONFLICT DO UPDATE … WHERE processed_at IS NULL AND claimed_at < NOW()-60s RETURNING` (fresh insert OR stale-reclaim wins). `markStripeEventProcessed` upserts so the pre-auth path (no deposit, no pre-claim) still dedups.
- **The portal webhook is fail-fast + idempotent, NOT ack-fast-async.** `op-backend.js` `opFetch` bounds each attempt with an AbortController timeout so a storm-slowed OP can't blow Stripe's ack window; on timeout/failure it throws → the webhook returns non-2xx → Stripe re-delivers later, and the idempotency claim makes the retry a safe no-op. This **keeps Stripe's own retry as the money-critical safety net** (ack-fast-async would throw it away and require building a new deposit reconciler).
- **The reconciler heals silently; the scanner is the loud backstop.** `booked-status-reconciler.ts` `reconcileBookedStatus()` (wired into the 30-min sync) re-pushes HH status 2 for `pipeline_status='confirmed' AND status<2` jobs — no bell, no email. `runBookedSplitScan` (2h grace, jon@ alert) only fires when that keeps failing. See the sanity-scanner entry above.
- **Harmless historical scar:** `job_payments` is append-only, so a duplicate-deposit incident leaves n=2 audit rows forever even after the HH-side cleanup — the double-intent detection query still shows the old event. Not a live problem; don't try to delete audit rows.

### `stripe_events` keyspace separation — the cross-endpoint collision (Aug 2026) — job 16523

**Read this before touching `stripe_events`, `services/stripe-event-claim.ts`, or `services/stripe-webhook.ts`.**

**The incident.** A client authorised a £1,200 excess pre-auth through the Payment Portal (15 Aug 2026, 15:52). Stripe delivered `payment_intent.amount_capturable_updated` and BOTH webhook destinations returned `200 OK`. The Netlify log showed one clean attempt, `✅ OP MODE: Pre-auth event recorded`, 1.1s total. And yet OP had **nothing** — no `job_payments` row, no `job_excess` movement (`excess_status` still `pending`, `amount_held` 0). A live hold on a client's card, completely invisible to us. Found only because the client mentioned it.

**Root cause: TWO Stripe destinations, ONE event id, ONE `stripe_events` table meaning two different things.**

| Consumer | Writes | Means |
|---|---|---|
| OP's own receiver (`services/stripe-webhook.ts`, `/api/webhooks/stripe`) | raw `evt_...` | "I received this event" — a RECEIPT log |
| Payment Portal via `payment-event` / `claimStripeEvent` (`services/stripe-event-claim.ts`) | same raw `evt_...` | "the MONEY EFFECT of this event has been applied to a job" |

Both destinations are subscribed to overlapping event types on the same Stripe account, so both receive the **same** `evt_` id. The receiver's flow is: `INSERT stripe_events` → run the handler → `UPDATE … SET processed_at = NOW()`. But `payment_intent.amount_capturable_updated` has **no `case`** in its switch — it fell to `default:` ("Ignoring unhandled event type"), did nothing, and **still got stamped `processed_at`**. Three milliseconds later (`claimed_at` 15:52:57.624 → `processed_at` .627 — a no-op handler's fingerprint), the portal's `payment-event` arrived carrying the same `stripe_event_id`, `isStripeEventProcessed()` returned true, and it returned `200 {deduplicated:true}` before reaching even the `job_payments` INSERT.

**Why it started on 13 Aug:** the job-16513 idempotency fix (`83938a4`) threaded `stripe_event_id` into the pre-auth path for the first time. Every pre-auth before that sent no event id and so never hit the dedup gate — 20 clean portal pre-auths from 25 Jun to 7 Aug, then the first one attempted after the deploy (16523, 15 Aug) failed. The fix for the duplicate-deposit problem created a silent-drop problem on the one path that shares an event id with OP's own receiver.

**Deposits were unaffected** — the charge path keys off `checkout.session.completed`, which OP's endpoint is not subscribed to, so no collision.

**The fixes (all three, belt and braces):**
1. **Keyspace separation (load-bearing).** `stripe-event-claim.ts` prefixes every portal-facing key with `pe:` via `portalKey()`, applied inside all four helpers (`claimStripeEvent` / `recordStripeEventDeposit` / `markStripeEventProcessed` / `isStripeEventProcessed`). The receiver stays on RAW ids. The two consumers now occupy disjoint keyspaces and **cannot collide regardless of what gets subscribed to which endpoint in the Stripe dashboard** — which is the point, since that config is a dashboard click, not code. Historical portal-written rows are orphaned by design (a Stripe re-delivery of a days-old event isn't a real scenario, and treating a receiver row as "the portal did this" is the bug).
2. **An honest receipt log.** `processStripeEvent` now returns `handled: boolean` (only `default:` returns false — new `case` branches inherit "handled" automatically, so this can't silently regress). `handleStripeWebhook` stamps `processed_at` only when handled, and DELETEs the receipt row when it deliberately ignored the event. This also keeps `claimStripeEvent`'s fresh-`claimed_at` staleness window out of the way — note that leaving an unstamped row would NOT have been enough on its own, because the claim's `WHERE processed_at IS NULL AND claimed_at < NOW() - 60s` would still have blocked a portal claim for 60s.
3. **Portal-side propagation** (netlify-functions) — the pre-auth path's OP call is bounded and its failures now propagate instead of being swallowed. See that repo's CLAUDE.md.

**Also removed:** `payment_intent.amount_capturable_updated` was unticked from OP's Stripe destination (it only ever hit `default:`). That was the same-day mitigation; fixes 1+2 are what make re-adding it safe. `payment_intent.succeeded` remains subscribed on both endpoints — harmless today because the portal's handler for it just logs, and now structurally safe anyway.

**Conventions:**
- **Never read/write `stripe_events` with a raw `evt_` id from a portal/business-effect path** — go through the `stripe-event-claim.ts` helpers so the prefix is applied.
- **"I ignored it" ≠ "it's processed."** Any new receiver-side event handling must keep the handled/ignored distinction; don't stamp `processed_at` for a no-op.
- **A `stripe_events` row does not tell you WHO wrote it** unless you look at the key prefix (and, for legacy rows, `type` — the receiver writes the real Stripe event type, `markStripeEventProcessed` defaults to `'payment_event'`).

### Stripe → OP pre-auth discovery (`services/stripe-preauth-reconciler.ts`, daily 09:50)

The safety net that would have caught 16523 without a human. **A missed CHARGE self-heals** — it leaves a HireHop deposit for the Money-tab passive reconciliation to match. **A missed PRE-AUTH leaves no HH artefact at all** (only a job note), so nothing existed to reconcile against; the 09:40 expiry sweep only reconciles holds OP already knows about. This closes the only direction left: ask Stripe what it is actually holding.

Lists `requires_capture` PaymentIntents created in the last 10 days (Stripe auths live ~7), keeps only ours (same metadata gate the portal webhook uses — `jobId` + `paymentType='excess'` + `isPreAuth='true'`), and diffs against `job_excess.stripe_payment_intent_id` ∪ `job_payments.stripe_payment_intent`.

**Self-heal vs alert — the rule:**
- Hold live **AND** the hire hasn't finished → **self-heal**: replay the exact `payment-event` call the portal should have made, over localhost with a short-lived admin JWT (the `job-financials-backfill` pattern — one computation path, so excess creation, requirement sync, the dispatch gate and the client email all behave identically to the happy path). Idempotency key `reconcile:<pi_id>`.
- Finished hire / unknown job / anything ambiguous → **alert info@ only, never auto-write.** Emailing a client "we've taken your £1,200 hold" days after their hire ended would be worse than the gap it fixes.

Runs right after the 09:40 expiry sweep — that one reconciles known holds, this one finds unknown ones. Silent when clean.

**Clearing an alert (it re-fires daily until you do).** The scan is a pure diff, so an alerted hold keeps alerting until it leaves `requires_capture` in Stripe OR OP carries its PaymentIntent. Two valid resolutions: (a) capture/release it in Stripe — it drops out next morning; (b) record it against the job (Money tab → Insurance Excess → Manage → **Record Pre-Auth Hold**, method Stripe GBP, pasting the `pi_...`), which links the hold so OP can capture or release it itself. **Leaving it alone is not a resolution** — Stripe auto-voids the auth at ~7 days, so the money gets released by default rather than by decision. The alert email carries the raw `pi_...` (not just a dashboard link) and a deep-link to the job's Money tab precisely so route (b) is a copy-paste.

### Cost Capture & Xero Push ✅ (Jun 2026)

Staff capture supplier costs (`costs` table, migration 092) on `/money/costs`
via `CostCaptureModal`, categorise them to a Xero account, and push them to Xero
as either **Spend Money** (paid-now methods) or an **AUTHORISED Bill** (pay-later
methods). Engine: `services/cost-xero-push.ts`; routes: `routes/costs.ts`; UI:
`components/CostCaptureModal.tsx` + `pages/CostsPage.tsx`.

**Feedback-round additions (Jun 2026)** — all in `docs/COST-CAPTURE-RECHARGE-SPEC.md`:
- **Bundled-invoice allocation split** (`cost_allocations`, migration 092): split one cost across jobs via `PUT /costs/:id/allocations` — `CostAllocationModal`, surfaced both as a `⑂` row action AND a "Split across multiple jobs" tick at capture time (`onSavedAndSplit`). **Model = "Option A": one cost = one payable = one Xero bill; `cost_allocations` is a pure OP-side attribution layer** — a split NEVER changes what we owe the supplier or what's pushed to Xero, it only re-attributes the cost across jobs for OP cost tracking. Under-allocation is allowed (the modal shows an amber "£X unallocated (our cost) — OK to save" nudge; the remainder stays as our own cost, surfaced on no job); only OVER-allocation is blocked. When splitting a captured cost, the modal pre-seeds the capture job at the full amount as the first line, so the common "split the captured job's cost across others" flow is one add.
  - **⚠️ THE cost read that honours allocations is `GET /costs/by-job/:jobId`** (allocation-aware UNION — see the big comment block on that route). A job's costs = (A) costs captured on it with NO allocations at `full amount_gross` UNION (B) allocations TO it at the allocation amount. A split cost is attributed **purely by its allocations** (surfaces once per allocated job via clause B, never double-counted on its capture job). This was the fix for the write-only-`cost_allocations` bug (Jul 2026, PR #1060): the ⑂ fork wrote rows but nothing read them, so a £150 invoice split £75/£75 stayed £150 on its capture job with nothing on the other job. **Any NEW per-job cost read MUST go through `/by-job` (or replicate the UNION) — never `SELECT … FROM costs WHERE job_id = $1` alone**, which ignores splits. Recharge stays cost-level (on `costs.job_id` = capture job); splits never move it — allocation-in rows render read-only on other jobs' Money tabs (no recharge/Resolve controls).
  - **Money-tab itemisation:** the Job Costs panel (`MoneyTab.tsx` `JobCostsPanel`) itemises every cost applied to the job — "Costs applied to this job" (quote_actual) + "Extra costs" (extra) lists, each row tagged + amount + a "· split from #<capture HH job>" deeplink to the capture job for allocation-in rows. `/by-job` returns `is_allocation`, `full_amount_gross`, `allocation_id`, `job_id` (capture job uuid on a split-in row) + `capture_hh_job_number` so the frontend can name/link the source. Each row also carries its **paperwork**: the receipt/invoice thumb (image thumbnail, 📎 for PDFs, lightbox on click), the `invoice_number` beside the supplier, a soft grey "no receipt" marker when nothing's attached, and a click-through to that cost on the Costs hub (the row TITLE is the link — an ↗ icon was tried first and was too small to aim at; the "split from #N" link stays a sibling so the anchors never nest). `/by-job` selects `c.*`, so `receipt_r2_key` / `receipt_filename` / `invoice_number` were always on the wire — only the render was missing (added Aug 2026). **The receipt viewer is shared** — `components/costs/CostReceipt.tsx` (`ReceiptThumb` + `ReceiptPreview`), used by BOTH the Costs hub and the Money tab; typed against a minimal `ReceiptLike` shape so any future cost surface can mount it. Receipts live in the PRIVATE R2 bucket, so they MUST be fetched through the authenticated `api.blob()` helper — a plain `<img src="/files/download">` won't carry the JWT.
  - **Cost deep-link:** `/money/costs?view=all&job=<captureJobUuid>&cost=<costId>`. `job` narrows the hub via the existing `job_id` list filter (which also guarantees the target row is inside the 200-row page cap — see the LIMIT lesson above), `cost` scrolls to and ring-highlights the row, and a purple chip explains the narrowing with a "Show all costs" escape. The link always points at the **capture** job (`c.job_id`), which on a split-in row is a different job than the one you're viewing — that's where the invoice and the recharge actually live.
- **Edit-after-push → manual re-sync** (migration 147, `costs.xero_stale`): editing a Xero-affecting field on an already-pushed cost flags it stale (amber "Re-sync" pill) rather than silently diverging or auto-mutating a reconciled object. `POST /costs/:id/resync-xero` updates the Xero object IN PLACE (`updateBill`/`updateSpendMoney`, POST-with-ID, never duplicates); 409 + dismiss for Xero-locked (paid/reconciled). **Delete is OP-only — it does NOT delete the Xero bill/txn** (the delete confirm warns when `xero_object_id` is set; void in Xero separately).
- **COT receipt chaser** (migration 148): weekly digest (Wed 12:00 London) to each card-holder about company-card costs missing a receipt (3-day grace), `services/cost-receipt-chaser.ts`; `?missing_receipt=1[&mine=1]` list filter + "COT Receipts" dashboard bucket.
- **COT card register** (migration 148, `users.cot_card_label`): admin-managed card per staff (Settings → COT Card Register, `GET /users/cot-cards` + `PATCH /users/:id/cot-card`); capture stamps holder + last4 server-side, staff never type card details.
- **Supplier terms pull-through fix**: `costs.xero_contact_id` was never persisted (the bill was created by contact *name*), so Xero terms never seeded. `pushBill` now resolves the contact first, writes the id back, seeds terms, then computes the due date + creates the bill by `contactId`. Skipped for `reimburse_me`.
- **Freelancer Friday terms**: `freelancerDueDate()` = first Friday on/after (**invoice date** + 7 days), overriding supplier/Xero terms for `cost_type='freelancer_invoice'` (list display, bill push, re-sync). Xero can't model this. `SupplierTerms.source` gained `'freelancer'`. **⚠️ The anchor moved from `approved_at` to `cost_date` in Sep 2026** — jon confirmed the rule is invoice-date-based ("their invoice date, first Friday +7 days", so due 8–14 days after they submit). The old anchor meant the due date did not exist until a manager approved, so it could never be shown at capture time — which is exactly what staff wanted. `resolveDueDate` falls back to `approved_at` only for a legacy cost with no invoice date. Expect existing freelancer bills to show a slightly EARLIER due date after this change (approval normally lands a day or two after the invoice date).
- **Bills-to-Pay UX**: sortable Due column + Overdue / This Friday / Next Friday / This week / Next 7 days filter pills (client-side over server `due_date` — format dates in LOCAL time, not `toISOString()`, or BST shifts the exact-Friday match) + a per-supplier dropdown. The Xero-status cell collapses status+sync into one clickable pill so row actions don't get pushed off-screen.
- **Xero reconciliation probe** ("in Xero, not in OP"): `GET /api/costs/reconcile/xero-cot?days=N` (admin/manager) reads SPEND bank transactions on the mapped COT account (`xero_bank_cot_card`) and flags each matched (pushed `xero_object_id`, else amount+near-date) vs unmatched. `XeroCotProbe` panel on the Reconcile tab. Verified live (Jun 2026): unreconciled bank-feed transactions ARE API-readable, so a full matcher is viable — currently kept as an on-demand probe (0 orphans); promote to always-on (dashboard count / chaser / dismiss list) only if orphans recur. Caveat: a truly raw/uncoded statement line won't surface until coded in Xero.
- **Extraction date guard**: `normaliseCostDate()` in `cost-receipt-extract.ts` — implausibly-future extracted dates (> today + 7d) try the day/month swap and take it if it lands a valid past date (downgrading confidence), else keep + downgrade. Catches the UK-vs-US misread (11/06 → 6 Nov). Prompt is UK day-first; capture modal shows an amber future-date hint.

**Remittance advice (Jul 2026, migration 169).** Optional courtesy email fired from the Bills-to-Pay "mark paid" modal — a tickbox confirming to the payee that their invoice/expense **has been** (or, on a future `paid_value_date`, **is scheduled to be**) paid. Deliberately scoped to freelancers + staff reimbursements (the cases that value it), best-effort supplier fallback. **NOT a PDF** — a branded email note IS a valid remittance advice (no legal format, unlike an invoice). `services/remittance.ts` owns it.
  - **Recipient is resolved for pre-fill, staff confirm/edit before send (never blind).** `resolveRemittanceContact` order: reimbursement → `uploaded_by` staff person; freelancer-invoice → linked `quote_assignment` person; **remembered** → the address staff manually chose on a *previous* remittance for the same `supplier_name` (a prior `costs.remittance_email`, honoured as an explicit human decision — this is the "manual entry saves" mechanism, no new table); **person name-match** → `supplier_name` against `people` (freelancers first, UNIQUE match only — freelancers are people, not orgs, which is why the first cut surfaced nothing); then org (`xero_contact_id`, name); else none. The modal also has a **person picker** (`GET /people?search=`) to search OP for anyone.
  - **Decoupled from the money action** — `POST /costs/:id/send-remittance` (admin-only, matches `/pay`) is fired by the frontend *after* a successful pay; a failed email surfaces "paid, but email failed, resend later" and never unwinds the payment. `GET /costs/:id/remittance-contact` drives the pre-fill. Sending stamps `remittance_sent_at`/`remittance_email` (migration 169) → ✉︎ pip on paid rows + the "remembered" reuse.
  - **`remittance_advice` template** is client-branded but subject/body are composed in the service (supplier-vs-reimbursement wording, paid-vs-scheduled tense) via `subjectOverride`/`bodyHtmlOverride`. Email copy uses plain hyphens, not em-dashes, and includes a "you'll receive a separate remittance for each other invoice" line (heads off the "what about my others?" reply). Rollout: ships OFF `EMAIL_LIVE_TEMPLATES` so it test-redirects until released.

**Due dates — `resolveDueDate()` in `services/supplier-terms.ts` is THE definition (Sep 2026, migration 198).** The bill due date is DERIVED, not stored, and was being re-derived independently at five sites (the costs list, get-one, the bill push, the bill re-sync, and by extension the mark-paid modal via the list payload) — each carrying its own copy of the freelancer-vs-supplier branch. Every one of those now calls `resolveDueDate(cost, supplierTerms)` (or the terms-resolving `resolveDueDateForCost(cost)` for a single row), so OP and Xero cannot disagree about when a bill is due.

- **Precedence: staff override → the Ooosh freelancer Friday rule → the supplier's payment terms.** Do NOT branch on `cost_type` at a call site — the resolver picks the rule; that branching living in the callers is exactly how the sites drifted.
- **`costs.due_date_override` (DATE, nullable) is the override.** NULL = follow the rules. It is in `WRITABLE` and in `XERO_AFFECTING`, so editing it on an already-pushed bill flags `xero_stale` and staff re-sync — otherwise Xero would keep the old DueDate. **Never read the column raw for display**: the API's `due_date` already accounts for it, and `due_date_derived` / `due_date_is_override` come alongside for the "reset to default" affordance.
- **List endpoints use the batch `buildTermsResolver` + `resolveDueDate`**, never `resolveDueDateForCost` per row (that's one terms query per row — the N+1 the batch resolver exists to avoid).
- **`GET /costs/due-date-preview`** answers "what would the rules give?" for a cost that does not exist yet, so the capture modal can show the real default at upload time. Same engine, so what staff see is what lands. Multi-segment path so it doesn't hit `/:id`.
- **Extraction:** `cost_receipt_extract` now reads a printed `due_date` (or resolves stated terms like "Net 30" against the invoice date). `normaliseDueDate` is deliberately SEPARATE from `normaliseCostDate` — a due date legitimately points forward, so the future-date day/month repair must never be applied to it; it only rejects unparseable values, dates before the invoice date, and anything over a year out. An extracted due date lands as an override (the document's own answer beats our derived guess) and staff can clear it back to the rule.

**Supporting documents — `services/cost-documents.ts` is THE definition (Sep 2026, migration 200).** A payable often arrives with more evidence than the one document the AI reads: a freelancer invoices £250 labour + £60 fuel and encloses the fuel receipt, and that receipt is what makes the £10 VAT reclaimable. `costs.supporting_documents` (JSONB array of `{r2_key, filename, content_type, size_bytes, uploaded_at, uploaded_by}`) holds them; the main receipt stays on `receipt_r2_key`/`receipt_filename`.

- **⚠️ Xero keys an attachment by FILENAME.** A `PUT` to `/Attachments/{name}` on an object that already has that name OVERWRITES it — silently, with a 200. Two files both called `receipt.pdf` on one bill means the second simply does not exist. `collectDocuments()` renames duplicates **in the payload only** (`receipt.pdf`, `receipt-1.pdf`); OP keeps the name staff uploaded. The rename is deterministic — same order in, same suffix out — so a re-sync overwrites the same attachments rather than piling up new ones. **Never write a second attach loop that reads the array directly.**
- **The cap is 10 per Xero object**, and the main receipt claims one, so the modal + the Zod schema cap supporting docs at **9** (`MAX_SUPPORTING_DOCS` frontend / `MAX_SUPPORTING_DOCUMENTS` in `routes/costs.ts`). `collectDocuments` truncates at 10 with the receipt first, so the receipt is never the one dropped.
- **`supporting_documents` is in `XERO_AFFECTING`.** A doc added after the push has no other route to Xero — `resyncCostToXero` re-attaches the whole set (idempotent by filename) and the attach failure is non-fatal there, exactly as on the original push: the figures are the important leg.
- **⚠️ It is JSONB, so the write path MUST `JSON.stringify` it** (`serialiseJsonbForWrite` in `routes/costs.ts`). node-postgres sends a JS array as a Postgres ARRAY literal, which JSONB rejects — and an EMPTY array survives, so the bug only shows once someone actually attaches something. Same class as `JSONB_FIELDS` in `driver-verification.ts`.
- **The array is an idempotent REPLACE.** The modal always posts the full list, so removing a document is just a shorter array. Don't add a per-document delete endpoint without deciding what happens to the Xero attachment (nothing removes it there today).
- **UI is opt-in and out of the way** — one quiet "＋ Add supporting documents" link under the receipt pane, expanding only when asked for or when docs already exist. A fuel receipt captured in twenty seconds must not have to walk past this. The shared `ReceiptThumb` (`components/costs/CostReceipt.tsx`) carries a `+N` pip so the Costs hub and the Money tab both show that extra paperwork is filed. **Known gap:** a cost with supporting docs but NO main receipt renders no pip (the thumb early-returns on a missing `receipt_r2_key`) — an unlikely shape, and the capture modal still lists them.

**Push concurrency — per-cost advisory lock (DO NOT REMOVE).** The push is
triggered from FIVE sites — create / update / approve / pay / the Push-Now
button — and four are fire-and-forget (`pushCostToXeroBackground` → `setImmediate`).
With no guard, two overlapping triggers each loaded the cost with
`xero_object_id` still null, both passed the `billExists` check, and each created
its own Xero bill → **duplicate AUTHORISED bills** (live incident: T.Reeve repair
invoices — one OP cost row, two identical Xero bills; the VAT calc was correct on
both, it was just billed twice). Fix: `pushCostToXero` wraps its whole body in a
Postgres advisory lock (`pg_advisory_lock(hashtext('cost-push:'||id)::bigint)`)
on a dedicated client. The second push waits for the first to commit
`xero_object_id`, then `loadCost` + the `billExists` / `PUSHED_STATES` guard
short-circuit it. **Never push a cost to Xero outside `pushCostToXero`** — that's
how the guard is inherited. Any NEW trigger site just calls
`pushCostToXeroBackground(costId)` and is automatically serialised.

**VAT treatment — `vat_treatment` (migration 118).** Two ways a cost's VAT is
pushed, chosen explicitly in the modal (the `buildCostLineItems` helper drives
the line structure):
- `'standard'` (default) — a single INCLUSIVE line; Xero derives the VAT from the
  account / tax type. Correct whenever the VAT is a clean standard rate of net.
- `'reclaim_split'` — insurance-claim / "VAT-only" invoices where the VAT is
  non-standard relative to net (e.g. £750 excess + £702.68 reclaimable VAT, total
  £1,452.68). Pushed as the 3-line EXCLUSIVE structure an accountant enters by
  hand: `net @ No VAT` / `vat÷0.20 @ 20% VAT` / `−vat÷0.20 @ No VAT`. Lines 2+3
  net to zero, so subtotal=net, VAT=vat, total=gross for ANY net/vat pair.
  **Assumes the underlying VAT was charged at the 20% standard rate** (the only
  realistic case for these UK invoices). It's an explicit opt-in ("VAT reclaim"
  mode in the modal) so a normal-VAT data-entry slip can't silently trigger it.

**Invoice de-dup (migration 118).** Optional `costs.invoice_number` (fuel/till
receipts won't have one). `GET /costs/check-invoice?invoice_number=&supplier_name=&exclude_id=`
returns a non-blocking warning if the same supplier+number already exists; the
modal surfaces it but never blocks the save. Partial case-insensitive index
`idx_costs_invoice_dedup`.

**Cost ↔ vehicle service-log unification (Jun 2026).** `CostCaptureModal` is
dual-purpose — it captures a cost AND/OR a `vehicle_service_log` record in one
entry, so a garage invoice is entered once:
- Pick a van on a **servicing/repair-category** cost → an "Also add to <REG>'s
  service history" toggle appears, **defaulted ON** ("ask per cost, default yes"),
  revealing the service fields (type / mileage / garage→defaults to supplier /
  status / next-due / apply-to-vehicle). The offer is whitelisted to genuine
  service-event categories (Vehicle servicing `406`, Vehicle repairs `409`) —
  **fuel / parking / PCN costs keep their reg link on the cost row (the
  charge-back sanity check) but never create a service record**, or the history
  clogs instantly (`SERVICE_HISTORY_CATEGORY_CODES` in `CostCaptureModal.tsx`,
  Jun 2026). Whitelist not blacklist, so a future non-service vehicle category
  can't slip through.
- The offer also appears **in edit mode** when a cost has a van link but no
  `vehicle_service_log_id` yet — covers the "van link added in a later edit"
  hole where the unification only used to fire at create time, so the cost showed
  as linked on `/money/costs` but was invisible in Service History (Hi-Q
  Portslade / RX22SYV incident, Jun 2026). Edit-mode opens unticked with an amber
  hint; the vehicle picker auto-ticks when the edit itself adds the link. An edit
  never re-touches an already-linked service record.
- On save it creates the cost, then POSTs to the existing
  `POST /vehicles/fleet/:id/service-log` endpoint (reusing ALL its side-effects —
  mileage-log, fleet live-figure updates, upward-only mileage ratchet), attaches
  the receipt to the service record, and links them via
  `costs.vehicle_service_log_id`. Service-log creation is non-fatal: if it fails
  the cost is still saved and the modal warns.
- **Cost optional:** when a van is linked + the toggle is on, the gross amount is
  no longer required. Blank → service-record-only (handles a £0 MOT pass or a
  future "Booked" service, no cost row). `onSaved` may therefore receive `null`.
- The **vehicle page Service History "+ Add Record"** opens this same modal
  (`presetVehicleId`). **Editing** an existing service record still uses the
  dedicated `ServiceRecordForm` — so multi-file-with-comments edits and existing
  £0/Booked records are untouched. Known trade-off: adding via the unified modal
  carries a single receipt (multi-file-at-add deferred).

Migration 118 (`invoice_number` + `vat_treatment`) is in `run.ts`.

**June 2026 polish round (PR #706):**
- **Invoice number → Xero Reference.** `xeroReference()` helper in `cost-xero-push.ts` — the Xero `Reference` field on bills, spend-money AND bill payments carries `invoice_number` (fallback: supplier name). Previously it redundantly sent the supplier name (already the Contact). **Do NOT filter "junk-looking" invoice numbers** — a UUID-shaped value can be genuine (Spotify's printed Invoice ID is a real GUID); a UUID guard was tried + reverted (Jul 2026).
- **⚠️ Xero ACCPAY bill quirk — the invoice number the user SEES on a bill is `InvoiceNumber`, NOT the API `Reference` (Jul 2026).** On a Bill (ACCPAY invoice), the field the Xero UI labels "Reference" (the visible box) maps to the API **`InvoiceNumber`** field — the API `Reference` field IS stored but hidden. On **spend-money** (BankTransaction) there's no InvoiceNumber, so the UI "Reference" IS the API `Reference`. That's why for months spend-money references appeared but bill references didn't — we only ever set `Reference`, which lands invisibly on bills. Fix: `xeroInvoiceNumber(cost)` (invoice number ONLY, no supplier-name fallback) is passed as `invoiceNumber` to `createBill`/`updateBill`, which set Xero `InvoiceNumber` (in addition to `Reference`, kept as a bonus). Spend-money paths unchanged. Verified via `scripts/diagnose-xero-reference.ts` (reads back the actual stored `Reference` + `InvoiceNumber` from Xero for a cost — read-only, use `--id=`/`--supplier=`). Backfill re-run (`backfill-xero-references.ts`) re-pushes existing bills through `updateBill` so `InvoiceNumber` populates on the visible box.
- **Xero Reference reachability + un-gated re-sync (Jul 2026).** `invoice_number` reaches Xero `Reference` ONLY at push time or via `resyncCostToXero` (the "Re-sync to Xero" action, `POST /costs/:id/resync-xero`). The **"Push now"** button (`POST /costs/:id/sync-xero` → `pushCostToXeroBackground`) short-circuits anything already pushed (`PUSHED_STATES` guard) and never touches Reference again. So a cost pushed before `invoice_number` extraction was reliable had NO reachable way to get its real number into Xero — the re-sync action used to be gated behind the amber "Re-sync" pill (`xero_stale=TRUE`, set only on an OP-side edit). **Fix:** the terminal "Synced" / "In Xero" / "Bill created" / "Sent" pills in `CostsPage.tsx XeroCell` are now **click-to-re-sync** for ANY pushed, non-locked cost (calls the existing `resyncStale` handler). Xero-LOCKED states stay static — **reconciled spend-money** and **paid bills** (`xero_payment_id` set) can't be mutated; `resyncCostToXero` returns `{locked:true}` → 409 for those. Re-syncing an already-correct cost is a harmless no-op. Backlog fixer: `scripts/backfill-xero-references.ts` (dry-run default, `--commit`, `--supplier=`/`--id=`/`--limit=`) sweeps every pushed non-locked cost through `resyncCostToXero` in place (never duplicates); locked ones reported + skipped. **Convention:** any new "the Xero object drifted from OP" surface should reach `resyncCostToXero`, not a fresh push — that's the only in-place update path.
- **AI extraction hardening** (`cost-receipt-extract.ts`): `invoice_number` is now in the prompt + schema (it was simply never asked for — the field post-dated the extractor). Explicit gross-vs-net prompt rules, plus a deterministic post-parse `normaliseAmounts()` repair: net + VAT must equal gross; obvious swaps fixed, confidence downgraded to `medium` on any real correction so the modal banner prompts a human check. If accuracy complaints persist, the next lever is swapping `MODEL_ID` from Haiku to Sonnet (~10x cost, still <1p/receipt).
- **Capture modal uses the document's actual figures.** When extracted VAT isn't 20% of net, the modal lands in Manual mode with all three figures verbatim — it previously force-recomputed net from gross at 20%, mangling correct extractions (a real source of staff gross/net complaints).
- **Category is required on save** (except service-record-only saves, which create no cost row). A missing category = missing `xero_account_code` = guaranteed push failure ("Missing xero_account_code" incident, Jun 2026). The push error message now tells staff to Edit → pick category (PATCH auto-retries the push).
- **Approve = push.** It always did (the `/approve` endpoint fires the background push) but the UI implied a second manual step: unapproved bills now show a passive "Syncs on approval" instead of a no-op "Push now", and Approve triggers a delayed table re-refresh so the "Bill created" pill appears on its own.
- **Xero reconcile sync** (`services/cost-xero-reconcile-sync.ts`, daily 07:45 Europe/London): polls Xero `BankTransactions` (chunked `IsReconciled==true` Guid-OR filter, 1-3 calls/day) for pushed spend-money costs still in `bill_created`/`attached` and flips them to `reconciled`. This is what makes the `/money/costs` Reconcile tab a true exception list that self-empties — anything still on it days after the bank feed landed = unmatched payment / missing receipt, worth chasing. Voided/deleted Xero txns are left alone (state stays, visible on the tab).
- **Costs table UX:** click-to-sort headers (Date/Supplier/Description/Gross/Type/Status), truncated Type + Description with hover tooltips, "Uploaded by" column only on the All costs tab (tooltip elsewhere), icon Edit/Delete, Linked column links through to Job Detail / Vehicle Detail. Mark-paid modal shows invoice number + due date (invoice date + 30, mirroring `addDaysISO` in the push) and defaults to `lloyds_transfer`.

**Receipt extraction — vehicle reg + mileage + service type (Jun 2026, PR #869).** Garage/vehicle invoices put the reg, odometer and the work done in a labelled header, so the AI extractor now reads them and ties the cost to the van automatically:
- `cost-receipt-extract.ts` schema/prompt gained `vehicle_reg`, `mileage` and `service_type` (enum matching the service-log pills: service / repair / mot / insurance / tax / tyre / other). `normaliseVehicle()` cleans the reg (uppercase, no spaces, 2–8 chars) and clamps mileage to a sane positive integer (`>0`, `<1,000,000`), dropping misreads.
- **Auto-link the van** (`CostCaptureModal.tsx`): an exact match against the loaded active fleet (`normReg` both sides) auto-links the vehicle so the mileage/garage pre-fill has somewhere to land; an unrecognised reg surfaces an amber "not in active fleet" note. Mirrors the "📎 Looks like job #12345" pattern. Never overrides an existing/preset link.
- **⚠️ Match in an effect, NOT inline in the async handler.** The first cut matched inline inside `extractReceipt`, which captured `fleet` in the handler's closure — if the `/vehicles/fleet` fetch was still in flight when the multi-second Claude call returned, it matched against an empty list and false-reported "not in fleet" (live bug on RO23HLR, which IS in the fleet). Fixed by stashing the extracted reg in `pendingVehicleReg` and matching in a `useEffect` keyed on `[pendingVehicleReg, fleet, ...]` so it waits for the fleet to load. Any future "match extracted value against an async-loaded list" must do the same — don't match against a list inside the async extract closure.
- **Pre-fills** (all suggestions, flagged by the existing confidence banner): `serviceMileage` from `mileage` (the service endpoint's upward-only ratchet still guards the live odometer), `serviceGarage` from supplier (same entity on a garage invoice), `serviceType` from the extracted classification, and the service-history toggle auto-ticks for 406/409 categories.
- **Xero-sync transparency note** in the modal footer: paid-now costs already auto-push to Xero (Spend Money) on save via `pushCostToXeroBackground` in the create handler — there's no "Approve & save" for them because they skip the approval gate. The footer now states this explicitly (and that pay-later bills wait for approval) so the auto-sync isn't invisible. No behaviour change — `costs.ts:663` always fired the push; only the UI was silent. The CostsPage row's Xero pill (+ `/costs/:id/sync-xero` retry) remains the surface for sync status/failures.

### Cost Recharge — lifecycle + declared post-hire recharge + freelancer clarity ✅ COMPLETE (Jun/Jul 2026)

The full "recharge a cost to the client" story, in three layers. **Specs:** `docs/COST-CAPTURE-RECHARGE-SPEC.md` §"Phase D" (the resolution lifecycle) + `docs/POST-HIRE-EXPENSE-RECHARGE-SPEC.md` (declared running-cost recharge + V&D book-out + portal). Migrations **150** (lifecycle) + **152** (`jobs.recharge_running_costs` + the `recharge_running_costs` requirement type).

**1. Resolution lifecycle (`costs.recharge_status`).** A flagged recharge ends in exactly one terminal state: `pending` → `recharged_hh` (pushed to HireHop as a billable line via `cost-recharge-hh.ts`) / `recharged_external` (billed another way — closed HH job → direct Xero invoice) / `absorbed` (written off, reason required + audited). The "Recharges pending" bucket is keyed on `recharge_status = 'pending'` (NOT the old `recharged_to_hh_at IS NULL`). **Markup at confirm time** via `services/cost-recharge-markup.ts` (default = greater of £10 or 20%, ex VAT; HH adds the VAT). One shared UI surface: `RechargeResolveModal.tsx` (markup breakdown + 3 paths), used from `/money/costs` Recharges tab AND the Job View Money tab "Extra costs" rows. `POST /:id/push-recharge` (persists markup + pushes) + `POST /:id/resolve-recharge` (external/absorbed). Post-hire `cost_resolve` close-out card (`services/cost-requirement-sync.ts`, reactive — appears when a recharge cost exists). Dashboard "Recharges to Resolve" amber bucket.

**2. Declared running-cost recharge (the runner / V&D job).** `jobs.recharge_running_costs` (migration 152) declares "we recharge this job's fuel/parking/etc. at actual + markup post-hire". Set TWO ways, both converge on the flag: (a) a **Recharge** line on a Crew & Transport quote (auto-set on quote save), or (b) the compact **⛽ toggle in the Money tab's Job Costs panel** (`MoneyTab.tsx` — for the no-quote / mid-hire case; it was removed from the Job Detail header as redundant). The flag drives: **cost auto-inherit** (`routes/costs.ts` create — a running-cost cost, Xero code 410/411/325, on a flagged job defaults to `extra` + recharge-pending, with an amber hint in `CostCaptureModal`), and the **standing forward-looking `recharge_running_costs` post-hire card** (`hh-requirement-derivation.ts`, amber "expect invoices", manual close — distinct from the reactive `cost_resolve`). The capture modal's "This job so far" box also surfaces the job's *expected* recharges (declared Recharge lines across its quotes).

**3. Expense charge model — `QuoteExpenseItem.chargeMode`.** Four states: `included` | `not_included` | `recharge` | `na`. **PD defaults to `na`** (most jobs carry none). `recharge` + `na` are both excluded from the client quote total (recharge bills at actual post-hire; the amount on a recharge line is an indicative estimate). Back-compat: absent `chargeMode` derives from the legacy `included` boolean. The 4-radio-column control (+ "set all" headings) is shared by `TransportCalculator.tsx` (create) and `QuoteEditModal.tsx` (edit — which fetches expenses via `GET /quotes/:id` so **both the Job Detail and Transport Ops edit entry points behave identically**; the PUT accepts `expenses`, recalcs the total, re-flags the job, and lets staff **add / remove / retype** lines, not just re-state them). `expensesRecharge` is a calculator output; recharge lines stay out of `clientChargeTotal`.

**Fee edits vs recalc — override semantics on `PUT /quotes/:id` (Jul 2026).** The edit modal echoes the loaded fee figures back on EVERY save, so the PUT handler treats a posted `client_charge_rounded` / `freelancer_fee_rounded` as an override **only when it differs from the stored value** (compared against `oldQuote` — safe for stale browser bundles too). Genuine overrides are **re-applied AFTER the recalc block**, so editing the fee and editing the expenses are independent intents: whichever you touched wins for its own field; an untouched fee follows the calculator. Pre-Jul-2026 the overrides were gated on `!recalcNeeded`, and since the modal always sent `expenses` (forcing `recalcNeeded=true`), every fee edit on a calculator-backed quote was silently dropped and overwritten by the calculator reproducing the original figure — the "fee reverts on save" bug. Companion frontend fix: `QuoteEditModal` dirty-tracks expenses and only includes them in the payload when actually touched — sending them unconditionally also meant a notes-only save repriced the quote from *current* `calculator_settings` (fuel price drift etc.). **Don't regress either half:** new fields on the edit modal that feed the calculator should extend `calcAffectingFields`, and any new derived-total writer in the PUT must run before the fee-override re-apply. NB quote fee edits never push to HireHop (the amber "already pushed to HH" banner covers that); local D&C quotes skip recalc entirely. Display gotchas when verifying a fee edit landed: a quote in a **priced run group** renders the run's combined fee on Job Detail / Transport Ops / the portal (individual fee struck through — by design), and the portal reads `quote_assignments.agreed_rate` in preference to the quote fee (normally NULL — the standard "+ Assign" picker sends only person + role; only Monday-migrated or manually-rated assignments carry one).

**4. Freelancer portal clarity — `deriveCrewMoney()` in `routes/portal.ts` is the SINGLE source of the freelancer-facing pay/reimburse wording.** It turns the quote's expense states into plain instructions on the portal job page ("Expenses & Per Diem — what to do"): **Per Diem ALWAYS shows a line** (No PDs / "we're paying it — include on your invoice" / "client pays you directly"); **fronted** types (fuel/parking/tolls) → "pay it, include on your invoice"; **prebooked** types (hotel/transport) → "booked & paid by Ooosh"; `not_included` → "client covers directly". Reword freelancer money instructions there, one place. The panel only renders in `DATA_BACKEND=op` mode (the portal is the in-repo Next.js app at `src/app/`).

**5. V&D / freelancer soft book-out scale-back.** When Ooosh hands the van to our own / a freelancer driver (`isVanAndDriver` in `BookOutPage.tsx`), the ONLY hard requirements are **fuel + mileage** — photos, briefing, and signature are optional. **Normal customer self-drive is unchanged** (full walkaround + signature; gated strictly on `isVanAndDriver`). Check-in fires an active amber "fuel down → chargeable, log the receipt" prompt when the van returns lower on fuel (`CheckInPage.tsx`). The new-driver / long-hire auto-nudge for photos is a parked Future Enhancement.

**Watch-outs for future work:** (a) any "recharge pending" query keys on `recharge_status`, not `recharged_to_hh_at`; (b) don't re-add N/A logic that counts `na` lines in a total; (c) the recharge flag is set-only on quote save (removing the last Recharge line does NOT auto-clear it — the ⛽ toggle is the off switch); (d) freelancer wording lives ONLY in `deriveCrewMoney`; (e) don't relax the self-drive book-out gate — the scale-back is `isVanAndDriver`-only.

### PII Encryption ✅ COMPLETE (PR 3, May 2026)

**File:** `backend/src/services/encryption.ts`

Application-level AES-256-GCM encryption for fields that must never sit in the database as plaintext. First consumer is **client bank details for excess reimbursement** (migration 094); the rest of the PII surface gets retrofitted on jon's timeline (checklist below).

**Exports:**
- `encrypt(plaintext) → "iv:authTag:ciphertext"` (hex) / `decrypt(stored) → plaintext`
- `encryptJson(obj)` / `decryptJson<T>(stored)` — for structured records (bank details)
- `tryDecrypt` / `tryDecryptJson` — best-effort variants returning `null` instead of throwing (use in list-mapping loops so one bad row doesn't 500 the response)
- `isEncryptionConfigured()` — guard before calling. Routes 503 / refuse-and-warn cleanly on a server without the key, rather than throwing a 500. **Never fall back to storing plaintext** when the key is missing — refuse the write and surface a warning (the reimburse flow does this).

**Format:** `iv:authTag:ciphertext`, all hex. IV is random per call (12 bytes, GCM), so the same plaintext encrypts to different ciphertext each time — expected. Decrypt ONLY in the API response layer, admin/manager only. Never decrypt inside SQL or log decrypted values.

**Key management — CRITICAL:**
- `ENCRYPTION_KEY` env var = 64 hex chars (32 bytes), `openssl rand -hex 32`.
- **The key must NEVER change once data is encrypted with it** — rotating or losing it makes every encrypted field permanently unrecoverable. There is no recovery path.
- jon generated the key and holds it safely. It goes into `/var/www/ooosh-portal/backend/.env` as `ENCRYPTION_KEY=...` when PR 3 deploys. Until it's set, bank-detail storage is refused (no plaintext fallback) and decrypt endpoints 503 — everything else works.

**Bank details (the first consumer):** Stored encrypted on `job_excess.bank_details_encrypted` (migration 094), SCOPED TO THE RECORD (not permanently on person/org). Captured in the reimburse form when the method is a bank transfer (`wise_bacs` / `lloyds_bank`). UK = holder + sort code + account number; international = holder + IBAN + SWIFT/BIC + bank country (structured for a future Wise recipient). `GET /api/excess/:id/previous-bank-details` finds the client's most recent record with details for a "reuse from previous hire" offer, with a `bank_details_last_used_at` staleness heads-up so staff reconfirm before relying on them. `bank_details_last_used_at` is stamped every time a reimbursement is recorded against the details.

**Retrofit checklist (apply on jon's timeline — build once, encrypt incrementally):**
- [x] Client bank details (reimbursement) — done in PR 3
- [~] Driver PII — **Phase 1 SHIPPED (Jun 2026, migration 103)**: `date_of_birth`, `dvla_check_code`, `address_line1`, `address_line2`, `address_full`, `licence_address` on `drivers`. Dual-write (plaintext kept + `*_encrypted` companions), reads prefer encrypted with plaintext fallback (`services/driver-pii.ts` — `encryptDriverPiiInto`/`decryptDriverRow`). Backfill: `scripts/encrypt-driver-pii.ts` (dry-run default, `--commit`, `--verify` key round-trip). Live backfill done (246 drivers / 900 fields, 0 remaining). **`licence_number` + `postcode` deliberately NOT encrypted** — used in live ILIKE/exact search; need a blind-index to encrypt (separate follow-up). **Phase 2 STILL TODO** (no rush — Phase 1 is correct, plaintext just still co-exists): (a) convert the two ALIASED hire-form PDF read paths (`hire-forms.ts` ~1110 + ~2028 — `d.date_of_birth AS driver_dob` etc., which `decryptDriverRow` can't match; inventoried in the `driver-pii.ts` header), then (b) a migration to null the plaintext columns + stop the plaintext write. Passport expiry + the searched fields are later slices.
- [x] Storage door codes — done (migration 128). `storage_tenancies.access_code` → `access_code_encrypted`; see Step 9 Client Storage notes + `scripts/encrypt-storage-access-codes.ts`.
- [ ] Card-machine receipt scan storage (the scan files themselves; metadata flag already on `job_excess`)
- [ ] Freelancer PII (held in `people` / `drivers`)

When retrofitting a field: add an `*_encrypted TEXT` column, write via `encrypt`/`encryptJson` (guarded by `isEncryptionConfigured()`), decrypt only in the admin/manager response layer via `tryDecrypt`/`tryDecryptJson`, and never log or SQL-query the decrypted value.

### API Key Verification ✅ COMPLETE

**File:** `backend/src/middleware/api-key.ts`

Single source of truth for verifying the `X-API-Key` header against the `api_keys` table. Pulls all rows with the matching `key_prefix` and `bcrypt.compare`s the full key against each row's `key_hash`. Bumps `last_used_at` on success.

Used by:
- `POST /api/money/*` (`authenticateFlexible` in `money.ts`) — Payment Portal
- `POST /api/webhooks/external/status-transition` — external status pushes

**Why this exists:** the original inline implementation in both files only matched the first 8 chars of the supplied key against `api_keys.key_prefix`, accepting any string starting with a known prefix (e.g. `ppk_live`) as authenticated. Bypassed the bcrypt hash entirely. Fixed May 2026.

**Routes that DON'T use this:** routes authenticating against a single env-var key (`hire-forms.ts`, `driver-verification.ts`) use `crypto.timingSafeEqual` directly — different pattern, not vulnerable.

**Audit script:** `backend/src/scripts/audit-api-key-hashes.ts` checks existing rows have bcrypt-shaped `key_hash` values. Run before deploying changes that affect API key auth, or whenever a new row is added. Reports non-bcrypt / missing hashes per row, and the deploy-safety summary only counts active rows (inactive rows can have any garbage in `key_hash` — `verifyApiKey` won't query them).

**Creating a new api_keys row:** never insert plaintext or non-bcrypt values into `key_hash`. The May 2026 audit revealed two historical rows had been inserted incorrectly — one with a SHA-256 hex string in `key_hash`, one with `key_hash = NULL`. Both authenticated under the old prefix-only code despite the wrong hash format; both broke under the new bcrypt-strict code. Standard creation pattern:

```ts
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const key = `ppk_live_${crypto.randomBytes(24).toString('hex')}`;
const hash = await bcrypt.hash(key, 12);
// INSERT INTO api_keys (name, key_hash, key_prefix, service, is_active)
//   VALUES ('Foo Service', $hash, key.substring(0, 8), 'foo_service', true);
// Then store `key` in the consuming integration's env var (Netlify, Vercel, etc.)
// — that's the only time you'll see the full plaintext value.
```

The `key_prefix` should be the first 8 chars of the plaintext key (used as a fast lookup index — `verifyApiKey` matches on prefix, then bcrypt-compares the full key against each candidate's `key_hash`).

### Post-Hook Recovery ✅ COMPLETE (7 May 2026)

**File:** `backend/src/services/post-hook-recovery.ts`

Hardening for the fire-and-forget `setImmediate` blocks that run after a route has already responded (post-PATCH side-effects: PDF generation, status writebacks, requirement syncs, email sends, etc.). Wrap the inner work with `runHookWithRecovery({...}, async () => { ... })` instead of bare try/catch.

**What it does:**
1. **Retry with exponential backoff** — 3 attempts at 1s / 4s / 16s. Catches transient DB pool exhaustion, network blips, momentary HH 429s.
2. **Loud failure alert** — when retries are exhausted, writes a `notifications` row (priority=high, type=`system`) for every active admin/manager + emails `info@oooshtours.co.uk` with the hook label, job ref, error message, and a click-through to the job. Means a permanent failure is visible in minutes instead of "next time someone notices an email didn't arrive".

**Idempotency contract:** every consumer hook MUST be safe to retry. Current consumers all have natural idempotency markers (`hire_form_emailed_at`, `ooh_info_sent_at`, "skip if HH already at target status" guards in auto-dispatch, forward-only requirement sync helpers). Any new hook wrapped with `runHookWithRecovery` must satisfy the same property — adding it to a non-idempotent operation will double-send / double-write.

**Wired into:** the 5 post-book-out hooks in `routes/hire-forms.ts` PATCH handler — vehicle requirement sync, post-book-out requirement advance, hire form PDF + email, OOH info email, auto-dispatch. The 7 May 2026 RX72TKO incident lost all 5 simultaneously to a single Postgres connection timeout that coincided with a deploy restart; after this hardening, the same blip would have been retried + recovered automatically, or surfaced via bell + email if the retries also failed.

**NOT a replacement for the eventual outbox pattern** (see "Future Enhancements" — outbox would survive server restarts and give full observability over pending work). This is the cheap fix that closes ~90% of the gap until that work is scheduled. New `setImmediate` blocks added to the codebase should use `runHookWithRecovery` until the outbox lands.

**Usage:**
```ts
import { runHookWithRecovery } from '../services/post-hook-recovery';

setImmediate(() => {
  runHookWithRecovery(
    {
      hookLabel: 'Some background task',
      jobId,                  // OP UUID — drives the action_url
      hhJobNumber: hhJobId,   // human-readable in the alert title
      assignmentId: id,       // optional — included in alert body
    },
    async () => {
      // Do the actual work. Throw on failure.
    }
  ).catch((err) => {
    console.error('[my-route] background task failed (after retries):', err);
  });
});
```

The outer `.catch` is for the post-alert rethrow — the alert has already fired by then, this is just for log visibility.

### Vehicle Notification Recipients ✅ COMPLETE

**File:** `backend/src/services/vehicle-notify.ts`

Centralised recipient helper for vehicle-related alerts (insurance referrals, mid-tour drivers, fleet compliance — MOT/Tax/Insurance/TFL). Returns `{ to: 'info@oooshtours.co.uk', cc: ['will@oooshtours.co.uk'], bellUserIds: [<Will's UUID>] }` with 5-min in-process cache.

**Why this exists:** Pre-May 2026, vehicle bell notifications fanned out to every active `role IN ('admin', 'manager')` user (~5 staff). High-priority bells escalating to email after 1h meant one referral generated 5+ emails to staff who don't look after vehicles. Most managers cover other areas of the business and shouldn't be in this loop. Hardcoded info@ + will@ for now (can move to env vars if recipients ever need to differ across environments).

**Usage:**
```typescript
const { getVehicleNotificationTargets } = await import('../services/vehicle-notify');
const targets = await getVehicleNotificationTargets();

// Direct email
await emailService.send('referral_alert', {
  to: targets.to,        // info@
  cc: targets.cc,        // will@
  variables: { ... },
});

// Bell — only the vehicle manager. Set email_sent_at = NOW() if a direct
// email was also sent, so notification-escalation doesn't double-fire.
for (const userId of targets.bellUserIds) {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, priority, email_sent_at, ...)
     VALUES ($1, 'compliance', $2, $3, 'normal', NOW(), ...)`,
    [userId, ...]
  );
}
```

**info@ as guaranteed fallback:** if Will's user record is missing or `is_active = false`, `bellUserIds` is empty (no bell fires) but emails still send. info@ never goes silent.

**Wired into:**
- `routes/driver-verification.ts` — referral bell when flag set mid-flow (no email here; the proper email fires from hire-forms.ts when the form is submitted)
- `routes/hire-forms.ts` — `referral_alert` email + mid-tour driver bell + `mid_tour_driver` email
- `services/compliance-checker.ts` — daily compliance bells + per-alert `compliance_reminder` email (added direct email path; previously relied on bell→escalation fanout for delivery)

**Don't bypass:** any future vehicle alert path (e.g. issues register notifications, vehicle swap alerts, breakdown notifications) MUST use this helper rather than reverting to `WHERE role IN ('admin', 'manager')`. The legacy `vehicle_compliance_settings.notification_roles` setting is intentionally ignored — kept in the DB for backwards-compat reads but no longer drives recipients.

**Escalation duplicate-prevention pattern:** when both a direct email AND a bell fire for the same event, set `email_sent_at = NOW()` on the bell INSERT. The 15-min escalation scheduler skips notifications where `email_sent_at IS NOT NULL`, so Will doesn't get the same content twice.

### Portal Notification Preferences ✅ COMPLETE (May 2026)

**File:** `backend/src/services/portal-notification-prefs.ts`

Single source of truth for "should this informational portal notification be sent?". The freelancer/staff D&C portal splits notifications into two classes with distinct mute behaviour:

| Class | Examples | Respects mute? |
|---|---|---|
| **Informational** | `freelancer_assignment` (new allocation), `job_change_notification` (date / time / venue change) | Yes — global mute (`people.portal_notifications_paused_until`) AND per-job mute (`people.portal_muted_quote_ids`) |
| **Accountability** | completion-chaser ladder (2h / 6h / 14h), staff L3 escalation | **No — always sends, by design** |

**Why two classes:** the staff shared account (info@) keeps its global mute set permanently to suppress new-allocation/time-change spam (D&C is a high-volume internal flow). But "you haven't marked the job complete yet" chases MUST still land — that's the accountability loop. A single all-or-nothing mute couldn't do both. Same applies to freelancers going on holiday — they can mute informational comms but completion accountability survives.

**Usage pattern:**
```typescript
import { shouldSuppressInformational } from '../services/portal-notification-prefs';

const { suppress } = await shouldSuppressInformational(personId, String(quoteId));
if (suppress) return;  // or `continue` inside a loop
```

**The rule:** every NEW informational sender to the portal MUST call this helper before sending. Accountability senders MUST NOT — chases bypass mute by design. The helper logs every suppression to console for debugging (`[notify] suppressed for person {id}: {reason}`).

**Wired into:**
- `routes/quotes.ts` PUT `/:id` — `job_change_notification` (refactored from inline mute check)
- `routes/quotes.ts` PATCH `/:id/status` — `freelancer_assignment` on draft → confirmed (also sets `qa.confirmed_at` on suppression so a future re-confirm doesn't replay if mute later expires)
- `routes/quotes.ts` POST `/:id/assignments` — `freelancer_assignment` on new assignment to confirmed quote

**NOT wired into (deliberately):**
- `services/completion-chaser.ts` — accountability class, always fires. Also dropped its `qa.is_ooosh_crew = false` filter so info@ assignments get chased on the same ladder. L3 staff escalation is suppressed when chasee email IS info@oooshtours.co.uk (avoids self-CC since L1+L2+L3 already landed there).
- `src/app/api/webhooks/monday/job-updated/route.ts` — Next.js, Monday-shaped data (comma-separated string, not UUID array), on the deprecation path under `PORTAL_MONDAY_FALLBACK_ENABLED`. Refactoring would create new cross-service coupling that's about to be torn down.

**Storage** (migration 067):
- `people.portal_notifications_paused_until` — TIMESTAMPTZ, future = muted, year-2125 sentinel = "indefinite". info@ seeded muted indefinitely.
- `people.portal_muted_quote_ids` — UUID[], per-job mutes for "stop bugging me about THIS specific hire I already know about".

**UI surfaces:**
- **Portal banner:** `src/components/MuteBanner.tsx` mounted in root portal layout (`src/app/layout.tsx`). Sticky red strip across top of every authenticated page with inline Resume button. Mobile-first (44px tap targets). Hidden on 401 / no mute / fetch error.
- **Portal settings:** `src/app/settings/page.tsx` — 4 mute durations (end of today / 7 days / specific date / indefinite), per-job mutes managed from each job's detail page.
- **Staff address book:** `frontend/src/pages/PersonDetailPage.tsx` — small amber 🔕 chip in the freelancer details block when `portal_notifications_paused_until` is in the future. Read-only context for staff.

**Watch list:**
- Staff report "stopped getting allocation emails" → check `portal_notifications_paused_until` on their `people` row. Pre-May-2026, `freelancer_assignment` ignored mute entirely; the May 2026 fix correctly stops sending when muted.
- Staff report "didn't get a completion chase" → NOT mute-related. Check `qa.is_ooosh_crew`, `qa.status`, `q.ops_status`, `q.completion_reminder_level` and the `completion-chaser.ts` query.

### Render-crash safety: error boundaries + date parsing ✅ (Sep 2026)

**The incident.** Switching Fleet to **table** view threw `RangeError: Invalid time value` and blanked the entire SPA. `RX73TBZ` had `last_rossetts_service_date` stored as `0006-08-25` (mistyped year); `formatDate()` in `routes/vehicles.ts` padded month and day but **not** the year, so it reached the frontend as `"6-08-25"` — and **any year that isn't exactly 4 digits is an Invalid Date in JS**. `getRossettsStatus()` → `addMonths()` → `toISOString()` threw inside the fleet table's row `.map()`, so one bad van took the whole page down. Only the table view calls `getRossettsStatus`, which is why cards/finance were fine — the finance view's `sellByDate()` already had the guard `service-status.ts` was missing.

**Three conventions came out of it:**

1. **Never call `toISOString()` on a Date you haven't range-checked.** Any helper that parses a date string and re-serialises it MUST `Number.isNaN(d.getTime())`-guard both *after parsing* and *after shifting* (a shift can overflow the Date range, or land on NaN if an interval argument is non-numeric — e.g. a garbage `rossetts_interval_months` compliance setting). `service-status.ts` `shiftDate()` and `vehicle-lifecycle.ts` `sellByDate()` are the reference implementations; return `null` and let the caller render `—`. There's a standing comment on the same trap in `prep-trends.ts`.

2. **Zero-pad the year when hand-building a `YYYY-MM-DD` string.** `backend/src/routes/vehicles.ts` `formatDate()` is the shared helper behind every date on every vehicle payload; it pads the year to 4 and returns `''` for an Invalid Date rather than `"NaN-NaN-NaN"`. Postgres will happily store year 6 or year 202, so this is not hypothetical. Any new date serialiser must do the same.

3. **A render throw must not be able to blank the platform.** `frontend/src/components/ErrorBoundary.tsx` is mounted **twice** in the tree: once **inside `Layout`** wrapping the page `<Routes>` (so a page crash keeps the nav usable and staff can navigate away), and once around the whole app in `main.tsx` (backstop for crashes in `Layout` itself and the public, Layout-less routes). It resets its error state when `location.pathname` changes — deliberately **without** re-keying its children, so normal navigation keeps page state exactly as before.

**The trap that made it unrecoverable, and the escape hatch.** The crash alone was survivable; what made staff *stuck* was `fleet-view-mode` persisting in `localStorage`, so every reload restored the table and re-crashed before anything could be clicked. The boundary's **"Reset saved view settings"** button clears all of `localStorage` **except** an allowlist of session keys (`SESSION_KEYS` in `ErrorBoundary.tsx` — the `ooosh_*` staff tokens plus the `vehicleApp*` vehicle-module/freelancer session), so the user stays logged in. Allowlisting sessions rather than listing pref keys means dynamically-named prefs are covered and **a new persisted preference needs no change here** — but **any new *session* key MUST be added to `SESSION_KEYS`**, or the reset button will log people out.

**When adding a persisted view preference,** remember it can pin a page into a crashing state on reload. That's now recoverable via the boundary, but prefer validating a stored value on read (as `VehiclesPage` does for `fleet-view-mode`) over trusting it blindly.

### Hire Date Resolution

**Canonical hire-window source for PDFs / emails / overlap checks:**

| Field | Authoritative source | Fallback |
|---|---|---|
| Hire start date | `vehicle_hire_assignments.hire_start` (set at book-out, optional override) | `jobs.job_date` (Job Start) |
| Hire end date | `vehicle_hire_assignments.hire_end` (set at book-out, optional override) | `jobs.job_end` (Job Finish — the REAL end of charge) |

**Important:** The fallback for hire end is `jobs.job_end`, **NOT `jobs.return_date`**. The `return_date` field is the artificial +1-day turnaround buffer used for warehouse scheduling — it's not when the hire actually ends.

This was a real bug: `hire-forms.ts` PDF generation at lines 1173 + 1424 was using `j.return_date` as the fallback, while `assignment-overlap.ts` used `j.job_end`. Hire agreement PDFs would show a different end date than the overlap check expected. Fixed Apr 2026 — both now use `j.job_end`.

**The four-layer date model:**
1. `jobs.job_date / job_end / out_date / return_date` — HH-synced job dates (canonical for the JOB)
2. `vehicle_hire_assignments.hire_start / hire_end` — per-van actual hire window (CAN drift from job dates intentionally — e.g. client picks up the night before)
3. `vehicle_hire_assignments.booked_out_at / checked_in_at` — when book-out / check-in physically happened (event timestamps)
4. Vehicle event history — full audit trail

Book-out is the canonical moment dates get LOCKED on the assignment. Before book-out, `hire_start/hire_end` are tentative (mirror job dates if not set). At book-out, staff can adjust them on the BookOutPage form. Mid-tour drivers added after book-out get THEIR own `hire_start = NOW()`.

### Book-out / check-in lifecycle invariants (Jun 2026)

Two invariants that, when broken, silently strand a hire and mis-attribute its check-in to the wrong job. Learned the hard way via **RX73TBZ (jobs 16057↔16149)** — read before touching any book-out or check-in path.

**1. Any path that sets `vehicle_hire_assignments.status = 'booked_out'` MUST also stamp `booked_out_at`.** A "real" book-out used to be split across two writes: the status flip (`PATCH /api/hire-forms/:id` — the BookOutPage per-driver writeback loop) AND a *separate* `save-event` vehicle event (which wrote the R2 history card and stamped `booked_out_at`). The PATCH path did NOT stamp `booked_out_at` — only the event did. So when the event failed to land (transient error, abandoned walkaround, offline-queue not flushed), the row read as `booked_out` with `booked_out_at = NULL` and no history card. Fixed Jun 2026: `hire-forms.ts` PATCH now stamps `booked_out_at = COALESCE(booked_out_at, NOW())` (+ `booked_out_by` for staff) on the transition. The other paths (`assignments.ts` `/book-out`, `vehicles.ts` save-event, `hire-forms.ts` add-to-hire) already stamped it. **Any NEW book-out path must stamp it too — a `booked_out` row without `booked_out_at` is a bug.**

**2. Check-in resolves the hire from the authoritative assignment, NOT the latest R2 book-out event.** `CheckInPage` used to read the van's most-recent book-out *event* and key the whole check-in (the R2 card's `hireHopJob` AND the backend's assignment-flip) off it. When invariant 1 was broken, the live hire had no book-out event, so the event query returned a STALE book-out from a *previous* hire — and the check-in got stamped against that wrong job, leaving the real hire stuck `booked_out` (the prior hire even got a duplicate check-in card). Fixed Jun 2026: `GET /api/vehicles/check-in-eligibility` already returned `hirehopJob` (the open assignment's job, straight from the DB); `checkAlreadyCheckedIn` now threads it through and `CheckInPage` prefers it over the event's job (logs a `console.warn` on disagreement). **The DB assignment is the source of truth for "which hire is this van on" — never resolve it solely from R2 event history.**

**Tripwire:** `runBookedOutNoTimestampScan` (`services/sanity-check-scanner.ts`, wired into the 15-min sanity cron) flags any `booked_out` row with `booked_out_at IS NULL` for > 3h — impossible post-fix, so a hit means a new path has regressed invariant 1. One alert per job to info@, deduped via a `[Tripwire: …]` notes marker (stamp-first, like the other scans).

**Historical backlog (cleared Jun 2026):** `16149`, `15769` (×4), `15738` — hires booked out via the PATCH path before the fix that never got a proper check-in, leaving rows stuck `booked_out` on already-`completed` jobs (and the van wrongly reading "Check In available" / `fleet_vehicles.hire_status='On Hire'`). Flipped to `returned` by hand. The fleet-wide finder for any future occurrence: `booked_out`/`active` assignments whose linked job is already `returned`/`completed`/`cancelled`/`lost` (dual job-match on `job_id` OR `hh_job_number`). Flipping the assignment does NOT recompute `fleet_vehicles.hire_status` (raw SQL skips `syncFleetHireStatus`), so correct the cached fleet status separately if the stale row was pinning the van `On Hire`.

### Check-in damage → Problems register (Sept 2026) — job 15428 / RX24SZD

**Damage flagged at check-in reaches OP by TWO independent routes, and both were broken.** A dent
photographed on RX24SZD's check-in appeared on the condition-report PDF and nowhere else: no
`job_issues` row, no `damage_review` card, an empty Problems panel.

1. **`job_issues` (the Problems register)** — `CheckInPage` posts one
   `POST /api/problems/auto-create` per damage item. It used to `continue` past any item whose
   **description was blank**, and the Description box is an optional textarea behind a
   `canAdvance() => true` step. Location + severity + three photos with no typed description
   produced no issue at all. **A damage item is now always posted**, falling back to
   `"<Severity> damage flagged at check-in — see photos"`. Don't reintroduce a content gate here —
   the PDF happily renders a description-less damage item, so any gate the PDF doesn't share
   silently splits the two records.
2. **`vehicle_hire_assignments.has_damage` → the post-hire `damage_review` card** — dead twice
   over. `createVehicleEvent` had no `hasDamage` param and no caller sent one, so
   `event.hasDamage === true` was always false; and the write was
   `has_damage = COALESCE(has_damage, $4)` on a `BOOLEAN DEFAULT false` (never NULL) column, so it
   could only ever return the existing `false`. **COALESCE is right for `mileage_in`/`fuel_level_in`
   and wrong for a not-null-defaulted boolean** — it is now
   `has_damage = COALESCE(has_damage, false) OR $4` (forward-only; a later corrective event can't
   clear a flagged hire). Verified: `has_damage` had never been `true` on a single row in
   production, so that card had never once fired.

**The silence is the part that cost the day.** The results panel only rendered its
"Damage issues logged" row when `created || reflagged || failed` was non-zero, so a fully-skipped
damage set showed a clean success screen. It now **always** renders once `damageItems.length > 0`,
reading `0 logged from N damage item(s) — log manually on the job` in the bad case. Any new
post-submit side-effect on a walkaround page should report itself the same way — a step that can
no-op must say so.

**Consequence for anything already checked in:** damage lives in `job_issues`, not the event JSON
(`createVehicleEvent` persists neither `damageItems` nor a damage flag — only a free-text
`Damage items: N` line in `details`). So for a pre-fix check-in, **regenerating the condition report
reconstructs "NO DAMAGE REPORTED"** — the frozen PDF at `condition-reports/<REG>/<eventId>.pdf` is
the real record. Log the damage manually via **+ Log Problem** on the job.

**Two latent gaps closed alongside:** the `damage_review` derivation query tested `job_id` only, so
it missed damage on staff-allocation / V&D rows (which carry only `hirehop_job_id`) — now dual-match;
and `POST /api/assignments/:id/check-in` (the *other*, correct `has_damage` writer, which has **no
frontend caller**) did `SELECT registration FROM fleet_vehicles` against a column actually named
`reg` — it would have thrown on every run, which is itself the proof that path has never executed.

**Still open:** the offline queue replay (`sync-processors.ts processCheckInSubmission`) does not
mirror the `auto-create` loop, so a queued check-in creates the `damage_review` card (it now sends
`hasDamage`) but no `job_issues` rows.

### Multi-van book-out scramble (Jul 2026) — read before touching the book-out write path

**Full incident + root cause + cleanup + fix design: `docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md`.**

**The bug:** the book-out write path **never partitions driver rows by van.** On a 2-van
"everyone drives everything" self-drive job, all drivers share one set of `vehicle_hire_assignments`
rows, and *each* van's book-out stamps itself onto *all* of them — there's no
`van_requirement_index` scoping. Because three fields have three different write disciplines, the
first and last van each "win" different columns on the same shared rows, so the data comes out
**scrambled, not merely wrong**:
- `vehicle_id` — last-write-wins (BookOutPage `writeBackTrack` PATCH loop, `hire-forms.ts` PATCH `fieldMap` plain assign) → **2nd** van booked out wins every row.
- `mileage_out` — first-write-once (`save-event` book-out branch, `vehicles.ts` `COALESCE(mileage_out, …)`) → **1st** van wins.
- `hire_form_pdf_key` — first-write, atomic-claim (`generateAndEmailHireFormPdf`) → **1st** van wins.
- The 2nd van ends with **zero rows** (its rows' `vehicle_id` got overwritten to the other van), so a check-in for it hits the DB-authoritative gate (`check-in-eligibility`, `JOIN fleet_vehicles ON fv.id = vha.vehicle_id`) with nothing to find → falls back to the van's *previous* hire and blocks. **Live incident: job 14885, RX24SZG blocked at check-in behind RO23HLU (Jul 2026).**
- **Sibling symptom — photos:** book-out walkaround core photos are keyed `events/{eventId}/{REG}/{angle}.jpg`; a crossed `form.vehicleReg` files the 2nd van's core photos under the wrong reg/eventId, so its check-in "Book-Out Summary" (a **live listing of one prefix**) shows only the handful of uniquely-keyed extras. **The photos are NOT lost** — the condition-report PDF embeds them via a separate LOCAL base64 pipeline (frozen at `condition-reports/{REG}/{eventId}.pdf`), and the loose objects sit under the crossed prefix (recover/enumerate via `get-events` → `list-photos?prefix=…` → `regenerate-pdf`). The PDF's "View full size" links 404 for the same reason (they point at the expected, empty key) — self-contained, not a general link bug.

**The one line that permits it:** the PATCH terminal-row guard blocks writes only on
`swapped`/`returned`/`cancelled` — so a row already `booked_out` to one van can have its
`vehicle_id` re-stamped by a *second* van's book-out. Tightening that (refuse to overwrite
`vehicle_id` on a row already booked out to a *different* van) is the narrowest guard.

**Blast-radius fingerprint (sweep):** a row whose `hire_form_pdf_key` reg ≠ its `vehicle_id`'s
fleet reg (and the PDF reg is a real, different fleet van). At discovery: **3 jobs** — 14885
(fixed), 15411 (Jabir HLR/HLU), 16206 (SA75RVV/RX73TBZ). 15411/16206 are completed, no stuck flags.
Query + per-job cleanup in the doc. **Verified 30 Jul 2026 — all 3 jobs clean; no mileage tidy
needed** (the surviving RO23HLU/SA75RVV rows already carry the correct book-out/check-in mileage per
the emailed condition-report PDFs; the prior investigation's scrambled figures were a stale
snapshot). RO23HLR/RX73TBZ have no rows on their jobs — deliberately NOT recreated on completed
hires; their mileage lives in the event history / PDFs.

**Status:** 14885 cleaned up (mileage `UPDATE` + missing-van `INSERT` + UI check-in).
**(1) Detection scanner — SHIPPED (migration 187).** `runStuckOnHireScan`
(`services/sanity-check-scanner.ts`, wired into the 15-min sanity cron) finds vehicles projected
`hire_status='On Hire'` with NO live `booked_out`/`active` assignment row — mirrors
`syncFleetHireStatus`'s exact "has a live assignment" definition (dual job match, lost/cancelled
excluded), so "no live row" == "the projection is unjustified". Emails **jon@** (not info@) ONCE per
stuck van, deduped via `fleet_vehicles.stuck_onhire_alerted_at` (stamp-first; **cleared in
`syncFleetHireStatus` when the van leaves On Hire**). HH job number is best-effort R2 enrichment
(`lookupStuckOnHireJob` reads the van's most recent book-out event — the DB assignment points at the
van's PREVIOUS hire, so the current job can only come from the event). Also catches any other stale
On-Hire drift (self-corrects on next sync, one alert).
**(2) The core fix — SHIPPED (PR #1057, Jul 2026).** Book-out now **partitions driver rows by
van**: when a book-out `PATCH /api/hire-forms/:id` (`status='booked_out'` + a `vehicle_id`)
targets a **driver** row already live-booked-out to a **different** van, it **clones** a fresh
per-van row for `(this driver, this van)` instead of re-pointing the shared one — van A's row is
left untouched, van B gets its own rows and becomes bookable + checkinable. Idempotent (reuses an
existing `(driver, van, job)` booked-out row on retry). The clone drives the same post-book-out
chain as the normal path — `cancelOrphanSiblingAllocations` + `firePostBookOutHooks` (fleet
status, own-van agreement, `fanOutVanHireForms` cross-van, OOH, auto-dispatch) + vehicle-requirement
sync — so the **per-driver referral gate stays intact** (the clone's agreement routes through
`generateAndEmailHireFormPdf` → `isDriverAuthorisedForAgreement`; a referral-pending driver is held
back exactly as before). A non-book-out re-point of a live van, or a driverless row, is **refused**
(no-op 200) — genuine swaps go through Swap Vehicle; this is the terminal-guard tightening. The
frontend `updateDriverHireForm` now forwards `mileage_out` so the second-van clone records the
correct odometer (backend consumes it ONLY on the clone path — the normal update ignores it,
save-event still owns `mileage_out` there). Closes fields + photos + view-full-size links at source
(none cross once the reg isn't crossed). **Implementation note / deliberate deviation from the
original sketch:** the clone lives in the **PATCH path ONLY**, not a shared PATCH+save-event
choke-point. Reasons: (a) in a staff book-out `save-event` fires BEFORE the write-back PATCH loop,
so it can't see clones the PATCH hasn't made yet; (b) the incident class is staff self-drive
multi-van (uses the PATCH loop); (c) freelancer multi-van D&C is explicitly out of scope. If a
freelancer multi-van book-out ever needs this, the same clone logic would have to move into (or be
duplicated at) the `save-event` book-out matcher in `vehicles.ts`. **No migration** (Zod
`patchSchema` gained optional `mileage_out`/`fuel_level_out`; consumed only on the clone branch).
**Verify live** on the next real 2-van book-out — build-verified only, no runtime CI (see the PR's
"How to verify"). The historical mileage tidy for 15411 + 16206 was **verified clean on
30 Jul 2026 — no action needed** (both jobs' surviving rows already match the emailed PDFs; the
doc's scrambled figures were stale). The multi-van scramble item is now fully closed bar the live
2-van book-out verification.

### Per-job contacts (`job_contacts`)

**The convention:** each hire has its own contact list — who's actually involved in THIS booking — distinct from the org-wide "who works at this company" model in `person_organisation_roles`. Rounds 1-6 (May 2026) built this end-to-end: the storage layer, the routing graduation, the management UI, and the HH push enrichment. **All new client-facing email senders, and any new HH push surface, MUST follow this convention.**

**Storage** (migration 086):

`job_contacts (job_id, person_id, is_primary, role_override, notes, created_by, created_at, updated_at)`
- `UNIQUE (job_id, person_id)` — one row per person per job
- Partial unique index `WHERE is_primary = true` — at most one primary per job (enforced; passing two would 23505)
- `role_override` reserved for the edge case where a person's per-job role differs from their org-level role; NULL = inherit. Most rows leave it NULL.

**Why a new table rather than `person_organisation_roles.is_primary`:** `is_primary` is org-wide. "Sarah is primary at ATC Live" means she's primary on every job for ATC Live. We need per-job selection where some hires have Sarah as lead, others Tom, some both ticked with Sarah as lead. `job_contacts` lets that vary independently per job without polluting the org-level "who's the main rep here" signal.

**The routing rule (single source of truth):**

Every client-facing email sender resolves recipients in this exact order:

```
0. email_routing override   ← per-bucket override (jobs.email_routing JSONB,
                              migration 107). Only consulted when sender
                              passes a templateId mapped to a bucket. See
                              "Email routing (per-bucket overrides)" below.
1. job_contacts            ← primary = `to`, rest = CC (REPLACES org-level when non-empty)
2. person_organisation_roles  via client_id OR any job_organisations link
3. organisations.email     (client org's own column, then any linked org)
4. people name-match       (jobs.client_name → people.first_name + last_name)
5. info@oooshtours.co.uk   (safety net, banner injected)
```

When `job_contacts` has rows for a job, they ARE the recipient list. The org-level lookup is NOT merged — that's the point of per-job selection ("Sarah's at this org but THIS hire is Tom"). Steps 2-4 only run when the job has zero `job_contacts` rows.

**Round 7 fix (Jun 2026) — emailless primary now routes to info@ rather than org spray.** Pre-round-7, `getJobEmailRecipients` filtered emailless contacts INSIDE the `job_contacts` query, so a primary with no email returned zero rows and was indistinguishable from "no contacts picked." Resolution silently fell through to step 2 and sprayed the whole org's roles list. Live incident: Riverjuke #16007 with Adam Williams (emailless) ticked as primary; the booking-confirmed email went to all four Tour Managers via step 2. **Fixed:** detect `job_contacts` rows FIRST regardless of email. If rows exist but none are reachable → skip steps 2-4 and land on step 5 (info@ fallback with banner). If reachable rows exist, use them (primary if reachable, else first reachable as `to` so a single emailless primary doesn't drop the email entirely). **The UI complement** is an emailless-primary guard on both `JobContactsCard` and the New Enquiry contact picker (emailless contacts still tick as CC, just can't be the star) + a default-primary auto-tick on `JobContactsCard` when the job has no `job_contacts` rows yet AND a clear default exists (org-level primary, or sole reachable candidate). Saves immediately, removes the "tick the only option" friction on single-contact orgs.

**Implementations:**
- `getJobEmailRecipients` (`services/money-emails.ts`) — used by `resolveClientEmailTarget`, drives payment/excess/cancellation/portal/vehicle/hire-form-auto emails
- `resolveHireFormContacts` (`services/hire-form-contacts.ts`) — used by the manual hire-form picker. **Differs from above:** stays additive (shows all reachable contacts as candidates) but lands `job_contacts` rows at the top tagged `job_contact_primary` / `job_contact`. Surfaces `person_id` on every source backed by a known person row.
- `has_client_email` banner check (`routes/hirehop.ts`) — mirrors the same priority order so the Job Detail amber warning matches send behaviour. Must stay in sync with `getJobEmailRecipients`.

**Don't write a parallel path.** Any new client-facing sender must route through one of the helpers above, or follow the same five-level fallback. The May 2026 round-3 RX22SWU sole-trader incident is the cautionary tale — multiple senders had drifted from `getJobEmailRecipients` and were silently failing on edge-case data shapes.

**Write paths (where `job_contacts` rows come from):**
1. **New Enquiry form** (`POST /api/pipeline/enquiry`) — `contact_person_ids[]` + `primary_contact_person_id` from the cascade picker
2. **Job Detail `<JobContactsCard>`** (round 6) — three endpoints under `/api/pipeline/:jobId/contacts`:
   - `GET` → `{ ticked, candidates }` (candidates = people from `client_id` + any `job_organisations` linked org, deduped by `person_id`, client wins tie)
   - `PUT` → idempotent replace `{ person_ids, primary_person_id }`. Transactional delete-all-insert-new.
   - `POST /add-person` → one-shot: link existing person OR create-and-link to client org + tick on job. Honours `set_as_primary` by clearing any current primary first (partial unique index would 23505 otherwise).
3. **Hire-form picker promote checkbox** (round 6) — when staff sends a hire-form email via `<RequirementCard>`, an opt-in checkbox "Also save these N contacts to the job" POSTs each promotable selected contact (one with a `person_id` not already in `job_contacts`) to `/add-person`. Fire-and-forget; doesn't block the send.

**HireHop push enrichment** (round 5):

`POST /:id/push-hirehop` + `POST /:id/sync-client-to-hh` (both in `routes/pipeline.ts`) look up the primary `job_contacts` row and use it for the HH `job_save_contact.php` payload:

| HH field | Value |
|---|---|
| `NAME` | Primary contact's full name (fallback: org name) |
| `COMPANY` | Org name (fallback: primary contact's name) |
| `EMAIL` | Primary contact's email if set, else org email |
| `TELEPHONE` | Primary contact's phone if set, else org phone |
| `CLIENT_ID` | `external_id_map` lookup — UPDATE in place, not duplicate |

Because we pass `CLIENT_ID`, HH updates the existing contact record in place — including its `NAME` field. That's the intended cleanup direction (evolves "ATC Live" → "Sarah Smith / ATC Live") and matches the SPEC's Stream C cleanup notes. New jobs for the same client will show the most recent push's NAME until their own push overwrites it.

**⚠️ Call ORDER: `save_job.php` FIRST, then `job_save_contact.php` (Jul 2026, "Save error. 154" fix).** `job_save_contact.php` is UPDATE-oriented — it needs an existing `CLIENT_ID` to save against. Calling it WITHOUT one (e.g. when the headline org is a freshly-created OP org with no `external_id_map` entry yet — the "change the headline client" case) makes HireHop reject with **"Save error. 154"**. So `sync-client-to-hh` (and `push-hirehop`) both run `save_job.php` FIRST — it creates/links the HH client from `company`/`name`/`email` and hands back the `client_id` (fall back to `job_data.php` to read it) — THEN enrich via `job_save_contact.php` with that `CLIENT_ID`. **Never reorder these.** Any future OP→HH contact-sync surface must follow the same order.

**`person_id` on `resolveHireFormContacts` results:**
- Present for: `job_contact`, `job_contact_primary`, `client_person`, role-derived linked-org sources, `client_name_match`
- Absent for: `client_org`, `linked_org`-style org-level rows, `manual_entry`

The picker promote checkbox keys off this — it only renders for selected contacts where `person_id` is set AND `source !== 'job_contact*'`.

**Watch list:**
- Staff report "I picked Tom but the email still went to Sarah" → check `job_contacts.is_primary` for the job. The partial unique index means only one row should have `is_primary=true`; if zero rows have it, routing falls through to step 2+. The amber "No primary contact picked" hint on `<JobContactsCard>` is the heads-up.
- Staff add a contact via the Job Detail UI but the banner doesn't clear → make sure the parent component is wired to refresh on the `onChanged` callback (re-runs `loadJob()` which re-fetches `has_client_email`).
- New email sender added but recipients are wrong → confirm it routes via `resolveClientEmailTarget` / `getJobEmailRecipients`. Don't write a fresh `SELECT email FROM organisations WHERE id = $client_id` — that bypasses the rule.
- Future `job_person_roles` work (SPEC §2.3 — Enquirer / Authoriser / Payer / Site Contact / Driver / Booker per-job roles) will extend or replace this. `job_contacts` was the round-1-to-6 stepping stone; the role-keyed routing model is captured in "Future Enhancements".

### Email routing (per-bucket overrides) ✅ SHIPPED Jun 2026

Layered on top of `job_contacts`. The base behaviour ("every client email goes to the primary `job_contact`") is right for ~95% of jobs. For the cases where a specific email category needs to go to a different person — typically invoices to an accountant, hire forms to a tour manager — `jobs.email_routing` (JSONB, migration 107) stores per-bucket recipient arrays that REPLACE the default primary for any template mapped to that bucket.

**Storage:** sparse JSONB on `jobs.email_routing`. Shape: `{ bucket_id: [person_uuid, ...] }`. Empty / absent bucket = "default to primary." Empty array also means default. The endpoint drops empty arrays server-side so the JSONB stays clean.

**Five buckets** (canonical list in `backend/services/email-routing.ts` — frontend mirror in `JobContactsCard`):

| Bucket id | Label | Covers |
|---|---|---|
| `bookings_payments` | Bookings & payments | `booking_confirmed_deposit`, `payment_received`, `last_minute_booking`, `job_cancelled_client` |
| `send_invoice` | Send invoice | **Reserved** — HH/Xero send invoices today, no template currently mapped. Picker shows the slot so a future OP-driven invoice template lands cleanly. |
| `hire_forms` | Hire forms & driver | `hire_form_request`, `hire_form_chase` |
| `carnet` | Carnet | `carnet_request`, `carnet_request_chase` |
| `excess` | Insurance excess | Every active lifecycle template (`excess_payment_confirmed`, `excess_preauth_confirmed`, `excess_preauth_released`, `excess_partial_received`, `excess_reimbursed`, `excess_partially_reimbursed`, `excess_claimed`, `excess_rolled_over_applied`) |
| `delivery_on_day` | Delivery / on-the-day | `delivery_note`, `collection_confirmation`, `vehicle_checked_in` |

**The full bucket→template map lives in `TEMPLATE_BUCKETS` (`backend/services/email-routing.ts`)** — when adding a new template, decide whether it belongs in a bucket and add it there. Internal/staff/freelancer templates (`referral_alert`, `mid_tour_driver`, `compliance_reminder`, `under_dispatched_warning`, `freelancer_assignment`, `file_resend`, `ooh_return_*`, `hire_form_fallback_alert`, etc.) are deliberately unbucketed — they have their own routing rules.

**Resolution at send time:** `resolveClientEmailTarget(jobId, templateId?)` (`services/money-emails.ts`). When `templateId` is supplied AND mapped to a bucket AND that bucket has UUIDs AND at least one UUID resolves to a person with an email, the override wins — first reachable becomes `to`, the rest are CC. Stale UUIDs (deleted people, emailless people) are silently skipped. If EVERY override UUID is unreachable, falls through to the default path rather than dropping the email (a stale override shouldn't drop comms).

**Callers (already wired):** `sendPaymentEmail`, `sendExcessEmail` (`services/money-emails.ts`), cancellation client email (`routes/cancellations.ts`), portal delivery-note fallback (`routes/portal.ts`), hire-form auto-email fallback (`services/hire-form-auto-email.ts`). Any NEW client-facing template should pass its `templateId` when calling `resolveClientEmailTarget` — otherwise overrides won't apply for that template.

**Known limitation:** the hire-form auto-emailer's primary path uses the broader `resolveHireFormContacts` picker, not `resolveClientEmailTarget`. So an override on the `hire_forms` bucket only takes effect via the info@-fallback branch (when the broad picker finds nothing). Tightening the broad picker to consult the override first is a follow-up.

**UI:** collapsed "Email routing" section on `<JobContactsCard>` with a one-line `All emails → [primary]` summary in the common case. Expanding shows 5 rows of multi-select chip pickers from the ticked contact list — multiple recipients per bucket supported. Hidden when no contacts are ticked. Persists via `PUT /api/pipeline/:jobId/email-routing` (idempotent replace, debounced 400ms). Unknown bucket keys are rejected at the endpoint so a typo doesn't silently land in JSONB.

**Endpoints** (under `/api/pipeline/:jobId`):
- `GET /email-routing` — returns `{ routing: { bucket_id: [...] } }` (sparse, only populated buckets)
- `PUT /email-routing` — body `{ routing: { ... } }`, idempotent replace

**Storage cleanup on contact removal:** when staff unticks a contact in `JobContactsCard`, the component drops their UUID from every routing bucket and persists. Without this the JSONB would accumulate stale UUIDs (backend silently skips them, but the UI state stays honest).

### Sanity-check scanners (deferred + de-duped warnings) ✅ SHIPPED Jun 2026

Pattern for safety-net warning emails that previously fired inline and spammed staff. Two live consumers (dispatch + return), both following the same shape — copy the shape if you add a third.

**The pattern:**
1. The action that USED to fire the inline warning (e.g. book-out PATCH calling `autoDispatchJob`) no longer sends an email. It just performs its core work.
2. A scheduled scanner runs every 15 min (`cron.schedule('*/15 * * * *', ...)` in `config/scheduler.ts`).
3. The scanner finds candidates that have been in the "concerning" state for longer than a grace window (long enough that the relevant background sync / desk-side action has had time to land).
4. For each candidate, **stamp the dedup marker FIRST**, then send the email. Stamp-first is deliberate — a transient send failure shouldn't cause the next 15-min sweep to re-fire. The cost is "one rare email that didn't actually send" vs "duplicate emails on every scan if a template/SMTP issue persists." The latter is the spam pattern we're trying to eliminate.
5. **Clear the marker on transition out of the "concerning" state**, so a re-entered state can warn afresh.

**Live consumers** (`services/sanity-check-scanner.ts`):

| Scanner | Trigger condition | Grace window | Marker (migration 107) |
|---|---|---|---|
| `runDispatchSanityScan` | `pipeline_status='dispatched'` AND `status<5` AND no marker yet | 30 min (one full polling-sync cycle, so cached HH `jobs.status` has refreshed) | `jobs.under_dispatch_warned_at` |
| `runReturnedBookedOutScan` | `pipeline_status='returned'` AND any `vehicle_hire_assignments` row still `booked_out`/`active` AND no marker yet | 20 min (desk-side check-in time after HH webhook fires Returned) | `jobs.returned_bookedout_warned_at` |

A third consumer, `runStuckOnHireScan` (migration 187), follows the same stamp-first pattern but keys off `fleet_vehicles.hire_status` rather than `jobs.pipeline_status`: it flags a van projected `On Hire` with no live `booked_out`/`active` assignment (the multi-van book-out scramble fingerprint) and alerts **jon@** (not info@). Its dedup marker (`fleet_vehicles.stuck_onhire_alerted_at`) is cleared inside `syncFleetHireStatus` when the van leaves On Hire, not via a pipeline_status transition writer. See the "Multi-van book-out scramble" entry above.

A fourth consumer, `runBookedSplitScan` (migration 189), catches the **OP↔HireHop "Booked" split-brain** (job 16513) — a job OP believes is past-confirmed (`pipeline_status IN BOOKED_SPLIT_STATUSES` = confirmed/prepping/prepped/dispatched/returned_incomplete/returned/completed) but HireHop never registered the Booked push for (`jobs.status < 2`), stuck for over 2h (`pipeline_status_changed_at` grace). Alerts **jon@** ONCE per stuck job, deduped via `jobs.booked_split_alerted_at` (stamp-first). **The `status < 2` guard is what stops a legit last-minute booking racing confirmed→prepping→dispatched from tripping it** — once the HH push lands and `status` climbs to ≥2, the job drops out. Unlike the pipeline_status-transition scanners, this one clears its own marker **in-scan** (a cleanup UPDATE at the top, the exact inverse of the candidate condition) rather than via a transition writer — so it self-releases on recovery (`status >= 2`) or terminal (lost/cancelled) without touching every status-write path. It's the loud backstop to the SILENT `services/booked-status-reconciler.ts` (30-min sync re-push), which heals these without telling anyone — the scanner only fires when that keeps failing (a persistent HireHop outage). See the "Stripe webhook idempotency + Booked split-brain" convention below.

**Marker clears** are wired into `routes/pipeline.ts` (`PATCH /:id/status`) and `routes/webhooks.ts` (HH inbound status changes) — both clear the matching pipeline_status marker when leaving the watched state.

**Why deferred + grace:** the original inline pattern fired the moment the trigger happened, but two real-world facts make that a false-positive generator: (a) the polling sync is every 30 min, so the cached `jobs.status` lags live HireHop by up to that long; (b) the writeback uses `no_webhook=1` (loop prevention), so the action that triggered the warning doesn't refresh the cached copy either. By the time the scanner sweeps after the grace window, both background sync and desk-side action have had time to land — when the warning fires, it's pointing at a real gap.

**Why stamp-first:** the original inline pattern ALSO fired once per (driver, van, job) triple on multi-driver hires — three drivers on one van = three `autoDispatchJob` calls = three warning emails for one logical dispatch. The marker reduces that to one regardless of how many calls the trigger generates. Multi-driver-per-van also drove the separate `vehicle-emails.ts` dedupe-by-vehicle change (see "Returned-bookedout dedupe by vehicle" below).

**Adding a third scanner:** copy the existing two — same shape, new marker column, new grace window. Wire the marker clear into every pipeline_status transition writer. Don't put the email send back inline at the trigger site, even "for the urgent case" — the spam pattern always comes back.

**Returned-bookedout dedupe by vehicle** (`services/vehicle-emails.ts`, `buildAndSendReturnedBookedOutAlert`): per the documented data model, multiple drivers sharing one van = multiple `vehicle_hire_assignments` rows with the SAME `vehicle_id`. The pre-refactor email counted those rows literally, producing "3 van(s) still booked out — RX73TCJ, RX73TCJ, RX73TCJ" for a single multi-driver hire. The replacement groups by `vehicle_id` in SQL and renders each van once, with `(N drivers)` suffix when N > 1. **Any future "count of vans" or "count of things on a job" rendering must dedupe by `vehicle_id` first**, not by row count. The data model puts one row per (driver, van, job).
