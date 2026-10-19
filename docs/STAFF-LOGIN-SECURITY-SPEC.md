# Staff login security — two-factor, trusted devices, passkeys, the kiosk till

**Status (19 Oct 2026): DRAFT for jon's approval. Nothing is built.** Written at the end
of the October security audit (`SECURITY-AUDIT-BRIEF.md`) — the audit closed every
code-level hole it found; what is left is the front door. A stolen or phished staff
password is now the most likely way into OP, and nothing in the code can stop a login
that arrives with the right password. This spec is the answer to that.

Read `SECURITY-AUDIT-BRIEF.md` A.1 and A.9 first: every token family already carries an
`aud` and goes through `services/tokens.ts`. Everything below adds families; nothing
widens one.

---

## 1. Settled decisions (jon, 19 Oct 2026)

1. **Every OP staff login gets a second factor.** Not optional per person.
2. **Passkeys are the primary method** — Face ID / Touch ID / Windows Hello standing in
   for both the password and the code. **Mandatory for admins** (today: jon's
   `admin@`). Nothing to phish: there is no secret to type.
3. **The fallback is a 6-digit code sent by email**, not SMS and not an authenticator
   app (jon's preference; SMS is the weakest factor and SIM-swap fraud is real; the
   email-code machinery already exists for the hire form — `driver_verification_codes`
   — and is copied, not shared).
4. **Trusted devices.** The second factor is asked for ONCE per device, then that laptop
   or phone is remembered for 90 days. Switching between a person's own laptop and
   phone costs nothing after the first time on each. This is what makes 2FA bearable;
   without it staff would be challenged daily and would revolt. (Google and GitHub
   work this way.)
5. **Per-account slowdown on wrong passwords**, independent of the per-IP limiter
   (a botnet brings thousands of addresses; the account is the constant).
6. **Shared logins are gone.** Front Desk and the demo freelancer are deactivated. The
   `system@` service identity (migration 031, the all-zeros user id that automated
   writes are recorded against) stays as a row and is made unable to log in.
7. **The warehouse iPad keeps its PIN** — the PIN logs in the DEVICE — and gains a
   till. Each sale names the PERSON from a dropdown of who is in today. The PIN
   exchange is accepted only from the yard's own internet connections.
8. **No refunds, reversals or money overview from the kiosk.** Those need a real login.

Deliberately NOT built: SMS codes, authenticator apps (could be added later as a third
fallback), single sign-on with Google, hardware keys as a separate method (a YubiKey
IS a passkey and works under §4 unchanged).

---

## 2. What a member of staff experiences

| Moment | What happens |
|---|---|
| First login on a new laptop or phone | Password → "Check your email" → 6-digit code (or, once enrolled, a passkey prompt instead of both) → in. The device is now trusted for 90 days. |
| Every login after that on that device | Password → in. With a passkey: face → in. No code. |
| 90 days later | One more code (or face) on that device. |
| A browser they have never used, a colleague's laptop, a hotel PC | Code every time; the device is not trusted unless they tick "trust this device". |
| Lost phone | They log in on the laptop (still trusted), go to My profile › Security, and remove the phone. Or an admin does it from the Staff page › Access tab. |
| Locked out entirely (new phone, laptop at work) | Recovery code (ten printed at enrolment), or an admin resets their second factor from the Staff page; the next login re-enrols. |
| Wrong password five times | 15-minute wait, doubling each time; the person and the admins get a bell on the tenth. |
| "Sign out everywhere" | Clears every refresh token and every trusted device for that person. Also what an admin presses when someone leaves. |

Admins: the same, except enrolling a passkey is required before the first 2FA login
completes, and the email fallback is disabled for them (an admin's mailbox is a
password-reset channel; a code there would make email both factors).

---

## 3. Design

### 3.1 Login becomes two steps

`POST /auth/login` keeps its shape. When the password is right it answers one of:

- `{ accessToken, refreshToken, user }` — as today — if the request carried a valid
  **trusted-device cookie** for this user, or the user has no second factor yet AND the
  grace period (§6) has not ended.
- `{ pending: <token>, methods: ['passkey', 'email'], emailHint: 'j***@oooshtours.co.uk' }`
  — otherwise. `pending` is a 5-minute JWT, audience `login_pending`, carrying only the
  user id. It is useless for anything but the next step.

Second step, one of:

- `POST /auth/login/code` `{ pending, code }` — email code.
- `POST /auth/login/passkey` `{ pending, assertion }` — WebAuthn assertion.
- `POST /auth/login/recovery` `{ pending, recoveryCode }`.

Each answers `{ accessToken, refreshToken, user }` and, when the client asked to
`trustDevice`, sets the trusted-device cookie.

`POST /auth/login/send-code` `{ pending }` sends (or re-sends, limited) the email.

**Passkey as the whole login** (no password): `POST /auth/login/passkey` without a
`pending` — a discoverable credential names the user. This is what admins use daily.

### 3.2 Trusted devices

- Table `user_trusted_devices (id, user_id, label, created_at, last_used_at, revoked_at, ua_family)`.
- Cookie `op_device`: a JWT, audience `trusted_device`, `{ userId, deviceId }`, 90 days,
  **httpOnly, Secure, SameSite=Lax, Path=/api/auth** — the SPA's JavaScript never sees
  it (the login sits in `localStorage` today; the device proof must NOT be there, or an
  XSS that steals the login also steals the device). The row is the revocation: a
  revoked or missing row refuses the cookie whatever its signature says.
- Trust is per person per browser profile. Two people sharing a laptop each trust it
  separately.
- Removing a device = `revoked_at`. "Sign out everywhere" = revoke all + null the
  refresh token.

### 3.3 Email codes

Table `staff_login_codes (id, user_id, code_hash, expires_at, attempts, consumed_at, created_at)`,
the `driver_verification_codes` shape copied: 6 digits, 10-minute life, 5 attempts then
dead, one live code per user (a new send voids the old), hashed at rest. Sent through
`emailService` with a new template `staff_login_code` — job-less, so no job number.
Limits: 3 sends per user per 15 minutes; the existing per-IP login limiter still applies.

### 3.4 Passkeys (WebAuthn)

- Library: `@simplewebauthn/server` (backend) and `@simplewebauthn/browser` (frontend).
  Relying-party id `staff.oooshtours.co.uk`; origin the same with `https://`.
- Table `user_passkeys (id, user_id, credential_id, public_key, counter, transports,
  label, backed_up, created_at, last_used_at)`. A person may hold several (phone,
  laptop, a YubiKey). Apple/Google sync one passkey across a person's own devices, so
  one enrolment usually covers both.
- Enrolment from My profile › Security ("Add a passkey") and forced on first login for
  admins. Registration options and assertions carry a server challenge held in Redis
  for 5 minutes (key `webauthn:<userId>:<nonce>`).
- A passkey login satisfies both factors and ALSO trusts the device when asked.

### 3.5 Recovery codes

Ten per person, generated at first enrolment, shown once, stored hashed in
`user_recovery_codes`. Each single-use. Regenerable from My profile (invalidates the
rest). An admin reset (§3.7) wipes them.

### 3.6 Per-account slowdown

Table `staff_login_failures (user_id, failed_at)` or a Redis counter — Redis: key
`login_fail:<userId>`, incremented on a wrong password, TTL 1 hour. At 5 failures the
account waits 15 minutes; each further block doubles (30, 60, capped at 4 hours). A
correct password + second factor clears it. At 10 failures in an hour: a bell to the
person and to admins ("Someone is trying your password"). The response for a blocked
account is the same 401 as a wrong password (no account enumeration), but the UI is
told `retryAfter` so it can say "try again in 14 minutes" to the real owner.

### 3.7 Admin controls — Staff page › Access tab

Per person: enrolled methods (passkeys with labels, email fallback on/off), trusted
devices (label, last used, Remove), **Reset second factor** (wipes passkeys, recovery
codes, trusted devices; next login re-enrols — manager-tier action, bell to the person),
**Sign out everywhere**. Every one of these writes `audit_log`.

### 3.8 The `system@` identity

`users.login_disabled BOOLEAN DEFAULT false`, set true for the all-zeros user by the
migration. `/auth/login` and `/auth/refresh` refuse it the way they refuse
`role = 'freelancer'`. Nothing else changes: it stays `is_active` so `created_by`
joins and the staff pickers that already exclude it by role keep working.

### 3.9 Tokens

New audiences in `services/tokens.ts`: `login_pending` (5 min), `trusted_device`
(90 days). The staff access and refresh tokens are unchanged (15 min / 7 days). A
session that has passed 2FA is not marked in the access token — the second factor is
proven at login, not per request.

---

## 4. The kiosk till

### 4.1 One PIN, two scopes

The warehouse PIN exchange (`POST /warehouse/auth/pin`) mints the existing
`warehouse_session` (audience `warehouse`). It gains a `scopes` claim:
`['collections', 'till']`. The till is the same iPad, the same PIN, the same 12-hour
session — a second tab, not a second login.

### 4.2 What the till session may call — an allow-list, like `FREELANCER_PREP_ALLOW`

| Allowed | Refused (needs a staff login) |
|---|---|
| `GET /shop/stock/search`, `/stock/barcode/:code`, `/stock/:id`, `POST /stock/availability` | `/shop/sales/:id/cancel`, `/reverse`, `/refund-settled`, `/retry` |
| `GET /shop/jobs/today`, `GET /shop/jobs/search` (today's bookings only) | `/shop/period*`, `/week*`, `/consumption`, `/drain`, `/sales/review` |
| `POST /shop/quote`, `POST /shop/sales` (cash or card reader) | `GET /shop/sales` list (the till shows its own last five only) |
| `POST /shop/sales/:id/receipt`, `GET …/receipt/suggestions`, `/jobs/:jobId/receipt-contacts` | everything outside `/shop` and `/warehouse` |
| The card-reader start / poll calls, when `system_settings.stripe_terminal_kiosk = 'true'` | refunds to the card |

The shop router today is `authenticate` + `STAFF_ROLES`. The till endpoints above get
`authenticateShopFlexible` (staff token OR warehouse session with the `till` scope),
the same pattern as `authenticateVehicleFlexible`.

### 4.3 Who made the sale

A kiosk sale MUST carry `sold_by_person_id`, chosen on the till from the people in
today (`services/shop-routing.ts` already answers "who's in"). `shop_sales` gains
`sold_by_person_id` and `source = 'kiosk'` (staff-login sales keep `created_by`, and
`sold_by_person_id` defaults to the same person). The receipt, the weekly reconcile and
the Shop tab show the name. The dropdown remembers the last choice for 30 minutes so a
run of sales by one person is one tap each.

### 4.4 Where the PIN works

`system_settings.kiosk_allowed_ips` — a list of public addresses. The PIN exchange
refuses any other source (the per-IP limiter still applies). Empty list = anywhere,
and the Settings page shows a warning when it is empty. The yard's two connections go
in; if either turns out not to be fixed, that connection is left out and the iPad uses
the other. Editable without a deploy.

### 4.5 Housekeeping

Quarterly bell to admins: "Rotate the warehouse PIN" (`system_settings.kiosk_pin_rotated_at`).
The iPad itself: device passcode, auto-lock, Guided Access to the OP kiosk page.

---

## 5. Phases

| Phase | What | Why this order |
|---|---|---|
| **1** | Email codes, trusted devices, per-account slowdown, `login_disabled`, My profile › Security, Staff page › Access controls. Grace period (§6) on. | Secures every login within days on machinery that already exists. |
| **2** | Passkeys: enrolment, passkey login, admin-mandatory. Grace period ends. | The real answer; needs the library and the UI, so second. |
| **3** | Kiosk till: scopes, allow-list, `sold_by`, IP list, Settings. | Independent of 1–2 except for the token work; last so the front door closes first. |

Each phase is one PR, built and exercised on the scratch database as the audit was
(every refusal path over HTTP, not just the happy path).

## 6. Rollout

- Phase 1 ships with a **14-day grace period** (`system_settings.staff_2fa_enforced_from`):
  until that date a person with no second factor logs in as today and sees a banner
  "Set up your login security before <date>". After it, the login forces enrolment.
- Admins are forced from the first login after Phase 2 deploys.
- Nobody is logged out by any phase: existing sessions and refresh tokens stay valid.

## 7. Open questions for jon

1. **Is the staff email itself protected by 2FA?** The Google Workspace accounts.
   If yes, an email code is a sound second factor. If no, the mailbox is the weak
   link for every non-admin and Phase 2 should make passkeys mandatory for managers too.
2. **90 days** for a trusted device — right? (30 is the cautious choice; 90 is what
   the big providers use.)
3. **Are both office connections on fixed public addresses?** `zgrep` on the nginx log
   shows which addresses the iPad and the office have used (command in the chat).
4. **May the kiosk take card-reader payments** without a named staff login behind
   it? (§4.2 says yes behind a setting; the person is still named on the sale.)
5. **Recovery codes**: printed and kept in the office safe, or each person's own?
