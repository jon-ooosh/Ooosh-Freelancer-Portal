import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import CalculatedExcessEditModal from '../components/CalculatedExcessEditModal';
import { MobileListCard } from '../components/mobile/MobileListCard';
import { TelLink } from '../components/mobile/TapTargets';

interface DriverListItem {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  licence_number: string | null;
  licence_points: number;
  licence_valid_to: string | null;
  requires_referral: boolean;
  referral_status: string | null;
  dvla_check_date: string | null;
  dvla_valid_until: string | null;
  poa1_valid_until: string | null;
  poa2_valid_until: string | null;
  signature_date: string | null;
  is_active: boolean;
  source: string;
  created_at: string;
  updated_at: string;
  person_first_name: string | null;
  person_last_name: string | null;
  // Latest excess_amount_required on any of this driver's job_excess records,
  // kept around for legacy callers but the EXCESS column now reads from
  // calculated_excess_amount on the driver row directly (driver-level
  // liability is the source of truth; per-job records are realisations).
  latest_excess_id: string | null;
  latest_excess_required: number | string | null;
  latest_excess_status: string | null;
  // Driver-level individual liability — source of truth for the EXCESS
  // column. Set by hire form submission (£1,200 floor) and editable by
  // staff via the inline modal. NULL until a hire form has set it.
  calculated_excess_amount: number | string | null;
  calculated_excess_basis: string | null;
  excess_locked: boolean;
}

interface DriversResponse {
  data: DriverListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  meta?: {
    searched_as_job_number: string | null;
  };
}

type StatusKey = 'in_progress' | 'approved' | 'expired' | 'referred_waiting' | 'refer_insurers' | 'not_approved';
type SortKey = 'last_activity' | 'name' | 'dvla_expiring' | 'points_desc';

function isDateExpired(d: string | null): boolean {
  if (!d) return false;
  try {
    return new Date(d) < new Date();
  } catch {
    return false;
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    const diff = Math.floor((Date.now() - then) / 1000);
    if (diff < 0) return 'just now';
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const days = Math.floor(diff / 86400);
    if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
    const weeks = Math.floor(days / 7);
    if (days < 30) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    if (days < 365) return `${months} month${months !== 1 ? 's' : ''} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  } catch {
    return '—';
  }
}

/**
 * Unified driver status — single source of truth.
 * Mirror of the SQL CASE in backend/src/routes/drivers.ts list endpoint;
 * keep in sync if the status rules change.
 */
function deriveDriverStatus(driver: DriverListItem): { label: string; colour: string } {
  if (driver.requires_referral) {
    if (driver.referral_status === 'approved') {
      return { label: 'Approved', colour: 'bg-green-100 text-green-700' };
    }
    if (driver.referral_status === 'waived') {
      return { label: 'Approved (Waived)', colour: 'bg-green-100 text-green-700' };
    }
    if (driver.referral_status === 'declined') {
      return { label: 'Not Approved', colour: 'bg-red-100 text-red-700' };
    }
    if (driver.referral_status === 'pending') {
      return { label: 'Referred & Waiting', colour: 'bg-amber-100 text-amber-700' };
    }
    return { label: 'Refer to Insurers', colour: 'bg-red-100 text-red-700' };
  }
  if (!driver.signature_date) {
    return { label: 'In Progress', colour: 'bg-blue-100 text-blue-700' };
  }
  const expired =
    isDateExpired(driver.licence_valid_to) ||
    isDateExpired(driver.dvla_valid_until) ||
    isDateExpired(driver.poa1_valid_until);
  if (expired) {
    return { label: 'Expired', colour: 'bg-amber-100 text-amber-700' };
  }
  return { label: 'Approved', colour: 'bg-green-100 text-green-700' };
}

const STATUS_PILLS: { key: StatusKey; label: string; pillColour: string }[] = [
  { key: 'in_progress', label: 'In Progress', pillColour: 'bg-blue-100 text-blue-700 border-blue-300' },
  { key: 'approved', label: 'Approved', pillColour: 'bg-green-100 text-green-700 border-green-300' },
  { key: 'expired', label: 'Expired', pillColour: 'bg-amber-100 text-amber-700 border-amber-300' },
  { key: 'referred_waiting', label: 'Referred & Waiting', pillColour: 'bg-amber-100 text-amber-700 border-amber-300' },
  { key: 'refer_insurers', label: 'Refer to Insurers', pillColour: 'bg-red-100 text-red-700 border-red-300' },
  { key: 'not_approved', label: 'Not Approved', pillColour: 'bg-red-100 text-red-700 border-red-300' },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'last_activity', label: 'Last activity (newest)' },
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'dvla_expiring', label: 'DVLA expiring soonest' },
  { key: 'points_desc', label: 'Points (highest first)' },
];

export default function DriversPage() {
  const [drivers, setDrivers] = useState<DriverListItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [filterReferral, setFilterReferral] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusKey[]>([]);
  const [sort, setSort] = useState<SortKey>('last_activity');
  const [jobSearchDetected, setJobSearchDetected] = useState<string | null>(null);
  const [editingExcessDriver, setEditingExcessDriver] = useState<DriverListItem | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadDrivers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filterReferral, statusFilter, sort]);

  async function loadDrivers(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50', sort });
      if (search) params.set('search', search);
      if (filterReferral) params.set('has_referral', 'true');
      for (const s of statusFilter) params.append('status', s);

      const data = await api.get<DriversResponse>(`/drivers?${params}`);
      setDrivers(data.data);
      setPagination(data.pagination);
      setJobSearchDetected(data.meta?.searched_as_job_number || null);
    } catch (err) {
      console.error('Failed to load drivers:', err);
    } finally {
      setLoading(false);
    }
  }

  function toggleStatus(key: StatusKey) {
    setStatusFilter(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }

  function pointsBadge(points: number) {
    if (points === 0) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">0 pts</span>;
    if (points <= 3) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">{points} pts</span>;
    if (points <= 6) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700">{points} pts</span>;
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">{points} pts</span>;
  }

  const filtersActive = search || filterReferral || statusFilter.length > 0;

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Drivers</h1>
        <p className="mt-1 text-sm text-gray-500">
          {pagination.total} driver{pagination.total !== 1 ? 's' : ''} — drivers are added automatically via the hire form process
        </p>
      </div>

      {/* Search + sort */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px] max-w-md">
          <input
            type="text"
            placeholder="Search by name, email, licence, postcode, or HH job #"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          {jobSearchDetected && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ooosh-50 text-ooosh-700 border border-ooosh-200">
                Also searching HH job #{jobSearchDetected}
              </span>
            </div>
          )}
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterReferral}
            onChange={(e) => setFilterReferral(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Referral required
        </label>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label className="text-gray-500">Sort:</label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status pills */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {STATUS_PILLS.map(p => {
          const active = statusFilter.includes(p.key);
          return (
            <button
              key={p.key}
              onClick={() => toggleStatus(p.key)}
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                active ? p.pillColour : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          );
        })}
        {statusFilter.length > 0 && (
          <button
            onClick={() => setStatusFilter([])}
            className="text-xs text-gray-500 hover:text-gray-700 underline ml-1"
          >
            Clear
          </button>
        )}
      </div>

      {/* Driver list — desktop table + mobile cards */}
      <div className="mt-4 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Licence</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Points</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Excess</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Activity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-sm text-gray-500">Loading...</td>
                </tr>
              ) : drivers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-sm text-gray-500">
                    {filtersActive ? 'No drivers match your filters.' : 'No drivers yet. Drivers appear here after completing the hire form.'}
                  </td>
                </tr>
              ) : (
                drivers.map((driver) => {
                  const status = deriveDriverStatus(driver);
                  return (
                    <tr
                      key={driver.id}
                      onClick={() => navigate(`/drivers/${driver.id}`)}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{driver.full_name}</div>
                        {driver.postcode && (
                          <div className="text-xs text-gray-400">{driver.postcode}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {driver.email || '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                        {driver.licence_number || '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {pointsBadge(driver.licence_points)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {/* Driver-level individual liability — always editable. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingExcessDriver(driver);
                          }}
                          title={driver.excess_locked
                            ? 'Locked — manual override pinned. Click to edit.'
                            : 'Edit driver’s individual liability'}
                          className={`hover:text-ooosh-700 hover:underline ${
                            driver.calculated_excess_amount != null
                              ? 'text-gray-900 font-medium'
                              : 'text-gray-400'
                          }`}
                        >
                          {driver.calculated_excess_amount != null
                            ? `£${Number(driver.calculated_excess_amount).toFixed(2)}`
                            : '—'}
                          {driver.excess_locked && (
                            <span className="ml-1 text-xs text-amber-600" title="Locked against auto-update">🔒</span>
                          )}
                          <span className="ml-1 text-xs text-gray-400">✎</span>
                        </button>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500" title={driver.updated_at || ''}>
                        {relativeTime(driver.updated_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${status.colour}`}>
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden">
          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">Loading...</div>
          ) : drivers.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">
              {filtersActive ? 'No drivers match your filters.' : 'No drivers yet. Drivers appear here after completing the hire form.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {drivers.map((driver) => {
                const status = deriveDriverStatus(driver);
                const excessDisplay = driver.calculated_excess_amount != null
                  ? `£${Number(driver.calculated_excess_amount).toFixed(0)}`
                  : '—';
                return (
                  <MobileListCard
                    key={driver.id}
                    onToggle={() => navigate(`/drivers/${driver.id}`)}
                    primary={driver.full_name}
                    primarySuffix={
                      driver.excess_locked ? (
                        <span title="Locked against auto-update" className="text-amber-600 text-xs">🔒</span>
                      ) : null
                    }
                    trailing={
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs whitespace-nowrap ${status.colour}`}>
                        {status.label}
                      </span>
                    }
                    secondary={
                      driver.email ? (
                        <span className="truncate">{driver.email}</span>
                      ) : null
                    }
                    meta={
                      <>
                        {driver.licence_number && (
                          <span className="font-mono">{driver.licence_number}</span>
                        )}
                        {driver.postcode && <span>· {driver.postcode}</span>}
                        <span>· {relativeTime(driver.updated_at)}</span>
                      </>
                    }
                    chips={
                      <>
                        {pointsBadge(driver.licence_points)}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingExcessDriver(driver);
                          }}
                          className={`text-xs px-2 py-1 rounded-full border font-medium inline-flex items-center gap-1 ${
                            driver.calculated_excess_amount != null
                              ? 'bg-gray-100 text-gray-700 border-gray-200'
                              : 'bg-white text-gray-500 border-gray-300'
                          }`}
                        >
                          Excess: {excessDisplay}
                          <span className="text-gray-400">✎</span>
                        </button>
                        {driver.phone && (
                          <TelLink phone={driver.phone} className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium">
                            Call
                          </TelLink>
                        )}
                      </>
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="mt-4 flex justify-between items-center">
          <p className="text-sm text-gray-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => loadDrivers(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => loadDrivers(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Driver-level liability edit (always available) */}
      {editingExcessDriver && (
        <CalculatedExcessEditModal
          driver={editingExcessDriver}
          onClose={() => setEditingExcessDriver(null)}
          onSaved={(updated) => {
            // Patch the row in place so the UI updates immediately.
            setDrivers((prev) => prev.map((d) =>
              d.id === updated.id
                ? {
                    ...d,
                    calculated_excess_amount: updated.calculated_excess_amount,
                    calculated_excess_basis: updated.calculated_excess_basis,
                    excess_locked: updated.excess_locked,
                  }
                : d
            ));
          }}
        />
      )}

    </div>
  );
}
