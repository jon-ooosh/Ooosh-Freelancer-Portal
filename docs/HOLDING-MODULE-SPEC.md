# HOLDING MODULE SPEC — "Held for Clients" + "Lost Property" + Temp Storage

**Status:** SPEC / DISCUSSION ONLY — nothing built yet. This is the shaped design to refer
to before implementation. £/billing is noted but deferred for v1.

**Last shaped:** Jun 2026 (jon + Claude design session)

---

## 0. One-line summary

Everything we temporarily hold for a client reduces to the same spine:

> **a thing (or N boxes) we're temporarily holding → figure out whose it is → tell them → keep it
> somewhere → it leaves (collected / shipped back / disposed).**

So it's **one engine, one table** (`held_items`), with a `kind` discriminator that drives
different *behaviour* and different *display homes*. It replaces two Monday boards ("Things being
sent to us" + "Lost property & temporary storage") and two JotForms (Merch delivery form + Lost
property form).

---

## 1. Why one engine, not three

The Monday boards, the JotForms, and the temp-storage use-case are all the same data shape
(consignment/item → identify owner → notify → hold → leaves). Writing the mystery-box backfill,
the storage-location picker, the photo/notify flow, and the chase logic **once** is the whole win.

But the **`kind` matters operationally** — it splits cleanly into two temperaments:

| Temperament | Kinds | Behaviour |
|---|---|---|
| **Forward-looking, date-pressured** | `incoming`, `temp_storage` | Has a "needed by" date. Must be actioned before a hire leaves (e.g. "5 merch boxes arrived Monday, van to Gatwick Thursday — load them"). Hooks into the **pre-hire checklist + reminders**. |
| **Backward-looking, opportunistic** | `lost_property` | No hard deadline. Surfaced on the client's **next booking sidebar**, chased on a slow escalation clock (1/2/3 weeks). |

**Nav / identity:** one module under **Operations**, surfaced as **two named views** (filter pills
on the same engine):

- **"Held for Clients"** — `incoming` + `temp_storage`
- **"Lost Property"** — `lost_property`

(If temp storage later wants its own view, it's just a third pill — no rework.)

The standing **Storage Clients** module (rooms, tenancies, rent, rate reviews) stays **separate** —
that's a lease, not a transient consignment. The two **cross-link**: a `temp_storage` item can point
its location at a storage room, and a storage client's detail page shows both their tenancy *and*
any held items.

---

## 2. Data model

### `held_items` (new table)

```
held_items
  id                    UUID PK
  kind                  'incoming' | 'lost_property' | 'temp_storage'
  status                (unified superset — see §3)
  owner_unknown         BOOLEAN NOT NULL DEFAULT false   -- the "mystery box" flag, backfillable

  -- WHO (all nullable until identified)
  owner_person_id       UUID → people(id)
  owner_organisation_id UUID → organisations(id)
  client_name_text      TEXT            -- free text until linked to a person/org
  job_id                UUID → jobs(id)
  hh_job_number         INTEGER         -- may be known before the OP job row exists

  -- WHAT
  description           TEXT
  box_count             INTEGER         -- expected/declared
  received_count        INTEGER         -- actually arrived (partial arrivals)
  condition_notes       TEXT
  photos                JSONB           -- R2 keys, same FileAttachment shape as jobs.files

  -- WHERE FROM (lost property)
  found_in              'van' | 'rehearsal' | 'backline' | 'elsewhere' | NULL
  found_vehicle_id      UUID → fleet_vehicles(id)   -- when found_in = 'van'
  found_location_text   TEXT

  -- WHERE NOW
  storage_location_id   UUID → held_item_locations(id)
  storage_room_id       UUID → storage_rooms(id)    -- when stored in a Storage Clients room

  -- INBOUND (incoming)
  expected_date         DATE
  import_charge_flag    'yes' | 'no' | 'unknown' | NULL

  -- DEADLINE (forward-looking kinds)
  needed_by             DATE            -- usually derived from linked job out_date

  -- MONEY (deferred — flag + notes only for v1)
  chargeable            BOOLEAN NOT NULL DEFAULT false
  storage_started_at    DATE
  charge_notes          TEXT

  -- OUT
  collected_at          TIMESTAMPTZ
  collected_by          TEXT            -- name captured at handover
  return_method         TEXT            -- postage method
  tracking_number       TEXT
  disposed_at           TIMESTAMPTZ

  -- CHASE (lost property)
  escalation_level      INTEGER NOT NULL DEFAULT 0   -- 0=none, 1=wk1, 2=wk2, 3=wk3/final
  last_chased_at        TIMESTAMPTZ
  dispose_after         DATE

  -- META
  arrived_at            TIMESTAMPTZ      -- incoming/temp_storage receipt
  found_date            DATE             -- lost property
  created_by            UUID → users(id)
  created_at / updated_at TIMESTAMPTZ
  notes                 TEXT
```

### `held_item_locations` (new managed picklist)

Seeded from the lost-property JotForm radio set, extensible from the Settings page (admin/manager):

`On storage shelves`, `In the safe`, `Big office`, `Corridor`, `By downstairs toilet`,
`Loading bay`, `Somewhere else…` — plus the option for a row to map onto a **storage room**.

### Audit / timeline

Reuse the existing `interactions` table for the per-item activity log (status changes, notifies,
link events, chase sends). Item entry/exit events ("arrived as mystery box Monday → identified
Thursday") stay legible because interactions are timestamped and ordered.

---

## 3. Lifecycles

Unified status superset (UI only shows the subset relevant to the `kind`):

```
expected → arrived (partial/full) → stored → client_notified
        → collection_arranged → collected/given → shipped_back → disposed / unclaimed
```

| Kind | Typical path |
|---|---|
| `incoming` | `expected → arrived → stored → (client_notified) → given_to_client` (loaded into van) / `shipped_back` |
| `temp_storage` | `stored → (chargeable accruing) → collected/given → shipped_back` |
| `lost_property` | `found → (client_notified) → collection_arranged → collected` / `shipped_back` / `disposed` / `unclaimed` |

Status never downgrades silently; any new "things we hold" surface MUST read the canonical status
rather than re-deriving from individual fields.

---

## 4. The unknown → backfill cascade

**"Unknown owner" is a first-class state, not a blocker.** Log in ~10 seconds with
`owner_unknown=true` + a photo + a location. Backfill anytime — ten minutes later when the rehearsal
client pops down, or ten days later when the band turns up.

When an item is **linked** to a person/org and/or a job, the link **cascades**:

1. **Owner linked** → appears on that person/org's **"Held Items"** address-book tab, and on the
   **Job View right-hand sidebar** of their future bookings (lost-property surfacing — see §6).
2. **Job linked** → appears on that Job's view. For **forward-looking kinds** with a near `out_date`,
   auto-create/attach a **pre-hire checklist requirement** (see §5) + optional reminder.
3. **Audit preserved** — the mystery-box history stays intact on the timeline.
4. **Optional staff notification** on link: *"📦 mystery box just linked to job 15816 (out Thursday)
   — needs loading."*

**Auto-suggest owner** from context we already hold:
- Lost property `found_in='van'` + `found_vehicle_id` → recent `vehicle_hire_assignments` for that
  reg → likely client.
- `hh_job_number` present → straight to the job + its client.

---

## 5. Forward-looking items → pre-hire checklist tie-in (the time-sensitive bit)

The killer requirement: incoming/temp-storage items linked to a job must surface as *"do something
with these before the van leaves."*

Reuse the **existing `merch` requirement type** (`job_requirements`, migration 021 —
"Merch Receiving": Request sent → Some received → All received → Notified client → Given to client).
When an `incoming` item is linked to a job:

- Auto-create/attach the `merch` requirement card if not already present.
- "Given to client" = loaded into the van.
- It inherits the **dashboard progress strip**, overdue logic, and the reminder/notification engine
  **for free**.
- `needed_by` derives from the job's `out_date`; an optional reminder fires the morning prep is due
  ("load these 5 boxes by Thursday AM").

This is the cleanest integration — no new prep-tracking surface, it rides the requirement engine.

---

## 6. Lost-property surfacing on future bookings

Lost property has no deadline, so it's surfaced **opportunistically** rather than chased into the
prep flow. On the **Job View right-hand sidebar** (alongside the existing client trading-history
block), show:

> ⚠️ This client has 2 items in lost property held since 2 Feb → [view]

Zero chasing friction — it just appears when the client is next in our world, and staff can hand it
over then.

---

## 7. The "client collected but staff forgot → gnarly chase email" problem

The Monday pain: client collects, staff forgets to update the board, three days later an automated
"we're going to dispose of your stuff" email fires. Two complementary fixes — **both**:

### A. Make "mark collected" frictionless, at the point of handover

The forgetting happens because staff are physically handing over a box, not at a desk. So the
collect action lives on the **mobile quick page** (§9): **✅ Handover/collected** → search recent
held items → tap the row → optionally capture who collected (name, or a quick signature mirroring
the staff-signature the lost-property JotForm already grabs) → done. If marking-done is as fast as
forgetting, the forgetting mostly stops.

### B. Gate the escalation behind a human, not a cron

The real safety net. The daily scan does **not** auto-fire chase emails. Instead it assembles a
**"Chases ready to send" review page** — one screen listing every item due a chase, each row with
**Send now** / **Skip** / **Snooze** + enough context to spot "oh, they collected that Tuesday."
A staff member eyeballs it over coffee; stale rows get unticked before anything leaves.

- A lightweight **digest email to staff** ("3 lost-property chases ready") **deep-links to that
  page** rather than firing the client email itself.
- Slots into the existing **actionable-notification pattern** (`notifications.actions` JSONB
  whitelist) as a `review_chases` action — can also live as a bell notification with a button.
- **No signed one-click-send-from-email links** for v1 — the whole point is a human sees the batch.

Supporting touches: soften tier copy into a genuine gradient (wk1 friendly nudge → wk3 firm final
notice); auto-suppress an item from the review if it's had recent status activity. A+B are the spine.
Principle (consistent with money emails): never let a client-facing, irreversible-feeling email fire
fully unattended.

---

## 8. Inbound client form + label/QR flow (replacing the merch JotForm)

### Sending the client the form link — client-picker controlled, never a blast

How the client *gets* the "tell us what you're sending" link. This mirrors the existing
**hire-form send** pattern exactly (the right precedent):

- **"Send merch form" button** on the Job View (merch requirement card / "Held for Clients" strip),
  using the **same contact picker** as hire forms — `/api/hire-forms/email-contacts/:jobId`
  (client org email, org people, `job_organisations` linked contacts, HH name-match) with
  **per-recipient checkboxes** and **send / chase** modes. Staff pick who; no splatting everyone.
- The emailed link is a **per-job pre-filled form URL** (HH job number baked in) so the resulting
  `held_item` **auto-links to the job** on submit — no "which booking is this?" guessing.

**Triggers:**
1. **Manual (primary)** — staff hit "Send merch form" when they know a client's sending stuff.
2. **Suggested, NOT automatic** — surface a gentle nudge ("self-drive job confirmed / this client
   often sends merch — send the form?") rather than auto-firing. Deliberately *not* auto-sent on
   confirmation the way hire forms are: most jobs never involve merch, and auto-blasting would train
   clients to ignore it.

### Public form (client-facing, no login)

Same pattern as the OOH-parking / driver-verification public pages. Ports the existing merch JotForm:
band/artist, HH contract #, boxes expected, estimated delivery date, import-charge? (yes/no/don't
know), contact email, contact phone, notes, **T&Cs accept** (the existing "≤5 days before hire /
must be labelled / no liability / goodwill service" copy ports straight over).

On submit → creates a `held_item` (`kind='incoming'`, `status='expected'`), auto-links to the job by
HH number where possible.

### Label PDF + QR

Generate a **label PDF** (pdf-lib, like the OP's other PDFs) carrying:
- Job number + band/client name
- Box numbering ("Box 1 of 3 …")
- A **QR code** (`qrcode.react` already a dependency)

### Two QRs, kept distinct (security)

| QR | Audience | Auth |
|---|---|---|
| **Public form URL** | Clients fill it in | Public (only public surface) |
| **Label QR** (printed on the box) | **Staff**, scanned on arrival | **Behind staff login** |

The label QR encodes a link to the **acknowledge-receipt** page for that consignment. Scan on arrival
→ tick boxes in → snap photo → pick location → optional notify-client-with-photo → done. **A UPS
driver (or anyone) scanning the label QR just hits the OP login wall** — they can't touch anything.

---

## 9. Mobile quick-action page

A mobile-first launcher staff **save to their phone home screen** (PWA manifest + icon → launches
full-screen like an app). **Individual staff JWT + password** (no PIN kiosk — personal devices, so
every quick action is correctly attributed).

Big thumb-friendly buttons, no menus. v1 set:

- 📦 **Package arrived** — photo → who / unknown → where stored → notify? → done
- 🔍 **Lost property found** — photo → found where (pre-fills van reg / rehearsal / backline) →
  items → where stored → notify?
- ✅ **Handover / collected** — search recent held items → tap → optional collected-by → done (§7A)
- 🧾 **Upload receipt** — the existing cost-receipt flow
- ↩️ **Check vehicle in**

**Book Out is deliberately excluded** for v1 — it's not a clean mobile-first flow.

Implement as a **registry of quick actions** (same pattern as the dashboard section registry) so new
buttons are a one-liner later. Reuses existing primitives: R2 photo upload, `files` JSONB, the
`mobile_upload_tokens` QR-handoff primitive (explicitly designed to generalise), the email service.

---

## 10. Contextual entry points

Ad-hoc access (mobile page + module pages) **plus** contextual prompts at the moments items surface:

| Moment | Prompt | Pre-fills |
|---|---|---|
| **Vehicle check-in** (esp. customer-not-present) | "Found anything in the van? → Log lost property" | van reg, job, suggested owner |
| **Vehicle prep** | "Log lost property" | van reg |
| **Backline / rehearsal de-prep** | "Anything left behind? → Log" | found_in = backline/rehearsal |
| **Job Detail** | "Held for Clients" strip of items linked to the job (the `merch` requirement card is the per-job window) | job |
| **Storage client detail** | "Packages held" tab (the Amazon-deluge case) | owner org |

Pre-filling found-in + job + owner from context turns a 6-field form into a 2-tap confirm.

---

## 11. Notifications & client comms

Reuse the email service + templates. Client-facing templates needed:

- **Incoming received** — "Your N boxes for job #X have arrived" (+ optional photo)
- **Lost property found** — "We found this after your hire" (+ photo)
- **Lost property chase** — gradient tiers wk1/wk2/wk3 (only ever sent via the §7B review gate)
- **Shipped back** — postage method + tracking number

Follow the house convention: HH job number in subject + body for any job-scoped template. Use the
client email-resolution chain (`job_contacts` → org people → org email → name-match → info@ fallback)
for linked items; for unknown/unlinked items, capture a recipient at notify time.

---

## 12. Deferred for v1 (noted, not built)

- **£ / billing.** `chargeable` flag + `storage_started_at` + `charge_notes` captured; surface
  "here N days — chargeable" so staff raise it manually via the Money tab. No automated billing.
- **Long-term temp storage → tenancy promotion.** The USA-band-merch-for-months case starts in
  `held_items`; "promote" to a real Storage Clients tenancy only if it goes genuinely long-term.
  Don't try to draw the line up front.
- **Signed one-click chase-send from email** — review-page gate only for now.
- **Book Out on the mobile quick page.**

---

## 13. Build order (when we go)

1. Migration: `held_items` + `held_item_locations` + seed locations.
2. Backend `routes/holding.ts`: CRUD, link-owner/job (with cascade), notify, mark-collected,
   ship-back, chase-review list + send.
3. Backline/check-in/prep contextual "log" hooks + Job View sidebar surfacing.
4. `merch` requirement auto-create on incoming→job link.
5. Module pages: "Held for Clients" + "Lost Property" views under Operations.
6. Mobile quick-action page (PWA manifest) + the 5 v1 buttons.
7. Public inbound form + label PDF + staff-auth acknowledge-receipt QR page.
8. Chase review page + daily scan + digest email + gradient templates.
9. Address-book "Held Items" tab + Storage-client "Packages held" tab.

Streams 2–9 mostly independent once 1 lands.
