/**
 * Vehicles › Claims — the possible-insurance-claim tracker
 * (docs/INCIDENT-CLAIMS-SPEC.md §5). Columns are the vehicle manager's list.
 *
 * Cases are opened from a Problem ("Possible insurance claim" on the Problem),
 * or here via "Claim out of the blue" for a third-party claim that arrives
 * after the hire (§3.1) — which still logs the Problem first, server-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import {
  ClaimListRow, ClaimStage, ClaimStagePill, CLAIM_STAGE_LABEL, NextCheckCell, fmtClaimDate,
} from '../components/claims/format';

const STAGE_TABS: Array<{ key: string; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'open', label: CLAIM_STAGE_LABEL.open },
  { key: 'submitted', label: CLAIM_STAGE_LABEL.submitted },
  { key: 'reviewed', label: CLAIM_STAGE_LABEL.reviewed },
  { key: 'with_broker', label: CLAIM_STAGE_LABEL.with_broker },
  { key: 'closed', label: CLAIM_STAGE_LABEL.closed },
  { key: 'all', label: 'All' },
];

export default function ClaimsPage() {
  const [params, setParams] = useSearchParams();
  const stage = STAGE_TABS.some((t) => t.key === params.get('stage')) ? (params.get('stage') as string) : 'active';
  const [search, setSearch] = useState(params.get('q') || '');
  const [rows, setRows] = useState<ClaimListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ stage, limit: '200' });
      const q = params.get('q');
      if (q) qs.set('search', q);
      const r = await api.get<{ data: ClaimListRow[]; pagination: { total: number } }>(`/claims?${qs}`);
      setRows(r.data);
      setTotal(r.pagination.total);
    } catch {
      setError('Failed to load claims');
    } finally {
      setLoading(false);
    }
  }, [stage, params]);

  useEffect(() => { load(); }, [load]);

  const setStage = (key: string) => {
    const next = new URLSearchParams(params);
    if (key === 'active') next.delete('stage'); else next.set('stage', key);
    setParams(next, { replace: true });
  };
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    if (search.trim()) next.set('q', search.trim()); else next.delete('q');
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800">Insurance claims</h1>
          <p className="text-sm text-slate-500">
            Possible claims, opened from a Problem. The broker only hears about a case when a manager sends it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="px-3 py-2 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50"
          title="A third party says one of our vans hit them, after the hire has ended"
        >
          + Claim out of the blue
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {STAGE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setStage(t.key)}
            className={`px-3 py-1 text-xs font-medium rounded-full border ${
              stage === t.key ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-slate-600 border-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
        <form onSubmit={submitSearch} className="ml-auto flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Reg, job #, ref, driver, place…"
            className="border border-slate-300 rounded px-3 py-1.5 text-sm w-60"
          />
          <button type="submit" className="px-3 py-1.5 text-sm rounded bg-slate-800 text-white">Search</button>
        </form>
      </div>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}

      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">HH#</th>
              <th className="text-left px-3 py-2">Van</th>
              <th className="text-left px-3 py-2">Driver</th>
              <th className="text-left px-3 py-2">Incident</th>
              <th className="text-left px-3 py-2">Location</th>
              <th className="text-left px-3 py-2">Markerstudy ref</th>
              <th className="text-left px-3 py-2">Boswell ref</th>
              <th className="text-left px-3 py-2">Stage</th>
              <th className="text-left px-3 py-2">Next check</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No claims here.</td></tr>
            ) : rows.map((c) => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 whitespace-nowrap">{c.hh_job_number ? `#${c.hh_job_number}` : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium">
                  <Link to={`/vehicles/claims/${c.id}`} className="text-ooosh-700 hover:underline">{c.vehicle_reg || 'No van'}</Link>
                  {c.third_party_claim && <span className="ml-1 text-[11px] text-red-700" title="Third-party claim against our policy">3P</span>}
                  {c.liability_dispute && <span className="ml-1 text-[11px] text-amber-700" title="Liability dispute with the hirer">⚖</span>}
                </td>
                <td className="px-3 py-2">{c.driver_name || <span className="text-slate-400">not identified</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.incident_at ? fmtClaimDate(c.incident_at) : '—'}
                  {c.incident_time_text ? <span className="text-slate-500"> {c.incident_time_text}</span> : null}
                  {c.notified_via === 'tts360' && <span className="ml-1 text-[11px] text-sky-700" title="Reported through TTS360's 24-hour line">via TTS360</span>}
                </td>
                <td className="px-3 py-2 max-w-[16rem] truncate" title={c.incident_location || ''}>{c.incident_location || '—'}</td>
                <td className="px-3 py-2">{c.insurer_ref || '—'}</td>
                <td className="px-3 py-2">{c.broker_ref || '—'}</td>
                <td className="px-3 py-2"><ClaimStagePill stage={c.stage as ClaimStage} outcome={c.outcome} /></td>
                <td className="px-3 py-2 whitespace-nowrap"><NextCheckCell row={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && total > rows.length && (
        <p className="text-xs text-slate-500 mt-2">Showing {rows.length} of {total}. Narrow it with a search.</p>
      )}

      {showNew && <OutOfTheBlueModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

// ── A claim out of the blue (§3.1) ──────────────────────────────────────────

interface FleetLite { id: string; reg: string; isActive?: boolean }
interface HireMatch {
  assignment_id: string;
  driver_id: string | null;
  driver_name: string | null;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
}

function OutOfTheBlueModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [fleet, setFleet] = useState<FleetLite[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [date, setDate] = useState('');
  const [matches, setMatches] = useState<HireMatch[] | null>(null);
  const [pick, setPick] = useState<string>(''); // `${job_id}|${driver_id}` or 'none'
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ data: FleetLite[] }>('/vehicles/fleet?include_inactive=true')
      .then((r) => setFleet([...r.data].sort((a, b) => a.reg.localeCompare(b.reg))))
      .catch(() => setError('Could not load the fleet list'));
  }, []);

  // Which hire had that van on that day — the PCN matcher's lookup.
  useEffect(() => {
    setMatches(null);
    setPick('');
    const van = fleet.find((f) => f.id === vehicleId);
    if (!van || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const reg = van.reg.toUpperCase().replace(/\s/g, '');
    api.get<{ data: { drivers: HireMatch[] } }>(`/pcns/match?reg=${encodeURIComponent(reg)}&offence_at=${date}`)
      .then((r) => setMatches(r.data.drivers))
      .catch(() => setMatches([]));
  }, [vehicleId, date, fleet]);

  // Group driver rows by hire so staff pick the hire, optionally a driver.
  const options = (matches || []).filter((m) => m.job_id);

  const submit = async () => {
    if (!vehicleId || !date || summary.trim().length < 2) { setError('Van, date and a summary are needed'); return; }
    setBusy(true);
    setError('');
    try {
      const [jobId, driverId] = pick && pick !== 'none' ? pick.split('|') : ['', ''];
      const r = await api.post<{ data: { id: string } }>('/claims/out-of-the-blue', {
        vehicle_id: vehicleId,
        alleged_date: date,
        job_id: jobId || null,
        driver_id: driverId || null,
        summary: summary.trim(),
        description: description.trim() || null,
      });
      navigate(`/vehicles/claims/${r.data.id}`);
    } catch {
      setError('Could not log the claim');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Claim out of the blue</h2>
          <p className="text-xs text-slate-500">
            A third party says one of our vans was involved, after the hire. This logs a Problem on the van and opens a case flagged as a third-party claim.
          </p>
        </div>
        <label className="block text-sm">
          <span className="text-xs text-slate-600">Van</span>
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className="mt-1 w-full border rounded px-2 py-1.5">
            <option value="">— Pick a van —</option>
            {fleet.map((f) => (
              <option key={f.id} value={f.id}>{f.reg}{f.isActive === false ? ' (no longer in fleet)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-600">Date the third party says it happened</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full border rounded px-2 py-1.5" />
        </label>
        {vehicleId && date && (
          <div className="text-sm">
            <div className="text-xs text-slate-600 mb-1">Which hire had the van that day?</div>
            {matches === null ? (
              <div className="text-xs text-slate-400">Looking…</div>
            ) : (
              <div className="space-y-1">
                {options.map((m) => (
                  <label key={`${m.job_id}|${m.driver_id}`} className="flex items-center gap-2">
                    <input type="radio" name="hire" checked={pick === `${m.job_id}|${m.driver_id || ''}`} onChange={() => setPick(`${m.job_id}|${m.driver_id || ''}`)} />
                    <span>#{m.hh_job_number} {m.job_name}{m.driver_name ? ` — ${m.driver_name}` : ''}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2">
                  <input type="radio" name="hire" checked={pick === 'none'} onChange={() => setPick('none')} />
                  <span>{options.length ? 'None of these / not sure' : 'No hire had it that day (e.g. in the yard)'}</span>
                </label>
              </div>
            )}
          </div>
        )}
        <label className="block text-sm">
          <span className="text-xs text-slate-600">Summary</span>
          <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Letter from Admiral: alleged side-swipe on the M25" className="mt-1 w-full border rounded px-2 py-1.5" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-600">Detail (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mt-1 w-full border rounded px-2 py-1.5" />
        </label>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white disabled:opacity-50">
            {busy ? 'Logging…' : 'Log Problem + open case'}
          </button>
        </div>
      </div>
    </div>
  );
}
