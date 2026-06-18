import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

// ── Types ───────────────────────────────────────────────────────────────
export interface Pcn {
  id: string;
  reference: string | null;
  fine_type: string;
  vehicle_id: string | null;
  driver_id: string | null;
  job_id: string | null;
  hh_job_number: number | null;
  vehicle_reg: string | null;
  fleet_reg: string | null;
  driver_name: string | null;
  client_organisation_name: string | null;
  job_name: string | null;
  offence_at: string | null;
  offence_time_text: string | null;
  location: string | null;
  issuing_authority: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  status: string;
  action_path: string | null;
  notes: string | null;
  created_at: string;
}

interface MatchedDriver {
  assignment_id: string;
  vehicle_id: string;
  reg: string;
  driver_id: string | null;
  driver_name: string | null;
  driver_email: string | null;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
  client_organisation_id: string | null;
  client_organisation_name: string | null;
}

// ── Display maps ──────────────────────────────────────────────────────────
export const PCN_STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  awaiting_driver_id: 'Awaiting Driver ID',
  driver_notified_pay: 'Driver Notified — To Pay',
  paid_by_driver: 'Paid by Driver',
  liability_transferred: 'Liability Transferred',
  paid_recharged: 'Paid & Recharged',
  internal_ooosh: 'Internal (Ooosh)',
  internal_freelancer: 'Internal (Freelancer)',
  under_query: 'Under Query',
  closed: 'Closed',
};

// green = sorted, amber = in-flight, slate = new
export const PCN_STATUS_COLOUR: Record<string, string> = {
  received: 'bg-slate-100 text-slate-700',
  awaiting_driver_id: 'bg-amber-100 text-amber-800',
  driver_notified_pay: 'bg-amber-100 text-amber-800',
  paid_by_driver: 'bg-green-100 text-green-800',
  liability_transferred: 'bg-amber-100 text-amber-800',
  paid_recharged: 'bg-green-100 text-green-800',
  internal_ooosh: 'bg-green-100 text-green-800',
  internal_freelancer: 'bg-green-100 text-green-800',
  under_query: 'bg-amber-100 text-amber-800',
  closed: 'bg-green-100 text-green-800',
};

export const FINE_TYPE_LABEL: Record<string, string> = {
  private_pcn: 'Private PCN',
  council_pcn: 'Council PCN',
  police_nip: 'Police NIP',
  toll: 'Toll',
  other: 'Other',
};

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const money = (n: number | null | undefined) => (n == null ? '—' : `£${Number(n).toFixed(2)}`);

export function PcnStatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PCN_STATUS_COLOUR[status] || 'bg-slate-100 text-slate-700'}`}>
      {PCN_STATUS_LABEL[status] || status}
    </span>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
export default function PcnsPage() {
  const [pcns, setPcns] = useState<Pcn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter) params.set('status', statusFilter);
      const r = await api.get<{ data: Pcn[] }>(`/pcns?${params.toString()}`);
      setPcns(r.data);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-800">PCNs</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#6a5092]"
        >
          + Log PCN
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ref, reg, authority, job #…"
          className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[220px]"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {Object.entries(PCN_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-lg border overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading…</div>
        ) : pcns.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No PCNs found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Vehicle</th>
                <th className="px-3 py-2 font-medium">Driver</th>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Offence</th>
                <th className="px-3 py-2 font-medium">Fine</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {pcns.map((p) => (
                <tr key={p.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link to={`/vehicles/pcns/${p.id}`} className="text-[#7B5EA7] font-medium hover:underline">
                      {p.reference || '(no ref)'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{FINE_TYPE_LABEL[p.fine_type] || p.fine_type}</td>
                  <td className="px-3 py-2">{p.fleet_reg || p.vehicle_reg || '—'}</td>
                  <td className="px-3 py-2">{p.driver_name || '—'}</td>
                  <td className="px-3 py-2">{p.hh_job_number ? `#${p.hh_job_number}` : '—'}</td>
                  <td className="px-3 py-2">{fmtDate(p.offence_at)}{p.offence_time_text ? ` ${p.offence_time_text}` : ''}</td>
                  <td className="px-3 py-2">{money(p.fine_amount)}</td>
                  <td className="px-3 py-2"><PcnStatusPill status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreatePcnModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Create modal: manual entry + driver match ─────────────────────────────
function CreatePcnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    reference: '', fine_type: 'private_pcn', vehicle_reg: '',
    offence_date: '', offence_time: '', location: '', issuing_authority: '',
    fine_amount: '', reduced_amount: '', reduced_deadline: '', final_deadline: '',
    notes: '',
  });
  const [matches, setMatches] = useState<MatchedDriver[] | null>(null);
  const [picked, setPicked] = useState<MatchedDriver | null>(null);
  const [matching, setMatching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const findDriver = async () => {
    if (!form.vehicle_reg.trim() || !form.offence_date) {
      setError('Enter vehicle reg and offence date first.');
      return;
    }
    setMatching(true); setError(null); setPicked(null);
    try {
      const offenceAt = `${form.offence_date}T${form.offence_time || '12:00'}:00`;
      const r = await api.get<{ data: { drivers: MatchedDriver[] } }>(
        `/pcns/match?reg=${encodeURIComponent(form.vehicle_reg)}&offence_at=${encodeURIComponent(offenceAt)}`
      );
      setMatches(r.data.drivers);
      if (r.data.drivers.length === 1) setPicked(r.data.drivers[0]);
    } catch {
      setError('Driver match failed.');
    } finally {
      setMatching(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const offenceAt = form.offence_date
        ? `${form.offence_date}T${form.offence_time || '12:00'}:00`
        : null;
      const body: Record<string, unknown> = {
        reference: form.reference || null,
        fine_type: form.fine_type,
        vehicle_reg: form.vehicle_reg.toUpperCase().replace(/\s/g, '') || null,
        offence_at: offenceAt,
        offence_time_text: form.offence_time || null,
        location: form.location || null,
        issuing_authority: form.issuing_authority || null,
        fine_amount: form.fine_amount ? Number(form.fine_amount) : null,
        reduced_amount: form.reduced_amount ? Number(form.reduced_amount) : null,
        reduced_deadline: form.reduced_deadline || null,
        final_deadline: form.final_deadline || null,
        notes: form.notes || null,
      };
      if (picked) {
        body.vehicle_id = picked.vehicle_id;
        body.driver_id = picked.driver_id;
        body.assignment_id = picked.assignment_id;
        body.job_id = picked.job_id;
        body.hh_job_number = picked.hh_job_number;
        body.client_organisation_id = picked.client_organisation_id;
      }
      await api.post('/pcns', body);
      onCreated();
    } catch {
      setError('Failed to save PCN.');
      setSaving(false);
    }
  };

  const input = 'border rounded-lg px-3 py-2 text-sm w-full';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-2xl w-full my-8 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Log PCN</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">Reference
            <input className={input} value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </label>
          <label className="text-sm">Type
            <select className={input} value={form.fine_type} onChange={(e) => set('fine_type', e.target.value)}>
              {Object.entries(FINE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="text-sm">Vehicle reg
            <input className={input} value={form.vehicle_reg} onChange={(e) => set('vehicle_reg', e.target.value)} />
          </label>
          <label className="text-sm">Issuing authority
            <input className={input} value={form.issuing_authority} onChange={(e) => set('issuing_authority', e.target.value)} />
          </label>
          <label className="text-sm">Offence date
            <input type="date" className={input} value={form.offence_date} onChange={(e) => set('offence_date', e.target.value)} />
          </label>
          <label className="text-sm">Offence time
            <input type="time" className={input} value={form.offence_time} onChange={(e) => set('offence_time', e.target.value)} />
          </label>
          <label className="text-sm">Location
            <input className={input} value={form.location} onChange={(e) => set('location', e.target.value)} />
          </label>
          <label className="text-sm">Fine amount (£)
            <input type="number" className={input} value={form.fine_amount} onChange={(e) => set('fine_amount', e.target.value)} />
          </label>
          <label className="text-sm">Reduced amount (£)
            <input type="number" className={input} value={form.reduced_amount} onChange={(e) => set('reduced_amount', e.target.value)} />
          </label>
          <label className="text-sm">Reduced deadline
            <input type="date" className={input} value={form.reduced_deadline} onChange={(e) => set('reduced_deadline', e.target.value)} />
          </label>
          <label className="text-sm">Final deadline
            <input type="date" className={input} value={form.final_deadline} onChange={(e) => set('final_deadline', e.target.value)} />
          </label>
        </div>

        <label className="text-sm block mt-3">Notes
          <textarea className={`${input} resize-y min-h-[60px]`} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        {/* Driver matching */}
        <div className="mt-4 border-t pt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Driver match</span>
            <button onClick={findDriver} disabled={matching}
              className="text-sm border rounded-lg px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50">
              {matching ? 'Matching…' : '🔍 Find driver from hire data'}
            </button>
          </div>
          {matches !== null && (
            <div className="mt-2 space-y-1">
              {matches.length === 0 && (
                <p className="text-sm text-amber-700">No hire matched this reg + time. Save as-is and triage manually.</p>
              )}
              {matches.map((m) => (
                <label key={m.assignment_id}
                  className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 cursor-pointer ${picked?.assignment_id === m.assignment_id ? 'border-[#7B5EA7] bg-purple-50' : ''}`}>
                  <input type="radio" name="driver" checked={picked?.assignment_id === m.assignment_id}
                    onChange={() => setPicked(m)} />
                  <span>
                    <strong>{m.driver_name || '(no driver on row)'}</strong>
                    {m.client_organisation_name ? ` · ${m.client_organisation_name}` : ''}
                    {m.hh_job_number ? ` · job #${m.hh_job_number}` : ''}
                  </span>
                </label>
              ))}
              {matches.length > 0 && (
                <button onClick={() => setPicked(null)} className="text-xs text-slate-500 hover:underline">
                  Clear selection (log without a driver)
                </button>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-[#7B5EA7] text-white hover:bg-[#6a5092] disabled:opacity-50">
            {saving ? 'Saving…' : 'Save PCN'}
          </button>
        </div>
      </div>
    </div>
  );
}
