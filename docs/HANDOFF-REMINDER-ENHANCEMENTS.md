# Handoff Spec: Event Trigger Reminders + Per-Reminder Delivery + Reminder Button Position

## Context
The Ooosh Operations Platform has a working inbox/notification system with "Reminder" job requirements. Two features are captured in the UI but not yet enforced in the backend. Plus a minor UX fix.

## Task 1: Event Trigger Reminders

### What exists
- `JobDetailPage.tsx` (line ~4266): Reminder form has an "Also notify me if..." dropdown with options: `confirmed`, `cancelled`, `lost`
- When the user selects a trigger, it's stored in the requirement's `notes` field as `Trigger: confirmed` (text, not structured)
- `job_requirements` table has: `id`, `job_id`, `requirement_type`, `status`, `notes`, `assigned_to`, `due_date`, `custom_label`

### What needs building

**Migration 048:** Add `event_trigger` and `delivery_method` columns to `job_requirements`:
```sql
ALTER TABLE job_requirements ADD COLUMN IF NOT EXISTS event_trigger VARCHAR(30);
-- Values: NULL, 'confirmed', 'cancelled', 'lost'
ALTER TABLE job_requirements ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) DEFAULT 'both';
-- Values: 'notification', 'email', 'both'
```
Add filename to hardcoded array in `backend/src/migrations/run.ts`.

**Frontend changes (`JobDetailPage.tsx`):**
- Update `createReminder()` (line ~3967) to pass `event_trigger` and `delivery_method` as structured fields instead of encoding in notes text
- Update `addRequirementSchema` acceptance in backend

**Backend changes (`routes/requirements.ts`):**
- Add `event_trigger` and `delivery_method` to `addRequirementSchema` (line ~224)
- Store them as columns, not in notes text

**Backend changes (`routes/pipeline.ts`):**
- In the status transition handler (`PATCH /:id/status`, line ~437), after updating the job status, check for reminder requirements with matching `event_trigger`:
```typescript
// After status update succeeds, check for event-triggered reminders
if (['confirmed', 'cancelled', 'lost'].includes(pipeline_status)) {
  const triggered = await query(
    `SELECT jr.id, jr.custom_label, jr.assigned_to, jr.notes, jr.delivery_method, jr.job_id
     FROM job_requirements jr
     WHERE jr.job_id = $1
       AND jr.requirement_type = 'reminder'
       AND jr.event_trigger = $2
       AND jr.status != 'done'`,
    [jobId, pipeline_status]
  );
  
  for (const rem of triggered.rows) {
    // Create notification for assigned user (or the current user if no assignee)
    const targetUserId = rem.assigned_to || req.user!.id;
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'follow_up', $2, $3, 'jobs', $4, $5, 'high')`,
      [targetUserId, `Reminder triggered: ${rem.custom_label}`, 
       `Job ${pipeline_status} — ${rem.custom_label}`, rem.job_id, `/jobs/${rem.job_id}?tab=timeline`]
    );
    // Mark the reminder as done
    await query(`UPDATE job_requirements SET status = 'done', updated_at = NOW() WHERE id = $1`, [rem.id]);
  }
}
```

**Also fire triggers in `routes/cancellations.ts`** — the cancellation flow sets `pipeline_status = 'cancelled'` directly, bypassing the normal status transition. Add the same event trigger check there.

### RequirementCard display
In `RequirementCard.tsx`, the reminder rendering (line ~477) should show the event trigger if set:
```tsx
{req.event_trigger && (
  <div className="text-[10px] text-purple-600">
    Triggers on: job {req.event_trigger}
  </div>
)}
```

## Task 2: Per-Reminder Delivery Method Enforcement

### What exists
- The escalation scheduler (`services/notification-escalation.ts`) sends emails based on `user_notification_preferences` table (global per-type)
- Individual reminders capture delivery preference in UI but it's stored as notes text

### What needs building

**With the new `delivery_method` column from Task 1:**
- When creating notifications from event triggers or due-date reminders, check the `delivery_method` on the requirement
- If `delivery_method = 'notification'`: create notification but DON'T send email (set a flag or check in escalation)
- If `delivery_method = 'email'`: send email immediately, still create notification
- If `delivery_method = 'both'`: normal behaviour (create notification, email escalates per priority)

**Approach:** The simplest way is to set the notification's priority based on delivery_method:
- `notification` only → set priority to `low` (escalation scheduler never emails low priority)
- `email` only → send email immediately on creation + set notification as already emailed (`email_sent_at = NOW()`)
- `both` → normal priority, escalation scheduler handles it

**Also apply to the close-out chase scanner** (`config/scheduler.ts`, the 09:30 daily scan): when creating notifications for overdue requirements, check the requirement's `delivery_method`.

## Task 3: Move Reminder Button to Top

### What needs changing
In `JobDetailPage.tsx`, the "Add Job Requirement" dropdown menu currently shows templates first, then individual types in sort order. The "Reminder" type (sort_order 260) appears at the bottom.

**Option A:** Add a dedicated "+ Add Reminder" button next to the "+ Add Job Requirement" button at the top of the prep checklist section (line ~4089). This is more prominent and doesn't require changing sort order.

**Option B:** Change migration to set reminder sort_order to 1 (before all others).

**Recommended: Option A** — add a small dedicated button:
```tsx
<button
  onClick={() => addRequirement('reminder')}
  className="px-3 py-1.5 text-sm border border-ooosh-200 text-ooosh-600 rounded-lg hover:bg-ooosh-50"
>
  + Reminder
</button>
```
Place it next to the existing "+ Add Job Requirement" button.

## Files to modify
```
backend/src/migrations/048_reminder_fields.sql     (new)
backend/src/migrations/run.ts                      (add 048 to array)
backend/src/routes/requirements.ts                 (add event_trigger, delivery_method to schema + INSERT)
backend/src/routes/pipeline.ts                     (fire event triggers on status change)
backend/src/routes/cancellations.ts                (fire event triggers on cancellation)
backend/src/config/scheduler.ts                    (respect delivery_method in chase scanner)
frontend/src/pages/JobDetailPage.tsx               (pass structured fields, add Reminder button)
frontend/src/components/RequirementCard.tsx         (show event trigger + delivery on card)
```

## Testing
1. Create a reminder with trigger "This job confirms" → confirm the job → notification should fire + reminder marked done
2. Create a reminder with delivery "Bell only" → verify no email is sent on escalation
3. Create a reminder with delivery "Email only" → verify email is sent immediately
4. Verify "+ Reminder" button appears at top of prep checklist
5. Verify past dates cannot be selected in the date picker
