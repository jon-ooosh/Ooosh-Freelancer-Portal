/**
 * "Watch for tours" on an organisation's page (docs/TOUR-FINDER-SPEC.md §21).
 * Watching asks Ticketmaster every week whether the band has UK or European
 * dates, and turns a new tour into a warm lead. Shown for the org types a band
 * can be filed under; always shown once a watch exists, so it can be stopped.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { fmtDateYear } from './leadTypes';

interface OrgWatch {
  id: string;
  tm_match: 'pending' | 'auto' | 'confirmed' | 'needs_match' | 'unknown' | 'not_found';
  tm_attraction_name: string | null;
  started_at: string;
  stopped_at: string | null;
  last_tm_check_at: string | null;
}

/** Types a band might be filed under — the HireHop sync often types a band as "client". */
const BAND_LIKE_TYPES = ['band', 'client', 'unknown', 'other'];

export default function WatchBandButton({ orgId, orgType }: { orgId: string; orgType: string }) {
  const [watch, setWatch] = useState<OrgWatch | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<{ data: OrgWatch | null }>(`/band-watches/org/${orgId}`)
      .then((res) => { if (live) setWatch(res.data); })
      .catch(() => { if (live) setWatch(null); });
    return () => { live = false; };
  }, [orgId]);

  if (watch === undefined) return null;
  const active = watch && !watch.stopped_at;
  if (!watch && !BAND_LIKE_TYPES.includes(orgType)) return null;

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: OrgWatch }>('/band-watches', { organisation_id: orgId });
      setWatch(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start watching');
    } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!watch || !confirm('Stop watching this band for new tours?')) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/band-watches/${watch.id}/stop`, {});
      setWatch({ ...watch, stopped_at: new Date().toISOString() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t stop watching');
    } finally { setBusy(false); }
  };

  if (!active) {
    return (
      <span className="inline-flex items-center gap-1">
        <button onClick={start} disabled={busy}
          title="Check Ticketmaster every week and tell us when they next tour the UK or Europe"
          className="px-3 py-1.5 text-sm border border-purple-300 text-[#7B5EA7] rounded hover:bg-purple-50 transition-colors disabled:opacity-50">
          👁 {watch ? 'Watch for tours again' : 'Watch for tours'}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  const note = watch.tm_match === 'needs_match'
    ? 'pick their Ticketmaster act'
    : watch.tm_match === 'not_found' || watch.tm_match === 'unknown'
      ? 'not on Ticketmaster'
      : watch.tm_match === 'pending'
        ? 'looking them up'
        : watch.last_tm_check_at ? `checked ${fmtDateYear(watch.last_tm_check_at)}` : 'first check at 7am';

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded border border-purple-200 bg-purple-50 text-[#7B5EA7]"
      title={`Watching since ${fmtDateYear(watch.started_at)}${watch.tm_attraction_name ? ` — Ticketmaster: ${watch.tm_attraction_name}` : ''}`}>
      👁 Watching for tours
      <Link to="/jobs/leads?tab=watched" className="text-xs text-gray-500 hover:underline">· {note}</Link>
      <button onClick={stop} disabled={busy} className="text-xs text-gray-400 hover:text-red-600 ml-1" aria-label="Stop watching">Stop</button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
