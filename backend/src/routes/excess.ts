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
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

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
  method: z.enum(['payment_portal', 'bank_transfer', 'card_in_office', 'cash', 'rolled_over']),
  reference: z.string().max(200).nullable().optional(),
});

const claimSchema = z.object({
  amount: z.number().min(0),
  notes: z.string().nullable().optional(),
});

const reimburseSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['bank_transfer', 'card_refund', 'cash']),
});

const waiveSchema = z.object({
  reason: z.string().min(1),
});

// ── GET /api/excess — List excess records ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, hirehop_job_id, xero_contact_id,
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
        d.full_name AS driver_name
      FROM job_excess je
      JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
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

// ── GET /api/excess/rules — Get excess calculation rules ──

router.get('/rules', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT * FROM excess_rules WHERE is_active = true ORDER BY sort_order ASC'
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[excess] Rules error:', error);
    res.status(500).json({ error: 'Failed to load excess rules' });
  }
});

// ── PUT /api/excess/rules — Update excess rules (admin only) ──

router.put('/rules', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { rules } = req.body;

    if (!Array.isArray(rules)) {
      res.status(400).json({ error: 'rules array required' });
      return;
    }

    // Upsert each rule
    for (const rule of rules) {
      if (rule.id) {
        await query(
          `UPDATE excess_rules SET
            rule_type = $1, condition_min = $2, condition_max = $3,
            condition_code = $4, excess_amount = $5, requires_referral = $6,
            description = $7, is_active = $8, sort_order = $9,
            updated_at = NOW(), updated_by = $10
          WHERE id = $11`,
          [
            rule.rule_type, rule.condition_min, rule.condition_max,
            rule.condition_code, rule.excess_amount, rule.requires_referral,
            rule.description, rule.is_active ?? true, rule.sort_order ?? 0,
            req.user!.id, rule.id,
          ]
        );
      } else {
        await query(
          `INSERT INTO excess_rules (
            rule_type, condition_min, condition_max, condition_code,
            excess_amount, requires_referral, description, is_active, sort_order, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            rule.rule_type, rule.condition_min, rule.condition_max, rule.condition_code,
            rule.excess_amount, rule.requires_referral, rule.description,
            rule.is_active ?? true, rule.sort_order ?? 0, req.user!.id,
          ]
        );
      }
    }

    const result = await query(
      'SELECT * FROM excess_rules WHERE is_active = true ORDER BY sort_order ASC'
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[excess] Update rules error:', error);
    res.status(500).json({ error: 'Failed to update excess rules' });
  }
});

// ── GET /api/excess/calculate — Calculate excess for given licence points ──

router.get('/calculate', async (req: AuthRequest, res: Response) => {
  try {
    const { points, endorsements, licence_country } = req.query;
    const pointsNum = parseInt(points as string) || 0;
    const endorsementCodes = endorsements ? (endorsements as string).split(',') : [];
    const country = (licence_country as string) || 'GB';

    // Check referral triggers first
    const referralRules = await query(
      `SELECT * FROM excess_rules
       WHERE is_active = true AND requires_referral = true
       ORDER BY sort_order ASC`
    );

    let requiresReferral = false;
    let referralReason = '';

    // Check endorsement-based referrals
    for (const rule of referralRules.rows) {
      if (rule.rule_type === 'endorsement_referral' && rule.condition_code) {
        const matchingCode = endorsementCodes.find(code =>
          code.toUpperCase().startsWith(rule.condition_code.toUpperCase())
        );
        if (matchingCode) {
          requiresReferral = true;
          referralReason = rule.description || `Endorsement code ${matchingCode}`;
          break;
        }
      }
      if (rule.rule_type === 'licence_type' && country !== 'GB') {
        requiresReferral = true;
        referralReason = rule.description || 'Non-GB licence';
        break;
      }
    }

    // Check points-based tiers
    const tierResult = await query(
      `SELECT * FROM excess_rules
       WHERE is_active = true
         AND rule_type = 'points_tier'
         AND condition_min <= $1
         AND condition_max >= $1
       ORDER BY sort_order ASC
       LIMIT 1`,
      [pointsNum]
    );

    const tier = tierResult.rows[0];

    if (tier?.requires_referral) {
      requiresReferral = true;
      referralReason = tier.description || `${pointsNum} points exceeds threshold`;
    }

    res.json({
      points: pointsNum,
      excessAmount: requiresReferral ? null : (tier?.excess_amount ? parseFloat(tier.excess_amount) : null),
      requiresReferral,
      referralReason: requiresReferral ? referralReason : null,
      calculationBasis: tier?.description || null,
      tierMatched: tier ? { min: tier.condition_min, max: tier.condition_max, amount: tier.excess_amount } : null,
    });
  } catch (error) {
    console.error('[excess] Calculate error:', error);
    res.status(500).json({ error: 'Failed to calculate excess' });
  }
});

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
        d.full_name AS driver_name
      FROM job_excess je
      JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
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
        d.full_name AS driver_name
      FROM job_excess je
      JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
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

export default router;
