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

All of A.1–A.7 were exercised over HTTP against a migrated + seeded scratch
database on 9 Oct 2026 (22 checks plus the limiter counts); both portal-secret
guards were seen to refuse startup.

## B. Open

1. **One secret for every token family.** The shape checks are a guard, not a
   design. Decision (jon, 9 Oct 2026): add an `aud` claim per family and keep
   the one secret, rather than per-purpose secrets — they would all live in the
   same `.env` on the same server, so a leak of one is a leak of all, and
   `jsonwebtoken` enforces `audience` natively. Plan: one `services/tokens.ts`
   with `signFor(audience, payload, opts)` / `verifyFor(audience, token)`; move
   every mint and verify site through it. Mint sites: `routes/auth.ts` (access
   ×2, refresh), `routes/portal.ts` (×3), `routes/warehouse.ts`,
   `routes/driver-verification.ts`, `services/claim-links.ts`,
   `middleware/freelancer-bookout-auth.ts` (×3), and the two scripts that mint
   their own staff token — `services/stripe-preauth-reconciler.ts`,
   `services/job-financials-backfill.ts` (miss these and they 401 silently on
   their next run). Verify sites: `middleware/auth.ts`, `index.ts` (via
   `verifyStaffToken`), `routes/auth.ts` refresh, `routes/portal.ts`,
   `routes/warehouse.ts`, `routes/driver-verification.ts`,
   `services/claim-links.ts`, `middleware/freelancer-bookout-auth.ts` (×3).
   **Cost on the day:** every existing token stops verifying — staff log in once,
   freelancers' 30-day portal cookies expire once, anyone mid-way through the
   hire form re-verifies their email. The Netlify portal app verifies the cookie
   with `jose` and does not check `aud` unless asked, so it keeps working.
   Deploy at a quiet time (scheduled: a weekend).
2. **Per-router `authorize()` pass.** With A.3 in place only staff hold staff
   tokens, so this is now about tiering between staff roles, not about outsiders.
   The routers listed in PLATFORM-CONVENTIONS "Still open" each need a read:
   which endpoints should be manager-tier. **Do not sweep blind:** `vehicles.ts`
   and `hire-forms.ts` are deliberately mixed-audience; `notifications.ts` serves
   whoever is logged in.
3. **Tokens in URLs.** Reviewed and left as is. The book-out / check-in pages
   strip `freelancerToken` / `hubToken` with `replaceState` straight after
   redeeming (`modules/vehicles/hooks/useAuth.tsx`); the prep page strips its
   redeem token; nginx sets `Referrer-Policy: strict-origin-when-cross-origin`.
   The one remaining sink is the nginx access log, which records query strings.
   The HMAC tokens are single-purpose and expire, so this is accepted.

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
| `index.ts` | `/jobs…` when an API key header is present | API key | none |

## D. Deliberately not done (decisions, not gaps)

- A freelancer's prep flags do NOT open Problems (Problems are reported by a staff
  user); they are belled to the fleet people for review (jon, Oct 2026).
- The freelancer prep session can reach exactly the calls the prep page makes,
  each held to one van (`FREELANCER_PREP_ALLOW` in `routes/vehicles.ts`) — tested
  over HTTP (30 checks) in the session that built it.
- Per-purpose secrets were considered and rejected in favour of `aud` claims (B.1).
