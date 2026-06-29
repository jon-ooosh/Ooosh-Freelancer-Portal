/**
 * PCN "will this liability transfer actually fly?" pre-flight check.
 *
 * A SOFT advisory only — it never blocks the transfer_liability action. The
 * point is to warn staff "this representation is likely to be rejected" BEFORE
 * they fire it at the council, so they can fall back to Pay & recharge instead
 * of burning a doomed representation and having liability bounce back weeks
 * later.
 *
 * Grounded in the statutory transfer mechanism:
 *  - To transfer a council PCN to the hirer, the hire agreement must carry the
 *    prescribed particulars (Sch 2, Road Traffic (Owner Liability) Regs 2000
 *    SI 2000/2546 — reg/make+model/hirer name/DOB/address/licence) AND a signed
 *    statement of liability, AND the contravention must fall inside the hire
 *    window. A missing applicable particular is "fatal to the hire agreement"
 *    (London Tribunals, Camden v Europcar) — liability stays with us.
 *  - Bus-lane contraventions from LONDON authorities can't be transferred at
 *    all (London Local Authorities Act 1996 lacuna). Outside London they
 *    transfer normally via the signed statement (SI 2005/2757 reg 5(2)).
 */
import { query } from '../config/database';

export type TransferWarningCode =
  | 'no_driver'
  | 'no_hire_agreement'
  | 'missing_make_model'
  | 'missing_particulars'
  | 'offence_outside_window'
  | 'london_bus_lane';

export interface TransferWarning {
  code: TransferWarningCode;
  /** 'high' = likely to be rejected; 'info' = be aware. */
  severity: 'high' | 'info';
  message: string;
}

export interface TransferReadiness {
  /** false when any high-severity warning is present. */
  ok: boolean;
  warnings: TransferWarning[];
}

// London authorities for the bus-lane carve-out. ILIKE '%london%' / '%tfl%'
// catches "London Borough of …", "Transport for London", "London Councils";
// the borough list catches the ones whose name doesn't contain "London"
// (Camden, Hackney, Westminster, etc.). Soft heuristic — over-warning here is
// harmless (staff confirm the issuer), under-warning is the costlier miss.
const LONDON_BOROUGHS = [
  'camden', 'westminster', 'islington', 'hackney', 'lambeth', 'southwark',
  'tower hamlets', 'wandsworth', 'kensington', 'chelsea', 'hammersmith',
  'fulham', 'haringey', 'lewisham', 'greenwich', 'newham', 'brent', 'ealing',
  'hounslow', 'richmond', 'kingston', 'merton', 'sutton', 'croydon', 'bromley',
  'bexley', 'havering', 'redbridge', 'barking', 'dagenham', 'enfield',
  'waltham forest', 'barnet', 'harrow', 'hillingdon', 'city of london',
];

function looksLondon(issuer: string | null): boolean {
  if (!issuer) return false;
  const s = issuer.toLowerCase();
  if (s.includes('london') || s.includes('tfl') || s.includes('transport for london')) return true;
  return LONDON_BOROUGHS.some((b) => s.includes(b));
}

function looksBusLane(...fields: (string | null)[]): boolean {
  return fields.some((f) => !!f && /bus\s*(lane|gate)/i.test(f));
}

/**
 * Assess whether a council-PCN liability transfer is likely to stick. Read-only.
 */
export async function assessTransferReadiness(pcnId: string): Promise<TransferReadiness> {
  const r = await query(
    `SELECT
        p.fine_type, p.offence_at, p.issuing_authority,
        p.offence_description, p.location, p.hh_job_number,
        p.driver_id, p.driver_person_id, p.vehicle_id, p.assignment_id, p.job_id,
        fv.reg                                AS fleet_reg,
        fv.make                               AS vehicle_make,
        fv.model                              AS vehicle_model,
        d.signature_date,
        (d.date_of_birth IS NOT NULL OR d.date_of_birth_encrypted IS NOT NULL) AS has_dob,
        (COALESCE(d.address_full, d.address_line1,
                  d.address_full_encrypted, d.address_line1_encrypted) IS NOT NULL) AS has_address,
        (d.licence_number IS NOT NULL) AS has_licence,
        vha.id                                AS resolved_assignment_id,
        vha.hire_form_pdf_key,
        COALESCE(vha.hire_start, j.job_date)  AS hire_start,
        COALESCE(vha.hire_end, j.job_end)     AS hire_end
      FROM pcns p
      LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
      LEFT JOIN drivers d         ON d.id = p.driver_id
      LEFT JOIN jobs j            ON j.id = p.job_id
      LEFT JOIN LATERAL (
        SELECT a.* FROM vehicle_hire_assignments a
        WHERE (p.assignment_id IS NOT NULL AND a.id = p.assignment_id)
           OR (p.assignment_id IS NULL AND p.vehicle_id IS NOT NULL
               AND a.vehicle_id = p.vehicle_id
               AND (a.job_id = p.job_id OR a.hirehop_job_id = p.hh_job_number))
        ORDER BY a.booked_out_at DESC NULLS LAST
        LIMIT 1
      ) vha ON true
      WHERE p.id = $1 AND p.is_deleted = false`,
    [pcnId],
  );
  if (r.rows.length === 0) return { ok: true, warnings: [] };
  const p = r.rows[0];
  const warnings: TransferWarning[] = [];

  // 1. London bus lane — can't be transferred at all (legal lacuna).
  if (looksBusLane(p.offence_description, p.location, p.issuing_authority)) {
    if (looksLondon(p.issuing_authority)) {
      warnings.push({
        code: 'london_bus_lane',
        severity: 'high',
        message:
          'This looks like a London bus-lane PCN. Liability for London bus-lane ' +
          'contraventions cannot be transferred to the hirer (a gap in the London ' +
          'Local Authorities Act 1996) — the hire company stays liable. Use Pay & ' +
          'recharge the client instead.',
      });
    } else {
      warnings.push({
        code: 'london_bus_lane',
        severity: 'info',
        message:
          'This looks like a bus-lane PCN. Outside London these transfer normally, ' +
          'but if the issuer is a London authority liability cannot be transferred ' +
          '— check the issuing authority before sending.',
      });
    }
  }

  // 2. No driver identified — nothing/no-one to name to the issuer.
  if (!p.driver_id && !p.driver_person_id) {
    warnings.push({
      code: 'no_driver',
      severity: 'high',
      message:
        'No driver is linked to this PCN. You can’t name who was liable. Match a ' +
        'driver first, or request the driver ID from the client.',
    });
  }

  // 3. No signed hire agreement to evidence the transfer.
  if (p.driver_id && !p.hire_form_pdf_key && !p.signature_date) {
    warnings.push({
      code: 'no_hire_agreement',
      severity: 'high',
      message:
        'No signed hire agreement is on file for this hire. Councils require a copy ' +
        'of the signed hiring agreement with the representation — without it the ' +
        'transfer will be refused.',
    });
  }

  // 4. Vehicle make/model missing from the fleet record — the agreement won't
  // name it, which is the exact omission councils reject (Camden v Europcar).
  if (p.vehicle_id && !p.vehicle_make && !p.vehicle_model) {
    warnings.push({
      code: 'missing_make_model',
      severity: 'high',
      message:
        `No make/model on file for ${p.fleet_reg || 'this vehicle'}. The hire ` +
        'agreement is required to name the exact make and model — add it to the ' +
        'fleet record (Vehicle › Settings) before transferring, or the ' +
        'representation may be rejected.',
    });
  }

  // 5. Other prescribed particulars missing on the driver record.
  if (p.driver_id) {
    const missing: string[] = [];
    if (!p.has_dob) missing.push('date of birth');
    if (!p.has_address) missing.push('address');
    if (!p.has_licence) missing.push('licence number');
    if (missing.length) {
      warnings.push({
        code: 'missing_particulars',
        severity: 'info',
        message:
          `The hire agreement may be missing prescribed particulars (${missing.join(', ')}). ` +
          'These are statutory requirements for a valid transfer — fill them in on the ' +
          'driver record where possible.',
      });
    }
  }

  // 6. Contravention falls outside the recorded hire window.
  if (p.offence_at && (p.hire_start || p.hire_end)) {
    const offence = new Date(p.offence_at);
    const start = p.hire_start ? new Date(p.hire_start) : null;
    const end = p.hire_end ? new Date(p.hire_end) : null;
    // Compare on date to avoid 09:00-boundary false positives (the agreement
    // window is day-granular at the edges).
    const dayOnly = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const o = dayOnly(offence);
    const beforeStart = start && o < dayOnly(start);
    const afterEnd = end && o > dayOnly(end);
    if (beforeStart || afterEnd) {
      warnings.push({
        code: 'offence_outside_window',
        severity: 'high',
        message:
          'The offence date falls outside the recorded hire window for this vehicle. ' +
          'The issuer will reject a transfer if the contravention wasn’t during the ' +
          'hire — double-check the dates before sending.',
      });
    }
  }

  return { ok: !warnings.some((w) => w.severity === 'high'), warnings };
}
