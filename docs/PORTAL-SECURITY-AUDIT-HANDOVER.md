# Handover — security audit of the client-facing apps (payment portal, hire form)

**For a new Claude session hooked up to the OTHER repos.** Written 19 Oct 2026 at the
close of the Operations Platform (OP) security audit, `docs/SECURITY-AUDIT-BRIEF.md` in
`jon-ooosh/Ooosh-Freelancer-Portal`. OP is done; the apps that talk to OP have not been
looked at. jon is not a coder; discuss and agree before coding; least change that works;
pushback over flattery.

## 1. The estate, as OP sees it

| App | Host | Where | Talks to OP as |
|---|---|---|---|
| Operations Platform (staff) | `staff.oooshtours.co.uk` | `Ooosh-Freelancer-Portal` → `backend/`, `frontend/` | — (it IS OP) |
| Freelancer portal (Next.js) | `freelancer.oooshtours.co.uk` | **same repo**, `src/` (Netlify) | a `session` cookie signed with `SESSION_SECRET` (jose on the Next side, `routes/portal.ts` `portalAuth` on OP's) |
| Payment portal (Netlify functions) | `payments.oooshtours.co.uk` | **`netlify-functions` repo** — `get-job-details-v2.js`, `handle-stripe-webhook.js`, `op-backend.js`, `vat-adjustment.js` | `x-api-key` rows in OP's `api_keys` table (`middleware/api-key.ts`, bcrypt full-key) on `/api/money/*` |
| Hire form (self-drive client sign-up) | `hireforms.oooshtours.co.uk` | the hire-form repo (Netlify) | `HIRE_FORM_API_KEY` (`x-api-key`, timing-safe) on `/api/driver-verification/*` and `/api/hire-forms/*`; the client's own browser holds a 40-minute `hire_form` JWT minted by OP's `auth/verify` against `HIRE_FORM_VERIFICATION_SECRET` |
| Freelancer book-out / check-in / prep | `staff.oooshtours.co.uk/vehicles/…` | OP frontend, reached from the freelancer portal | HMAC link tokens on `FREELANCER_HUB_SECRET`, exchanged at `/api/vehicles/freelancer-*/resolve` |

Audit each of the three Netlify apps the way OP was audited: list every public endpoint,
what proves identity on it, what rate limit it has, what it can reach in OP. OP's inventory
(brief §C) is the model.

## 2. What OP already fixed that those apps must respect

- **Every OP token family carries an `aud`** and `services/tokens.ts` is the only
  minter/verifier. The portal session is the ONE exception: the Next.js app mints the
  same `session` cookie with jose and `SESSION_SECRET`; OP's `portalAuth` refuses any
  token carrying `scope`/`type`/`typ`. `SESSION_SECRET` must differ from `JWT_SECRET`
  (OP refuses to start otherwise). If the Next.js app ever starts adding claims, agree
  the shape with OP first.
- **OP's `authenticate` accepts staff access tokens only.** A hire-form, portal, kiosk or
  freelancer token can no longer read staff routes. Nothing in the other apps should rely
  on that having worked.
- **Rate limits** are on every public OP endpoint except the API-key ones (the key is the
  gate). The portal's login/register/reset and the hire form's `auth/verify` are limited
  on OP's side; a limiter on the Netlify side too is belt and braces, not a duplicate.
- **Cross-repo Stripe idempotency lives in OP** (`stripe_events`): the payment portal's
  webhook claims the event at `POST /api/money/stripe-event/claim` BEFORE creating the
  HireHop deposit and records it at `/record-deposit`. Keep that order; it is what makes
  a Stripe re-delivery safe.
- **The payment portal has its own copy of the VAT rule** (`vat-adjustment.js` ↔ OP
  `services/vat-adjustment.ts`). Change both or neither.
- **CSP, HSTS, frame/sniff headers** are live on `staff.oooshtours.co.uk` (nginx). The
  three Netlify hosts have whatever `netlify.toml` / `_headers` give them — probably
  nothing. Check.

## 3. What to look for first (ranked)

1. **Secrets in the Netlify apps.** Where do `HIRE_FORM_API_KEY`, the `api_keys` row
   used by the payment portal, `SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET` and the HireHop
   API token live — Netlify env only, or anywhere in the repo, a build log, or client-side
   code? A key that reaches the browser bundle is public. The HireHop token must never
   be in client code.
2. **Stripe webhook signature.** `handle-stripe-webhook.js` must verify
   `stripe-signature` with the endpoint secret before anything else, and must still
   return non-2xx on OP failure (fail-fast + idempotent — see OP's
   `docs/reference/SHARED-UTILITIES.md` "Cross-repo Stripe-event idempotency").
3. **What a client can read.** `get-job-details-v2.js` takes a job number and a hash
   (`services/payment-portal-link.ts` in OP computes the hash from the HireHop job and
   its dates). Confirm the function refuses a job number without the right hash, and
   that the response is an allow-list of fields, not the HireHop job object.
4. **The hire form's session.** A 40-minute `hire_form` JWT names only an email. Confirm
   every hire-form read/write on the Netlify side is scoped to that email's own driver
   record, and that `send-code` / `verify-code` go through OP (which limits them) rather
   than a local copy.
5. **The freelancer portal's `src/middleware.ts`.** It verifies the cookie with jose; check
   the `matcher` covers every authenticated route and that the cookie is `httpOnly`,
   `Secure`, `SameSite=Lax`. Check `register/*` and `forgot-password` cannot enumerate
   emails (same response whether or not the address exists).
6. **Headers on the three Netlify hosts**: CSP (even report-only to start), HSTS,
   `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors. OP's policy is in
   `deploy/nginx-ooosh-portal.conf` as the model.
7. **Dependencies**: `npm audit` in each repo (never `--force`); Dependabot is on for OP
   with auto-merge for minor/patch (`.github/dependabot.yml` + the workflow) — copy the
   setup if the other repos lack it.
8. **Tokens in URLs** (freelancer hub links, hire-form links): accepted in OP (short-lived,
   single purpose, `Referrer-Policy` set). Check the Netlify side does not log full URLs
   anywhere it keeps.

## 4. Method that worked on OP

Read first, then a written brief with Section A (verify) / Section B (fix, ranked), agree
it with jon, then fix in small PRs with every refusal path exercised over HTTP, not just
the happy path (a scratch Postgres + the server on a spare port; for Netlify functions,
`netlify dev` or direct invocation). jon deploys by hand; give him the commands. Nothing
is "done" until it is merged, deployed and seen working on the live host.

## 5. Decisions already made (do not reopen)

- No SMS, no authenticator apps, no SSO (STAFF-LOGIN-SECURITY-SPEC §1).
- The portal session stays on its own secret, not OP's token families.
- `xlsx` and `uuid` advisories in OP's backend are deliberately left.
- The warehouse kiosk keeps its PIN (now IP-restricted); the yard's second connection is
  NOT in the list until the ISP confirms it is fixed.
