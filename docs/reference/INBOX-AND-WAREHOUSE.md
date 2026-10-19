<!--
Extracted verbatim from the root CLAUDE.md (Sep 2026 restructure).
CLAUDE.md was ~757KB / 5,746 lines and was consuming most of every session's
context window before a single turn of work. It now carries only the
always-applicable conventions; the detail lives here.

This file is the FULL record: design decisions, incident forensics, shipped-work
history. The distilled "never do X" rules that must reach every session live in
`.claude/rules/*.md` (auto-loaded when Claude opens a matching file).
-->

# Inbox, Notifications, Messaging & Warehouse Collections — module reference

#### Step 7: Inbox & Notification System ← IN PROGRESS (Apr 2026)

Unified messaging, notification, and follow-up system. Replaces Monday.com's @mention/update system. The existing interaction/timeline system is the conversation layer; the inbox surfaces conversations and system alerts to the right people.

**Phases A-E shipped Apr 2026 are the inbox foundation. The threaded-messaging upgrade (Phase F) is mostly shipped May 2026 — full thread view in inbox, attachments, paste-to-attach, render polish, actionable notifications. Problems-system integration (issue comments through interactions) is the remaining piece. Spec: `docs/MESSAGING-SPEC.md`.**

**Design principles:**
- @mention in timelines IS the messaging system — conversations happen on entities (jobs, people, orgs)
- Chase pattern for follow-ups: set a date, get reminded, snooze/action/dismiss
- Sender can see read/unread status and nudge recipients
- Escalation respects working hours (staff calendar when built, defaults 08:00-18:00 Mon-Fri until then)
- Users choose their reminder delivery: in-app notification, email, or both

**Navigation:** Inbox link in user avatar dropdown (above "My Profile").

##### Database Changes (migration 045)

```sql
-- Extend notifications table
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_user_id UUID REFERENCES users(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS interaction_id UUID REFERENCES interactions(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT;

-- User notification preferences
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,   -- mention, chase_alert, compliance, follow_up, etc.
  delivery_method VARCHAR(20) DEFAULT 'both'
    CHECK (delivery_method IN ('notification', 'email', 'both', 'none')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);
```

##### Notification Types (extended)

| Type | Source | Default Priority | Default Delivery | Escalates? |
|------|--------|-----------------|------------------|------------|
| `mention` | @mention in interaction | normal | both | Yes (4h) |
| `chase_alert` | Chase date due | normal | notification | Yes (4h) |
| `compliance` | Scheduled check | high | both | Yes (1h) |
| `hire_form` | Mid-tour driver submission | high | both | Yes (1h) |
| `referral` | Driver requires referral | high | both | Yes (1h) |
| `follow_up` | Retro / manual reminder | normal | notification | Yes (4h) |
| `system` | General system alerts | low | notification | No |

##### Escalation Scheduler

Runs every 15 minutes. Checks unread notifications and escalates based on priority:

| Priority | Email after | Notes |
|----------|------------|-------|
| Low | Never | Informational only |
| Normal | 4h (working hours) | Standard escalation |
| High | 1h (working hours) | Faster escalation |
| Urgent | Immediately | Pushes through regardless of working hours |

"Working hours" defaults to 08:00-18:00 Mon-Fri until staff calendar is built.
Respects `user_notification_preferences.delivery_method` — if user has set `notification` only for a type, email escalation is skipped.

##### @Mention Flow

1. User writes interaction on a job/person/org timeline, @mentions colleagues
2. System creates notification per mentionee: `type=mention`, `source_user_id=author`, `interaction_id=the interaction`
3. Mentionee sees it in bell dropdown + inbox page
4. Click → navigates to entity timeline, scrolled to that interaction
5. Reply = new interaction on same entity → original author gets notification
6. Sender can see read status in their "Sent" inbox view, and can "Nudge" unread recipients

##### Follow-Up Reminder Flow (Chase Pattern)

1. User creates follow-up (from retro modal, interaction form, or inbox "Remind me" button)
2. System creates notification: `type=follow_up`, `due_date=chosen date`, `snoozed_until=due_date`
3. Notification hidden from inbox until `snoozed_until` passes
4. On due date: notification appears in inbox + bell
5. User can: action it (acknowledge), snooze again (pick new date), or dismiss
6. Delivery method per user preference (notification, email, or both)

##### Nudge Flow

1. Sender opens "Sent" view in inbox → sees who has/hasn't read their mentions
2. Clicks "Nudge" on unread recipient → updates `nudged_at`, re-surfaces in recipient's bell
3. Nudge is manual only — no auto-nudge

##### Inbox Page (`/inbox`)

**Tabs:**
- **All** — everything unread + recent
- **Mentions** — @mentions from colleagues (type=mention)
- **Follow-ups** — reminders with due dates (type=follow_up), including upcoming ones
- **System** — compliance, chase alerts, hire form alerts

**Features:**
- Filter by read/unread, priority
- Acknowledge button (stronger than "mark read" — records `acknowledged_at`)
- Snooze button on any notification (pick future date)
- Reply to mentions inline (creates interaction on the linked entity)
- "Sent" section: mentions you've sent, with read/unread status per recipient + nudge button
- Notification preferences: per-type delivery method (notification / email / both / none)

**Badge:** Unread count shown on inbox link in user dropdown + bell icon (existing).

##### Implementation Phases

**Phase A — Migration + Backend Foundation** ✅ COMPLETE
- [x] Migration 045: extend notifications, create user_notification_preferences
- [x] Backend endpoints:
  - `GET /api/notifications/inbox` — paginated, filterable, supports tabs
  - `POST /api/notifications/:id/acknowledge` — mark as acknowledged
  - `POST /api/notifications/:id/snooze` — snooze with new due_date
  - `POST /api/notifications/:id/nudge` — sender nudges unread recipient
  - `GET /api/notifications/sent` — notifications created by current user, with read status
  - `POST /api/notifications/follow-up` — create follow-up reminder
  - `GET /api/notifications/preferences` — user's delivery preferences
  - `PUT /api/notifications/preferences` — update preferences
- [x] Extend existing notification creation points to populate new fields (source_user_id, interaction_id, action_url)

**Phase B — Inbox Page + Nav** ✅ COMPLETE
- [x] Inbox page at `/inbox` with All / Mentions / Follow-ups / System tabs
- [x] Inbox link in user avatar dropdown (above "My Profile")
- [x] Unread badge on inbox link
- [x] Acknowledge, snooze, dismiss actions
- [x] Click-through navigation to linked entities (action_url with entity fallback)

**Phase C — @Mention Improvements** ✅ COMPLETE
- [x] @mention autocomplete in interaction forms (type `@` → user picker dropdown) — already built in ActivityTimeline.tsx
- [x] Mention notifications include interaction content preview
- [x] Reply from inbox (creates interaction on linked entity)
- [x] "Sent" view with read receipts + nudge
- [x] Priority selector on @mentions (Normal / Important / Urgent) — controls escalation timing
- [x] Reply marks notification as Done + reply text shown inline on notification card

**Phase D — Escalation Scheduler** ✅ COMPLETE
- [x] Scheduler task (every 15 min): check unread notifications, send email based on priority + working hours
- [x] Respect user_notification_preferences for delivery method
- [x] Default working hours 08:00-18:00 Mon-Fri (configurable when staff calendar built)
- [x] Urgent priority bypasses working hours
- [x] Close-out requirement chase scanner (daily 09:30): scans overdue post-hire requirements, creates notifications, 24h dedup

**Phase E — Retro & Chase Integration** ✅ COMPLETE
- [x] Completion retro "follow up in X" creates follow_up notification with due_date (with date picker + 1m/3m/6m presets)
- [x] Client's upcoming jobs shown in completion modal (blue info box with future bookings)
- [x] Multi-reminder support: add multiple reminders, each with text, date, delivery method, priority, assigned user
- [x] Chase auto-mover creates inbox notifications with snooze support (targets last chase assignee or admins)
- [x] Reminder job requirement type (migration 047): add reminders to prep checklist with date, delivery, event triggers, multi-user assignment
- [x] Event trigger reminders (migration 048): `event_trigger` + `delivery_method` columns on `job_requirements`, fire notifications when job status matches trigger (confirmed/cancelled/lost), triggers fire in both pipeline.ts status changes and cancellations.ts cancellation flow
- [x] Per-reminder delivery enforcement: `delivery_method` (notification/email/both) respected when creating and escalating notifications — notification-only uses low priority (skips email escalation), email-only sends immediately, both uses normal escalation
- [x] Dedicated "+ Reminder" button at top of prep checklist (next to "+ Add Job Requirement")
- [x] Close-out chase scanner respects per-requirement delivery_method

**Phase F — Threaded Messaging Upgrade** ← MOSTLY SHIPPED (May 2026)

Closes the "one-way" gap in the current inbox: rolling conversations with replies, attachments, rich rendering, actionable system notifications, and integration with the Problems register. Full spec lives in `docs/MESSAGING-SPEC.md` — read that before touching code. Headline shape:

- **Threading on interactions** via `parent_interaction_id` (no parallel `conversations` table — extend what's there).
- **Attachments on interactions** via the existing `interactions.files` JSONB (already in migration 001, just needs wiring through the create endpoint and render layer).
- **Actionable notifications** via a new `notifications.actions` JSONB carrying a small whitelist of `kind`s (`mark_chased`, `complete_requirement`, `resend_email`, `snooze`, `mark_handled`).
- **Issue messaging** via `interactions.issue_id` — comments on `job_issues` move from `job_issue_events.comment` to real interactions, gain mentions / attachments / replies / escalation. IssueDetailPage merges typed events + interactions at render time.
- **Markdown-lite rendering** at display time: URL → link, `@user` → pill, `#NNNNN` → job link. Storage stays plain text.
- **Working agreements** (jon, May 2026): notify ALL prior thread participants on a reply (low priority, no email); per-recipient acknowledgement; issue messages do NOT bubble to vehicle / driver / org timelines; staff-only — no freelancer participation; no backfill of historical replies.

**What's shipped:**
- [x] **Phase A (foundation)** — migration 076 (parent_interaction_id, issue_id, actions); `POST /api/interactions` accepts `parent_interaction_id` + `attachments` + flattens to thread root + thread re-notify (low priority); new `GET /api/interactions/:id/thread`; `POST /api/files/upload?attachment_only=true` mode.
- [x] **Phase B (attachments + render polish)** — composer drag/drop + paste-to-attach for clipboard images (any composer surface); inline image thumbnails (authenticated via api.blob), file pills for non-images; URL / `@user` / `#NNNNN` linkification at render time. Shared primitives in `frontend/src/components/messaging/Attachments.tsx` (types + components + `useAttachments()` hook).
- [x] **Phase C (threaded ActivityTimeline)** — replies render nested under root, > 2 collapsed by default, inline Reply composer per thread with @mentions + attachments + paste.
- [x] **Phase D (Inbox thread view)** — `frontend/src/components/messaging/ThreadView.tsx` is the shared full-thread render (used by Inbox now, will be reused by IssueDetailPage in Stage 3). Replaces the old single-line `<input>` reply with a persistent threaded view: fetches `GET /api/interactions/:id/thread`, renders root + replies oldest-first with attachments, persistent reply composer at bottom with @mentions + paste + drop. Triggered by a "View thread" button on any notification with `interaction_id`.
- [x] **Phase E (actionable notifications)** — `POST /api/notifications/:id/action` endpoint with whitelist of internal handlers; first cut ships **3 server-side kinds**: `mark_chased` (logs a chase interaction + bumps next_chase_date with the sacred-future rule), `complete_requirement` (flips `job_requirements` → status=done with audit note), `mark_handled` (optional note → interaction). `snooze` and `resend_email` are deliberately NOT server kinds — `snooze` is a UI affordance handled client-side via the existing modal; `resend_email` deferred until we have a clear template list. Wired into the chase-alert scheduler (`mark_chased`) and the close-out / reminder requirement scanner (`complete_requirement`). Inbox renders the full action list inline with per-button loading state; NotificationBell renders the first action only (compact dropdown — full list is in the inbox).

**Round 2 polish shipped (May 2026, post-launch):**
- [x] **In-page image lightbox** — `<AttachmentImage>` was wrapping thumbnails in a plain `<a target=_blank>` to `/api/files/download`, which 401'd because browsers don't send the JWT on direct navigations. Replaced with an in-page modal using the same blob URL the thumbnail already has. `<AttachmentPill>` (non-image attachments) gained an authenticated `api.blob` fetch on click — PDFs preview in a new tab, other types trigger a real download with the proper filename.
- [x] **Mention emails fire at creation time** — bug: mentions get marked `is_read=true` within seconds when the user glances at the bell, so the 15-min escalator's `WHERE is_read=false` filter then skipped them and no email ever fired. Fix: send the mention email IMMEDIATELY at notification creation when the recipient's pref allows (`email` or `both`), and stamp `email_sent_at = NOW()` so the escalator doesn't double-fire later. Conversations always get the email, regardless of how quickly the bell was cleared. Thread re-notifies stay priority='low' / no email per spec.
- [x] **Lightweight emoji reactions** — migration 077: `reactions JSONB` on `interactions`. Curated 6-emoji palette (👍 ❤️ ✅ 😂 🎉 👀) enforced server-side via Zod. Toggle on/off per user via `POST /api/interactions/:id/reactions { emoji }`. **No notifications fire** — that's the point of the "I saw it, no further action needed" pattern. Shared `<Reactions>` component used in both ActivityTimeline (InteractionRow) and ThreadView.
- [x] **Inbox organisation** — search across title + content (debounced ILIKE), sort dropdown (Priority / Newest / Oldest), acknowledged-hidden by default with "Show done" toggle, "Clear read" button (bulk-acknowledges every read item in the current tab via `POST /api/notifications/bulk-acknowledge`, scope='read' so unread items are never touched).

**Round 3 polish shipped (May 2026):**
- [x] **Real-time inbox via Socket.io** — InboxPage now subscribes to the same `notification` socket channel the bell does. New mentions / chases / system alerts splice into the visible list when on page 1, no active search, and tab matches; tab counts update regardless. Subtleties: avoid double-insert on echo; only splice when conditions match (otherwise the user sees a count bump but the visible list stays predictable).
- [x] **Thread root preview in re-notify cards** — "Pete replied in a thread you're in" used to show only Pete's reply, leaving the user no idea what the thread was *about* without expanding. The inbox query now LEFT JOINs `interactions reply` → `interactions root` (via `parent_interaction_id`) and surfaces `thread_root_preview` + `thread_root_author`. Rendered as a dim italic quote above the reply preview. Skipped when the notification points at the root itself (no quote needed).
- [x] **Date headings on inbox** — "Today / Yesterday / Earlier this week / Earlier this month / Older" sticky-style section labels. Only when sort is `newest` or `oldest` (priority sort interleaves dates so headings would mislead). Bucket calculated from `created_at`, single pass through the array during render.
- [x] **Smarter snooze presets** — "2 hours / Tomorrow morning / Monday morning / 3 days / 1 week / 2 weeks" plus a `<input type="datetime-local">` for "pick exact moment". `nextWorkdayMorningISO()` helper resolves "next 8am" / "next Monday 8am" in local time. The `snooze_until` endpoint already accepted any ISO string — backend unchanged.
- [x] **Group by entity (toggle)** — `Group by job` checkbox in the toolbar. When on, adjacent runs of notifications sharing `entity_type+entity_id` collapse into one card showing "5 notifications on this job [3 unread]" with show/hide. Adjacency-only — sort changes can split a group apart, intentional (avoids reordering surprises). Off by default.
- [x] **Mute thread** — migration 080: `user_muted_threads` table, primary key `(user_id, root_interaction_id)`. New `POST /api/interactions/:id/mute { muted: bool }` walks to the thread root and toggles. The thread re-notify path checks `user_muted_threads` per-recipient and skips muted users. **Direct @mentions still fire** even on muted threads — if someone calls for your attention, you see it. `<ThreadView>` renders a 🔔 Mute / 🔕 Muted toggle next to the Done/Snooze buttons.
- [x] **Undo toast for Done + Clear-read** — 5-second toast at the bottom of the inbox with `[Undo]` button. Single-Done undo via new `POST /api/notifications/:id/unacknowledge` (also reverses the reminder-requirement cascade). Bulk-Clear undo via `POST /api/notifications/bulk-unacknowledge { ids }`. Bulk-acknowledge endpoint now returns the actual `ids` array so the frontend can hand them back. Idempotent — replaying undo on an already-unacknowledged row is safe.
- [x] **Composer textarea resize handle** — `resize-y` + `min-h-[64px]` on the three message composers (top-level + reply on ActivityTimeline, ThreadView reply). Drag the bottom-right corner to expand for long replies.

**Still TODO under Phase F:**
- [ ] **Problems integration** — `POST /api/problems/:id/comments` repointed to write through `interactions` (with `issue_id` set). IssueDetailPage merges typed events + interactions at render time, reusing `<ThreadView>`. Concrete plan:
  1. Migration: no schema changes needed (migration 076 already added `interactions.issue_id`).
  2. **Repoint** `routes/problems.ts:/:id/comments` POST handler: instead of writing a row to `job_issue_events` directly, do `POST /api/interactions` (server-internal call or shared helper) with `{ type: 'note', issue_id, job_id (inherited from issue), content, mentioned_user_ids, attachments }`. Then write a marker row to `job_issue_events` with `event_type='comment'` and `metadata: { interaction_id: <new uuid> }` for audit continuity.
  3. **IssueDetailPage** merges streams: fetches `GET /api/interactions?issue_id=:id` alongside the existing `job_issue_events` query. Render in chronological order — typed events render as terse pill rows (status_change, severity_change), interactions render via `<ThreadView>` for the most recent comment thread + collapsed older ones. The `interactions.ts` GET already exposes `issue_id` as a filter.
  4. **Critical scoping rule (already in place):** `GET /api/interactions` filters `issue_id IS NULL` on person/org/venue/job-without-include_issues reads. Issue chatter does NOT bubble to the linked vehicle / driver / organisation timelines. Verify before shipping that no entity-timeline reads have been added since Phase A without that guard.
  5. **Notifications:** mention notifications already work for issue interactions (entity_type='job_issues', entity_id=issue.id, action_url='/operations/problems/<issue.id>'). No additional wiring needed — the `interactions.ts` POST handler already routes correctly when `issue_id` is set.
  6. **Don't break existing comments:** the `job_issue_events.comment` column stays — historical comments stay readable. New comments live in `interactions`; the IssueDetailPage merge handles both.
- [ ] **`resend_email` action kind** — once a clear set of templates benefit from a one-click resend (hire form, OOH info, payment confirmation, etc.).

Phased plan in `docs/MESSAGING-SPEC.md`. Phase G (email reply ingestion via `reply+<id>@oooshtours.co.uk`) is captured in spec but deferred.

**Round 4 backlog (captured, not shipped):**
- Real-time updates in Inbox for the Sent tab (currently Sent doesn't refresh on socket events — minor).
- Sender-side reply tracking from Sent tab using `<ThreadView>` (currently Sent shows only nudge button, not the thread).
- Keyboard shortcuts (j/k/e/s) — power-user nicety, defer until volume justifies it.
- Per-channel notification preferences (bell-only / email-only toggles instead of the 4-option dropdown).

##### Future Enhancements
- Staff working calendar integration (escalation timing based on actual schedules)
- Group mentions (@warehouse, @office — mention a role/team, not just individuals)
- File attachments in interaction messages (interactions already support files)
- Notification digest email (daily summary instead of per-notification)
- Mobile push notifications (if mobile app/PWA built)
- Tasks system (general-purpose tasks linked to inbox — freelancer application review, annual reviews, admin tasks)

#### Step 8: Warehouse Module — Customer Collections ✅ LIVE (May 2026)

In-person sign-off tool for clients picking up equipment at the warehouse. Replaces the standalone Monday-driven module that previously lived in the Next.js freelancer portal at `ooosh-freelancer-portal.netlify.app/warehouse`. Single OP module now, single auth, single deploy.

**Where:** `staff.oooshtours.co.uk/warehouse` — three kiosk-mode routes mounted **outside** the `<Layout>` wrapper (no nav shell, tablet-friendly):
- `/warehouse` — PIN entry (`WarehousePinPage.tsx`)
- `/warehouse/collections` — list of jobs ready for pickup (`WarehouseCollectionsPage.tsx`)
- `/warehouse/collections/:jobId` — equipment review + signature + complete (`WarehouseCollectionDetailPage.tsx`)

**Auth:** `POST /api/warehouse/auth/pin` validates the kiosk PIN (`WAREHOUSE_PIN` env var) and returns a 12h `warehouse_session` JWT, stored in `sessionStorage` via `services/warehouseSession.ts`. Staff JWTs also accepted on the same routes — desk users can drive it from desktop without re-PINning. Distinct from the staff Zustand store so kiosk and staff sessions don't pollute each other.

**Backend:** `backend/src/routes/warehouse.ts` mounted at `/api/warehouse`. Four endpoints:
- `POST /auth/pin` — public, exchanges PIN for warehouse session JWT
- `GET /collections` — list candidates (PIN or staff JWT)
- `GET /collections/:jobId` — job + equipment list
- `POST /collections/:jobId/complete` — sign-off action

**Candidate filter** (Monday Q&H board → OP `jobs` table):
```
pipeline_status IN ('confirmed', 'prepped', 'prepping')
  AND out_date BETWEEN today-1 AND today+1
  AND HireHop COLLECT = 0
```
The `prepping` (HH 4 / Part Dispatched) inclusion handles the edge case of a job already being part-scanned when the customer signs. The OP↔HH semantic gap (HH jumps to 5 on physical checkout but OP holds at `prepped` until staff explicitly dispatches) is exactly what this list covers — anything in `prepped` with HH at 5 is "ready for sign-off". Customer-collect filter via per-candidate `job_data.php` call (broker-cached, fail-open if HH unreachable).

**On sign-off:**
1. Signature → R2 at `warehouse-collections/{jobId}/signature-{ts}.png`
2. Delivery note PDF (reuses `services/delivery-note-pdf.ts` — same artefact the freelancer portal D&C completion uses) → R2 + appended to `jobs.files` JSONB so it appears on the **Files tab** of the job
3. PDF emailed to recipients via `emailService.send('delivery_note')` (existing template)
4. `pipeline_status` → `dispatched` + HH writeback to status 5 (no-op if already at 5)
5. `interaction` logged on the Activity Timeline (`type='note'`, content `📦 Equipment collected at HH:MM by [name]. Delivery note emailed to [recipients].`)

**Writeback addition:** `PIPELINE_TO_HH` map in `services/hirehop-writeback.ts` gained `dispatched: 5`. Previously absent because HH normally auto-jumps to 5 on physical checkout; the warehouse flow is the origin event, not a mirror, so the push is needed. The "skip if already at target" guard makes this safe for all callers.

**Env vars:**
- `WAREHOUSE_PIN` — required (4-8 digit PIN, set in OP backend `.env`); endpoint returns 503 without it.

**Audit attribution:** PIN-only sessions log interactions as the system service user (UUID `00000000-0000-0000-0000-000000000000` from migration 031). Staff JWT sessions attribute to the actual user.

**Tear-down:** Legacy `src/app/warehouse/*` and `src/app/api/warehouse/*` pages + routes deleted from the Next.js portal. `netlify.toml` has a 301 redirect from `/warehouse[/*]` → `https://staff.oooshtours.co.uk/warehouse` for any latent tablet bookmarks. `MONDAY_API_TOKEN` in the Next.js portal is now warehouse-unused (still used by other freelancer-portal flows pre-repoint).

**Nav:** "Warehouse Collections" link added to Operations submenu (between Backline and Issues). Clicking takes staff to the same kiosk-style page the iPad uses — they're already authenticated via staff JWT so no PIN needed. To return to the OP nav, use browser back.

**Future enhancements (deferred):**
- "Recent collections" / "Customer-collected" filter on Jobs + Returns pages — would surface a `collect_method` column on `jobs` (HH `COLLECT` field synced down: 0=customer, 1=we deliver, 2=courier, 3=other) and add a filter pill + Job Detail header pip. Discussed May 2026, parked in favour of higher-value work.
