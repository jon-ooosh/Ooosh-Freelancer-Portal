/**
 * Excess Routes — Insurance excess financial lifecycle tracking.
 *
 * Manages the excess amount required for self-drive hires:
 * pending → taken → (claimed | reimbursed | rolled_over)
 *
 * Also handles excess rules (points-based tiers, referral triggers)
 * and the client excess ledger (running balance per client).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { sendExcessEmail } from '../services/money-emails';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { emailService } from '../services/email-service';

const router = Router();
router.use(authenticate);

// ── Schemas ──

const updateExcessSchema = z.object({
  excess_amount_required: z.number().min(0).nullable().optional(),
  excess_amount_taken: z.number().min(0).optional(),
  excess_calculation_basis: z.string().nullable().optional(),
  excess_status: z.enum(['not_required', 'pending', 'taken', 'partial', 'waived', 'claimed', 'reimbursed', 'rolled_over']).optional(),
  payment_method: z.string().max(30).nullable().optional(),
  payment_reference: z.string().max(200).nullable().optional(),
  xero_contact_id: z.string().max(100).nullable().optional(),
  xero_contact_name: z.string().max(200).nullable().optional(),
  client_name: z.string().max(200).nullable().optional(),
});

const paymentSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank', 'rolled_over']),
  reference: z.string().max(200).nullable().optional(),
});

const claimSchema = z.object({
  amount: z.number().min(0),
  notes: z.string().nullable().optional(),
});

const reimburseSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank']),
});

const waiveSchema = z.object({
  reason: z.string().min(1),
});

const overrideSchema = z.object({
  reason: z.enum([
    'client_on_credit',
    'pre_auth_to_follow',
    'ooosh_staff_vehicle',
    'balance_on_account',
    'other',
  ]),
  notes: z.string().max(500).optional(),
});

const moveExcessSchema = z.object({
  xero_contact_id: z.string().max(100).optional().default(''),
  xero_contact_name: z.string().max(200),
  client_name: z.string().max(200).optional(),
  person_id: z.string().uuid().nullable().optional().or(z.literal('')),
  reason: z.string().max(500).optional(),
});

// ── GET /api/excess — List excess records ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, hirehop_job_id, xero_contact_id, person_id, job_id,
      page = '1', limit = '50',
    } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const pageLimit = parseInt(limit as string);

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      where += ` AND je.excess_status = $${params.length}`;
    }
    if (hirehop_job_id) {
      params.push(parseInt(hirehop_job_id as string));
      where += ` AND je.hirehop_job_id = $${params.length}`;
    }
    if (xero_contact_id) {
      params.push(xero_contact_id);
      where += ` AND je.xero_contact_id = $${params.length}`;
    }
    if (person_id) {
      params.push(person_id);
      where += ` AND je.person_id = $${params.length}`;
    }
    if (job_id) {
      params.push(job_id);
      where += ` AND je.job_id = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM job_excess je ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, pageLimit, offset];
    const result = await query(
      `SELECT je.*,
        vha.vehicle_id,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        vha.assignment_type,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      ${where}
      ORDER BY je.created_at DESC
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
    });
  } catch (error) {
    console.error('[excess] List error:', error);
    res.status(500).json({ error: 'Failed to load excess records' });
  }
});

// NOTE: Excess calculation engine (rules CRUD + calculate endpoint) REMOVED.
// All excess calculations are done within the hire form app (Netlify).
// The OP only stores/tracks the excess amount passed through from the hire form.
// The excess_rules table still exists in the DB but is not used by any endpoint.

// ── GET /api/excess/ledger — Client excess ledger ──

router.get('/ledger', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM client_excess_ledger ORDER BY balance_held DESC`
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[excess] Ledger error:', error);
    res.status(500).json({ error: 'Failed to load excess ledger' });
  }
});

// ── GET /api/excess/ledger/:xeroContactId — Single client ledger ──

router.get('/ledger/:xeroContactId', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { xeroContactId } = req.params;

    const summaryResult = await query(
      `SELECT * FROM client_excess_ledger WHERE xero_contact_id = $1`,
      [xeroContactId]
    );

    const historyResult = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE je.xero_contact_id = $1
      ORDER BY je.created_at DESC`,
      [xeroContactId]
    );

    res.json({
      summary: summaryResult.rows[0] || null,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error('[excess] Client ledger error:', error);
    res.status(500).json({ error: 'Failed to load client ledger' });
  }
});

// ── GET /api/excess/:id — Single excess record ──

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT je.*,
        vha.vehicle_id,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE je.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Detail error:', error);
    res.status(500).json({ error: 'Failed to load excess record' });
  }
});

// ── PUT /api/excess/:id — Update excess record ──

router.put('/:id', validate(updateExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      params.push(value ?? null);
      setClauses.push(`${key} = $${params.length}`);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE job_excess SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Update error:', error);
    res.status(500).json({ error: 'Failed to update excess record' });
  }
});

// ── POST /api/excess/:id/payment — Record payment ──

router.post('/:id/payment', validate(paymentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method, reference } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_amount_taken = COALESCE(excess_amount_taken, 0) + $1,
        excess_status = CASE
          WHEN COALESCE(excess_amount_taken, 0) + $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
          ELSE 'partial'
        END,
        payment_method = $2,
        payment_reference = $3,
        payment_date = NOW(),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [amount, method, reference || null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Send excess payment confirmation email
    const excess = result.rows[0];
    sendExcessEmail({
      templateId: 'excess_payment_confirmed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      paymentMethod: method,
    }).catch(e => console.error('[excess] Payment email failed:', e));

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── POST /api/excess/:id/claim — Record damage claim ──

router.post('/:id/claim', validate(claimSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, notes } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = 'claimed',
        claim_amount = $1,
        claim_date = NOW(),
        claim_notes = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
      [amount, notes || null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Send claim email
    const excess = result.rows[0];
    sendExcessEmail({
      templateId: 'excess_claimed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      reason: notes || undefined,
    }).catch(e => console.error('[excess] Claim email failed:', e));

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Claim error:', error);
    res.status(500).json({ error: 'Failed to record claim' });
  }
});

// ── POST /api/excess/:id/reimburse — Record reimbursement ──

router.post('/:id/reimburse', authorize('admin', 'manager'), validate(reimburseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = 'reimbursed',
        reimbursement_amount = $1,
        reimbursement_date = NOW(),
        reimbursement_method = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
      [amount, method, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Send reimbursement email
    const excess = result.rows[0];
    const originalAmount = parseFloat(excess.excess_amount_taken || '0');
    const isPartial = amount < originalAmount;
    sendExcessEmail({
      templateId: isPartial ? 'excess_partial_reimbursed' : 'excess_reimbursed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      paymentMethod: method,
      refundAmount: amount,
      originalAmount,
      retainedAmount: isPartial ? originalAmount - amount : 0,
    }).catch(e => console.error('[excess] Reimburse email failed:', e));

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Reimburse error:', error);
    res.status(500).json({ error: 'Failed to record reimbursement' });
  }
});

// ── POST /api/excess/:id/waive — Waive excess (admin only) ──

router.post('/:id/waive', authorize('admin'), validate(waiveSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = 'waived',
        claim_notes = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
      [reason, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Waive error:', error);
    res.status(500).json({ error: 'Failed to waive excess' });
  }
});

// ── POST /api/excess/:id/override — Manager override to allow dispatch without excess ──

router.post('/:id/override', authorize('admin', 'manager'), validate(overrideSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    const overrideNotes = reason === 'other' ? (notes || 'No details provided') : reason.replace(/_/g, ' ');

    const result = await query(
      `UPDATE job_excess SET
        dispatch_override = true,
        dispatch_override_reason = $1,
        dispatch_override_by = $2,
        dispatch_override_at = NOW(),
        notes = CASE WHEN notes IS NULL THEN $3 ELSE notes || E'\n' || $3 END,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [overrideNotes, req.user!.id, `Override: ${overrideNotes}`, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Override error:', error);
    res.status(500).json({ error: 'Failed to record override' });
  }
});

// ── POST /api/excess/:id/move — Move excess to a different Xero contact / person ──

router.post('/:id/move', authorize('admin', 'manager'), validate(moveExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { xero_contact_id, xero_contact_name, client_name, person_id, reason } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        xero_contact_id = $1,
        xero_contact_name = $2,
        client_name = COALESCE($3, $2),
        person_id = $4,
        notes = CASE WHEN notes IS NULL THEN $5 ELSE notes || E'\n' || $5 END,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *`,
      [
        xero_contact_id,
        xero_contact_name,
        client_name || null,
        person_id || null,
        `Moved to ${xero_contact_name}${reason ? ': ' + reason : ''}`,
        id,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Move error:', error);
    res.status(500).json({ error: 'Failed to move excess record' });
  }
});

// ── GET /api/excess/by-person/:personId — Excess history for a person (address book) ──

router.get('/by-person/:personId', async (req: AuthRequest, res: Response) => {
  try {
    const { personId } = req.params;

    const result = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE je.person_id = $1
         OR vha.driver_id IN (SELECT id FROM drivers WHERE person_id = $1)
      ORDER BY je.created_at DESC`,
      [personId]
    );

    // Calculate summary
    const records = result.rows;
    const totalTaken = records.reduce((sum: number, r: any) => sum + parseFloat(r.excess_amount_taken || 0), 0);
    const totalClaimed = records.reduce((sum: number, r: any) => sum + parseFloat(r.claim_amount || 0), 0);
    const totalReimbursed = records.reduce((sum: number, r: any) => sum + parseFloat(r.reimbursement_amount || 0), 0);
    const pendingCount = records.filter((r: any) => r.excess_status === 'pending').length;

    res.json({
      summary: {
        total_hires: records.length,
        total_taken: totalTaken,
        total_claimed: totalClaimed,
        total_reimbursed: totalReimbursed,
        balance_held: totalTaken - totalClaimed - totalReimbursed,
        pending_count: pendingCount,
      },
      history: records,
    });
  } catch (error) {
    console.error('[excess] By person error:', error);
    res.status(500).json({ error: 'Failed to load person excess history' });
  }
});

// ── GET /api/excess/by-org/:orgId — Excess history for an organisation (address book) ──

router.get('/by-org/:orgId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = req.params;

    // Find excess records where the job's client org matches, or xero_contact matches org's external ID
    const result = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE j.client_id = $1
         OR je.xero_contact_id IN (
           SELECT external_id FROM external_id_map
           WHERE entity_type = 'organisation' AND entity_id = $1 AND source = 'xero'
         )
      ORDER BY je.created_at DESC`,
      [orgId]
    );

    const records = result.rows;
    const totalTaken = records.reduce((sum: number, r: any) => sum + parseFloat(r.excess_amount_taken || 0), 0);
    const totalClaimed = records.reduce((sum: number, r: any) => sum + parseFloat(r.claim_amount || 0), 0);
    const totalReimbursed = records.reduce((sum: number, r: any) => sum + parseFloat(r.reimbursement_amount || 0), 0);
    const pendingCount = records.filter((r: any) => r.excess_status === 'pending').length;

    res.json({
      summary: {
        total_hires: records.length,
        total_taken: totalTaken,
        total_claimed: totalClaimed,
        total_reimbursed: totalReimbursed,
        balance_held: totalTaken - totalClaimed - totalReimbursed,
        pending_count: pendingCount,
      },
      history: records,
    });
  } catch (error) {
    console.error('[excess] By org error:', error);
    res.status(500).json({ error: 'Failed to load organisation excess history' });
  }
});

// ── GET /api/excess/client-balance/:xeroContactId — Quick balance check for auto-suggest ──

router.get('/client-balance/:xeroContactId', async (req: AuthRequest, res: Response) => {
  try {
    const { xeroContactId } = req.params;

    const result = await query(
      `SELECT * FROM client_excess_ledger WHERE xero_contact_id = $1`,
      [xeroContactId]
    );

    if (result.rows.length === 0) {
      res.json({ data: { balance_held: 0, rolled_over_count: 0, has_balance: false } });
      return;
    }

    const ledger = result.rows[0];
    res.json({
      data: {
        ...ledger,
        has_balance: parseFloat(ledger.balance_held) > 0 || parseInt(ledger.rolled_over_count) > 0,
      },
    });
  } catch (error) {
    console.error('[excess] Client balance error:', error);
    res.status(500).json({ error: 'Failed to check client balance' });
  }
});

export default router;
