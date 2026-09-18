/**
 * StudioSittersPage — Operations > Studio Sitters (Rehearsals module).
 *
 * The site-evening roster: one row per night that needs cover (derived across all
 * rehearsal jobs) plus any manual-override shifts. Staff assign / reassign / clear
 * an approved freelancer per night (Studio-Sitter-tagged first), select specific
 * nights to bulk-assign, force manual cover on a daytime day, and set the default
 * per-night fee. One sitter per night covers the whole building.
 * See docs/REHEARSALS-SPEC.md.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import StudioShiftNotes from '../components/StudioShiftNotes';
import StudioLockupReport from '../components/StudioLockupReport';

interface RosterJobEntry {
  job_id: string;
  hh_job_number: number | null;
  label: string;
  rooms: string[];
  speculative?: boolean;
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
  speculative?: boolean;
  jobs: RosterJobEntry[];
  shift: {
    id: string; status: string; manual_override: boolean; override_reason: string | null; note_count?: number;
    report?: { submitted_at: string; submitted_by_name: string | null; exceptions_count: number } | null;
  } | null;
  assignee: RosterAssignee | null;
}
interface SitterOption {
  id: string;
  name: string;
  is_studio_sitter: boolean;
  skills: string[];
}

type RangeKey = '7' | '14' | 'all';
type CoverageFilter = 'all' | 'unassigned' | 'assigned';
// from/to are optional custom-range overrides (for looking back through history);
// when unset the range preset drives a today→+N forward window.
interface Prefs { range: RangeKey; filter: CoverageFilter; speculative: boolean; from?: string; to?: string; }

const PREFS_KEY = 'ooosh_studio_sitters_prefs';
const RANGE_DAYS: Record<RangeKey, number> = { '7': 7, '14': 14, all: 730 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (['7', '14', 'all'].includes(p.range) && ['all', 'unassigned', 'assigned'].includes(p.filter)) {
        return {
          range: p.range,
          filter: p.filter,
          speculative: p.speculative === true,
          from: DATE_RE.test(p.from) ? p.from : undefined,
          to: DATE_RE.test(p.to) ? p.to : undefined,
        };
      }
    }
  } catch { /* ignore */ }
  return { range: '14', filter: 'all', speculative: false };
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export default function StudioSittersPage() {
  const { user } = useAuthStore();
  const isManager = hasManagerRole(user?.role || '');

  const [rows, setRows] = useState<RosterRow[]>([]);
  const [sitters, setSitters] = useState<SitterOption[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Selection for date-specific bulk assign
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Sitter picker: assign one date, or the selected dates
  const [picker, setPicker] = useState<{ mode: 'assign'; date: string } | { mode: 'selected' } | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');

  // Handover notes: which shift ids have their notes panel expanded
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const toggleNotes = (id: string) => setOpenNotes((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Lock-up report read-only panels, keyed by shift date.
  const [openReports, setOpenReports] = useState<Set<string>>(new Set());
  const toggleReport = (date: string) => setOpenReports((prev) => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  // Add-cover (manual override)
  const [showAddCover, setShowAddCover] = useState(false);
  const [coverDate, setCoverDate] = useState(todayIso());
  const [coverReason, setCoverReason] = useState('');

  // Default fee
  const [defaultFee, setDefaultFee] = useState<number | null>(null);
  const [editingFee, setEditingFee] = useState(false);
  const [feeInput, setFeeInput] = useState('');

  // Custom from/to (history look-back) override the forward preset window.
  const from = prefs.from || todayIso();
  const to = prefs.to || addDaysIso(todayIso(), RANGE_DAYS[prefs.range]);
  const customRange = !!(prefs.from || prefs.to);

  useEffect(() => { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const spec = prefs.speculative ? '&speculative=1' : '';
      const r = await api.get<{ data: RosterRow[] }>(`/studio-sitters/roster?from=${from}&to=${to}${spec}`);
      setRows(r.data ?? []);
    } catch {
      setError('Failed to load the roster.');
    } finally {
      setLoading(false);
    }
  }, [from, to, prefs.speculative]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ data: SitterOption[] }>('/studio-sitters/sitters').then((r) => setSitters(r.data ?? [])).catch(() => {});
    api.get<{ data: { fee: number | null } }>('/studio-sitters/default-fee').then((r) => setDefaultFee(r.data?.fee ?? null)).catch(() => {});
  }, []);

  async function assign(date: string, personId: string) {
    setBusy(true);
    try {
      await api.post('/studio-sitters/assign', { date, person_id: personId });
      setPicker(null); setPickerSearch('');
      await load();
    } catch { setError('Failed to assign.'); } finally { setBusy(false); }
  }

  async function assignSelected(personId: string) {
    setBusy(true);
    try {
      const dates = [...selected];
      await api.post('/studio-sitters/bulk-assign', { dates, person_id: personId });
      setPicker(null); setPickerSearch(''); setSelected(new Set());
      await load();
    } catch { setError('Failed to assign selected.'); } finally { setBusy(false); }
  }

  async function clearAssignee(date: string) {
    setBusy(true);
    try { await api.post('/studio-sitters/unassign', { date }); await load(); }
    catch { setError('Failed to clear.'); } finally { setBusy(false); }
  }

  async function removeCover(date: string) {
    setBusy(true);
    try { await api.post('/studio-sitters/remove-cover', { date }); await load(); }
    catch { setError('Failed to remove cover.'); } finally { setBusy(false); }
  }

  async function addCover() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(coverDate)) { setError('Pick a valid date.'); return; }
    setBusy(true);
    try {
      await api.post('/studio-sitters/manual', { date: coverDate, reason: coverReason || undefined });
      setShowAddCover(false); setCoverReason('');
      await load();
    } catch { setError('Failed to add cover.'); } finally { setBusy(false); }
  }

  async function saveFee() {
    const trimmed = feeInput.trim();
    const fee = trimmed === '' ? null : Number(trimmed);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) { setError('Invalid fee.'); return; }
    setBusy(true);
    try {
      await api.put('/studio-sitters/default-fee', { fee });
      setDefaultFee(fee); setEditingFee(false);
    } catch { setError('Failed to save fee.'); } finally { setBusy(false); }
  }

  function toggleSelect(date: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  }

  // Coverage filter
  const visibleRows = rows.filter((r) => {
    if (prefs.filter === 'assigned') return !!r.assignee;
    if (prefs.filter === 'unassigned') return r.needs_sitter && !r.assignee;
    return true;
  });
  const selectableVisible = visibleRows.filter((r) => r.needs_sitter && !r.assignee);
  const allSelectableSelected = selectableVisible.length > 0 && selectableVisible.every((r) => selected.has(r.date));

  const filteredSitters = sitters.filter((s) => !pickerSearch.trim() || s.name.toLowerCase().includes(pickerSearch.toLowerCase()));

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Studio Sitters</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddCover((v) => !v)} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">＋ Add cover</button>
        </div>
      </div>

      {/* Controls: range + coverage filter + enquiries + default fee */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        <div className="flex items-center gap-1">
          {(['7', '14', 'all'] as RangeKey[]).map((k) => (
            <button key={k} onClick={() => setPrefs((p) => ({ ...p, range: k, from: undefined, to: undefined }))}
              className={`px-3 py-1 text-sm rounded-lg border ${!customRange && prefs.range === k ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {k === 'all' ? 'All' : `${k} days`}
            </button>
          ))}
        </div>
        {/* Custom date range — look back through history */}
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <input type="date" value={prefs.from || todayIso()}
            onChange={(e) => setPrefs((p) => ({ ...p, from: DATE_RE.test(e.target.value) ? e.target.value : undefined }))}
            className={`px-2 py-1 border rounded ${customRange ? 'border-purple-300 text-purple-700' : 'border-gray-300 text-gray-600'}`} title="From" />
          <span>→</span>
          <input type="date" value={to}
            onChange={(e) => setPrefs((p) => ({ ...p, to: DATE_RE.test(e.target.value) ? e.target.value : undefined }))}
            className={`px-2 py-1 border rounded ${customRange ? 'border-purple-300 text-purple-700' : 'border-gray-300 text-gray-600'}`} title="To" />
          {customRange && (
            <button onClick={() => setPrefs((p) => ({ ...p, from: undefined, to: undefined }))}
              className="text-purple-600 hover:text-purple-800" title="Back to upcoming">Reset</button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'unassigned', 'assigned'] as CoverageFilter[]).map((f) => (
            <button key={f} onClick={() => setPrefs((p) => ({ ...p, filter: f }))}
              className={`px-3 py-1 text-sm rounded-lg border capitalize ${prefs.filter === f ? 'bg-gray-800 border-gray-800 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {f}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" checked={prefs.speculative}
            onChange={(e) => setPrefs((p) => ({ ...p, speculative: e.target.checked }))} />
          Include enquiries
        </label>
        <div className="text-sm text-gray-600 ml-auto flex items-center gap-2">
          {editingFee ? (
            <span className="flex items-center gap-1">
              Default fee £<input type="number" min="0" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} className="w-20 px-2 py-1 border border-gray-300 rounded text-sm" />
              <button onClick={saveFee} disabled={busy} className="px-2 py-1 text-xs rounded bg-gray-800 text-white disabled:opacity-40">Save</button>
              <button onClick={() => setEditingFee(false)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
            </span>
          ) : (
            <span>
              Default fee: <span className="font-medium">{defaultFee != null ? `£${defaultFee}` : '—'}</span>
              {isManager && (
                <button onClick={() => { setFeeInput(defaultFee != null ? String(defaultFee) : ''); setEditingFee(true); }} className="ml-1 text-xs text-purple-600 hover:text-purple-800">Edit</button>
              )}
            </span>
          )}
        </div>
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

      {/* Selection bar */}
      {selectableVisible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5 text-gray-600">
            <input type="checkbox" checked={allSelectableSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(selectableVisible.map((r) => r.date)) : new Set())} />
            Select all unassigned ({selectableVisible.length})
          </label>
          {selected.size > 0 && (
            <>
              <button onClick={() => setPicker({ mode: 'selected' })} disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40">
                Assign selected ({selected.size})
              </button>
              <button onClick={() => setSelected(new Set())} className="text-gray-500 hover:text-gray-700">Clear selection</button>
            </>
          )}
        </div>
      )}

      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Loading roster…</div>
      ) : visibleRows.length === 0 ? (
        <div className="text-gray-500 text-sm py-10 text-center border border-dashed border-gray-200 rounded-lg">
          {prefs.filter === 'all' ? 'No evenings need a studio sitter in this range.' : `No ${prefs.filter} evenings in this range.`}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleRows.map((row) => {
            const selectable = row.needs_sitter && !row.assignee;
            return (
              <div key={row.date} className={`rounded-xl border p-3 sm:p-4 ${row.assignee ? 'border-green-200 bg-green-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex items-start gap-2">
                    {selectable && (
                      <input type="checkbox" className="mt-1" checked={selected.has(row.date)} onChange={() => toggleSelect(row.date)} />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900">
                        {formatDay(row.date)}
                        {row.speculative && (
                          <span className="ml-2 text-[11px] font-normal px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200" title="Pre-confirmation — enquiry/provisional">enquiry</span>
                        )}
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
                        className="px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-white disabled:opacity-40">Clear</button>
                    )}
                    {row.shift?.manual_override && (
                      <button onClick={() => removeCover(row.date)} disabled={busy}
                        className="px-2.5 py-1 text-xs rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-40">Remove</button>
                    )}
                    {row.shift?.id && (() => {
                      const noteCount = row.shift.note_count ?? 0;
                      const active = openNotes.has(row.shift.id);
                      const hasNotes = noteCount > 0;
                      return (
                        <button onClick={() => toggleNotes(row.shift!.id)}
                          className={`px-2.5 py-1 text-xs rounded-lg border ${active || hasNotes ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-500 hover:bg-white'}`}>
                          💬 Notes{hasNotes ? ` (${noteCount})` : ''}
                        </button>
                      );
                    })()}
                    {row.shift?.report && (() => {
                      const ex = row.shift.report.exceptions_count;
                      return (
                        <button onClick={() => toggleReport(row.date)}
                          className={`px-2.5 py-1 text-xs rounded-lg border ${ex > 0 ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-green-300 bg-green-50 text-green-700'}`}
                          title={`Lock-up report submitted${row.shift.report.submitted_by_name ? ` by ${row.shift.report.submitted_by_name}` : ''}`}>
                          🔒 Lock-up{ex > 0 ? ` (⚠ ${ex})` : ' ✓'}
                        </button>
                      );
                    })()}
                  </div>
                </div>

                {row.shift?.id && openNotes.has(row.shift.id) && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <StudioShiftNotes shiftId={row.shift.id} />
                  </div>
                )}

                {row.shift?.report && openReports.has(row.date) && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <StudioLockupReport date={row.date} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sitter picker modal */}
      {picker && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setPicker(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b">
              <h2 className="font-semibold text-gray-900">
                {picker.mode === 'selected' ? `Assign ${selected.size} selected night${selected.size !== 1 ? 's' : ''}` : `Assign sitter — ${formatDay(picker.date)}`}
              </h2>
              <input autoFocus value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search approved freelancers…"
                className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div className="overflow-y-auto p-2">
              {filteredSitters.length === 0 ? (
                <div className="text-sm text-gray-400 p-4 text-center">No approved freelancers found.</div>
              ) : filteredSitters.map((s) => (
                <button key={s.id} disabled={busy}
                  onClick={() => picker.mode === 'selected' ? assignSelected(s.id) : assign(picker.date, s.id)}
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
