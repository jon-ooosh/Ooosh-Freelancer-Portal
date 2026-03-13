/**
 * Vehicle Module Routes
 *
 * Native OP backend routes for fleet management and job data,
 * plus a catch-all proxy to Netlify for remaining VM functions.
 *
 * Route priority (top-to-bottom):
 *   1. /api/vehicles/fleet/*     — Fleet CRUD (reads from fleet_vehicles table)
 *   2. /api/vehicles/jobs/*      — Job data for VM (reads from OP jobs table, returns HireHopJob format)
 *   3. /api/vehicles/hirehop/*   — HireHop proxy (barcode checkout/checkin, status updates)
 *   4. /api/vehicles/:fn         — Netlify proxy catch-all (for remaining VM functions)
 */
import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { hireHopGet, hireHopPost, isHireHopConfigured } from '../config/hirehop';

const router = Router();
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════════
// 1. FLEET CRUD — /api/vehicles/fleet/*
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet
 * List all fleet vehicles. Supports filtering by fleet_group, hire_status, simple_type.
 * Returns data in the shape the VM's Vehicle interface expects.
 */
router.get('/fleet', async (req: AuthRequest, res: Response) => {
  try {
    const { group, hire_status, simple_type, include_inactive } = req.query;

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    // By default exclude inactive (old/sold) unless explicitly requested
    if (include_inactive !== 'true') {
      where += ' AND is_active = true';
    }

    if (group && (group as string) !== 'all') {
      params.push(group);
      where += ` AND fleet_group = $${params.length}`;
    }

    if (hire_status) {
      params.push(hire_status);
      where += ` AND hire_status = $${params.length}`;
    }

    if (simple_type) {
      params.push(simple_type);
      where += ` AND simple_type = $${params.length}`;
    }

    const result = await query(
      `SELECT * FROM fleet_vehicles ${where} ORDER BY reg ASC`,
      params
    );

    // Map DB rows to the VM's Vehicle interface shape
    const vehicles = result.rows.map(mapDbRowToVehicle);

    res.json({ data: vehicles });
  } catch (error) {
    console.error('[vehicles/fleet] List error:', error);
    res.status(500).json({ error: 'Failed to load fleet' });
  }
});

/**
 * GET /api/vehicles/fleet/:id
 * Get a single vehicle by ID or registration.
 */
router.get('/fleet/:idOrReg', async (req: AuthRequest, res: Response) => {
  try {
    const idOrReg = req.params.idOrReg as string;

    // Try UUID first, then registration
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrReg);
    const result = isUuid
      ? await query('SELECT * FROM fleet_vehicles WHERE id = $1', [idOrReg])
      : await query('SELECT * FROM fleet_vehicles WHERE reg = $1', [idOrReg.toUpperCase()]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    res.json(mapDbRowToVehicle(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/fleet] Detail error:', error);
    res.status(500).json({ error: 'Failed to load vehicle' });
  }
});

/**
 * POST /api/vehicles/fleet
 * Create a new vehicle.
 */
router.post('/fleet', async (req: AuthRequest, res: Response) => {
  try {
    const v = req.body;
    const result = await query(
      `INSERT INTO fleet_vehicles (
        reg, vehicle_type, simple_type, make, model, colour, seats,
        damage_status, service_status, hire_status,
        mot_due, tax_due, tfl_due, last_service_date, warranty_expires,
        last_service_mileage, next_service_due,
        ulez_compliant, spare_key, wifi_network,
        finance_with, finance_ends,
        co2_per_km, recommended_tyre_psi_front, recommended_tyre_psi_rear,
        fuel_type, mpg, fleet_group, is_active, monday_item_id, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20,
        $21, $22,
        $23, $24, $25,
        $26, $27, $28, $29, $30, $31
      ) RETURNING *`,
      [
        (v.reg || '').toUpperCase(), v.vehicle_type || v.vehicleType, v.simple_type || v.simpleType,
        v.make, v.model, v.colour, v.seats || null,
        v.damage_status || v.damageStatus || 'ALL GOOD',
        v.service_status || v.serviceStatus || 'OK',
        v.hire_status || v.hireStatus || 'Available',
        v.mot_due || v.motDue || null, v.tax_due || v.taxDue || null,
        v.tfl_due || v.tflDue || null, v.last_service_date || v.lastServiceDate || null,
        v.warranty_expires || v.warrantyExpires || null,
        v.last_service_mileage || v.lastServiceMileage || null,
        v.next_service_due || v.nextServiceDue || null,
        v.ulez_compliant ?? v.ulezCompliant ?? true,
        v.spare_key ?? v.spareKey ?? false,
        v.wifi_network || v.wifiNetwork || null,
        v.finance_with || v.financeWith || null,
        v.finance_ends || v.financeEnds || null,
        v.co2_per_km || v.co2PerKm || null,
        v.recommended_tyre_psi_front || v.recommendedTyrePsiFront || null,
        v.recommended_tyre_psi_rear || v.recommendedTyrePsiRear || null,
        v.fuel_type || v.fuelType || 'diesel',
        v.mpg || null,
        v.fleet_group || v.fleetGroup || 'active',
        v.is_active ?? v.isActive ?? true,
        v.monday_item_id || v.mondayItemId || null,
        v.notes || null,
      ]
    );

    res.status(201).json(mapDbRowToVehicle(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/fleet] Create error:', error);
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A vehicle with this registration already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});

/**
 * PUT /api/vehicles/fleet/:id
 * Update a vehicle.
 */
router.put('/fleet/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const v = req.body;

    // Build dynamic SET clause from provided fields
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      reg: 'reg', vehicle_type: 'vehicle_type', vehicleType: 'vehicle_type',
      simple_type: 'simple_type', simpleType: 'simple_type',
      make: 'make', model: 'model', colour: 'colour', seats: 'seats',
      damage_status: 'damage_status', damageStatus: 'damage_status',
      service_status: 'service_status', serviceStatus: 'service_status',
      hire_status: 'hire_status', hireStatus: 'hire_status',
      mot_due: 'mot_due', motDue: 'mot_due',
      tax_due: 'tax_due', taxDue: 'tax_due',
      tfl_due: 'tfl_due', tflDue: 'tfl_due',
      last_service_date: 'last_service_date', lastServiceDate: 'last_service_date',
      warranty_expires: 'warranty_expires', warrantyExpires: 'warranty_expires',
      last_service_mileage: 'last_service_mileage', lastServiceMileage: 'last_service_mileage',
      next_service_due: 'next_service_due', nextServiceDue: 'next_service_due',
      ulez_compliant: 'ulez_compliant', ulezCompliant: 'ulez_compliant',
      spare_key: 'spare_key', spareKey: 'spare_key',
      wifi_network: 'wifi_network', wifiNetwork: 'wifi_network',
      finance_with: 'finance_with', financeWith: 'finance_with',
      finance_ends: 'finance_ends', financeEnds: 'finance_ends',
      co2_per_km: 'co2_per_km', co2PerKm: 'co2_per_km',
      recommended_tyre_psi_front: 'recommended_tyre_psi_front', recommendedTyrePsiFront: 'recommended_tyre_psi_front',
      recommended_tyre_psi_rear: 'recommended_tyre_psi_rear', recommendedTyrePsiRear: 'recommended_tyre_psi_rear',
      fuel_type: 'fuel_type', fuelType: 'fuel_type',
      mpg: 'mpg', fleet_group: 'fleet_group', fleetGroup: 'fleet_group',
      is_active: 'is_active', isActive: 'is_active',
      notes: 'notes',
    };

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (v[key] !== undefined) {
        // Avoid duplicate columns
        if (!fields.some(f => f.startsWith(`${dbCol} =`))) {
          fields.push(`${dbCol} = $${idx}`);
          values.push(key === 'reg' ? String(v[key]).toUpperCase() : v[key]);
          idx++;
        }
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);
    const result = await query(
      `UPDATE fleet_vehicles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    res.json(mapDbRowToVehicle(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/fleet] Update error:', error);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

/**
 * PATCH /api/vehicles/fleet/by-reg/:reg/hire-status
 * Quick hire status update by registration plate.
 * Used by book-out (→ "On Hire") and check-in (→ "Prep Needed").
 */
router.patch('/fleet/by-reg/:reg/hire-status', async (req: AuthRequest, res: Response) => {
  try {
    const reg = (req.params.reg as string).toUpperCase();
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    const result = await query(
      'UPDATE fleet_vehicles SET hire_status = $1 WHERE reg = $2 RETURNING *',
      [status, reg]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: `Vehicle with reg ${reg} not found` });
      return;
    }

    console.log(`[vehicles/fleet] Hire status updated: ${reg} → ${status}`);
    res.json({ success: true, vehicle: mapDbRowToVehicle(result.rows[0]) });
  } catch (error) {
    console.error('[vehicles/fleet] Hire status update error:', error);
    res.status(500).json({ error: 'Failed to update hire status' });
  }
});

/**
 * POST /api/vehicles/fleet/bulk
 * Bulk upsert vehicles (for one-time Monday.com data import).
 */
router.post('/fleet/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicles } = req.body;
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      res.status(400).json({ error: 'vehicles array is required' });
      return;
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const v of vehicles) {
      try {
        const reg = (v.reg || '').toUpperCase();
        if (!reg) {
          errors.push('Skipped vehicle with no registration');
          continue;
        }

        const result = await query(
          `INSERT INTO fleet_vehicles (
            reg, vehicle_type, simple_type, make, model, colour, seats,
            damage_status, service_status, hire_status,
            mot_due, tax_due, tfl_due, last_service_date, warranty_expires,
            last_service_mileage, next_service_due,
            ulez_compliant, spare_key, wifi_network,
            finance_with, finance_ends,
            co2_per_km, recommended_tyre_psi_front, recommended_tyre_psi_rear,
            fuel_type, mpg, fleet_group, is_active, monday_item_id, notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17,
            $18, $19, $20,
            $21, $22,
            $23, $24, $25,
            $26, $27, $28, $29, $30, $31
          )
          ON CONFLICT (reg) DO UPDATE SET
            vehicle_type = EXCLUDED.vehicle_type,
            simple_type = EXCLUDED.simple_type,
            make = EXCLUDED.make,
            model = EXCLUDED.model,
            colour = EXCLUDED.colour,
            seats = EXCLUDED.seats,
            damage_status = EXCLUDED.damage_status,
            service_status = EXCLUDED.service_status,
            hire_status = EXCLUDED.hire_status,
            mot_due = EXCLUDED.mot_due,
            tax_due = EXCLUDED.tax_due,
            tfl_due = EXCLUDED.tfl_due,
            last_service_date = EXCLUDED.last_service_date,
            warranty_expires = EXCLUDED.warranty_expires,
            last_service_mileage = EXCLUDED.last_service_mileage,
            next_service_due = EXCLUDED.next_service_due,
            ulez_compliant = EXCLUDED.ulez_compliant,
            spare_key = EXCLUDED.spare_key,
            wifi_network = EXCLUDED.wifi_network,
            finance_with = EXCLUDED.finance_with,
            finance_ends = EXCLUDED.finance_ends,
            co2_per_km = EXCLUDED.co2_per_km,
            recommended_tyre_psi_front = EXCLUDED.recommended_tyre_psi_front,
            recommended_tyre_psi_rear = EXCLUDED.recommended_tyre_psi_rear,
            fuel_type = EXCLUDED.fuel_type,
            mpg = EXCLUDED.mpg,
            fleet_group = EXCLUDED.fleet_group,
            is_active = EXCLUDED.is_active,
            monday_item_id = EXCLUDED.monday_item_id,
            notes = EXCLUDED.notes
          RETURNING (xmax = 0) AS is_insert`,
          [
            reg, v.vehicleType || v.vehicle_type, v.simpleType || v.simple_type,
            v.make, v.model, v.colour, v.seats || null,
            v.damageStatus || v.damage_status || 'ALL GOOD',
            v.serviceStatus || v.service_status || 'OK',
            v.hireStatus || v.hire_status || 'Available',
            v.motDue || v.mot_due || null, v.taxDue || v.tax_due || null,
            v.tflDue || v.tfl_due || null, v.lastServiceDate || v.last_service_date || null,
            v.warrantyExpires || v.warranty_expires || null,
            v.lastServiceMileage || v.last_service_mileage || null,
            v.nextServiceDue || v.next_service_due || null,
            v.ulezCompliant ?? v.ulez_compliant ?? true,
            v.spareKey ?? v.spare_key ?? false,
            v.wifiNetwork || v.wifi_network || null,
            v.financeWith || v.finance_with || null,
            v.financeEnds || v.finance_ends || null,
            v.co2PerKm || v.co2_per_km || null,
            v.recommendedTyrePsiFront || v.recommended_tyre_psi_front || null,
            v.recommendedTyrePsiRear || v.recommended_tyre_psi_rear || null,
            v.fuelType || v.fuel_type || 'diesel',
            v.mpg || null,
            v.fleetGroup || v.fleet_group || 'active',
            v.isActive ?? v.is_active ?? true,
            v.mondayItemId || v.monday_item_id || v.id || null,
            v.notes || null,
          ]
        );

        if (result.rows[0].is_insert) {
          created++;
        } else {
          updated++;
        }
      } catch (err) {
        const reg = (v.reg || 'unknown').toUpperCase();
        errors.push(`${reg}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    console.log(`[vehicles/fleet] Bulk import: ${created} created, ${updated} updated, ${errors.length} errors`);
    res.json({ created, updated, errors, total: vehicles.length });
  } catch (error) {
    console.error('[vehicles/fleet] Bulk import error:', error);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. JOBS — /api/vehicles/jobs/*
//    Serves job data from the OP's jobs table in HireHopJob format.
//    Replaces the VM's direct HireHop API calls and R2 cache.
// ═══════════════════════════════════════════════════════════════════════════

/** HireHop status codes for active/dispatched jobs */
const ACTIVE_STATUSES = [1, 2, 3, 4, 5]; // Provisional → Dispatched
const RETURN_STATUSES = [5, 6]; // Dispatched, Returned Incomplete

/**
 * GET /api/vehicles/jobs/going-out
 * Jobs going out today and tomorrow (by out_date).
 */
router.get('/jobs/going-out', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (out_date IS NOT NULL AND out_date::date >= $2::date AND out_date::date <= $3::date)
           OR (out_date IS NULL AND job_date IS NOT NULL AND job_date::date >= $2::date AND job_date::date <= $3::date)
         )
       ORDER BY out_date ASC NULLS LAST, job_date ASC NULLS LAST`,
      [ACTIVE_STATUSES, today, tomorrow]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Going out error:', error);
    res.status(500).json({ error: 'Failed to load going-out jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/due-back
 * Jobs due back today and tomorrow (by return_date).
 */
router.get('/jobs/due-back', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (return_date IS NOT NULL AND return_date::date >= $2::date AND return_date::date <= $3::date)
           OR (return_date IS NULL AND job_end IS NOT NULL AND job_end::date >= $2::date AND job_end::date <= $3::date)
         )
       ORDER BY return_date ASC NULLS LAST, job_end ASC NULLS LAST`,
      [RETURN_STATUSES, today, tomorrow]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Due back error:', error);
    res.status(500).json({ error: 'Failed to load due-back jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/upcoming?days=7
 * Upcoming jobs for the next N days.
 */
router.get('/jobs/upcoming', async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const today = new Date().toISOString().split('T')[0];
    const endDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (out_date IS NOT NULL AND out_date::date >= $2::date AND out_date::date <= $3::date)
           OR (out_date IS NULL AND job_date IS NOT NULL AND job_date::date >= $2::date AND job_date::date <= $3::date)
         )
       ORDER BY out_date ASC NULLS LAST, job_date ASC NULLS LAST`,
      [ACTIVE_STATUSES, today, endDate]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Upcoming error:', error);
    res.status(500).json({ error: 'Failed to load upcoming jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/upcoming-due-back?days=7
 * Upcoming due-back jobs for the next N days.
 */
router.get('/jobs/upcoming-due-back', async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const today = new Date().toISOString().split('T')[0];
    const endDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (return_date IS NOT NULL AND return_date::date >= $2::date AND return_date::date <= $3::date)
           OR (return_date IS NULL AND job_end IS NOT NULL AND job_end::date >= $2::date AND job_end::date <= $3::date)
         )
       ORDER BY return_date ASC NULLS LAST, job_end ASC NULLS LAST`,
      [RETURN_STATUSES, today, endDate]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Upcoming due-back error:', error);
    res.status(500).json({ error: 'Failed to load upcoming due-back jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/cache-meta
 * Returns sync metadata (replaces R2 cache meta).
 */
router.get('/jobs/cache-meta', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT completed_at FROM sync_log
       WHERE sync_type = 'jobs' AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`
    );

    res.json({
      syncedAt: result.rows[0]?.completed_at || null,
      source: 'op-database',
    });
  } catch {
    res.json({ syncedAt: null, source: 'op-database' });
  }
});

/**
 * GET /api/vehicles/jobs/:jobNumber
 * Get a single job by HireHop job number.
 */
router.get('/jobs/:jobNumber', async (req: AuthRequest, res: Response) => {
  try {
    const jobNumber = parseInt(req.params.jobNumber as string);
    if (isNaN(jobNumber)) {
      res.status(400).json({ error: 'Invalid job number' });
      return;
    }

    const result = await query(
      'SELECT * FROM jobs WHERE hh_job_number = $1 AND is_deleted = false',
      [jobNumber]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: `Job #${jobNumber} not found` });
      return;
    }

    res.json(mapJobRowToHireHopJob(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/jobs] Job detail error:', error);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HIREHOP PROXY — /api/vehicles/hirehop/*
//    Direct HireHop API operations (barcode checkout/checkin, status updates).
//    Uses the OP's HireHop config (token + domain) instead of Netlify proxy.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/vehicles/hirehop
 * Generic HireHop proxy — forwards requests to HireHop API.
 * Body: { endpoint, method, params }
 */
router.post('/hirehop', async (req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(503).json({ error: 'HireHop not configured' });
      return;
    }

    const { endpoint, method, params } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    let result;
    if (method === 'POST') {
      result = await hireHopPost(endpoint, params || {}, true);
    } else {
      result = await hireHopGet(endpoint, params || {});
    }

    if (!result.success) {
      // Return the error in a format the VM's hirehop-api.ts expects
      res.status(400).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    console.error('[vehicles/hirehop] Proxy error:', error);
    res.status(500).json({ error: 'HireHop request failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NETLIFY PROXY CATCH-ALL (for remaining VM functions not yet migrated)
// ═══════════════════════════════════════════════════════════════════════════

const NETLIFY_BASE = process.env.VEHICLE_MODULE_URL || 'https://ooosh-vehicles.netlify.app';

router.all('/:functionName', proxyToNetlify);
router.all('/:functionName/*', proxyToNetlify);

async function proxyToNetlify(req: Request, res: Response): Promise<void> {
  const functionName = req.params.functionName as string;

  // Don't proxy routes we handle natively
  if (['fleet', 'jobs', 'hirehop'].includes(functionName)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const subPath = req.params[0] ? `/${req.params[0]}` : '';
  const netlifyUrl = `${NETLIFY_BASE}/.netlify/functions/${functionName}${subPath}`;
  const queryString = new URL(req.url, 'http://localhost').search;
  const targetUrl = `${netlifyUrl}${queryString}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': req.headers['content-type'] || 'application/json',
    };

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization as string;
    }

    const authReq = req as AuthRequest;
    if (authReq.user) {
      headers['X-OP-User-Id'] = authReq.user.id;
      headers['X-OP-User-Email'] = authReq.user.email;
      headers['X-OP-User-Role'] = authReq.user.role;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    res.status(response.status);

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error(`[Vehicle Proxy] Error forwarding to ${targetUrl}:`, error);
    res.status(502).json({
      error: 'Vehicle Module proxy error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAPPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Map a fleet_vehicles DB row to the VM's Vehicle interface shape */
function mapDbRowToVehicle(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    reg: row.reg as string,
    vehicleType: (row.vehicle_type as string) || '',
    simpleType: (row.simple_type as string) || '',
    make: (row.make as string) || '',
    model: (row.model as string) || '',
    colour: (row.colour as string) || '',
    seats: row.seats as number | null,
    damageStatus: (row.damage_status as string) || '',
    serviceStatus: (row.service_status as string) || '',
    hireStatus: (row.hire_status as string) || '',
    motDue: formatDate(row.mot_due),
    taxDue: formatDate(row.tax_due),
    tflDue: formatDate(row.tfl_due),
    lastServiceDate: formatDate(row.last_service_date),
    warrantyExpires: formatDate(row.warranty_expires),
    lastServiceMileage: row.last_service_mileage as number | null,
    nextServiceDue: row.next_service_due as number | null,
    ulezCompliant: row.ulez_compliant as boolean,
    spareKey: row.spare_key as boolean,
    wifiNetwork: row.wifi_network as string | null,
    financeWith: row.finance_with as string | null,
    financeEnds: formatDate(row.finance_ends),
    co2PerKm: row.co2_per_km ? Number(row.co2_per_km) : null,
    recommendedTyrePsiFront: row.recommended_tyre_psi_front ? Number(row.recommended_tyre_psi_front) : null,
    recommendedTyrePsiRear: row.recommended_tyre_psi_rear ? Number(row.recommended_tyre_psi_rear) : null,
    isOldSold: (row.fleet_group as string) === 'old_sold',
    // Extra fields not in VM's original Vehicle but useful
    fuelType: row.fuel_type as string | null,
    mpg: row.mpg ? Number(row.mpg) : null,
    fleetGroup: row.fleet_group as string,
    isActive: row.is_active as boolean,
    mondayItemId: row.monday_item_id as string | null,
  };
}

/**
 * Map an OP jobs row to the VM's HireHopJob interface shape.
 * Note: items[] will be empty — line item data is fetched separately
 * via the HireHop items_to_supply_list endpoint when needed.
 */
function mapJobRowToHireHopJob(row: Record<string, unknown>) {
  const HIREHOP_STATUS_LABELS: Record<number, string> = {
    0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
    4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
    7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
    10: 'Not Interested', 11: 'Completed',
  };

  const status = Number(row.status ?? 0);

  return {
    id: row.hh_job_number as number,
    jobName: (row.job_name as string) || '',
    company: (row.company_name as string) || (row.client_name as string) || '',
    contactName: (row.client_name as string) || '',
    contactEmail: '', // Not stored in OP jobs table — fetched from HireHop on demand if needed
    status,
    statusLabel: HIREHOP_STATUS_LABELS[status] || 'Unknown',
    outDate: formatDate(row.out_date),
    jobDate: formatDate(row.job_date),
    jobEndDate: formatDate(row.job_end),
    returnDate: formatDate(row.return_date),
    items: [], // Line items not stored in OP — fetched from HireHop on demand
    depot: row.depot_name ? null : null, // OP stores depot_name (string), not depot ID
    notes: row.notes as string | null,
  };
}

/** Format a date value to YYYY-MM-DD string */
function formatDate(val: unknown): string {
  if (!val) return '';
  const s = String(val);
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : '';
}

export default router;
