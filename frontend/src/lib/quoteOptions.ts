/**
 * Quote options — display helpers (docs/QUOTE-VERSIONS-SPEC.md; "version" there
 * is "option" in code). Backend twin: services/job-groups.ts.
 *
 * The "(Option N)" suffix lives in the REAL job_name so HireHop, the quote PDFs
 * and the emails all agree; the Job Detail header strips it and shows a pill
 * instead. Strip for display only — never when saving a name.
 */
import { PIPELINE_STATUS_CONFIG, OPERATIONAL_STATUS_CONFIG } from '../../../shared/types';
import type { JobGroupMember, PipelineStatus, OperationalStatus } from '../../../shared/types';

const OPTION_SUFFIX_RE = /\s*\(Option\s+(\d+)\)\s*$/i;

/** The job name without its "(Option N)" suffix. */
export function stripOptionSuffix(name: string | null | undefined): string {
  return String(name ?? '').replace(OPTION_SUFFIX_RE, '').trim();
}

/** The lost reason for an option the client didn't pick (mirrors backend ALTERNATIVE_QUOTE_LOST_REASON). */
export const ALTERNATIVE_QUOTE_LOST_REASON = 'Confirmed Alternative Quote (from us)';

/** Statuses an option can still be chosen from (mirrors backend PRE_CONFIRMED_STATUSES). */
export const OPTION_OPEN_STATUSES = ['new_enquiry', 'quoting', 'chasing', 'paused', 'provisional'];

export function isOptionOpen(status: string | null | undefined): boolean {
  return OPTION_OPEN_STATUSES.includes(status || '');
}

export function isOptionDead(status: string | null | undefined): boolean {
  return status === 'lost' || status === 'cancelled';
}

/** Label + colour for an option's pill, from the shared status configs. */
export function optionStatusStyle(m: Pick<JobGroupMember, 'pipeline_status' | 'is_chasing'>): { label: string; colour: string } {
  if (m.is_chasing) return PIPELINE_STATUS_CONFIG.chasing;
  const s = (m.pipeline_status || '') as PipelineStatus | OperationalStatus;
  if (s in PIPELINE_STATUS_CONFIG) return PIPELINE_STATUS_CONFIG[s as PipelineStatus];
  if (s in OPERATIONAL_STATUS_CONFIG) return OPERATIONAL_STATUS_CONFIG[s as OperationalStatus];
  return { label: s || 'Unknown', colour: '#9CA3AF' };
}

/** "5–21 Aug" style inside-dates for a pill. */
export function optionDateSpan(m: Pick<JobGroupMember, 'job_date' | 'job_end' | 'out_date' | 'return_date'>): string {
  const start = m.job_date || m.out_date;
  const end = m.job_end || m.return_date;
  const fmt = (d: string | null, withMonth: boolean) => {
    if (!d) return null;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString('en-GB', withMonth ? { day: 'numeric', month: 'short' } : { day: 'numeric' });
  };
  if (!start) return '';
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const sameMonth = e && !Number.isNaN(e.getTime()) && s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const b = fmt(end, true);
  const a = fmt(start, !sameMonth || !b);
  if (!a) return '';
  if (!b || a === b) return a;
  return `${a}–${b}`;
}
