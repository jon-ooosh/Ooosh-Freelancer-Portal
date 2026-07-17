/**
 * LeadsPage — Jobs > Leads. The Lead Finder (Tour Finder → OP).
 * Spec: docs/TOUR-FINDER-SPEC.md.
 *
 * PR 1: trigger a Ticketmaster search, watch it run, and review the AI-scored
 * tours it finds. Address-book matching (the Warm/Remarketing stream), contact
 * research and enrichment land in later slices — the Warm tab is present but
 * empty for now.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';

interface Lead {
  id: string;
  artist_name: string;
  tm_artist_id: string | null;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  relevance_score: number | null;
  client_tier: number | null;
  origin_country: string | null;
  is_international: boolean | null;
  reasoning: string | null;
  stream: 'cold' | 'warm';
  match_confidence: 'exact' | 'partial' | 'none';
  status: string;
}

interface Run {
  id: string;
  trigger: string;
  status: 'running' | 'complete' | 'failed';
  counts: {
    collection?: { newEvents: number; venuesResolved: number };
    detection?: { toursCreated: number; toursUpdated: number; droppedTooImminent: number; droppedNotTour: number };
    scoring?: { scored: number; skipped: number };
  } | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  triggered_by_name: string | null;
}

interface Setting { key: string; value: string | null; label: string; }

const SCORE_CLS = (score: number | null): string => {
  if (score == null) return 'bg-gray-100 text-gray-500';
  if (score >= 8) return 'bg-green-100 text-green-800';
  if (score >= 6) return 'bg-lime-100 text-lime-800';
  if (score >= 4) return 'bg-amber-100 text-amber-800';
  return 'bg-gray-100 text-gray-600';
};

const TIER_LABEL: Record<number, string> = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };

const STATUS_CLS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-700',
  reviewing: 'bg-indigo-100 text-indigo-700',
  contacted: 'bg-purple-100 text-purple-700',
  converted: 'bg-green-100 text-green-700',
  dismissed: 'bg-gray-100 text-gray-500',
  not_relevant: 'bg-gray-100 text-gray-500',
};

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        const [, , s] = await Promise.all([
          loadLeads(),
          loadRun(),
          api.get<{ data: Setting[] }>('/leads/settings'),
        ]);
        setSettings(s.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load leads');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadLeads, loadRun]);

  // Poll while a run is active; refresh the list when it finishes.
  useEffect(() => {
    const running = run?.status === 'running';
    if (running && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const latest = await loadRun();
        if (latest?.status !== 'running') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          await loadLeads();
        }
      }, 4000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [run?.status, loadRun, loadLeads]);

  const startRun = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.post('/leads/run', {});
      await loadRun();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start search');
    } finally {
      setStarting(false);
    }
  };

  const updateLead = async (id: string, status: string) => {
    await api.patch<{ data: Lead }>(`/leads/${id}`, { status });
    await loadLeads();
  };

  const settingVal = (key: string) => settings.find((s) => s.key === key)?.value ?? '';
  const isRunning = run?.status === 'running';

  const shown = leads.filter((l) => l.stream === tab);
  const coldCount = leads.filter((l) => l.stream === 'cold').length;
  const warmCount = leads.filter((l) => l.stream === 'warm').length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500 mt-1">
            Touring bands that fit the Ooosh profile, found via Ticketmaster and scored by relevance.
          </p>
          {settings.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Looking {settingVal('lead_lookahead_min_weeks')}–{settingVal('lead_lookahead_max_weeks')} weeks ahead ·
              tour = {settingVal('lead_tour_min_dates')}+ UK dates within {settingVal('lead_tour_window_weeks')} weeks
            </p>
          )}
        </div>
        {canRun && (
          <button
            onClick={startRun}
            disabled={starting || isRunning}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50"
          >
            {isRunning ? 'Searching…' : starting ? 'Starting…' : '🔍 Run search now'}
          </button>
        )}
      </div>

      {/* Run status */}
      {run && (
        <div className={`rounded-lg px-4 py-3 mb-4 text-sm ${
          run.status === 'running' ? 'bg-blue-50 text-blue-800'
          : run.status === 'failed' ? 'bg-red-50 text-red-800'
          : 'bg-gray-50 text-gray-600'
        }`}>
          {run.status === 'running' && <>Search running… started {new Date(run.started_at).toLocaleTimeString('en-GB')}. This can take a couple of minutes.</>}
          {run.status === 'failed' && <>Last search failed: {run.error || 'unknown error'}</>}
          {run.status === 'complete' && run.counts && (
            <>
              Last search {run.finished_at ? new Date(run.finished_at).toLocaleString('en-GB') : ''}
              {run.triggered_by_name ? ` by ${run.triggered_by_name}` : ''} —
              {' '}found <b>{run.counts.detection?.toursCreated ?? 0}</b> new tours
              {' '}(scored {run.counts.scoring?.scored ?? 0}, skipped {run.counts.scoring?.skipped ?? 0};
              {' '}dropped {run.counts.detection?.droppedTooImminent ?? 0} too-imminent,
              {' '}{run.counts.detection?.droppedNotTour ?? 0} not-a-tour).
            </>
          )}
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 text-red-800 px-4 py-3 mb-4 text-sm">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        <button
          onClick={() => setTab('cold')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'cold' ? 'border-[#7B5EA7] text-[#7B5EA7]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Cold ({coldCount})
        </button>
        <button
          onClick={() => setTab('warm')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'warm' ? 'border-[#7B5EA7] text-[#7B5EA7]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Warm / Remarketing ({warmCount})
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading…</div>
      ) : tab === 'warm' ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          Address-book matching arrives in the next step — bands you've worked with before will surface here.
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          No leads yet.{canRun ? ' Run a search to find touring bands.' : ''}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Band</th>
                <th className="px-3 py-2 text-left">Tour dates</th>
                <th className="px-3 py-2 text-right">UK dates</th>
                <th className="px-3 py-2 text-center">Score</th>
                <th className="px-3 py-2 text-left">Origin</th>
                <th className="px-3 py-2 text-left">Why</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((l) => (
                <tr key={l.id} className="hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {l.artist_name}
                    {l.is_international && <span className="ml-1 text-xs text-gray-400" title="International act">✈</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {fmtDate(l.first_date)} – {fmtDate(l.last_date)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{l.uk_date_count}</td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${SCORE_CLS(l.relevance_score)}`}>
                      {l.relevance_score ?? '—'}
                    </span>
                    {l.client_tier && <div className="text-[10px] text-gray-400 mt-0.5">{TIER_LABEL[l.client_tier]}</div>}
                  </td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.origin_country ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 max-w-xs">{l.reasoning ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_CLS[l.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {l.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {l.status !== 'dismissed' && (
                      <button
                        onClick={() => updateLead(l.id, 'dismissed')}
                        className="text-xs text-gray-400 hover:text-red-600"
                        title="Dismiss this lead"
                      >
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
