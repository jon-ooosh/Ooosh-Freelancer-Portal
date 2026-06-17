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
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { getSystemSettings } from './system-settings';

const router = Router();

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
         o.name                                     AS client_organisation_name,
         j.job_name                                 AS job_name,
         (hb.first_name || ' ' || hb.last_name)     AS handled_by_name
  FROM pcns p
  LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
  LEFT JOIN drivers d         ON d.id = p.driver_id
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

  res.json({ data: { drivers, match_count: drivers.length } });
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
  const { status, fine_type, search } = req.query;
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
  sql += ` ORDER BY p.created_at DESC`;
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

const createSchema = z.object({
  reference: z.string().optional().nullable(),
  fine_type: fineType.optional(),
  vehicle_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
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
  notes: z.string().optional().nullable(),
});

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof createSchema>;

  const result = await query(
    `INSERT INTO pcns (
       reference, fine_type, vehicle_id, driver_id, assignment_id, job_id,
       client_organisation_id, hh_job_number, vehicle_reg,
       offence_at, offence_time_text, location, issuing_authority, offence_description,
       fine_amount, reduced_amount, reduced_deadline, final_deadline,
       extraction_confidence, pcn_document_url, notes, handled_by, status
     ) VALUES (
       $1,$2,$3,$4,$5,$6, $7,$8,$9, $10,$11,$12,$13,$14,
       $15,$16,$17,$18, $19,$20,$21,$22, 'received'
     ) RETURNING *`,
    [
      b.reference ?? null, b.fine_type ?? 'other', b.vehicle_id ?? null, b.driver_id ?? null,
      b.assignment_id ?? null, b.job_id ?? null, b.client_organisation_id ?? null,
      b.hh_job_number ?? null, b.vehicle_reg ?? null,
      b.offence_at ?? null, b.offence_time_text ?? null, b.location ?? null,
      b.issuing_authority ?? null, b.offence_description ?? null,
      b.fine_amount ?? null, b.reduced_amount ?? null, b.reduced_deadline ?? null,
      b.final_deadline ?? null, b.extraction_confidence ?? null,
      b.pcn_document_url ?? null, b.notes ?? null, req.user!.id,
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
  'reference', 'fine_type', 'vehicle_id', 'driver_id', 'assignment_id', 'job_id',
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
  await logAudit(req.user!.id, 'pcns', pcn.id, 'update', before, pcn);
  res.json({ data: pcn });
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

export default router;
