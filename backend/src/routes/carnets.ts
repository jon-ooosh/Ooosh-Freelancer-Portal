/**
 * ATA Carnet management — routes.
 *
 * Slice 1 (foundation): read-only endpoints to validate that the HH-derived
 * carnet records are being created. Full CRUD, the public client request form,
 * GMR management, send-timing and PDF generation land in later slices.
 *
 * See docs/CARNET-SPEC.md.
 */
import { Router, Response, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { getSystemSettings } from './system-settings';
import { getFromR2, uploadToR2 } from '../config/r2';
import { generateCarnetAuthorityPdf } from '../services/carnet-authority-pdf';
import { getFrontendUrl } from '../config/app-urls';
import { emailService } from '../services/email-service';
import { resolveClientEmailTarget } from '../services/money-emails';

const router = Router();

// The two-block authority wording shown to the client before they sign.
const CARNET_AUTHORITY_TERMS =
  'Ooosh Tours Ltd will use the information you provide to process an ATA Carnet on your behalf, ' +
  'appointing the lead person named above as our agent for dealing with and signing the Carnet, under ' +
  'the appropriate International Convention and guaranteed by the appropriate Chamber of Commerce.\n\n' +
  'By signing, the lead person accepts full responsibility for any charges, fees, taxes or similar that ' +
  'may become due by the use or misuse of the Carnet — under no circumstances will Ooosh! Tours Ltd be ' +
  'held responsible for any such costs. This responsibility lasts until the closure of the Carnet in the ' +
  'usual timeframe (usually eighteen (18) months from the end date of the Carnet).\n\n' +
  'As part of this service we will usually supply a list of equipment with serial numbers, weights etc. ' +
  'Although we act in good faith, this is provided without guarantee and we reserve the right to make ' +
  'changes to the agreed equipment, accepting no responsibility for any charges, losses or damages ' +
  'incurred as a result of any such changes.';

const TERMINAL_FORM_STATUSES = ['discharged', 'closed', 'cancelled'];

// ════════════════════════════════════════════════════════════════════════
// PUBLIC — client request form (token, no JWT). MUST be before the auth gate.
// ════════════════════════════════════════════════════════════════════════

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/carnets/form/:token — form context + validity.
router.get('/form/:token', publicLimiter, async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT c.id, c.status, c.lead_name, c.lead_email, c.lead_role, c.form_submitted_at,
              j.hh_job_number, j.job_name, j.client_name,
              COALESCE(c.carnet_start_date, j.out_date, j.job_date) AS default_start_date
       FROM job_carnets c JOIN jobs j ON j.id = c.job_id
       WHERE c.form_token = $1`,
      [req.params.token]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'This link is not valid.' });
    const c = result.rows[0];
    const valid = !TERMINAL_FORM_STATUSES.includes(c.status);
    res.json({
      data: {
        valid,
        already_submitted: !!c.form_submitted_at,
        hh_job_number: c.hh_job_number,
        job_name: c.job_name,
        client_name: c.client_name,
        lead_name: c.lead_name,
        lead_email: c.lead_email,
        lead_role: c.lead_role,
        default_start_date: c.default_start_date ? new Date(c.default_start_date).toISOString().slice(0, 10) : null,
        authority_terms: CARNET_AUTHORITY_TERMS,
      },
    });
  } catch (err) {
    console.error('[carnets] form context error:', err);
    res.status(500).json({ error: 'Could not load the form.' });
  }
});

// POST /api/carnets/form/:token/submit — the combined info + authority + signature.
router.post('/form/:token/submit', publicLimiter, async (req: Request, res: Response) => {
  try {
    const cur = await query(
      `SELECT c.*, j.hh_job_number, j.client_name FROM job_carnets c JOIN jobs j ON j.id = c.job_id WHERE c.form_token = $1`,
      [req.params.token]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'This link is not valid.' });
    const carnet = cur.rows[0];
    if (carnet.form_submitted_at) return res.status(409).json({ error: 'This form has already been submitted.' });
    if (TERMINAL_FORM_STATUSES.includes(carnet.status)) return res.status(410).json({ error: 'This carnet is closed.' });

    const b = req.body || {};
    const length = [2, 6, 12].includes(Number(b.carnet_length_months)) ? Number(b.carnet_length_months) : null;
    const leadName = String(b.lead_name || '').trim();
    const leadEmail = String(b.lead_email || '').trim();
    const leadRole = String(b.lead_role || '').trim();
    const euCountries = Array.isArray(b.eu_countries) ? b.eu_countries : [];
    const nonEuCountries = Array.isArray(b.non_eu_countries) ? b.non_eu_countries : [];
    if (!length) return res.status(400).json({ error: 'Please choose a carnet length.' });
    if (!b.carnet_start_date) return res.status(400).json({ error: 'Please provide a required start date.' });
    if (!leadName) return res.status(400).json({ error: 'Lead name is required.' });
    if (!leadEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(leadEmail)) return res.status(400).json({ error: 'A valid lead email is required.' });
    if (!leadRole) return res.status(400).json({ error: 'Lead role is required.' });
    if (euCountries.length + nonEuCountries.length === 0) return res.status(400).json({ error: 'Please select at least one country.' });
    if (b.gmr_needed !== true && b.gmr_needed !== false) return res.status(400).json({ error: 'Please answer the GMR question.' });
    if (!b.accepted) return res.status(400).json({ error: 'Please accept the terms.' });
    if (!b.signature || !String(b.signature).startsWith('data:image')) return res.status(400).json({ error: 'Please provide a signature.' });

    const expiry = addMonthsISO(String(b.carnet_start_date), length);
    const liability = addMonthsISO(expiry, 18);

    // Client signature → R2 (kept as a buffer for the PDF).
    let clientSigBuf: Buffer | null = null;
    try {
      clientSigBuf = Buffer.from(String(b.signature).split(',')[1] || '', 'base64');
      await uploadToR2(`carnet-authority/${carnet.id}/client-signature-${Date.now()}.png`, clientSigBuf, 'image/png');
    } catch { clientSigBuf = null; }

    const additionalNames = Array.isArray(b.additional_names)
      ? b.additional_names.filter((n: { first?: string; last?: string }) => (n?.first || n?.last))
      : [];

    await query(
      `UPDATE job_carnets SET
         carnet_length_months = $1, carnet_start_date = $2, carnet_expiry_date = $3, liability_until = $4,
         eu_countries = $5, non_eu_countries = $6, lead_name = $7, lead_email = $8, lead_role = $9,
         additional_names = $10, form_submitted_at = NOW(), status = 'info_received', updated_at = NOW()
       WHERE id = $11`,
      [
        length, b.carnet_start_date, expiry, liability,
        euCountries, nonEuCountries,
        leadName, leadEmail || null, leadRole || null,
        JSON.stringify(additionalNames), carnet.id,
      ]
    );

    // Seed GMRs from the crossings (only if none exist yet).
    const existingGmrs = await query(`SELECT COUNT(*) AS n FROM carnet_gmrs WHERE carnet_id = $1`, [carnet.id]);
    if (parseInt(existingGmrs.rows[0].n, 10) === 0 && b.gmr_needed && Array.isArray(b.crossings)) {
      let order = 0;
      for (const x of b.crossings) {
        if (!x?.crossing_date && !x?.crossing_location) continue;
        const direction = ['into_eu', 'out_of_eu'].includes(x.direction) ? x.direction : null;
        await query(
          `INSERT INTO carnet_gmrs (carnet_id, crossing_date, crossing_location, direction, status, sort_order)
           VALUES ($1, $2, $3, $4, 'needed', $5)`,
          [carnet.id, x.crossing_date || null, x.crossing_location || null, direction, order++]
        );
      }
    }

    // Generate the final two-signature Letter of Authorisation.
    let pdfKey: string | null = null;
    let pdfBuffer: Buffer | null = null;
    try {
      const settings = await getSystemSettings([
        'carnet_ooosh_signatory_name', 'carnet_ooosh_signatory_role',
        'carnet_company_address', 'carnet_ooosh_signature_url',
      ]);
      const oooshSig = settings.carnet_ooosh_signature_url ? await r2ToBuffer(settings.carnet_ooosh_signature_url) : null;
      const pdfBytes = await generateCarnetAuthorityPdf({
        date: new Date(),
        companyAddress: settings.carnet_company_address || 'Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL, UK',
        signatoryName: settings.carnet_ooosh_signatory_name || 'Jonathan Wood',
        signatoryRole: settings.carnet_ooosh_signatory_role || 'Company Director',
        signatureBuffer: oooshSig,
        leadName, leadRole,
        clientSignatureBuffer: clientSigBuf,
      });
      pdfBuffer = Buffer.from(pdfBytes);
      pdfKey = `carnet-authority/${carnet.id}/letter-of-authorisation-${Date.now()}.pdf`;
      await uploadToR2(pdfKey, pdfBuffer, 'application/pdf');
      await query(`UPDATE job_carnets SET signed_authority_url = $1 WHERE id = $2`, [pdfKey, carnet.id]);
      const jf = await query(`SELECT files FROM jobs WHERE id = $1`, [carnet.job_id]);
      const files = Array.isArray(jf.rows[0]?.files) ? jf.rows[0].files : [];
      files.push({ url: pdfKey, name: 'Letter of Authorisation (carnet).pdf', label: 'Carnet authority', uploaded_at: new Date().toISOString(), uploaded_by: SYSTEM_USER_ID });
      await query(`UPDATE jobs SET files = $1 WHERE id = $2`, [JSON.stringify(files), carnet.job_id]);
    } catch (err) {
      console.error('[carnets] authority PDF generation on submit failed:', err);
    }

    await syncCarnetRequirementStatus(carnet.job_id, 'info_received');
    await logCarnetInteraction(carnet.job_id, `📄 Carnet request form submitted by ${leadName} — authority signed`, undefined);

    // Email: signed copy to the client + notification to the office.
    const jobNumber = String(carnet.hh_job_number || '');
    const attachments = pdfBuffer ? [{ filename: 'Letter of Authorisation.pdf', content: pdfBuffer, contentType: 'application/pdf' }] : undefined;
    if (leadEmail) {
      emailService.send('carnet_authority_copy', {
        to: leadEmail,
        variables: { leadName, jobNumber },
        attachments,
      }).catch((e) => console.error('[carnets] client copy email failed:', e));
    }
    emailService.send('carnet_authority_received_internal', {
      to: 'info@oooshtours.co.uk',
      variables: { leadName, jobNumber, clientName: carnet.client_name || '' },
      attachments,
    }).catch((e) => console.error('[carnets] internal notify failed:', e));

    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[carnets] form submit error:', err);
    res.status(500).json({ error: 'Could not submit the form. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// STAFF — everything below requires a JWT.
// ════════════════════════════════════════════════════════════════════════
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// GET /api/carnets — Operations overview list (both modes).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { mode, status, q } = req.query as { mode?: string; status?: string; q?: string };
    const conditions: string[] = ['j.is_deleted = false'];
    const params: unknown[] = [];

    if (mode) { params.push(mode); conditions.push(`c.mode = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(j.job_name ILIKE $${params.length} OR j.client_name ILIKE $${params.length} OR j.hh_job_number::text ILIKE $${params.length})`);
    }

    const result = await query(
      `SELECT c.id, c.job_id, c.mode, c.status, c.format, c.custody_location,
              c.carnet_start_date, c.carnet_expiry_date, c.chase_date,
              c.form_sent_at, c.form_submitted_at, c.created_at, c.updated_at,
              j.hh_job_number, j.job_name, j.client_name, j.job_date,
              -- "Needed by" = when the carnet must be in hand (form start date if
              -- given, else the tour's outgoing date). "Return by" = 7 days after
              -- the carnet's validity ends (start + length), we_supply only — the
              -- discharge deadline, NOT the job end date.
              COALESCE(c.carnet_start_date, j.out_date, j.job_date) AS needed_by,
              CASE WHEN c.mode = 'we_supply' AND c.carnet_expiry_date IS NOT NULL
                   THEN c.carnet_expiry_date + 7 END AS return_by,
              (SELECT COUNT(*) FROM carnet_gmrs g WHERE g.carnet_id = c.id) AS gmr_count,
              (SELECT COUNT(*) FROM carnet_gmrs g WHERE g.carnet_id = c.id AND g.status = 'sent') AS gmr_sent_count
       FROM job_carnets c
       JOIN jobs j ON j.id = c.job_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY j.job_date ASC NULLS LAST, c.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[carnets] list error:', err);
    res.status(500).json({ error: 'Failed to load carnets' });
  }
});

// GET /api/carnets/by-job/:jobId — the carnet (+ GMRs) for a single job.
router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM job_carnets WHERE job_id = $1 AND status <> 'cancelled' LIMIT 1`,
      [req.params.jobId]
    );
    if (result.rows.length === 0) return res.json({ data: null });
    const carnet = result.rows[0];
    const gmrs = await query(
      `SELECT * FROM carnet_gmrs WHERE carnet_id = $1 ORDER BY sort_order, crossing_date NULLS LAST, created_at`,
      [carnet.id]
    );
    res.json({ data: { ...carnet, gmrs: gmrs.rows } });
  } catch (err) {
    console.error('[carnets] by-job error:', err);
    res.status(500).json({ error: 'Failed to load carnet' });
  }
});

// GET /api/carnets/:id — single carnet + GMRs (+ job header fields).
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.*, j.hh_job_number, j.job_name, j.client_name, j.job_date,
              COALESCE(c.carnet_start_date, j.out_date, j.job_date) AS needed_by,
              CASE WHEN c.mode = 'we_supply' AND c.carnet_expiry_date IS NOT NULL
                   THEN c.carnet_expiry_date + 7 END AS return_by
       FROM job_carnets c JOIN jobs j ON j.id = c.job_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const carnet = result.rows[0];
    const gmrs = await query(
      `SELECT * FROM carnet_gmrs WHERE carnet_id = $1 ORDER BY sort_order, crossing_date NULLS LAST, created_at`,
      [carnet.id]
    );
    res.json({ data: { ...carnet, gmrs: gmrs.rows } });
  } catch (err) {
    console.error('[carnets] get error:', err);
    res.status(500).json({ error: 'Failed to load carnet' });
  }
});

// ── Write endpoints (slice 3 — staff cockpit) ───────────────────────────────

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const WE_SUPPLY_STATUSES = [
  'detected', 'form_sent', 'info_received', 'applied', 'received',
  'with_client', 'returned', 'discharged', 'closed', 'cancelled',
];
const CLIENT_ARRANGES_STATUSES = ['requested', 'spreadsheet_sent', 'done', 'cancelled'];
const CUSTODY_VALUES = ['ooosh', 'client', 'issuer'];

function addMonthsISO(dateStr: string, months: number): string {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m - 1) + months, d)).toISOString().slice(0, 10);
}

async function logCarnetInteraction(jobId: string, content: string, userId?: string) {
  try {
    await query(
      `INSERT INTO interactions (job_id, type, content, created_by) VALUES ($1, 'note', $2, $3)`,
      [jobId, content, userId || SYSTEM_USER_ID]
    );
  } catch (err) {
    console.error('[carnets] interaction log failed:', err);
  }
}

// Map the carnet lifecycle status onto the thin `carnet` job_requirement so the
// Job-View tracker (and the pre-hire prep counter) reflect real progress.
// Management lives in Operations; the requirement card is a read-only reflection.
const CARNET_REQ_STATUS: Record<string, 'not_started' | 'in_progress' | 'done'> = {
  // we_supply
  detected: 'not_started', form_sent: 'not_started',
  info_received: 'in_progress', applied: 'in_progress', received: 'in_progress',
  with_client: 'in_progress', returned: 'in_progress', discharged: 'in_progress',
  closed: 'done',
  // client_arranges
  requested: 'not_started', spreadsheet_sent: 'in_progress', done: 'done',
  // a cancelled carnet is no longer outstanding
  cancelled: 'done',
};

async function syncCarnetRequirementStatus(jobId: string, carnetStatus: string) {
  const reqStatus = CARNET_REQ_STATUS[carnetStatus];
  if (!reqStatus) return;
  try {
    await query(
      `UPDATE job_requirements SET status = $1, updated_at = NOW()
       WHERE job_id = $2 AND requirement_type = 'carnet' AND phase = 'pre_hire'`,
      [reqStatus, jobId]
    );
  } catch (err) {
    console.error('[carnets] requirement status sync failed:', err);
  }
}

// POST /api/carnets — manual create (primarily client_arranges; also rare manual we_supply).
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.job_id) return res.status(400).json({ error: 'job_id is required' });
    const mode = b.mode === 'we_supply' ? 'we_supply' : 'client_arranges';
    const initStatus = mode === 'we_supply' ? 'detected' : 'requested';

    const existing = await query(
      `SELECT id FROM job_carnets WHERE job_id = $1 AND status <> 'cancelled' LIMIT 1`,
      [b.job_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A carnet already exists for this job' });
    }

    const result = await query(
      `INSERT INTO job_carnets
         (job_id, mode, status, format, notes, chase_date, lead_name, lead_email, lead_role,
          spreadsheet_requested_at, created_by)
       VALUES ($1, $2, $3, COALESCE($4, 'paper'), $5, $6, $7, $8, $9,
          CASE WHEN $2 = 'client_arranges' THEN NOW() ELSE NULL END, $10)
       RETURNING *`,
      [
        b.job_id, mode, initStatus, b.format || null, b.notes || null, b.chase_date || null,
        b.lead_name || null, b.lead_email || null, b.lead_role || null,
        req.user?.id || SYSTEM_USER_ID,
      ]
    );
    await logCarnetInteraction(
      b.job_id,
      `📄 Carnet record created (${mode === 'we_supply' ? 'we supply' : 'client arranges'})`,
      req.user?.id
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] create error:', err);
    res.status(500).json({ error: 'Failed to create carnet' });
  }
});

// PATCH /api/carnets/:id — update fields. Status changes auto-set timestamps + custody
// and log a job-timeline interaction.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const cur = await query(`SELECT * FROM job_carnets WHERE id = $1`, [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const carnet = cur.rows[0];
    const b = req.body || {};

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    const scalarFields = [
      'format', 'notes', 'application_ref', 'lead_name', 'lead_email', 'lead_role',
      'carnet_length_months', 'carnet_start_date', 'chase_date',
    ];
    for (const f of scalarFields) {
      if (f in b) set(f, b[f] === '' ? null : b[f]);
    }
    if ('custody_location' in b) {
      if (b.custody_location && !CUSTODY_VALUES.includes(b.custody_location)) {
        return res.status(400).json({ error: 'Invalid custody_location' });
      }
      set('custody_location', b.custody_location || null);
    }
    if ('eu_countries' in b) set('eu_countries', b.eu_countries || []);
    if ('non_eu_countries' in b) set('non_eu_countries', b.non_eu_countries || []);
    if ('additional_names' in b) set('additional_names', JSON.stringify(b.additional_names || []));

    // Derived expiry + liability when both length and start are known.
    const length = 'carnet_length_months' in b ? b.carnet_length_months : carnet.carnet_length_months;
    const start = 'carnet_start_date' in b ? b.carnet_start_date : carnet.carnet_start_date;
    if (length && start) {
      const expiry = addMonthsISO(String(start), Number(length));
      set('carnet_expiry_date', expiry);
      set('liability_until', addMonthsISO(expiry, 18));
    }

    let statusChanged = false;
    if ('status' in b && b.status !== carnet.status) {
      const valid = carnet.mode === 'we_supply' ? WE_SUPPLY_STATUSES : CLIENT_ARRANGES_STATUSES;
      if (!valid.includes(b.status)) {
        return res.status(400).json({ error: `Invalid status '${b.status}' for mode ${carnet.mode}` });
      }
      set('status', b.status);
      statusChanged = true;
      const stampMap: Record<string, string> = {
        applied: 'applied_at', received: 'received_at', with_client: 'issued_to_client_at',
        returned: 'returned_at', discharged: 'discharged_at', closed: 'closed_at',
        spreadsheet_sent: 'spreadsheet_sent_at',
      };
      if (stampMap[b.status]) set(stampMap[b.status], new Date().toISOString());
      // Auto-set custody from status unless the caller set it explicitly in this PATCH.
      if (!('custody_location' in b)) {
        const custodyMap: Record<string, string> = {
          received: 'ooosh', with_client: 'client', returned: 'ooosh', discharged: 'issuer',
        };
        if (custodyMap[b.status]) set('custody_location', custodyMap[b.status]);
      }
    }

    if (sets.length === 0) return res.json({ data: carnet });

    params.push(req.params.id);
    const result = await query(
      `UPDATE job_carnets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (statusChanged) {
      await logCarnetInteraction(carnet.job_id, `📄 Carnet status → ${b.status}`, req.user?.id);
      await syncCarnetRequirementStatus(carnet.job_id, b.status);
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] update error:', err);
    res.status(500).json({ error: 'Failed to update carnet' });
  }
});

// POST /api/carnets/:id/cancel — soft cancel.
router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE job_carnets SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status <> 'cancelled' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Carnet not found or already cancelled' });
    await logCarnetInteraction(result.rows[0].job_id, '📄 Carnet cancelled', req.user?.id);
    await syncCarnetRequirementStatus(result.rows[0].job_id, 'cancelled');
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel carnet' });
  }
});

// ── GMR management ──

// POST /api/carnets/:id/gmrs — add a GMR.
router.post('/:id/gmrs', async (req: AuthRequest, res: Response) => {
  try {
    const carnet = await query(`SELECT id FROM job_carnets WHERE id = $1`, [req.params.id]);
    if (carnet.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const b = req.body || {};
    const status = ['needed', 'made', 'sent'].includes(b.status) ? b.status : 'needed';
    const direction = ['into_eu', 'out_of_eu'].includes(b.direction) ? b.direction : null;
    const result = await query(
      `INSERT INTO carnet_gmrs
         (carnet_id, crossing_date, crossing_location, direction, status, gmr_reference, notes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
         COALESCE((SELECT MAX(sort_order) + 1 FROM carnet_gmrs WHERE carnet_id = $1), 0))
       RETURNING *`,
      [
        req.params.id, b.crossing_date || null, b.crossing_location || null, direction,
        status, b.gmr_reference || null, b.notes || null,
      ]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] gmr create error:', err);
    res.status(500).json({ error: 'Failed to add GMR' });
  }
});

// PATCH /api/carnets/:id/gmrs/:gmrId — update a GMR.
router.patch('/:id/gmrs/:gmrId', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    for (const f of ['crossing_date', 'crossing_location', 'gmr_reference', 'qr_image_url', 'notes']) {
      if (f in b) set(f, b[f] === '' ? null : b[f]);
    }
    if ('direction' in b) set('direction', ['into_eu', 'out_of_eu'].includes(b.direction) ? b.direction : null);
    if ('status' in b) {
      if (!['needed', 'made', 'sent'].includes(b.status)) return res.status(400).json({ error: 'Invalid GMR status' });
      set('status', b.status);
      if (b.status === 'sent') set('sent_to_client_at', new Date().toISOString());
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.gmrId, req.params.id);
    const result = await query(
      `UPDATE carnet_gmrs SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND carnet_id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'GMR not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] gmr update error:', err);
    res.status(500).json({ error: 'Failed to update GMR' });
  }
});

// POST /api/carnets/:id/gmrs/:gmrId/mark-sent — flip to sent.
router.post('/:id/gmrs/:gmrId/mark-sent', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE carnet_gmrs SET status = 'sent', sent_to_client_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND carnet_id = $2 RETURNING *`,
      [req.params.gmrId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'GMR not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[carnets] gmr mark-sent error:', err);
    res.status(500).json({ error: 'Failed to mark GMR sent' });
  }
});

// POST /api/carnets/:id/gmrs/:gmrId/email — forward the GMR number + QR to the
// client, then mark it sent. Falls back to the job's client contact if the
// carnet has no lead email.
router.post('/:id/gmrs/:gmrId/email', async (req: AuthRequest, res: Response) => {
  try {
    const g = await query(
      `SELECT g.*, c.lead_email, c.job_id, j.hh_job_number, j.job_name, j.client_name
       FROM carnet_gmrs g
       JOIN job_carnets c ON c.id = g.carnet_id
       JOIN jobs j ON j.id = c.job_id
       WHERE g.id = $1 AND g.carnet_id = $2`,
      [req.params.gmrId, req.params.id]
    );
    if (g.rows.length === 0) return res.status(404).json({ error: 'GMR not found' });
    const gmr = g.rows[0];
    if (!gmr.gmr_reference) return res.status(400).json({ error: 'Add the GMR number before sending.' });

    let to = (gmr.lead_email || '').trim();
    if (!to) {
      const target = await resolveClientEmailTarget(gmr.job_id);
      to = target?.primaryEmail || '';
    }
    if (!to) return res.status(422).json({ error: 'No client email on file — set the lead email on the carnet first.' });

    const attachments = [];
    if (gmr.qr_image_url) {
      const qr = await r2ToBuffer(gmr.qr_image_url);
      if (qr) attachments.push({ filename: `GMR-${gmr.gmr_reference}.png`, content: qr, contentType: 'image/png' });
    }
    const crossing = [gmr.crossing_location, gmr.crossing_date ? new Date(gmr.crossing_date).toLocaleDateString('en-GB') : null].filter(Boolean).join(' · ');
    await emailService.send('carnet_gmr_details', {
      to,
      variables: {
        clientName: gmr.client_name || '', jobName: gmr.job_name || '', jobNumber: String(gmr.hh_job_number || ''),
        gmrNumber: gmr.gmr_reference,
        crossingSuffix: gmr.crossing_location ? ` — ${gmr.crossing_location}` : '',
        crossingLine: crossing ? ` <span style="color:#64748b;">(${crossing})</span>` : '',
        qrNote: attachments.length ? '' : ' separately',
      },
      attachments: attachments.length ? attachments : undefined,
    });

    await query(`UPDATE carnet_gmrs SET status = 'sent', sent_to_client_at = NOW(), updated_at = NOW() WHERE id = $1`, [gmr.id]);
    await logCarnetInteraction(gmr.job_id, `📄 GMR ${gmr.gmr_reference} sent to ${to}`, req.user?.id);
    res.json({ data: { sent: true, recipient: to } });
  } catch (err) {
    console.error('[carnets] gmr email error:', err);
    res.status(500).json({ error: 'Failed to send GMR' });
  }
});

// DELETE /api/carnets/:id/gmrs/:gmrId
router.delete('/:id/gmrs/:gmrId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM carnet_gmrs WHERE id = $1 AND carnet_id = $2 RETURNING id`,
      [req.params.gmrId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'GMR not found' });
    res.json({ data: { id: req.params.gmrId } });
  } catch (err) {
    console.error('[carnets] gmr delete error:', err);
    res.status(500).json({ error: 'Failed to delete GMR' });
  }
});

// ── Document attachments (files JSONB) ──

// POST /api/carnets/:id/files — append an already-uploaded R2 object.
router.post('/:id/files', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.r2_key || !b.name) return res.status(400).json({ error: 'r2_key and name are required' });
    const cur = await query(`SELECT files FROM job_carnets WHERE id = $1`, [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const files = Array.isArray(cur.rows[0].files) ? cur.rows[0].files : [];
    files.push({
      url: b.r2_key, name: b.name, label: b.label || null, comment: b.comment || null,
      uploaded_at: new Date().toISOString(), uploaded_by: req.user?.id || SYSTEM_USER_ID,
    });
    const result = await query(
      `UPDATE job_carnets SET files = $1, updated_at = NOW() WHERE id = $2 RETURNING files`,
      [JSON.stringify(files), req.params.id]
    );
    res.json({ data: result.rows[0].files });
  } catch (err) {
    console.error('[carnets] file add error:', err);
    res.status(500).json({ error: 'Failed to attach file' });
  }
});

// DELETE /api/carnets/:id/files/:idx — remove by index.
router.delete('/:id/files/:idx', async (req: AuthRequest, res: Response) => {
  try {
    const idx = parseInt(String(req.params.idx), 10);
    const cur = await query(`SELECT files FROM job_carnets WHERE id = $1`, [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const files = Array.isArray(cur.rows[0].files) ? cur.rows[0].files : [];
    if (Number.isNaN(idx) || idx < 0 || idx >= files.length) return res.status(400).json({ error: 'Invalid file index' });
    files.splice(idx, 1);
    const result = await query(
      `UPDATE job_carnets SET files = $1, updated_at = NOW() WHERE id = $2 RETURNING files`,
      [JSON.stringify(files), req.params.id]
    );
    res.json({ data: result.rows[0].files });
  } catch (err) {
    console.error('[carnets] file delete error:', err);
    res.status(500).json({ error: 'Failed to remove file' });
  }
});

// Read an R2 object into a Buffer (signature image).
async function r2ToBuffer(key: string): Promise<Buffer | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as NodeJS.ReadableStream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// POST /api/carnets/:id/generate-authority — build the Letter of Authorisation
// PDF from the carnet's details + the Ooosh signatory settings, store in R2,
// set signed_authority_url, and surface it on the job's Files tab.
router.post('/:id/generate-authority', async (req: AuthRequest, res: Response) => {
  try {
    const cur = await query(
      `SELECT c.*, j.hh_job_number FROM job_carnets c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const carnet = cur.rows[0];

    const settings = await getSystemSettings([
      'carnet_ooosh_signatory_name', 'carnet_ooosh_signatory_role',
      'carnet_company_address', 'carnet_ooosh_signature_url',
    ]);

    const sigKey = settings.carnet_ooosh_signature_url;
    const signatureBuffer = sigKey ? await r2ToBuffer(sigKey) : null;

    const pdfBytes = await generateCarnetAuthorityPdf({
      date: new Date(),
      companyAddress: settings.carnet_company_address || 'Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL, UK',
      signatoryName: settings.carnet_ooosh_signatory_name || 'Jonathan Wood',
      signatoryRole: settings.carnet_ooosh_signatory_role || 'Company Director',
      signatureBuffer,
      leadName: carnet.lead_name || '',
      leadRole: carnet.lead_role || '',
      clientSignatureBuffer: null, // captured by the public form (next slice)
    });

    const key = `carnet-authority/${carnet.id}/letter-of-authorisation-${Date.now()}.pdf`;
    await uploadToR2(key, Buffer.from(pdfBytes), 'application/pdf');

    // Set on the carnet + surface on the job Files tab.
    await query(`UPDATE job_carnets SET signed_authority_url = $1, updated_at = NOW() WHERE id = $2`, [key, carnet.id]);
    const jobFiles = await query(`SELECT files FROM jobs WHERE id = $1`, [carnet.job_id]);
    const files = Array.isArray(jobFiles.rows[0]?.files) ? jobFiles.rows[0].files : [];
    files.push({
      url: key, name: 'Letter of Authorisation (carnet).pdf', label: 'Carnet authority',
      uploaded_at: new Date().toISOString(), uploaded_by: req.user?.id || SYSTEM_USER_ID,
    });
    await query(`UPDATE jobs SET files = $1 WHERE id = $2`, [JSON.stringify(files), carnet.job_id]);

    await logCarnetInteraction(carnet.job_id, '📄 Carnet Letter of Authorisation generated', req.user?.id);

    res.json({ data: { signed_authority_url: key, signature_present: !!signatureBuffer } });
  } catch (err) {
    console.error('[carnets] generate-authority error:', err);
    res.status(500).json({ error: 'Failed to generate Letter of Authorisation' });
  }
});

// POST /api/carnets/:id/send-form — mint (or reuse) the client form token and
// return the link; optionally email it to the client. we_supply only.
router.post('/:id/send-form', async (req: AuthRequest, res: Response) => {
  try {
    const cur = await query(
      `SELECT c.*, j.hh_job_number, j.job_name FROM job_carnets c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Carnet not found' });
    const carnet = cur.rows[0];
    if (carnet.mode !== 'we_supply') return res.status(400).json({ error: 'Request form only applies to we-supply carnets' });

    // Reuse an existing token (so a re-send keeps the same link); else mint one.
    let token: string = carnet.form_token;
    if (!token) {
      token = randomBytes(24).toString('base64url');
    }
    await query(
      `UPDATE job_carnets SET form_token = $1, form_sent_at = NOW(),
         status = CASE WHEN status = 'detected' THEN 'form_sent' ELSE status END,
         updated_at = NOW()
       WHERE id = $2`,
      [token, carnet.id]
    );
    if (carnet.status === 'detected') await syncCarnetRequirementStatus(carnet.job_id, 'form_sent');

    const url = `${getFrontendUrl()}/carnet-form/${token}`;
    let sent = false;
    let recipient: string | null = null;

    if (req.body?.send_email) {
      try {
        const target = await resolveClientEmailTarget(carnet.job_id, 'carnet_request');
        if (target?.primaryEmail) {
          recipient = target.primaryEmail;
          await emailService.send('carnet_request', {
            to: target.primaryEmail,
            cc: target.ccEmails,
            variables: { clientName: carnet.client_name || '', jobName: carnet.job_name || '', jobNumber: String(carnet.hh_job_number || ''), formUrl: url },
          });
          sent = true;
        }
      } catch (e) {
        console.error('[carnets] send-form email failed:', e);
      }
    }

    await logCarnetInteraction(carnet.job_id, sent ? `📄 Carnet request form sent to ${recipient}` : '📄 Carnet request form link generated', req.user?.id);
    res.json({ data: { url, token, sent, recipient } });
  } catch (err) {
    console.error('[carnets] send-form error:', err);
    res.status(500).json({ error: 'Failed to generate the request form link' });
  }
});

export default router;
