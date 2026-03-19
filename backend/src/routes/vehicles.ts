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
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { isHireHopConfigured } from '../config/hirehop';
import { hhBroker } from '../services/hirehop-broker';
import { getFromR2, uploadToR2, deleteFromR2, listR2Objects, isR2Configured } from '../config/r2';
import { emailService } from '../services/email-service';

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
      // Insurance
      insurance_due: 'insurance_due', insuranceDue: 'insurance_due',
      insurance_provider: 'insurance_provider', insuranceProvider: 'insurance_provider',
      insurance_policy_number: 'insurance_policy_number', insurancePolicyNumber: 'insurance_policy_number',
      // Booked-in dates
      mot_booked_in_date: 'mot_booked_in_date', motBookedInDate: 'mot_booked_in_date',
      service_booked_in_date: 'service_booked_in_date', serviceBookedInDate: 'service_booked_in_date',
      insurance_booked_in_date: 'insurance_booked_in_date', insuranceBookedInDate: 'insurance_booked_in_date',
      tax_booked_in_date: 'tax_booked_in_date', taxBookedInDate: 'tax_booked_in_date',
      // Mileage
      current_mileage: 'current_mileage', currentMileage: 'current_mileage',
      // V5 fields
      vin: 'vin',
      date_first_reg: 'date_first_reg', dateFirstReg: 'date_first_reg',
      v5_type: 'v5_type', v5Type: 'v5_type',
      body_type: 'body_type', bodyType: 'body_type',
      max_mass_kg: 'max_mass_kg', maxMassKg: 'max_mass_kg',
      vehicle_category: 'vehicle_category', vehicleCategory: 'vehicle_category',
      cylinder_capacity_cc: 'cylinder_capacity_cc', cylinderCapacityCc: 'cylinder_capacity_cc',
      // Extended details (migration 015)
      oil_type: 'oil_type', oilType: 'oil_type',
      coolant_type: 'coolant_type', coolantType: 'coolant_type',
      tyre_size: 'tyre_size', tyreSize: 'tyre_size',
      last_rossetts_service_date: 'last_rossetts_service_date', lastRossettsServiceDate: 'last_rossetts_service_date',
      last_rossetts_service_notes: 'last_rossetts_service_notes', lastRossettsServiceNotes: 'last_rossetts_service_notes',
      service_plan_status: 'service_plan_status', servicePlanStatus: 'service_plan_status',
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
// 1b. SERVICE LOG — /api/vehicles/fleet/:vehicleId/service-log/*
//     CRUD for vehicle service, repair, MOT, insurance, and tax records.
// ═══════════════════════════════════════════════════════════════════════════

function mapServiceLogRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    vehicleId: row.vehicle_id as string,
    name: row.name as string,
    serviceType: row.service_type as string,
    serviceDate: formatDate(row.service_date),
    mileage: row.mileage as number | null,
    cost: row.cost ? Number(row.cost) : null,
    status: row.status as string | null,
    garage: row.garage as string | null,
    hirehopJob: row.hirehop_job as string | null,
    notes: row.notes as string | null,
    nextDueDate: formatDate(row.next_due_date),
    nextDueMileage: row.next_due_mileage as number | null,
    aiSummary: row.ai_summary as string | null,
    aiExtracted: row.ai_extracted as boolean,
    files: row.files || [],
    createdBy: row.created_by as string | null,
    createdByName: row.created_by_name as string | null,
    createdAt: row.created_at ? (row.created_at as Date).toISOString() : null,
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : null,
  };
}

/**
 * GET /api/vehicles/fleet/:vehicleId/service-log
 * List all service records for a vehicle. Optional ?type= filter.
 */
router.get('/fleet/:vehicleId/service-log', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { type, limit = '50', offset = '0' } = req.query;

    let sql = `SELECT sl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
      FROM vehicle_service_log sl
      LEFT JOIN users u ON u.id = sl.created_by
      LEFT JOIN people p ON p.id = u.person_id
      WHERE sl.vehicle_id = $1`;
    const params: unknown[] = [vehicleId];
    let idx = 2;

    if (type && typeof type === 'string') {
      sql += ` AND sl.service_type = $${idx}`;
      params.push(type);
      idx++;
    }

    sql += ` ORDER BY sl.service_date DESC NULLS LAST, sl.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM vehicle_service_log WHERE vehicle_id = $1';
    const countParams: unknown[] = [vehicleId];
    if (type && typeof type === 'string') {
      countSql += ' AND service_type = $2';
      countParams.push(type);
    }
    const countResult = await query(countSql, countParams);

    res.json({
      data: result.rows.map(mapServiceLogRow),
      total: Number(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('[vehicles/service-log] List error:', error);
    res.status(500).json({ error: 'Failed to fetch service records' });
  }
});

/**
 * GET /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Get a single service record.
 */
router.get('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const result = await query(
      `SELECT sl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM vehicle_service_log sl
       LEFT JOIN users u ON u.id = sl.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE sl.id = $1 AND sl.vehicle_id = $2`,
      [logId, vehicleId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }
    res.json(mapServiceLogRow(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/service-log] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch service record' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/service-log
 * Create a new service record. Also updates vehicle mileage and due dates.
 */
router.post('/fleet/:vehicleId/service-log', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const authReq = req as AuthRequest;
    const userId = authReq.user?.id || null;
    const {
      name, service_type = 'service', service_date, mileage, cost,
      status, garage, hirehop_job, notes, next_due_date, next_due_mileage,
      ai_summary, ai_extracted = false, files = [],
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Insert service record
    const result = await query(
      `INSERT INTO vehicle_service_log (
        vehicle_id, name, service_type, service_date, mileage, cost,
        status, garage, hirehop_job, notes, next_due_date, next_due_mileage,
        ai_summary, ai_extracted, files, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        vehicleId, name, service_type, service_date || null, mileage || null, cost || null,
        status || null, garage || null, hirehop_job || null, notes || null,
        next_due_date || null, next_due_mileage || null,
        ai_summary || null, ai_extracted, JSON.stringify(files), userId,
      ]
    );

    const record = result.rows[0];

    // If mileage provided, record it in mileage log and update vehicle
    if (mileage) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'service', $3, $4)`,
        [vehicleId, mileage, record.id, userId]
      );
      await query(
        `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
         WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
        [mileage, vehicleId]
      );
    }

    // If next_due_date, update relevant date on fleet_vehicles
    if (next_due_date) {
      const dateFieldMap: Record<string, string> = {
        mot: 'mot_due',
        service: 'next_service_due', // For service, we use last_service_date + next_due_date
        insurance: 'insurance_due',
        tax: 'tax_due',
      };
      // For MOT/insurance/tax, update the due date directly
      if (service_type === 'mot') {
        await query('UPDATE fleet_vehicles SET mot_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
      } else if (service_type === 'insurance') {
        await query('UPDATE fleet_vehicles SET insurance_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
      } else if (service_type === 'tax') {
        await query('UPDATE fleet_vehicles SET tax_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
      }
    }

    // Update last_service_date if this is a service record
    if ((service_type === 'service' || service_type === 'repair') && service_date) {
      await query(
        `UPDATE fleet_vehicles SET last_service_date = $1, last_service_mileage = COALESCE($2, last_service_mileage)
         WHERE id = $3`,
        [service_date, mileage, vehicleId]
      );
    }

    res.status(201).json(mapServiceLogRow(record));
  } catch (error) {
    console.error('[vehicles/service-log] Create error:', error);
    res.status(500).json({ error: 'Failed to create service record' });
  }
});

/**
 * PUT /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Update a service record.
 */
router.put('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const v = req.body;

    const fieldMap: Record<string, string> = {
      name: 'name', service_type: 'service_type', service_date: 'service_date',
      mileage: 'mileage', cost: 'cost', status: 'status',
      garage: 'garage', hirehop_job: 'hirehop_job', notes: 'notes',
      next_due_date: 'next_due_date', next_due_mileage: 'next_due_mileage',
      ai_summary: 'ai_summary', files: 'files',
    };

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (v[key] !== undefined) {
        fields.push(`${dbCol} = $${idx}`);
        values.push(key === 'files' ? JSON.stringify(v[key]) : v[key]);
        idx++;
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(logId, vehicleId);
    const result = await query(
      `UPDATE vehicle_service_log SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND vehicle_id = $${idx + 1} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    res.json(mapServiceLogRow(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/service-log] Update error:', error);
    res.status(500).json({ error: 'Failed to update service record' });
  }
});

/**
 * DELETE /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Delete a service record.
 */
router.delete('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const result = await query(
      'DELETE FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2 RETURNING id',
      [logId, vehicleId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/service-log] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete service record' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1c. SERVICE LOG FILES — /api/vehicles/fleet/:vehicleId/service-log/:logId/files
// ═══════════════════════════════════════════════════════════════════════════

const serviceLogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * POST /api/vehicles/fleet/:vehicleId/service-log/:logId/files
 * Upload a file and append to the service record's files JSONB array.
 */
router.post(
  '/fleet/:vehicleId/service-log/:logId/files',
  serviceLogUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { vehicleId, logId } = req.params;
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      // Verify record exists
      const existing = await query(
        'SELECT id, files FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2',
        [logId, vehicleId]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Service record not found' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileId = uuid();
      const key = `files/vehicle-service/${vehicleId}/${logId}/${fileId}${ext}`;

      await uploadToR2(key, req.file.buffer, req.file.mimetype);

      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];
      const fileType = imageExts.includes(ext) ? 'image' : docExts.includes(ext) ? 'document' : 'other';

      const comment = req.body?.comment?.trim() || '';

      const fileMeta: Record<string, unknown> = {
        name: req.file.originalname,
        url: key,
        type: fileType,
        size: req.file.size,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.user!.email,
      };
      if (comment) {
        fileMeta.comment = comment;
      }

      // Append to JSONB array
      await query(
        `UPDATE vehicle_service_log
         SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND vehicle_id = $3`,
        [JSON.stringify([fileMeta]), logId, vehicleId]
      );

      res.status(201).json(fileMeta);
    } catch (error) {
      console.error('[vehicles/service-log] File upload error:', error);
      if (error instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${error.message}` });
        return;
      }
      res.status(500).json({ error: 'File upload failed' });
    }
  }
);

/**
 * DELETE /api/vehicles/fleet/:vehicleId/service-log/:logId/files
 * Remove a file from the service record and R2.
 * Body: { key: "files/vehicle-service/..." }
 */
router.delete('/fleet/:vehicleId/service-log/:logId/files', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const { key } = req.body;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    // Get current files
    const existing = await query(
      'SELECT files FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2',
      [logId, vehicleId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    const files = (existing.rows[0].files || []) as Array<{ url: string }>;
    const updated = files.filter(f => f.url !== key);

    // Delete from R2
    try {
      await deleteFromR2(key);
    } catch (e) {
      console.warn('[vehicles/service-log] R2 delete failed (may not exist):', e);
    }

    // Update JSONB
    await query(
      'UPDATE vehicle_service_log SET files = $1::jsonb, updated_at = NOW() WHERE id = $2 AND vehicle_id = $3',
      [JSON.stringify(updated), logId, vehicleId]
    );

    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/service-log] File delete error:', error);
    res.status(500).json({ error: 'File delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1d. VEHICLE FILES — /api/vehicles/fleet/:vehicleId/files
// ═══════════════════════════════════════════════════════════════════════════

const vehicleFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * POST /api/vehicles/fleet/:vehicleId/files
 * Upload a file and append to the vehicle's files JSONB array.
 * Body (multipart): file, label (optional), comment (optional)
 */
router.post(
  '/fleet/:vehicleId/files',
  vehicleFileUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { vehicleId } = req.params;
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      // Verify vehicle exists
      const existing = await query('SELECT id, files FROM fleet_vehicles WHERE id = $1', [vehicleId]);
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Vehicle not found' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileType = ext.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) ? 'image' : ext === '.pdf' ? 'document' : 'other';
      const fileId = uuid();
      const r2Key = `files/vehicle/${vehicleId}/${fileId}${ext}`;

      await uploadToR2(r2Key, req.file.buffer, req.file.mimetype);

      const fileMeta = {
        name: req.file.originalname,
        label: req.body.label || null,
        comment: req.body.comment || null,
        url: r2Key,
        type: fileType,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.user?.email || 'system',
      };

      const currentFiles = (existing.rows[0].files || []) as unknown[];
      currentFiles.push(fileMeta);

      await query(
        'UPDATE fleet_vehicles SET files = $1::jsonb WHERE id = $2',
        [JSON.stringify(currentFiles), vehicleId]
      );

      res.status(201).json(fileMeta);
    } catch (error) {
      console.error('[vehicles/files] Upload error:', error);
      if (error instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${error.message}` });
        return;
      }
      res.status(500).json({ error: 'File upload failed' });
    }
  }
);

/**
 * DELETE /api/vehicles/fleet/:vehicleId/files
 * Remove a file from the vehicle and R2.
 * Body: { key: "files/vehicle/..." }
 */
router.delete('/fleet/:vehicleId/files', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { key } = req.body;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    const existing = await query('SELECT files FROM fleet_vehicles WHERE id = $1', [vehicleId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const files = (existing.rows[0].files || []) as Array<{ url: string }>;
    const updated = files.filter(f => f.url !== key);

    try {
      await deleteFromR2(key);
    } catch (e) {
      console.warn('[vehicles/files] R2 delete failed (may not exist):', e);
    }

    await query(
      'UPDATE fleet_vehicles SET files = $1::jsonb WHERE id = $2',
      [JSON.stringify(updated), vehicleId]
    );

    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/files] Delete error:', error);
    res.status(500).json({ error: 'File delete failed' });
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
      result = await hhBroker.post(endpoint, params || {}, { priority: 'high' });
    } else {
      result = await hhBroker.get(endpoint, params || {}, { priority: 'high' });
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
// 4. R2-BACKED DATA ENDPOINTS
//    Settings, issues, allocations, stock, and vehicle events.
//    All stored in the OP's R2 bucket under vm-specific prefixes.
// ═══════════════════════════════════════════════════════════════════════════

/** Helper: read a JSON file from R2, return parsed object or null */
async function readR2Json<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === 'NoSuchKey') return null;
    throw err;
  }
}

/** Helper: write a JSON object to R2 */
async function writeR2Json(key: string, data: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(data));
  await uploadToR2(key, body, 'application/json');
}

// ── Checklist Settings ──

/**
 * GET /api/vehicles/get-checklist-settings
 * Fetch checklist settings from R2. Falls back to empty defaults.
 */
router.get('/get-checklist-settings', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<Record<string, unknown>>('settings/checklists.json');
    if (data) {
      res.json(data);
    } else {
      // Return empty structure — the frontend has DEFAULT_CHECKLIST_SETTINGS as fallback
      res.json({ briefingItems: {}, prepItems: {} });
    }
  } catch (error) {
    console.error('[vehicles/settings] Failed to read checklist settings:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

/**
 * POST /api/vehicles/save-checklist-settings
 * Save checklist settings to R2.
 */
router.post('/save-checklist-settings', async (req: AuthRequest, res: Response) => {
  try {
    const data = req.body;
    data.updatedAt = new Date().toISOString();
    await writeR2Json('settings/checklists.json', data);
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/settings] Failed to save checklist settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── Issues (R2-backed) ──

/**
 * GET /api/vehicles/get-all-issues
 * Fetch the fleet-wide issue index from R2.
 */
router.get('/get-all-issues', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ issues: unknown[] }>('issues/_index.json');
    res.json({ issues: data?.issues || [] });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read issues index:', error);
    res.status(500).json({ error: 'Failed to load issues' });
  }
});

/**
 * GET /api/vehicles/get-vehicle-issues?vehicleReg=XX00XXX
 * Fetch all issues for a specific vehicle from R2.
 */
router.get('/get-vehicle-issues', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    const prefix = `issues/${vehicleReg}/`;
    const objects = await listR2Objects(prefix);
    const issues: unknown[] = [];

    for (const obj of objects) {
      if (!obj.Key || obj.Key.endsWith('/_index.json')) continue;
      const issue = await readR2Json(obj.Key);
      if (issue) issues.push(issue);
    }

    // Sort by reportedAt descending
    issues.sort((a: any, b: any) => (b.reportedAt || '').localeCompare(a.reportedAt || ''));
    res.json({ issues });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read vehicle issues:', error);
    res.status(500).json({ error: 'Failed to load vehicle issues' });
  }
});

/**
 * GET /api/vehicles/get-issue?vehicleReg=XX00XXX&issueId=xxx
 * Fetch a single issue by vehicle reg + issue ID.
 */
router.get('/get-issue', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    const issueId = req.query.issueId as string;
    if (!vehicleReg || !issueId) {
      res.status(400).json({ error: 'vehicleReg and issueId are required' });
      return;
    }

    const issue = await readR2Json(`issues/${vehicleReg}/${issueId}.json`);
    if (!issue) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json({ issue });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read issue:', error);
    res.status(500).json({ error: 'Failed to load issue' });
  }
});

/**
 * POST /api/vehicles/save-issue
 * Save (create or update) an issue to R2.
 * Writes the full issue JSON and upserts the fleet-wide index.
 */
router.post('/save-issue', async (req: AuthRequest, res: Response) => {
  try {
    const { issue } = req.body;
    if (!issue?.id || !issue?.vehicleReg) {
      res.status(400).json({ error: 'issue with id and vehicleReg is required' });
      return;
    }

    const reg = (issue.vehicleReg as string).toUpperCase();

    // Write full issue JSON
    await writeR2Json(`issues/${reg}/${issue.id}.json`, issue);

    // Update fleet-wide index
    const indexData = await readR2Json<{ issues: any[] }>('issues/_index.json') || { issues: [] };
    const indexEntry = {
      id: issue.id,
      vehicleReg: reg,
      vehicleId: issue.vehicleId || '',
      category: issue.category,
      component: issue.component,
      severity: issue.severity,
      summary: issue.summary,
      status: issue.status,
      reportedAt: issue.reportedAt,
      resolvedAt: issue.resolvedAt || null,
      lastActivityAt: issue.activity?.length
        ? issue.activity[issue.activity.length - 1].timestamp
        : issue.reportedAt,
    };

    const idx = indexData.issues.findIndex((e: any) => e.id === issue.id);
    if (idx >= 0) {
      indexData.issues[idx] = indexEntry;
    } else {
      indexData.issues.push(indexEntry);
    }

    await writeR2Json('issues/_index.json', indexData);
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/issues] Failed to save issue:', error);
    res.status(500).json({ error: 'Failed to save issue' });
  }
});

// ── Allocations ──

/**
 * GET /api/vehicles/get-allocations
 * Fetch all active allocations from R2.
 */
router.get('/get-allocations', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ allocations: unknown[] }>('allocations/_index.json');
    res.json({ allocations: data?.allocations || [] });
  } catch (error) {
    console.error('[vehicles/allocations] Failed to read allocations:', error);
    res.status(500).json({ error: 'Failed to load allocations' });
  }
});

/**
 * POST /api/vehicles/save-allocations
 * Save the full allocations array to R2 (replaces existing).
 */
router.post('/save-allocations', async (req: AuthRequest, res: Response) => {
  try {
    const { allocations } = req.body;
    await writeR2Json('allocations/_index.json', { allocations: allocations || [], updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/allocations] Failed to save allocations:', error);
    res.status(500).json({ error: 'Failed to save allocations' });
  }
});

// ── Stock ──

/**
 * GET /api/vehicles/get-stock
 * Fetch all stock items and recent transactions from R2.
 */
router.get('/get-stock', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ items: unknown[]; transactions: unknown[] }>('stock/data.json');
    res.json({ items: data?.items || [], transactions: data?.transactions || [] });
  } catch (error) {
    console.error('[vehicles/stock] Failed to read stock:', error);
    res.status(500).json({ error: 'Failed to load stock' });
  }
});

/**
 * POST /api/vehicles/save-stock
 * Save the full stock state (items + transactions).
 */
router.post('/save-stock', async (req: AuthRequest, res: Response) => {
  try {
    const { items, transactions } = req.body;
    await writeR2Json('stock/data.json', { items: items || [], transactions: transactions || [], updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/stock] Failed to save stock:', error);
    res.status(500).json({ error: 'Failed to save stock' });
  }
});

/**
 * POST /api/vehicles/record-stock-transaction
 * Record one or more stock transactions.
 * Reads current stock, applies transaction(s), writes back.
 */
router.post('/record-stock-transaction', async (req: AuthRequest, res: Response) => {
  try {
    const { transaction, transactions: batchTransactions } = req.body;
    const txns = batchTransactions || (transaction ? [transaction] : []);

    if (txns.length === 0) {
      res.status(400).json({ error: 'transaction(s) required' });
      return;
    }

    // Read current stock
    const data = await readR2Json<{ items: any[]; transactions: any[] }>('stock/data.json') || { items: [], transactions: [] };

    // Apply each transaction
    for (const txn of txns) {
      data.transactions.push(txn);

      // Update item quantity
      const item = data.items.find((i: any) => i.id === txn.itemId);
      if (item) {
        if (txn.type === 'consumed' || txn.type === 'adjustment_down') {
          item.currentStock = Math.max(0, (item.currentStock || 0) - (txn.quantity || 0));
        } else if (txn.type === 'received' || txn.type === 'adjustment_up') {
          item.currentStock = (item.currentStock || 0) + (txn.quantity || 0);
        }
        item.updatedAt = new Date().toISOString();
      }
    }

    data.transactions = data.transactions || [];
    await writeR2Json('stock/data.json', { ...data, updatedAt: new Date().toISOString() });
    res.json({ success: true, processed: txns.length });
  } catch (error) {
    console.error('[vehicles/stock] Failed to record transaction:', error);
    res.status(500).json({ error: 'Failed to record stock transaction' });
  }
});

// ── Vehicle Events ──

/**
 * POST /api/vehicles/save-event
 * Save a vehicle event to R2.
 * Writes event JSON + updates per-vehicle index.
 */
router.post('/save-event', async (req: AuthRequest, res: Response) => {
  try {
    const { event } = req.body;
    if (!event?.id || !event?.vehicleReg) {
      res.status(400).json({ error: 'event with id and vehicleReg is required' });
      return;
    }

    const reg = (event.vehicleReg as string).toUpperCase();

    // Write full event JSON
    await writeR2Json(`vehicle-events/${reg}/${event.id}.json`, event);

    // Update per-vehicle index
    const indexKey = `vehicle-events/${reg}/_index.json`;
    const indexData = await readR2Json<{ events: any[] }>(indexKey) || { events: [] };

    const indexEntry = {
      id: event.id,
      vehicleReg: reg,
      eventType: event.eventType,
      eventDate: event.eventDate,
      mileage: event.mileage ?? null,
      fuelLevel: event.fuelLevel ?? null,
      hireHopJob: event.hireHopJob ?? null,
      hireStatus: event.hireStatus ?? null,
      createdAt: event.createdAt || new Date().toISOString(),
    };

    const idx = indexData.events.findIndex((e: any) => e.id === event.id);
    if (idx >= 0) {
      indexData.events[idx] = indexEntry;
    } else {
      indexData.events.push(indexEntry);
    }

    await writeR2Json(indexKey, indexData);

    // If hire status change included, update fleet_vehicles table
    if (event.hireStatus) {
      await query(
        'UPDATE fleet_vehicles SET hire_status = $1 WHERE reg = $2',
        [event.hireStatus, reg]
      ).catch(err => console.warn('[vehicles/events] Failed to update hire status:', err));
    }

    // Dual-write mileage to vehicle_mileage_log if present
    if (event.mileage && Number(event.mileage) > 0) {
      const mileageVal = Number(event.mileage);
      const eventType = event.eventType || 'event';
      try {
        // Look up vehicle ID from reg
        const vehicleResult = await query('SELECT id FROM fleet_vehicles WHERE reg = $1', [reg]);
        if (vehicleResult.rows.length > 0) {
          const vehicleId = vehicleResult.rows[0].id;
          const userId = req.user?.id || null;

          await query(
            `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [vehicleId, mileageVal, eventType, event.id, userId]
          );
          // Update current mileage (only if higher)
          await query(
            `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
             WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
            [mileageVal, vehicleId]
          );
        }
      } catch (err) {
        console.warn('[vehicles/events] Failed to log mileage:', err);
      }
    }

    res.json({ success: true, id: event.id });
  } catch (error) {
    console.error('[vehicles/events] Failed to save event:', error);
    res.status(500).json({ error: 'Failed to save event' });
  }
});

/**
 * GET /api/vehicles/get-recent-events?limit=10
 * Fetch recent events across all vehicles.
 * Scans per-vehicle indexes and returns the most recent N events.
 */
router.get('/get-recent-events', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

    // List all vehicle event index files
    const objects = await listR2Objects('vehicle-events/');
    const indexKeys = (objects || [])
      .filter(obj => obj.Key?.endsWith('/_index.json'))
      .map(obj => obj.Key!);

    const allEvents: any[] = [];
    for (const key of indexKeys) {
      const indexData = await readR2Json<{ events: any[] }>(key);
      if (indexData?.events) {
        allEvents.push(...indexData.events);
      }
    }

    // Sort by createdAt descending, take limit
    allEvents.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ events: allEvents.slice(0, limit) });
  } catch (error) {
    console.error('[vehicles/events] Failed to read recent events:', error);
    res.status(500).json({ error: 'Failed to load recent events' });
  }
});

// ── Tracker Assignments ──

/**
 * GET /api/vehicles/get-tracker-assignments
 * Fetch tracker-to-vehicle assignment map from R2.
 */
router.get('/get-tracker-assignments', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ assignments: Record<string, string> }>('trackers/assignments.json');
    res.json({ assignments: data?.assignments || {} });
  } catch (error) {
    console.error('[vehicles/trackers] Failed to read assignments:', error);
    res.status(500).json({ error: 'Failed to load tracker assignments' });
  }
});

/**
 * POST /api/vehicles/save-tracker-assignments
 * Save the full tracker assignments map to R2 (replaces existing).
 */
router.post('/save-tracker-assignments', async (req: AuthRequest, res: Response) => {
  try {
    const { assignments } = req.body;
    await writeR2Json('trackers/assignments.json', {
      assignments: assignments || {},
      updatedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/trackers] Failed to save assignments:', error);
    res.status(500).json({ error: 'Failed to save tracker assignments' });
  }
});

// ── Per-Vehicle Events Query ──

/**
 * GET /api/vehicles/get-events?vehicleReg=XX00XXX&eventType=Book+Out&eventId=xxx
 * Fetch events for a specific vehicle from R2 index.
 * If eventId is provided, returns the full event detail.
 */
router.get('/get-events', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    const eventType = req.query.eventType as string | undefined;
    const eventId = req.query.eventId as string | undefined;

    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    // If eventId provided, return full event detail
    if (eventId) {
      const event = await readR2Json(`vehicle-events/${vehicleReg}/${eventId}.json`);
      res.json({ event: event || null });
      return;
    }

    // Otherwise return index, optionally filtered by event type
    const indexKey = `vehicle-events/${vehicleReg}/_index.json`;
    const indexData = await readR2Json<{ events: any[] }>(indexKey);
    let events = indexData?.events || [];

    if (eventType) {
      events = events.filter((e: any) => e.eventType === eventType);
    }

    // Sort by createdAt/eventDate descending
    events.sort((a: any, b: any) => (b.createdAt || b.eventDate || '').localeCompare(a.createdAt || a.eventDate || ''));

    res.json({ events });
  } catch (error) {
    console.error('[vehicles/events] Failed to query events:', error);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// ── Condition Report PDF Generation ──

/**
 * POST /api/vehicles/generate-pdf
 * Generate a vehicle condition report PDF (book-out / check-in).
 * Returns base64-encoded PDF + filename.
 */
router.post('/generate-pdf', async (req: AuthRequest, res: Response) => {
  try {
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

    const data = req.body;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const isCheckIn = data.isCheckIn === true;
    const title = isCheckIn ? 'Vehicle Check-In Report' : 'Vehicle Book-Out Report';

    let page = pdfDoc.addPage([595, 842]); // A4
    let y = 800;
    const leftMargin = 50;
    const pageWidth = 595 - 100; // 50px margins

    const drawText = (text: string, x: number, yPos: number, size: number, f = font) => {
      page.drawText(text, { x, y: yPos, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    };

    const addPageIfNeeded = (neededSpace: number) => {
      if (y < neededSpace) {
        page = pdfDoc.addPage([595, 842]);
        y = 800;
      }
    };

    // Header
    drawText(title, leftMargin, y, 18, fontBold);
    y -= 25;
    drawText(`Generated: ${data.eventDateTime || data.eventDate || new Date().toISOString()}`, leftMargin, y, 9);
    y -= 20;

    // Divider
    page.drawLine({ start: { x: leftMargin, y }, end: { x: leftMargin + pageWidth, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 20;

    // Vehicle details
    drawText('VEHICLE DETAILS', leftMargin, y, 11, fontBold); y -= 18;
    drawText(`Registration: ${data.vehicleReg || '—'}`, leftMargin, y, 10); y -= 15;
    drawText(`Type: ${data.vehicleType || '—'}`, leftMargin, y, 10); y -= 15;
    if (data.vehicleMake) { drawText(`Make: ${data.vehicleMake}`, leftMargin, y, 10); y -= 15; }
    if (data.vehicleModel) { drawText(`Model: ${data.vehicleModel}`, leftMargin, y, 10); y -= 15; }
    if (data.vehicleColour) { drawText(`Colour: ${data.vehicleColour}`, leftMargin, y, 10); y -= 15; }
    y -= 10;

    // Hire details
    drawText('HIRE DETAILS', leftMargin, y, 11, fontBold); y -= 18;
    drawText(`Driver: ${data.driverName || '—'}`, leftMargin, y, 10); y -= 15;
    if (data.clientEmail) { drawText(`Email: ${data.clientEmail}`, leftMargin, y, 10); y -= 15; }
    if (data.hireHopJob) { drawText(`Job #: ${data.hireHopJob}`, leftMargin, y, 10); y -= 15; }
    if (data.hireStartDate) { drawText(`Hire Start: ${data.hireStartDate}`, leftMargin, y, 10); y -= 15; }
    if (data.hireEndDate) { drawText(`Hire End: ${data.hireEndDate}`, leftMargin, y, 10); y -= 15; }
    if (data.allDrivers && data.allDrivers.length > 1) {
      drawText(`All Drivers: ${data.allDrivers.join(', ')}`, leftMargin, y, 10); y -= 15;
    }
    y -= 10;

    // Vehicle state
    drawText('VEHICLE STATE', leftMargin, y, 11, fontBold); y -= 18;
    drawText(`Mileage: ${data.mileage != null ? data.mileage.toLocaleString() : '—'}`, leftMargin, y, 10); y -= 15;
    drawText(`Fuel Level: ${data.fuelLevel || '—'}`, leftMargin, y, 10); y -= 15;

    if (isCheckIn && data.bookOutMileage != null) {
      y -= 5;
      drawText('COMPARISON (vs Book-Out)', leftMargin, y, 11, fontBold); y -= 18;
      drawText(`Book-Out Mileage: ${data.bookOutMileage.toLocaleString()}`, leftMargin, y, 10); y -= 15;
      drawText(`Book-Out Fuel: ${data.bookOutFuelLevel || '—'}`, leftMargin, y, 10); y -= 15;
      if (data.bookOutDate) { drawText(`Book-Out Date: ${data.bookOutDate}`, leftMargin, y, 10); y -= 15; }
      const milesDriven = (data.mileage || 0) - (data.bookOutMileage || 0);
      if (milesDriven > 0) { drawText(`Miles Driven: ${milesDriven.toLocaleString()}`, leftMargin, y, 10); y -= 15; }
    }
    y -= 10;

    // Briefing items
    if (data.briefingItems && data.briefingItems.length > 0) {
      addPageIfNeeded(100);
      drawText('BRIEFING CHECKLIST', leftMargin, y, 11, fontBold); y -= 18;
      for (const item of data.briefingItems) {
        addPageIfNeeded(20);
        drawText(`  ✓ ${item}`, leftMargin, y, 9); y -= 14;
      }
      y -= 10;
    }

    // Notes
    if (data.bookOutNotes) {
      addPageIfNeeded(60);
      drawText('NOTES', leftMargin, y, 11, fontBold); y -= 18;
      const lines = data.bookOutNotes.split('\n');
      for (const line of lines) {
        addPageIfNeeded(20);
        drawText(line, leftMargin, y, 9); y -= 14;
      }
      y -= 10;
    }

    // Damage items (check-in)
    if (isCheckIn && data.damageItems && data.damageItems.length > 0) {
      addPageIfNeeded(100);
      drawText('DAMAGE REPORT', leftMargin, y, 11, fontBold); y -= 18;
      for (const item of data.damageItems) {
        addPageIfNeeded(50);
        drawText(`Location: ${item.location}  |  Severity: ${item.severity}`, leftMargin, y, 10, fontBold); y -= 15;
        drawText(`Description: ${item.description}`, leftMargin, y, 9); y -= 20;
      }
      y -= 10;
    }

    // Photos section (embed thumbnails if base64 provided)
    if (data.photos && data.photos.length > 0) {
      addPageIfNeeded(200);
      drawText('CONDITION PHOTOS', leftMargin, y, 11, fontBold); y -= 20;

      for (const photo of data.photos) {
        try {
          if (!photo.base64) continue;
          addPageIfNeeded(180);

          // Extract raw base64 data
          const base64Data = photo.base64.includes(',') ? photo.base64.split(',')[1] : photo.base64;
          const imageBuffer = Buffer.from(base64Data!, 'base64');

          let image;
          try {
            image = await pdfDoc.embedJpg(imageBuffer);
          } catch {
            try {
              image = await pdfDoc.embedPng(imageBuffer);
            } catch {
              drawText(`[${photo.label}] — image could not be embedded`, leftMargin, y, 9);
              y -= 15;
              continue;
            }
          }

          // Scale to fit width (max 200px wide, maintain aspect ratio)
          const maxW = 200;
          const maxH = 150;
          const scale = Math.min(maxW / image.width, maxH / image.height, 1);
          const w = image.width * scale;
          const h = image.height * scale;

          drawText(photo.label || photo.angle, leftMargin, y, 9, fontBold);
          y -= h + 5;
          page.drawImage(image, { x: leftMargin, y, width: w, height: h });
          y -= 15;
        } catch (imgErr) {
          drawText(`[${photo.label}] — failed to embed`, leftMargin, y, 9);
          y -= 15;
        }
      }
    }

    // Signature
    if (data.signatureBase64) {
      try {
        addPageIfNeeded(120);
        drawText('DRIVER SIGNATURE', leftMargin, y, 11, fontBold); y -= 20;
        const sigBase64 = data.signatureBase64.includes(',') ? data.signatureBase64.split(',')[1] : data.signatureBase64;
        const sigBuffer = Buffer.from(sigBase64!, 'base64');
        const sigImage = await pdfDoc.embedPng(sigBuffer);
        const scale = Math.min(200 / sigImage.width, 80 / sigImage.height, 1);
        const w = sigImage.width * scale;
        const h = sigImage.height * scale;
        y -= h;
        page.drawImage(sigImage, { x: leftMargin, y, width: w, height: h });
        y -= 15;
      } catch {
        drawText('[Signature could not be embedded]', leftMargin, y, 9);
        y -= 15;
      }
    }

    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    const filename = `${isCheckIn ? 'check-in' : 'book-out'}_${data.vehicleReg || 'unknown'}_${new Date().toISOString().slice(0, 10)}.pdf`;

    res.json({
      pdf: base64Pdf,
      size: pdfBytes.length,
      filename,
    });
  } catch (error) {
    console.error('[vehicles/pdf] Generate condition report error:', error);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// ── Send Email (condition report with PDF attachment) ──

/**
 * POST /api/vehicles/send-email
 * Send an email with optional PDF attachment.
 * Used by book-out/check-in flows to email condition reports.
 */
router.post('/send-email', async (req: AuthRequest, res: Response) => {
  try {
    const { to, subject, html, pdfBase64, pdfFilename } = req.body;

    if (!to || !subject) {
      res.status(400).json({ error: 'to and subject are required' });
      return;
    }

    const attachments = pdfBase64 && pdfFilename ? [{
      filename: pdfFilename,
      content: Buffer.from(pdfBase64, 'base64'),
      contentType: 'application/pdf' as const,
    }] : [];

    // Use the email service's sendRaw for plain emails, or direct nodemailer for attachments
    if (attachments.length > 0) {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
      });

      const isTestMode = (process.env.EMAIL_MODE || 'test') === 'test';
      const actualTo = isTestMode && process.env.EMAIL_TEST_REDIRECT
        ? process.env.EMAIL_TEST_REDIRECT : to;

      const mailResult = await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Ooosh Tours <notifications@oooshtours.co.uk>',
        to: actualTo,
        subject: isTestMode ? `[TEST] ${subject}` : subject,
        html: html || '',
        attachments,
      });

      res.json({ messageId: mailResult.messageId || 'sent' });
    } else {
      const result = await emailService.sendRaw({ to, subject, html: html || '' });
      if (!result.success) {
        res.status(500).json({ error: result.error || 'Email send failed' });
        return;
      }
      res.json({ messageId: result.messageId || 'sent' });
    }
  } catch (error) {
    console.error('[vehicles/email] Send error:', error);
    res.status(500).json({ error: 'Email send failed', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ── Photo Upload & List ──

/**
 * POST /api/vehicles/upload-photo
 * Upload a photo to R2. Expects multipart form with 'file' and 'key' fields.
 */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

router.post('/upload-photo', (req: AuthRequest, res: Response) => {
  photoUpload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('[vehicles/photos] Multer error:', err);
      res.status(400).json({ error: err.message || 'Upload failed' });
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const key = req.body.key as string;
      if (!key) {
        res.status(400).json({ error: 'No key provided' });
        return;
      }

      // Sanitise key — prevent path traversal
      const sanitisedKey = key.replace(/\.\./g, '').replace(/^\/+/, '');

      await uploadToR2(sanitisedKey, req.file.buffer, req.file.mimetype);

      res.json({
        url: sanitisedKey,
        key: sanitisedKey,
        bucket: 'operations',
      });
    } catch (error) {
      console.error('[vehicles/photos] Upload error:', error);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

/**
 * GET /api/vehicles/list-photos?prefix=events/xxx/REG/
 * List photos in R2 under a given prefix.
 */
router.get('/list-photos', async (req: AuthRequest, res: Response) => {
  try {
    const prefix = req.query.prefix as string;
    if (!prefix) {
      res.status(400).json({ error: 'prefix is required' });
      return;
    }

    const objects = await listR2Objects(prefix);
    const photos = (objects || [])
      .filter(obj => obj.Key && /\.(jpg|jpeg|png|webp)$/i.test(obj.Key))
      .map(obj => {
        const key = obj.Key!;
        const angle = key.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
        return { angle, key, url: `/api/vehicles/photo/${encodeURIComponent(key)}` };
      });

    res.json({ photos });
  } catch (error) {
    console.error('[vehicles/photos] List error:', error);
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

/**
 * GET /api/vehicles/photo/:key
 * Serve a photo from R2 (streaming proxy).
 */
router.get('/photo/*', async (req: AuthRequest, res: Response) => {
  try {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    const obj = await getFromR2(key);
    if (!obj.Body) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    const contentType = obj.ContentType || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const bodyBytes = await obj.Body.transformToByteArray();
    res.send(Buffer.from(bodyBytes));
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === 'NoSuchKey') {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    console.error('[vehicles/photos] Serve error:', error);
    res.status(500).json({ error: 'Failed to serve photo' });
  }
});

// ── Traccar GPS Proxy ──

const TRACCAR_URL = process.env.TRACCAR_URL || 'https://tracking.oooshtours.co.uk';
const TRACCAR_EMAIL = process.env.TRACCAR_EMAIL || '';
const TRACCAR_PASSWORD = process.env.TRACCAR_PASSWORD || '';

/**
 * POST /api/vehicles/traccar
 * Proxy requests to Traccar GPS tracking server.
 * Body: { endpoint: string, params?: Record<string, string> }
 */
router.post('/traccar', async (req: AuthRequest, res: Response) => {
  try {
    if (!TRACCAR_EMAIL || !TRACCAR_PASSWORD) {
      res.status(503).json({ error: 'Traccar not configured. Set TRACCAR_URL, TRACCAR_EMAIL, TRACCAR_PASSWORD in .env' });
      return;
    }

    const { endpoint, params } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    // Build URL with query params
    const url = new URL(`/api${endpoint}`, TRACCAR_URL);
    if (params) {
      for (const [key, value] of Object.entries(params as Record<string, string>)) {
        url.searchParams.set(key, value);
      }
    }

    const authHeader = 'Basic ' + Buffer.from(`${TRACCAR_EMAIL}:${TRACCAR_PASSWORD}`).toString('base64');

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[vehicles/traccar] Traccar API error: ${response.status}`, body);
      res.status(response.status).json({ error: `Traccar API error: ${response.status}` });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[vehicles/traccar] Proxy error:', error);
    res.status(500).json({ error: 'Traccar request failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MILEAGE — /api/vehicles/fleet/:vehicleId/mileage
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet/:vehicleId/mileage
 * Mileage history for a vehicle, most recent first.
 */
router.get('/fleet/:vehicleId/mileage', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT ml.*, CONCAT(p.first_name, ' ', p.last_name) AS recorded_by_name
       FROM vehicle_mileage_log ml
       LEFT JOIN users u ON u.id = ml.recorded_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE ml.vehicle_id = $1
       ORDER BY ml.recorded_at DESC
       LIMIT $2 OFFSET $3`,
      [vehicleId, Number(limit), Number(offset)]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM vehicle_mileage_log WHERE vehicle_id = $1',
      [vehicleId]
    );

    // Compute stats
    const statsResult = await query(
      `SELECT
         MIN(mileage) AS min_mileage,
         MAX(mileage) AS max_mileage,
         COUNT(*) AS total_readings,
         MIN(recorded_at) AS first_reading,
         MAX(recorded_at) AS last_reading
       FROM vehicle_mileage_log WHERE vehicle_id = $1`,
      [vehicleId]
    );
    const stats = statsResult.rows[0] || {};

    // Average daily mileage (from first to last reading)
    let avgDailyMileage: number | null = null;
    if (stats.first_reading && stats.last_reading && stats.min_mileage != null && stats.max_mileage != null) {
      const daysDiff = (new Date(stats.last_reading as string).getTime() - new Date(stats.first_reading as string).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 0) {
        avgDailyMileage = Math.round((Number(stats.max_mileage) - Number(stats.min_mileage)) / daysDiff);
      }
    }

    res.json({
      data: result.rows.map(row => ({
        id: row.id,
        vehicleId: row.vehicle_id,
        mileage: Number(row.mileage),
        source: row.source,
        sourceRef: row.source_ref,
        recordedAt: row.recorded_at ? (row.recorded_at as Date).toISOString() : null,
        recordedBy: row.recorded_by,
        recordedByName: row.recorded_by_name,
      })),
      total: Number(countResult.rows[0]?.count || 0),
      stats: {
        currentMileage: stats.max_mileage ? Number(stats.max_mileage) : null,
        totalReadings: Number(stats.total_readings || 0),
        avgDailyMileage,
      },
    });
  } catch (error) {
    console.error('[vehicles/mileage] List error:', error);
    res.status(500).json({ error: 'Failed to load mileage history' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/mileage
 * Manual mileage entry.
 */
router.post('/fleet/:vehicleId/mileage', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { mileage, source = 'manual', source_ref } = req.body;
    const userId = req.user?.id || null;

    if (!mileage || Number(mileage) <= 0) {
      res.status(400).json({ error: 'Valid mileage is required' });
      return;
    }

    const mileageVal = Number(mileage);

    const result = await query(
      `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [vehicleId, mileageVal, source, source_ref || null, userId]
    );

    // Update current mileage (only if higher)
    await query(
      `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
       WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
      [mileageVal, vehicleId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[vehicles/mileage] Create error:', error);
    res.status(500).json({ error: 'Failed to record mileage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. FUEL LOG — /api/vehicles/fleet/:vehicleId/fuel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet/:vehicleId/fuel
 * Fuel log with stats (cost per mile calculated from full-to-full fills).
 */
router.get('/fleet/:vehicleId/fuel', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT fl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM vehicle_fuel_log fl
       LEFT JOIN users u ON u.id = fl.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE fl.vehicle_id = $1
       ORDER BY fl.date DESC, fl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [vehicleId, Number(limit), Number(offset)]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM vehicle_fuel_log WHERE vehicle_id = $1', [vehicleId]
    );

    // Aggregate stats
    const statsResult = await query(
      `SELECT
         SUM(cost) AS total_cost,
         SUM(litres) AS total_litres,
         COUNT(*) AS fill_count,
         MIN(date) AS first_fill,
         MAX(date) AS last_fill
       FROM vehicle_fuel_log WHERE vehicle_id = $1`,
      [vehicleId]
    );
    const s = statsResult.rows[0] || {};

    // Cost per mile: use mileage range from fuel entries that have mileage_at_fill
    let costPerMile: number | null = null;
    const mileageRange = await query(
      `SELECT MIN(mileage_at_fill) AS min_m, MAX(mileage_at_fill) AS max_m, SUM(cost) AS total_cost
       FROM vehicle_fuel_log
       WHERE vehicle_id = $1 AND mileage_at_fill IS NOT NULL`,
      [vehicleId]
    );
    const mr = mileageRange.rows[0];
    if (mr && mr.min_m != null && mr.max_m != null && Number(mr.max_m) > Number(mr.min_m)) {
      costPerMile = Math.round((Number(mr.total_cost) / (Number(mr.max_m) - Number(mr.min_m))) * 100) / 100;
    }

    res.json({
      data: result.rows.map(row => ({
        id: row.id,
        vehicleId: row.vehicle_id,
        date: formatDate(row.date),
        litres: row.litres ? Number(row.litres) : null,
        cost: Number(row.cost),
        mileageAtFill: row.mileage_at_fill as number | null,
        fullTank: row.full_tank as boolean,
        receiptFile: row.receipt_file,
        notes: row.notes,
        createdBy: row.created_by,
        createdByName: row.created_by_name,
        createdAt: row.created_at ? (row.created_at as Date).toISOString() : null,
      })),
      total: Number(countResult.rows[0]?.count || 0),
      stats: {
        totalCost: s.total_cost ? Number(s.total_cost) : 0,
        totalLitres: s.total_litres ? Number(s.total_litres) : 0,
        fillCount: Number(s.fill_count || 0),
        costPerMile,
      },
    });
  } catch (error) {
    console.error('[vehicles/fuel] List error:', error);
    res.status(500).json({ error: 'Failed to load fuel log' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/fuel
 * Record a fuel fill.
 */
router.post('/fleet/:vehicleId/fuel', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { date, litres, cost, mileage_at_fill, full_tank = false, notes } = req.body;
    const userId = req.user?.id || null;

    if (!cost || !date) {
      res.status(400).json({ error: 'date and cost are required' });
      return;
    }

    const result = await query(
      `INSERT INTO vehicle_fuel_log (vehicle_id, date, litres, cost, mileage_at_fill, full_tank, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [vehicleId, date, litres || null, cost, mileage_at_fill || null, full_tank, notes || null, userId]
    );

    // If mileage provided, also log to mileage_log
    if (mileage_at_fill && Number(mileage_at_fill) > 0) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'fuel', $3, $4)`,
        [vehicleId, mileage_at_fill, result.rows[0].id, userId]
      ).catch(() => {});
      await query(
        `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
         WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
        [mileage_at_fill, vehicleId]
      ).catch(() => {});
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[vehicles/fuel] Create error:', error);
    res.status(500).json({ error: 'Failed to record fuel' });
  }
});

/**
 * DELETE /api/vehicles/fleet/:vehicleId/fuel/:fuelId
 */
router.delete('/fleet/:vehicleId/fuel/:fuelId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, fuelId } = req.params;
    const result = await query(
      'DELETE FROM vehicle_fuel_log WHERE id = $1 AND vehicle_id = $2 RETURNING id',
      [fuelId, vehicleId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Fuel record not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/fuel] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete fuel record' });
  }
});

/**
 * GET /api/vehicles/fleet-costs
 * Fleet-wide cost report — aggregates service + fuel costs per vehicle.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/fleet-costs', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
      res.status(403).json({ error: 'Admin or manager role required' });
      return;
    }

    const { from, to } = req.query;
    const fromDate = from ? String(from) : new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const toDate = to ? String(to) : new Date().toISOString().split('T')[0];

    // Service costs by vehicle
    const serviceCosts = await query(
      `SELECT fv.id, fv.reg, fv.make, fv.model, fv.simple_type,
              COALESCE(SUM(sl.cost), 0) AS service_total,
              COUNT(sl.id) AS service_count
       FROM fleet_vehicles fv
       LEFT JOIN vehicle_service_log sl ON sl.vehicle_id = fv.id
         AND sl.service_date BETWEEN $1 AND $2
       WHERE fv.is_active = true AND fv.fleet_group != 'old_sold'
       GROUP BY fv.id, fv.reg, fv.make, fv.model, fv.simple_type
       ORDER BY fv.reg`,
      [fromDate, toDate]
    );

    // Fuel costs by vehicle
    const fuelCosts = await query(
      `SELECT vehicle_id, COALESCE(SUM(cost), 0) AS fuel_total, COUNT(*) AS fuel_count
       FROM vehicle_fuel_log
       WHERE date BETWEEN $1 AND $2
       GROUP BY vehicle_id`,
      [fromDate, toDate]
    );

    const fuelMap = new Map<string, { fuel_total: number; fuel_count: number }>();
    for (const row of fuelCosts.rows) {
      fuelMap.set(row.vehicle_id as string, {
        fuel_total: Number(row.fuel_total),
        fuel_count: Number(row.fuel_count),
      });
    }

    const report = serviceCosts.rows.map(row => {
      const fuel = fuelMap.get(row.id as string) || { fuel_total: 0, fuel_count: 0 };
      const serviceTotal = Number(row.service_total);
      return {
        vehicleId: row.id,
        reg: row.reg,
        make: row.make,
        model: row.model,
        simpleType: row.simple_type,
        serviceCost: serviceTotal,
        serviceCount: Number(row.service_count),
        fuelCost: fuel.fuel_total,
        fuelCount: fuel.fuel_count,
        totalCost: serviceTotal + fuel.fuel_total,
      };
    });

    // Grand totals
    const grandService = report.reduce((sum, r) => sum + r.serviceCost, 0);
    const grandFuel = report.reduce((sum, r) => sum + r.fuelCost, 0);

    res.json({
      data: report,
      period: { from: fromDate, to: toDate },
      totals: {
        serviceCost: grandService,
        fuelCost: grandFuel,
        totalCost: grandService + grandFuel,
        vehicleCount: report.length,
      },
    });
  } catch (error) {
    console.error('[vehicles/fleet-costs] Report error:', error);
    res.status(500).json({ error: 'Failed to generate cost report' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. COMPLIANCE SETTINGS — /api/vehicles/compliance/*
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/compliance/settings
 * Return all compliance settings.
 */
router.get('/compliance/settings', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT key, value, updated_at FROM vehicle_compliance_settings ORDER BY key');
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) {
      try {
        settings[row.key as string] = JSON.parse(row.value as string);
      } catch {
        settings[row.key as string] = row.value;
      }
    }
    res.json(settings);
  } catch (error) {
    console.error('[vehicles/compliance] Settings fetch error:', error);
    res.status(500).json({ error: 'Failed to load compliance settings' });
  }
});

/**
 * PUT /api/vehicles/compliance/settings
 * Update compliance settings (admin/manager only).
 * Body: { key: value, key: value, ... }
 */
router.put('/compliance/settings', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
      res.status(403).json({ error: 'Admin or manager role required' });
      return;
    }

    const updates = req.body as Record<string, unknown>;
    const userId = req.user!.id;

    for (const [key, value] of Object.entries(updates)) {
      await query(
        `INSERT INTO vehicle_compliance_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW(), updated_by = $3`,
        [key, JSON.stringify(value), userId]
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[vehicles/compliance] Settings update error:', error);
    res.status(500).json({ error: 'Failed to update compliance settings' });
  }
});

/**
 * GET /api/vehicles/compliance/check
 * Run compliance check on demand (returns alerts without creating notifications).
 */
router.get('/compliance/check', async (_req: AuthRequest, res: Response) => {
  try {
    const { runComplianceCheck } = await import('../services/compliance-checker');
    const result = await runComplianceCheck(false);
    res.json(result);
  } catch (error) {
    console.error('[vehicles/compliance] Check error:', error);
    res.status(500).json({ error: 'Failed to run compliance check' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NETLIFY PROXY CATCH-ALL (for remaining VM functions not yet migrated)
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
    // Insurance
    insuranceDue: formatDate(row.insurance_due),
    insuranceProvider: row.insurance_provider as string | null,
    insurancePolicyNumber: row.insurance_policy_number as string | null,
    // Booked-in dates
    motBookedInDate: formatDate(row.mot_booked_in_date),
    serviceBookedInDate: formatDate(row.service_booked_in_date),
    insuranceBookedInDate: formatDate(row.insurance_booked_in_date),
    taxBookedInDate: formatDate(row.tax_booked_in_date),
    // Mileage
    currentMileage: row.current_mileage as number | null,
    lastMileageUpdate: row.last_mileage_update ? (row.last_mileage_update as Date).toISOString() : null,
    // V5 / VE103B fields
    vin: row.vin as string | null,
    dateFirstReg: formatDate(row.date_first_reg),
    v5Type: row.v5_type as string | null,
    bodyType: row.body_type as string | null,
    maxMassKg: row.max_mass_kg as number | null,
    vehicleCategory: row.vehicle_category as string | null,
    cylinderCapacityCc: row.cylinder_capacity_cc as number | null,
    // Extended details (migration 015)
    oilType: row.oil_type as string | null,
    coolantType: row.coolant_type as string | null,
    tyreSize: row.tyre_size as string | null,
    lastRossettsServiceDate: formatDate(row.last_rossetts_service_date),
    lastRossettsServiceNotes: row.last_rossetts_service_notes as string | null,
    servicePlanStatus: row.service_plan_status as string | null,
    files: row.files || [],
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
  // Handle Date objects (returned by pg for DATE/TIMESTAMP columns)
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val);
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : '';
}

export default router;
