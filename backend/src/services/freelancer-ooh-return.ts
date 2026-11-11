/**
 * Out-of-hours van returns for FREELANCERS (jon, Nov 2026; migration 335;
 * docs/FREELANCER-PORTAL-SPEC.md §8). THE definition: the staff tick, the
 * 10:00 run, the portal's link and the public parking page all come here.
 *
 * A freelancer bringing an Ooosh van back to the yard after we've closed (a van
 * they collected from a hirer, a van they took backline out in, or a Van & Driver
 * job) gets the procedure by EMAIL ONLY: gate code, where to park, the key drop
 * (never the letterbox or the grey cupboard), leave the backline in the van, and
 * a link to tell us where they parked (the hirers' /return-parking/:token page).
 *
 * - On by default when the van is due back late (Nov 2026, migration 339): a leg
 *   whose van comes back to the yard (vanComesBack()) and is due back at or after
 *   `ooh_auto_from` (16:40) or before `ooh_auto_until` (09:00), by the venue time
 *   + about half an hour on site + the drive back (backAtYardMinutes()). The
 *   automatic answer is worked out when it's needed, never stored, so a changed
 *   time can't leave a stale copy.
 * - Staff can still turn it on or off by hand on the freelancer's job
 *   (`quotes.ooh_return`: NULL automatic, TRUE on, FALSE off).
 * - The email goes on the job's LAST day (a Van & Driver run may span days): at
 *   once if a hand tick lands on or after that day, otherwise by the run every
 *   half hour from 10:00 (so a time changed on the day is still caught).
 *   Once per freelancer per job (`freelancer_ooh_returns.info_sent_at`).
 * - It ignores the freelancer's email pause: it's an instruction for a job they
 *   have taken, like a cancellation (never shouldSuppressInformational()).
 * - NOT the hirer's `vehicle_hire_assignments.return_overnight`, which emails and
 *   texts the HIRER and counts late returns against them.
 *
 * Which van: the one they collected (`soft_checked_in_by_person_id`) or their
 * Van & Driver van (`freelancer_person_id`), looked up when the page opens (a
 * collection is usually after the email). Nothing records the van for a backline
 * run, so the page asks for the number plate then.
 */
import { randomBytes } from 'crypto';
import { query } from '../config/database';
import { emailService } from './email-service';
import { getSystemSettings } from '../routes/system-settings';
import { getFrontendUrl } from '../config/app-urls';
import { greetingName, fullDisplayName } from './display-name';
import { ukToday } from './uk-date';
import { LAST_WORK_DAY_SQL } from './quote-schedule';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
/** How long the parking link keeps working after the job's last day. */
const LINK_DAYS_AFTER = 2;

const newToken = () => randomBytes(24).toString('base64url');

// ── The automatic rule ──────────────────────────────────────────────────────

/** Roughly the calculator's on-site allowance for a delivery or collection (handover + unload). */
const ON_SITE_MINS = 30;

/** "16:40" (or "16:40:00") as minutes after midnight; null if it isn't a time. */
export function hhmmToMinutes(v: unknown): number | null {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The facts on a quotes row the rule reads. */
export interface OohLegFacts {
  job_type?: unknown; what_is_it?: unknown; travel_method?: unknown;
  arrival_time?: unknown; drive_time_mins?: unknown;
}

/**
 * Does a van come back to our yard at the end of this leg? Any collection (by
 * train there and the van back, or the van both ways), and a backline or People
 * delivery driven there and back (the calculator's "vehicle" travel; a quick
 * local quote stores none). Never a hire-van delivery: the van stays with the
 * customer. Crew and Van & Driver work have no reliable return time, so they
 * stay a tick by hand.
 */
export function vanComesBack(q: OohLegFacts): boolean {
  if (q.job_type === 'collection') return true;
  return q.job_type === 'delivery'
    && (q.what_is_it === 'equipment' || q.what_is_it === 'people')
    && q.travel_method !== 'public_transport';
}

/**
 * When the van should be back in the yard, in minutes after midnight on the
 * job's day (past 24:00 when it's after midnight): the venue time + about half
 * an hour on site + the one-way drive. Null when no van comes back or there's
 * no time on the quote.
 */
export function backAtYardMinutes(q: OohLegFacts): number | null {
  if (!vanComesBack(q)) return null;
  const at = hhmmToMinutes(q.arrival_time);
  if (at == null) return null;
  const drive = Math.max(0, Math.round(Number(q.drive_time_mins) || 0));
  return at + ON_SITE_MINS + drive;
}

export interface OohAutoRule { from: number; until: number }

/** The rule's times from Settings (16:40 and 09:00 unless changed). */
export async function getAutoRule(): Promise<OohAutoRule> {
  const s = await getSystemSettings(['ooh_auto_from', 'ooh_auto_until']);
  return {
    from: hhmmToMinutes(s.ooh_auto_from) ?? 16 * 60 + 40,
    until: hhmmToMinutes(s.ooh_auto_until) ?? 9 * 60,
  };
}

/** The automatic answer, and the estimated time back ("17:30") for the staff pill. */
export function autoOohReturn(q: OohLegFacts, rule: OohAutoRule): { on: boolean; backAt: string | null } {
  const back = backAtYardMinutes(q);
  if (back == null) return { on: false, backAt: null };
  const ofDay = back % 1440;
  const backAt = `${String(Math.floor(ofDay / 60)).padStart(2, '0')}:${String(ofDay % 60).padStart(2, '0')}`;
  return { on: back >= rule.from || back < rule.until, backAt };
}

/** On for this leg? A person's choice wins; otherwise the automatic rule. */
export function effectiveOohReturn(q: OohLegFacts & { ooh_return?: unknown }, rule: OohAutoRule): boolean {
  if (q.ooh_return === true) return true;
  if (q.ooh_return === false) return false;
  return autoOohReturn(q, rule).on;
}

/** Add whole days to a YYYY-MM-DD date. */
function plusDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Thursday 5 November". */
function longDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return Number.isNaN(dt.getTime()) ? ymd
    : dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function parkingUrl(token: string): string {
  return `${getFrontendUrl()}/return-parking/${token}`;
}

/** The freelancers on a job who are told (not declined/cancelled, not the "Ooosh Staff" placeholder). */
const RECIPIENTS_SQL = `
  SELECT qa.person_id, p.first_name, p.last_name, p.preferred_name, p.email,
         q.id AS quote_id, q.job_id, j.hh_job_number, j.job_name,
         q.ooh_return, q.job_type, q.what_is_it, q.travel_method, q.arrival_time, q.drive_time_mins,
         (${LAST_WORK_DAY_SQL})::text AS last_day,
         r.id AS row_id, r.parking_token, r.info_sent_at
    FROM quotes q
    JOIN quote_assignments qa ON qa.quote_id = q.id
    JOIN people p ON p.id = qa.person_id
    LEFT JOIN jobs j ON j.id = q.job_id
    LEFT JOIN freelancer_ooh_returns r ON r.quote_id = q.id AND r.person_id = qa.person_id
   WHERE qa.status NOT IN ('declined', 'cancelled')
     AND COALESCE(qa.is_ooosh_crew, false) = false
     AND p.is_freelancer = true
     AND COALESCE(p.is_deleted, false) = false
     AND p.email IS NOT NULL AND p.email <> ''`;

/** Live quotes not turned off by hand (NULL is automatic): never for a cancelled job or leg. */
const LIVE_QUOTE_SQL = `q.ooh_return IS NOT FALSE
     AND COALESCE(q.is_deleted, false) = false
     AND COALESCE(q.status, '') <> 'cancelled'
     AND COALESCE(q.ops_status, '') <> 'cancelled'
     AND (j.id IS NULL OR j.pipeline_status NOT IN ('lost', 'cancelled'))`;

interface RecipientRow extends OohLegFacts {
  person_id: string; first_name: string | null; last_name: string | null; preferred_name: string | null; email: string;
  quote_id: string; job_id: string | null; hh_job_number: number | null; job_name: string | null;
  ooh_return: boolean | null;
  last_day: string | null; row_id: string | null; parking_token: string | null; info_sent_at: Date | null;
}

/** The link row for one freelancer on one job, made on first need. */
async function ensureRow(quoteId: string, personId: string): Promise<{ id: string; token: string }> {
  const r = await query(
    `INSERT INTO freelancer_ooh_returns (quote_id, person_id, parking_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (quote_id, person_id) DO UPDATE SET quote_id = EXCLUDED.quote_id
     RETURNING id, parking_token`,
    [quoteId, personId, newToken()],
  );
  return { id: r.rows[0].id, token: r.rows[0].parking_token };
}

/** Email one freelancer the procedure. Stamps info_sent_at only when the send worked. */
async function sendTo(row: RecipientRow): Promise<boolean> {
  const link = await ensureRow(row.quote_id, row.person_id);
  const s = await getSystemSettings(['ooh_gate_code', 'ooh_yard_address', 'ooh_yard_maps_url', 'ooh_keydrop_photo_url', 'ooh_what3words']);
  const result = await emailService.send('freelancer_ooh_return_info', {
    to: row.email,
    variables: {
      freelancerName: greetingName(row),
      jobNumber: String(row.hh_job_number ?? ''),
      jobName: row.job_name || '',
      jobDate: row.last_day ? longDay(row.last_day) : 'tonight',
      gateCode: s.ooh_gate_code || 'call us for it',
      yardAddress: s.ooh_yard_address || 'Ooosh Tours',
      yardMapsUrl: s.ooh_yard_maps_url || '',
      what3words: s.ooh_what3words || '',
      keydropPhotoUrl: s.ooh_keydrop_photo_url || '',
      parkingFormUrl: parkingUrl(link.token),
    },
  });
  if (!result.success) return false;
  await query(`UPDATE freelancer_ooh_returns SET info_sent_at = NOW() WHERE id = $1`, [link.id]);
  return true;
}

/**
 * Email everyone on one job who hasn't had it, if the job's last day has come.
 * For a hand tick (on), so it doesn't ask the automatic rule. Returns what
 * happened, for the staff tick.
 */
export async function sendForQuote(quoteId: string): Promise<{ due: boolean; sent: number; failed: number }> {
  const r = await query(
    `${RECIPIENTS_SQL} AND q.id = $1 AND ${LIVE_QUOTE_SQL}`,
    [quoteId],
  );
  const rows = r.rows as RecipientRow[];
  const today = ukToday();
  const lastDay = rows[0]?.last_day ?? null;
  if (!lastDay || lastDay > today) return { due: false, sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  for (const row of rows.filter((x) => !x.info_sent_at)) {
    try { if (await sendTo(row)) sent++; else failed++; }
    catch (err) { failed++; console.error('[freelancer-ooh] send failed', row.quote_id, row.person_id, err); }
  }
  return { due: true, sent, failed };
}

/**
 * Staff click: on, off, or back to automatic (`null`). Turning it on sends
 * straight away when the day has come; back to automatic sends straight away
 * if the rule says on and today is the day. A job that finished more than
 * LINK_DAYS_AFTER days ago can't be turned on (`tooLate`): its link would
 * already be dead, so the email would be no use. `on` in the answer is the
 * effective state, `auto` whether it follows the rule.
 */
export async function setOohReturn(quoteId: string, on: boolean | null): Promise<{
  on: boolean; auto: boolean; due: boolean; sent: number; failed: number; tooLate?: boolean;
} | null> {
  if (on === true) {
    const d = await query(`SELECT (${LAST_WORK_DAY_SQL})::text AS last_day FROM quotes q WHERE q.id = $1`, [quoteId]);
    if (!d.rows.length) return null;
    const lastDay = d.rows[0].last_day as string | null;
    if (lastDay && ukToday() > plusDays(lastDay, LINK_DAYS_AFTER)) {
      return { on: false, auto: false, due: false, sent: 0, failed: 0, tooLate: true };
    }
  }
  const r = await query(
    `UPDATE quotes SET ooh_return = $1, updated_at = NOW() WHERE id = $2
     RETURNING job_type, what_is_it, travel_method, arrival_time, drive_time_mins`,
    [on, quoteId],
  );
  if (!r.rows.length) return null;
  if (on === false) return { on: false, auto: false, due: false, sent: 0, failed: 0 };
  if (on === true) return { on: true, auto: false, ...(await sendForQuote(quoteId)) };
  const rule = await getAutoRule();
  const auto = autoOohReturn(r.rows[0], rule).on;
  const run = await runFreelancerOohInfo(quoteId);
  return { on: auto, auto: true, due: run.due, sent: run.sent, failed: run.failed };
}

/**
 * The run (every half hour from 10:00, config/scheduler.ts): every job whose
 * last day is today and that is on, by hand or by the rule, for anyone not yet
 * emailed. With a quote id, just that job (the staff click).
 */
export async function runFreelancerOohInfo(quoteId?: string): Promise<{ due: boolean; sent: number; failed: number }> {
  const params: unknown[] = [ukToday()];
  if (quoteId) params.push(quoteId);
  const r = await query(
    `${RECIPIENTS_SQL} AND ${LIVE_QUOTE_SQL}
       AND r.info_sent_at IS NULL
       AND (${LAST_WORK_DAY_SQL}) = $1::date
       ${quoteId ? 'AND q.id = $2' : ''}`,
    params,
  );
  const rule = await getAutoRule();
  const rows = (r.rows as RecipientRow[]).filter((row) => effectiveOohReturn(row, rule));
  let sent = 0; let failed = 0;
  for (const row of rows) {
    try { if (await sendTo(row)) sent++; else failed++; }
    catch (err) { failed++; console.error('[freelancer-ooh] run send failed', row.quote_id, row.person_id, err); }
  }
  if (!quoteId && (sent || failed)) console.log(`[freelancer-ooh] run: ${sent} sent, ${failed} failed`);
  return { due: rows.length > 0, sent, failed };
}

/** The van this freelancer has on the job: the one they collected, or their Van & Driver van. */
async function vanFor(personId: string, jobId: string | null, hh: number | null): Promise<{ id: string; reg: string } | null> {
  if (!jobId && hh == null) return null;
  const r = await query(
    `SELECT fv.id, fv.reg
       FROM vehicle_hire_assignments vha
       JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE (vha.job_id = $2 OR vha.hirehop_job_id = $3)
        AND vha.status <> 'cancelled'
        AND (vha.soft_checked_in_by_person_id = $1
             OR (vha.assignment_type = 'driven' AND vha.freelancer_person_id = $1))
      ORDER BY vha.soft_checked_in_at DESC NULLS LAST, vha.updated_at DESC
      LIMIT 1`,
    [personId, jobId, hh],
  );
  return r.rows[0] ? { id: r.rows[0].id, reg: r.rows[0].reg } : null;
}

export interface FreelancerOohContext {
  rowId: string;
  quoteId: string;
  jobId: string | null;
  hhJobNumber: number | null;
  jobName: string | null;
  personName: string;
  vehicleId: string | null;
  vehicleReg: string | null;
  alreadySubmitted: boolean;
}

/**
 * A freelancer parking link: valid while the job is ticked and live, until
 * LINK_DAYS_AFTER days after its last day. Null otherwise.
 */
export async function resolveFreelancerOohToken(token: string): Promise<FreelancerOohContext | null> {
  if (!token || token.length < 16 || token.length > 64) return null;
  const r = await query(
    `SELECT fr.id AS row_id, fr.quote_id, fr.person_id, fr.vehicle_id, fr.returned_at,
            q.job_id, j.hh_job_number, j.job_name, (${LAST_WORK_DAY_SQL})::text AS last_day,
            p.first_name, p.last_name, p.preferred_name, fv.reg AS vehicle_reg
       FROM freelancer_ooh_returns fr
       JOIN quotes q ON q.id = fr.quote_id
       JOIN people p ON p.id = fr.person_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = fr.vehicle_id
      WHERE fr.parking_token = $1 AND ${LIVE_QUOTE_SQL}`,
    [token],
  );
  const row = r.rows[0];
  if (!row || !row.last_day) return null;
  if (ukToday() > plusDays(row.last_day, LINK_DAYS_AFTER)) return null;
  let vehicleId: string | null = row.vehicle_id;
  let vehicleReg: string | null = row.vehicle_reg;
  if (!vehicleId) {
    const van = await vanFor(row.person_id, row.job_id, row.hh_job_number);
    if (van) {
      vehicleId = van.id; vehicleReg = van.reg;
      await query(`UPDATE freelancer_ooh_returns SET vehicle_id = $1 WHERE id = $2 AND vehicle_id IS NULL`, [van.id, row.row_id]);
    }
  }
  return {
    rowId: row.row_id, quoteId: row.quote_id, jobId: row.job_id, hhJobNumber: row.hh_job_number,
    jobName: row.job_name, personName: fullDisplayName(row) || 'Freelancer',
    vehicleId, vehicleReg, alreadySubmitted: !!row.returned_at,
  };
}

/** "te45 reg" → "TE45REG", to match fleet_vehicles.reg however it was typed. */
function regKey(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Record where a freelancer parked: the row, a note on the job's timeline and
 * (unless turned off, `ooh_cc_info_email`) an email to info@ the first time.
 * `typedReg` is the number plate from the page when we didn't know the van.
 */
export async function recordFreelancerOohSubmission(ctx: FreelancerOohContext, opts: {
  lat: number; lng: number; notes: string | null; typedReg?: string | null;
}): Promise<void> {
  let vehicleId = ctx.vehicleId;
  let reg = ctx.vehicleReg;
  if (!vehicleId && opts.typedReg && regKey(opts.typedReg)) {
    const v = await query(
      `SELECT id, reg FROM fleet_vehicles WHERE regexp_replace(UPPER(reg), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`,
      [regKey(opts.typedReg)],
    );
    if (v.rows[0]) { vehicleId = v.rows[0].id; reg = v.rows[0].reg; }
    else reg = opts.typedReg.trim().toUpperCase().slice(0, 12);
  }
  await query(
    `UPDATE freelancer_ooh_returns
        SET returned_at = COALESCE(returned_at, NOW()), parking_lat = $1, parking_lng = $2,
            parking_notes = $3, vehicle_id = COALESCE(vehicle_id, $4)
      WHERE id = $5`,
    [opts.lat, opts.lng, opts.notes, vehicleId, ctx.rowId],
  );

  const mapsLink = `https://www.google.com/maps?q=${opts.lat},${opts.lng}`;
  const who = `${ctx.personName} (freelancer)`;
  const van = reg || 'the van';
  if (ctx.jobId) {
    const noteSnippet = opts.notes ? ` Notes: ${opts.notes.slice(0, 200)}.` : '';
    await query(
      `INSERT INTO interactions (job_id, type, content, created_by) VALUES ($1, 'note', $2, $3)`,
      [ctx.jobId, `🌙 Out-of-hours return: ${who} parked ${van}.${noteSnippet} Location: ${mapsLink}${ctx.alreadySubmitted ? ' (updated)' : ''}`, SYSTEM_USER_ID],
    ).catch((err) => console.warn('[freelancer-ooh] timeline note failed:', err));
  }

  const cc = await getSystemSettings(['ooh_cc_info_email']);
  if (cc.ooh_cc_info_email !== 'false' && !ctx.alreadySubmitted) {
    const result = await emailService.send('ooh_return_received_internal', {
      to: 'info@oooshtours.co.uk',
      variables: {
        driverName: who,
        vehicleReg: van,
        jobNumber: String(ctx.hhJobNumber ?? ''),
        submittedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }),
        coordsLine: `${opts.lat.toFixed(5)}, ${opts.lng.toFixed(5)}`,
        mapsLink,
        notes: opts.notes || '',
        jobUrl: ctx.jobId ? `${getFrontendUrl()}/jobs/${ctx.jobId}` : getFrontendUrl(),
      },
    }).catch((err) => { console.warn('[freelancer-ooh] info@ email failed:', err); return null; });
    if (result && !result.success) console.warn('[freelancer-ooh] info@ email not sent');
  }
}

/**
 * For the portal's job page: this freelancer's parking link, once their email
 * has gone and for as long as the page itself accepts it (same rules as
 * resolveFreelancerOohToken, so the portal never shows a dead link).
 */
export async function portalParkingUrlFor(quoteId: string, personId: string): Promise<string | null> {
  const r = await query(
    `SELECT fr.parking_token, (${LAST_WORK_DAY_SQL})::text AS last_day
       FROM freelancer_ooh_returns fr
       JOIN quotes q ON q.id = fr.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
      WHERE fr.quote_id = $1 AND fr.person_id = $2 AND fr.info_sent_at IS NOT NULL
        AND ${LIVE_QUOTE_SQL}`,
    [quoteId, personId],
  );
  const row = r.rows[0];
  if (!row || !row.last_day || ukToday() > plusDays(row.last_day, LINK_DAYS_AFTER)) return null;
  return parkingUrl(row.parking_token);
}
