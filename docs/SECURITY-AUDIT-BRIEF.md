# Security audit brief — known open goals (Oct 2026)

Hand-over for a full security audit of the Ooosh Operations Platform. Written at
the end of the freelancer-tasks work (STAFF-CALENDAR-SPEC §21), which turned up
the items below. **Section A is fixed — verify, don't redo. Section B is known
and open — start there.** Background on RBAC: `docs/reference/PLATFORM-CONVENTIONS.md`
"Reference-route RBAC" and "Token types".

The shape of the problem, in one line: **one secret (`JWT_SECRET`) signs every
kind of token this platform issues** — staff logins, staff refresh tokens, and
tokens handed to the public, to kiosks and to freelancers — and until Oct 2026
the general `authenticate` middleware checked the signature and nothing else.

## A. Fixed in Oct 2026 (verify)

1. **`authenticate` accepted any token signed with `JWT_SECRET`.** A member of
   the public who verified their email on the hire form holds a
   `{ email, type: 'hire_form_session' }` token; the claim form issues
   `{ typ: 'claim_driver' }`; the warehouse kiosk `{ scope: 'warehouse_session' }`;
   freelancers get `{ scope: 'freelancer_bookout' | 'freelancer_prep' }`; staff
   refresh tokens are `{ id, type: 'refresh' }` (7 days by default). **All of them passed
   `authenticate`** and reached every route that relies on it without
   `authorize()` (~230 handlers across ~20 routers by a rough count). Proven on a
   test database: a hire-form session read `GET /api/drivers` — driver names and
   contact details. **Fix:** `middleware/auth.ts` `authenticate` now requires
   `{ id, email, role }` and rejects any token carrying `scope`, `type` or `typ`.
   Every legitimate non-staff token already had its own middleware
   (`authenticateVehicleFlexible`, `authenticateWarehouse`, `authenticateHireForm`,
   the claim-form routes, `portalAuth`). *Audit:* confirm nothing legitimate broke,
   and whether production logs ever show those token shapes hitting staff routes.
2. **`portalAuth` accepted scoped tokens** — `PORTAL_SECRET` falls back to
   `JWT_SECRET` when `PORTAL_SESSION_SECRET` / `SESSION_SECRET` are unset. Now
   refuses any token with a `scope` or without an `id`.
3. **`returnUrl` / `startUrl` from the URL rendered as `<a href>`** on the
   freelancer book-out, collection and prep pages (and their error screens). A
   crafted link with `returnUrl=javascript:…` would have run script in OP's origin
   — where a staff login sits in localStorage — when a staff member clicked "Back
   to the portal". Fixed with `modules/vehicles/lib/safe-url.ts` `safeReturnUrl()`
   (http/https only) at every reader.

## B. Known and open (start here)

1. **One secret for every token family.** The `authenticate` shape check is a
   guard, not a design. Recommend per-purpose secrets, or `aud`/`iss` claims
   checked by each middleware, so a token minted for one audience can never be
   *verified* by another.
2. **`PORTAL_SECRET` falls back to `JWT_SECRET`.** If production has no
   `PORTAL_SESSION_SECRET`, a STAFF access token (`{ id, email, role }`) would pass
   `portalAuth` with a `users.id` where a `people.id` is expected. Check the
   production env; make a separate portal secret mandatory at startup.
3. **Freelancer-role OP logins reach `authenticate`-only routes.** `POST
   /api/auth/login` has no role gate, so a `users` row with `role = 'freelancer'`
   holds a real staff-shaped JWT — and passes the fixed `authenticate`. The
   routers listed in PLATFORM-CONVENTIONS "Still open" (`drivers.ts`, `quotes.ts`,
   `costs.ts`, `assignments.ts`, `files.ts`, `notifications.ts`, `dashboard.ts`,
   `ve103b.ts`, …) need a per-router decision. **Do not sweep blind:**
   `vehicles.ts` and `hire-forms.ts` are deliberately mixed-audience.
4. **`GET /api/files/download` serves every R2 prefix except `staff-records/` and
   `claims/` to any authenticated caller** — including freelancer-role users. Is
   anything sensitive filed under `files/`?
5. **Tokens in URLs.** Book-out / check-in HMAC tokens and the freelancer prep
   redeem token (15 min) travel in query strings (history, logs, Referer). The
   prep page strips its token after redeeming; check the others, and the
   `Referrer-Policy` on those pages.
6. **Rate limiting on public token endpoints** — the book-out / check-in / prep
   resolvers, the freelancer-day accept/decline page, the claim form, the
   hire-form email verification. Login and refresh are limited; these may not be.
7. **Socket.io accepts any token signed with `JWT_SECRET`** (`backend/src/index.ts`
   `io.use`) — the same signature-only check `authenticate` had — and a connected
   socket may `join-entity` any id. Apply the staff-shape check there too, and
   decide whether entity rooms need an access check.
8. **Public-route inventory.** Everything mounted before `authenticate` (search for
   "PUBLIC" / "mounted BEFORE" in `routes/`) — each should be a deliberate,
   minimal surface.

## C. Deliberately not done (decisions, not gaps)

- A freelancer's prep flags do NOT open Problems (Problems are reported by a staff
  user); they are belled to the fleet people for review (jon, Oct 2026).
- The freelancer prep session can reach exactly the calls the prep page makes,
  each held to one van (`FREELANCER_PREP_ALLOW` in `routes/vehicles.ts`) — tested
  over HTTP (30 checks) in the session that built it.
