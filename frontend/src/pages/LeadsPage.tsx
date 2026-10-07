/**
 * LeadsPage — Jobs > Leads. The Lead Finder (Tour Finder → OP).
 * Spec: docs/TOUR-FINDER-SPEC.md (§17 is this layout).
 *
 * Organised by WHERE A LEAD HAS GOT TO — To review · Contacted · In pipeline ·
 * Dismissed (the backend's `stage`) — with warm/cold as a filter + badge, since
 * staff work it in batches (a search every few weeks). Filters live in the URL.
 * The run strip says what the last search did; Search history lists them all and
 * jumps to the leads each one found. Expand a row for history, contacts, venues,
 * match suggestions and the lead's activity timeline.
 */
import { useState, useEffect, useCallback, useRef, Fragment, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import {
  Lead, LeadRun, LeadStage, STAGE_TABS, REASON_LABEL, EVENT_SHORT, fmtDate, fmtDateYear,
  tourJobBadge, isLiveTourJob,
} from '../components/leads/leadTypes';
import LeadTourJobs from '../components/leads/LeadTourJobs';
import DismissLeadModal from '../components/leads/DismissLeadModal';
import RunSearchModal from '../components/leads/RunSearchModal';
import AddToAddressBookModal from '../components/leads/AddToAddressBookModal';
import StartEnquiryModal from '../components/leads/StartEnquiryModal';
import LogOutreachModal from '../components/leads/LogOutreachModal';
import SearchHistoryModal from '../components/leads/SearchHistoryModal';
import LeadTimeline from '../components/leads/LeadTimeline';
import LeadContacts from '../components/leads/LeadContacts';
import RunStrip from '../components/leads/RunStrip';
import LeadFilters, {
  LeadFilterState, filtersFromParams, filtersToParams, applyLeadFilters, tourStarted,
} from '../components/leads/LeadFilters';

interface Setting { key: string; value: string | null; }
interface SettingsResponse { data: Setting[]; default_window?: { from: string; to: string }; max_window_days?: number; }

type Modal =
  | { kind: 'dismiss'; lead: Lead }
  | { kind: 'address'; lead: Lead }
  | { kind: 'enquiry'; lead: Lead }
  | { kind: 'outreach'; lead: Lead }
  | { kind: 'run' }
  | { kind: 'history' }
  | null;

const STAGES: LeadStage[] = ['review', 'contacted', 'pipeline', 'dismissed'];

const SCORE_CLS = (s: number | null): string =>
  s == null ? 'bg-gray-100 text-gray-500'
  : s >= 8 ? 'bg-green-100 text-green-800'
  : s >= 6 ? 'bg-lime-100 text-lime-800'
  : s >= 4 ? 'bg-amber-100 text-amber-800'
  : 'bg-gray-100 text-gray-600';
const TIER_LABEL: Record<number, string> = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };

type SortKey = 'band' | 'dates' | 'uk' | 'score' | 'origin' | 'contacts' | 'activity';
const SORT_COLS: { key: SortKey; label: string; align: 'left' | 'right' | 'center'; defDir: 'asc' | 'desc' }[] = [
  { key: 'band', label: 'Band', align: 'left', defDir: 'asc' },
  { key: 'dates', label: 'Tour dates', align: 'left', defDir: 'asc' },
  { key: 'uk', label: 'UK dates', align: 'right', defDir: 'desc' },
  { key: 'score', label: 'Score', align: 'center', defDir: 'desc' },
  { key: 'origin', label: 'Origin', align: 'left', defDir: 'asc' },
  { key: 'contacts', label: 'Contacts', align: 'center', defDir: 'desc' },
  { key: 'activity', label: 'Last activity', align: 'left', defDir: 'desc' },
];
function sortValue(l: Lead, key: SortKey): string | number {
  switch (key) {
    case 'band': return l.artist_name.toLowerCase();
    case 'dates': return l.first_date ?? '';
    case 'uk': return l.uk_date_count;
    case 'score': return l.relevance_score ?? -1;
    case 'origin': return (l.origin_country ?? '').toLowerCase();
    case 'contacts': return l.contacts?.length ?? 0;
    case 'activity': return l.last_event_at ?? '';
  }
}

/** One-line OOOSH history for the row ("3 booked · 2 lost"). */
function historyChip(l: Lead): string | null {
  const h = l.client_history;
  if (!h) return null;
  const noReply = h.outreach_no_reply ?? 0;
  const noReplyBit = noReply ? `${noReply} outreach, no reply` : null;
  if (h.enquiries === 0) return noReplyBit ?? 'no hires yet';
  const bits = [`${h.booked} booked`];
  if (h.lost) bits.push(`${h.lost} lost`);
  if (h.cancelled) bits.push(`${h.cancelled} cancelled`);
  if (h.open) bits.push(`${h.open} open`);
  if (noReplyBit) bits.push(noReplyBit);
  return bits.join(' · ');
}

/** "You passed on their last tour…" — the previous tour's outcome, shown on this one. */
function prevTourLine(l: Lead): { text: string; flag: boolean } | null {
  if (!l.prev_lead_id) return null;
  const when = `${fmtDateYear(l.prev_first_date)}`;
  if (l.prev_converted_job_id) return { text: `Last tour (${when}) became an enquiry`, flag: false };
  if (l.prev_status === 'dismissed') {
    const reason = REASON_LABEL[l.prev_status_reason ?? ''] ?? 'dismissed';
    return {
      text: `Passed on last tour (${when}): ${reason}${l.prev_status_note ? ` — “${l.prev_status_note}”` : ''}`,
      flag: l.prev_status_reason === 'next_time',
    };
  }
  return null;
}

const todayYmd = () => new Date().toISOString().slice(0, 10);

export default function LeadsPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canRun = hasManagerRole(user?.role);

  // Tab + filters come from the URL (validated — a bad value falls back to the default).
  const tabParam = searchParams.get('tab');
  const tab: LeadStage = STAGES.includes(tabParam as LeadStage) ? (tabParam as LeadStage) : 'review';
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const setTab = (t: LeadStage) => {
    const p = new URLSearchParams(searchParams);
    if (t === 'review') p.delete('tab'); else p.set('tab', t);
    if (t !== 'contacted') p.delete('stale');
    setSearchParams(p, { replace: true });
    setExpanded(null);
  };
  const setFilters = (f: LeadFilterState) => setSearchParams(filtersToParams(f, searchParams), { replace: true });

  const [leads, setLeads] = useState<Lead[]>([]);
  const [hidden, setHidden] = useState<Lead[] | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [run, setRun] = useState<LeadRun | null>(null);
  const [runs, setRuns] = useState<LeadRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [defaultWindow, setDefaultWindow] = useState<{ from: string; to: string } | null>(null);
  const [maxWindowDays, setMaxWindowDays] = useState(366);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; href?: string; linkText?: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [modal, setModal] = useState<Modal>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLeads = useCallback(async () => {
    const resp = await api.get<{ data: Lead[]; hidden_count?: number }>('/leads');
    setLeads(resp.data);
    setHiddenCount(resp.hidden_count ?? 0);
  }, []);
  const loadHidden = useCallback(async () => {
    const resp = await api.get<{ data: Lead[] }>('/leads?view=hidden');
    setHidden(resp.data);
  }, []);
  const loadRun = useCallback(async () => {
    const resp = await api.get<{ data: LeadRun | null }>('/leads/runs/latest');
    setRun(resp.data);
    return resp.data;
  }, []);
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const resp = await api.get<{ data: LeadRun[] }>('/leads/runs');
      setRuns(resp.data);
    } finally { setRunsLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [, , s] = await Promise.all([loadLeads(), loadRun(), api.get<SettingsResponse>('/leads/settings'), loadRuns()]);
        setSettings(s.data);
        if (s.default_window) setDefaultWindow(s.default_window);
        if (s.max_window_days) setMaxWindowDays(s.max_window_days);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load leads');
      } finally { setLoading(false); }
    })();
  }, [loadLeads, loadRun, loadRuns]);

  // Close the ⋯ menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  // Deep link from the dashboard's "Leads to look at" card: ?lead=<id> opens
  // that lead (right tab, expanded, scrolled to). The param is then dropped so
  // a later refresh doesn't keep yanking the view back.
  const deepLinkId = searchParams.get('lead');
  useEffect(() => {
    if (!deepLinkId || loading) return;
    const target = leads.find((l) => l.id === deepLinkId);
    const next = new URLSearchParams(searchParams);
    next.delete('lead');
    if (target) {
      if (target.stage === 'review') next.delete('tab'); else next.set('tab', target.stage);
      setExpanded(target.id);
      setTimeout(() => document.getElementById(`lead-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    }
    setSearchParams(next, { replace: true });
  }, [deepLinkId, loading, leads, searchParams, setSearchParams]);

  // The Dismissed tab loads on first open (and after any change while it's open).
  useEffect(() => {
    if (tab === 'dismissed' && hidden == null) {
      loadHidden().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load dismissed leads'));
    }
  }, [tab, hidden, loadHidden]);

  const isRunning = run?.status === 'running';

  // Poll while running (robust: a transient error doesn't kill the loop); refresh list on finish.
  useEffect(() => {
    if (isRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const latest = await loadRun();
          if (latest?.status !== 'running') {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            await Promise.all([loadLeads(), loadRuns()]);
            setHidden(null);
          }
        } catch { /* transient — try again next tick */ }
      }, 4000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [isRunning, loadRun, loadLeads, loadRuns]);

  // A "Research again" runs in the background — poll the list until it lands
  // (gives up after 3 minutes; a stuck one shows Research again after 5).
  const researchingCount = leads.filter((l) => l.research_status === 'running').length;
  useEffect(() => {
    if (researchingCount === 0) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 180_000) { clearInterval(t); return; }
      loadLeads().catch(() => { /* transient */ });
    }, 5000);
    return () => clearInterval(t);
  }, [researchingCount, loadLeads]);

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

  /** After any change: reload the open list, and drop the dismissed list so it reloads when next shown. */
  const reloadAll = async () => {
    try {
      await loadLeads();
      if (tab === 'dismissed') await loadHidden(); else setHidden(null);
    } catch { /* noop */ }
  };
  const refresh = async () => {
    setMenuOpen(false);
    try { await Promise.all([reloadAll(), loadRun(), loadRuns()]); } catch { /* noop */ }
  };
  const processExisting = async () => {
    setMenuOpen(false);
    setStarting(true); setError(null);
    try { await api.post('/leads/process-existing', {}); await loadRun(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to start'); }
    finally { setStarting(false); }
  };
  const stopRun = async () => {
    try { await api.post('/leads/cancel', {}); await loadRun(); } catch { /* noop */ }
  };
  const showBatch = (runId: string) => {
    setModal(null);
    const p = filtersToParams({ ...filters, run: runId }, searchParams);
    p.delete('tab');
    setSearchParams(p, { replace: true });
  };
  const toggleSort = (key: SortKey, defDir: 'asc' | 'desc') => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(defDir); }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await reloadAll(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); }
  };
  const confirmMatch = (id: string, organisation_id: string) => act(() => api.post(`/leads/${id}/confirm-match`, { organisation_id }));
  const rejectMatch = (id: string) => act(() => api.post(`/leads/${id}/reject-match`, {}));
  const restore = (id: string) => act(() => api.post(`/leads/${id}/restore`, {}));
  // One click when the tour turns out to be one we've already quoted and lost /
  // had cancelled / dismissed — "already handled", with the job named in the note.
  const dismissAlreadyQuoted = (l: Lead) => {
    const dead = (l.tour_jobs ?? []).filter((j) => j.status === 'linked');
    const note = `Already quoted this tour — ${dead.map((j) => tourJobBadge(j).text).join(', ')}`;
    return act(() => api.post(`/leads/${l.id}/dismiss`, { reason: 'already_handled', note }));
  };

  const sv = (k: string) => settings.find((s) => s.key === k)?.value ?? '';
  const today = todayYmd();

  // Tab counts: the open stages from the loaded list (To review / Contacted
  // without tours that have already started — the same rule the tab applies by
  // default); Dismissed from the server's count until its rows are loaded.
  const counts: Record<LeadStage, number> = { review: 0, contacted: 0, pipeline: 0, dismissed: hidden?.length ?? hiddenCount };
  let startedHidden = 0;
  for (const l of leads) {
    if (l.stage === 'dismissed') continue;
    if ((l.stage === 'review' || l.stage === 'contacted') && tourStarted(l, today)) continue;
    counts[l.stage] = (counts[l.stage] ?? 0) + 1;
  }

  const stageRows = tab === 'dismissed' ? (hidden ?? []) : leads.filter((l) => l.stage === tab);
  const hidesStarted = (tab === 'review' || tab === 'contacted') && !filters.started;
  const afterStarted = hidesStarted ? stageRows.filter((l) => !tourStarted(l, today)) : stageRows;
  startedHidden = stageRows.length - afterStarted.length;
  const shown = applyLeadFilters(afterStarted, filters)
    .sort((a, b) => {
      const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  const tabMeta = STAGE_TABS.find((t) => t.key === tab)!;

  const lastActivity = (l: Lead) => {
    if (!l.last_event || !l.last_event_at) return null;
    return {
      label: EVENT_SHORT[l.last_event] ?? l.last_event,
      when: fmtDate(l.last_event_at),
      by: l.last_event_by,
    };
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500 truncate">Touring bands for Ooosh — found on Ticketmaster, scored, matched to your address book.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canRun && (
            <button onClick={() => setModal({ kind: 'run' })} disabled={starting || isRunning}
              className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
              {isRunning ? 'Searching…' : '🔍 Run search…'}
            </button>
          )}
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen((o) => !o)} aria-label="More"
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">⋯</button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-20 py-1 text-sm">
                <button onClick={refresh} className="block w-full text-left px-3 py-2 hover:bg-gray-50">↻ Refresh</button>
                <button onClick={() => { setMenuOpen(false); setModal({ kind: 'history' }); void loadRuns(); }}
                  className="block w-full text-left px-3 py-2 hover:bg-gray-50">🕘 Search history</button>
                {canRun && (
                  <button onClick={processExisting} disabled={starting || isRunning}
                    className="block w-full text-left px-3 py-2 hover:bg-gray-50 disabled:opacity-50">
                    ✨ Match &amp; research existing
                    <span className="block text-xs text-gray-400">Re-match, re-score and research the leads already found — no new search.</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <RunStrip run={run} elapsed={elapsed} canRun={canRun} onStop={stopRun}
        onHistory={() => { setModal({ kind: 'history' }); void loadRuns(); }} onShowBatch={showBatch} />

      {error && <div className="rounded-lg bg-red-50 text-red-800 px-4 py-3 mb-4 text-sm">{error}</div>}
      {notice && (
        <div className="rounded-lg bg-green-50 text-green-800 px-4 py-3 mb-4 text-sm flex justify-between gap-2">
          <span>
            {notice.text}
            {notice.href && <> <Link to={notice.href} className="underline font-medium">{notice.linkText ?? 'Open'} →</Link></>}
          </span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ── Stage tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-gray-200 mb-3 overflow-x-auto">
        {STAGE_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${tab === t.key ? 'border-[#7B5EA7] text-[#7B5EA7]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label} <span className="text-xs text-gray-400">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <LeadFilters value={filters} onChange={setFilters} leads={leads} runs={runs}
        showStale={tab === 'contacted'} shown={shown.length} total={afterStarted.length} />

      {hidesStarted && startedHidden > 0 && (
        <div className="text-xs text-gray-400 mb-2">
          {startedHidden} tour{startedHidden === 1 ? ' has' : 's have'} already started and {startedHidden === 1 ? 'is' : 'are'} hidden ·{' '}
          <button onClick={() => setFilters({ ...filters, started: true })} className="text-[#7B5EA7] hover:underline">show</button>
        </div>
      )}
      {(tab === 'review' || tab === 'contacted') && filters.started && (
        <div className="text-xs text-gray-400 mb-2">
          Including tours that have already started ·{' '}
          <button onClick={() => setFilters({ ...filters, started: false })} className="text-[#7B5EA7] hover:underline">hide them</button>
        </div>
      )}

      {loading || (tab === 'dismissed' && hidden == null) ? (
        <div className="text-center text-gray-400 py-12">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          {stageRows.length > 0 ? 'Nothing matches these filters.' : tabMeta.empty}
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
              {shown.map((l) => {
                const chip = historyChip(l);
                const prev = prevTourLine(l);
                const top = l.match_candidates?.[0];
                const activity = lastActivity(l);
                const started = tourStarted(l, today);
                const tourJobs = l.tour_jobs ?? [];
                const liveJob = tourJobs.find(isLiveTourJob);
                const linkedJobs = tourJobs.filter((j) => j.status === 'linked');
                const suggestedJob = tourJobs.find((j) => j.status === 'suggested');
                const onlyDeadJobs = !liveJob && linkedJobs.length > 0;
                return (
                <Fragment key={l.id}>
                  <tr id={`lead-${l.id}`} className={`hover:bg-gray-50 align-top cursor-pointer ${expanded === l.id ? 'bg-purple-50/40' : ''}`} onClick={() => setExpanded(expanded === l.id ? null : l.id)}>
                    <td className="px-3 py-2 font-medium text-gray-900">
                      <span className="mr-1 text-gray-300">{expanded === l.id ? '▾' : '▸'}</span>
                      {l.artist_name}
                      {l.is_international && <span className="ml-1 text-xs text-gray-400" title="International act">✈</span>}
                      {l.stream === 'warm' && (
                        <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide bg-green-100 text-green-700 px-1.5 py-0.5 rounded" title="A band we know — remarketing">Warm</span>
                      )}
                      {l.matched_organisation_id && l.matched_org_name && (
                        <Link to={`/organisations/${l.matched_organisation_id}`} onClick={(e) => e.stopPropagation()}
                          className={`block text-xs hover:underline ${l.stream === 'warm' ? 'text-green-700' : 'text-gray-500'}`}>
                          {l.match_via === 'job_name' ? `↩ booked via ${l.matched_org_name}` : l.match_via === 'created' ? `📒 ${l.matched_org_name}` : `↩ ${l.matched_org_name}`}
                        </Link>
                      )}
                      {chip && (
                        <div className={`text-xs font-normal ${l.client_history?.do_not_hire ? 'text-red-600' : 'text-gray-500'}`}>
                          {l.client_history?.do_not_hire ? '⚠ Do Not Hire · ' : ''}{chip}
                        </div>
                      )}
                      {l.known_contacts?.length > 0 && (
                        <div className="text-xs font-normal text-teal-700" title="A researched contact is already in your address book">
                          🤝 Known contact: {l.known_contacts[0].name}{l.known_contacts[0].orgs ? ` (${l.known_contacts[0].orgs})` : ''}
                          {l.known_contacts.length > 1 ? ` +${l.known_contacts.length - 1}` : ''}
                        </div>
                      )}
                      {prev && (
                        <div className={`text-xs font-normal ${prev.flag ? 'text-amber-700' : 'text-gray-400'}`}>↻ {prev.text}</div>
                      )}
                      {linkedJobs.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1 font-normal" onClick={(e) => e.stopPropagation()}>
                          {linkedJobs.slice(0, 2).map((j) => {
                            const b = tourJobBadge(j);
                            return (
                              <Link key={j.job_id} to={`/jobs/${j.job_id}`} className={`text-[11px] px-1.5 py-0.5 rounded hover:underline ${b.cls}`}
                                title={`${j.job_name ?? ''} — a job for this tour`}>
                                {b.icon} {b.text}
                              </Link>
                            );
                          })}
                          {linkedJobs.length > 2 && <span className="text-[11px] text-gray-400">+{linkedJobs.length - 2}</span>}
                        </div>
                      )}
                      {!liveJob && suggestedJob && (
                        <div className="mt-0.5 text-xs font-normal text-amber-700">
                          Possible job for this tour: {tourJobBadge(suggestedJob).text} — expand to confirm
                        </div>
                      )}
                      {tab !== 'dismissed' && l.match_confidence === 'partial' && !l.matched_organisation_id && top && (
                        <div className="mt-1 text-xs font-normal" onClick={(e) => e.stopPropagation()}>
                          <span className="text-amber-700">
                            {top.via === 'job_name'
                              ? `Booked via ${top.name}? (${top.job_count} job${top.job_count === 1 ? '' : 's'} named after them)`
                              : `Possible: ${top.name}?`}
                          </span>
                          <button onClick={() => confirmMatch(l.id, top.id)} className="ml-2 text-green-700 hover:underline">Confirm</button>
                          <button onClick={() => rejectMatch(l.id)} className="ml-2 text-gray-400 hover:underline">Reject</button>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                      {fmtDate(l.first_date)} – {fmtDate(l.last_date)}
                      {started && <div className="text-[10px] text-gray-400">already started</div>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">{l.uk_date_count}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${SCORE_CLS(l.relevance_score)}`}>{l.relevance_score ?? '—'}</span>
                      {l.client_tier && <div className="text-[10px] text-gray-400 mt-0.5">{TIER_LABEL[l.client_tier]}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.origin_country ?? '—'}</td>
                    <td className="px-3 py-2 text-center text-gray-500">
                      {l.research_status === 'running' ? <span className="text-blue-600 animate-pulse" title="Researching…">●</span>
                        : l.contacts?.length ? l.contacts.length
                        : l.research_status === 'none' ? <span title="Researched — nothing found">✗</span> : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {activity ? (
                        <>
                          <div>{activity.label} {activity.when}</div>
                          {activity.by && <div className="text-gray-400">{activity.by}</div>}
                        </>
                      ) : '—'}
                      {tab === 'dismissed' && l.status_reason && (
                        <div className="text-[11px] text-gray-500 mt-0.5">{REASON_LABEL[l.status_reason] ?? l.status_reason}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                      {tab === 'dismissed' ? (
                        <button onClick={() => restore(l.id)} className="text-xs text-[#7B5EA7] hover:underline"
                          title={l.status_reason === 'not_a_fit' ? 'Bring this lead back — and let future tours through again' : 'Bring this lead back'}>
                          Restore
                        </button>
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          {l.converted_job_id ? (
                            <Link to={`/jobs/${l.converted_job_id}`} className="text-xs text-green-700 hover:underline">
                              Open enquiry{l.converted_job_number ? ` #${l.converted_job_number}` : ''} →
                            </Link>
                          ) : liveJob ? (
                            <Link to={`/jobs/${liveJob.job_id}`} className="text-xs text-green-700 hover:underline"
                              title="We already have a job for this tour">
                              Open {liveJob.hh_job_number ? `#${liveJob.hh_job_number}` : 'job'} →
                            </Link>
                          ) : l.matched_organisation_id ? (
                            <button onClick={() => setModal({ kind: 'enquiry', lead: l })}
                              className="text-xs px-2 py-1 rounded border border-[#7B5EA7] text-[#7B5EA7] hover:bg-purple-50">Start enquiry</button>
                          ) : (
                            <button onClick={() => setModal({ kind: 'address', lead: l })}
                              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50">Add to address book</button>
                          )}
                          {onlyDeadJobs && l.status !== 'converted' && (
                            <button onClick={() => dismissAlreadyQuoted(l)} className="text-xs text-gray-600 hover:text-red-600"
                              title="We've already quoted this tour and it didn't go ahead — dismiss with that as the reason">
                              Dismiss — already quoted
                            </button>
                          )}
                          {!l.converted_job_id && !liveJob && ['new', 'reviewing', 'contacted'].includes(l.status) && (
                            <button onClick={() => setModal({ kind: 'outreach', lead: l })} className="text-xs text-gray-500 hover:text-[#7B5EA7]"
                              title="You've contacted them — note it, and put a Cold enquiry in the pipeline so it gets chased">
                              {l.status === 'contacted' ? 'Log outreach again' : 'Log outreach'}
                            </button>
                          )}
                          {l.status !== 'converted' && (
                            <button onClick={() => setModal({ kind: 'dismiss', lead: l })} className="text-xs text-gray-400 hover:text-red-600" title="Dismiss this lead">Dismiss</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={8} className="px-6 py-3 text-xs text-gray-600">
                        <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
                          <div className="min-w-0">
                            {l.status === 'contacted' && l.status_note && (
                              <p className="mb-2"><span className="text-gray-400">Outreach:</span> {l.status_note}</p>
                            )}
                            {tab === 'dismissed' && l.status_note && (
                              <p className="mb-2"><span className="text-gray-400">Dismiss note:</span> {l.status_note}</p>
                            )}
                            {l.ai_summary && <p className="mb-2 text-gray-700">{l.ai_summary}</p>}
                            {(l.client_history?.lost_reasons?.length ?? 0) > 0 && (
                              <p className="mb-2"><span className="text-gray-400">Why we lost them:</span> {(l.client_history?.lost_reasons ?? []).map((r) => `${r.reason} ×${r.count}`).join(', ')}</p>
                            )}
                            {l.venues?.length > 0 && <p className="mb-2"><span className="text-gray-400">Venues:</span> {l.venues.join(', ')}</p>}
                            {l.reasoning && l.reasoning !== l.ai_summary && <p className="mb-2"><span className="text-gray-400">Assessment:</span> {l.reasoning}</p>}
                            {l.known_contacts?.length > 0 && (
                              <div className="mb-2">
                                <div className="text-gray-400 mb-1">Already in your address book:</div>
                                <ul className="space-y-0.5">
                                  {l.known_contacts.map((k) => (
                                    <li key={k.person_id}>
                                      <Link to={`/people/${k.person_id}`} className="text-blue-600 hover:underline">{k.name}</Link>
                                      <span className="text-gray-400"> · {k.email}{k.orgs ? ` · ${k.orgs}` : ''}{k.job_count ? ` · on ${k.job_count} job${k.job_count === 1 ? '' : 's'}` : ''}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <LeadTourJobs lead={l} onChanged={() => { void reloadAll(); }} />
                            <LeadContacts lead={l} onChanged={() => { void reloadAll(); }} />
                            {tab !== 'dismissed' && !l.matched_organisation_id && l.match_candidates?.length > 0 && (
                              <div className="mt-2">
                                <div className="text-gray-400 mb-1">Possible address-book matches:</div>
                                {l.match_candidates.map((c) => (
                                  <div key={c.id} className="flex items-center gap-2">
                                    <span>
                                      {c.name}{' '}
                                      <span className="text-gray-400">
                                        ({c.type ?? 'org'}, {c.via === 'job_name'
                                          ? `${c.job_count} job${c.job_count === 1 ? '' : 's'} named after the band${c.sample_job_name ? ` — e.g. “${c.sample_job_name}”` : ''}`
                                          : `${((c.similarity ?? 0) * 100).toFixed(0)}% similar name`})
                                      </span>
                                    </span>
                                    <button onClick={() => confirmMatch(l.id, c.id)} className="text-green-700 hover:underline">Confirm this</button>
                                  </div>
                                ))}
                                <button onClick={() => rejectMatch(l.id)} className="mt-1 text-gray-400 hover:underline">None of these</button>
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="text-gray-400 mb-1">Activity</div>
                            <LeadTimeline leadId={l.id} refreshKey={l.last_event_at ?? undefined} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'run' && (
        <RunSearchModal
          defaultWindow={defaultWindow}
          maxDays={maxWindowDays}
          tourRule={settings.length ? `A “tour” = ${sv('lead_tour_min_dates')}+ UK dates within ${sv('lead_tour_window_weeks')} weeks. The standard window is ${sv('lead_lookahead_min_weeks')}–${sv('lead_lookahead_max_weeks')} weeks ahead.` : undefined}
          onClose={() => setModal(null)}
          onStarted={async () => { setModal(null); await loadRun(); }}
        />
      )}
      {modal?.kind === 'history' && (
        <SearchHistoryModal runs={runs} loading={runsLoading} onClose={() => setModal(null)} onShowBatch={showBatch} />
      )}
      {modal?.kind === 'dismiss' && (
        <DismissLeadModal lead={modal.lead} onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await reloadAll(); }} />
      )}
      {modal?.kind === 'address' && (
        <AddToAddressBookModal lead={modal.lead} onClose={() => setModal(null)}
          onDone={async (msg) => { setModal(null); setNotice({ text: msg }); await reloadAll(); }} />
      )}
      {modal?.kind === 'outreach' && (
        <LogOutreachModal lead={modal.lead} onClose={() => setModal(null)}
          onAddToAddressBook={() => setModal({ kind: 'address', lead: modal.lead })}
          onDone={async ({ jobId, chaseInDays }) => {
            setModal(null);
            setNotice(jobId
              ? { text: `Outreach to ${modal.lead.artist_name} logged — Cold enquiry created, first chase in ${chaseInDays} days.`, href: `/jobs/${jobId}`, linkText: 'Open enquiry' }
              : { text: `Outreach to ${modal.lead.artist_name} logged.` });
            await reloadAll();
          }} />
      )}
      {modal?.kind === 'enquiry' && (
        <StartEnquiryModal lead={modal.lead} onClose={() => setModal(null)}
          onDone={(jobId) => { setModal(null); navigate(`/jobs/${jobId}`); }} />
      )}
    </div>
  );
}
