/**
 * Holding module — "Held for Clients" + "Lost Property" + temp storage.
 *
 * One engine (held_items), kind discriminator drives behaviour + display home.
 * Replaces the Monday "Things being sent to us" + "Lost property & temporary
 * storage" boards and the merch/lost-property JotForms.
 *
 * Staff endpoints (STAFF_ROLES JWT). Public inbound form + label-QR
 * acknowledge flow land in a later stage (own token auth, mounted separately).
 *
 * See docs/HOLDING-MODULE-SPEC.md.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { isR2Configured, uploadToR2 } from '../config/r2';
import { emailService } from '../services/email-service';
import { frontendLink } from '../config/app-urls';
import { buildMerchLabelPdf } from '../services/holding-label-pdf';

const router = Router();

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ════════════════════════════════════════════════════════════════════════
// PUBLIC — inbound merch form (no JWT). MUST be before the staff auth gate.
// Replaces the JotForm. Client tells us what they're sending; we create the
// held_item, generate labels, and email them back.
// ════════════════════════════════════════════════════════════════════════

const publicLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false });

// Light job context so the form can confirm "this is for <client>"
router.get('/public/job/:hhJobNumber', publicLimiter, async (req: Request, res: Response) => {
  const n = Number(req.params.hhJobNumber);
  if (!Number.isFinite(n)) { res.status(400).json({ error: 'Invalid job number' }); return; }
  const r = await query(`SELECT job_name, client_name FROM jobs WHERE hh_job_number = $1`, [n]);
  if (r.rows.length === 0) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ data: { job_name: r.rows[0].job_name, client_name: r.rows[0].client_name } });
});

const merchFormSchema = z.object({
  band_name: z.string().min(1).max(200),
  hh_job_number: z.number().int().optional().nullable(),
  box_count: z.number().int().min(1).max(99).optional().nullable(), // null = "don't know yet"
  expected_date: z.string().optional().nullable(),
  import_charge_flag: z.enum(['yes', 'no', 'unknown']).optional().nullable(),
  contact_email: z.string().email(),
  contact_phone: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/public/merch-form', publicLimiter, validate(merchFormSchema), async (req: Request, res: Response) => {
  const b = req.body as z.infer<typeof merchFormSchema>;

  // Resolve the OP job if the HH number matches one we know
  let jobId: string | null = null;
  let jobName: string | null = null;
  if (b.hh_job_number) {
    const j = await query(`SELECT id, job_name FROM jobs WHERE hh_job_number = $1`, [b.hh_job_number]);
    if (j.rows.length > 0) { jobId = j.rows[0].id; jobName = j.rows[0].job_name; }
  }

  const description = b.box_count ? `${b.box_count} box(es) of merch/equipment` : 'Merch/equipment (box count TBC)';

  const ins = await query(
    `INSERT INTO held_items (
        kind, status, owner_unknown, client_name_text, job_id, hh_job_number,
        description, box_count, expected_date, import_charge_flag, needed_by,
        contact_email, contact_phone, notes, created_by
     ) VALUES ('incoming', 'expected', false, $1, $2, $3, $4, $5, $6, $7,
        CASE WHEN $2::uuid IS NOT NULL THEN (SELECT out_date::date FROM jobs WHERE id = $2::uuid) ELSE NULL END,
        $8, $9, $10, $11) RETURNING *`,
    [
      b.band_name, jobId, b.hh_job_number ?? null,
      description, b.box_count ?? null,
      b.expected_date || null, b.import_charge_flag ?? null,
      b.contact_email, b.contact_phone ?? null, b.notes || null, SYSTEM_USER_ID,
    ]
  );
  const item = ins.rows[0];

  // Forward-looking: surface on the job prep checklist
  if (jobId) {
    try {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by) VALUES ('note', $1, $2, $3)`,
        [`📦 Incoming delivery declared via merch form: ${description} from ${b.band_name}`, jobId, SYSTEM_USER_ID]
      );
      const existing = await query(`SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = 'merch' AND phase = 'pre_hire'`, [jobId]);
      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
           VALUES ($1, 'merch', 'in_progress', $2, true, 'holding', 'pre_hire')`,
          [jobId, 'Incoming merch declared via form — load before dispatch']
        );
      }
    } catch (err) { console.warn('[holding] merch-form job side-effects failed:', err); }
  }

  // Generate labels + email them back to the client (best-effort)
  let labelEmailed = false;
  try {
    const pdf = await buildMerchLabelPdf({ heldItemId: item.id, hhJobNumber: b.hh_job_number ?? null, clientName: b.band_name, boxCount: b.box_count ?? 1 });
    if (isR2Configured()) {
      await uploadToR2(`files/holding/labels/${item.id}.pdf`, pdf, 'application/pdf').catch((e) => console.warn('[holding] label R2 upload failed:', e));
    }
    await emailService.send('merch_label', {
      to: b.contact_email,
      variables: {
        clientName: b.band_name,
        jobName: jobName || b.band_name,
        jobNumber: String(b.hh_job_number || ''),
        boxCount: b.box_count ? String(b.box_count) : 'each',
      },
      attachments: [{ filename: `ooosh-labels-${b.hh_job_number || item.id}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
    labelEmailed = true;
  } catch (err) { console.warn('[holding] label generation/email failed:', err); }

  res.status(201).json({ data: { id: item.id, label_emailed: labelEmailed } });
});

// ════════════════════════════════════════════════════════════════════════
// STAFF — everything below requires a staff JWT.
// ════════════════════════════════════════════════════════════════════════

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// Send the inbound merch-form link to chosen client contacts (client-picker
// controlled — never a blast). Recipients come from the same picker the hire
// form uses; the frontend passes the selected ones.
const sendFormSchema = z.object({
  hh_job_number: z.number().int(),
  recipients: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).min(1).max(10),
  message: z.string().optional().nullable(),
});

router.post('/send-merch-form', validate(sendFormSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof sendFormSchema>;
  const j = await query(`SELECT job_name, client_name FROM jobs WHERE hh_job_number = $1`, [b.hh_job_number]);
  const jobName = j.rows[0]?.job_name || `Job #${b.hh_job_number}`;
  const formUrl = frontendLink(`/merch-form?job=${b.hh_job_number}`);

  const results = await Promise.all(b.recipients.map(async (r) => {
    try {
      await emailService.send('merch_form_request', {
        to: r.email,
        variables: {
          clientName: r.name || 'there',
          jobName,
          jobNumber: String(b.hh_job_number),
          formUrl,
          message: b.message || '',
        },
      });
      return { email: r.email, success: true };
    } catch (e) { return { email: r.email, success: false, error: e instanceof Error ? e.message : 'Send failed' }; }
  }));

  res.json({ data: { sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results } });
});

// Re-download / regenerate the label PDF for a held item
router.get('/:id/label', async (req: AuthRequest, res: Response) => {
  const r = await query(`SELECT id, hh_job_number, client_name_text, box_count FROM held_items WHERE id = $1`, [req.params.id]);
  if (r.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  const h = r.rows[0];
  const pdf = await buildMerchLabelPdf({ heldItemId: h.id, hhJobNumber: h.hh_job_number, clientName: h.client_name_text || 'Client', boxCount: h.box_count || 1 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ooosh-labels-${h.hh_job_number || h.id}.pdf"`);
  res.send(pdf);
});

const TERMINAL = ['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'];

// Shared SELECT with the joined display fields the frontend expects
const SELECT_WITH_JOINS = `
  SELECT h.*,
         (p.first_name || ' ' || p.last_name)      AS owner_person_name,
         o.name                                    AS owner_organisation_name,
         loc.name                                  AS storage_location_name,
         j.job_name                                AS job_name,
         fv.reg                                    AS found_vehicle_reg,
         (rbp.first_name || ' ' || rbp.last_name)  AS received_by_name
  FROM held_items h
  LEFT JOIN people p              ON p.id = h.owner_person_id
  LEFT JOIN organisations o       ON o.id = h.owner_organisation_id
  LEFT JOIN held_item_locations loc ON loc.id = h.storage_location_id
  LEFT JOIN jobs j                ON j.id = h.job_id
  LEFT JOIN fleet_vehicles fv     ON fv.id = h.found_vehicle_id
  LEFT JOIN users rb              ON rb.id = h.received_by
  LEFT JOIN people rbp            ON rbp.id = rb.person_id
`;

// ════════════════════════ LOCATIONS (picklist) ════════════════════════

router.get('/locations', async (_req: AuthRequest, res: Response) => {
  const result = await query(
    `SELECT * FROM held_item_locations WHERE is_active = true ORDER BY sort_order, name`
  );
  res.json({ data: result.rows });
});

// ════════════════════════ CHASE REVIEW (lost property) ════════════════════════
// The human-gated escalation queue — items due a chase, NOT auto-sent.

router.get('/chases/review', async (_req: AuthRequest, res: Response) => {
  const result = await query(
    `${SELECT_WITH_JOINS}
     WHERE h.kind = 'lost_property'
       AND h.status NOT IN ('collected', 'shipped_back', 'disposed', 'cancelled')
       AND (h.owner_person_id IS NOT NULL OR h.owner_organisation_id IS NOT NULL)
       AND (
         h.last_chased_at IS NULL
         OR h.last_chased_at < NOW() - INTERVAL '7 days'
       )
       AND h.found_date IS NOT NULL
       AND h.found_date <= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY h.found_date ASC`
  );
  res.json({ data: result.rows });
});

// ════════════════════════ BY-ENTITY READS (surfacing) ════════════════════════

router.get('/by-person/:personId', async (req: AuthRequest, res: Response) => {
  const { open_only } = req.query;
  let sql = `${SELECT_WITH_JOINS} WHERE h.owner_person_id = $1`;
  if (open_only === 'true') sql += ` AND h.status NOT IN ('collected','given_to_client','shipped_back','disposed','cancelled')`;
  sql += ` ORDER BY h.created_at DESC`;
  const result = await query(sql, [req.params.personId]);
  res.json({ data: result.rows });
});

router.get('/by-org/:orgId', async (req: AuthRequest, res: Response) => {
  const { open_only } = req.query;
  let sql = `${SELECT_WITH_JOINS} WHERE h.owner_organisation_id = $1`;
  if (open_only === 'true') sql += ` AND h.status NOT IN ('collected','given_to_client','shipped_back','disposed','cancelled')`;
  sql += ` ORDER BY h.created_at DESC`;
  const result = await query(sql, [req.params.orgId]);
  res.json({ data: result.rows });
});

router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  // Accept OP UUID or HH job number
  const id = String(req.params.jobId);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const sql = isUuid
    ? `${SELECT_WITH_JOINS} WHERE h.job_id = $1 ORDER BY h.created_at DESC`
    : `${SELECT_WITH_JOINS} WHERE h.hh_job_number = $1 ORDER BY h.created_at DESC`;
  const result = await query(sql, [isUuid ? id : Number(id)]);
  res.json({ data: result.rows });
});

// ════════════════════════ LIST ════════════════════════

router.get('/', async (req: AuthRequest, res: Response) => {
  const { kind, status, search, owner_unknown, include_done } = req.query;
  let sql = `${SELECT_WITH_JOINS} WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;
  if (kind) { sql += ` AND h.kind = $${i++}`; params.push(kind); }
  if (status) { sql += ` AND h.status = $${i++}`; params.push(status); }
  if (owner_unknown === 'true') { sql += ` AND h.owner_unknown = true`; }
  if (include_done !== 'true') { sql += ` AND h.status NOT IN ('collected','given_to_client','shipped_back','disposed','cancelled')`; }
  if (search) {
    sql += ` AND (h.description ILIKE $${i} OR h.client_name_text ILIKE $${i} OR h.notes ILIKE $${i}
                  OR CAST(h.hh_job_number AS TEXT) ILIKE $${i})`;
    params.push(`%${search}%`);
    i++;
  }
  sql += ` ORDER BY COALESCE(h.needed_by, h.dispose_after, h.created_at::date) ASC, h.created_at DESC`;
  const result = await query(sql, params);
  res.json({ data: result.rows });
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const result = await query(`${SELECT_WITH_JOINS} WHERE h.id = $1`, [req.params.id]);
  if (result.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  res.json({ data: result.rows[0] });
});

// ════════════════════════ CREATE ════════════════════════

const photoSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  comment: z.string().optional(),
  url: z.string(),
  type: z.enum(['document', 'image', 'other']).optional().default('image'),
  uploaded_at: z.string().optional(),
  uploaded_by: z.string().optional(),
});

const createSchema = z.object({
  kind: z.enum(['incoming', 'lost_property', 'temp_storage']),
  status: z.enum([
    'expected', 'arrived', 'stored', 'client_notified', 'collection_arranged',
    'collected', 'given_to_client', 'shipped_back', 'disposed', 'unclaimed', 'cancelled',
  ]).optional(),
  owner_unknown: z.boolean().optional(),
  owner_person_id: z.string().uuid().optional().nullable(),
  owner_organisation_id: z.string().uuid().optional().nullable(),
  client_name_text: z.string().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  hh_job_number: z.number().int().optional().nullable(),
  description: z.string().optional().nullable(),
  box_count: z.number().int().optional().nullable(),
  received_count: z.number().int().optional().nullable(),
  condition_notes: z.string().optional().nullable(),
  photos: z.array(photoSchema).optional().default([]),
  found_in: z.enum(['van', 'rehearsal', 'backline', 'elsewhere']).optional().nullable(),
  found_vehicle_id: z.string().uuid().optional().nullable(),
  found_location_text: z.string().optional().nullable(),
  storage_location_id: z.string().uuid().optional().nullable(),
  storage_location_text: z.string().optional().nullable(),
  storage_room_id: z.string().uuid().optional().nullable(),
  expected_date: z.string().optional().nullable(),
  import_charge_flag: z.enum(['yes', 'no', 'unknown']).optional().nullable(),
  needed_by: z.string().optional().nullable(),
  chargeable: z.boolean().optional(),
  storage_started_at: z.string().optional().nullable(),
  charge_notes: z.string().optional().nullable(),
  dispose_after: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof createSchema>;

  // Default status by kind: incoming with no arrival = expected, everything else stored
  const status = b.status ?? (b.kind === 'incoming' && !b.received_count ? 'expected' : 'stored');
  // Stamp the receipt/found clock
  const arrivedAt = (b.kind !== 'lost_property' && status !== 'expected') ? 'NOW()' : null;
  const foundDate = b.kind === 'lost_property' ? 'CURRENT_DATE' : null;

  const result = await query(
    `INSERT INTO held_items (
        kind, status, owner_unknown,
        owner_person_id, owner_organisation_id, client_name_text, job_id, hh_job_number,
        description, box_count, received_count, condition_notes, photos,
        found_in, found_vehicle_id, found_location_text,
        storage_location_id, storage_location_text, storage_room_id,
        expected_date, import_charge_flag, needed_by,
        chargeable, storage_started_at, charge_notes, dispose_after, notes,
        arrived_at, found_date, created_by
     ) VALUES (
        $1,$2,$3, $4,$5,$6,$7,$8, $9,$10,$11,$12,$13,
        $14,$15,$16, $17,$18,$19, $20,$21,$22,
        $23,$24,$25,$26,$27,
        ${arrivedAt ?? 'NULL'}, ${foundDate ?? 'NULL'}, $28
     ) RETURNING *`,
    [
      b.kind, status, b.owner_unknown ?? false,
      b.owner_person_id ?? null, b.owner_organisation_id ?? null, b.client_name_text ?? null,
      b.job_id ?? null, b.hh_job_number ?? null,
      b.description ?? null, b.box_count ?? null, b.received_count ?? null,
      b.condition_notes ?? null, JSON.stringify(b.photos ?? []),
      b.found_in ?? null, b.found_vehicle_id ?? null, b.found_location_text ?? null,
      b.storage_location_id ?? null, b.storage_location_text ?? null, b.storage_room_id ?? null,
      b.expected_date ?? null, b.import_charge_flag ?? null, b.needed_by ?? null,
      b.chargeable ?? false, b.storage_started_at ?? null, b.charge_notes ?? null,
      b.dispose_after ?? null, b.notes ?? null,
      req.user!.id,
    ]
  );
  const item = result.rows[0];
  await logAudit(req.user!.id, 'held_items', item.id, 'create', null, item);

  // If already linked to a job, log it on that job's timeline
  if (item.job_id) {
    await logToJobTimeline(item, req.user!.id, 'logged');
    if (item.kind === 'incoming') await ensureMerchRequirement(item.job_id);
  }

  res.status(201).json({ data: item });
});

// ════════════════════════ UPDATE ════════════════════════

router.put('/:id', validate(createSchema.partial()), async (req: AuthRequest, res: Response) => {
  const b = req.body as Partial<z.infer<typeof createSchema>>;
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(b)) {
    fields.push(`${k} = $${i++}`);
    params.push(k === 'photos' ? JSON.stringify(v) : v);
  }
  // When staff mark a declared/undeclared delivery as arrived/stored, stamp the
  // arrival clock + who booked it in (only the first time — preserve the original).
  if (b.status === 'stored' || b.status === 'arrived') {
    fields.push(`arrived_at = COALESCE(arrived_at, NOW())`);
    fields.push(`received_by = COALESCE(received_by, $${i++})`);
    params.push(req.user!.id);
  }
  if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(req.params.id);
  const result = await query(
    `UPDATE held_items SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    params
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  res.json({ data: result.rows[0] });
});

// ════════════════════════ LINK (owner / job) — the backfill cascade ════════════════════════

const linkSchema = z.object({
  owner_person_id: z.string().uuid().optional().nullable(),
  owner_organisation_id: z.string().uuid().optional().nullable(),
  client_name_text: z.string().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  hh_job_number: z.number().int().optional().nullable(),
});

router.post('/:id/link', validate(linkSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof linkSchema>;

  // If only an HH job number was supplied, resolve the OP job UUID so the
  // needed_by deadline derivation (which reads jobs.out_date by id) can fire.
  let jobId = b.job_id ?? null;
  if (!jobId && b.hh_job_number) {
    const j = await query(`SELECT id FROM jobs WHERE hh_job_number = $1`, [b.hh_job_number]);
    if (j.rows.length > 0) jobId = j.rows[0].id;
  }

  // Resolve the job's out_date so forward-looking kinds get a needed_by deadline
  const result = await query(
    `UPDATE held_items SET
        owner_person_id       = COALESCE($1, owner_person_id),
        owner_organisation_id = COALESCE($2, owner_organisation_id),
        client_name_text      = COALESCE($3, client_name_text),
        job_id                = COALESCE($4, job_id),
        hh_job_number         = COALESCE($5, hh_job_number),
        owner_unknown         = CASE
          WHEN $1 IS NOT NULL OR $2 IS NOT NULL THEN false ELSE owner_unknown END,
        needed_by             = CASE
          WHEN $4 IS NOT NULL AND kind IN ('incoming','temp_storage') AND needed_by IS NULL
          THEN (SELECT out_date::date FROM jobs WHERE id = $4)
          ELSE needed_by END,
        updated_at            = NOW()
     WHERE id = $6 RETURNING *`,
    [
      b.owner_person_id ?? null, b.owner_organisation_id ?? null, b.client_name_text ?? null,
      jobId, b.hh_job_number ?? null, req.params.id,
    ]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  const item = result.rows[0];
  await logAudit(req.user!.id, 'held_items', item.id, 'update', null, item);

  if (item.job_id) {
    await logToJobTimeline(item, req.user!.id, 'linked');
    if (item.kind === 'incoming') await ensureMerchRequirement(item.job_id);
  }

  res.json({ data: item });
});

// ════════════════════════ LIFECYCLE ACTIONS ════════════════════════

const collectedSchema = z.object({
  collected_by: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// Mark collected / handed over (the §7A frictionless handover action)
router.post('/:id/collected', validate(collectedSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof collectedSchema>;
  const cur = await query(`SELECT kind FROM held_items WHERE id = $1`, [req.params.id]);
  if (cur.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  // Incoming = "given to client" (loaded), everything else = "collected"
  const status = cur.rows[0].kind === 'incoming' ? 'given_to_client' : 'collected';
  const result = await query(
    `UPDATE held_items SET status = $1, collected_at = NOW(), collected_by = $2,
        notes = COALESCE($3, notes), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [status, b.collected_by ?? null, b.notes ?? null, req.params.id]
  );
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  if (result.rows[0].job_id) await logToJobTimeline(result.rows[0], req.user!.id, status === 'given_to_client' ? 'given to client' : 'collected');
  res.json({ data: result.rows[0] });
});

const shipBackSchema = z.object({
  return_method: z.string().min(1),
  tracking_number: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/:id/ship-back', validate(shipBackSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof shipBackSchema>;
  const result = await query(
    `UPDATE held_items SET status = 'shipped_back', return_method = $1, tracking_number = $2,
        notes = COALESCE($3, notes), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [b.return_method, b.tracking_number ?? null, b.notes ?? null, req.params.id]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  res.json({ data: result.rows[0] });
});

router.post('/:id/dispose', async (req: AuthRequest, res: Response) => {
  const result = await query(
    `UPDATE held_items SET status = 'disposed', disposed_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  res.json({ data: result.rows[0] });
});

// Notify the client their items have arrived. Emails the contact captured on
// the record (or the job's client contacts as a fallback), flips status to
// client_notified, and reports who got it so the UI can show clear feedback.
router.post('/:id/notify', async (req: AuthRequest, res: Response) => {
  const cur = await query(
    `SELECT h.*, j.job_name, j.hh_job_number AS job_hh
     FROM held_items h LEFT JOIN jobs j ON j.id = h.job_id WHERE h.id = $1`,
    [req.params.id]
  );
  if (cur.rows.length === 0) { res.status(404).json({ error: 'Held item not found' }); return; }
  const h = cur.rows[0];

  // Resolve recipient: the contact captured on the record wins; else the job's
  // client contacts via the shared resolver.
  let to: string | null = h.contact_email || null;
  if (!to && h.job_id) {
    try {
      const { resolveClientEmailTarget } = await import('../services/money-emails');
      const target = await resolveClientEmailTarget(h.job_id);
      to = target?.primaryEmail || null;
    } catch { /* fall through */ }
  }

  let emailed = false;
  if (to) {
    const received = h.received_count ? ` (${h.received_count} item${h.received_count === 1 ? '' : 's'})` : '';
    try {
      await emailService.send('holding_received', {
        to,
        variables: {
          clientName: h.owner_person_name || h.client_name_text || 'there',
          jobName: h.job_name || h.client_name_text || 'your hire',
          jobNumber: String(h.hh_job_number || h.job_hh || ''),
          receivedSummary: received,
        },
      });
      emailed = true;
    } catch (err) { console.warn('[holding] notify email failed:', err); }
  }

  const result = await query(
    `UPDATE held_items SET status = CASE WHEN status IN ('expected','arrived','stored') THEN 'client_notified' ELSE status END,
        updated_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  if (result.rows[0].job_id) await logToJobTimeline(result.rows[0], req.user!.id, emailed ? `client notified (${to})` : 'marked client notified');
  res.json({ data: result.rows[0], emailed, notified_to: emailed ? to : null });
});

// Send a chase (from the human-gated review queue). Bumps the escalation level.
router.post('/:id/chase', async (req: AuthRequest, res: Response) => {
  const result = await query(
    `UPDATE held_items SET escalation_level = LEAST(escalation_level + 1, 3),
        last_chased_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND kind = 'lost_property' RETURNING *`,
    [req.params.id]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Lost property item not found' }); return; }
  await logAudit(req.user!.id, 'held_items', req.params.id as string, 'update', null, result.rows[0]);
  // TODO (Stage 8): send the gradient chase email (wk1/wk2/wk3) to the client.
  res.json({ data: result.rows[0] });
});

// ════════════════════════ helpers ════════════════════════

async function logToJobTimeline(item: Record<string, unknown>, userId: string, verb: string): Promise<void> {
  try {
    const kindLabel = item.kind === 'lost_property' ? 'Lost property' : item.kind === 'incoming' ? 'Incoming delivery' : 'Held item';
    const desc = (item.description as string) || `${item.box_count || ''} item(s)`.trim();
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by) VALUES ('note', $1, $2, $3)`,
      [`📦 ${kindLabel} ${verb}: ${desc}`.trim(), item.job_id, userId]
    );
  } catch (err) {
    console.warn('[holding] failed to log job timeline interaction:', err);
  }
}

// When an incoming delivery is linked to a job, make sure the job's pre-hire
// prep checklist carries a `merch` requirement so the boxes surface on the
// checklist + dashboard progress strip ("do something with these before the
// van leaves"). Idempotent — only creates if one doesn't already exist.
async function ensureMerchRequirement(jobId: string): Promise<void> {
  try {
    const existing = await query(
      `SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = 'merch' AND phase = 'pre_hire'`,
      [jobId]
    );
    if (existing.rows.length > 0) return;
    await query(
      `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
       VALUES ($1, 'merch', 'in_progress', $2, true, 'holding', 'pre_hire')`,
      [jobId, 'Incoming items logged in Holding — load before dispatch']
    );
  } catch (err) {
    console.warn('[holding] failed to ensure merch requirement:', err);
  }
}

export default router;
