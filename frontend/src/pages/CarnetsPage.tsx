/**
 * CarnetsPage — Operations > Carnets overview + management.
 *
 * Master/detail: a filterable list of every carnet (both modes), and the rich
 * CarnetSection cockpit for the selected one. The Job-View `carnet` requirement
 * card links here (?job=<jobId> auto-selects). This is where the full lifecycle,
 * custody, GMR and document management lives — kept off the job view.
 *
 * See docs/CARNET-SPEC.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import CarnetSection from '../components/CarnetSection';

interface CarnetRow {
  id: string;
  job_id: string;
  mode: 'we_supply' | 'client_arranges';
  status: string;
  format: 'paper' | 'digital';
  custody_location: 'ooosh' | 'client' | 'issuer' | null;
  carnet_start_date: string | null;
  carnet_expiry_date: string | null;
  chase_date: string | null;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  job_date: string | null;
  gmr_count: number;
  gmr_sent_count: number;
}

const STATUS_COLOUR: Record<string, string> = {
  detected: 'bg-gray-100 text-gray-700',
  form_sent: 'bg-amber-100 text-amber-800',
  info_received: 'bg-blue-100 text-blue-800',
  applied: 'bg-blue-100 text-blue-800',
  received: 'bg-indigo-100 text-indigo-800',
  with_client: 'bg-purple-100 text-purple-800',
  returned: 'bg-indigo-100 text-indigo-800',
  discharged: 'bg-green-100 text-green-800',
  closed: 'bg-green-100 text-green-700',
  requested: 'bg-gray-100 text-gray-700',
  spreadsheet_sent: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

function fmt(d: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB');
}

export default function CarnetsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<CarnetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('');
  const [selectedJob, setSelectedJob] = useState<string | null>(searchParams.get('job'));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (mode) params.set('mode', mode);
      if (status) params.set('status', status);
      const res = await api.get<{ data: CarnetRow[] }>(`/carnets?${params.toString()}`);
      setRows(res.data || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [q, mode, status]);

  useEffect(() => { load(); }, [load]);

  // Auto-select from ?job= once rows have loaded (or keep an explicit selection).
  useEffect(() => {
    const jobParam = searchParams.get('job');
    if (jobParam) setSelectedJob(jobParam);
  }, [searchParams]);

  const selectJob = (jobId: string | null) => {
    setSelectedJob(jobId);
    const next = new URLSearchParams(searchParams);
    if (jobId) next.set('job', jobId); else next.delete('job');
    setSearchParams(next, { replace: true });
  };

  const counts = useMemo(() => ({
    total: rows.length,
    weSupply: rows.filter((r) => r.mode === 'we_supply').length,
    open: rows.filter((r) => !['closed', 'done', 'cancelled'].includes(r.status)).length,
  }), [rows]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">📄 Carnets</h1>
        <div className="text-sm text-gray-500">{counts.total} total · {counts.weSupply} we supply · {counts.open} open</div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search job / client / HH number"
          className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[200px]"
        />
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm">
          <option value="">All modes</option>
          <option value="we_supply">We supply</option>
          <option value="client_arranges">Client arranges</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm">
          <option value="">All statuses</option>
          {['detected', 'form_sent', 'info_received', 'applied', 'received', 'with_client', 'returned', 'discharged', 'closed', 'requested', 'spreadsheet_sent', 'done', 'cancelled'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Job</th>
              <th className="text-left px-3 py-2">Client</th>
              <th className="text-left px-3 py-2">Mode</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Custody</th>
              <th className="text-left px-3 py-2">GMRs</th>
              <th className="text-left px-3 py-2">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No carnets.</td></tr>}
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => selectJob(r.job_id)}
                className={`border-t border-gray-100 cursor-pointer hover:bg-purple-50 ${selectedJob === r.job_id ? 'bg-purple-50' : ''}`}
              >
                <td className="px-3 py-2 font-medium text-gray-800">{r.hh_job_number ? `#${r.hh_job_number}` : '—'}<div className="text-xs text-gray-400 truncate max-w-[180px]">{r.job_name}</div></td>
                <td className="px-3 py-2 text-gray-600">{r.client_name || '—'}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${r.mode === 'we_supply' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}`}>{r.mode === 'we_supply' ? 'We supply' : 'Client'}</span></td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLOUR[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status.replace(/_/g, ' ')}</span></td>
                <td className="px-3 py-2 text-gray-600 capitalize">{r.custody_location === 'ooosh' ? 'We have it' : r.custody_location || '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.gmr_count > 0 ? `${r.gmr_sent_count}/${r.gmr_count} sent` : '—'}</td>
                <td className="px-3 py-2 text-gray-600">{fmt(r.carnet_expiry_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail cockpit */}
      {selectedJob && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-gray-500">Selected carnet</h2>
            <button onClick={() => selectJob(null)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
          </div>
          <CarnetSection jobId={selectedJob} onChanged={load} />
        </div>
      )}
    </div>
  );
}
