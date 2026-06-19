/**
 * PCN module — Penalty Charge Notice management.
 *
 * Standalone OP-native module (under Vehicles) replacing the Monday-driven
 * PCN-Management-System Netlify app. FK anchors into fleet_vehicles / drivers /
 * vehicle_hire_assignments / jobs / organisations.
 *
 * PR 1 (foundation): CRUD + driver matching + settings reads + by-entity reads.
 * AI extraction, HireHop charge, email templates, the pay-direct receipt loop,
 * chasers and dashboard buckets land in later PRs.
 *
 * See docs/PCN-MODULE-SPEC.md.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { getSystemSettings } from './system-settings';
import { isAnthropicConfigured } from '../config/anthropic';
import { uploadToR2 } from '../config/r2';

const router = Router();

// Multer (memory) — 10MB, images + PDF. Shared by AI-extract + receipt upload.
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — pay-direct receipt upload (token-authenticated, NO staff auth).
// Defined BEFORE the auth gate. The driver gets the link by email; it's valid
// while the PCN is still awaiting their payment (status='driver_notified_pay'),
// and rejects once paid/escalated (status-bound, mirrors the OOH parking token).
// ─────────────────────────────────────────────────────────────────────────

async function resolveReceiptToken(token: string) {
  const r = await query(
    `SELECT p.*, fv.reg AS fleet_reg, d.full_name AS driver_name
     FROM pcns p
     LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
     LEFT JOIN drivers d ON d.id = p.driver_id
     WHERE p.receipt_upload_token = $1 AND p.is_deleted = false`,
    [token]
  );
  return r.rows[0] || null;
}

router.get('/public/receipt/:token', async (req: Request, res: Response) => {
  const pcn = await resolveReceiptToken(String(req.params.token));
  if (!pcn) { res.status(404).json({ error: 'This link is not valid.' }); return; }
  const alreadyPaid = pcn.status !== 'driver_notified_pay';
  res.json({
    data: {
      reference: pcn.reference,
      vehicle_reg: pcn.fleet_reg || pcn.vehicle_reg,
      issuing_authority: pcn.issuing_authority,
      fine_amount: pcn.fine_amount,
      reduced_amount: pcn.reduced_amount,
      reduced_deadline: pcn.reduced_deadline,
      driver_name: pcn.driver_name,
      already_uploaded: !!pcn.receipt_url,
      // If the PCN has moved on (paid/escalated), the form shows a closed state.
      closed: alreadyPaid && !pcn.receipt_url,
    },
  });
});

router.post('/public/receipt/:token', extractUpload.single('file'), async (req: Request, res: Response) => {
  const pcn = await resolveReceiptToken(String(req.params.token));
  if (!pcn) { res.status(404).json({ error: 'This link is not valid.' }); return; }
  if (pcn.status !== 'driver_notified_pay') {
    res.status(409).json({ error: 'This charge is no longer awaiting your payment — please contact us.' });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

  const ext = (req.file.mimetype || '').includes('pdf') ? 'pdf' : 'jpg';
  const key = `files/pcn-receipts/${pcn.id}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  await uploadToR2(key, req.file.buffer, req.file.mimetype || 'application/octet-stream');

  await query(
    `UPDATE pcns SET receipt_url = $2, receipt_uploaded_at = NOW(), status = 'paid_by_driver', updated_at = NOW()
     WHERE id = $1`,
    [pcn.id, key]
  );
  await query(
    `INSERT INTO pcn_events (pcn_id, event_type, body, metadata)
     VALUES ($1, 'receipt_received', $2, $3)`,
    [pcn.id, 'Driver uploaded proof of payment', JSON.stringify({ receipt_url: key })]
  );

  // Alert info@ — pay-direct must be "rock solid" (jon): a human confirms it.
  try {
    const { emailService } = await import('../services/email-service');
    await emailService.send('pcn_receipt_received_alert', {
      to: 'info@oooshtours.co.uk',
      variables: {
        vehicleReg: pcn.fleet_reg || pcn.vehicle_reg || '—',
        pcnReference: pcn.reference || '—',
        driverName: pcn.driver_name || 'the driver',
        jobNumber: String(pcn.hh_job_number || ''),
        pcnUrl: `${(await import('../config/app-urls')).getFrontendUrl()}/vehicles/pcns/${pcn.id}`,
      },
    });
  } catch (err) {
    console.error('[pcns] receipt-received alert failed:', err);
  }

  res.json({ data: { ok: true } });
});

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function logPcnEvent(
  pcnId: string,
  eventType: string,
  body: string | null,
  metadata: Record<string, unknown> | null,
  userId: string | null
): Promise<void> {
  await query(
    `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [pcnId, eventType, body, metadata ? JSON.stringify(metadata) : null, userId]
  );
}

const SELECT_WITH_JOINS = `
  SELECT p.*,
         fv.reg                                     AS fleet_reg,
         d.full_name                                AS driver_name,
         d.email                                    AS driver_email,
         (dp.first_name || ' ' || dp.last_name)     AS driver_person_name,
         dp.email                                   AS driver_person_email,
         o.name                                     AS client_organisation_name,
         j.job_name                                 AS job_name,
         (hb.first_name || ' ' || hb.last_name)     AS handled_by_name
  FROM pcns p
  LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
  LEFT JOIN drivers d         ON d.id = p.driver_id
  LEFT JOIN people dp         ON dp.id = p.driver_person_id
  LEFT JOIN organisations o   ON o.id = p.client_organisation_id
  LEFT JOIN jobs j            ON j.id = p.job_id
  LEFT JOIN users hu          ON hu.id = p.handled_by
  LEFT JOIN people hb         ON hb.id = hu.person_id
`;

// ─────────────────────────────────────────────────────────────────────────
// Settings (replaces the Monday PCN Settings board)
// ─────────────────────────────────────────────────────────────────────────

router.get('/settings', async (_req: AuthRequest, res: Response) => {
  const s = await getSystemSettings([
    'pcn_handling_charge', 'pcn_vat_rate', 'pcn_receipt_chase_days',
    'pcn_pay_direct_hours', 'pcn_police_nip_urgency_days', 'pcn_hh_charge_item',
  ]);
  res.json({
    data: {
      handling_charge: parseFloat(s.pcn_handling_charge || '35'),
      vat_rate: parseFloat(s.pcn_vat_rate || '20'),
      receipt_chase_days: (s.pcn_receipt_chase_days || '3,5,7')
        .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n)),
      pay_direct_hours: parseInt(s.pcn_pay_direct_hours || '48', 10),
      police_nip_urgency_days: parseInt(s.pcn_police_nip_urgency_days || '5', 10),
      hh_charge_item: s.pcn_hh_charge_item || 'b1744',
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AI extraction — PRIMARY entry path. Upload a photo/PDF of the notice, get
// the fields back for the modal to pre-fill. Manual entry is the fallback.
// Inert (503) when ANTHROPIC_API_KEY is missing. Replaces Netlify extract.js.
// ─────────────────────────────────────────────────────────────────────────

// Accepts one or more pages (front + back of a paper notice, or a multi-page
// PDF). Back-compat: a single `file` field still works.
router.post('/extract', extractUpload.any(), async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    res.status(503).json({ error: 'AI extraction not configured (ANTHROPIC_API_KEY missing on server)' });
    return;
  }
  const uploaded = (req.files as Express.Multer.File[] | undefined) || [];
  if (uploaded.length === 0) { res.status(400).json({ error: 'No file provided' }); return; }
  try {
    const { extractPcn } = await import('../services/pcn-extract');
    const data = await extractPcn(uploaded.map((f) => ({ buffer: f.buffer, mimeType: f.mimetype })));
    res.json({ data });
  } catch (err) {
    console.error('[pcns] extract error:', err);
    res.status(500).json({ error: 'Extraction failed', details: (err as Error).message });
  }
});

// Duplicate detection (non-blocking flag) — surfaces any existing non-deleted
// PCN(s) sharing this reference so staff can spot an accidental re-upload.
// Never blocks the save; references can be blank or mis-keyed.
router.get('/check-duplicate', async (req: AuthRequest, res: Response) => {
  const reference = String(req.query.reference || '').trim();
  if (!reference) { res.json({ data: [] }); return; }
  const excludeId = String(req.query.exclude_id || '');
  const params: unknown[] = [reference];
  let sql = `${SELECT_WITH_JOINS} WHERE p.is_deleted = false AND LOWER(TRIM(p.reference)) = LOWER($1)`;
  if (excludeId) { sql += ` AND p.id <> $2`; params.push(excludeId); }
  sql += ` ORDER BY p.created_at DESC LIMIT 10`;
  const r = await query(sql, params);
  res.json({ data: r.rows });
});

// ─────────────────────────────────────────────────────────────────────────
// Driver matching — replaces match-driver.js (Monday Driver Hire Form board)
// Finds the driver(s) who had the vehicle across the offence moment, reading
// vehicle_hire_assignments. Canonical hire window = vha.hire_start/hire_end,
// fallback jobs.job_date/job_end (NOT return_date). Dual-match on hh_job_number
// so V&D staff-allocation rows (job_id NULL) still surface.
// ─────────────────────────────────────────────────────────────────────────

router.get('/match', async (req: AuthRequest, res: Response) => {
  const reg = String(req.query.reg || '').toUpperCase().replace(/\s/g, '');
  const offenceAt = String(req.query.offence_at || '');
  if (!reg || !offenceAt) {
    res.status(400).json({ error: 'reg and offence_at are required' });
    return;
  }
  const offenceDate = new Date(offenceAt);
  if (isNaN(offenceDate.getTime())) {
    res.status(400).json({ error: 'offence_at is not a valid date' });
    return;
  }

  const result = await query(
    `SELECT vha.id              AS assignment_id,
            vha.status          AS assignment_status,
            vha.hire_start, vha.hire_end,
            fv.id               AS vehicle_id,
            fv.reg,
            d.id                AS driver_id,
            d.full_name         AS driver_name,
            d.email             AS driver_email,
            d.phone             AS driver_phone,
            j.id                AS job_id,
            j.hh_job_number,
            j.job_name,
            o.id                AS client_organisation_id,
            o.name              AS client_organisation_name
     FROM vehicle_hire_assignments vha
     JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d    ON d.id = vha.driver_id
     LEFT JOIN jobs j ON (vha.job_id IS NOT NULL AND j.id = vha.job_id)
                      OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
     LEFT JOIN organisations o ON o.id = j.client_id
     WHERE fv.reg = $1
       AND vha.status <> 'cancelled'
       AND $2::date >= COALESCE(vha.hire_start, j.job_date::date)
       AND $2::date <= COALESCE(vha.hire_end, j.job_end::date)
     ORDER BY vha.hire_start NULLS LAST`,
    [reg, offenceDate.toISOString()]
  );

  // Dedup per (driver, jobKey) so dual rows (staff-allocation + hire-form) on
  // the same hire don't both surface as separate "drivers".
  const seen = new Set<string>();
  const drivers = [];
  for (const row of result.rows) {
    const jobKey = row.job_id ? `uuid:${row.job_id}` : `hh:${row.hh_job_number}`;
    const key = `${row.driver_id || 'nodriver'}|${jobKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drivers.push(row);
  }

  // Crew / transport context — for V&D and D&C supplies we rarely record a reg
  // against the run, so a vehicle-match alone won't find who was driving. Pull
  // every freelancer/crew assignment on a transport quote whose job spans the
  // offence date so staff can decipher it manually. Broad net by design.
  const crew = await query(
    `SELECT DISTINCT
            qa.person_id,
            p.first_name || ' ' || p.last_name AS person_name,
            p.email                            AS person_email,
            p.is_freelancer,
            qa.role,
            q.job_type,
            j.id                               AS job_id,
            j.hh_job_number,
            j.job_name,
            j.job_date,
            j.job_end
     FROM quote_assignments qa
     JOIN quotes q ON q.id = qa.quote_id AND q.is_deleted = false
     JOIN people p ON p.id = qa.person_id
     JOIN jobs j   ON j.id = q.job_id
     WHERE qa.status <> 'cancelled'
       AND $1::date >= (COALESCE(j.job_date, j.out_date))::date
       AND $1::date <= (COALESCE(j.job_end, j.return_date, j.job_date))::date
     ORDER BY j.job_date NULLS LAST
     LIMIT 25`,
    [offenceDate.toISOString()]
  );

  res.json({ data: { drivers, match_count: drivers.length, crew_candidates: crew.rows } });
});

// ─────────────────────────────────────────────────────────────────────────
// By-entity reads (for the reusable PcnHistorySection)
// ─────────────────────────────────────────────────────────────────────────

router.get('/by-vehicle/:id', async (req: AuthRequest, res: Response) => {
  const r = await query(
    `${SELECT_WITH_JOINS} WHERE p.vehicle_id = $1 AND p.is_deleted = false ORDER BY p.offence_at DESC NULLS LAST, p.created_at DESC`,
    [req.params.id]
  );
  res.json({ data: r.rows });
});

router.get('/by-driver/:id', async (req: AuthRequest, res: Response) => {
  const r = await query(
    `${SELECT_WITH_JOINS} WHERE p.driver_id = $1 AND p.is_deleted = false ORDER BY p.offence_at DESC NULLS LAST, p.created_at DESC`,
    [req.params.id]
  );
  res.json({ data: r.rows });
});

router.get('/by-org/:id', async (req: AuthRequest, res: Response) => {
  const r = await query(
    `${SELECT_WITH_JOINS} WHERE p.client_organisation_id = $1 AND p.is_deleted = false ORDER BY p.offence_at DESC NULLS LAST, p.created_at DESC`,
    [req.params.id]
  );
  res.json({ data: r.rows });
});

router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(req.params.jobId));
  const sql = isUuid
    ? `${SELECT_WITH_JOINS} WHERE p.job_id = $1 AND p.is_deleted = false ORDER BY p.created_at DESC`
    : `${SELECT_WITH_JOINS} WHERE p.hh_job_number = $1 AND p.is_deleted = false ORDER BY p.created_at DESC`;
  const r = await query(sql, [isUuid ? req.params.jobId : Number(req.params.jobId)]);
  res.json({ data: r.rows });
});

// ─────────────────────────────────────────────────────────────────────────
// List + detail
// ─────────────────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  const { status, fine_type, search, offence_from, offence_to, sort } = req.query;
  let sql = `${SELECT_WITH_JOINS} WHERE p.is_deleted = false`;
  const params: unknown[] = [];
  let i = 1;
  if (status) { sql += ` AND p.status = $${i++}`; params.push(status); }
  if (fine_type) { sql += ` AND p.fine_type = $${i++}`; params.push(fine_type); }
  if (search) {
    sql += ` AND (p.reference ILIKE $${i} OR p.vehicle_reg ILIKE $${i} OR p.issuing_authority ILIKE $${i}
                  OR CAST(p.hh_job_number AS TEXT) ILIKE $${i})`;
    params.push(`%${search}%`);
    i++;
  }
  // Offence-date range (inclusive). `offence_to` is bumped to end-of-day so a
  // same-day from/to selects that whole day.
  if (offence_from) { sql += ` AND p.offence_at >= $${i++}`; params.push(offence_from); }
  if (offence_to) { sql += ` AND p.offence_at < ($${i++}::date + INTERVAL '1 day')`; params.push(offence_to); }

  // Sort — whitelisted; NULLS LAST so undated/unmatched rows don't crowd the
  // top. One <field>_asc / <field>_desc pair per clickable column header.
  const SORTS: Record<string, string> = {
    created_desc:   'p.created_at DESC',
    created_asc:    'p.created_at ASC',
    reference_asc:  'p.reference ASC NULLS LAST, p.created_at DESC',
    reference_desc: 'p.reference DESC NULLS LAST, p.created_at DESC',
    type_asc:       'p.fine_type ASC, p.created_at DESC',
    type_desc:      'p.fine_type DESC, p.created_at DESC',
    reg_asc:        "COALESCE(fv.reg, p.vehicle_reg) ASC NULLS LAST, p.created_at DESC",
    reg_desc:       "COALESCE(fv.reg, p.vehicle_reg) DESC NULLS LAST, p.created_at DESC",
    driver_asc:     'd.full_name ASC NULLS LAST, p.created_at DESC',
    driver_desc:    'd.full_name DESC NULLS LAST, p.created_at DESC',
    job_asc:        'p.hh_job_number ASC NULLS LAST, p.created_at DESC',
    job_desc:       'p.hh_job_number DESC NULLS LAST, p.created_at DESC',
    offence_desc:   'p.offence_at DESC NULLS LAST, p.created_at DESC',
    offence_asc:    'p.offence_at ASC NULLS LAST, p.created_at DESC',
    fine_desc:      'p.fine_amount DESC NULLS LAST, p.created_at DESC',
    fine_asc:       'p.fine_amount ASC NULLS LAST, p.created_at DESC',
    status_asc:     'p.status ASC, p.created_at DESC',
    status_desc:    'p.status DESC, p.created_at DESC',
    deadline_asc:   'COALESCE(p.reduced_deadline, p.final_deadline) ASC NULLS LAST, p.created_at DESC',
    deadline_desc:  'COALESCE(p.reduced_deadline, p.final_deadline) DESC NULLS LAST, p.created_at DESC',
  };
  sql += ` ORDER BY ${SORTS[String(sort)] || SORTS.created_desc}`;
  const r = await query(sql, params);
  res.json({ data: r.rows });
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const r = await query(`${SELECT_WITH_JOINS} WHERE p.id = $1`, [req.params.id]);
  if (r.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }
  const events = await query(
    `SELECT e.*, (pe.first_name || ' ' || pe.last_name) AS created_by_name
     FROM pcn_events e
     LEFT JOIN users u ON u.id = e.created_by
     LEFT JOIN people pe ON pe.id = u.person_id
     WHERE e.pcn_id = $1 ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  res.json({ data: { ...r.rows[0], events: events.rows } });
});

// ─────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────

const fineType = z.enum(['private_pcn', 'council_pcn', 'police_nip', 'toll', 'other']);

const DOC_KINDS = ['notice_front', 'notice_back', 'correspondence', 'response', 'receipt', 'other'] as const;
const pcnDocSchema = z.object({
  r2_key: z.string(),
  name: z.string().optional().nullable(),
  kind: z.enum(DOC_KINDS).optional(),
  comment: z.string().optional().nullable(),
});

const createSchema = z.object({
  reference: z.string().optional().nullable(),
  fine_type: fineType.optional(),
  vehicle_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  driver_person_id: z.string().uuid().optional().nullable(),
  assignment_id: z.string().uuid().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  client_organisation_id: z.string().uuid().optional().nullable(),
  hh_job_number: z.number().int().optional().nullable(),
  vehicle_reg: z.string().optional().nullable(),
  offence_at: z.string().optional().nullable(),
  offence_time_text: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  issuing_authority: z.string().optional().nullable(),
  offence_description: z.string().optional().nullable(),
  fine_amount: z.number().optional().nullable(),
  reduced_amount: z.number().optional().nullable(),
  reduced_deadline: z.string().optional().nullable(),
  final_deadline: z.string().optional().nullable(),
  extraction_confidence: z.enum(['high', 'medium', 'low']).optional().nullable(),
  pcn_document_url: z.string().optional().nullable(),
  documents: z.array(pcnDocSchema).optional(),
  notes: z.string().optional().nullable(),
});

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof createSchema>;

  // Stamp uploaded_at / uploaded_by onto each document at write time.
  const docs = (b.documents ?? []).map((d) => ({
    r2_key: d.r2_key,
    name: d.name ?? null,
    kind: d.kind ?? 'other',
    comment: d.comment ?? null,
    uploaded_at: new Date().toISOString(),
    uploaded_by: req.user!.id,
  }));

  const result = await query(
    `INSERT INTO pcns (
       reference, fine_type, vehicle_id, driver_id, assignment_id, job_id,
       client_organisation_id, hh_job_number, vehicle_reg,
       offence_at, offence_time_text, location, issuing_authority, offence_description,
       fine_amount, reduced_amount, reduced_deadline, final_deadline,
       extraction_confidence, pcn_document_url, documents, notes, handled_by, status
     ) VALUES (
       $1,$2,$3,$4,$5,$6, $7,$8,$9, $10,$11,$12,$13,$14,
       $15,$16,$17,$18, $19,$20,$21::jsonb,$22,$23, 'received'
     ) RETURNING *`,
    [
      b.reference ?? null, b.fine_type ?? 'other', b.vehicle_id ?? null, b.driver_id ?? null,
      b.assignment_id ?? null, b.job_id ?? null, b.client_organisation_id ?? null,
      b.hh_job_number ?? null, b.vehicle_reg ?? null,
      b.offence_at ?? null, b.offence_time_text ?? null, b.location ?? null,
      b.issuing_authority ?? null, b.offence_description ?? null,
      b.fine_amount ?? null, b.reduced_amount ?? null, b.reduced_deadline ?? null,
      b.final_deadline ?? null, b.extraction_confidence ?? null,
      b.pcn_document_url ?? null, JSON.stringify(docs), b.notes ?? null, req.user!.id,
    ]
  );
  const pcn = result.rows[0];
  await logPcnEvent(pcn.id, 'created', `PCN logged${pcn.reference ? `: ${pcn.reference}` : ''}`, null, req.user!.id);
  if (pcn.driver_id) {
    await logPcnEvent(pcn.id, 'matched', `Matched to driver`, { driver_id: pcn.driver_id }, req.user!.id);
  }
  await logAudit(req.user!.id, 'pcns', pcn.id, 'create', null, pcn);
  res.status(201).json({ data: pcn });
});

// ─────────────────────────────────────────────────────────────────────────
// Update (status / action / notes / corrections)
// ─────────────────────────────────────────────────────────────────────────

const updateSchema = createSchema.partial().extend({
  status: z.enum([
    'received', 'awaiting_driver_id', 'driver_notified_pay', 'paid_by_driver',
    'liability_transferred', 'paid_recharged', 'internal_ooosh',
    'internal_freelancer', 'under_query', 'closed',
  ]).optional(),
  action_path: z.enum([
    'pay_direct', 'transfer_liability', 'pay_recharge',
    'internal_ooosh', 'internal_freelancer', 'query',
  ]).optional().nullable(),
});

const UPDATABLE = [
  'reference', 'fine_type', 'vehicle_id', 'driver_id', 'driver_person_id', 'assignment_id', 'job_id',
  'client_organisation_id', 'hh_job_number', 'vehicle_reg', 'offence_at',
  'offence_time_text', 'location', 'issuing_authority', 'offence_description',
  'fine_amount', 'reduced_amount', 'reduced_deadline', 'final_deadline',
  'extraction_confidence', 'pcn_document_url', 'notes', 'status', 'action_path',
] as const;

router.patch('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as Record<string, unknown>;
  const existing = await query(`SELECT * FROM pcns WHERE id = $1 AND is_deleted = false`, [req.params.id]);
  if (existing.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }
  const before = existing.rows[0];

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const field of UPDATABLE) {
    if (field in b) {
      sets.push(`${field} = $${i++}`);
      params.push(b[field] ?? null);
    }
  }
  if (sets.length === 0) { res.json({ data: before }); return; }
  sets.push(`updated_at = NOW()`);
  params.push(req.params.id);

  const result = await query(
    `UPDATE pcns SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  const pcn = result.rows[0];

  if (b.status && b.status !== before.status) {
    await logPcnEvent(pcn.id, 'status_change', `Status → ${b.status}`,
      { from: before.status, to: b.status }, req.user!.id);
  }
  if ('driver_id' in b && (b.driver_id ?? null) !== (before.driver_id ?? null)) {
    await logPcnEvent(pcn.id, 'matched',
      b.driver_id ? 'Driver assigned' : 'Driver unassigned',
      { from: before.driver_id ?? null, to: b.driver_id ?? null }, req.user!.id);
  }
  if ('driver_person_id' in b && (b.driver_person_id ?? null) !== (before.driver_person_id ?? null)) {
    await logPcnEvent(pcn.id, 'matched',
      b.driver_person_id ? 'Freelancer/crew assigned as driver' : 'Driver (crew) unassigned',
      { from: before.driver_person_id ?? null, to: b.driver_person_id ?? null }, req.user!.id);
  }
  await logAudit(req.user!.id, 'pcns', pcn.id, 'update', before, pcn);
  res.json({ data: pcn });
});

// ─────────────────────────────────────────────────────────────────────────
// Action — the "what next" chooser. Drives status + action_path, fires the
// branded client/driver email (optional), and adds the conditional £35+VAT
// HireHop handling charge (transfer / recharge). See services/pcn-actions.ts.
//
// RBAC: money-moving / charge-adding actions (transfer_liability, pay_recharge)
// are MANAGER_ROLES-tier — they push a charge to HireHop and recharge the
// client. The lenient pay-direct path + ID requests + internal/query are
// STAFF_ROLES (the router-level gate). Mirrors the excess RBAC precedent.
// ─────────────────────────────────────────────────────────────────────────

const actionSchema = z.object({
  action: z.enum([
    'transfer_liability', 'pay_direct', 'pay_recharge',
    'request_driver_id', 'internal_ooosh', 'internal_freelancer', 'query',
  ]),
  send_email: z.boolean().optional().default(true),
  add_charge: z.boolean().optional(),
  email_override: z.string().email().optional().nullable(),
  resolution_note: z.string().max(2000).optional().nullable(),
});

const MANAGER_TIER_ACTIONS = new Set(['transfer_liability', 'pay_recharge']);

router.post('/:id/action', validate(actionSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof actionSchema>;

  // Per-action gate: charge-adding / money-moving actions need manager tier.
  if (MANAGER_TIER_ACTIONS.has(b.action) && !MANAGER_ROLES.includes(req.user!.role as never)) {
    res.status(403).json({ error: 'This action requires a manager — it adds a charge / recharges the client. Refer to a manager.' });
    return;
  }

  const exists = await query(`SELECT id FROM pcns WHERE id = $1 AND is_deleted = false`, [req.params.id]);
  if (exists.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }

  try {
    const { applyPcnAction } = await import('../services/pcn-actions');
    const result = await applyPcnAction(
      String(req.params.id),
      { action: b.action, send_email: b.send_email !== false, add_charge: b.add_charge, email_override: b.email_override, resolution_note: b.resolution_note },
      req.user!.id
    );
    await logAudit(req.user!.id, 'pcns', String(req.params.id), 'update', null, { action: b.action, ...result });
    res.json({ data: result });
  } catch (err) {
    console.error('[pcns] action error:', err);
    res.status(500).json({ error: 'Action failed', details: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Soft delete
// ─────────────────────────────────────────────────────────────────────────

router.delete('/:id', authorize('admin', 'manager', 'weekend_manager'), async (req: AuthRequest, res: Response) => {
  const r = await query(
    `UPDATE pcns SET is_deleted = true, updated_at = NOW() WHERE id = $1 AND is_deleted = false RETURNING id`,
    [req.params.id]
  );
  if (r.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }
  await logAudit(req.user!.id, 'pcns', String(req.params.id), 'delete', null, null);
  res.json({ data: { deleted: true } });
});

// ─────────────────────────────────────────────────────────────────────────
// Documents (multi-doc audit trail — notice front/back, correspondence,
// council/company responses). The file is uploaded to R2 first via
// /api/files/upload?attachment_only=true; this appends the metadata entry.
// ─────────────────────────────────────────────────────────────────────────

const addDocSchema = z.object({
  r2_key: z.string().min(1),
  name: z.string().optional().nullable(),
  kind: z.enum(DOC_KINDS).optional(),
  comment: z.string().optional().nullable(),
});

router.post('/:id/documents', validate(addDocSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof addDocSchema>;
  const entry = {
    r2_key: b.r2_key,
    name: b.name ?? null,
    kind: b.kind ?? 'other',
    comment: b.comment ?? null,
    uploaded_at: new Date().toISOString(),
    uploaded_by: req.user!.id,
  };
  const r = await query(
    `UPDATE pcns SET documents = COALESCE(documents, '[]'::jsonb) || $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND is_deleted = false
     RETURNING documents`,
    [req.params.id, JSON.stringify([entry])]
  );
  if (r.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }
  await logPcnEvent(
    String(req.params.id), 'document_added',
    `Document added (${entry.kind.replace(/_/g, ' ')})${entry.name ? `: ${entry.name}` : ''}`,
    { r2_key: entry.r2_key, kind: entry.kind }, req.user!.id
  );
  res.json({ data: { documents: r.rows[0].documents } });
});

// Remove a document entry by r2_key (the R2 object itself is left in place —
// cheap, and keeps the audit chain intact). Logs a document_removed event.
router.delete('/:id/documents', async (req: AuthRequest, res: Response) => {
  const r2Key = String(req.query.r2_key || (req.body && req.body.r2_key) || '');
  if (!r2Key) { res.status(400).json({ error: 'r2_key is required' }); return; }
  const r = await query(
    `UPDATE pcns
       SET documents = COALESCE((
             SELECT jsonb_agg(d) FROM jsonb_array_elements(documents) d
             WHERE d->>'r2_key' <> $2
           ), '[]'::jsonb),
           updated_at = NOW()
     WHERE id = $1 AND is_deleted = false
     RETURNING documents`,
    [req.params.id, r2Key]
  );
  if (r.rows.length === 0) { res.status(404).json({ error: 'PCN not found' }); return; }
  await logPcnEvent(String(req.params.id), 'document_removed', 'Document removed', { r2_key: r2Key }, req.user!.id);
  res.json({ data: { documents: r.rows[0].documents } });
});

export default router;
