/**
 * LeadsPage — Jobs > Leads. The Lead Finder (Tour Finder → OP).
 * Spec: docs/TOUR-FINDER-SPEC.md.
 *
 * Find touring bands that fit the Ooosh profile (Ticketmaster), AI-score them,
 * match against the address book (Cold vs Warm/Remarketing), and research
 * contacts for cold leads. Expand a row for contacts, venues, and match detail.
 */
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';

interface Contact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
}
interface MatchCandidate { id: string; name: string; type: string | null; similarity: number; }

interface Lead {
  id: string;
  artist_name: string;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  relevance_score: number | null;
  client_tier: number | null;
  origin_country: string | null;
  is_international: boolean | null;
  reasoning: string | null;
  ai_summary: string | null;
  stream: 'cold' | 'warm';
  match_confidence: 'exact' | 'partial' | 'none';
  match_candidates: MatchCandidate[];
  matched_organisation_id: string | null;
  matched_org_name: string | null;
  contacts: Contact[];
  status: string;
}

interface Run {
  id: string;
  status: 'running' | 'complete' | 'failed';
  counts: {
    mode?: string;
    collection?: { newEvents: number };
    detection?: { toursCreated: number; droppedTooImminent: number; droppedNotTour: number };
    scoring?: { scored: number; skipped: number };
    matching?: { exact: number; partial: number };
    research?: { researched: number; contactsFound: number; failed?: number; lastError?: string };
  } | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  triggered_by_name: string | null;
}
interface Setting { key: string; value: string | null; }

const SCORE_CLS = (s: number | null): string =>
  s == null ? 'bg-gray-100 text-gray-500'
  : s >= 8 ? 'bg-green-100 text-green-800'
  : s >= 6 ? 'bg-lime-100 text-lime-800'
  : s >= 4 ? 'bg-amber-100 text-amber-800'
  : 'bg-gray-100 text-gray-600';
const TIER_LABEL: Record<number, string> = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };
const STATUS_CLS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-700', reviewing: 'bg-indigo-100 text-indigo-700',
  contacted: 'bg-purple-100 text-purple-700', converted: 'bg-green-100 text-green-700',
  dismissed: 'bg-gray-100 text-gray-500', not_relevant: 'bg-gray-100 text-gray-500',
};
const fmtDate = (d: string | null): string =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

type SortKey = 'band' | 'dates' | 'uk' | 'score' | 'origin' | 'contacts' | 'status';
const SORT_COLS: { key: SortKey; label: string; align: 'left' | 'right' | 'center'; defDir: 'asc' | 'desc' }[] = [
  { key: 'band', label: 'Band', align: 'left', defDir: 'asc' },
  { key: 'dates', label: 'Tour dates', align: 'left', defDir: 'asc' },
  { key: 'uk', label: 'UK dates', align: 'right', defDir: 'desc' },
  { key: 'score', label: 'Score', align: 'center', defDir: 'desc' },
  { key: 'origin', label: 'Origin', align: 'left', defDir: 'asc' },
  { key: 'contacts', label: 'Contacts', align: 'center', defDir: 'desc' },
  { key: 'status', label: 'Status', align: 'left', defDir: 'asc' },
];
function sortValue(l: Lead, key: SortKey): string | number {
  switch (key) {
    case 'band': return l.artist_name.toLowerCase();
    case 'dates': return l.first_date ?? '';
    case 'uk': return l.uk_date_count;
    case 'score': return l.relevance_score ?? -1;
    case 'origin': return (l.origin_country ?? '').toLowerCase();
    case 'contacts': return l.contacts?.length ?? 0;
    case 'status': return l.status;
  }
}

export default function LeadsPage() {
  const { user } = useAuthStore();
  const canRun = hasManagerRole(user?.role);

  const [tab, setTab] = useState<'cold' | 'warm'>('cold');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLeads = useCallback(async () => {
    const resp = await api.get<{ data: Lead[] }>('/leads');
    setLeads(resp.data);
  }, []);
  const loadRun = useCallback(async () => {
    const resp = await api.get<{ data: Run | null }>('/leads/runs/latest');
    setRun(resp.data);
    return resp.data;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [, , s] = await Promise.all([loadLeads(), loadRun(), api.get<{ data: Setting[] }>('/leads/settings')]);
        setSettings(s.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load leads');
      } finally { setLoading(false); }
    })();
  }, [loadLeads, loadRun]);

  const isRunning = run?.status === 'running';

  // Poll while running (robust: a transient error doesn't kill the loop); refresh list on finish.
  useEffect(() => {
    if (isRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const latest = await loadRun();
          if (latest?.status !== 'running') {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            await loadLeads();
          }
        } catch { /* transient — try again next tick */ }
      }, 4000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [isRunning, loadRun, loadLeads]);

  // Elapsed-time ticker while running (reassurance the search is alive).
  useEffect(() => {
    if (isRunning && run?.started_at) {
      const start = new Date(run.started_at).getTime();
      const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
      tick();
      tickRef.current = setInterval(tick, 1000);
    }
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };
  }, [isRunning, run?.started_at]);

  const startRun = async () => {
    setStarting(true); setError(null);
    try { await api.post('/leads/run', {}); await loadRun(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to start search'); }
    finally { setStarting(false); }
  };
  const refresh = async () => {
    try { await Promise.all([loadLeads(), loadRun()]); } catch { /* noop */ }
  };
  const processExisting = async () => {
    setStarting(true); setError(null);
    try { await api.post('/leads/process-existing', {}); await loadRun(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to start'); }
    finally { setStarting(false); }
  };
  const stopRun = async () => {
    try { await api.post('/leads/cancel', {}); await loadRun(); } catch { /* noop */ }
  };
  const toggleSort = (key: SortKey, defDir: 'asc' | 'desc') => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(defDir); }
  };
  const updateLead = async (id: string, status: string) => {
    await api.patch(`/leads/${id}`, { status }); await loadLeads();
  };
  const confirmMatch = async (id: string, organisation_id: string) => {
    await api.post(`/leads/${id}/confirm-match`, { organisation_id }); await loadLeads();
  };
  const rejectMatch = async (id: string) => {
    await api.post(`/leads/${id}/reject-match`, {}); await loadLeads();
  };

  const sv = (k: string) => settings.find((s) => s.key === k)?.value ?? '';
  const coldCount = leads.filter((l) => l.stream === 'cold').length;
  const warmCount = leads.filter((l) => l.stream === 'warm').length;

  const q = search.trim().toLowerCase();
  const shown = leads
    .filter((l) => l.stream === tab && (!q || l.artist_name.toLowerCase().includes(q) || (l.origin_country ?? '').toLowerCase().includes(q)))
    .sort((a, b) => {
      const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500 mt-1">
            Touring bands that fit the Ooosh profile, found via Ticketmaster, scored, and matched to your address book.
          </p>
          {settings.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Looking {sv('lead_lookahead_min_weeks')}–{sv('lead_lookahead_max_weeks')} weeks ahead ·
              tour = {sv('lead_tour_min_dates')}+ UK dates within {sv('lead_tour_window_weeks')} weeks
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button onClick={refresh} className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">
            ↻ Refresh
          </button>
          {canRun && isRunning && (
            <button onClick={stopRun} className="px-3 py-2 rounded-lg border border-red-300 text-red-700 text-sm hover:bg-red-50">
              ■ Stop
            </button>
          )}
          {canRun && (
            <button onClick={processExisting} disabled={starting || isRunning} title="Match + research the leads already found — no Ticketmaster crawl (fast)"
              className="px-3 py-2 rounded-lg border border-[#7B5EA7] text-[#7B5EA7] text-sm font-medium hover:bg-purple-50 disabled:opacity-50">
              ✨ Match &amp; research existing
            </button>
          )}
          {canRun && (
            <button onClick={startRun} disabled={starting || isRunning}
              className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
              {isRunning ? 'Searching…' : starting ? 'Starting…' : '🔍 Run search now'}
            </button>
          )}
        </div>
      </div>

      {run && (
        <div className={`rounded-lg px-4 py-3 mb-4 text-sm ${
          run.status === 'running' ? 'bg-blue-50 text-blue-800'
          : run.status === 'failed' ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-600'}`}>
          {run.status === 'running' && (
            <>
              <span className="inline-block animate-pulse mr-1">●</span>
              Search running — {Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed.
              It runs in the background across ~24 venues and every band's UK dates, so it takes a few minutes.
              <b> This page updates automatically — no need to refresh.</b>
            </>
          )}
          {run.status === 'failed' && <>Last run failed: {run.error || 'unknown error'}</>}
          {run.status === 'complete' && run.counts && (
            <>
              {run.counts.mode === 'process_existing' ? (
                <>Processed existing leads {run.finished_at ? new Date(run.finished_at).toLocaleString('en-GB') : ''} — matched {run.counts.matching?.exact ?? 0} known band(s), {run.counts.matching?.partial ?? 0} possible; found contacts for {run.counts.research?.researched ?? 0} cold lead(s).</>
              ) : (
                <>
                  Last search {run.finished_at ? new Date(run.finished_at).toLocaleString('en-GB') : ''}
                  {run.triggered_by_name ? ` by ${run.triggered_by_name}` : ''} —
                  {' '}<b>{run.counts.detection?.toursCreated ?? 0}</b> new tours
                  {' '}(scored {run.counts.scoring?.scored ?? 0}, dropped {run.counts.detection?.droppedTooImminent ?? 0} too-imminent).
                  {' '}Matched {run.counts.matching?.exact ?? 0} known band(s), {run.counts.matching?.partial ?? 0} possible.
                  {' '}Found contacts for {run.counts.research?.researched ?? 0} cold lead(s).
                </>
              )}
              {(run.counts.research?.failed ?? 0) > 0 && run.counts.research?.lastError && (
                <div className="mt-1 text-amber-700">⚠ Contact research errored on {run.counts.research.failed} lead(s): {run.counts.research.lastError}</div>
              )}
            </>
          )}
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 text-red-800 px-4 py-3 mb-4 text-sm">{error}</div>}

      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-gray-200 mb-4">
        <div className="flex gap-1">
          {(['cold', 'warm'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === t ? 'border-[#7B5EA7] text-[#7B5EA7]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t === 'cold' ? `Cold (${coldCount})` : `Warm / Remarketing (${warmCount})`}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search band or origin…"
          className="mb-1 px-3 py-1.5 rounded-lg border border-gray-300 text-sm w-56"
        />
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          {tab === 'warm'
            ? 'No matches to bands you’ve worked with yet. Warm leads appear here when a detected tour matches your address book.'
            : `No leads yet.${canRun ? ' Run a search to find touring bands.' : ''}`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                {SORT_COLS.map((c) => (
                  <th key={c.key}
                    className={`px-3 py-2 cursor-pointer select-none hover:text-gray-700 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}
                    onClick={() => toggleSort(c.key, c.defDir)}>
                    {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((l) => (
                <Fragment key={l.id}>
                  <tr className="hover:bg-gray-50 align-top cursor-pointer" onClick={() => setExpanded(expanded === l.id ? null : l.id)}>
                    <td className="px-3 py-2 font-medium text-gray-900">
                      <span className="mr-1 text-gray-300">{expanded === l.id ? '▾' : '▸'}</span>
                      {l.artist_name}
                      {l.is_international && <span className="ml-1 text-xs text-gray-400" title="International act">✈</span>}
                      {tab === 'warm' && l.matched_org_name && (
                        <Link to={`/organisations/${l.matched_organisation_id}`} onClick={(e) => e.stopPropagation()}
                          className="block text-xs text-green-700 hover:underline">↩ {l.matched_org_name}</Link>
                      )}
                      {tab === 'cold' && l.match_confidence === 'partial' && l.match_candidates[0] && (
                        <div className="mt-1 text-xs" onClick={(e) => e.stopPropagation()}>
                          <span className="text-amber-700">Possible: {l.match_candidates[0].name}?</span>
                          <button onClick={() => confirmMatch(l.id, l.match_candidates[0].id)} className="ml-2 text-green-700 hover:underline">Confirm</button>
                          <button onClick={() => rejectMatch(l.id)} className="ml-2 text-gray-400 hover:underline">Reject</button>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(l.first_date)} – {fmtDate(l.last_date)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{l.uk_date_count}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${SCORE_CLS(l.relevance_score)}`}>{l.relevance_score ?? '—'}</span>
                      {l.client_tier && <div className="text-[10px] text-gray-400 mt-0.5">{TIER_LABEL[l.client_tier]}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.origin_country ?? '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-500">{l.contacts?.length ? l.contacts.length : '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_CLS[l.status] ?? 'bg-gray-100 text-gray-600'}`}>{l.status.replace('_', ' ')}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                      {l.status !== 'dismissed' && (
                        <button onClick={() => updateLead(l.id, 'dismissed')} className="text-xs text-gray-400 hover:text-red-600" title="Dismiss this lead">Dismiss</button>
                      )}
                    </td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={8} className="px-6 py-3 text-xs text-gray-600">
                        {l.ai_summary && <p className="mb-2 text-gray-700">{l.ai_summary}</p>}
                        {l.venues?.length > 0 && <p className="mb-2"><span className="text-gray-400">Venues:</span> {l.venues.join(', ')}</p>}
                        {l.reasoning && <p className="mb-2"><span className="text-gray-400">Assessment:</span> {l.reasoning}</p>}
                        {l.contacts?.length > 0 ? (
                          <div className="mb-1">
                            <div className="text-gray-400 mb-1">Contacts found:</div>
                            <ul className="space-y-1">
                              {l.contacts.map((c, i) => (
                                <li key={i} className="flex flex-wrap gap-x-2">
                                  <span className="font-medium">{c.contact_name || c.contact_type}</span>
                                  <span className="text-gray-400">({c.contact_type})</span>
                                  {c.contact_email && <a href={`mailto:${c.contact_email}`} className="text-blue-600 hover:underline">{c.contact_email}</a>}
                                  {c.contact_phone && <span>{c.contact_phone}</span>}
                                  <span className={`text-[10px] px-1 rounded ${c.confidence === 'high' ? 'bg-green-100 text-green-700' : c.confidence === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{c.confidence}</span>
                                  {c.source && <span className="text-gray-400">· {c.source}</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : tab === 'cold' ? (
                          <p className="text-gray-400">No contacts found yet.</p>
                        ) : null}
                        {tab === 'cold' && l.match_candidates?.length > 0 && (
                          <div className="mt-2">
                            <div className="text-gray-400 mb-1">Possible address-book matches:</div>
                            {l.match_candidates.map((c) => (
                              <div key={c.id} className="flex items-center gap-2">
                                <span>{c.name} <span className="text-gray-400">({c.type ?? 'org'}, {(c.similarity * 100).toFixed(0)}%)</span></span>
                                <button onClick={() => confirmMatch(l.id, c.id)} className="text-green-700 hover:underline">Confirm this</button>
                              </div>
                            ))}
                            <button onClick={() => rejectMatch(l.id)} className="mt-1 text-gray-400 hover:underline">None of these</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
