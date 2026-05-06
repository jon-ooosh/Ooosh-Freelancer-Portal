/**
 * JobProblemsPanel — Issues / Problems register on Job Detail.
 *
 * Lists open issues on this job + a "Log Problem" button with a smart
 * picker (vehicles allocated to this hire, line items on the job, drivers,
 * job people, client org). Backend at /api/problems/* (NOT /api/issues/*).
 *
 * Per-issue rows are clickable and navigate to /operations/problems/:id
 * for the full control panel (timeline, comments, resolution).
 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

type IssueStatus = 'open' | 'investigating' | 'awaiting_quote' | 'quoted' | 'actioned' | 'resolved' | 'written_off' | 'cancelled';
type IssueCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'breakdown' | 'other';
type IssueSeverity = 'low' | 'normal' | 'urgent';

interface Issue {
  id: string;
  status: IssueStatus;
  category: IssueCategory;
  severity: IssueSeverity;
  summary: string;
  description: string | null;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  driver_id: string | null;
  driver_name: string | null;
  person_id: string | null;
  person_name: string | null;
  client_organisation_id: string | null;
  client_organisation_name: string | null;
  hh_stock_item_id: number | null;
  hh_stock_item_name: string | null;
  barcode: string | null;
  source_module: string | null;
  due_date: string | null;
  created_at: string;
  reported_by_name: string | null;
  assigned_to_name: string | null;
}

interface PickerData {
  job: {
    id: string;
    hh_job_number: number;
    client_organisation_id: string | null;
    client_organisation_name: string | null;
  };
  vehicles: Array<{ id: string; reg: string; simple_type: string }>;
  drivers: Array<{ id: string; full_name: string }>;
  people: Array<{ id: string; first_name: string; last_name: string; role: string | null; organisation_name: string | null }>;
  line_items: Array<{ list_id: number | null; title: string; qty: string | number }>;
}

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  awaiting_quote: 'Awaiting Quote',
  quoted: 'Quoted',
  actioned: 'Actioned',
  resolved: 'Resolved',
  written_off: 'Written Off',
  cancelled: 'Cancelled',
};
const STATUS_COLOURS: Record<IssueStatus, string> = {
  open: 'bg-red-100 text-red-700',
  investigating: 'bg-amber-100 text-amber-700',
  awaiting_quote: 'bg-orange-100 text-orange-700',
  quoted: 'bg-yellow-100 text-yellow-800',
  actioned: 'bg-blue-100 text-blue-700',
  resolved: 'bg-green-100 text-green-700',
  written_off: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-gray-100 text-gray-500',
};
const CATEGORY_LABELS: Record<IssueCategory, string> = {
  damaged: 'Damaged', missing: 'Missing', broken: 'Broken',
  dispute: 'Dispute', breakdown: 'Breakdown', other: 'Other',
};
const CATEGORY_ICONS: Record<IssueCategory, string> = {
  damaged: '🔨', missing: '❓', broken: '⚙️', dispute: '⚖️', breakdown: '🚨', other: '⚠️',
};

const SURFACE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Just live in the register' },
  { value: 'vehicle_check_in', label: 'Banner on this vehicle’s next check-in' },
  { value: 'next_hire', label: 'Banner on this vehicle’s next hire' },
  { value: 'next_book_out', label: 'Banner on next book-out' },
  { value: 'job_close_out', label: 'Block this job’s close-out' },
];

export default function JobProblemsPanel({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Issue[] }>(`/problems/job/${jobId}`);
      setItems(res.data);
    } catch (err) {
      console.error('Failed to load issues:', err);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const open = items.filter(i => !['resolved', 'written_off', 'cancelled'].includes(i.status));
  const resolved = items.filter(i => ['resolved', 'written_off', 'cancelled'].includes(i.status));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Problems</h3>
          {open.length > 0 && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              open.some(p => p.severity === 'urgent') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {open.length} open
            </span>
          )}
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          {showForm ? 'Cancel' : '+ Log Problem'}
        </button>
      </div>

      {showForm && (
        <LogProblemForm
          jobId={jobId}
          onCancel={() => setShowForm(false)}
          onCreated={() => { setShowForm(false); load(); }}
        />
      )}

      {loading ? (
        <div className="text-xs text-gray-400 py-2">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-gray-400 py-2 italic">No problems on this job.</div>
      ) : (
        <>
          {open.length > 0 ? (
            <div className="space-y-2">{open.map(i => <Row key={i.id} i={i} />)}</div>
          ) : (
            <div className="text-xs text-gray-400 py-2 italic">No open problems.</div>
          )}
          {resolved.length > 0 && (
            <>
              <button
                onClick={() => setShowResolved(s => !s)}
                className="text-xs text-gray-500 hover:text-gray-700 mt-3"
              >
                {showResolved ? '− Hide' : '+ Show'} {resolved.length} resolved
              </button>
              {showResolved && (
                <div className="space-y-2 mt-2 opacity-60">{resolved.map(i => <Row key={i.id} i={i} />)}</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Row({ i }: { i: Issue }) {
  const ageDays = Math.floor((Date.now() - new Date(i.created_at).getTime()) / 86400000);
  // Build a "subject line" — what the issue is about
  const subjectParts: string[] = [];
  if (i.vehicle_reg) subjectParts.push(`🚐 ${i.vehicle_reg}`);
  if (i.hh_stock_item_name) subjectParts.push(`🎸 ${i.hh_stock_item_name}${i.barcode ? ` (${i.barcode})` : ''}`);
  if (i.driver_name) subjectParts.push(`🧑 ${i.driver_name}`);
  if (i.person_name && !i.driver_name) subjectParts.push(`👤 ${i.person_name}`);
  return (
    <Link
      to={`/operations/problems/${i.id}`}
      className={`block border rounded-lg p-2.5 hover:shadow-sm transition-all ${
        i.severity === 'urgent' ? 'border-red-200 bg-red-50/40 hover:bg-red-50' : 'border-gray-200 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="text-base">{CATEGORY_ICONS[i.category]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLOURS[i.status]}`}>
              {STATUS_LABELS[i.status]}
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase">
              {CATEGORY_LABELS[i.category]}
            </span>
            {i.severity === 'urgent' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">⚠ Urgent</span>
            )}
            <span className="text-[10px] text-gray-500">{ageDays === 0 ? 'today' : `${ageDays}d`}</span>
            {i.assigned_to_name && (
              <span className="text-[10px] text-blue-600">→ {i.assigned_to_name}</span>
            )}
          </div>
          <div className="text-sm text-gray-900">{i.summary}</div>
          {subjectParts.length > 0 && (
            <div className="text-xs text-gray-500 mt-0.5">{subjectParts.join(' · ')}</div>
          )}
          {i.description && (
            <div className="text-xs text-gray-600 mt-1 whitespace-pre-wrap line-clamp-2">{i.description}</div>
          )}
        </div>
      </div>
    </Link>
  );
}

// ── Smart-picker form ─────────────────────────────────────────────────────

type SubjectKind = 'vehicle' | 'equipment' | 'driver' | 'person' | 'client' | 'job';

function LogProblemForm({ jobId, onCancel, onCreated }: {
  jobId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [picker, setPicker] = useState<PickerData | null>(null);
  const [pickerLoading, setPickerLoading] = useState(true);

  const [category, setCategory] = useState<IssueCategory>('damaged');
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('vehicle');
  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [personId, setPersonId] = useState('');
  const [lineItemId, setLineItemId] = useState('');     // HH list_id stringified
  const [lineItemName, setLineItemName] = useState(''); // denormalised
  const [barcode, setBarcode] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IssueSeverity>('normal');
  const [dueDate, setDueDate] = useState('');
  const [surfaceOn, setSurfaceOn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPickerLoading(true);
    api.get<{ data: PickerData }>(`/problems/picker/${jobId}`)
      .then(res => setPicker(res.data))
      .catch(() => setError('Failed to load job context — type your subject manually'))
      .finally(() => setPickerLoading(false));
  }, [jobId]);

  // Auto-pick the first vehicle if there's only one — saves a click.
  useEffect(() => {
    if (picker?.vehicles.length === 1 && subjectKind === 'vehicle' && !vehicleId) {
      setVehicleId(picker.vehicles[0].id);
    }
  }, [picker, subjectKind, vehicleId]);

  async function submit() {
    if (!summary.trim()) {
      setError('Summary is required'); return;
    }
    setError(''); setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        job_id: jobId,
        category,
        severity,
        summary: summary.trim(),
        description: description.trim() || null,
        source_module: 'manual',
      };
      if (subjectKind === 'vehicle' && vehicleId) payload.vehicle_id = vehicleId;
      if (subjectKind === 'driver' && driverId) payload.driver_id = driverId;
      if (subjectKind === 'person' && personId) payload.person_id = personId;
      if (subjectKind === 'client' && picker?.job.client_organisation_id) {
        payload.client_organisation_id = picker.job.client_organisation_id;
      }
      if (subjectKind === 'equipment') {
        if (lineItemId) payload.hh_stock_item_id = parseInt(lineItemId, 10);
        if (lineItemName) payload.hh_stock_item_name = lineItemName;
        if (barcode.trim()) payload.barcode = barcode.trim();
      }
      if (dueDate) payload.due_date = dueDate;
      if (surfaceOn) payload.surface_on = surfaceOn;

      await api.post('/problems', payload);
      onCreated();
    } catch (err) {
      console.error('Failed to log problem:', err);
      setError('Failed to log problem');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-3">
      {/* Category */}
      <div>
        <div className="text-[11px] font-medium text-gray-600 mb-1">What kind of problem?</div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                category === c ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300'
              }`}
            >
              {CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      {/* Subject — kind picker + per-kind dropdown */}
      <div>
        <div className="text-[11px] font-medium text-gray-600 mb-1">What’s it about?</div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {([
            ['vehicle', '🚐 Vehicle'],
            ['equipment', '🎸 Equipment'],
            ['driver', '🧑 Driver'],
            ['person', '👤 Person'],
            ['client', '🏢 Client'],
            ['job', '📋 The job itself'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSubjectKind(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                subjectKind === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {pickerLoading ? (
          <div className="text-xs text-gray-400">Loading job context…</div>
        ) : (
          <>
            {subjectKind === 'vehicle' && (
              picker && picker.vehicles.length > 0 ? (
                <select
                  value={vehicleId}
                  onChange={e => setVehicleId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                >
                  <option value="">— Pick a vehicle —</option>
                  {picker.vehicles.map(v => (
                    <option key={v.id} value={v.id}>{v.reg} — {v.simple_type}</option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-amber-600 italic">No vehicle assignments on this job yet.</div>
              )
            )}

            {subjectKind === 'equipment' && (
              <div className="space-y-2">
                {picker && picker.line_items.length > 0 ? (
                  <select
                    value={lineItemId}
                    onChange={e => {
                      setLineItemId(e.target.value);
                      const item = picker?.line_items.find(li => String(li.list_id) === e.target.value);
                      setLineItemName(item?.title || '');
                    }}
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                  >
                    <option value="">— Pick an equipment item —</option>
                    {picker.line_items.map((li, idx) => (
                      <option key={`${li.list_id}-${idx}`} value={li.list_id ?? ''}>
                        {li.title} (×{li.qty})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={lineItemName}
                    onChange={e => setLineItemName(e.target.value)}
                    placeholder="Equipment name (no HH line items found)"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                  />
                )}
                <input
                  type="text"
                  value={barcode}
                  onChange={e => setBarcode(e.target.value)}
                  placeholder="Barcode (optional — type or scan the actual checked-out item)"
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                />
              </div>
            )}

            {subjectKind === 'driver' && (
              picker && picker.drivers.length > 0 ? (
                <select
                  value={driverId}
                  onChange={e => setDriverId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                >
                  <option value="">— Pick a driver —</option>
                  {picker.drivers.map(d => (
                    <option key={d.id} value={d.id}>{d.full_name}</option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-amber-600 italic">No driver assignments on this job.</div>
              )
            )}

            {subjectKind === 'person' && (
              picker && picker.people.length > 0 ? (
                <select
                  value={personId}
                  onChange={e => setPersonId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                >
                  <option value="">— Pick a person —</option>
                  {picker.people.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.first_name} {p.last_name}
                      {p.role ? ` — ${p.role}` : ''}
                      {p.organisation_name ? ` (${p.organisation_name})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-amber-600 italic">No people linked to this job yet.</div>
              )
            )}

            {subjectKind === 'client' && (
              picker?.job.client_organisation_name ? (
                <div className="text-sm text-gray-700 px-3 py-2 bg-white border border-gray-200 rounded">
                  🏢 {picker.job.client_organisation_name}
                </div>
              ) : (
                <div className="text-xs text-amber-600 italic">No client org linked to this job.</div>
              )
            )}

            {subjectKind === 'job' && (
              <div className="text-xs text-gray-500 italic">Issue is against the job as a whole — no specific anchor.</div>
            )}
          </>
        )}
      </div>

      {/* Summary */}
      <div>
        <label className="block text-[11px] font-medium text-gray-600 mb-1">Summary</label>
        <input
          type="text"
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="Short summary (e.g. Scratched bumper, found at check-in)"
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[11px] font-medium text-gray-600 mb-1">Detail</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Optional — what happened, who reported it, any context"
          rows={3}
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
      </div>

      {/* Severity, due date, surface */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="text-xs text-gray-600 flex items-center gap-2 px-2 py-1 bg-white border border-gray-200 rounded">
          <input
            type="checkbox"
            checked={severity === 'urgent'}
            onChange={e => setSeverity(e.target.checked ? 'urgent' : 'normal')}
          />
          ⚠ Urgent
        </label>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Resolve by</label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Surface again on</label>
          <select
            value={surfaceOn}
            onChange={e => setSurfaceOn(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
          >
            {SURFACE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs border rounded">Cancel</button>
        <button
          onClick={submit}
          disabled={!summary.trim() || submitting}
          className="px-3 py-1.5 text-xs bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Logging…' : 'Log problem'}
        </button>
      </div>
    </div>
  );
}
