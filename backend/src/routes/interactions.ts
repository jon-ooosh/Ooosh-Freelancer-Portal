import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import emailService from '../services/email-service';
import { frontendLink } from '../config/app-urls';

const router = Router();
router.use(authenticate);

// Attachment shape — mirrors the metadata returned by
// POST /api/files/upload?attachment_only=true. Stored on interactions.files
// JSONB (column already exists from migration 001).
const attachmentSchema = z.object({
  r2_key: z.string().min(1),
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  thumbnail_key: z.string().optional().nullable(),
});

const createInteractionSchema = z.object({
  type: z.enum(['note', 'email', 'call', 'meeting', 'mention', 'chase', 'status_transition']),
  content: z.string().min(1),
  // Polymorphic linking — at least one must be provided
  person_id: z.string().uuid().optional().nullable(),
  organisation_id: z.string().uuid().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  opportunity_id: z.string().uuid().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  issue_id: z.string().uuid().optional().nullable(),
  // Threading: if set, this is a reply. Server flattens to thread root and
  // inherits the parent's anchor (job/person/org/venue/issue/opportunity).
  parent_interaction_id: z.string().uuid().optional().nullable(),
  // Attachments — files already uploaded via attachment_only=true
  attachments: z.array(attachmentSchema).optional().default([]),
  // @mentions
  mentioned_user_ids: z.array(z.string().uuid()).optional().default([]),
  mention_priority: z.enum(['normal', 'high', 'urgent']).optional().default('normal'),
  // Chase-specific fields
  chase_method: z.enum(['phone', 'email', 'text', 'whatsapp']).optional().nullable(),
  chase_response: z.string().optional().nullable(),
  // Optional: override next chase date (otherwise auto-calculated)
  next_chase_date: z.string().optional().nullable(),
  // Chase alert: notify a user when chase is due
  chase_alert_user_id: z.string().uuid().optional().nullable(),
  chase_alert_delivery: z.enum(['bell', 'bell_email', 'none']).optional().nullable(),
  // Opt-out for the auto-chase-bump on call/email/meeting interactions.
  // Default false (= bump fires). Set true when logging a backdated or
  // non-consequential contact event that shouldn't shift the chase date.
  skip_chase_bump: z.boolean().optional().default(false),
});

// GET /api/interactions — timeline for an entity
//
// IMPORTANT: timeline reads on person/org/venue MUST exclude issue-scoped
// interactions (issue_id IS NOT NULL). Issue messages stay scoped to the
// IssueDetailPage — they don't bubble to vehicle/driver/org timelines per
// docs/MESSAGING-SPEC.md §6.3.
//
// The job-scoped read keeps issue-anchored interactions because the issue is
// owned by the job — but the IssueDetailPage filters via issue_id to render
// them as a separate stream. (Job timeline can show "issue logged"-style
// summary rows from job_issue_events instead of the chatter.)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { person_id, organisation_id, job_id, venue_id, issue_id, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `
      SELECT i.*,
        u.email as created_by_email,
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name
      FROM interactions i
      LEFT JOIN users u ON u.id = i.created_by
      LEFT JOIN people p ON p.id = u.person_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (person_id) {
      // Issue messages don't bubble to person timelines.
      sql += ` AND i.person_id = $${paramIndex} AND i.issue_id IS NULL`;
      params.push(person_id);
      paramIndex++;
    }
    if (organisation_id) {
      sql += ` AND i.organisation_id = $${paramIndex} AND i.issue_id IS NULL`;
      params.push(organisation_id);
      paramIndex++;
    }
    if (job_id) {
      // Job timeline filters issue-scoped interactions out by default — the
      // IssueDetailPage owns that conversation. Caller can pass
      // include_issues=true to override (e.g. for a forensic "everything
      // that touched this job" view).
      sql += ` AND i.job_id = $${paramIndex}`;
      params.push(job_id);
      paramIndex++;
      if (req.query.include_issues !== 'true') {
        sql += ` AND i.issue_id IS NULL`;
      }
    }
    if (venue_id) {
      sql += ` AND i.venue_id = $${paramIndex} AND i.issue_id IS NULL`;
      params.push(venue_id);
      paramIndex++;
    }
    if (issue_id) {
      sql += ` AND i.issue_id = $${paramIndex}`;
      params.push(issue_id);
      paramIndex++;
    }

    sql += ` ORDER BY i.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string), offset);

    const result = await query(sql, params);

    res.json({ data: result.rows });
  } catch (error) {
    console.error('List interactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/interactions/:id/thread — full thread for any interaction in it
//
// Walks parent_interaction_id back to the root, then returns root + all
// descendants ordered oldest-first. Caller can pass any interaction in the
// thread; response is the same.
router.get('/:id/thread', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Find the root: walk parent_interaction_id until we hit a row with NULL
    // parent. Threads are always one-deep in storage (replies hang directly
    // off root — see flatten logic in POST), but defensively walk in case
    // historical data has chains.
    const rootResult = await query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_interaction_id, 0 AS depth
         FROM interactions WHERE id = $1
         UNION ALL
         SELECT i.id, i.parent_interaction_id, c.depth + 1
         FROM interactions i
         JOIN chain c ON i.id = c.parent_interaction_id
         WHERE c.depth < 10
       )
       SELECT id FROM chain WHERE parent_interaction_id IS NULL LIMIT 1`,
      [id]
    );

    if (rootResult.rows.length === 0) {
      res.status(404).json({ error: 'Interaction not found' });
      return;
    }
    const rootId = rootResult.rows[0].id;

    // Fetch root + replies with author info.
    const threadResult = await query(
      `SELECT i.*,
        u.email AS created_by_email,
        CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM interactions i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE i.id = $1 OR i.parent_interaction_id = $1
       ORDER BY i.created_at ASC`,
      [rootId]
    );

    const root = threadResult.rows.find((r) => r.id === rootId) || threadResult.rows[0];
    const replies = threadResult.rows.filter((r) => r.id !== rootId);

    // Distinct participants for the header chip strip in the UI.
    const participantIds = new Set<string>();
    for (const row of threadResult.rows) {
      if (row.created_by) participantIds.add(row.created_by);
      if (Array.isArray(row.mentioned_user_ids)) {
        for (const uid of row.mentioned_user_ids) participantIds.add(uid);
      }
    }
    let participants: { id: string; name: string; email: string }[] = [];
    if (participantIds.size > 0) {
      const partResult = await query(
        `SELECT u.id,
          u.email,
          COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email) AS name
         FROM users u
         LEFT JOIN people p ON p.id = u.person_id
         WHERE u.id = ANY($1::uuid[])`,
        [Array.from(participantIds)]
      );
      participants = partResult.rows;
    }

    // Has the requesting user muted this thread? Returned to the client so
    // the UI can render the right toggle state. Tolerate the table not
    // existing yet (pre-migration deploy).
    let isMuted = false;
    try {
      const muteResult = await query(
        `SELECT 1 FROM user_muted_threads WHERE user_id = $1 AND root_interaction_id = $2`,
        [req.user!.id, rootId]
      );
      isMuted = muteResult.rows.length > 0;
    } catch { /* table not yet created */ }

    res.json({ root, replies, participants, is_muted: isMuted });
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/interactions/:id/mute — silence further re-notifies on this thread
//
// Toggles the current user's mute state for the thread root that contains
// :id (which can be any interaction in the thread — server walks to root).
// Body: { muted: boolean }. Idempotent.
//
// Only suppresses LOW-priority "replied in a thread" re-notifies. Explicit
// @mentions on the thread still notify the user — direct calls for
// attention always get through.
const muteSchema = z.object({ muted: z.boolean() });

router.post('/:id/mute', async (req: AuthRequest, res: Response) => {
  try {
    const { muted } = muteSchema.parse(req.body);

    // Walk to root the same way /thread does.
    const rootResult = await query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_interaction_id, 0 AS depth
         FROM interactions WHERE id = $1
         UNION ALL
         SELECT i.id, i.parent_interaction_id, c.depth + 1
         FROM interactions i
         JOIN chain c ON i.id = c.parent_interaction_id
         WHERE c.depth < 10
       )
       SELECT id FROM chain WHERE parent_interaction_id IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (rootResult.rows.length === 0) {
      return res.status(404).json({ error: 'Interaction not found' });
    }
    const rootId = rootResult.rows[0].id;

    if (muted) {
      await query(
        `INSERT INTO user_muted_threads (user_id, root_interaction_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, root_interaction_id) DO NOTHING`,
        [req.user!.id, rootId]
      );
    } else {
      await query(
        `DELETE FROM user_muted_threads
         WHERE user_id = $1 AND root_interaction_id = $2`,
        [req.user!.id, rootId]
      );
    }

    res.json({ is_muted: muted, root_interaction_id: rootId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('Toggle mute error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/interactions — create a note, log a call, chase, reply, etc.
router.post('/', validate(createInteractionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      type, content, mentioned_user_ids, mention_priority, chase_method, chase_response,
      next_chase_date, chase_alert_user_id, chase_alert_delivery, skip_chase_bump,
      attachments,
    } = req.body;
    let { person_id, organisation_id, job_id, opportunity_id, venue_id, issue_id, parent_interaction_id } = req.body;

    // Threading: if this is a reply, look up the parent and inherit its
    // anchor. We FLATTEN to the thread root — replies always hang off root,
    // never off another reply. Keeps the read query in /thread simple
    // (one-deep, no recursion needed in the common case).
    let parentRow: Record<string, unknown> | null = null;
    if (parent_interaction_id) {
      const parentResult = await query(
        `SELECT id, parent_interaction_id, person_id, organisation_id, job_id,
                opportunity_id, venue_id, issue_id, created_by, mentioned_user_ids
         FROM interactions WHERE id = $1`,
        [parent_interaction_id]
      );
      if (parentResult.rows.length === 0) {
        res.status(400).json({ error: 'parent_interaction_id not found' });
        return;
      }
      parentRow = parentResult.rows[0];

      // Flatten: if the supplied parent is itself a reply, point at root.
      if (parentRow!.parent_interaction_id) {
        parent_interaction_id = parentRow!.parent_interaction_id as string;
        // Re-fetch the actual root for anchor inheritance.
        const rootResult = await query(
          `SELECT id, person_id, organisation_id, job_id, opportunity_id, venue_id, issue_id,
                  created_by, mentioned_user_ids
           FROM interactions WHERE id = $1`,
          [parent_interaction_id]
        );
        if (rootResult.rows.length > 0) parentRow = rootResult.rows[0];
      }

      // Inherit anchor from the root. Replies MUST sit on the same entity
      // as the thread — guard against client passing a different anchor.
      person_id = (parentRow!.person_id as string | null) ?? null;
      organisation_id = (parentRow!.organisation_id as string | null) ?? null;
      job_id = (parentRow!.job_id as string | null) ?? null;
      opportunity_id = (parentRow!.opportunity_id as string | null) ?? null;
      venue_id = (parentRow!.venue_id as string | null) ?? null;
      issue_id = (parentRow!.issue_id as string | null) ?? null;
    }

    // If linked to a job, snapshot current status for tracking
    let jobStatusAt: number | null = null;
    let jobStatusNameAt: string | null = null;
    let pipelineStatusAt: string | null = null;
    if (job_id) {
      const jobResult = await query(
        `SELECT status, status_name, pipeline_status FROM jobs WHERE id = $1 AND is_deleted = false`,
        [job_id]
      );
      if (jobResult.rows.length > 0) {
        jobStatusAt = jobResult.rows[0].status;
        jobStatusNameAt = jobResult.rows[0].status_name;
        pipelineStatusAt = jobResult.rows[0].pipeline_status;
      }
    }

    // Stamp uploaded_at / uploaded_by on attachments (caller supplies the
    // R2 metadata from /api/files/upload?attachment_only=true; we add the
    // audit fields server-side).
    const filesPayload = (attachments || []).map((a: Record<string, unknown>) => ({
      ...a,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user!.id,
    }));

    const result = await query(
      `INSERT INTO interactions (type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
        issue_id, parent_interaction_id, mentioned_user_ids, files, created_by,
        job_status_at_creation, job_status_name_at_creation, pipeline_status_at_creation,
        chase_method, chase_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
        issue_id || null, parent_interaction_id || null,
        mentioned_user_ids, JSON.stringify(filesPayload), req.user!.id,
        jobStatusAt, jobStatusNameAt, pipelineStatusAt,
        chase_method || null, chase_response || null]
    );

    // Chase side-effects: bump chase_count, set next_chase_date, persist
    // alert preferences. Crucially we DO NOT touch pipeline_status — chasing
    // is a derived view (next_chase_date + pre-confirmed status), not a
    // stored status. Setting next_chase_date to a future date is enough to
    // drop the card out of the Chasing pile in the Kanban; the underlying
    // pipeline_status (new_enquiry / quoting / paused / provisional) is
    // preserved.
    if (type === 'chase' && job_id) {
      const chaseDate = next_chase_date || null;
      await query(
        `UPDATE jobs SET
          chase_count = chase_count + 1,
          last_chased_at = NOW(),
          next_chase_date = CASE
            WHEN $1::date IS NOT NULL THEN $1::date
            ELSE (CURRENT_DATE + (COALESCE(chase_interval_days, 3) || ' days')::interval)::date
          END,
          chase_alert_user_id = COALESCE($3, chase_alert_user_id),
          chase_alert_delivery = COALESCE($4, chase_alert_delivery),
          updated_at = NOW()
        WHERE id = $2`,
        [chaseDate, job_id, chase_alert_user_id || null, chase_alert_delivery || null]
      );
    }

    // Auto-bump chase on contact-type interactions (call / email / meeting).
    // Logging a contact event IS evidence of action — push the chase forward.
    // Notes and mentions are deliberately excluded: notes are too varied
    // (could be internal observations) and mentions are internal collaboration,
    // not client contact.
    //
    // Safety rule: only bump if the current chase date is null/today/past.
    // A future-dated chase is a deliberate user decision and must not be
    // shortened (e.g. "chase Friday because client said they'd reply then" —
    // an unrelated email logged Wednesday should NOT shrink Friday → Monday).
    //
    // Opt-out: skip_chase_bump=true on the request body skips the bump.
    // Use for backdated entries or non-consequential events.
    const CONTACT_BUMP_TYPES = new Set(['call', 'email', 'meeting']);
    if (
      job_id
      && CONTACT_BUMP_TYPES.has(type)
      && !skip_chase_bump
      // Only bump for jobs that are actually in an enquiry stage — chase
      // dates on confirmed/lost/cancelled jobs are stale anyway.
      && pipelineStatusAt
      && ['new_enquiry', 'quoting', 'paused', 'provisional'].includes(pipelineStatusAt)
    ) {
      await query(
        `UPDATE jobs SET
          next_chase_date = CASE
            WHEN next_chase_date IS NULL OR next_chase_date <= CURRENT_DATE
              THEN (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date
            ELSE next_chase_date
          END,
          last_chased_at = NOW(),
          updated_at = NOW()
        WHERE id = $1`,
        [job_id]
      );
    }

    await logAudit(req.user!.id, 'interactions', result.rows[0].id, 'create', null, result.rows[0]);

    // Author display name — used by both mention and thread-reply notifications.
    const creatorResult = await query(
      `SELECT CONCAT(p.first_name, ' ', p.last_name) as name
       FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
      [req.user!.id]
    );
    const creatorName = creatorResult.rows[0]?.name || 'Someone';

    // Resolve the entity anchor that mentions / thread re-notifications point at.
    // Issue-anchored interactions point at the IssueDetailPage rather than a
    // generic entity page.
    const entityType = issue_id ? 'job_issues'
      : person_id ? 'people'
      : organisation_id ? 'organisations'
      : venue_id ? 'venues'
      : job_id ? 'jobs'
      : null;
    const entityId = issue_id || person_id || organisation_id || venue_id || job_id || null;

    // Build action URL for click-through navigation. Issue messages route to
    // the IssueDetailPage; otherwise default to the entity's timeline tab.
    const actionUrl = issue_id ? `/operations/problems/${issue_id}`
      : job_id ? `/jobs/${job_id}?tab=timeline`
      : person_id ? `/people/${person_id}`
      : organisation_id ? `/organisations/${organisation_id}`
      : venue_id ? `/venues/${venue_id}`
      : null;

    // Track who already got a notification for this interaction so we can
    // dedupe the thread re-notify pass below — explicit mentions take
    // priority over generic "replied in thread" notifications.
    const notifiedUserIds = new Set<string>([req.user!.id]);

    const io = req.app.get('io');

    // 1) Explicit @mentions — high-signal. Email fires IMMEDIATELY at
    //    creation time (not via the 15-min escalator) when the recipient's
    //    preference allows it. Why: the escalator filters on
    //    `is_read = false`, but users routinely read mention notifications
    //    via the bell within seconds — flipping is_read=true and silently
    //    killing any email path. For conversations (which is what mentions
    //    are), the user expectation is "email me too so I can reply from
    //    my phone", regardless of whether I happened to glance at the bell.
    //
    //    Thread re-notifications (priority='low' below) deliberately
    //    don't email — that's the spec'd model.
    const priority = mention_priority || 'normal';
    if (mentioned_user_ids && mentioned_user_ids.length > 0) {
      // Bulk-load recipients + delivery preferences in one round-trip.
      const recipientResult = await query(
        `SELECT u.id, u.email, p.first_name,
          COALESCE(
            (SELECT delivery_method FROM user_notification_preferences
              WHERE user_id = u.id AND notification_type = 'mention'),
            'both'
          ) AS pref
         FROM users u
         LEFT JOIN people p ON p.id = u.person_id
         WHERE u.id = ANY($1::uuid[]) AND u.is_active = true`,
        [mentioned_user_ids]
      );
      const recipientMap = new Map(recipientResult.rows.map((r) => [r.id, r]));

      for (const userId of mentioned_user_ids) {
        if (notifiedUserIds.has(userId)) continue;
        notifiedUserIds.add(userId);

        const recipient = recipientMap.get(userId);
        const wantsEmail = recipient
          && (recipient.pref === 'email' || recipient.pref === 'both')
          && priority !== 'low'
          && recipient.email;

        // Stamp email_sent_at at INSERT time when we plan to email
        // immediately, so the 15-min escalator doesn't double-fire later.
        const notifResult = await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id,
             source_user_id, interaction_id, action_url, priority, email_sent_at)
           VALUES ($1, 'mention', $2, $3, $4, $5, $6, $7, $8, $9, ${wantsEmail ? 'NOW()' : 'NULL'})
           RETURNING *`,
          [
            userId,
            `${creatorName} mentioned you`,
            content.length > 200 ? content.slice(0, 200) + '...' : content,
            entityType,
            entityId,
            req.user!.id,
            result.rows[0].id,
            actionUrl,
            priority,
          ]
        );

        if (io) {
          io.to(`user:${userId}`).emit('notification', notifResult.rows[0]);
        }

        // Fire email out-of-band — don't block the route response on SMTP.
        // Failure here just means the user doesn't get the immediate email;
        // the escalator can't pick it up either (we already stamped
        // email_sent_at), so we log loudly. Acceptable trade-off — alarming
        // every flake would create more noise than it saves.
        if (wantsEmail) {
          const recipientName = recipient.first_name || 'there';
          const recipientEmail = recipient.email;
          const priorityLabel = priority === 'urgent' ? 'URGENT: ' : priority === 'high' ? 'Important: ' : '';
          const subject = `${priorityLabel}${creatorName} mentioned you`;
          const linkHtml = actionUrl
            ? `<p><a href="${frontendLink(actionUrl)}" style="color: #7B5EA7; text-decoration: underline;">View in Ooosh</a></p>`
            : '';
          const escapeMap: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };
          const previewBody = (content.length > 200 ? content.slice(0, 200) + '…' : content).replace(/[<>&]/g, (c: string) => escapeMap[c]);
          setImmediate(() => {
            emailService.sendRaw({
              to: recipientEmail,
              subject,
              html: `
                <p>Hi ${recipientName},</p>
                <p style="font-size: 13px; color: #666;">From: ${creatorName}</p>
                <p style="font-size: 15px; margin: 16px 0;"><strong>${creatorName} mentioned you</strong></p>
                <p style="color: #333; white-space: pre-wrap;">${previewBody}</p>
                ${linkHtml}
                <p style="color: #999; font-size: 12px; margin-top: 24px;">
                  You're receiving this because you were @mentioned on the Ooosh Operations Platform.
                  Adjust your notification preferences in your Inbox settings.
                </p>
              `,
              variant: 'internal',
            }).catch((err) => {
              console.error(`[Interactions] Failed to send mention email to ${recipientEmail}:`, err);
            });
          });
        }
      }
    }

    // 2) Thread re-notify — fire LOW-PRIORITY "replied in a thread you're in"
    //    notifications to everyone earlier in the thread (root author +
    //    every prior reply author + every previously mentioned user), deduped
    //    against explicit mentions above and the reply's own author.
    //
    //    Low priority means no email escalation — pure in-app surfacing.
    //    Per docs/MESSAGING-SPEC.md §5.1 / working agreement (jon, May 2026).
    if (parent_interaction_id) {
      // Find the thread root + collect every distinct user_id who has touched
      // the thread (authored a row or been mentioned in one).
      const participantsResult = await query(
        `SELECT i.created_by, i.mentioned_user_ids
         FROM interactions i
         WHERE i.id = $1 OR i.parent_interaction_id = $1`,
        [parent_interaction_id]
      );
      const priorParticipants = new Set<string>();
      for (const row of participantsResult.rows) {
        if (row.created_by) priorParticipants.add(row.created_by);
        if (Array.isArray(row.mentioned_user_ids)) {
          for (const uid of row.mentioned_user_ids) priorParticipants.add(uid);
        }
      }

      const replyPreview = content.length > 200 ? content.slice(0, 200) + '...' : content;

      // Suppress re-notifies for users who have muted this thread root.
      // (Explicit @mentions above are NOT muted by this — if someone @s
      // you directly, you still see it.)
      const candidateIds = [...priorParticipants].filter((u) => !notifiedUserIds.has(u));
      let mutedSet = new Set<string>();
      if (candidateIds.length > 0) {
        try {
          const mutedResult = await query(
            `SELECT user_id FROM user_muted_threads
             WHERE root_interaction_id = $1 AND user_id = ANY($2::uuid[])`,
            [parent_interaction_id, candidateIds]
          );
          mutedSet = new Set(mutedResult.rows.map((r) => r.user_id as string));
        } catch (err) {
          // Table missing on a freshly-deployed instance pre-migration —
          // fall back to "not muted" so re-notifies still fire. Will
          // self-correct as soon as migration 080 lands.
          console.warn('[Interactions] user_muted_threads lookup failed (pre-migration?):', (err as Error).message);
        }
      }

      for (const userId of priorParticipants) {
        if (notifiedUserIds.has(userId)) continue;
        if (mutedSet.has(userId)) continue;
        notifiedUserIds.add(userId);

        const notifResult = await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id,
             source_user_id, interaction_id, action_url, priority)
           VALUES ($1, 'mention', $2, $3, $4, $5, $6, $7, $8, 'low')
           RETURNING *`,
          [
            userId,
            `${creatorName} replied in a thread`,
            replyPreview,
            entityType,
            entityId,
            req.user!.id,
            result.rows[0].id,
            actionUrl,
          ]
        );

        if (io) {
          io.to(`user:${userId}`).emit('notification', notifResult.rows[0]);
        }
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create interaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/interactions/:id/move — move an interaction to a different entity
const moveInteractionSchema = z.object({
  target_type: z.enum(['person_id', 'organisation_id', 'venue_id']),
  target_id: z.string().uuid(),
});

router.put('/:id/move', validate(moveInteractionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { target_type, target_id } = req.body;

    // Verify interaction exists
    const current = await query('SELECT * FROM interactions WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Interaction not found' });
      return;
    }

    // Clear all entity links and set the new one
    const result = await query(
      `UPDATE interactions
       SET person_id = CASE WHEN $1 = 'person_id' THEN $2::uuid ELSE NULL END,
           organisation_id = CASE WHEN $1 = 'organisation_id' THEN $2::uuid ELSE NULL END,
           venue_id = CASE WHEN $1 = 'venue_id' THEN $2::uuid ELSE NULL END
       WHERE id = $3
       RETURNING *`,
      [target_type, target_id, req.params.id]
    );

    await logAudit(req.user!.id, 'interactions', req.params.id as string, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Move interaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/interactions/:id/reactions — toggle a reaction ───────────────
//
// Body: { emoji: string }. The user's reaction with this emoji is toggled
// on/off — idempotent. Server enforces a curated 6-emoji palette to keep
// the surface tidy and avoid arbitrary emoji proliferation.
//
// No notifications fire on reactions — this is intentionally the
// lightweight "I saw it, no follow-up needed" pattern.

const REACTION_PALETTE = ['👍', '❤️', '✅', '😂', '🎉', '👀'] as const;

const reactionSchema = z.object({
  emoji: z.enum(REACTION_PALETTE),
});

router.post('/:id/reactions', validate(reactionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { emoji } = req.body as { emoji: typeof REACTION_PALETTE[number] };
    const userId = req.user!.id;

    // Read current reactions, toggle the user's id in the chosen emoji's
    // array, write back. Single round-trip via JSONB ops would be cleaner
    // but it's a small payload and this is more readable.
    const current = await query(
      `SELECT reactions FROM interactions WHERE id = $1`,
      [req.params.id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Interaction not found' });
    }
    const reactions = (current.rows[0].reactions || {}) as Record<string, string[]>;
    const existing = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    if (existing.includes(userId)) {
      reactions[emoji] = existing.filter((u) => u !== userId);
      // Drop the key entirely when the last reactor removes themselves —
      // keeps the JSONB clean instead of accumulating empty arrays.
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      reactions[emoji] = [...existing, userId];
    }

    const result = await query(
      `UPDATE interactions SET reactions = $1::jsonb WHERE id = $2 RETURNING reactions`,
      [JSON.stringify(reactions), req.params.id]
    );

    res.json({ reactions: result.rows[0].reactions });
  } catch (error) {
    console.error('Toggle reaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
