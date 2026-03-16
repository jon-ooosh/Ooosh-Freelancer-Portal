import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';

interface LicenceEndorsement {
  code: string;
  points: number;
  date: string | null;
  expiry: string | null;
}

interface DriverDetail {
  id: string;
  person_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postcode: string | null;
  licence_number: string | null;
  licence_type: string | null;
  licence_valid_from: string | null;
  licence_valid_to: string | null;
  licence_issue_country: string;
  licence_points: number;
  licence_endorsements: LicenceEndorsement[];
  licence_restrictions: string | null;
  dvla_check_code: string | null;
  dvla_check_date: string | null;
  requires_referral: boolean;
  referral_status: string | null;
  referral_date: string | null;
  referral_notes: string | null;
  source: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  person_first_name: string | null;
  person_last_name: string | null;
  person_email: string | null;
}

interface HireHistoryItem {
  id: string;
  vehicle_reg: string;
  vehicle_type: string;
  hirehop_job_id: number | null;
  hirehop_job_name: string | null;
  assignment_type: string;
  status: string;
  hire_start: string | null;
  hire_end: string | null;
  mileage_out: number | null;
  mileage_in: number | null;
  has_damage: boolean;
  created_at: string;
}

interface ExcessHistoryItem {
  id: string;
  vehicle_reg: string;
  hire_start: string | null;
  hire_end: string | null;
  excess_amount_required: number | null;
  excess_amount_taken: number;
  excess_status: string;
  payment_method: string | null;
  claim_amount: number | null;
  reimbursement_amount: number | null;
  created_at: string;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}

function statusBadge(status: string) {
  const colours: Record<string, string> = {
    soft: 'bg-gray-100 text-gray-700',
    confirmed: 'bg-blue-100 text-blue-700',
    booked_out: 'bg-indigo-100 text-indigo-700',
    active: 'bg-green-100 text-green-700',
    returned: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${colours[status] || 'bg-gray-100 text-gray-700'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function excessStatusBadge(status: string) {
  const colours: Record<string, string> = {
    not_required: 'bg-gray-100 text-gray-600',
    pending: 'bg-yellow-100 text-yellow-700',
    taken: 'bg-green-100 text-green-700',
    partial: 'bg-orange-100 text-orange-700',
    waived: 'bg-blue-100 text-blue-700',
    claimed: 'bg-red-100 text-red-700',
    reimbursed: 'bg-purple-100 text-purple-700',
    rolled_over: 'bg-indigo-100 text-indigo-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${colours[status] || 'bg-gray-100 text-gray-700'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

export default function DriverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [driver, setDriver] = useState<DriverDetail | null>(null);
  const [hireHistory, setHireHistory] = useState<HireHistoryItem[]>([]);
  const [excessHistory, setExcessHistory] = useState<ExcessHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'details' | 'hires' | 'excess'>('details');
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (id) loadDriver();
  }, [id]);

  useEffect(() => {
    if (id && activeTab === 'hires' && hireHistory.length === 0) loadHireHistory();
    if (id && activeTab === 'excess' && excessHistory.length === 0) loadExcessHistory();
  }, [id, activeTab]);

  async function loadDriver() {
    setLoading(true);
    try {
      const data = await api.get<{ data: DriverDetail }>(`/drivers/${id}`);
      setDriver(data.data);
    } catch (err) {
      console.error('Failed to load driver:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadHireHistory() {
    try {
      const data = await api.get<{ data: HireHistoryItem[] }>(`/drivers/${id}/hire-history`);
      setHireHistory(data.data);
    } catch (err) {
      console.error('Failed to load hire history:', err);
    }
  }

  async function loadExcessHistory() {
    try {
      const data = await api.get<{ data: ExcessHistoryItem[] }>(`/drivers/${id}/excess-history`);
      setExcessHistory(data.data);
    } catch (err) {
      console.error('Failed to load excess history:', err);
    }
  }

  function startEditing() {
    if (!driver) return;
    setEditData({
      full_name: driver.full_name,
      email: driver.email || '',
      phone: driver.phone || '',
      date_of_birth: driver.date_of_birth || '',
      address_line1: driver.address_line1 || '',
      address_line2: driver.address_line2 || '',
      city: driver.city || '',
      postcode: driver.postcode || '',
      licence_number: driver.licence_number || '',
      licence_type: driver.licence_type || 'full',
      licence_valid_from: driver.licence_valid_from || '',
      licence_valid_to: driver.licence_valid_to || '',
      licence_issue_country: driver.licence_issue_country || 'GB',
      licence_points: driver.licence_points,
      licence_restrictions: driver.licence_restrictions || '',
      dvla_check_code: driver.dvla_check_code || '',
      dvla_check_date: driver.dvla_check_date || '',
      referral_notes: driver.referral_notes || '',
    });
    setEditing(true);
    setSaveError('');
  }

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Record<string, any> = {};
      for (const [key, value] of Object.entries(editData)) {
        payload[key] = value === '' ? null : value;
      }
      await api.put(`/drivers/${id}`, payload);
      await loadDriver();
      setEditing(false);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading driver...</div>;
  }

  if (!driver) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Driver not found.</p>
        <button onClick={() => navigate('/drivers')} className="mt-4 text-ooosh-600 hover:underline text-sm">
          Back to Drivers
        </button>
      </div>
    );
  }

  const dvlaCheckAge = driver.dvla_check_date
    ? Math.floor((Date.now() - new Date(driver.dvla_check_date).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const dvlaCheckStale = dvlaCheckAge !== null && dvlaCheckAge > 180;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => navigate('/drivers')}
            className="text-sm text-gray-500 hover:text-gray-700 mb-2 inline-flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Drivers
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{driver.full_name}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-gray-500">
            {driver.email && <span>{driver.email}</span>}
            {driver.phone && <span>{driver.phone}</span>}
            {driver.person_id && (
              <Link to={`/people/${driver.person_id}`} className="text-ooosh-600 hover:underline">
                View Person Record
              </Link>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button
              onClick={startEditing}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Status banners */}
      {driver.requires_referral && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Insurance referral {driver.referral_status === 'approved' ? 'approved' : driver.referral_status === 'declined' ? 'declined' : 'required'}.
          {driver.referral_notes && <span className="ml-1">{driver.referral_notes}</span>}
        </div>
      )}
      {dvlaCheckStale && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          DVLA check is {dvlaCheckAge} days old (last: {formatDate(driver.dvla_check_date)}). Consider requesting a fresh check code.
        </div>
      )}

      {/* Tabs */}
      <div className="mt-6 border-b border-gray-200">
        <nav className="flex gap-6">
          {(['details', 'hires', 'excess'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'details' ? 'Details' : tab === 'hires' ? 'Hire History' : 'Excess History'}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === 'details' && (
          <DetailsTab
            driver={driver}
            editing={editing}
            editData={editData}
            setEditData={setEditData}
            saving={saving}
            saveError={saveError}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
          />
        )}
        {activeTab === 'hires' && <HireHistoryTab history={hireHistory} />}
        {activeTab === 'excess' && <ExcessHistoryTab history={excessHistory} />}
      </div>
    </div>
  );
}

// ── Details Tab ──

function DetailsTab({
  driver,
  editing,
  editData,
  setEditData,
  saving,
  saveError,
  onSave,
  onCancel,
}: {
  driver: DriverDetail;
  editing: boolean;
  editData: Record<string, any>;
  setEditData: (d: Record<string, any>) => void;
  saving: boolean;
  saveError: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = (label: string, key: string, opts?: { type?: string; mono?: boolean; half?: boolean }) => {
    const value = editing ? (editData[key] ?? '') : ((driver as any)[key] ?? '');
    if (editing) {
      return (
        <div className={opts?.half ? '' : ''}>
          <label className="block text-xs text-gray-500 mb-1">{label}</label>
          <input
            type={opts?.type || 'text'}
            value={value}
            onChange={(e) => setEditData({ ...editData, [key]: opts?.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value })}
            className={`w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 ${opts?.mono ? 'font-mono' : ''}`}
          />
        </div>
      );
    }
    return (
      <div>
        <dt className="text-xs text-gray-500">{label}</dt>
        <dd className={`text-sm text-gray-900 ${opts?.mono ? 'font-mono' : ''}`}>{value || '—'}</dd>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {saveError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{saveError}</div>
      )}

      {/* Identity */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Identity</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {field('Full Name', 'full_name')}
          {field('Email', 'email')}
          {field('Phone', 'phone')}
          {field('Date of Birth', 'date_of_birth', { type: 'date' })}
        </div>
      </div>

      {/* Address */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Address</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {field('Address Line 1', 'address_line1')}
          {field('Address Line 2', 'address_line2')}
          {field('City', 'city')}
          {field('Postcode', 'postcode')}
        </div>
      </div>

      {/* Licence */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Licence Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {field('Licence Number', 'licence_number', { mono: true })}
          {field('Type', 'licence_type')}
          {field('Country', 'licence_issue_country')}
          {field('Valid From', 'licence_valid_from', { type: 'date' })}
          {field('Valid To', 'licence_valid_to', { type: 'date' })}
          {field('Points', 'licence_points', { type: 'number' })}
          {field('Restrictions', 'licence_restrictions')}
        </div>

        {/* Endorsements (read-only for now) */}
        {!editing && driver.licence_endorsements && driver.licence_endorsements.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h4 className="text-xs text-gray-500 mb-2">Endorsements</h4>
            <div className="space-y-1">
              {driver.licence_endorsements.map((e, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="font-mono bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs">{e.code}</span>
                  <span className="text-gray-600">{e.points} pts</span>
                  {e.date && <span className="text-gray-400">{formatDate(e.date)}</span>}
                  {e.expiry && <span className="text-gray-400">expires {formatDate(e.expiry)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* DVLA Check */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">DVLA Check</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {field('Check Code', 'dvla_check_code', { mono: true })}
          {field('Check Date', 'dvla_check_date', { type: 'date' })}
        </div>
      </div>

      {/* Referral */}
      {driver.requires_referral && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Insurance Referral</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-xs text-gray-500">Status</dt>
              <dd className="text-sm">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${
                  driver.referral_status === 'approved' ? 'bg-green-100 text-green-700'
                    : driver.referral_status === 'declined' ? 'bg-red-100 text-red-700'
                    : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {driver.referral_status || 'pending'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Referral Date</dt>
              <dd className="text-sm text-gray-900">{formatDate(driver.referral_date)}</dd>
            </div>
            {editing ? field('Notes', 'referral_notes') : (
              <div>
                <dt className="text-xs text-gray-500">Notes</dt>
                <dd className="text-sm text-gray-900">{driver.referral_notes || '—'}</dd>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Record Info</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Source</dt>
            <dd className="text-gray-900">{driver.source}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Created</dt>
            <dd className="text-gray-900">{formatDate(driver.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Last Updated</dt>
            <dd className="text-gray-900">{formatDate(driver.updated_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Active</dt>
            <dd className="text-gray-900">{driver.is_active ? 'Yes' : 'No'}</dd>
          </div>
        </div>
      </div>

      {/* Edit actions */}
      {editing && (
        <div className="flex gap-3">
          <button
            onClick={onSave}
            disabled={saving}
            className="bg-ooosh-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-700"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Hire History Tab ──

function HireHistoryTab({ history }: { history: HireHistoryItem[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-gray-500 py-8 text-center">No hire history yet.</p>;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Vehicle</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dates</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Mileage</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {history.map((h) => (
            <tr key={h.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <span className="text-sm font-medium text-gray-900">{h.vehicle_reg}</span>
                <span className="ml-2 text-xs text-gray-400">{h.vehicle_type}</span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {h.hirehop_job_id ? (
                  <span>#{h.hirehop_job_id} {h.hirehop_job_name && `— ${h.hirehop_job_name.substring(0, 30)}`}</span>
                ) : '—'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {formatDate(h.hire_start)} — {formatDate(h.hire_end)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {h.mileage_out != null ? (
                  <span>
                    {h.mileage_out.toLocaleString()}
                    {h.mileage_in != null && ` → ${h.mileage_in.toLocaleString()} (${(h.mileage_in - h.mileage_out).toLocaleString()} mi)`}
                  </span>
                ) : '—'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center gap-2">
                  {statusBadge(h.status)}
                  {h.has_damage && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">Damage</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Excess History Tab ──

function ExcessHistoryTab({ history }: { history: ExcessHistoryItem[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-gray-500 py-8 text-center">No excess history yet.</p>;
  }

  const totalTaken = history.reduce((sum, h) => sum + (h.excess_amount_taken || 0), 0);
  const totalClaimed = history.reduce((sum, h) => sum + (h.claim_amount || 0), 0);
  const totalReimbursed = history.reduce((sum, h) => sum + (h.reimbursement_amount || 0), 0);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Taken</p>
          <p className="text-lg font-bold text-gray-900">&pound;{totalTaken.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Claimed</p>
          <p className="text-lg font-bold text-gray-900">&pound;{totalClaimed.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Reimbursed</p>
          <p className="text-lg font-bold text-gray-900">&pound;{totalReimbursed.toFixed(2)}</p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Vehicle</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hire Dates</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Required</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Taken</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {history.map((h) => (
              <tr key={h.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {h.vehicle_reg}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {formatDate(h.hire_start)} — {formatDate(h.hire_end)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {h.excess_amount_required != null ? `\u00A3${Number(h.excess_amount_required).toFixed(2)}` : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  &pound;{Number(h.excess_amount_taken).toFixed(2)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {excessStatusBadge(h.excess_status)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {h.payment_method?.replace('_', ' ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
