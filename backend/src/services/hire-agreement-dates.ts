/**
 * Are this job's hire agreements out of date with its dates?
 *
 * THE answer for the "hire dates have changed" warnings on Job Detail (the
 * top-of-page banner and the Drivers & Vehicles banner) and for the one
 * "Update hire forms" button behind them (`routes/hire-forms.ts`
 * `POST /job/:jobId/update-dates`). Never re-derive it beside them.
 *
 * Why it exists (HH 16892, Nov 2026): a hire extended by two days while the
 * van was out showed no warning anywhere. The old check only compared a
 * driver row's STORED hire dates with the job's, and most rows store none —
 * they follow the job — so there was nothing to compare. Nothing recorded
 * which dates the emailed agreement carried. Migration 358 records them
 * (`agreement_hire_start` / `agreement_hire_end`) every time an agreement PDF
 * is made, on the driver's row for their own van and on `hire_form_documents`
 * for a multi-van driver's agreements for the other vans.
 *
 * A driver row needs attention when:
 *   - it STORES hire dates that differ from the job's (they no longer follow
 *     the job — van availability, PCN matching and the out-of-hours reminder
 *     all read them), or
 *   - an agreement on file prints dates other than the ones it would print
 *     now. An agreement made before mig 358 has no recorded dates: it counts
 *     as out of date only when the row's stored dates have drifted (then it
 *     certainly printed the old ones); otherwise it can't be judged.
 *
 * Nothing here sends or writes anything. Revert the job's dates (a client who
 * only wanted a price) and the warning goes away by itself.
 */
import { query } from '../config/database';

/**
 * A hire date as 'YYYY-MM-DD', exactly as the hire agreement PDF prints it
 * (`routes/hire-forms.ts` `loadHireFormData()` uses this same function, so a
 * comparison between "what it printed" and "what it would print now" can't
 * disagree with itself).
 */
export function hireDateYmd(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return undefined;
    return v.toISOString().split('T')[0];
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().split('T')[0];
}

/** One agreement PDF on file and the dates it printed (null = not recorded). */
export interface AgreementOnFile {
  printedStart: string | null;
  printedEnd: string | null;
}

/** What `planAgreementRow` needs about one driver row. All dates 'YYYY-MM-DD'. */
export interface AgreementRowInput {
  storedStart: string | null;
  storedEnd: string | null;
  /** The dates an agreement made now would print (stored, else the job's). */
  printsNowStart: string | null;
  printsNowEnd: string | null;
  /** The driver's own-van agreement, if one has been made. */
  ownAgreement: AgreementOnFile | null;
  /** A multi-van driver's agreements for the other vans. */
  otherVanAgreements: AgreementOnFile[];
}

export interface AgreementRowPlan {
  /** Stored dates differ from the job's — the button moves them to the job's. */
  storedDrift: boolean;
  /** The dates the paperwork should carry once the button has run. */
  afterStart: string | null;
  afterEnd: string | null;
  ownStale: boolean;
  /** Indexes into `otherVanAgreements` that are out of date. */
  staleOtherVan: number[];
  needsAttention: boolean;
}

/**
 * Pure: does this driver row need the "Update hire forms" button, and what
 * would it change? `jobStart` / `jobEnd` are the job's dates as UK calendar
 * dates.
 */
export function planAgreementRow(
  row: AgreementRowInput,
  jobStart: string,
  jobEnd: string,
): AgreementRowPlan {
  const storedDrift =
    (!!row.storedStart && row.storedStart !== jobStart) ||
    (!!row.storedEnd && row.storedEnd !== jobEnd);

  // A stored date is moved to the job's; an unstored one keeps following the job.
  const afterStart = row.storedStart ? jobStart : row.printsNowStart;
  const afterEnd = row.storedEnd ? jobEnd : row.printsNowEnd;

  const isStale = (a: AgreementOnFile): boolean => {
    const known = !!a.printedStart || !!a.printedEnd;
    if (!known) return storedDrift; // made before mig 358 — only judge it when the row moved
    return a.printedStart !== afterStart || a.printedEnd !== afterEnd;
  };

  const ownStale = !!row.ownAgreement && isStale(row.ownAgreement);
  const staleOtherVan = row.otherVanAgreements
    .map((a, i) => (isStale(a) ? i : -1))
    .filter((i) => i >= 0);

  return {
    storedDrift,
    afterStart,
    afterEnd,
    ownStale,
    staleOtherVan,
    needsAttention: storedDrift || ownStale || staleOtherVan.length > 0,
  };
}

export interface HireDateCheckRow {
  assignmentId: string;
  vehicleId: string | null;
  vehicleReg: string | null;
  driverName: string | null;
  storedDrift: boolean;
  ownStale: boolean;
  /** `hire_form_documents` ids of the out-of-date other-van agreements. */
  staleOtherVanDocs: Array<{ docId: string; vehicleId: string; vehicleReg: string | null }>;
  /** The end date the driver's paperwork shows today (for the warning's wording). */
  wasStart: string | null;
  wasEnd: string | null;
  afterStart: string | null;
  afterEnd: string | null;
}

export interface HireDateCheck {
  jobId: string;
  hhJobNumber: number | null;
  /** The job's dates as UK calendar dates; null when the job has none. */
  jobStart: string | null;
  jobEnd: string | null;
  /** Only the driver rows that need attention. Empty = nothing to do. */
  rows: HireDateCheckRow[];
  /**
   * VE103B certificates issued for this hire that end before the job now does.
   * Only filled when `rows` isn't empty — the warning rides along with the
   * hire-form one; a VE103B is a physical certificate and OP can't extend it.
   */
  ve103b: Array<{ certificateNumber: string; vehicleReg: string | null; hireEnd: string }>;
}

// Live self-drive driver rows only: a returned / swapped / cancelled row's
// paperwork is history, and a driverless staff allocation has no agreement.
const LIVE_STATUSES = ['soft', 'confirmed', 'booked_out', 'active'];

/** Read everything the check needs for one job (OP job UUID). */
export async function getHireDateCheck(jobId: string): Promise<HireDateCheck | null> {
  const jobRes = await query(
    `SELECT id, hh_job_number, pipeline_status,
            (job_date AT TIME ZONE 'Europe/London')::date::text AS job_start,
            (job_end  AT TIME ZONE 'Europe/London')::date::text AS job_end
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobRes.rows[0];
  if (!job) return null;

  const empty: HireDateCheck = {
    jobId,
    hhJobNumber: job.hh_job_number ?? null,
    jobStart: job.job_start ?? null,
    jobEnd: job.job_end ?? null,
    rows: [],
    ve103b: [],
  };
  if (!job.job_start || !job.job_end) return empty;
  if (['completed', 'cancelled', 'lost'].includes(job.pipeline_status)) return empty;

  // The resolved dates mirror loadHireFormData() exactly (same COALESCE, same
  // join on vha.job_id), so "prints now" is what the PDF would print.
  const rowsRes = await query(
    `SELECT vha.id, vha.vehicle_id, fv.reg AS vehicle_reg, d.full_name AS driver_name,
            vha.hire_start::text AS stored_start,
            vha.hire_end::text   AS stored_end,
            COALESCE(vha.hire_start, j.job_date) AS resolved_start,
            COALESCE(vha.hire_end,   j.job_end)  AS resolved_end,
            (vha.hire_form_pdf_key IS NOT NULL)   AS has_agreement,
            vha.agreement_hire_start::text AS printed_start,
            vha.agreement_hire_end::text   AS printed_end
       FROM vehicle_hire_assignments vha
       JOIN jobs j ON j.id = vha.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
      WHERE vha.job_id = $1
        AND vha.assignment_type = 'self_drive'
        AND vha.driver_id IS NOT NULL
        AND vha.status = ANY($2::text[])
      ORDER BY vha.created_at`,
    [jobId, LIVE_STATUSES],
  );
  if (rowsRes.rows.length === 0) return empty;

  const ids = rowsRes.rows.map((r: any) => r.id as string);
  const docsRes = await query(
    `SELECT hfd.id, hfd.assignment_id, hfd.vehicle_id,
            COALESCE(hfd.vehicle_reg, fv.reg) AS vehicle_reg,
            hfd.agreement_hire_start::text AS printed_start,
            hfd.agreement_hire_end::text   AS printed_end
       FROM hire_form_documents hfd
       LEFT JOIN fleet_vehicles fv ON fv.id = hfd.vehicle_id
      WHERE hfd.assignment_id = ANY($1::uuid[])
        AND hfd.pdf_r2_key IS NOT NULL
        AND hfd.vehicle_id IS NOT NULL
      ORDER BY hfd.created_at`,
    [ids],
  );
  const docsByRow = new Map<string, any[]>();
  for (const d of docsRes.rows) {
    const list = docsByRow.get(d.assignment_id) || [];
    list.push(d);
    docsByRow.set(d.assignment_id, list);
  }

  const rows: HireDateCheckRow[] = [];
  for (const r of rowsRes.rows) {
    const docs = docsByRow.get(r.id) || [];
    const own: AgreementOnFile | null = r.has_agreement
      ? { printedStart: r.printed_start ?? null, printedEnd: r.printed_end ?? null }
      : null;
    const plan = planAgreementRow(
      {
        storedStart: r.stored_start ?? null,
        storedEnd: r.stored_end ?? null,
        printsNowStart: hireDateYmd(r.resolved_start) ?? null,
        printsNowEnd: hireDateYmd(r.resolved_end) ?? null,
        ownAgreement: own,
        otherVanAgreements: docs.map((d) => ({
          printedStart: d.printed_start ?? null,
          printedEnd: d.printed_end ?? null,
        })),
      },
      job.job_start,
      job.job_end,
    );
    if (!plan.needsAttention) continue;

    // What the driver's paperwork shows today: the agreement's recorded dates,
    // else the stored ones, else what it follows.
    const shown = own && (own.printedStart || own.printedEnd) ? own : null;
    rows.push({
      assignmentId: r.id,
      vehicleId: r.vehicle_id ?? null,
      vehicleReg: r.vehicle_reg ?? null,
      driverName: r.driver_name ?? null,
      storedDrift: plan.storedDrift,
      ownStale: plan.ownStale,
      staleOtherVanDocs: plan.staleOtherVan.map((i) => ({
        docId: docs[i].id,
        vehicleId: docs[i].vehicle_id,
        vehicleReg: docs[i].vehicle_reg ?? null,
      })),
      wasStart: shown?.printedStart ?? r.stored_start ?? hireDateYmd(r.resolved_start) ?? null,
      wasEnd: shown?.printedEnd ?? r.stored_end ?? hireDateYmd(r.resolved_end) ?? null,
      afterStart: plan.afterStart,
      afterEnd: plan.afterEnd,
    });
  }

  let ve103b: HireDateCheck['ve103b'] = [];
  if (rows.length > 0) {
    const certRes = await query(
      `SELECT certificate_number, vehicle_reg, hire_end::text AS hire_end
         FROM ve103b_certificates
        WHERE (job_id = $1 OR ($2::int IS NOT NULL AND hirehop_job_number = $2::int))
          AND status = 'issued'
          AND hire_end IS NOT NULL
          AND hire_end < $3::date
        ORDER BY created_at`,
      [jobId, job.hh_job_number ?? null, job.job_end],
    );
    ve103b = certRes.rows.map((c: any) => ({
      certificateNumber: c.certificate_number,
      vehicleReg: c.vehicle_reg ?? null,
      hireEnd: c.hire_end,
    }));
  }

  return { ...empty, rows, ve103b };
}
