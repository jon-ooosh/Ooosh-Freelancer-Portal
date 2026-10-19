# Rack Planner — Spec & Build Reference (v2)

**Status:** Design finalised and empirically validated against a real HireHop job
pull (job 15553, June 2026). Ready to build. This document is the living reference
for a build expected to span multiple sessions — update it as phases land.

Supersedes the original v1 design brief. The two §5 "resolve before build" unknowns
are now answered (see §5). The original probe script lives at
`backend/scripts/hh-item-probe.js` (modes: `<jobNumber>`, `--item <LIST_ID>`,
`--categories`).

---

## 1. The problem this solves

When we send out a rack of gear (e.g. a FOH rack containing a desk, stagebox,
split, router, recharge rack), the HireHop quote tells the client and our staff
*what* is being supplied, but nothing about *how* it's arranged or interconnected.
This causes:

- Staff guessing at build intentions ("racked together or separate? where do the splits go?").
- The client getting no clarity about what they're receiving as a system.
- Forgotten connective items — looms, Cat5, splits, power — because the headline
  hire is obviously on the quote and the infrastructure isn't.
- Duplicate work and avoidable mistakes from lack of pre-planning.

The forgotten **loom** is the canonical failure case. The tool's primary job is to
make us declare connections, and in doing so, catch the missing loom.

This is **not** a patch-sheet tool and **not** an inventory tool. It describes
*how we will supply* a system. It is a planning and communication layer on top of
HireHop.

## 2. Two governing principles (carved in)

1. **HireHop is the source of truth for *what* is supplied.** The plan pulls from
   HireHop and never writes back. The plan may never assert that an item exists if
   HireHop doesn't have it.
2. **The plan owns *how*, never *what*, and describes only what *we* provide — not
   how the client patches.** Arrangement, links, and our infrastructure notes live
   in the plan. The show's input/channel list (kick, snare, vox) does **not** —
   that's the client's volatile document, not in HireHop, and storing it would
   poison the plan's "always up to date" authority.

## 3. The model

### 3.1 Canvas of nodes + labelled arrows

A canvas (Mermaid-style boxes + connecting lines) attached to a HireHop job.
**Nodes** are racks/system elements; **arrows** connect them and carry a free-text
label (e.g. "8-way XLR loom", "15m Cat5 to stagebox USR"). **Arrows are prompts,
not validated** — the label *is* the check. No graph logic, no completeness math.

### 3.2 Three node types

| Type | Has an interior? | Source | Example |
|------|------------------|--------|---------|
| **Built-here case** | Yes — an ordered, drag-to-reorder U-stack | A flightcase item, or a blank node staff name | The DL32/M32C/router rack |
| **Pre-built unit** | No — opaque, saved photo + label | A `VIRTUAL` package item | The 4-way G4 IEM rack |
| **Loose element** | No — label only | A job item that matters but isn't racked | A stagebox |

Built-here nodes do **not** require a HireHop case line — staff can create a blank
named node ("FOH rack") and drag U-items in. (In job 15553 the FOH rack's contents
exist but no single case line cleanly wraps them.)

### 3.3 The picker — classification rules (LOCKED, validated on job 15553)

Fed from the HireHop job pull (`jobs.line_items`, synced from
`items_to_supply_list.php`). Classification is a pure function applied **in this
order**:

1. **Build the LFT/RGT containment tree.** HireHop expresses parent/child via a
   nested set: a child's `[LFT,RGT]` falls inside its parent's range. (There is no
   usable `PARENT_ID` — ignore it.)
2. **Top-level `VIRTUAL` item → pre-built node.** Collapse its *entire subtree*:
   all descendants are absorbed into the opaque node and excluded from every other
   bucket. **This is what hides a package's internals — including its own
   autopulled loom/cables — which is correct: a package is a trusted pre-built
   unit.**
3. Of what remains (not inside any VIRTUAL subtree):
   - `rackheight > 0` → **U-item** (draggable into a built-here case). Carries the
     `rackwidth` half-width flag.
   - category **408** (cases) → **built-here node** candidate.
   - everything else → **loose / unplaced**.
4. Group the loose/unplaced bucket by the `kind:0` section headers (Audio / Veam /
   Backline) for readability. Show everything, hide nothing — noise filtering is
   deferred to IRL tuning (see §8).

### 3.4 The interior of a built-here case

- A vertical U-stack; items occupy U-bands sized by `rackheight`.
- **Drag to reorder** within the case. Order is bespoke per job (a real variable,
  not a template).
- **Half-width items** (`rackwidth` ticked) occupy half a 19" bay — placed
  side-by-side, or one + a half-width **blanking panel** filler. The tool *prompts*
  ("this bay is half-filled — add a unit or a blank?") but never gates. The blank
  is a placeable filler in the plan, not a HH line (unless a physical blank is
  actually racked).
- **Front-panel photo only** (no rear panels in v1). Photo fills the U-band, height
  driven by `rackheight`. **Missing photo → labelled-block fallback.** Photo work
  must never block use of the tool.

### 3.5 Node detail / infrastructure notes

- **Click a node → its I/O / infrastructure notes** (per-node, not per-socket).
- Notes describe **wiring we provide** ("12-way split: 1–8 to FOH, 9–12 to
  monitors; Cat5 from DM0"), **never channel names** (Principle 2).

### 3.6 Drift handling

The plan is a separate document from the HireHop job, so the job can change after
planning. Drift is **computed live against current `jobs.line_items` at load** and
**shown on the canvas** (not buried in a sidebar):

- **Racked item removed from the job** → a **red shape fills the hole, holding its
  U-position.** Loud, eye-level.
- **Unracked item removed** → a quiet "N item(s) removed from job" line.
- **Item on the job but not placed** → an explicit **"on job, unplaced" bucket.**
  Legitimate (e.g. a bass amp that isn't racked) but always *shown*. Also where a
  newly-added job item (e.g. a loom nobody racked) surfaces.
- **Reordering within a case** → no flag. Self-healing.

Drift is the only *live* part of the output. Layout is the *saved* part.

### 3.7 Output: view-only URL

- A tokenised, login-free URL renders the **saved plan**. Drift is computed **live
  against HireHop at load** and overlaid. Affordances: toggle labels, zoom.
- The URL is a delivery wrapper; the drift flag is the staleness solution.

## 4. Scope guardrails (deliberately NOT built)

No rear panels. No full wiring/signal-flow diagram (arrows are labelled prompts
only). No connection validation. No per-socket hotspots. No channel/input list. No
push back to HireHop (pull only). No modelling of the whole catalogue — only the
~25 rackable items, tagged once in HireHop.

## 5. §5 questions — RESOLVED (evidence: job 15553)

**Q1 — Do autopulled accessories surface as their own job lines? ✅ YES.**
The 8-way XLR loom (ID 696), IEC cables, Cat5, BNC and PowerCon all appear as their
own `kind:2` lines. The loom-catch mechanism is viable.

**Q2 — Does the pull group package components under a parent? ✅ YES, via LFT/RGT
nested set.** The IEM Rack Package (974) cleanly encloses its components at LFT
2–21; the drum kit (861) encloses its shells; etc. Collapse by containment. No
`PARENT_ID` needed.

**Q3 — Are all pre-built packages `VIRTUAL`? ✅ YES.** The four real packages (IEM
rack 974, IEM single 973, drum kit 861, drum hardware 1184) are all VIRTUAL. The
probe's "14 non-virtual enclosers" warning is a **false alarm** — those are ordinary
stock items with their own autopulled accessories (the M32C encloses its cables, a
kick drum encloses its hardcase). "Encloses children" is NOT a package signal;
`VIRTUAL` is.

**Validated distinction (the key test):** the pre-built rack of four G4 IEMs (974,
transmitter qty 4) and the *extra single* G4 unit (973, transmitter qty 1) are two
separate VIRTUAL packages with separate subtrees → rendered as **two distinct
pre-built nodes.** Never conflated.

**Photo source:** confirmed **NOT** present on the job pull, and the public
`hirehop.info` image URL uses an internal asset id (e.g. `2346_592`) that is *not*
the `LIST_ID`. No readable stock-item master endpoint was found (every candidate
returned the HireHop web-app HTML shell). **Decision: we own photos** (see §6).

## 6. HireHop tagging convention (data hygiene)

The classifier rests on three signals, all already in HireHop. **Seed these once
per stock item; never tag a `VIRTUAL` item with rack dimensions.**

| Signal | Field | Meaning |
|---|---|---|
| Rack-mountable + height | `TYPE_CUSTOM_FIELDS.rackheight` (integer) | How many U tall. `> 0` = rackable; absent/`0` = not a rack item. (`0` is HireHop's default and is treated as "not rackable".) |
| Half-width | `TYPE_CUSTOM_FIELDS.rackwidth` (boolean checkbox) | Ticked = occupies **half** a 19" bay (two fit across). Absent/unticked = full width. (Field is named `rackwidth`; a third-width case doesn't exist in our fleet, so boolean is sufficient.) |
| Pre-built package | `VIRTUAL = "Yes"` (native HireHop) | Opaque pre-built unit. Its subtree is collapsed. **Never set `rackheight`/`rackwidth` on a VIRTUAL item** — keeps the two node types separable on one unambiguous signal each. |

**Photos are NOT stored in HireHop.** We own them (see §7) — there's no readable
image endpoint, and we need our own rendering primitives for half-width units and
blank panels anyway.

## 7. Build spec

### 7.1 Storage — migration `121_rack_planner.sql`

Add the filename to the hardcoded list in `backend/src/migrations/run.ts`.

- **`rack_plans`** — `id`, `job_id` (FK jobs), `hh_job_number`, `title`,
  `view_token` (random unique — mirrors `ooh_parking_token`), `layout JSONB`,
  `created_by`, `created_at`, `updated_at`.
  The `layout` document is the *saved* plan:
  - `nodes[]`: `{ id, type: 'built_here'|'pre_built'|'loose', x, y, label, notes,
    hh_list_id?, hh_item_id?, items?: [{ hh_list_id, hh_item_id, label,
    rackheight, half_width, h_slot }] }` (`items[]` only on built-here nodes;
    ordered = U-stack order top→bottom).
  - `arrows[]`: `{ id, from_node, to_node, label }`.
- **`rack_stock_items`** — keyed by HireHop `LIST_ID`: `front_photo_key` (R2),
  `back_photo_key` (reserved/null), `name_cache`, `updated_by`, timestamps. Owned
  photos, lazy-seeded.

### 7.2 Backend — `routes/rack-plans.ts` (mounted `/api/rack-plans`)

- `GET /by-job/:jobId` (STAFF_ROLES) — get-or-create the plan; returns saved
  `layout` + freshly-classified picker buckets + computed drift.
- `PUT /:id` (STAFF_ROLES) — save `layout`.
- `POST /stock-photo/:listId` (STAFF_ROLES) — upload front panel → R2 +
  `rack_stock_items` (reuse `files/upload?attachment_only=true`).
- `GET /public/:token` — **login-free**, defined BEFORE the auth gate (mirrors the
  storage-TCS / OOH-parking public routes). Returns saved `layout` + live drift,
  read against current `jobs.line_items`. All HireHop reads via `hhBroker`.

### 7.3 Classification — `services/rack-classify.ts`

Pure, unit-tested function implementing §3.3 over `HHLineItem[]`. Single source of
truth. (The algorithm is already proven in `hh-item-probe.js`'s rack analysis —
port it cleanly.)

### 7.4 Frontend

- **"Rack Plan" tab on Job Detail** (consistent with the other job tabs).
- **Public `/rack/:token`** mounted outside `<Layout>`.
- Canvas: **`react-flow`** (agreed dependency) — boxes + labelled arrows + drag +
  pan/zoom + read-only mode. Custom node renderers for the three types; built-here
  node renders the U-stack interior (drag-to-reorder, photo bands sized by
  `rackheight`, half-width side-by-side + blank filler). Right-hand picker panel.
  Click-node → infra-notes side panel. Drift overlay per §3.6.

### 7.5 Build order (shippable increments)

1. **Storage + backend + classify service** — testable via API, zero UI/dep risk.
   ← start here.
2. Job Detail "Rack Plan" tab: canvas + picker + 3 node types + built-here U-stack
   + owned photos (lazy-seed upload + labelled-block fallback).
3. Arrows + free-text labels + per-node infrastructure notes.
4. Drift computation + on-canvas display.
5. Public tokenised view + live drift overlay.

## 8. Known edges / deferred (watch IRL)

- **Single unit fitted into a pre-built rack.** A `VIRTUAL` pre-built node is opaque
  (no interior), so you can't drop one node inside another. For v1, express
  "single G4 fitted into the main rack" via a labelled arrow or per-node note. If
  augmenting pre-built racks proves common, later allow a pre-built node to accept
  dropped extra U-items as an override. (Surfaced by job 15553: rack-of-4 [974] +
  single [973].)
- **Picker noise.** A real job has many loose lines, most irrelevant to a rack plan
  (drums, batteries, cymbal cases). v1 shows everything, grouped by section header;
  staff ignore the noise. Tune from real use rather than pre-building a category
  allowlist (Veam splits *are* rackable, so naive category filtering would be
  wrong).
- **Items rackable but untagged.** Follow `rackheight` as the convention — untagged
  rackables simply won't classify as U-items until seeded. No inline height-setting
  in the picker (keep the tag authoritative in HireHop).
- **Blank panels** are plan-only fillers, not HH lines (unless physically racked).
- **Back panels** — out of scope for v1. The day rear panels are wanted is the
  trigger to add `back_photo_key` rendering (storage column already reserved).

## 9. Empirical reference (job 15553)

Test job: a hire with a pre-built 4-way G4 IEM rack (VIRTUAL 974), an extra single
G4 unit (VIRTUAL 973), an ad-hoc FOH rack (M32C 1U + DL32 3U + Swissonic router 1U),
a 2U Veam split, plus a full drum kit (backline noise). Re-run any time with:

```bash
cd /var/www/ooosh-portal/backend
git fetch origin <branch>
git checkout FETCH_HEAD -- scripts/hh-item-probe.js
node scripts/hh-item-probe.js 15553        # rack analysis (tree + classification)
node scripts/hh-item-probe.js --categories  # HH category tree
node scripts/hh-item-probe.js --item 755    # stock-master probe (photo hunt)
```

## 10. Build status (Jun 2026) — LIVE

Backend `routes/rack-plans.ts` + `services/rack-classify.ts`; frontend
`components/rackplan/*` (+ `pages/RackPlanPublicPage.tsx`). Migrations 123
(`rack_plans` + `rack_stock_items`) and 124 (`rack_plans.updated_by`).

**Shipped:**
- ✅ Storage (one plan/job, JSONB `layout`, login-free `view_token`) + classify
  service (the locked §3.3 rules) + drift computation (backend).
- ✅ Launches from **Job Detail → 🛠 Tools → Rack Planner** (a modal, NOT a tab —
  keeps the tab bar uncluttered). An Overview **Rack Plan card** surfaces once a
  plan has content (item count, last-edited-by, View-only button, Edit button) so
  staff know a plan exists.
- ✅ Canvas (`@xyflow/react`): four node types — built-here rack (U-stack
  interior), pre-built (opaque package), loose, and **free-text note**. Drag to
  position, **grid-snap** (16px) for easy in-line alignment.
- ✅ Picker (right panel) fed from the classifier, **quantity-aware** (a qty:3
  item places 3× and counts down; rack cases gated too). Section buckets:
  Pre-built / Cases / U-items / Loose.
- ✅ Built-here interior: drag-order via ▲▼, per-item ✕, **half-width pairing**
  (two halves share one U-band; lone half + "pair/blank"), **capacity gate** +
  proportional empty-U rendering (a case's `rackheight` = its U capacity).
- ✅ **Connections**: drag any node-dot → any node-dot (Loose mode, 4 source
  handles/node), right-angle (smoothstep) routing, auto-prompt label on connect,
  click-to-edit + ✕-delete via an on-line chip.
- ✅ **Per-node notes**, **editable labels** (double-click — overrides the HH
  name), **coloured borders** (swatch row when selected, for grouping).
- ✅ **Front-panel photos**: lazy-seed upload (📷 on bands + pre-built nodes) to
  the **public R2 bucket** keyed by HH `list_id`, resolved live by `list_id`
  (editor + client). `object-contain` on dark backing = true aspect, no crop.
- ✅ **View-only page** `/rack/:token` (login-free, outside Layout): read-only
  canvas, Ooosh logo + job/HH header, "show labels" toggle, subtle line grid.
  **Short eyeball-friendly URL** via a `slug` (migration 125; `/rack/<slug>`,
  long `view_token` still resolves for backward compat — public endpoint matches
  `slug OR view_token`).
- ✅ **Drift display** (§3.6) — placed item removed from HH renders a red
  "⚠ removed from job" band **holding its U-slot** (+ red strip on standalone
  nodes); red + amber **banners** above the canvas count removed / on-job-unplaced
  items (the loom-catcher). Live in editor (computed vs current picker) and
  client view (from backend `drift.removed`). **Gotcha fixed:** standalone nodes
  must check `hh_item_id` (per-job ROW id), NOT `hh_list_id` (stock id) — the
  drift set is row-ids; mixing them flagged everything as removed.
- ✅ **Editable labels** everywhere — double-click a node header OR a U-item in a
  rack to override the HireHop name (plan-side display only; never written back).
- ✅ **Alignment guides** — react-flow helper-lines (`helper-lines.tsx`): drag a
  node and it snaps to other nodes' edges with a purple guide line (replaced the
  earlier grid-snap).
- ✅ **Photo edit-mode toggle** — per-item 📷 controls are OFF by default
  (opt-in via the "⚙️ Photos" toolbar toggle) so staff can't accidentally
  overwrite a photo.

**Migrations:** 123 (tables), 124 (`updated_by`), 125 (`slug`).

**Remaining (optional polish only — spec is fully delivered):**
- ⏳ Proportional **pre-built** node sizing (size the opaque package to its own U
  height — needs a U height seeded on the package). Not spec-required.

## 11. Learnings / gotchas (carve these in)

- **HireHop field names:** rack height = `TYPE_CUSTOM_FIELDS.rackheight` (integer,
  `>0` = rackable; `0` is HH's default = not rackable). Half-width = `rackwidth`
  (a **boolean checkbox**, despite the name; ticked = half). On a **case** (cat
  408), `rackheight` means **U capacity**, not occupied height — so classify
  checks cat 408 BEFORE the generic `rackheight>0 → u_item` rule.
- **react-flow Loose mode is required on BOTH the editor AND the public view.**
  All handles are `type="source"` (so any dot connects to any dot). In the default
  **Strict** connectionMode, react-flow tries to resolve an edge's target end
  against a *target-type* handle, finds none, and **silently drops the edge** —
  which is why connection lines rendered in the editor but vanished in the client
  view for several rounds. Fix = `connectionMode={ConnectionMode.Loose}`
  everywhere. (Also: hide read-only handles with `opacity:0`, NOT
  `isConnectable={false}` — the latter stops react-flow measuring them and edges
  lose their anchor.)
- **Photos go in the PUBLIC R2 bucket** (`uploadToPublicR2`, `R2_PUBLIC_URL`) —
  same pattern as vehicle photos — so the login-free client view can show them
  with no auth. Front-panel images are not PII. Store the full public URL in
  `rack_stock_items.front_photo_key`; resolve by `list_id` at render (so a photo
  added after a plan was saved still shows). Render `object-contain` so the true
  panel aspect is preserved (no squish/crop). Needs `R2_PUBLIC_URL` +
  `R2_PUBLIC_BUCKET_NAME` on the server (already set for vehicle photos).
- **The real Ooosh logo is `/ooosh-logo-full.jpg`** (used by login + warehouse +
  vehicle shell). The `ooosh-logo*.svg` files were a stray/wrong asset and were
  deleted.
- **Quantity expansion is count-based:** placement tracks count per HH `itemId`
  (standalone nodes + stack items), picker remaining = `quantity − placed`. A
  built-here node created from a case carries the case's `itemId` so it's gated
  too; blank "+ New rack" nodes carry no item ref (intentionally unlimited).
- **All node types share one inline `width: 240px`** so the plot lines up — don't
  reintroduce width classes that can drift between node types.
