/**
 * Pre-Hire Briefing builder.
 *
 * Given a job ID, returns a structured briefing for the daily ~10am email
 * that goes to info@. The briefing serves a dual purpose:
 *   - INTERNAL sanity-check for staff: outstanding requirements, money
 *     status, crew confirmation, last client contact, computed red-flags
 *     and discussion points.
 *   - DRAFT for staff to send the client: a copy-paste message block
 *     pre-filled from the same data (delivery details if D&C, balance
 *     position from HireHop, hire form follow-up, excess to collect, etc.)
 *
 * The email itself is INTERNAL — never sent to clients automatically.
 * Staff edit the draft and send it from their own inbox.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';
import { buildProgressStrips, JobProgressStrip, RequirementRow } from './job-progress-strip';
import { emailService } from './email-service';
import { renderBriefingHtml, buildSubject } from './email-templates/pre-hire-briefing';
import { resolveHireFormContacts, ResolvedContact } from './hire-form-contacts';

// SYSTEM_USER_ID matches the value used elsewhere for system-attributed
// interactions (cron jobs, automated logs). See migration 031.
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

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
  /** True if out_time is null or the default '09:00' — i.e. no real
   *  pickup time has been set, so we should ask the client what time
   *  they want to collect (skipped when transport delivery exists). */
  is_default_pickup_time: boolean;
  /** Human-readable summary of what's being hired, derived from
   *  hh_derived_flags. e.g. "the van and backline" / "the backline" /
   *  "the staging" / "the hire" (fallback). Used in the client draft. */
  equipment_summary: string;
  /** True if the job has any self-drive vans — drives whether the
   *  briefing renders Drivers/Excess/Hire-Forms sections at all. */
  has_self_drive: boolean;
  /** True if the job has any backline items. */
  has_backline: boolean;
}

export interface BriefingRequirement {
  type: string;
  label: string;
  status: string;
  notes: string | null;
}

export interface BriefingMoney {
  /** Hire value gross (inc VAT) per HireHop billing_list. Falls back to
   *  jobs.job_value (cached, gross) if HH fetch fails. */
  hire_value: number;
  /** Sum of non-excess deposits applied. 0 if no HH data available. */
  deposits_paid: number;
  /** hire_value − deposits_paid, floored at 0. */
  balance_outstanding: number;
  /** True if balance/deposits came from a successful HH fetch (vs cached). */
  hh_billing_loaded: boolean;
  excess_required: number;
  excess_taken: number;
  excess_outstanding: number;
}

export interface BriefingDriver {
  id: string;
  name: string;
  hire_form_status: 'received' | 'sent' | 'pending';
  /** When form was last emailed to them (ISO). null if never sent. */
  hire_form_emailed_at: string | null;
  /** Email address the form was sent to. null if never sent / unknown. */
  hire_form_emailed_to: string | null;
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
  /** Quote-level job_date — ISO. May differ from main job dates. */
  job_date: string | null;
  /** Arrival time on the quote (HH:MM string). */
  arrival_time: string | null;
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
  /** People associated with the job — names + emails for the staff to
   *  copy-paste into their To: field. Sourced via the same canonical
   *  resolver the hire-form picker uses (org-level + person-level +
   *  job_organisations chain). */
  contacts: ResolvedContact[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86400000);
}

/** Match Money tab's isExcessPayment keyword check (used to classify HH
 *  deposit rows). Word-bounded to avoid false hits in Stripe URLs etc. */
function isExcessKeyword(text: string): boolean {
  return /\bexcess\b|\binsurance\b|\bxs\b|\btop[- ]?up\b/.test(text.toLowerCase());
}

/** True if out_time string represents the system default (null/empty/09:00).
 *  When true AND no transport delivery exists, the email asks the client
 *  what time they'd like to collect. */
function isDefaultPickupTime(outTime: string | null): boolean {
  if (!outTime) return true;
  const trimmed = outTime.slice(0, 5);
  return trimmed === '09:00' || trimmed === '';
}

interface DerivedFlagsLite {
  has_vehicle?: boolean;
  vehicle_count?: number;
  self_drive_count?: number;
  has_backline?: boolean;
  has_rehearsal?: boolean;
  has_staging?: boolean;
  has_pa?: boolean;
  has_lighting?: boolean;
}

/**
 * Build a client-friendly summary of what's on the hire, from hh_derived_flags.
 *
 * Used to replace the hard-coded "the van and backline" in the draft —
 * a backline-only / staging-only / rehearsal-only job should read
 * correctly without the staff having to edit.
 *
 * Priority: van + backline both → "the van and backline" (most common
 * common-case phrasing). Otherwise list whatever's present; fallback to
 * a generic "the hire" if we can't determine anything.
 */
function summariseEquipment(flags: DerivedFlagsLite | null | undefined): string {
  if (!flags) return 'the hire';
  const hasVan = !!flags.has_vehicle && (flags.vehicle_count ?? 0) > 0;
  const hasBackline = !!flags.has_backline;
  const hasStaging = !!flags.has_staging;
  const hasPA = !!flags.has_pa;
  const hasLighting = !!flags.has_lighting;
  const hasRehearsal = !!flags.has_rehearsal;

  // Common-case shortcut for the most frequent phrasing.
  if (hasVan && hasBackline) return 'the van and backline';
  if (hasVan && !hasBackline && !hasStaging && !hasPA && !hasLighting) return 'the van';
  if (hasRehearsal && !hasVan) return 'the rehearsal kit';

  const parts: string[] = [];
  if (hasVan) parts.push('van');
  if (hasBackline) parts.push('backline');
  if (hasStaging) parts.push('staging');
  if (hasPA) parts.push('PA');
  if (hasLighting) parts.push('lighting');
  if (parts.length === 0) return 'the hire';
  if (parts.length === 1) return `the ${parts[0]}`;
  if (parts.length === 2) return `the ${parts[0]} and ${parts[1]}`;
  const last = parts.pop();
  return `the ${parts.join(', ')} and ${last}`;
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
            pipeline_status, status as hh_status, job_value,
            hh_derived_flags
       FROM jobs
      WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobResult.rows.length === 0) return null;
  const j = jobResult.rows[0] as Record<string, unknown>;
  const hhJobNumber = (j.hh_job_number as number | null) ?? null;

  const outDate = (j.out_date || j.job_date) as string | null;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const days_to_out = outDate
    ? daysBetween(todayStart, new Date(outDate as string))
    : 0;

  // ── Parallel fetches ───────────────────────────────────────────────
  // HH billing fetch is best-effort: failure (rate limit, network, missing
  // job number) falls back to the cached jobs.job_value for hire_value
  // and zero for deposits/balance. Cron + Money tab share the broker
  // cache so this rarely actually hits HH.
  const hhBillingPromise = hhJobNumber
    ? hhBroker
        .get('/php_functions/billing_list.php', { main_id: hhJobNumber, type: 1 }, { priority: 'low', cacheTTL: 300 })
        .catch((err: unknown) => {
          console.warn(`[pre-hire-briefing] HH billing fetch failed for job ${jobId} (HH#${hhJobNumber}):`, err);
          return null;
        })
    : Promise.resolve(null);

  const [
    requirementsResult,
    excessResult,
    driversResult,
    crewResult,
    transportResult,
    lastInteractionResult,
    hhBillingRes,
    contacts,
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
    // Drivers linked via vehicle_hire_assignments. Hire-form status is
    // tracked on the assignment row itself (no separate hire_forms table):
    // hire_form_emailed_at / hire_form_generated_at = sent, driver
    // signature_date = received. client_email is the address we sent the
    // form link to.
    query(
      `SELECT d.id, d.full_name, d.requires_referral, d.referral_status,
              d.signature_date,
              vha.status AS assignment_status,
              vha.hire_form_emailed_at,
              vha.hire_form_generated_at,
              vha.client_email,
              fv.reg AS vehicle_reg
         FROM vehicle_hire_assignments vha
         JOIN drivers d ON d.id = vha.driver_id
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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
    // Transport quotes — include date + time so we can render
    // "we're delivering on Tue 12 May at 11am to St Pancras".
    query(
      `SELECT q.id, q.job_type, q.venue_name, q.ops_status, q.client_introduction,
              q.job_date, q.arrival_time,
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
    hhBillingPromise,
    // Contacts for the To: copy block — same resolver hire forms use.
    resolveHireFormContacts(jobId).catch((err: unknown) => {
      console.warn(`[pre-hire-briefing] contacts resolve failed for job ${jobId}:`, err);
      return [] as ResolvedContact[];
    }),
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

  // ── Money summary ───────────────────────────────────────────────────
  // Excess from job_excess always loaded from OP DB.
  let excess_required = 0;
  let excess_taken = 0;
  for (const row of excessResult.rows as Array<Record<string, unknown>>) {
    excess_required += parseFloat((row.excess_amount_required as string | number | null) as string) || 0;
    excess_taken += parseFloat((row.excess_amount_taken as string | number | null) as string) || 0;
  }

  // Hire value + deposits from HH billing_list when available. Same
  // parsing pattern as routes/money.ts but simpler (we only need
  // hire_value gross + total non-excess deposits).
  const cachedHireValue = parseFloat((j.job_value as string | number | null) as string) || 0;
  let hireValueExVat = 0;
  let hireValueIncVat = 0;
  let hireDepositsTotal = 0;
  let hh_billing_loaded = false;

  const billingPayload = (hhBillingRes as { success: boolean; data: unknown } | null);
  if (billingPayload?.success && billingPayload.data) {
    const bl = billingPayload.data as Record<string, unknown>;
    const rows = (bl.rows as Array<Record<string, unknown>>) || [];
    for (const row of rows) {
      const kind = parseInt(((row.kind as string | number) ?? '0').toString(), 10);
      const data = (row.data as Record<string, unknown>) || {};
      if (kind === 0) {
        // Job total — accrued = ex-VAT, total = inc-VAT (if present)
        hireValueExVat = parseFloat((row.accrued as string) || (data.accrued as string) || (data.ACCRUED as string) || '0');
        const grossCandidate = parseFloat((row.total as string) || (data.total as string) || (data.TOTAL as string) || '0');
        hireValueIncVat = grossCandidate || hireValueExVat * 1.2;
      } else if (kind === 6) {
        const credit = parseFloat((row.credit as string) || (data.credit as string) || '0');
        if (credit <= 0) continue; // refunds skipped
        const description = String((data.DESCRIPTION as string) || (row.desc as string) || '');
        const memo = String((data.MEMO as string) || '');
        if (!isExcessKeyword(description + ' ' + memo)) {
          hireDepositsTotal += credit;
        }
      }
    }
    hh_billing_loaded = true;
  }

  const moneyHireValue = hh_billing_loaded
    ? (hireValueIncVat || hireValueExVat || cachedHireValue)
    : cachedHireValue;
  const balanceOutstanding = Math.max(0, moneyHireValue - hireDepositsTotal);

  const money: BriefingMoney = {
    hire_value: moneyHireValue,
    deposits_paid: hireDepositsTotal,
    balance_outstanding: balanceOutstanding,
    hh_billing_loaded,
    excess_required,
    excess_taken,
    excess_outstanding: Math.max(0, excess_required - excess_taken),
  };

  // ── Drivers ────────────────────────────────────────────────────────
  const drivers: BriefingDriver[] = (driversResult.rows as Array<Record<string, unknown>>).map(r => {
    // Hire-form status precedence: signature_date wins (received).
    // Otherwise, emailed_at or generated_at means we've at least sent
    // them the link / PDF. Anything else = pending.
    let hire_form_status: 'received' | 'sent' | 'pending' = 'pending';
    if (r.signature_date) hire_form_status = 'received';
    else if (r.hire_form_emailed_at || r.hire_form_generated_at) hire_form_status = 'sent';
    return {
      id: r.id as string,
      name: (r.full_name as string) || 'Unknown',
      hire_form_status,
      hire_form_emailed_at: (r.hire_form_emailed_at as string) || null,
      hire_form_emailed_to: (r.client_email as string) || null,
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
    job_date: (r.job_date as string) || null,
    arrival_time: (r.arrival_time as string) || null,
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

  // ── Derived equipment summary + self-drive flag ────────────────────
  const derivedFlags = (j.hh_derived_flags as DerivedFlagsLite | null) || null;
  const has_self_drive = !!derivedFlags?.has_vehicle
    && (derivedFlags?.self_drive_count ?? derivedFlags?.vehicle_count ?? 0) > 0;
  const has_backline = !!derivedFlags?.has_backline;
  const equipment_summary = summariseEquipment(derivedFlags);

  // ── Red flags & discussion points ──────────────────────────────────
  const red_flags: BriefingFlag[] = [];
  const discussion_points: string[] = [];

  // WARNING: HH billing fetch failed. Without it we can't compute live
  // balance, so the email's money paragraph is suppressed. Make the
  // failure explicit so staff verify in HH before sending the draft.
  if (hhJobNumber && !hh_billing_loaded) {
    red_flags.push({
      severity: 'warning',
      label: 'HireHop balance fetch failed — please verify payment position in HH before sending the draft',
    });
    discussion_points.push('Live HireHop balance unavailable — confirm hire-fee position before drafting money paragraph');
  }

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

  // Hire fee position — surface live balance when we have HH data,
  // otherwise just remind staff to check HH.
  if (money.hh_billing_loaded && money.hire_value > 0) {
    if (money.balance_outstanding > 0) {
      const depositLabel = money.deposits_paid > 0
        ? `£${money.deposits_paid.toFixed(2)} deposit paid`
        : 'no deposit yet';
      discussion_points.push(
        `Hire fee balance: £${money.balance_outstanding.toFixed(2)} due (${depositLabel} of £${money.hire_value.toFixed(2)})`
      );
    } else if (money.hire_value > 0) {
      discussion_points.push(`Hire fee £${money.hire_value.toFixed(2)} paid in full ✓`);
    }
  } else if (money.hire_value > 0) {
    discussion_points.push(`Hire fee £${money.hire_value.toFixed(0)} — confirm balance position with HireHop (live data unavailable)`);
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
    hh_job_number: hhJobNumber,
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
    is_default_pickup_time: isDefaultPickupTime((j.out_time as string) || null),
    equipment_summary,
    has_self_drive,
    has_backline,
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
    contacts,
  };
}

// ── Send + log helper ───────────────────────────────────────────────────

export interface SendBriefingResult {
  success: boolean;
  subject: string | null;
  sent_to: string | null;
  message_id: string | null;
  error: string | null;
}

/**
 * Build, render, send, and log a pre-hire review email for a single job.
 *
 * Used by both the manual "Send Pre-Hire Review" button and the daily
 * scheduler — keeping both paths in this single helper guarantees they
 * produce identical emails AND identical audit trails (interaction on the
 * job timeline + email_log row).
 *
 * @param jobId       — OP job UUID
 * @param recipient   — defaults to PRE_HIRE_BRIEFING_RECIPIENT env or info@
 * @param triggeredBy — optional UUID of the staff user who clicked manually;
 *                       null/undefined = scheduler / system attribution.
 */
export async function sendBriefingEmail(
  jobId: string,
  recipient?: string,
  triggeredBy?: string | null,
): Promise<SendBriefingResult> {
  const briefing = await buildBriefing(jobId);
  if (!briefing) {
    return { success: false, subject: null, sent_to: null, message_id: null, error: 'Job not found' };
  }
  const to = recipient
    || process.env.PRE_HIRE_BRIEFING_RECIPIENT
    || 'info@oooshtours.co.uk';
  const subject = buildSubject(briefing);
  const html = renderBriefingHtml(briefing);
  const result = await emailService.send('pre_hire_briefing', {
    to,
    subjectOverride: subject,
    bodyHtmlOverride: html,
  });
  if (!result.success) {
    return { success: false, subject, sent_to: to, message_id: null, error: result.error || 'Email send failed' };
  }
  const actualRecipient = result.redirectedTo || to;

  // Log interaction on the job timeline. Best-effort — failure here
  // doesn't surface as a send failure (the email already went out).
  try {
    const trigger = triggeredBy ? 'manual' : 'scheduled';
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by)
       VALUES ('note', $1, $2, $3)`,
      [
        `📧 Pre-Hire Review email sent to ${actualRecipient} (${trigger}). Subject: "${subject}"`,
        jobId,
        triggeredBy || SYSTEM_USER_ID,
      ],
    );
  } catch (err) {
    console.warn(`[pre-hire-briefing] interaction log failed for job ${jobId}:`, err);
  }

  return {
    success: true,
    subject,
    sent_to: actualRecipient,
    message_id: result.messageId || null,
    error: null,
  };
}

/**
 * Look up the most recent pre-hire review send for a job, used to show
 * "Last sent: ..." next to the manual button. Returns null if never sent.
 */
export interface LastSentInfo {
  sent_at: string;
  recipient: string | null;
  sent_by_name: string | null;
  trigger: 'manual' | 'scheduled' | null;
}

export async function getLastBriefingSend(jobId: string): Promise<LastSentInfo | null> {
  // Source the timestamp from email_log (authoritative — captures both
  // manual + scheduled). The column on email_log is `created_at` (set
  // at send time — there's no separate sent_at). Cross-reference the
  // interactions row for the attribution name (who clicked / system).
  const result = await query(
    `SELECT el.created_at AS sent_at, el.actual_recipient, el.subject,
            i.created_by AS interaction_user_id,
            CONCAT(p.first_name, ' ', p.last_name) AS sent_by_name,
            i.content AS interaction_content
       FROM email_log el
       LEFT JOIN interactions i
         ON i.job_id = $1
        AND i.type = 'note'
        AND i.content LIKE '%Pre-Hire Review email sent%'
        AND i.created_at >= el.created_at - INTERVAL '5 seconds'
        AND i.created_at <= el.created_at + INTERVAL '60 seconds'
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE el.template_id = 'pre_hire_briefing'
        AND el.status = 'sent'
        AND el.subject LIKE '%' || COALESCE((SELECT '#' || hh_job_number::text FROM jobs WHERE id = $1), '~no-match~') || '%'
      ORDER BY el.created_at DESC
      LIMIT 1`,
    [jobId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0] as Record<string, unknown>;
  const content = (r.interaction_content as string) || '';
  const isManual = content.includes('(manual)');
  const isScheduled = content.includes('(scheduled)');
  return {
    sent_at: r.sent_at as string,
    recipient: (r.actual_recipient as string) || null,
    sent_by_name: (r.sent_by_name as string) || null,
    trigger: isManual ? 'manual' : isScheduled ? 'scheduled' : null,
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
