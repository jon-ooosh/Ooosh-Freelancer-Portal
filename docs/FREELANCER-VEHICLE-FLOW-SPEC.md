# Freelancer Vehicle Flow — Collection / Soft Check-In + Multi-Leg Completion

**Status:** Spec for build (handoff to a fresh session). Written Jul 2026 after two live incidents.
**Owner context:** jon. **Repo:** this one (`backend/` = OP Express API, `frontend/` = OP React SPA/vehicle module, `src/` = Next.js freelancer portal on Netlify, `docs/` = specs).
**Related spec (read first):** `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md` — the soft-check-in *primitive* this builds on. Also `docs/FREELANCER-PORTAL-REPOINTING.md` and the "Stream 7 / Freelancer book-out Round 4" notes in `CLAUDE.md`.

> ✅ **Root cause of the Tobi hire-agreement misfire is CONFIRMED** (journal evidence in §D). The fix is settled: the vehicle `save-event` book-out must drive the per-driver hire-forms side, cascading across **all** drivers on the van. Read §D + §2 before writing code.
>
> 🚑 **Immediate operational note (not a code task):** on any already-affected job, staff can email each driver their agreement now via the **"Hire form ▾"** dropdown on each Drivers & Vehicles card (backend `POST /api/hire-forms/:id/generate-pdf?send_email=true`). HH 15669 had 3 drivers on RO23HLV (Michael booked-out, Matthew + Felix confirmed) all needing this.

---

## 1. Why this exists — two live incidents

### Incident A — Lewis (job 15669… no: HH **15933**, van collection at Gatwick, 2 Jul)
A freelancer (Lewis Hoadley-Gaulin, portal login `hoadleyguitartech@live.com`) was **collecting a van** (RX22SWO) from Gatwick. Trail (Netlify SSR logs):
```
/job/<quoteId>/start → /complete → POST /bookout-token (200) → window.location = staff.oooshtours.co.uk/vehicles/book-out?freelancerToken=…
```
He hit that redirect twice (06:29, 07:09), **never completed**, drove off with the van, and the client had to be chased. He also did **two full password resets** (06:28, 07:07) that morning — auth friction, not backend latency (all logins were sub-2s; OP was healthy: job 15933 items returned 6 rows in 214ms).

Root problems exposed:
1. **The portal `/start` wizard offers a vehicle *book-out* on a *collection*.** A collection is a check-in/return, not a book-out. There is **no freelancer check-in/collection flow anywhere in the portal** (`grep` for any `checkin`/`check-in` token or route returns nothing).
2. **The OP handoff is a dead-end on failure.** There was **no `freelancer-bookout/resolve` call at all** in the OP journal for that window — he bounced off the cross-domain handoff before it resolved and had nowhere to go. Even staff, cleaning up later, hit `GET /api/vehicles/get-collection?vehicleReg=RX22SWO&jobId=15933 → 404` twice.
3. **Freelancer↔assignment linkage is brittle** (see §5) — email mismatch and "collecting freelancer ≠ original hirer".

### Incident B — Tobi (HH **15669**, van book-out/hand-over to customer, 2 Jul ~19:19 UTC / 20:22 BST)
A freelancer (Tobi Blackman) handed a van (RO23HLV) to a self-drive customer (Michael Steven Feinberg, `mike@subversiveinc.com`). Tobi's experience: booked out fine, **vehicle condition report emailed to the client** ✅. But:
- **No hire agreement PDF was sent to the customer** ❌.
- **The portal nagged Tobi all night to "complete the book-out"** ❌.

DB evidence (`vehicle_hire_assignments` for HH 15669):
```
080a6d84 | booked_out | vehicle 788415d0 (RO23HLV) | driver 857796fd
         | booked_out_at 2026-07-02 19:19:02 UTC | booked_out_by NULL | hire_form_emailed_at NULL
```
The agreement-hook guard (`status=booked_out` AND `vehicle_id` set AND `hire_form_emailed_at IS NULL`) was **satisfied**, yet `hire_form_emailed_at` never stamped. `booked_out_by` is NULL and the condition report *did* send → the book-out came through the **`save-event` (condition-report) path** (which stamps `booked_out_at`, flips status, sends the walkaround, and does not set `booked_out_by` for a freelancer), while the **`PATCH /api/hire-forms/:id → booked_out` path — the only place `generateAndEmailHireFormPdf` (the hire *agreement*) is scheduled — never ran.** **CONFIRMED by journal — see §D.** The freelancer flow did the *vehicle* side but not the *hire-forms* side.

Quotes for HH 15669:
```
b3e3ae1d | collection | ops_status=todo      | reminder 0   (future end-of-hire collection, 13 Jul — NOT a bug)
74650403 | delivery   | ops_status=completed | reminder 3   completed_at 2026-07-03 10:05 (manual)
```
The **delivery** quote climbed the completion-chaser ladder to level 3 overnight and was only closed manually this morning → **the OP book-out did not close the portal quote.** This is the same cross-domain gap as Incident A's outbound leg, on the return leg.

**Also present:** rows `8baa5a89` / `7e4e5c1f` = other drivers with no van yet (multi-driver hire), and `d2276e63` = a leftover `soft` staff-allocation of the *same* van RO23HLV. So the dual-row / sibling pattern is live here — resolve + close logic must handle siblings. (NB: `soft` is an existing *assignment allocation status*; do **not** overload that word for "soft check-in" — see §6.)

---

## 2. The core design decision — leg-based completion

The `/start` wizard ("What are you delivering/collecting today?") already captures intent. Use it as the **declaration of which legs a job has**, then record each leg's completion **server-side as it happens**, and **auto-close the portal quote when the last selected leg completes — independent of browser navigation.**

| `/start` selection | Direction | Legs | Quote closes when… |
|---|---|---|---|
| Van only | delivery | van book-out | book-out event lands (NO portal return hop required) |
| Van only | collection | van soft-check-in | soft-check-in event lands (NO portal return hop) |
| Backline only | either | equipment | portal `/complete` submitted |
| Both | either | van + equipment | **both** legs recorded done (order-independent) |

**Consequences (these are the fixes):**
- Van-only never depends on the cross-domain return hop → **Tobi's nag disappears** (book-out closes the delivery quote directly).
- "Both" survives a failed return hop: each leg is stamped when it happens; the freelancer can do the second leg whenever, and the system closes when both are in. No silent "stuck at todo".
- Collections finally have a correct path (soft-check-in), closing **Lewis's** mis-route.

**Implementation shape:** a small per-quote completion tracker. Options (pick the simplest that fits existing schema — confirm during build):
- Add `van_leg_done_at` / `equipment_leg_done_at` (nullable timestamptz) + `legs_required` (e.g. `text[]` or two booleans seeded from the `/start` selection) on `quotes`, OR
- Derive van-leg-done from the linked `vehicle_hire_assignments` event and equipment-leg-done from the portal completion, and store only `legs_required`.
A shared helper `maybeCloseQuote(quoteId)` runs after **either** leg completes: if every required leg is done → set `ops_status='completed'`, `completed_at=NOW()`, stop the chaser, and run the existing last-mover auto-dispatch equivalent. Idempotent.

**Chaser gate:** the completion chaser (`services/completion-chaser.ts`) must treat a quote as done when its legs are done, not only when `ops_status='completed'` was set by the browser. Simplest: since `maybeCloseQuote` sets `ops_status='completed'` server-side the moment legs finish, the existing chaser query already stops nagging — just make sure **every** leg-completion path calls `maybeCloseQuote`.

---

## 3. Portal `/start` — route correctly by direction (fixes Lewis's mis-route)

File: `src/app/job/[id]/start/page.tsx`. Currently every "van" choice calls `bookout-token`. Change:
- Branch on `job.type`:
  - **delivery** → van option = **"Van book-out"** → `POST /api/jobs/[id]/bookout-token` (unchanged).
  - **collection** → van option = **"Van check-in / return"** → new `POST /api/jobs/[id]/checkin-token` (§4).
- **Never** call `bookout-token` on a collection.
- Persist the chosen legs so the completion tracker knows what's required (send the selection to a new `POST /api/jobs/[id]/legs` or fold it into the token mint; see §2). "Both" = van + equipment; "Van only" = van; "Backline only" = equipment.
- Relabel copy per direction ("book out" vs "check in / return").

---

## 4. New portal route + OP resolve — the check-in handoff (mirror of book-out)

**Portal:** `POST /api/jobs/[id]/checkin-token` — mirror `src/app/api/jobs/[id]/bookout-token/route.ts`.
- Mint HMAC token with a **`checkin` discriminator**: `{expiry}.op.checkin.{quoteId}.{email}.{sig}` (so the OP verifier routes it to the check-in resolver, not book-out).
- Redirect to `${OP_BACKEND_URL}/vehicles/check-in?freelancerToken=…&returnUrl=${portal}/job/{id}/complete`.
- Signed with `FREELANCER_HUB_SECRET` (shared with OP). Same env guards as bookout-token.

**OP:** `POST /api/vehicles/freelancer-checkin/resolve` — mirror `freelancer-bookout/resolve` (`backend/src/routes/vehicles.ts` + `middleware/freelancer-bookout-auth.ts`). Differences:
- Target the **currently-out** assignment for the job — a `booked_out`/`active` `vehicle_hire_assignments` row (the van on hire), not a pre-book-out allocation.
- Mint a **`freelancer_checkin`**-scoped session JWT (or reuse `freelancer_bookout` scope + a `mode:'checkin'` flag). Scope to the one assignment + reg. 4h TTL.
- Add the check-in endpoints to `FREELANCER_BOOKOUT_ALLOW` and clamp `/get-events` etc. to the session's reg (same tidy as Round 4).

---

## 5. Fix the freelancer↔assignment linkage (root of both strandings)

The resolve endpoints match too narrowly. Harden both `freelancer-bookout/resolve` and the new `freelancer-checkin/resolve`:
- **Match the freelancer by ANY of their known emails**, not just one. (Lewis logs in as `hoadleyguitartech@live.com`; the assignment/driver email differed.) Resolve via the `people`/`quote_assignments` graph: the freelancer is whoever is on the quote's crew, regardless of which email they logged in with.
- **A collecting freelancer is usually NOT the hirer.** Resolve check-in on "who is assigned to collect this on the quote", not "who is the driver on the hire".
- Handle **sibling rows** (dual-row pattern — see the `d2276e63` soft allocation of RO23HLV alongside the booked-out `080a6d84`): pick the right van/assignment deterministically (most-progressed status; the van actually out for a check-in).
- On **any resolve failure**, do NOT dead-end (see §7).

---

## 6. OP freelancer Check-In page (soft mode) — reuse the primitive

Reuse the existing `CheckInPage`/`CollectionPage` (frontend vehicle module) in a freelancer/soft variant, driven by the `freelancer_checkin` scope.
- **Steps:** confirm van + job → walkaround photos + **mileage + fuel** (the two must-haves) + condition notes → optional customer signature → submit.
- **On submit, fire the existing `save-event eventType='soft-check-in'` primitive** (already built for van-swap, see `docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md`): sets `fleet_vehicles.hire_status='Not Ready'` (sticky), logs mileage, generates the **`isInterim` "INTERIM VEHICLE ASSESSMENT" PDF**, emails it to client + info@ via the server-side `/send-condition-report` path.
- **Do NOT flip the assignment to `returned`.** That's the warehouse's final check-in (damage adjudication, HH → Returned(7), close-out). Stamp a **`soft_checked_in_at`** marker instead (migration if the column doesn't exist). Keeps the two-stage model from the swap primitive. (`soft` the *allocation status* is unrelated — don't conflate.)
- **After the soft-check-in event lands, call `maybeCloseQuote(quoteId)`** so the collection quote closes server-side (§2) regardless of whether the freelancer's browser returns to the portal.
- Inherit the **photo-memory rules** (sequential resize, revoke objectURLs — see the May/Jun 2026 book-out perf notes in `CLAUDE.md`) and the **server-side condition-report send** (no 10 MB base64 round-trip through the phone).

---

## 7. Shared robustness net (applies to book-out too)

1. **Dead-end fallback.** If `freelancer-checkin/resolve` OR `freelancer-bookout/resolve` fails, land on a friendly OP screen — "We couldn't link your van automatically. Capture the details anyway / call the office on …" — never an OP error page or blank. (This alone would have saved Lewis.)
2. **Server-closes-the-quote (§2).** The vehicle event closing the portal quote is the backbone. Every leg-completion path calls `maybeCloseQuote`.
3. **"Started but not completed" alert.** If a check-in/book-out token is minted and no vehicle event lands within N hours, flag to staff proactively (bell + info@) — so you learn before an 11am client chase. (Ties into the deferred "post-hook outbox" idea in `CLAUDE.md` Future Enhancements.)
4. **Bounded timeouts + clear copy** on the portal POSTs (`login`, `complete`, `bookout-token`, `checkin-token`) so a genuinely slow OP surfaces "try again" instead of an indefinite hang. `opFetch` in `src/lib/op-api.ts` retries GETs only; POSTs have no timeout — add an AbortController timeout with a friendly message.
5. **Auto-sign-in after password reset** (auth friction — Lewis reset twice). `reset-password` already returns a session; make sure it drops the freelancer straight into the dashboard, not back to a login screen they'll re-reset from. Consider magic-link/OTP for freelancers as a later, separate piece (they log in rarely; passwords are the wrong primitive).

---

## D. Fix the Tobi hire-agreement misfire — CONFIRMED root cause (do FIRST)

**Confirmed by journal** (HH 15669, 2 Jul, correct window 19:10–19:45 UTC):
```
19:10  freelancer-bookout/resolve → 200   (tobi@dictionarypudding.co.uk, assignment 080a6d84 / RO23HLV)
19:19  POST /api/vehicles/save-event → 200            ← the book-out (condition-report path)
19:19  fleet hire-status RO23HLV → On Hire
       (NO  PATCH /api/hire-forms/:id  anywhere in the window)
19:23  [hire-form-pdf] Logo loaded from R2            ← a hire-form PDF started ~4 min later, but never emailed / never stamped hire_form_emailed_at
```
**The freelancer book-out went through `POST /api/vehicles/save-event` only.** It flipped the van to `booked_out`, stamped `booked_out_at`, set fleet → On Hire, and emailed the condition report — but it **never ran the `PATCH /api/hire-forms/:id → booked_out` loop**, which is the *only* place `generateAndEmailHireFormPdf` (the per-driver hire *agreement*) is scheduled. Hence `hire_form_emailed_at` NULL and no agreement to any driver. (This is why `booked_out_by` is also NULL — the freelancer save-event path doesn't set it.)

**The fix (make the vehicle book-out drive the hire-forms side, server-side):**
Don't rely on the client to loop PATCHes. In the **`save-event` book-out branch (`backend/src/routes/vehicles.ts`)**, when the booked-out van has linked customer hire-form rows on the job, **cascade across ALL of them**:
- for each driver row sharing that (vehicle, job): flip to `booked_out`, stamp `booked_out_at`, and fire `generateAndEmailHireFormPdf` (each driver gets **their own** agreement — see the per-driver/per-van scope rules in `CLAUDE.md`).
- Idempotent: guard each send on `hire_form_emailed_at IS NULL`.
- This makes `save-event` the single source of truth for book-out and removes the dependence on the freelancer BookOutPage's client-side PATCH loop (which demonstrably didn't run here). The existing PATCH path stays as-is for staff/other callers and remains idempotent via the same guard.

**⚠️ Multi-driver design question for jon (resolve during build, don't assume):** HH 15669 had **3 drivers on one van** (Michael booked-out; Matthew + Felix still "Confirmed" with "Add to Hire" buttons). `CLAUDE.md` says book-out is per-van ("the van leaves with all its drivers at once, each emailed their own PDF"), which argues for **cascade-all-on-book-out**. But the UI's per-card "Add to Hire" implies drivers can be **added incrementally** after the van's out. Confirm the intended semantics:
- (a) **Cascade all** at van book-out (flip + email every driver on the van), or
- (b) **Lead driver books out**, additional drivers are added later via "Add to Hire" — in which case each "Add to Hire" must itself flip that driver + email their agreement.
Either way the **agreement email must fire for every driver** (that's the bug); the open question is only *when* the non-lead drivers flip. Build to whichever jon confirms; default to (a) if unspecified, since it matches the documented per-van model and is what failed here.

**Mid-tour notifications are NOT part of this bug.** All three 15669 forms were submitted *before* book-out, so no mid-tour notification is expected (those only fire for forms landing after dispatch). Working as intended — don't "fix" it.

---

## Build order

0. **Task 0** — confirm the hire-agreement root cause (above) and fix it. Fast, high-value, unblocks trust in the book-out path.
1. **Leg-based completion + server-closes-the-quote (§2, §7.2)** — biggest safety win; immediately fixes Tobi's nag and hardens the existing book-out. Includes `maybeCloseQuote` + the chaser gate + `/start` persisting `legs_required`.
2. **Dead-end fallback + linkage hardening (§5, §7.1)** — fixes Lewis's strand for both directions.
3. **`/start` collection branch + `checkin-token` (§3, §4 portal side)** — routes collections correctly.
4. **`freelancer-checkin/resolve` + freelancer soft-check-in CheckInPage (§4 OP side, §6)** — the actual collection flow.
5. **Migration** for `soft_checked_in_at` (and any `quotes` leg columns from §2) if not present. Remember the hardcoded migration list in `backend/src/migrations/run.ts`.
6. **Robustness polish (§7.3–7.5)** — started-not-completed alert, POST timeouts, auto-sign-in-after-reset.

---

## Edge cases & rules

- **Multi-driver on one van** (15669 = 3 drivers on RO23HLV): book-out is **per-van** → cascade the flip + the per-driver agreement email to **all** drivers sharing that (vehicle, job), each getting their own PDF (see §D + the design question there). Do NOT book out / email only the single resolved row. Multi-*van* expansion (drivers×vans) can stay deferred — single-van-many-drivers is the case that bit us.
- **Collection with no customer hire form** (self-drive customer returning): the interim/condition report keys on the assignment; **no hire agreement needed on check-in**.
- **Mid-tour swap collection** (freelancer collects a broken van): same `save-event soft-check-in` primitive, `swap` trigger already exists.
- **Do NOT flip HH status to Returned or run close-out** on a freelancer soft check-in — warehouse owns final check-in.
- **`vehicle_hire_assignments` is soft-cancel only** — never hard-delete rows (see `CLAUDE.md`).
- **Idempotency everywhere**: `maybeCloseQuote`, the agreement send (`hire_form_emailed_at`), the soft-check-in event.
- **`weekend_manager ≡ manager`**, use `STAFF_ROLES`/`MANAGER_ROLES` constants for any new gated endpoint (see `CLAUDE.md` RBAC notes). Freelancer endpoints use the scoped `freelancer_checkin`/`freelancer_bookout` JWTs, not staff roles.

## Testing / acceptance

- **Van-only delivery:** book out → delivery quote flips to `completed` with **no** portal return hop and **no** chaser nag. Hire agreement emailed to the customer (Task 0). Condition report emailed.
- **Van-only collection:** `/start` offers "Check in / return", not book-out. Soft-check-in → interim PDF emailed, `fleet_vehicles.hire_status='Not Ready'`, `soft_checked_in_at` stamped, assignment NOT `returned`, collection quote `completed`.
- **Both:** do van then equipment (and vice versa) → quote only closes after the second leg; closing the tab between legs does not strand the quote.
- **Resolve failure:** friendly fallback screen, never a dead end; "started not completed" alert fires if abandoned.
- **Idempotency:** re-submitting any leg does not double-email or double-close.

## Env / infra referenced
`OP_BACKEND_URL`, `FREELANCER_HUB_SECRET`, `DATA_BACKEND=op`, `PORTAL_MONDAY_FALLBACK_ENABLED`. Portal is Next.js on Netlify (`ooosh-freelancer-portal.netlify.app`); OP is the Hetzner box (`staff.oooshtours.co.uk`, systemd `ooosh-portal`). The freelancer's browser talks to OP directly during the vehicle legs (cross-domain) — that's why server-side leg recording (not browser round-trips) is the design backbone.
