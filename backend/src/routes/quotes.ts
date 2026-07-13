import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  calculateCosts,
  applyCrewMultiplier,
  CalculatorSettings,
  CalculatorInput,
} from '../services/crew-transport-calculator';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';
import { shouldSuppressInformational } from '../services/portal-notification-prefs';

const router = Router();
router.use(authenticate);

// ── GET /api/quotes/ops/overview — operations overview (must be before /:id) ──

router.get('/ops/overview', async (req: AuthRequest, res: Response) => {
  try {
    const {
      job_type, ops_status, date_from, date_to, show_all,
      include_provisional, include_enquiry, include_lost, include_cancelled,
    } = req.query;

    let whereClause = 'WHERE q.is_deleted = false';
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

    // Job-stage filter: by default, only operational jobs (confirmed and
    // beyond, excluding lost / cancelled). Toggles widen to include
    // speculative or dead stages. The frontend uses pipeline_status +
    // job_status (returned in the SELECT below) to render speculative work
    // in its own sections, so headline stat chips stay scoped to
    // operational quotes. Quotes with no linked job (job_id IS NULL) are
    // always shown — they're local D&C entries with no pipeline status.
    //
    // Stage detection mirrors backline overview: prefer pipeline_status,
    // fall back to HH numeric status when pipeline_status is NULL (legacy
    // data pre-webhook).
    const stageOrClauses: string[] = [
      // Operational
      `(j.id IS NULL
        OR j.pipeline_status IN ('confirmed','prepping','prepped','dispatched','returned_incomplete','returned','completed')
        OR (j.pipeline_status IS NULL AND j.status IN (2,3,4,5,6,7,8,11)))`,
    ];
    if (include_provisional === 'true') {
      stageOrClauses.push(`(j.pipeline_status = 'provisional' OR (j.pipeline_status IS NULL AND j.status = 1))`);
    }
    if (include_enquiry === 'true') {
      stageOrClauses.push(`(j.pipeline_status IN ('new_enquiry','quoting','paused') OR (j.pipeline_status IS NULL AND j.status = 0))`);
    }
    if (include_lost === 'true') {
      stageOrClauses.push(`(j.pipeline_status = 'lost' OR (j.pipeline_status IS NULL AND j.status = 10))`);
    }
    if (include_cancelled === 'true') {
      stageOrClauses.push(`(j.pipeline_status = 'cancelled' OR (j.pipeline_status IS NULL AND j.status = 9))`);
    }
    whereClause += ` AND (${stageOrClauses.join(' OR ')})`;

    // Default window: last 14 days → forward. Keeps the payload small
    // as migrated history grows. Caller can override with ?date_from /
    // ?date_to, or ask for everything with ?show_all=1.
    if (date_from) {
      params.push(date_from);
      whereClause += ` AND q.job_date >= $${params.length}`;
    } else if (!show_all) {
      whereClause += ` AND q.job_date >= CURRENT_DATE - INTERVAL '14 days'`;
    }

    if (date_to) {
      params.push(date_to);
      whereClause += ` AND q.job_date <= $${params.length}`;
    }

    // Use effective_ops_status: if quote lifecycle status is cancelled, treat ops_status as cancelled too
    // This handles legacy data where status was set to cancelled without updating ops_status
    const result = await query(
      `SELECT q.*,
        CASE WHEN q.status = 'cancelled' THEN 'cancelled' ELSE COALESCE(q.ops_status, 'todo') END as effective_ops_status,
        j.job_name, j.hh_job_number, j.client_name, j.out_date, j.return_date,
        j.pipeline_status, j.status as job_status,
        v.name as linked_venue_name, v.address as venue_address, v.city as venue_city,
        rg.combined_freelancer_fee as run_combined_freelancer_fee,
        rg.combined_client_fee as run_combined_client_fee,
        rg.notes as run_notes,
        CONCAT(scp.first_name, ' ', scp.last_name) as status_changed_by_name,
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
       LEFT JOIN run_groups rg ON rg.id = q.run_group
       LEFT JOIN users scu ON scu.id = q.status_changed_by
       LEFT JOIN people scp ON scp.id = scu.person_id
       ${whereClause}
       ORDER BY
         CASE WHEN q.status = 'cancelled' THEN 7
           WHEN q.ops_status = 'todo' THEN 1
           WHEN q.ops_status = 'arranging' THEN 2
           WHEN q.ops_status = 'arranged' THEN 3
           WHEN q.ops_status = 'dispatched' THEN 4
           WHEN q.ops_status = 'arrived' THEN 5
           WHEN q.ops_status = 'completed' THEN 6
           WHEN q.ops_status = 'cancelled' THEN 7
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
  travelTimeMins: z.number().min(0).optional().nullable(),
  travelCost: z.number().min(0).optional().nullable(),
  dayRateOverride: z.number().optional().nullable(),
  clientRateOverride: z.number().optional().nullable(),
  applyMinHours: z.boolean().optional().nullable(),
  oohOverride: z.object({
    earlyStartMins: z.number(),
    lateFinishMins: z.number(),
  }).optional().nullable(),
  expenses: z.array(z.object({
    type: z.string(),
    description: z.string(),
    amount: z.number().min(0),
    // Legacy binary — optional now that chargeMode is the source of truth.
    includedInCharge: z.boolean().optional(),
    // Three-state: included | not_included | recharge (recharge = bill actual post-hire).
    chargeMode: z.enum(['included', 'not_included', 'recharge', 'na']).optional(),
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
  // Override the strict arrivalTime inherited from calculateSchema: on save the
  // time is OPTIONAL. A blank time is stored as NULL (renders "Time TBC", pushes
  // no time to HireHop) — the 09:00 default is applied only to the cost
  // calculation below, never to the stored value.
  arrivalTime: z.string().optional().nullable(),
});

// Does any expense line declare a post-hire recharge?
function quoteHasRechargeLine(expenses: unknown): boolean {
  return Array.isArray(expenses) && expenses.some((e) => (e as { chargeMode?: string })?.chargeMode === 'recharge');
}

// Insert one quote row. Used twice when creating delivery + collection siblings.
async function insertQuoteRow(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }> },
  body: any,
  jobType: 'delivery' | 'collection' | 'crewed',
  jobDate: string | null,
  arrivalTime: string | null,
  result: ReturnType<typeof calculateCosts>,
  settings: unknown,
  crewCount: number,
  isMultiDay: boolean,
  addCollection: boolean,
  collectionDate: string | null,
  collectionTime: string | null,
  userId: string,
): Promise<string> {
  const inserted = await client.query(
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
      body.jobId || null,
      jobType,
      body.calculationMode,
      body.venueName || null,
      body.venueId || null,
      body.distanceMiles,
      body.driveTimeMins,
      arrivalTime,
      jobDate,
      body.jobFinishDate || null,
      isMultiDay,
      body.workDurationHrs || null,
      body.numDays || null,
      body.setupExtraHrs || null,
      body.setupPremium || null,
      body.travelMethod,
      body.dayRateOverride || null,
      body.clientRateOverride || null,
      JSON.stringify(body.expenses || []),
      body.whatIsIt || null,
      addCollection,
      collectionDate,
      collectionTime,
      body.clientName || null,
      body.includesSetup || false,
      body.setupDescription || null,
      body.workType || null,
      body.workDescription || null,
      body.oohManual || false,
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
      body.internalNotes || null,
      body.freelancerNotes || null,
      body.travelTimeMins || null,
      body.travelCost || null,
      userId,
      crewCount,
    ],
  );
  return inserted.rows[0].id;
}

router.post('/', validate(saveQuoteSchema), async (req: AuthRequest, res: Response) => {
  const dbClient = await (await import('../config/database')).getClient();
  try {
    const settings = await loadSettings();

    const baseInput: CalculatorInput = {
      jobType: req.body.jobType,
      calculationMode: req.body.calculationMode,
      distanceMiles: req.body.distanceMiles,
      driveTimeMins: req.body.driveTimeMins,
      // Costing only — the OOH split needs a time, so assume 09:00 when none was
      // entered. The STORED arrival_time (passed to insertQuoteRow below) keeps
      // the real null so the quote shows "Time TBC".
      arrivalTime: req.body.arrivalTime || '09:00',
      workDurationHrs: req.body.workDurationHrs,
      numDays: req.body.numDays,
      setupExtraHrs: req.body.setupExtraHrs,
      setupPremium: req.body.setupPremium,
      travelMethod: req.body.travelMethod,
      travelTimeMins: req.body.travelTimeMins ?? undefined,
      travelCost: req.body.travelCost ?? undefined,
      dayRateOverride: req.body.dayRateOverride,
      clientRateOverride: req.body.clientRateOverride,
      applyMinHours: req.body.applyMinHours ?? undefined,
      // Manual OOH override: reconstruct from the flat oohManual + early/late fields the
      // calculator sends. When oohManual is off, leave undefined so the engine auto-derives.
      oohOverride: req.body.oohManual
        ? {
            earlyStartMins: Number(req.body.earlyStartMins) || 0,
            lateFinishMins: Number(req.body.lateFinishMins) || 0,
          }
        : null,
      expenses: req.body.expenses || [],
    };

    const crewCount = (req.body.jobType === 'crewed' && req.body.crewCount > 1) ? req.body.crewCount : 1;
    const primarySingle = calculateCosts(baseInput, settings);
    const primaryResult = applyCrewMultiplier(primarySingle, crewCount);

    // "Add collection" turns a delivery into TWO quote rows: delivery + collection sibling.
    // Each leg is calculated independently (different arrival time → different OOH split).
    // We DON'T pass addCollection through to either row — they're now standalone quotes.
    const wantsCollectionSibling = !!req.body.addCollection
      && req.body.jobType === 'delivery'
      && !!req.body.collectionTime;

    await dbClient.query('BEGIN');

    const primaryId = await insertQuoteRow(
      dbClient,
      req.body,
      req.body.jobType,
      req.body.jobDate || null,
      req.body.arrivalTime || null,
      primaryResult,
      settings,
      crewCount,
      req.body.isMultiDay || false,
      false,                    // never store add_collection on the actual rows now
      null,
      null,
      req.user!.id,
    );

    let collectionId: string | null = null;
    if (wantsCollectionSibling) {
      const collectionInput: CalculatorInput = {
        ...baseInput,
        jobType: 'collection',
        arrivalTime: req.body.collectionTime,
      };
      const collectionResult = applyCrewMultiplier(calculateCosts(collectionInput, settings), crewCount);
      collectionId = await insertQuoteRow(
        dbClient,
        req.body,
        'collection',
        req.body.collectionDate || req.body.jobDate || null,
        req.body.collectionTime,
        collectionResult,
        settings,
        crewCount,
        false, // collection sibling is single-day even if delivery was multi-day
        false,
        null,
        null,
        req.user!.id,
      );

      // Link the pair both ways
      await dbClient.query(
        `UPDATE quotes SET paired_quote_id = $1 WHERE id = $2`,
        [collectionId, primaryId],
      );
      await dbClient.query(
        `UPDATE quotes SET paired_quote_id = $1 WHERE id = $2`,
        [primaryId, collectionId],
      );
    }

    // If any expense line is set to recharge post-hire, mark the job as a
    // recharge-running-costs job. Set-only — removing the last recharge line
    // doesn't auto-clear the mode (staff may already be logging costs against
    // it); the Tools-menu toggle is the off switch.
    if (req.body.jobId && quoteHasRechargeLine(req.body.expenses)) {
      await dbClient.query(
        `UPDATE jobs SET recharge_running_costs = true WHERE id = $1 AND recharge_running_costs = false`,
        [req.body.jobId],
      );
    }

    await dbClient.query('COMMIT');

    res.status(201).json({
      id: primaryId,
      paired_id: collectionId,
      ...primaryResult,
    });
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Save quote error:', error);
    res.status(500).json({ error: 'Failed to save quote' });
    return;
  } finally {
    dbClient.release();
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
        rg.combined_freelancer_fee as run_combined_freelancer_fee,
        rg.combined_client_fee as run_combined_client_fee,
        rg.notes as run_notes,
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name,
        CONCAT(scp.first_name, ' ', scp.last_name) as status_changed_by_name,
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
       LEFT JOIN users scu ON scu.id = q.status_changed_by
       LEFT JOIN people scp ON scp.id = scu.person_id
       LEFT JOIN run_groups rg ON rg.id = q.run_group
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
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name,
        CONCAT(scp.first_name, ' ', scp.last_name) as status_changed_by_name,
        j.pipeline_status, j.status as job_status
       FROM quotes q
       LEFT JOIN users u ON u.id = q.created_by
       LEFT JOIN people p ON p.id = u.person_id
       LEFT JOIN users scu ON scu.id = q.status_changed_by
       LEFT JOIN people scp ON scp.id = scu.person_id
       LEFT JOIN jobs j ON j.id = q.job_id
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
  what_is_it: z.union([z.enum(['vehicle', 'equipment', 'people']), z.literal('')]).optional().nullable().transform(v => v === '' ? null : v),
  work_type: z.string().optional().nullable(),
  work_description: z.string().optional().nullable(),
  crew_count: z.number().int().min(1).optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  freelancer_notes: z.string().optional().nullable(),
  client_charge_rounded: z.coerce.number().min(0).optional().nullable(),
  freelancer_fee_rounded: z.coerce.number().min(0).optional().nullable(),
  // Expense charge-mode edits (three-state). When present, the quote recalcs
  // from the new states — see the PUT handler.
  expenses: z.array(z.object({
    type: z.string(),
    description: z.string().optional().default(''),
    amount: z.number().min(0).optional().default(0),
    includedInCharge: z.boolean().optional(),
    chargeMode: z.enum(['included', 'not_included', 'recharge', 'na']).optional(),
  })).optional(),
});

router.put('/:id', validate(editQuoteSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Fetch existing quote + assignments for change detection
    const existing = await query(
      `SELECT q.id, q.calculation_mode, q.is_local, q.job_date, q.arrival_time,
              q.venue_name, q.venue_id, q.status,
              q.job_type, q.num_days, q.is_multi_day, q.crew_count,
              q.client_charge_rounded, q.freelancer_fee_rounded,
              j.job_name as linked_job_name, j.hh_job_number as linked_hh_job_number
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

    // Did the user change any field that affects the cost calculation?
    // If yes, we re-run calculateCosts() after persisting field changes and
    // overwrite the derived totals — the calculator is the source of truth
    // when inputs change. Pure note edits / venue tweaks skip the recalc.
    const calcAffectingFields = ['job_type', 'num_days', 'arrival_time', 'crew_count', 'is_multi_day'];
    let recalcNeeded = false;
    for (const f of calcAffectingFields) {
      if (fields[f] !== undefined) {
        const oldVal = oldQuote[f];
        const oldComparable = oldVal instanceof Date ? oldVal.toISOString().split('T')[0] : oldVal;
        if (fields[f] !== oldComparable) {
          recalcNeeded = true;
          break;
        }
      }
    }
    // Local D&C quotes don't have calculator inputs — skip recalc for them
    if (oldQuote.is_local) recalcNeeded = false;

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${idx}`);
        // Store empty strings as null for nullable fields
        params.push(fields[field] === '' ? null : fields[field]);
        idx++;
      }
    }

    // Expense charge-mode edits — persist the JSONB and force a recalc so the
    // client total (recharge lines drop out) + the recharge flag reflect the new
    // states. Local quotes have no calculator expenses, so skip.
    if (!oldQuote.is_local && fields.expenses !== undefined) {
      updates.push(`expenses = $${idx}`);
      params.push(JSON.stringify(fields.expenses));
      idx++;
      recalcNeeded = true;
    }

    // Fee overrides (available for all quote types). A posted fee only counts
    // as an override when it DIFFERS from the stored value — the edit form
    // echoes the loaded figures back on every save, and an unchanged echo must
    // not pin a fee against a recalc. Genuine overrides survive the recalc
    // (re-applied after it below): editing the fee and editing the expenses
    // are independent intents. Pre-Jul-2026 this was gated on `!recalcNeeded`,
    // which silently DROPPED fee edits whenever `expenses` was posted alongside
    // (the modal always sent it) — the "fee reverts on save" bug.
    const clientFeeOverride =
      fields.client_charge_rounded !== undefined && fields.client_charge_rounded !== null &&
      Number(fields.client_charge_rounded) !== Number(oldQuote.client_charge_rounded ?? 0)
        ? Number(fields.client_charge_rounded)
        : null;
    const freelancerFeeOverride =
      fields.freelancer_fee_rounded !== undefined && fields.freelancer_fee_rounded !== null &&
      Number(fields.freelancer_fee_rounded) !== Number(oldQuote.freelancer_fee_rounded ?? 0)
        ? Number(fields.freelancer_fee_rounded)
        : null;

    if (!recalcNeeded) {
      if (clientFeeOverride !== null) {
        updates.push(`client_charge_rounded = $${idx}, client_charge_total = $${idx}`);
        params.push(clientFeeOverride);
        idx++;
      }
      if (freelancerFeeOverride !== null) {
        updates.push(`freelancer_fee_rounded = $${idx}, freelancer_fee = $${idx}`);
        params.push(freelancerFeeOverride);
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

    let updatedQuote = result.rows[0];

    // Recalc derived totals from the post-update calculator inputs.
    // Note: we do NOT clear hh_pushed_at — the line item still exists in HH at
    // the old price, and the frontend uses hh_pushed_at to flag that.
    if (recalcNeeded && updatedQuote) {
      const settings = await loadSettings();
      const reInput: CalculatorInput = {
        jobType: updatedQuote.job_type,
        calculationMode: updatedQuote.calculation_mode,
        distanceMiles: Number(updatedQuote.distance_miles) || 0,
        driveTimeMins: Number(updatedQuote.drive_time_mins) || 0,
        arrivalTime: updatedQuote.arrival_time || '09:00',
        workDurationHrs: Number(updatedQuote.work_duration_hrs) || 0,
        numDays: Number(updatedQuote.num_days) || 1,
        setupExtraHrs: Number(updatedQuote.setup_extra_hrs) || 0,
        setupPremium: Number(updatedQuote.setup_premium) || 0,
        travelMethod: updatedQuote.travel_method || 'vehicle',
        travelTimeMins: updatedQuote.travel_time_mins != null ? Number(updatedQuote.travel_time_mins) : undefined,
        travelCost: updatedQuote.travel_cost != null ? Number(updatedQuote.travel_cost) : undefined,
        dayRateOverride: updatedQuote.day_rate_override != null ? Number(updatedQuote.day_rate_override) : undefined,
        clientRateOverride: updatedQuote.client_rate_override != null ? Number(updatedQuote.client_rate_override) : undefined,
        // Preserve a manually-set OOH override across edits (apply_min_hours isn't persisted,
        // so the min-hours floor falls back to the engine default on recalc).
        oohOverride: updatedQuote.ooh_manual
          ? {
              earlyStartMins: Number(updatedQuote.early_start_mins) || 0,
              lateFinishMins: Number(updatedQuote.late_finish_mins) || 0,
            }
          : null,
        expenses: Array.isArray(updatedQuote.expenses) ? updatedQuote.expenses : (updatedQuote.expenses ? JSON.parse(updatedQuote.expenses) : []),
      };
      // Editing in a recharge line flags the job (set-only, mirrors create).
      if (updatedQuote.job_id && quoteHasRechargeLine(reInput.expenses)) {
        await query(
          `UPDATE jobs SET recharge_running_costs = true WHERE id = $1 AND recharge_running_costs = false`,
          [updatedQuote.job_id],
        );
      }
      const newCrewCount = (reInput.jobType === 'crewed' && Number(updatedQuote.crew_count) > 1) ? Number(updatedQuote.crew_count) : 1;
      const recalc = applyCrewMultiplier(calculateCosts(reInput, settings), newCrewCount);
      const recalcUpdate = await query(
        `UPDATE quotes SET
           client_charge_labour = $1, client_charge_fuel = $2, client_charge_expenses = $3,
           client_charge_total = $4, client_charge_rounded = $5,
           freelancer_fee = $6, freelancer_fee_rounded = $7,
           expected_fuel_cost = $8, expenses_included = $9, expenses_not_included = $10,
           our_total_cost = $11, our_margin = $12,
           estimated_time_mins = $13, estimated_time_hrs = $14,
           early_start_mins = $15, late_finish_mins = $16,
           updated_at = NOW()
         WHERE id = $17 AND is_deleted = false RETURNING *`,
        [
          recalc.clientChargeLabour, recalc.clientChargeFuel, recalc.clientChargeExpenses,
          recalc.clientChargeTotal, recalc.clientChargeTotalRounded,
          recalc.freelancerFee, recalc.freelancerFeeRounded,
          recalc.expectedFuelCost, recalc.expensesIncluded, recalc.expensesNotIncluded,
          recalc.ourTotalCost, recalc.ourMargin,
          recalc.estimatedTimeMinutes, recalc.estimatedTimeHours,
          recalc.autoEarlyStartMinutes, recalc.autoLateFinishMinutes,
          req.params.id,
        ]
      );
      updatedQuote = recalcUpdate.rows[0] || updatedQuote;

      // Re-apply explicit fee overrides ON TOP of the recalc output. The
      // recalc owns every derived figure EXCEPT a fee the user actually typed
      // — without this, a fee edit saved together with expenses gets clobbered
      // by the calculator reproducing the original figure.
      if (clientFeeOverride !== null || freelancerFeeOverride !== null) {
        const ovUpdates: string[] = [];
        const ovParams: unknown[] = [];
        let ovIdx = 1;
        if (clientFeeOverride !== null) {
          ovUpdates.push(`client_charge_rounded = $${ovIdx}, client_charge_total = $${ovIdx}`);
          ovParams.push(clientFeeOverride);
          ovIdx++;
        }
        if (freelancerFeeOverride !== null) {
          ovUpdates.push(`freelancer_fee_rounded = $${ovIdx}, freelancer_fee = $${ovIdx}`);
          ovParams.push(freelancerFeeOverride);
          ovIdx++;
        }
        ovParams.push(req.params.id);
        const ovResult = await query(
          `UPDATE quotes SET ${ovUpdates.join(', ')}, updated_at = NOW()
           WHERE id = $${ovIdx} AND is_deleted = false RETURNING *`,
          ovParams
        );
        updatedQuote = ovResult.rows[0] || updatedQuote;
      }
    }

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
      const quoteId = String(req.params.id);
      (async () => {
        try {
          const assignees = await query(
            `SELECT qa.person_id, p.first_name, p.last_name, p.email
             FROM quote_assignments qa
             JOIN people p ON p.id = qa.person_id
             WHERE qa.quote_id = $1 AND qa.status NOT IN ('declined', 'cancelled')
               AND p.email IS NOT NULL`,
            [quoteId]
          );

          const jobName = oldQuote.linked_job_name || oldQuote.job_name || 'a job';
          const formattedDate = updatedQuote.job_date
            ? new Date(updatedQuote.job_date).toLocaleDateString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
              })
            : 'TBC';
          for (const crew of assignees.rows) {
            // Informational notification — respect global / per-job mute.
            const { suppress } = await shouldSuppressInformational(crew.person_id, quoteId);
            if (suppress) continue;
            const portalBase = (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
            const portalUrl = `${portalBase}/job/${quoteId}`;
            try {
              await emailService.send('job_change_notification', {
                to: crew.email,
                variables: {
                  freelancerName: crew.first_name || 'there',
                  jobName,
                  jobNumber: String(oldQuote.linked_hh_job_number || ''),
                  jobDate: formattedDate,
                  venueName: updatedQuote.venue_name || 'TBC',
                  changeDescription: keyFieldsChanged.join('. '),
                  portalUrl,
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

    // Capture old status so we can detect draft → confirmed transitions
    // and fire freelancer_assignment emails for pre-existing assignees.
    const oldStatusResult = await query(
      `SELECT status FROM quotes WHERE id = $1 AND is_deleted = false`,
      [req.params.id]
    );
    const oldStatus = oldStatusResult.rows[0]?.status;

    // When cancelling a quote, also set ops_status to cancelled so it appears in the cancelled group on Transport Ops
    const opsStatusClause = status === 'cancelled' ? ', ops_status = \'cancelled\'' : '';
    // When restoring from cancelled (back to draft), reset ops_status to todo
    const restoreOpsClause = status === 'draft' ? ', ops_status = \'todo\'' : '';
    // When confirming a quote, bump ops_status from 'todo' to 'arranging' so the
    // Transport Ops overview reflects the commercial commitment. Leave alone if
    // already past todo (e.g. already arranging/arranged/dispatched).
    const confirmOpsBump =
      status === 'confirmed' ? `, ops_status = CASE WHEN ops_status = 'todo' THEN 'arranging' ELSE ops_status END` : '';
    // When completing a quote, also mark ops as completed (Transport Ops and
    // Job Detail stay aligned).
    const completeOpsBump = status === 'completed' ? `, ops_status = 'completed', completed_at = NOW()` : '';
    const result = await query(
      `UPDATE quotes
       SET status = $1, status_changed_at = NOW(), status_changed_by = $2,
           cancelled_reason = $3, updated_at = NOW()${opsStatusClause}${restoreOpsClause}${confirmOpsBump}${completeOpsBump}
       WHERE id = $4 AND is_deleted = false
       RETURNING id, status, ops_status`,
      [status, req.user!.id, status === 'cancelled' ? (cancelledReason || null) : null, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    // Fire freelancer_assignment email when a quote is confirmed for any
    // already-assigned freelancers. This covers: (a) staff assigned crew
    // during draft, then confirmed later; (b) quote reopened (draft) then
    // re-confirmed. We dedup on assignment.confirmed_at timestamp set below.
    if (status === 'confirmed' && oldStatus !== 'confirmed') {
      (async () => {
        try {
          const assignees = await query(
            `SELECT qa.id AS assignment_id, qa.role, qa.agreed_rate, qa.rate_type,
                    p.id AS person_id, p.first_name, p.email, p.is_freelancer,
                    q.job_date, q.venue_name, j.job_name, j.hh_job_number
             FROM quote_assignments qa
             JOIN people p ON p.id = qa.person_id
             JOIN quotes q ON q.id = qa.quote_id
             LEFT JOIN jobs j ON j.id = q.job_id
             WHERE qa.quote_id = $1
               AND qa.status NOT IN ('declined', 'cancelled')
               AND qa.confirmed_at IS NULL
               AND qa.is_ooosh_crew = false
               AND p.is_freelancer = true
               AND p.email IS NOT NULL`,
            [req.params.id]
          );
          for (const a of assignees.rows) {
            // Informational notification — respect global / per-job mute.
            const { suppress } = await shouldSuppressInformational(a.person_id, String(req.params.id));
            if (suppress) {
              // Still flag confirmed_at so we don't re-send if mute later expires
              // and the quote bounces draft → confirmed again.
              await query(
                `UPDATE quote_assignments SET confirmed_at = NOW() WHERE id = $1`,
                [a.assignment_id]
              );
              continue;
            }
            const freelancerName = (a.first_name || '').trim() || 'there';
            const jobName = a.job_name || a.venue_name || 'a job';
            const jobDate = a.job_date
              ? new Date(a.job_date).toLocaleDateString('en-GB', {
                  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                })
              : 'TBC';
            const rateDisplay = a.agreed_rate
              ? `£${Number(a.agreed_rate).toFixed(2)}${a.rate_type === 'hourly' ? '/hr' : a.rate_type === 'dayrate' ? ' per day' : ''}`
              : 'To be confirmed';
            const portalBase = (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
            const portalUrl = `${portalBase}/job/${req.params.id}`;
            try {
              await emailService.send('freelancer_assignment', {
                to: a.email,
                variables: { freelancerName, jobName, jobNumber: String(a.hh_job_number || ''), jobDate, role: a.role || 'Crew', rate: rateDisplay, portalUrl },
              });
              // Record that we've notified so we don't re-send on re-confirm
              await query(
                `UPDATE quote_assignments SET confirmed_at = NOW() WHERE id = $1`,
                [a.assignment_id]
              );
            } catch (emailErr) {
              console.error(`freelancer_assignment to ${a.email} failed:`, emailErr);
            }
          }
        } catch (err) {
          console.error('Failed to notify assignees on quote confirmation:', err);
        }
      })();
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

// ── GET /api/quotes/job/:jobId/ooosh-crew ───────────────────────────
// Returns crew members assigned across the job's quotes — used by the Van &
// Driver soft book-out picker. Accepts OP job UUID or HireHop job number.
//
// We deliberately don't filter by qa.is_ooosh_crew=true: that flag is
// auto-set when crew is added via specific entry points (the freelancer-
// portal-flagged path, line ~1397 in this file, and the ops staff pickup
// path) but NOT when crew is added via the standard "+ Assign" button on a
// quote — which is the most common path. For a Van & Driver hire, anyone
// on the job's crew list is implicitly Ooosh-supplied (the whole point is
// we're providing the driver). Filtering by the flag was hiding crew that
// staff had clearly assigned for the job. We surface everyone non-cancelled
// and let the picker UI choose; is_ooosh_crew is returned in the payload
// so the picker can mark Ooosh-flagged crew if it wants to.

router.get('/job/:jobId/ooosh-crew', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const jobIdStr = Array.isArray(jobId) ? jobId[0]! : jobId!;
    const isUuid = /^[0-9a-f]{8}-/.test(jobIdStr);
    const jobLookup = await query(
      isUuid
        ? `SELECT id FROM jobs WHERE id = $1`
        : `SELECT id FROM jobs WHERE hh_job_number = $1`,
      [isUuid ? jobIdStr : parseInt(jobIdStr, 10)]
    );
    if (jobLookup.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const opJobId = jobLookup.rows[0]!.id;

    // DISTINCT on person_id — same person could be on multiple quotes for the
    // same job; we only need them once in the picker. Sort is_ooosh_crew=true
    // ones first so flagged crew lead the picker, then by recency.
    const result = await query(
      `SELECT DISTINCT ON (p.id)
         p.id AS person_id,
         p.first_name, p.last_name, p.email, p.mobile,
         p.is_freelancer, p.is_approved,
         qa.role, qa.is_ooosh_crew, qa.id AS quote_assignment_id, qa.quote_id
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       JOIN people p ON p.id = qa.person_id
       WHERE q.job_id = $1
         AND COALESCE(qa.status, 'assigned') NOT IN ('declined', 'cancelled')
         AND COALESCE(q.is_deleted, false) = false
       ORDER BY p.id, qa.is_ooosh_crew DESC NULLS LAST, qa.created_at DESC`,
      [opJobId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('List Ooosh crew for job error:', error);
    res.status(500).json({ error: 'Failed to load Ooosh crew' });
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

    // Check if assignment already exists — if so, this is an edit, not a fresh assignment
    const existing = await query(
      `SELECT id FROM quote_assignments WHERE quote_id = $1 AND person_id = $2`,
      [req.params.id, personId]
    );
    const isNewAssignment = existing.rows.length === 0;

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

    // Fire-and-forget freelancer_assignment email for new assignments on confirmed
    // quotes where the person is a freelancer with an email on file.
    if (isNewAssignment) {
      (async () => {
        try {
          const ctx = await query(
            `SELECT p.first_name, p.last_name, p.email, p.is_freelancer,
                    q.status AS quote_status, q.job_date, q.arrival_time,
                    q.venue_name, q.job_type,
                    j.job_name, j.hh_job_number
             FROM people p
             CROSS JOIN quotes q
             LEFT JOIN jobs j ON j.id = q.job_id
             WHERE p.id = $1 AND q.id = $2`,
            [personId, req.params.id]
          );
          if (ctx.rows.length === 0) return;
          const row = ctx.rows[0];
          if (!row.is_freelancer || !row.email) return;
          if (row.quote_status !== 'confirmed') return;

          // Informational notification — respect global / per-job mute.
          const { suppress } = await shouldSuppressInformational(personId, String(req.params.id));
          if (suppress) return;

          const freelancerName = (row.first_name || '').trim() || 'there';
          const jobName = row.job_name || row.venue_name || 'a job';
          const jobDate = row.job_date
            ? new Date(row.job_date).toLocaleDateString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
              })
            : 'TBC';
          const rateDisplay = agreedRate
            ? `£${Number(agreedRate).toFixed(2)}${rateType === 'hourly' ? '/hr' : rateType === 'dayrate' ? ' per day' : ''}`
            : 'To be confirmed';

          const portalBase = (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
          const portalUrl = `${portalBase}/job/${req.params.id}`;
          await emailService.send('freelancer_assignment', {
            to: row.email,
            variables: {
              freelancerName,
              jobName,
              jobNumber: String(row.hh_job_number || ''),
              jobDate,
              role: role || 'Crew',
              rate: rateDisplay,
              portalUrl,
            },
          });
        } catch (emailErr) {
          console.error('Failed to send freelancer_assignment email:', emailErr);
        }
      })();
    }

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

    // Auto-sync commercial status with operational progress.
    // - Moving ops into arranging/arranged/dispatched/arrived on a still-draft
    //   quote implies we've committed to the job → confirm it.
    // - Moving ops to 'completed' also completes the commercial quote if it
    //   wasn't already, so Job Detail's Crew & Transport card stops showing
    //   a still-active "Complete" button after the portal completion.
    // - Moving ops to 'cancelled' also cancels the commercial quote.
    if (['arranging', 'arranged', 'dispatched', 'arrived'].includes(ops_status)) {
      updates.push(`status = CASE WHEN status = 'draft' THEN 'confirmed' ELSE status END`);
      updates.push(`status_changed_at = CASE WHEN status = 'draft' THEN NOW() ELSE status_changed_at END`);
      updates.push(`status_changed_by = CASE WHEN status = 'draft' THEN $${params.length + 1} ELSE status_changed_by END`);
      params.push(req.user!.id);
    } else if (ops_status === 'completed') {
      updates.push(`status = CASE WHEN status IN ('draft', 'confirmed') THEN 'completed' ELSE status END`);
      updates.push(`status_changed_at = CASE WHEN status IN ('draft', 'confirmed') THEN NOW() ELSE status_changed_at END`);
      updates.push(`status_changed_by = CASE WHEN status IN ('draft', 'confirmed') THEN $${params.length + 1} ELSE status_changed_by END`);
      params.push(req.user!.id);
    } else if (ops_status === 'cancelled') {
      updates.push(`status = CASE WHEN status IN ('draft', 'confirmed') THEN 'cancelled' ELSE status END`);
      updates.push(`status_changed_at = CASE WHEN status IN ('draft', 'confirmed') THEN NOW() ELSE status_changed_at END`);
      updates.push(`status_changed_by = CASE WHEN status IN ('draft', 'confirmed') THEN $${params.length + 1} ELSE status_changed_by END`);
      params.push(req.user!.id);
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE quotes SET ${updates.join(', ')} WHERE id = $${params.length} AND is_deleted = false RETURNING id, ops_status, status`,
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

// ── POST /api/quotes/:id/complete-override ─────────────────────────
// Manager/admin fallback when the freelancer portal can't be used (driver
// vanished, portal malfunction, catching up legacy data). The primary path
// is the portal — photos, signature, notes on site. Here we just capture
// WHY we're bypassing it and log to the job timeline.

const completeOverrideSchema = z.object({
  reason: z.string().min(10, 'Please give a bit more detail about why you are completing this here.'),
  notes: z.string().optional().nullable(),
});

router.post(
  '/:id/complete-override',
  authorize('admin', 'manager'),
  validate(completeOverrideSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { reason, notes } = req.body as { reason: string; notes?: string | null };
      const quoteId = req.params.id;

      const quoteResult = await query(
        `SELECT q.id, q.job_id, q.status, q.ops_status, q.venue_name, j.job_name
         FROM quotes q
         LEFT JOIN jobs j ON j.id = q.job_id
         WHERE q.id = $1 AND q.is_deleted = false`,
        [quoteId]
      );
      if (quoteResult.rows.length === 0) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }
      const quote = quoteResult.rows[0];

      const prefix = `[OP OVERRIDE – ${reason.trim()}]`;
      const combined = notes && notes.trim()
        ? `${prefix} ${notes.trim()}`
        : prefix;

      await query(
        `UPDATE quotes SET
           ops_status = 'completed',
           status = CASE WHEN status IN ('draft', 'confirmed') THEN 'completed' ELSE status END,
           status_changed_at = CASE WHEN status IN ('draft', 'confirmed') THEN NOW() ELSE status_changed_at END,
           status_changed_by = CASE WHEN status IN ('draft', 'confirmed') THEN $1 ELSE status_changed_by END,
           completed_at = NOW(),
           completed_by = $2,
           completion_notes = $3,
           updated_at = NOW()
         WHERE id = $4`,
        [req.user!.id, req.user!.email, combined, quoteId]
      );

      // Mark this user's assignment completed; leave others untouched
      // (staff override doesn't know which crew member actually did it).
      await query(
        `UPDATE quote_assignments
         SET status = 'completed', updated_at = NOW()
         WHERE quote_id = $1 AND status NOT IN ('declined', 'cancelled', 'completed')`,
        [quoteId]
      );

      // Timeline log on the linked job (skip for local quotes with no job).
      if (quote.job_id) {
        const venueLabel = quote.venue_name || quote.job_name || 'quote';
        await query(
          `INSERT INTO interactions (type, content, job_id, created_by, source)
           VALUES ('status_transition', $1, $2, $3, 'system')`,
          [
            `Transport quote manually marked complete (${venueLabel}) — reason: ${reason.trim()}` +
              (notes && notes.trim() ? `. Notes: ${notes.trim()}` : ''),
            quote.job_id,
            req.user!.id,
          ]
        );
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Complete override error:', error);
      res.status(500).json({ error: 'Failed to complete quote' });
    }
  }
);

// ── POST /api/quotes/:id/nudge-completion ──────────────────────────
// Staff-initiated reminder nudge to an assigned freelancer. Independent
// of the auto scheduler's reminder ladder (doesn't bump
// completion_reminder_level). Used from the completion-override modal
// before staff decide to bypass the portal.

const nudgeSchema = z.object({
  personId: z.string().uuid(),
});

router.post(
  '/:id/nudge-completion',
  validate(nudgeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { personId } = req.body as { personId: string };
      const quoteId = req.params.id;

      const result = await query(
        `SELECT q.id AS quote_id, q.job_type, q.venue_name, q.job_date, q.arrival_time,
                p.id AS person_id, p.email AS person_email,
                p.first_name, p.last_name,
                j.job_name
         FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id
         JOIN people p ON p.id = qa.person_id
         LEFT JOIN jobs j ON j.id = q.job_id
         WHERE qa.quote_id = $1 AND qa.person_id = $2
           AND q.is_deleted = false
           AND qa.is_ooosh_crew = false
         LIMIT 1`,
        [quoteId, personId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assignment not found or is Ooosh Staff' });
        return;
      }
      const row = result.rows[0];
      if (!row.person_email) {
        res.status(400).json({ error: 'Assigned freelancer has no email on file' });
        return;
      }

      const firstName = (row.first_name || '').trim() || 'there';
      const venueName = row.venue_name || 'the venue';
      const jobName = row.job_name || row.venue_name || 'your job';
      const portalBase = (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
      const portalUrl = `${portalBase}/job/${quoteId}/complete`;

      await emailService.sendRaw({
        to: row.person_email,
        subject: `Quick nudge — please complete ${jobName}`,
        html: `
          <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">One last thing</h2>
          <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
            Just checking in — could you finish off your ${row.job_type || 'job'}
            at <strong>${venueName}</strong> in the portal when you've got a moment?
            Photos, signature, any notes and you're done.
          </p>
          <p style="margin:0 0 20px;">
            <a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Complete job</a>
          </p>
          <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">
            Any questions: <a href="mailto:info@oooshtours.co.uk" style="color:#7B5EA7;">info@oooshtours.co.uk</a>.
          </p>
        `,
        variant: 'internal',
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Nudge completion error:', error);
      res.status(500).json({ error: 'Failed to send nudge' });
    }
  }
);

// ── PUT /api/quotes/:id/ops-details — update arranging/ops fields ───

const opsDetailsSchema = z.object({
  // key_points was dropped in migration 079 — content backfilled into freelancer_notes
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
  freelancerNotes: z.string().optional().nullable(),
  whatIsIt: z.enum(['vehicle', 'equipment', 'people']).optional().nullable(),
});

router.post('/local', validate(localQuoteSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, jobType, jobDate, arrivalTime, venueId, venueName, fee, clientCharge, notes, freelancerNotes, whatIsIt } = req.body;
    const feeVal = fee || 0;
    const chargeVal = clientCharge || feeVal;

    const result = await query(
      `INSERT INTO quotes (
        job_id, job_type, is_local, calculation_mode,
        venue_id, venue_name, job_date, arrival_time,
        freelancer_fee, freelancer_fee_rounded,
        client_charge_total, client_charge_rounded,
        what_is_it, internal_notes, freelancer_notes,
        distance_miles, drive_time_mins,
        created_by
      ) VALUES ($1, $2, true, 'fixed', $3, $4, $5, $6, $7, $7, $8, $8, $9, $10, $11, 0, 0, $12)
      RETURNING id`,
      [
        jobId, jobType, venueId || null, venueName || null,
        jobDate || null, arrivalTime || null,
        feeVal, chargeVal,
        whatIsIt || null, notes || null, freelancerNotes || null,
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

// ── PUT /api/quotes/:id/run-group — attach/detach a quote to a run ───
//
// Accepts an existing run_groups.id OR null (to ungroup). If the UUID
// doesn't exist yet (legacy clients mint their own and PUT it), we
// upsert a blank run_groups row so the FK resolves — this keeps
// backward compat with the existing Transport Ops UI that calls
// crypto.randomUUID() client-side.

const runGroupSchema = z.object({
  run_group: z.string().uuid().nullable(),
  run_order: z.number().optional().nullable(),
  run_group_fee: z.number().optional().nullable(),
});

router.put('/:id/run-group', validate(runGroupSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { run_group, run_order, run_group_fee } = req.body;

    if (run_group) {
      await query(
        `INSERT INTO run_groups (id, run_date)
         SELECT $1, job_date::date FROM quotes WHERE id = $2
         ON CONFLICT (id) DO NOTHING`,
        [run_group, req.params.id]
      );
    }

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

// ── Run groups CRUD ─────────────────────────────────────────────────
//
// A run_group is a first-class entity with an optional combined fee
// that overrides the sum of per-quote fees. Grouping/ungrouping is
// non-destructive — individual quotes.freelancer_fee is never touched.

const createRunSchema = z.object({
  run_date: z.string().optional().nullable(),
  combined_freelancer_fee: z.number().optional().nullable(),
  combined_client_fee: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
  quote_ids: z.array(z.string().uuid()).optional(),
});

router.post('/runs', validate(createRunSchema), async (req: AuthRequest, res: Response) => {
  const client = await (await import('../config/database')).getClient();
  try {
    await client.query('BEGIN');
    const { run_date, combined_freelancer_fee, combined_client_fee, notes, quote_ids } = req.body;

    const runResult = await client.query(
      `INSERT INTO run_groups (run_date, combined_freelancer_fee, combined_client_fee, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, run_date, combined_freelancer_fee, combined_client_fee, notes, created_at`,
      [run_date || null, combined_freelancer_fee ?? null, combined_client_fee ?? null, notes || null, req.user!.id]
    );
    const run = runResult.rows[0];

    if (quote_ids && quote_ids.length > 0) {
      await client.query(
        `UPDATE quotes SET run_group = $1, updated_at = NOW()
         WHERE id = ANY($2::uuid[]) AND is_deleted = false`,
        [run.id, quote_ids]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(run);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create run group error:', error);
    res.status(500).json({ error: 'Failed to create run group' });
  } finally {
    client.release();
  }
});

const updateRunSchema = z.object({
  run_date: z.string().optional().nullable(),
  combined_freelancer_fee: z.number().optional().nullable(),
  combined_client_fee: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.patch('/runs/:runId', validate(updateRunSchema), async (req: AuthRequest, res: Response) => {
  try {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const key of ['run_date', 'combined_freelancer_fee', 'combined_client_fee', 'notes']) {
      if (key in req.body) {
        params.push(req.body[key] ?? null);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    params.push(req.params.runId);
    const result = await query(
      `UPDATE run_groups SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING id, run_date, combined_freelancer_fee, combined_client_fee, notes, updated_at`,
      params
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update run group error:', error);
    res.status(500).json({ error: 'Failed to update run group' });
  }
});

// Delete (ungroup): FK is ON DELETE SET NULL, so member quotes are
// ungrouped automatically and their standalone freelancer_fee values
// become visible again — non-destructive.
router.delete('/runs/:runId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM run_groups WHERE id = $1 RETURNING id`,
      [req.params.runId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete run group error:', error);
    res.status(500).json({ error: 'Failed to delete run group' });
  }
});

// Returns the run with its member quotes' standalone fees, so the UI
// can show "individual total would be £X, combined is £Y".
router.get('/runs/:runId', async (req: AuthRequest, res: Response) => {
  try {
    const runResult = await query(
      `SELECT id, run_date, combined_freelancer_fee, combined_client_fee, notes, created_at, updated_at
       FROM run_groups WHERE id = $1`,
      [req.params.runId]
    );
    if (runResult.rows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const quotesResult = await query(
      `SELECT id, job_id, job_type, job_date, arrival_time, run_order,
              freelancer_fee, freelancer_fee_rounded,
              client_charge_total, client_charge_rounded,
              venue_name
       FROM quotes WHERE run_group = $1 AND is_deleted = false
       ORDER BY run_order NULLS LAST, arrival_time NULLS LAST, created_at`,
      [req.params.runId]
    );
    const run = runResult.rows[0];
    const quotes = quotesResult.rows;
    const standaloneFreelancerTotal = quotes.reduce((s: number, q: Record<string, unknown>) =>
      s + Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0), 0);
    const standaloneClientTotal = quotes.reduce((s: number, q: Record<string, unknown>) =>
      s + Number(q.client_charge_rounded ?? q.client_charge_total ?? 0), 0);
    res.json({
      ...run,
      quotes,
      standalone_freelancer_total: standaloneFreelancerTotal,
      standalone_client_total: standaloneClientTotal,
    });
  } catch (error) {
    console.error('Get run group error:', error);
    res.status(500).json({ error: 'Failed to load run group' });
  }
});

// ── POST /api/quotes/:id/assignments/ooosh-crew — assign as Ooosh crew

router.post('/:id/assignments/ooosh-crew', async (req: AuthRequest, res: Response) => {
  try {
    // Attach the system "Ooosh Staff" person to this quote. Using a real
    // person_id (rather than NULL) keeps quote_assignments cleanly relational
    // and lets the portal's shared info@ account match through person_id like
    // any other person. ON CONFLICT for the rare case the quote already has
    // an Ooosh Staff assignment (quote_id, person_id is UNIQUE).
    const OOOSH_STAFF_ID = '00000000-0000-0000-0000-000000000001';
    const result = await query(
      `INSERT INTO quote_assignments (quote_id, person_id, role, is_ooosh_crew, created_by)
       VALUES ($1, $2, 'driver', true, $3)
       ON CONFLICT (quote_id, person_id) DO UPDATE
         SET is_ooosh_crew = true, updated_at = NOW()
       RETURNING id`,
      [req.params.id, OOOSH_STAFF_ID, req.user!.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Assign Ooosh staff error:', error);
    res.status(500).json({ error: 'Failed to assign Ooosh staff' });
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

function buildItemNote(date?: string | Date | null, endDate?: string | Date | null, time?: string | null, venue?: string | null, workType?: string | null, isMultiDay?: boolean): string {
  const parts: string[] = [];
  if (workType) parts.push(workType);

  const formatDate = (raw: string | Date): string => {
    // Coerce to string — PG may return Date objects
    const str = raw instanceof Date ? raw.toISOString() : String(raw || '');
    if (!str) return '';
    const dateOnly = str.includes('T') ? str.split('T')[0] : str;
    const d = new Date(dateOnly + 'T12:00:00');
    if (isNaN(d.getTime())) return str;
    const day = d.getDate();
    const month = d.toLocaleDateString('en-GB', { month: 'short' });
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  };

  if (date) {
    if (endDate && endDate !== date) {
      parts.push(`${formatDate(date)} - ${formatDate(endDate)}`);
    } else {
      parts.push(formatDate(date));
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
  // Fetch existing items to find a header — skip cache to avoid stale data causing duplicate headers
  const itemsRes = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as any;
  if (!itemsRes?.success) {
    console.error(`[HH findOrCreateHeader] Broker failed for job ${hhJobId}:`, itemsRes?.error);
    // If we can't read items, still try to create a header rather than failing entirely
  }
  const rawData = itemsRes?.data;
  // HH may return a plain array, or { items: [...] }, or { rows: [...] }
  const items = Array.isArray(rawData)
    ? rawData
    : (rawData?.items || rawData?.rows || []);

  console.log(`[HH findOrCreateHeader] Job ${hhJobId}: broker success=${itemsRes?.success}, rawData type=${typeof rawData}, isArray=${Array.isArray(rawData)}, items count=${items.length}, rawData keys=${rawData && typeof rawData === 'object' ? Object.keys(rawData).join(',') : 'N/A'}`);

  // Headers have kind 0 (may be string '0' or number 0) and no parent (top-level)
  const headers = items.filter((i: any) => String(i.kind) === '0' && (!i.parent || String(i.parent) === '0'));
  console.log(`[HH findOrCreateHeader] Job ${hhJobId}: found ${headers.length} top-level headers: ${headers.map((h: any) => `"${h.NAME || h.title || h.name || '?'}" (ID=${h.ID})`).join(', ')}`);
  for (const header of headers) {
    const name = (header.NAME || header.title || header.name || '').toLowerCase();
    if (HEADER_KEYWORDS.some(kw => name.includes(kw))) {
      console.log(`[HH findOrCreateHeader] Job ${hhJobId}: reusing existing header ID=${header.ID} name="${header.NAME || header.title || header.name}"`);
      return header.ID;
    }
  }

  // Create header — via broker so we get rate limiting + 327 retry
  const createRes = await hhBroker.post('/php_functions/items_save.php', {
    job: hhJobId, kind: 0, id: 0, name: 'Crew & transport', qty: 0, parent: 0,
  }, { priority: 'high' }) as any;
  if (!createRes?.success) {
    console.error(`[HH findOrCreateHeader] Job ${hhJobId}: header create broker call failed:`, createRes?.error);
    throw new Error(`Failed to create header in HireHop: ${createRes?.error || 'unknown error'}`);
  }
  const result = createRes.data;
  if (result?.items?.[0]?.ID) return result.items[0].ID;
  console.error(`[HH findOrCreateHeader] Job ${hhJobId}: header create returned unexpected shape:`, JSON.stringify(result));
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
  try {
    // Step 1: Get items before
    const itemsBefore = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as any;
    const beforeData = itemsBefore?.data;
    const beforeItems = Array.isArray(beforeData) ? beforeData : (beforeData?.items || beforeData?.rows || []);
    const existingIds = new Set(beforeItems.map((i: any) => i.ID));

    // Step 2: Add the item
    const itemsToAdd = { [`c${listId}`]: qty };
    const addResult = await hhBroker.post('/api/save_job.php', {
      job: hhJobId,
      items: JSON.stringify(itemsToAdd),
    }, { priority: 'high' });
    if (!addResult.success) {
      return { success: false, error: `Failed to add item to HH job: ${addResult.error}` };
    }

    // Step 3: Find the new item
    await new Promise(r => setTimeout(r, 1000));
    const itemsAfter = await hhBroker.get('/frames/items_to_supply_list.php', { job: hhJobId }, { priority: 'high', cacheTTL: -1 }) as any;
    const afterData = itemsAfter?.data;
    const afterItems = Array.isArray(afterData) ? afterData : (afterData?.items || afterData?.rows || []);
    const newItem = afterItems.find((i: any) => !existingIds.has(i.ID) && i.LIST_ID === String(listId) && i.kind === '4');

    if (!newItem) {
      return { success: false, error: 'Item added but could not find its ID' };
    }

    // Step 4: Edit item to set price, note, parent — via broker for rate limiting + 327 retry
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const editRes = await hhBroker.post('/php_functions/items_save.php', {
      job: hhJobId, kind: 4, id: newItem.ID, list_id: listId,
      qty, unit_price: price, price: price * qty,
      price_type: 0, add: note, cust_add: '', memo: '', name: '',
      parent: headerId, acc_nominal: 29, acc_nominal_po: 30,
      vat_rate: 0, value: 0, cost_price: 0, weight: 0,
      start: '', end: '', duration: 0, country_origin: '', hs_code: '',
      flag: 0, priority_confirm: 0, no_shortfall: 1, no_availability: 0,
      ignore: 0, local: now,
    }, { priority: 'high' }) as any;

    if (!editRes?.success) {
      return { success: false, error: `Edit step failed: ${editRes?.error || 'unknown error'}` };
    }

    const editResult = editRes.data;
    if (editResult?.error) {
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
      // Local D/C: use pre-priced item based on time window.
      // The edit step in addItemToHireHop overwrites HH's default price, so we
      // must pass the correct price explicitly from LOCAL_DC_ITEMS.
      listId = getLocalItemId(quote.job_type, quote.arrival_time);
      qty = 1;
      const localItem = (LOCAL_DC_ITEMS[quote.job_type] || LOCAL_DC_ITEMS['delivery']).find(i => i.id === listId);
      price = localItem?.price ?? 40;
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
      // Only show end date for multi-day quotes; single-day D&C should not display a date range
      const dcEndDate = quote.is_multi_day ? quote.job_finish_date : null;
      note = buildItemNote(quote.job_date, dcEndDate, quote.arrival_time, quote.venue_name);
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
    // Track that this quote has been pushed so the Edit Quote modal can warn
    // staff that subsequent edits won't update HH (we'd need to find + edit the
    // line item there manually, which we don't currently do).
    await query(`UPDATE quotes SET hh_pushed_at = NOW() WHERE id = $1`, [quoteId]);
    res.json({ success: true, hhJobId });
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('Push to HireHop error:', msg, error);
    res.status(500).json({ error: `Failed to push to HireHop: ${msg}` });
  }
});

export default router;
