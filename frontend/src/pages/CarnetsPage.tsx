/**
 * CarnetsPage — Operations > Carnets overview (list).
 *
 * Filterable list of every carnet (both modes). Each row opens its own detail
 * page (/operations/carnets/:id) — kept separate so the list doesn't get messy
 * with inline-expanded cockpits. The full lifecycle / custody / GMR / document
 * management lives on the detail page.
 *
 * See docs/CARNET-SPEC.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import Countdown from '../components/CarnetCountdown';

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
  needed_by: string | null;
  return_by: string | null;
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

interface JobHit { id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null }

// Manual create for the "client arranges their own carnet — just log it" case.
function NewClientCarnetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<JobHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get<{ data: JobHit[] }>(`/hirehop/jobs?search=${encodeURIComponent(q.trim())}&limit=10`);
        setHits(res.data || []);
      } catch { setHits([]); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function create(job: JobHit) {
    setBusy(true); setErr('');
    try {
      const res = await api.post<{ data: { id: string } }>('/carnets', { job_id: job.id, mode: 'client_arranges' });
      onCreated(res.data.id);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not create — does this job already have a carnet?'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">Client-arranged carnet</h2>
        <p className="text-sm text-gray-500 mb-3">For when the client arranges their own carnet — pick the job to log it against.</p>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search job / client / HH number"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-2" />
        {err && <p className="text-sm text-red-600 mb-2">{err}</p>}
        <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
          {searching && <p className="text-sm text-gray-400 py-2">Searching…</p>}
          {!searching && hits.map((j) => (
            <button key={j.id} disabled={busy} onClick={() => create(j)} className="w-full text-left py-2 hover:bg-purple-50 px-2 rounded text-sm disabled:opacity-50">
              <span className="font-medium">{j.hh_job_number ? `#${j.hh_job_number}` : '—'}</span> · {j.job_name || '—'}
              <span className="text-gray-400"> · {j.client_name || ''}</span>
            </button>
          ))}
          {!searching && q.trim().length >= 2 && hits.length === 0 && <p className="text-sm text-gray-400 py-2">No matching jobs.</p>}
        </div>
        <div className="mt-3 text-right"><button onClick={onClose} className="text-sm text-gray-500">Cancel</button></div>
      </div>
    </div>
  );
}

export default function CarnetsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<CarnetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('');

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

  const counts = useMemo(() => ({
    total: rows.length,
    weSupply: rows.filter((r) => r.mode === 'we_supply').length,
    open: rows.filter((r) => !['closed', 'done', 'cancelled'].includes(r.status)).length,
  }), [rows]);

  const [showNew, setShowNew] = useState(false);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">📄 Carnets</h1>
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-500">{counts.total} total · {counts.weSupply} we supply · {counts.open} open</div>
          <button onClick={() => setShowNew(true)} className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm font-medium">+ Client-arranged carnet</button>
        </div>
      </div>

      {showNew && <NewClientCarnetModal onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/operations/carnets/${id}`)} />}

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
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Job</th>
              <th className="text-left px-3 py-2">Client</th>
              <th className="text-left px-3 py-2">Mode</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Custody</th>
              <th className="text-left px-3 py-2">GMRs</th>
              <th className="text-left px-3 py-2">Needed by</th>
              <th className="text-left px-3 py-2">Return by</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No carnets.</td></tr>}
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => navigate(`/operations/carnets/${r.id}`)}
                className="border-t border-gray-100 cursor-pointer hover:bg-purple-50"
              >
                <td className="px-3 py-2 font-medium text-gray-800">{r.hh_job_number ? `#${r.hh_job_number}` : '—'}<div className="text-xs text-gray-400 truncate max-w-[180px]">{r.job_name}</div></td>
                <td className="px-3 py-2 text-gray-600">{r.client_name || '—'}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${r.mode === 'we_supply' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}`}>{r.mode === 'we_supply' ? 'We supply' : 'Client'}</span></td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLOUR[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status.replace(/_/g, ' ')}</span></td>
                <td className="px-3 py-2 text-gray-600 capitalize">{r.custody_location === 'ooosh' ? 'We have it' : r.custody_location || '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.gmr_count > 0 ? `${r.gmr_sent_count}/${r.gmr_count} sent` : '—'}</td>
                <td className="px-3 py-2"><Countdown date={r.needed_by} /></td>
                <td className="px-3 py-2"><Countdown date={r.return_by} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
