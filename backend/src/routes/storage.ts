/**
 * Client Storage — standalone OP-native module (replaces Monday "Storage Clients").
 *
 * Public endpoints (token auth, no JWT) — defined BEFORE the staff auth gate:
 *   GET  /api/storage/tcs/by-token/:token          — load T&Cs + tenancy context
 *   POST /api/storage/tcs/by-token/:token/accept    — record acceptance + signature
 *
 * Staff endpoints (STAFF_ROLES JWT):
 *   rooms, tenancies (+ rate / invoice / move-out / access list / T&Cs send),
 *   access events, waiting list, T&Cs versions, overview.
 *
 * See docs/STORAGE-CLIENTS-SPEC.md.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { isR2Configured, uploadToR2 } from '../config/r2';
import { emailService } from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';
import { encrypt, tryDecrypt, isEncryptionConfigured } from '../services/encryption';

const router = Router();

const ADMIN_MANAGER = ['admin', 'manager'] as const;

// ── Door-code encryption (migration 121, see docs/STORAGE-CLIENTS-SPEC.md §9) ──
// Encrypt-at-rest for the per-tenancy access_code. When the key is configured
// we store ONLY the ciphertext (plaintext column nulled); otherwise we fall
// back to plaintext so nothing breaks pre-key.
function prepAccessCode(code: string | null | undefined): { plain: string | null; enc: string | null } {
  if (!code) return { plain: null, enc: null };
  if (isEncryptionConfigured()) return { plain: null, enc: encrypt(code) };
  return { plain: code, enc: null };
}
// Decrypt for the response + strip the ciphertext column so it never leaves the API.
function revealAccessCode(row: Record<string, unknown>): Record<string, unknown> {
  if (row['access_code_encrypted']) {
    row['access_code'] = tryDecrypt(row['access_code_encrypted'] as string) ?? row['access_code'] ?? null;
  }
  delete row['access_code_encrypted'];
  return row;
}
// Strip both code fields from a row entirely (list views — the code is only
// ever exposed via the single-tenancy detail endpoint).
function stripAccessCode(row: Record<string, unknown>): Record<string, unknown> {
  delete row['access_code'];
  delete row['access_code_encrypted'];
  return row;
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC — T&Cs accept (token, no JWT). MUST be before the staff auth gate.
// ════════════════════════════════════════════════════════════════════════

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET context for the public accept page
router.get('/tcs/by-token/:token', publicLimiter, async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const result = await query(
    `SELECT t.id AS tenancy_id, t.tcs_agreement_id, r.name AS room_name,
            o.name AS organisation_name,
            v.id AS version_id, v.version, v.body
     FROM storage_tenancies t
     JOIN storage_rooms r ON r.id = t.room_id
     LEFT JOIN organisations o ON o.id = t.organisation_id
     LEFT JOIN storage_tcs_versions v ON v.is_current = true
     WHERE t.tcs_token = $1`,
    [token]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'This link is no longer valid.' });
    return;
  }
  const row = result.rows[0];
  res.json({
    data: {
      roomName: row.room_name,
      organisationName: row.organisation_name,
      version: row.version,
      body: row.body,
      alreadyAccepted: !!row.tcs_agreement_id,
    },
  });
});

const acceptSchema = z.object({
  accepted_by_name: z.string().min(1).max(200),
  signature: z.string().optional().nullable(), // data URL (png base64)
});

// POST accept — records the agreement + signature, clears the token
router.post('/tcs/by-token/:token/accept', publicLimiter, validate(acceptSchema), async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const { accepted_by_name, signature } = req.body as z.infer<typeof acceptSchema>;

  const tenancyRes = await query(
    `SELECT t.id, t.tcs_agreement_id, v.id AS version_id, v.version, v.body,
            r.name AS room_name, o.name AS org_name
     FROM storage_tenancies t
     JOIN storage_rooms r ON r.id = t.room_id
     LEFT JOIN organisations o ON o.id = t.organisation_id
     LEFT JOIN storage_tcs_versions v ON v.is_current = true
     WHERE t.tcs_token = $1`,
    [token]
  );
  if (tenancyRes.rows.length === 0) {
    res.status(404).json({ error: 'This link is no longer valid.' });
    return;
  }
  const tenancy = tenancyRes.rows[0];
  if (tenancy.tcs_agreement_id) {
    res.status(409).json({ error: 'These terms have already been accepted.' });
    return;
  }

  // Persist signature image to R2 if supplied (keep the buffer for the PDF too)
  let signatureKey: string | null = null;
  let signatureBuf: Buffer | null = null;
  if (signature && signature.startsWith('data:image')) {
    try {
      signatureBuf = Buffer.from(signature.split(',')[1] || '', 'base64');
      if (isR2Configured()) {
        signatureKey = `files/storage/tcs/${tenancy.id}/signature-${Date.now()}.png`;
        await uploadToR2(signatureKey, signatureBuf, 'image/png');
      }
    } catch (err) {
      console.warn('[storage] T&Cs signature upload failed:', err);
    }
  }

  const acceptedAt = new Date();
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
  const agreement = await query(
    `INSERT INTO storage_tcs_agreements
       (tenancy_id, version_id, accepted_by_name, signature_r2_key, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenancy.id, tenancy.version_id || null, accepted_by_name, signatureKey, ip, req.headers['user-agent'] || null]
  );

  await query(
    `UPDATE storage_tenancies SET tcs_agreement_id = $1, tcs_token = NULL, updated_at = NOW() WHERE id = $2`,
    [agreement.rows[0].id, tenancy.id]
  );

  // Generate the signed-agreement PDF snapshot (best-effort — never block acceptance).
  if (isR2Configured()) {
    try {
      const { generateStorageTcsPdf } = await import('../services/storage-tcs-pdf');
      const pdfBytes = await generateStorageTcsPdf({
        orgName: tenancy.org_name, roomName: tenancy.room_name, version: tenancy.version,
        bodyHtml: tenancy.body || '', acceptedByName: accepted_by_name, acceptedAt,
        signaturePng: signatureBuf, ip,
      });
      const pdfKey = `files/storage/tcs/${tenancy.id}/agreement-${agreement.rows[0].id}.pdf`;
      await uploadToR2(pdfKey, Buffer.from(pdfBytes), 'application/pdf');
      await query(`UPDATE storage_tcs_agreements SET pdf_r2_key = $1 WHERE id = $2`, [pdfKey, agreement.rows[0].id]);
    } catch (err) {
      console.warn('[storage] T&Cs PDF generation failed (acceptance still recorded):', err);
    }
  }

  res.json({ data: { accepted: true } });
});

// ════════════════════════════════════════════════════════════════════════
// STAFF GATE — everything below requires a staff JWT.
// ════════════════════════════════════════════════════════════════════════
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// ── Overview (occupancy + reminder counts) ───────────────────────────────
router.get('/overview', async (_req: AuthRequest, res: Response) => {
  const rooms = await query(`SELECT status, COUNT(*)::int AS n FROM storage_rooms WHERE is_active = true GROUP BY status`);
  const live = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(weekly_rate),0)::numeric AS weekly
     FROM storage_tenancies WHERE status IN ('active','notice')`
  );
  const billingDue = await query(
    `SELECT COUNT(*)::int AS n FROM storage_tenancies
     WHERE status IN ('active','notice') AND billing_mode = 'manual'
       AND next_bill_date IS NOT NULL
       AND next_bill_date - (bill_reminder_lead_days || ' days')::interval <= CURRENT_DATE`
  );
  const reviewsDue = await query(
    `SELECT COUNT(*)::int AS n FROM storage_tenancies
     WHERE status IN ('active','notice') AND next_rate_review_date IS NOT NULL
       AND next_rate_review_date <= CURRENT_DATE`
  );
  const accessOpen = await query(
    `SELECT COUNT(*)::int AS n FROM storage_access_events WHERE status IN ('requested','scheduled')`
  );
  const waiting = await query(`SELECT COUNT(*)::int AS n FROM storage_waiting_list WHERE status = 'waiting'`);

  const byStatus: Record<string, number> = {};
  for (const r of rooms.rows) byStatus[r.status] = r.n;
  const weekly = Number(live.rows[0].weekly || 0);

  res.json({
    data: {
      rooms_by_status: byStatus,
      active_tenancies: live.rows[0].n,
      weekly_revenue: weekly,
      monthly_revenue: Math.round((weekly * 52 / 12) * 100) / 100,
      billing_due: billingDue.rows[0].n,
      reviews_due: reviewsDue.rows[0].n,
      access_open: accessOpen.rows[0].n,
      waiting: waiting.rows[0].n,
    },
  });
});

// ════════════════════════ ROOMS ════════════════════════

router.get('/rooms', async (req: AuthRequest, res: Response) => {
  const { status, search } = req.query;
  let sql = `
    SELECT r.*,
           t.id AS tenancy_id, t.organisation_id, t.status AS tenancy_status,
           o.name AS occupant_name
    FROM storage_rooms r
    LEFT JOIN LATERAL (
      SELECT * FROM storage_tenancies st
      WHERE st.room_id = r.id AND st.status IN ('active','notice','reserved')
      ORDER BY st.created_at DESC LIMIT 1
    ) t ON true
    LEFT JOIN organisations o ON o.id = t.organisation_id
    WHERE r.is_active = true`;
  const params: unknown[] = [];
  let i = 1;
  if (status) { sql += ` AND r.status = $${i++}`; params.push(status); }
  if (search) { sql += ` AND r.name ILIKE $${i++}`; params.push(`%${search}%`); }
  sql += ` ORDER BY r.name`;
  const result = await query(sql, params);
  res.json({ data: result.rows });
});

router.get('/rooms/:id', async (req: AuthRequest, res: Response) => {
  const result = await query(`SELECT * FROM storage_rooms WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) { res.status(404).json({ error: 'Room not found' }); return; }
  res.json({ data: result.rows[0] });
});

const roomSchema = z.object({
  name: z.string().min(1).max(120),
  size_category: z.enum(['small', 'medium', 'large', 'xl']).default('medium'),
  location_type: z.enum(['internal', 'external']).optional().nullable(),
  default_weekly_rate: z.number().nonnegative().optional().nullable(),
  dimensions: z.string().max(120).optional().nullable(),
  area_sqft: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
  photos: z.array(z.object({ name: z.string(), url: z.string(), type: z.string().optional() })).optional().default([]),
  status: z.enum(['available', 'occupied', 'reserved', 'out_of_use']).optional(),
  notes: z.string().optional().nullable(),
});

router.post('/rooms', authorize(...ADMIN_MANAGER), validate(roomSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof roomSchema>;
  const result = await query(
    `INSERT INTO storage_rooms (name, size_category, location_type, default_weekly_rate, dimensions, area_sqft,
        description, photos, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.name, b.size_category, b.location_type ?? null, b.default_weekly_rate ?? null, b.dimensions ?? null,
     b.area_sqft ?? null, b.description ?? null, JSON.stringify(b.photos ?? []), b.status ?? 'available',
     b.notes ?? null, req.user!.id]
  );
  await logAudit(req.user!.id, 'storage_rooms', result.rows[0].id, 'create', null, result.rows[0]);
  res.status(201).json({ data: result.rows[0] });
});

router.put('/rooms/:id', authorize(...ADMIN_MANAGER), validate(roomSchema.partial()), async (req: AuthRequest, res: Response) => {
  const b = req.body as Partial<z.infer<typeof roomSchema>>;
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(b)) {
    fields.push(`${k} = $${i++}`);
    params.push(k === 'photos' ? JSON.stringify(v) : v);
  }
  if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(req.params.id);
  const result = await query(
    `UPDATE storage_rooms SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    params
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Room not found' }); return; }
  await logAudit(req.user!.id, 'storage_rooms', req.params.id as string, 'update', null, result.rows[0]);
  res.json({ data: result.rows[0] });
});

// ════════════════════════ TENANCIES ════════════════════════

router.get('/tenancies', async (req: AuthRequest, res: Response) => {
  const { status, search } = req.query;
  let sql = `
    SELECT t.*, r.name AS room_name, r.size_category,
           o.name AS organisation_name,
           p.first_name || ' ' || p.last_name AS lead_contact_name,
           a.accepted_at AS tcs_accepted_at
    FROM storage_tenancies t
    JOIN storage_rooms r ON r.id = t.room_id
    LEFT JOIN organisations o ON o.id = t.organisation_id
    LEFT JOIN people p ON p.id = t.lead_contact_person_id
    LEFT JOIN storage_tcs_agreements a ON a.id = t.tcs_agreement_id
    WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;
  if (status === 'live') { sql += ` AND t.status IN ('active','notice','reserved')`; }
  else if (status) { sql += ` AND t.status = $${i++}`; params.push(status); }
  if (search) { sql += ` AND (o.name ILIKE $${i} OR r.name ILIKE $${i})`; params.push(`%${search}%`); i++; }
  sql += ` ORDER BY (t.status = 'ended'), r.name`;
  const result = await query(sql, params);
  res.json({ data: result.rows.map(stripAccessCode) });
});

router.get('/tenancies/:id', async (req: AuthRequest, res: Response) => {
  const t = await query(
    `SELECT t.*, r.name AS room_name, r.size_category, r.location_type,
            o.name AS organisation_name,
            p.first_name || ' ' || p.last_name AS lead_contact_name,
            a.accepted_at AS tcs_accepted_at, a.accepted_by_name AS tcs_accepted_by, a.pdf_r2_key AS tcs_pdf_key
     FROM storage_tenancies t
     JOIN storage_rooms r ON r.id = t.room_id
     LEFT JOIN organisations o ON o.id = t.organisation_id
     LEFT JOIN people p ON p.id = t.lead_contact_person_id
     LEFT JOIN storage_tcs_agreements a ON a.id = t.tcs_agreement_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (t.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found' }); return; }
  const [rateHistory, accessList, invoices] = await Promise.all([
    query(`SELECT * FROM storage_rate_history WHERE tenancy_id = $1 ORDER BY effective_date DESC`, [req.params.id]),
    query(`SELECT al.*, p.first_name || ' ' || p.last_name AS person_name
           FROM storage_access_list al LEFT JOIN people p ON p.id = al.person_id
           WHERE al.tenancy_id = $1 ORDER BY al.added_at DESC`, [req.params.id]),
    query(`SELECT * FROM storage_invoice_log WHERE tenancy_id = $1 ORDER BY sent_at DESC`, [req.params.id]),
  ]);
  res.json({ data: { ...revealAccessCode(t.rows[0]), rate_history: rateHistory.rows, access_list: accessList.rows, invoices: invoices.rows } });
});

const tenancySchema = z.object({
  room_id: z.string().uuid(),
  organisation_id: z.string().uuid().optional().nullable(),
  lead_contact_person_id: z.string().uuid().optional().nullable(),
  status: z.enum(['reserved', 'active', 'notice', 'ended']).default('active'),
  move_in_date: z.string().optional().nullable(),
  weekly_rate: z.number().nonnegative().default(0),
  access_type: z.enum(['door_code', 'we_hold_key', 'client_key']).default('door_code'),
  access_code: z.string().optional().nullable(),
  key_location: z.string().max(200).optional().nullable(),
  billing_mode: z.enum(['recurring', 'manual']).default('manual'),
  billing_cadence: z.enum(['monthly', 'quarterly', 'annual', 'custom']).default('monthly'),
  next_bill_date: z.string().optional().nullable(),
  bill_reminder_person_id: z.string().uuid().optional().nullable(),
  bill_reminder_lead_days: z.number().int().optional(),
  bill_overdue_grace_days: z.number().int().optional(),
  rate_review_cadence: z.enum(['annual', 'biennial', 'custom']).default('annual'),
  next_rate_review_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/tenancies', validate(tenancySchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof tenancySchema>;
  try {
    const ac = prepAccessCode(b.access_code);
    const result = await query(
      `INSERT INTO storage_tenancies
        (room_id, organisation_id, lead_contact_person_id, status, move_in_date, weekly_rate,
         access_type, access_code, access_code_encrypted, key_location,
         billing_mode, billing_cadence, next_bill_date, bill_reminder_person_id,
         bill_reminder_lead_days, bill_overdue_grace_days, rate_review_cadence, next_rate_review_date,
         notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,7),COALESCE($16,5),$17,$18,$19,$20) RETURNING *`,
      [b.room_id, b.organisation_id ?? null, b.lead_contact_person_id ?? null, b.status, b.move_in_date ?? null,
       b.weekly_rate, b.access_type, ac.plain, ac.enc, b.key_location ?? null,
       b.billing_mode, b.billing_cadence, b.next_bill_date ?? null, b.bill_reminder_person_id ?? null,
       b.bill_reminder_lead_days ?? null, b.bill_overdue_grace_days ?? null, b.rate_review_cadence,
       b.next_rate_review_date ?? null, b.notes ?? null, req.user!.id]
    );
    // Reflect occupancy on the room
    await query(`UPDATE storage_rooms SET status = 'occupied', updated_at = NOW() WHERE id = $1 AND status != 'out_of_use'`, [b.room_id]);
    await logAudit(req.user!.id, 'storage_tenancies', result.rows[0].id, 'create', null, stripAccessCode({ ...result.rows[0] }));
    res.status(201).json({ data: revealAccessCode(result.rows[0]) });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'This room already has a live tenancy. End it before adding a new one.' });
      return;
    }
    throw err;
  }
});

router.put('/tenancies/:id', validate(tenancySchema.partial()), async (req: AuthRequest, res: Response) => {
  const allowed = ['organisation_id', 'lead_contact_person_id', 'status', 'move_in_date', 'billing_mode',
    'billing_cadence', 'next_bill_date', 'bill_reminder_person_id', 'bill_reminder_lead_days',
    'bill_overdue_grace_days', 'rate_review_cadence', 'next_rate_review_date', 'notes',
    'access_type', 'access_code', 'key_location'];
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(req.body)) {
    if (!allowed.includes(k)) continue;
    if (k === 'access_code') {
      const ac = prepAccessCode(v as string | null);
      fields.push(`access_code = $${i++}`); params.push(ac.plain);
      fields.push(`access_code_encrypted = $${i++}`); params.push(ac.enc);
      continue;
    }
    fields.push(`${k} = $${i++}`);
    params.push(v);
  }
  if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(req.params.id);
  const result = await query(`UPDATE storage_tenancies SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, params);
  if (result.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found' }); return; }
  await logAudit(req.user!.id, 'storage_tenancies', req.params.id as string, 'update', null, stripAccessCode({ ...result.rows[0] }));
  res.json({ data: revealAccessCode(result.rows[0]) });
});

// Rate change (writes history)
const rateSchema = z.object({
  new_rate: z.number().nonnegative(),
  effective_date: z.string().optional().nullable(),
  next_rate_review_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
router.post('/tenancies/:id/rate', authorize(...ADMIN_MANAGER), validate(rateSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof rateSchema>;
  const cur = await query(`SELECT weekly_rate FROM storage_tenancies WHERE id = $1`, [req.params.id]);
  if (cur.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found' }); return; }
  const oldRate = Number(cur.rows[0].weekly_rate);
  const effective = b.effective_date || new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO storage_rate_history (tenancy_id, effective_date, old_rate, new_rate, changed_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, effective, oldRate, b.new_rate, req.user!.id, b.notes ?? null]
  );
  const result = await query(
    `UPDATE storage_tenancies
     SET weekly_rate = $1, previous_weekly_rate = $2, last_rate_change_date = $3,
         next_rate_review_date = COALESCE($4, next_rate_review_date),
         rate_review_sent_for = NULL, updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [b.new_rate, oldRate, effective, b.next_rate_review_date ?? null, req.params.id]
  );
  res.json({ data: result.rows[0] });
});

// Mark this cycle's invoice as sent → log it + advance next_bill_date by cadence
const invoiceSchema = z.object({
  amount: z.number().optional().nullable(),
  next_bill_date: z.string().optional().nullable(), // override (required for 'custom' cadence)
  notes: z.string().optional().nullable(),
});
router.post('/tenancies/:id/mark-invoiced', validate(invoiceSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof invoiceSchema>;
  const t = await query(`SELECT * FROM storage_tenancies WHERE id = $1`, [req.params.id]);
  if (t.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found' }); return; }
  const ten = t.rows[0];
  const dueDate = ten.next_bill_date || new Date().toISOString().slice(0, 10);
  const amount = b.amount != null ? b.amount
    : Number(ten.weekly_rate) * (ten.billing_cadence === 'monthly' ? 52 / 12 : ten.billing_cadence === 'quarterly' ? 13 : ten.billing_cadence === 'annual' ? 52 : 1);

  await query(
    `INSERT INTO storage_invoice_log (tenancy_id, due_date, amount, sent_by, notes)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.params.id, dueDate, Math.round(amount * 100) / 100, req.user!.id, b.notes ?? null]
  );

  // Advance next_bill_date by cadence (or to explicit override for custom)
  const cadenceInterval: Record<string, string> = { monthly: '1 month', quarterly: '3 months', annual: '1 year' };
  let nextSql: string;
  const params: unknown[] = [req.params.id];
  if (b.next_bill_date) {
    nextSql = `$2::date`;
    params.push(b.next_bill_date);
  } else if (cadenceInterval[ten.billing_cadence]) {
    nextSql = `(COALESCE(next_bill_date, CURRENT_DATE) + interval '${cadenceInterval[ten.billing_cadence]}')::date`;
  } else {
    nextSql = `next_bill_date`; // custom with no override: leave as-is, staff will set
  }
  const result = await query(
    `UPDATE storage_tenancies
     SET next_bill_date = ${nextSql}, billing_reminder_sent_for = NULL, billing_overdue_sent_for = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    params
  );
  res.json({ data: result.rows[0] });
});

// Move out
const moveOutSchema = z.object({ move_out_date: z.string().optional().nullable() });
router.post('/tenancies/:id/move-out', validate(moveOutSchema), async (req: AuthRequest, res: Response) => {
  const moveOut = (req.body as z.infer<typeof moveOutSchema>).move_out_date || new Date().toISOString().slice(0, 10);
  const result = await query(
    `UPDATE storage_tenancies SET status = 'ended', move_out_date = $1, updated_at = NOW()
     WHERE id = $2 AND status != 'ended' RETURNING room_id`,
    [moveOut, req.params.id]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found or already ended' }); return; }
  // Free the room if no other live tenancy remains
  const roomId = result.rows[0].room_id;
  const other = await query(`SELECT 1 FROM storage_tenancies WHERE room_id = $1 AND status IN ('active','notice','reserved')`, [roomId]);
  if (other.rows.length === 0) {
    await query(`UPDATE storage_rooms SET status = 'available', updated_at = NOW() WHERE id = $1 AND status = 'occupied'`, [roomId]);
  }
  await logAudit(req.user!.id, 'storage_tenancies', req.params.id as string, 'update', null, { status: 'ended', move_out_date: moveOut });
  res.json({ data: { ended: true } });
});

// Send T&Cs accept-link to the lead contact
router.post('/tenancies/:id/send-tcs', async (req: AuthRequest, res: Response) => {
  const t = await query(
    `SELECT t.id, t.tcs_agreement_id, r.name AS room_name, o.name AS org_name,
            p.email AS contact_email, p.first_name AS contact_first
     FROM storage_tenancies t
     JOIN storage_rooms r ON r.id = t.room_id
     LEFT JOIN organisations o ON o.id = t.organisation_id
     LEFT JOIN people p ON p.id = t.lead_contact_person_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (t.rows.length === 0) { res.status(404).json({ error: 'Tenancy not found' }); return; }
  const row = t.rows[0];
  if (row.tcs_agreement_id) { res.status(409).json({ error: 'T&Cs already accepted for this tenancy.' }); return; }
  const recipient = (req.body?.email as string) || row.contact_email;
  if (!recipient) { res.status(400).json({ error: 'No email on file for the lead contact — pass an email.' }); return; }
  const current = await query(`SELECT id FROM storage_tcs_versions WHERE is_current = true`);
  if (current.rows.length === 0) { res.status(400).json({ error: 'No current T&Cs version set. Create one first.' }); return; }

  const token = randomBytes(24).toString('base64url');
  await query(`UPDATE storage_tenancies SET tcs_token = $1, tcs_sent_at = NOW(), updated_at = NOW() WHERE id = $2`, [token, req.params.id]);
  const link = `${getFrontendUrl()}/storage-tcs/${token}`;
  await emailService.send('storage_tcs_request', {
    to: recipient,
    variables: {
      contactName: row.contact_first || 'there',
      roomName: row.room_name || '',
      orgSuffix: row.org_name ? ` (${row.org_name})` : '',
      link,
    },
  });
  res.json({ data: { sent: true, to: recipient } });
});

// ── Access list ───────────────────────────────────────────────────────────
const accessListSchema = z.object({
  person_id: z.string().uuid().optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  relationship: z.string().max(120).optional().nullable(),
  notes: z.string().optional().nullable(),
});
router.post('/tenancies/:id/access-list', validate(accessListSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof accessListSchema>;
  const result = await query(
    `INSERT INTO storage_access_list (tenancy_id, person_id, name, phone, relationship, notes, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, b.person_id ?? null, b.name ?? null, b.phone ?? null, b.relationship ?? null, b.notes ?? null, req.user!.id]
  );
  res.status(201).json({ data: result.rows[0] });
});
router.delete('/access-list/:id', async (req: AuthRequest, res: Response) => {
  await query(`DELETE FROM storage_access_list WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
});

// ════════════════════════ ACCESS EVENTS ════════════════════════

router.get('/access-events', async (req: AuthRequest, res: Response) => {
  const { status } = req.query;
  let sql = `
    SELECT e.*, r.name AS room_name, o.name AS organisation_name,
           p.first_name || ' ' || p.last_name AS attendee_person_name,
           rb.email AS requested_by_email
    FROM storage_access_events e
    LEFT JOIN storage_tenancies t ON t.id = e.tenancy_id
    LEFT JOIN storage_rooms r ON r.id = COALESCE(e.room_id, t.room_id)
    LEFT JOIN organisations o ON o.id = t.organisation_id
    LEFT JOIN people p ON p.id = e.attendee_person_id
    LEFT JOIN users rb ON rb.id = e.requested_by
    WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;
  if (status === 'open') sql += ` AND e.status IN ('requested','scheduled')`;
  else if (status) { sql += ` AND e.status = $${i++}`; params.push(status); }
  sql += ` ORDER BY (e.status IN ('done','cancelled')), e.requested_date NULLS LAST, e.created_at DESC`;
  const result = await query(sql, params);
  res.json({ data: result.rows });
});

const accessEventSchema = z.object({
  tenancy_id: z.string().uuid().optional().nullable(),
  room_id: z.string().uuid().optional().nullable(),
  type: z.enum(['visit', 'retrieve', 'courier_out', 'deposit']).default('visit'),
  description: z.string().optional().nullable(),
  attendee_person_id: z.string().uuid().optional().nullable(),
  attendee_name: z.string().max(200).optional().nullable(),
  method: z.enum(['in_person', 'courier']).default('in_person'),
  requested_date: z.string().optional().nullable(),
  notify_user_ids: z.array(z.string().uuid()).optional().default([]),
  delivery_method: z.enum(['notification', 'email', 'both']).default('both'),
  notes: z.string().optional().nullable(),
});
router.post('/access-events', validate(accessEventSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof accessEventSchema>;
  const result = await query(
    `INSERT INTO storage_access_events
       (tenancy_id, room_id, type, description, requested_by, attendee_person_id, attendee_name, method,
        requested_date, notify_user_ids, delivery_method, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [b.tenancy_id ?? null, b.room_id ?? null, b.type, b.description ?? null, req.user!.id,
     b.attendee_person_id ?? null, b.attendee_name ?? null, b.method, b.requested_date ?? null,
     b.notify_user_ids ?? [], b.delivery_method, b.notes ?? null]
  );

  // Access-list check (non-blocking warning)
  let notOnAccessList = false;
  if (b.tenancy_id && (b.attendee_person_id || b.attendee_name)) {
    const check = await query(
      `SELECT 1 FROM storage_access_list
       WHERE tenancy_id = $1 AND (
         ($2::uuid IS NOT NULL AND person_id = $2) OR
         ($3::text IS NOT NULL AND name ILIKE $3))`,
      [b.tenancy_id, b.attendee_person_id ?? null, b.attendee_name ?? null]
    );
    notOnAccessList = check.rows.length === 0;
  }

  // Fire the notification NOW only if it's for today or has no date. Future-dated
  // requests are picked up on the morning of by the daily scanner
  // (services/storage-reminders.ts). notifyAccessEvent stamps notified_at.
  const dueNow = !b.requested_date || new Date(b.requested_date) <= new Date(new Date().toISOString().slice(0, 10));
  if (dueNow) {
    try {
      const { notifyAccessEvent } = await import('../services/storage-reminders');
      await notifyAccessEvent(result.rows[0].id, notOnAccessList);
    } catch (err) { console.warn('[storage] access-event notify failed:', err); }
  }

  res.status(201).json({ data: result.rows[0], not_on_access_list: notOnAccessList });
});

const accessActionSchema = z.object({
  status: z.enum(['requested', 'scheduled', 'done', 'cancelled']),
  notes: z.string().optional().nullable(),
});
router.patch('/access-events/:id', validate(accessActionSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof accessActionSchema>;
  const done = b.status === 'done';
  const result = await query(
    `UPDATE storage_access_events
     SET status = $1, notes = COALESCE($2, notes),
         actioned_by = CASE WHEN $3 THEN $4 ELSE actioned_by END,
         actioned_at = CASE WHEN $3 THEN NOW() ELSE actioned_at END,
         updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [b.status, b.notes ?? null, done, req.user!.id, req.params.id]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'Access event not found' }); return; }
  res.json({ data: result.rows[0] });
});

// ════════════════════════ WAITING LIST ════════════════════════

router.get('/waiting-list', async (req: AuthRequest, res: Response) => {
  const { status } = req.query;
  let sql = `
    SELECT w.*, o.name AS organisation_name, p.first_name || ' ' || p.last_name AS person_name
    FROM storage_waiting_list w
    LEFT JOIN organisations o ON o.id = w.organisation_id
    LEFT JOIN people p ON p.id = w.person_id
    WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;
  if (status) { sql += ` AND w.status = $${i++}`; params.push(status); }
  sql += ` ORDER BY (w.status != 'waiting'), w.date_requested`;
  const result = await query(sql, params);
  res.json({ data: result.rows });
});

const waitingSchema = z.object({
  organisation_id: z.string().uuid().optional().nullable(),
  person_id: z.string().uuid().optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  contact_email: z.string().max(200).optional().nullable(),
  contact_phone: z.string().max(40).optional().nullable(),
  preferred_size: z.enum(['small', 'medium', 'large', 'xl', 'any']).optional().nullable(),
  notes: z.string().optional().nullable(),
});
router.post('/waiting-list', validate(waitingSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof waitingSchema>;
  const result = await query(
    `INSERT INTO storage_waiting_list
       (organisation_id, person_id, contact_name, contact_email, contact_phone, preferred_size, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.organisation_id ?? null, b.person_id ?? null, b.contact_name ?? null, b.contact_email ?? null,
     b.contact_phone ?? null, b.preferred_size ?? null, b.notes ?? null, req.user!.id]
  );
  res.status(201).json({ data: result.rows[0] });
});

const waitingUpdateSchema = z.object({
  status: z.enum(['waiting', 'offered', 'converted', 'declined', 'withdrawn']).optional(),
  preferred_size: z.enum(['small', 'medium', 'large', 'xl', 'any']).optional().nullable(),
  notes: z.string().optional().nullable(),
  mark_offered: z.boolean().optional(),
});
router.patch('/waiting-list/:id', validate(waitingUpdateSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof waitingUpdateSchema>;
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (b.status) { fields.push(`status = $${i++}`); params.push(b.status); }
  if (b.preferred_size !== undefined) { fields.push(`preferred_size = $${i++}`); params.push(b.preferred_size); }
  if (b.notes !== undefined) { fields.push(`notes = $${i++}`); params.push(b.notes); }
  if (b.mark_offered) { fields.push(`date_last_offered = CURRENT_DATE`); if (!b.status) fields.push(`status = 'offered'`); }
  if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(req.params.id);
  const result = await query(`UPDATE storage_waiting_list SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, params);
  if (result.rows.length === 0) { res.status(404).json({ error: 'Waiting list entry not found' }); return; }
  res.json({ data: result.rows[0] });
});

// ════════════════════════ T&Cs VERSIONS ════════════════════════

router.get('/tcs-versions', async (_req: AuthRequest, res: Response) => {
  const result = await query(`SELECT * FROM storage_tcs_versions ORDER BY created_at DESC`);
  res.json({ data: result.rows });
});

const tcsVersionSchema = z.object({
  version: z.string().min(1).max(40),
  body: z.string().min(1),
  effective_date: z.string().optional().nullable(),
  make_current: z.boolean().optional().default(true),
});
router.post('/tcs-versions', authorize(...ADMIN_MANAGER), validate(tcsVersionSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof tcsVersionSchema>;
  if (b.make_current) {
    await query(`UPDATE storage_tcs_versions SET is_current = false WHERE is_current = true`);
  }
  const result = await query(
    `INSERT INTO storage_tcs_versions (version, body, effective_date, is_current, created_by)
     VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5) RETURNING *`,
    [b.version, b.body, b.effective_date ?? null, !!b.make_current, req.user!.id]
  );
  res.status(201).json({ data: result.rows[0] });
});

// ════════════════════════ ADDRESS-BOOK READS ════════════════════════
// Storage tab on Org / Person detail. Returns current + past tenancies plus
// any waiting-list entries for the entity. Mirrors the Hire/Excess history
// reusable-section pattern.

const tenancyForEntitySelect = `
  SELECT t.id, t.status, t.move_in_date, t.move_out_date, t.weekly_rate,
         t.billing_mode, t.billing_cadence, t.next_bill_date, t.next_rate_review_date,
         t.access_type, t.tcs_agreement_id,
         r.name AS room_name, r.size_category, r.location_type,
         o.name AS organisation_name,
         p.first_name || ' ' || p.last_name AS lead_contact_name,
         a.accepted_at AS tcs_accepted_at
  FROM storage_tenancies t
  JOIN storage_rooms r ON r.id = t.room_id
  LEFT JOIN organisations o ON o.id = t.organisation_id
  LEFT JOIN people p ON p.id = t.lead_contact_person_id
  LEFT JOIN storage_tcs_agreements a ON a.id = t.tcs_agreement_id`;

router.get('/by-organisation/:id', async (req: AuthRequest, res: Response) => {
  const [tenancies, waiting] = await Promise.all([
    query(`${tenancyForEntitySelect} WHERE t.organisation_id = $1 ORDER BY (t.status = 'ended'), t.move_in_date DESC NULLS LAST`, [req.params.id]),
    query(`SELECT * FROM storage_waiting_list WHERE organisation_id = $1 AND status NOT IN ('converted','withdrawn') ORDER BY date_requested`, [req.params.id]),
  ]);
  res.json({ data: { tenancies: tenancies.rows, waiting: waiting.rows } });
});

router.get('/by-person/:id', async (req: AuthRequest, res: Response) => {
  const [tenancies, waiting] = await Promise.all([
    query(`${tenancyForEntitySelect} WHERE t.lead_contact_person_id = $1 ORDER BY (t.status = 'ended'), t.move_in_date DESC NULLS LAST`, [req.params.id]),
    query(`SELECT * FROM storage_waiting_list WHERE person_id = $1 AND status NOT IN ('converted','withdrawn') ORDER BY date_requested`, [req.params.id]),
  ]);
  res.json({ data: { tenancies: tenancies.rows, waiting: waiting.rows } });
});

// ════════════════════════ VACANCY MATCHING ════════════════════════
// Waiting-list entries that fit a freed room's size (exact, or 'any'/null).
// Drives the "room freed — who wants it?" prompt at move-out + the Find-tenant
// button on available room cards.
router.get('/waiting-list/matches', async (req: AuthRequest, res: Response) => {
  const size = req.query.size ? String(req.query.size) : null;
  const result = await query(
    `SELECT w.*, o.name AS organisation_name, p.first_name || ' ' || p.last_name AS person_name
     FROM storage_waiting_list w
     LEFT JOIN organisations o ON o.id = w.organisation_id
     LEFT JOIN people p ON p.id = w.person_id
     WHERE w.status = 'waiting'
       AND ($1::text IS NULL OR w.preferred_size IS NULL OR w.preferred_size IN ('any', $1))
     ORDER BY (w.preferred_size = $1) DESC, w.date_requested ASC`,
    [size]
  );
  res.json({ data: result.rows });
});

export default router;
