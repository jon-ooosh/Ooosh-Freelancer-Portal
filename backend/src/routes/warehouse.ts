/**
 * Warehouse Module — In-person customer collections
 *
 * Replaces the standalone Monday-driven module that used to live in the
 * Next.js freelancer portal at /warehouse. Same workflow:
 *   1. Staff opens kiosk URL on the warehouse iPad → enters PIN
 *   2. Sees today's customer-collect jobs (filtered)
 *   3. Picks a job → reviews equipment list with the client
 *   4. Captures signature → submits → job flips to On Hire,
 *      delivery note PDF generated + emailed, all logged to job timeline
 *
 * Auth: PIN-or-staff-JWT via authenticateWarehouse (below).
 *   • PIN exchange yields a 12h "warehouse_session" JWT.
 *   • Routine staff JWTs also work — convenient for non-tablet access.
 *
 * Source-of-truth swap: Monday Q&H board → OP `jobs` table.
 *   • Filter: pipeline_status IN ('confirmed', 'prepped', 'prepping'), out_date ±1 day
 *     (prepping = HH "Part Dispatched", i.e. some items already scanned out
 *     mid-collection — edge case but real)
 *   • Customer-collect filter: HireHop COLLECT=0 (excludes deliveries)
 *   • On-Hire flip: pipeline_status='dispatched' + HH writeback to status 5
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';
import { autoDispatchJob } from '../services/auto-dispatch';
import { generateDeliveryNotePdf, type DeliveryNoteItem } from '../services/delivery-note-pdf';
import { emailService } from '../services/email-service';
import { uploadToR2, isR2Configured } from '../config/r2';

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = process.env.JWT_SECRET;
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h — kiosk left running between shifts

// Stable UUID seeded by migration 031 — used as created_by for PIN-only sessions
// where there's no real OP user attached to the action.
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

interface WarehouseSessionClaims {
  scope: 'warehouse_session';
  sessionId: string;
}

interface WarehouseRequest extends Request {
  warehouseSession?: WarehouseSessionClaims;
  staffUser?: { id: string; email: string; role: string };
}

/**
 * Resolve the actor for audit purposes — staff user UUID if logged in,
 * otherwise the system user UUID for PIN-only kiosk sessions.
 */
function actorId(req: WarehouseRequest): string {
  return req.staffUser?.id || SYSTEM_USER_ID;
}

function actorLabel(req: WarehouseRequest): string {
  return req.staffUser?.email || 'Warehouse Kiosk';
}

/**
 * Authenticate via either:
 *   - "warehouse_session" JWT minted by POST /auth/pin (kiosk PIN flow)
 *   - Staff JWT (so OP-logged-in staff can use the route from desktop)
 */
function authenticateWarehouse(req: WarehouseRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = authHeader.slice(7);

  let decoded: Record<string, unknown>;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (decoded.scope === 'warehouse_session' && typeof decoded.sessionId === 'string') {
    req.warehouseSession = {
      scope: 'warehouse_session',
      sessionId: decoded.sessionId,
    };
    next();
    return;
  }

  // Staff JWT shape: { id, email, role }
  if (typeof decoded.id === 'string' && typeof decoded.email === 'string' && typeof decoded.role === 'string') {
    req.staffUser = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
    return;
  }

  res.status(401).json({ error: 'Invalid token' });
}

const router = Router();

// ─── POST /api/warehouse/auth/pin ───────────────────────────────────
// Validate the kiosk PIN and return a warehouse_session JWT.

router.post('/auth/pin', async (req: Request, res: Response) => {
  try {
    const { pin } = req.body as { pin?: unknown };
    if (typeof pin !== 'string' || !pin) {
      res.status(400).json({ error: 'PIN required' });
      return;
    }
    const expected = process.env.WAREHOUSE_PIN;
    if (!expected) {
      console.error('[warehouse] WAREHOUSE_PIN env var not set');
      res.status(503).json({ error: 'Warehouse access not configured' });
      return;
    }
    if (pin !== expected) {
      res.status(401).json({ error: 'Incorrect PIN' });
      return;
    }
    const token = jwt.sign(
      { scope: 'warehouse_session', sessionId: uuid() } satisfies WarehouseSessionClaims,
      JWT_SECRET,
      { expiresIn: SESSION_TTL_SECONDS }
    );
    res.json({ token, expiresIn: SESSION_TTL_SECONDS });
  } catch (err) {
    console.error('[warehouse] PIN auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// All routes below require either warehouse_session OR staff JWT
router.use(authenticateWarehouse);

// ─── GET /api/warehouse/collections ─────────────────────────────────
// List jobs ready for in-person collection.
// Filter:
//   - pipeline_status IN ('confirmed', 'prepped', 'prepping')
//     ('prepping' = HH 4/Part Dispatched — covers the edge case where the
//     warehouse has already scanned some items out before the customer
//     finishes signing.)
//   - out_date BETWEEN today-1 AND today+1
//   - HireHop COLLECT=0 (customer collects, not delivery)

interface CandidateJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  out_date: Date;
  pipeline_status: string;
}

interface CollectionListItem {
  id: string;
  jobName: string;
  hhRef: string;
  clientName: string;
  hireStartDate: string;
  pipelineStatus: string;
}

router.get('/collections', async (_req: WarehouseRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, hh_job_number, job_name, client_name, out_date, pipeline_status
       FROM jobs
       WHERE pipeline_status IN ('confirmed', 'prepped', 'prepping')
         AND is_deleted = false
         AND out_date IS NOT NULL
         AND out_date::date BETWEEN (CURRENT_DATE - INTERVAL '1 day') AND (CURRENT_DATE + INTERVAL '1 day')
       ORDER BY out_date ASC`
    );

    const candidates = result.rows as CandidateJob[];

    // Customer-collect filter: HireHop COLLECT=0. Done in parallel via the
    // broker (rate-limited, deduped). If the call fails for a job, we
    // include it (fail-open) — better to show a job that turns out to be a
    // delivery than to silently hide a real collection.
    const checked = await Promise.all(
      candidates.map(async (job) => {
        if (!job.hh_job_number) {
          // No HH link — shouldn't really happen for confirmed jobs but handle gracefully.
          return { job, isCollection: true };
        }
        try {
          const resp = await hhBroker.get<Record<string, unknown>>(
            '/api/job_data.php',
            { job: job.hh_job_number },
            { priority: 'high', cacheTTL: 300 }
          );
          if (!resp.success || !resp.data) {
            return { job, isCollection: true }; // fail-open
          }
          const collect = parseInt(String(resp.data.COLLECT ?? ''), 10);
          // 0 = customer collects, 1 = we deliver, 2 = courier, 3 = other
          return { job, isCollection: collect === 0 };
        } catch (err) {
          console.warn(`[warehouse] HH COLLECT check failed for job ${job.hh_job_number}:`, err);
          return { job, isCollection: true }; // fail-open
        }
      })
    );

    const jobs: CollectionListItem[] = checked
      .filter(({ isCollection }) => isCollection)
      .map(({ job }) => ({
        id: job.id,
        jobName: job.job_name || `Job ${job.hh_job_number || ''}`.trim(),
        hhRef: job.hh_job_number ? String(job.hh_job_number) : '',
        clientName: job.client_name || '',
        hireStartDate: job.out_date instanceof Date ? job.out_date.toISOString() : String(job.out_date),
        pipelineStatus: job.pipeline_status,
      }));

    res.json({ jobs, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[warehouse] List collections error:', err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ─── GET /api/warehouse/collections/:jobId ──────────────────────────
// Job details + equipment list (HH items_to_supply_list, equipment-only).

interface JobDetailRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  client_id: string | null;
  out_date: Date | null;
  pipeline_status: string;
  client_email: string | null;
}

interface EquipmentItem {
  id: string;
  name: string;
  quantity: number;
}

router.get('/collections/:jobId', async (req: WarehouseRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);

    const result = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.client_id,
              j.out_date, j.pipeline_status,
              o.email AS client_email
       FROM jobs j
       LEFT JOIN organisations o ON o.id = j.client_id
       WHERE j.id = $1 AND j.is_deleted = false`,
      [jobId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = result.rows[0] as JobDetailRow;

    // Pull equipment from HireHop. Same filter as the portal completion flow:
    // kind:2 + non-virtual = real physical line items (excluding headers,
    // selected-prompts, crew, virtual prompt parents).
    let items: EquipmentItem[] = [];
    if (job.hh_job_number) {
      try {
        const hhResp = await hhBroker.get<unknown>(
          '/frames/items_to_supply_list.php',
          { job: job.hh_job_number },
          { priority: 'high', cacheTTL: 300 }
        );
        if (hhResp.success && hhResp.data) {
          const data = hhResp.data as Record<string, unknown>;
          const rawItems: unknown[] = Array.isArray(data)
            ? data
            : Array.isArray(data.items)
              ? (data.items as unknown[])
              : Array.isArray(data.rows)
                ? (data.rows as unknown[])
                : [];
          items = (rawItems as Array<Record<string, unknown>>)
            .filter((it) => {
              const kind = Number(it.kind ?? 2);
              const isVirtual = it.VIRTUAL === '1' || it.VIRTUAL === 1 || it.VIRTUAL === true;
              if (kind !== 2 || isVirtual) return false;
              // Equipment-only: exclude vehicle categories so the warehouse
              // sign-off doesn't list vans alongside backline.
              const cat = String(it.CATEGORY_ID ?? '');
              if (cat === '370' || cat === '371') return false;
              return true;
            })
            .map((it) => ({
              id: String(it.id ?? it.ID ?? ''),
              name: String(it.title ?? it.NAME ?? it.ITEM_NAME ?? ''),
              quantity: Number(it.qty ?? it.QUANTITY ?? it.quantity ?? 1),
            }))
            .filter((it) => it.name);
        }
      } catch (err) {
        console.error(`[warehouse] HH items fetch failed for job ${job.hh_job_number}:`, err);
        // Swallow — return empty items list rather than block the page
      }
    }

    res.json({
      job: {
        id: job.id,
        hhRef: job.hh_job_number ? String(job.hh_job_number) : '',
        jobName: job.job_name || '',
        clientName: job.client_name || '',
        clientEmail: job.client_email || '',
        hireStartDate: job.out_date instanceof Date ? job.out_date.toISOString() : (job.out_date ? String(job.out_date) : ''),
        pipelineStatus: job.pipeline_status,
        items,
      },
    });
  } catch (err) {
    console.error('[warehouse] Job detail error:', err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ─── POST /api/warehouse/collections/:jobId/complete ────────────────
// Sign-off action. Order of operations:
//   1. Persist signature PNG to R2
//   2. Generate delivery note PDF (signature embedded), persist to R2,
//      append to jobs.files JSONB
//   3. Email PDF to recipients (if any)
//   4. Bump pipeline_status to 'dispatched' + push HH writeback to status 5
//   5. Log a 'note' interaction on the job timeline with R2 keys in the body

const completeSchema = z.object({
  signatureBase64: z.string().min(1, 'Signature required'),
  collectedBy: z.string().trim().min(1, 'Name of person collecting required').max(120),
  recipientEmails: z.array(z.string().email()).max(5).default([]),
  // Echoed back from list/detail — saves an extra DB lookup in the email body
  jobName: z.string().optional(),
  hireStartDate: z.string().optional(),
  hhRef: z.string().optional(),
  items: z.array(z.object({
    name: z.string(),
    quantity: z.number(),
  })).default([]),
});

router.post('/collections/:jobId/complete', async (req: WarehouseRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid completion data', details: parsed.error.issues });
      return;
    }
    const { signatureBase64, collectedBy, recipientEmails, jobName, hireStartDate, hhRef, items } = parsed.data;

    // Verify job exists + is in a dispatchable state
    const jobResult = await query(
      `SELECT id, hh_job_number, pipeline_status, out_date, job_name, client_name
       FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const job = jobResult.rows[0] as {
      id: string;
      hh_job_number: number | null;
      pipeline_status: string;
      out_date: Date | null;
      job_name: string | null;
      client_name: string | null;
    };

    if (!['confirmed', 'prepped', 'prepping', 'dispatched'].includes(job.pipeline_status)) {
      // Allow re-completion of an already-dispatched job (e.g. emailing the
      // delivery note to an extra recipient after the fact would be a separate
      // future flow, but for now reject to avoid confusion).
      res.status(409).json({
        error: `Job is in pipeline_status='${job.pipeline_status}' — cannot mark as collected from here`,
      });
      return;
    }

    const completedAt = new Date();
    const completedAtIso = completedAt.toISOString();
    const ts = completedAt.getTime();
    const safeJobId = jobId.replace(/[^a-zA-Z0-9-]/g, '');

    // ── 1. Signature → R2 ──
    let signatureKey: string | null = null;
    let signatureBuffer: Buffer | null = null;
    try {
      const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, '');
      signatureBuffer = Buffer.from(base64Data, 'base64');
      if (isR2Configured()) {
        const key = `warehouse-collections/${safeJobId}/signature-${ts}.png`;
        await uploadToR2(key, signatureBuffer, 'image/png');
        signatureKey = key;
      }
    } catch (err) {
      console.error('[warehouse] Signature upload error:', err);
      // Non-fatal — still proceed with status flip and PDF generation
    }

    // ── 2. PDF → R2 + jobs.files ──
    let pdfKey: string | null = null;
    let pdfBuffer: Buffer | null = null;
    const effectiveHhRef = hhRef || (job.hh_job_number ? String(job.hh_job_number) : 'N/A');
    const effectiveJobDate = hireStartDate || (job.out_date instanceof Date ? job.out_date.toISOString() : completedAtIso);
    const effectiveJobName = jobName || job.job_name || 'Ooosh Job';
    const effectiveClientName = job.client_name || collectedBy;

    try {
      const pdfBytes = await generateDeliveryNotePdf({
        hhRef: effectiveHhRef,
        jobDate: effectiveJobDate,
        completedAt: completedAtIso,
        clientName: effectiveClientName,
        venueName: 'Ooosh Warehouse — Compass House',
        deliveryAddress: 'Compass House, 7 East Street, Portslade, BN41 1DL',
        items: items as DeliveryNoteItem[],
        signature: signatureBuffer ?? undefined,
        photos: [],
        driverName: collectedBy,
      });
      pdfBuffer = pdfBytes;

      if (isR2Configured()) {
        const fileId = uuid();
        const key = `files/jobs/${jobId}/${fileId}.pdf`;
        await uploadToR2(key, pdfBytes, 'application/pdf');
        pdfKey = key;

        // Append to jobs.files so it shows up on the Files tab
        const fileAttachment = {
          name: `Collection delivery note — ${effectiveHhRef}.pdf`,
          url: key,
          type: 'pdf',
          label: 'Collection delivery note',
          uploaded_at: completedAtIso,
          uploaded_by: actorLabel(req),
          comment: `Signed by ${collectedBy} on collection from warehouse.`,
        };
        await query(
          `UPDATE jobs SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify([fileAttachment]), jobId]
        );
      }
    } catch (err) {
      console.error('[warehouse] PDF generation/upload error:', err);
      // Non-fatal — continue with status flip
    }

    // ── 3. Email recipients (best-effort) ──
    const emailedTo: string[] = [];
    const emailFailures: string[] = [];
    if (pdfBuffer && recipientEmails.length > 0) {
      const dateLabel = new Date(effectiveJobDate).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
      const completedDateTime = completedAt.toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      for (const to of recipientEmails) {
        try {
          await emailService.send('delivery_note', {
            to,
            variables: {
              clientName: effectiveClientName || 'there',
              jobName: effectiveJobName,
              jobNumber: effectiveHhRef && effectiveHhRef !== 'N/A' ? effectiveHhRef : '',
              venueName: 'Ooosh Warehouse',
              deliveryDate: dateLabel,
              driverName: collectedBy,
              completedAt: completedDateTime,
            },
            attachments: [{
              filename: `Ooosh_Delivery_Note_${effectiveHhRef.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf',
            }],
          });
          emailedTo.push(to);
        } catch (err) {
          console.error(`[warehouse] Email send failed for ${to}:`, err);
          emailFailures.push(to);
        }
      }
    }

    // ── 4. Status flip ──
    // Auto-dispatch (shared helper): OP pipeline → 'dispatched' if not
    // already + HH writeback to 5 + sanity-check email to info@ (and bell
    // to staff) when HH is still pre-Dispatched.
    const dispatchResult = await autoDispatchJob({
      jobId,
      source: 'warehouse',
      actorLabel: actorLabel(req),
      actorUserId: req.staffUser?.id || null,
      interactionContent: `🚐 Job dispatched — equipment collected via warehouse by ${collectedBy}.`,
    });
    const opStatusChanged = dispatchResult.opStatusChanged;
    const hhWriteback = dispatchResult.hhWriteback;

    // ── 5. Activity Timeline ──
    const recipientsLine = emailedTo.length > 0
      ? ` Delivery note emailed to ${emailedTo.join(', ')}.`
      : recipientEmails.length > 0
        ? ` Delivery note email failed for ${emailFailures.join(', ')}.`
        : ' (No delivery note emailed.)';

    const completedHHmm = completedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const content = `📦 Equipment collected at ${completedHHmm} by ${collectedBy}.${recipientsLine}`;

    try {
      await query(
        `INSERT INTO interactions (id, type, content, job_id, created_by, created_at, pipeline_status_at_creation)
         VALUES ($1, 'note', $2, $3, $4, $5, 'dispatched')`,
        [uuid(), content, jobId, actorId(req), completedAtIso]
      );
    } catch (err) {
      console.error('[warehouse] Interaction insert error:', err);
      // Non-fatal — the action itself completed
    }

    res.json({
      success: true,
      completedAt: completedAtIso,
      opStatusChanged,
      hhWriteback,
      emailedTo,
      emailFailures,
      pdfKey,
      signatureKey,
    });
  } catch (err) {
    console.error('[warehouse] Complete error:', err);
    res.status(500).json({ error: 'Failed to complete collection' });
  }
});

export default router;
