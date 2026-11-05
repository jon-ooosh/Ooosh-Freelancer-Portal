/**
 * Leads › Watched bands › "＋ Past bands" — the band watch's back catalogue
 * (docs/TOUR-FINDER-SPEC.md §21.8). Bands from lost, cancelled and completed
 * jobs of the last three years that nobody is watching yet, looked up on
 * Ticketmaster first (a manager starts the look-up; it runs in the background).
 *
 * The ones Ticketmaster knows by exactly one act are listed to tick in bulk —
 * watching them needs nobody to match anything. The rest (several possible
 * acts, never heard of, not looked up yet) sit behind "Show the others".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import { fmtDateYear } from './leadTypes';

interface PastBand {
  organisation_id: string;
  name: string;
  type: string | null;
  jobs: number;
  booked: number;
  lost: number;
  cancelled: number;
  last_job_at: string | null;
  last_job_id: string | null;
  last_job_number: number | null;
  tm_status: 'known' | 'ambiguous' | 'unknown' | null;
  exact_count: number | null;
  tm_attraction_name: string | null;
  tm_upcoming: number | null;
  looked_up_at: string | null;
}

interface Progress {
  running: boolean;
  done: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface ListResponse {
  data: PastBand[];
  counts: { total: number; known: number; ambiguous: number; unknown: number; not_looked_up: number };
  lookup: Progress;
  ticketmaster: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  ambiguous: 'several possible acts — you’ll pick on Match these',
  unknown: 'Ticketmaster has never heard of them',
  none: 'not looked up yet',
};

function history(b: PastBand): string {
  const parts = [`${b.jobs} job${b.jobs === 1 ? '' : 's'}`];
  const bits = [
    b.booked ? `${b.booked} booked` : null,
    b.lost ? `${b.lost} lost` : null,
    b.cancelled ? `${b.cancelled} cancelled` : null,
  ].filter(Boolean);
  return bits.length ? `${parts[0]}: ${bits.join(', ')}` : parts[0];
}

export default function BackCatalogueModal({ canManage, onClose }: {
  canManage: boolean;
  /** `changed` = some bands were watched, so the list behind should reload. */
  onClose: (changed: boolean) => void;
}) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showOthers, setShowOthers] = useState(false);
  const [sort, setSort] = useState<'recent' | 'booked'>('recent');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.get<ListResponse>('/band-watches/back-catalogue'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load past bands');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While the look-up runs, refresh every few seconds.
  useEffect(() => {
    if (!list?.lookup.running) return;
    const t = setTimeout(() => { void load(); }, 4000);
    return () => clearTimeout(t);
  }, [list, load]);

  const sorted = useMemo(() => {
    const rows = [...(list?.data ?? [])];
    if (sort === 'booked') rows.sort((a, b) => b.booked - a.booked || b.jobs - a.jobs);
    return rows;
  }, [list, sort]);
  const known = sorted.filter((b) => b.tm_status === 'known');
  const others = sorted.filter((b) => b.tm_status !== 'known');

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allKnownTicked = known.length > 0 && known.every((b) => selected.has(b.organisation_id));
  const tickAllKnown = () => setSelected((s) => {
    const n = new Set(s);
    if (allKnownTicked) known.forEach((b) => n.delete(b.organisation_id));
    else known.forEach((b) => n.add(b.organisation_id));
    return n;
  });

  const lookUp = async () => {
    setError(null);
    try {
      await api.post('/band-watches/back-catalogue/look-up', {});
      setList((l) => (l ? { ...l, lookup: { ...l.lookup, running: true, done: 0, error: null } } : l));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start the look-up');
    }
  };

  const watchSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: { watched: number; skipped: number } }>(
        '/band-watches/back-catalogue/watch', { organisation_ids: Array.from(selected) },
      );
      setNotice(`Watching ${res.data.watched} more band${res.data.watched === 1 ? '' : 's'} — they’re checked from 7am tomorrow (or press Check now).`);
      setSelected(new Set());
      setChanged(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t watch those bands');
    } finally { setBusy(false); }
  };

  const row = (b: PastBand) => (
    <li key={b.organisation_id} className="flex items-start gap-2 py-1.5">
      <input type="checkbox" className="mt-0.5 rounded border-gray-300" checked={selected.has(b.organisation_id)}
        onChange={() => toggle(b.organisation_id)} aria-label={`Watch ${b.name}`} />
      <div className="min-w-0 flex-1">
        <Link to={`/organisations/${b.organisation_id}`} target="_blank" className="font-medium text-gray-900 hover:underline">{b.name}</Link>
        {b.tm_status === 'known' && b.tm_attraction_name && b.tm_attraction_name.toLowerCase() !== b.name.toLowerCase() && (
          <span className="text-xs text-gray-500"> — Ticketmaster: {b.tm_attraction_name}</span>
        )}
        <div className="text-xs text-gray-500">
          {history(b)}
          {b.last_job_at ? ` · last ${fmtDateYear(b.last_job_at)}` : ''}
          {b.last_job_number ? ` (#${b.last_job_number})` : ''}
          {b.tm_status === 'known' && b.tm_upcoming != null ? ` · ${b.tm_upcoming} upcoming event${b.tm_upcoming === 1 ? '' : 's'} on Ticketmaster` : ''}
          {b.tm_status !== 'known' && <span className="text-gray-400"> · {STATUS_LABEL[b.tm_status ?? 'none']}</span>}
        </div>
      </div>
    </li>
  );

  const p = list?.lookup;
  const notLookedUp = list?.counts.not_looked_up ?? 0;

  return (
    <LeadModal wide title="Watch bands from past jobs" onClose={() => onClose(changed)}
      footer={(
        <>
          <button onClick={() => onClose(changed)} className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-50">Close</button>
          <button onClick={watchSelected} disabled={busy || selected.size === 0}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {busy ? 'Watching…' : `👁 Watch ${selected.size || ''} selected`}
          </button>
        </>
      )}>
      <p className="text-gray-500 mb-3">
        Bands from lost, cancelled and completed jobs of the last three years that nobody is watching yet.
        Ticketmaster is asked about each one first, so the ones it knows can be watched without matching anything by hand.
      </p>

      {error && <div className="rounded-lg bg-red-50 text-red-800 px-3 py-2 mb-3">{error}</div>}
      {notice && <div className="rounded-lg bg-green-50 text-green-800 px-3 py-2 mb-3">{notice}</div>}

      {!list ? (
        <div className="text-center text-gray-400 py-8">Loading…</div>
      ) : (
        <>
          {p?.running ? (
            <div className="rounded-lg bg-blue-50 text-blue-800 px-3 py-2 mb-3">
              <span className="inline-block animate-pulse">●</span> Looking them up on Ticketmaster — {p.done} of {p.total || '…'} done.
              It runs in the background; you can close this.
            </div>
          ) : notLookedUp > 0 && (
            <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 mb-3 flex flex-wrap items-center justify-between gap-2">
              <span>{notLookedUp} band{notLookedUp === 1 ? '' : 's'} not looked up on Ticketmaster yet{p?.error ? ` — ${p.error}` : ''}.</span>
              {canManage ? (
                <button onClick={lookUp} disabled={!list.ticketmaster}
                  className="px-3 py-1 rounded border border-amber-400 text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                  Look them up
                </button>
              ) : <span className="text-xs">A manager can look them up.</span>}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <div className="font-medium text-gray-900">Ticketmaster knows them ({known.length})</div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1 text-gray-600">
                Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'booked')}
                  className="border border-gray-300 rounded px-1 py-0.5 text-xs">
                  <option value="recent">Most recent job</option>
                  <option value="booked">Most booked with us</option>
                </select>
              </label>
              {known.length > 0 && (
                <button onClick={tickAllKnown} className="text-[#7B5EA7] hover:underline">
                  {allKnownTicked ? 'Untick all' : 'Tick all'}
                </button>
              )}
            </div>
          </div>
          {known.length === 0 ? (
            <p className="text-gray-400 mb-3">
              {notLookedUp > 0 ? 'None yet — look them up on Ticketmaster first.' : 'None — every band left is unclear or unknown to Ticketmaster.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-[45vh] overflow-y-auto border border-gray-200 rounded-lg px-3 mb-3">
              {known.map(row)}
            </ul>
          )}

          {others.length > 0 && (
            <div>
              <button onClick={() => setShowOthers((v) => !v)} className="text-xs text-[#7B5EA7] hover:underline">
                {showOthers ? 'Hide' : 'Show'} the others ({others.length}) — {list.counts.ambiguous} with several possible acts,
                {' '}{list.counts.unknown} Ticketmaster has never heard of{notLookedUp ? `, ${notLookedUp} not looked up` : ''}
              </button>
              {showOthers && (
                <ul className="divide-y divide-gray-100 max-h-[35vh] overflow-y-auto border border-gray-200 rounded-lg px-3 mt-2">
                  {others.map(row)}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </LeadModal>
  );
}
