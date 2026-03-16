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
    const { event, data, changes, export_key } = req.body || {};

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

    console.log(`[Webhook] HireHop event: ${event}`);

    let result: { success: boolean; message: string; changes?: Record<string, unknown> };

    // Route to appropriate handler
    if (event.startsWith('job.status')) {
      result = await handleJobStatusChange(data, changes);
    } else if (event.startsWith('job.')) {
      result = await handleJobUpdate(event, data, changes);
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
): Promise<{ success: boolean; message: string; changes?: Record<string, unknown> }> {
  if (!data) {
    return { success: false, message: 'No data in webhook payload' };
  }

  // Extract job number — HireHop may send it as ID, NUMBER, or job
  const jobNumber = data.NUMBER || data.job || data.ID;
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
  if (newHHStatus === null && data.STATUS !== undefined) {
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

    await query(
      `UPDATE jobs SET pipeline_status = $1, pipeline_status_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newPipelineStatus, job.id],
    );

    // Log as interaction (status transition)
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, $3, $4)`,
      [
        `Status changed via HireHop: ${fromLabel} → ${toLabel}`,
        job.id,
        'system',  // system user for webhook-triggered changes
        job.pipeline_status,
      ],
    );

    statusChanges.pipeline_status = { from: job.pipeline_status, to: newPipelineStatus };

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
): Promise<{ success: boolean; message: string }> {
  if (!data) {
    return { success: false, message: 'No data in webhook payload' };
  }

  const jobNumber = data.NUMBER || data.job || data.ID;
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

  for (const [hhField, dbField] of Object.entries(fieldMap)) {
    if (data[hhField] !== undefined) {
      updates.push(`${dbField} = $${pIdx}`);
      params.push(data[hhField] || null);
      pIdx++;
    }
  }

  if (params.length > 0) {
    params.push(jobResult.rows[0].id);
    await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${pIdx}`,
      params,
    );
    return { success: true, message: `Job ${jobNumber} updated (${params.length - 1} fields) via ${event}` };
  }

  return { success: true, message: `Job ${jobNumber}: ${event} — no updatable fields in payload` };
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

    // Verify API key
    const keyPrefix = apiKey.substring(0, 8);
    const keyResult = await query(
      `SELECT id, name, service, permissions FROM api_keys
       WHERE key_prefix = $1 AND is_active = true`,
      [keyPrefix],
    );

    if (keyResult.rows.length === 0) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    // Update last_used_at
    await query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [keyResult.rows[0].id]);

    const { hirehop_job_id, new_status, trigger, source, metadata } = req.body;

    if (!hirehop_job_id || new_status === undefined) {
      res.status(400).json({ error: 'hirehop_job_id and new_status required' });
      return;
    }

    // Log the webhook
    await query(
      `INSERT INTO webhook_log (source, event, payload)
       VALUES ($1, 'status_transition', $2)`,
      [source || keyResult.rows[0].service, JSON.stringify(req.body)],
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

    // Update pipeline status
    await query(
      `UPDATE jobs SET
         pipeline_status = $1, pipeline_status_changed_at = NOW(),
         status = $2, hh_status = $2, status_name = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [newPipelineStatus, new_status, getHHStatusName(new_status), job.id],
    );

    // Log transition
    const fromLabel = PIPELINE_LABELS[job.pipeline_status] || job.pipeline_status;
    const toLabel = PIPELINE_LABELS[newPipelineStatus] || newPipelineStatus;

    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, 'system', $3)`,
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
