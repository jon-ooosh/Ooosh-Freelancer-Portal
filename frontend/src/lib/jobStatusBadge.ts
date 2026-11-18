/**
 * A job's status badge on a list row — label + colour. Shared by Upcoming & Out
 * (JobsPage) and Returns & Completed (ReturnsPage) so the two lists can't drift
 * (moved out of JobsPage, Nov 2026).
 */
import {
  PIPELINE_STATUS_CONFIG,
  OPERATIONAL_STATUS_CONFIG,
  PipelineStatus,
  OperationalStatus,
} from '../../../shared/types';

const STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
  10: 'Not Interested', 11: 'Completed',
};

// Resolve a job's display badge from pipeline_status (OP truth) first,
// falling back to HH integer status only when pipeline_status is missing.
// HH auto-jumps to 5 (Dispatched) on item checkout while OP intentionally
// holds at 'prepped' until staff explicitly marks the job On Hire.
export function getStatusBadge(job: { pipeline_status: string | null; status: number; status_name: string | null }): {
  label: string;
  colour: string | null;
  fallbackClass: string | null;
} {
  if (job.pipeline_status) {
    const ps = job.pipeline_status as PipelineStatus;
    if (PIPELINE_STATUS_CONFIG[ps]) {
      const cfg = PIPELINE_STATUS_CONFIG[ps];
      return { label: cfg.label, colour: cfg.colour, fallbackClass: null };
    }
    const ops = job.pipeline_status as unknown as OperationalStatus;
    if (OPERATIONAL_STATUS_CONFIG[ops]) {
      const cfg = OPERATIONAL_STATUS_CONFIG[ops];
      return { label: cfg.label, colour: cfg.colour, fallbackClass: null };
    }
  }
  return {
    label: STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`,
    colour: null,
    fallbackClass: STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600',
  };
}

const STATUS_COLOURS: Record<number, string> = {
  0: 'bg-blue-100 text-blue-700',
  1: 'bg-amber-100 text-amber-700',
  2: 'bg-green-100 text-green-700',
  3: 'bg-purple-100 text-purple-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-indigo-100 text-indigo-700',
  6: 'bg-yellow-100 text-yellow-800',
  7: 'bg-teal-100 text-teal-700',
  8: 'bg-red-100 text-red-700',
  9: 'bg-gray-100 text-gray-500 line-through',
  10: 'bg-gray-100 text-gray-500',
  11: 'bg-emerald-100 text-emerald-700',
};
