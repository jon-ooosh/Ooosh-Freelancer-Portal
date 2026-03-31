import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  calculateCosts,
  CalculatorSettings,
  CalculatorInput,
} from '../services/crew-transport-calculator';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';

const router = Router();
router.use(authenticate);

// ── GET /api/quotes/ops/overview — operations overview (must be before /:id) ──

router.get('/ops/overview', async (req: AuthRequest, res: Response) => {
  try {
    const { job_type, ops_status, date_from, date_to } = req.query;

    let whereClause = 'WHERE q.is_deleted = false AND q.status != \'cancelled\'';
    const params: unknown[] = [];

    if (job_type) {
      if (job_type === 'transport') {
        whereClause += ` AND q.job_type IN ('delivery', 'collection')`;
      } else if (job_type === 'crewed') {
        whereClause += ` AND q.job_type = 'crewed'`;
      }
    }

    if (ops_status) {
      params.push(ops_status);
      whereClause += ` AND q.ops_status = $${params.length}`;
    }

    if (date_from) {
      params.push(date_from);
      whereClause += ` AND q.job_date >= $${params.length}`;
    }

    if (date_to) {
      params.push(date_to);
      whereClause += ` AND q.job_date <= $${params.length}`;
    }

    const result = await query(
      `SELECT q.*,
        j.job_name, j.hh_job_number, j.client_name, j.out_date, j.return_date,
        v.name as linked_venue_name, v.address as venue_address, v.city as venue_city,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', qa.id,
            'person_id', qa.person_id,
            'first_name', ap.first_name,
            'last_name', ap.last_name,
            'role', qa.role,
            'status', qa.status,
            'agreed_rate', qa.agreed_rate,
            'rate_type', qa.rate_type,
            'is_ooosh_crew', qa.is_ooosh_crew,
            'confirmed_at', qa.confirmed_at,
            'expected_expenses', qa.expected_expenses,
            'invoice_received', qa.invoice_received,
            'invoice_amount', qa.invoice_amount
          ) ORDER BY qa.created_at)
          FROM quote_assignments qa
          LEFT JOIN people ap ON ap.id = qa.person_id
          WHERE qa.quote_id = q.id
        ), '[]'::json) as assignments
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       ${whereClause}
       ORDER BY
         CASE q.ops_status
           WHEN 'todo' THEN 1
           WHEN 'arranging' THEN 2
           WHEN 'arranged' THEN 3
           WHEN 'dispatched' THEN 4
           WHEN 'arrived' THEN 5
           WHEN 'completed' THEN 6
           WHEN 'cancelled' THEN 7
           ELSE 8
         END,
         q.job_date ASC NULLS LAST,
         q.arrival_time ASC NULLS LAST`,
      params
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('Ops overview error:', error);
    res.status(500).json({ error: 'Failed to load operations overview' });
  }
});

// ── GET /api/quotes/settings — fetch all calculator settings ─────────

router.get('/settings', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT key, value, label, unit FROM calculator_settings ORDER BY key`
    );
    // Convert rows to key-value object
    const settings: Record<string, { value: number; label: string; unit: string }> = {};
    for (const row of result.rows) {
      settings[row.key] = {
        value: parseFloat(row.value),
        label: row.label,
        unit: row.unit,
      };
    }
    res.json({ data: settings });
  } catch (error) {
    console.error('Get calculator settings error:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ── PUT /api/quotes/settings — update calculator settings ────────────

const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.number()),
});

router.put('/settings', validate(updateSettingsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { settings } = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await query(
        `UPDATE calculator_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3`,
        [value, req.user!.id, key]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Update calculator settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── POST /api/quotes/calculate — run calculation (no save) ──────────

const calculateSchema = z.object({
  jobType: z.enum(['delivery', 'collection', 'crewed']),
  calculationMode: z.enum(['hourly', 'dayrate']),
  distanceMiles: z.number().min(0),
  driveTimeMins: z.number().min(0),
  arrivalTime: z.string().regex(/^\d{2}:\d{2}$/),
  workDurationHrs: z.number().min(0).optional().nullable(),
  numDays: z.number().min(1).optional().nullable(),
  setupExtraHrs: z.number().min(0).optional().nullable(),
  setupPremium: z.number().min(0).optional().nullable(),
  travelMethod: z.enum(['vehicle', 'public_transport']).default('vehicle'),
  dayRateOverride: z.number().optional().nullable(),
  clientRateOverride: z.number().optional().nullable(),
  expenses: z.array(z.object({
    type: z.string(),
    description: z.string(),
    amount: z.number().min(0),
    includedInCharge: z.boolean(),
  })).default([]),
});

router.post('/calculate', validate(calculateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const settings = await loadSettings();
    const result = calculateCosts(req.body as CalculatorInput, settings);
    res.json({ data: result, settings });
  } catch (error) {
    console.error('Calculate error:', error);
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// ── POST /api/quotes — save a quote (calculate + persist) ───────────

const saveQuoteSchema = calculateSchema.extend({
  jobId: z.string().uuid().optional().nullable(),
  venueId: z.string().uuid().optional().nullable(),
  venueName: z.string().optional().nullable(),
  jobDate: z.string().optional().nullable(),
  jobFinishDate: z.string().optional().nullable(),
  isMultiDay: z.boolean().optional().nullable(),
  whatIsIt: z.enum(['vehicle', 'equipment', 'people']).optional().nullable(),
  addCollection: z.boolean().optional().nullable(),
  collectionDate: z.string().optional().nullable(),
  collectionTime: z.string().optional().nullable(),
  clientName: z.string().optional().nullable(),
  includesSetup: z.boolean().optional().nullable(),
  setupDescription: z.string().optional().nullable(),
  workType: z.string().optional().nullable(),
  workDescription: z.string().optional().nullable(),
  oohManual: z.boolean().optional().nullable(),
  earlyStartMins: z.number().optional().nullable(),
  lateFinishMins: z.number().optional().nullable(),
  travelTimeMins: z.number().optional().nullable(),
  travelCost: z.number().optional().nullable(),
  internalNotes: z.string().optional().nullable(),
  freelancerNotes: z.string().optional().nullable(),
  crewCount: z.number().int().min(1).optional().nullable(),
});

router.post('/', validate(saveQuoteSchema), async (req: AuthRequest, res: Response) => {
  try {
    const settings = await loadSettings();
    const calculatorInput: CalculatorInput = {
      jobType: req.body.jobType,
      calculationMode: req.body.calculationMode,
      distanceMiles: req.body.distanceMiles,
      driveTimeMins: req.body.driveTimeMins,
      arrivalTime: req.body.arrivalTime,
      workDurationHrs: req.body.workDurationHrs,
      numDays: req.body.numDays,
      setupExtraHrs: req.body.setupExtraHrs,
      setupPremium: req.body.setupPremium,
      travelMethod: req.body.travelMethod,
      dayRateOverride: req.body.dayRateOverride,
      clientRateOverride: req.body.clientRateOverride,
      expenses: req.body.expenses || [],
    };

    const singleCrewResult = calculateCosts(calculatorInput, settings);

    // Multi-crew: multiply costs by crew_count for crewed jobs
    const crewCount = (req.body.jobType === 'crewed' && req.body.crewCount > 1) ? req.body.crewCount : 1;
    const result = crewCount > 1 ? {
      ...singleCrewResult,
      clientChargeLabour: Math.round(singleCrewResult.clientChargeLabour * crewCount * 100) / 100,
      clientChargeTotal: Math.round(singleCrewResult.clientChargeTotal * crewCount * 100) / 100,
      clientChargeTotalRounded: Math.round(singleCrewResult.clientChargeTotalRounded * crewCount),
      freelancerFee: Math.round(singleCrewResult.freelancerFee * crewCount * 100) / 100,
      freelancerFeeRounded: Math.ceil((singleCrewResult.freelancerFeeRounded * crewCount) / 5) * 5,
      ourTotalCost: Math.round(singleCrewResult.ourTotalCost * crewCount * 100) / 100,
      ourMargin: Math.round((singleCrewResult.clientChargeTotalRounded * crewCount) - (singleCrewResult.ourTotalCost * crewCount) * 100) / 100,
    } : singleCrewResult;

    const saved = await query(
      `INSERT INTO quotes (
        job_id, job_type, calculation_mode,
        venue_name, venue_id, distance_miles, drive_time_mins,
        arrival_time, job_date, job_finish_date, is_multi_day,
        work_duration_hrs, num_days,
        setup_extra_hrs, setup_premium, travel_method,
        day_rate_override, client_rate_override, expenses,
        what_is_it, add_collection, collection_date, collection_time,
        client_name, includes_setup, setup_description,
        work_type, work_description,
        ooh_manual, early_start_mins, late_finish_mins,
        client_charge_labour, client_charge_fuel, client_charge_expenses,
        client_charge_total, client_charge_rounded,
        freelancer_fee, freelancer_fee_rounded,
        expected_fuel_cost, expenses_included, expenses_not_included,
        our_total_cost, our_margin,
        estimated_time_mins, estimated_time_hrs,
        settings_snapshot, internal_notes, freelancer_notes,
        travel_time_mins, travel_cost, created_by, client_introduction,
        crew_count
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
        $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48,
        $49, $50, $51, 'todo', $52
      ) RETURNING id`,
      [
        req.body.jobId || null,
        req.body.jobType,
        req.body.calculationMode,
        req.body.venueName || null,
        req.body.venueId || null,
        req.body.distanceMiles,
        req.body.driveTimeMins,
        req.body.arrivalTime,
        req.body.jobDate || null,
        req.body.jobFinishDate || null,
        req.body.isMultiDay || false,
        req.body.workDurationHrs || null,
        req.body.numDays || null,
        req.body.setupExtraHrs || null,
        req.body.setupPremium || null,
        req.body.travelMethod,
        req.body.dayRateOverride || null,
        req.body.clientRateOverride || null,
        JSON.stringify(req.body.expenses || []),
        req.body.whatIsIt || null,
        req.body.addCollection || false,
        req.body.collectionDate || null,
        req.body.collectionTime || null,
        req.body.clientName || null,
        req.body.includesSetup || false,
        req.body.setupDescription || null,
        req.body.workType || null,
        req.body.workDescription || null,
        req.body.oohManual || false,
        result.autoEarlyStartMinutes,
        result.autoLateFinishMinutes,
        result.clientChargeLabour,
        result.clientChargeFuel,
        result.clientChargeExpenses,
        result.clientChargeTotal,
        result.clientChargeTotalRounded,
        result.freelancerFee,
        result.freelancerFeeRounded,
        result.expectedFuelCost,
        result.expensesIncluded,
        result.expensesNotIncluded,
        result.ourTotalCost,
        result.ourMargin,
        result.estimatedTimeMinutes,
        result.estimatedTimeHours,
        JSON.stringify(settings),
        req.body.internalNotes || null,
        req.body.freelancerNotes || null,
        req.body.travelTimeMins || null,
        req.body.travelCost || null,
        req.user!.id,
        crewCount,
      ]
    );

    res.status(201).json({ id: saved.rows[0].id, ...result });
  } catch (error) {
    console.error('Save quote error:', error);
    res.status(500).json({ error: 'Failed to save quote' });
  }
});

// ── GET /api/quotes — list quotes (optionally by job) ───────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { job_id, page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let whereClause = 'WHERE q.is_deleted = false';
    const params: unknown[] = [];

    if (job_id) {
      params.push(job_id);
      whereClause += ` AND q.job_id = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM quotes q ${whereClause}`, params
    );

    params.push(parseInt(limit as string));
    params.push(offset);
    const result = await query(
      `SELECT q.*,
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', qa.id,
            'person_id', qa.person_id,
            'first_name', ap.first_name,
            'last_name', ap.last_name,
            'role', qa.role,
            'status', qa.status,
            'agreed_rate', qa.agreed_rate,
            'rate_type', qa.rate_type
          ) ORDER BY qa.created_at)
          FROM quote_assignments qa
          JOIN people ap ON ap.id = qa.person_id
          WHERE qa.quote_id = q.id
        ), '[]'::json) as assignments
       FROM quotes q
       LEFT JOIN users u ON u.id = q.created_by
       LEFT JOIN people p ON p.id = u.person_id
       ${whereClause}
       ORDER BY q.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult.rows[0].count),
      },
    });
  } catch (error) {
    console.error('List quotes error:', error);
    res.status(500).json({ error: 'Failed to load quotes' });
  }
});

// ── GET /api/quotes/:id — single quote detail ──────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT q.*,
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name
       FROM quotes q
       LEFT JOIN users u ON u.id = q.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE q.id = $1 AND q.is_deleted = false`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get quote error:', error);
    res.status(500).json({ error: 'Failed to load quote' });
  }
});

// ── PUT /api/quotes/:id — edit quote core fields ─────────────────────

const editQuoteSchema = z.object({
  job_type: z.enum(['delivery', 'collection', 'crewed']).optional(),
  venue_name: z.string().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  job_date: z.string().optional().nullable(),
  job_finish_date: z.string().optional().nullable(),
  is_multi_day: z.boolean().optional().nullable(),
  num_days: z.number().int().min(1).optional().nullable(),
  arrival_time: z.string().optional().nullable(),
  what_is_it: z.enum(['vehicle', 'equipment', 'people']).optional().nullable(),
  work_type: z.string().optional().nullable(),
  work_description: z.string().optional().nullable(),
  crew_count: z.number().int().min(1).optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  freelancer_notes: z.string().optional().nullable(),
  client_charge_rounded: z.coerce.number().min(0).optional().nullable(),
  freelancer_fee_rounded: z.coerce.number().min(0).optional().nullable(),
});

router.put('/:id', validate(editQuoteSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Fetch existing quote + assignments for change detection
    const existing = await query(
      `SELECT q.id, q.calculation_mode, q.is_local, q.job_date, q.arrival_time,
              q.venue_name, q.venue_id, q.status,
              j.job_name as linked_job_name
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE q.id = $1 AND q.is_deleted = false`,
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const oldQuote = existing.rows[0];

    const fields = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    // Map of allowed fields to their DB columns
    const allowedFields = [
      'job_type', 'venue_name', 'venue_id', 'job_date', 'job_finish_date',
      'is_multi_day', 'num_days', 'arrival_time',
      'what_is_it', 'work_type', 'work_description', 'crew_count',
      'internal_notes', 'freelancer_notes',
    ];

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${idx}`);
        params.push(fields[field]);
        idx++;
      }
    }

    // Fee overrides (available for all quote types)
    if (fields.client_charge_rounded !== undefined) {
      updates.push(`client_charge_rounded = $${idx}, client_charge_total = $${idx}`);
      params.push(fields.client_charge_rounded);
      idx++;
    }
    if (fields.freelancer_fee_rounded !== undefined) {
      updates.push(`freelancer_fee_rounded = $${idx}, freelancer_fee = $${idx}`);
      params.push(fields.freelancer_fee_rounded);
      idx++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push('updated_at = NOW()');
    params.push(req.params.id);

    const result = await query(
      `UPDATE quotes SET ${updates.join(', ')} WHERE id = $${idx} AND is_deleted = false RETURNING *`,
      params
    );

    const updatedQuote = result.rows[0];

    // Check if key fields changed and notify assigned crew
    const keyFieldsChanged: string[] = [];
    if (fields.job_date !== undefined && fields.job_date !== (oldQuote.job_date ? String(oldQuote.job_date).split('T')[0] : null)) {
      keyFieldsChanged.push(`Date changed to ${fields.job_date}`);
    }
    if (fields.arrival_time !== undefined && fields.arrival_time !== oldQuote.arrival_time) {
      keyFieldsChanged.push(`Arrival time changed to ${fields.arrival_time}`);
    }
    if (fields.venue_name !== undefined && fields.venue_name !== oldQuote.venue_name) {
      keyFieldsChanged.push(`Venue changed to ${fields.venue_name}`);
    }

    if (keyFieldsChanged.length > 0 && updatedQuote.status === 'confirmed') {
      // Fire-and-forget: send notifications to assigned crew
      (async () => {
        try {
          const assignees = await query(
            `SELECT qa.person_id, p.first_name, p.last_name, p.email
             FROM quote_assignments qa
             JOIN people p ON p.id = qa.person_id
             WHERE qa.quote_id = $1 AND qa.status NOT IN ('declined', 'cancelled')
               AND p.email IS NOT NULL`,
            [req.params.id]
          );

          const jobName = oldQuote.linked_job_name || oldQuote.job_name || 'a job';
          for (const crew of assignees.rows) {
            try {
              await emailService.send('job_change_notification', {
                to: crew.email,
                variables: {
                  freelancerName: crew.first_name || 'there',
                  jobName,
                  jobDate: updatedQuote.job_date ? String(updatedQuote.job_date).split('T')[0] : 'TBC',
                  venueName: updatedQuote.venue_name || 'TBC',
                  changeDescription: keyFieldsChanged.join('. '),
                },
              });
            } catch (emailErr) {
              console.error(`Failed to notify ${crew.email} of job change:`, emailErr);
            }
          }
        } catch (err) {
          console.error('Failed to send job change notifications:', err);
        }
      })();
    }

    res.json(updatedQuote);
  } catch (error: any) {
    console.error('Edit quote error:', error?.message || error, error?.detail || '', 'Body:', JSON.stringify(req.body).substring(0, 500));
    res.status(500).json({ error: `Failed to update quote: ${error?.message || 'Unknown error'}` });
  }
});

// ── PATCH /api/quotes/:id/status — update quote status ──────────────

const statusSchema = z.object({
  status: z.enum(['draft', 'confirmed', 'cancelled', 'completed']),
  cancelledReason: z.string().optional().nullable(),
});

router.patch('/:id/status', validate(statusSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { status, cancelledReason } = req.body;
    const result = await query(
      `UPDATE quotes
       SET status = $1, status_changed_at = NOW(), status_changed_by = $2,
           cancelled_reason = $3, updated_at = NOW()
       WHERE id = $4 AND is_deleted = false
       RETURNING id, status`,
      [status, req.user!.id, status === 'cancelled' ? (cancelledReason || null) : null, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update quote status error:', error);
    res.status(500).json({ error: 'Failed to update quote status' });
  }
});

// ── DELETE /api/quotes/:id — soft-delete a quote ────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE quotes SET is_deleted = true, updated_at = NOW() WHERE id = $1 AND is_deleted = false RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete quote error:', error);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// ── GET /api/quotes/:id/assignments — list crew for a quote ─────────

router.get('/:id/assignments', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT qa.*,
        p.first_name, p.last_name, p.email, p.mobile, p.skills,
        p.is_insured_on_vehicles, p.is_approved
       FROM quote_assignments qa
       JOIN people p ON p.id = qa.person_id
       WHERE qa.quote_id = $1
       ORDER BY qa.created_at`,
      [_req.params.id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('List quote assignments error:', error);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// ── POST /api/quotes/:id/assignments — assign a person to a quote ───

const assignSchema = z.object({
  personId: z.string().uuid(),
  role: z.string().default('driver'),
  agreedRate: z.number().optional().nullable(),
  rateType: z.enum(['hourly', 'dayrate', 'fixed']).optional().nullable(),
  rateNotes: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/:id/assignments', validate(assignSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { personId, role, agreedRate, rateType, rateNotes, notes } = req.body;
    const result = await query(
      `INSERT INTO quote_assignments (quote_id, person_id, role, agreed_rate, rate_type, rate_notes, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (quote_id, person_id) DO UPDATE SET
         role = EXCLUDED.role, agreed_rate = EXCLUDED.agreed_rate,
         rate_type = EXCLUDED.rate_type, rate_notes = EXCLUDED.rate_notes,
         notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING id`,
      [req.params.id, personId, role, agreedRate || null, rateType || null, rateNotes || null, notes || null, req.user!.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Assign person to quote error:', error);
    res.status(500).json({ error: 'Failed to assign person' });
  }
});

// ── DELETE /api/quotes/:quoteId/assignments/:assignmentId ───────────

router.delete('/:quoteId/assignments/:assignmentId', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM quote_assignments WHERE id = $1 AND quote_id = $2 RETURNING id`,
      [_req.params.assignmentId, _req.params.quoteId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Remove quote assignment error:', error);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// ── PATCH /api/quotes/:id/ops-status — update operational status ────

const opsStatusSchema = z.object({
  ops_status: z.enum(['todo', 'arranging', 'arranged', 'dispatched', 'arrived', 'completed', 'cancelled']),
});

router.patch('/:id/ops-status', validate(opsStatusSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { ops_status } = req.body;
    const updates: string[] = ['ops_status = $1', 'updated_at = NOW()'];
    const params: unknown[] = [ops_status];

    if (ops_status === 'completed') {
      updates.push(`completed_at = NOW()`);
      updates.push(`completed_by = $${params.length + 1}`);
      params.push(req.user!.email);
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE quotes SET ${updates.join(', ')} WHERE id = $${params.length} AND is_deleted = false RETURNING id, ops_status`,
      params
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update ops status error:', error);
    res.status(500).json({ error: 'Failed to update operational status' });
  }
});

// ── PUT /api/quotes/:id/ops-details — update arranging/ops fields ───

const opsDetailsSchema = z.object({
  key_points: z.string().optional().nullable(),
  client_introduction: z.string().optional().nullable(),
  tolls_status: z.enum(['not_needed', 'todo', 'booked', 'paid']).optional(),
  accommodation_status: z.enum(['not_needed', 'todo', 'booked', 'paid']).optional(),
  flight_status: z.enum(['not_needed', 'todo', 'booked', 'paid']).optional(),
  work_type: z.string().optional().nullable(),
  work_type_other: z.string().optional().nullable(),
  work_description: z.string().optional().nullable(),
  job_date: z.string().optional().nullable(),
  arrival_time: z.string().optional().nullable(),
  venue_name: z.string().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  freelancer_notes: z.string().optional().nullable(),
  internal_notes: z.string().optional().nullable(),
});

router.put('/:id/ops-details', validate(opsDetailsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const fields = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${key} = $${idx}`);
        params.push(value);
        idx++;
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push('updated_at = NOW()');
    params.push(req.params.id);

    const result = await query(
      `UPDATE quotes SET ${updates.join(', ')} WHERE id = $${idx} AND is_deleted = false RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update ops details error:', error);
    res.status(500).json({ error: 'Failed to update details' });
  }
});

// ── POST /api/quotes/local — create a local delivery/collection ─────

const localQuoteSchema = z.object({
  jobId: z.string().uuid(),
  jobType: z.enum(['delivery', 'collection']),
  jobDate: z.string().optional().nullable(),
  arrivalTime: z.string().optional().nullable(),
  venueId: z.string().uuid().optional().nullable(),
  venueName: z.string().optional().nullable(),
  fee: z.number().min(0).optional().nullable(),
  clientCharge: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
  whatIsIt: z.enum(['vehicle', 'equipment', 'people']).optional().nullable(),
});

router.post('/local', validate(localQuoteSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, jobType, jobDate, arrivalTime, venueId, venueName, fee, clientCharge, notes, whatIsIt } = req.body;
    const feeVal = fee || 0;
    const chargeVal = clientCharge || feeVal;

    const result = await query(
      `INSERT INTO quotes (
        job_id, job_type, is_local, calculation_mode,
        venue_id, venue_name, job_date, arrival_time,
        freelancer_fee, freelancer_fee_rounded,
        client_charge_total, client_charge_rounded,
        what_is_it, internal_notes,
        distance_miles, drive_time_mins,
        created_by
      ) VALUES ($1, $2, true, 'fixed', $3, $4, $5, $6, $7, $7, $8, $8, $9, $10, 0, 0, $11)
      RETURNING id`,
      [
        jobId, jobType, venueId || null, venueName || null,
        jobDate || null, arrivalTime || null,
        feeVal, chargeVal,
        whatIsIt || null, notes || null,
        req.user!.id,
      ]
    );

    const quoteId = result.rows[0].id;

    // Auto-assign "Ooosh Staff" person to local D&C quotes
    const OOOSH_STAFF_ID = '00000000-0000-0000-0000-000000000001';
    try {
      await query(
        `INSERT INTO quote_assignments (quote_id, person_id, role, is_ooosh_crew, created_by)
         VALUES ($1, $2, 'driver', true, $3)
         ON CONFLICT (quote_id, person_id) DO NOTHING`,
        [quoteId, OOOSH_STAFF_ID, req.user!.id]
      );
    } catch (assignErr) {
      // Non-fatal: quote was created, just log the auto-assign failure
      console.warn('Failed to auto-assign Ooosh Staff to local quote:', assignErr);
    }

    res.status(201).json({ id: quoteId });
  } catch (error) {
    console.error('Create local quote error:', error);
    res.status(500).json({ error: 'Failed to create local delivery/collection' });
  }
});

// ── PUT /api/quotes/:id/run-group — manage run grouping ─────────────

const runGroupSchema = z.object({
  run_group: z.string().uuid().nullable(),
  run_order: z.number().optional().nullable(),
  run_group_fee: z.number().optional().nullable(),
});

router.put('/:id/run-group', validate(runGroupSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { run_group, run_order, run_group_fee } = req.body;
    const result = await query(
      `UPDATE quotes SET run_group = $1, run_order = $2, run_group_fee = $3, updated_at = NOW()
       WHERE id = $4 AND is_deleted = false RETURNING id, run_group, run_order, run_group_fee`,
      [run_group, run_order || null, run_group_fee || null, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update run group error:', error);
    res.status(500).json({ error: 'Failed to update run group' });
  }
});

// ── POST /api/quotes/:id/assignments/ooosh-crew — assign as Ooosh crew

router.post('/:id/assignments/ooosh-crew', async (req: AuthRequest, res: Response) => {
  try {
    // Get or create a system "Ooosh Crew" assignment (no real person)
    // We use person_id = NULL with is_ooosh_crew = true
    const result = await query(
      `INSERT INTO quote_assignments (quote_id, person_id, role, is_ooosh_crew, created_by)
       VALUES ($1, NULL, 'driver', true, $2)
       RETURNING id`,
      [req.params.id, req.user!.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Assign Ooosh crew error:', error);
    res.status(500).json({ error: 'Failed to assign Ooosh crew' });
  }
});

// ── Helper: load settings as typed object ───────────────────────────

async function loadSettings(): Promise<CalculatorSettings> {
  const result = await query(`SELECT key, value FROM calculator_settings`);
  const map: Record<string, number> = {};
  for (const row of result.rows) {
    map[row.key] = parseFloat(row.value);
  }
  return {
    freelancer_hourly_day: map.freelancer_hourly_day ?? 18,
    freelancer_hourly_night: map.freelancer_hourly_night ?? 25,
    client_hourly_day: map.client_hourly_day ?? 33,
    client_hourly_night: map.client_hourly_night ?? 45,
    driver_day_rate: map.driver_day_rate ?? 180,
    admin_cost_per_hour: map.admin_cost_per_hour ?? 5,
    fuel_price_per_litre: map.fuel_price_per_litre ?? 1.45,
    handover_time_mins: map.handover_time_mins ?? 15,
    unload_time_mins: map.unload_time_mins ?? 30,
    expense_markup_percent: map.expense_markup_percent ?? 10,
    min_hours_threshold: map.min_hours_threshold ?? 5,
    min_client_charge_floor: map.min_client_charge_floor ?? 0,
    day_rate_client_markup: map.day_rate_client_markup ?? 1.8,
    fuel_efficiency_mpg: map.fuel_efficiency_mpg ?? 5,
    expense_variance_threshold: map.expense_variance_threshold ?? 20,
  };
}

// ── GET /api/quotes/crew-history — previously assigned crew for a client/venue ──

router.get('/crew-history', async (req: AuthRequest, res: Response) => {
  try {
    const { job_id, venue_id, client_name } = req.query;

    if (!job_id && !venue_id && !client_name) {
      res.status(400).json({ error: 'Provide job_id, venue_id, or client_name' });
      return;
    }

    // Find people who've been assigned to crewed jobs for the same client or venue
    const conditions: string[] = [`q.job_type = 'crewed'`, `q.is_deleted = false`];
    const params: unknown[] = [];

    if (venue_id) {
      params.push(venue_id);
      conditions.push(`q.venue_id = $${params.length}`);
    }

    if (client_name) {
      params.push(`%${client_name}%`);
      conditions.push(`(q.client_name ILIKE $${params.length} OR j.client_name ILIKE $${params.length})`);
    }

    if (job_id) {
      // Look up the job's client_name and venue to match against
      const jobResult = await query(
        `SELECT j.client_name, j.venue_id FROM jobs j WHERE j.id = $1`,
        [job_id]
      );
      if (jobResult.rows.length > 0) {
        const job = jobResult.rows[0];
        const orParts: string[] = [];
        if (job.client_name) {
          params.push(job.client_name);
          orParts.push(`(q.client_name = $${params.length} OR j.client_name = $${params.length})`);
        }
        if (job.venue_id) {
          params.push(job.venue_id);
          orParts.push(`q.venue_id = $${params.length}`);
        }
        if (orParts.length > 0) {
          conditions.push(`(${orParts.join(' OR ')})`);
        }
      }
    }

    const result = await query(
      `SELECT
        p.id as person_id, p.first_name, p.last_name,
        qa.role,
        COUNT(DISTINCT q.id) as job_count,
        MAX(q.job_date) as last_job_date,
        ROUND(AVG(qa.agreed_rate)::numeric, 2) as avg_rate
       FROM quote_assignments qa
       JOIN people p ON p.id = qa.person_id
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE ${conditions.join(' AND ')}
         AND p.is_freelancer = true AND p.is_approved = true
       GROUP BY p.id, p.first_name, p.last_name, qa.role
       ORDER BY job_count DESC, last_job_date DESC
       LIMIT 10`,
      params
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('Crew history error:', error);
    res.status(500).json({ error: 'Failed to load crew history' });
  }
});

// ── POST /api/quotes/:id/push-hirehop — add quote as line item to HireHop job ──

const LABOUR_ITEM_IDS: Record<string, number> = {
  delivery: 5,
  collection: 6,
  crew: 86,
};

// Local D/C pre-priced items by type and time window
const LOCAL_DC_ITEMS: Record<string, { id: number; price: number }[]> = {
  delivery: [
    { id: 11, price: 40 },   // 10am-5pm
    { id: 13, price: 85 },   // 5pm-10pm
    { id: 82, price: 125 },  // 10pm-10am
  ],
  collection: [
    { id: 79, price: 40 },   // 10am-5pm
    { id: 80, price: 85 },   // 5pm-10pm
    { id: 81, price: 125 },  // 10pm-10am
  ],
};

function getLocalItemId(jobType: string, arrivalTime: string | null): number {
  // Determine time window from arrival time
  const items = LOCAL_DC_ITEMS[jobType] || LOCAL_DC_ITEMS['delivery'];
  if (!arrivalTime) return items[0].id; // Default to daytime

  const [h] = arrivalTime.split(':').map(Number);
  if (h >= 10 && h < 17) return items[0].id;     // 10am-5pm
  if (h >= 17 && h < 22) return items[1].id;      // 5pm-10pm
  return items[2].id;                               // 10pm-10am (22-10)
}

function buildItemNote(date?: string | null, endDate?: string | null, time?: string | null, venue?: string | null, workType?: string | null, isMultiDay?: boolean): string {
  const parts: string[] = [];
  if (workType) parts.push(workType);

  const ordinal = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  if (date) {
    const d = new Date(date + 'T12:00:00');
    const day = d.getDate();
    const month = d.toLocaleDateString('en-GB', { month: 'long' });

    if (endDate && endDate !== date) {
      const ed = new Date(endDate + 'T12:00:00');
      const endDay = ed.getDate();
      const endMonth = ed.toLocaleDateString('en-GB', { month: 'long' });
      parts.push(month === endMonth
        ? `${ordinal(day)} - ${ordinal(endDay)} ${month}`
        : `${ordinal(day)} ${month} - ${ordinal(endDay)} ${endMonth}`
      );
    } else {
      parts.push(`${ordinal(day)} ${month}`);
    }
  }

  // For multi-day crewed jobs, skip time and venue in the note
  if (!isMultiDay) {
    if (time) parts.push(time);
    if (venue) parts.push(venue);
  }

  return parts.join(' - ');
}

const HEADER_KEYWORDS = ['crew', 'transport', 'delivery', 'collection'];

async function findOrCreateHeader(hhJobId: string): Promise<string> {
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
  const token = process.env.HIREHOP_API_TOKEN!;

  // Fetch existing items to find a header
  const itemsRes = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: 10 }) as any;
  const items = Array.isArray(itemsRes) ? itemsRes : (itemsRes?.items || []);

  const headers = items.filter((i: any) => i.kind === '0' && (!i.parent || i.parent === '0'));
  for (const header of headers) {
    const name = (header.NAME || header.title || '').toLowerCase();
    if (HEADER_KEYWORDS.some(kw => name.includes(kw))) {
      return header.ID;
    }
  }

  // Create header
  const params = new URLSearchParams({
    job: hhJobId, kind: '0', id: '0', name: 'Crew & transport', qty: '0', parent: '0', token,
  });
  const res = await fetch(`https://${domain}/php_functions/items_save.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const result = await res.json() as any;
  if (result.items?.[0]?.ID) return result.items[0].ID;
  throw new Error('Failed to create header in HireHop');
}

async function addItemToHireHop(
  hhJobId: string,
  listId: number,
  qty: number,
  price: number,
  note: string,
  headerId: string,
): Promise<{ success: boolean; error?: string }> {
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
  const token = process.env.HIREHOP_API_TOKEN!;

  try {
    // Step 1: Get items before
    const itemsBefore = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: 0 }) as any;
    const beforeItems = Array.isArray(itemsBefore) ? itemsBefore : (itemsBefore?.items || []);
    const existingIds = new Set(beforeItems.map((i: any) => i.ID));

    // Step 2: Add the item
    const itemsToAdd = { [`c${listId}`]: qty };
    await hhBroker.post('/api/save_job.php', {
      job: hhJobId,
      items: JSON.stringify(itemsToAdd),
    }, { priority: 'high' });

    // Step 3: Find the new item
    await new Promise(r => setTimeout(r, 1000));
    const itemsAfter = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: 0 }) as any;
    const afterItems = Array.isArray(itemsAfter) ? itemsAfter : (itemsAfter?.items || []);
    const newItem = afterItems.find((i: any) => !existingIds.has(i.ID) && i.LIST_ID === String(listId) && i.kind === '4');

    if (!newItem) {
      return { success: false, error: 'Item added but could not find its ID' };
    }

    // Step 4: Edit item to set price, note, parent
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const editParams = new URLSearchParams({
      job: hhJobId, kind: '4', id: newItem.ID, list_id: String(listId),
      qty: String(qty), unit_price: String(price), price: String(price * qty),
      price_type: '0', add: note, cust_add: '', memo: '', name: '',
      parent: headerId, acc_nominal: '29', acc_nominal_po: '30',
      vat_rate: '0', value: '0', cost_price: '0', weight: '0',
      start: '', end: '', duration: '0', country_origin: '', hs_code: '',
      flag: '0', priority_confirm: '0', no_shortfall: '1', no_availability: '0',
      ignore: '0', local: now, token,
    });

    const editRes = await fetch(`https://${domain}/php_functions/items_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: editParams.toString(),
    });

    if (!editRes.ok) {
      return { success: false, error: `Edit step failed: HTTP ${editRes.status}` };
    }

    const editResult = await editRes.json() as any;
    if (editResult.error) {
      return { success: false, error: `Edit error: ${editResult.error}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

const pushHirehopSchema = z.object({
  quoteId: z.string().uuid().optional(), // Can also use URL param
});

router.post('/:id/push-hirehop', async (req: AuthRequest, res: Response) => {
  try {
    const quoteId = req.params.id;

    // Look up quote + job HH number
    const quoteRes = await query(
      `SELECT q.*, j.hh_job_number, j.job_name
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE q.id = $1 AND q.is_deleted = false`,
      [quoteId]
    );

    if (quoteRes.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const quote = quoteRes.rows[0];

    if (!quote.hh_job_number) {
      res.status(400).json({ error: 'Job has no HireHop number — cannot push' });
      return;
    }

    const hhJobId = String(quote.hh_job_number);
    const isLocal = quote.is_local;
    const isCrewed = quote.job_type === 'crewed';

    // Determine which HH stock item to add
    let listId: number;
    let qty: number;
    let price: number;
    let note: string;

    if (isLocal) {
      // Local D/C: use pre-priced item based on time window
      listId = getLocalItemId(quote.job_type, quote.arrival_time);
      qty = 1;
      price = 0; // HireHop has the price already
      note = buildItemNote(quote.job_date, null, quote.arrival_time, quote.venue_name || quote.linked_venue_name);
    } else if (isCrewed) {
      listId = LABOUR_ITEM_IDS['crew'];
      qty = quote.crew_count || 1;
      price = Math.round((quote.client_charge_rounded || 0) / (quote.crew_count || 1));
      const isMultiDay = quote.is_multi_day && quote.job_finish_date;
      const workTypeLabel = quote.work_type
        ? (quote.work_type === 'other' ? (quote.work_type_other || 'Crew') : quote.work_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))
        : 'Crew';
      note = buildItemNote(quote.job_date, quote.job_finish_date, quote.arrival_time, quote.venue_name, workTypeLabel, !!isMultiDay);
    } else {
      // D&C from calculator
      listId = LABOUR_ITEM_IDS[quote.job_type] || LABOUR_ITEM_IDS['delivery'];
      qty = 1;
      price = quote.client_charge_rounded || 0;
      note = buildItemNote(quote.job_date, quote.job_finish_date, quote.arrival_time, quote.venue_name);
    }

    // Find or create header
    const headerId = await findOrCreateHeader(hhJobId);

    // Add the item
    const result = await addItemToHireHop(hhJobId, listId, qty, price, note, headerId);

    if (!result.success) {
      console.error(`HireHop push failed for quote ${quoteId}:`, result.error);
      res.status(500).json({ error: result.error || 'Failed to push to HireHop' });
      return;
    }

    console.log(`[HH Push] Quote ${quoteId} → HH job ${hhJobId}: ${quote.job_type} item added (list=${listId}, qty=${qty}, price=${price})`);
    res.json({ success: true, hhJobId });
  } catch (error) {
    console.error('Push to HireHop error:', error);
    res.status(500).json({ error: 'Failed to push to HireHop' });
  }
});

export default router;
