/**
 * The yard and building codes a freelancer sees in the portal, and WHEN
 * (jon, Nov 2026). THE definition: the portal routes ask this, nothing else
 * reads the code settings for a freelancer.
 *
 * One place to update them: Settings › Out-of-Hours Returns
 * (`ooh_gate_code`, `site_cupboard_code`, `site_lockbox_code`, migration 325).
 *
 * - The yard GATE code: on any job's page from its first day to the day after
 *   its last (a late collection gets back after midnight). Low secrecy: every
 *   hirer returning out of hours is already emailed it.
 * - The grey CUPBOARD and key LOCKBOX codes are the building's keys, so they
 *   only reach a studio sitter, on their shift page, on the day of the shift.
 *
 * Never on a list or a page that is always there: a Resources "Codes" page
 * would let every freelancer login, past ones included, read the building's
 * key code at any time (FREELANCER-PORTAL-SPEC §8). A code that isn't set
 * comes back null, and the portal shows nothing for it.
 */
import { getSystemSettings } from '../routes/system-settings';
import { ukToday } from './uk-date';
import { lastWorkDay } from './quote-schedule';
import { dateOnly } from './leads/dates';

export interface SitterCodes {
  gate: string | null;
  cupboard: string | null;
  lockbox: string | null;
}

/** A setting's value, trimmed; blank is "not set". */
function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/** Add whole days to a YYYY-MM-DD date. */
function plusDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * A studio sitter's codes for one evening: all three, but only when the
 * evening is today (UK) and the shift is real (not cancelled, not merely
 * "needed"). Null otherwise, or when none of them is set.
 */
export async function sitterCodesFor(shift: { date: string; status: string | null }): Promise<SitterCodes | null> {
  if (shift.date !== ukToday()) return null;
  if (!shift.status || shift.status === 'cancelled' || shift.status === 'needed') return null;
  const s = await getSystemSettings(['ooh_gate_code', 'site_cupboard_code', 'site_lockbox_code']);
  const codes = { gate: clean(s.ooh_gate_code), cupboard: clean(s.site_cupboard_code), lockbox: clean(s.site_lockbox_code) };
  return codes.gate || codes.cupboard || codes.lockbox ? codes : null;
}

/**
 * The yard gate code for a job's page: from the job's first day to the day
 * after its last, unless the job is cancelled. Null otherwise.
 */
export async function gateCodeForJob(row: {
  job_type?: unknown; job_date?: unknown; job_finish_date?: unknown; num_days?: unknown;
  status?: unknown; ops_status?: unknown;
}): Promise<string | null> {
  if (row.ops_status === 'cancelled' || row.status === 'cancelled') return null;
  const first = dateOnly(row.job_date);
  const last = lastWorkDay(row);
  if (!first || !last) return null;
  const today = ukToday();
  if (today < first || today > plusDays(last, 1)) return null;
  const s = await getSystemSettings(['ooh_gate_code']);
  return clean(s.ooh_gate_code);
}
