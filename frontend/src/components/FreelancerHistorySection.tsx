/**
 * FreelancerHistorySection — per-person view of everything ever assigned to a
 * freelancer, across three sources (crew/transport quotes, studio sitter
 * shifts, driven vehicle assignments). Assignment-grained — shows the person's
 * OWN assignment status + their fee, unlike the job-grained Hire History tab.
 *
 * Cancelled/declined rows are deliberately included (rendered muted) — that's
 * the point of this tab.
 *
 * Mounted as the "Freelancer History" tab on PersonDetailPage (freelancers only).
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface FreelancerHistoryItem {
  source: 'crew' | 'sitter' | 'vehicle';
  id: string;
  title: string;
  role: string | null;
  job_type: string | null;
  is_local: boolean | null;
  date_start: string | null;
  date_end: string | null;
  fee: number | null;
  assignment_status: string;
  quote_ops_status: string | null;
  pipeline_status: string | null;
  hh_job_number: number | null;
  job_id: string | null;
  quote_id: string | null;
  venue_name: string | null;
  client_name: string | null;
  vehicle_reg: string | null;
  run_combined_fee: number | null;
}

interface FreelancerHistorySummary {
  total_gigs: number;
  upcoming_count: number;
  declined_count: number;
  cancelled_count: number;
  fees_ytd: number;
}

interface FreelancerHistorySectionProps {
  entityId: string; // person id
}

type FilterPill = 'all' | 'upcoming' | 'past' | 'dead';

const DEAD_STATUSES = new Set(['cancelled', 'declined']);

function statusPillClass(status: string): string {
  switch (status) {
    case 'confirmed':
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'assigned':
    case 'soft':
    case 'booked_out':
    case 'active':
      return 'bg-blue-100 text-blue-800';
    case 'declined':
    case 'cancelled':
      return 'bg-red-100 text-red-700';
    default:
      // returned / swapped / anything else
      return 'bg-gray-100 text-gray-600';
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    assigned: 'Assigned',
    confirmed: 'Confirmed',
    declined: 'Declined',
    completed: 'Completed',
    cancelled: 'Cancelled',
    soft: 'Soft',
    booked_out: 'Booked Out',
    active: 'On Hire',
    returned: 'Returned',
    swapped: 'Swapped',
  };
  return labels[status] || status;
}

function sourceBadge(item: FreelancerHistoryItem): { icon: string; label: string } {
  if (item.source === 'sitter') return { icon: '🎸', label: 'Studio Sitter' };
  if (item.source === 'vehicle') return { icon: '🚐', label: 'Van' };
  const jt = item.job_type;
  const label = jt === 'delivery' ? 'Delivery'
    : jt === 'collection' ? 'Collection'
    : jt === 'crewed' ? 'Crewed'
    : 'Crew & Transport';
  return { icon: '🚚', label };
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: '2-digit',
  });
}

function fmtDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  if (!end || end === start) return fmtDate(start);
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function fmtMoney(v: number): string {
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function FreelancerHistorySection({ entityId }: FreelancerHistorySectionProps) {
  const [summary, setSummary] = useState<FreelancerHistorySummary | null>(null);
  const [items, setItems] = useState<FreelancerHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterPill>('all');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<{ summary: FreelancerHistorySummary; items: FreelancerHistoryItem[] }>(
      `/people/${entityId}/freelancer-history`
    )
      .then((data) => {
        if (!alive) return;
        setSummary(data.summary);
        setItems(data.items);
      })
      .catch((err) => console.error('Failed to load freelancer history:', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entityId]);

  if (loading) {
    return <div className="py-8 text-center text-sm text-gray-500">Loading freelancer history...</div>;
  }

  if (!summary || items.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        Nothing has been assigned to this freelancer yet.
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const isDead = (it: FreelancerHistoryItem) => DEAD_STATUSES.has(it.assignment_status);
  // Upcoming = still-live assignment whose (end || start) date is today or later.
  // Cancelled/declined rows always live in History — they're not pending work.
  const isUpcoming = (it: FreelancerHistoryItem) => {
    if (isDead(it)) return false;
    const d = it.date_end || it.date_start;
    return !!d && d >= today;
  };

  const filtered = items.filter((it) => {
    if (filter === 'upcoming') return isUpcoming(it);
    if (filter === 'past') return !isUpcoming(it) && !isDead(it);
    if (filter === 'dead') return isDead(it);
    return true;
  });

  const upcoming = filtered.filter(isUpcoming)
    .sort((a, b) => (a.date_start || '9999').localeCompare(b.date_start || '9999')); // soonest first
  const history = filtered.filter((it) => !isUpcoming(it)); // already date DESC from server

  const pills: Array<{ key: FilterPill; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
    { key: 'dead', label: 'Cancelled + Declined' },
  ];

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-500">Total Gigs</p>
          <p className="text-lg font-bold text-gray-900">{summary.total_gigs}</p>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs text-blue-700">Upcoming</p>
          <p className="text-lg font-bold text-blue-800">{summary.upcoming_count}</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-500">Declined</p>
          <p className="text-lg font-bold text-gray-900">{summary.declined_count}</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-xs text-gray-500">Cancelled</p>
          <p className="text-lg font-bold text-gray-900">{summary.cancelled_count}</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
          <p className="text-xs text-green-700">Fees YTD</p>
          <p className="text-lg font-bold text-green-800">{fmtMoney(summary.fees_ytd)}</p>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        {pills.map((p) => (
          <button
            key={p.key}
            onClick={() => setFilter(p.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              filter === p.key
                ? 'bg-ooosh-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {upcoming.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Upcoming & Pending</h3>
          <HistoryTable items={upcoming} />
        </div>
      )}

      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">History</h3>
          <HistoryTable items={history} />
        </div>
      )}

      {filtered.length === 0 && (
        <div className="py-8 text-center text-sm text-gray-500">
          Nothing matches this filter.
        </div>
      )}
    </div>
  );
}

function HistoryTable({ items }: { items: FreelancerHistoryItem[] }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Date(s)</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase">Fee</th>
            <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {items.map((it) => {
            const dead = DEAD_STATUSES.has(it.assignment_status);
            const badge = sourceBadge(it);
            return (
              <tr key={`${it.source}-${it.id}`} className={`hover:bg-gray-50 ${dead ? 'opacity-60' : ''}`}>
                <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                  {fmtDateRange(it.date_start, it.date_end)}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                  <span className="mr-1" aria-hidden="true">{badge.icon}</span>
                  {badge.label}
                  {it.source === 'crew' && it.is_local ? ' (local)' : ''}
                </td>
                <td className="px-4 py-2.5">
                  {it.job_id ? (
                    <Link to={`/jobs/${it.job_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-800 font-medium">
                      {it.title}
                    </Link>
                  ) : (
                    <span className="text-sm text-gray-900">{it.title}</span>
                  )}
                  <p className="text-xs text-gray-500">
                    {it.hh_job_number ? `#${it.hh_job_number}` : ''}
                    {it.hh_job_number && (it.venue_name || it.vehicle_reg) ? ' · ' : ''}
                    {it.venue_name || it.vehicle_reg || ''}
                  </p>
                </td>
                <td className="px-4 py-2.5 text-sm text-gray-600 capitalize">{it.role || '—'}</td>
                <td className="px-4 py-2.5 text-right text-sm whitespace-nowrap">
                  {it.run_combined_fee != null ? (
                    <span>
                      {it.fee != null && (
                        <span className="text-gray-400 line-through mr-1.5">{fmtMoney(it.fee)}</span>
                      )}
                      <span className="font-medium text-gray-900">{fmtMoney(it.run_combined_fee)}</span>
                      <span className="block text-[10px] text-gray-500">combined run fee</span>
                    </span>
                  ) : it.fee != null ? (
                    <span className="font-medium text-gray-900">{fmtMoney(it.fee)}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusPillClass(it.assignment_status)}`}>
                    {statusLabel(it.assignment_status)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
