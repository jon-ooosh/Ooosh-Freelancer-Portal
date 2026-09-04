import { useState, useEffect } from 'react';
import { EvidenceGroup, type EvidenceGroupSpec, type EvidenceFile } from '../components/drivers/EvidenceGroup';
import { StageTracker, WhatNeedsDoing, type DriverVerificationState, type VerificationAction } from '../components/drivers/VerificationCockpit';
import { deriveDriverStatus } from '../lib/driverStatus';
import { hasManagerRole, roleAllowed } from '../lib/roles';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import OohComplianceTab from '../components/OohComplianceTab';
import PcnHistorySection from '../components/PcnHistorySection';
import ExcessPaymentModal from '../components/ExcessPaymentModal';
import CalculatedExcessEditModal from '../components/CalculatedExcessEditModal';
import type { JobExcess } from '../../../shared/types';

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
  licence_categories: string | null;
  licence_next_check_due: string | null;
  date_passed_test: string | null;
  // FROM dates — what staff and the hire form actually set (migration 192).
  poa1_doc_date: string | null;
  poa2_doc_date: string | null;
  passport_check_date: string | null;
  passport_expiry: string | null;
  // Derived expiry windows, maintained by services/driver-validity.ts on every
  // write. Display only — never edit these directly, edit the FROM date.
  licence_check_valid_until: string | null;
  // iDenfy verdict + staff review of a failed face match (migration 193).
  idenfy_overall: string | null;
  idenfy_face_result: string | null;
  idenfy_doc_result: string | null;
  idenfy_mismatch_tags: string[] | null;
  idenfy_suspicion_reasons: string[] | null;
  identity_check_status: 'needs_review' | 'accepted' | 'rejected' | null;
  identity_reviewed_at: string | null;
  identity_review_notes: string | null;
  current_job_number: number | null;
  current_job_started_at: string | null;
  /** current_job_number ONLY while they haven't signed for it and the job is live. */
  unsigned_job_number: number | null;
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
  // Driver-level individual liability — source of truth for /drivers
  // display + per-job excess calculation. Set by hire form submission,
  // editable via CalculatedExcessEditModal.
  calculated_excess_amount: number | string | null;
  calculated_excess_basis: string | null;
  excess_locked: boolean;
}

interface HireHistoryItem {
  id: string;
  job_id: string | null;
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

/** "just now" / "3 min ago" / "2 hr ago" for the header refresh stamp. */
function formatAgo(at: Date, now: number): string {
  const secs = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hr ago`;
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

function IdentityReviewPanel({ driver, onDriverUpdate }: {
  driver: DriverDetail;
  onDriverUpdate: (d: DriverDetail) => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState('');

  const status = driver.identity_check_status;
  if (!status) return null;

  const detail: string[] = [];
  if (driver.idenfy_overall) detail.push(`iDenfy result: ${driver.idenfy_overall}`);
  if (driver.idenfy_face_result) detail.push(`Face check: ${driver.idenfy_face_result}`);
  if (driver.idenfy_doc_result) detail.push(`Document check: ${driver.idenfy_doc_result}`);
  for (const t of driver.idenfy_mismatch_tags || []) detail.push(`Mismatch: ${t}`);
  for (const r of driver.idenfy_suspicion_reasons || []) detail.push(`Flag: ${r}`);

  async function resolve(outcome: 'accepted' | 'rejected') {
    setBusy(outcome);
    setError('');
    try {
      await api.post(`/drivers/${driver.id}/resolve-identity`, { outcome, notes });
      const refreshed = await api.get<{ data: DriverDetail }>(`/drivers/${driver.id}`);
      onDriverUpdate(refreshed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that — please try again.');
    } finally {
      setBusy(null);
    }
  }

  const tone = status === 'needs_review'
    ? { box: 'bg-amber-50 border-amber-200', head: 'text-amber-800' }
    : status === 'accepted'
      ? { box: 'bg-green-50 border-green-200', head: 'text-green-800' }
      : { box: 'bg-red-50 border-red-200', head: 'text-red-800' };

  return (
    <div className={`rounded-xl border p-6 ${tone.box}`}>
      <h3 className={`text-sm font-semibold mb-1 ${tone.head}`}>
        {status === 'needs_review' && 'Photo ID check needs review'}
        {status === 'accepted' && 'Photo ID check accepted'}
        {status === 'rejected' && 'Photo ID check rejected'}
      </h3>

      {status === 'needs_review' && (
        <p className="text-sm text-gray-700 mb-3">
          iDenfy couldn&rsquo;t match this driver&rsquo;s selfie to the photo on their licence. That&rsquo;s
          often just an old licence photo or a change in appearance &mdash; compare the
          <strong> Selfie</strong> and <strong>Licence Front</strong> images below and decide.
          Until then they can&rsquo;t be assigned to a hire and won&rsquo;t be sent a hire agreement.
        </p>
      )}

      {detail.length > 0 && (
        <ul className="text-xs text-gray-600 mb-3 space-y-0.5">
          {detail.map((d) => <li key={d}>• {d}</li>)}
        </ul>
      )}

      {status !== 'needs_review' && (
        <p className="text-xs text-gray-600">
          {driver.identity_reviewed_at && <>Reviewed {formatDate(driver.identity_reviewed_at)}. </>}
          {driver.identity_review_notes}
        </p>
      )}

      {status === 'needs_review' && (
        <>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Notes (optional) — e.g. spoke to driver, licence photo is 9 years old"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm mb-3 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => resolve('accepted')}
              className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50"
            >
              {busy === 'accepted' ? 'Saving…' : '✓ It&rsquo;s them — accept'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => resolve('rejected')}
              className="px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
            >
              {busy === 'rejected' ? 'Saving…' : '✕ Not a match — reject'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The evidence groups shown on the driver cockpit.
 *
 * Grouped by the WINDOW they share, not one row per file — the licence front,
 * back and selfie are three images behind a single 90-day identity check, which
 * is why the date is asked once per group. POA1 and POA2 are deliberately
 * separate groups: policy is that both must be valid, but they lapse
 * independently, so only the expired one gets asked for again.
 *
 * No arithmetic here. Every `until` is read straight off the driver row, where
 * backend/src/services/driver-validity.ts wrote it.
 */
function buildEvidenceGroups(driver: DriverDetail): EvidenceGroupSpec[] {
  const licenceUntrusted = !!driver.idenfy_check_date && !driver.licence_issued_by?.trim();
  return [
    {
      key: 'identity',
      title: 'Identity — licence & selfie',
      slots: [
        { label: 'Licence Front', match: ['Licence Front', 'licence_front', 'License Front', 'license_front'] },
        { label: 'Licence Back', match: ['Licence Back', 'licence_back', 'License Back', 'license_back'] },
        { label: 'Selfie', match: ['Selfie', 'selfie', 'face', 'idenfy_face'] },
      ],
      fromField: 'idenfy_check_date',
      fromLabel: 'Identity checked',
      docExpiryField: 'licence_valid_to',
      docExpiryLabel: 'Licence expires',
      until: driver.licence_check_valid_until,
      emptyHint: licenceUntrusted
        ? 'Identity check recorded but no licence details came back — needs re-verification'
        : undefined,
    },
    {
      key: 'dvla',
      title: 'DVLA check',
      slots: [{ label: 'DVLA Check', match: ['DVLA Check Code', 'DVLA Check', 'dvla_check', 'dvla'] }],
      fromField: 'dvla_check_date',
      fromLabel: 'Checked on',
      until: driver.dvla_valid_until,
    },
    {
      key: 'poa1',
      title: `Proof of address 1${driver.poa1_provider ? ` — ${driver.poa1_provider}` : ''}`,
      slots: [{ label: 'Proof of Address 1', match: ['Proof of Address', 'POA 1', 'poa1', 'Proof of Address 1'] }],
      fromField: 'poa1_doc_date',
      fromLabel: 'Date on document',
      textField: 'poa1_provider',
      textLabel: 'Provider',
      until: driver.poa1_valid_until,
    },
    {
      key: 'poa2',
      title: `Proof of address 2${driver.poa2_provider ? ` — ${driver.poa2_provider}` : ''}`,
      slots: [{ label: 'Proof of Address 2', match: ['POA 2', 'poa2', 'Proof of Address 2'] }],
      fromField: 'poa2_doc_date',
      fromLabel: 'Date on document',
      textField: 'poa2_provider',
      textLabel: 'Provider',
      until: driver.poa2_valid_until,
    },
    {
      key: 'passport',
      title: 'Passport',
      slots: [{ label: 'Passport', match: ['Passport', 'passport'] }],
      fromField: 'passport_check_date',
      fromLabel: 'Checked on',
      docExpiryField: 'passport_expiry',
      docExpiryLabel: 'Passport expires',
      until: driver.passport_valid_until,
    },
    {
      key: 'signature',
      title: 'Signature',
      slots: [{ label: 'Signature', match: ['Signature', 'signature', 'sig'] }],
      // A signature doesn't expire — it's per HIRE. So instead of an expiry
      // pill, say when they last signed and, if they're mid-form for a hire
      // they haven't signed for, say so in amber. That second state is the
      // one every surface used to miss (Cameron Williams-Hill / 16618).
      headerRight: driver.unsigned_job_number ? (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">
          Not yet signed for #{driver.unsigned_job_number}
          {driver.signature_date ? ` · last signed ${formatDate(driver.signature_date)}` : ''}
        </span>
      ) : driver.signature_date ? (
        <span className="text-xs text-gray-500">Signed {formatDate(driver.signature_date)}</span>
      ) : (
        <span className="text-xs text-gray-400">Not signed</span>
      ),
    },
  ];
}

/**
 * Does the licence address MATERIALLY differ from the home address?
 *
 * The two strings are two AI reads of two different documents — the home
 * address is lifted off the POA statement, the licence address off the licence
 * image — so they are never byte-identical and punctuation/spacing/case noise
 * is the norm. The Claude read of a licence also tends to repeat the postcode
 * ("…, B17 8JS, B17 8JS"), which a plain normalise-and-compare flagged as a
 * different address (Steven Aldridge, Sep 2026).
 *
 * The material test is: same UK postcode AND same house number. A move nearly
 * always changes the postcode; a different flat at the same postcode changes
 * the leading number. Where no UK postcode can be found on one side (an
 * overseas licence) it falls back to comparing the de-duplicated word sets,
 * which is today's behaviour minus the duplicate-token trap.
 *
 * Display only — nothing gates on this. The hire form does its own comparison
 * at POA upload time, and a driver who declares they have moved is routed to
 * a passport check there.
 */
const UK_POSTCODE = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/i;

function extractPostcode(addr: string): string | null {
  const m = addr.match(UK_POSTCODE);
  return m ? `${m[1]}${m[2]}`.toUpperCase() : null;
}

function leadingNumber(addr: string): string | null {
  const m = addr.match(/\d+[a-z]?/i);
  return m ? m[0].toLowerCase() : null;
}

function addressTokens(addr: string): Set<string> {
  return new Set(
    addr.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  );
}

function addressesDiffer(a: string, b: string): boolean {
  const pa = extractPostcode(a);
  const pb = extractPostcode(b);
  if (pa && pb) {
    if (pa !== pb) return true;
    const na = leadingNumber(a);
    const nb = leadingNumber(b);
    return !!(na && nb && na !== nb);
  }
  const ta = addressTokens(a);
  const tb = addressTokens(b);
  if (ta.size !== tb.size) return true;
  for (const t of ta) if (!tb.has(t)) return true;
  return false;
}

/**
 * Unified driver status — single source of truth, same as DriversPage.
 * Six statuses: In Progress / Approved / Expired / Refer to Insurers / Referred & Waiting / Not Approved
 * "Expired" = one or more documents past its validity window (renewable).
 */
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
// Friendly field name mapping for audit log display
const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full Name', email: 'Email', phone: 'Phone', phone_country: 'Phone Country',
  date_of_birth: 'Date of Birth', nationality: 'Nationality', address_full: 'Home Address',
  licence_address: 'Licence Address', address_line1: 'Address Line 1', address_line2: 'Address Line 2',
  city: 'City', postcode: 'Postcode', licence_number: 'Licence Number', licence_type: 'Licence Type',
  licence_issued_by: 'Issued By', licence_valid_from: 'Valid From', licence_valid_to: 'Valid To',
  licence_issue_country: 'Issue Country', licence_points: 'Points',
  licence_restrictions: 'Restrictions', licence_categories: 'Licence Categories',
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
  const canEdit = hasManagerRole(user?.role);
  // Document dates are deliberately wider than the rest of the record: whoever
  // uploads a replacement must be able to date it, or the date gets left for
  // someone else and forgotten. Scoped by PATCH /drivers/:id/document-dates,
  // which reaches nothing but the FROM dates.
  const canEditDates = roleAllowed(user?.role, ['admin', 'manager', 'staff', 'general_assistant']);

  const [driver, setDriver] = useState<DriverDetail | null>(null);
  const [hireHistory, setHireHistory] = useState<HireHistoryItem[]>([]);
  const [excessHistory, setExcessHistory] = useState<ExcessHistoryItem[]>([]);
  const [excessModalRecord, setExcessModalRecord] = useState<JobExcess | null>(null);
  const [excessModalLoadingId, setExcessModalLoadingId] = useState<string | null>(null);
  const [excessModalInitialAction, setExcessModalInitialAction] = useState<'edit_required' | undefined>(undefined);
  const [editingCalcExcess, setEditingCalcExcess] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [verificationState, setVerificationState] = useState<DriverVerificationState | null>(null);
  const [loading, setLoading] = useState(true);
  // Refresh button (top right): staff "watch" a driver complete a form live
  // and want a one-click re-read plus an honest "how stale is this?" stamp.
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<'details' | 'hires' | 'excess' | 'ooh' | 'pcns'>('details');
  const [pcnCount, setPcnCount] = useState<{ open: number; total: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (id) { loadDriver(); loadVerificationState(); }
  }, [id]);

  // Re-render the "Refreshed N min ago" label without refetching anything.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Reset tab + per-tab caches when switching drivers (component instance
  // is reused across /drivers/A → /drivers/B). Without this the active
  // tab + previously-loaded history "drags across" to the new driver.
  useEffect(() => {
    setActiveTab('details');
    setHireHistory([]);
    setExcessHistory([]);
    setPcnCount(null);
    setEditing(false);
    setEditData({});
  }, [id]);

  useEffect(() => {
    if (id && activeTab === 'hires' && hireHistory.length === 0) loadHireHistory();
    if (id && activeTab === 'excess' && excessHistory.length === 0) loadExcessHistory();
  }, [id, activeTab]);

  // Load audit log when details tab is shown
  useEffect(() => {
    if (id && activeTab === 'details') loadAuditLog();
  }, [id, activeTab]);

  async function loadDriver(opts: { silent?: boolean } = {}) {
    // `silent` keeps the page mounted: `loading=true` swaps the whole page for
    // the "Loading driver..." placeholder, which is right on first mount but
    // would flash the page away on a refresh click.
    if (!opts.silent) setLoading(true);
    try {
      const data = await api.get<{ data: DriverDetail }>(`/drivers/${id}`);
      setDriver(data.data);
      setLastRefreshedAt(new Date());
    } catch (err) {
      console.error('Failed to load driver:', err);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  /** Top-right Refresh: re-read everything the current view is showing. */
  async function refreshAll() {
    if (!id || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        loadDriver({ silent: true }),
        loadVerificationState(),
        activeTab === 'details' ? loadAuditLog() : Promise.resolve(),
        activeTab === 'hires' ? loadHireHistory() : Promise.resolve(),
        activeTab === 'excess' ? loadExcessHistory() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
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

  async function openExcessModal(excessId: string, initialAction?: 'edit_required') {
    setExcessModalLoadingId(excessId);
    try {
      const res = await api.get<{ data: JobExcess }>(`/excess/${excessId}`);
      setExcessModalInitialAction(initialAction);
      setExcessModalRecord(res.data);
    } catch (err) {
      console.error('Failed to load excess record:', err);
    } finally {
      setExcessModalLoadingId(null);
    }
  }

  async function loadVerificationState() {
    if (!id) return;
    try {
      const res = await api.get<{ data: DriverVerificationState }>(`/drivers/${id}/verification-state`);
      setVerificationState(res.data);
    } catch (err) {
      // Non-fatal: the cockpit hides itself rather than blocking the page.
      console.error('Failed to load verification state:', err);
      setVerificationState(null);
    }
  }

  /**
   * Save one date immediately and re-derive.
   *
   * Inline rather than behind the Edit form: the date is asked for right after
   * an upload, which is the moment staff actually know it. The backend derives
   * the matching *_valid_until on write, so we re-read the driver rather than
   * patching state locally.
   */
  async function handleDateChange(field: string, value: string) {
    if (!id) return;
    await api.patch(`/drivers/${id}/document-dates`, { [field]: value || null });
    const refreshed = await api.get<{ data: DriverDetail }>(`/drivers/${id}`);
    setDriver(refreshed.data);
    await loadVerificationState();
  }

  /**
   * "What needs doing" click-through — scroll to the group that needs work.
   * `send_hire_form` lines never reach here (the cockpit renders them without a
   * button): hire forms are sent per HIRE from the Job page, not from a driver.
   */
  function handleVerificationAction(action: VerificationAction) {
    if (!action.slot) return;
    const el = document.getElementById(`evidence-${action.slot}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      idenfy_check_date: toInputDate(driver.idenfy_check_date),
      // FROM dates — the editable inputs. The *_valid_until columns are derived
      // server-side on save, so they are deliberately NOT seeded here.
      poa1_doc_date: toInputDate(driver.poa1_doc_date),
      poa2_doc_date: toInputDate(driver.poa2_doc_date),
      passport_check_date: toInputDate(driver.passport_check_date),
      passport_expiry: toInputDate(driver.passport_expiry),
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
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{driver.full_name}</h1>
            {(() => {
              const s = deriveDriverStatus(driver);
              return (
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${s.colour}`}>
                  {s.label}
                </span>
              );
            })()}
          </div>
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
          {/* Activity strip — the three timestamps a staff member actually wants
              when diagnosing a driver mid-flow. updated_at bumps on any hire
              form app write; idenfy_check_date reflects the last successful
              licence verification; signature_date is set at form submission. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span title={driver.updated_at || ''}>
              <span className="text-gray-400">Last activity:</span>{' '}
              <span className="text-gray-700">{formatDateTime(driver.updated_at)}</span>
            </span>
            <span>
              <span className="text-gray-400">Idenfy completed:</span>{' '}
              <span className="text-gray-700">{formatDate(driver.idenfy_check_date)}</span>
            </span>
            <span>
              <span className="text-gray-400">Last signed:</span>{' '}
              <span className="text-gray-700">{formatDate(driver.signature_date)}</span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap justify-end items-center gap-2">
          {!editing && (
            <div className="flex items-center gap-2 mr-1">
              {lastRefreshedAt && (
                <span className="text-xs text-gray-400" title={lastRefreshedAt.toLocaleString('en-GB')}>
                  Refreshed {formatAgo(lastRefreshedAt, nowTick)}
                </span>
              )}
              <button
                type="button"
                onClick={refreshAll}
                disabled={refreshing}
                title="Re-read this driver's record — useful while watching someone complete a form"
                className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-700 px-3 py-2 rounded text-sm font-medium hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                <svg
                  className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}
          {!editing && (
            <SnapshotPdfButton driverId={driver.id} driverName={driver.full_name} />
          )}
          {!editing && canEdit && (
            <button
              onClick={startEditing}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              Edit
            </button>
          )}
          {!editing && user?.role === 'admin' && (
            <button
              onClick={async () => {
                if (!confirm(`Permanently delete driver record for ${driver.full_name}? This cannot be undone.`)) return;
                try {
                  await api.delete(`/drivers/${id}`);
                  navigate('/drivers');
                } catch (err) {
                  console.error('Failed to delete driver:', err);
                  alert('Failed to delete driver. Check console for details.');
                }
              }}
              className="border border-red-300 text-red-600 px-4 py-2 rounded text-sm font-medium hover:bg-red-50 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Referral panel — shown when a referral is pending OR has been
          resolved (keeps historical context visible even after approve
          clears requires_referral). */}
      {(driver.requires_referral || driver.referral_status) && (
        <div className="mt-4">
          <ReferralPanel driver={driver} onDriverUpdate={setDriver} />
        </div>
      )}

      {/* Calculated excess (driver-level liability) */}
      <div className="mt-4 bg-white border rounded-lg px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-gray-900">
            Calculated Excess (individual liability)
            {driver.excess_locked && (
              <span className="ml-2 text-xs text-amber-700" title="Locked against auto-update">
                🔒 Locked
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {driver.calculated_excess_amount != null
              ? <>£{Number(driver.calculated_excess_amount).toFixed(2)} — {driver.calculated_excess_basis || 'No reason recorded'}</>
              : 'Not yet set. Defaults to £1,200 on hire form completion.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditingCalcExcess(true)}
          className="text-sm text-ooosh-700 hover:underline"
        >
          Edit
        </button>
      </div>

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
            { key: 'ooh', label: 'OOH' },
            { key: 'pcns', label: pcnCount ? `PCNs (${pcnCount.total})` : 'PCNs' },
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
            onDriverUpdate={(d) => { setDriver(d); loadVerificationState(); }}
            auditLog={auditLog}
            canEditDates={canEditDates}
            onDateChanged={handleDateChange}
            verificationState={verificationState}
            onVerificationAction={handleVerificationAction}
          />
        )}
        {activeTab === 'hires' && <HireHistoryTab history={hireHistory} />}
        {activeTab === 'ooh' && <OohComplianceTab driverId={driver.id} />}
        {activeTab === 'pcns' && (
          <PcnHistorySection
            entityType="driver"
            entityId={driver.id}
            showRepeatFlag
            onCount={(open, total) => setPcnCount({ open, total })}
          />
        )}
        {activeTab === 'excess' && (
          <ExcessHistoryTab
            history={excessHistory}
            loadingId={excessModalLoadingId}
            onManage={(excessId, initialAction) => openExcessModal(excessId, initialAction)}
          />
        )}

        {excessModalRecord && (
          <ExcessPaymentModal
            excess={excessModalRecord}
            initialAction={excessModalInitialAction}
            onClose={() => { setExcessModalRecord(null); setExcessModalInitialAction(undefined); }}
            onUpdated={() => { loadExcessHistory(); }}
          />
        )}

        {editingCalcExcess && driver && (
          <CalculatedExcessEditModal
            driver={{
              id: driver.id,
              full_name: driver.full_name,
              calculated_excess_amount: driver.calculated_excess_amount,
              calculated_excess_basis: driver.calculated_excess_basis,
              excess_locked: driver.excess_locked,
            }}
            onClose={() => setEditingCalcExcess(false)}
            onSaved={(updated) => {
              setDriver((prev) => prev ? {
                ...prev,
                calculated_excess_amount: updated.calculated_excess_amount,
                calculated_excess_basis: updated.calculated_excess_basis,
                excess_locked: updated.excess_locked,
              } : prev);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Validity date pill ──

function SnapshotPdfButton({ driverId, driverName }: { driverId: string; driverName: string }) {
  const [generating, setGenerating] = useState(false);
  const accessToken = useAuthStore((s) => s.accessToken);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/drivers/${driverId}/generate-snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to generate snapshot');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Driver_Snapshot_${driverName.replace(/\s+/g, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Snapshot generation failed:', err);
      alert('Failed to generate snapshot PDF. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <button
      onClick={handleGenerate}
      disabled={generating}
      className="border border-gray-300 text-gray-700 px-4 py-2 rounded text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 flex items-center gap-1.5"
    >
      {generating ? (
        <>
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Generating...
        </>
      ) : (
        <>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Snapshot PDF
        </>
      )}
    </button>
  );
}

// ── Referral Action Panel ──

function ReferralPanel({ driver, onDriverUpdate }: { driver: DriverDetail; onDriverUpdate: (d: DriverDetail) => void }) {
  const [resolving, setResolving] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'declined' | 'waived'>('approved');
  const [notes, setNotes] = useState('');
  const [adjustedExcess, setAdjustedExcess] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const [error, setError] = useState('');
  // Mirror the driver's existing dates exactly — empty stays empty.
  // Falling back to today on null fields would let staff inadvertently
  // FABRICATE a check date that never happened (e.g. DVLA date for a
  // non-UK driver), or SHORTEN an already-valid future date by accepting
  // a defaulted "today" without realising it. Backend at
  // routes/drivers.ts only writes fields with truthy values, so leaving
  // a picker empty leaves the underlying date untouched.
  const [extendDates, setExtendDates] = useState({
    idenfy_check_date: toInputDate(driver.idenfy_check_date) || '',
    dvla_check_date: toInputDate(driver.dvla_check_date) || '',
    poa1_valid_until: toInputDate(driver.poa1_valid_until) || '',
    poa2_valid_until: toInputDate(driver.poa2_valid_until) || '',
    passport_valid_until: toInputDate(driver.passport_valid_until) || '',
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
      if (outcome === 'approved' || outcome === 'waived') {
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
      driver.referral_status === 'approved' ? 'border-green-200'
        : driver.referral_status === 'declined' ? 'border-red-200'
        : 'border-amber-300'
    }`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Insurance Referral</h3>
        {(() => {
          const s = deriveDriverStatus(driver);
          return (
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${s.colour}`}>
              {s.label}
            </span>
          );
        })()}
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

      {/* Action buttons — depends on current referral state */}
      {!isResolved && !showResolve && (
        <div className="flex gap-2">
          {/* If not yet marked as referred, show "Mark as Referred" to transition to pending.
              Stamps referral_date so we have a record of when the insurer email actually went out. */}
          {!driver.referral_status && (
            <button
              onClick={async () => {
                setError('');
                try {
                  const today = new Date().toISOString().split('T')[0];
                  const result = await api.put<{ data: DriverDetail }>(`/drivers/${driver.id}`, {
                    referral_status: 'pending',
                    referral_date: today,
                  });
                  onDriverUpdate(result.data);
                } catch (err: any) {
                  setError(err.message || 'Failed to update');
                }
              }}
              className="bg-amber-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-amber-700 transition-colors"
            >
              Mark as Referred to Insurer
            </button>
          )}
          <button
            onClick={() => setShowResolve(true)}
            className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
          >
            Resolve Referral
          </button>
        </div>
      )}

      {showResolve && (
        <div className="mt-4 border-t border-gray-200 pt-4 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Outcome</label>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as 'approved' | 'declined' | 'waived')}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="approved">Approved by insurer</option>
                <option value="declined">Declined by insurer</option>
                <option value="waived">Approved without referral (waived)</option>
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

          {/* Date extensions — for approved + waived outcomes */}
          {(outcome === 'approved' || outcome === 'waived') && (
            <div>
              <label className="block text-xs text-gray-500 mb-2">Extend Validity Dates</label>
              <p className="text-xs text-gray-400 mb-2">Mirrors the driver's current dates — leave blank to leave a date untouched. Empty fields are not overwritten.</p>
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
                outcome === 'declined'
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-green-600 hover:bg-green-700'
              } disabled:opacity-50`}
            >
              {resolving
                ? 'Saving...'
                : outcome === 'declined'
                  ? 'Decline Referral'
                  : outcome === 'waived'
                    ? 'Approve (Waive Referral)'
                    : 'Approve Referral'}
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
  canEditDates,
  onDateChanged,
  verificationState,
  onVerificationAction,
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
  canEditDates: boolean;
  onDateChanged: (field: string, value: string) => Promise<void>;
  verificationState: DriverVerificationState | null;
  onVerificationAction: (action: VerificationAction) => void;
}) {
  /**
   * One evidence group by key.
   *
   * Rendered individually rather than mapped over, so cards that describe a
   * document (Licence Details, Addresses) can sit with it — the page then reads
   * in the same order as the tracker above, and as the driver's own form.
   */
  const evidenceGroups = buildEvidenceGroups(driver);
  const evidenceDates: Record<string, string | null> = {
    idenfy_check_date: toInputDate(driver.idenfy_check_date),
    licence_valid_to: toInputDate(driver.licence_valid_to),
    dvla_check_date: toInputDate(driver.dvla_check_date),
    poa1_doc_date: toInputDate(driver.poa1_doc_date),
    poa2_doc_date: toInputDate(driver.poa2_doc_date),
    passport_check_date: toInputDate(driver.passport_check_date),
    passport_expiry: toInputDate(driver.passport_expiry),
    // Not dates, but they live on the same cards and go through the same PATCH.
    poa1_provider: driver.poa1_provider,
    poa2_provider: driver.poa2_provider,
  };
  const renderGroup = (key: string) => {
    const spec = evidenceGroups.find(g => g.key === key);
    if (!spec) return null;
    return (
      <EvidenceGroup
        key={spec.key}
        spec={spec}
        files={(driver.files || []) as EvidenceFile[]}
        driverId={driver.id}
        canEdit={canEditDates}
        dates={evidenceDates}
        onFilesChanged={(files) => onDriverUpdate({ ...driver, files: files as FileAttachment[] })}
        onDateChanged={onDateChanged}
      />
    );
  };

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
        <dd className={`text-sm text-gray-900 ${opts?.mono ? 'font-mono' : ''}`}>
          {displayValue === 0 || (displayValue !== '' && displayValue != null) ? displayValue : '—'}
        </dd>
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

      {verificationState && <StageTracker stages={verificationState.stages} />}
      {verificationState && (
        <WhatNeedsDoing state={verificationState} onAction={onVerificationAction} />
      )}

      <IdentityReviewPanel driver={driver} onDriverUpdate={onDriverUpdate} />

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

      {/* Which hire is this? A driver part-way through the form has no
          vehicle_hire_assignments row yet, so the Hire History tab is empty and
          nothing tells staff what a stuck driver relates to. */}
      {/* Keyed on "not signed FOR THIS HIRE", not "no signature at all" — a
          returning driver carries last time's signature_date, and that hid
          exactly this state for Cameron Williams-Hill / 16618 (Sep 2026). */}
      {driver.unsigned_job_number && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Started the hire form for job{' '}
          <Link to={`/jobs?search=${driver.unsigned_job_number}`} className="font-semibold underline">
            #{driver.unsigned_job_number}
          </Link>
          {driver.current_job_started_at && <> on {formatDate(driver.current_job_started_at)}</>}
          {' '}but hasn't signed it yet &mdash; nothing links them to the hire until they do.
          {driver.signature_date && (
            <> They last signed on {formatDate(driver.signature_date)}, for a previous hire.</>
          )}
        </div>
      )}

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

      {/* Rendered individually rather than mapped, so the cards that describe a
          document can sit with it. */}
      {renderGroup('identity')}
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
          {field('Categories', 'licence_categories')}
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

      {renderGroup('poa1')}
      {renderGroup('poa2')}
      {renderGroup('dvla')}
      {renderGroup('passport')}
      {renderGroup('signature')}

      {/* Anything uploaded outside the groups above — kept visible so a
          mis-labelled file is never silently invisible. Membership is tested
          against the evidence groups themselves, so a slot added there can't
          leave its files orphaned here. */}
      {(() => {
        const known = new Set(
          buildEvidenceGroups(driver)
            .flatMap(g => g.slots)
            .flatMap(sl => sl.match)
            .map(m => m.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
        const tokenOf = (v?: string) => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const uncategorised = (driver.files || []).filter(f =>
          !known.has(tokenOf(f.label)) && !known.has(tokenOf((f as { tag?: string }).tag))
        );
        // Render nothing at all when there's nothing to show — an empty card is
        // just a mystery box on the page.
        if (uncategorised.length === 0) return null;
        return (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6">
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Other Files</h4>
            <div className="space-y-1.5">
              {uncategorised.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm flex-wrap">
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
                    className="text-ooosh-600 hover:text-ooosh-700 truncate max-w-[60vw] sm:max-w-none"
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
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
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
          {history.map((h) => {
            const jobLabel = h.hirehop_job_id
              ? <span>#{h.hirehop_job_id} {h.hirehop_job_name && `— ${h.hirehop_job_name.substring(0, 30)}`}</span>
              : '—';
            return (
            <tr key={h.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <span className="text-sm font-medium text-gray-900">{h.vehicle_reg}</span>
                <span className="ml-2 text-xs text-gray-400">{h.vehicle_type}</span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                {h.job_id ? (
                  <Link to={`/jobs/${h.job_id}`} className="text-ooosh-700 hover:text-ooosh-900 hover:underline">
                    {jobLabel}
                  </Link>
                ) : (
                  <span className="text-gray-500">{jobLabel}</span>
                )}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Excess History Tab ──

function ExcessHistoryTab({
  history,
  loadingId,
  onManage,
}: {
  history: ExcessHistoryItem[];
  loadingId: string | null;
  onManage: (excessId: string, initialAction?: 'edit_required') => void;
}) {
  if (history.length === 0) {
    return <p className="text-sm text-gray-500 py-8 text-center">No excess history yet.</p>;
  }

  // Postgres DECIMAL columns serialise as strings via node-postgres; coerce each
  // addend to Number before summing so "0" + "1200.00" doesn't concatenate.
  const totalTaken = history.reduce((sum, h) => sum + Number(h.excess_amount_taken || 0), 0);
  const totalClaimed = history.reduce((sum, h) => sum + Number(h.claim_amount || 0), 0);
  const totalReimbursed = history.reduce((sum, h) => sum + Number(h.reimbursement_amount || 0), 0);

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
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {history.map((h) => {
              const rowLoading = loadingId === h.id;
              return (
                <tr key={h.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{h.vehicle_reg}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatDate(h.hire_start)} — {formatDate(h.hire_end)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {h.excess_amount_required != null ? `\u00A3${Number(h.excess_amount_required).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">&pound;{Number(h.excess_amount_taken).toFixed(2)}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{excessStatusBadge(h.excess_status)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{h.payment_method?.replace('_', ' ') || '—'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                    <div className="flex justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => onManage(h.id, 'edit_required')}
                        disabled={rowLoading}
                        className="text-ooosh-700 hover:text-ooosh-900 hover:underline font-medium disabled:opacity-50"
                      >
                        {rowLoading ? '…' : 'Edit'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onManage(h.id)}
                        disabled={rowLoading}
                        className="text-gray-600 hover:text-gray-900 hover:underline font-medium disabled:opacity-50"
                      >
                        Manage
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
