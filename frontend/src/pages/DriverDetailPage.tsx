import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface FileAttachment {
  name: string;
  label?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
}

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
  phone_country: string | null;
  date_of_birth: string | null;
  nationality: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postcode: string | null;
  address_full: string | null;
  licence_address: string | null;
  licence_number: string | null;
  licence_type: string | null;
  licence_valid_from: string | null;
  licence_valid_to: string | null;
  licence_issue_country: string;
  licence_issued_by: string | null;
  licence_points: number;
  licence_endorsements: LicenceEndorsement[];
  licence_restrictions: string | null;
  licence_next_check_due: string | null;
  date_passed_test: string | null;
  poa1_valid_until: string | null;
  poa2_valid_until: string | null;
  dvla_valid_until: string | null;
  passport_valid_until: string | null;
  poa1_provider: string | null;
  poa2_provider: string | null;
  dvla_check_code: string | null;
  dvla_check_date: string | null;
  has_disability: boolean;
  has_convictions: boolean;
  has_prosecution: boolean;
  has_accidents: boolean;
  has_insurance_issues: boolean;
  has_driving_ban: boolean;
  additional_details: string | null;
  insurance_status: string | null;
  overall_status: string | null;
  idenfy_check_date: string | null;
  idenfy_scan_ref: string | null;
  signature_date: string | null;
  requires_referral: boolean;
  referral_status: string | null;
  referral_date: string | null;
  referral_notes: string | null;
  files: FileAttachment[];
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

interface AuditLogEntry {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  action: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}

function formatDateTime(d: string | null): string {
  if (!d) return '—';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return d;
  }
}

function toInputDate(d: string | null): string {
  if (!d) return '';
  try {
    // Already in yyyy-MM-dd format — return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    // ISO format with time component — extract date part directly (no timezone shift)
    if (d.includes('T')) return d.split('T')[0];
    // Fallback: parse and format
    const date = new Date(d);
    if (isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}

function isDateExpired(d: string | null): boolean {
  if (!d) return false;
  try { return new Date(d) < new Date(); } catch { return false; }
}

function daysUntil(d: string | null): number | null {
  if (!d) return null;
  try {
    const diff = new Date(d).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

/**
 * Compute Ooosh acceptance validity windows.
 * - Licence: 90 days from iDenfy check, capped at actual licence expiry
 * - DVLA: 30 days from DVLA check date
 * - Passport: 30 days from iDenfy check (non-UK) or passport_valid_until
 */
function computeOooshValidity(driver: DriverDetail): {
  licence: string | null;
  licenceCapped: boolean;
  dvla: string | null;
  passport: string | null;
  isUkDriver: boolean;
} {
  function addDays(dateStr: string | null, days: number): string | null {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return null;
      d.setDate(d.getDate() + days);
      return d.toISOString().split('T')[0];
    } catch { return null; }
  }

  function minDate(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return new Date(a) < new Date(b) ? a : b;
  }

  // UK driver: licence issued by DVLA OR licence_issue_country = GB
  const isUkDriver = driver.licence_issued_by === 'DVLA' || driver.licence_issue_country === 'GB';

  // Licence: 90d from iDenfy check, capped at actual licence expiry
  const licenceWindow = addDays(driver.idenfy_check_date, 90);
  const licenceActual = driver.licence_valid_to || null;
  let licence: string | null = licenceWindow;
  let licenceCapped = false;
  if (licenceWindow && licenceActual) {
    const capped = minDate(licenceWindow, licenceActual);
    licenceCapped = capped !== licenceWindow;
    licence = capped;
  } else if (!licenceWindow && licenceActual) {
    // No iDenfy check yet — fall back to licence_next_check_due if set
    licence = driver.licence_next_check_due || null;
  }

  // DVLA: 30d from check date
  const dvla = addDays(driver.dvla_check_date, 30);

  // Passport: always show stored value if set (UK drivers need it for address mismatch).
  // For non-UK drivers, auto-compute 30d from iDenfy if no stored value.
  let passport: string | null = driver.passport_valid_until || null;
  if (!passport && !isUkDriver) {
    passport = addDays(driver.idenfy_check_date, 30);
  }

  return { licence, licenceCapped, dvla, passport, isUkDriver };
}

// Normalise address for comparison — strip whitespace, punctuation, lowercase
function normaliseAddress(addr: string): string {
  return addr.toLowerCase().replace(/[,.\-\/\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function addressesDiffer(a: string, b: string): boolean {
  return normaliseAddress(a) !== normaliseAddress(b);
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

// Document categories — labels match what the hire form app sends
const DOCUMENT_CATEGORIES: { label: string; fileLabels: string[]; description: string }[] = [
  { label: 'Licence Front', fileLabels: ['Licence Front', 'licence_front', 'License Front', 'license_front'], description: 'Photo of front of driving licence' },
  { label: 'Licence Back', fileLabels: ['Licence Back', 'licence_back', 'License Back', 'license_back'], description: 'Photo of back of driving licence' },
  { label: 'DVLA Check', fileLabels: ['DVLA Check Code', 'DVLA Check', 'dvla_check', 'dvla check', 'dvla'], description: 'DVLA check code screenshot' },
  { label: 'Proof of Address 1', fileLabels: ['Proof of Address', 'POA 1', 'poa1', 'Proof of Address 1'], description: 'Utility bill, council tax, or bank statement' },
  { label: 'Proof of Address 2', fileLabels: ['POA 2', 'poa2', 'Proof of Address 2'], description: 'Second proof of address document' },
  { label: 'Passport', fileLabels: ['Passport', 'passport'], description: 'Passport photo page' },
  { label: 'Signature', fileLabels: ['Signature', 'signature', 'sig'], description: 'Driver signature' },
];

// Friendly field name mapping for audit log display
const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full Name', email: 'Email', phone: 'Phone', phone_country: 'Phone Country',
  date_of_birth: 'Date of Birth', nationality: 'Nationality', address_full: 'Home Address',
  licence_address: 'Licence Address', address_line1: 'Address Line 1', address_line2: 'Address Line 2',
  city: 'City', postcode: 'Postcode', licence_number: 'Licence Number', licence_type: 'Licence Type',
  licence_issued_by: 'Issued By', licence_valid_from: 'Valid From', licence_valid_to: 'Valid To',
  licence_issue_country: 'Issue Country', licence_points: 'Points', licence_restrictions: 'Restrictions',
  date_passed_test: 'Date Passed Test', dvla_check_code: 'DVLA Check Code', dvla_check_date: 'DVLA Check Date',
  dvla_valid_until: 'DVLA Valid Until', poa1_valid_until: 'POA 1 Valid Until', poa2_valid_until: 'POA 2 Valid Until',
  passport_valid_until: 'Passport Valid Until', referral_notes: 'Referral Notes',
  has_disability: 'Disability', has_convictions: 'Convictions', has_prosecution: 'Prosecution',
  has_accidents: 'Accidents', has_insurance_issues: 'Insurance Issues', has_driving_ban: 'Driving Ban',
  additional_details: 'Additional Details', insurance_status: 'Insurance Status',
};

export default function DriverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canEdit = user?.role === 'admin' || user?.role === 'manager';

  const [driver, setDriver] = useState<DriverDetail | null>(null);
  const [hireHistory, setHireHistory] = useState<HireHistoryItem[]>([]);
  const [excessHistory, setExcessHistory] = useState<ExcessHistoryItem[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
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

  // Load audit log when details tab is shown
  useEffect(() => {
    if (id && activeTab === 'details') loadAuditLog();
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

  async function loadAuditLog() {
    try {
      const data = await api.get<{ data: AuditLogEntry[] }>(`/drivers/${id}/audit-log`);
      setAuditLog(data.data);
    } catch (err) {
      console.error('Failed to load audit log:', err);
    }
  }

  function startEditing() {
    if (!driver) return;
    setEditData({
      full_name: driver.full_name,
      email: driver.email || '',
      phone: driver.phone || '',
      phone_country: driver.phone_country || '',
      date_of_birth: toInputDate(driver.date_of_birth),
      nationality: driver.nationality || '',
      address_full: driver.address_full || '',
      licence_address: driver.licence_address || '',
      address_line1: driver.address_line1 || '',
      address_line2: driver.address_line2 || '',
      city: driver.city || '',
      postcode: driver.postcode || '',
      licence_number: driver.licence_number || '',
      licence_type: driver.licence_type || 'full',
      licence_issued_by: driver.licence_issued_by || '',
      licence_valid_from: toInputDate(driver.licence_valid_from),
      licence_valid_to: toInputDate(driver.licence_valid_to),
      licence_issue_country: driver.licence_issue_country || 'GB',
      licence_points: driver.licence_points,
      licence_restrictions: driver.licence_restrictions || '',
      date_passed_test: toInputDate(driver.date_passed_test),
      dvla_check_code: driver.dvla_check_code || '',
      dvla_check_date: toInputDate(driver.dvla_check_date),
      dvla_valid_until: toInputDate(driver.dvla_valid_until),
      idenfy_check_date: toInputDate(driver.idenfy_check_date),
      poa1_valid_until: toInputDate(driver.poa1_valid_until),
      poa2_valid_until: toInputDate(driver.poa2_valid_until),
      passport_valid_until: toInputDate(driver.passport_valid_until),
      referral_notes: driver.referral_notes || '',
      // Insurance questionnaire
      has_disability: driver.has_disability,
      has_convictions: driver.has_convictions,
      has_prosecution: driver.has_prosecution,
      has_accidents: driver.has_accidents,
      has_insurance_issues: driver.has_insurance_issues,
      has_driving_ban: driver.has_driving_ban,
      additional_details: driver.additional_details || '',
      insurance_status: driver.insurance_status || '',
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
      await loadAuditLog();
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
            {driver.phone && (
              <span>
                {driver.phone_country && <span className="text-gray-400">{driver.phone_country} </span>}
                {driver.phone}
              </span>
            )}
            {driver.person_id && (
              <Link to={`/people/${driver.person_id}`} className="text-ooosh-600 hover:underline">
                View Person Record
              </Link>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!editing && canEdit && (
            <button
              onClick={startEditing}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Referral panel — shown prominently at top when applicable */}
      {driver.requires_referral && (
        <div className="mt-4">
          <ReferralPanel driver={driver} onDriverUpdate={setDriver} />
        </div>
      )}

      {/* DVLA stale warning */}
      {dvlaCheckStale && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          DVLA check is {dvlaCheckAge} days old (last: {formatDate(driver.dvla_check_date)}). Consider requesting a fresh check code.
        </div>
      )}

      {/* Tabs */}
      <div className="mt-6 border-b border-gray-200">
        <nav className="flex gap-6">
          {([
            { key: 'details', label: 'Overview' },
            { key: 'hires', label: 'Hire History' },
            { key: 'excess', label: 'Excess History' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
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
            onDriverUpdate={setDriver}
            auditLog={auditLog}
          />
        )}
        {activeTab === 'hires' && <HireHistoryTab history={hireHistory} />}
        {activeTab === 'excess' && <ExcessHistoryTab history={excessHistory} />}
      </div>
    </div>
  );
}

// ── Validity date pill ──

function ValidityPill({ date, label }: { date: string | null; label?: string }) {
  if (!date) return <span className="text-gray-400 text-xs">Not set</span>;
  const expired = isDateExpired(date);
  const days = daysUntil(date);
  const isExpiringSoon = days !== null && days > 0 && days <= 30;

  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
      expired ? 'bg-red-100 text-red-700' :
      isExpiringSoon ? 'bg-amber-100 text-amber-700' :
      'bg-green-100 text-green-700'
    }`}>
      {label && <span className="font-medium">{label}:</span>}
      {formatDate(date)}
      {expired && ' (expired)'}
      {isExpiringSoon && ` (${days}d)`}
    </span>
  );
}

// ── Document Category Row ──

function DocumentCategoryRow({
  category,
  files,
  driverId,
  onFilesChanged,
}: {
  category: { label: string; fileLabels: string[]; description: string };
  files: FileAttachment[];
  driverId: string;
  onFilesChanged: (files: FileAttachment[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const matchingFiles = files.filter(f =>
    category.fileLabels.some(cl => f.label?.toLowerCase() === cl.toLowerCase())
  );

  const latestFile = matchingFiles.length > 0
    ? matchingFiles.reduce((a, b) => new Date(a.uploaded_at) > new Date(b.uploaded_at) ? a : b)
    : null;

  const olderFiles = matchingFiles.filter(f => f !== latestFile);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('entity_type', 'drivers');
      formData.append('entity_id', driverId);
      formData.append('label', category.label);
      const result = await api.upload<FileAttachment>('/files/upload', formData);
      onFilesChanged([...files, result]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDownload(file: FileAttachment) {
    try {
      const { blob, contentType } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
      const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      setError('Download failed');
    }
  }

  async function handleDelete(file: FileAttachment) {
    if (!confirm(`Delete "${file.label || file.name}"?`)) return;
    try {
      await api.deleteWithBody('/files/delete', { key: file.url, entity_type: 'drivers', entity_id: driverId });
      onFilesChanged(files.filter(f => f.url !== file.url));
    } catch {
      setError('Delete failed');
    }
  }

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <div className="w-40 flex-shrink-0">
        <span className="text-xs font-medium text-gray-700">{category.label}</span>
      </div>
      <div className="flex-1 min-w-0">
        {latestFile ? (
          <div className="flex items-center gap-2">
            <button onClick={() => handleDownload(latestFile)} className="text-sm text-ooosh-600 hover:text-ooosh-700 truncate" title={latestFile.name}>
              {latestFile.name}
            </button>
            <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(latestFile.uploaded_at)}</span>
            {olderFiles.length > 0 && (
              <button onClick={() => setShowHistory(!showHistory)} className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap">
                +{olderFiles.length} older
              </button>
            )}
            <button onClick={() => handleDelete(latestFile)} className="text-gray-300 hover:text-red-500 ml-1" title="Delete">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <span className="text-xs text-gray-400">{category.description}</span>
        )}
        {showHistory && olderFiles.length > 0 && (
          <div className="mt-1.5 ml-2 space-y-1 border-l-2 border-gray-100 pl-2">
            {olderFiles.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()).map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                <button onClick={() => handleDownload(f)} className="hover:text-ooosh-600 truncate">{f.name}</button>
                <span>{formatDate(f.uploaded_at)}</span>
                <button onClick={() => handleDelete(f)} className="hover:text-red-500">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <div className="flex-shrink-0">
        <input ref={fileInputRef} type="file" onChange={handleUpload} className="hidden" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx" />
        <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-ooosh-400 hover:text-ooosh-600 transition-colors disabled:opacity-50">
          {uploading ? 'Uploading...' : latestFile ? 'Replace' : 'Upload'}
        </button>
      </div>
    </div>
  );
}

// ── Referral Action Panel ──

function ReferralPanel({ driver, onDriverUpdate }: { driver: DriverDetail; onDriverUpdate: (d: DriverDetail) => void }) {
  const [resolving, setResolving] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'declined'>('approved');
  const [notes, setNotes] = useState('');
  const [adjustedExcess, setAdjustedExcess] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const [error, setError] = useState('');
  // Pre-populate dates from existing driver data, falling back to today + standard validity
  const today = new Date().toISOString().split('T')[0];
  const addDays = (d: string, days: number) => {
    const dt = new Date(d);
    dt.setDate(dt.getDate() + days);
    return dt.toISOString().split('T')[0];
  };
  const [extendDates, setExtendDates] = useState({
    idenfy_check_date: toInputDate(driver.idenfy_check_date) || today,
    dvla_check_date: toInputDate(driver.dvla_check_date) || today,
    poa1_valid_until: toInputDate(driver.poa1_valid_until) || addDays(today, 90),
    poa2_valid_until: toInputDate(driver.poa2_valid_until) || addDays(today, 90),
    passport_valid_until: toInputDate(driver.passport_valid_until) || addDays(today, 90),
  });

  // Build referral reasons from driver data
  const reasons: string[] = [];
  if (driver.referral_notes) reasons.push(driver.referral_notes);
  if (driver.has_disability) reasons.push('Declared disability/medical condition');
  if (driver.has_convictions) reasons.push('Declared motoring convictions');
  if (driver.has_prosecution) reasons.push('Declared pending prosecution');
  if (driver.has_accidents) reasons.push('Declared previous accidents');
  if (driver.has_insurance_issues) reasons.push('Declared insurance issues (declined/cancelled/special terms)');
  if (driver.has_driving_ban) reasons.push('Declared previous driving ban');
  if (driver.licence_points >= 9) reasons.push(`${driver.licence_points} penalty points on licence`);
  if (driver.licence_issue_country && !['GB', 'UK', 'DVLA'].includes(driver.licence_issue_country.toUpperCase())) {
    reasons.push(`Non-standard licence country: ${driver.licence_issue_country}`);
  }
  if (reasons.length === 0 && driver.additional_details) reasons.push(driver.additional_details);
  if (reasons.length === 0) reasons.push('Flagged by hire form verification process');

  const isResolved = driver.referral_status === 'approved' || driver.referral_status === 'declined';

  async function handleResolve() {
    setResolving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        outcome,
        notes,
      };
      if (adjustedExcess) {
        payload.adjusted_excess = parseFloat(adjustedExcess);
      }
      if (outcome === 'approved') {
        payload.extend_dates = extendDates;
      }
      const result = await api.post<{ data: DriverDetail }>(`/drivers/${driver.id}/resolve-referral`, payload);
      onDriverUpdate(result.data);
      setShowResolve(false);
    } catch (err: any) {
      setError(err.message || 'Failed to resolve referral');
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className={`bg-white rounded-xl shadow-sm border-2 p-6 ${
      isResolved
        ? driver.referral_status === 'approved' ? 'border-green-200' : 'border-red-200'
        : 'border-amber-300'
    }`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Insurance Referral</h3>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
          driver.referral_status === 'approved' ? 'bg-green-100 text-green-700'
            : driver.referral_status === 'declined' ? 'bg-red-100 text-red-700'
            : 'bg-amber-100 text-amber-700'
        }`}>
          {driver.referral_status || 'pending'}
        </span>
      </div>

      {/* Referral reasons */}
      <div className="mb-4">
        <dt className="text-xs text-gray-500 mb-1">Reasons for referral</dt>
        <dd className="text-sm text-gray-700">
          <ul className="list-disc list-inside space-y-0.5">
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </dd>
      </div>

      {/* Metadata row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
        <div>
          <dt className="text-xs text-gray-500">Referral Date</dt>
          <dd className="text-sm text-gray-900">{formatDate(driver.referral_date) || formatDate(driver.created_at)}</dd>
        </div>
        {driver.referral_notes && (
          <div className="md:col-span-2">
            <dt className="text-xs text-gray-500">Notes</dt>
            <dd className="text-sm text-gray-900">{driver.referral_notes}</dd>
          </div>
        )}
      </div>

      {/* Resolve button / form */}
      {!isResolved && !showResolve && (
        <button
          onClick={() => setShowResolve(true)}
          className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
        >
          Resolve Referral
        </button>
      )}

      {showResolve && (
        <div className="mt-4 border-t border-gray-200 pt-4 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Outcome</label>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as 'approved' | 'declined')}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="approved">Approved by insurer</option>
                <option value="declined">Declined by insurer</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Adjusted Excess (optional)</label>
              <div className="relative">
                <span className="absolute left-3 top-1.5 text-gray-400 text-sm">£</span>
                <input
                  type="number"
                  value={adjustedExcess}
                  onChange={(e) => setAdjustedExcess(e.target.value)}
                  placeholder="e.g. 2500"
                  className="w-full rounded border border-gray-300 pl-7 pr-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
              <p className="text-xs text-gray-400 mt-0.5">Leave blank if standard excess applies</p>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Resolution Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Spoke to insurer, confirmed OK with increased excess..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>

          {/* Date extensions — only for approved outcome */}
          {outcome === 'approved' && (
            <div>
              <label className="block text-xs text-gray-500 mb-2">Extend Validity Dates</label>
              <p className="text-xs text-gray-400 mb-2">Pre-filled with today's date. Adjusts so driver can proceed with hire form.</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Licence check date (90d validity)</label>
                  <input type="date" value={extendDates.idenfy_check_date} onChange={(e) => setExtendDates({ ...extendDates, idenfy_check_date: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">DVLA check date (30d validity)</label>
                  <input type="date" value={extendDates.dvla_check_date} onChange={(e) => setExtendDates({ ...extendDates, dvla_check_date: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">POA 1 valid until</label>
                  <input type="date" value={extendDates.poa1_valid_until} onChange={(e) => setExtendDates({ ...extendDates, poa1_valid_until: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">POA 2 valid until</label>
                  <input type="date" value={extendDates.poa2_valid_until} onChange={(e) => setExtendDates({ ...extendDates, poa2_valid_until: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Passport valid until</label>
                  <input type="date" value={extendDates.passport_valid_until} onChange={(e) => setExtendDates({ ...extendDates, passport_valid_until: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleResolve}
              disabled={resolving}
              className={`px-4 py-2 rounded text-sm font-medium text-white transition-colors ${
                outcome === 'approved'
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-red-600 hover:bg-red-700'
              } disabled:opacity-50`}
            >
              {resolving ? 'Saving...' : outcome === 'approved' ? 'Approve Referral' : 'Decline Referral'}
            </button>
            <button
              onClick={() => setShowResolve(false)}
              className="px-4 py-2 rounded text-sm text-gray-600 border border-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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
  onDriverUpdate,
  auditLog,
}: {
  driver: DriverDetail;
  editing: boolean;
  editData: Record<string, any>;
  setEditData: (d: Record<string, any>) => void;
  saving: boolean;
  saveError: string;
  onSave: () => void;
  onCancel: () => void;
  onDriverUpdate: (d: DriverDetail) => void;
  auditLog: AuditLogEntry[];
}) {
  const field = (label: string, key: string, opts?: { type?: string; mono?: boolean }) => {
    const rawValue = editing ? (editData[key] ?? '') : ((driver as any)[key] ?? '');
    const displayValue = !editing && opts?.type === 'date' ? formatDate(rawValue || null) : rawValue;
    const editValue = editing && opts?.type === 'date' ? toInputDate(rawValue || null) || rawValue : rawValue;

    if (editing) {
      return (
        <div>
          <label className="block text-xs text-gray-500 mb-1">{label}</label>
          <input
            type={opts?.type || 'text'}
            value={editValue}
            onChange={(e) => setEditData({ ...editData, [key]: opts?.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value })}
            className={`w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 ${opts?.mono ? 'font-mono' : ''}`}
          />
        </div>
      );
    }
    return (
      <div>
        <dt className="text-xs text-gray-500">{label}</dt>
        <dd className={`text-sm text-gray-900 ${opts?.mono ? 'font-mono' : ''}`}>{displayValue || '—'}</dd>
      </div>
    );
  };

  const validityField = (label: string, key: string, providerKey?: string) => {
    const providerLabel = providerKey ? (driver as any)[providerKey] : null;
    const fullLabel = providerLabel ? `${label} (${providerLabel})` : label;
    if (editing) {
      return (
        <div>
          <label className="block text-xs text-gray-500 mb-1">{fullLabel}</label>
          <input
            type="date"
            value={editData[key] || ''}
            onChange={(e) => setEditData({ ...editData, [key]: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
        </div>
      );
    }
    return (
      <div>
        <dt className="text-xs text-gray-400 mb-1">{fullLabel}</dt>
        <dd><ValidityPill date={(driver as any)[key]} /></dd>
      </div>
    );
  };

  const homeAddress = driver.address_full ||
    [driver.address_line1, driver.address_line2, driver.city, driver.postcode].filter(Boolean).join(', ');

  const insuranceFields = [
    { key: 'has_disability', label: 'Disability' },
    { key: 'has_convictions', label: 'Convictions' },
    { key: 'has_prosecution', label: 'Prosecution' },
    { key: 'has_accidents', label: 'Accidents' },
    { key: 'has_insurance_issues', label: 'Insurance Issues' },
    { key: 'has_driving_ban', label: 'Driving Ban' },
  ];

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
          <div>
            <dt className="text-xs text-gray-500">Phone</dt>
            {editing ? (
              <div className="flex gap-2">
                <input type="text" value={editData.phone_country || ''} onChange={(e) => setEditData({ ...editData, phone_country: e.target.value })} placeholder="+44" className="w-20 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                <input type="tel" value={editData.phone || ''} onChange={(e) => setEditData({ ...editData, phone: e.target.value })} className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
              </div>
            ) : (
              <dd className="text-sm text-gray-900">
                {driver.phone ? (
                  <span>{driver.phone_country && <span className="text-gray-400">{driver.phone_country} </span>}{driver.phone}</span>
                ) : '—'}
              </dd>
            )}
          </div>
          {field('Date of Birth', 'date_of_birth', { type: 'date' })}
          {field('Nationality', 'nationality')}
        </div>
      </div>

      {/* Document Validity — Ooosh acceptance windows, not raw doc dates */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Document Validity</h3>
        <p className="text-xs text-gray-400 mb-3">Ooosh acceptance windows — expiry triggers a renewal request via the hire form.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Licence: 90 days from iDenfy check, capped at actual licence expiry */}
          {(() => {
            const computed = computeOooshValidity(driver);
            if (editing) {
              return (
                <>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Licence (90d from check)</label>
                    <input type="date" value={editData.idenfy_check_date || ''} onChange={(e) => setEditData({ ...editData, idenfy_check_date: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                    {computed.licenceCapped && (
                      <span className="block text-[10px] text-amber-600 mt-0.5">Capped by licence expiry {formatDate(driver.licence_valid_to)}</span>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">DVLA Check (30d from check)</label>
                    <input type="date" value={editData.dvla_check_date || ''} onChange={(e) => setEditData({ ...editData, dvla_check_date: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                  </div>
                  {validityField(`POA 1${editData.poa1_provider ? ` (${editData.poa1_provider})` : ''} (90d from doc)`, 'poa1_valid_until', undefined)}
                  {validityField(`POA 2${editData.poa2_provider ? ` (${editData.poa2_provider})` : ''} (90d from doc)`, 'poa2_valid_until', undefined)}
                  {validityField('Passport', 'passport_valid_until')}
                </>
              );
            }
            return (
              <>
                <div>
                  <dt className="text-xs text-gray-400 mb-1">Licence (90d from check)</dt>
                  <dd>
                    <ValidityPill date={computed.licence} />
                    {computed.licenceCapped && (
                      <span className="block text-[10px] text-amber-600 mt-0.5">Capped by licence expiry {formatDate(driver.licence_valid_to)}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400 mb-1">DVLA Check (30d from check)</dt>
                  <dd><ValidityPill date={computed.dvla} /></dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400 mb-1">POA 1{driver.poa1_provider ? ` (${driver.poa1_provider})` : ''} (90d from doc)</dt>
                  <dd><ValidityPill date={driver.poa1_valid_until} /></dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400 mb-1">POA 2{driver.poa2_provider ? ` (${driver.poa2_provider})` : ''} (90d from doc)</dt>
                  <dd><ValidityPill date={driver.poa2_valid_until} /></dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400 mb-1">Passport{!computed.isUkDriver ? ' (30d from check)' : ''}</dt>
                  <dd><ValidityPill date={computed.passport} /></dd>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Addresses */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Addresses</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Home Address</h4>
            {editing ? (
              <div className="space-y-2">
                <input type="text" value={editData.address_full || ''} onChange={(e) => setEditData({ ...editData, address_full: e.target.value })} placeholder="Full address (from hire form)" className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                <p className="text-xs text-gray-400">Or individual fields:</p>
                <input type="text" value={editData.address_line1 || ''} onChange={(e) => setEditData({ ...editData, address_line1: e.target.value })} placeholder="Line 1" className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                <input type="text" value={editData.address_line2 || ''} onChange={(e) => setEditData({ ...editData, address_line2: e.target.value })} placeholder="Line 2" className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" value={editData.city || ''} onChange={(e) => setEditData({ ...editData, city: e.target.value })} placeholder="City" className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                  <input type="text" value={editData.postcode || ''} onChange={(e) => setEditData({ ...editData, postcode: e.target.value })} placeholder="Postcode" className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-900">{homeAddress || '—'}</p>
            )}
          </div>
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Licence Address</h4>
            {editing ? (
              <textarea value={editData.licence_address || ''} onChange={(e) => setEditData({ ...editData, licence_address: e.target.value })} placeholder="Address as shown on licence" rows={3} className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
            ) : (
              <p className="text-sm text-gray-900">{driver.licence_address || '—'}</p>
            )}
            {!editing && homeAddress && driver.licence_address && addressesDiffer(homeAddress, driver.licence_address) && (
              <p className="text-xs text-amber-600 mt-1">Address differs from home address</p>
            )}
          </div>
        </div>
      </div>

      {/* Licence Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Licence Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {field('Licence Number', 'licence_number', { mono: true })}
          {field('Type', 'licence_type')}
          {field('Issued By', 'licence_issued_by')}
          {field('Country', 'licence_issue_country')}
          {field('Valid From', 'licence_valid_from', { type: 'date' })}
          {field('Date Passed Test', 'date_passed_test', { type: 'date' })}
          {field('Points', 'licence_points', { type: 'number' })}
          {field('Restrictions', 'licence_restrictions')}
        </div>
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

      {/* Insurance Questionnaire — now always shown and editable */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Insurance Questionnaire</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {insuranceFields.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-2">
              {editing ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!editData[key]}
                    onChange={(e) => setEditData({ ...editData, [key]: e.target.checked })}
                    className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                  />
                  <span className="text-gray-700">{label}</span>
                </label>
              ) : (
                <>
                  <span className={`w-2 h-2 rounded-full ${(driver as any)[key] ? 'bg-red-500' : 'bg-green-500'}`} />
                  <span className="text-gray-700">{label}</span>
                </>
              )}
            </div>
          ))}
        </div>
        {editing ? (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Additional Details</label>
              <textarea
                value={editData.additional_details || ''}
                onChange={(e) => setEditData({ ...editData, additional_details: e.target.value })}
                rows={2}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
          </div>
        ) : (
          <>
            {driver.additional_details && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <dt className="text-xs text-gray-500">Additional Details</dt>
                <dd className="text-sm text-gray-700 mt-1">{driver.additional_details}</dd>
              </div>
            )}
          </>
        )}
      </div>

      {/* Documents — categorised file slots */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Documents</h3>
        <div className="divide-y divide-gray-50">
          {DOCUMENT_CATEGORIES.map((cat) => (
            <DocumentCategoryRow
              key={cat.label}
              category={cat}
              files={driver.files || []}
              driverId={driver.id}
              onFilesChanged={(files) => onDriverUpdate({ ...driver, files })}
            />
          ))}
        </div>

        {/* Uncategorised files */}
        {(() => {
          const allCategoryLabels = DOCUMENT_CATEGORIES.flatMap(c => c.fileLabels.map(l => l.toLowerCase()));
          const uncategorised = (driver.files || []).filter(f =>
            !f.label || !allCategoryLabels.includes(f.label.toLowerCase())
          );
          if (uncategorised.length === 0) return null;
          return (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Other Files</h4>
              <div className="space-y-1.5">
                {uncategorised.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-400 text-xs">{file.label || 'Unlabelled'}</span>
                    <button
                      onClick={async () => {
                        try {
                          const { blob, contentType } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
                          const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
                          window.open(blobUrl, '_blank');
                          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                        } catch { /* ignore */ }
                      }}
                      className="text-ooosh-600 hover:text-ooosh-700 truncate"
                    >
                      {file.name}
                    </button>
                    <span className="text-xs text-gray-400">{formatDate(file.uploaded_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Record Info */}
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
            <dt className="text-xs text-gray-500">Signed</dt>
            <dd className="text-gray-900">{formatDate(driver.signature_date)}</dd>
          </div>
        </div>
      </div>

      {/* Edit actions */}
      {editing && (
        <div className="flex gap-3">
          <button onClick={onSave} disabled={saving} className="bg-ooosh-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-700">
            Cancel
          </button>
        </div>
      )}

      {/* Audit Log */}
      {auditLog.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Edit History</h3>
          <div className="space-y-3">
            {auditLog.map((entry) => (
              <div key={entry.id} className="border-l-2 border-gray-200 pl-3 py-1">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{entry.user_name || entry.user_email || 'System'}</span>
                  <span>{formatDateTime(entry.created_at)}</span>
                </div>
                {entry.new_values && (
                  <div className="mt-1 text-xs text-gray-600">
                    {Object.entries(entry.new_values).map(([key, newVal]) => {
                      const oldVal = entry.previous_values?.[key];
                      const label = FIELD_LABELS[key] || key;
                      const oldStr = oldVal == null || oldVal === '' ? 'empty' : String(oldVal);
                      const newStr = newVal == null || newVal === '' ? 'empty' : String(newVal);
                      // Format date values
                      const isDate = key.includes('date') || key.includes('valid') || key.includes('until');
                      const displayOld = isDate && oldStr !== 'empty' ? formatDate(oldStr) : oldStr;
                      const displayNew = isDate && newStr !== 'empty' ? formatDate(newStr) : newStr;
                      return (
                        <div key={key}>
                          <span className="text-gray-500">{label}:</span>{' '}
                          <span className="text-red-600 line-through">{displayOld}</span>{' '}
                          <span className="text-green-700">{displayNew}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
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
                {h.hirehop_job_id ? <span>#{h.hirehop_job_id} {h.hirehop_job_name && `— ${h.hirehop_job_name.substring(0, 30)}`}</span> : '—'}
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
                  {h.has_damage && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">Damage</span>}
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
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{h.vehicle_reg}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatDate(h.hire_start)} — {formatDate(h.hire_end)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {h.excess_amount_required != null ? `\u00A3${Number(h.excess_amount_required).toFixed(2)}` : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">&pound;{Number(h.excess_amount_taken).toFixed(2)}</td>
                <td className="px-6 py-4 whitespace-nowrap">{excessStatusBadge(h.excess_status)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{h.payment_method?.replace('_', ' ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
