import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';

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

interface DriverFormData {
  full_name: string;
  email: string;
  phone: string;
  date_of_birth: string;
  address_line1: string;
  address_line2: string;
  city: string;
  postcode: string;
  licence_number: string;
  licence_type: string;
  licence_valid_from: string;
  licence_valid_to: string;
  licence_issue_country: string;
  licence_points: number;
  licence_restrictions: string;
  dvla_check_code: string;
  dvla_check_date: string;
}

const emptyForm: DriverFormData = {
  full_name: '',
  email: '',
  phone: '',
  date_of_birth: '',
  address_line1: '',
  address_line2: '',
  city: '',
  postcode: '',
  licence_number: '',
  licence_type: 'full',
  licence_valid_from: '',
  licence_valid_to: '',
  licence_issue_country: 'GB',
  licence_points: 0,
  licence_restrictions: '',
  dvla_check_code: '',
  dvla_check_date: '',
};

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

function deriveDriverStatus(driver: DriverListItem): { label: string; colour: string } {
  // Referral takes priority
  if (driver.requires_referral) {
    if (driver.referral_status === 'approved') {
      return { label: 'Referral Approved', colour: 'bg-blue-100 text-blue-700' };
    }
    if (driver.referral_status === 'declined') {
      return { label: 'Referral Declined', colour: 'bg-red-100 text-red-700' };
    }
    return { label: 'Referral Required', colour: 'bg-red-100 text-red-700' };
  }

  // Check for expired documents
  const expiredDocs: string[] = [];
  if (isDateExpired(driver.licence_valid_to)) expiredDocs.push('Licence');
  if (isDateExpired(driver.dvla_valid_until)) expiredDocs.push('DVLA');
  if (isDateExpired(driver.poa1_valid_until)) expiredDocs.push('POA');

  if (expiredDocs.length > 0) {
    return { label: 'Expired', colour: 'bg-amber-100 text-amber-700' };
  }

  // In progress — has started form but not signed
  if (!driver.signature_date && driver.email) {
    // Check if they have any meaningful data beyond just name/email
    const hasLicence = !!driver.licence_number;
    const hasDvla = !!driver.dvla_check_date;
    if (!hasLicence && !hasDvla) {
      return { label: 'In Progress', colour: 'bg-blue-100 text-blue-700' };
    }
  }

  // If signed but missing key validity dates, still in progress
  if (driver.signature_date && !driver.dvla_valid_until && !driver.licence_valid_to) {
    return { label: 'In Progress', colour: 'bg-blue-100 text-blue-700' };
  }

  return { label: 'Clear', colour: 'bg-green-100 text-green-700' };
}

export default function DriversPage() {
  const [drivers, setDrivers] = useState<DriverListItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [showForm, setShowForm] = useState(false);
  const [filterReferral, setFilterReferral] = useState(false);
  const [formData, setFormData] = useState<DriverFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
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

  async function handleCreate() {
    if (!formData.full_name.trim()) {
      setFormError('Driver name is required');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.post('/drivers', {
        ...formData,
        email: formData.email || null,
        phone: formData.phone || null,
        date_of_birth: formData.date_of_birth || null,
        address_line1: formData.address_line1 || null,
        address_line2: formData.address_line2 || null,
        city: formData.city || null,
        postcode: formData.postcode || null,
        licence_number: formData.licence_number || null,
        licence_type: formData.licence_type || null,
        licence_valid_from: formData.licence_valid_from || null,
        licence_valid_to: formData.licence_valid_to || null,
        dvla_check_code: formData.dvla_check_code || null,
        dvla_check_date: formData.dvla_check_date || null,
        licence_restrictions: formData.licence_restrictions || null,
        source: 'manual',
      });
      setShowForm(false);
      setFormData(emptyForm);
      loadDrivers();
    } catch (err: any) {
      setFormError(err.message || 'Failed to create driver');
    } finally {
      setSaving(false);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Drivers</h1>
          <p className="mt-1 text-sm text-gray-500">
            {pagination.total} driver{pagination.total !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { setFormData(emptyForm); setFormError(''); setShowForm(true); }}
          className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
        >
          Add Driver
        </button>
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
                  {search || filterReferral ? 'No drivers match your filters.' : 'No drivers yet. Add one to get started.'}
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

      {/* Add Driver Panel */}
      <SlidePanel open={showForm} onClose={() => setShowForm(false)} title="Add Driver">
        <div className="space-y-6">
          {formError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {formError}
            </div>
          )}

          {/* Identity */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Identity</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Full Name *</label>
                <input
                  type="text"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  placeholder="As it appears on licence"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Phone</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Date of Birth</label>
                <input
                  type="date"
                  value={formData.date_of_birth}
                  onChange={(e) => setFormData({ ...formData, date_of_birth: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            </div>
          </div>

          {/* Address */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Address</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={formData.address_line1}
                onChange={(e) => setFormData({ ...formData, address_line1: e.target.value })}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                placeholder="Address line 1"
              />
              <input
                type="text"
                value={formData.address_line2}
                onChange={(e) => setFormData({ ...formData, address_line2: e.target.value })}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                placeholder="Address line 2"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  placeholder="City"
                />
                <input
                  type="text"
                  value={formData.postcode}
                  onChange={(e) => setFormData({ ...formData, postcode: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  placeholder="Postcode"
                />
              </div>
            </div>
          </div>

          {/* Licence */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Licence Details</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Licence Number</label>
                  <input
                    type="text"
                    value={formData.licence_number}
                    onChange={(e) => setFormData({ ...formData, licence_number: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Licence Type</label>
                  <select
                    value={formData.licence_type}
                    onChange={(e) => setFormData({ ...formData, licence_type: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  >
                    <option value="full">Full</option>
                    <option value="provisional">Provisional</option>
                    <option value="international">International</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Valid From</label>
                  <input
                    type="date"
                    value={formData.licence_valid_from}
                    onChange={(e) => setFormData({ ...formData, licence_valid_from: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Valid To</label>
                  <input
                    type="date"
                    value={formData.licence_valid_to}
                    onChange={(e) => setFormData({ ...formData, licence_valid_to: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Country</label>
                  <input
                    type="text"
                    value={formData.licence_issue_country}
                    onChange={(e) => setFormData({ ...formData, licence_issue_country: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Points</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.licence_points}
                    onChange={(e) => setFormData({ ...formData, licence_points: parseInt(e.target.value) || 0 })}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Restrictions</label>
                <input
                  type="text"
                  value={formData.licence_restrictions}
                  onChange={(e) => setFormData({ ...formData, licence_restrictions: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  placeholder="e.g. corrective lenses"
                />
              </div>
            </div>
          </div>

          {/* DVLA Check */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">DVLA Check</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Check Code</label>
                <input
                  type="text"
                  value={formData.dvla_check_code}
                  onChange={(e) => setFormData({ ...formData, dvla_check_code: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Check Date</label>
                <input
                  type="date"
                  value={formData.dvla_check_date}
                  onChange={(e) => setFormData({ ...formData, dvla_check_date: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t">
            <button
              onClick={handleCreate}
              disabled={saving}
              className="flex-1 bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Create Driver'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      </SlidePanel>
    </div>
  );
}
