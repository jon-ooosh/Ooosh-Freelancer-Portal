# Book-Out Phase Split, VE103B Desk Gate & Mobile Handoff — Spec

**Status:** In progress (branch `claude/vehicle-bookout-workflow-6A6gn`)
**Author:** drafted with jon, May/Jun 2026
**Touches:** vehicle book-out flow, VE103B, HireHop line-item writeback, freelancer portal book-out

## 1. Motivation

The vehicle book-out wizard (`frontend/src/modules/vehicles/pages/BookOutPage.tsx`) is one 6-step flow:

| Step | Captures | Where you physically are |
|---|---|---|
| 1. Select Vehicle | van picker | front desk |
| 2. Driver & Hire | driver, hire dates/times, **VE103B ref**, OOH-return toggle, excess | **front desk (face-to-face with customer)** |
| 3. Vehicle State | mileage, fuel | at the van |
| 4. Photos | 16-angle walkaround | at the van |
| 5. Briefing | checklist + notes | at the van |
| 6. Confirm | review + signature | at the van |

Two real pains:

1. **VE103B prints too late.** The cert number is entered at step 2 but generation only fires at *final submit* (step 6) — one of the parallel tracks in `handleSubmit` (`BookOutPage.tsx` ~L945). So staff enter the number inside, walk out, do the whole walkaround, sign, submit, then walk *back* inside to print. The VE103B overlay only needs vehicle + driver + dates + cert number — all known at step 2. There's no reason to wait.
2. **Device friction.** Steps 1–2 are desk/customer work; steps 3–6 are at-the-van work better done on a phone (camera). Today staff either do it all on a laptop (awkward photos) or all on a phone (clunky at the desk). There's no clean handoff.

## 2. Design

### 2.1 Phase A / Phase B

Split the wizard conceptually into two phases (the existing 6 steps stay; we insert a **commit + handoff juncture** after step 2):

- **Phase A — Desk** (steps 1–2): van, driver, dates/times, VE103B, OOH. At the end of Phase A we **commit the assignment server-side**: write `vehicle_id` + `hire_start`/`hire_end` to the `vehicle_hire_assignments` row, **but leave `status` pre-`booked_out`** (stays `confirmed`/`soft`). No book-out side-effects fire yet (the hire-agreement PDF email, auto-dispatch, OOH info email all key off the `status → booked_out` transition). Reversible if abandoned: the van shows *allocated with dates*, not *booked out*.
- **Phase B — Walkaround** (steps 3–6): mileage, fuel, photos, briefing, signature → submit → *now* `status → booked_out`, side-effects fire.

Because Phase A persists everything server-side, Phase B can load from the assignment on **any device** — no IndexedDB-draft transfer needed.

### 2.2 Device-aware, non-blocking handoff (jon, Jun 2026)

The handoff is an **affordance, never a gate**:

- **On a phone already** (touch + small viewport heuristic) → no QR shown; Phase A flows straight into Phase B as one continuous wizard, exactly as today. Nothing changes for the all-on-mobile user.
- **On a laptop/desktop** → at the Phase A→B juncture, offer **"Continue on mobile"** (renders a QR). Scanning it opens Phase B on the phone.
- **Finishing the whole thing on the laptop stays allowed** — "Continue here" sits next to the QR. Never blocked.

### 2.3 VE103B desk gate

Replace the silent optional VE103B text box with an explicit Phase-A gate:

> **"Is this vehicle leaving the UK on this hire?"** — No (UK only) / Yes (VE103B required)

- **HH-derived pre-fill:** the derivation engine reads job line items; presence of stock item **1023 ("VE103B certificate", CATEGORY_ID 355)** ⇒ pre-select **Yes**. The "▶ Vehicle going to EU" prompt is a corroborating signal.
- **Yes** ⇒ reveal cert-number field + **"Generate VE103B now"** button, fired at the desk by the printer (existing `POST /api/ve103b/generate`). Staff generate before walking out.
- **Not detected** ⇒ gate is unanswered; staff must actively pick "UK only" (confirm-and-go) or flip to "Going abroad". Non-blocking warning if unanswered, consistent with the OP confirm-or-flag convention.
- **Surprise-EU** (customer says "actually we're off to EU Thursday" and item 1023 isn't on the job): staff flip to Yes ⇒ OP **adds item 1023 to the HH job** (so it's charged + recorded HH-side) **then** generates the cert.

### 2.4 VE103B multi-van count guard (jon, Jun 2026)

**Book-out is per van** (physical, one van at a time), so each van's book-out handles *its own* cert. But the **job-level VE103B "sorted" state must count vans first**:

- A VE103B authorises one *vehicle* abroad. N vans going to the EU ⇒ **N certs** needed.
- The job-level VE103B requirement / "all sorted" indicator is **done only when `certsGenerated == vansGoingAbroad`** — never "≥1 cert exists". `vansGoingAbroad` is read from item 1023 quantity on the job (and/or per-van "going to EU" prompts).
- Mirrors the existing additional-driver logic (`hire-forms.ts` `processAdditionalDriverCharge`): **count what's already on HH first**, only add the delta.

### 2.5 HireHop item add — reuse the proven pattern

We already add HH line items in the additional-driver flow (`hire-forms.ts` ~L2771):

```js
await hhBroker.post('/api/save_job.php', {
  job: hhJobId,
  items: JSON.stringify({ [`b${STOCK_ID}`]: qty }),   // "b1023" for VE103B cert
  no_webhook: 1,
});
```

VE103B item add copies that helper's guards verbatim:
1. **Count existing 1023 lines + count vans first** — only add `max(0, vansGoingAbroad − existing1023)` (idempotent; never double-charge on re-entry).
2. **Skip locked/closed jobs** (HH status 7/9/10/11 or `LOCKED`) → return `manualActionRequired`, surface to staff instead of writing.
3. **Post a confirming HH note** via `job_note.php`.

### 2.6 Mobile handoff token & scoped session

Reuse the **`mobile_upload_tokens`** table + QR/poll UX (built for excess receipt scans) for the *exchange*, and a **sibling of the freelancer-bookout session** for the *auth*.

**Why a sibling, not literal reuse of `scope:'freelancer_bookout'`:** that scope drives freelancer-only UI branches (portal redirect after submit, customer-hire-form gate, hidden cross-job fallback) and freelancer audit attribution. A staff handoff must run **staff-mode Phase B** and attribute the book-out to the real staff user. So we add a distinct scope `bookout_handoff` carrying the staff identity.

**Flow:**
1. **Mint (laptop, authenticated staff):** `POST /api/vehicles/bookout-handoff-token` `{ assignment_id }` → `createMobileUploadToken({ purpose: 'book_out_handoff', targetId: assignmentId, createdBy: staffUserId })`. Returns `{ token, url, expires_at }` where `url = ${FRONTEND_URL}/m/bookout/:token`. 15-min TTL, single-use.
2. **QR + poll (laptop):** render `url` as QR (`qrcode.react`), poll `GET /api/mobile-upload/:token` for `consumed:true`, then show "Handed off to mobile — finish on your phone" and stop. (Reuses the existing GET context endpoint; adds a `book_out_handoff` branch to `resolveMobileUploadToken` for display context: van reg, driver, job #.)
3. **Redeem (phone, public, no login):** opens `/m/bookout/:token` → `POST /api/vehicles/bookout-handoff/resolve` `{ token }` → backend validates (unexpired, unconsumed, purpose match), **marks the token consumed**, and mints a `bookout_handoff` session JWT (assignment-scoped, staff-attributed, 4h TTL). Returns the session + assignment context.
4. **Drive Phase B (phone):** phone stores the session, deep-links into `BookOutPage` at the walkaround step in **staff mode**, completes mileage/fuel/photos/briefing/signature, submits. All walkaround endpoints (`save-event`, `upload-photo`, `generate-pdf`, `send-email`) already accept the scoped session via `authenticateVehicleFlexible`.

**Token semantics note:** the file-upload `POST /api/mobile-upload/:token` is *not* used for `book_out_handoff` (no file). The handoff is consumed at **resolve** time (exchange-for-session), not at file upload. The shared GET endpoint is still used for display + laptop polling.

### 2.7 Freelancer parity

Freelancers already do **Phase B only** — the office + the customer's remote hire form *are* their Phase A, and freelancer mode already hides times/VE103B and gates on the customer hire form. The staff `bookout_handoff` session is a sibling of the freelancer session, so:

- `getBookoutScope` is generalised to resolve scope from either session kind (it already only reads `assignmentId`).
- `authenticateVehicleFlexible` gains a `bookout_handoff` branch alongside the `freelancer_bookout` one.
- Phase B walkaround code is identical for staff-mobile and freelancer; the difference is cosmetic UI mode + audit attribution.

## 3. Backend changes

| File | Change |
|---|---|
| `services/hh-requirement-derivation.ts` | Detect item 1023 → `flags.ve103b_required` + `flags.vans_going_abroad` (count). Job-level VE103B done-gating reads `ve103b_certificates` count vs vans-going-abroad. |
| `routes/ve103b.ts` | (mostly unchanged — generate already exists.) Add a read for "VE103B status for job" (certs generated vs vans needed) if the desk gate needs it. |
| `services/ve103b-hh.ts` *(new, small)* | `ensureVe103bItemOnJob(hhJobId, vansGoingAbroad)` — count-first add of item 1023 via `save_job.php`, locked/closed guard, HH note. Modelled on `processAdditionalDriverCharge`. |
| `middleware/freelancer-bookout-auth.ts` | Add `bookout_handoff` scope: `mintBookoutHandoffSession({ assignmentId, staffUserId, staffEmail, staffRole })`, branch in `authenticateVehicleFlexible`, generalise `getBookoutScope`. |
| `services/mobile-upload-token.ts` | Widen `MobileUploadPurpose` to include `'book_out_handoff'`; add resolver display branch (van/driver/job). |
| `routes/vehicles.ts` | `POST /bookout-handoff-token` (staff, mint). `POST /bookout-handoff/resolve` (public, exchange token → session). Add both to behaviour as needed. Commit-assignment endpoint for Phase A (link vehicle + dates without status flip) — may reuse existing PATCH paths. |

No new migration expected — `mobile_upload_tokens` already has the columns; VE103B status derives from existing `ve103b_certificates` + line items. (Confirm during build; add a migration only if a tracking column proves necessary.)

## 4. Frontend changes

| File | Change |
|---|---|
| `pages/BookOutPage.tsx` | VE103B desk gate (toggle + generate-at-desk button) in step 2. Phase A→B juncture: device detection, commit-assignment call, "Continue on mobile" QR + "Continue here". Accept a `bookout_handoff` session (staff mode, enter at walkaround step). |
| `pages/BookoutHandoffPage.tsx` *(new)* | Public `/m/bookout/:token` route (no Layout). Resolves token → session → routes into BookOutPage Phase B in staff mode. Modelled on `MobileReceiptUploadPage.tsx`. |
| `lib/driver-hire-api.ts` / vehicle api libs | VE103B generate call wired to the desk button; handoff token mint + resolve calls. |
| `App.tsx` | Mount `/m/bookout/:token` route outside Layout. |

## 5. Risks & rollout

- **Live critical flow.** Changes to BookOutPage must be **additive** — the existing 6-step path must keep working unchanged for the all-on-one-device case. The phase juncture is an inserted affordance, not a rewrite.
- **Billing touch.** VE103B item add writes a £25 charge to HH. Guarded by count-first + locked/closed checks (mirrors additional-driver, which is proven). Always posts a note for audit.
- **No runtime testing in CI.** Build/typecheck only. Needs **IRL book-out verification** before relying on it (consistent with how VE103B end-to-end was shipped). Flag in PR.
- **Token security.** Handoff token is single-use, 15-min TTL, scoped to one assignment, exchanged once for a 4h assignment-scoped session. Phone never logs in (same as receipt scan + freelancer) — multi-device login stays parked and irrelevant here.

## 6. Out of scope

- General multi-device login (parked — jon, Jun 2026).
- Check-in mobile handoff (same pattern, follow-up — the `book_out_handoff` purpose generalises).
- Partial/per-van VE103B UI beyond the count-guard done-gating.
