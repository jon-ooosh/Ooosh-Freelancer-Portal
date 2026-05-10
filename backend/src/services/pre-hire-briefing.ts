/**
 * Pre-Hire Briefing builder.
 *
 * Given a job ID, returns a structured briefing for the daily 10am email
 * that goes to info@. Pulls together everything the rota staff need to
 * sanity-check a hire before it leaves: outstanding requirements, money
 * status, crew confirmation, last client contact, plus a few computed
 * red-flags / discussion points.
 *
 * The briefing is INTERNAL — never sent to clients. The email it powers
 * includes a templated "copy-paste this to the client" block built from
 * the same data.
 */
import { query } from '../config/database';
import { buildProgressStrips, JobProgressStrip, RequirementRow } from './job-progress-strip';

// ── Types ───────────────────────────────────────────────────────────────

export interface BriefingJob {
  id: string;
  hh_job_number: number | null;
  job_name: string;
  client_name: string | null;
  company_name: string | null;
  venue_name: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  out_time: string | null;
  return_time: string | null;
  pipeline_status: string;
  hh_status: number;
  job_value: number | null;
  /** Days until out_date (or job_date). Negative if in the past. */
  days_to_out: number;
  /** Has D&C transport quote OR crew assignments — affects email cadence. */
  is_transport_heavy: boolean;
}

export interface BriefingRequirement {
  type: string;
  label: string;
  status: string;
  notes: string | null;
}

export interface BriefingMoney {
  hire_value: number;
  excess_required: number;
  excess_taken: number;
  excess_outstanding: number;
}

export interface BriefingDriver {
  id: string;
  name: string;
  hire_form_status: 'received' | 'sent' | 'pending';
  referral_status: 'pending' | 'approved' | 'declined' | null;
  vehicle_reg: string | null;
}

export interface BriefingCrew {
  id: string;
  name: string;
  role: string;
  status: string;
  is_freelancer: boolean;
  is_ooosh_crew: boolean;
}

export interface BriefingTransport {
  id: string;
  job_type: string;
  venue: string | null;
  ops_status: string | null;
  client_intro_status: string | null;
  crew_count: number;
}

export interface BriefingInteraction {
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  days_ago: number;
}

export interface BriefingFlag {
  severity: 'urgent' | 'warning' | 'info';
  label: string;
}

export interface JobBriefing {
  job: BriefingJob;
  progress_strip: JobProgressStrip;
  outstanding: BriefingRequirement[];
  money: BriefingMoney;
  drivers: BriefingDriver[];
  crew: BriefingCrew[];
  transport: BriefingTransport[];
  last_interaction: BriefingInteraction | null;
  red_flags: BriefingFlag[];
  discussion_points: string[];
  links: { job_detail: string; hirehop: string | null };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86400000);
}

function safeName(j: { client_name: string | null; company_name: string | null }): string {
  return j.client_name || j.company_name || 'Unknown';
}

// ── Main builder ────────────────────────────────────────────────────────

/**
 * Build a structured pre-hire briefing for a single job.
 *
 * @param jobId — OP job UUID
 * @param frontendBaseUrl — e.g. https://staff.oooshtours.co.uk — used to
 *   produce absolute job-detail links inside the email body. Defaults to
 *   the env value if not passed.
 */
export async function buildBriefing(
  jobId: string,
  frontendBaseUrl?: string,
): Promise<JobBriefing | null> {
  const baseUrl = frontendBaseUrl
    || process.env.FRONTEND_URL
    || 'https://staff.oooshtours.co.uk';

  // ── Job basics ─────────────────────────────────────────────────────
  const jobResult = await query(
    `SELECT id, hh_job_number, job_name, client_name, company_name, venue_name,
            out_date, job_date, job_end, return_date, out_time, return_time,
            pipeline_status, status as hh_status, job_value
       FROM jobs
      WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobResult.rows.length === 0) return null;
  const j = jobResult.rows[0] as Record<string, unknown>;

  const outDate = (j.out_date || j.job_date) as string | null;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const days_to_out = outDate
    ? daysBetween(todayStart, new Date(outDate as string))
    : 0;

  // ── Parallel fetches ───────────────────────────────────────────────
  const [
    requirementsResult,
    excessResult,
    driversResult,
    crewResult,
    transportResult,
    lastInteractionResult,
  ] = await Promise.all([
    // All pre-hire requirements with their labels
    query(
      `SELECT jr.requirement_type, jr.status, jr.notes, rtd.label, rtd.icon
         FROM job_requirements jr
         LEFT JOIN requirement_type_definitions rtd ON rtd.type = jr.requirement_type
        WHERE jr.job_id = $1 AND jr.phase = 'pre_hire'
        ORDER BY rtd.sort_order ASC NULLS LAST, jr.requirement_type ASC`,
      [jobId],
    ),
    // Excess records on this job (driver-linked or job-level)
    query(
      `SELECT je.id, je.excess_status, je.excess_amount_required,
              je.excess_amount_taken
         FROM job_excess je
         LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        WHERE je.job_id = $1
           OR vha.job_id = $1`,
      [jobId],
    ),
    // Drivers linked via vehicle_hire_assignments
    query(
      `SELECT d.id, d.full_name, d.requires_referral, d.referral_status,
              d.signature_date,
              vha.status AS assignment_status,
              fv.reg AS vehicle_reg,
              hf.id AS hire_form_id
         FROM vehicle_hire_assignments vha
         JOIN drivers d ON d.id = vha.driver_id
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         LEFT JOIN hire_forms hf ON hf.assignment_id = vha.id
        WHERE vha.job_id = $1
          AND vha.status NOT IN ('cancelled', 'returned')
        ORDER BY d.full_name ASC`,
      [jobId],
    ),
    // Crew via quote_assignments
    query(
      `SELECT qa.id, qa.role, qa.status, qa.is_ooosh_crew,
              p.id AS person_id, p.first_name, p.last_name, p.is_freelancer
         FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id
         LEFT JOIN people p ON p.id = qa.person_id
        WHERE q.job_id = $1
          AND qa.status != 'cancelled'
          AND q.status != 'cancelled'
        ORDER BY p.first_name ASC NULLS LAST`,
      [jobId],
    ),
    // Transport quotes
    query(
      `SELECT q.id, q.job_type, q.venue_name, q.ops_status, q.client_introduction,
              v.name AS linked_venue_name,
              (SELECT COUNT(*) FROM quote_assignments qa
                WHERE qa.quote_id = q.id AND qa.status != 'cancelled') AS crew_count
         FROM quotes q
         LEFT JOIN venues v ON v.id = q.venue_id
        WHERE q.job_id = $1
          AND q.is_deleted = false
          AND q.status != 'cancelled'
        ORDER BY q.created_at ASC`,
      [jobId],
    ),
    // Last client-facing interaction
    query(
      `SELECT i.type, i.content, i.created_at,
              CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
         FROM interactions i
         LEFT JOIN users u ON u.id = i.created_by
         LEFT JOIN people p ON p.id = u.person_id
        WHERE i.job_id = $1
          AND i.type IN ('email', 'phone', 'meeting', 'note', 'chase')
        ORDER BY i.created_at DESC
        LIMIT 1`,
      [jobId],
    ),
  ]);

  // ── Progress strip (pre-hire phase) ─────────────────────────────────
  const stripRows: RequirementRow[] = (requirementsResult.rows as Array<Record<string, unknown>>).map(r => ({
    job_id: jobId,
    requirement_type: r.requirement_type as string,
    status: r.status as string | null,
    phase: 'pre_hire',
  }));
  const strips = buildProgressStrips(stripRows, { [jobId]: 'pre_hire' });
  const progress_strip = strips[jobId] || {};

  // ── Outstanding requirements (not 'done') ──────────────────────────
  const outstanding: BriefingRequirement[] = (requirementsResult.rows as Array<Record<string, unknown>>)
    .filter(r => r.status !== 'done')
    .map(r => ({
      type: r.requirement_type as string,
      label: (r.label as string) || (r.requirement_type as string),
      status: (r.status as string) || 'not_started',
      notes: (r.notes as string) || null,
    }));

  // ── Money summary (excess from job_excess + hire value cached on job) ─
  let excess_required = 0;
  let excess_taken = 0;
  for (const row of excessResult.rows as Array<Record<string, unknown>>) {
    excess_required += parseFloat((row.excess_amount_required as string | number | null) as string) || 0;
    excess_taken += parseFloat((row.excess_amount_taken as string | number | null) as string) || 0;
  }
  const money: BriefingMoney = {
    hire_value: parseFloat((j.job_value as string | number | null) as string) || 0,
    excess_required,
    excess_taken,
    excess_outstanding: Math.max(0, excess_required - excess_taken),
  };

  // ── Drivers ────────────────────────────────────────────────────────
  const drivers: BriefingDriver[] = (driversResult.rows as Array<Record<string, unknown>>).map(r => {
    let hire_form_status: 'received' | 'sent' | 'pending' = 'pending';
    if (r.signature_date) hire_form_status = 'received';
    else if (r.hire_form_id) hire_form_status = 'sent';
    return {
      id: r.id as string,
      name: (r.full_name as string) || 'Unknown',
      hire_form_status,
      referral_status: r.requires_referral
        ? ((r.referral_status as 'pending' | 'approved' | 'declined' | null) || 'pending')
        : null,
      vehicle_reg: (r.vehicle_reg as string) || null,
    };
  });

  // ── Crew ───────────────────────────────────────────────────────────
  const crew: BriefingCrew[] = (crewResult.rows as Array<Record<string, unknown>>).map(r => ({
    id: (r.id as string),
    name: [(r.first_name as string) || '', (r.last_name as string) || ''].join(' ').trim() || 'Unassigned',
    role: (r.role as string) || 'Crew',
    status: (r.status as string) || 'assigned',
    is_freelancer: (r.is_freelancer as boolean) ?? false,
    is_ooosh_crew: (r.is_ooosh_crew as boolean) ?? false,
  }));

  // ── Transport ──────────────────────────────────────────────────────
  const transport: BriefingTransport[] = (transportResult.rows as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    job_type: (r.job_type as string) || 'transport',
    venue: ((r.linked_venue_name as string) || (r.venue_name as string)) || null,
    ops_status: (r.ops_status as string) || null,
    client_intro_status: (r.client_introduction as string) || null,
    crew_count: parseInt(((r.crew_count as string | number) ?? '0') as string, 10) || 0,
  }));

  // ── Transport-heavy detection ──────────────────────────────────────
  // True if ANY D&C quote OR ANY crew assignment exists.
  const is_transport_heavy = transport.some(t => t.job_type === 'delivery' || t.job_type === 'collection' || t.job_type === 'crewed')
    || crew.length > 0;

  // ── Last interaction ───────────────────────────────────────────────
  const last_interaction: BriefingInteraction | null = lastInteractionResult.rows.length > 0
    ? (() => {
        const r = lastInteractionResult.rows[0] as Record<string, unknown>;
        const created = new Date(r.created_at as string);
        return {
          type: r.type as string,
          content: ((r.content as string) || '').slice(0, 200),
          created_at: r.created_at as string,
          created_by_name: (r.created_by_name as string) || null,
          days_ago: daysBetween(created, todayStart),
        };
      })()
    : null;

  // ── Red flags & discussion points ──────────────────────────────────
  const red_flags: BriefingFlag[] = [];
  const discussion_points: string[] = [];

  const driversNeedingForm = drivers.filter(d => d.hire_form_status !== 'received');

  // RED FLAG: 1 day or less to out_date AND any required hire forms still missing
  if (days_to_out <= 1 && driversNeedingForm.length > 0) {
    red_flags.push({
      severity: 'urgent',
      label: `${driversNeedingForm.length} hire form${driversNeedingForm.length === 1 ? '' : 's'} still missing — hire starts in ${days_to_out <= 0 ? 'less than 24h' : '1 day'}`,
    });
  } else if (driversNeedingForm.length > 0) {
    discussion_points.push(
      `Hire form${driversNeedingForm.length === 1 ? ' still' : 's still'} outstanding from: ${driversNeedingForm.map(d => d.name).join(', ')}`
    );
  }

  // Pending referrals — always a flag
  const pendingReferrals = drivers.filter(d => d.referral_status === 'pending');
  if (pendingReferrals.length > 0) {
    red_flags.push({
      severity: 'warning',
      label: `${pendingReferrals.length} driver${pendingReferrals.length === 1 ? '' : 's'} pending insurance referral`,
    });
  }

  // Excess outstanding — discussion point (clients commonly pay on the day)
  if (money.excess_outstanding > 0) {
    discussion_points.push(`Insurance excess £${money.excess_outstanding.toFixed(0)} still to be collected`);
  }

  // Hire value placeholder reminder when present
  if (money.hire_value > 0) {
    discussion_points.push(`Hire fee £${money.hire_value.toFixed(0)} — confirm balance position with HireHop`);
  }

  // No client contact in N days
  if (!last_interaction) {
    discussion_points.push('No interaction logged on this job — worth touching base');
  } else if (last_interaction.days_ago >= 7) {
    discussion_points.push(`Last client interaction was ${last_interaction.days_ago} days ago`);
  }

  // Crew unconfirmed
  const unconfirmedCrew = crew.filter(c => c.status === 'assigned');
  if (unconfirmedCrew.length > 0) {
    discussion_points.push(
      `${unconfirmedCrew.length} crew assignment${unconfirmedCrew.length === 1 ? '' : 's'} not yet confirmed: ${unconfirmedCrew.map(c => c.name).join(', ')}`
    );
  }

  // Transport client introduction not done
  const introsTodo = transport.filter(t => t.client_intro_status === 'todo' || t.client_intro_status === 'working_on_it');
  if (introsTodo.length > 0) {
    discussion_points.push(
      `Client not yet introduced to driver${introsTodo.length === 1 ? '' : 's'} for ${introsTodo.map(t => t.venue || t.job_type).join(', ')}`
    );
  }

  // ── Build briefing ─────────────────────────────────────────────────
  const briefingJob: BriefingJob = {
    id: j.id as string,
    hh_job_number: (j.hh_job_number as number | null) ?? null,
    job_name: (j.job_name as string) || 'Untitled job',
    client_name: (j.client_name as string) || null,
    company_name: (j.company_name as string) || null,
    venue_name: (j.venue_name as string) || null,
    out_date: (j.out_date as string) || null,
    job_date: (j.job_date as string) || null,
    job_end: (j.job_end as string) || null,
    return_date: (j.return_date as string) || null,
    out_time: (j.out_time as string) || null,
    return_time: (j.return_time as string) || null,
    pipeline_status: (j.pipeline_status as string) || 'unknown',
    hh_status: (j.hh_status as number) ?? 0,
    job_value: (j.job_value as number | null) ?? null,
    days_to_out,
    is_transport_heavy,
  };

  return {
    job: briefingJob,
    progress_strip,
    outstanding,
    money,
    drivers,
    crew,
    transport,
    last_interaction,
    red_flags,
    discussion_points,
    links: {
      job_detail: `${baseUrl}/jobs/${jobId}`,
      hirehop: briefingJob.hh_job_number
        ? `https://myhirehop.com/job.php?id=${briefingJob.hh_job_number}`
        : null,
    },
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────

export interface EligibleJob {
  id: string;
  hh_job_number: number | null;
  job_name: string;
  client_name: string | null;
  out_date: string | null;
  days_to_out: number;
  is_transport_heavy: boolean;
  /** 'standard' (3 days), 'transport_early' (5 days), or 'urgent' (1 day, hire forms missing) */
  trigger_reason: 'standard' | 'transport_early' | 'urgent';
}

/**
 * Find all confirmed jobs that should receive a pre-hire briefing today.
 *
 * Triggers (any one):
 *   - 3 days to out_date (standard)
 *   - 5 days to out_date AND has D&C quote or crew (transport-heavy / earlier)
 *   - 1 day to out_date AND any hire form missing (urgent)
 *
 * Each job is sent at most once per day (we let the email_log dedupe at the
 * scheduler level — if a job already received a briefing today we skip it).
 */
export async function findEligibleJobs(): Promise<EligibleJob[]> {
  // Pull confirmed jobs starting in the next 5 days. Frontend baseUrl
  // resolution lives on the consumer side so we keep the query lean.
  const result = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
            j.out_date, j.job_date,
            COALESCE(j.out_date::date, j.job_date::date) AS effective_date,
            (COALESCE(j.out_date::date, j.job_date::date) - CURRENT_DATE) AS days_to_out,
            EXISTS(
              SELECT 1 FROM quotes q
               WHERE q.job_id = j.id
                 AND q.is_deleted = false
                 AND q.status != 'cancelled'
                 AND q.job_type IN ('delivery','collection','crewed')
            ) AS has_transport_quote,
            EXISTS(
              SELECT 1 FROM quote_assignments qa
                JOIN quotes q ON q.id = qa.quote_id
               WHERE q.job_id = j.id
                 AND qa.status != 'cancelled'
                 AND q.status != 'cancelled'
            ) AS has_crew,
            EXISTS(
              SELECT 1 FROM vehicle_hire_assignments vha
                JOIN drivers d ON d.id = vha.driver_id
               WHERE vha.job_id = j.id
                 AND vha.status NOT IN ('cancelled', 'returned')
                 AND d.signature_date IS NULL
            ) AS has_unsigned_driver
       FROM jobs j
      WHERE j.is_deleted = false
        AND j.pipeline_status = 'confirmed'
        AND COALESCE(j.out_date::date, j.job_date::date) IS NOT NULL
        AND COALESCE(j.out_date::date, j.job_date::date) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '5 days'`,
    [],
  );

  const out: EligibleJob[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const days_to_out = parseInt(((row.days_to_out as number | string) || '0').toString(), 10);
    const is_transport_heavy = (row.has_transport_quote as boolean) || (row.has_crew as boolean);
    const has_unsigned_driver = (row.has_unsigned_driver as boolean);

    let trigger: EligibleJob['trigger_reason'] | null = null;
    if (days_to_out <= 1 && has_unsigned_driver) {
      trigger = 'urgent';
    } else if (days_to_out === 3) {
      trigger = 'standard';
    } else if (days_to_out === 5 && is_transport_heavy) {
      trigger = 'transport_early';
    }
    if (!trigger) continue;

    out.push({
      id: row.id as string,
      hh_job_number: (row.hh_job_number as number | null) ?? null,
      job_name: (row.job_name as string) || 'Untitled job',
      client_name: (row.client_name as string) || (row.company_name as string) || null,
      out_date: (row.out_date as string) || (row.job_date as string) || null,
      days_to_out,
      is_transport_heavy,
      trigger_reason: trigger,
    });
  }
  return out;
}
