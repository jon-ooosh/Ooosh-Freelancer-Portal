/**
 * Cancellation Routes
 *
 * Handles the full cancellation workflow:
 * - Calculate cancellation fee (no side effects)
 * - Process cancellation (status change + automated actions)
 * - List cancelled + lost jobs
 * - Get transport/crew associated with a job
 * - Re-open cancelled job as new booking (HH duplicate)
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { hhBroker } from '../services/hirehop-broker';
import { writeBackStatusToHireHop } from '../services/hirehop-writeback';
import { calculatePreHireCancellation, calculateEarlyReturn } from '../services/cancellation-calculator';
import emailService from '../services/email-service';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from '../services/money-emails';
import { getFrontendUrl } from '../config/app-urls';

const router = Router();
router.use(authenticate);

// ── Calculate cancellation fee (no side effects) ────────────────────────

const calculateSchema = z.object({
  totalHireCost: z.number().min(0),
  hireStartDate: z.string(),
  cancellationDate: z.string().optional(),
  transportCharges: z.number().min(0).optional(),
  totalHireDays: z.number().min(1).optional(),
  hireType: z.enum(['vehicle', 'backline', 'week']).optional(),
});

router.post('/:jobId/calculate', validate(calculateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const result = calculatePreHireCancellation({
      totalHireCost: req.body.totalHireCost,
      hireStartDate: new Date(req.body.hireStartDate),
      cancellationDate: req.body.cancellationDate ? new Date(req.body.cancellationDate) : undefined,
      transportCharges: req.body.transportCharges,
      totalHireDays: req.body.totalHireDays,
    });
    res.json(result);
  } catch (error) {
    console.error('Calculate cancellation error:', error);
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// ── Get transport & crew for cancellation modal ─────────────────────────

router.get('/:jobId/transport-crew', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    // Each query is independent — catch individually so one failing doesn't block others
    let quotes = { rows: [] as any[] };
    let crew = { rows: [] as any[] };
    let vehicles = { rows: [] as any[] };
    let excess = { rows: [] as any[] };

    // Already-cancelled quotes / crew assignments are a SEPARATE concern —
    // they were cancelled at some earlier point and have nothing to do with
    // the cancellation being actioned now. Surfacing them here misleads
    // staff into thinking they're live commitments and inflates the
    // Transport & Crew Commitments panel. Filter at the SQL boundary in
    // both places: the quote list itself, and the parent-quote subquery
    // that drives crew. The processing path further down already short-
    // circuits cancelled rows, so this is purely a display fix.
    try {
      quotes = await query(
        `SELECT q.id, q.job_type, q.venue_name, q.client_charge_total, q.ops_status,
                q.job_date, q.collection_date
         FROM quotes q WHERE q.job_id = $1 AND q.is_deleted = false
           AND q.status != 'cancelled'`,
        [jobId]
      );
    } catch (e) { console.warn('[Cancellation] quotes query failed:', e); }

    try {
      crew = await query(
        `SELECT qa.id, qa.role, qa.agreed_rate, qa.status,
                p.first_name, p.last_name, p.email, p.phone
         FROM quote_assignments qa
         JOIN people p ON p.id = qa.person_id
         WHERE qa.quote_id IN (
           SELECT id FROM quotes
           WHERE job_id = $1 AND is_deleted = false AND status != 'cancelled'
         )
           AND qa.status NOT IN ('cancelled', 'declined')`,
        [jobId]
      );
    } catch (e) { console.warn('[Cancellation] crew query failed:', e); }

    try {
      vehicles = await query(
        `SELECT vha.id, vha.status, vha.hire_start, vha.hire_end,
                fv.reg
         FROM vehicle_hire_assignments vha
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         WHERE vha.job_id = $1 AND vha.status NOT IN ('cancelled')`,
        [jobId]
      );
    } catch (e) { console.warn('[Cancellation] vehicles query failed:', e); }

    try {
      excess = await query(
        `SELECT id, excess_amount_required, excess_status, payment_method
         FROM job_excess WHERE job_id = $1`,
        [jobId]
      );
    } catch (e) { console.warn('[Cancellation] excess query failed:', e); }

    res.json({
      quotes: quotes.rows,
      crew: crew.rows,
      vehicles: vehicles.rows,
      excess: excess.rows,
    });
  } catch (error) {
    console.error('Get transport-crew error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Process cancellation (full workflow) ─────────────────────────────────

const processSchema = z.object({
  cancellation_reason: z.string().min(1),
  cancellation_notes: z.string().optional(),
  cancellation_fee: z.number().min(0),
  cancellation_refund: z.number().min(0),
  cancellation_tier: z.string(),
  cancellation_notice_days: z.number().min(0),
  transport_charges: z.number().min(0).optional(),
  breakdown: z.string().optional(),
  // Optional override of cancelled_at — used when staff backdate the
  // cancellation (e.g. client emailed yesterday, we're processing today).
  // Sent as ISO string from the modal date picker (UTC noon to dodge tz edges).
  cancelled_at: z.string().datetime().optional().nullable(),
  // Optional — what the client still owes us after the cancellation fee
  // is applied to what they've already paid. Computed by the modal from
  // the live Money summary; passed through so the email template can show
  // the right state (refund / all-square / outstanding) without the route
  // having to re-fetch billing.
  cancellation_outstanding_balance: z.number().min(0).optional(),
  // Whether to email the client a cancellation confirmation. Default true.
  // Opt-out is for cases where staff have already had the conversation
  // out-of-band (phone / face-to-face) and the templated email would be
  // redundant. Internal info@ alert + crew emails fire regardless — those
  // are operational, not customer-facing.
  send_client_email: z.boolean().optional().default(true),
  // Requirement IDs the user explicitly chose to KEEP alive past cancellation.
  // Everything else open on the job is auto-cancelled below. Kept items get
  // keep_after_close=true so background scanners still fire them. See
  // CLAUDE.md → "Lost / Cancelled cleanup pattern".
  keep_requirement_ids: z.array(z.string().uuid()).optional().nullable(),
});

router.post(
  '/:jobId/process',
  authorize('admin', 'manager'),
  validate(processSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const jobId = req.params.jobId as string;
      const userId = req.user!.id;
      const {
        cancellation_reason, cancellation_notes,
        cancellation_fee, cancellation_refund,
        cancellation_tier, cancellation_notice_days,
        breakdown, keep_requirement_ids, cancelled_at,
        cancellation_outstanding_balance,
        send_client_email,
      } = req.body;

      // Verify job exists and is in a cancellable state (confirmed+)
      const jobResult = await query(
        `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
        [jobId]
      );
      if (jobResult.rows.length === 0) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      const job = jobResult.rows[0];
      const cancelableStatuses = ['confirmed', 'prepped', 'dispatched', 'returned_incomplete', 'returned'];
      if (!cancelableStatuses.includes(job.pipeline_status)) {
        res.status(400).json({ error: `Cannot cancel a job with status '${job.pipeline_status}'. Must be confirmed or later.` });
        return;
      }

      // 1. Update job status to cancelled. cancelled_at honours the optional
      // backdate override — used by the modal when staff process a cancellation
      // a day or two after the client actually emailed (which would otherwise
      // shift the notice tier). Future dates are clamped to NOW server-side
      // (Zod min isn't enough because the front-end could lie).
      const cancelledAtSql = cancelled_at && new Date(cancelled_at) <= new Date()
        ? cancelled_at
        : null;
      await query(
        `UPDATE jobs SET
          pipeline_status = 'cancelled',
          pipeline_status_changed_at = NOW(),
          cancelled_at = COALESCE($9::timestamptz, NOW()),
          cancelled_by = $2,
          cancellation_reason = $3,
          cancellation_notes = $4,
          cancellation_fee = $5,
          cancellation_refund = $6,
          cancellation_tier = $7,
          cancellation_notice_days = $8,
          next_chase_date = NULL,
          updated_at = NOW()
        WHERE id = $1`,
        [jobId, userId, cancellation_reason, cancellation_notes || null,
         cancellation_fee, cancellation_refund, cancellation_tier, cancellation_notice_days,
         cancelledAtSql]
      );

      // 2. Log cancellation as interaction on activity timeline
      const timelineContent = [
        `Job cancelled by ${req.user!.email}`,
        `Reason: ${cancellation_reason}`,
        cancellation_notes ? `Notes: ${cancellation_notes}` : null,
        `Notice period: ${cancellation_notice_days} days (${cancellation_tier})`,
        `Cancellation fee: £${cancellation_fee.toFixed(2)}`,
        `Refund due: £${cancellation_refund.toFixed(2)}`,
        breakdown ? `\nBreakdown:\n${breakdown}` : null,
      ].filter(Boolean).join('\n');

      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
         VALUES ('status_transition', $1, $2, $3, 'cancelled', 'system')`,
        [timelineContent, jobId, userId]
      );

      // 2a. Flag the requirements the user explicitly chose to KEEP alive.
      // The blanket cancel pass below skips items with keep_after_close=true,
      // so flagging happens first. Background scanners (reminder scanner,
      // hire-form auto-emailer, etc.) check this flag and keep firing kept
      // items even though the parent job is now in a terminal status.
      if (Array.isArray(keep_requirement_ids) && keep_requirement_ids.length > 0) {
        try {
          await query(
            `UPDATE job_requirements
             SET keep_after_close = true,
                 notes = COALESCE(notes, '') ||
                         E'\n[Kept alive after job cancelled]',
                 updated_at = NOW()
             WHERE id = ANY($1::uuid[])
               AND job_id = $2
               AND status NOT IN ('done', 'cancelled')`,
            [keep_requirement_ids, jobId]
          );
        } catch (cancelErr) {
          console.warn('[Cancellation] Failed to flag kept requirements:', cancelErr);
        }
      }

      // 2b. Fire event-triggered reminders (before blanket mark-as-done)
      try {
        const triggered = await query(
          `SELECT jr.id, jr.custom_label, jr.assigned_to, jr.notes, jr.delivery_method, jr.job_id
           FROM job_requirements jr
           WHERE jr.job_id = $1
             AND jr.requirement_type = 'reminder'
             AND jr.event_trigger = 'cancelled'
             AND jr.status NOT IN ('done', 'cancelled')`,
          [jobId]
        );

        const jobName = job.job_name || job.client_name || `Job ${job.hh_job_number || ''}`;
        for (const rem of triggered.rows) {
          const targetUserId = rem.assigned_to || userId;
          const title = `Reminder triggered: ${rem.custom_label || 'Reminder'}`;
          const content = `Job cancelled — ${rem.custom_label || 'Reminder'} (${jobName})`;
          const deliveryMethod = rem.delivery_method || 'both';
          const priority = deliveryMethod === 'notification' ? 'low' : 'high';

          await query(
            `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
             VALUES ($1, 'follow_up', $2, $3, 'jobs', $4, $5, $6, $7)`,
            [targetUserId, title, content, rem.job_id, `/jobs/${rem.job_id}?tab=overview`, priority, userId]
          );

          if (deliveryMethod === 'email' || deliveryMethod === 'both') {
            try {
              const userResult = await query('SELECT u.email, p.first_name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1', [targetUserId]);
              if (userResult.rows.length > 0 && userResult.rows[0].email) {
                await emailService.sendRaw({
                  to: userResult.rows[0].email,
                  subject: title,
                  html: `<p>Hi ${userResult.rows[0].first_name || ''},</p>
                         <p>Your reminder "<strong>${rem.custom_label || 'Reminder'}</strong>" has been triggered because the job <strong>${jobName}</strong> has been <strong>cancelled</strong>.</p>
                         ${rem.notes ? `<p>Notes: ${rem.notes}</p>` : ''}
                         <p><a href="${getFrontendUrl()}/jobs/${rem.job_id}?tab=overview">View Job</a></p>`,
                });
              }
            } catch (emailErr) {
              console.warn('[Cancellation] Event trigger email failed:', emailErr);
            }
          }

          // Mark the reminder as done
          await query(`UPDATE job_requirements SET status = 'done', updated_at = NOW() WHERE id = $1`, [rem.id]);
        }

        if (triggered.rows.length > 0) {
          console.log(`[Cancellation] Fired ${triggered.rows.length} event-triggered reminder(s) for job ${jobId}`);
        }
      } catch (triggerErr) {
        console.warn('[Cancellation] Event trigger check failed:', triggerErr);
      }

      // 3. Cancel all remaining open requirements EXCEPT those the user
      // explicitly chose to keep (flagged keep_after_close=true in step 2a).
      // See CLAUDE.md → "Lost / Cancelled cleanup pattern".
      await query(
        `UPDATE job_requirements
         SET status = 'cancelled',
             notes = COALESCE(notes, '') || ' [Cancelled]',
             updated_at = NOW()
         WHERE job_id = $1
           AND status NOT IN ('done', 'cancelled')
           AND keep_after_close = false`,
        [jobId]
      );

      // 4. Cancel vehicle assignments.
      //    Dual job match catches V&D-style rows (`job_id IS NULL`,
      //    only `hirehop_job_id` set). Exclude already-terminal states
      //    (returned / swapped) to avoid re-marking historic rows.
      //    Recompute fleet hire_status for each affected vehicle so the
      //    cached projection catches up immediately.
      const sweptVha = await query(
        `UPDATE vehicle_hire_assignments
           SET status = 'cancelled',
               status_changed_at = NOW(),
               notes = COALESCE(notes, '') || E'\n[Auto-cancelled: job cancelled]',
               updated_at = NOW()
         WHERE (job_id = $1
                OR (job_id IS NULL AND hirehop_job_id = $2::integer))
           AND status NOT IN ('cancelled', 'returned', 'swapped')
         RETURNING id, vehicle_id`,
        [jobId, job.hh_job_number ?? null]
      );
      if (sweptVha.rows.length > 0) {
        const { syncFleetHireStatus } = await import('../services/fleet-hire-status-sync');
        const seen = new Set<string>();
        for (const r of sweptVha.rows) {
          if (r.vehicle_id && !seen.has(r.vehicle_id)) {
            seen.add(r.vehicle_id);
            try { await syncFleetHireStatus(r.vehicle_id); }
            catch (e) { console.warn('[Cancellation] syncFleetHireStatus failed:', e); }
          }
        }
      }

      // 5a. Cancel the transport/crew quotes themselves. Without this the
      // Transport Ops page keeps showing them in their pre-existing ops
      // bucket (Arranging/Arranged/…) because effective_ops_status only
      // reads q.status/q.ops_status — not the parent job's state.
      await query(
        `UPDATE quotes
           SET status = 'cancelled',
               ops_status = 'cancelled',
               status_changed_at = NOW(),
               status_changed_by = $2,
               cancelled_reason = COALESCE(cancelled_reason, 'Parent job cancelled'),
               updated_at = NOW()
         WHERE job_id = $1
           AND is_deleted = false
           AND status NOT IN ('cancelled', 'completed')`,
        [jobId, userId]
      );

      // 5b. Cancel crew assignments + send emails
      const crewResult = await query(
        `SELECT qa.id, qa.role, qa.status, p.first_name, p.last_name, p.email
         FROM quote_assignments qa
         JOIN people p ON p.id = qa.person_id
         WHERE qa.quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
           AND qa.status NOT IN ('cancelled', 'declined')`,
        [jobId]
      );

      // Cancel all crew assignments
      if (crewResult.rows.length > 0) {
        await query(
          `UPDATE quote_assignments SET status = 'cancelled'
           WHERE quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
             AND status NOT IN ('cancelled', 'declined')`,
          [jobId]
        );
      }

      // Email crew members
      const jobNumber = job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW';
      const jobName = job.job_name || 'Untitled';
      const jobDates = [job.job_date, job.job_end].filter(Boolean).map(
        (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      ).join(' — ');

      for (const crew of crewResult.rows) {
        if (crew.email) {
          emailService.send('job_cancelled_crew', {
            to: crew.email,
            variables: {
              crewName: `${crew.first_name} ${crew.last_name}`.trim(),
              jobName,
              jobNumber,
              jobDates,
              crewRole: crew.role || 'Crew',
            },
          }).catch(err => console.error(`[Cancellation] Failed to email crew ${crew.email}:`, err));
        }
      }

      // 6. Flag excess records for refund — add cancellation note, don't change status
      // (staff processes actual refund via Money tab / excess ledger)
      await query(
        `UPDATE job_excess SET notes = COALESCE(notes, '') || ' [Job cancelled — refund due]', updated_at = NOW()
         WHERE job_id = $1 AND excess_status IN ('needed', 'taken', 'pre_auth', 'partially_paid')`,
        [jobId]
      );

      // 7. Write back to HireHop (status 9 = Cancelled)
      writeBackStatusToHireHop(jobId, 'cancelled', req.user!.email || userId)
        .catch(err => console.error('[Cancellation] HH write-back error:', err));

      // 8. Create pending refund record in job_payments if refund > 0
      if (cancellation_refund > 0) {
        try {
          await query(
            `INSERT INTO job_payments (job_id, payment_type, amount, payment_method, payment_status, notes, recorded_by)
             VALUES ($1, 'refund', $2, 'bank_transfer', 'pending', $3, $4)`,
            [jobId, cancellation_refund, `Cancellation refund — ${cancellation_reason}`, userId]
          );
        } catch (err) {
          console.warn('[Cancellation] Failed to create refund record:', err);
        }
      }

      // 9. Send internal notification email
      const frontendUrl = getFrontendUrl();
      emailService.send('job_cancelled_internal', {
        to: 'info@oooshtours.co.uk',
        variables: {
          cancelledBy: req.user!.email || 'Unknown',
          jobName,
          jobNumber,
          reason: cancellation_reason,
          fee: `£${cancellation_fee.toFixed(2)}`,
          refund: `£${cancellation_refund.toFixed(2)}`,
          jobUrl: `${frontendUrl}/jobs/${jobId}`,
        },
      }).catch(err => console.error('[Cancellation] Internal email failed:', err));

      // 10. Send client cancellation email — reason-aware intro paragraph.
      // The boilerplate "We're writing to confirm…" line worked for client-led
      // cancellations but read tone-deaf when the cancellation was Ooosh-side
      // (e.g. overbooked) or out of anyone's control (e.g. event cancelled).
      // Build the intro server-side and pass it as a template variable.
      // Plain text — the email-service substituter HTML-escapes variable
      // values, so any markup here would render as literal text. The static
      // template below already has a "Original dates" panel showing the job
      // number and name; the intro just needs to set the tone.
      const clientIntroByReason: Record<string, string> = {
        'Client cancelled': "We're writing to confirm that your booking has been cancelled at your request.",
        'Event cancelled': "We're sorry to hear the event has been cancelled. We're writing to confirm that your booking has been cancelled accordingly.",
        'Date change': "Following the date change, we're writing to confirm that your original booking has been cancelled. Please get in touch if you'd like us to set up the new dates.",
        'Venue change': "Following the venue change, we're writing to confirm that your original booking has been cancelled. Please get in touch if you'd like to rebook for the new venue.",
        'Budget': "We're writing to confirm that your booking has been cancelled.",
        'Overbooked': "Unfortunately we're no longer able to fulfil your booking due to a clash on our end, and we're writing to confirm that the booking has been cancelled. We're very sorry for the inconvenience.",
        'Other': "We're writing to confirm that your booking has been cancelled.",
      };
      const clientIntro = clientIntroByReason[cancellation_reason] || clientIntroByReason['Other'];

      // Opt-out via the modal checkbox. Default true (Zod default applies).
      // When skipped we still log a timeline note so the audit trail records
      // the deliberate decision — not just an email that silently didn't send.
      if (send_client_email === false) {
        await query(
          `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
           VALUES ('note', $1, $2, $3, 'cancelled', 'system')`,
          [
            `Client cancellation email skipped (opt-out at cancellation by ${req.user!.email}).`,
            jobId,
            userId,
          ]
        ).catch(err => console.warn('[Cancellation] Failed to log email-skip:', err));
      }

      if (send_client_email !== false) (async () => {
        try {
          const target = await resolveClientEmailTarget(jobId, 'job_cancelled_client');

          // Three balance states the email needs to convey, mutually exclusive:
          //   1. refundAmount > 0      — we owe the client
          //   2. outstandingBalance > 0 — client still owes us
          //   3. all-square            — deposit paid covers the fee exactly
          // Variables are passed as plain strings (empty = falsy for the
          // {{#if}} block resolver), so the template renders the right panel.
          // Markup lives in the template — variables are NEVER raw HTML; the
          // substituter HTML-escapes everything.
          const feeIncVat = cancellation_fee * 1.2;
          const outstandingBalance = Number(cancellation_outstanding_balance || 0);
          const refundAmount = cancellation_refund > 0 ? cancellation_refund.toFixed(2) : '';
          const outstandingStr = outstandingBalance > 0 ? outstandingBalance.toFixed(2) : '';
          const allSquare = cancellation_fee > 0 && cancellation_refund <= 0 && outstandingBalance <= 0;
          const feeAmountStr = cancellation_fee > 0 ? cancellation_fee.toFixed(2) : '';
          const feeIncVatStr = cancellation_fee > 0 ? feeIncVat.toFixed(2) : '';

          await emailService.send('job_cancelled_client', {
            to: target.primaryEmail,
            cc: target.ccEmails.length > 0 ? target.ccEmails : undefined,
            prependBanner: target.isFallback
              ? buildFallbackBanner({
                  jobId,
                  clientName: target.clientName,
                  jobNumber: target.jobNumber,
                  jobName: target.jobName,
                })
              : undefined,
            variables: {
              clientName: target.primaryFirstName,
              jobNumber,
              jobName,
              jobDates,
              clientIntro,
              refundAmount,
              outstandingBalance: outstandingStr,
              showAllSquare: allSquare ? '1' : '',
              feeAmount: feeAmountStr,
              feeIncVat: feeIncVatStr,
            },
          });
          if (target.isFallback) {
            await logFallbackToTimeline({ jobId, templateId: 'job_cancelled_client' });
          }
        } catch (err) {
          console.error('[Cancellation] Client email failed:', err);
        }
      })();

      // 11. Create cancellation close-out requirements (same pattern as returns close-out)
      try {
        const ensureReq = async (type: string, notes: string) => {
          const exists = await query(
            `SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = $2 AND phase = 'post_hire'`,
            [jobId, type]
          );
          if (exists.rows.length === 0) {
            await query(
              `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
               VALUES ($1, $2, 'not_started', $3, true, 'cancellation', 'post_hire')`,
              [jobId, type, notes]
            );
          }
        };

        // Always: invoice for cancellation fee
        if (cancellation_fee > 0) {
          await ensureReq('invoice', `Create HireHop invoice for cancellation fee: £${cancellation_fee.toFixed(2)} + VAT (£${(cancellation_fee * 1.2).toFixed(2)} gross)`);
        }

        // Always: client follow-up (confirm cancellation received, handle any queries)
        await ensureReq('client_followup', 'Confirm client received cancellation notification');

        // If refund due: payment reconciliation
        if (cancellation_refund > 0) {
          await ensureReq('payment_reconcile', `Process refund of £${cancellation_refund.toFixed(2)} to client (10 working day target)`);
        }

        // If excess records: resolve them
        const excessCount = await query(
          `SELECT COUNT(*) AS cnt FROM job_excess WHERE job_id = $1`,
          [jobId]
        );
        if (parseInt(excessCount.rows[0]?.cnt || '0') > 0) {
          await ensureReq('excess_resolve', 'Resolve insurance excess — reimburse or waive');
        }
      } catch (err) {
        console.warn('[Cancellation] Failed to create close-out requirements:', err);
      }

      // 12. Log audit
      await logAudit(userId, 'jobs', jobId, 'update', job, { pipeline_status: 'cancelled', cancellation_reason });

      res.json({ success: true, message: 'Job cancelled successfully' });
    } catch (error) {
      console.error('Process cancellation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── List cancelled + lost jobs ──────────────────────────────────────────

router.get('/list', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, page = '1', limit = '50', sort = 'date_desc', search,
      lost_reason, cancellation_tier, manager,
      date_from, date_to,           // Date the job was lost / cancelled (not job dates)
      value_min, value_max,
      notice_period,                // 'same_day' | 'within_week' | 'within_month' | 'over_month' (Cancelled only)
      outstanding_closeout,         // 'true' = jobs with at least one open post_hire requirement
      hide_reopened,                // 'true' = hide jobs that have a reopened_to_job_id set
    } = req.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = `j.is_deleted = false AND j.pipeline_status IN ('lost', 'cancelled')`;
    const params: unknown[] = [];
    let pIdx = 1;

    if (status === 'cancelled') {
      whereClause = `j.is_deleted = false AND j.pipeline_status = 'cancelled'`;
    } else if (status === 'lost') {
      whereClause = `j.is_deleted = false AND j.pipeline_status = 'lost'`;
    }

    // Search now includes hh_job_number — was the missing search target.
    if (search) {
      whereClause += ` AND (j.job_name ILIKE $${pIdx} OR j.company_name ILIKE $${pIdx} OR j.client_name ILIKE $${pIdx} OR CAST(j.hh_job_number AS TEXT) ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    if (lost_reason) {
      whereClause += ` AND j.lost_reason = $${pIdx}`;
      params.push(lost_reason);
      pIdx++;
    }

    if (cancellation_tier) {
      whereClause += ` AND j.cancellation_tier = $${pIdx}`;
      params.push(cancellation_tier);
      pIdx++;
    }

    if (manager) {
      whereClause += ` AND (j.manager1_person_id = $${pIdx} OR j.manager2_person_id = $${pIdx})`;
      params.push(manager);
      pIdx++;
    }

    // Date range filter — applies to lost_at OR cancelled_at depending on
    // which is set. COALESCE picks whichever one the job has.
    if (date_from) {
      whereClause += ` AND COALESCE(j.cancelled_at, j.lost_at) >= $${pIdx}`;
      params.push(date_from);
      pIdx++;
    }
    if (date_to) {
      // Inclusive end-of-day
      whereClause += ` AND COALESCE(j.cancelled_at, j.lost_at) < ($${pIdx}::date + INTERVAL '1 day')`;
      params.push(date_to);
      pIdx++;
    }

    if (value_min) {
      whereClause += ` AND j.job_value >= $${pIdx}`;
      params.push(parseFloat(value_min));
      pIdx++;
    }
    if (value_max) {
      whereClause += ` AND j.job_value <= $${pIdx}`;
      params.push(parseFloat(value_max));
      pIdx++;
    }

    // Notice period bucket (Cancelled tab only — based on cancellation_notice_days)
    if (notice_period === 'same_day') {
      whereClause += ` AND j.cancellation_notice_days = 0`;
    } else if (notice_period === 'within_week') {
      whereClause += ` AND j.cancellation_notice_days > 0 AND j.cancellation_notice_days < 7`;
    } else if (notice_period === 'within_month') {
      whereClause += ` AND j.cancellation_notice_days >= 7 AND j.cancellation_notice_days < 30`;
    } else if (notice_period === 'over_month') {
      whereClause += ` AND j.cancellation_notice_days >= 30`;
    }

    // Outstanding close-out toggle: show only jobs with at least one open
    // post_hire requirement (status not in done/cancelled).
    if (outstanding_closeout === 'true') {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM job_requirements jr
        WHERE jr.job_id = j.id
          AND jr.phase = 'post_hire'
          AND jr.status NOT IN ('done', 'cancelled')
      )`;
    }

    // Hide jobs that have been re-opened (have reopened_to_job_id set)
    if (hide_reopened === 'true') {
      whereClause += ` AND j.reopened_to_job_id IS NULL`;
    }

    let orderBy = 'j.cancelled_at DESC NULLS LAST, j.lost_at DESC NULLS LAST';
    if (sort === 'date_asc') orderBy = 'COALESCE(j.cancelled_at, j.lost_at) ASC NULLS LAST';
    if (sort === 'value_desc') orderBy = 'j.job_value DESC NULLS LAST';
    if (sort === 'value_asc') orderBy = 'j.job_value ASC NULLS LAST';
    if (sort === 'name') orderBy = 'j.job_name ASC';

    const countResult = await query(
      `SELECT COUNT(*) FROM jobs j WHERE ${whereClause}`, params
    );

    params.push(parseInt(limit), offset);
    const result = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.company_name, j.client_name,
              j.job_date, j.job_end, j.job_value, j.pipeline_status,
              j.lost_reason, j.lost_detail, j.lost_at,
              j.cancelled_at, j.cancellation_reason, j.cancellation_fee,
              j.cancellation_refund, j.cancellation_tier, j.cancellation_notice_days,
              j.cancellation_notes, j.reopened_to_job_id,
              m1p.first_name as manager1_first_name, m1p.last_name as manager1_last_name
       FROM jobs j
       LEFT JOIN people m1p ON m1p.id = j.manager1_person_id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
      params
    );

    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error('List cancelled/lost error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Re-open cancelled job as new booking ────────────────────────────────

router.post(
  '/:jobId/reopen',
  authorize('admin', 'manager'),
  async (req: AuthRequest, res: Response) => {
    try {
      const jobId = req.params.jobId as string;

      const jobResult = await query(
        `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
        [jobId]
      );
      if (jobResult.rows.length === 0) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      const job = jobResult.rows[0];
      if (job.pipeline_status !== 'cancelled') {
        res.status(400).json({ error: 'Only cancelled jobs can be re-opened as new bookings' });
        return;
      }

      let newHhJobNumber: number | null = null;

      // If the original had an HH job, duplicate it in HireHop (copies items, dates, etc.)
      if (job.hh_job_number) {
        try {
          const hhResult = await hhBroker.post('/php_functions/job_duplicate.php', {
            id: job.hh_job_number,
            supplying: 1,       // Copy the items/supplying list
            notes: 1,           // Copy notes
            transport: 1,       // Copy transport
            reserved: 1,        // Copy reserved items (conflicts omitted)
            job_name: `${job.job_name || 'Job'} (rebooking)`,
            local: new Date().toISOString().replace('T', ' ').substring(0, 16),
          }, { priority: 'high' });

          const hhData = hhResult?.data as { job?: number } | undefined;
          if (hhData?.job) {
            newHhJobNumber = hhData.job;
            console.log(`[Cancellation] HH duplicate created: J-${newHhJobNumber}`);

            // Update HH job dates to 09:00 (duplicate may use current time)
            try {
              const fmtHH = (d: string | null) => {
                if (!d) return null;
                return new Date(d).toISOString().split('T')[0] + ' 09:00';
              };
              const dateParams: Record<string, unknown> = {
                job: newHhJobNumber,
                no_webhook: 1,
              };
              if (job.out_date) dateParams.out = fmtHH(job.out_date);
              if (job.job_date) dateParams.start = fmtHH(job.job_date);
              if (job.job_end) dateParams.end = fmtHH(job.job_end);
              if (job.return_date) dateParams.to = fmtHH(job.return_date);
              await hhBroker.post('/api/save_job.php', dateParams, { priority: 'high' });
            } catch {
              console.error('[Cancellation] HH date update failed (non-fatal)');
            }
          } else {
            console.warn('[Cancellation] HH duplicate returned no job number:', hhResult);
          }
        } catch (hhErr) {
          console.error('[Cancellation] HH duplicate failed:', hhErr);
          // Continue without HH — create OP job anyway
        }
      }

      // Copy dates from original job, normalising times to 09:00
      const normaliseDateTo0900 = (d: string | null): string | null => {
        if (!d) return null;
        const dateStr = new Date(d).toISOString().split('T')[0];
        return `${dateStr} 09:00`;
      };
      const outDate = normaliseDateTo0900(job.out_date);
      const jobDate = normaliseDateTo0900(job.job_date);
      const jobEnd = normaliseDateTo0900(job.job_end);
      const returnDate = normaliseDateTo0900(job.return_date);

      // Create new job in OP with all relevant fields from original
      const newJobResult = await query(
        `INSERT INTO jobs (
          hh_job_number, job_name, job_type, client_id, client_name, company_name, client_ref,
          venue_id, venue_name, address,
          out_date, job_date, job_end, return_date,
          duration_days, duration_hrs,
          manager1_name, manager1_person_id, manager2_name, manager2_person_id,
          hh_project_id, project_name,
          details, notes, custom_index, depot_name,
          enquiry_source, likelihood,
          pipeline_status, pipeline_status_changed_at,
          reopened_from_job_id, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16,
          $17, $18, $19, $20,
          $21, $22,
          $23, $24, $25, $26,
          $27, $28,
          'new_enquiry', NOW(),
          $29, $30
        ) RETURNING id, hh_job_number`,
        [
          newHhJobNumber,
          `${job.job_name || 'Job'} (rebooking)`,
          job.job_type,
          job.client_id, job.client_name, job.company_name, job.client_ref,
          job.venue_id, job.venue_name, job.address,
          outDate, jobDate, jobEnd, returnDate,
          job.duration_days, job.duration_hrs,
          job.manager1_name, job.manager1_person_id, job.manager2_name, job.manager2_person_id,
          job.hh_project_id, job.project_name,
          job.details, job.notes, job.custom_index, job.depot_name,
          job.enquiry_source, 'hot',
          jobId, req.user!.id,
        ]
      );

      const newJob = newJobResult.rows[0];

      // Copy job_organisations links (band, client, promoter etc.)
      try {
        await query(
          `INSERT INTO job_organisations (job_id, organisation_id, role)
           SELECT $1, organisation_id, role FROM job_organisations WHERE job_id = $2`,
          [newJob.id, jobId]
        );
      } catch (e) { console.warn('[Cancellation] Failed to copy job_organisations:', e); }

      // Link the original job to the new one
      await query(
        `UPDATE jobs SET reopened_to_job_id = $1 WHERE id = $2`,
        [newJob.id, jobId]
      );

      // Log on both timelines
      const origNote = `Re-opened as new booking ${newHhJobNumber ? `J-${newHhJobNumber}` : newJob.id}`;
      const newNote = `Rebooking from cancelled job ${job.hh_job_number ? `J-${job.hh_job_number}` : jobId}`;

      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
         VALUES ('note', $1, $2, $3, 'cancelled', 'system')`,
        [origNote, jobId, req.user!.id]
      );
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
         VALUES ('note', $1, $2, $3, 'new_enquiry', 'system')`,
        [newNote, newJob.id, req.user!.id]
      );

      res.json({
        success: true,
        newJobId: newJob.id,
        newHhJobNumber,
        message: `Job re-opened as new booking${newHhJobNumber ? ` (J-${newHhJobNumber})` : ''}`,
      });
    } catch (error) {
      console.error('Reopen cancelled job error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
