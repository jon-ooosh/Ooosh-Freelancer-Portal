/**
 * Which hires does the vehicle VAT correction (14 Oct 2026) touch?
 *
 * Read-only. Until 14 Oct 2026 OP and the payment portal split a VEHICLE's VAT by UK /
 * non-UK days on any hire under 31 days. The rule (Ooosh! Tours guide to VAT on hires)
 * is: vehicles are zero-rated only on a 31+ day hire or one that starts AND ends outside
 * the UK — otherwise 20% on the whole vehicle hire. This lists every job carrying a
 * "Non-standard VAT rules" item (not cancelled / lost; open, or ended in the last 180
 * days) with what the vehicles' VAT was under the old split, what it is now, what the
 * client has paid towards the hire, and the invoices already raised.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx tsx src/scripts/vat-vehicle-rule-sweep.ts
 */
import { query } from '../config/database';
import { calculateVatAdjustment, hireDaysBetween, VEHICLE_ZERO_RATE_MIN_DAYS } from '../services/vat-adjustment';
import { readBillingRows } from '../services/hh-deposit-release';
import { invoiceRows, invoiceStatus, invoiceGross } from '../services/hh-invoice-close';

const r2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${r2(n).toFixed(2)}`;

async function main() {
  const jobs = await query(
    `SELECT id, hh_job_number, job_name, pipeline_status, job_date, job_end, out_date, return_date
       FROM jobs
      WHERE hh_job_number IS NOT NULL
        AND COALESCE(is_deleted, false) = false
        AND pipeline_status NOT IN ('cancelled', 'lost')
        AND line_items::text ILIKE '%non-standard vat%'
        AND (pipeline_status <> 'completed' OR COALESCE(job_end, return_date) >= CURRENT_DATE - 180)
      ORDER BY COALESCE(job_date, out_date)`,
  );
  console.log(`${jobs.rows.length} job(s) carry a "Non-standard VAT rules" item.\n`);

  let affected = 0;
  for (const j of jobs.rows) {
    const hh = Number(j.hh_job_number);
    const hireDays = hireDaysBetween(j.job_date || j.out_date, j.job_end || j.return_date);
    const adj = await calculateVatAdjustment(hh, hireDays).catch(() => null);
    if (!adj) {
      console.log(`  ${hh}  ${j.job_name} — no adjustment (no non-UK days on the item, or HireHop unreadable)`);
      continue;
    }
    const vehicles = adj.breakdown.find((b) => b.category === 'Vehicles');
    const vehicleNet = adj.vehicleRevenue;
    const newVehicleVat = vehicles ? vehicles.subtotalVat : 0;
    // The old rule: 0% at 31+ days, otherwise the UK share of the days at 20%.
    const oldVehicleVat = hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS ? 0 : vehicleNet * (adj.ukDays / hireDays) * 0.2;
    const diff = r2(newVehicleVat - oldVehicleVat);
    if (Math.abs(diff) < 0.005) continue;
    affected++;

    const paid = await query(
      `SELECT COALESCE(SUM(CASE WHEN payment_type IN ('deposit', 'balance') THEN amount
                                WHEN payment_type = 'refund' THEN -amount ELSE 0 END), 0)::float8 AS paid
         FROM job_payments WHERE job_id = $1`,
      [j.id],
    );
    let invoices = '—';
    try {
      const rows = await readBillingRows(hh);
      const approved = invoiceRows(rows).filter((r) => invoiceStatus(r) >= 2);
      if (approved.length) invoices = approved.map((r) => `${r.data?.NUMBER || r.number} ${gbp(invoiceGross(r) ?? 0)}`).join(', ');
    } catch { invoices = '(HireHop unreadable)'; }

    const hirePaid = Number(paid.rows[0]?.paid || 0);
    console.log(`  ${hh}  ${j.job_name}  [${j.pipeline_status}]`);
    console.log(`        ${hireDays} days, ${adj.nonUkDays} non-UK · vehicles ${gbp(vehicleNet)} ex VAT`);
    console.log(`        vehicle VAT ${gbp(oldVehicleVat)} → ${gbp(newVehicleVat)} (${diff > 0 ? '+' : ''}${gbp(diff)})`);
    console.log(`        hire total now ${gbp(adj.adjustedTotal)} · hire paid ${gbp(hirePaid)} · still to pay ${gbp(adj.adjustedTotal - hirePaid)}`);
    console.log(`        invoices: ${invoices}\n`);
  }
  console.log(`${affected} job(s) change under the corrected rule.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
