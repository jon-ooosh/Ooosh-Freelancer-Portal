/**
 * THE job status badge definition — label + Tailwind colour for a job's
 * `pipeline_status`, falling back to the raw HireHop numeric `status` when the
 * OP status hasn't been set.
 *
 * Lifted out of HireHistoryTab (which now imports from here) so the venue
 * "Linked Jobs" tab shows an identical badge rather than growing a fourth
 * private copy of the same map. GlobalSearch and the dashboard keep their own
 * — they label a deliberately narrower set for a different purpose.
 */

/** HireHop numeric status codes — see CLAUDE.md § HireHop status mapping. */
export const HH_STATUS_LABELS: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete', 7: 'Returned',
  8: 'Requires Attention', 9: 'Cancelled', 10: 'Not Interested', 11: 'Completed',
};

export const PIPELINE_LABELS: Record<string, { label: string; colour: string }> = {
  new_enquiry: { label: 'Enquiry', colour: 'bg-blue-100 text-blue-700' },
  quoting: { label: 'Quoting', colour: 'bg-cyan-100 text-cyan-700' },
  chasing: { label: 'Chasing', colour: 'bg-amber-100 text-amber-700' },
  provisional: { label: 'Provisional', colour: 'bg-red-100 text-red-700' },
  paused: { label: 'Paused', colour: 'bg-gray-100 text-gray-600' },
  confirmed: { label: 'Confirmed', colour: 'bg-green-100 text-green-700' },
  lost: { label: 'Lost', colour: 'bg-gray-100 text-gray-500' },
  cancelled: { label: 'Cancelled', colour: 'bg-gray-100 text-gray-500' },
  prepped: { label: 'Prepped', colour: 'bg-purple-100 text-purple-700' },
  dispatched: { label: 'Dispatched', colour: 'bg-indigo-100 text-indigo-700' },
  returned: { label: 'Returned', colour: 'bg-teal-100 text-teal-700' },
  returned_incomplete: { label: 'Checking In', colour: 'bg-yellow-100 text-yellow-800' },
  completed: { label: 'Completed', colour: 'bg-emerald-100 text-emerald-700' },
};

export function jobStatusDisplay(
  job: { pipeline_status?: string | null; status?: number | null }
): { label: string; colour: string } {
  if (job.pipeline_status && PIPELINE_LABELS[job.pipeline_status]) {
    return PIPELINE_LABELS[job.pipeline_status];
  }
  if (job.status == null) return { label: 'Unknown', colour: 'bg-gray-100 text-gray-600' };
  return {
    label: HH_STATUS_LABELS[job.status] || `Status ${job.status}`,
    colour: 'bg-gray-100 text-gray-600',
  };
}
