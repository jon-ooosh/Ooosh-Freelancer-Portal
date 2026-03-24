import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import ActivityTimeline from '../components/ActivityTimeline';
import TransportCalculator from '../components/TransportCalculator';
import type { FileAttachment, PipelineStatus, HoldReason, ConfirmedMethod } from '@shared/index';
import { PIPELINE_STATUS_CONFIG, HOLD_REASON_LABELS, LOST_REASON_OPTIONS } from '@shared/index';

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
  collection_date: string | null;
  add_collection: boolean;
  what_is_it: string | null;
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
  cancelled_reason: string | null;
  // Assignments
  assignments: QuoteAssignment[];
  // Notes
  internal_notes: string | null;
  freelancer_notes: string | null;
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
  hire_form_pdf_key?: string | null;
  hire_form_generated_at?: string | null;
  excess?: {
    id: string;
    excess_status: string;
    excess_amount_required: number | null;
    excess_amount_taken: number | null;
  } | null;
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

// ── Hire Form PDF Actions (per assignment, in Drivers & Vehicles tab) ────────
function HireFormActions({ assignmentId, pdfKey, pdfGeneratedAt }: {
  assignmentId: string;
  pdfKey?: string | null;
  pdfGeneratedAt?: string | null;
}) {
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
            disabled={generating}
            className="text-xs px-2.5 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50"
          >
            {generating ? '...' : pdfKey ? 'Regenerate PDF' : 'Generate PDF'}
          </button>
          <button
            onClick={() => generatePdf(true)}
            disabled={generating}
            className="text-xs px-2.5 py-1.5 bg-ooosh-100 text-ooosh-700 rounded hover:bg-ooosh-200 disabled:opacity-50"
          >
            {generating ? '...' : 'Generate + Email'}
          </button>
          {pdfKey && (
            <>
              <a
                href={`/api/hire-forms/${assignmentId}/download`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1.5 bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
              >
                View PDF
              </a>
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

// ── Quick Assign Driver + Vehicle to Job (for testing) ──────────────────
function QuickAssignButton({ jobId, jobDate, returnDate, onCreated }: { jobId: string; jobDate?: string; returnDate?: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [hireStart, setHireStart] = useState(jobDate ? jobDate.substring(0, 10) : new Date().toISOString().substring(0, 10));
  const [hireEnd, setHireEnd] = useState(returnDate ? returnDate.substring(0, 10) : '');
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

  async function handleSubmit() {
    if (!driverId || !vehicleId) { setError('Select both driver and vehicle'); return; }
    setSaving(true);
    setError('');
    try {
      await api.post('/hire-forms/quick-assign', {
        driver_id: driverId,
        vehicle_id: vehicleId,
        job_id: jobId,
        hire_start: hireStart || undefined,
        hire_end: hireEnd || undefined,
      });
      setOpen(false);
      setDriverId('');
      setVehicleId('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); loadOptions(); }}
        className="flex items-center gap-1.5 px-3 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium"
      >
        + Assign Driver & Vehicle
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Assign Driver & Vehicle</h3>

            {error && <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded mb-3">{error}</div>}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Driver</label>
                <select value={driverId} onChange={e => setDriverId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">Select driver...</option>
                  {drivers.map(d => (
                    <option key={d.id} value={d.id}>{d.full_name} ({d.email || 'no email'}) — {d.licence_points || 0} pts</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
                <select value={vehicleId} onChange={e => setVehicleId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">Select vehicle...</option>
                  {vehicles.map(v => (
                    <option key={v.id} value={v.id}>{v.reg} — {v.vehicle_type || v.simple_type || 'Unknown'} ({v.hire_status})</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hire Start</label>
                  <input type="date" value={hireStart} onChange={e => setHireStart(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hire End</label>
                  <input type="date" value={hireEnd} onChange={e => setHireEnd(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 text-sm font-medium disabled:opacity-50">
                {saving ? 'Creating...' : 'Create Assignment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = (location.state as { from?: string })?.from || '/jobs';
  const backLabel = backTo === '/pipeline' ? 'Back to Pipeline' : 'Back to Jobs';

  const [job, setJob] = useState<JobDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline' | 'files' | 'transport' | 'drivers' | 'details'>('overview');
  const [showCalculator, setShowCalculator] = useState(false);
  const [quotes, setQuotes] = useState<SavedQuote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [assignModalQuoteId, setAssignModalQuoteId] = useState<string | null>(null);
  const [peopleOptions, setPeopleOptions] = useState<PersonOption[]>([]);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [assignRole, setAssignRole] = useState('driver');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingQuoteId, setEditingQuoteId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, unknown>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [showLocalForm, setShowLocalForm] = useState(false);
  const [localFormData, setLocalFormData] = useState({
    jobType: 'delivery' as 'delivery' | 'collection',
    venueId: '',
    venueName: '',
    jobDate: '',
    arrivalTime: '',
    notes: '',
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
  const [vehicleAssignmentsLoading, setVehicleAssignmentsLoading] = useState(false);
  const [dispatchCheck, setDispatchCheck] = useState<DispatchCheckResult | null>(null);

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
  const [dateOutLinked, setDateOutLinked] = useState(true);
  const [dateReturnLinked, setDateReturnLinked] = useState(true);
  const [editingClient, setEditingClient] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [clientSearchResults, setClientSearchResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [editingValue, setEditingValue] = useState(false);
  const [editValueAmount, setEditValueAmount] = useState('');
  const [editingChaseDate, setEditingChaseDate] = useState(false);
  const [editChaseDate, setEditChaseDate] = useState('');
  const [inlineEditSaving, setInlineEditSaving] = useState(false);
  const [pushingToHH, setPushingToHH] = useState(false);
  const editNameRef = useRef<HTMLInputElement>(null);
  const editHHRef = useRef<HTMLInputElement>(null);
  const editValueRef = useRef<HTMLInputElement>(null);
  const clientSearchRef = useRef<HTMLDivElement>(null);

  // ── Inline edit helpers ──────────────────────────────────────────────────
  function toDateInputValue(dateStr: string | null): string {
    if (!dateStr) return '';
    if (typeof dateStr === 'string' && dateStr.includes('T')) return dateStr.split('T')[0];
    return dateStr;
  }

  async function saveInlineField(patch: Record<string, unknown>) {
    if (!job) return;
    setInlineEditSaving(true);
    try {
      await api.patch(`/pipeline/${job.id}/edit`, patch);
      await loadJob();
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
    // Determine link state from current values
    setDateOutLinked(toDateInputValue(job.out_date) === toDateInputValue(job.job_date));
    setDateReturnLinked(toDateInputValue(job.return_date) === toDateInputValue(job.job_end));
    setEditingDates(true);
  }

  // Date linking handlers (mirrored from PipelinePage New Enquiry form)
  const handleEditOutDate = (val: string) => {
    if (editJobDate && val > editJobDate) return;
    setEditOutDate(val);
    if (dateOutLinked) {
      setEditJobDate(val);
      if (editJobEnd && val > editJobEnd) {
        setEditJobEnd(val);
        if (dateReturnLinked) setEditReturnDate(val);
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
    if (!editJobEnd || editJobEnd < val) {
      setEditJobEnd(val);
      if (dateReturnLinked) setEditReturnDate(val);
    }
  };

  const handleEditJobEnd = (val: string) => {
    if (editJobDate && val < editJobDate) return;
    setEditJobEnd(val);
    if (dateReturnLinked) {
      setEditReturnDate(val);
    } else {
      if (editReturnDate && editReturnDate < val) setEditReturnDate(val);
    }
  };

  const handleEditReturnDate = (val: string) => {
    if (editJobEnd && val < editJobEnd) return;
    setEditReturnDate(val);
    if (dateReturnLinked) {
      setEditJobEnd(val);
    }
  };

  async function saveDates() {
    setEditingDates(false);
    await saveInlineField({
      out_date: editOutDate || null,
      job_date: editJobDate || null,
      job_end: editJobEnd || null,
      return_date: editReturnDate || null,
    });
  }

  function startEditClient() {
    setClientSearch('');
    setClientSearchResults([]);
    setEditingClient(true);
  }

  async function selectClient(org: { id: string; name: string }) {
    setEditingClient(false);
    await saveInlineField({ client_id: org.id, client_name: org.name });
  }

  function startEditValue() {
    if (!job) return;
    setEditValueAmount(job.job_value != null ? String(job.job_value) : '');
    setEditingValue(true);
    setTimeout(() => editValueRef.current?.focus(), 50);
  }

  async function saveEditValue() {
    setEditingValue(false);
    const parsed = parseFloat(editValueAmount);
    await saveInlineField({ job_value: isNaN(parsed) ? null : parsed });
  }

  async function cycleLikelihood() {
    if (!job) return;
    const cycle = ['hot', 'warm', 'cold'] as const;
    const currentIdx = cycle.indexOf((job.likelihood || 'warm') as typeof cycle[number]);
    const nextIdx = (currentIdx + 1) % cycle.length;
    await saveInlineField({ likelihood: cycle[nextIdx] });
  }

  function startEditChaseDate() {
    if (!job) return;
    setEditChaseDate(toDateInputValue(job.next_chase_date));
    setEditingChaseDate(true);
  }

  async function saveEditChaseDate() {
    setEditingChaseDate(false);
    await saveInlineField({ next_chase_date: editChaseDate || null });
  }

  async function pushToHireHop() {
    if (!job) return;
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

  async function handleStatusTransition(targetStatus: PipelineStatus, extraData?: Record<string, string>) {
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
    const needsPrompt = ['paused', 'confirmed', 'lost'].includes(targetStatus);
    if (needsPrompt) {
      setTransitionTarget(targetStatus);
      setShowTransitionModal(true);
    } else {
      handleStatusTransition(targetStatus);
    }
  }

  // Client trading history for sidebar
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
  } | null>(null);

  useEffect(() => {
    if (id) {
      loadJob();
      loadInteractions();
      loadQuotes();
      loadVehicleAssignments();
      loadJobOrgs();
    }
  }, [id]);

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

  // Load client history when job loads
  useEffect(() => {
    if (job && (job.client_id || job.client_name)) {
      const params = job.client_id
        ? `client_id=${encodeURIComponent(job.client_id)}&exclude_job_id=${job.id}`
        : `client_name=${encodeURIComponent(job.client_name!)}&exclude_job_id=${job.id}`;
      api.get<typeof clientHistoryData>(`/pipeline/client-history?${params}`)
        .then(data => setClientHistoryData(data))
        .catch(() => setClientHistoryData(null));
    }
  }, [job?.id, job?.client_id, job?.client_name]);

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

  async function deleteQuote(quoteId: string) {
    try {
      await api.delete(`/quotes/${quoteId}`);
      setQuotes(prev => prev.filter(q => q.id !== quoteId));
      setConfirmingDelete(null);
    } catch {
      console.error('Failed to delete quote');
    }
  }

  function startEditQuote(q: SavedQuote) {
    const dateStr = q.job_date
      ? (typeof q.job_date === 'string' && q.job_date.includes('T') ? q.job_date.split('T')[0] : String(q.job_date))
      : '';
    setEditForm({
      job_type: q.job_type,
      venue_name: q.venue_name || '',
      venue_id: q.venue_id || null,
      job_date: dateStr,
      arrival_time: q.arrival_time || '',
      what_is_it: q.what_is_it || '',
      internal_notes: q.internal_notes || '',
      freelancer_notes: q.freelancer_notes || '',
      client_charge_rounded: Number(q.client_charge_rounded ?? 0),
      freelancer_fee_rounded: Number(q.freelancer_fee_rounded ?? 0),
    });
    setEditingQuoteId(q.id);
  }

  async function saveEditQuote() {
    if (!editingQuoteId) return;
    setEditSaving(true);
    try {
      await api.put(`/quotes/${editingQuoteId}`, editForm);
      await loadQuotes();
      setEditingQuoteId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setEditSaving(false);
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
      const raw = await api.get<{ data: any[] }>(`/assignments?job_id=${id}`);
      // Reshape flat excess columns into nested object
      const shaped: VehicleAssignment[] = raw.data.map((r: any) => ({
        ...r,
        excess: r.excess_id ? {
          id: r.excess_id,
          excess_status: r.excess_status,
          excess_amount_required: r.excess_amount_required,
          excess_amount_taken: r.excess_amount_taken,
        } : null,
      }));
      setVehicleAssignments(shaped);

      // Also load dispatch check
      const check = await api.get<DispatchCheckResult>(`/assignments/dispatch-check/${id}`);
      setDispatchCheck(check);
    } catch {
      console.error('Failed to load vehicle assignments');
    } finally {
      setVehicleAssignmentsLoading(false);
    }
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function formatDateTime(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (!job) {
    return <div className="text-center py-12 text-gray-500">Job not found.</div>;
  }

  // Pipeline status takes precedence for display if available
  const pipelineConfig = job.pipeline_status
    ? PIPELINE_STATUS_CONFIG[job.pipeline_status as PipelineStatus]
    : null;
  const statusLabel = pipelineConfig?.label || STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`;
  const statusColour = pipelineConfig
    ? '' // Using inline style for pipeline status
    : (STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600');
  const hasPipelineStatus = !!job.pipeline_status;

  // Available pipeline statuses for the dropdown (excluding current)
  const PIPELINE_TRANSITIONS: PipelineStatus[] = ['new_enquiry', 'chasing', 'provisional', 'paused', 'confirmed', 'lost'];
  const availableStatuses = PIPELINE_TRANSITIONS.filter(s => s !== job.pipeline_status);
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

      {/* Header Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
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
                        const cfg = PIPELINE_STATUS_CONFIG[s];
                        return (
                          <button
                            key={s}
                            onClick={() => initiateStatusChange(s)}
                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2"
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: cfg.colour }}
                            />
                            {cfg.label}
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
                className="text-2xl font-bold text-gray-900 mt-2 w-full border-b-2 border-ooosh-400 bg-transparent outline-none px-0 py-0.5"
              />
            ) : (
              <h1
                className="text-2xl font-bold text-gray-900 mt-2 cursor-pointer hover:bg-gray-50 rounded px-1 -ml-1 transition-colors group"
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
            <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-600 items-center">
              {/* Client — editable */}
              <div className="relative inline-flex items-center gap-1" ref={clientSearchRef}>
                {(job.client_name || job.company_name) ? (
                  <>
                    {job.client_id ? (
                      <Link to={`/organisations/${job.client_id}`} className="text-ooosh-600 hover:text-ooosh-700">
                        {job.client_name || job.company_name}
                      </Link>
                    ) : (
                      <span>{job.client_name || job.company_name}</span>
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
                ) : (
                  <button
                    onClick={startEditClient}
                    className="text-gray-400 hover:text-ooosh-600 transition-colors text-xs border border-dashed border-gray-300 px-2 py-0.5 rounded"
                  >
                    + Add client
                  </button>
                )}
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
                  {(job.job_end || job.return_date) && job.job_end !== job.job_date && (
                    <> &ndash; {formatDate(job.job_end || job.return_date)}</>
                  )}
                  <button
                    onClick={startEditDates}
                    className="text-gray-300 hover:text-gray-500 transition-colors ml-0.5"
                    title="Edit dates"
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

            {/* Dates editor panel */}
            {editingDates && (
              <div className="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Outgoing</label>
                    <input
                      type="date"
                      value={editOutDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(e) => handleEditOutDate(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Job Start</label>
                    <input
                      type="date"
                      value={editJobDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(e) => handleEditJobDate(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
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
                    <input
                      type="date"
                      value={editJobEnd}
                      min={editJobDate || new Date().toISOString().split('T')[0]}
                      onChange={(e) => handleEditJobEnd(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
                    />
                  </div>
                  <div className="relative">
                    <label className="block text-xs font-medium text-gray-500 mb-1">Returning</label>
                    <input
                      type="date"
                      value={editReturnDate}
                      min={editJobEnd || new Date().toISOString().split('T')[0]}
                      onChange={(e) => handleEditReturnDate(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
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
            {hasPipelineStatus && (
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

                {/* Next Chase Date */}
                <div className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {editingChaseDate ? (
                    <input
                      type="date"
                      value={editChaseDate}
                      onChange={(e) => setEditChaseDate(e.target.value)}
                      onBlur={saveEditChaseDate}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEditChaseDate(); if (e.key === 'Escape') setEditingChaseDate(false); }}
                      className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:ring-ooosh-500 focus:border-ooosh-500"
                      autoFocus
                    />
                  ) : (
                    <button
                      onClick={startEditChaseDate}
                      className={`hover:text-ooosh-600 transition-colors ${
                        job.next_chase_date && new Date(job.next_chase_date) < new Date() ? 'text-red-600 font-semibold' : ''
                      }`}
                      title="Click to set next chase date"
                    >
                      {job.next_chase_date
                        ? `Chase: ${formatDate(job.next_chase_date)}`
                        : 'Set chase date'}
                    </button>
                  )}
                </div>

                {/* Job Value */}
                <div className="inline-flex items-center text-xs">
                  {editingValue ? (
                    <div className="flex items-center gap-0.5">
                      <span className="text-gray-500 font-medium">£</span>
                      <input
                        ref={editValueRef}
                        type="number"
                        value={editValueAmount}
                        onChange={(e) => setEditValueAmount(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveEditValue(); if (e.key === 'Escape') { setEditingValue(false); } }}
                        onBlur={saveEditValue}
                        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs w-24 focus:ring-ooosh-500 focus:border-ooosh-500"
                        step="1"
                        min="0"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={startEditValue}
                      className="font-semibold text-gray-900 hover:text-ooosh-600 transition-colors"
                      title="Click to edit job value"
                    >
                      {job.job_value != null
                        ? `£${job.job_value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : <span className="text-gray-400 font-normal">Set value</span>}
                    </button>
                  )}
                </div>

                {inlineEditSaving && (
                  <span className="text-xs text-gray-400 animate-pulse">Saving...</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hhJobUrl && (
              <a
                href={hhJobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600"
              >
                Open in HireHop &rarr;
              </a>
            )}
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
        <div className="mt-4 pt-4 border-t border-gray-100">
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
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['overview', 'timeline', 'transport', 'drivers', 'files', 'details'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'overview' ? 'Job Requirements' :
               tab === 'timeline' ? 'Activity Timeline' :
               tab === 'transport' ? `Crew & Transport${quotes.length > 0 ? ` (${quotes.length})` : ''}` :
               tab === 'drivers' ? `Drivers & Vehicles${vehicleAssignments.length > 0 ? ` (${vehicleAssignments.length})` : ''}` :
               tab === 'files' ? `Files${fileCount > 0 ? ` (${fileCount})` : ''}` :
               'Full Details'}
            </button>
          ))}
        </nav>
      </div>

      {/* Overview Tab (Prep Checklist) */}
      {activeTab === 'overview' && (
        <JobPrepChecklist jobId={id || ''} />
      )}

      {/* Timeline Tab */}
      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="job_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={loadInteractions}
        />
      )}

      {/* Drivers & Vehicles Tab */}
      {activeTab === 'drivers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Drivers & Vehicles</h3>
            {id && <QuickAssignButton jobId={id} jobDate={job.job_date || undefined} returnDate={job.return_date || undefined} onCreated={loadVehicleAssignments} />}
          </div>

          {/* Referral/excess warnings */}
          {dispatchCheck && dispatchCheck.blockers.length > 0 && (
            <div className="space-y-2">
              {dispatchCheck.blockers.map((b, i) => (
                <div key={i} className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium ${
                  b.type === 'referral_pending'
                    ? 'bg-orange-50 border border-orange-200 text-orange-800'
                    : 'bg-amber-50 border border-amber-200 text-amber-800'
                }`}>
                  <span>{b.type === 'referral_pending' ? '!' : '$'}</span>
                  <span>
                    {b.type === 'referral_pending'
                      ? `Referral pending for ${b.driverName || 'Unknown driver'} (${b.vehicleReg || '?'}) — cannot book out until approved`
                      : `Excess pending for ${b.driverName || 'Unknown driver'} (${b.vehicleReg || '?'})${b.amountRequired ? ` — £${b.amountRequired.toFixed(2)} required` : ''}`
                    }
                  </span>
                </div>
              ))}
            </div>
          )}

          {vehicleAssignmentsLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
            </div>
          ) : vehicleAssignments.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
              <p className="text-gray-400 text-4xl mb-3">🚐</p>
              <p className="text-gray-600 font-medium">No vehicle assignments yet</p>
              <p className="text-sm text-gray-400 mt-1">Vehicle assignments from the Allocations page will appear here</p>
            </div>
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
                                {a.driver_name}
                                {a.driver_email && <span className="text-gray-400 font-normal ml-2">{a.driver_email}</span>}
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
                                {a.excess.excess_amount_required && (
                                  <span className="font-medium text-gray-700">
                                    £{Number(a.excess.excess_amount_required).toFixed(2)}
                                  </span>
                                )}
                                <span className={`px-2 py-0.5 rounded-full font-medium ${
                                  a.excess.excess_status === 'taken' ? 'bg-green-100 text-green-700' :
                                  a.excess.excess_status === 'waived' ? 'bg-blue-100 text-blue-700' :
                                  a.excess.excess_status === 'pending' ? 'bg-amber-100 text-amber-700' :
                                  'bg-gray-100 text-gray-600'
                                }`}>
                                  {a.excess.excess_status === 'taken' ? 'Collected' :
                                   a.excess.excess_status === 'waived' ? 'Waived' :
                                   a.excess.excess_status === 'pending' ? 'Pending' :
                                   a.excess.excess_status}
                                </span>
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
                    </div>

                    {/* Hire Form PDF actions */}
                    {a.assignment_type === 'self_drive' && (
                      <HireFormActions assignmentId={a.id} pdfKey={a.hire_form_pdf_key} pdfGeneratedAt={a.hire_form_generated_at} />
                    )}
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

          {quotesLoading ? (
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
                  draft: { label: 'Draft', bg: 'bg-gray-100', text: 'text-gray-600' },
                  confirmed: { label: 'Confirmed', bg: 'bg-green-100', text: 'text-green-700' },
                  cancelled: { label: 'Cancelled', bg: 'bg-red-100', text: 'text-red-700' },
                  completed: { label: 'Completed', bg: 'bg-emerald-100', text: 'text-emerald-700' },
                };
                const sc = statusConfig[quoteStatus] || statusConfig.draft;

                return (
                <div key={q.id} className={`bg-white rounded-xl shadow-sm border ${isCancelled ? 'border-red-200 opacity-60' : 'border-gray-200'} p-5`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {/* Header row with type, mode badge, status badge */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="text-lg">
                          {q.job_type === 'delivery' ? '📦' : q.job_type === 'collection' ? '📥' : '👷'}
                        </span>
                        <span className="font-semibold text-gray-900 capitalize">
                          {q.job_type}
                          {q.what_is_it ? ` (${q.what_is_it})` : ''}
                          {q.add_collection ? ' + Collection' : ''}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          q.calculation_mode === 'dayrate' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {q.calculation_mode === 'dayrate' ? 'Day Rate' : 'Hourly'}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.bg} ${sc.text}`}>
                          {sc.label}
                        </span>
                      </div>

                      {/* Price summary row */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <span className="text-gray-500">Client Charge</span>
                          <p className="font-bold text-green-700">
                            &pound;{clientCharge.toFixed(2)}
                            {q.add_collection && <span className="text-xs font-normal text-gray-400"> (&times;2 = &pound;{(clientCharge * 2).toFixed(2)})</span>}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500">Freelancer Fee</span>
                          <p className="font-bold text-blue-700">
                            &pound;{freelancerFee.toFixed(2)}
                          </p>
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

                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-gray-500">
                        {q.venue_name && (
                          q.venue_id ? (
                            <Link to={`/venues/${q.venue_id}`} className="text-ooosh-600 hover:text-ooosh-700 hover:underline">📍 {q.venue_name}</Link>
                          ) : (
                            <span>📍 {q.venue_name}</span>
                          )
                        )}
                        {q.distance_miles && <span>{q.distance_miles}mi · {q.drive_time_mins}min</span>}
                        {q.arrival_time && <span>🕐 Arrive by {q.arrival_time}</span>}
                        {q.job_date && <span>📅 {new Date(q.job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                        {q.add_collection && q.collection_date && (
                          <span>📥 Collection: {new Date(q.collection_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                        )}
                        {q.travel_method === 'public_transport' && (
                          <span>🚆 Public transport{q.travel_time_mins ? ` ${q.travel_time_mins}min` : ''}{q.travel_cost ? ` £${Number(q.travel_cost).toFixed(2)}` : ''}</span>
                        )}
                      </div>

                      {/* Crew assignments */}
                      <div className="mt-3 pt-3 border-t border-gray-100">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-medium text-gray-500">Crew</span>
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
                          <p className="text-xs text-gray-400 italic">No crew assigned</p>
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

                    {/* Right side: meta + actions */}
                    <div className="text-right text-xs ml-4 shrink-0 flex flex-col items-end gap-2">
                      <div className="text-gray-400">
                        <p>{new Date(q.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
                        {q.created_by_name && <p>{q.created_by_name}</p>}
                      </div>

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
                              onClick={() => updateQuoteStatus(q.id, 'completed')}
                              className="px-2.5 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700 font-medium"
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

                      {/* Delete button */}
                      {confirmingDelete === q.id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => deleteQuote(q.id)}
                            className="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(null)}
                            className="px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingDelete(q.id)}
                          className="text-gray-300 hover:text-red-500 text-xs"
                          title="Delete quote"
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* Edit Quote Modal */}
          {editingQuoteId && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/50" onClick={() => setEditingQuoteId(null)} />
              <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit Quote</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                    <select
                      value={String(editForm.job_type || '')}
                      onChange={(e) => setEditForm((p) => ({ ...p, job_type: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="delivery">Delivery</option>
                      <option value="collection">Collection</option>
                      <option value="crewed">Crewed</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Venue</label>
                    <input
                      type="text"
                      value={String(editForm.venue_name || '')}
                      onChange={(e) => setEditForm((p) => ({ ...p, venue_name: e.target.value, venue_id: null }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                      <input
                        type="date"
                        value={String(editForm.job_date || '')}
                        onChange={(e) => setEditForm((p) => ({ ...p, job_date: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Time</label>
                      <input
                        type="time"
                        value={String(editForm.arrival_time || '')}
                        onChange={(e) => setEditForm((p) => ({ ...p, arrival_time: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Client Charge</label>
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={Number(editForm.client_charge_rounded ?? 0)}
                        onChange={(e) => setEditForm((p) => ({ ...p, client_charge_rounded: parseFloat(e.target.value) || 0 }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Fee</label>
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={Number(editForm.freelancer_fee_rounded ?? 0)}
                        onChange={(e) => setEditForm((p) => ({ ...p, freelancer_fee_rounded: parseFloat(e.target.value) || 0 }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
                    <textarea
                      value={String(editForm.internal_notes || '')}
                      onChange={(e) => setEditForm((p) => ({ ...p, internal_notes: e.target.value }))}
                      rows={2}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Notes</label>
                    <textarea
                      value={String(editForm.freelancer_notes || '')}
                      onChange={(e) => setEditForm((p) => ({ ...p, freelancer_notes: e.target.value }))}
                      rows={2}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-6 flex justify-end gap-2">
                  <button
                    onClick={() => setEditingQuoteId(null)}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveEditQuote}
                    disabled={editSaving}
                    className="px-4 py-2 bg-ooosh-600 text-white rounded-lg text-sm hover:bg-ooosh-700 font-medium disabled:opacity-50"
                  >
                    {editSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Hire Forms Section (testing) */}
        </div>
      )}

      {/* Full Details Tab */}
      {activeTab === 'details' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailField label="HireHop Job #" value={job.hh_job_number ? String(job.hh_job_number) : 'N/A (Ooosh-native)'} />
            <DetailField label="Job Name" value={job.job_name} />
            <DetailField label="Job Type" value={job.job_type} />
            <DetailField label="Status" value={statusLabel} />
            <DetailField label="Client" value={job.client_name || job.company_name} />
            <DetailField label="Client Ref" value={job.client_ref} />
            <DetailField label="Venue" value={job.venue_name} />
            <DetailField label="Address" value={job.address} />
            <DetailField label="Out Date" value={formatDate(job.out_date)} />
            <DetailField label="Job Start" value={formatDate(job.job_date)} />
            <DetailField label="Job End" value={formatDate(job.job_end)} />
            <DetailField label="Return Date" value={formatDate(job.return_date)} />
            <DetailField label="Duration" value={
              job.duration_days || job.duration_hrs
                ? `${job.duration_days || 0} days, ${job.duration_hrs || 0} hrs`
                : null
            } />
            <DetailField label="Manager 1" value={job.manager1_name} />
            <DetailField label="Manager 2" value={job.manager2_name} />
            <DetailField label="Project" value={job.project_name} />
            <DetailField label="Depot" value={job.depot_name} />
            <DetailField label="Custom Index" value={job.custom_index} />
            <DetailField label="Internal" value={job.is_internal ? 'Yes' : 'No'} />
            <DetailField label="Created in HireHop" value={formatDateTime(job.created_date)} />
            <DetailField label="Synced" value={formatDateTime(job.created_at)} />
          </div>
          {job.details && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Details</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{job.details}</p>
            </div>
          )}
          {job.notes && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{job.notes}</p>
            </div>
          )}
        </div>
      )}

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
                    <input
                      type="date"
                      value={localFormData.jobDate}
                      onChange={(e) => setLocalFormData({ ...localFormData, jobDate: e.target.value })}
                      className={`w-full border rounded-lg px-3 py-2 text-sm ${
                        dateChanged ? 'border-amber-400 bg-amber-50' : 'border-gray-300'
                      }`}
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
                      type="time"
                      value={localFormData.arrivalTime}
                      onChange={(e) => setLocalFormData({ ...localFormData, arrivalTime: e.target.value })}
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
                      await api.post('/quotes/local', {
                        jobId: job.id,
                        jobType: localFormData.jobType,
                        venueId: localFormData.venueId || job.venue_id || undefined,
                        venueName: localFormData.venueName || job.venue_name || undefined,
                        jobDate: dateStr,
                        arrivalTime: localFormData.arrivalTime || undefined,
                        notes: localFormData.notes || undefined,
                      });
                      setShowLocalForm(false);
                      setLocalFormData({ jobType: 'delivery', venueId: '', venueName: '', jobDate: '', arrivalTime: '', notes: '' });
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
      {showTransitionModal && transitionTarget && (
        <StatusTransitionModal
          targetStatus={transitionTarget}
          saving={transitionSaving}
          onConfirm={(data) => handleStatusTransition(transitionTarget, data)}
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
              <div className="mb-3 p-2 bg-gray-50 rounded-lg">
                <div className="text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Working Terms</div>
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold text-white ${
                    { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' }[clientHistoryData!.client_info.working_terms_type] || 'bg-gray-500'
                  }`}>{
                    { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' }[clientHistoryData!.client_info.working_terms_type] || clientHistoryData!.client_info.working_terms_type
                  }</span>
                  {clientHistoryData!.client_info.working_terms_credit_days && (
                    <span className="text-[10px] text-gray-500">{clientHistoryData!.client_info.working_terms_credit_days}d credit</span>
                  )}
                </div>
                {clientHistoryData!.client_info.working_terms_notes && (
                  <p className="text-[10px] text-gray-500 mt-0.5">{clientHistoryData!.client_info.working_terms_notes}</p>
                )}
              </div>
            )}

            {/* Internal Notes */}
            {clientHistoryData!.client_info?.internal_notes && (
              <div className="mb-3 p-2 bg-amber-50 border border-amber-100 rounded-lg">
                <div className="text-[10px] font-semibold text-amber-700 uppercase mb-0.5">Internal Notes</div>
                <p className="text-[10px] text-gray-700 whitespace-pre-wrap leading-relaxed">{clientHistoryData!.client_info.internal_notes}</p>
              </div>
            )}

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

            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Other Jobs</h4>
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

interface JobRequirement {
  id: string;
  job_id: string;
  requirement_type: string;
  status: 'not_started' | 'in_progress' | 'done' | 'blocked';
  current_step: string | null;
  custom_label: string | null;
  notes: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  due_date: string | null;
  is_auto: boolean;
  source: string;
  type_label: string;
  type_icon: string;
  type_steps: string[] | null;
  sort_order: number;
}

const PREP_STATUS_CONFIG: Record<string, { label: string; colour: string; bg: string; border: string }> = {
  not_started: { label: 'Not Started', colour: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' },
  in_progress: { label: 'In Progress', colour: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-200' },
  done:        { label: 'Done',        colour: 'text-green-700', bg: 'bg-green-100', border: 'border-green-200' },
  blocked:     { label: 'Blocked',     colour: 'text-red-700',   bg: 'bg-red-100',   border: 'border-red-200' },
};

const PREP_STATUS_ORDER: JobRequirement['status'][] = ['not_started', 'in_progress', 'done', 'blocked'];

function JobPrepChecklist({ jobId }: { jobId: string }) {
  const [requirements, setRequirements] = useState<JobRequirement[]>([]);
  const [types, setTypes] = useState<RequirementTypeDef[]>([]);
  const [templates, setTemplates] = useState<RequirementTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState<string | null>(null);

  useEffect(() => {
    loadAll();
  }, [jobId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [reqRes, typesRes, tmplRes] = await Promise.all([
        api.get<{ data: JobRequirement[] }>(`/requirements/job/${jobId}`),
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

  async function addRequirement(typeKey: string) {
    try {
      await api.post(`/requirements/job/${jobId}`, { requirement_type: typeKey });
      await loadAll();
      setShowAddMenu(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add';
      console.error('Failed to add requirement:', msg);
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
    setShowStatusMenu(null);
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

  async function removeRequirement(reqId: string) {
    try {
      await api.delete(`/requirements/${reqId}`);
      setRequirements(prev => prev.filter(r => r.id !== reqId));
    } catch (err) {
      console.error('Failed to remove requirement:', err);
    }
  }

  const doneCount = requirements.filter(r => r.status === 'done').length;
  const blockedCount = requirements.filter(r => r.status === 'blocked').length;
  const totalCount = requirements.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const availableTypes = types.filter(t => t.type === 'custom' || !requirements.some(r => r.requirement_type === t.type));

  if (loading) {
    return <div className="text-center text-sm text-gray-500 py-8">Loading prep checklist...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header with progress */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-lg font-semibold text-gray-900">Job Requirements</h3>
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

        <div className="relative">
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

      {/* Requirements list */}
      {requirements.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-500 text-sm">No requirements added yet.</p>
          <p className="text-gray-400 text-xs mt-1">Click "+ Add Job Requirement" to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {requirements.map((req) => {
            const statusConfig = PREP_STATUS_CONFIG[req.status] || PREP_STATUS_CONFIG.not_started;
            const label = req.custom_label || req.type_label;
            return (
              <div
                key={req.id}
                className={`group bg-white rounded-xl border ${statusConfig.border} p-4 transition-all hover:shadow-sm`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{req.type_icon}</span>
                    <div>
                      <span className={`font-medium ${req.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                        {label}
                      </span>
                      {req.notes && (
                        <span className="text-xs text-gray-400 ml-2">{req.notes}</span>
                      )}
                      {req.assigned_to_name && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded ml-2">{req.assigned_to_name}</span>
                      )}
                      {req.due_date && (
                        <span className="text-xs text-gray-400 ml-2">Due: {new Date(req.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Step progress for multi-step requirements */}
                    {req.type_steps && req.current_step && (
                      <div className="flex items-center gap-1 mr-2">
                        <span className="text-xs text-gray-500">{req.current_step}</span>
                        {req.type_steps.indexOf(req.current_step) < req.type_steps.length - 1 && (
                          <button
                            onClick={() => advanceStep(req.id)}
                            className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium ml-1"
                            title="Advance to next step"
                          >
                            Next &rarr;
                          </button>
                        )}
                      </div>
                    )}

                    {/* Status dropdown — non-linear, any to any */}
                    <div className="relative">
                      <button
                        onClick={() => setShowStatusMenu(showStatusMenu === req.id ? null : req.id)}
                        className={`inline-flex px-3 py-1 rounded text-xs font-medium ${statusConfig.bg} ${statusConfig.colour} cursor-pointer hover:opacity-80 transition-opacity`}
                      >
                        {statusConfig.label}
                        <svg className="w-3 h-3 ml-1 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {showStatusMenu === req.id && (
                        <div className="absolute right-0 mt-1 w-36 bg-white rounded-lg shadow-lg border border-gray-200 z-10 py-1">
                          {PREP_STATUS_ORDER.map((s) => {
                            const sc = PREP_STATUS_CONFIG[s];
                            return (
                              <button
                                key={s}
                                onClick={() => changeStatus(req.id, s)}
                                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2 ${req.status === s ? 'font-bold' : ''}`}
                              >
                                <span className={`w-2 h-2 rounded-full ${sc.bg.replace('100', '500')}`} />
                                {sc.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Remove button (visible on hover) */}
                    <button
                      onClick={() => removeRequirement(req.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all ml-1"
                      title="Remove requirement"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Multi-step progress bar */}
                {req.type_steps && (
                  <div className="mt-3 flex gap-1">
                    {req.type_steps.map((step: string, i: number) => {
                      const currentIdx = req.current_step ? req.type_steps!.indexOf(req.current_step) : -1;
                      const isComplete = i <= currentIdx;
                      return (
                        <div
                          key={step}
                          className={`flex-1 h-1.5 rounded-full ${isComplete ? 'bg-green-400' : 'bg-gray-200'} transition-colors`}
                          title={step}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
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
              return (
                <div
                  key={file.url || idx}
                  className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 group"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
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
                        {file.label && (
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${fileTagColour(file.label)}`}>
                            {file.label}
                          </span>
                        )}
                      </div>
                      {file.comment && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{file.comment}</p>
                      )}
                      <p className="text-xs text-gray-400">
                        {file.uploaded_by} &middot; {new Date(file.uploaded_at).toLocaleDateString('en-GB', {
                          day: 'numeric', month: 'short', year: 'numeric',
                        })}
                      </p>
                    </div>
                  </div>
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

    </div>
  );
}

// ── Helper Components ─────────────────────────────────────────────────────

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value || '—'}</dd>
    </div>
  );
}

function StatusTransitionModal({
  targetStatus,
  saving,
  onConfirm,
  onCancel,
}: {
  targetStatus: PipelineStatus;
  saving: boolean;
  onConfirm: (data: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [holdReason, setHoldReason] = useState<HoldReason>('client_undecided');
  const [holdDetail, setHoldDetail] = useState('');
  const [confirmedMethod, setConfirmedMethod] = useState<ConfirmedMethod>('deposit');
  const [lostReason, setLostReason] = useState('Price');
  const [lostDetail, setLostDetail] = useState('');
  const [note, setNote] = useState('');

  const handleSubmit = () => {
    const data: Record<string, string> = {};
    if (targetStatus === 'paused') {
      data.hold_reason = holdReason;
      if (holdDetail) data.hold_reason_detail = holdDetail;
    } else if (targetStatus === 'confirmed') {
      data.confirmed_method = confirmedMethod;
    } else if (targetStatus === 'lost') {
      data.lost_reason = lostReason;
      if (lostDetail) data.lost_detail = lostDetail;
    }
    if (note) data.transition_note = note;
    onConfirm(data);
  };

  const config = PIPELINE_STATUS_CONFIG[targetStatus];

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
              {Object.entries(HOLD_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
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
