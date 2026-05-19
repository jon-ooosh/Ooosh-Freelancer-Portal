import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { getPaymentState, PAYMENT_STATE_LABELS, PAYMENT_STATE_CLASSES } from '../services/paymentState';
import ActivityTimeline from '../components/ActivityTimeline';
import JobProblemsPanel from '../components/JobProblemsPanel';
import TransportCalculator from '../components/TransportCalculator';
import RequirementCard from '../components/RequirementCard';
import type { JobRequirement } from '../components/RequirementCard';
import ExcessGateBanner from '../components/ExcessGateBanner';
import ExcessPaymentModal from '../components/ExcessPaymentModal';
import OohReturnModal from '../components/OohReturnModal';
import type { JobExcess } from '../../../shared/types';
import CancellationModal from '../components/CancellationModal';
import CancelOpenRequirementsSection from '../components/CancelOpenRequirementsSection';
import { useAuthStore } from '../hooks/useAuthStore';
import MoneyTab from '../components/MoneyTab';
import DatePicker from '../components/DatePicker';
import { TimeInput } from '../components/TimeInput';
import ChaseModal from '../components/ChaseModal';
import CompleteQuoteOverrideModal from '../components/CompleteQuoteOverrideModal';
import FileEmailModal from '../components/FileEmailModal';
import QuoteEditModal from '../components/QuoteEditModal';
import type { FileAttachment, PipelineStatus, HoldReason, ConfirmedMethod } from '@shared/index';
import { PIPELINE_STATUS_CONFIG, LOST_REASON_OPTIONS, PAUSED_REASON_OPTIONS } from '@shared/index';

const STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
  10: 'Not Interested', 11: 'Completed',
};

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
  9: 'bg-gray-100 text-gray-500',
  10: 'bg-gray-100 text-gray-500',
  11: 'bg-emerald-100 text-emerald-700',
};

const FILE_TAGS = [
  'Stage Plot', 'Rider', 'Tour Dates', 'Quote', 'Invoice',
  'Contract', 'Production Schedule', 'Site Map', 'Risk Assessment', 'Other',
] as const;

function fileTagColour(label: string): string {
  const map: Record<string, string> = {
    'Stage Plot': 'bg-purple-100 text-purple-700',
    'Rider': 'bg-blue-100 text-blue-700',
    'Tour Dates': 'bg-amber-100 text-amber-700',
    'Quote': 'bg-green-100 text-green-700',
    'Invoice': 'bg-emerald-100 text-emerald-700',
    'Contract': 'bg-red-100 text-red-700',
    'Production Schedule': 'bg-indigo-100 text-indigo-700',
    'Site Map': 'bg-teal-100 text-teal-700',
    'Risk Assessment': 'bg-orange-100 text-orange-700',
  };
  return map[label] || 'bg-gray-100 text-gray-600';
}

// Check if a file can be previewed inline
function isPreviewable(name: string): 'image' | 'pdf' | null {
  const lower = name.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(lower)) return 'image';
  if (/\.pdf$/.test(lower)) return 'pdf';
  return null;
}

interface JobDetail {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  job_type: string | null;
  status: number;
  status_name: string | null;
  colour: string | null;
  client_id: string | null;
  client_name: string | null;
  company_name: string | null;
  client_ref: string | null;
  venue_id: string | null;
  venue_name: string | null;
  address: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  out_time: string | null;
  start_time: string | null;
  return_time: string | null;
  end_time: string | null;
  created_date: string | null;
  duration_days: number | null;
  duration_hrs: number | null;
  manager1_name: string | null;
  manager1_person_id: string | null;
  manager2_name: string | null;
  manager2_person_id: string | null;
  hh_project_id: number | null;
  project_name: string | null;
  details: string | null;
  custom_index: string | null;
  depot_name: string | null;
  is_internal: boolean;
  job_value: number | null;
  pipeline_status: string | null;
  likelihood: string | null;
  enquiry_source: string | null;
  notes: string | null;
  next_chase_date: string | null;
  tags: string[];
  files: FileAttachment[];
  created_at: string;
  // Cancellation
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  cancellation_fee: number | null;
  cancellation_refund: number | null;
  cancellation_notice_days: number | null;
  cancellation_notes: string | null;
  cancellation_tier: string | null;
  reopened_from_job_id: string | null;
  reopened_to_job_id: string | null;
  // Lost-job fields (mirror of cancellation, populated by pipeline transition)
  lost_at?: string | null;
  lost_reason?: string | null;
  lost_detail?: string | null;
  has_client_email?: boolean;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  created_by_email: string | null;
  mentioned_user_ids: string[];
}

interface QuoteAssignment {
  id: string;
  person_id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  agreed_rate: number | null;
  rate_type: string | null;
  is_ooosh_crew?: boolean;
}

interface SavedQuote {
  id: string;
  job_type: string;
  calculation_mode: string;
  venue_name: string | null;
  venue_id: string | null;
  distance_miles: number | null;
  drive_time_mins: number | null;
  arrival_time: string | null;
  job_date: string | null;
  job_finish_date: string | null;
  is_multi_day: boolean;
  num_days: number | null;
  collection_date: string | null;
  add_collection: boolean;
  what_is_it: string | null;
  work_type: string | null;
  work_description: string | null;
  crew_count: number | null;
  client_charge_labour: number | null;
  client_charge_fuel: number | null;
  client_charge_expenses: number | null;
  client_charge_total: number | null;
  client_charge_rounded: number | null;
  freelancer_fee: number | null;
  freelancer_fee_rounded: number | null;
  expected_fuel_cost: number | null;
  expenses_included: number | null;
  expenses_not_included: number | null;
  our_margin: number | null;
  our_total_cost: number | null;
  estimated_time_hrs: number | null;
  travel_method: string | null;
  travel_time_mins: number | null;
  travel_cost: number | null;
  // Status
  status: string;
  status_changed_at: string | null;
  status_changed_by_name: string | null;
  cancelled_reason: string | null;
  // Run grouping
  run_group: string | null;
  run_order: number | null;
  run_combined_freelancer_fee: number | null;
  run_combined_client_fee: number | null;
  run_notes: string | null;
  // Assignments
  assignments: QuoteAssignment[];
  // Notes
  internal_notes: string | null;
  freelancer_notes: string | null;
  // HireHop push tracking — non-null when this quote was added as a line item on the linked HH job
  hh_pushed_at: string | null;
  // Pair link — set on delivery+collection siblings created together
  paired_quote_id: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface PersonOrgLink {
  organisation_id: string;
  organisation_name: string;
  role: string;
}

interface PersonOption {
  id: string;
  first_name: string;
  last_name: string;
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  current_organisations?: PersonOrgLink[] | null;
}

interface VehicleAssignment {
  id: string;
  vehicle_id: string;
  vehicle_reg: string;
  vehicle_type: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_email: string | null;
  driver_phone: string | null;
  driver_points: number | null;
  freelancer_name: string | null;
  freelancer_person_id: string | null;
  assignment_type: string;
  status: string;
  hire_start: string | null;
  hire_end: string | null;
  mileage_out: number | null;
  mileage_in: number | null;
  booked_out_at: string | null;
  checked_in_at: string | null;
  has_damage: boolean;
  notes: string | null;
  swap_reason: string | null;
  swapped_to_assignment_id: string | null;
  ve103b_ref: string | null;
  hire_form_pdf_key?: string | null;
  hire_form_generated_at?: string | null;
  excess?: {
    id: string;
    excess_status: string;
    excess_amount_required: number | null;
    excess_amount_taken: number | null;
  } | null;
  van_requirement_index?: number | null;
  /**
   * `vehicle_id` if directly linked, else the vehicle from a sibling staff
   * allocation on the same `van_requirement_index` (driver_id NULL,
   * vehicle_id set). Drives the "Allocate Van" → "Book Out" button switch
   * even when staff has done the allocation in two steps (alloc page picks
   * the van; cascade onto the hire form pending). At book-out time
   * BookOutPage's PATCH writes vehicle_id to this row anyway, so the
   * inferred link gets cemented retroactively.
   */
  effective_vehicle_id?: string | null;
  /** Out-of-hours return tracking (per-assignment) */
  return_overnight?: boolean | null;
  ooh_info_sent_at?: string | null;
  ooh_returned_at?: string | null;
}

interface DispatchCheckResult {
  canDispatch: boolean;
  totalAssignments: number;
  readyAssignments: number;
  blockers: Array<{
    type: string;
    assignmentId: string;
    driverName: string | null;
    vehicleReg: string | null;
    amountRequired: number | null;
  }>;
}

// ── Swap Vehicle Button ─────────────────────────────────────────────────────
function SwapVehicleButton({ assignmentId, currentVehicleReg, onSwapped }: {
  assignmentId: string;
  currentVehicleReg: string;
  onSwapped: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [vehicles, setVehicles] = useState<{ id: string; reg: string; simpleType: string }[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (showForm && vehicles.length === 0) {
      api.get<{ data: { id: string; reg: string; simple_type: string }[] }>('/vehicles/fleet')
        .then(r => setVehicles((r.data || []).map(v => ({ id: v.id, reg: v.reg, simpleType: v.simple_type }))))
        .catch(() => {});
    }
  }, [showForm]);

  const handleSwap = async () => {
    if (!selectedVehicle || !reason.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post(`/assignments/${assignmentId}/swap-vehicle`, {
        new_vehicle_id: selectedVehicle,
        swap_reason: reason,
      });
      setShowForm(false);
      onSwapped();
    } catch (err: any) {
      setError(err.message || 'Swap failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="text-xs text-orange-600 hover:text-orange-800 font-medium"
      >
        Swap Vehicle
      </button>
    );
  }

  return (
    <div className="mt-2 border border-orange-200 rounded-lg p-3 bg-orange-50 space-y-2">
      <p className="text-xs font-medium text-orange-800">
        Swap <strong>{currentVehicleReg}</strong> to:
      </p>
      <select
        value={selectedVehicle}
        onChange={e => setSelectedVehicle(e.target.value)}
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
      >
        <option value="">Select replacement vehicle...</option>
        {vehicles
          .filter(v => v.reg !== currentVehicleReg)
          .map(v => (
            <option key={v.id} value={v.id}>{v.reg} ({v.simpleType})</option>
          ))}
      </select>
      <input
        type="text"
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason for swap (e.g. breakdown)"
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleSwap}
          disabled={!selectedVehicle || !reason.trim() || submitting}
          className="bg-orange-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-orange-700 disabled:opacity-50"
        >
          {submitting ? 'Swapping...' : 'Confirm Swap'}
        </button>
        <button
          onClick={() => { setShowForm(false); setError(''); }}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Hire Form PDF Actions (per assignment, in Drivers & Vehicles tab) ────────
function HireFormActions({ assignmentId, pdfKey, pdfGeneratedAt, vehicleId }: {
  assignmentId: string;
  pdfKey?: string | null;
  pdfGeneratedAt?: string | null;
  vehicleId?: string | null;
}) {
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Can only generate a meaningful PDF once a vehicle is linked — the PDF
  // needs the reg + model. Before book-out, these buttons are dimmed and
  // disabled with a tooltip so they read as "safety nets for later" rather
  // than "this is the next action". Book-out generates + emails the
  // definitive PDF automatically.
  const hasVehicle = !!vehicleId;
  const disabledReason = hasVehicle ? null : 'Assign a vehicle first — the PDF needs the van reg';

  async function generatePdf(sendEmail: boolean) {
    setGenerating(true);
    setMessage(null);
    try {
      const res = await api.post<{ pdf_key: string; filename: string; email_sent: boolean; email_redirected_to?: string }>(
        `/hire-forms/${assignmentId}/generate-pdf?send_email=${sendEmail}`, {}
      );
      const parts = [`PDF generated: ${res.filename}`];
      if (res.email_sent) {
        parts.push(res.email_redirected_to
          ? `Email sent (test -> ${res.email_redirected_to})`
          : 'Email sent');
      }
      setMessage(parts.join(' | '));
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setGenerating(false);
    }
  }

  async function viewPdf() {
    // Raw <a href> to the download endpoint fails because the browser
    // opens the URL in a new tab WITHOUT the Authorization header, so
    // the auth-protected endpoint returns 401. Fetch the PDF as a blob
    // via the authenticated api client, then open a blob: URL instead.
    setGenerating(true);
    setMessage(null);
    try {
      const { blob } = await api.blob(`/hire-forms/${assignmentId}/download`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after a delay so the new tab has time to load the PDF.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Failed to open PDF'}`);
    } finally {
      setGenerating(false);
    }
  }

  async function resendEmail() {
    setGenerating(true);
    setMessage(null);
    try {
      const res = await api.post<{ email_sent: boolean; recipient: string; redirected_to?: string }>(
        `/hire-forms/${assignmentId}/send-email`, {}
      );
      setMessage(res.email_sent
        ? (res.redirected_to ? `Email sent (test -> ${res.redirected_to})` : `Email sent to ${res.recipient}`)
        : 'Email send failed');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className="font-medium text-gray-700">Hire Form</span>
          {pdfGeneratedAt && <span className="text-green-600">PDF ready</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => generatePdf(false)}
            disabled={generating || !hasVehicle}
            title={disabledReason || undefined}
            className="text-xs px-2.5 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {generating ? '...' : pdfKey ? 'Regenerate PDF' : 'Generate PDF'}
          </button>
          <button
            onClick={() => generatePdf(true)}
            disabled={generating || !hasVehicle}
            title={disabledReason || undefined}
            className="text-xs px-2.5 py-1.5 bg-ooosh-100 text-ooosh-700 rounded hover:bg-ooosh-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {generating ? '...' : 'Generate + Email'}
          </button>
          {pdfKey && (
            <>
              <button
                onClick={viewPdf}
                disabled={generating}
                className="text-xs px-2.5 py-1.5 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-50"
              >
                View PDF
              </button>
              <button
                onClick={resendEmail}
                disabled={generating}
                className="text-xs px-2.5 py-1.5 bg-amber-50 text-amber-700 rounded hover:bg-amber-100 disabled:opacity-50"
              >
                Re-send
              </button>
            </>
          )}
        </div>
      </div>
      {message && (
        <div className={`text-xs px-2 py-1.5 rounded mt-2 ${message.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
          {message}
        </div>
      )}
    </div>
  );
}

// ── Quick Assign Driver (+ optional Vehicle) to Job ────────────────────
// Links a driver to a hire in one click — vehicle is optional so staff can
// assign the driver up front and pick the vehicle later (vehicle choice is
// a separate prep-side decision).
/** Traffic-light validity state for a driver record. */
type DriverValidity = {
  level: 'green' | 'amber' | 'red';
  reasons: string[];           // human-readable expiry / amber notes
  expiredDocs: string[];       // names of expired docs (red trigger)
};

/**
 * Compute traffic-light validity for a driver record relative to today.
 *
 * Rules — kept aligned with the backend gate in /api/hire-forms/quick-assign:
 *   - Red: any required doc expired (licence_valid_to < today, dvla_valid_until
 *     < today, OR both POAs expired); insurance referral pending / declined
 *   - Amber: any required doc expires within the next 30 days
 *   - Green: all docs valid with > 30 days remaining
 *
 * Most active drivers will be amber in practice — the DVLA check is only
 * valid for 30 days from the date the driver pulls it, so a driver who
 * filled out their hire form even a week before the hire is already amber.
 * This is fine — staff can still assign amber drivers; the gate is red.
 */
function computeDriverValidity(d: {
  licence_valid_to?: string | null;
  dvla_valid_until?: string | null;
  poa1_valid_until?: string | null;
  poa2_valid_until?: string | null;
  requires_referral?: boolean;
  referral_status?: string | null;
}): DriverValidity {
  const reasons: string[] = [];
  const expiredDocs: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms30 = 30 * 24 * 60 * 60 * 1000;

  function check(label: string, raw: string | null | undefined): 'green' | 'amber' | 'red' {
    if (!raw) return 'amber';
    const exp = new Date(raw);
    const ms = exp.getTime() - today.getTime();
    if (ms < 0) {
      reasons.push(`${label} expired ${exp.toLocaleDateString('en-GB')}`);
      expiredDocs.push(label);
      return 'red';
    }
    if (ms <= ms30) {
      reasons.push(`${label} expires ${exp.toLocaleDateString('en-GB')}`);
      return 'amber';
    }
    return 'green';
  }

  let level: 'green' | 'amber' | 'red' = 'green';
  function bump(next: 'green' | 'amber' | 'red') {
    if (next === 'red') level = 'red';
    else if (next === 'amber' && level !== 'red') level = 'amber';
  }

  bump(check('Licence', d.licence_valid_to));
  bump(check('DVLA check', d.dvla_valid_until));

  // POA: at least one must be valid. Both expired → red.
  const poa1 = d.poa1_valid_until ? new Date(d.poa1_valid_until) : null;
  const poa2 = d.poa2_valid_until ? new Date(d.poa2_valid_until) : null;
  const poa1Expired = poa1 && poa1 < today;
  const poa2Expired = poa2 && poa2 < today;
  if ((!poa1 && !poa2) || (poa1Expired && poa2Expired) || (!poa1 && poa2Expired) || (poa1Expired && !poa2)) {
    reasons.push('Proof of address expired');
    expiredDocs.push('Proof of address');
    bump('red');
  } else {
    // Use the latest-expiring POA for the amber check
    const latest = poa1 && poa2 ? (poa1 > poa2 ? poa1 : poa2) : (poa1 || poa2);
    if (latest) {
      const ms = latest.getTime() - today.getTime();
      if (ms <= ms30) {
        reasons.push(`POA expires ${latest.toLocaleDateString('en-GB')}`);
        bump('amber');
      }
    }
  }

  if (d.requires_referral && d.referral_status !== 'approved') {
    reasons.push(`Insurance referral ${d.referral_status || 'pending'}`);
    bump('red');
  }

  return { level, reasons, expiredDocs };
}

function ValidityPill({ level }: { level: 'green' | 'amber' | 'red' }) {
  const styles = {
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-700',
    red:   'bg-red-100 text-red-700',
  }[level];
  const label = { green: 'OK', amber: 'Expiring', red: 'Expired' }[level];
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${styles}`}>{label}</span>
  );
}

function QuickAssignButton({ jobId, jobDate, jobEnd, onCreated, subtle }: { jobId: string; jobDate?: string; jobEnd?: string; onCreated: () => void; subtle?: boolean }) {
  const [open, setOpen] = useState(false);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [driverId, setDriverId] = useState('');
  const [driverSearch, setDriverSearch] = useState('');
  const [driverFocus, setDriverFocus] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [vehicleFocus, setVehicleFocus] = useState(false);
  const [hireStart, setHireStart] = useState(jobDate ? jobDate.substring(0, 10) : new Date().toISOString().substring(0, 10));
  // Hire end defaults to JOB END (the real end of charge), NOT return_date
  // (the +1-day warehouse turnaround buffer). Per the CLAUDE.md "Hire Date
  // Resolution" rule — return_date is for warehouse scheduling, never for
  // customer-facing hire windows.
  const [hireEnd, setHireEnd] = useState(jobEnd ? jobEnd.substring(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function loadOptions() {
    try {
      const res = await api.get<{ drivers: any[]; vehicles: any[] }>('/hire-forms/options/lists');
      setDrivers(res.drivers || []);
      setVehicles(res.vehicles || []);
    } catch {
      setError('Failed to load options');
    }
  }

  function resetForm() {
    setDriverId(''); setDriverSearch('');
    setVehicleId(''); setVehicleSearch('');
  }

  async function handleSubmit() {
    if (!driverId) { setError('Select a driver'); return; }
    setSaving(true);
    setError('');
    try {
      await api.post('/hire-forms/quick-assign', {
        driver_id: driverId,
        vehicle_id: vehicleId || undefined,          // optional
        job_id: jobId,
        hire_start: hireStart || undefined,
        hire_end: hireEnd || undefined,
      });
      setOpen(false);
      resetForm();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  const selectedDriver = drivers.find(d => d.id === driverId);
  const selectedDriverValidity = selectedDriver ? computeDriverValidity(selectedDriver) : null;
  const selectedVehicle = vehicles.find(v => v.id === vehicleId);

  // Annotate every driver with computed validity. Red drivers can't be
  // selected — staff sees them in the list (for transparency) but the
  // row is disabled with a "Send hire form" hint.
  const filteredDrivers = (driverSearch.trim() === ''
    ? drivers.slice(0, 50)
    : drivers.filter(d =>
        (d.full_name || '').toLowerCase().includes(driverSearch.toLowerCase()) ||
        (d.email || '').toLowerCase().includes(driverSearch.toLowerCase())
      ).slice(0, 50)
  ).map(d => ({ ...d, _validity: computeDriverValidity(d) }));

  const filteredVehicles = vehicleSearch.trim() === ''
    ? vehicles
    : vehicles.filter(v =>
        (v.reg || '').toLowerCase().includes(vehicleSearch.toLowerCase()) ||
        (v.vehicle_type || '').toLowerCase().includes(vehicleSearch.toLowerCase()) ||
        (v.simple_type || '').toLowerCase().includes(vehicleSearch.toLowerCase())
      );

  // Subtle mode renders a low-key text link instead of the prominent primary
  // button. The primary path for getting drivers onto a hire is the hire form
  // URL (auto-emailed T-10 days, manually chase-able). This manual fallback
  // exists for the "someone slipped through the net" edge case — admin/manager
  // only at the call site.
  return (
    <>
      {subtle ? (
        <button
          onClick={() => { setOpen(true); loadOptions(); }}
          className="text-xs text-gray-500 hover:text-gray-800 underline underline-offset-2"
          title="Manually add a driver to this job — use only if a driver hasn't been able to submit their hire form themselves"
        >
          + Add driver manually
        </button>
      ) : (
        <button
          onClick={() => { setOpen(true); loadOptions(); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium"
        >
          + Assign Driver
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Assign Driver to Hire</h3>
            <p className="text-xs text-gray-500 mb-4">Vehicle is optional — assign a driver now and pick the vehicle during prep.</p>

            {error && <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded mb-3">{error}</div>}

            <div className="space-y-3">
              {/* Driver picker — searchable, with traffic-light validity */}
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">Driver <span className="text-red-500">*</span></label>
                {selectedDriver && selectedDriverValidity ? (
                  <div>
                    <div className="flex items-center justify-between border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50">
                      <span className="flex items-center gap-2">
                        <ValidityPill level={selectedDriverValidity.level} />
                        <span>
                          <span className="font-medium">{selectedDriver.full_name}</span>
                          <span className="text-gray-500"> ({selectedDriver.email || 'no email'}) — {selectedDriver.licence_points || 0} pts</span>
                        </span>
                      </span>
                      <button type="button" onClick={() => { setDriverId(''); setDriverSearch(''); }}
                        className="text-gray-400 hover:text-gray-600 ml-2" aria-label="Clear driver">&times;</button>
                    </div>
                    {selectedDriverValidity.reasons.length > 0 && (
                      <div className={`mt-1 text-xs ${selectedDriverValidity.level === 'red' ? 'text-red-600' : 'text-amber-700'}`}>
                        {selectedDriverValidity.reasons.join(' · ')}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={driverSearch}
                      onChange={e => setDriverSearch(e.target.value)}
                      onFocus={() => setDriverFocus(true)}
                      onBlur={() => setTimeout(() => setDriverFocus(false), 150)}
                      placeholder="Search by name or email..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    {driverFocus && filteredDrivers.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                        {filteredDrivers.map(d => {
                          const v = d._validity as DriverValidity;
                          const blocked = v.level === 'red';
                          return (
                            <button
                              key={d.id}
                              type="button"
                              disabled={blocked}
                              title={blocked ? `Cannot assign — ${v.reasons.join(', ')}. Send a fresh hire form to refresh.` : v.reasons.join(', ')}
                              onClick={() => { if (!blocked) { setDriverId(d.id); setDriverSearch(''); } }}
                              className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 ${
                                blocked ? 'bg-gray-50 cursor-not-allowed opacity-60' : 'hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="font-medium text-gray-900 flex items-center gap-2">
                                  <ValidityPill level={v.level} />
                                  {d.full_name}
                                </div>
                                {blocked && <span className="text-[10px] text-red-600">Send hire form</span>}
                              </div>
                              <div className="text-xs text-gray-500">{d.email || 'no email'} — {d.licence_points || 0} pts</div>
                              {v.reasons.length > 0 && (
                                <div className={`text-[11px] mt-0.5 ${v.level === 'red' ? 'text-red-600' : 'text-amber-600'}`}>
                                  {v.reasons.slice(0, 2).join(' · ')}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {driverFocus && filteredDrivers.length === 0 && driverSearch.trim() !== '' && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm text-gray-500">No matching drivers</div>
                    )}
                  </>
                )}
              </div>

              {/* Vehicle picker — searchable, optional */}
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle <span className="text-gray-400 text-xs font-normal">(optional)</span></label>
                {selectedVehicle ? (
                  <div className="flex items-center justify-between border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50">
                    <span>
                      <span className="font-medium">{selectedVehicle.reg}</span>
                      <span className="text-gray-500"> — {selectedVehicle.vehicle_type || selectedVehicle.simple_type || 'Unknown'}</span>
                    </span>
                    <button type="button" onClick={() => { setVehicleId(''); setVehicleSearch(''); }}
                      className="text-gray-400 hover:text-gray-600 ml-2" aria-label="Clear vehicle">&times;</button>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={vehicleSearch}
                      onChange={e => setVehicleSearch(e.target.value)}
                      onFocus={() => setVehicleFocus(true)}
                      onBlur={() => setTimeout(() => setVehicleFocus(false), 150)}
                      placeholder="Search by reg or type..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    {vehicleFocus && filteredVehicles.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                        {filteredVehicles.map(v => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => { setVehicleId(v.id); setVehicleSearch(''); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                          >
                            <div className="font-medium text-gray-900">{v.reg}</div>
                            <div className="text-xs text-gray-500">{v.vehicle_type || v.simple_type || 'Unknown'}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    {vehicleFocus && filteredVehicles.length === 0 && vehicleSearch.trim() !== '' && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm text-gray-500">No matching vehicles</div>
                    )}
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hire Start</label>
                  <DatePicker value={hireStart} onChange={(val) => setHireStart(val)} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hire End</label>
                  <DatePicker value={hireEnd} onChange={(val) => setHireEnd(val)} />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setOpen(false); resetForm(); }} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button
                onClick={handleSubmit}
                disabled={saving || !driverId || selectedDriverValidity?.level === 'red'}
                title={selectedDriverValidity?.level === 'red' ? selectedDriverValidity.reasons.join(', ') : ''}
                className="px-4 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium disabled:opacity-50">
                {saving ? 'Creating...' : (vehicleId ? 'Assign Driver & Vehicle' : 'Assign Driver')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function EditableTextArea({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (val: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  function startEdit() {
    setDraft(value);
    setEditing(true);
    setTimeout(() => ref.current?.focus(), 50);
  }

  function save() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        rows={3}
        className="w-full border border-ooosh-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        placeholder={placeholder}
      />
    );
  }

  return (
    <div
      onClick={startEdit}
      className="min-h-[60px] cursor-pointer rounded px-3 py-2 text-sm text-gray-600 whitespace-pre-wrap hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors group"
      title="Click to edit"
    >
      {value || <span className="text-gray-400 italic">{placeholder}</span>}
      <svg className="w-3.5 h-3.5 inline-block ml-1 text-gray-300 group-hover:text-gray-500 transition-colors align-text-top" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    </div>
  );
}

// ─── Job Alert Banner ─────────────────────────────────────────────────────
// Shared shell for the time/data-driven banners that sit at the top of the
// Job Detail page (overdue dispatch, overdue return, hire form missing, etc.).
// Severity drives the colour scheme; an optional action button on the right
// gives the user a one-click next step (status change, tab switch, etc.).
function JobAlertBanner({
  severity,
  message,
  action,
}: {
  severity: 'amber' | 'red';
  message: React.ReactNode;
  action?: { label: string; onClick: () => void; loading?: boolean };
}) {
  const isRed = severity === 'red';
  return (
    <div
      className={`mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-sm border ${
        isRed ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
      }`}
    >
      <svg
        className={`w-4 h-4 flex-shrink-0 ${isRed ? 'text-red-500' : 'text-amber-500'}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
        />
      </svg>
      <span className={isRed ? 'text-red-800' : 'text-amber-800'}>{message}</span>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.loading}
          className={`ml-auto px-3 py-1 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 whitespace-nowrap ${
            isRed ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600'
          }`}
        >
          {action.loading ? 'Working…' : action.label}
        </button>
      )}
    </div>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const user = useAuthStore(s => s.user);
  const backTo = (location.state as { from?: string })?.from || '/jobs';
  const backLabel = backTo.includes('/returns') ? 'Back to Returns' : backTo.includes('/lost-cancelled') ? 'Back to Lost & Cancelled' : backTo === '/pipeline' ? 'Back to Pipeline' : 'Back to Jobs';

  const [job, setJob] = useState<JobDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const validTabs = ['overview', 'timeline', 'files', 'transport', 'drivers', 'money'] as const;
  type TabType = typeof validTabs[number];
  const initialTab = (validTabs.includes(searchParams.get('tab') as TabType) ? searchParams.get('tab') : 'overview') as TabType;
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  // Reset tab when navigating to a different job. React Router reuses the
  // JobDetailPage component instance across /jobs/A → /jobs/B, so without
  // this the active tab "drags across" — e.g. you were on Money on job A,
  // click through to job B and you're still on Money. Re-reads the URL
  // tab param so deep-links still land where they should.
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    setActiveTab((validTabs as readonly string[]).includes(urlTab || '') ? (urlTab as TabType) : 'overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [showCalculator, setShowCalculator] = useState(false);
  const [showDetailsNotes, setShowDetailsNotes] = useState(false);
  const detailsNotesRef = useRef<HTMLDivElement>(null);

  // Close details/notes on click outside
  useEffect(() => {
    if (!showDetailsNotes) return;
    function handleClick(e: MouseEvent) {
      if (detailsNotesRef.current && !detailsNotesRef.current.contains(e.target as Node)) {
        setShowDetailsNotes(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDetailsNotes]);
  const [showChaseModal, setShowChaseModal] = useState(false);
  const [quotes, setQuotes] = useState<SavedQuote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  // Requirements summary — only the bits the page-level alerts need (full
  // requirements list is loaded separately by the JobRequirements section).
  const [reqSummary, setReqSummary] = useState<{
    hireFormsStatus: string | null;
    postHireOpenCount: number;
  }>({ hireFormsStatus: null, postHireOpenCount: 0 });
  const [assignModalQuoteId, setAssignModalQuoteId] = useState<string | null>(null);
  const [peopleOptions, setPeopleOptions] = useState<PersonOption[]>([]);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [assignRole, setAssignRole] = useState('driver');

  const [editingQuote, setEditingQuote] = useState<SavedQuote | null>(null);
  const [completingQuote, setCompletingQuote] = useState<SavedQuote | null>(null);
  const [cancelledQuotesExpanded, setCancelledQuotesExpanded] = useState(false);
  const [showLocalForm, setShowLocalForm] = useState(false);
  const [localFormData, setLocalFormData] = useState({
    jobType: 'delivery' as 'delivery' | 'collection',
    venueId: '',
    venueName: '',
    jobDate: '',
    arrivalTime: '',
    notes: '',
    pushToHirehop: true,
  });
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [venueSearch, setVenueSearch] = useState('');
  const [venueOptions, setVenueOptions] = useState<{ id: string; name: string; city: string | null }[]>([]);
  const [showVenueDropdown, setShowVenueDropdown] = useState(false);

  // Job organisations (band, promoter, etc.)
  const [jobOrgs, setJobOrgs] = useState<Array<{
    id: string; job_id: string; organisation_id: string; role: string;
    is_primary: boolean; notes: string | null; organisation_name: string; organisation_type: string;
  }>>([]);
  const [showAddJobOrg, setShowAddJobOrg] = useState(false);
  const [jobOrgSearch, setJobOrgSearch] = useState('');
  const [jobOrgResults, setJobOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [jobOrgSelectedOrg, setJobOrgSelectedOrg] = useState<{ id: string; name: string; type: string } | null>(null);
  const [jobOrgRole, setJobOrgRole] = useState('band');
  const [jobOrgSaving, setJobOrgSaving] = useState(false);
  const [orgSuggestions, setOrgSuggestions] = useState<Array<{
    org_id: string; org_name: string; org_type: string;
    relationship_type: string; suggested_role: string;
  }>>([]);

  // Drivers & Vehicles state
  const [vehicleAssignments, setVehicleAssignments] = useState<VehicleAssignment[]>([]);
  const [excessModalRecord, setExcessModalRecord] = useState<JobExcess | null>(null);
  const [excessModalInitialAction, setExcessModalInitialAction] = useState<'edit_required' | 'reimburse' | undefined>(undefined);
  const [excessModalLoadingId, setExcessModalLoadingId] = useState<string | null>(null);
  // Excess records held against a cancelled job — used by the cancelled banner
  // to expose a one-click "Process refund" action straight into ExcessPaymentModal.
  const [cancelledExcessHeld, setCancelledExcessHeld] = useState<Array<{ id: string; excess_amount_taken: number; excess_status: string }>>([]);
  const [oohModalAssignmentId, setOohModalAssignmentId] = useState<string | null>(null);
  const [vehicleAssignmentsLoading, setVehicleAssignmentsLoading] = useState(false);
  const [dispatchCheck, setDispatchCheck] = useState<DispatchCheckResult | null>(null);
  // Cross-job allocation conflicts — van also booked on another job over
  // overlapping dates. Populated from /assignments/allocation-conflicts/:jobId
  // whenever the Drivers & Vehicles tab loads.
  type AllocationConflict = {
    assignmentId: string;
    vehicleId: string;
    vehicleReg: string | null;
    driverName: string | null;
    conflict: {
      id: string;
      status: string;
      jobId: string | null;
      hirehopJobId: number | null;
      jobName: string | null;
      hhJobNumber: number | null;
      effectiveStart: string | null;
      effectiveEnd: string | null;
      driverName: string | null;
    };
  };
  const [allocationConflicts, setAllocationConflicts] = useState<AllocationConflict[]>([]);
  // Date drift between job_date/job_end and an active assignment's hire_start
  // /hire_end. Populated from /assignments/date-mismatches/:jobId. Banner on
  // Drivers & Vehicles tab offers one-click "match dates" to push the
  // assignment back in line with the job — uses the overlap helper to refuse
  // if the new window collides with another hire on the same van.
  type DateMismatch = {
    assignmentId: string;
    vehicleReg: string | null;
    driverName: string | null;
    assignmentStatus: string;
    assignmentStart: string | null;
    assignmentEnd: string | null;
    jobStart: string | null;
    jobEnd: string | null;
    kind: 'extension' | 'shortening' | 'start_drift';
  };
  const [dateMismatches, setDateMismatches] = useState<DateMismatch[]>([]);
  // Per-session dismissal of date-mismatch banners. Staff can hide a
  // mismatch they don't want to act on right now (e.g. comms about it
  // are in flight, or the dates will be reverted shortly). Refreshing
  // the page brings the banner back so it's not lost permanently.
  const [dismissedMismatches, setDismissedMismatches] = useState<Set<string>>(new Set());

  // ── Inline editing state ──────────────────────────────────────────────────
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [editingHHNumber, setEditingHHNumber] = useState(false);
  const [editHHValue, setEditHHValue] = useState('');
  const [editingDates, setEditingDates] = useState(false);
  const [editOutDate, setEditOutDate] = useState('');
  const [editJobDate, setEditJobDate] = useState('');
  const [editJobEnd, setEditJobEnd] = useState('');
  const [editReturnDate, setEditReturnDate] = useState('');
  const [editOutTime, setEditOutTime] = useState('09:00');
  const [editStartTime, setEditStartTime] = useState('09:00');
  const [editReturnTime, setEditReturnTime] = useState('09:00');
  const [editEndTime, setEditEndTime] = useState('09:00');
  const [dateOutLinked, setDateOutLinked] = useState(true);
  const [dateReturnLinked, setDateReturnLinked] = useState(true);
  // Time chain links — Start Time mirrors Out Time, Return Time mirrors End Time
  // unless the user explicitly unlinks them. Mirrors the date chain UX.
  const [outTimeLinked, setOutTimeLinked] = useState(true);
  const [endTimeLinked, setEndTimeLinked] = useState(true);
  const [editingClient, setEditingClient] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [clientSearchResults, setClientSearchResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [inlineEditSaving, setInlineEditSaving] = useState(false);
  const [pushingToHH, setPushingToHH] = useState(false);
  const [hhClientOutOfSync, setHhClientOutOfSync] = useState(false);
  const [hhClientSyncName, setHhClientSyncName] = useState('');
  const [syncingClientToHH, setSyncingClientToHH] = useState(false);
  const [hhClientSyncSuccess, setHhClientSyncSuccess] = useState(false);
  const [hhDatesOutOfSync, setHhDatesOutOfSync] = useState(false);
  const [syncingDatesToHH, setSyncingDatesToHH] = useState(false);
  const [hhDatesSyncSuccess, setHhDatesSyncSuccess] = useState(false);

  // ── Pre-Hire Review manual send ─────────────────────────────────────────
  // (API path stays as /pre-hire-briefing for stability; UI label is the
  // user-facing name.)
  const [briefingSending, setBriefingSending] = useState(false);
  const [briefingLastSent, setBriefingLastSent] = useState<{
    sent_at: string;
    sent_by_name: string | null;
    trigger: 'manual' | 'scheduled' | null;
  } | null>(null);

  // Fetch last-sent on page load (and after each send) so the button can
  // show "Sent {time} ago" and staff don't double-send by accident.
  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    api.get<{ data: { sent_at: string; sent_by_name: string | null; trigger: 'manual' | 'scheduled' | null } | null }>(
      `/pre-hire-briefing/${job.id}/last-sent`
    )
      .then(r => { if (!cancelled) setBriefingLastSent(r.data); })
      .catch(() => { /* silent — button still works */ });
    return () => { cancelled = true; };
  }, [job?.id]);

  async function sendPreHireBriefing() {
    if (!job) return;
    setBriefingSending(true);
    try {
      const res = await api.post<{ sent_to: string; subject: string }>(
        `/pre-hire-briefing/${job.id}/send`, {}
      );
      alert(`Pre-Hire Review sent to ${res.sent_to}.\n\nSubject: ${res.subject}`);
      // Refresh last-sent so the button label updates without a page reload.
      try {
        const r = await api.get<{ data: typeof briefingLastSent }>(`/pre-hire-briefing/${job.id}/last-sent`);
        setBriefingLastSent(r.data);
      } catch { /* non-critical */ }
    } catch (err: any) {
      alert(`Failed to send review: ${err?.message || 'unknown error'}`);
    } finally {
      setBriefingSending(false);
    }
  }

  function formatBriefingLastSent(): string | null {
    if (!briefingLastSent) return null;
    const d = new Date(briefingLastSent.sent_at);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHrs / 24);
    let when: string;
    if (diffMin < 1) when = 'just now';
    else if (diffMin < 60) when = `${diffMin}m ago`;
    else if (diffHrs < 24) when = `${diffHrs}h ago`;
    else if (diffDays === 1) when = 'yesterday';
    else when = `${diffDays}d ago`;
    return when;
  }

  // ── HH Sync & Derived Requirements ──────────────────────────────────────
  const [hhSyncing, setHhSyncing] = useState(false);
  const [hhSyncResult, setHhSyncResult] = useState<{
    itemCount: number;
    derivation: {
      flags: {
        has_vehicle: boolean; vehicle_count: number; vehicle_types: string[];
        vehicle_slots?: Array<{ item_id: number; slot_index: number; item_name: string; mode: 'self_drive' | 'van_and_driver' }>;
        self_drive_count?: number;
        van_and_driver_count?: number;
        seat_config: 'round_table' | 'forward_facing' | null;
        has_backline: boolean; backline_item_count: number;
        has_rehearsal: boolean; has_staging: boolean; has_pa: boolean; has_lighting: boolean; has_crew_items: boolean; crew_item_count: number;
        total_prep_time_mins: number;
        prep_time_by_category: { vehicles: number; backline: number; rehearsals: number; other: number };
      };
      requirementsCreated: string[];
      requirementsUpdated: string[];
      mismatchesFlagged: string[];
      seatAvailability?: {
        required: string;
        matchingVans: Array<{ reg: string; seat_layout: string | null }>;
        nonMatchingVans: Array<{ reg: string; seat_layout: string | null }>;
        unknownVans: Array<{ reg: string }>;
      };
    };
  } | null>(null);
  const [hhLastSynced, setHhLastSynced] = useState<string | null>(null);
  const [hhStatusMismatch, setHhStatusMismatch] = useState<{ op_status: string; hh_status: number; hh_status_name: string } | null>(null);
  const [pushingStatusToHH, setPushingStatusToHH] = useState(false);
  const [prepChecklistKey, setPrepChecklistKey] = useState(0);
  const editNameRef = useRef<HTMLInputElement>(null);
  const editHHRef = useRef<HTMLInputElement>(null);
  const clientSearchRef = useRef<HTMLDivElement>(null);

  // ── Inline edit helpers ──────────────────────────────────────────────────
  function toDateInputValue(dateStr: string | null): string {
    if (!dateStr) return '';
    if (typeof dateStr === 'string' && dateStr.includes('T')) return dateStr.split('T')[0];
    return dateStr;
  }

  // Validate ordering of out/start/end/return datetimes. Returns a friendly
  // error string if invalid, or null if OK / insufficient data to check.
  // Mirrors backend validateJobDateTimes — same rules, same messages.
  function validateDateTimeOrdering(v: {
    out_date: string; job_date: string; job_end: string; return_date: string;
    out_time: string; start_time: string; end_time: string; return_time: string;
  }): string | null {
    const ms = (date: string, time: string): number => {
      if (!date) return NaN;
      const t = (time || '09:00').slice(0, 5);
      return Date.parse(`${date}T${t}:00Z`);
    };
    const oMs = ms(v.out_date, v.out_time);
    const sMs = ms(v.job_date, v.start_time);
    const eMs = ms(v.job_end, v.end_time);
    const rMs = ms(v.return_date, v.return_time);
    // Out > Start is allowed on the same calendar day (e.g. charge starts 09:00,
    // client collects at 15:00 — Outgoing here means the physical handover time).
    // Cross-day Out-after-Start stays blocked: the inbound HH sync would clobber
    // out_date back to job_date on the next pull (HH never sees the user's
    // intended later date because we clamp on push), so we don't expose that case.
    if (!isNaN(oMs) && !isNaN(sMs) && oMs > sMs && v.out_date !== v.job_date) {
      return 'Outgoing date must be on or before Job Start date.';
    }
    if (!isNaN(sMs) && !isNaN(eMs) && sMs > eMs) {
      return 'Job Start date/time must be on or before Job End date/time.';
    }
    if (!isNaN(eMs) && !isNaN(rMs) && eMs > rMs) {
      return 'Job End date/time must be on or before Returning date/time.';
    }
    return null;
  }

  function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }

  async function saveInlineField(patch: Record<string, unknown>) {
    if (!job) return;
    setInlineEditSaving(true);
    try {
      const resp = await api.patch<{ hh_writeback_warning?: string }>(`/pipeline/${job.id}/edit`, patch);
      await loadJob();
      if (resp?.hh_writeback_warning) {
        alert(resp.hh_writeback_warning);
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to save';
      console.error('Inline edit failed:', msg);
      alert(msg);
    } finally {
      setInlineEditSaving(false);
    }
  }

  function startEditName() {
    if (!job) return;
    setEditNameValue(job.job_name || '');
    setEditingName(true);
    setTimeout(() => editNameRef.current?.focus(), 50);
  }

  async function saveEditName() {
    if (!editNameValue.trim()) return;
    setEditingName(false);
    await saveInlineField({ job_name: editNameValue.trim() });
  }

  function startEditHHNumber() {
    setEditHHValue('');
    setEditingHHNumber(true);
    setTimeout(() => editHHRef.current?.focus(), 50);
  }

  async function saveEditHHNumber() {
    const raw = editHHValue.trim();
    if (!raw) { setEditingHHNumber(false); return; }
    // Extract job number from pasted HireHop URLs (e.g. https://myhirehop.com/job.php?id=15564)
    let jobNumber = raw;
    const urlMatch = raw.match(/[?&]id=(\d+)/);
    if (urlMatch) {
      jobNumber = urlMatch[1];
    } else {
      // Strip non-numeric characters in case they pasted something like "#15564"
      const numMatch = raw.match(/\d+/);
      if (numMatch) jobNumber = numMatch[0];
    }
    setEditingHHNumber(false);
    await saveInlineField({ hh_job_number: jobNumber });
  }

  function startEditDates() {
    if (!job) return;
    setEditOutDate(toDateInputValue(job.out_date));
    setEditJobDate(toDateInputValue(job.job_date));
    setEditJobEnd(toDateInputValue(job.job_end));
    setEditReturnDate(toDateInputValue(job.return_date));
    const outT = (job.out_time || '09:00:00').slice(0, 5);
    const startT = (job.start_time || job.out_time || '09:00:00').slice(0, 5);
    const returnT = (job.return_time || '09:00:00').slice(0, 5);
    const endT = (job.end_time || '09:00:00').slice(0, 5);
    setEditOutTime(outT);
    setEditStartTime(startT);
    setEditReturnTime(returnT);
    setEditEndTime(endT);
    // Determine link state from current values
    setDateOutLinked(toDateInputValue(job.out_date) === toDateInputValue(job.job_date));
    setDateReturnLinked(toDateInputValue(job.return_date) === toDateInputValue(job.job_end));
    setOutTimeLinked(outT === startT);
    setEndTimeLinked(endT === returnT);
    setEditingDates(true);
  }

  // Date linking handlers (mirrored from PipelinePage New Enquiry form)
  const handleEditOutDate = (val: string) => {
    if (val && editJobDate && val > editJobDate) return;
    setEditOutDate(val);
    if (dateOutLinked && val) {
      setEditJobDate(val);
      if (!editJobEnd || editJobEnd <= val) {
        const nextDay = addDays(val, 1);
        setEditJobEnd(nextDay);
        if (dateReturnLinked) setEditReturnDate(nextDay);
      }
    }
  };

  const handleEditJobDate = (val: string) => {
    setEditJobDate(val);
    if (dateOutLinked) {
      setEditOutDate(val);
    } else {
      if (editOutDate && editOutDate > val) setEditOutDate(val);
    }
    if (val) {
      if (!editJobEnd || editJobEnd < val) {
        const nextDay = addDays(val, 1);
        setEditJobEnd(nextDay);
        if (dateReturnLinked) setEditReturnDate(nextDay);
      }
    }
  };

  const handleEditJobEnd = (val: string) => {
    if (val && editJobDate && val < editJobDate) return;
    setEditJobEnd(val);
    if (dateReturnLinked) {
      setEditReturnDate(val);
    } else {
      if (editReturnDate && editReturnDate < val) setEditReturnDate(val);
    }
  };

  const handleEditReturnDate = (val: string) => {
    if (val && editJobEnd && val < editJobEnd) return;
    setEditReturnDate(val);
    if (dateReturnLinked) {
      setEditJobEnd(val);
    }
  };

  async function saveDates() {
    const outT = editOutTime || '09:00';
    const startT = outTimeLinked ? outT : (editStartTime || '09:00');
    const endT = editEndTime || '09:00';
    const returnT = endTimeLinked ? endT : (editReturnTime || '09:00');
    const orderingError = validateDateTimeOrdering({
      out_date: editOutDate, job_date: editJobDate, job_end: editJobEnd, return_date: editReturnDate,
      out_time: outT, start_time: startT, end_time: endT, return_time: returnT,
    });
    if (orderingError) {
      alert(orderingError);
      return;
    }
    if (editOutDate && editJobDate && editOutDate === editJobDate && outT > startT) {
      const ok = window.confirm(
        `Outgoing time (${outT}) is after Job Start time (${startT}).\n\n` +
        `HireHop will show Outgoing as ${startT} to keep the chargeable period intact. ` +
        `Ooosh will keep your ${outT} collection time for the Dashboard, prep schedules, etc.\n\n` +
        `Save?`
      );
      if (!ok) return;
    }
    setEditingDates(false);
    await saveInlineField({
      out_date: editOutDate || null,
      job_date: editJobDate || null,
      job_end: editJobEnd || null,
      return_date: editReturnDate || null,
      out_time: outT,
      start_time: startT,
      return_time: returnT,
      end_time: endT,
    });
    // Prompt to sync dates to HireHop if job is linked
    if (job?.hh_job_number) {
      setHhDatesOutOfSync(true);
      setHhDatesSyncSuccess(false);
    }
  }

  async function syncDatesToHH() {
    if (!job) return;
    setSyncingDatesToHH(true);
    try {
      await api.post(`/pipeline/${job.id}/push-dates-to-hh`, {});
      setHhDatesOutOfSync(false);
      setHhDatesSyncSuccess(true);
      setTimeout(() => setHhDatesSyncSuccess(false), 3000);
    } catch (err: any) {
      alert(err?.message || 'Failed to sync dates to HireHop');
    } finally {
      setSyncingDatesToHH(false);
    }
  }

  function startEditClient() {
    setClientSearch('');
    setClientSearchResults([]);
    setEditingClient(true);
  }

  async function selectClient(org: { id: string; name: string }) {
    setEditingClient(false);
    await saveInlineField({ client_id: org.id, client_name: org.name });
    // Show sync banner if job is linked to HireHop
    if (job?.hh_job_number) {
      setHhClientSyncName(org.name);
      setHhClientOutOfSync(true);
      setHhClientSyncSuccess(false);
    }
  }

  async function syncClientToHH() {
    if (!job) return;
    setSyncingClientToHH(true);
    try {
      await api.post(`/pipeline/${job.id}/sync-client-to-hh`, {});
      setHhClientOutOfSync(false);
      setHhClientSyncSuccess(true);
      setTimeout(() => setHhClientSyncSuccess(false), 3000);
    } catch (err: any) {
      const msg = err?.message || 'Failed to sync client to HireHop';
      alert(msg);
    } finally {
      setSyncingClientToHH(false);
    }
  }


  async function cycleLikelihood() {
    if (!job) return;
    const cycle = ['hot', 'warm', 'cold'] as const;
    const currentIdx = cycle.indexOf((job.likelihood || 'warm') as typeof cycle[number]);
    const nextIdx = (currentIdx + 1) % cycle.length;
    await saveInlineField({ likelihood: cycle[nextIdx] });
  }


  async function pushToHireHop() {
    if (!job) return;
    if (!job.job_date || !job.job_end) {
      alert('Start date and end date are required before creating a job in HireHop. Please set both dates first.');
      return;
    }
    setPushingToHH(true);
    try {
      await api.post(`/pipeline/${job.id}/push-hirehop`, {});
      await loadJob();
    } catch (err: any) {
      alert(err?.message || 'Failed to create in HireHop');
    } finally {
      setPushingToHH(false);
    }
  }

  // Search orgs for client picker
  useEffect(() => {
    if (!editingClient || clientSearch.length < 2) { setClientSearchResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
          `/organisations?search=${encodeURIComponent(clientSearch)}&limit=10`
        );
        setClientSearchResults(data.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [clientSearch, editingClient]);

  // Close client search dropdown on outside click
  useEffect(() => {
    if (!editingClient) return;
    function handleClickOutside(e: MouseEvent) {
      if (clientSearchRef.current && !clientSearchRef.current.contains(e.target as Node)) {
        setEditingClient(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [editingClient]);

  // Escape key to close modals
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (assignModalQuoteId) { setAssignModalQuoteId(null); setPeopleSearch(''); setPeopleOptions([]); }
        else if (showLocalForm) setShowLocalForm(false);
      }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [assignModalQuoteId, showLocalForm]);

  // Status transition state
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showTransitionModal, setShowTransitionModal] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<PipelineStatus | null>(null);
  const [transitionSaving, setTransitionSaving] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Close status dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setShowStatusDropdown(false);
      }
    }
    if (showStatusDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showStatusDropdown]);

  async function handleStatusTransition(targetStatus: PipelineStatus, extraData?: Record<string, unknown>) {
    if (!job) return;
    setTransitionSaving(true);
    try {
      await api.patch(`/pipeline/${job.id}/status`, {
        pipeline_status: targetStatus,
        ...extraData,
      });
      await loadJob();
      await loadInteractions();
      setShowTransitionModal(false);
      setTransitionTarget(null);
    } catch (err) {
      console.error('Status transition failed:', err);
    } finally {
      setTransitionSaving(false);
    }
  }

  function initiateStatusChange(targetStatus: PipelineStatus) {
    setShowStatusDropdown(false);
    const needsPrompt = ['paused', 'confirmed', 'lost', 'cancelled', 'completed'].includes(targetStatus);
    const needsDispatchConfirm = ['dispatched'].includes(targetStatus);
    // Check if going backwards from confirmed/operational to enquiry stage
    const enquiryStages = ['new_enquiry', 'provisional'];
    const isGoingBackwards = (isConfirmed || isOperational) && enquiryStages.includes(targetStatus);
    if (isGoingBackwards) {
      const LABELS: Record<string, string> = { new_enquiry: 'Enquiry', provisional: 'Provisional' };
      if (!window.confirm(`Move this job back to "${LABELS[targetStatus] || targetStatus}"? This will also update HireHop.`)) return;
      handleStatusTransition(targetStatus);
    } else if (needsPrompt) {
      setTransitionTarget(targetStatus);
      setShowTransitionModal(true);
    } else if (needsDispatchConfirm) {
      if (window.confirm('Mark as On Hire? This will update HireHop to Dispatched status.')) {
        handleStatusTransition(targetStatus);
      }
    } else {
      handleStatusTransition(targetStatus);
    }
  }

  // Client trading history for sidebar
  const [clientNotesExpanded, setClientNotesExpanded] = useState(false);
  const [clientHistoryData, setClientHistoryData] = useState<{
    jobs: Array<{
      id: string; hh_job_number: number | null; job_name: string | null;
      status: number; pipeline_status: string | null; job_date: string | null;
      job_end: string | null; job_value: number | null;
    }>;
    stats: {
      total_jobs: string; confirmed_jobs: string; lost_jobs: string;
      total_confirmed_value: string; total_value: string;
    };
    client_info?: {
      id: string; name: string;
      do_not_hire: boolean; do_not_hire_reason: string | null;
      working_terms_type: string | null; working_terms_credit_days: number | null;
      working_terms_notes: string | null; internal_notes: string | null;
    } | null;
    band_history?: {
      jobs: Array<{
        id: string; hh_job_number: number | null; job_name: string | null;
        status: number; pipeline_status: string | null; job_date: string | null;
        job_end: string | null; job_value: number | null;
      }>;
      stats: { total_jobs: string; confirmed_jobs: string; lost_jobs: string; total_confirmed_value: string; total_value: string };
      band_info?: { id: string; name: string; do_not_hire: boolean; do_not_hire_reason: string | null; internal_notes: string | null } | null;
    } | null;
  } | null>(null);

  useEffect(() => {
    if (id) {
      // Clear previous job's state immediately so we never render stale data
      // for the new job — React Router reuses the component instance across
      // /jobs/A → /jobs/B, and any in-flight fetch from A could otherwise
      // resolve and overwrite B's state. Worse: loadVehicleAssignments reads
      // job.hh_job_number from state to build its second query, so without
      // this reset it would query A's HH number while displaying B's page.
      setJob(null);
      setInteractions([]);
      setQuotes([]);
      setVehicleAssignments([]);
      setDispatchCheck(null);
      setAllocationConflicts([]);
      setDateMismatches([]);
      setJobOrgs([]);
      setReqSummary({ hireFormsStatus: null, postHireOpenCount: 0 });
      setLoading(true);

      loadJob();
      loadInteractions();
      loadQuotes();
      // loadVehicleAssignments is now driven by [job?.id, job?.hh_job_number]
      // below — running it here would use the stale job state.
      loadJobOrgs();
      loadRequirementsSummary();
    }
  }, [id]);

  // loadVehicleAssignments depends on job.hh_job_number to fetch staff
  // allocations (which only carry hirehop_job_id, not the OP UUID). Run it
  // only once `job` has loaded for the CURRENT id, otherwise we'd query the
  // previous job's HH number and merge those rows into this page.
  useEffect(() => {
    if (!id || !job || job.id !== id) return;
    loadVehicleAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job?.id, job?.hh_job_number]);

  // Re-run loadVehicleAssignments when V&D slot info arrives — the first
  // fetch on page load races the HH sync that populates vehicle_slots, so
  // V&D staff-allocation rows can be filtered out on the first pass and
  // never re-evaluated. This second fetch picks them up once we know which
  // slots are V&D. Cheap (one query) and idempotent — assignments rarely
  // change between these two fetches.
  const vandSlotSignature = useMemo(() => {
    const slots = hhSyncResult?.derivation?.flags?.vehicle_slots || [];
    return slots.filter(s => s.mode === 'van_and_driver').map(s => s.slot_index).sort().join(',');
  }, [hhSyncResult]);
  useEffect(() => {
    if (!id) return;
    if (!vandSlotSignature) return;
    // Don't fire until job has loaded for THIS id — see loadVehicleAssignments
    // comment above. Otherwise the V&D-driven refetch could run with stale
    // job state on the first navigation to a new job.
    if (!job || job.id !== id) return;
    loadVehicleAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, vandSlotSignature, job?.id]);

  async function loadRequirementsSummary() {
    if (!id) return;
    try {
      const [pre, post] = await Promise.all([
        api.get<{ data: JobRequirement[] }>(`/requirements/job/${id}?phase=pre_hire`),
        api.get<{ data: JobRequirement[] }>(`/requirements/job/${id}?phase=post_hire`),
      ]);
      const hf = pre.data.find(r => r.requirement_type === 'hire_forms');
      const openPost = post.data.filter(r => r.status !== 'done').length;
      setReqSummary({
        hireFormsStatus: hf?.status || null,
        postHireOpenCount: openPost,
      });
    } catch {
      // non-fatal — alerts just won't fire
    }
  }

  // Search orgs for job-org picker
  useEffect(() => {
    if (jobOrgSearch.length < 2) { setJobOrgResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
          `/organisations?search=${encodeURIComponent(jobOrgSearch)}&limit=10`
        );
        // Filter out orgs already linked
        const linkedIds = new Set(jobOrgs.map(jo => jo.organisation_id));
        setJobOrgResults(data.data.filter(o => !linkedIds.has(o.id)));
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [jobOrgSearch]);

  // Load client history when job loads (include band if linked)
  useEffect(() => {
    if (job && (job.client_id || job.client_name)) {
      let params = job.client_id
        ? `client_id=${encodeURIComponent(job.client_id)}&exclude_job_id=${job.id}`
        : `client_name=${encodeURIComponent(job.client_name!)}&exclude_job_id=${job.id}`;
      const bandOrg = jobOrgs.find(jo => jo.role === 'band');
      if (bandOrg) params += `&band_id=${encodeURIComponent(bandOrg.organisation_id)}`;
      api.get<typeof clientHistoryData>(`/pipeline/client-history?${params}`)
        .then(data => setClientHistoryData(data))
        .catch(() => setClientHistoryData(null));
    }
  }, [job?.id, job?.client_id, job?.client_name, jobOrgs]);

  async function loadQuotes() {
    if (!id) return;
    setQuotesLoading(true);
    try {
      const data = await api.get<{ data: SavedQuote[] }>(`/quotes?job_id=${id}`);
      setQuotes(data.data);
    } catch {
      console.error('Failed to load quotes');
    } finally {
      setQuotesLoading(false);
    }
  }

  async function updateQuoteStatus(quoteId: string, status: string, cancelledReason?: string) {
    try {
      await api.patch(`/quotes/${quoteId}/status`, { status, cancelledReason });
      await loadQuotes();
    } catch {
      console.error('Failed to update quote status');
    }
  }


  function startEditQuote(q: SavedQuote) {
    setEditingQuote(q);
  }

  // Cycle client_introduction through not_needed → todo → working_on_it → done.
  // Mirrors the same pill on TransportOpsPage so staff can clear intros from
  // the Job Detail without switching pages.
  async function cycleClientIntro(quoteId: string, current: string) {
    const order = ['not_needed', 'todo', 'working_on_it', 'done'];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    try {
      await api.put(`/quotes/${quoteId}/ops-details`, { client_introduction: next });
      await loadQuotes();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update client intro');
    }
  }

  async function searchVenues(search: string) {
    try {
      const data = await api.get<{ data: { id: string; name: string; city: string | null }[] }>(
        `/venues?search=${encodeURIComponent(search)}&limit=10`
      );
      setVenueOptions(data.data);
    } catch {
      console.error('Failed to search venues');
    }
  }

  function getDefaultDate(jobType: 'delivery' | 'collection'): string {
    if (!job) return '';
    const dateStr = jobType === 'delivery' ? job.out_date : job.return_date;
    if (!dateStr) return '';
    // Handle both Date objects and ISO strings
    if (typeof dateStr === 'object' && dateStr !== null) return (dateStr as Date).toISOString().split('T')[0];
    if (typeof dateStr === 'string') return dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return '';
  }

  function openLocalForm() {
    if (!job) return;
    const defaultDate = getDefaultDate('delivery');
    setLocalFormData({
      jobType: 'delivery',
      venueId: job.venue_id || '',
      venueName: job.venue_name || '',
      jobDate: defaultDate,
      arrivalTime: '',
      notes: '',
      pushToHirehop: true,
    });
    setVenueSearch(job.venue_name || '');
    setVenueOptions([]);
    setShowVenueDropdown(false);
    setShowLocalForm(true);
  }

  async function searchPeople(search: string) {
    try {
      const data = await api.get<{ data: PersonOption[] }>(`/people?search=${encodeURIComponent(search)}&limit=10&is_freelancer=true&is_approved=true`);
      setPeopleOptions(data.data);
    } catch {
      console.error('Failed to search people');
    }
  }

  async function assignPerson(quoteId: string, personId: string, role: string) {
    try {
      await api.post(`/quotes/${quoteId}/assignments`, { personId, role });
      await loadQuotes();
      setAssignModalQuoteId(null);
      setPeopleSearch('');
      setPeopleOptions([]);
      setAssignRole('driver');
    } catch {
      console.error('Failed to assign person');
    }
  }

  async function removeAssignment(quoteId: string, assignmentId: string) {
    try {
      await api.delete(`/quotes/${quoteId}/assignments/${assignmentId}`);
      await loadQuotes();
    } catch {
      console.error('Failed to remove assignment');
    }
  }

  async function loadJob() {
    try {
      const data = await api.get<JobDetail>(`/hirehop/jobs/${id}`);
      setJob(data);
    } catch {
      navigate(backTo);
    } finally {
      setLoading(false);
    }
  }

  /** Sync line items from HireHop + run requirement derivation */
  async function syncFromHireHop(showIndicator = true) {
    if (!id || !job?.hh_job_number) return;
    if (showIndicator) setHhSyncing(true);
    try {
      const data = await api.post<{
        success: boolean; itemCount: number;
        derivation: typeof hhSyncResult extends null ? never : NonNullable<typeof hhSyncResult>['derivation'];
        statusMismatch?: { op_status: string; hh_status: number; hh_status_name: string } | null;
      }>(`/hirehop/jobs/${id}/sync`, {});
      setHhSyncResult({ itemCount: data.itemCount, derivation: data.derivation });
      setHhLastSynced(new Date().toISOString());
      // Surface status mismatch if detected
      setHhStatusMismatch(data.statusMismatch || null);
      // Always reload job after sync to pick up requirement changes
      loadJob();
      // Bump prepChecklistKey to force prep checklist to re-fetch
      setPrepChecklistKey(k => k + 1);
    } catch (err) {
      console.warn('HH sync failed:', err);
    } finally {
      if (showIndicator) setHhSyncing(false);
    }
  }

  /** Push OP pipeline status to HireHop to resolve a mismatch */
  async function pushStatusToHH() {
    if (!job) return;
    setPushingStatusToHH(true);
    try {
      await api.patch(`/pipeline/${job.id}/status`, {
        pipeline_status: job.pipeline_status,
      });
      setHhStatusMismatch(null);
      await loadJob();
    } catch (err: any) {
      alert(err?.message || 'Failed to push status to HireHop');
    } finally {
      setPushingStatusToHH(false);
    }
  }

  // Auto-sync on page load when job has a HH number (non-blocking)
  useEffect(() => {
    if (job?.hh_job_number && id) {
      syncFromHireHop(false);
    }
  }, [job?.hh_job_number]);

  // Cancelled job → fetch any held excess records so the banner can link
  // straight into a one-click reimburse. Only the records that have actual
  // money sitting with us are useful here (taken / pre_auth / partially_paid);
  // 'needed' / 'pending' rows would dump staff into a payment form, not a
  // refund form. Refreshes after the excess modal closes (onUpdated callback)
  // so the banner clears as records progress to reimbursed/waived.
  const loadCancelledExcessHeld = useCallback(async () => {
    if (!id || job?.pipeline_status !== 'cancelled') {
      setCancelledExcessHeld([]);
      return;
    }
    try {
      const res = await api.get<{ data: Array<{ id: string; excess_amount_taken: number | string; excess_status: string }> }>(`/excess?job_id=${id}&limit=20`);
      const held = (res.data || []).filter(r =>
        ['taken', 'pre_auth', 'partially_paid'].includes(r.excess_status)
      ).map(r => ({
        id: r.id,
        excess_amount_taken: Number(r.excess_amount_taken || 0),
        excess_status: r.excess_status,
      }));
      setCancelledExcessHeld(held);
    } catch (err) {
      console.warn('Failed to load held excess for cancelled job:', err);
    }
  }, [id, job?.pipeline_status]);

  useEffect(() => {
    loadCancelledExcessHeld();
  }, [loadCancelledExcessHeld]);

  async function loadJobOrgs() {
    if (!id) return;
    try {
      const data = await api.get<{ data: typeof jobOrgs }>(`/pipeline/${id}/organisations`);
      setJobOrgs(data.data);
    } catch (err) {
      console.error('Failed to load job organisations:', err);
    }
  }

  async function handleAddJobOrg() {
    if (!jobOrgSelectedOrg || !id) return;
    setJobOrgSaving(true);
    try {
      await api.post(`/pipeline/${id}/organisations`, {
        organisation_id: jobOrgSelectedOrg.id,
        role: jobOrgRole,
      });
      // After adding a band, fetch org graph suggestions
      if (jobOrgRole === 'band') {
        try {
          const suggestions = await api.get<{ data: typeof orgSuggestions }>(`/organisations/${jobOrgSelectedOrg.id}/suggestions`);
          // Filter out orgs already linked to this job
          const linkedIds = new Set(jobOrgs.map(jo => jo.organisation_id));
          linkedIds.add(jobOrgSelectedOrg.id);
          const filtered = suggestions.data.filter(s => !linkedIds.has(s.org_id));
          if (filtered.length > 0) setOrgSuggestions(filtered);
        } catch { /* suggestions are nice-to-have, don't block */ }
      }
      setShowAddJobOrg(false);
      setJobOrgSelectedOrg(null);
      setJobOrgSearch('');
      loadJobOrgs();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to add organisation');
    } finally {
      setJobOrgSaving(false);
    }
  }

  async function acceptOrgSuggestion(suggestion: typeof orgSuggestions[0]) {
    if (!id) return;
    try {
      await api.post(`/pipeline/${id}/organisations`, {
        organisation_id: suggestion.org_id,
        role: suggestion.suggested_role,
      });
      setOrgSuggestions(prev => prev.filter(s => s.org_id !== suggestion.org_id));
      loadJobOrgs();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to add organisation');
    }
  }

  async function handleRemoveJobOrg(linkId: string) {
    if (!id) return;
    try {
      await api.delete(`/pipeline/${id}/organisations/${linkId}`);
      loadJobOrgs();
    } catch (err) {
      console.error('Failed to remove job organisation:', err);
    }
  }

  async function loadInteractions() {
    try {
      const data = await api.get<{ data: Interaction[] }>(`/interactions?job_id=${id}`);
      setInteractions(data.data);
    } catch (err) {
      console.error('Failed to load interactions:', err);
    }
  }

  async function loadVehicleAssignments() {
    if (!id) return;
    setVehicleAssignmentsLoading(true);
    try {
      // Hire-form-driven rows have job_id (OP UUID) set; staff-created
      // allocations from the Allocations page only have hirehop_job_id.
      // Fetch both so we can see staff allocations for sibling-vehicle
      // inference, then dedupe by id.
      const hhJobNum = job?.hh_job_number ?? null;
      const [byJobId, byHhJob] = await Promise.all([
        api.get<{ data: any[] }>(`/assignments?job_id=${id}`),
        hhJobNum
          ? api.get<{ data: any[] }>(`/assignments?hirehop_job_id=${hhJobNum}`)
          : Promise.resolve({ data: [] }),
      ]);
      const merged = new Map<string, any>();
      for (const r of (byJobId.data || [])) merged.set(r.id, r);
      for (const r of (byHhJob.data || [])) {
        if (!merged.has(r.id)) merged.set(r.id, r);
      }
      const allRows = Array.from(merged.values());

      // Build slot → vehicle_id map from staff allocations (no driver_id,
      // no freelancer_person_id, has vehicle_id). Used to infer the van
      // for hire-form rows that haven't been cascade-linked yet.
      const slotVehicleByIndex = new Map<number, string>();
      for (const r of allRows) {
        const idx = r.van_requirement_index ?? 0;
        if (!r.driver_id && !r.freelancer_person_id && r.vehicle_id && !slotVehicleByIndex.has(idx)) {
          slotVehicleByIndex.set(idx, r.vehicle_id);
        }
      }

      // Slot-mode lookup for V&D detection. Staff-allocation rows on V&D
      // slots have no customer driver (and no freelancer attached until
      // soft-book-out), but they ARE the hire — so we surface them as
      // cards. Without this, V&D-mode jobs render "No vehicle assignments
      // yet" forever even after vans are allocated.
      const slots = hhSyncResult?.derivation?.flags?.vehicle_slots || [];
      const slotModeByIndex = new Map<number, 'self_drive' | 'van_and_driver'>();
      for (const s of slots) {
        slotModeByIndex.set(s.slot_index, s.mode);
      }
      const anySlotIsVand = slots.some(s => s.mode === 'van_and_driver');

      // Track which slot indexes already have a human-bearing row, so we
      // don't double up by surfacing the staff-allocation sibling on
      // self-drive jobs that already have a hire-form-driven card.
      const slotsWithHuman = new Set<number>();
      for (const r of allRows) {
        if (r.driver_id || r.freelancer_person_id) {
          slotsWithHuman.add(r.van_requirement_index ?? 0);
        }
      }

      // Display rows: hire-form / freelancer rows always show. Staff-allocation
      // rows surface only when they sit on a V&D slot and have no human
      // sibling — that's the V&D case where the freelancer gets attached at
      // soft-book-out. Self-drive plumbing stays hidden as before.
      const displayRows = allRows.filter((r: any) => {
        if (r.driver_id || r.freelancer_person_id) return true;
        const idx = r.van_requirement_index ?? 0;
        if (slotsWithHuman.has(idx)) return false;
        const slotMode = slotModeByIndex.get(idx);
        if (slotMode === 'van_and_driver') return true;
        // Coarse fallback for jobs where the per-slot map isn't fully
        // populated but the job has at least one V&D slot — still safer
        // than hiding the only row that exists.
        if (anySlotIsVand && r.assignment_type === 'self_drive') return true;
        return false;
      });

      const shaped: VehicleAssignment[] = displayRows.map((r: any) => {
        const idx = r.van_requirement_index ?? 0;
        const inferred = !r.vehicle_id ? (slotVehicleByIndex.get(idx) || null) : null;
        return {
          ...r,
          excess: r.excess_id ? {
            id: r.excess_id,
            excess_status: r.excess_status,
            excess_amount_required: r.excess_amount_required,
            excess_amount_taken: r.excess_amount_taken,
          } : null,
          effective_vehicle_id: r.vehicle_id || inferred,
        };
      });
      setVehicleAssignments(shaped);

      // Also load dispatch check
      const check = await api.get<DispatchCheckResult>(`/assignments/dispatch-check/${id}`);
      setDispatchCheck(check);

      // Cross-job allocation conflicts — surface the amber banner when a van
      // on this job has an overlapping assignment on a different job.
      try {
        const conflictsResp = await api.get<{ data: { conflicts: AllocationConflict[] } }>(
          `/assignments/allocation-conflicts/${id}`
        );
        setAllocationConflicts(conflictsResp.data?.conflicts || []);
      } catch {
        setAllocationConflicts([]);
      }

      // Date mismatch detection — surface "extend assignment to match job?"
      // banner when job_end has shifted past the assignment's locked hire_end.
      try {
        const mismatchResp = await api.get<{ data: { mismatches: DateMismatch[] } }>(
          `/assignments/date-mismatches/${id}`
        );
        setDateMismatches(mismatchResp.data?.mismatches || []);
      } catch {
        setDateMismatches([]);
      }
    } catch {
      console.error('Failed to load vehicle assignments');
    } finally {
      setVehicleAssignmentsLoading(false);
    }
  }

  async function matchAssignmentDatesToJob(assignmentId: string, vehicleReg: string | null) {
    const ok = confirm(
      `Update hire form dates for ${vehicleReg || 'this hire'} to match the job dates?\n\nThis adjusts the hire window. If the new window clashes with another hire on the same van you'll get an error and need to reassign one of them.`
    );
    if (!ok) return;
    try {
      await api.post(`/assignments/${assignmentId}/match-job-dates`, {});
      loadVehicleAssignments();
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to match dates';
      alert(msg);
    }
  }

  async function openExcessModal(excessId: string, initialAction?: 'edit_required' | 'reimburse') {
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

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (!job) {
    return <div className="text-center py-12 text-gray-500">Job not found.</div>;
  }

  // Pipeline or operational status for display
  const OPS_DISPLAY: Record<string, { label: string; colour: string }> = {
    prepping: { label: 'Prepping', colour: '#A78BFA' },
    prepped: { label: 'Prepped', colour: '#8B5CF6' },
    dispatched: { label: 'On Hire', colour: '#6366F1' },
    returned_incomplete: { label: 'Checking In', colour: '#F59E0B' },
    returned: { label: 'Returned', colour: '#8B5CF6' },
    completed: { label: 'Completed', colour: '#059669' },
  };
  const pipelineConfig = job.pipeline_status
    ? (PIPELINE_STATUS_CONFIG[job.pipeline_status as PipelineStatus] || OPS_DISPLAY[job.pipeline_status] || null)
    : null;
  const statusLabel = pipelineConfig?.label || STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`;
  const statusColour = pipelineConfig
    ? '' // Using inline style for pipeline status
    : (STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600');
  const hasPipelineStatus = !!job.pipeline_status;

  // Available pipeline statuses for the dropdown (excluding current).
  // 'chasing' is intentionally absent — it's a derived view (a job with
  // next_chase_date <= today + pre-confirmed status), not a selectable
  // lifecycle status. Use the chase modal to set a chase date instead.
  const ENQUIRY_STATUSES: PipelineStatus[] = ['new_enquiry', 'provisional', 'paused'];
  const PIPELINE_STATUSES: PipelineStatus[] = [...ENQUIRY_STATUSES, 'confirmed', 'lost'];
  const OPERATIONAL_STATUSES: string[] = ['prepping', 'prepped', 'dispatched', 'returned_incomplete', 'returned', 'completed'];
  const isOperational = OPERATIONAL_STATUSES.includes(job.pipeline_status || '');
  const isConfirmed = job.pipeline_status === 'confirmed';
  // After confirmation: show operational progression + enquiry stages (backwards) + cancelled/lost
  // Before confirmation: show pipeline statuses only
  const availableStatuses = isConfirmed || isOperational
    ? [...ENQUIRY_STATUSES, 'confirmed', ...OPERATIONAL_STATUSES, 'cancelled', 'lost'].filter(s => s !== job.pipeline_status)
    : PIPELINE_STATUSES.filter(s => s !== job.pipeline_status);

  // ─── Date-based job alerts ───────────────────────────────────────────────
  // Today as YYYY-MM-DD in local timezone for date-only comparisons.
  const todayLocalISO = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  })();
  const outDay = job.out_date ? toDateInputValue(job.out_date) : null;
  const returnDay = job.return_date ? toDateInputValue(job.return_date) : null;
  const dayMs = 24 * 60 * 60 * 1000;
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / dayMs);

  // Overdue dispatch banner — fires when a confirmed/prepped job hasn't been
  // marked as dispatched by 16:30 on its out date (amber), or by end of out
  // date (red, days-overdue). Hides once status moves to dispatched or beyond.
  const PRE_DISPATCH = ['confirmed', 'prepped'];
  const overdueDispatch: { severity: 'amber' | 'red'; daysOverdue: number; outTime: string | null } | null = (() => {
    if (!outDay || !PRE_DISPATCH.includes(job.pipeline_status || '')) return null;
    if (outDay < todayLocalISO) {
      return { severity: 'red', daysOverdue: daysBetween(todayLocalISO, outDay), outTime: job.out_time };
    }
    if (outDay === todayLocalISO) {
      const now = new Date();
      const cutoff = new Date();
      cutoff.setHours(16, 30, 0, 0);
      if (now >= cutoff) {
        return { severity: 'amber', daysOverdue: 0, outTime: job.out_time };
      }
    }
    return null;
  })();

  // Overdue return — dispatched job past its return_date with no check-in.
  // The kit was due back at the warehouse and isn't (or hasn't been recorded
  // as such). Symmetrical bookend to the overdue dispatch banner.
  const overdueReturn: { daysOverdue: number } | null = (() => {
    if (job.pipeline_status !== 'dispatched') return null;
    if (!returnDay || returnDay >= todayLocalISO) return null;
    return { daysOverdue: daysBetween(todayLocalISO, returnDay) };
  })();

  // Hire form missing close to start — confirmed self-drive job within 5 days
  // of out_date but the hire_forms requirement is still 'not_started'. Auto-
  // emailer fires at 10d + 5d but a visible flag on the job header surfaces
  // it earlier. Only when there's actually a hire_forms requirement (i.e.
  // self-drive vehicles detected on the job).
  const hireFormMissing: { daysToOut: number } | null = (() => {
    if (!['confirmed', 'prepped'].includes(job.pipeline_status || '')) return null;
    if (!outDay) return null;
    if (reqSummary.hireFormsStatus !== 'not_started') return null;
    const daysToOut = daysBetween(outDay, todayLocalISO);
    if (daysToOut < 0 || daysToOut > 5) return null;
    return { daysToOut };
  })();

  // Close-out overdue — job returned more than 7 days ago but post-hire
  // requirements still open (invoice not sent, payment not reconciled,
  // excess unresolved, damage open, etc.).
  const closeOutOverdue: { daysSinceReturn: number; openCount: number } | null = (() => {
    if (job.pipeline_status !== 'returned') return null;
    if (!returnDay) return null;
    const daysSinceReturn = daysBetween(todayLocalISO, returnDay);
    if (daysSinceReturn < 7 || reqSummary.postHireOpenCount === 0) return null;
    return { daysSinceReturn, openCount: reqSummary.postHireOpenCount };
  })();

  // Crew unassigned + Crew not introduced — gate on EACH QUOTE'S OWN date,
  // not the job's overall out_date. A job can have a delivery in 1 day plus
  // a collection in 3 weeks; only the imminent quote should fire the banner.
  // Without per-quote gating the banner fires for the late quote every time
  // the early one approaches, with confusingly job-scoped wording.
  type NudgeQuote = { id: string; daysTo: number; jobDate: string | null; jobType: string | null };
  const formatQuoteDate = (iso: string | null): string => {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const describeQuote = (q: NudgeQuote): string => {
    const type = q.jobType || 'transport';
    const date = formatQuoteDate(q.jobDate);
    if (q.daysTo < 0) return `${type} on ${date} — ${Math.abs(q.daysTo)} day(s) ago`;
    if (q.daysTo === 0) return `${type} today (${date})`;
    if (q.daysTo === 1) return `${type} tomorrow (${date})`;
    return `${type} on ${date} (in ${q.daysTo} days)`;
  };
  const collectImminentQuotes = (predicate: (q: SavedQuote) => boolean, windowDays: number): NudgeQuote[] => {
    const out: NudgeQuote[] = [];
    for (const q of quotes) {
      if (q.status === 'cancelled') continue;
      if (!q.job_date) continue;
      if (!predicate(q)) continue;
      const qDay = q.job_date.slice(0, 10);
      const daysTo = daysBetween(qDay, todayLocalISO);
      if (daysTo > windowDays) continue;
      out.push({ id: q.id, daysTo, jobDate: q.job_date, jobType: q.job_type });
    }
    out.sort((a, b) => a.daysTo - b.daysTo);
    return out;
  };

  const crewUnassigned: { quotes: NudgeQuote[] } | null = (() => {
    if (!['confirmed', 'prepped', 'dispatched'].includes(job.pipeline_status || '')) return null;
    const matches = collectImminentQuotes(
      (q) => !q.assignments || q.assignments.length === 0,
      3,
    );
    return matches.length === 0 ? null : { quotes: matches };
  })();

  const crewNotIntroduced: { quotes: NudgeQuote[] } | null = (() => {
    if (!['confirmed', 'prepped'].includes(job.pipeline_status || '')) return null;
    const matches = collectImminentQuotes((q) => {
      const intro = (q as { client_introduction?: string }).client_introduction;
      return intro === 'todo' || intro === 'working_on_it';
    }, 7);
    return matches.length === 0 ? null : { quotes: matches };
  })();

  // Next-suggested status — the natural progression given dates + current
  // status. Bolded + asterisked in the status dropdown so staff can see at a
  // glance what they're likely about to pick. Pure date-based for v1; data-
  // aware suggestions (prep done → bold prepped, close-out done → bold
  // completed) are deferred until we lift requirements state up.
  const nextSuggestedStatus: string | null = (() => {
    const status = job.pipeline_status;
    if (!status) return null;
    if (['new_enquiry', 'quoting', 'provisional', 'paused'].includes(status)) {
      return 'confirmed';
    }
    if ((status === 'confirmed' || status === 'prepped') && outDay && todayLocalISO >= outDay) {
      return 'dispatched';
    }
    if (status === 'dispatched' && returnDay) {
      const dayBefore = (() => {
        const d = new Date(returnDay + 'T00:00:00');
        d.setDate(d.getDate() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      if (todayLocalISO >= dayBefore) return 'returned';
    }
    if (status === 'returned_incomplete') return 'returned';
    if (status === 'returned') return 'completed';
    return null;
  })();
  // ─────────────────────────────────────────────────────────────────────────

  const fileCount = (job.files || []).length;
  const hhJobUrl = job.hh_job_number
    ? `https://myhirehop.com/job.php?id=${job.hh_job_number}`
    : null;

  const showClientHistory = clientHistoryData && (parseInt(clientHistoryData.stats.total_jobs) > 0 || clientHistoryData.client_info);

  return (
    <div className={showClientHistory ? 'lg:flex lg:gap-6' : ''}>
      <div className={showClientHistory ? 'flex-1 min-w-0' : ''}>
      {/* Back link */}
      <Link to={backTo} className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block">
        &larr; {backLabel}
      </Link>

      {/* Cancelled banner */}
      {job.pipeline_status === 'cancelled' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-sm font-bold text-red-700">
                This job was cancelled{job.cancelled_at ? ` on ${new Date(job.cancelled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                {job.cancellation_reason ? ` — ${job.cancellation_reason}` : ''}
              </p>
              {(job.cancellation_fee != null || job.cancellation_refund != null) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm">
                  {job.cancellation_fee != null && (
                    <span className="text-red-600">
                      Fee retained (ex-VAT): <strong>£{Number(job.cancellation_fee).toFixed(2)}</strong>
                      <span className="text-red-500/80 ml-1">(inc-VAT £{(Number(job.cancellation_fee) * 1.2).toFixed(2)})</span>
                    </span>
                  )}
                  {job.cancellation_refund != null && Number(job.cancellation_refund) > 0 && (
                    <span className="text-green-700">Refund due to client: <strong>£{Number(job.cancellation_refund).toFixed(2)}</strong></span>
                  )}
                </div>
              )}
              {/* One-click into the reimburse modal for any excess still
                  held against this cancelled job. Listed individually so
                  staff can process driver-by-driver without picking from a
                  list inside the modal. */}
              {cancelledExcessHeld.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {cancelledExcessHeld.map(rec => (
                    <button
                      key={rec.id}
                      type="button"
                      onClick={() => openExcessModal(rec.id, 'reimburse')}
                      disabled={excessModalLoadingId === rec.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 rounded-md hover:bg-amber-200 disabled:opacity-50"
                    >
                      {excessModalLoadingId === rec.id
                        ? 'Opening…'
                        : `Process excess refund (£${rec.excess_amount_taken.toFixed(2)})`}
                    </button>
                  ))}
                </div>
              )}
              {job.cancellation_notes && (
                <p className="text-xs text-red-600 mt-1">{job.cancellation_notes}</p>
              )}
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {job.reopened_to_job_id ? (
                <Link
                  to={`/jobs/${job.reopened_to_job_id}`}
                  className="text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 whitespace-nowrap text-center"
                >
                  Already reopened &rarr; View new booking
                </Link>
              ) : (user?.role === 'admin' || user?.role === 'manager') ? (
                <button
                  onClick={async () => {
                    if (!window.confirm('Re-open this cancelled job as a new booking? The original job will stay cancelled for audit purposes.')) return;
                    try {
                      const result = await api.post<{ newJobId: string; message: string }>(`/cancellations/${job.id}/reopen`, {});
                      alert(result.message);
                      navigate(`/jobs/${result.newJobId}`);
                    } catch (err) {
                      console.error('Re-open failed:', err);
                      alert('Failed to re-open job');
                    }
                  }}
                  className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap"
                >
                  Re-open as New Booking
                </button>
              ) : null}
              {/* Fill-a-Gap link — surfaces paused/open enquiries that could
                  take the freed slot. Phase 1 SQL-only; AI rationale + draft
                  emails layer in Phase 2 (pending Claude API key). */}
              <Link
                to={`/operations/fill-gap/${job.id}`}
                className="text-xs px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 whitespace-nowrap text-center"
              >
                Find replacement booking &rarr;
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Lost banner — surfaces the Fill-a-Gap button mostly for the
          provisional → lost case, where a booking we were holding fell
          through. The same button renders for any-status → lost; an
          enquiry that never had capacity allocated will just hit a
          zero-candidate page (cheap). */}
      {job.pipeline_status === 'lost' && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-orange-700">
                This job was marked lost
                {job.lost_at ? ` on ${new Date(job.lost_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                {job.lost_reason ? ` — ${job.lost_reason}` : ''}
              </p>
              {job.lost_detail && (
                <p className="text-xs text-orange-600 mt-1">{job.lost_detail}</p>
              )}
            </div>
            <Link
              to={`/operations/fill-gap/${job.id}`}
              className="text-xs px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 whitespace-nowrap text-center shrink-0"
            >
              Find replacement booking &rarr;
            </Link>
          </div>
        </div>
      )}

      {/* No client email warning — automated emails for this job will be redirected to info@ */}
      {job.has_client_email === false && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-800">
                &#9888; No client email on file
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Automated emails for this job (payment confirmations, excess receipts, etc.) will be redirected to <strong>info@oooshtours.co.uk</strong> with a banner asking the team to forward manually. Add an email to the client organisation or a linked contact to enable direct comms.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              {/* HH Job Number — editable if NEW */}
              {job.hh_job_number ? (
                <a
                  href={hhJobUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline"
                  title="Open in HireHop"
                >
                  #{job.hh_job_number}
                </a>
              ) : editingHHNumber ? (
                <input
                  ref={editHHRef}
                  type="text"
                  value={editHHValue}
                  onChange={(e) => setEditHHValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveEditHHNumber(); if (e.key === 'Escape') setEditingHHNumber(false); }}
                  onBlur={saveEditHHNumber}
                  placeholder="HH number or URL..."
                  className="text-sm font-mono border border-ooosh-300 rounded px-2 py-0.5 w-56 focus:ring-ooosh-500 focus:border-ooosh-500"
                />
              ) : (
                <button
                  onClick={startEditHHNumber}
                  className="text-sm font-mono text-gray-400 hover:text-ooosh-600 hover:bg-ooosh-50 px-2 py-0.5 rounded cursor-pointer transition-colors"
                  title="Click to link HireHop job (accepts number or URL)"
                >
                  NEW
                </button>
              )}

              {/* Create in HireHop button — only when no HH number */}
              {!job.hh_job_number && !editingHHNumber && (
                <button
                  onClick={pushToHireHop}
                  disabled={pushingToHH}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors"
                >
                  {pushingToHH ? (
                    <>Creating...</>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Create in HireHop
                    </>
                  )}
                </button>
              )}

              {/* Pipeline status dropdown */}
              {hasPipelineStatus ? (
                <div ref={statusDropdownRef} className="relative">
                  <button
                    onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-semibold cursor-pointer hover:opacity-80 transition-opacity"
                    style={{
                      backgroundColor: pipelineConfig!.colour + '20',
                      color: pipelineConfig!.colour,
                    }}
                    title="Click to change status"
                  >
                    {statusLabel}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showStatusDropdown && (
                    <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px]">
                      {availableStatuses.map((s) => {
                        const OPS_CONFIG: Record<string, { label: string; colour: string }> = {
                          prepping: { label: 'Prepping', colour: '#A78BFA' },
                          prepped: { label: 'Prepped', colour: '#8B5CF6' },
                          dispatched: { label: 'Dispatched', colour: '#6366F1' },
                          returned_incomplete: { label: 'Checking In', colour: '#F59E0B' },
                          returned: { label: 'Returned', colour: '#8B5CF6' },
                          completed: { label: 'Completed', colour: '#059669' },
                        };
                        const cfg = PIPELINE_STATUS_CONFIG[s as PipelineStatus] || OPS_CONFIG[s];
                        if (!cfg) return null;
                        const isNext = s === nextSuggestedStatus;
                        return (
                          <button
                            key={s}
                            onClick={() => initiateStatusChange(s as PipelineStatus)}
                            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2 ${isNext ? 'font-bold' : ''}`}
                            title={isNext ? 'Suggested next step based on dates' : undefined}
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: cfg.colour }}
                            />
                            {cfg.label}{isNext ? ' *' : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <span className={`inline-flex px-3.5 py-1.5 rounded-md text-sm font-semibold ${statusColour}`}>
                  {statusLabel}
                </span>
              )}
              {job.is_internal && (
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-200 text-gray-600">Internal</span>
              )}
            </div>

            {/* Job Name — inline editable */}
            {editingName ? (
              <input
                ref={editNameRef}
                type="text"
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEditName(); if (e.key === 'Escape') { setEditingName(false); } }}
                onBlur={saveEditName}
                className="text-lg sm:text-2xl font-bold text-gray-900 mt-2 w-full border-b-2 border-ooosh-400 bg-transparent outline-none px-0 py-0.5"
              />
            ) : (
              <h1
                className="text-lg sm:text-2xl font-bold text-gray-900 mt-2 cursor-pointer hover:bg-gray-50 rounded px-1 -ml-1 transition-colors group"
                onClick={startEditName}
                title="Click to edit job name"
              >
                {job.job_name || 'Untitled Job'}
                <svg className="w-4 h-4 inline-block ml-2 text-gray-300 group-hover:text-gray-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </h1>
            )}

            {/* Client, Venue, Dates summary row */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-gray-600 items-center">
              {/* Client headline — prefer band → linked client org → company → client_name
                  Contact person surfaced separately when HH CONTACT differs from HH COMPANY */}
              <div className="relative inline-flex items-center gap-1" ref={clientSearchRef}>
                {(() => {
                  const bandOrg = jobOrgs.find(jo => jo.role === 'band');
                  const hasClient = !!(job.client_name || job.company_name);
                  if (!bandOrg && !hasClient) {
                    return (
                      <button
                        onClick={startEditClient}
                        className="text-gray-400 hover:text-ooosh-600 transition-colors text-xs border border-dashed border-gray-300 px-2 py-0.5 rounded"
                      >
                        + Add client
                      </button>
                    );
                  }
                  const headlineText = bandOrg?.organisation_name
                    || job.company_name
                    || job.client_name;
                  const headlineLinkId = bandOrg?.organisation_id || job.client_id;
                  return (
                    <>
                      {headlineLinkId ? (
                        <Link to={`/organisations/${headlineLinkId}`} className="text-ooosh-600 hover:text-ooosh-700">
                          {headlineText}
                        </Link>
                      ) : (
                        <span>{headlineText}</span>
                      )}
                      {bandOrg && (
                        <span className="text-xs text-purple-500 font-medium">(Band)</span>
                      )}
                      <button
                        onClick={startEditClient}
                        className="text-gray-300 hover:text-gray-500 transition-colors"
                        title="Change client"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    </>
                  );
                })()}
                {editingClient && (
                  <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg w-64">
                    <input
                      type="text"
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                      placeholder="Search organisations..."
                      className="w-full border-b border-gray-200 px-3 py-2 text-sm focus:ring-0 focus:outline-none rounded-t-lg"
                      autoFocus
                    />
                    {clientSearchResults.length > 0 && (
                      <div className="max-h-48 overflow-y-auto">
                        {clientSearchResults.map((o) => (
                          <button
                            key={o.id}
                            onClick={() => selectClient(o)}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm flex items-center gap-2 border-b border-gray-50 last:border-b-0"
                          >
                            <span className="font-medium">{o.name}</span>
                            <span className="text-gray-400 text-xs">{o.type}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {clientSearch.length >= 2 && clientSearchResults.length === 0 && (
                      <div className="px-3 py-2 text-sm text-gray-400">No results</div>
                    )}
                  </div>
                )}
              </div>
              {/* Billed to sub-line (when Band takes top slot) */}
              {(() => {
                const bandOrg = jobOrgs.find(jo => jo.role === 'band');
                if (!bandOrg) return null;
                const billedToText = job.company_name || job.client_name;
                if (!billedToText) return null;
                return (
                  <span className="text-xs text-gray-500">
                    Billed to:{' '}
                    {job.client_id ? (
                      <Link to={`/organisations/${job.client_id}`} className="text-gray-600 hover:text-ooosh-600 underline decoration-dotted">
                        {billedToText}
                      </Link>
                    ) : (
                      <span className="text-gray-600">{billedToText}</span>
                    )}
                  </span>
                );
              })()}
              {/* Contact pill (HH CONTACT differs from HH COMPANY → person contact) */}
              {(() => {
                const bandOrg = jobOrgs.find(jo => jo.role === 'band');
                if (bandOrg) return null;
                if (!job.company_name || !job.client_name) return null;
                if (job.client_name === job.company_name) return null;
                return (
                  <span className="text-xs text-gray-500">
                    Contact: <span className="text-gray-700">{job.client_name}</span>
                  </span>
                );
              })()}

              {/* Venue */}
              {job.venue_name && (
                <span>
                  {job.venue_id ? (
                    <Link to={`/venues/${job.venue_id}`} className="text-ooosh-600 hover:text-ooosh-700">
                      {job.venue_name}
                    </Link>
                  ) : (
                    job.venue_name
                  )}
                </span>
              )}

              {/* Dates summary + edit button */}
              {(job.out_date || job.job_date || job.job_end || job.return_date) && (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {formatDate(job.job_date || job.out_date)}
                  {job.out_time && (
                    <span className="text-blue-500 text-xs ml-0.5">{job.out_time.slice(0, 5)}</span>
                  )}
                  {(job.job_end || job.return_date) && job.job_end !== job.job_date && (
                    <> &ndash; {formatDate(job.job_end || job.return_date)}
                    {job.return_time && (
                      <span className="text-teal-500 text-xs ml-0.5">{job.return_time.slice(0, 5)}</span>
                    )}
                    </>
                  )}
                  {job.end_time && job.end_time !== job.return_time && (
                    <span className="text-purple-500 text-xs ml-1">ends {job.end_time.slice(0, 5)}</span>
                  )}
                  <button
                    onClick={startEditDates}
                    className="text-gray-300 hover:text-gray-500 transition-colors ml-0.5"
                    title="Edit dates & times"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                </span>
              )}
              {!job.out_date && !job.job_date && !job.job_end && !job.return_date && (
                <button
                  onClick={startEditDates}
                  className="text-gray-400 hover:text-ooosh-600 transition-colors text-xs border border-dashed border-gray-300 px-2 py-0.5 rounded"
                >
                  + Add dates
                </button>
              )}
            </div>

            {/* HireHop client sync banner */}
            {hhClientOutOfSync && (
              <div className="mt-2 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span className="text-amber-800">
                  Client changed to <strong>{hhClientSyncName}</strong> — HireHop still shows the old client. Sync now?
                </span>
                <button
                  onClick={syncClientToHH}
                  disabled={syncingClientToHH}
                  className="ml-auto px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                >
                  {syncingClientToHH ? 'Syncing...' : 'Sync to HireHop'}
                </button>
                <button
                  onClick={() => setHhClientOutOfSync(false)}
                  className="text-amber-600 hover:text-amber-800 text-xs underline"
                >
                  Dismiss
                </button>
              </div>
            )}
            {hhClientSyncSuccess && (
              <div className="mt-2 flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Client synced to HireHop successfully.
              </div>
            )}

            {/* Date/data-driven job alert banners */}
            {overdueDispatch && (
              <JobAlertBanner
                severity={overdueDispatch.severity}
                message={
                  overdueDispatch.severity === 'red'
                    ? `Booked to go out ${overdueDispatch.daysOverdue} ${
                        overdueDispatch.daysOverdue === 1 ? 'day' : 'days'
                      } ago — not yet marked as Dispatched.`
                    : `Booked to go out today${
                        overdueDispatch.outTime ? ` at ${overdueDispatch.outTime.slice(0, 5)}` : ''
                      } — not yet marked as Dispatched.`
                }
                action={{
                  label: 'Mark as Dispatched',
                  onClick: () => initiateStatusChange('dispatched' as PipelineStatus),
                }}
              />
            )}
            {overdueReturn && (
              <JobAlertBanner
                severity="red"
                message={`Booked back ${overdueReturn.daysOverdue} ${
                  overdueReturn.daysOverdue === 1 ? 'day' : 'days'
                } ago — not yet checked in.`}
                action={{
                  label: 'Mark as Checking In',
                  onClick: () => initiateStatusChange('returned_incomplete' as PipelineStatus),
                }}
              />
            )}
            {hireFormMissing && (
              <JobAlertBanner
                severity="amber"
                message={
                  hireFormMissing.daysToOut === 0
                    ? 'Self-drive hire goes out today — no hire form sent yet.'
                    : `Self-drive hire goes out in ${hireFormMissing.daysToOut} ${
                        hireFormMissing.daysToOut === 1 ? 'day' : 'days'
                      } — no hire form sent yet.`
                }
                action={{
                  label: 'View Job Requirements',
                  onClick: () => setActiveTab('overview'),
                }}
              />
            )}
            {crewUnassigned && (
              <JobAlertBanner
                severity="amber"
                message={
                  crewUnassigned.quotes.length === 1
                    ? `Crew unassigned for ${describeQuote(crewUnassigned.quotes[0])}.`
                    : `Crew unassigned for ${crewUnassigned.quotes.length} transport/crew jobs — soonest: ${describeQuote(crewUnassigned.quotes[0])}.`
                }
                action={{
                  label: 'View Crew & Transport',
                  onClick: () => setActiveTab('transport'),
                }}
              />
            )}
            {crewNotIntroduced && (
              <JobAlertBanner
                severity="amber"
                message={
                  crewNotIntroduced.quotes.length === 1
                    ? `Client not yet introduced for ${describeQuote(crewNotIntroduced.quotes[0])}.`
                    : `Client not yet introduced for ${crewNotIntroduced.quotes.length} transport/crew jobs — soonest: ${describeQuote(crewNotIntroduced.quotes[0])}.`
                }
                action={{
                  label: 'View Crew & Transport',
                  onClick: () => setActiveTab('transport'),
                }}
              />
            )}
            {closeOutOverdue && (
              <JobAlertBanner
                severity="amber"
                message={`Returned ${closeOutOverdue.daysSinceReturn} days ago, ${
                  closeOutOverdue.openCount
                } close-out item${closeOutOverdue.openCount === 1 ? '' : 's'} still open.`}
                action={{
                  label: 'View Close-Out Items',
                  onClick: () => setActiveTab('overview'),
                }}
              />
            )}

            {/* HireHop status mismatch banner */}
            {hhStatusMismatch && (
              <div className="mt-2 flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
                <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span className="text-red-800">
                  Status mismatch — OP shows <strong>{PIPELINE_STATUS_CONFIG[hhStatusMismatch.op_status as PipelineStatus]?.label || hhStatusMismatch.op_status}</strong> but HireHop shows <strong>{hhStatusMismatch.hh_status_name}</strong>
                </span>
                <button
                  onClick={pushStatusToHH}
                  disabled={pushingStatusToHH}
                  className="ml-auto px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {pushingStatusToHH ? 'Pushing...' : 'Push OP status to HireHop'}
                </button>
                <button
                  onClick={() => setHhStatusMismatch(null)}
                  className="text-red-600 hover:text-red-800 text-xs underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* HireHop dates sync banner */}
            {hhDatesOutOfSync && (
              <div className="mt-2 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span className="text-amber-800">
                  Dates updated — also update on HireHop?
                </span>
                <button
                  onClick={syncDatesToHH}
                  disabled={syncingDatesToHH}
                  className="ml-auto px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                >
                  {syncingDatesToHH ? 'Syncing...' : 'Sync to HireHop'}
                </button>
                <button
                  onClick={() => setHhDatesOutOfSync(false)}
                  className="text-amber-600 hover:text-amber-800 text-xs underline"
                >
                  Dismiss
                </button>
              </div>
            )}
            {hhDatesSyncSuccess && (
              <div className="mt-2 flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Dates synced to HireHop successfully.
              </div>
            )}

            {/* Dates editor panel */}
            {editingDates && (
              <div className="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Outgoing</label>
                    <DatePicker
                      value={editOutDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleEditOutDate(val)}
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Job Start</label>
                    <DatePicker
                      value={editJobDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleEditJobDate(val)}
                    />
                    <button
                      onClick={() => { if (!dateOutLinked) setEditOutDate(editJobDate); setDateOutLinked(!dateOutLinked); }}
                      className={`absolute -left-4 top-8 w-4 text-center text-xs ${dateOutLinked ? 'text-ooosh-600' : 'text-gray-300 hover:text-gray-500'}`}
                      title={dateOutLinked ? 'Linked to Outgoing (click to unlink)' : 'Click to link to Outgoing'}
                    >
                      {dateOutLinked ? (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" /></svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" /></svg>
                      )}
                    </button>
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Job End</label>
                    <DatePicker
                      value={editJobEnd}
                      min={editJobDate || new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleEditJobEnd(val)}
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Returning</label>
                    <DatePicker
                      value={editReturnDate}
                      min={editJobEnd || new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleEditReturnDate(val)}
                    />
                    <button
                      onClick={() => { if (!dateReturnLinked) setEditReturnDate(editJobEnd); setDateReturnLinked(!dateReturnLinked); }}
                      className={`absolute -left-4 top-8 w-4 text-center text-xs ${dateReturnLinked ? 'text-ooosh-600' : 'text-gray-300 hover:text-gray-500'}`}
                      title={dateReturnLinked ? 'Linked to Job End (click to unlink)' : 'Click to link to Job End'}
                    >
                      {dateReturnLinked ? (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" /></svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" /></svg>
                      )}
                    </button>
                  </div>
                </div>
                {/* Time inputs row — four times mirror the four dates above.
                    Start Time is linked to Out Time by default; Return Time
                    is linked to End Time by default. Click chain icon to
                    unlink and edit independently. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Out Time</label>
                    <TimeInput
                      value={editOutTime}
                      onChange={(v) => {
                        setEditOutTime(v);
                        if (outTimeLinked) setEditStartTime(v);
                      }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500"
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Start Time</label>
                    <TimeInput
                      value={editStartTime}
                      disabled={outTimeLinked}
                      onChange={(v) => setEditStartTime(v)}
                      className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500 ${outTimeLinked ? 'bg-gray-50 text-gray-400' : ''}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (outTimeLinked) {
                          // unlinking — keep current value, just unlock
                          setOutTimeLinked(false);
                        } else {
                          // re-linking — sync Start Time back to Out Time
                          setEditStartTime(editOutTime);
                          setOutTimeLinked(true);
                        }
                      }}
                      className={`absolute -left-4 top-8 w-4 text-center text-xs ${outTimeLinked ? 'text-ooosh-600' : 'text-gray-300 hover:text-gray-500'}`}
                      title={outTimeLinked ? 'Linked to Out Time (click to unlink)' : 'Click to link to Out Time'}
                    >
                      {outTimeLinked ? (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" /></svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" /></svg>
                      )}
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">End Time</label>
                    <TimeInput
                      value={editEndTime}
                      onChange={(v) => {
                        setEditEndTime(v);
                        if (endTimeLinked) setEditReturnTime(v);
                      }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500"
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Return Time</label>
                    <TimeInput
                      value={editReturnTime}
                      disabled={endTimeLinked}
                      onChange={(v) => setEditReturnTime(v)}
                      className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500 ${endTimeLinked ? 'bg-gray-50 text-gray-400' : ''}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (endTimeLinked) {
                          setEndTimeLinked(false);
                        } else {
                          setEditReturnTime(editEndTime);
                          setEndTimeLinked(true);
                        }
                      }}
                      className={`absolute -left-4 top-8 w-4 text-center text-xs ${endTimeLinked ? 'text-ooosh-600' : 'text-gray-300 hover:text-gray-500'}`}
                      title={endTimeLinked ? 'Linked to End Time (click to unlink)' : 'Click to link to End Time'}
                    >
                      {endTimeLinked ? (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" /></svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" /></svg>
                      )}
                    </button>
                  </div>
                </div>
                {editJobDate && editJobEnd && (() => {
                  const start = new Date(editJobDate);
                  const end = new Date(editJobEnd);
                  const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                  return days > 0 ? <p className="text-xs text-gray-500 font-medium mt-1">{days} day{days !== 1 ? 's' : ''}</p> : null;
                })()}
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={saveDates}
                    disabled={inlineEditSaving}
                    className="px-3 py-1.5 text-xs font-medium bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                  >
                    {inlineEditSaving ? 'Saving...' : 'Save dates'}
                  </button>
                  <button
                    onClick={() => setEditingDates(false)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Pipeline fields row: Likelihood, Next Chase, Value */}
            {hasPipelineStatus && !isConfirmed && !isOperational && job.pipeline_status !== 'lost' && job.pipeline_status !== 'cancelled' && (
              <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-gray-100">
                {/* Likelihood */}
                <button
                  onClick={cycleLikelihood}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                    job.likelihood === 'hot'
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : job.likelihood === 'warm'
                      ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                      : job.likelihood === 'cold'
                      ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                  title="Click to cycle likelihood: hot / warm / cold"
                >
                  {job.likelihood === 'hot' && (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clipRule="evenodd" /></svg>
                  )}
                  {job.likelihood ? (job.likelihood.charAt(0).toUpperCase() + job.likelihood.slice(1)) : 'Set likelihood'}
                </button>

                {/* Next Chase Date — opens full chase modal (hidden for lost/operational statuses) */}
                {!isOperational && job.pipeline_status !== 'lost' && (
                <div className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <button
                    onClick={() => setShowChaseModal(true)}
                    className={`hover:text-ooosh-600 transition-colors ${
                      job.next_chase_date && new Date(job.next_chase_date) < new Date() ? 'text-red-600 font-semibold' : ''
                    }`}
                    title="Log chase"
                  >
                    {job.next_chase_date
                      ? `Chase: ${formatDate(job.next_chase_date)}`
                      : 'Log chase'}
                  </button>
                </div>
                )}

                {inlineEditSaving && (
                  <span className="text-xs text-gray-400 animate-pulse">Saving...</span>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0 max-w-full">
            <div className="flex items-center gap-2">
              {job.hh_job_number && (
                <button
                  onClick={() => syncFromHireHop(true)}
                  disabled={hhSyncing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs sm:text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 disabled:opacity-50 transition-colors"
                  title={hhLastSynced ? `Last synced: ${new Date(hhLastSynced).toLocaleTimeString()}` : 'Sync items from HireHop'}
                >
                  <svg className={`w-3.5 h-3.5 ${hhSyncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="hidden sm:inline">{hhSyncing ? 'Syncing...' : 'Sync HH'}</span>
                </button>
              )}
              {hhJobUrl && (
                <a
                  href={hhJobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600"
                >
                  Open in HireHop &rarr;
                </a>
              )}
            </div>
            {/* Pre-Hire Review — manual send to info@. Admin/manager only.
                 Visibility whitelist: confirmed / prepping / prepped only.
                 Provisional and earlier: review isn't meaningful yet.
                 Dispatched (on hire) onwards: the hire's gone, review's done.
                 The same content goes out automatically via the daily
                 09:55 cron for confirmed jobs at T-3d / T-5d / T-1d.
                 Visual state: faded grey when a recent send exists (within
                 the last 24h) so staff can see at-a-glance it's been
                 actioned. Still clickable — sometimes you want to resend.
                 Sits on its own row beneath Sync HH / Open in HireHop so
                 the optional "· last sent X" subtitle can't squash the
                 job title on the left. */}
            {(user?.role === 'admin' || user?.role === 'manager')
              && (job.pipeline_status === 'confirmed'
                  || job.pipeline_status === 'prepping'
                  || job.pipeline_status === 'prepped') && (() => {
                const sentRecently = briefingLastSent
                  && (Date.now() - new Date(briefingLastSent.sent_at).getTime()) < 24 * 60 * 60_000;
                return (
                  <button
                    onClick={sendPreHireBriefing}
                    disabled={briefingSending}
                    className={
                      sentRecently
                        ? "hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 text-sm border border-gray-200 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-50 transition-colors"
                        : "hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 text-sm border border-purple-300 rounded-lg hover:bg-purple-50 text-purple-700 disabled:opacity-50 transition-colors"
                    }
                    title={
                      briefingLastSent
                        ? `Last sent ${formatBriefingLastSent()}${briefingLastSent.sent_by_name ? ` by ${briefingLastSent.sent_by_name}` : briefingLastSent.trigger === 'scheduled' ? ' by scheduler' : ''}. Click to send again.`
                        : 'Send a pre-hire review email for this job to info@oooshtours.co.uk now'
                    }
                  >
                    {briefingSending
                      ? 'Sending…'
                      : sentRecently
                        ? <>✓ Pre-Hire Review <span className="text-gray-400 text-xs ml-1">· sent {formatBriefingLastSent()}</span></>
                        : briefingLastSent
                          ? <>✉ Pre-Hire Review <span className="text-purple-400 text-xs ml-1">· last sent {formatBriefingLastSent()}</span></>
                          : '✉ Pre-Hire Review'}
                  </button>
                );
              })()}
          </div>
        </div>

        {/* Tags */}
        {job.tags && job.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {job.tags.map((tag) => (
              <span key={tag} className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Linked Organisations (Band, Promoter, etc.) */}
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Organisations:</span>
            {jobOrgs.map((jo) => {
              const roleColors: Record<string, string> = {
                band: 'bg-purple-100 text-purple-700 border-purple-200',
                client: 'bg-blue-100 text-blue-700 border-blue-200',
                promoter: 'bg-red-100 text-red-700 border-red-200',
                management: 'bg-sky-100 text-sky-700 border-sky-200',
                label: 'bg-green-100 text-green-700 border-green-200',
                venue_operator: 'bg-teal-100 text-teal-700 border-teal-200',
                supplier: 'bg-gray-100 text-gray-700 border-gray-200',
              };
              return (
                <span key={jo.id} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${roleColors[jo.role] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                  <span className="opacity-70 capitalize">{jo.role.replace('_', ' ')}:</span>
                  <Link to={`/organisations/${jo.organisation_id}`} className="hover:underline font-semibold">
                    {jo.organisation_name}
                  </Link>
                  <button
                    onClick={() => handleRemoveJobOrg(jo.id)}
                    className="ml-0.5 opacity-40 hover:opacity-100 transition-opacity"
                    title="Remove"
                  >
                    &times;
                  </button>
                </span>
              );
            })}
            {!showAddJobOrg ? (
              <button
                onClick={() => { setShowAddJobOrg(true); setJobOrgSelectedOrg(null); setJobOrgSearch(''); }}
                className="inline-flex items-center px-2 py-1 text-xs text-gray-500 hover:text-ooosh-600 hover:bg-gray-50 rounded border border-dashed border-gray-300 transition-colors"
              >
                + Add
              </button>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {!jobOrgSelectedOrg ? (
                  <div className="relative">
                    <input
                      type="text"
                      value={jobOrgSearch}
                      onChange={(e) => setJobOrgSearch(e.target.value)}
                      placeholder="Search organisations..."
                      className="border border-gray-300 rounded px-2 py-1 text-xs w-48 focus:ring-ooosh-500 focus:border-ooosh-500"
                      autoFocus
                    />
                    {jobOrgResults.length > 0 && (
                      <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-64 max-h-48 overflow-y-auto">
                        {jobOrgResults.map((o) => (
                          <button
                            key={o.id}
                            onClick={() => { setJobOrgSelectedOrg(o); setJobOrgResults([]); }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 text-xs flex items-center gap-2 border-b border-gray-50 last:border-b-0"
                          >
                            <span className="font-medium">{o.name}</span>
                            <span className="text-gray-400">{o.type}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <span className="text-xs font-medium text-gray-900 bg-gray-100 px-2 py-1 rounded">
                      {jobOrgSelectedOrg.name}
                    </span>
                    <select
                      value={jobOrgRole}
                      onChange={(e) => setJobOrgRole(e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1 text-xs"
                    >
                      <option value="band">Band</option>
                      <option value="client">Client</option>
                      <option value="promoter">Promoter</option>
                      <option value="management">Management</option>
                      <option value="label">Label</option>
                      <option value="venue_operator">Venue Operator</option>
                      <option value="supplier">Supplier</option>
                      <option value="other">Other</option>
                    </select>
                    <button
                      onClick={handleAddJobOrg}
                      disabled={jobOrgSaving}
                      className="px-2 py-1 text-xs bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                    >
                      {jobOrgSaving ? '...' : 'Add'}
                    </button>
                  </>
                )}
                <button
                  onClick={() => { setShowAddJobOrg(false); setJobOrgSelectedOrg(null); setJobOrgSearch(''); }}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {/* Smart suggestions from org graph */}
          {orgSuggestions.length > 0 && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-amber-600 font-medium">Suggested:</span>
              {orgSuggestions.map(s => (
                <button
                  key={s.org_id}
                  onClick={() => acceptOrgSuggestion(s)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                  title={`Add as ${s.suggested_role} (${s.relationship_type.replace('_', ' ')} relationship)`}
                >
                  + {s.org_name} <span className="opacity-60">as {s.suggested_role}</span>
                </button>
              ))}
              <button
                onClick={() => setOrgSuggestions([])}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Collapsible Details & Notes */}
        <div ref={detailsNotesRef} className="mt-3 pt-3 border-t border-gray-100">
          <button
            onClick={() => setShowDetailsNotes(!showDetailsNotes)}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors w-full text-left"
          >
            <svg className={`w-3.5 h-3.5 transition-transform flex-shrink-0 ${showDetailsNotes ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Details & Notes
          </button>
          {/* Collapsed snippets */}
          {!showDetailsNotes && (job.details || job.notes) && (
            <div
              onClick={() => setShowDetailsNotes(true)}
              className="mt-1.5 ml-5 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1 transition-colors"
            >
              {job.details && (
                <p className="text-xs text-gray-400 truncate"><span className="font-medium text-gray-500">Details:</span> {job.details}</p>
              )}
              {job.notes && (
                <p className="text-xs text-gray-400 truncate"><span className="font-medium text-gray-500">Notes:</span> {job.notes}</p>
              )}
            </div>
          )}
          {showDetailsNotes && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Details</label>
                <EditableTextArea
                  value={job.details || ''}
                  placeholder="What do they want / what is it?"
                  onSave={(val) => saveInlineField({ details: val || null })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Notes</label>
                <EditableTextArea
                  value={job.notes || ''}
                  placeholder="Internal notes..."
                  onSave={(val) => saveInlineField({ notes: val || null })}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto scrollbar-hide">
        <nav className="flex gap-4 sm:gap-6 min-w-max">
          {(['overview', 'timeline', 'transport', 'drivers', 'money', 'files'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'overview' ? 'Overview' :
               tab === 'timeline' ? (<><span className="sm:hidden">Timeline</span><span className="hidden sm:inline">Activity Timeline</span></>) :
               tab === 'transport' ? (<><span className="sm:hidden">Transport{(() => { const active = quotes.filter(q => q.status !== 'cancelled').length; return active > 0 ? ` (${active})` : ''; })()}</span><span className="hidden sm:inline">Crew & Transport{(() => { const active = quotes.filter(q => q.status !== 'cancelled').length; return active > 0 ? ` (${active})` : ''; })()}</span></>) :
               tab === 'drivers' ? (<><span className="sm:hidden">Drivers{vehicleAssignments.length > 0 ? ` (${vehicleAssignments.length})` : ''}</span><span className="hidden sm:inline">Drivers & Vehicles{vehicleAssignments.length > 0 ? ` (${vehicleAssignments.length})` : ''}</span></>) :
               tab === 'money' ? 'Money' :
               `Files${fileCount > 0 ? ` (${fileCount})` : ''}`}
            </button>
          ))}
        </nav>
      </div>

      {/* Overview Tab (Prep Checklist + Financial Strip + Notes) */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Compact financial progress strip */}
          {id && <OverviewFinancialStrip jobId={id} />}

          {/* Problems / Issues register — cross-module damage / missing /
              broken / dispute / other tracking. Hidden when empty so it
              doesn't clutter clean jobs; "+ Log Problem" button sits inside. */}
          {id && <JobProblemsPanel jobId={id} />}

          <JobPrepChecklist
            key={prepChecklistKey}
            jobId={id || ''}
            hhJobNumber={job.hh_job_number}
            pipelineStatus={job.pipeline_status}
            derivedFlags={hhSyncResult?.derivation?.flags || null}
            seatAvailability={hhSyncResult?.derivation?.seatAvailability || null}
            hasCrewQuotes={quotes.some(q => (q.job_type === 'crewed' || (q.assignments && q.assignments.length > 0)) && q.status !== 'cancelled')}
            hasCrewOnHH={hhSyncResult?.derivation?.flags?.has_crew_items || false}
            onOpenCrewCalculator={() => { setShowCalculator(true); setActiveTab('transport'); }}
          />

        </div>
      )}

      {/* Timeline Tab */}
      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="job_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={() => { loadInteractions(); setPrepChecklistKey(k => k + 1); }}
        />
      )}

      {/* Drivers & Vehicles Tab */}
      {activeTab === 'drivers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Drivers & Vehicles</h3>
            {/* Manual driver add — ADMIN ONLY now (was admin/manager). The
                primary path is the hire form URL (auto-emailed + manually
                chase-able from the Job Requirements vehicle card). This
                fallback exists for genuine "someone slipped through" edge
                cases where admin needs to backfill — and was previously
                being misused by managers, leading to duplicate assignments
                + £0 not_required excess records via top-N rule. Tightening
                visibility instead of weakening dedup. Backend dedup at
                /quick-assign also rejects with 409 for the same driver+job. */}
            {id && user?.role === 'admin' && (
              <QuickAssignButton
                jobId={id}
                jobDate={job.job_date || undefined}
                jobEnd={job.job_end || undefined}
                onCreated={loadVehicleAssignments}
                subtle
              />
            )}
          </div>

          {/* Hire date drift — job dates moved post-book-out, hire form dates disagree */}
          {dateMismatches.filter(m => !dismissedMismatches.has(m.assignmentId)).length > 0 && (
            <div className="space-y-2">
              {dateMismatches.filter(m => !dismissedMismatches.has(m.assignmentId)).map((m) => {
                const reg = m.vehicleReg || 'this hire';
                const drv = m.driverName ? ` (${m.driverName})` : '';
                const headline =
                  m.kind === 'extension'
                    ? `Job extended to ${m.jobEnd}, but hire form for ${reg}${drv} ends ${m.assignmentEnd}.`
                    : m.kind === 'shortening'
                      ? `Job shortened to ${m.jobEnd}, but hire form for ${reg}${drv} ends ${m.assignmentEnd}.`
                      : `Hire form start for ${reg}${drv} (${m.assignmentStart}) no longer matches job start (${m.jobStart}).`;
                const action =
                  m.kind === 'extension' ? 'Extend hire form'
                  : m.kind === 'shortening' ? 'Shorten hire form'
                  : 'Match job dates';
                return (
                  <div
                    key={m.assignmentId}
                    className="flex flex-wrap items-center gap-2 px-4 py-3 rounded-lg text-sm bg-amber-50 border border-amber-200 text-amber-900"
                  >
                    <span aria-hidden>📅</span>
                    <span className="flex-1">{headline}</span>
                    <button
                      type="button"
                      onClick={() => matchAssignmentDatesToJob(m.assignmentId, m.vehicleReg)}
                      className="px-3 py-1 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-900 text-xs font-medium border border-amber-300"
                    >
                      {action}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedMismatches(s => new Set(s).add(m.assignmentId))}
                      title="Hide this warning until next refresh"
                      className="px-2 py-1 rounded-md hover:bg-amber-100 text-amber-700 text-xs"
                      aria-label="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Allocation overlap warnings — van committed to another hire on overlapping dates */}
          {allocationConflicts.length > 0 && (
            <div className="space-y-2">
              {allocationConflicts.map((c) => {
                const reg = c.vehicleReg || 'Van';
                const otherJob = c.conflict.hhJobNumber
                  ? `job #${c.conflict.hhJobNumber}`
                  : c.conflict.jobName || 'another hire';
                const window =
                  c.conflict.effectiveStart && c.conflict.effectiveEnd
                    ? `${c.conflict.effectiveStart} → ${c.conflict.effectiveEnd}`
                    : 'overlapping dates';
                return (
                  <div
                    key={c.assignmentId}
                    className="flex items-start gap-2 px-4 py-3 rounded-lg text-sm bg-amber-50 border border-amber-200 text-amber-900"
                  >
                    <span aria-hidden>⚠️</span>
                    <span>
                      <strong>{reg}</strong> is also allocated to <strong>{otherJob}</strong> ({window}).
                      {' '}Dates overlap — reassign one of the hires.
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Referral warnings */}
          {dispatchCheck && dispatchCheck.blockers.filter(b => b.type === 'referral_pending').length > 0 && (
            <div className="space-y-2">
              {dispatchCheck.blockers.filter(b => b.type === 'referral_pending').map((b, i) => (
                <div key={i} className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-orange-50 border border-orange-200 text-orange-800">
                  <span>!</span>
                  <span>
                    Referral pending for {b.driverName || 'Unknown driver'} ({b.vehicleReg || '?'}) — cannot book out until approved
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Excess gate banner */}
          {dispatchCheck && dispatchCheck.blockers.filter(b => b.type === 'excess_pending').length > 0 && (
            <ExcessGateBanner
              blockers={dispatchCheck.blockers.filter(b => b.type === 'excess_pending').map(b => ({
                ...b,
                excessId: vehicleAssignments.find(a => a.id === b.assignmentId)?.excess?.id,
                excessStatus: vehicleAssignments.find(a => a.id === b.assignmentId)?.excess?.excess_status,
                dispatchOverride: false,
              }))}
              onOverrideComplete={loadVehicleAssignments}
              onNavigateToRequirements={() => setActiveTab('overview')}
              clientId={job?.client_id || undefined}
            />
          )}

          {vehicleAssignmentsLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
            </div>
          ) : vehicleAssignments.length === 0 ? (
            (() => {
              // For self-drive jobs, an assignment row is created automatically
              // when the customer submits a hire form — the empty state is the
              // expected pre-arrival state. For V&D jobs no hire form ever
              // lands, so the row only exists once staff allocates a van. In
              // both cases an "Allocate Van" deep-link gives staff a way to
              // seed the row from Job Detail (V&D) or pre-allocate early
              // (self-drive). Only render when the job actually has vehicle
              // slots — no point on jobs with no vehicle requirement.
              const slots = hhSyncResult?.derivation?.flags?.vehicle_slots || [];
              const hasSlots = slots.length > 0;
              const hasVdSlot = slots.some(s => s.mode === 'van_and_driver');
              const hhJobNum = job.hh_job_number;
              return (
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                  <p className="text-gray-400 text-4xl mb-3">🚐</p>
                  <p className="text-gray-600 font-medium">No vehicle assignments yet</p>
                  <p className="text-sm text-gray-400 mt-1">
                    {hasVdSlot
                      ? 'Van & Driver job — allocate a van to get started.'
                      : 'Vehicle assignments from the Allocations page will appear here.'}
                  </p>
                  {hasSlots && hhJobNum && (
                    <Link
                      to={`/vehicles/allocations?job=${hhJobNum}`}
                      className="inline-flex items-center gap-1.5 px-4 py-2 mt-4 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium"
                    >
                      🚐 Allocate Van
                    </Link>
                  )}
                </div>
              );
            })()
          ) : (
            <div className="space-y-3">
              {vehicleAssignments.map((a) => {
                const assignmentBlockers = dispatchCheck?.blockers.filter(b => b.assignmentId === a.id) || [];
                const hasReferralBlocker = assignmentBlockers.some(b => b.type === 'referral_pending');
                const hasExcessBlocker = assignmentBlockers.some(b => b.type === 'excess_pending');

                const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
                  soft: { label: 'Soft Allocation', bg: 'bg-gray-100', text: 'text-gray-600' },
                  confirmed: { label: 'Confirmed', bg: 'bg-blue-100', text: 'text-blue-700' },
                  booked_out: { label: 'Booked Out', bg: 'bg-indigo-100', text: 'text-indigo-700' },
                  active: { label: 'On Hire', bg: 'bg-green-100', text: 'text-green-700' },
                  returned: { label: 'Returned', bg: 'bg-teal-100', text: 'text-teal-700' },
                  cancelled: { label: 'Cancelled', bg: 'bg-red-100', text: 'text-red-700' },
                  swapped: { label: 'Swapped', bg: 'bg-orange-100', text: 'text-orange-700' },
                };
                const sc = statusConfig[a.status] || statusConfig.soft;

                const typeLabels: Record<string, string> = {
                  self_drive: 'Self-Drive',
                  driven: 'Driven',
                  delivery: 'Delivery',
                  collection: 'Collection',
                };

                return (
                  <div key={a.id} className={`bg-white rounded-xl shadow-sm border ${
                    hasReferralBlocker ? 'border-orange-300' : hasExcessBlocker ? 'border-amber-300' : 'border-gray-200'
                  } p-5`}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-lg">🚐</span>
                        <span className="font-semibold text-gray-900">{a.vehicle_reg}</span>
                        {a.vehicle_type && <span className="text-sm text-gray-500">({a.vehicle_type})</span>}
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.bg} ${sc.text}`}>
                          {sc.label}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                          {typeLabels[a.assignment_type] || a.assignment_type}
                        </span>
                        {/* OOH return pill — self-drive only */}
                        {a.assignment_type === 'self_drive' && (
                          <button
                            type="button"
                            onClick={() => setOohModalAssignmentId(a.id)}
                            title="Out-of-hours return"
                            className={`text-xs px-2 py-0.5 rounded-full font-medium hover:opacity-80 ${
                              a.return_overnight === true
                                ? 'bg-indigo-100 text-indigo-700'
                                : a.return_overnight === false
                                ? 'bg-gray-100 text-gray-500'
                                : 'bg-gray-50 text-gray-400 border border-dashed border-gray-300'
                            }`}
                          >
                            {a.return_overnight === true
                              ? `🌙 OOH: Yes${a.ooh_returned_at ? ' · returned' : a.ooh_info_sent_at ? ' · sent' : ''}`
                              : a.return_overnight === false
                              ? '🌙 OOH: No'
                              : '🌙 OOH: —'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Driver info */}
                    {a.assignment_type === 'self_drive' && (
                      <div className={`rounded-lg p-3 mb-3 ${
                        hasReferralBlocker ? 'bg-orange-50' : 'bg-gray-50'
                      }`}>
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-xs font-medium text-gray-500 uppercase">Driver</span>
                            {a.driver_name ? (
                              <p className="text-sm font-medium text-gray-900">
                                {a.driver_id ? (
                                  <Link to={`/drivers/${a.driver_id}`} className="text-ooosh-700 hover:text-ooosh-900 hover:underline">
                                    {a.driver_name}
                                  </Link>
                                ) : (
                                  a.driver_name
                                )}
                                {a.driver_email && <span className="text-gray-400 font-normal ml-2">{a.driver_email}</span>}
                                {a.driver_phone && <span className="text-gray-400 font-normal ml-2">{a.driver_phone}</span>}
                              </p>
                            ) : (
                              <p className="text-sm text-gray-400 italic">No driver assigned</p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {hasReferralBlocker && (
                              <span className="text-xs px-2 py-1 rounded-full bg-orange-100 text-orange-700 font-medium">
                                Referral Pending
                              </span>
                            )}
                            {a.driver_points != null && a.driver_points > 0 && (
                              <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                                a.driver_points >= 10 ? 'bg-red-100 text-red-700' :
                                a.driver_points >= 7 ? 'bg-orange-100 text-orange-700' :
                                a.driver_points >= 4 ? 'bg-amber-100 text-amber-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>
                                {a.driver_points} pts
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Excess status */}
                        {a.excess && (
                          <div className="mt-2 pt-2 border-t border-gray-200">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-500">Insurance Excess</span>
                              <div className="flex items-center gap-2">
                                {a.excess.excess_amount_required != null && (
                                  <span className="font-medium text-gray-700">
                                    £{Number(a.excess.excess_amount_required).toFixed(2)}
                                  </span>
                                )}
                                <span className={`px-2 py-0.5 rounded-full font-medium ${
                                  a.excess.excess_status === 'taken' ? 'bg-green-100 text-green-700' :
                                  a.excess.excess_status === 'pre_auth' ? 'bg-sky-100 text-sky-700' :
                                  a.excess.excess_status === 'waived' ? 'bg-blue-100 text-blue-700' :
                                  a.excess.excess_status === 'reimbursed' ? 'bg-emerald-100 text-emerald-700' :
                                  a.excess.excess_status === 'partially_reimbursed' ? 'bg-orange-100 text-orange-700' :
                                  a.excess.excess_status === 'fully_claimed' ? 'bg-red-100 text-red-700' :
                                  ['needed', 'pending'].includes(a.excess.excess_status) ? 'bg-amber-100 text-amber-700' :
                                  a.excess.excess_status === 'partially_paid' ? 'bg-yellow-100 text-yellow-700' :
                                  a.excess.excess_status === 'not_required' ? 'bg-gray-100 text-gray-500' :
                                  'bg-gray-100 text-gray-600'
                                }`}>
                                  {a.excess.excess_status === 'taken' ? 'Taken' :
                                   a.excess.excess_status === 'pre_auth' ? 'Pre-auth' :
                                   a.excess.excess_status === 'waived' ? 'Waived' :
                                   a.excess.excess_status === 'reimbursed' ? 'Reimbursed' :
                                   a.excess.excess_status === 'partially_reimbursed' ? 'Part Reimbursed' :
                                   a.excess.excess_status === 'fully_claimed' ? 'Claimed' :
                                   ['needed', 'pending'].includes(a.excess.excess_status) ? 'Required' :
                                   a.excess.excess_status === 'partially_paid' ? 'Part Paid' :
                                   a.excess.excess_status === 'not_required' ? 'Covered' :
                                   a.excess.excess_status}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => a.excess && openExcessModal(a.excess.id, 'edit_required')}
                                  disabled={a.excess && excessModalLoadingId === a.excess.id ? true : false}
                                  title="Edit required excess amount"
                                  className="text-xs font-medium text-ooosh-700 hover:text-ooosh-900 hover:underline disabled:opacity-50"
                                >
                                  {a.excess && excessModalLoadingId === a.excess.id ? '…' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => a.excess && openExcessModal(a.excess.id)}
                                  disabled={a.excess && excessModalLoadingId === a.excess.id ? true : false}
                                  className="text-xs font-medium text-gray-600 hover:text-gray-900 hover:underline disabled:opacity-50"
                                >
                                  Manage
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Driven assignment - show freelancer driver */}
                    {a.assignment_type === 'driven' && a.freelancer_name && (
                      <div className="bg-gray-50 rounded-lg p-3 mb-3">
                        <span className="text-xs font-medium text-gray-500 uppercase">Staff Driver</span>
                        <p className="text-sm font-medium text-gray-900">{a.freelancer_name}</p>
                      </div>
                    )}

                    {/* Hire dates and mileage */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                      {a.hire_start && (
                        <span>Start: {new Date(a.hire_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      )}
                      {a.hire_end && (
                        <span>End: {new Date(a.hire_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      )}
                      {a.mileage_out != null && <span>Out: {a.mileage_out.toLocaleString()} mi</span>}
                      {a.mileage_in != null && <span>In: {a.mileage_in.toLocaleString()} mi</span>}
                      {a.has_damage && <span className="text-red-600 font-medium">Damage reported</span>}
                      {a.ve103b_ref && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                          VE103B: {a.ve103b_ref}
                        </span>
                      )}
                    </div>

                    {/* Swap info for swapped assignments */}
                    {a.status === 'swapped' && a.notes && (
                      <div className="mt-2 text-xs text-orange-600 italic">{a.notes}</div>
                    )}

                    {/* Actions row */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {/* Primary next-action — Allocate Van / Book Out / Check In.
                          State-aware: drives the staff cockpit workflow from
                          this card so they don't have to leave Job Detail to
                          hunt down the right tool elsewhere. Self-drive only;
                          driven/D&C lifecycles live in Crew & Transport.

                          Uses `effective_vehicle_id` rather than
                          `vehicle_id` so that a sibling staff allocation
                          (van picked on the Allocations page but not yet
                          cascade-linked to this driver's hire form row)
                          surfaces "Book Out" rather than "Allocate Van".
                          BookOutPage's PATCH then writes vehicle_id to this
                          row at submission, retroactively cementing the
                          link. */}
                      {/* Soft Book Out for Van & Driver mode (Ooosh-supplied driver, no
                          customer hire form). Detection: assignment is already 'driven'
                          (post-promotion), OR matching vehicle slot is in V&D mode, OR
                          the job has V&D slots and this assignment isn't yet booked-out
                          self-drive. Routes to BookOutPage with ?mode=van_and_driver. */}
                      {(() => {
                        const slots = hhSyncResult?.derivation?.flags?.vehicle_slots || [];
                        const matchedSlot = slots.find(s => s.slot_index === (a.van_requirement_index ?? 0));
                        const slotIsVand = matchedSlot?.mode === 'van_and_driver';
                        const anySlotIsVand = slots.some(s => s.mode === 'van_and_driver');
                        const isVandAssignment =
                          a.assignment_type === 'driven' ||
                          slotIsVand ||
                          // No matched slot but job has V&D slots somewhere — coarse
                          // signal that helps when slot indexing doesn't line up cleanly
                          // (legacy job-level toggle, sparse vehicle_slots, etc.)
                          (anySlotIsVand && a.assignment_type === 'self_drive');
                        if (!isVandAssignment) return null;
                        const hhJobNum = job.hh_job_number;
                        const baseClass = 'inline-flex items-center gap-1.5 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium';
                        const effectiveVehicleId = a.effective_vehicle_id || a.vehicle_id;
                        if (a.status === 'soft' || a.status === 'confirmed') {
                          if (!effectiveVehicleId) {
                            return (
                              <Link
                                to={`/vehicles/allocations${hhJobNum ? `?job=${hhJobNum}` : ''}`}
                                className={baseClass}
                                title="Pick a van for this Van & Driver hire on the Allocations page"
                              >
                                🚐 Allocate Van
                              </Link>
                            );
                          }
                          return (
                            <Link
                              to={`/vehicles/book-out?vehicle=${effectiveVehicleId}${hhJobNum ? `&job=${hhJobNum}` : ''}&mode=van_and_driver&assignment=${a.id}`}
                              className={baseClass}
                              title="Soft book-out: walkaround + photos + signature for the Ooosh-supplied freelancer driver. No customer hire form."
                            >
                              🚐 Soft Book Out (V&amp;D)
                            </Link>
                          );
                        }
                        if ((a.status === 'booked_out' || a.status === 'active') && effectiveVehicleId) {
                          return (
                            <Link
                              to={`/vehicles/check-in?vehicle=${effectiveVehicleId}`}
                              className={baseClass}
                              title="Return walkaround, mileage, damage check"
                            >
                              ↩️ Check In
                            </Link>
                          );
                        }
                        return null;
                      })()}

                      {a.assignment_type === 'self_drive' && (() => {
                        // If the matching slot is in V&D mode the V&D button above
                        // owns this card — hide the customer self-drive button to
                        // keep the UX unambiguous (one path per slot mode).
                        const slots = hhSyncResult?.derivation?.flags?.vehicle_slots || [];
                        const matchedSlot = slots.find(s => s.slot_index === (a.van_requirement_index ?? 0));
                        if (matchedSlot?.mode === 'van_and_driver') return null;
                        if (slots.length > 0 && slots.every(s => s.mode === 'van_and_driver')) return null;
                        const hhJobNum = job.hh_job_number;
                        const baseClass = 'inline-flex items-center gap-1.5 px-3 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium';
                        const effectiveVehicleId = a.effective_vehicle_id || a.vehicle_id;
                        if (a.status === 'soft' || a.status === 'confirmed') {
                          if (!effectiveVehicleId) {
                            return (
                              <Link
                                to={`/vehicles/allocations${hhJobNum ? `?job=${hhJobNum}` : ''}`}
                                className={baseClass}
                                title="Pick a van for this driver on the Allocations page"
                              >
                                🚐 Allocate Van
                              </Link>
                            );
                          }
                          return (
                            <Link
                              to={`/vehicles/book-out?vehicle=${effectiveVehicleId}${hhJobNum ? `&job=${hhJobNum}` : ''}`}
                              className={baseClass}
                              title="Walkaround photos, mileage, signature — pre-filled from this assignment"
                            >
                              📋 Book Out
                            </Link>
                          );
                        }
                        if ((a.status === 'booked_out' || a.status === 'active') && effectiveVehicleId) {
                          return (
                            <Link
                              to={`/vehicles/check-in?vehicle=${effectiveVehicleId}`}
                              className={baseClass}
                              title="Return walkaround, mileage, damage check"
                            >
                              ↩️ Check In
                            </Link>
                          );
                        }
                        return null;
                      })()}

                      {/* Hire Form PDF actions */}
                      {a.assignment_type === 'self_drive' && (
                        <HireFormActions assignmentId={a.id} pdfKey={a.hire_form_pdf_key} pdfGeneratedAt={a.hire_form_generated_at} vehicleId={a.vehicle_id} />
                      )}

                      {/* Swap Vehicle button — only for active/confirmed assignments */}
                      {!['cancelled', 'swapped'].includes(a.status) && (
                        <SwapVehicleButton
                          assignmentId={a.id}
                          currentVehicleReg={a.vehicle_reg}
                          onSwapped={() => {
                            // Refresh assignments
                            api.get<{ data: VehicleAssignment[] }>(`/assignments?job_id=${job.id}`)
                              .then(r => setVehicleAssignments(r.data || []))
                              .catch(() => {});
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Files Tab */}
      {activeTab === 'files' && id && (
        <JobFilesSection
          jobId={id}
          files={job.files || []}
          onFilesChanged={loadJob}
        />
      )}

      {/* Crew & Transport Tab */}
      {activeTab === 'transport' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Crew & Transport</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => openLocalForm()}
                className="flex items-center gap-1.5 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
              >
                + Local D/C
              </button>
              <button
                onClick={() => setShowCalculator(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium"
              >
                + New Calculation
              </button>
            </div>
          </div>

          {quotesLoading && quotes.length === 0 ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
            </div>
          ) : quotes.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
              <p className="text-gray-400 text-4xl mb-3">🧮</p>
              <p className="text-gray-600 font-medium">No calculations yet</p>
              <p className="text-sm text-gray-400 mt-1">Use the calculator to cost deliveries, collections, and crewed jobs</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Summary panel */}
              {quotes.length > 0 && (() => {
                const activeQuotes = quotes.filter(q => (q.status || 'draft') !== 'cancelled');
                const confirmedQuotes = quotes.filter(q => q.status === 'confirmed' || q.status === 'completed');
                const totalClient = activeQuotes.reduce((s, q) => s + Number(q.client_charge_rounded ?? q.client_charge_total ?? 0), 0);
                const totalFreelancer = activeQuotes.reduce((s, q) => s + Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0), 0);
                const totalMargin = activeQuotes.reduce((s, q) => s + Number(q.our_margin ?? 0), 0);
                const totalTime = activeQuotes.reduce((s, q) => s + Number(q.estimated_time_hrs ?? 0), 0);
                const totalCrew = activeQuotes.reduce((s, q) => s + (Array.isArray(q.assignments) ? q.assignments.length : 0), 0);
                return (
                  <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 text-sm mb-2">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      <div>
                        <span className="text-gray-500">Total Client</span>
                        <p className="font-bold text-green-700">&pound;{totalClient.toFixed(2)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Total Freelancer</span>
                        <p className="font-bold text-blue-700">&pound;{totalFreelancer.toFixed(2)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Total Margin</span>
                        <p className={`font-bold ${totalMargin < 0 ? 'text-red-600' : 'text-purple-700'}`}>&pound;{totalMargin.toFixed(2)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Total Time</span>
                        <p className="font-medium text-gray-900">{totalTime.toFixed(1)}h</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Status</span>
                        <p className="font-medium text-gray-900">
                          {confirmedQuotes.length}/{activeQuotes.length} confirmed
                          {totalCrew > 0 && <span className="text-gray-400"> · {totalCrew} crew</span>}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {[...quotes]
                .sort((a, b) => {
                  const dateA = a.job_date || '';
                  const dateB = b.job_date || '';
                  if (dateA !== dateB) return dateA.localeCompare(dateB);
                  const timeA = a.arrival_time || '';
                  const timeB = b.arrival_time || '';
                  return timeA.localeCompare(timeB);
                })
                .filter((q) => q.status !== 'cancelled')
                .map((q) => {
                const clientCharge = Number(q.client_charge_rounded ?? q.client_charge_total ?? 0);
                const freelancerFee = Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0);
                const margin = Number(q.our_margin ?? 0);
                const totalCost = Number(q.our_total_cost ?? 0);
                const fuelCost = Number(q.expected_fuel_cost ?? 0);
                const labourCharge = Number(q.client_charge_labour ?? 0);
                const fuelCharge = Number(q.client_charge_fuel ?? 0);
                const expenseCharge = Number(q.client_charge_expenses ?? 0);
                const expensesAbsorbed = Number(q.expenses_included ?? 0);
                const marginIsNegative = margin < 0;
                const quoteStatus = q.status || 'draft';
                const assignments: QuoteAssignment[] = Array.isArray(q.assignments) ? q.assignments : [];
                const isCancelled = quoteStatus === 'cancelled';

                const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
                  draft: { label: 'To be arranged', bg: 'bg-gray-100', text: 'text-gray-600' },
                  confirmed: { label: 'Confirmed', bg: 'bg-green-100', text: 'text-green-700' },
                  cancelled: { label: 'Cancelled', bg: 'bg-red-100', text: 'text-red-700' },
                  completed: { label: 'Completed', bg: 'bg-emerald-100', text: 'text-emerald-700' },
                };
                const sc = statusConfig[quoteStatus] || statusConfig.draft;
                // Effective venue name — prefer joined venues.name (linked_venue_name)
                // over q.venue_name, which can be NULL on quotes that have venue_id
                // set (Monday-migrated, HH-derived, older OP-native). Matches the
                // fallback TransportOpsPage uses everywhere.
                const venueDisplayName =
                  (q as { linked_venue_name?: string | null }).linked_venue_name || q.venue_name || '';

                return (
                <div key={q.id} className={`bg-white rounded-xl shadow-sm border ${isCancelled ? 'border-red-200 opacity-60' : 'border-gray-200'} p-5`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {/* Header row with type, mode badge, status badge */}
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-lg">
                          {q.job_type === 'delivery' ? '📦' : q.job_type === 'collection' ? '📥' : '👷'}
                        </span>
                        <Link
                          to={`/operations/transport?quote=${q.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-gray-900 capitalize hover:text-ooosh-600 hover:underline"
                          title="Open this quote on the Crew & Transport ops page (new tab) to see what else is going on around the same time"
                        >
                          {q.job_type}
                          {q.what_is_it ? ` (${q.what_is_it})` : ''}
                          {q.add_collection ? ' + Collection' : ''}
                          <span className="ml-1 text-xs text-ooosh-600">↗</span>
                        </Link>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          q.calculation_mode === 'dayrate' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {q.calculation_mode === 'dayrate' ? 'Day Rate' : 'Hourly'}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.bg} ${sc.text}`}>
                          {sc.label}
                        </span>
                        {q.run_group && (
                          <span
                            className="text-xs px-2 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700"
                            title={q.run_notes || 'Part of a multi-drop run — see Transport Ops for full run detail.'}
                          >
                            🔗 Part of a run
                          </span>
                        )}
                        {/* Client intro pill — clickable, mirrors Transport Ops */}
                        {(() => {
                          const intro = (q as { client_introduction?: string }).client_introduction || 'not_needed';
                          const colour: Record<string, string> = {
                            not_needed: 'bg-gray-100 text-gray-400',
                            todo: 'bg-amber-100 text-amber-700',
                            working_on_it: 'bg-orange-100 text-orange-700',
                            done: 'bg-green-100 text-green-700',
                          };
                          const label: Record<string, string> = {
                            not_needed: 'n/a',
                            todo: 'to do',
                            working_on_it: 'working on it',
                            done: 'done',
                          };
                          return (
                            <button
                              onClick={() => cycleClientIntro(q.id, intro)}
                              className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${colour[intro] || 'bg-gray-100 text-gray-600'}`}
                              title="Click to cycle: n/a → to do → working on it → done"
                            >
                              Client intro: {label[intro] || intro}
                            </button>
                          );
                        })()}
                      </div>

                      {/* Date, time, venue — top line */}
                      {(venueDisplayName || q.job_date || q.arrival_time) && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-2 text-sm text-gray-700">
                          {q.job_date && <span>📅 {new Date(q.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                          {q.arrival_time
                            ? <span>🕐 {q.arrival_time}</span>
                            : q.job_date && <span className="text-gray-400 italic">🕐 Time TBC</span>}
                          {venueDisplayName && (
                            q.venue_id ? (
                              <Link to={`/venues/${q.venue_id}`} className="text-ooosh-600 hover:text-ooosh-700 hover:underline">📍 {venueDisplayName}</Link>
                            ) : (
                              <span>📍 {venueDisplayName}</span>
                            )
                          )}
                          {q.distance_miles && <span className="text-gray-500 text-xs self-center">{q.distance_miles}mi · {q.drive_time_mins}min</span>}
                          {q.add_collection && q.collection_date && (
                            <span>📥 Collection: {new Date(q.collection_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                          )}
                          {q.travel_method === 'public_transport' && (
                            <span className="text-gray-500 text-xs self-center">🚆 Public transport{q.travel_time_mins ? ` ${q.travel_time_mins}min` : ''}{q.travel_cost ? ` £${Number(q.travel_cost).toFixed(2)}` : ''}</span>
                          )}
                        </div>
                      )}

                      {/* Price summary row */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <span className="text-gray-500">Client Charge</span>
                          {q.run_group && q.run_combined_client_fee != null ? (
                            <p className="font-bold text-green-700">
                              <span className="line-through text-gray-400 font-normal mr-1">&pound;{clientCharge.toFixed(2)}</span>
                              &pound;{Number(q.run_combined_client_fee).toFixed(2)}
                              <span className="block text-[10px] font-normal text-violet-600">run combined</span>
                            </p>
                          ) : (
                            <p className="font-bold text-green-700">
                              &pound;{clientCharge.toFixed(2)}
                              {q.add_collection && <span className="text-xs font-normal text-gray-400"> (&times;2 = &pound;{(clientCharge * 2).toFixed(2)})</span>}
                            </p>
                          )}
                        </div>
                        <div>
                          <span className="text-gray-500">Freelancer Fee</span>
                          {q.run_group && q.run_combined_freelancer_fee != null ? (
                            <p className="font-bold text-blue-700">
                              <span className="line-through text-gray-400 font-normal mr-1">&pound;{freelancerFee.toFixed(2)}</span>
                              &pound;{Number(q.run_combined_freelancer_fee).toFixed(2)}
                              <span className="block text-[10px] font-normal text-violet-600">run combined</span>
                            </p>
                          ) : (
                            <p className="font-bold text-blue-700">
                              &pound;{freelancerFee.toFixed(2)}
                            </p>
                          )}
                        </div>
                        <div>
                          <span className="text-gray-500">Our Margin</span>
                          <p className={`font-bold ${marginIsNegative ? 'text-red-600' : 'text-purple-700'}`}>
                            &pound;{margin.toFixed(2)}
                          </p>
                        </div>
                        {q.estimated_time_hrs && (
                          <div>
                            <span className="text-gray-500">Est. Time</span>
                            <p className="font-medium text-gray-900">{Number(q.estimated_time_hrs).toFixed(1)}h</p>
                          </div>
                        )}
                      </div>

                      {/* Cost breakdown */}
                      <div className="mt-2 grid grid-cols-2 gap-x-6 text-xs">
                        <div className="space-y-0.5">
                          <p className="text-gray-400 font-medium">Client charges:</p>
                          {labourCharge > 0 && <p className="text-gray-500">Labour: &pound;{labourCharge.toFixed(2)}</p>}
                          {fuelCharge > 0 && <p className="text-gray-500">Fuel: &pound;{fuelCharge.toFixed(2)}</p>}
                          {expenseCharge > 0 && <p className="text-gray-500">Expenses: &pound;{expenseCharge.toFixed(2)}</p>}
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-gray-400 font-medium">Our costs:</p>
                          <p className="text-gray-500">Freelancer: &pound;{freelancerFee.toFixed(2)}</p>
                          {fuelCost > 0 && <p className="text-gray-500">Fuel: &pound;{fuelCost.toFixed(2)}</p>}
                          {expensesAbsorbed > 0 && <p className="text-gray-500">Absorbed expenses: &pound;{expensesAbsorbed.toFixed(2)}</p>}
                          <p className="text-gray-500 font-medium">Total cost: &pound;{totalCost.toFixed(2)}</p>
                        </div>
                      </div>


                      {/* Crew assignments */}
                      <div className="mt-3 pt-3 border-t border-gray-100">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-medium text-gray-500">Crew</span>
                          {(q.crew_count || 1) > 1 && (
                            <span className={`text-xs font-medium ${assignments.length >= (q.crew_count || 1) ? 'text-green-600' : 'text-amber-600'}`}>
                              {assignments.length}/{q.crew_count} assigned
                            </span>
                          )}
                          {!isCancelled && (
                            <button
                              onClick={() => { setAssignModalQuoteId(q.id); setPeopleSearch(''); setPeopleOptions([]); }}
                              className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                            >
                              + Assign
                            </button>
                          )}
                        </div>
                        {assignments.length === 0 ? (
                          <p className="text-xs text-gray-400 italic">
                            No crew assigned{(q.crew_count || 1) > 1 ? ` (${q.crew_count} needed)` : ''}
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {assignments.map((a) => (
                              <div key={a.id} className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-full px-2.5 py-1 text-xs">
                                <span className="font-medium text-blue-800">{a.first_name} {a.last_name}</span>
                                <span className="text-blue-500 capitalize">({a.role})</span>
                                {a.agreed_rate != null && (
                                  <span className="text-blue-400">&pound;{Number(a.agreed_rate).toFixed(0)}</span>
                                )}
                                {!isCancelled && (
                                  <button
                                    onClick={() => removeAssignment(q.id, a.id)}
                                    className="ml-0.5 text-blue-400 hover:text-red-500"
                                    title="Remove"
                                  >
                                    &times;
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {(q.internal_notes || q.freelancer_notes) && (
                        <div className="mt-3 flex gap-4 text-xs">
                          {q.internal_notes && (
                            <div className="flex-1 bg-amber-50 border border-amber-200 rounded p-2">
                              <span className="font-medium text-amber-700">🔒 Internal:</span>
                              <span className="ml-1 text-amber-600">{q.internal_notes}</span>
                            </div>
                          )}
                          {q.freelancer_notes && (
                            <div className="flex-1 bg-blue-50 border border-blue-200 rounded p-2">
                              <span className="font-medium text-blue-700">📝 Freelancer:</span>
                              <span className="ml-1 text-blue-600">{q.freelancer_notes}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {q.cancelled_reason && (
                        <div className="mt-2 text-xs bg-red-50 border border-red-200 rounded p-2">
                          <span className="font-medium text-red-700">Cancelled:</span>
                          <span className="ml-1 text-red-600">{q.cancelled_reason}</span>
                        </div>
                      )}
                    </div>

                    {/* Right side: actions */}
                    <div className="text-right text-xs ml-4 shrink-0 flex flex-col items-end gap-2">
                      {/* Edit button */}
                      {!isCancelled && (
                        <button
                          onClick={() => startEditQuote(q)}
                          className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200 font-medium"
                        >
                          Edit
                        </button>
                      )}

                      {/* Status action buttons */}
                      {!isCancelled && (
                        <div className="flex flex-col gap-1">
                          {quoteStatus === 'draft' && (
                            <button
                              onClick={() => updateQuoteStatus(q.id, 'confirmed')}
                              className="px-2.5 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 font-medium"
                            >
                              Confirm
                            </button>
                          )}
                          {quoteStatus === 'confirmed' && (
                            <button
                              onClick={() => setCompletingQuote(q)}
                              className="px-2.5 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700 font-medium"
                              title="Normally the freelancer completes via the portal. This is a manager override."
                            >
                              Complete
                            </button>
                          )}
                          {(quoteStatus === 'draft' || quoteStatus === 'confirmed') && (
                            <button
                              onClick={() => {
                                const reason = window.prompt('Reason for cancelling (optional):');
                                if (reason !== null) updateQuoteStatus(q.id, 'cancelled', reason || undefined);
                              }}
                              className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-red-50 hover:text-red-600 font-medium"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      )}
                      {quoteStatus === 'cancelled' && (
                        <button
                          onClick={() => updateQuoteStatus(q.id, 'draft')}
                          className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200 font-medium"
                        >
                          Restore
                        </button>
                      )}

                    </div>
                  </div>
                  {/* Created by — bottom right */}
                  <div className="flex justify-end items-center mt-2">
                    <span className="text-[11px] text-gray-400">
                      Created: {new Date(q.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {q.created_by_name && ` / ${q.created_by_name}`}
                    </span>
                  </div>
                </div>
                );
              })}

              {/* Cancelled quotes collapsible section */}
              {(() => {
                const cancelledList = quotes.filter((q) => q.status === 'cancelled');
                if (cancelledList.length === 0) return null;
                return (
                  <div className="mt-4 border border-gray-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setCancelledQuotesExpanded((p) => !p)}
                      className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-sm text-gray-500 font-medium"
                    >
                      <span>Cancelled ({cancelledList.length})</span>
                      <span className="text-xs">{cancelledQuotesExpanded ? '▲ Hide' : '▼ Show'}</span>
                    </button>
                    {cancelledQuotesExpanded && (
                      <div className="space-y-3 p-3 bg-gray-50/50">
                        {cancelledList
                          .sort((a, b) => (a.job_date || '').localeCompare(b.job_date || ''))
                          .map((q) => {
                          const clientCharge = Number(q.client_charge_rounded ?? q.client_charge_total ?? 0);
                          const freelancerFee = Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0);
                          const sc = { label: 'Cancelled', bg: 'bg-red-100', text: 'text-red-700' };
                          const venueDisplayName =
                            (q as { linked_venue_name?: string | null }).linked_venue_name || q.venue_name || '';
                          return (
                            <div key={q.id} className="bg-white rounded-xl shadow-sm border border-red-200 opacity-60 p-5">
                              <div className="flex items-start justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span className="text-lg">
                                      {q.job_type === 'delivery' ? '📦' : q.job_type === 'collection' ? '📥' : '👷'}
                                    </span>
                                    <Link
                                      to={`/operations/transport?quote=${q.id}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-semibold text-gray-900 capitalize hover:text-ooosh-600 hover:underline"
                                      title="Open this quote on the Crew & Transport ops page (new tab)"
                                    >
                                      {q.job_type}{q.what_is_it ? ` (${q.what_is_it})` : ''}{q.add_collection ? ' + Collection' : ''}
                                      <span className="ml-1 text-xs text-ooosh-600">↗</span>
                                    </Link>
                                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.bg} ${sc.text}`}>{sc.label}</span>
                                  </div>
                                  {(venueDisplayName || q.job_date || q.arrival_time) && (
                                    <div className="flex flex-wrap gap-x-3 text-sm text-gray-600 mb-2">
                                      {venueDisplayName && <span>📍 {venueDisplayName}</span>}
                                      {q.job_date && <span>📅 {new Date(q.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                                      {q.arrival_time
                                        ? <span>🕐 {q.arrival_time}</span>
                                        : q.job_date && <span className="text-gray-400 italic">🕐 Time TBC</span>}
                                    </div>
                                  )}
                                  <div className="text-sm text-gray-500">
                                    Client: £{clientCharge.toFixed(2)} · Freelancer: £{freelancerFee.toFixed(2)}
                                  </div>
                                  {q.cancelled_reason && (
                                    <div className="mt-2 text-xs bg-red-50 border border-red-200 rounded p-2">
                                      <span className="font-medium text-red-700">Reason:</span>
                                      <span className="ml-1 text-red-600">{q.cancelled_reason}</span>
                                    </div>
                                  )}
                                </div>
                                <div className="text-right text-xs ml-4 shrink-0 flex flex-col items-end gap-2">
                                  <button
                                    onClick={() => updateQuoteStatus(q.id, 'draft')}
                                    className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200 font-medium"
                                  >
                                    Restore
                                  </button>
                                  <div className="text-gray-400 text-[11px] leading-snug">
                                    <div>
                                      Created: {new Date(q.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                      {q.created_by_name && ` / ${q.created_by_name}`}
                                    </div>
                                    {q.status_changed_at && (
                                      <div className="text-red-500">
                                        Cancelled: {new Date(q.status_changed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                        {' '}{new Date(q.status_changed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                                        {q.status_changed_by_name && ` / ${q.status_changed_by_name}`}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Edit Quote Modal — shared component */}
          {editingQuote && (
            <QuoteEditModal
              quote={{
                id: editingQuote.id,
                job_type: editingQuote.job_type as 'delivery' | 'collection' | 'crewed',
                calculation_mode: editingQuote.calculation_mode,
                venue_id: editingQuote.venue_id,
                venue_name: editingQuote.venue_name,
                linked_venue_name: (editingQuote as { linked_venue_name?: string | null }).linked_venue_name,
                job_date: editingQuote.job_date,
                job_finish_date: editingQuote.job_finish_date,
                is_multi_day: editingQuote.is_multi_day,
                num_days: editingQuote.num_days,
                arrival_time: editingQuote.arrival_time,
                what_is_it: editingQuote.what_is_it,
                work_type: editingQuote.work_type,
                work_description: editingQuote.work_description,
                crew_count: editingQuote.crew_count,
                internal_notes: editingQuote.internal_notes,
                freelancer_notes: editingQuote.freelancer_notes,
                client_charge_rounded: editingQuote.client_charge_rounded,
                freelancer_fee_rounded: editingQuote.freelancer_fee_rounded,
                hh_pushed_at: editingQuote.hh_pushed_at,
                out_date: job?.out_date ?? null,
                return_date: job?.return_date ?? null,
              }}
              onClose={() => setEditingQuote(null)}
              onSaved={loadQuotes}
            />
          )}

          {/* Hire Forms Section (testing) */}

          {/* Complete Quote Override Modal */}
          {completingQuote && (
            <CompleteQuoteOverrideModal
              quoteId={completingQuote.id}
              assignees={(completingQuote.assignments || []).map((a) => ({
                id: a.person_id,
                name: `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'Assigned crew',
                is_ooosh_crew: a.is_ooosh_crew === true,
              }))}
              onClose={() => setCompletingQuote(null)}
              onCompleted={() => {
                setCompletingQuote(null);
                loadQuotes();
              }}
            />
          )}
        </div>
      )}

      {/* Money Tab */}
      {activeTab === 'money' && id && (
        <MoneyTab jobId={id} job={job} onJobChanged={loadJob} />
      )}

      {/* Chase Modal */}
      {/* Excess Payment / Edit Modal — opened from Drivers & Vehicles strip */}
      {excessModalRecord && (
        <ExcessPaymentModal
          excess={excessModalRecord}
          initialAction={excessModalInitialAction}
          onClose={() => { setExcessModalRecord(null); setExcessModalInitialAction(undefined); }}
          onUpdated={() => { loadVehicleAssignments(); loadCancelledExcessHeld(); }}
        />
      )}

      {/* Out-of-Hours Return Modal */}
      {oohModalAssignmentId && (() => {
        const assignment = vehicleAssignments.find(v => v.id === oohModalAssignmentId);
        if (!assignment) return null;
        // Sibling drivers on the same van — for showing "will email X, Y" preview.
        const siblings = vehicleAssignments.filter(
          v => v.vehicle_id && v.vehicle_id === assignment.vehicle_id && v.driver_email
        );
        const driverEmails = siblings.map(v => v.driver_email!).filter(Boolean);
        return (
          <OohReturnModal
            assignmentId={assignment.id}
            vehicleReg={assignment.vehicle_reg}
            current={assignment.return_overnight ?? null}
            infoSentAt={assignment.ooh_info_sent_at ?? null}
            driverEmails={driverEmails}
            onClose={() => setOohModalAssignmentId(null)}
            onSaved={() => { loadVehicleAssignments(); }}
          />
        );
      })()}

      <ChaseModal
        isOpen={showChaseModal}
        job={job ? {
          id: job.id,
          job_name: job.job_name,
          client_name: job.client_name,
          company_name: job.company_name,
          chase_count: (job as unknown as { chase_count?: number }).chase_count || 0,
          next_chase_date: job.next_chase_date,
          chase_alert_user_id: (job as unknown as { chase_alert_user_id?: string | null }).chase_alert_user_id || null,
          chase_alert_delivery: (job as unknown as { chase_alert_delivery?: 'bell' | 'bell_email' | null }).chase_alert_delivery || null,
        } : null}
        onClose={() => setShowChaseModal(false)}
        onChaseLogged={() => { loadJob(); loadInteractions(); }}
      />

      {/* Transport Calculator Modal */}
      <TransportCalculator
        isOpen={showCalculator}
        onClose={() => setShowCalculator(false)}
        onSaved={() => { loadJob(); loadQuotes(); }}
        jobId={job.id}
        jobName={job.job_name || undefined}
        clientName={job.client_name || job.company_name || undefined}
        venueName={job.venue_name || undefined}
        venueId={job.venue_id || undefined}
        jobDate={job.job_date || undefined}
        jobEndDate={job.job_end || undefined}
        hhJobNumber={job.hh_job_number || undefined}
      />

      {/* Local Delivery/Collection Form Modal */}
      {showLocalForm && (() => {
        const defaultDate = getDefaultDate(localFormData.jobType);
        const dateChanged = localFormData.jobDate && defaultDate && localFormData.jobDate !== defaultDate;
        const defaultLabel = localFormData.jobType === 'delivery' ? 'hire start date' : 'hire end date';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Local Delivery / Collection</h3>
              <div className="space-y-3">
                {/* Type toggle */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <div className="flex gap-2">
                    {(['delivery', 'collection'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          const newDefault = getDefaultDate(t);
                          setLocalFormData({ ...localFormData, jobType: t, jobDate: newDefault });
                        }}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium ${
                          localFormData.jobType === t
                            ? 'border-ooosh-500 bg-ooosh-50 text-ooosh-700'
                            : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {t === 'delivery' ? 'Delivery' : 'Collection'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Venue search */}
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Venue</label>
                  <input
                    type="text"
                    value={venueSearch}
                    onChange={(e) => {
                      setVenueSearch(e.target.value);
                      if (e.target.value.length >= 2) {
                        searchVenues(e.target.value);
                        setShowVenueDropdown(true);
                      } else {
                        setVenueOptions([]);
                        setShowVenueDropdown(false);
                      }
                      // Clear venue selection if text changed
                      if (e.target.value !== localFormData.venueName) {
                        setLocalFormData({ ...localFormData, venueId: '', venueName: e.target.value });
                      }
                    }}
                    onFocus={() => {
                      if (venueOptions.length > 0) setShowVenueDropdown(true);
                    }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    placeholder="Search venues..."
                  />
                  {showVenueDropdown && venueOptions.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {venueOptions.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => {
                            setLocalFormData({ ...localFormData, venueId: v.id, venueName: v.name });
                            setVenueSearch(v.name);
                            setShowVenueDropdown(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50 flex justify-between"
                        >
                          <span className="font-medium text-gray-900">{v.name}</span>
                          {v.city && <span className="text-xs text-gray-400">{v.city}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Date & Time */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                    <DatePicker
                      value={localFormData.jobDate}
                      onChange={(val) => setLocalFormData({ ...localFormData, jobDate: val })}
                      min={new Date().toISOString().split('T')[0]}
                      className={dateChanged ? '[&>button]:border-amber-400 [&>button]:bg-amber-50' : ''}
                    />
                    {dateChanged && (
                      <p className="text-xs text-amber-600 mt-1">
                        Changed from {defaultLabel}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Time</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="e.g. 11:00"
                      value={localFormData.arrivalTime}
                      onChange={(e) => {
                        let v = e.target.value.replace(/[^0-9:]/g, '');
                        setLocalFormData({ ...localFormData, arrivalTime: v });
                      }}
                      onBlur={(e) => {
                        // Smart-complete partial times: "11" → "11:00", "9" → "09:00", "1130" → "11:30"
                        const v = e.target.value.trim();
                        if (!v) return;
                        if (v.includes(':')) {
                          // Already has colon — pad hours if needed (e.g. "9:30" → "09:30")
                          const [hStr, mStr] = v.split(':');
                          const h = parseInt(hStr, 10);
                          const m = parseInt(mStr || '0', 10);
                          if (!isNaN(h) && h >= 0 && h <= 23 && !isNaN(m) && m >= 0 && m <= 59) {
                            setLocalFormData({ ...localFormData, arrivalTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` });
                          }
                        } else if (v.length <= 2) {
                          // Just hours: "11" → "11:00", "9" → "09:00"
                          const h = parseInt(v, 10);
                          if (!isNaN(h) && h >= 0 && h <= 23) {
                            setLocalFormData({ ...localFormData, arrivalTime: `${String(h).padStart(2, '0')}:00` });
                          }
                        } else if (v.length === 3 || v.length === 4) {
                          // "930" → "09:30", "1130" → "11:30"
                          const hLen = v.length === 3 ? 1 : 2;
                          const h = parseInt(v.slice(0, hLen), 10);
                          const m = parseInt(v.slice(hLen), 10);
                          if (!isNaN(h) && h >= 0 && h <= 23 && !isNaN(m) && m >= 0 && m <= 59) {
                            setLocalFormData({ ...localFormData, arrivalTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` });
                          }
                        }
                      }}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={localFormData.notes}
                    onChange={(e) => setLocalFormData({ ...localFormData, notes: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    rows={2}
                    placeholder="Optional notes..."
                  />
                </div>

                {/* Push to HireHop toggle */}
                {job.hh_job_number && (
                  <label className="flex items-center gap-2 text-sm text-gray-700 pt-1">
                    <input
                      type="checkbox"
                      checked={localFormData.pushToHirehop}
                      onChange={(e) => setLocalFormData({ ...localFormData, pushToHirehop: e.target.checked })}
                      className="w-4 h-4 text-ooosh-600 rounded"
                    />
                    Add to HireHop job #{job.hh_job_number}
                  </label>
                )}
              </div>

              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowLocalForm(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  disabled={localSubmitting}
                  onClick={async () => {
                    setLocalSubmitting(true);
                    try {
                      // Ensure date is a string, not a Date object
                      let dateStr = localFormData.jobDate || undefined;
                      if (!dateStr && job.out_date) {
                        dateStr = typeof job.out_date === 'string'
                          ? (job.out_date.includes('T') ? job.out_date.split('T')[0] : job.out_date)
                          : undefined;
                      }
                      const localResult = await api.post<{ id: string }>('/quotes/local', {
                        jobId: job.id,
                        jobType: localFormData.jobType,
                        venueId: localFormData.venueId || job.venue_id || undefined,
                        venueName: localFormData.venueName || job.venue_name || undefined,
                        jobDate: dateStr,
                        arrivalTime: localFormData.arrivalTime || undefined,
                        notes: localFormData.notes || undefined,
                      });
                      // Push to HireHop if toggled on
                      if (localFormData.pushToHirehop && job.hh_job_number && localResult?.id) {
                        try {
                          await api.post(`/quotes/${localResult.id}/push-hirehop`, {});
                        } catch (hhErr) {
                          console.warn('HireHop push failed for local D/C:', hhErr);
                        }
                      }
                      setShowLocalForm(false);
                      setLocalFormData({ jobType: 'delivery', venueId: '', venueName: '', jobDate: '', arrivalTime: '', notes: '', pushToHirehop: true });
                      loadQuotes();
                    } catch (err) {
                      alert(err instanceof Error ? err.message : 'Failed to create');
                    } finally {
                      setLocalSubmitting(false);
                    }
                  }}
                  className="px-4 py-2 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 font-medium"
                >
                  {localSubmitting ? 'Saving...' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Assign Crew Modal */}
      {assignModalQuoteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setAssignModalQuoteId(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Assign Crew Member</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={assignRole}
                  onChange={e => setAssignRole(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="driver">Driver</option>
                  <option value="crew">Crew</option>
                  <option value="loader">Loader</option>
                  <option value="tech">Tech</option>
                  <option value="manager">Manager</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Search People</label>
                <input
                  type="text"
                  value={peopleSearch}
                  onChange={e => {
                    setPeopleSearch(e.target.value);
                    if (e.target.value.length >= 2) searchPeople(e.target.value);
                    else setPeopleOptions([]);
                  }}
                  placeholder="Type a name..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  autoFocus
                />
              </div>

              {peopleOptions.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {peopleOptions.map(p => {
                    const currentQuote = quotes.find(q => q.id === assignModalQuoteId);
                    const alreadyAssigned = currentQuote?.assignments?.some(a => a.person_id === p.id);
                    return (
                      <button
                        key={p.id}
                        disabled={alreadyAssigned}
                        onClick={() => assignPerson(assignModalQuoteId!, p.id, assignRole)}
                        className={`w-full text-left px-3 py-2.5 text-sm flex items-center justify-between ${
                          alreadyAssigned ? 'opacity-40 cursor-not-allowed' : 'hover:bg-ooosh-50'
                        }`}
                      >
                        <div>
                          <span className="font-medium text-gray-900">{p.first_name} {p.last_name}</span>
                          {p.current_organisations?.length ? (
                            <span className="ml-2 text-xs text-gray-400">
                              {p.current_organisations.slice(0, 2).map(o => `${o.role} at ${o.organisation_name}`).join(', ')}
                            </span>
                          ) : p.skills?.length > 0 ? (
                            <span className="ml-2 text-xs text-gray-400">{p.skills.slice(0, 3).join(', ')}</span>
                          ) : null}
                        </div>
                        <div className="flex gap-1">
                          {p.is_insured_on_vehicles && (
                            <span className="text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5">Insured</span>
                          )}
                          {p.is_approved && (
                            <span className="text-xs bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">Approved</span>
                          )}
                          {alreadyAssigned && (
                            <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">Assigned</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {peopleSearch.length >= 2 && peopleOptions.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-2">No people found</p>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => { setAssignModalQuoteId(null); setPeopleSearch(''); setPeopleOptions([]); }}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status transition modal */}
      {showTransitionModal && transitionTarget && transitionTarget !== 'cancelled' && (
        <StatusTransitionModal
          targetStatus={transitionTarget}
          saving={transitionSaving}
          jobId={id}
          clientId={job?.client_id}
          clientName={job?.client_name || job?.company_name}
          onConfirm={(data) => handleStatusTransition(transitionTarget, data)}
          onCancel={() => { setShowTransitionModal(false); setTransitionTarget(null); }}
        />
      )}

      {/* Cancellation modal */}
      {showTransitionModal && transitionTarget === 'cancelled' && job && (
        <CancellationModal
          jobId={job.id}
          jobName={job.job_name || 'Untitled'}
          jobNumber={job.hh_job_number ? String(job.hh_job_number) : null}
          hireValue={job.job_value}
          hireStartDate={job.job_date}
          totalHireDays={job.job_date && job.job_end
            ? Math.ceil((new Date(job.job_end).getTime() - new Date(job.job_date).getTime()) / (1000 * 60 * 60 * 24))
            : null}
          userRole={user?.role || 'staff'}
          saving={transitionSaving}
          onConfirm={async (data) => {
            setTransitionSaving(true);
            try {
              await api.post(`/cancellations/${job.id}/process`, data);
              await loadJob();
              await loadInteractions();
              setShowTransitionModal(false);
              setTransitionTarget(null);
            } catch (err) {
              console.error('Cancellation failed:', err);
            } finally {
              setTransitionSaving(false);
            }
          }}
          onCancel={() => { setShowTransitionModal(false); setTransitionTarget(null); }}
        />
      )}
      </div>

      {/* Client trading history sidebar (desktop only) */}
      {showClientHistory && (
        <div className="hidden lg:block w-72 shrink-0">
          <div className="sticky top-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Client History — {job.client_name || job.company_name}
            </h3>

            {/* Do Not Hire warning */}
            {clientHistoryData!.client_info?.do_not_hire && (
              <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  <span className="text-sm font-bold text-red-700">DO NOT HIRE</span>
                </div>
                {clientHistoryData!.client_info.do_not_hire_reason && (
                  <p className="text-xs text-red-600 mt-1">{clientHistoryData!.client_info.do_not_hire_reason}</p>
                )}
              </div>
            )}

            {/* Working Terms */}
            {clientHistoryData!.client_info?.working_terms_type && (
              <div className="mb-3 p-2.5 bg-gray-50 rounded-lg">
                <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Working Terms</div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block px-2.5 py-1 rounded text-sm font-semibold text-white ${
                    { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' }[clientHistoryData!.client_info.working_terms_type] || 'bg-gray-500'
                  }`}>{
                    { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' }[clientHistoryData!.client_info.working_terms_type] || clientHistoryData!.client_info.working_terms_type
                  }</span>
                  {clientHistoryData!.client_info.working_terms_credit_days && (
                    <span className="text-sm text-gray-500">{clientHistoryData!.client_info.working_terms_credit_days}d credit</span>
                  )}
                </div>
                {clientHistoryData!.client_info.working_terms_notes && (
                  <p className="text-xs text-gray-500 mt-1">{clientHistoryData!.client_info.working_terms_notes}</p>
                )}
              </div>
            )}

            {/* Internal Notes — clamped to 2 lines with expand toggle for long notes (e.g. merge backref logs) */}
            {clientHistoryData!.client_info?.internal_notes && (() => {
              const notes = clientHistoryData!.client_info.internal_notes;
              const isLong = notes.length > 120 || notes.split('\n').length > 2;
              return (
                <div className="mb-3 p-2 bg-amber-50 border border-amber-100 rounded-lg">
                  <div className="text-[10px] font-semibold text-amber-700 uppercase mb-0.5">Internal Notes</div>
                  <p
                    className={`text-[10px] text-gray-700 whitespace-pre-wrap leading-relaxed ${isLong && !clientNotesExpanded ? 'line-clamp-2' : ''}`}
                    title={isLong && !clientNotesExpanded ? notes : undefined}
                  >
                    {notes}
                  </p>
                  {isLong && (
                    <button
                      onClick={() => setClientNotesExpanded(v => !v)}
                      className="text-[10px] text-amber-700 hover:text-amber-900 underline mt-0.5"
                    >
                      {clientNotesExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              );
            })()}

            <div className="grid grid-cols-2 gap-2 mb-4">
              <div className="bg-gray-50 rounded-lg p-2 text-center">
                <div className="text-lg font-bold text-gray-900">{clientHistoryData!.stats.total_jobs}</div>
                <div className="text-[10px] text-gray-500">Total Jobs</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-2 text-center">
                <div className="text-lg font-bold text-green-600">{clientHistoryData!.stats.confirmed_jobs}</div>
                <div className="text-[10px] text-gray-500">Confirmed</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-2 text-center">
                <div className="text-lg font-bold text-gray-900">
                  {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(parseFloat(clientHistoryData!.stats.total_confirmed_value))}
                </div>
                <div className="text-[10px] text-gray-500">Confirmed Value</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-2 text-center">
                <div className="text-lg font-bold text-red-500">{clientHistoryData!.stats.lost_jobs}</div>
                <div className="text-[10px] text-gray-500">Lost</div>
              </div>
            </div>

            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">{clientHistoryData!.band_history ? 'Client Jobs' : 'Other Jobs'}</h4>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {clientHistoryData!.jobs.map((j) => {
                const pStatus = j.pipeline_status;
                const pConfig = pStatus ? PIPELINE_STATUS_CONFIG[pStatus as PipelineStatus] : null;
                // Fallback to HireHop status for completed/cancelled/dispatched etc.
                const hhStatusBadge = !pConfig && j.status != null ? (() => {
                  const HH_STATUS_MAP: Record<number, { label: string; colour: string }> = {
                    3: { label: 'Prepped', colour: '#8B5CF6' },
                    4: { label: 'Part Dispatched', colour: '#F97316' },
                    5: { label: 'On Hire', colour: '#0EA5E9' },
                    6: { label: 'Returned (Incomplete)', colour: '#F59E0B' },
                    7: { label: 'Returned', colour: '#6366F1' },
                    8: { label: 'Needs Attention', colour: '#EF4444' },
                    9: { label: 'Cancelled', colour: '#9CA3AF' },
                    10: { label: 'Not Interested', colour: '#6B7280' },
                    11: { label: 'Completed', colour: '#059669' },
                  };
                  return HH_STATUS_MAP[j.status] || null;
                })() : null;
                const badge = pConfig || hhStatusBadge;
                return (
                  <Link
                    key={j.id}
                    to={`/jobs/${j.id}`}
                    className="block bg-gray-50 rounded-lg p-2.5 text-xs hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      {j.hh_job_number ? (
                        <a
                          href={`https://myhirehop.com/job.php?id=${j.hh_job_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          J-{j.hh_job_number}
                        </a>
                      ) : (
                        <span className="text-gray-400">NEW</span>
                      )}
                      {badge && (
                        <span
                          className="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                          style={{ backgroundColor: badge.colour + '20', color: badge.colour }}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className="font-medium text-gray-900 truncate">{j.job_name || 'Untitled'}</div>
                    {j.job_date && (
                      <div className="text-gray-400 mt-0.5">
                        {new Date(j.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                    )}
                    {j.job_value != null && (
                      <div className="text-gray-600 font-medium mt-0.5">
                        {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(j.job_value)}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>

            {/* Band History Section */}
            {clientHistoryData!.band_history && parseInt(clientHistoryData!.band_history.stats.total_jobs) > 0 && (
              <>
                <div className="border-t border-purple-200 my-4" />
                <h4 className="text-sm font-semibold text-purple-700 mb-3">
                  Band History — {clientHistoryData!.band_history.band_info?.name || 'Unknown'}
                </h4>

                {clientHistoryData!.band_history.band_info?.do_not_hire && (
                  <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                      <span className="text-sm font-bold text-red-700">DO NOT HIRE</span>
                    </div>
                    {clientHistoryData!.band_history.band_info.do_not_hire_reason && (
                      <p className="text-xs text-red-600 mt-1">{clientHistoryData!.band_history.band_info.do_not_hire_reason}</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 mb-4">
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-gray-900">{clientHistoryData!.band_history.stats.total_jobs}</div>
                    <div className="text-[10px] text-gray-500">Total Jobs</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-green-600">{clientHistoryData!.band_history.stats.confirmed_jobs}</div>
                    <div className="text-[10px] text-gray-500">Confirmed</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-gray-900">
                      {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(parseFloat(clientHistoryData!.band_history.stats.total_confirmed_value))}
                    </div>
                    <div className="text-[10px] text-gray-500">Confirmed Value</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-red-500">{clientHistoryData!.band_history.stats.lost_jobs}</div>
                    <div className="text-[10px] text-gray-500">Lost</div>
                  </div>
                </div>

                <h5 className="text-xs font-semibold text-purple-500 uppercase mb-2">Band Jobs</h5>
                <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                  {clientHistoryData!.band_history.jobs.map((bj) => {
                    const pStatus = bj.pipeline_status;
                    const pConfig = pStatus ? PIPELINE_STATUS_CONFIG[pStatus as PipelineStatus] : null;
                    const hhStatusBadge = !pConfig && bj.status != null ? (() => {
                      const HH_STATUS_MAP: Record<number, { label: string; colour: string }> = {
                        3: { label: 'Prepped', colour: '#8B5CF6' },
                        4: { label: 'Part Dispatched', colour: '#F97316' },
                        5: { label: 'On Hire', colour: '#0EA5E9' },
                        6: { label: 'Returned (Incomplete)', colour: '#F59E0B' },
                        7: { label: 'Returned', colour: '#6366F1' },
                        8: { label: 'Needs Attention', colour: '#EF4444' },
                        9: { label: 'Cancelled', colour: '#9CA3AF' },
                        10: { label: 'Not Interested', colour: '#6B7280' },
                        11: { label: 'Completed', colour: '#059669' },
                      };
                      return HH_STATUS_MAP[bj.status] || null;
                    })() : null;
                    const badge = pConfig || hhStatusBadge;
                    return (
                      <Link
                        key={bj.id}
                        to={`/jobs/${bj.id}`}
                        className="block bg-purple-50 rounded-lg p-2.5 text-xs hover:bg-purple-100 transition-colors border border-purple-200"
                      >
                        <div className="flex items-center justify-between mb-1">
                          {bj.hh_job_number ? (
                            <a
                              href={`https://myhirehop.com/job.php?id=${bj.hh_job_number}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-purple-600 hover:text-purple-700 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              J-{bj.hh_job_number}
                            </a>
                          ) : (
                            <span className="text-gray-400">NEW</span>
                          )}
                          {badge && (
                            <span
                              className="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                              style={{ backgroundColor: badge.colour + '20', color: badge.colour }}
                            >
                              {badge.label}
                            </span>
                          )}
                        </div>
                        <div className="font-medium text-gray-900 truncate">{bj.job_name || 'Untitled'}</div>
                        {bj.job_date && (
                          <div className="text-gray-400 mt-0.5">
                            {new Date(bj.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </div>
                        )}
                        {bj.job_value != null && (
                          <div className="text-gray-600 font-medium mt-0.5">
                            {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(bj.job_value)}
                          </div>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── File Viewer Modal ─────────────────────────────────────────────────────

function FileViewerModal({
  file,
  onClose,
}: {
  file: FileAttachment | null;
  onClose: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadFile = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
    } catch {
      setError('Failed to load file');
    } finally {
      setLoading(false);
    }
  }, [file]);

  useEffect(() => {
    loadFile();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!file) return null;

  const previewType = isPreviewable(file.name);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{file.name}</h3>
            {file.label && (
              <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${fileTagColour(file.label)}`}>
                {file.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {objectUrl && (
              <a
                href={objectUrl}
                download={file.name}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Download
              </a>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>

        {/* Comment */}
        {file.comment && (
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
            <p className="text-sm text-gray-600">{file.comment}</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center min-h-[300px]">
          {loading && (
            <div className="animate-spin h-8 w-8 border-4 border-ooosh-600 border-t-transparent rounded-full" />
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {objectUrl && previewType === 'image' && (
            <img src={objectUrl} alt={file.name} className="max-w-full max-h-[70vh] object-contain" />
          )}
          {objectUrl && previewType === 'pdf' && (
            <iframe
              src={objectUrl}
              title={file.name}
              className="w-full h-[70vh] border-0"
            />
          )}
          {objectUrl && !previewType && (
            <div className="text-center">
              <p className="text-sm text-gray-500 mb-3">Preview not available for this file type.</p>
              <a
                href={objectUrl}
                download={file.name}
                className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700"
              >
                Download File
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Overview / Prep Checklist (API-backed) ───────────────────────────────

interface RequirementTypeDef {
  type: string;
  label: string;
  icon: string;
  steps: string[] | null;
  sort_order: number;
}

interface RequirementTemplate {
  id: string;
  name: string;
  description: string | null;
  requirement_types: string[];
}

// JobRequirement, DerivedFlags, SeatAvailability, PREP_STATUS_CONFIG, PREP_STATUS_ORDER
// now imported from '../components/RequirementCard'

function OverviewFinancialStrip({ jobId }: { jobId: string }) {
  const [data, setData] = useState<{
    hire_value_inc_vat: number; total_hire_deposits: number;
    balance_outstanding: number; deposit_percent: number; deposit_paid: boolean;
  } | null>(null);

  useEffect(() => {
    setData(null);
    api.get<{ data: { financial: any } }>(`/money/${jobId}/summary`)
      .then(res => {
        const f = res.data.financial;
        if (f.hire_value_inc_vat > 0) {
          setData({
            hire_value_inc_vat: f.hire_value_inc_vat,
            total_hire_deposits: f.total_hire_deposits,
            balance_outstanding: f.balance_outstanding,
            deposit_percent: f.deposit_percent,
            deposit_paid: f.deposit_paid,
          });
        }
      })
      .catch(() => {});
  }, [jobId]);

  if (!data) return null;

  const state = getPaymentState(data);
  const stateClass = PAYMENT_STATE_CLASSES[state].text;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>Payment: £{data.total_hire_deposits.toFixed(2)} of £{data.hire_value_inc_vat.toFixed(2)}</span>
            <span className={`${stateClass} font-medium`}>
              {PAYMENT_STATE_LABELS[state]}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                data.deposit_percent >= 100 ? 'bg-green-500' : data.deposit_paid ? 'bg-ooosh-500' : 'bg-amber-500'
              }`}
              style={{ width: `${Math.min(100, data.deposit_percent)}%` }}
            />
          </div>
        </div>
        {data.balance_outstanding > 0 && (
          <span className="text-xs font-semibold text-red-600 whitespace-nowrap">
            £{data.balance_outstanding.toFixed(2)} outstanding
          </span>
        )}
      </div>
    </div>
  );
}


function JobPrepChecklist({ jobId, hhJobNumber, pipelineStatus, derivedFlags, seatAvailability, hasCrewQuotes, hasCrewOnHH, onOpenCrewCalculator }: {
  jobId: string;
  hhJobNumber?: number | null;
  pipelineStatus?: string | null;
  derivedFlags?: {
    has_vehicle: boolean; vehicle_count: number; vehicle_types: string[];
    vehicle_slots?: Array<{ item_id: number; slot_index: number; item_name: string; mode: 'self_drive' | 'van_and_driver' }>;
    self_drive_count?: number;
    van_and_driver_count?: number;
    seat_config: 'round_table' | 'forward_facing' | null;
    has_backline: boolean; backline_item_count: number;
    has_rehearsal: boolean; has_staging: boolean; has_pa: boolean; has_lighting: boolean; has_crew_items: boolean; crew_item_count: number;
    total_prep_time_mins: number;
    prep_time_by_category: { vehicles: number; backline: number; rehearsals: number; other: number };
  } | null;
  seatAvailability?: {
    required: string;
    matchingVans: Array<{ reg: string; seat_layout: string | null }>;
    nonMatchingVans: Array<{ reg: string; seat_layout: string | null }>;
    unknownVans: Array<{ reg: string }>;
  } | null;
  hasCrewQuotes?: boolean;
  hasCrewOnHH?: boolean;
  onOpenCrewCalculator?: () => void;
}) {
  const [requirements, setRequirements] = useState<JobRequirement[]>([]);
  const [types, setTypes] = useState<RequirementTypeDef[]>([]);
  const [templates, setTemplates] = useState<RequirementTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [isVanAndDriver, setIsVanAndDriver] = useState(false);
  // Local copy of derived flags so per-slot toggles can update the UI without a page refresh.
  // Seeded from the parent prop; refreshed from the PATCH response on every slot/toggle change.
  const [localFlags, setLocalFlags] = useState<typeof derivedFlags>(derivedFlags);
  useEffect(() => { setLocalFlags(derivedFlags); }, [derivedFlags]);
  const effectiveFlags = localFlags || derivedFlags;
  // Phase initial value: prefer ?phase= query param (so inbox links land on
  // the toggle that actually contains the requirement they're chasing), else
  // default to post_hire only once OP says the job has actually left
  // (pipeline_status = dispatched or beyond). HH jumps to status 4/5 the
  // moment items get checked out, but OP holds at 'prepped' until staff
  // explicitly mark dispatched — staying on Pre-Hire until then avoids the
  // trap of staff seeing two backline cards and ticking the wrong one.
  const phaseParam = new URLSearchParams(window.location.search).get('phase');
  const POST_HIRE_PIPELINE_STATUSES = ['dispatched', 'returned_incomplete', 'returned', 'completed', 'cancelled'];
  const initialPhase: 'pre_hire' | 'post_hire' =
    phaseParam === 'pre_hire' || phaseParam === 'post_hire'
      ? phaseParam
      : (pipelineStatus && POST_HIRE_PIPELINE_STATUSES.includes(pipelineStatus)) ? 'post_hire' : 'pre_hire';
  const [phase, setPhase] = useState<'pre_hire' | 'post_hire'>(initialPhase);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Click outside to dismiss Add Requirement menu
  useEffect(() => {
    if (!showAddMenu) return;
    function handleClick(e: MouseEvent) {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAddMenu]);

  useEffect(() => {
    loadAll();
    // Load van & driver flag
    api.get<{ isVanAndDriver: boolean }>(`/hirehop/jobs/${jobId}/derived-flags`)
      .then(d => setIsVanAndDriver(d.isVanAndDriver || false))
      .catch(() => {});
  }, [jobId, phase]);

  async function loadAll() {
    setLoading(true);
    try {
      const [reqRes, typesRes, tmplRes] = await Promise.all([
        api.get<{ data: JobRequirement[] }>(`/requirements/job/${jobId}?phase=${phase}`),
        api.get<{ data: RequirementTypeDef[] }>('/requirements/types'),
        api.get<{ data: RequirementTemplate[] }>('/requirements/templates'),
      ]);
      setRequirements(reqRes.data);
      setTypes(typesRes.data);
      setTemplates(tmplRes.data);
    } catch (err) {
      console.error('Failed to load requirements:', err);
    } finally {
      setLoading(false);
    }
  }

  // Apply the result of a toggle/slot PATCH: update flags, van-and-driver flag,
  // reload requirement list, and open crew calculator if job just became fully V&D.
  async function applyDerivationResult(derivation: { flags?: typeof derivedFlags } | undefined) {
    const flags = derivation?.flags;
    if (flags) {
      setLocalFlags(flags);
      const allVanAndDriver = !!(flags.has_vehicle && flags.self_drive_count === 0);
      setIsVanAndDriver(allVanAndDriver);
      await loadAll();
      if (allVanAndDriver && !hasCrewQuotes && !hasCrewOnHH && onOpenCrewCalculator) {
        onOpenCrewCalculator();
      }
    } else {
      await loadAll();
    }
  }

  async function toggleVanAndDriver() {
    try {
      const data = await api.patch<{ derivation?: { flags?: typeof derivedFlags } }>(
        `/hirehop/jobs/${jobId}/van-and-driver`,
        { isVanAndDriver: !isVanAndDriver }
      );
      await applyDerivationResult(data.derivation);
    } catch (err) {
      console.error('Failed to toggle van & driver:', err);
    }
  }

  async function changeSlotMode(itemId: number, slotIndex: number, mode: 'self_drive' | 'van_and_driver') {
    try {
      const data = await api.patch<{ derivation?: { flags?: typeof derivedFlags } }>(
        `/hirehop/jobs/${jobId}/vehicle-slot-mode`,
        { itemId, slotIndex, mode }
      );
      await applyDerivationResult(data.derivation);
    } catch (err) {
      console.error('Failed to change slot mode:', err);
    }
  }

  // Reminder form state
  const [showReminderForm, setShowReminderForm] = useState(false);
  const [reminderText, setReminderText] = useState('');
  const [reminderDate, setReminderDate] = useState('');
  const [reminderDelivery, setReminderDelivery] = useState<'both' | 'notification' | 'email'>('both');
  const [reminderAssignees, setReminderAssignees] = useState<string[]>(['']);
  const [reminderEventTrigger, setReminderEventTrigger] = useState('');
  const [reminderUsers, setReminderUsers] = useState<Array<{ id: string; first_name: string; last_name: string }>>([]);

  async function addRequirement(typeKey: string) {
    if (typeKey === 'reminder') {
      // Show form instead of creating immediately
      setShowAddMenu(false);
      setShowReminderForm(true);
      setReminderText('');
      setReminderDate('');
      setReminderDelivery('both');
      setReminderAssignees(['']);
      setReminderEventTrigger('');
      if (reminderUsers.length === 0) {
        api.get<{ data: Array<{ id: string; first_name: string; last_name: string }> }>('/users')
          .then(res => setReminderUsers(res.data))
          .catch(() => {});
      }
      return;
    }
    try {
      await api.post(`/requirements/job/${jobId}`, { requirement_type: typeKey, phase });
      await loadAll();
      setShowAddMenu(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add';
      console.error('Failed to add requirement:', msg);
    }
  }

  async function createReminder() {
    if (!reminderText.trim()) return;
    try {
      const validAssignees = reminderAssignees.filter(id => id);

      // Create one requirement per assignee (or one for self if none selected)
      const targets = validAssignees.length > 0 ? validAssignees : [null];
      for (const assignee of targets) {
        await api.post(`/requirements/job/${jobId}`, {
          requirement_type: 'reminder',
          phase,
          custom_label: reminderText.trim(),
          due_date: reminderDate || null,
          assigned_to: assignee,
          notes: reminderText.trim(),
          event_trigger: reminderEventTrigger || null,
          delivery_method: reminderDelivery,
        });
      }
      await loadAll();
      setShowReminderForm(false);
    } catch (err) {
      console.error('Failed to create reminder:', err);
    }
  }

  async function applyTemplate(templateId: string) {
    try {
      await api.post(`/requirements/job/${jobId}/template/${templateId}`, {});
      await loadAll();
      setShowAddMenu(false);
    } catch (err) {
      console.error('Failed to apply template:', err);
    }
  }

  async function updateRequirement(reqId: string, updates: Record<string, unknown>) {
    try {
      await api.patch(`/requirements/${reqId}`, updates);
      // Optimistic update
      setRequirements(prev => prev.map(r =>
        r.id === reqId ? { ...r, ...updates, updated_at: new Date().toISOString() } as JobRequirement : r
      ));
    } catch (err) {
      console.error('Failed to update requirement:', err);
      await loadAll(); // Revert on error
    }
  }

  async function changeStatus(reqId: string, newStatus: JobRequirement['status']) {
    await updateRequirement(reqId, { status: newStatus });
  }

  async function advanceStep(reqId: string) {
    const req = requirements.find(r => r.id === reqId);
    if (!req?.type_steps || !req.current_step) return;
    const idx = req.type_steps.indexOf(req.current_step);
    if (idx < req.type_steps.length - 1) {
      const nextStep = req.type_steps[idx + 1];
      const isLast = idx + 1 === req.type_steps.length - 1;
      await updateRequirement(reqId, {
        current_step: nextStep,
        status: isLast ? 'done' : 'in_progress',
      });
    }
  }

  async function removeRequirement(reqId: string, reason?: string) {
    try {
      const url = reason
        ? `/requirements/${reqId}?reason=${encodeURIComponent(reason)}`
        : `/requirements/${reqId}`;
      await api.delete(url);
      setRequirements(prev => prev.filter(r => r.id !== reqId));
    } catch (err) {
      console.error('Failed to remove requirement:', err);
    }
  }

  // VD-suspended requirements (hire forms / excess auto-suspended when every
  // van slot is Van & Driver) are listed below as greyed "Not required" stubs
  // but shouldn't move the progress meter or count as "blocked" — they're
  // not a problem, they just don't apply on this job.
  const isVdSuspended = (r: JobRequirement) => r.notes?.includes('[Suspended: Van & Driver]') === true;
  const countableReqs = requirements.filter(r => !isVdSuspended(r));
  const doneCount = countableReqs.filter(r => r.status === 'done').length;
  const blockedCount = countableReqs.filter(r => r.status === 'blocked').length;
  const totalCount = countableReqs.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const availableTypes = types.filter(t => t.type === 'custom' || !requirements.some(r => r.requirement_type === t.type));

  if (loading) {
    return <div className="text-center text-sm text-gray-500 py-8">Loading prep checklist...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header with phase toggle + progress */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4">
          <h3 className="text-lg font-semibold text-gray-900">Job Requirements</h3>
          {/* Phase toggle */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setPhase('pre_hire')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                phase === 'pre_hire' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Pre-Hire
            </button>
            <button
              onClick={() => setPhase('post_hire')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                phase === 'post_hire' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Post-Hire
            </button>
          </div>
          {totalCount > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${blockedCount > 0 ? 'bg-red-500' : progressPct === 100 ? 'bg-green-500' : 'bg-amber-400'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-sm text-gray-500">
                {doneCount}/{totalCount}
                {blockedCount > 0 && <span className="text-red-600 ml-1">({blockedCount} blocked)</span>}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => addRequirement('reminder')}
            className="px-3 py-1.5 text-sm border border-ooosh-200 text-ooosh-600 rounded-lg hover:bg-ooosh-50"
          >
            + Reminder
          </button>
          <div className="relative" ref={addMenuRef}>
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700"
          >
            + Add Job Requirement
          </button>
          {showAddMenu && (
            <div className="absolute right-0 mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-10 py-1 max-h-96 overflow-y-auto">
              {/* Templates section */}
              {templates.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Quick Add (Templates)</div>
                  {templates.map((tmpl) => (
                    <button
                      key={`tmpl-${tmpl.id}`}
                      onClick={() => applyTemplate(tmpl.id)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span className="text-base">📋</span>
                      <div>
                        <span className="font-medium">{tmpl.name}</span>
                        <span className="text-xs text-gray-400 ml-2">{tmpl.requirement_types.length} items</span>
                      </div>
                    </button>
                  ))}
                  {availableTypes.length > 0 && (
                    <div className="border-t border-gray-100 my-1" />
                  )}
                </>
              )}
              {/* Individual requirement types */}
              {availableTypes.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Individual</div>
                  {availableTypes.map((t) => (
                    <button
                      key={t.type}
                      onClick={() => addRequirement(t.type)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span>{t.icon}</span>
                      <span>{t.label}</span>
                      {t.steps && <span className="text-xs text-gray-400 ml-auto">{t.steps.length} steps</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Requirements list */}
      {requirements.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-500 text-sm">No requirements added yet.</p>
          <p className="text-gray-400 text-xs mt-1">Click "+ Add Job Requirement" to get started, or sync from HireHop.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(() => {
            // Group: hire_forms and excess nest under vehicle
            const nestedTypes = new Set(['hire_forms', 'excess']);
            const hasVehicle = requirements.some(r => r.requirement_type === 'vehicle');
            const cards: JSX.Element[] = [];

            for (const req of requirements) {
              // Skip nested types — they'll be rendered after the vehicle card
              if (hasVehicle && nestedTypes.has(req.requirement_type)) continue;

              cards.push(
                <RequirementCard
                  key={req.id}
                  req={req}
                  derivedFlags={effectiveFlags}
                  seatAvailability={seatAvailability}
                  jobId={jobId}
                  hhJobNumber={hhJobNumber}
                  isVanAndDriver={isVanAndDriver}
                  onStatusChange={changeStatus}
                  onAdvanceStep={advanceStep}
                  onRemove={removeRequirement}
                  onVanAndDriverToggle={req.requirement_type === 'vehicle' ? toggleVanAndDriver : undefined}
                  onSlotModeChange={req.requirement_type === 'vehicle' ? changeSlotMode : undefined}
                  onReload={loadAll}
                />
              );

              // After vehicle card, render nested hire_forms + excess
              if (req.requirement_type === 'vehicle') {
                const nested = requirements.filter(r => nestedTypes.has(r.requirement_type));
                for (const nr of nested) {
                  cards.push(
                    <RequirementCard
                      key={nr.id}
                      req={nr}
                      derivedFlags={effectiveFlags}
                      isNested
                      jobId={jobId}
                      hhJobNumber={hhJobNumber}
                      onStatusChange={changeStatus}
                      onAdvanceStep={advanceStep}
                      onRemove={removeRequirement}
                      onReload={loadAll}
                    />
                  );
                }
              }
            }

            // If no vehicle card, still show hire_forms/excess at their normal position
            if (!hasVehicle) {
              // They weren't skipped, so they're already in the loop
            }

            return cards;
          })()}
        </div>
      )}

      {/* Reminder creation form modal */}
      {showReminderForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowReminderForm(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-[420px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Add Reminder</h3>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="What needs to be done?"
                value={reminderText}
                onChange={e => setReminderText(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                autoFocus
              />

              {/* Due date (no past dates) */}
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={reminderDate}
                  min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                  onChange={e => setReminderDate(e.target.value)}
                  className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm"
                />
                <div className="flex gap-1">
                  {[{ label: '1w', days: 7 }, { label: '2w', days: 14 }, { label: '1m', days: 30 }].map(p => (
                    <button key={p.label} type="button"
                      onClick={() => setReminderDate(new Date(Date.now() + p.days * 86400000).toISOString().split('T')[0])}
                      className="px-1.5 py-0.5 text-[10px] border border-gray-200 rounded text-gray-500 hover:bg-gray-100"
                    >{p.label}</button>
                  ))}
                </div>
              </div>

              {/* Delivery method */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Notify via</label>
                <select
                  value={reminderDelivery}
                  onChange={e => setReminderDelivery(e.target.value as 'both' | 'notification' | 'email')}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                >
                  <option value="both">Bell + Email</option>
                  <option value="notification">Bell only</option>
                  <option value="email">Email only</option>
                </select>
              </div>

              {/* Event trigger (optional) */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Also notify me if...</label>
                <select
                  value={reminderEventTrigger}
                  onChange={e => setReminderEventTrigger(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                >
                  <option value="">No event trigger</option>
                  <option value="confirmed">This job confirms</option>
                  <option value="cancelled">This job is cancelled</option>
                  <option value="lost">This job is lost</option>
                </select>
              </div>

              {/* Assignees (multi-user) */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Notify</label>
                {reminderAssignees.map((assignee, idx) => (
                  <div key={idx} className="flex items-center gap-1 mb-1">
                    <select
                      value={assignee}
                      onChange={e => {
                        const updated = [...reminderAssignees];
                        updated[idx] = e.target.value;
                        setReminderAssignees(updated);
                      }}
                      className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm"
                    >
                      <option value="">Me</option>
                      {reminderUsers.map(u => (
                        <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                      ))}
                    </select>
                    {reminderAssignees.length > 1 && (
                      <button type="button" onClick={() => setReminderAssignees(reminderAssignees.filter((_, i) => i !== idx))}
                        className="text-red-400 hover:text-red-600 text-xs px-1">&times;</button>
                    )}
                  </div>
                ))}
                <button type="button"
                  onClick={() => setReminderAssignees([...reminderAssignees, ''])}
                  className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                >+ Add person</button>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowReminderForm(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button
                onClick={createReminder}
                disabled={!reminderText.trim()}
                className="px-4 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
              >Add Reminder</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Files Section ─────────────────────────────────────────────────────────

function JobFilesSection({
  jobId,
  files,
  onFilesChanged,
}: {
  jobId: string;
  files: FileAttachment[];
  onFilesChanged: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [fileComment, setFileComment] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [viewingFile, setViewingFile] = useState<FileAttachment | null>(null);
  const [emailingFile, setEmailingFile] = useState<FileAttachment | null>(null);

  // Post-save metadata edit — keyed on file URL because that's stable
  // across re-renders (label/comment shift around as users edit).
  const [editingFileUrl, setEditingFileUrl] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editComment, setEditComment] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (file: FileAttachment) => {
    setEditingFileUrl(file.url);
    setEditLabel(file.label || '');
    setEditComment(file.comment || '');
  };
  const cancelEdit = () => {
    setEditingFileUrl(null);
    setEditLabel('');
    setEditComment('');
  };
  const saveEdit = async (file: FileAttachment) => {
    setSavingEdit(true);
    setError('');
    try {
      await api.patch('/files/update-metadata', {
        entity_type: 'jobs',
        entity_id: jobId,
        file_url: file.url,
        updates: {
          label: editLabel.trim() || null,
          comment: editComment.trim() || null,
        },
      });
      cancelEdit();
      onFilesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update file');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleShare = async (file: FileAttachment) => {
    try {
      await api.patch('/files/update-metadata', {
        entity_type: 'jobs',
        entity_id: jobId,
        file_url: file.url,
        updates: { share_with_freelancer: !file.share_with_freelancer },
      });
      onFilesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update share status');
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('entity_type', 'jobs');
      formData.append('entity_id', jobId);
      if (selectedTag) formData.append('label', selectedTag);
      if (fileComment.trim()) formData.append('comment', fileComment.trim());

      await api.upload('/files/upload', formData);
      setSelectedTag('');
      setFileComment('');
      onFilesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (fileUrl: string) => {
    if (!confirm('Delete this file?')) return;
    setDeleting(fileUrl);
    try {
      await api.deleteWithBody('/files/delete', {
        key: fileUrl,
        entity_type: 'jobs',
        entity_id: jobId,
      });
      onFilesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const existingTags = [...new Set(files.map(f => f.label).filter(Boolean))] as string[];
  const filteredFiles = filterTag
    ? files.filter(f => f.label === filterTag)
    : files;

  return (
    <div className="space-y-6">
      {/* Upload section */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Upload File</h3>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Tag</label>
              <select
                value={selectedTag}
                onChange={(e) => setSelectedTag(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="">No tag</option>
                {FILE_TAGS.map(tag => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-500 mb-1">Comment</label>
              <input
                type="text"
                value={fileComment}
                onChange={(e) => setFileComment(e.target.value)}
                placeholder="Optional note about this file..."
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleUpload}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp,.svg,.zip,.rar"
                className="hidden"
                id="file-upload"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading...' : 'Choose File'}
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400">PDF, images, docs, spreadsheets. Max 10MB. Images and PDFs can be viewed inline.</p>
        </div>
      </div>

      {/* File list */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700">
            Files {files.length > 0 && `(${files.length})`}
          </h3>
          {existingTags.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400">Filter:</span>
              <button
                onClick={() => setFilterTag('')}
                className={`text-xs px-2 py-0.5 rounded ${
                  !filterTag ? 'bg-ooosh-100 text-ooosh-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                All
              </button>
              {existingTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(tag === filterTag ? '' : tag)}
                  className={`text-xs px-2 py-0.5 rounded ${
                    filterTag === tag ? 'bg-ooosh-100 text-ooosh-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {filteredFiles.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            {files.length === 0 ? 'No files uploaded yet' : 'No files match this filter'}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredFiles.map((file, idx) => {
              const canPreview = isPreviewable(file.name);
              const isEditing = editingFileUrl === file.url;
              return (
                <div
                  key={file.url || idx}
                  className="flex items-start justify-between p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 group"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                      file.type === 'image' ? 'bg-purple-100 text-purple-600' :
                      file.type === 'document' ? 'bg-blue-100 text-blue-600' :
                      'bg-gray-100 text-gray-500'
                    }`}>
                      {file.type === 'image' ? 'IMG' : file.type === 'document' ? 'DOC' : 'FILE'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setViewingFile(file)}
                          className="text-sm font-medium text-gray-900 hover:text-ooosh-600 truncate text-left"
                        >
                          {file.name}
                          {canPreview && (
                            <span className="text-xs text-gray-400 ml-1">(click to view)</span>
                          )}
                        </button>
                        {!isEditing && file.label && (
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${fileTagColour(file.label)}`}>
                            {file.label}
                          </span>
                        )}
                      </div>
                      {isEditing ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-xs text-gray-500">Tag:</label>
                            <select
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                            >
                              <option value="">No tag</option>
                              {FILE_TAGS.map(tag => (
                                <option key={tag} value={tag}>{tag}</option>
                              ))}
                              {/* Preserve a custom value not in the standard list */}
                              {editLabel && !FILE_TAGS.includes(editLabel as typeof FILE_TAGS[number]) && (
                                <option value={editLabel}>{editLabel}</option>
                              )}
                            </select>
                          </div>
                          <input
                            type="text"
                            value={editComment}
                            onChange={(e) => setEditComment(e.target.value)}
                            placeholder="Comment / note about this file"
                            className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => saveEdit(file)}
                              disabled={savingEdit}
                              className="text-xs px-3 py-1 bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                            >
                              {savingEdit ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              onClick={cancelEdit}
                              disabled={savingEdit}
                              className="text-xs px-3 py-1 text-gray-600 hover:bg-gray-100 rounded"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {file.comment && (
                            <p className="text-xs text-gray-500 mt-0.5 truncate">{file.comment}</p>
                          )}
                          <p className="text-xs text-gray-400">
                            {file.uploaded_by} &middot; {new Date(file.uploaded_at).toLocaleDateString('en-GB', {
                              day: 'numeric', month: 'short', year: 'numeric',
                            })}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button
                        onClick={() => handleToggleShare(file)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                          file.share_with_freelancer
                            ? 'bg-green-50 border-green-200 text-green-700'
                            : 'bg-gray-50 border-gray-200 text-gray-400 opacity-0 group-hover:opacity-100'
                        }`}
                        title={file.share_with_freelancer ? 'Shared with freelancers — click to unshare' : 'Share with freelancers'}
                      >
                        {file.share_with_freelancer ? 'Shared' : 'Share'}
                      </button>
                      <button
                        onClick={() => setEmailingFile(file)}
                        className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Email this file"
                      >
                        Email
                      </button>
                      <button
                        onClick={() => startEdit(file)}
                        className="text-xs text-gray-600 hover:text-gray-800 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit tag / comment"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setViewingFile(file)}
                        className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        View
                      </button>
                      <button
                        onClick={() => handleDelete(file.url)}
                        disabled={deleting === file.url}
                        className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        {deleting === file.url ? '...' : 'Delete'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File viewer modal */}
      {viewingFile && (
        <FileViewerModal
          file={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}

      {/* File email modal */}
      {emailingFile && (
        <FileEmailModal
          file={{
            name: emailingFile.name,
            url: emailingFile.url,
            label: emailingFile.label,
            comment: emailingFile.comment,
          }}
          entityType="jobs"
          entityId={jobId}
          contextLabel="Send this file from the job to one or more recipients"
          onClose={() => setEmailingFile(null)}
          onSent={() => {
            setEmailingFile(null);
            onFilesChanged();
          }}
        />
      )}

    </div>
  );
}

// ── Helper Components ─────────────────────────────────────────────────────

function StatusTransitionModal({
  targetStatus,
  saving,
  onConfirm,
  onCancel,
  jobId,
  clientId,
  clientName,
}: {
  targetStatus: PipelineStatus | 'completed';
  saving: boolean;
  onConfirm: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  jobId?: string;
  clientId?: string | null;
  clientName?: string | null;
}) {
  const [holdReason, setHoldReason] = useState<HoldReason>('fully_booked');
  const [holdDetail, setHoldDetail] = useState('');
  const [setRevisit, setSetRevisit] = useState(false);
  const [revisitDate, setRevisitDate] = useState('');
  const [confirmedMethod, setConfirmedMethod] = useState<ConfirmedMethod>('deposit');
  const [lostReason, setLostReason] = useState('Price');
  const [lostDetail, setLostDetail] = useState('');
  const [note, setNote] = useState('');
  const [retroRating, setRetroRating] = useState<'great' | 'ok' | 'issues'>('great');
  const [retroNotes, setRetroNotes] = useState('');
  const [keepRequirementIds, setKeepRequirementIds] = useState<Set<string>>(new Set());

  // Multi-reminder system
  interface Reminder {
    text: string;
    date: string;
    delivery: 'notification' | 'email' | 'both';
    priority: 'normal' | 'high' | 'urgent';
    userId: string; // '' = self
  }
  const [reminders, setReminders] = useState<Reminder[]>([
    { text: '', date: '', delivery: 'both', priority: 'normal', userId: '' },
  ]);
  const [teamUsers, setTeamUsers] = useState<Array<{ id: string; first_name: string; last_name: string; email: string }>>([]);

  // Load team users for "remind someone else"
  useEffect(() => {
    if (targetStatus !== 'completed') return;
    api.get<{ data: Array<{ id: string; first_name: string; last_name: string; email: string }> }>('/users')
      .then(res => setTeamUsers(res.data))
      .catch(() => {});
  }, [targetStatus]);
  const [outstandingItems, setOutstandingItems] = useState<string[]>([]);
  const [upcomingJobs, setUpcomingJobs] = useState<Array<{
    id: string; hh_job_number: number | null; job_name: string | null;
    job_date: string | null; pipeline_status: string | null;
  }>>([]);

  // Fetch outstanding close-out items + upcoming client jobs when completing
  useEffect(() => {
    if (targetStatus !== 'completed' || !jobId) return;

    // Close-out progress
    api.post<{ data: Record<string, { items: Array<{ label: string; status: string }> }> }>(
      '/requirements/closeout-progress', { job_ids: [jobId] }
    ).then(res => {
      const co = res.data[jobId];
      if (co) {
        const outstanding = co.items
          .filter(i => i.status !== 'done')
          .map(i => i.label);
        setOutstandingItems(outstanding);
      }
    }).catch(() => {});

    // Upcoming client jobs
    if (clientId || clientName) {
      const params = clientId
        ? `client_id=${encodeURIComponent(clientId)}&exclude_job_id=${jobId}`
        : `client_name=${encodeURIComponent(clientName!)}&exclude_job_id=${jobId}`;
      api.get<{ data: Array<Record<string, unknown>>; client_info?: Record<string, unknown> }>(
        `/pipeline/client-history?${params}`
      ).then(res => {
        const now = new Date();
        const upcoming = (res.data || [])
          .filter((j: Record<string, unknown>) => {
            const status = j.pipeline_status as string;
            const jobDate = j.job_date ? new Date(j.job_date as string) : null;
            return jobDate && jobDate >= now && status !== 'lost' && status !== 'completed';
          })
          .slice(0, 5)
          .map((j: Record<string, unknown>) => ({
            id: j.id as string,
            hh_job_number: j.hh_job_number as number | null,
            job_name: j.job_name as string | null,
            job_date: j.job_date as string | null,
            pipeline_status: j.pipeline_status as string | null,
          }));
        setUpcomingJobs(upcoming);
      }).catch(() => {});
    }
  }, [targetStatus, jobId, clientId, clientName]);

  const handleSubmit = () => {
    const data: Record<string, unknown> = {};
    if (targetStatus === 'paused') {
      data.hold_reason = holdReason;
      if (holdDetail) data.hold_reason_detail = holdDetail;
      if (setRevisit && revisitDate) data.revisit_date = revisitDate;
    } else if (targetStatus === 'confirmed') {
      data.confirmed_method = confirmedMethod;
    } else if (targetStatus === 'lost') {
      data.lost_reason = lostReason;
      if (lostDetail) data.lost_detail = lostDetail;
      if (keepRequirementIds.size > 0) data.keep_requirement_ids = Array.from(keepRequirementIds);
    } else if (targetStatus === 'completed') {
      data.retro_rating = retroRating;
      if (retroNotes) data.retro_notes = retroNotes;
      // Collect valid reminders (have text + date)
      const validReminders = reminders.filter(r => r.text.trim() && r.date);
      if (validReminders.length > 0) {
        data.retro_follow_up = validReminders[0].text; // backward compat for interaction text
        data.retro_reminders = validReminders.map(r => ({
          text: r.text.trim(),
          date: r.date,
          delivery: r.delivery,
          priority: r.priority,
          user_id: r.userId || null,
        }));
      }
    }
    if (note) data.transition_note = note as string;
    onConfirm(data);
  };

  const config = PIPELINE_STATUS_CONFIG[targetStatus as PipelineStatus] || { label: 'Completed', colour: '#059669' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-4">
          Move to <span style={{ color: config.colour }}>{config.label}</span>
        </h3>

        {targetStatus === 'paused' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">Reason for pausing</label>
            <select
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value as HoldReason)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              {PAUSED_REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {holdReason === 'other' && (
              <input
                type="text"
                placeholder="Details..."
                value={holdDetail}
                onChange={(e) => setHoldDetail(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />
            )}
            <div className="border-t border-gray-200 pt-3 mt-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={setRevisit}
                  onChange={(e) => setSetRevisit(e.target.checked)}
                  className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                />
                Set a revisit date?
              </label>
              <p className="text-xs text-gray-500 mt-1">
                By default, paused jobs drop out of the Chasing pile. Set a date here and it'll come back when due — useful if you want another swing later (e.g. quieter period than expected).
              </p>
              {setRevisit && (
                <input
                  type="date"
                  value={revisitDate}
                  onChange={(e) => setRevisitDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="mt-2 w-full border border-gray-300 rounded px-3 py-2 text-sm"
                />
              )}
            </div>
          </div>
        )}

        {targetStatus === 'confirmed' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">How was this confirmed?</label>
            <select
              value={confirmedMethod}
              onChange={(e) => setConfirmedMethod(e.target.value as ConfirmedMethod)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              <option value="deposit">Deposit received</option>
              <option value="full_payment">Full payment received</option>
              <option value="po">Purchase order received</option>
              <option value="manual">Manual confirmation</option>
            </select>
          </div>
        )}

        {targetStatus === 'lost' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">Why was this lost?</label>
            <select
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              {LOST_REASON_OPTIONS.map((reason) => (
                <option key={reason} value={reason}>{reason}</option>
              ))}
            </select>
            <textarea
              placeholder="Any details..."
              value={lostDetail}
              onChange={(e) => setLostDetail(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
            {jobId && (
              <CancelOpenRequirementsSection
                jobId={jobId}
                targetStatus="lost"
                keepIds={keepRequirementIds}
                onChange={setKeepRequirementIds}
              />
            )}
          </div>
        )}

        {targetStatus === 'completed' && (
          <div className="space-y-3 mb-4">
            {outstandingItems.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
                <div className="font-medium text-amber-800 mb-1">Outstanding close-out items:</div>
                <ul className="text-amber-700 text-xs space-y-0.5">
                  {outstandingItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-amber-600 mt-2">You can still mark as completed — these will remain on the Returns page for follow-up.</p>
              </div>
            )}
            <label className="block text-sm font-medium text-gray-700">Quick retro — how did this job go?</label>
            <div className="flex gap-2">
              {([
                { key: 'great' as const, label: 'Great', colour: 'bg-green-100 text-green-700 border-green-300' },
                { key: 'ok' as const, label: 'OK', colour: 'bg-amber-100 text-amber-700 border-amber-300' },
                { key: 'issues' as const, label: 'Issues', colour: 'bg-red-100 text-red-700 border-red-300' },
              ]).map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setRetroRating(opt.key)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    retroRating === opt.key ? opt.colour + ' ring-2 ring-offset-1 ring-current' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <textarea
              placeholder="Anything to note? Lessons learned, client feedback, things to improve..."
              value={retroNotes}
              onChange={(e) => setRetroNotes(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
            {/* Reminders */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-600">Follow-up reminders</label>
              {reminders.map((rem, idx) => {
                const hasText = rem.text.trim().length > 0;
                return (
                  <div key={idx} className="border border-gray-200 rounded-lg p-2.5 space-y-2 bg-gray-50">
                    <input
                      type="text"
                      placeholder="e.g. 'Chase missing cable', 'Thank client', 'Check summer availability'"
                      value={rem.text}
                      onChange={(e) => {
                        const updated = [...reminders];
                        updated[idx] = { ...rem, text: e.target.value };
                        setReminders(updated);
                      }}
                      className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                    />
                    <div className={`flex items-center gap-2 flex-wrap ${hasText ? '' : 'opacity-40 pointer-events-none'}`}>
                      <input
                        type="date"
                        value={rem.date}
                        min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                        onChange={(e) => {
                          const updated = [...reminders];
                          updated[idx] = { ...rem, date: e.target.value };
                          setReminders(updated);
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 min-w-[120px]"
                      />
                      <div className="flex gap-1">
                        {[{ label: '1m', days: 30 }, { label: '3m', days: 90 }, { label: '6m', days: 180 }].map(p => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => {
                              const updated = [...reminders];
                              updated[idx] = { ...rem, date: new Date(Date.now() + p.days * 86400000).toISOString().split('T')[0] };
                              setReminders(updated);
                            }}
                            className="px-1.5 py-0.5 text-[10px] border border-gray-200 rounded text-gray-500 hover:bg-gray-100"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={`flex items-center gap-2 flex-wrap ${hasText ? '' : 'opacity-40 pointer-events-none'}`}>
                      <select
                        value={rem.priority}
                        onChange={(e) => {
                          const updated = [...reminders];
                          updated[idx] = { ...rem, priority: e.target.value as Reminder['priority'] };
                          setReminders(updated);
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-xs"
                      >
                        <option value="normal">Normal</option>
                        <option value="high">Important</option>
                        <option value="urgent">Urgent</option>
                      </select>
                      <select
                        value={rem.delivery}
                        onChange={(e) => {
                          const updated = [...reminders];
                          updated[idx] = { ...rem, delivery: e.target.value as Reminder['delivery'] };
                          setReminders(updated);
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-xs"
                      >
                        <option value="both">Bell + Email</option>
                        <option value="notification">Bell only</option>
                        <option value="email">Email only</option>
                      </select>
                      <select
                        value={rem.userId}
                        onChange={(e) => {
                          const updated = [...reminders];
                          updated[idx] = { ...rem, userId: e.target.value };
                          setReminders(updated);
                        }}
                        className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 min-w-[100px]"
                      >
                        <option value="">Remind me</option>
                        {teamUsers.map(u => (
                          <option key={u.id} value={u.id}>
                            {u.first_name} {u.last_name}
                          </option>
                        ))}
                      </select>
                      {reminders.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setReminders(reminders.filter((_, i) => i !== idx))}
                          className="text-[10px] text-red-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {reminders.some(r => r.text.trim()) && (
                <button
                  type="button"
                  onClick={() => setReminders([...reminders, { text: '', date: '', delivery: 'both', priority: 'normal', userId: '' }])}
                  className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                >
                  + Add another reminder
                </button>
              )}
            </div>
          </div>
        )}

        {/* Upcoming client jobs (completion context) */}
        {targetStatus === 'completed' && upcomingJobs.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <div className="text-xs font-medium text-blue-800 mb-1.5">
              This client has {upcomingJobs.length} upcoming job{upcomingJobs.length !== 1 ? 's' : ''}:
            </div>
            <div className="space-y-1">
              {upcomingJobs.map(uj => (
                <div key={uj.id} className="flex items-center justify-between text-xs">
                  <span className="text-blue-700 truncate max-w-[200px]">
                    {uj.hh_job_number ? `J-${uj.hh_job_number} ` : ''}{uj.job_name || 'Untitled'}
                  </span>
                  <span className="text-blue-500 whitespace-nowrap ml-2">
                    {uj.job_date ? new Date(uj.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
          <input
            type="text"
            placeholder="Why are you changing the status?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
