/**
 * "Watch this band for their next tour" — the tick on the lost / completed /
 * cancelled close-outs (docs/TOUR-FINDER-SPEC.md §21). Ticked by default.
 *
 * It offers the job's Band org, else its client (often the band itself), and
 * shows the name so it can be changed. It starts unticked for a band someone
 * stopped watching, and for a client that is plainly a company rather than a
 * band (a promoter, venue, management…) — then it asks for the band. The parent sends the chosen org as `watch_band_org_id` with the
 * status change; the backend starts the watch (band-watch.ts). `null` = don't.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { fmtDateYear } from './leadTypes';

interface WatchTarget {
  organisation_id: string;
  name: string;
  type: string | null;
  source: 'band' | 'client';
  watch: { id: string; tm_match: string; started_at: string; stopped_at: string | null } | null;
}

interface OrgOption { id: string; name: string; type: string | null }

/** Org types that are a company, not a band — the client tick starts unticked for these. */
const NOT_A_BAND_TYPES = [
  'management', 'label', 'agency', 'promoter', 'venue', 'festival', 'supplier', 'hire_company', 'booking_agent',
];
const notABand = (t: WatchTarget) => t.source === 'client' && NOT_A_BAND_TYPES.includes(t.type ?? '');

export default function WatchBandTick({ jobId, value, onChange }: {
  jobId: string;
  /** The org to watch, or null for "don't". */
  value: string | null;
  onChange: (orgId: string | null) => void;
}) {
  const [target, setTarget] = useState<WatchTarget | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<OrgOption[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let live = true;
    api.get<{ data: WatchTarget | null }>(`/band-watches/job-target/${jobId}`)
      .then((res) => {
        if (!live) return;
        const t = res.data;
        setTarget(t);
        if (t) {
          setChosen({ id: t.organisation_id, name: t.name });
          // Ticked by default — unless someone deliberately stopped watching
          // them, or the client is a company rather than a band.
          onChangeRef.current(t.watch?.stopped_at || notABand(t) ? null : t.organisation_id);
        } else {
          onChangeRef.current(null);
        }
      })
      .catch(() => { if (live) onChangeRef.current(null); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [jobId]);

  // Organisation search for "change" / "pick the band".
  useEffect(() => {
    if (!picking || search.trim().length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ data: OrgOption[] }>(`/organisations?search=${encodeURIComponent(search.trim())}&limit=8`)
        .then((res) => { if (live) setResults(res.data ?? []); })
        .catch(() => { if (live) setResults([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [search, picking]);

  if (!loaded) return null;

  const isTarget = chosen && target && chosen.id === target.organisation_id;
  const watch = isTarget ? target!.watch : null;
  let hint: string;
  if (!chosen) hint = 'Pick the band, and we’ll tell you when they next tour the UK or Europe.';
  else if (watch && !watch.stopped_at) hint = `Already watching since ${fmtDateYear(watch.started_at)} — this job is noted against it.`;
  else if (watch?.stopped_at) hint = `Someone stopped watching them on ${fmtDateYear(watch.stopped_at)}. Tick to watch again.`;
  else if (isTarget && notABand(target!)) hint = `The client is a ${(target!.type ?? '').replace('_', ' ')}, not a band — pick the band to watch.`;
  else if (isTarget && target!.source === 'client') hint = 'The client on this job — change it if the band is someone else.';
  else hint = 'We’ll check Ticketmaster every week and tell you when they next tour the UK or Europe.';

  const pick = (o: { id: string; name: string }) => {
    setChosen(o);
    setPicking(false);
    setSearch('');
    onChange(o.id);
  };

  return (
    <div className="border border-purple-200 bg-purple-50/50 rounded-lg p-3 text-sm">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={!chosen}
          onChange={(e) => onChange(e.target.checked && chosen ? chosen.id : null)}
          className="mt-0.5 rounded border-gray-300"
        />
        <span className="flex-1">
          👁 Watch {chosen ? <span className="font-medium">{chosen.name}</span> : 'this band'} for their next tour
          <span className="block text-xs text-gray-500 mt-0.5">{hint}</span>
        </span>
        {!picking && (
          <button type="button" onClick={(e) => { e.preventDefault(); setPicking(true); }}
            className="text-xs text-[#7B5EA7] hover:underline shrink-0">
            {chosen ? 'Change' : 'Pick band'}
          </button>
        )}
      </label>
      {picking && (
        <div className="mt-2">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the address book for the band…"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
          {results.length > 0 && (
            <div className="mt-1 max-h-40 overflow-y-auto border border-gray-200 rounded bg-white">
              {results.map((o) => (
                <button key={o.id} type="button" onClick={() => pick(o)}
                  className="block w-full text-left px-2 py-1.5 text-sm hover:bg-purple-50">
                  {o.name} {o.type && <span className="text-xs text-gray-400">{o.type}</span>}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => { setPicking(false); setSearch(''); }}
            className="mt-1 text-xs text-gray-500 hover:underline">Cancel</button>
        </div>
      )}
    </div>
  );
}
