/**
 * Webhook Receiver Routes
 *
 * Handles inbound webhooks from external systems:
 * - HireHop: job status changes, job updates, contact changes
 * - Future: Stripe payment events, etc.
 *
 * These endpoints are NOT authenticated via JWT — they use export_key
 * or API key verification instead.
 */
import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { HH_TO_PIPELINE } from '../services/hirehop-writeback';
import { verifyApiKey } from '../middleware/api-key';
import {
  triggerHireFormEmailOnConfirmation,
  triggerCarnetFormOnConfirmation,
  hireFormResultIsAnomaly,
  sendConfirmationSilentSkipAlert,
} from '../services/confirmation-hooks';
import { reactivateAutoCancelledRequirements } from '../services/requirement-cleanup';

const router = Router();

// ── HireHop Export Key verification ──────────────────────────────────────

function verifyHireHopWebhook(exportKey: string | undefined): boolean {
  const expected = process.env.HIREHOP_EXPORT_KEY;
  if (!expected) {
    console.warn('[Webhook] HIREHOP_EXPORT_KEY not configured — accepting all webhooks (INSECURE)');
    return true;
  }
  return exportKey === expected;
}

// ── Pipeline status labels for transition logging ────────────────────────

const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiries',
  quoting: 'Enquiries',
  chasing: 'Chasing',
  paused: 'Paused Enquiry',
  provisional: 'Provisional',
  confirmed: 'Confirmed',
  prepping: 'Prepping',
  prepped: 'Prepped',
  dispatched: 'On Hire',
  returned_incomplete: 'Checking In',
  returned: 'Returned',
  completed: 'Completed',
  cancelled: 'Cancelled',
  lost: 'Lost',
};

// ── HireHop Webhook Receiver — GET for URL verification ──────────────────

router.get('/hirehop', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'Ooosh Operations Platform',
    endpoint: 'HireHop Webhook Receiver',
    accepts: 'POST',
    timestamp: new Date().toISOString(),
  });
});

// ── HireHop Webhook Receiver ─────────────────────────────────────────────

router.post('/hirehop', async (req: Request, res: Response) => {
  const startTime = Date.now();

  // ── Raw request diagnostics (always log) ──────────────────────────────
  console.log('[Webhook] ══════════════════════════════════════════════════');
  console.log('[Webhook] Incoming POST /api/webhooks/hirehop');
  console.log('[Webhook] Content-Type:', req.headers['content-type']);
  console.log('[Webhook] User-Agent:', req.headers['user-agent']);
  console.log('[Webhook] IP:', req.ip || req.socket.remoteAddress);
  console.log('[Webhook] Body type:', typeof req.body, '| Keys:', req.body ? Object.keys(req.body) : 'null');
  console.log('[Webhook] Raw body:', JSON.stringify(req.body).substring(0, 500));
  console.log('[Webhook] ══════════════════════════════════════════════════');

  // Log the raw webhook immediately
  let logId: string | null = null;
  try {
    const logResult = await query(
      `INSERT INTO webhook_log (source, event, payload)
       VALUES ('hirehop', $1, $2)
       RETURNING id`,
      [req.body?.event || 'unknown', JSON.stringify(req.body)],
    );
    logId = logResult.rows[0].id;
  } catch (err) {
    console.error('[Webhook] Failed to log webhook:', err);
  }

  // Respond quickly — HireHop doesn't wait for our response
  res.status(200).json({ received: true });

  // Now process asynchronously
  try {
    const { event, data, changes, export_key, job: topLevelJobId } = req.body || {};

    // Verify authenticity
    if (!verifyHireHopWebhook(export_key)) {
      console.warn('[Webhook] Invalid export_key — rejecting');
      await updateWebhookLog(logId, false, { error: 'Invalid export_key' });
      return;
    }

    if (!event) {
      await updateWebhookLog(logId, false, { error: 'No event field' });
      return;
    }

    console.log(`[Webhook] HireHop event: ${event}, job: ${topLevelJobId || 'none'}`);

    let result: { success: boolean; message: string; changes?: Record<string, unknown> };

    // Route to appropriate handler — pass top-level job ID from webhook payload
    if (event.startsWith('job.status')) {
      result = await handleJobStatusChange(data, changes, topLevelJobId);
    } else if (event.startsWith('job.')) {
      result = await handleJobUpdate(event, data, changes, topLevelJobId);
    } else if (event.startsWith('contact.')) {
      result = await handleContactChange(event, data, changes);
    } else {
      result = { success: true, message: `Unhandled event type: ${event} — logged only` };
    }

    const processingMs = Date.now() - startTime;
    console.log(`[Webhook] ${event} processed in ${processingMs}ms: ${result.message}`);

    await updateWebhookLog(logId, result.success, {
      message: result.message,
      changes: result.changes,
      processingMs,
    });
  } catch (err) {
    console.error('[Webhook] Processing error:', err);
    await updateWebhookLog(logId, false, { error: String(err) });
  }
});

// ── Job Status Change Handler ────────────────────────────────────────────

async function handleJobStatusChange(
  data: Record<string, unknown> | undefined,
  changes: Record<string, unknown> | undefined,
  topLevelJobId?: number | string,
): Promise<{ success: boolean; message: string; changes?: Record<string, unknown> }> {
  if (!data && !topLevelJobId) {
    return { success: false, message: 'No data in webhook payload' };
  }

  // Extract job number — HireHop sends it as top-level "job" field,
  // or sometimes inside data as ID/NUMBER
  const jobNumber = topLevelJobId || data?.NUMBER || data?.job || data?.ID;
  if (!jobNumber) {
    return { success: false, message: 'No job number in webhook data' };
  }

  // Get the new status from changes or data
  let newHHStatus: number | null = null;
  if (changes && typeof changes === 'object') {
    // changes.STATUS might be { from: X, to: Y } or just the new value
    const statusChange = (changes as Record<string, unknown>).STATUS;
    if (statusChange && typeof statusChange === 'object' && 'to' in (statusChange as Record<string, unknown>)) {
      newHHStatus = Number((statusChange as Record<string, unknown>).to);
    } else if (typeof statusChange === 'number') {
      newHHStatus = statusChange;
    }
  }
  if (newHHStatus === null && data?.STATUS !== undefined) {
    newHHStatus = Math.floor(Number(data.STATUS));
  }

  if (newHHStatus === null) {
    return { success: false, message: 'Could not determine new status from webhook' };
  }

  // Find the job in our database
  const jobResult = await query(
    `SELECT id, pipeline_status, status as current_hh_status, hh_job_number
     FROM jobs WHERE hh_job_number = $1 AND is_deleted = false`,
    [Number(jobNumber)],
  );

  if (jobResult.rows.length === 0) {
    return { success: true, message: `Job ${jobNumber} not found in Ooosh — may be new, will be picked up by next sync` };
  }

  const job = jobResult.rows[0];
  const oldHHStatus = job.current_hh_status;

  // Always update the HH status fields
  await query(
    `UPDATE jobs SET status = $1, hh_status = $1, status_name = $2, updated_at = NOW()
     WHERE id = $3`,
    [newHHStatus, getHHStatusName(newHHStatus), job.id],
  );

  // Map to pipeline status if applicable
  const newPipelineStatus = HH_TO_PIPELINE[newHHStatus];
  const statusChanges: Record<string, unknown> = {
    hh_status: { from: oldHHStatus, to: newHHStatus },
  };

  if (newPipelineStatus && newPipelineStatus !== job.pipeline_status) {
    // Update pipeline status too
    const fromLabel = PIPELINE_LABELS[job.pipeline_status] || job.pipeline_status;
    const toLabel = PIPELINE_LABELS[newPipelineStatus] || newPipelineStatus;

    // Clear chase date when moving out of an enquiry-stage status — chases
    // belong to the pre-confirmation pipeline; once the job is past that, the
    // reminders system handles any genuine follow-ups.
    const enquiryStages = ['new_enquiry', 'quoting', 'chasing', 'paused', 'provisional'];
    const clearChase = !enquiryStages.includes(newPipelineStatus);

    // Sanity-check marker clears (migration 102) — when leaving a state
    // the scanner watches over, drop its marker so the next entry to
    // that state is allowed to warn afresh.
    const clearDispatchMarker =
      job.pipeline_status === 'dispatched' && newPipelineStatus !== 'dispatched';
    const clearReturnedMarker =
      job.pipeline_status === 'returned' && newPipelineStatus !== 'returned';

    await query(
      `UPDATE jobs SET pipeline_status = $1, pipeline_status_changed_at = NOW(), updated_at = NOW()
         ${clearChase ? ', next_chase_date = NULL' : ''}
         ${clearDispatchMarker ? ', under_dispatch_warned_at = NULL' : ''}
         ${clearReturnedMarker ? ', returned_bookedout_warned_at = NULL' : ''}
       WHERE id = $2`,
      [newPipelineStatus, job.id],
    );

    // Resurrection: reverse the Lost / Cancelled requirement sweep when HH
    // moves the job back out of lost/cancelled. Marker-gated so staff-cancelled
    // rows stay cancelled. See CLAUDE.md → "Lost / Cancelled cleanup pattern".
    if (
      (job.pipeline_status === 'lost' && newPipelineStatus !== 'lost') ||
      (job.pipeline_status === 'cancelled' && newPipelineStatus !== 'cancelled')
    ) {
      try {
        const reactivated = await reactivateAutoCancelledRequirements(job.id);
        if (reactivated.reactivatedCount > 0) {
          console.log(
            `[Webhook] Reactivated ${reactivated.reactivatedCount} auto-cancelled requirement(s) on resurrection (${job.pipeline_status} → ${newPipelineStatus}) for job ${job.id}`,
          );
        }
      } catch (reactivateErr) {
        console.warn('[Webhook] Failed to reactivate auto-cancelled requirements:', reactivateErr);
      }
    }

    // Log as interaction (status transition)
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, NULL, $3)`,
      [
        `Status changed via HireHop: ${fromLabel} → ${toLabel}`,
        job.id,
        job.pipeline_status,
      ],
    );

    statusChanges.pipeline_status = { from: job.pipeline_status, to: newPipelineStatus };

    // Returned-bookedout safety net is now the scheduled scanner (see
    // services/sanity-check-scanner.ts). It picks the job up after a
    // 20-min grace, dedupes by vehicle (multi-driver hire = one van),
    // and stamps `returned_bookedout_warned_at` so at most one email
    // fires per transition.

    // Hire form email + silent-skip alerting on confirmation. Pre-May 2026
    // the HH webhook didn't trigger this, so any job confirmed by HH staff
    // (rather than via OP UI / payment portal) silently skipped both the
    // on-confirmation send AND was at the mercy of the daily 09:00 scheduler
    // hitting the exact 10-day mark.
    if (newPipelineStatus === 'confirmed' && job.pipeline_status !== 'confirmed') {
      void (async () => {
        try {
          const hfResult = await triggerHireFormEmailOnConfirmation(job.id);
          triggerCarnetFormOnConfirmation(job.id).catch(() => {});
          const anomaly = hireFormResultIsAnomaly(hfResult);
          if (anomaly) {
            const jobRow = await query(
              `SELECT hh_job_number, job_name, client_name FROM jobs WHERE id = $1`,
              [job.id]
            );
            const j = jobRow.rows[0] || {};
            await sendConfirmationSilentSkipAlert({
              jobId: job.id,
              jobNumber: j.hh_job_number,
              jobName: j.job_name ?? null,
              clientName: j.client_name ?? null,
              triggerSource: 'status_change',
              issues: [anomaly],
            });
          }
        } catch (err) {
          console.error('[Webhook] Hire form email on confirmation failed:', err);
        }
      })();
    }

    return {
      success: true,
      message: `Job ${jobNumber}: HH status ${oldHHStatus} → ${newHHStatus}, pipeline ${job.pipeline_status} → ${newPipelineStatus}`,
      changes: statusChanges,
    };
  }

  // HH status updated but no pipeline change needed (operational statuses 3-8, 11)
  return {
    success: true,
    message: `Job ${jobNumber}: HH status ${oldHHStatus} → ${newHHStatus} (${getHHStatusName(newHHStatus)}), no pipeline change`,
    changes: statusChanges,
  };
}

// ── Job Update Handler (non-status changes) ──────────────────────────────

async function handleJobUpdate(
  event: string,
  data: Record<string, unknown> | undefined,
  _changes: Record<string, unknown> | undefined,
  topLevelJobId?: number | string,
): Promise<{ success: boolean; message: string }> {
  if (!data && !topLevelJobId) {
    return { success: false, message: 'No data in webhook payload' };
  }

  const jobNumber = topLevelJobId || data?.NUMBER || data?.job || data?.ID;
  if (!jobNumber) {
    return { success: true, message: 'No job number — logged only' };
  }

  // For job updates (name, dates, client, etc.), update our record
  const jobResult = await query(
    `SELECT id FROM jobs WHERE hh_job_number = $1 AND is_deleted = false`,
    [Number(jobNumber)],
  );

  if (jobResult.rows.length === 0) {
    return { success: true, message: `Job ${jobNumber} not in Ooosh — will be picked up by sync` };
  }

  // Update HH-owned fields if present in the data
  const updates: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let pIdx = 1;

  const fieldMap: Record<string, string> = {
    JOB_NAME: 'job_name',
    CLIENT: 'client_name',
    COMPANY: 'company_name',
    CLIENT_REF: 'client_ref',
    VENUE: 'venue_name',
    OUT_DATE: 'out_date',
    JOB_DATE: 'job_date',
    JOB_END: 'job_end',
    RETURN_DATE: 'return_date',
    MANAGER: 'manager1_name',
    MANAGER2: 'manager2_name',
    MONEY: 'job_value',
  };

  // HH search_list / webhook payloads decorate JOB_NAME for sub-jobs as
  // "<Project> ► <Leaf>". OP stores the leaf — strip the prefix on inbound.
  const { stripProjectPrefix } = await import('../services/hirehop-job-sync');

  for (const [hhField, dbField] of Object.entries(fieldMap)) {
    if (data && data[hhField] !== undefined) {
      const raw = data[hhField];
      const value = hhField === 'JOB_NAME' && typeof raw === 'string'
        ? stripProjectPrefix(raw)
        : (raw || null);
      updates.push(`${dbField} = $${pIdx}`);
      params.push(value);
      pIdx++;
    }
  }

  if (params.length > 0) {
    params.push(jobResult.rows[0].id);
    await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${pIdx}`,
      params,
    );
  }

  // Trigger line item re-fetch + requirement derivation on any job update
  // (non-blocking — don't fail the webhook if derivation errors)
  const jobId = jobResult.rows[0].id;
  setImmediate(async () => {
    try {
      const { fetchLineItemsOnDemand } = await import('../services/hirehop-job-sync');
      const items = await fetchLineItemsOnDemand(Number(jobNumber));
      await query(
        `UPDATE jobs SET line_items = $1, line_items_synced_at = NOW() WHERE id = $2`,
        [JSON.stringify(items), jobId]
      );
      const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
      const result = await deriveRequirementsForJob(jobId);
      if (result.requirementsCreated.length > 0 || result.mismatchesFlagged.length > 0) {
        console.log(`[Webhook] Derivation for job ${jobNumber}: created=${result.requirementsCreated.join(',')}, mismatches=${result.mismatchesFlagged.join(',')}`);
      }
    } catch (err) {
      console.warn(`[Webhook] Derivation failed for job ${jobNumber}:`, err);
    }
  });

  return {
    success: true,
    message: params.length > 0
      ? `Job ${jobNumber} updated (${params.length - 1} fields) via ${event} + derivation triggered`
      : `Job ${jobNumber}: ${event} — derivation triggered`,
  };
}

// ── Contact Change Handler ───────────────────────────────────────────────

async function handleContactChange(
  event: string,
  data: Record<string, unknown> | undefined,
  _changes: Record<string, unknown> | undefined,
): Promise<{ success: boolean; message: string }> {
  // For contact changes, we just log them. The next contact sync will pick up changes.
  // Real-time contact sync is lower priority than job status sync.
  const contactId = data?.ID || data?.id;
  return {
    success: true,
    message: `Contact event ${event} for ID ${contactId} — logged, will be picked up by next contact sync`,
  };
}

// ── External Status Transition Endpoint ──────────────────────────────────
// For external systems (payment portal, etc.) to push status changes

router.post('/external/status-transition', async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      res.status(401).json({ error: 'X-API-Key header required' });
      return;
    }

    // Verify API key (full bcrypt comparison via shared helper — the inline
    // implementation that was here matched only on key_prefix and accepted
    // any string starting with `ppk_live` as authenticated).
    const matched = await verifyApiKey(apiKey);
    if (!matched) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    const { hirehop_job_id, new_status, trigger, source, metadata } = req.body;

    if (!hirehop_job_id || new_status === undefined) {
      res.status(400).json({ error: 'hirehop_job_id and new_status required' });
      return;
    }

    // Log the webhook
    await query(
      `INSERT INTO webhook_log (source, event, payload)
       VALUES ($1, 'status_transition', $2)`,
      [source || matched.service, JSON.stringify(req.body)],
    );

    // Find the job
    const jobResult = await query(
      `SELECT id, pipeline_status FROM jobs WHERE hh_job_number = $1 AND is_deleted = false`,
      [hirehop_job_id],
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: `Job with HireHop ID ${hirehop_job_id} not found` });
      return;
    }

    const job = jobResult.rows[0];
    const newPipelineStatus = HH_TO_PIPELINE[new_status];

    if (!newPipelineStatus) {
      res.status(400).json({ error: `No pipeline mapping for HireHop status ${new_status}` });
      return;
    }

    if (newPipelineStatus === job.pipeline_status) {
      res.json({ success: true, message: 'Already at target status', job_id: job.id });
      return;
    }

    // Clear chase date when moving out of an enquiry-stage status — chases
    // belong to the pre-confirmation pipeline; once past that, the reminders
    // system handles any genuine follow-ups.
    const enquiryStages = ['new_enquiry', 'quoting', 'chasing', 'paused', 'provisional'];
    const clearChase = !enquiryStages.includes(newPipelineStatus);

    // Update pipeline status
    await query(
      `UPDATE jobs SET
         pipeline_status = $1, pipeline_status_changed_at = NOW(),
         status = $2, hh_status = $2, status_name = $3,
         updated_at = NOW()
         ${clearChase ? ', next_chase_date = NULL' : ''}
       WHERE id = $4`,
      [newPipelineStatus, new_status, getHHStatusName(new_status), job.id],
    );

    // Resurrection: reverse the Lost / Cancelled requirement sweep when an
    // external caller moves the job back out of lost/cancelled. Marker-gated
    // so staff-cancelled rows stay cancelled.
    if (
      (job.pipeline_status === 'lost' && newPipelineStatus !== 'lost') ||
      (job.pipeline_status === 'cancelled' && newPipelineStatus !== 'cancelled')
    ) {
      try {
        const reactivated = await reactivateAutoCancelledRequirements(job.id);
        if (reactivated.reactivatedCount > 0) {
          console.log(
            `[Webhook/external] Reactivated ${reactivated.reactivatedCount} auto-cancelled requirement(s) on resurrection (${job.pipeline_status} → ${newPipelineStatus}) for job ${job.id}`,
          );
        }
      } catch (reactivateErr) {
        console.warn('[Webhook/external] Failed to reactivate auto-cancelled requirements:', reactivateErr);
      }
    }

    // Log transition
    const fromLabel = PIPELINE_LABELS[job.pipeline_status] || job.pipeline_status;
    const toLabel = PIPELINE_LABELS[newPipelineStatus] || newPipelineStatus;

    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, NULL, $3)`,
      [
        `Status changed via ${source || 'external'}: ${fromLabel} → ${toLabel}${trigger ? ` (${trigger})` : ''}`,
        job.id,
        job.pipeline_status,
      ],
    );

    res.json({
      success: true,
      message: `Pipeline status updated: ${job.pipeline_status} → ${newPipelineStatus}`,
      job_id: job.id,
    });
  } catch (error) {
    console.error('[Webhook] External status transition error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function updateWebhookLog(
  logId: string | null,
  success: boolean,
  result: Record<string, unknown>,
): Promise<void> {
  if (!logId) return;
  try {
    await query(
      `UPDATE webhook_log SET processed = true, processing_result = $1, processed_at = NOW()
       ${!success ? ', error = $3' : ''}
       WHERE id = $2`,
      success
        ? [JSON.stringify(result), logId]
        : [JSON.stringify(result), logId, result.error || result.message],
    );
  } catch {
    // Non-critical
  }
}

function getHHStatusName(status: number): string {
  const names: Record<number, string> = {
    0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
    4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
    7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
    10: 'Not Interested', 11: 'Completed',
  };
  return names[status] || `Unknown (${status})`;
}

export default router;
