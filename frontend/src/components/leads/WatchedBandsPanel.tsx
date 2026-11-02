/**
 * Leads › Watched bands — the bands we're watching for their next tour
 * (docs/TOUR-FINDER-SPEC.md §21). Watches start from the close-out modals
 * (ticked by default) or an organisation's page; every week Ticketmaster is
 * asked for their UK and European dates and a new tour becomes a warm lead.
 *
 * "Match these" first: a band whose Ticketmaster act couldn't be found by its
 * exact name needs a person to pick it (or say it isn't on Ticketmaster).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { fmtDate, fmtDateYear, UK_POSITION_LABEL, UkPosition } from './leadTypes';

type TmMatch = 'pending' | 'auto' | 'confirmed' | 'needs_match' | 'not_found';

interface TmCandidate {
  id: string;
  name: string;
  segment: string | null;
  genre: string | null;
  upcoming: number | null;
  url: string | null;
  exact: boolean;
}

interface CheckedTour {
  first: string;
  last: string;
  dates: number;
  uk_position: UkPosition;
  countries: string;
  lead_id?: string;
  skipped?: 'too_soon' | 'suppressed';
}

interface WatchRow {
  id: string;
  organisation_id: string;
  org_name: string;
  org_type: string | null;
  tm_attraction_id: string | null;
  tm_attraction_name: string | null;
  tm_match: TmMatch;
  tm_candidates: TmCandidate[];
  started_at: string;
  stopped_at: string | null;
  last_ticked_at: string | null;
  last_tm_check_at: string | null;
  last_tm_result: { checked_at: string; european_dates?: number; tours?: CheckedTour[]; error?: string } | null;
  started_job_id: string | null;
  started_job_number: number | null;
  started_job_name: string | null;
  started_job_status: string | null;
  last_job_id: string | null;
  last_job_number: number | null;
  last_job_status: string | null;
  started_by_name: string | null;
  last_ticked_by_name: string | null;
  stopped_by_name: string | null;
  next_lead_id: string | null;
  next_lead_first_date: string | null;
  next_lead_last_date: string | null;
  next_lead_status: string | null;
}

interface ListResponse {
  data: WatchRow[];
  counts: { active: number; needs_match: number; stopped: number };
  checking: boolean;
  ticketmaster: boolean;
}

const JOB_STATUS_WORD: Record<string, string> = { lost: 'lost', cancelled: 'cancelled', completed: 'completed' };

/** What the last check found, in a few words. */
function lastCheckText(r: WatchRow): string {
  if (r.tm_match === 'not_found') return 'Not on Ticketmaster — not checked';
  if (r.tm_match === 'pending') return 'Looking up their Ticketmaster act…';
  if (r.tm_match === 'needs_match') return 'Waiting for you to match them';
  const res = r.last_tm_result;
  if (!r.last_tm_check_at) return res?.error ? res.error : 'First check at 7am';
  const when = fmtDateYear(r.last_tm_check_at);
  if (res?.error) return `${when} — ${res.error}`;
  const tours = res?.tours ?? [];
  if (tours.length === 0) return `${when} — no UK or European dates`;
  const live = tours.filter((t) => t.lead_id).length;
  const soon = tours.filter((t) => t.skipped === 'too_soon').length;
  const parts = [];
  if (live) parts.push(`${live} tour${live === 1 ? '' : 's'} on Leads`);
  if (soon) parts.push(`${soon} too soon to sell`);
  return `${when} — ${parts.join(', ') || 'nothing new'}`;
}

/** Pick a band's Ticketmaster act: the candidates found, or search another name. */
function MatchPicker({ row, onDone, onCancel }: { row: WatchRow; onDone: () => void; onCancel?: () => void }) {
  const [q, setQ] = useState(row.org_name);
  const [found, setFound] = useState<TmCandidate[] | null>(row.tm_candidates?.length ? row.tm_candidates : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.get<{ data: TmCandidate[] }>(`/band-watches/tm-search?q=${encodeURIComponent(q.trim())}`);
      setFound(res.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally { setBusy(false); }
  };
  const answer = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/band-watches/${row.id}/match`, body);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save that');
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3 text-xs space-y-2">
      <div className="text-gray-500">Which Ticketmaster act is <span className="font-medium text-gray-800">{row.org_name}</span>?</div>
      {found && found.length === 0 && <div className="text-gray-400">Ticketmaster has nobody by that name. Try another spelling, or say they’re not on it.</div>}
      {found && found.length > 0 && (
        <ul className="space-y-1">
          {found.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-800">{c.name}</span>
              <span className="text-gray-400">
                {[c.genre ?? c.segment, c.upcoming != null ? `${c.upcoming} upcoming event${c.upcoming === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
              </span>
              {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">view</a>}
              <button disabled={busy} onClick={() => answer({ tm_attraction_id: c.id, tm_attraction_name: c.name })}
                className="px-2 py-0.5 rounded border border-[#7B5EA7] text-[#7B5EA7] hover:bg-purple-50 disabled:opacity-50">This one</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          className="border border-gray-300 rounded px-2 py-1 text-xs w-56" placeholder="Search Ticketmaster…" />
        <button disabled={busy || q.trim().length < 2} onClick={search}
          className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">Search</button>
        <button disabled={busy} onClick={() => answer({ not_on_ticketmaster: true })}
          className="text-gray-500 hover:text-red-600">Not on Ticketmaster</button>
        {onCancel && <button onClick={onCancel} className="text-gray-400 hover:underline">Cancel</button>}
      </div>
      {error && <div className="text-red-600">{error}</div>}
    </div>
  );
}

export default function WatchedBandsPanel({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<'active' | 'stopped'>('active');
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [meta, setMeta] = useState<Omit<ListResponse, 'data'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse>(`/band-watches${view === 'stopped' ? '?status=stopped' : ''}`);
      setRows(res.data);
      setMeta({ counts: res.counts, checking: res.checking, ticketmaster: res.ticketmaster });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load watched bands');
    }
  }, [view]);

  useEffect(() => { setRows(null); void load(); }, [load]);

  // While a check runs, look again every few seconds.
  useEffect(() => {
    if (!meta?.checking) return;
    const t = setTimeout(() => { void load(); }, 5000);
    return () => clearTimeout(t);
  }, [meta, load]);

  const checkNow = async () => {
    setNotice(null);
    try {
      await api.post('/band-watches/check-now', {});
      setNotice('Checking every watched band now — new tours appear on To review in a minute or two.');
      setMeta((m) => (m ? { ...m, checking: true } : m));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start the check');
    }
  };
  const stop = async (r: WatchRow) => {
    if (!confirm(`Stop watching ${r.org_name}?`)) return;
    setBusyId(r.id);
    try { await api.post(`/band-watches/${r.id}/stop`, {}); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t stop watching'); }
    finally { setBusyId(null); }
  };
  const watchAgain = async (r: WatchRow) => {
    setBusyId(r.id);
    try { await api.post('/band-watches', { organisation_id: r.organisation_id }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t watch again'); }
    finally { setBusyId(null); }
  };
  const lookAgain = async (r: WatchRow) => {
    setBusyId(r.id);
    try { await api.post(`/band-watches/${r.id}/match`, { look_again: true }); setTimeout(() => { void load(); }, 1500); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t look them up again'); }
    finally { setBusyId(null); }
  };

  const toMatch = (rows ?? []).filter((r) => r.tm_match === 'needs_match');
  const others = (rows ?? []).filter((r) => view === 'stopped' || r.tm_match !== 'needs_match');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-sm text-gray-500">
          Bands we’ve worked with (or nearly) — Ticketmaster is checked every week for their UK and European dates,
          and a new tour lands on <span className="font-medium">To review</span> as a warm lead.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
            <button onClick={() => setView('active')} className={`px-3 py-1.5 ${view === 'active' ? 'bg-purple-50 text-[#7B5EA7] font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
              Watching {meta ? meta.counts.active : ''}
            </button>
            <button onClick={() => setView('stopped')} className={`px-3 py-1.5 border-l border-gray-300 ${view === 'stopped' ? 'bg-purple-50 text-[#7B5EA7] font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
              Stopped {meta ? meta.counts.stopped : ''}
            </button>
          </div>
          {canManage && view === 'active' && (
            <button onClick={checkNow} disabled={!meta?.ticketmaster || meta?.checking}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              title="Check every watched band now (otherwise it runs each morning)">
              {meta?.checking ? 'Checking…' : '↻ Check now'}
            </button>
          )}
        </div>
      </div>

      {meta && !meta.ticketmaster && (
        <div className="rounded-lg bg-amber-50 text-amber-800 px-4 py-2 mb-3 text-sm">Ticketmaster isn’t set up on the server — watches are recorded but not checked.</div>
      )}
      {error && <div className="rounded-lg bg-red-50 text-red-800 px-4 py-2 mb-3 text-sm">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 text-green-800 px-4 py-2 mb-3 text-sm">{notice}</div>}

      {rows === null ? (
        <div className="text-center text-gray-400 py-12">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-gray-400 py-12 text-sm">
          {view === 'stopped'
            ? 'Nothing stopped.'
            : 'No bands watched yet. Closing a job (lost, cancelled or completed) offers “Watch this band”, and an organisation’s page has “Watch for tours”.'}
        </div>
      ) : (
        <>
          {view === 'active' && toMatch.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-sm font-medium text-amber-800 mb-1">Match these ({toMatch.length})</div>
              <p className="text-xs text-amber-800/80 mb-2">Ticketmaster has none, or more than one, act by exactly this name. Pick the right one so we can watch them.</p>
              <div className="space-y-3">
                {toMatch.map((r) => (
                  <div key={r.id}>
                    <Link to={`/organisations/${r.organisation_id}`} className="text-sm font-medium text-gray-900 hover:underline">{r.org_name}</Link>
                    {r.started_job_number && (
                      <span className="ml-2 text-xs text-gray-500">from job #{r.started_job_number}</span>
                    )}
                    <button disabled={busyId === r.id} onClick={() => stop(r)}
                      className="ml-3 text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                      title="This isn't a band (a company, a promoter…) — stop watching it">
                      Not a band — stop watching
                    </button>
                    <MatchPicker row={r} onDone={() => { void load(); }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {others.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Band</th>
                    <th className="px-3 py-2 text-left">Watching since</th>
                    <th className="px-3 py-2 text-left">Next tour</th>
                    <th className="px-3 py-2 text-left">Last checked</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {others.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="px-3 py-2">
                        <Link to={`/organisations/${r.organisation_id}`} className="font-medium text-gray-900 hover:underline">{r.org_name}</Link>
                        {r.tm_attraction_name && r.tm_attraction_name.toLowerCase() !== r.org_name.toLowerCase() && (
                          <div className="text-xs text-gray-500">Ticketmaster: {r.tm_attraction_name}</div>
                        )}
                        {fixing === r.id && <MatchPicker row={r} onDone={() => { setFixing(null); void load(); }} onCancel={() => setFixing(null)} />}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                        <div>{fmtDateYear(r.started_at)}{r.started_by_name ? ` · ${r.started_by_name}` : ''}</div>
                        {r.started_job_id && (
                          <Link to={`/jobs/${r.started_job_id}`} className="text-gray-500 hover:underline">
                            job {r.started_job_number ? `#${r.started_job_number}` : ''}{r.started_job_status && JOB_STATUS_WORD[r.started_job_status] ? ` (${JOB_STATUS_WORD[r.started_job_status]})` : ''}
                          </Link>
                        )}
                        {r.last_job_id && r.last_job_id !== r.started_job_id && (
                          <div className="text-gray-400">
                            again: <Link to={`/jobs/${r.last_job_id}`} className="hover:underline">#{r.last_job_number ?? ''}</Link>
                            {r.last_ticked_by_name ? ` · ${r.last_ticked_by_name}` : ''}
                          </div>
                        )}
                        {r.stopped_at && <div className="text-gray-400">stopped {fmtDateYear(r.stopped_at)}{r.stopped_by_name ? ` · ${r.stopped_by_name}` : ''}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {r.next_lead_id ? (
                          <Link to={`/jobs/leads?lead=${r.next_lead_id}`} className="text-[#7B5EA7] hover:underline">
                            {fmtDate(r.next_lead_first_date)} – {fmtDateYear(r.next_lead_last_date)} →
                          </Link>
                        ) : <span className="text-gray-400">—</span>}
                        {(() => {
                          const t = r.last_tm_result?.tours?.find((x) => x.lead_id === r.next_lead_id);
                          return t ? <div className="text-gray-400">{t.dates} dates · {t.countries} · {UK_POSITION_LABEL[t.uk_position]}</div> : null;
                        })()}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">{lastCheckText(r)}</td>
                      <td className="px-3 py-2 text-xs text-right whitespace-nowrap">
                        {view === 'stopped' ? (
                          <button disabled={busyId === r.id} onClick={() => watchAgain(r)} className="text-[#7B5EA7] hover:underline disabled:opacity-50">Watch again</button>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            {(r.tm_match === 'auto' || r.tm_match === 'confirmed' || r.tm_match === 'not_found') && fixing !== r.id && (
                              <button onClick={() => setFixing(r.id)} className="text-gray-500 hover:text-[#7B5EA7]"
                                title="Pick a different Ticketmaster act">
                                {r.tm_match === 'not_found' ? 'Find on Ticketmaster' : 'Wrong band?'}
                              </button>
                            )}
                            {r.tm_match === 'pending' && (
                              <button disabled={busyId === r.id} onClick={() => lookAgain(r)} className="text-gray-500 hover:text-[#7B5EA7] disabled:opacity-50">Look up now</button>
                            )}
                            <button disabled={busyId === r.id} onClick={() => stop(r)} className="text-gray-400 hover:text-red-600 disabled:opacity-50">Stop</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
