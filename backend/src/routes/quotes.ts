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

const router = Router();
router.use(authenticate);

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
  internalNotes: z.string().optional().nullable(),
  freelancerNotes: z.string().optional().nullable(),
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

    const result = calculateCosts(calculatorInput, settings);

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
        settings_snapshot, internal_notes, freelancer_notes, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
        $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49
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
        req.user!.id,
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
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name
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

export default router;
