<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Client Storage & Holding Modules — module reference

#### Step 9: Client Storage Module ← PHASE 1 BUILT (May 2026)

Standalone OP-native module replacing the Monday.com "Storage Clients" board. Ooosh rents ~20 storage rooms to clients long-term — deliberately NOT tracked in HireHop (no per-month book-in/out). **Full spec:** `docs/STORAGE-CLIENTS-SPEC.md`.

**Where:** `/storage` (Operations submenu → "Storage"), tabbed page: Rooms / Tenancies / Waiting List / Access Requests / T&Cs. Public T&Cs accept page at `/storage-tcs/:token` (token auth, no Layout wrapper, mirrors the OOH parking page).

**Backend:** migration 093 (`storage_rooms`, `storage_tenancies`, `storage_rate_history`, `storage_invoice_log`, `storage_access_list`, `storage_access_events`, `storage_waiting_list`, `storage_tcs_versions`, `storage_tcs_agreements`) + migration 094 (round-2 refinements, below). `routes/storage.ts` mounted at `/api/storage` — public T&Cs token endpoints defined BEFORE the `STAFF_ROLES` auth gate; rooms/T&Cs-version writes gated to admin/manager. `services/storage-reminders.ts` wired into the scheduler (daily 09:20 Europe/London). `storage_tcs_request` email template added.

**Round 2 (migration 094, May 2026 — first-live feedback):**
- **Access mechanism moved room → tenancy.** Door code / we-hold-key / client-key-or-padlock changes per client, so `access_type` / `access_code` / `key_location` live on `storage_tenancies` now (set at move-in, editable). Rooms keep physical attributes only.
- **Rooms gained `location_type` (internal/external) + `default_weekly_rate`** — move-in prefills the rate from the room default. **Photo upload** wired (room form → `POST /api/files/upload?attachment_only=true` → `files/attachments/<uid>/…`, appended to `storage_rooms.photos` JSONB; display via authenticated `/api/files/download`).
- **Access requests are reminder-style.** `storage_access_events` gained `notify_user_ids UUID[]` + `delivery_method` (notification/email/both). The logger is pre-ticked as a recipient. Fires **immediately if undated or due today**, otherwise on the **morning of** `requested_date` via the daily scanner (`notifyAccessEvent()` + the round-4 pass in `runStorageReminders`). `notified_at` is the per-event dedup stamp. Honours delivery_method like the close-out chase scanner (notification→low priority, email→sent immediately, both→normal/escalated).
- **Dashboard "On Today" section** (`frontend/src/components/dashboard/v2/sections/OnToday.tsx`, registry id `ontoday`, slotted right after `needs`). The general home for ad-hoc to-dos that fall through the cracks — seeded from storage access requests due today/tomorrow via `on_today` on `GET /api/dashboard/operations` (defensively wrapped so a pre-migration env can't 500 the dashboard). Hidden when empty. **To add another ad-hoc source, union it into the `on_today` payload** — the item shape (`source/id/title/detail/due/href`) is generic on purpose.
- **UI:** Tenancies is now the default tab (it's the "who's where" view staff live in); Move-In button moved to the bottom of the list; tab-bar `overflow-y` quirk fixed (`overflow-y-hidden scrollbar-hide`).

**Key design points:**
- **One live tenancy per room** enforced by a partial unique index (`status IN ('active','notice','reserved')`); the create handler catches `23505` → 409. Move-out soft-ends the tenancy (row preserved as ex-client history) and frees the room.
- **Invoice "tickbox" = forward-moving date.** Manual-billing tenancies carry `next_bill_date`. "Mark invoice sent" logs a `storage_invoice_log` row and advances `next_bill_date` by cadence (clearing the per-cycle reminder dedup stamps). Recurring-mode (Xero) tenancies are tracked but not nudged. Mirrors the chase-date convention.
- **Billing decouple + custom cadence (migration 162, Jul 2026).** `next_bill_date` is now PURELY the reminder trigger, separate from the invoice record. "Mark invoice sent" is a pre-filled modal (`MarkInvoicedModal`): amount, optional `invoice_number`, optional `period_start`/`period_end` (all three on `storage_invoice_log`), and an overridable next-due date (pre-filled from cadence, `+1m/+3m/+6m/+1y` quick-set). `mark-invoiced` next-due resolution: explicit override → fixed cadence interval → **custom** `billing_custom_interval_value`+`billing_custom_interval_unit` (day/week/month/year — unit is code-whitelisted so the interval SQL is injection-safe) → left as-is. **Why it exists:** a `custom` cadence had no machine-readable interval, so mark-sent couldn't advance the date — it got stuck circling the same dead cycle and re-nagging about an already-sent invoice (Studio 1 / Raygun, 07/07/2026). The custom interval + `bill_reminder_lead_days` / `bill_overdue_grace_days` are all editable on the Edit-tenancy form.
- **Reminders** (per-cycle dedup via `billing_reminder_sent_for` / `billing_overdue_sent_for` / `rate_review_sent_for`): billing due-soon (lead days before), billing overdue (grace days after, unticked → high priority), rate review due. Notify `bill_reminder_person_id` (fallback admins/managers) as `follow_up` bell notifications (escalation handles email per prefs).
- **Access requests** (`storage_access_events`): "collect X / courier Y" pinch point — log → notify admins/managers → mark done. Non-blocking access-list check warns if the attendee isn't on the unit's allowed list.
- **T&Cs:** versioned (`storage_tcs_versions`, one current), public accept-link + e-signature → `storage_tcs_agreements` (signature PNG to R2).

**Deferred (noted, not built):**
- ~~**Door-code encryption**~~ — done (migration 128, Jun 2026). The per-tenancy `storage_tenancies.access_code` is encrypted at rest via `services/encryption.ts` (AES-256-GCM), same dual-column pattern as driver PII: ciphertext in `access_code_encrypted`, plaintext column nulled on write (`prepAccessCode`/`revealAccessCode`/`stripAccessCode` in `routes/storage.ts`). Decrypted ONLY in the single-tenancy detail response (list views strip it). Falls back to plaintext if `ENCRYPTION_KEY` is unset. Backfill: `scripts/encrypt-storage-access-codes.ts` (dry-run default, `--commit`). NOTE: `storage_rooms.access_code` (the dead 093-era column, superseded by the per-tenancy field in round 2) is NOT encrypted — it's unused; drop it in a future migration if tidying.
- **Xero recurring-invoice tracking** — follow-on from the broader Xero integration work. The manual `invoice sent` log + reminders are the interim value.
- ~~**Dashboard surface**~~ — done in round 2 as the general "On Today" section (not a NeedsAttention bucket). `/api/storage/overview` still returns counts if a header widget is ever wanted.
- ~~**Address-book "Storage" tab**~~ — done in round 3. `StorageHistorySection.tsx` (current + past tenancies + waiting-list entries) mounted as a "Storage" tab on Org + Person detail, backed by `GET /api/storage/by-organisation/:id` and `/by-person/:id`. Mirrors the Hire/Excess/Held section pattern.
- ~~**Waiting-list → vacancy matching**~~ — done in round 3. `GET /api/storage/waiting-list/matches?size=` returns waiting clients fitting a freed room's size (exact / `any` / null, exact-match first). Surfaced via a `VacancyMatchModal` at move-out (uses the freed room's size) and a "Find tenant →" button on available room cards. One click marks a waiting entry offered.
- ~~**Signed T&Cs snapshot PDF**~~ — done (round 5). `services/storage-tcs-pdf.ts` (pdf-lib + Roboto via shared `pdf-fonts`) renders the version text (HTML→text) + acceptance metadata (who/when/IP) + signature image. Generated best-effort at acceptance time in the public accept endpoint, stored in R2 (`storage_tcs_agreements.pdf_r2_key`). Surfaced as a "📄 Download signed T&Cs" link on the tenancy detail (`tcs_pdf_key` on the detail payload, fetched via authenticated `/api/files/download`).
- **Round 4–5 tenancy editability + contact picker (Jun 2026):** the tenancy detail modal gained an **Edit details** form (`EditTenancyForm`) covering every mutable field post-move-in (access type/code/key location, billing mode, cadence, next invoice + rate-review dates, lead contact, org, move-in date, status, notes) via the existing `PUT /tenancies/:id`; weekly rate stays on Change rate (history) and room is fixed. Access is **always shown** in the read view (was hidden when no code set). The lead-contact picker is now an org-scoped `ContactPicker` backed by **`GET /api/organisations/:id/contact-candidates`** — active roles only (`por.status='active'`; ended roles are `status='historical'` and must never surface) expanded across related orgs via `organisation_relationships` (Org>Org & Org>person, mirroring the New Enquiry job cascade). Falls back to global people search.
- Temp storage / incoming deliveries — deliberately NOT here; belongs with the Holding module (Step 10).

#### Step 10: Holding Module — one page for everything we're keeping that isn't ours ← UNIFIED + LIVE (Sep 2026)

The unified "things we're temporarily holding for a client" module. **One engine** (`held_items`), one
`kind` discriminator — **`incoming` / `lost_property` only since Aug 2026**; `temp_storage` was folded
into `incoming` (migration 195). Replaces the Monday "Things being sent to us" + "Lost property & temporary storage" boards and
the merch/lost-property JotForms. **Full spec: `docs/HOLDING-MODULE-SPEC.md`.**

**Storage:** migrations 113 (`held_items` + `held_item_locations` seeded picklist), 115
(`contact_email`/`contact_phone`), 116 (`received_by`). One table; `kind` discriminator. Soft states,
no hard deletes. **Two temperaments:** incoming/temp = forward-looking (date-pressured); lost_property
= backward-looking (opportunistic, slow chase).

**Backend** `routes/holding.ts` (STAFF_ROLES) + a PUBLIC section before the auth gate (inbound merch
form). Endpoints: list (search incl. job number), `/locations`, by-person/org/job reads, CRUD,
`/:id/link` (the unknown→owner/job **backfill cascade** — derives `needed_by` from job out_date),
`/:id/collected` `/ship-back` `/dispose` `/notify` (real client email via `holding_received`),
`/:id/chase` (lost property — bumps level; **gradient chase email is the remaining Stage 8 TODO**),
`POST /send-merch-form` (client-picker-controlled link email), `GET /:id/label` (re-download),
public `GET /public/job/:n` + `POST /public/merch-form` (creates item, links job, generates labels,
emails them). **⚠️ Staff names: join `people` via `users.person_id` — `users` has NO name columns
(this caused a full-API outage Jun 2026; `express-async-errors` now shields async route rejections).**

**Frontend:** `/holding` + `/holding/lost-property` (HoldingPage, view-driven), `/holding/receipt/:id`
(staff QR-scan receive flow, two-phase → notify), `/merch-form` (public, no Layout), `/quick`
(QuickActionsPage — mobile PWA launcher; "Package arrived" is **search-first**: receive an
expected/known delivery or fall through to create, so staff don't make duplicates). Reusable
`HeldItemsSection` (by person/org/job; `bare`/`kinds`/`hideWhenEmpty`/`heading`/`openOnly` opts) on
Person/Org "Held Items" tabs + Job Overview. `SendMerchFormButton` on Job Overview. Label PDF
(`services/holding-label-pdf.ts`, pdf-lib + `qrcode` dep, printer-friendly black-on-white, one page
per box, QR → staff receipt page).

**Derived merch pip (the key design decision, Jun 2026):** the pre-hire `merch` requirement is
**status-reactive, NOT hand-ticked** — `services/holding-requirement-sync.ts`
`syncMerchRequirementStatus(jobId)` recomputes it from the job's `held_items` on every mutation (same
pattern as `excess_resolve`). Pip = *"anything we're holding/awaiting for this client we haven't given
yet?"* — grey (none) / amber (anything `expected` or here-not-given) / green (all
`given_to_client`/`shipped_back`/`disposed`). **"All given = green" is honest** (we never claim
everything arrived — a surprise parcel re-opens it to amber). **"Won't arrive"** action cancels an
`expected` item so the pip can green. **Never gates dispatch.** The Held panel + the pip are the same
truth, two views. `merch` is NOT in `job-progress-strip.ts` (shows on Job Detail checklist counter,
not the dashboard strip — add a slot if wanted). NOT touched by the HH derivation engine (OP-only).
temp_storage + lost_property are NOT on the ticker — they're **right-sidebar FYI** on the Job View
("📦 Also holding (FYI)", client-wide via org).

**Smart linking + notify + ship-back (PRs #690/#692/#695):** HH job number is the primary capture
field — `POST /holding` + `/link` derive `job_id` + client org from it (`resolveJobContext`), live
`GET /holding/job-lookup/:n` confirms the client in the form, `GET /holding/org-jobs/:orgId`
reverse-links when staff know the band not the job. `/:id/notify` takes a multi-recipient picker
(`recipients[]` + `GET /:id/notify-contacts`), branches template by kind, **attaches item photos**
(compressed client-side ~1600px before upload so emails stay small), enriches the incoming email with
the description; fires post-save on the Quick Log for incoming + lost. Ship-back forwards postage +
tracking (`holding_shipped_back`). `locationLabel()` surfaces the "Somewhere else" typed text. Shared
FE primitives in `components/holding/`.

**Lost-property chase + temp hold-until (PR #698, migration 119):** human-gated chase ladder — NEVER
auto-fires to clients. `POST /:id/chase` sends the gradient email for the current tier
(`holding_chase_1/2/3`, wk1 friendly → wk2 firm → wk3 final; job # in subject, staff signature via
`users.person_id → people`) then bumps the level, only on successful send (422 no email / 502 fail,
record untouched). `ChaseReviewPanel` on the Lost Property page (Send / Snooze / Skip), opened from
the digest deep-link `?review=1`. Two timers on the detail card (Last contacted / Next chase due).
`expected_collection_date` (future = chases paused, doubles as snooze, excluded from review + scan);
`hold_until` on temp storage (staff reminded 3 days before). `services/holding-reminders.ts` runs
daily **09:25 Europe/London** — assembles the chase digest (staff bell + info@ email to the review
queue, NO client emails fired here) + hold-until reminders, per-cycle dedup via
`hold_until_reminder_sent_for`.

**Briefing + Stage 9 + merch strip (PRs #700/#701):** pre-hire briefing gains a "Things we're holding
for this client" block (`JobBriefing.holding`, try/catch-guarded). Storage tenancy detail shows the
client's held items (`HeldItemsSection entityType=organisation`). `merch` is now a slot in
`job-progress-strip.ts` (+ FE mirror + briefing strip) so the pip shows on the dashboard Today strip.

**Merch card + panel combined (PR #703):** the standalone Overview "Held for Clients" panel was
duplicating the inert merch checklist pip. Now ONE surface — the merch requirement card in
`JobPrepChecklist` carries its incoming-items detail + Send Merch Form nested beneath it (same pattern
as the vehicle card nesting hire_forms/excess); the requirement row is untouched so the prep counter /
dashboard strip / briefing roll-ups keep working. Merch is item-gated (no items → no requirement), so
when nothing's logged a plain "Held for Clients" entry card renders instead (preserving the Send-Merch-
Form entry point + empty state). Pre-hire only; standalone Overview panel removed.

**At-a-glance chase columns + unified capture form + notify-at-create (Jun 2026):** two related
upgrades after first-live feedback that the chase/notify state was buried behind a row-click.
- **Lost Property list is now chase-focused at a glance.** The `lost_property` view table gained four
  click-to-sort columns — **Last contacted · Chases · Next chase due · Expected collection** (the
  "Found in" column folded into a sub-line under Item; Location dropped from the list — it's on the
  detail card). Default sort is **Next chase due ascending** so whatever's due floats to the top.
  "Next chase due" is **colour-coded** (red = due, blue ⏸ = paused by an expected-collection date,
  grey = none/scheduled). **Single source of truth:** `next_chase_due` + `chase_state`
  (`none`/`paused`/`due`/`scheduled`) are computed columns in `SELECT_WITH_JOINS` (`routes/holding.ts`)
  that MIRROR the daily scan in `services/holding-reminders.ts` — the list, the detail card's two
  timers, and the chase digest can never disagree. Any future "is this due a chase" surface should read
  these fields rather than re-deriving (the old detail-card `addDays` derivation was replaced).
- **One shared capture form** (`components/holding/HeldItemForm.tsx`) now backs BOTH the desktop
  `CreateModal` (HoldingPage) and the mobile `QuickLogSheet` (`/quick`). They were two drifting copies
  — notify-at-create only existed on mobile. `variant: 'desktop' | 'mobile'` switches styling + trims a
  couple of secondary incoming fields on mobile; field set + save payload + notify logic are identical.
  Add new capture fields HERE, not in either page.
- **Notify-at-create across the board.** The form carries a "✉ Notify client now" checkbox (default
  ON, hidden when owner unknown or item handed straight to client). On save it hands straight into
  `NotifyClientModal` mid-flow — pick recipients (resolved from job#/org/person, or free-enter
  name+email), or untick to just log without emailing. Applies to lost property AND incoming/merch.

**Count vocabulary — THREE words, one helper (Aug 2026).** `frontend/src/components/holding/counts.ts`
`describeHeldCounts()` is the single source for how quantities read: **expected** (`box_count`,
what the client said they'd send) · **here** (`received_count`, what turned up) · **outstanding**
(the difference). It renders `3 of 5 here · 2 outstanding` on the Holding list, the detail modal,
the picker and the Job-View panel, so they cannot drift. `services/holding-requirement-sync.ts`
mirrors the same wording for the merch pip's notes (the backend can't import `shared/` at runtime —
keep the two in step, same convention as `DOC_MATCH_TOKENS`). **The `description` says WHAT the
thing is, never HOW MANY** — the merch form used to generate `"5 box(es) of merch/equipment"`, which
froze at declaration time and stayed wrong forever once a partial arrival was booked in (job 15912:
client declared 5, 3 turned up, every surface still read "5"). It now writes `'Merch/equipment'`.
**Any new surface showing a quantity MUST call `describeHeldCounts`, not read the description.**
Pre-Aug-2026 records keep their baked-in description — it's editable inline on the detail modal.

**Expected vs here — the create form can book straight in.** `HeldItemForm` gained an **"It's
already here"** toggle (+ "how many arrived"). Without it every item logged from `/holding` was born
`expected` (the backend defaults `status` off `received_count` — `routes/holding.ts`), so an arrived-
but-unlogged delivery could only be backfilled via `/quick`. Defaults on for `variant='mobile'` (you're
holding the box) and via `arrivedDefault` from the desktop Receive flow; off for a plain "+ Log Item"
(a forward declaration). Only meaningful for `incoming` — temp storage / lost property are by
definition already in the building.

**Receive + hand over live on BOTH surfaces.** The two things that physically happen used to exist
only on the mobile `/quick` page. `components/holding/HeldItemPicker.tsx` exports `HeldItemPicker`
(search-first list) + `HandoverFlow` (pick → who took it → `POST /:id/collected`), used by `/quick`
AND the `/holding` header buttons (📦 Receive delivery · ✅ Hand over). Same convention as
`HeldItemForm` — **add a new capture/handover field there, not in either page.**

**Job View panel is no longer read-only.** `HeldItemsSection` takes `actions` + `onChanged`: rows
deep-link to `/holding?item=<id>` (HoldingPage has honoured `?item=` all along — the rows just used
to link at the bare list) and carry the ONE next physical step (Receive → the receipt page, or Hand
over → inline confirm). `onChanged` reloads the job so the derived merch pip re-reads the items.
Everything else (notify / ship back / dispose / relink) deliberately stays on the Holding pages.
`kinds` is an effect dependency — pass a **stable** reference (`HELD_KINDS` on JobDetailPage), not an
inline array literal.

**Short delivery: "Nothing more coming" is an UPDATE, not a cancellation.** `✕ Won't arrive`
(cancels the record) now only shows when nothing at all turned up, and a part-arrived delivery gets
**📦 Nothing more coming** instead — it corrects `box_count` down to `received_count` so the shortfall
stops reading as outstanding, while what IS here stays open to be handed over. The original declared
figure is appended to `notes` so the correction doesn't quietly erase what we were told was coming.
Previously the cancel action was gated to `status='expected'`, so a part-arrived delivery had no
closing action at all.

**ONE PAGE, organised by NEXT ACTION (Aug 2026).** `/holding` is the single page; kind is a filter +
a row icon, never a separate page. The old split was purely a frontend constant — one table, one
endpoint, one component rendering two views — and it forced staff to classify an item ("held for a
client or lost property?") *before* logging it, which for a mystery box in the corridor is
unanswerable.

- **`next_action` + `action_due` are derived server-side** in **`services/held-item-query.ts`
  `HELD_ITEM_SELECT`** (the chase expressions sit in a `LEFT JOIN LATERAL` so the action CASE can
  reference `next_chase_due` without restating it). It moved out of `routes/holding.ts` in Sep 2026
  when the dashboard became a second consumer — `SELECT_WITH_JOINS` there is now just an alias.
  ONE definition, so the strip, the table, the ordering and the dashboard cannot disagree — same
  reasoning as `chase_state`. **Import it; never re-derive the CASE in a second query** (the first
  cut of the dashboard work did exactly that and was reverted). Precedence is by
  URGENCY, not kind: `link_owner` (owner unknown — you can't chase who you haven't identified) →
  `decide` (`hold_until`/`dispose_after` passed) → `chase_owner` → `receive` → `hand_over` → `none`
  (terminal). `action_due` is the matching date; for `link_owner` it's the found/logged date and
  renders as an AGE, never as overdue. Default list order is `action_due` ascending with resolved
  rows sunk to the bottom. **Any new "what does this need" surface reads these two columns.**
- **The page**: a clickable action strip (counts per bucket) over a flat sortable table — the
  `/money/overview` pattern. **Every column header sorts** (text via `localeCompare`, dates/numbers
  numerically, nulls always sinking to the bottom regardless of direction); Boxes sorts on the
  DECLARED `box_count`, not the rendered "3 of 5" string. **The strip's left-to-right order is
  workflow order** (To hand over · Awaiting arrival · Chase owner · Needs linking · Time's up) and is
  deliberately NOT the server-side precedence order — that decides which single action a row gets,
  this decides how the buckets read. Changing one does not imply changing the other. Buckets were considered and rejected: 17 open rows at unification, 20–30
  at absolute max, so an accordion would be pure overhead. Filtering is **client-side off one fetch**
  so the strip counts stay stable while a filter is applied; `?kind=` / `?action=` / `?item=` /
  `?review=1` all round-trip through the URL. Column set follows the kind filter (chase columns for
  lost property, job/boxes/location otherwise). The chase review queue renders as the `chase_owner`
  bucket's action surface.
- **⚠️ `/holding/lost-property` must never be removed.** It mounts the same page with the kind
  pre-filtered. The daily chase digest's `?review=1` link is already sitting in staff inboxes and on
  historical `notifications.action_url` rows, and the printed box-label QR (`/holding/receipt/:id`)
  is on labels physically in the post. **The rule for this module: never remove a route, only add.**
  Nav collapsed to one "Holding" entry; the route stays forever.
- **`temp_storage` folded into `incoming`** (migration 195 — 2 rows, both already terminal). It
  earned nothing: `hold_until` already applied to `incoming` in `holding-reminders.ts`, and the
  `needed_by` derivation already treated the two identically. Its only distinct behaviour was the
  visibility of the "hold until" form field, now shown for any held-for-a-client item and feeding the
  "Time's up" bucket. The CHECK constraint still permits the value (no constraint migration, no risk;
  historical rows and any in-flight caller keep working) — **the UI simply never offers it**, and
  `KIND_LABEL`/`KIND_EMOJI`/`matchesKind`/`pre-hire-briefing.ts` all treat it as `incoming`. The two
  kinds that remain split on a question staff can always answer: **does the client know we've got
  it?** — `incoming` = they sent/left it (ends in a handover); `lost_property` = we found it (ends in
  collection or disposal, chase ladder).
- **The description IS the title — it appears once.** The detail modal's heading is an editable
  input (`EditableTitle`, borderless until hover/focus, saves on blur); the old "Details >
  Description" block repeating it verbatim a few hundred pixels below is gone. What's left of that
  section is box counts only, so it renders for deliveries and disappears entirely for lost property.
  **Don't re-add a Description field** — rename in the heading.
- **Linking an owner is done FROM the Client / Job fields**, not a separate button. Both carry a
  small `LinkEditButton` ("🔗 Link" when empty, "✎" when set) opening the same `LinkForm` — it edits
  owner and job together, so either entry point reaches both. That's where staff instinctively go to
  fix an owner; the floating "Link owner / job" button below unrelated sections is gone.
- **"Nothing more coming" captures a reason.** The `confirm()` was replaced by an inline form whose
  optional note posts into the item's **discussion thread** (as well as the notes trail), so "why did
  2 boxes never show up?" is answerable later. Note failure is best-effort — the count correction is
  the important half and must not be lost to a failed note.
- **Two columns were deliberately folded into "Next action" — don't restore them.** The dedicated
  "Next chase due" and "Hold until" columns are gone: a paused chase renders as a blue ⏸ inside
  `ActionDueCell`, and hold-until urgency surfaces through the "Time's up" bucket. Re-adding either
  column would put the same signal on screen twice.

**Dashboard surfacing (Sep 2026) — split by SHAPE, not one bucket.** Holding used to surface
nowhere on the dashboard (one daily 09:25 digest email + the review panel), which was the real reason
things sat unnoticed. It now reads `HELD_ITEM_SELECT` from two places, split on whether the action
carries a real date:
- **Dated → "On Today / Tomorrow"** (`on_today` in `routes/dashboard.ts`): `decide` (a hold/dispose
  date has passed) and `receive` (a delivery due within a day). CLAUDE.md's own note on that section
  says to union new ad-hoc sources into `on_today` — this is that. ⚠️ **`receive` is capped at
  `action_due <= CURRENT_DATE + 1`**: on the Holding page EVERY expected delivery carries that action
  (it's the standing "what does this need" answer), but a Today surface only wants the imminent ones.
  That is an UPPER bound with no lower bound, so **anything overdue is already included** and sorts
  to the top (OnToday's `dueLabel` gives it a red "Overdue" pill) — don't "fix" this by adding an
  overdue arm, and note that narrowing it to "today + overdue" would drop tomorrow, which the section
  is named for and which the storage source also includes.
- **Undated → a NeedsAttention card, "Unidentified items"** (`holding_unlinked` /
  `holding_unlinked_count`): `link_owner` only — the mystery-box backlog, ranked by how cold the
  trail is. This is the genuine gap, because **the daily digest only chases items whose owner is
  already known**, so an unidentified box had nothing nudging anyone at all.
- The card is **self-hiding at zero** (the `selfHiding` array in `NeedsAttention.tsx`, same treatment
  as the PCN buckets). The secondary row otherwise renders 13 cards unconditionally, greying the
  empty ones — a surface meant to say "a human is needed here" shouldn't grow another permanent grey
  tile. NB CLAUDE.md's Dashboard section claims secondary cards hide at zero; **only the PCN buckets
  and this one actually do**. The wider crowding of that row is a known, separate problem (jon,
  Sep 2026: "a different problem for a different day").
- The headline count is the FULL total via `COUNT(*) OVER ()`, not the LIMIT-10 row count — the bug
  the overdue-completions bucket carried until May 2026.

**Remaining / open:**
- IRL feedback from the chase + hold-until flows (staff trialling over the following weeks).
- **Merch pip label doesn't split awaiting vs here.** `in_progress` reads "To hand over" even when
  nothing has arrived yet (`RequirementCard` `TYPE_STATUS_LABELS`), because the 4-state requirement
  status can't carry the distinction and the card has no access to the items. The notes line beneath
  it says "Nothing here yet · 5 outstanding", which carries the meaning. Cosmetic — parked.
- **`unknown owner` checkbox was dropped** from the filter bar — the `link_owner` bucket covers the
  live case (terminal unknown items are the only thing it no longer reaches).

**Migrations:** 113/115/116 (initial) + 119 (chase/hold) + **195 (fold temp_storage → incoming)**.
`qrcode` dep added at the initial build. Neither the Aug 2026 counts/receive/handover round nor the
Sep 2026 simplification + dashboard round added a migration — every column they needed existed.
