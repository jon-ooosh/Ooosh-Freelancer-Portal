/**
 * StudioSittersPage — Operations > Studio Sitters (Rehearsals module, Phase B).
 *
 * The site-evening roster: one row per night that needs cover (derived across all
 * rehearsal jobs) plus any manual-override shifts. Staff assign / reassign / clear
 * an approved freelancer per night (Studio-Sitter-tagged surfaced first), bulk-
 * assign across a range, and force cover on a daytime day. One sitter per night
 * covers the whole building — see docs/REHEARSALS-SPEC.md.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface RosterJobEntry {
  job_id: string;
  hh_job_number: number | null;
  label: string;
  rooms: string[];
}
interface RosterAssignee {
  id: string;
  name: string;
  is_studio_sitter: boolean;
  status: string;
}
interface RosterRow {
  date: string;
  needs_sitter: boolean;
  jobs: RosterJobEntry[];
  shift: { id: string; status: string; manual_override: boolean; override_reason: string | null } | null;
  assignee: RosterAssignee | null;
}
interface SitterOption {
  id: string;
  name: string;
  is_studio_sitter: boolean;
  skills: string[];
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export default function StudioSittersPage() {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [sitters, setSitters] = useState<SitterOption[]>([]);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Picker modal: assign one date, or bulk over the range.
  const [picker, setPicker] = useState<{ mode: 'assign' | 'bulk'; date?: string } | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // Add-cover (manual override) form
  const [showAddCover, setShowAddCover] = useState(false);
  const [coverDate, setCoverDate] = useState(todayIso());
  const [coverReason, setCoverReason] = useState('');

  const from = todayIso();
  const to = addDaysIso(from, days);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ data: RosterRow[] }>(`/studio-sitters/roster?from=${from}&to=${to}`);
      setRows(r.data ?? []);
    } catch {
      setError('Failed to load the roster.');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ data: SitterOption[] }>('/studio-sitters/sitters').then((r) => setSitters(r.data ?? [])).catch(() => {});
  }, []);

  async function assign(date: string, personId: string) {
    setBusy(true);
    try {
      await api.post('/studio-sitters/assign', { date, person_id: personId });
      setPicker(null);
      setPickerSearch('');
      await load();
    } catch {
      setError('Failed to assign.');
    } finally {
      setBusy(false);
    }
  }

  async function bulkAssign(personId: string) {
    setBusy(true);
    try {
      const r = await api.post<{ data: { assigned: number } }>('/studio-sitters/bulk-assign', { from, to, person_id: personId });
      setPicker(null);
      setPickerSearch('');
      await load();
      const n = r.data?.assigned ?? 0;
      if (n === 0) setError('No unassigned evenings in range to fill.');
    } catch {
      setError('Failed to bulk-assign.');
    } finally {
      setBusy(false);
    }
  }

  async function clearAssignee(date: string) {
    setBusy(true);
    try {
      await api.post('/studio-sitters/unassign', { date });
      await load();
    } catch {
      setError('Failed to clear.');
    } finally {
      setBusy(false);
    }
  }

  async function addCover() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(coverDate)) { setError('Pick a valid date.'); return; }
    setBusy(true);
    try {
      await api.post('/studio-sitters/manual', { date: coverDate, reason: coverReason || undefined });
      setShowAddCover(false);
      setCoverReason('');
      await load();
    } catch {
      setError('Failed to add cover.');
    } finally {
      setBusy(false);
    }
  }

  const filteredSitters = sitters.filter((s) =>
    !pickerSearch.trim() || s.name.toLowerCase().includes(pickerSearch.toLowerCase()));

  const unassignedCount = rows.filter((r) => r.needs_sitter && !r.assignee).length;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Studio Sitters</h1>
          <p className="text-sm text-gray-500">One sitter per evening covers the whole building.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddCover((v) => !v)} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">＋ Add cover</button>
          <button onClick={() => setPicker({ mode: 'bulk' })} disabled={unassignedCount === 0} className="px-3 py-1.5 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40">
            Bulk assign{unassignedCount > 0 ? ` (${unassignedCount})` : ''}
          </button>
        </div>
      </div>

      {/* Range presets */}
      <div className="flex items-center gap-1 mb-4">
        {[7, 14, 28].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-3 py-1 text-sm rounded-lg border ${days === d ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {d} days
          </button>
        ))}
        <span className="text-xs text-gray-400 ml-2">{formatDay(from)} – {formatDay(to)}</span>
      </div>

      {showAddCover && (
        <div className="mb-4 p-3 rounded-lg border border-gray-200 bg-gray-50 flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-600">Date
            <input type="date" value={coverDate} onChange={(e) => setCoverDate(e.target.value)} className="block mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-xs text-gray-600 flex-1 min-w-[180px]">Reason (optional)
            <input type="text" value={coverReason} onChange={(e) => setCoverReason(e.target.value)} placeholder="e.g. both rooms in, short-staffed" className="block mt-0.5 w-full px-2 py-1 border border-gray-300 rounded text-sm" />
          </label>
          <button onClick={addCover} disabled={busy} className="px-3 py-1.5 text-sm rounded-lg bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-40">Add</button>
        </div>
      )}

      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Loading roster…</div>
      ) : rows.length === 0 ? (
        <div className="text-gray-500 text-sm py-10 text-center border border-dashed border-gray-200 rounded-lg">
          No evenings need a studio sitter in this range.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.date} className={`rounded-xl border p-3 sm:p-4 ${row.assignee ? 'border-green-200 bg-green-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900">
                    {formatDay(row.date)}
                    {row.shift?.manual_override && (
                      <span className="ml-2 text-[11px] font-normal px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">manual cover</span>
                    )}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {row.jobs.length === 0 ? (
                      <div className="text-xs text-gray-400">{row.shift?.override_reason || 'Manual cover — no rehearsal job on this night'}</div>
                    ) : row.jobs.map((j, i) => (
                      <div key={i} className="text-xs text-gray-600">
                        {j.hh_job_number ? (
                          <Link to={`/jobs/${j.job_id}`} className="text-purple-600 hover:text-purple-800 font-medium">#{j.hh_job_number}</Link>
                        ) : null}{' '}
                        <span className="text-gray-800">{j.label}</span>
                        {j.rooms.length > 0 && <span className="text-gray-400"> — {j.rooms.join(', ')}</span>}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {row.assignee ? (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-green-100 text-green-800 text-sm">
                      {row.assignee.is_studio_sitter && <span title="Studio Sitter tag">⭐</span>}
                      {row.assignee.name}
                      {row.assignee.status === 'confirmed' && <span className="text-[11px] text-green-600">✓ confirmed</span>}
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded-lg bg-amber-100 text-amber-800 text-sm">Unassigned</span>
                  )}
                  <button onClick={() => setPicker({ mode: 'assign', date: row.date })} disabled={busy}
                    className="px-2.5 py-1 text-xs rounded-lg border border-gray-300 hover:bg-white disabled:opacity-40">
                    {row.assignee ? 'Reassign' : 'Assign'}
                  </button>
                  {row.assignee && (
                    <button onClick={() => clearAssignee(row.date)} disabled={busy}
                      className="px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-white disabled:opacity-40">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sitter picker modal (assign one date / bulk) */}
      {picker && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setPicker(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b">
              <h2 className="font-semibold text-gray-900">
                {picker.mode === 'bulk' ? `Bulk assign — ${unassignedCount} unassigned evening${unassignedCount !== 1 ? 's' : ''}` : `Assign sitter — ${picker.date ? formatDay(picker.date) : ''}`}
              </h2>
              <input autoFocus value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search approved freelancers…"
                className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div className="overflow-y-auto p-2">
              {filteredSitters.length === 0 ? (
                <div className="text-sm text-gray-400 p-4 text-center">No approved freelancers found.</div>
              ) : filteredSitters.map((s) => (
                <button key={s.id} disabled={busy}
                  onClick={() => picker.mode === 'bulk' ? bulkAssign(s.id) : assign(picker.date!, s.id)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-purple-50 flex items-center justify-between disabled:opacity-40">
                  <span className="flex items-center gap-1.5">
                    {s.is_studio_sitter && <span title="Studio Sitter tag">⭐</span>}
                    <span className="text-sm text-gray-800">{s.name}</span>
                  </span>
                  {s.is_studio_sitter && <span className="text-[11px] text-purple-600">Studio Sitter</span>}
                </button>
              ))}
            </div>
            <div className="p-3 border-t text-right">
              <button onClick={() => setPicker(null)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
