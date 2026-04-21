# Next session — transport / portal finish-up

**Opened:** 19 Apr 2026
**Branch to use:** `claude/freelancer-portal-golive-Hd369` (currently live branch)
**Server:** `49.13.158.66`, app at `/var/www/ooosh-portal`, service `ooosh-portal`
**Deployed state:** everything up to commit `0313d0a` on main, plus today's venue-migration work sitting on the branch (commits `549f4aa` → `1b13cc8`) waiting to merge.

## Where we are

Today's session went long but landed:

- Staff-shared portal account for `info@oooshtours.co.uk` (migration 053)
- Venue + job file sharing on the portal via presigned R2 URLs
- `PORTAL_MONDAY_FALLBACK_ENABLED` env flag to kill silent fallback when ready (still defaulted `true` on Netlify)
- Non-UUID 404 guard on portal quote endpoints (stops stale Monday IDs 500'ing)
- Completion flow fixes: PDF equipment list now renders, photos/signature stored on R2, lightbox + download on Transport Ops
- `migrate-monday-upcoming.ts` — imported 148 D&C assigned + 48 D&C unassigned (new_group bypass) + 0 crew = 196 quotes
- Migration 054 + `migrate-monday-venues.ts` — 464 venues imported (455 created + 9 name-matched to existing OP/HH venues)
- `--refresh-venues` mode on the upcoming script

Data-quality check after the dry-run of `--refresh-venues` surfaced the biggest outstanding bug: the `connect_boards6` venue-link column on D&C Monday items isn't being parsed (see task 1 below).

## Tasks, in priority order

### 1. Fix the D&C venue connect-column parser (BLOCKER for venue linkage)

**Symptom:** `--refresh-venues` reported `no Monday venue link: 155/155`. Jon confirms all 155 actually have their venue linked on Monday.

**Likely cause:** my JSON parsing of `column_values[id=connect_boards6].value` is wrong. The shape I'm assuming (`{ linkedPulseIds: [{ linkedPulseId: N }] }`) probably isn't what Monday's API 2024-01 returns for that column — could be `linked_pulse_ids` snake_case, or the venue id is on `column_values[].display_value`, or it's on a GraphQL relation we're not fetching.

**Files:**
- `backend/src/scripts/migrate-monday-upcoming.ts` — both the create-path (in `migrateDC`) and the refresh-path (`refreshVenueLinks`) use the same broken parse.
- `backend/src/scripts/migrate-monday-venues.ts` — has a working `fetchAllItems` that can double as a generic board-dump utility.

**Approach:**
1. Add a one-off diagnostic that prints the RAW `column_values` (id, text, value) for one known-linked D&C item — any of the 155. Include `display_value` if available.
2. Inspect the output — determine the actual JSON shape and where the linked pulse id lives.
3. Fix the parser in both paths. Add a small unit test with a captured sample payload if worth it.
4. Re-run `--refresh-venues --commit` — expect ~150 of the 155 to suddenly match. Job Detail and Transport Ops should now show venue names for those.

### 2. Edit Quote venue picker (Jon's explicit ask)

Jon wants to verify / add a venue picker in the Edit Quote modal on Transport Ops + Job Detail. CLAUDE.md line ~1121 claims it's done (`Quote editing: Edit Quote modal … (venue, date, time, fees, notes)`), but Jon suspects the venue part specifically doesn't work well for the migrated "No venue" quotes.

**Approach:**
1. Open any migrated "No venue" quote on Transport Ops → click Edit → confirm/deny venue picker
2. If picker exists but is broken: fix the existing flow in `frontend/src/pages/TransportOpsPage.tsx` `EditQuoteModal`
3. If picker is missing: add a venue search/pick control (mirrors the one on Local D&C form in Job Detail) — allow linking to an existing venue OR typing a free-text `venue_name`
4. Ensure the change surfaces on Transport Ops immediately (state refresh, not just requiring page reload)

### 3. Costings pull from D&C hidden columns

The initial migration only pulled `freelancer_fee` (driver pay). Transport Ops shows `£0` as client charge on every migrated row because the real fee fields were never populated. Jon's screenshot from the D&C tooltip shows Monday stores (on hidden columns per Jon's confirmation):

- Fuel
- Tolls / Crossings
- Parking
- Transport (outbound) / Transport (return)
- Hotel
- Per Diem
- Client charge (top-level — confirm on dump)

**Approach:**
1. Write a tiny `backend/src/scripts/dump-monday-columns.ts` utility: given `MONDAY_BOARD_ID_*`, dumps full column list (id / type / title). Same pattern as the venue script's `dumpBoardColumns`. ~30 lines.
2. Run against the D&C board (`MONDAY_BOARD_ID_DELIVERIES=2028045828`) — ask Jon to identify the 7-ish cost columns.
3. Add a `--refresh-costings` mode on `migrate-monday-upcoming.ts`:
   - Walk every `tracking=yes` D&C item (same pattern as `--refresh-venues`)
   - Match OP quote by (hh_job_number → job_id, job_type, job_date)
   - Populate `client_charge_total`, `client_charge_rounded`, and build up the `expenses` JSONB
   - `expenses` shape for reference: `[{ type: 'fuel'|'tolls'|'parking'|'hotel'|'per_diem'|...; amount: number; includedInCharge: boolean }]` — see existing code in `TransportCalculator.tsx` / `quotes.ts` for the exact shape
   - Only update quotes where the target fields are NULL/empty, to preserve any staff edits
4. Run `--refresh-costings --commit` → Transport Ops rows show real pricing.

### 4. P3 pre-flight sanity script

Small utility that calls every portal endpoint with known test data and reports pass/fail. Gives confidence before flipping the Monday fallback flag off. Can be skipped if you're happy to flip without it — your call.

**Approach:**
- `backend/src/scripts/portal-sanity-check.ts`
- Hits: `/api/portal/auth/login` (with test123@), `/api/portal/me`, `/api/portal/jobs`, `/api/portal/jobs/<known quoteId>`, `/api/portal/jobs/<id>/equipment`, `/api/portal/jobs/<id>/files`, `/api/portal/auth/verify-reset-token?token=invalid`
- Report HTTP status + any error body. Exit non-zero if anything's not 2xx / expected.
- Read the test account creds from env or `.env.test`.

### 5. Flip `PORTAL_MONDAY_FALLBACK_ENABLED=false`

The go-live moment. One line on Netlify. Before flipping:

- Tasks 1–3 done (so OP has real venue + costing data)
- Task 4 passes (or you're confident enough to skip it)
- Send freelancers a heads-up email: "From X date, use Forgot Password on first login if you registered before we moved systems"

After flipping: watch `portal_fallback_events` table for telemetry. Any unusual volume → investigate before bigger damage.

### 6. Crewed Jobs board

Currently `MONDAY_BOARD_ID_CREW_JOBS` isn't set on the server — Jon confirmed the board was an abandoned experiment with no real data. Safe to leave unset. If/when Jon wants to migrate crew items, the script's `migrateCrew()` works the same as D&C once the env var lands.

## Things to carry across from today

- Run all scripts from `/var/www/ooosh-portal/backend` via `npx tsx`, not compiled dist
- Dry-run first, `--commit` second, always
- After every code change: build + restart (`cd backend && npm run build && sudo systemctl restart ooosh-portal`). Script-only changes don't need restart, tsx reads source.
- Venue notes migrated from Monday include a clearly-marked `--- Migrated contacts (from Monday YYYY-MM-DD): ... ---` block. Long-term cleanup: promote these into proper `people` rows linked to orgs with `site_contact` role. Not urgent.
- Monday items already marked `"yes"` in the D&C tracking column (`text_mm2krnzm`) won't re-migrate. `--refresh-venues` / `--refresh-costings` modes operate on `"yes"` items (the ones we already created).
- The shared `info@` account on the portal sees every `is_ooosh_crew=true` assignment. Staff completion form prompts for a name so you know who actually did it.
- Branch pattern: keep pushing commits, let Jon PR + merge to main.

## Files touched today (for context)

| Scope | File |
|---|---|
| Staff shared account | `backend/src/migrations/053_portal_shared_account.sql`, `backend/src/routes/portal.ts` |
| File sharing | `backend/src/config/r2.ts`, `backend/src/routes/portal.ts`, `src/app/job/[id]/page.tsx`, `backend/package.json` |
| Monday fallback flag | `src/lib/op-api.ts`, 10 routes under `src/app/api/**` |
| Non-UUID guard | `backend/src/routes/portal.ts` |
| Completion flow | `backend/src/routes/portal.ts`, `backend/src/routes/files.ts`, `frontend/src/pages/TransportOpsPage.tsx` |
| Migration scripts | `backend/src/scripts/migrate-monday-upcoming.ts`, `backend/src/scripts/migrate-monday-venues.ts`, `backend/src/migrations/054_venue_default_tolls.sql` |
| Portal password reset | `src/app/api/auth/verify-reset-token/route.ts`, `src/lib/op-api.ts`, `backend/src/routes/portal.ts` |
