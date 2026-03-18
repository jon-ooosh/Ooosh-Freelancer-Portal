/**
 * Fleet Data Import — reads Monday.com Fleet Management xlsx export
 * and inserts vehicles + service records into the OP database.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/import-fleet-xlsx.ts /path/to/Fleet_Management_clean.xlsx
 *
 * What it does:
 *   1. Reads the xlsx file
 *   2. Parses vehicle rows (main items) and maps columns to fleet_vehicles fields
 *   3. Parses subitem rows (service/repair records) and links to their parent vehicle
 *   4. Upserts vehicles into fleet_vehicles (by registration)
 *   5. Inserts service records into vehicle_service_log
 *
 * Safe to run multiple times — vehicles are upserted by reg, service records
 * are checked for duplicates by (vehicle_id, name, service_date).
 */

import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ═══════════════════════════════════════════════════════════════════════════
// Column mapping: Monday.com header → our field name
// ═══════════════════════════════════════════════════════════════════════════

const VEHICLE_COLUMN_MAP: Record<string, string> = {
  'Name': 'reg',
  'Vehicle type': 'vehicle_type',
  'MOT Due': 'mot_due',
  'Tax Due': 'tax_due',
  'TFL Due': 'tfl_due',
  'ULEZ Compliant?': 'ulez_compliant',
  'Next Service Due': 'next_service_due',
  'Last Service Mileage': 'last_service_mileage',
  'Last service date': 'last_service_date',
  'Warranty expires': 'warranty_expires',
  'DAMAGE': 'damage_status',
  'Wifi network': 'wifi_network',
  'Finance with': 'finance_with',
  'Finance ends': 'finance_ends',
  'SPARE KEY': 'spare_key',
  'Front Tyres': 'recommended_tyre_psi_front',
  'Rear Tyres': 'recommended_tyre_psi_rear',
  'Vehicle_CO2': 'co2_per_km',
  'Simple type': 'simple_type',
  'SERVICE STATUS': 'service_status',
  'Hire status': 'hire_status',
  'D.1: Make': 'make',
  'D.3: Model': 'model',
  'R: Colour': 'colour',
  'S.1: No. of seats inc driver': 'seats',
  // V5 / VE103B fields
  'E: VIN / Chassis #': 'vin',
  'B: Date of first registration': 'date_first_reg',
  'D.2: Type': 'v5_type',
  'D.5: Body Type': 'body_type',
  'F.1: Max permissible mass': 'max_mass_kg',
  'J: Vehicle category': 'vehicle_category',
  'P.1: Cylinder capacity (cc)': 'cylinder_capacity_cc',
  // Also grab "Service ok?" as fallback for service_status
  'Service ok?': '_service_ok_fallback',
};

const SUBITEM_COLUMN_MAP: Record<string, string> = {
  'Name': 'name',
  'Service / Repair': 'service_type',
  'Date': 'service_date',
  'Mileage': 'mileage',
  'Cost': 'cost',
  'Status': 'status',
  'Garage/Bodyshop': 'garage',
  'Hirehop#': 'hirehop_job',
  'Notes': 'notes',
};

// ═══════════════════════════════════════════════════════════════════════════
// Parse helpers
// ═══════════════════════════════════════════════════════════════════════════

function parseDate(val: unknown): string | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;

  // Handle Excel serial date numbers
  if (/^\d+$/.test(s) && parseInt(s) > 40000) {
    const date = XLSX.SSF.parse_date_code(parseInt(s));
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
  }

  // Handle ISO dates like "2026-11-22" or "2026-03-13T11:09:55.805Z"
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1]!;

  // Handle DD/MM/YYYY
  const ukMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2]!.padStart(2, '0')}-${ukMatch[1]!.padStart(2, '0')}`;
  }

  return null;
}

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function parseBool(val: unknown): boolean {
  if (!val) return false;
  const s = String(val).trim().toUpperCase();
  return s === 'YES' || s === 'TRUE' || s === '1';
}

function cleanString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main import logic
// ═══════════════════════════════════════════════════════════════════════════

interface VehicleRecord {
  reg: string;
  vehicle_type: string | null;
  simple_type: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  seats: number | null;
  damage_status: string | null;
  service_status: string | null;
  hire_status: string | null;
  mot_due: string | null;
  tax_due: string | null;
  tfl_due: string | null;
  last_service_date: string | null;
  last_service_mileage: number | null;
  next_service_due: number | null;
  warranty_expires: string | null;
  ulez_compliant: boolean;
  spare_key: boolean;
  wifi_network: string | null;
  finance_with: string | null;
  finance_ends: string | null;
  co2_per_km: number | null;
  recommended_tyre_psi_front: number | null;
  recommended_tyre_psi_rear: number | null;
  // V5 fields
  vin: string | null;
  date_first_reg: string | null;
  v5_type: string | null;
  body_type: string | null;
  max_mass_kg: number | null;
  vehicle_category: string | null;
  cylinder_capacity_cc: number | null;
}

interface ServiceRecord {
  vehicleReg: string;
  name: string;
  service_type: string;
  service_date: string | null;
  mileage: number | null;
  cost: number | null;
  status: string | null;
  garage: string | null;
  hirehop_job: string | null;
  notes: string | null;
}

async function importFleet(filePath: string) {
  console.log(`\nReading ${filePath}...\n`);

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0]!;
  const sheet = workbook.Sheets[sheetName]!;

  // Convert to array of arrays (preserves row structure)
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Find header row (row 3 = index 2)
  const headerRowIdx = rows.findIndex((row, idx) =>
    idx >= 1 && row.some(cell => String(cell).trim() === 'Name') && row.some(cell => String(cell).trim() === 'Vehicle type')
  );

  if (headerRowIdx === -1) {
    console.error('Could not find header row with "Name" and "Vehicle type" columns');
    process.exit(1);
  }

  const headers = (rows[headerRowIdx] as string[]).map(h => String(h).trim());
  console.log(`Found ${headers.length} columns in header row ${headerRowIdx + 1}`);
  console.log(`Headers: ${headers.filter(h => h).join(' | ')}\n`);

  // Build column index maps
  const vehicleColIdx: Record<string, number> = {};
  for (const [header, field] of Object.entries(VEHICLE_COLUMN_MAP)) {
    const idx = headers.indexOf(header);
    if (idx !== -1) {
      vehicleColIdx[field] = idx;
    } else {
      console.warn(`  Column "${header}" not found in spreadsheet`);
    }
  }

  // Parse rows after the header
  const vehicles: VehicleRecord[] = [];
  const serviceRecords: ServiceRecord[] = [];
  let currentVehicleReg: string | null = null;
  let inSubitems = false;
  let subitemHeaders: string[] = [];

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const firstCell = String(row[0] || '').trim();
    const secondCell = String(row[1] || '').trim();

    // Skip empty rows
    if (row.every(cell => !cell || String(cell).trim() === '')) continue;

    // Detect subitem header row
    if (firstCell === 'Subitems' && secondCell === 'Name') {
      inSubitems = true;
      subitemHeaders = (row as string[]).map(h => String(h).trim());
      continue;
    }

    // If we're in subitems section and hit a new vehicle row (has Vehicle type in col C)
    const vehicleTypeCol = vehicleColIdx['vehicle_type'];
    const vehicleTypeVal = vehicleTypeCol !== undefined ? cleanString(row[vehicleTypeCol]) : null;

    // A vehicle row has content in the Vehicle type column and the Name looks like a reg plate
    const looksLikeReg = /^[A-Z]{2}\d{2}[A-Z]{3}$/i.test(firstCell) ||
                         /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/i.test(firstCell) ||
                         (firstCell.length >= 4 && firstCell.length <= 8 && /[A-Z]/.test(firstCell) && /\d/.test(firstCell));

    if (vehicleTypeVal && (looksLikeReg || firstCell.length >= 4)) {
      // This is a vehicle row
      inSubitems = false;
      currentVehicleReg = firstCell.toUpperCase();

      const vehicle: VehicleRecord = {
        reg: currentVehicleReg,
        vehicle_type: vehicleTypeVal,
        simple_type: cleanString(row[vehicleColIdx['simple_type']!]),
        make: cleanString(row[vehicleColIdx['make']!]),
        model: cleanString(row[vehicleColIdx['model']!]),
        colour: cleanString(row[vehicleColIdx['colour']!]),
        seats: parseNumber(row[vehicleColIdx['seats']!]),
        damage_status: cleanString(row[vehicleColIdx['damage_status']!]) || 'ALL GOOD',
        service_status: cleanString(row[vehicleColIdx['service_status']!]) ||
                        cleanString(row[vehicleColIdx['_service_ok_fallback']!]) || 'OK',
        hire_status: cleanString(row[vehicleColIdx['hire_status']!]) || 'Available',
        mot_due: parseDate(row[vehicleColIdx['mot_due']!]),
        tax_due: parseDate(row[vehicleColIdx['tax_due']!]),
        tfl_due: parseDate(row[vehicleColIdx['tfl_due']!]),
        last_service_date: parseDate(row[vehicleColIdx['last_service_date']!]),
        last_service_mileage: parseNumber(row[vehicleColIdx['last_service_mileage']!]),
        next_service_due: parseNumber(row[vehicleColIdx['next_service_due']!]),
        warranty_expires: parseDate(row[vehicleColIdx['warranty_expires']!]),
        ulez_compliant: parseBool(row[vehicleColIdx['ulez_compliant']!]),
        spare_key: parseBool(row[vehicleColIdx['spare_key']!]),
        wifi_network: cleanString(row[vehicleColIdx['wifi_network']!]),
        finance_with: cleanString(row[vehicleColIdx['finance_with']!]),
        finance_ends: parseDate(row[vehicleColIdx['finance_ends']!]),
        co2_per_km: parseNumber(row[vehicleColIdx['co2_per_km']!]),
        recommended_tyre_psi_front: parseNumber(row[vehicleColIdx['recommended_tyre_psi_front']!]),
        recommended_tyre_psi_rear: parseNumber(row[vehicleColIdx['recommended_tyre_psi_rear']!]),
        vin: cleanString(row[vehicleColIdx['vin']!]),
        date_first_reg: parseDate(row[vehicleColIdx['date_first_reg']!]),
        v5_type: cleanString(row[vehicleColIdx['v5_type']!]),
        body_type: cleanString(row[vehicleColIdx['body_type']!]),
        max_mass_kg: parseNumber(row[vehicleColIdx['max_mass_kg']!]),
        vehicle_category: cleanString(row[vehicleColIdx['vehicle_category']!]),
        cylinder_capacity_cc: parseNumber(row[vehicleColIdx['cylinder_capacity_cc']!]),
      };

      vehicles.push(vehicle);
      console.log(`  Vehicle: ${vehicle.reg} — ${vehicle.vehicle_type} (${vehicle.simple_type})`);
      continue;
    }

    // If we're in subitems and have a current vehicle, parse the service record
    if (inSubitems && currentVehicleReg && secondCell) {
      // Build subitem column index
      const subColIdx: Record<string, number> = {};
      for (const [header, field] of Object.entries(SUBITEM_COLUMN_MAP)) {
        const idx = subitemHeaders.indexOf(header);
        if (idx !== -1) subColIdx[field] = idx;
      }

      const serviceType = cleanString(row[subColIdx['service_type']!])?.toUpperCase() || 'SERVICE';

      const record: ServiceRecord = {
        vehicleReg: currentVehicleReg,
        name: secondCell,
        service_type: serviceType === 'REPAIR' ? 'repair' : 'service',
        service_date: parseDate(row[subColIdx['service_date']!]),
        mileage: parseNumber(row[subColIdx['mileage']!]),
        cost: parseNumber(row[subColIdx['cost']!]),
        status: cleanString(row[subColIdx['status']!]),
        garage: cleanString(row[subColIdx['garage']!]),
        hirehop_job: cleanString(row[subColIdx['hirehop_job']!]),
        notes: cleanString(row[subColIdx['notes']!]),
      };

      serviceRecords.push(record);
      continue;
    }

    // Check for group headers like "Current vehicle fleet" or "Old and sold"
    if (firstCell && !secondCell && !vehicleTypeVal) {
      // Might be a group header — check if next rows look like subitems or vehicles
      console.log(`  [Group/label: "${firstCell}"]`);
      continue;
    }
  }

  console.log(`\nParsed: ${vehicles.length} vehicles, ${serviceRecords.length} service records\n`);

  // ── Insert vehicles ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let vCreated = 0, vUpdated = 0, vErrors = 0;
    for (const v of vehicles) {
      try {
        const result = await client.query(
          `INSERT INTO fleet_vehicles (
            reg, vehicle_type, simple_type, make, model, colour, seats,
            damage_status, service_status, hire_status,
            mot_due, tax_due, tfl_due, last_service_date, warranty_expires,
            last_service_mileage, next_service_due,
            ulez_compliant, spare_key, wifi_network,
            finance_with, finance_ends,
            co2_per_km, recommended_tyre_psi_front, recommended_tyre_psi_rear,
            vin, date_first_reg, v5_type, body_type, max_mass_kg, vehicle_category, cylinder_capacity_cc,
            fuel_type, fleet_group, is_active
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17,
            $18, $19, $20,
            $21, $22,
            $23, $24, $25,
            $26, $27, $28, $29, $30, $31, $32,
            'diesel', 'active', true
          )
          ON CONFLICT (reg) DO UPDATE SET
            vehicle_type = EXCLUDED.vehicle_type,
            simple_type = EXCLUDED.simple_type,
            make = COALESCE(EXCLUDED.make, fleet_vehicles.make),
            model = COALESCE(EXCLUDED.model, fleet_vehicles.model),
            colour = COALESCE(EXCLUDED.colour, fleet_vehicles.colour),
            seats = COALESCE(EXCLUDED.seats, fleet_vehicles.seats),
            damage_status = EXCLUDED.damage_status,
            service_status = EXCLUDED.service_status,
            hire_status = EXCLUDED.hire_status,
            mot_due = COALESCE(EXCLUDED.mot_due, fleet_vehicles.mot_due),
            tax_due = COALESCE(EXCLUDED.tax_due, fleet_vehicles.tax_due),
            tfl_due = COALESCE(EXCLUDED.tfl_due, fleet_vehicles.tfl_due),
            last_service_date = COALESCE(EXCLUDED.last_service_date, fleet_vehicles.last_service_date),
            warranty_expires = COALESCE(EXCLUDED.warranty_expires, fleet_vehicles.warranty_expires),
            last_service_mileage = COALESCE(EXCLUDED.last_service_mileage, fleet_vehicles.last_service_mileage),
            next_service_due = COALESCE(EXCLUDED.next_service_due, fleet_vehicles.next_service_due),
            ulez_compliant = EXCLUDED.ulez_compliant,
            spare_key = EXCLUDED.spare_key,
            wifi_network = COALESCE(EXCLUDED.wifi_network, fleet_vehicles.wifi_network),
            finance_with = COALESCE(EXCLUDED.finance_with, fleet_vehicles.finance_with),
            finance_ends = COALESCE(EXCLUDED.finance_ends, fleet_vehicles.finance_ends),
            co2_per_km = COALESCE(EXCLUDED.co2_per_km, fleet_vehicles.co2_per_km),
            recommended_tyre_psi_front = COALESCE(EXCLUDED.recommended_tyre_psi_front, fleet_vehicles.recommended_tyre_psi_front),
            recommended_tyre_psi_rear = COALESCE(EXCLUDED.recommended_tyre_psi_rear, fleet_vehicles.recommended_tyre_psi_rear),
            vin = COALESCE(EXCLUDED.vin, fleet_vehicles.vin),
            date_first_reg = COALESCE(EXCLUDED.date_first_reg, fleet_vehicles.date_first_reg),
            v5_type = COALESCE(EXCLUDED.v5_type, fleet_vehicles.v5_type),
            body_type = COALESCE(EXCLUDED.body_type, fleet_vehicles.body_type),
            max_mass_kg = COALESCE(EXCLUDED.max_mass_kg, fleet_vehicles.max_mass_kg),
            vehicle_category = COALESCE(EXCLUDED.vehicle_category, fleet_vehicles.vehicle_category),
            cylinder_capacity_cc = COALESCE(EXCLUDED.cylinder_capacity_cc, fleet_vehicles.cylinder_capacity_cc)
          RETURNING (xmax = 0) AS is_insert`,
          [
            v.reg, v.vehicle_type, v.simple_type, v.make, v.model, v.colour, v.seats,
            v.damage_status, v.service_status, v.hire_status,
            v.mot_due, v.tax_due, v.tfl_due, v.last_service_date, v.warranty_expires,
            v.last_service_mileage, v.next_service_due,
            v.ulez_compliant, v.spare_key, v.wifi_network,
            v.finance_with, v.finance_ends,
            v.co2_per_km, v.recommended_tyre_psi_front, v.recommended_tyre_psi_rear,
            v.vin, v.date_first_reg, v.v5_type, v.body_type, v.max_mass_kg, v.vehicle_category, v.cylinder_capacity_cc,
          ]
        );
        if (result.rows[0].is_insert) vCreated++;
        else vUpdated++;
      } catch (err) {
        vErrors++;
        console.error(`  ERROR inserting ${v.reg}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`Vehicles: ${vCreated} created, ${vUpdated} updated, ${vErrors} errors`);

    // ── Insert service records ──
    let sCreated = 0, sSkipped = 0, sErrors = 0;
    for (const sr of serviceRecords) {
      try {
        // Look up the vehicle ID by reg
        const vLookup = await client.query(
          'SELECT id FROM fleet_vehicles WHERE reg = $1',
          [sr.vehicleReg]
        );
        if (vLookup.rows.length === 0) {
          console.warn(`  Service record skipped: vehicle ${sr.vehicleReg} not found`);
          sSkipped++;
          continue;
        }
        const vehicleId = vLookup.rows[0].id;

        // Check for duplicate (same vehicle, name, and date)
        const dup = await client.query(
          `SELECT id FROM vehicle_service_log
           WHERE vehicle_id = $1 AND name = $2 AND (service_date = $3 OR (service_date IS NULL AND $3 IS NULL))`,
          [vehicleId, sr.name, sr.service_date]
        );
        if (dup.rows.length > 0) {
          sSkipped++;
          continue;
        }

        await client.query(
          `INSERT INTO vehicle_service_log (
            vehicle_id, name, service_type, service_date, mileage,
            cost, status, garage, hirehop_job, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            vehicleId, sr.name, sr.service_type, sr.service_date, sr.mileage,
            sr.cost, sr.status, sr.garage, sr.hirehop_job, sr.notes,
          ]
        );
        sCreated++;
      } catch (err) {
        sErrors++;
        console.error(`  ERROR inserting service record "${sr.name}" for ${sr.vehicleReg}:`,
          err instanceof Error ? err.message : err);
      }
    }

    console.log(`Service records: ${sCreated} created, ${sSkipped} skipped (duplicate/missing), ${sErrors} errors`);

    await client.query('COMMIT');
    console.log('\nImport complete!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, rolled back:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Entry point ──
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: npx tsx src/scripts/import-fleet-xlsx.ts /path/to/Fleet_Management_clean.xlsx');
  process.exit(1);
}

importFleet(filePath).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
