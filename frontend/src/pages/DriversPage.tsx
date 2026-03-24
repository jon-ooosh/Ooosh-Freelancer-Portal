import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

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
}

interface DriversResponse {
  data: DriverListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}

function isDateExpired(d: string | null): boolean {
  if (!d) return false;
  try {
    return new Date(d) < new Date();
  } catch {
    return false;
  }
}

/**
 * Unified driver status — single source of truth.
 * Five statuses: Approved / Manual Review / Refer to Insurers / Referred & Waiting / Not Approved
 */
function deriveDriverStatus(driver: DriverListItem): { label: string; colour: string } {
  // Referral statuses take priority
  if (driver.requires_referral) {
    if (driver.referral_status === 'approved') {
      return { label: 'Approved', colour: 'bg-green-100 text-green-700' };
    }
    if (driver.referral_status === 'declined') {
      return { label: 'Not Approved', colour: 'bg-red-100 text-red-700' };
    }
    if (driver.referral_status === 'pending') {
      return { label: 'Referred & Waiting', colour: 'bg-amber-100 text-amber-700' };
    }
    // requires_referral but no referral_status = needs referring
    return { label: 'Refer to Insurers', colour: 'bg-red-100 text-red-700' };
  }

  // Check for expired/missing documents or incomplete form
  const expiredDocs: string[] = [];
  if (isDateExpired(driver.licence_valid_to)) expiredDocs.push('Licence');
  if (isDateExpired(driver.dvla_valid_until)) expiredDocs.push('DVLA');
  if (isDateExpired(driver.poa1_valid_until)) expiredDocs.push('POA');

  if (expiredDocs.length > 0) {
    return { label: 'Manual Review', colour: 'bg-amber-100 text-amber-700' };
  }

  // In progress — has started form but not signed, or missing key data
  if (!driver.signature_date && driver.email) {
    const hasLicence = !!driver.licence_number;
    const hasDvla = !!driver.dvla_check_date;
    if (!hasLicence && !hasDvla) {
      return { label: 'Manual Review', colour: 'bg-amber-100 text-amber-700' };
    }
  }
  if (driver.signature_date && !driver.dvla_valid_until && !driver.licence_valid_to) {
    return { label: 'Manual Review', colour: 'bg-amber-100 text-amber-700' };
  }

  return { label: 'Approved', colour: 'bg-green-100 text-green-700' };
}

export default function DriversPage() {
  const [drivers, setDrivers] = useState<DriverListItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [filterReferral, setFilterReferral] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadDrivers();
  }, [search, filterReferral]);

  async function loadDrivers(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (search) params.set('search', search);
      if (filterReferral) params.set('has_referral', 'true');

      const data = await api.get<DriversResponse>(`/drivers?${params}`);
      setDrivers(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load drivers:', err);
    } finally {
      setLoading(false);
    }
  }

  function pointsBadge(points: number) {
    if (points === 0) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">0 pts</span>;
    if (points <= 3) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">{points} pts</span>;
    if (points <= 6) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700">{points} pts</span>;
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">{points} pts</span>;
  }

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Drivers</h1>
        <p className="mt-1 text-sm text-gray-500">
          {pagination.total} driver{pagination.total !== 1 ? 's' : ''} — drivers are added automatically via the hire form process
        </p>
      </div>

      {/* Search & Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <input
          type="text"
          placeholder="Search by name, email, licence, or postcode..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterReferral}
            onChange={(e) => setFilterReferral(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Referral required
        </label>
      </div>

      {/* Table */}
      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Licence</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Points</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">DVLA Check</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-sm text-gray-500">Loading...</td>
              </tr>
            ) : drivers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-sm text-gray-500">
                  {search || filterReferral ? 'No drivers match your filters.' : 'No drivers yet. Drivers appear here after completing the hire form.'}
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
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(driver.dvla_check_date)}
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
    </div>
  );
}
