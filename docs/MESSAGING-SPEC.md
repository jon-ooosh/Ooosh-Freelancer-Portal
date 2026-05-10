# Messaging & Inbox Upgrade — Spec

**Status (May 2026):**
- **Phase A (threading) — SHIPPED.** Migration 076; `parent_interaction_id` + `attachments` on `POST /api/interactions`; `GET /api/interactions/:id/thread`; thread re-notify (low priority).
- **Phase B (attachments + render polish) — SHIPPED.** `attachment_only=true` upload mode; `useAttachments()` hook; markdown-lite linkification.
- **Phase C (threaded ActivityTimeline) — SHIPPED.** Nested replies, collapsed-by-default threads, inline reply composer.
- **Phase D (Inbox thread view) — SHIPPED.** `<ThreadView>` component; "View thread" expansion replaces single-line reply.
- **Phase E (actionable notifications) — SHIPPED.** `POST /api/notifications/:id/action` with three server kinds (`mark_chased`, `complete_requirement`, `mark_handled`).
- **Phase F (Problems integration) — TODO, BLOCKED ON PARALLEL ISSUES WORK.** Concrete plan now in `CLAUDE.md` §Step 7 Phase F "Still TODO" subsection.
- **Phase G (email reply ingestion) — DEFERRED.** Captured in §7 below; no plans to build until a clear pain point lands.

**Beyond the original spec, also shipped:**
- Lightweight emoji reactions (migration 077, `<Reactions>` component, curated 6-emoji palette) — no notifications fire on reactions; the lightweight "I saw it" pattern.
- Mention emails fire at notification creation time when the recipient's pref allows (not via the 15-min escalator) — the escalator was being silently skipped because users read mentions via the bell within seconds.
- Inbox tooling: search across title/content, sort dropdown (Priority / Newest / Oldest), default-hide acknowledged with "Show done" toggle, "Clear read" bulk-acknowledge action (scope='read' to stay safe).
- Real-time inbox updates via the same Socket.io channel the bell uses.
- Thread root preview rendered as a dim quote on "replied in a thread" cards.
- Date headings on inbox list when sorted by date.
- Smarter snooze presets (Tomorrow morning / Monday morning / 2h / 1w / 2w / pick exact moment).
- Group-by-entity toggle (collapse adjacent same-entity rows into one card with show/hide).
- Mute thread (migration 080, `user_muted_threads` table, per-user toggle in `<ThreadView>`). Suppresses thread re-notifies only — direct @mentions still fire.
- Undo toast (5-second window) on Done + Clear-read; new `POST /api/notifications/:id/unacknowledge` and `/bulk-unacknowledge` endpoints.
- Composer textarea resize handle (`resize-y` + `min-h-[64px]` on all message composers).

The narrative below is the original design doc — preserved for context. Up-to-date implementation status lives in CLAUDE.md.

**Owner of this doc:** the next Claude / engineer who picks this up.
**Related:** CLAUDE.md §Step 7 (Inbox & Notification System), §Step 4 Job Issues / Problems register.

## 1. Why we're doing this

The current inbox is "one-way": you can fire a mention at a colleague, escalate it to email if it goes unread, and they can mark it acknowledged. What you can't do:

- **Reply to a mention as a continuing conversation.** The Inbox "Reply" button creates a new sibling interaction on the entity's timeline and acknowledges the original. From the third turn onwards the thread is impossible to follow chronologically.
- **Attach files / photos to a message.** Interactions are plain text. File uploads go to a separate `files JSONB` on the entity and emit a companion "📎 Uploaded file: …" interaction — files and conversations are parallel, not joined.
- **Render rich content.** No URL linkification, no `@user` pills, no `#hh-job-number` shortcuts, no inline image preview.
- **Action a notification in place.** A chase / compliance / close-out alert opens a card with a deep link. To act on it you navigate to the entity, find the thing, change it, navigate back. There's no "Mark done", "Mark chased", "Resend now" button on the notification itself.
- **Have rolling conversations on issues.** The Problems register's `job_issue_events` table has a free-text `comment` event type but those comments don't surface in the inbox, can't be `@mentioned` to, can't carry attachments, and don't escalate.

The Monday.com system this replaces had a usable conversation primitive. Until we close the gap, staff are still using WhatsApp / email for the actual back-and-forth and OP only ends up with the summary.

## 2. Design principles

1. **Entity-anchored, no DMs.** Every conversation has a subject — job, person, organisation, venue, or issue. Ooosh is a CRM; "DM Pete about whatever" loses context. Stays this way.
2. **Threads on top of interactions, not a parallel table.** Interactions are already the activity record. Adding `parent_interaction_id` is a smaller surface than a separate `messages` / `conversations` table and keeps the timeline as the single read path.
3. **Notifications are derived, not authoritative.** Acknowledging a notification doesn't acknowledge anyone else's; it doesn't close the conversation. The conversation lives in interactions.
4. **Staff-only.** Freelancers do not see this system. No `share_with_freelancer` plumbing on interactions; no portal endpoints. Confirmed with jon May 2026.
5. **No backfill of historical replies.** What's done is done — old "reply"-style sibling interactions stay flat. New replies thread.
6. **Render polish is cheap, schema changes are forever.** We do markdown-lite rendering (URL / mention / job-number) on the frontend at display time, leaving stored content as plain text so existing search keeps working.

## 3. What we explicitly are NOT building

- A separate messaging / conversations table.
- Reactions, emoji, read receipts beyond per-recipient acknowledgement.
- Email reply ingestion (`reply+<id>@oooshtours.co.uk` → inbound webhook). Captured as Phase F, deferred until the rest is bedded in.
- Group / channel concepts ("#warehouse"). Mentioning a role-team is a future-enhancement listed in Step 7.
- Freelancer participation in messaging.
- DMs (person-to-person without an entity subject).

## 4. Data model changes

### 4.1 Migration 076 — Threading + actions + issue linkage

```sql
-- Threading on interactions
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS parent_interaction_id UUID
    REFERENCES interactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_parent
  ON interactions (parent_interaction_id)
  WHERE parent_interaction_id IS NOT NULL;

-- Issue linkage (anchors a message to a job_issues row)
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS issue_id UUID
    REFERENCES job_issues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_issue
  ON interactions (issue_id)
  WHERE issue_id IS NOT NULL;

-- Actionable notifications: array of {label, endpoint, method, body, success_message}
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '[]';
```

**Notes on column choices:**

- `parent_interaction_id ON DELETE SET NULL` — soft-detaching an orphaned reply is preferable to losing it. We don't expect to delete interactions in practice (they're audit trail), but the FK behaviour matters for GDPR / merge cases.
- `issue_id` is nullable because most messages aren't on issues. When set, the message is scoped to the issue (does NOT bubble to the linked vehicle/driver/org timelines — see §6.3).
- `actions` defaults to `[]` so existing notification creation code that doesn't supply it stays valid.

### 4.2 No new columns on `notifications` for threading

A reply re-notifies all prior thread participants by creating fresh `notifications` rows with `interaction_id` pointing at the *new reply* (not the thread root). Clicking a notification opens the thread scrolled to that reply. The thread is reconstructed at read-time by walking `parent_interaction_id` from the leaf back to the root.

This means thread membership ("everyone who's been in this thread") is computed by querying `interactions` where `parent_interaction_id` traces back to the same root, plus the root's author and `mentioned_user_ids`. We don't denormalise a `participants` array — the read query is small and bounded by thread length, and a denorm column would drift.

### 4.3 Interaction `files` column — already exists

Migration 001 already gives us `interactions.files JSONB DEFAULT '[]'`. The redesign uses it. No schema change needed; we just have to populate it from the create / reply endpoints and render it on read.

Each entry shape (existing convention from `routes/files.ts`):
```json
{
  "r2_key": "files/...",
  "filename": "wing-mirror.jpg",
  "content_type": "image/jpeg",
  "size_bytes": 482917,
  "uploaded_at": "2026-05-06T10:23:00Z",
  "uploaded_by": "<user-uuid>",
  "thumbnail_key": null
}
```

`thumbnail_key` is optional — generated lazily on first render for image types. If the field is absent or null, the frontend renders a generic file pill.

## 5. API changes

### 5.1 `POST /api/interactions` — extend

Accept two new optional fields:

```ts
{
  // existing fields…
  parent_interaction_id?: string,    // UUID; if set, this is a reply
  attachments?: Array<{              // appended to interactions.files
    r2_key: string,
    filename: string,
    content_type: string,
    size_bytes: number
  }>
}
```

Behaviour:

- If `parent_interaction_id` is set, the new interaction MUST inherit the parent's anchor (same `job_id` / `person_id` / `organisation_id` / `venue_id` / `issue_id`). The endpoint validates this rather than accepting whatever the client sends — guards against accidental "reply to job A's thread on job B's timeline".
- Mention notifications fire as today for explicitly `@mentioned` users.
- **Thread re-notify (per jon, May 2026):** if `parent_interaction_id` is set, the endpoint also creates **low-priority** notifications for everyone earlier in the thread (root author + every prior reply author + everyone previously mentioned), deduped, excluding the new reply's own author. Low priority means they never trigger email escalation — pure in-app.
  - Title format: `"<Author> replied in a thread you're in"`
  - `interaction_id` points at the new reply, so click-through opens the thread scrolled to it.
  - `entity_type` / `entity_id` / `action_url` mirror the reply's anchor.

### 5.2 `GET /api/interactions/:id/thread` — new

Returns the full thread (root + all descendants, depth-first) for rendering in the Inbox or "Show full thread" expansion on the timeline.

```ts
GET /api/interactions/:id/thread
→ {
    root: Interaction,
    replies: Interaction[],   // ordered by created_at ASC
    participants: User[]      // distinct authors + mentioned users, lightweight {id, name, email}
  }
```

`:id` can be ANY interaction in the thread — endpoint walks to the root and returns from there. Caller doesn't need to know which one is the root.

### 5.3 `POST /api/notifications/:id/action` — new

Generic action runner for actionable notifications. Given a notification with a non-empty `actions` JSONB, the client posts:

```ts
POST /api/notifications/:id/action
Body: { action_index: number, body_override?: object }
→ { success: true, notification: Notification }
```

Server reads `notifications.actions[action_index]`, validates it's still applicable (the notification isn't already acknowledged), executes the corresponding internal handler, and on success marks the notification acknowledged.

**The actions are not free-form HTTP calls.** Each entry is `{ kind: string, params: object, label: string, success_message?: string }` where `kind` is a short whitelist of internal handlers:

| `kind` | What it does | `params` shape |
|---|---|---|
| `mark_chased` | Creates a chase interaction on the linked job | `{ method?: 'phone'\|'email'\|'text'\|'whatsapp', skip_chase_bump?: boolean }` |
| `complete_requirement` | PATCHes a job_requirements row to status=done | `{ requirement_id: string }` |
| `resend_email` | Re-fires a known email template (hire-form etc.) | `{ template: string, job_id: string }` |
| `snooze` | Snoozes the notification itself | `{ days: number }` |
| `mark_handled` | Pure acknowledgement with optional note → creates an interaction | `{ note?: string }` |

Whitelisted kinds keep the surface auditable and prevent the Inbox from becoming an arbitrary RPC channel. Adding a new kind requires a code change, on purpose.

### 5.4 `POST /api/files/upload` — extend

Already accepts `entity_type=interactions`. We need it to accept an `attachment_only=true` flag that returns the R2 key + metadata WITHOUT creating the entity-side file row, so the caller can hold onto the metadata and pass it to `POST /api/interactions` as part of the `attachments` array. This avoids the awkward "upload first → get a file id → also append to entity files → also write a companion interaction" loop that exists today.

```ts
POST /api/files/upload?attachment_only=true
→ { r2_key, filename, content_type, size_bytes, thumbnail_key? }
```

When `attachment_only=true`, the endpoint:
- Uploads to R2 as normal.
- Does NOT modify any entity's `files` JSONB.
- Does NOT create a companion interaction.
- Returns the metadata blob the caller passes verbatim into `attachments` on the next `POST /api/interactions`.

The non-flag path is unchanged for backwards compatibility with the existing Files tab uploaders.

### 5.5 `POST /api/issues/:id/comments` — repoint

Today `routes/problems.ts` writes a free-text `comment` event to `job_issue_events`. We change it to:

1. Create an `interaction` row with `issue_id = :id`, `job_id` inherited from the issue, `type = 'note'`, content = comment body, attachments + mentions as supplied.
2. Write a `job_issue_events` row of type `comment` with `metadata = { interaction_id: <new uuid> }` so the audit timeline still has a typed marker.

The IssueDetailPage merges the two streams (typed events + interactions joined by `issue_id`) at render time, so the user-facing timeline doesn't change shape — comments just gain mentions, attachments, and threading.

The endpoint signature changes to accept the same payload as `POST /api/interactions`:

```ts
POST /api/issues/:id/comments
Body: {
  content: string,
  parent_interaction_id?: string,
  mentioned_user_ids?: string[],
  attachments?: Array<{r2_key, filename, content_type, size_bytes}>
}
```

## 6. Frontend changes

### 6.1 `InboxPage.tsx`

**Replace single-shot "Reply" with persistent thread view.** When opening a notification of `type='mention'` or any notification with `interaction_id` set:

- Fetch `GET /api/interactions/:id/thread` for the linked interaction.
- Render full thread (root + replies, oldest-first, threaded indentation by author OR flat with author labels — flat is simpler and probably enough).
- Reply box stays open continuously below the thread. Submitting posts a new reply (same endpoint, `parent_interaction_id` set to the thread root).
- Acknowledge / snooze / nudge actions sit alongside the reply box (current behaviour).

Acknowledge in this view = "I'm done with this thread for now" — per recipient, doesn't close it for anyone else. Confirmed with jon.

For non-mention notifications (chase, compliance, follow-up, system) without an `interaction_id`: no thread view, current single-card UI applies, with the new actionable buttons (§6.4) on top.

### 6.2 `ActivityTimeline.tsx`

- **Threaded rendering.** Group sibling interactions under their root via `parent_interaction_id`. Show first reply inline; "Show N more replies" expands the rest. A "Reply" button on every interaction opens an inline composer that pre-sets `parent_interaction_id`.
- **"Messages only" filter toggle.** Adds a filter pill that narrows to `type IN ('note', 'mention')` AND drops system events (status_transition, file uploads). Default off.
- **Drag-zone in composer.** Files dropped on the composer upload via `attachment_only=true` and become attachments on the new interaction. Visible thumbnail strip above the textarea while composing.
- **Render layer:** URL → `<a>`, `@username` → `<UserPill>`, `#NNNNN` (5+ digits matching a known HH job number on this entity OR linked to one) → `<JobLink>`. All client-side at render time.
- **Drop the companion `📎 Uploaded file: …` interactions for attachment-uploads going forward.** The Files tab still lists them via the entity's `files` JSONB; a file-upload event on the timeline becomes a small typed marker rather than a fake interaction. (Files tab uploads — i.e. uploads that aren't an attachment to a message — keep the companion interaction as today.)

### 6.3 `IssueDetailPage.tsx`

- Existing event timeline merges with interactions joined by `issue_id`. Render order: chronological. Typed events (status_change, severity_change, etc.) render as terse pill rows; `comment`-kind events render as full interaction cards (with mentions / attachments / replies / threading).
- Comment composer uses the same component as ActivityTimeline.tsx — shared primitive.
- **Issue messages do NOT bubble up to the linked vehicle / driver / org timelines.** Per jon May 2026: keeps noise off vehicle pages. The cross-link is via the IssueDetailPage's own anchors (clickable Vehicle / Driver / Person chips at the top) and via Vehicle/Org Detail's "Issues" tab. Concretely: `ActivityTimeline` queries on `vehicle_id` / `organisation_id` / `person_id` MUST NOT include rows where `issue_id IS NOT NULL`. Easy filter on the read query.

### 6.4 `NotificationBell.tsx`

Minor. Render the actionable button stack inline on each card if `notifications.actions` is non-empty (max 2 buttons; if more, show first + "More options" → opens InboxPage). Otherwise unchanged — it stays the quick-peek surface.

### 6.5 New component: `<ThreadView>`

Shared between InboxPage and IssueDetailPage. Props:

```tsx
<ThreadView
  rootInteractionId={uuid}
  onReply={(content, attachments, mentions) => void}
  showAcknowledge={boolean}
  showSnooze={boolean}
/>
```

Renders root + replies, attachments inline, mentions as pills. Reply composer below. Used anywhere we want to open a thread; future surfaces (e.g. a "Conversations" filter on Job Detail) reuse it.

## 7. Phased plan

| Phase | Scope | Files touched | Size |
|---|---|---|---|
| **A** | Migration 076 (parent_interaction_id, issue_id, actions). Extend `POST /api/interactions` to accept `parent_interaction_id` + `attachments`. New `GET /api/interactions/:id/thread`. Thread re-notify logic (low priority). | `migrations/076_*.sql`, `routes/interactions.ts` | medium |
| **B** | Extend `POST /api/files/upload` with `attachment_only=true` mode. Frontend: composer drag-zone, attachment thumbnail strip, attachment render in InboxPage + ActivityTimeline. | `routes/files.ts`, `ActivityTimeline.tsx`, `InboxPage.tsx`, `FileUpload.tsx` (or new sibling) | medium |
| **C** | Threaded rendering on ActivityTimeline (parent grouping, "Show N more replies" expand, inline Reply composer). Render layer: URL linkify + `@user` pill + `#NNNNN` job link. | `ActivityTimeline.tsx` + small render utility module | medium |
| **D** | Replace InboxPage single-shot reply with `<ThreadView>`. Fetch thread on open. Persistent reply composer. | `InboxPage.tsx`, new `<ThreadView>` component | medium |
| **E** | Actionable notifications. `POST /api/notifications/:id/action` endpoint with the 5 whitelisted `kind`s. Inbox + Bell render buttons. Wire chase / requirement-done / resend / snooze / mark-handled as the first batch. | `routes/notifications.ts`, `InboxPage.tsx`, `NotificationBell.tsx` | medium |
| **F** | Problems integration. Repoint `POST /api/issues/:id/comments` to write interactions + a typed event. IssueDetailPage merges streams, renders via `<ThreadView>`. Filter `issue_id IS NOT NULL` out of vehicle/driver/org timeline reads. | `routes/problems.ts`, `IssueDetailPage.tsx`, `ActivityTimeline.tsx` read query | medium |
| **G** (deferred) | Email reply ingestion. Reply-to address per notification email, MX catch-all, inbound parser, post-back as thread reply. | new `routes/inbound-mail.ts`, MX / DNS infra, mail parser | large, defer |

A and B can ship together (A is the schema + backend, B is the wiring on top). C-D-E-F can interleave once A/B land.

**Migration safety:** The new columns are all nullable / defaulted. Existing notification-creation code paths in pipeline.ts / cancellations.ts / hire-forms.ts / scheduler.ts continue to work without modification — they just don't emit `actions`, which renders as no buttons in the inbox (current behaviour).

## 8. Open implementation details — to settle while building

These are the calls I'm not making in advance because they're better answered against real code:

1. **Thread depth limit.** Slack picks one level (any reply on a thread becomes a top-level child of root). Keeps reads simple. I'd lean the same way — `parent_interaction_id` always points at the root, never at another reply. Build code can enforce by collapsing on insert: if the supplied `parent_interaction_id` itself has a non-null `parent_interaction_id`, set the new row's parent to the GREAT-grandparent (root). Decide on first build pass.

2. **Mention dedup across thread.** If Pete @mentions Jon in the root AND again in a reply, does Jon get two notifications? My instinct: yes, per-message mention is its own signal. But thread re-notify (low priority) shouldn't fire ON TOP of an explicit mention notification (high/normal priority) — dedupe by interaction_id at notification-create time.

3. **Attachment lifecycle on delete.** If we ever delete an interaction, what happens to its attachment R2 keys? Currently file deletion on entity removal isn't strictly enforced anywhere — flagged in CLAUDE.md as an existing gap. I'd say don't make this worse: leave attachment keys orphaned in R2 for now, address holistically when the broader file-cleanup pass happens.

4. **Search.** Plain-text storage means the existing global search keeps working. Mention pills / URLs in stored content stay as raw `@username` / `https://...` strings, which is fine. No work needed.

5. **Thumbnail generation.** First render of an image attachment generates a thumbnail and writes back `thumbnail_key`. Cheap (sharp library, in-process). Skip on initial build if it slows phase B; serve full-resolution under a constrained `<img>` and add thumbs later.

6. **`<ThreadView>` placement on Job Detail.** Step 7 talks about a "Messages only" filter on the timeline. I'd start with just the filter and not a separate tab. If staff actually want a dedicated Messages tab (vs. a filtered timeline view) we add it after the dust settles.

## 9. Working agreements (per jon, May 2026)

- Thread re-notify: notify ALL prior participants (root author + every prior reply author + every prior mentioned user), low-priority, no email.
- Acknowledgement: per-recipient. No "close thread for everyone".
- Issue scoping: messages on an issue stay on the issue. Don't bubble to vehicle / driver / org timelines.
- Freelancers: not in scope. Staff-only system. No `share_with_freelancer` on interactions.
- Backfill: skip. New conversations thread; old ones stay flat.
- Escalation paths beyond "informal conversation" (proper damage claim, formal dispute, etc.) get promoted to a Job Issue / Problem record using the existing register, then conversation continues on the issue.

## 10. Definition of done

- A staff user can `@mention` a colleague on a job, attach a photo, the colleague sees a notification, opens the inbox, sees the photo inline, replies with their own attachment, the original sender gets re-notified low-priority, and the whole exchange renders threaded on the job's timeline under the original message.
- A chase / compliance / close-out notification surfaces with one or two action buttons; clicking does the thing and acknowledges in one click.
- A comment on a job issue carries mentions + attachments + replies + escalation, surfaces in the relevant inboxes, and does not bubble to the vehicle's own timeline.
- Old (pre-launch) interactions still render normally; they just don't thread.
- Freelancers see no change — none of this surfaces in the portal.
