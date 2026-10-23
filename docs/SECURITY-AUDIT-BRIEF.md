# Security audit brief — status (Oct 2026)

Hand-over for the security audit of the Ooosh Operations Platform. Written at the
end of the freelancer-tasks work (STAFF-CALENDAR-SPEC §21), updated 9 Oct 2026 after
the first audit pass. **Section A is fixed — verify, don't redo. Section B is open.
Section C is the public-route inventory. Section D is decisions, not gaps.**
Background on RBAC: `docs/reference/PLATFORM-CONVENTIONS.md` "Reference-route RBAC"
and "Token types".

The shape of the problem, in one line: **one secret (`JWT_SECRET`) signs every
kind of token this platform issues** — staff logins, staff refresh tokens, and
tokens handed to the public, to kiosks and to freelancers — and until Oct 2026
the general `authenticate` middleware checked the signature and nothing else.

## A. Fixed in Oct 2026 (verify, don't redo)

1. **`authenticate` accepted any token signed with `JWT_SECRET`.** A member of
   the public who verified their email on the hire form holds a
   `{ email, type: 'hire_form_session' }` token; the claim form issues
   `{ typ: 'claim_driver' }`; the warehouse kiosk `{ scope: 'warehouse_session' }`;
   freelancers get `{ scope: 'freelancer_bookout' | 'freelancer_prep' }`; staff
   refresh tokens are `{ id, type: 'refresh' }`. **All of them passed `authenticate`**
   and reached every route that relies on it without `authorize()`. Proven on a
   test database: a hire-form session read `GET /api/drivers`. **Fix:**
   `middleware/auth.ts` `verifyStaffToken()` requires `{ id, email, role }` and
   rejects any token carrying `scope`, `type` or `typ`; `authenticate` and the
   Socket.io handshake both call it. Every legitimate non-staff token has its own
   middleware (`authenticateVehicleFlexible`, `authenticateWarehouse`,
   `authenticateHireForm`, the claim-form routes, `portalAuth`).
2. **`POST /api/auth/register` was public and let the caller pick `role: 'admin'`.**
   Found 9 Oct 2026, outside the original brief. No `authenticate`, no `authorize`,
   no rate limit; the comment said "admin only in production" and nothing enforced
   it. Anyone on the internet could have created an admin login and received a
   refresh token. **Fix:** `authenticate` + `authorize(...MANAGER_ROLES)`, and only
   an admin may create an admin. **Checked in production the same day:** every
   `users` row is a known person, and `zgrep "POST /api/auth/register"` over the
   retained nginx logs found no request at all. If that ever changes, rotate
   `JWT_SECRET` and reset passwords.
3. **Freelancer-role OP logins.** The `freelancer` role is gone from the register
   schema and refused at `/auth/login` and `/auth/refresh`. The only such row in
   production was the inactive demo seed `tom@example.com`. Freelancers authenticate
   against `people.portal_password_hash` via `routes/portal.ts`, never `users`.
   This closes the "freelancer holds a staff-shaped JWT" path without touching the
   ~18 `authenticate`-only routers (see B.2 for what is still worth doing there).
4. **`portalAuth` fell back to `JWT_SECRET`** when neither `PORTAL_SESSION_SECRET`
   nor `SESSION_SECRET` was set. The server now refuses to start without one, and
   refuses one equal to `JWT_SECRET`. Production already had `SESSION_SECRET` (the
   Netlify portal app verifies the same cookie with it — `src/middleware.ts`). The
   `scope` / `id` shape check in `portalAuth` stays as a second line.
5. **Socket.io** (`backend/src/index.ts` `io.use`) verified the signature alone.
   It now uses `verifyStaffToken()`. The `join-entity` / `leave-entity` handlers
   let any socket join any room by id; nothing ever emitted to an `entity:` room
   and no client sent the event, so they were removed. The only room is
   `user:<id>`, joined server-side from the token.
6. **`GET /api/files/download`** is gated to `STAFF_ROLES` (it was any
   authenticated caller). The prefix allow-list is unchanged: `staff-records/`
   and `claims/` stay role-gated inside the handler; `hire-forms/` and
   `driver-snapshots/` are refused outright.
7. **Rate limits** added to every public endpoint that lacked one: the three
   `/vehicles/freelancer-*/resolve` token redeemers, `/driver-verification/auth/verify`,
   `/warehouse/auth/pin` (a static PIN with no attempt limit — brute-forceable),
   and the portal's `/auth/login`, `register/start|verify|complete`,
   `forgot-password`, `reset-password`. Limits are per IP (`trust proxy` is set,
   one nginx hop) and sized for a yard or venue where several freelancers share
   one public IP.
8. **`returnUrl` / `startUrl` from the URL rendered as `<a href>`** on the
   freelancer book-out, collection and prep pages. `javascript:` would have run in
   OP's origin. Fixed with `modules/vehicles/lib/safe-url.ts` `safeReturnUrl()`.
9. **Every token family carries an `aud` its verifier checks** (the design fix
   behind A.1). Decision (jon, 9 Oct 2026): keep the one secret and add an `aud`
   per family rather than per-purpose secrets — they would all live in the same
   `.env` on the same server, so a leak of one is a leak of all, and
   `jsonwebtoken` enforces `audience` natively. **All minting and verifying goes
   through `services/tokens.ts` `signFor()` / `verifyFor()`**; the only other
   `jsonwebtoken` importer is `routes/portal.ts`. Families: `staff`,
   `staff_refresh`, `hire_form`, `claim_driver`, `warehouse`,
   `freelancer_bookout`, `freelancer_prep`, `freelancer_prep_redeem`. The two
   scripts that mint their own staff token (`stripe-preauth-reconciler.ts`,
   `job-financials-backfill.ts`) go through it too. **The portal session is
   deliberately outside the scheme**: its own secret is its isolation, and the
   Netlify app mints the same cookie with `jose` — an `aud` check in OP would
   reject those until both sides deploy together. **Cost on deploy:** every
   existing OP-signed token stops verifying — staff log in once, anyone mid-way
   through the hire form or claim form re-verifies, a kiosk re-enters its PIN,
   a freelancer mid-book-out re-opens their link. Portal cookies are unaffected.
10. **`backups/` was on the `/files/download` allow-list**, so any staff login
    could fetch a database dump by its date-based name. Removed; backups keep
    their own admin-only route.
11. **Production dependency advisories.** A semver-safe `npm audit fix` cleared
    every high/critical advisory in the backend's production tree except the
    known `xlsx` one (no fix exists; trusted admin uploads only).
12. **The freelancer portal (21 Oct 2026, `docs/FREELANCER-PORTAL-SPEC.md` §6).**
    - Login needed no approval, and a session kept working for its full 30 days
      after a freelancer was removed. `portalAuth` now re-reads the person on
      every request (`is_freelancer`, `is_approved`, not deleted) and answers 401
      `account_inactive`; the portal clears its cookie on any 401 from OP
      (`src/lib/op-api.ts`), so the pages' "401 → /login" can't loop against the
      middleware's "valid cookie → /dashboard". A database error there is a 503,
      never a 401 (a 401 signs the freelancer out).
    - An account with no portal password fell back to the person's OP STAFF
      password, i.e. an OP password opened the portal without OP's second
      factor. Removed.
    - Wrong passwords now slow the ACCOUNT, not just the IP (every freelancer is
      a Netlify address): `staff-login-security.ts` `portalSecondsBlocked()` etc.,
      the staff thresholds, Redis, fail-open.
    - A password reset signs out every other session
      (`people.portal_sessions_valid_after`, migration 302; a minute's grace for
      the Netlify clock). The reset's "transaction" was BEGIN/COMMIT through the
      shared pool, i.e. none; it is on one client now. Three other places still do
      that (`cost-lines.ts`, `routes/pipeline.ts` ×2) — open. (`routes/costs.ts`'s
      split save moved to one client with per-job recharges, Oct 2026.)
    - The registration code came from `Math.random()`; now `crypto.randomInt`.
    - `src/app/api/hirehop/items/[jobId]` (the portal's kit list, read with its
      own HireHop token) served any job to any login, and a Monday-era secret
      header skipped the login. It now needs `?job=<quote>`, and OP's
      `GET /portal/jobs/:quoteId/hirehop-ref` must say that job is theirs and has
      that HireHop number.
    - `GET /portal/venues/:id` (unscoped, unused) is gone; portal job responses no
      longer carry the run's CLIENT price (`runCombinedClientFee`).
    - The van screens: `/vehicles/send-email` (any HTML to any address, "checked"
      by the reg being in the subject) is off the freelancer allow-list — nothing
      freelancer-side calls it; and the book-out / collection link resolver
      refuses a login that is no longer an approved freelancer (the links last
      24 hours).

A.1–A.7 were exercised over HTTP against a migrated + seeded scratch database
on 9 Oct 2026 (22 checks plus the limiter counts); A.9 with 18 unit checks on
the freelancer and claim middleware and 20 HTTP checks across staff, refresh,
kiosk, hire-form and socket paths, including that a pre-`aud` token is refused
everywhere. Both portal-secret guards were seen to refuse startup.
A.12 was exercised over HTTP against a fully migrated scratch database and Redis
(37 checks on the real portal and vehicles routers), then through the portal app
itself, including a browser check that a removed freelancer lands on the login
page without a redirect loop.

## B. Open

1. **Content-Security-Policy — enforced 19 Oct 2026** after a week report-only.
   The week's reports (two staff IPs) found exactly two things: `heic2any`
   compiling WebAssembly when an iPhone HEIC photo is chosen (now
   `'wasm-unsafe-eval'` in `script-src` — wasm only, never JS eval) and three
   migrated Jotform reference photos on the studio-sitter lock-up template
   (`www.jotform.com` allowed in `img-src` until they are re-uploaded to R2, then
   drop it). Maps, blob PDFs, Socket.io and the framed staging calculator reported
   nothing. `stage-view.html`'s viewer script moved to `stage-view.js` so no
   inline exception is needed. Enforcement itself still reports to
   `/api/csp-report`, so a regression shows in the log. History follows.
   **Report-only phase (12–19 Oct).** Nginx sends the usual
   headers (nosniff, frame DENY, HSTS, Referrer-Policy, Permissions-Policy) but
   no CSP, and the staff login sits in `localStorage`, so an XSS anywhere in the
   app is a token theft. **Built (Oct 2026):** the policy as a
   `Content-Security-Policy-Report-Only` header in
   `deploy/nginx-ooosh-portal.conf` (the live config is applied by hand), and
   `POST /api/csp-report` (public, rate-limited, log only) so every staff
   browser's would-have-been-blocked loads land in `journalctl -u ooosh-portal
   | grep csp-report`. **Next:** apply the header AFTER the route is deployed,
   watch the log for a week, add anything legitimate, then rename the header to
   `Content-Security-Policy`. **Known blocker before enforcing:**
   `frontend/public/stage-view.html` has one inline `<script>`; move it to a
   file or hash it first. The two static tools are the only pages loading from
   cdnjs and Google Fonts.
2. **Per-router `authorize()` pass — DONE 19 Oct 2026.** All 19 `authenticate`-only
   routers carry `router.use(authorize(...STAFF_ROLES))` (a no-op today, but it keeps
   them closed if a non-staff login shape is ever added). The six ungated writes the
   read found are manager-tier since 19 Oct (jon: yes to all six):
   - `quotes.ts` `PUT /settings` and `DELETE /runs/:runId` — `authorize(...MANAGER_ROLES)`.
   - `quotes.ts` `PATCH /:id/status` and `/:id/ops-status` — a non-manager asking for
     `completed` gets 403 pointing at the manager's `POST /:id/complete-override`
     (`isManagerTier()` in `middleware/auth.ts`, the same rule as `authorize()`).
   - `ve103b.ts` `POST /:id/void`, `POST /:id/reactivate`, `POST /test-generate` —
     `authorize(...MANAGER_ROLES)`.
   - `duplicates.ts` `POST /merge` — `authorize(...MANAGER_ROLES)`.
   - `files.ts` `DELETE /delete` — the narrow gate: manager-tier only when
     `entity_type = 'drivers'`; every other file stays everyday desk work.
   Everything else ungated is reads or everyday desk work; every route that moves
   money in `costs.ts` is already admin-only. `vehicles.ts` and `hire-forms.ts` were
   left alone on purpose (mixed audience).
4. **The payment portal's API key is scoped — 20 Oct 2026** (portal audit B.6,
   `netlify-functions` `docs/SECURITY-AUDIT-BRIEF.md`). `authenticateFlexible` in
   `routes/money.ts` gave any valid `api_keys` row `role: 'service'`, and every money route
   without an `authorize()` accepted it — `refund-payment` (Stripe refund + HireHop + Xero),
   `record-payment`, `summary`, `payments`, `payment-link`, `sync-values`. A leaked Netlify
   env was money out. Now `api_keys.permissions` is honoured (`middleware/api-key.ts`
   `apiKeyMayCall()`): a row naming `money:job-lookup`, `money:excess-info`,
   `money:stripe-event`, `money:payment-event` reaches exactly those; `money:*` or an EMPTY
   row (the column default, every key today) stays unrestricted so nothing changes until the
   portal's row is set — do that once the code is live:
   `UPDATE api_keys SET permissions = '["money:job-lookup","money:excess-info","money:stripe-event","money:payment-event"]' WHERE service = 'payment_portal';`
   (check `SELECT name, service, key_prefix, permissions FROM api_keys WHERE is_active` first
   — the portal's row is the one whose prefix matches Netlify's `OP_API_KEY`). The
   `webhooks.ts` `external/status-transition` key check is untouched.

3. **Tokens in URLs.** Reviewed and left as is. The book-out / check-in pages
   strip `freelancerToken` / `hubToken` with `replaceState` straight after
   redeeming (`modules/vehicles/hooks/useAuth.tsx`); the prep page strips its
   redeem token; nginx sets `Referrer-Policy: strict-origin-when-cross-origin`.
   The one remaining sink is the nginx access log, which records query strings.
   The HMAC tokens are single-purpose and expire, so this is accepted.

5. **Transactions run through the shared pool — open (found 21 Oct 2026, A.12).**
   `await query('BEGIN')` / `query('COMMIT')` sends each statement to whichever
   pooled connection is free, so it is no transaction at all, and a BEGIN can be
   left open on a connection that later requests then write through. The portal's
   password reset was one (fixed in A.12, now on `getClient()`), and so was the
   cost split save in `routes/costs.ts` (fixed with per-job recharges, migration
   318, Oct 2026; now `services/cost-allocations.ts` `writeAllocations()`). Three remain: `services/cost-lines.ts` and `routes/pipeline.ts` (two).
   Fix: `const client = await getClient()`, BEGIN/COMMIT/ROLLBACK on that client,
   `client.release()` in a `finally`. Its own PR, with a test per path.

## C. Public-route inventory (9 Oct 2026)

Everything reachable without a staff login. Each should stay a deliberate,
minimal surface; a new one needs its own auth AND a limiter.

| Router | Public endpoints | Proves identity by | Per-IP limit |
|---|---|---|---|
| `auth.ts` | `login`, `refresh`, `avatar/:filename` | password / refresh token / none (avatar image) | login 10, refresh 20 per 15 min; avatar none |
| `portal.ts` | `auth/login`, `register/start\|verify\|complete`, `forgot-password`, `verify-reset-token`, `reset-password` | portal password / emailed code / reset token | 20 per 15 min; email senders 10 per 15 min (A.7) |
| `warehouse.ts` | `auth/pin` | static kiosk PIN → 12h `warehouse_session` | 10 per 15 min (A.7) |
| `vehicles.ts` | `freelancer-bookout/resolve`, `freelancer-checkin/resolve`, `freelancer-prep/resolve` | HMAC token (`FREELANCER_HUB_SECRET`) / prep redeem JWT | 30 per 15 min (A.7) |
| `driver-verification.ts` | `auth/verify`; `send-code`, `verify-code`, `send-confirmation`, `validate-job`, `telemetry/*` | shared secret / API key (server-to-server from the hire-form Netlify app) | `auth/verify` 30 per min (A.7); API-key routes none |
| `hire-forms.ts` | `POST /`, `GET /:id`, `send-email`, `download`, `post-signature` | API key or staff JWT (`authenticateOrApiKey`) | none (API key) |
| `claim-form.ts` | 18 | claim link token + driver code | read 90, write 40, code 6 per min |
| `freelancers.ts` | 3 (`apply/:token…`) | invite token | yes |
| `freelancer-days.ts` | 2 (accept / decline) | token | 20 per min |
| `ooh-return.ts` | 14 (parking form) | token | yes + submit limiter |
| `mobile-upload.ts` | 2 | token | yes |
| `storage.ts` | 2 (T&Cs accept) | token | yes |
| `holding.ts` | 2 | token | 20 per min |
| `carnets.ts` | 2 | token | yes |
| `pcns.ts` | `public/receipt/:token` (GET, POST) | token | **none** — receipt upload by unguessable token; add one if it ever grows |
| `rack-plans.ts` | 1 (view token) | token | yes |
| `vehicle-sales.ts` | 1 (`/van/:token` data) | token | yes |
| `incident-claims.ts` | 1 (photo) | token | yes |
| `staging.ts` | `plan/:slug` | public read of a shared 3D plan | **none** — read-only |
| `staff-calendar-feed.ts` | 1 (iCal) | feed token | yes |
| `enquiry-intake.ts` | 2 | API key | yes |
| `webhooks.ts` | `hirehop` (GET/POST), `external/status-transition` | HireHop `export_key` / `x-api-key` | none (key-gated) |
| `health.ts` | 1 | none | none |
| `csp-report.ts` | `POST /` | none — the browser posts CSP violation reports on its own; body is logged, truncated, never stored | 60 per min |
| `index.ts` | `/jobs…` when an API key header is present | API key | none |

## D. Deliberately not done (decisions, not gaps)

- A freelancer's prep flags do NOT open Problems (Problems are reported by a staff
  user); they are belled to the fleet people for review (jon, Oct 2026).
- The freelancer prep session can reach exactly the calls the prep page makes,
  each held to one van (`FREELANCER_PREP_ALLOW` in `routes/vehicles.ts`) — tested
  over HTTP (30 checks) in the session that built it.
- Per-purpose secrets were considered and rejected in favour of `aud` claims (B.1).
