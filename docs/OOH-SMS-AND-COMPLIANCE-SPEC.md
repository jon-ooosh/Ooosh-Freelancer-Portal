# OOH SMS Reminder + Return-Compliance Spec

**Status:** Draft for build · raised by jon 15 Jun 2026
**Builds on:** the existing Out-of-Hours (OOH) return module (`services/ooh-return.ts`, migrations 072/073, `OohReturnParkingPage`, the `ooh_*` `system_settings` keys, the daily 10:00 reminder cron).

## 1. Why

The OOH return flow (two emails — info at book-out, reminder T-1 — plus a per-driver
parking-confirmation link + Traccar-prefilled map) works well, but a minority of drivers
still leave vans inconsiderately in the street. Our neighbours need HGV access to their
gates; vans left across them cause real problems. Two improvements:

1. **A timely SMS nudge** fired when Traccar shows the van approaching base (~1 mile out),
   carrying the same per-driver parking link. Texts get read late at night when emails
   don't, and they land at the decision moment (where to park) rather than hours before.
2. **Per-driver compliance tracking** so a driver who repeatedly parks badly loses the
   ability to return OOH. Detection is a **staff decision** at morning check-in, not an
   automated one.

The two reinforce each other: the SMS link is per-driver, so an SMS-triggered submission
attributes the return to a specific person — improving the data that Part 2 relies on.

## 2. What we already have (don't rebuild)

| Asset | Where | Note |
|---|---|---|
| Per-driver OOH rows | `vehicle_hire_assignments` (one row per driver/van/job) | `driver_id`, `return_overnight`, `van_requirement_index`, status |
| Per-driver parking token | `vehicle_hire_assignments.ooh_parking_token` | Already unique per driver — submission = known driver |
| Send/track stamps | `ooh_info_sent_at`, `ooh_reminder_sent_at`, `ooh_returned_at`, `ooh_parking_lat/lng/notes` | |
| Driver phone | `drivers.phone` (VARCHAR 50) + `drivers.phone_country` (VARCHAR 10) | E.164 buildable today |
| Traccar lookup | `services/traccar-server.ts` → `getLatestPositionForReg(reg)` | Returns `{latitude, longitude, fixTime, ageSeconds}`, 5-min device cache |
| OOH config | `system_settings` (category `ooh_returns`) via `getSystemSettings([...])` | gate code, yard address, etc. |
| Parking form | `OohReturnParkingPage` + `routes/ooh-return.ts` public token endpoints | No-auth, status-bound token |
| Email patterns | `services/email-service.ts` | Test mode + per-template allowlist + `email_log` — **the SMS module mirrors this** |

---

# Part 1 — SMS module + geofence reminder

## 3. SMS module (reusable, mirrors the email service)

Build a channel-agnostic SMS service so future flows (hire-form chases, payment nudges,
freelancer alerts) can reuse it. **Pattern-match `email-service.ts` deliberately.**

**File:** `backend/src/services/sms-service.ts`

```ts
smsService.send('ooh_return_approach', {
  to: '+447700900123',        // or raw national + country, see normalisation
  variables: { driverName, vehicleReg, parkingFormUrl },
});
```

**Provider:** Twilio (jon setting up the account). One account covers SMS now + WhatsApp
later. Provider sits behind an interface (`SmsProvider`) so it can be swapped without
touching callers.

**Sender:** **Alphanumeric Sender ID `OOOSH`** for one-way reminders — free in the UK, no
rented number, no monthly fee, nothing to pay when quiet (e.g. the Christmas shutdown).
Replies bounce, which is fine (the action is "tap the link"). A real `TWILIO_FROM_NUMBER`
is only needed if we ever want two-way replies or US delivery — out of scope here.

**Test mode + allowlist (copy email-service exactly):**
- `SMS_MODE=test|live` — in test mode every message redirects to `SMS_TEST_REDIRECT`,
  body prefixed `[TEST → +44…]`.
- `SMS_LIVE_TEMPLATES` — comma-separated template IDs that go live while `SMS_MODE=test`
  (release one template at a time, no global flip).
- `sms_log` table (mirror `email_log`): recipient, template, body, segments, status,
  provider_message_id, `mode` (per-message *effective* routing), error, sent_at.
- No-op cleanly when unconfigured (missing creds) so the app boots before Twilio is wired.

**Templates:** plain-text registry (no HTML). Segment-aware (160 GSM-7 chars/segment) —
log segment count for cost visibility. First template `ooh_return_approach`:

> `Hi {{driverName}}, you're nearly back at Ooosh with {{vehicleReg}}. PLEASE park
> considerately and do NOT block the neighbours' gates. Confirm where you've left it:
> {{parkingFormUrl}}`

(Keep it one segment if possible. The short link is `{frontendUrl}/return-parking/{token}`.)

**E.164 normalisation** — `normaliseMsisdn(phone, phoneCountry)`:
- Strip spaces/punctuation. If already `+…`, trust it.
- Else use `phone_country` (ISO or dialling code) to prefix; UK `07…` → `+447…`.
- Return `null` if it can't be made valid → caller skips SMS (emails already cover them).
- Recommend the `libphonenumber-js` dep for correctness (small, well-maintained).

## 4. International policy (module is capable, sending is staged)

The module is international-ready for free (normalise via `phone_country`, hand to Twilio —
same call regardless of country). **Which countries we actually send to is a policy switch,
not code:**

- `system_settings.ooh_sms_country_allowlist` (CSV of ISO codes, default `GB`). Numbers
  outside the list **fall back to email-only** — zero regression, they still get both emails.
- Caveats baked into the doc, not the code: per-country cost varies; alphanumeric sender IDs
  work across most of Europe but **not US/Canada** (those need a rented number). Start `GB`,
  add EU codes once confident.

## 5. Geofence trigger (the scheduler)

**New scheduler task** in `config/scheduler.ts`. The office is open 09:00–17:00, so OOH
returns can land any time we're **closed** — 6pm, 2am, or 8:30am before we open — and all of
them need to park properly. So the scan runs across the **closed window: every 3 min from
17:00 to 08:59 Europe/London**. Cron: `*/3 17-23,0-8 * * *`. (Vans/night is a handful and the
existing 5-min Traccar device cache means load is negligible.) The 09:00–17:00 gap is
deliberate — anyone returning during office hours isn't an OOH case.

**File:** `backend/src/services/ooh-sms-approach.ts` → `runOohApproachScan()`.

For each **armed** assignment:
```
return_overnight = TRUE
AND status IN ('booked_out','active')
AND ooh_returned_at IS NULL
AND ooh_sms_sent_at IS NULL          -- one-shot
AND vehicle_id IS NOT NULL
AND COALESCE(hire_end, job_end::date) <= (CURRENT_DATE + 1)   -- only near the return
```
…look up `getLatestPositionForReg(reg)`, Haversine to base, and if
`distance_miles <= ooh_sms_radius_miles` (default **1**):
1. Build the driver's MSISDN from `drivers.phone` + `phone_country`. If unsendable (null,
   or country not in allowlist) → skip (stamp nothing; emails cover them).
2. `smsService.send('ooh_return_approach', …)` with that driver's own `ooh_parking_token`.
3. On success, stamp `ooh_sms_sent_at = NOW()`.

**Guards / edge cases:**
- The `hire_end <= tomorrow` clause kills the obvious false-fire (a driver who lives near
  base passing by mid-tour).
- Stamp is one-shot per assignment. No re-arm if they loop around (one nudge is enough).
- Stale GPS: if `ageSeconds` is very old (> ~20 min), skip this pass and retry next run
  rather than texting on a stale fix.
- Per-driver: a multi-driver van texts each driver who has a sendable number. (Acceptable —
  each is responsible; usually only the keyholder's phone is on file anyway.)

## 6. New settings (Part 1)

`system_settings`, category `ooh_returns`, admin/manager-editable on the Settings page:

| Key | Default | Meaning |
|---|---|---|
| `ooh_base_lat` | — | Yard latitude (one-time setup) |
| `ooh_base_lng` | — | Yard longitude |
| `ooh_sms_radius_miles` | `1` | Trigger distance |
| `ooh_sms_country_allowlist` | `GB` | ISO codes we SMS; others email-only |

**Env (`.env`):** `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_SENDER_ID=OOOSH`, `SMS_MODE=test`, `SMS_TEST_REDIRECT=+44…`, `SMS_LIVE_TEMPLATES=`.

## 7. Migration (Part 1)

Next free migration number (check `run.ts` — currently past 120; **add the filename to the
hardcoded array**):
- `vehicle_hire_assignments.ooh_sms_sent_at TIMESTAMPTZ`
- `CREATE TABLE sms_log (…)` mirroring `email_log`.

---

# Part 2 — Return-compliance tracking + auto-revoke

## 8. Principle

"Didn't fill in the form" is **not** a violation on its own — someone can park perfectly and
forget to confirm. The harm is **inconsiderate parking** (and its sibling: leaving the van
*somewhere* without telling us). Both are **staff judgements made at morning check-in**, never
auto-counted.

## 9. Detection — built into check-in (no separate "verify" chore)

The flag is captured **at the existing van check-in** (`CheckInPage` in the vehicles module),
not as a separate flow staff have to remember. We're already physically inspecting the van
when it comes in — that's the natural moment to record "did they park it properly?".

**On the check-in form, only when the van's assignment(s) have `return_overnight=true`:** a
**pre-ticked "OOH steps followed" checkbox**. Tick stays = assume fine, nothing logged.
**Untick it → a small severity modal** with two choices:

| Choice | type | severity |
|---|---|---|
| "Didn't tell us where they left it" | `left_without_telling_us` | minor |
| "Parked badly / blocked access" | `parked_blocking` | serious |

(+ optional free-text note.) On submit, the unticked state writes an `ooh_return_violations`
row using the attribution cascade in §10. The check-in person usually knows who brought the
van back, so the attribution picker (when needed) sits right there.

**Retro-flag fallback (§14) — because it won't always be the check-in person who makes the
call.** The manager who spots a van across the gates at 8am may not be the one who formally
checks it in at 10am. So the same flag/un-flag affordance is also reachable **after**
check-in from two places: the job's OOH section (Job Detail → Drivers & Vehicles) and a
short-lived dashboard list of **OOH returns from the last ~3 days** (so whoever made the call
can log it retroactively, and a mistaken flag can be cleared). Same modal, same write path.

Optional auto-signal (assist, never auto-flag): for **submitters** we have coords, so we can
geofence-check them against an acceptable-parking area and surface "parked outside yard" as a
*hint* next to the checkbox. Non-submitters have no coords (the typical offenders), so this is
assistive only — the human still makes the call.

## 10. Attribution cascade ("who returned it?")

1. **Submitted (incl. via SMS link)** → token → exact `driver_id`. Done.
2. **No form, single driver on the van** → it's them.
3. **No form, multiple drivers** → default the flag to the **main point of contact** for the
   hire, with a **driver picker** to change it (+ an "unattributed / whole hire" option).
   Staff usually know who the keyholder was.

Enforcement is **per-driver (person)**. Because violations join `job → client org`, a
**read-only org rollup** ("this client's drivers: 4 incidents") surfaces the
band-member-saying-"just-park-anywhere" pattern without punishing a one-off driver.

## 11. Data model (Part 2)

**`ooh_return_violations`** (new table):

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `driver_id` | uuid → `drivers`, **nullable** until attributed |
| `job_id`, `assignment_id`, `vehicle_id` | context (assignment nullable) |
| `occurred_on` | date |
| `type` | `parked_blocking` / `parked_outside_yard` / `left_without_telling_us` / `other` |
| `severity` | `minor` / `serious` |
| `notes` | free text |
| `logged_by` | uuid → `users` |
| `dismissed` + `dismiss_reason` + `dismissed_by` | so a mis-attribution clears cleanly (counter excludes dismissed) |
| `created_at` | |

**Eligibility flags on `drivers`:** `ooh_blocked BOOLEAN DEFAULT FALSE`, `ooh_blocked_at`,
`ooh_blocked_reason`, `ooh_blocked_by`.

**Block is suggest-and-confirm, not silent.** At `ooh_violation_block_threshold` (default
**2**, in `system_settings`) of non-dismissed violations, the system *prompts* a human to
block — it does not auto-flip. (We may auto-flip on 2× `serious` later; start human-in-loop.)

## 12. The two-tier override (jon's question)

Mirrors the dispatch-gate pattern — overriding a gate once vs. clearing the condition:

1. **Per-hire override** (manager, at the OOH toggle / book-out): "allow OOH for this driver
   on *this* job anyway." The block **stays**; you've waved one through. Default in-the-moment
   action.
2. **Lift the block entirely** (admin, on **Driver Detail**): clears `ooh_blocked` going
   forward — "we've had a word." Deliberately a considered action away from book-out, with a
   reason + audit entry.

## 13. Enforcement points

Anywhere OOH is offered/toggled — `OohReturnModal`, book-out — check every driver on the van:
if any is `ooh_blocked`, show a red banner ("Driver X has lost OOH return privileges — N
incidents") and block the toggle, with **manager override** (per §12.1). Consistent with the
OP non-blocking-with-override convention, but firm — which is the point.

## 14. Surfacing (Part 2)

- **Check-in form:** the primary capture point — pre-ticked "OOH steps followed" checkbox →
  severity modal on untick (§9).
- **Dashboard:** a short-lived "Recent OOH returns" list (last ~3 days) — lets someone other
  than the check-in person retro-flag, and lets a mistaken flag be cleared. Not a "to-verify"
  chore; it's a passive log with a flag/un-flag affordance.
- **Job Detail → Drivers & Vehicles:** flag/un-flag affordance on the OOH section per van,
  available after check-in.
- **Driver Detail:** OOH compliance section — return history (submitted ✓/✗, coords),
  violations, block status, **set / lift block** (admin).
- **Org Detail:** read-only OOH incident rollup (§10).

## 15. Migration (Part 2)

Next free migration number after Part 1's:
- `CREATE TABLE ooh_return_violations (…)`
- `ALTER TABLE drivers ADD ooh_blocked … ooh_blocked_at … ooh_blocked_reason … ooh_blocked_by`
- Seed `system_settings`: `ooh_violation_block_threshold=2`.
- **Add filenames to the `run.ts` array.**

---

# Build order

**Phase 1 — SMS module + geofence (self-contained, improves attribution):**
1. `sms-service.ts` + `SmsProvider`/Twilio + `sms_log` migration + E.164 normalisation.
2. Settings (`ooh_base_lat/lng`, `ooh_sms_radius_miles`, `ooh_sms_country_allowlist`) + env.
3. `ooh_return_approach` template.
4. `ooh-sms-approach.ts` scan + scheduler entry + `ooh_sms_sent_at` migration.
5. Settings-page UI for the new keys.

**Phase 2 — Compliance tracking:**
6. `ooh_return_violations` + `drivers.ooh_blocked*` migrations + threshold setting.
7. Check-in "OOH steps followed" checkbox + severity modal + attribution cascade (primary
   capture).
8. Retro-flag surfaces: "Recent OOH returns" dashboard list + Job Detail OOH flag affordance.
9. Driver Detail compliance section + set/lift block; Org rollup.
10. Enforcement banner + two-tier override at OOH toggle / book-out.

**Phase 3 (later, optional):** WhatsApp channel (dedicated number + Meta templates),
acceptable-parking polygon auto-hint.

## Operational setup jon owns (can't be coded)

- ✅ **Twilio account** created.
- **Upgrade out of trial** (add a little credit) — trial only sends to verified numbers and
  prepends a trial banner; the alphanumeric sender needs a paid account.
- Create a **Messaging Service** (Messaging → Services) and add **Alphanumeric Sender ID
  `OOOSH`** to its Sender Pool (UK — may need a short registration). Send via
  `messagingServiceSid`, not a raw `from`.
- Create a **Standard API Key** (Account → API keys & tokens) — revocable, preferred over the
  master Auth Token.
- Set on the **server `.env`** (jon, not in repo/chat): `TWILIO_ACCOUNT_SID`,
  `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`.
- Provide **yard lat/lng** for `ooh_base_lat/lng`.
- Decide a **test redirect mobile** for `SMS_TEST_REDIRECT` during the test-mode rollout.

## Costs (for reference)

- Alphanumeric sender ID: **no rental, no monthly fee** → **£0 when not sending** (quiet
  periods cost nothing).
- ~4p per UK text segment, PAYG. Negligible at OOH volume.
- International: per-country variable + email-only fallback off the allowlist.
- WhatsApp (Phase 3): per-conversation via Meta + a dedicated claimed number.
