/**
 * Operations › Premises & compliance — the register (docs/PREMISES-COMPLIANCE-SPEC.md §2).
 *
 * Every check the caller may see, grouped by heading, red / amber / green.
 * Places are filter chips, not tabs (jon, 19 Nov 2026): the question asked
 * most is "what's due, anywhere?". Each heading's rows sort by the column
 * clicked (name, last done, next due, status) — the choice and the place chip
 * are remembered per person in this browser, and validated on read so a bad
 * stored value can't pin the page (frontend.md "Crash safety").
 *
 * Status, dates and who sees what all come from the server.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { openR2Key } from '../lib/openAuthedFile';
import CheckFormModal from '../components/premises/CheckFormModal';
import PlacesHeadingsModal from '../components/premises/PlacesHeadingsModal';
import UsageChart from '../components/premises/UsageChart';
import DocumentsPanel from '../components/premises/DocumentsPanel';
import {
  Meter, PremisesCheck, PremisesMeta, STATUS_ORDER, VISIBILITY_LABEL, fmtDate, fmtNumber, statusPill,
} from '../components/premises/premisesCopy';

/** Meter readings tab: every meter, its last reading, its use, and the way to enter today's. */
function MetersPanel() {
  const [meters, setMeters] = useState<Meter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ data: Meter[] }>('/premises/meters')
      .then(res => setMeters(res.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load the meters'));
  }, []);
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!meters) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">Each meter's reminder opens the reading screen — or open it here.</p>
        <Link to="/operations/premises/readings" className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">Enter readings</Link>
      </div>
      {meters.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-sm text-gray-600">
          No meters yet. Add one with "+ Add a check" and choose "Meter reading".
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {meters.map(m => {
            const pill = statusPill(m);
            return (
              <Link key={m.id} to={`/operations/premises/checks/${m.id}`}
                className="bg-white border border-gray-200 rounded-lg p-4 hover:border-ooosh-300 space-y-2 block">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900">{m.title}</div>
                    <div className="text-xs text-gray-500">{m.place_name} · {m.repeat_text}</div>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${pill.cls}`}>{pill.text}</span>
                </div>
                <div className="text-xl font-bold tabular-nums text-gray-900">
                  {m.last_reading ? fmtNumber(m.last_reading.value, 3) : '—'}
                  {m.unit && <span className="ml-1 text-sm font-normal text-gray-500">{m.unit}</span>}
                </div>
                <div className="text-xs text-gray-500">
                  {m.last_reading ? `Read ${fmtDate(m.last_reading.done_on)}` : 'No readings yet'}
                  {m.last_use && <> · +{fmtNumber(m.last_use.used)} since {fmtDate(m.last_use.from)}</>}
                  {m.usual_per_week !== null && <> · usually {fmtNumber(m.usual_per_week)} a week</>}
                </div>
                <UsageChart usage={m.usage} unit={m.unit} height={90} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SortKey = 'title' | 'last_done' | 'next_due' | 'status';
const SORT_KEYS: SortKey[] = ['title', 'last_done', 'next_due', 'status'];
const PLACE_KEY = 'premises-place';
const SORT_KEY = 'premises-sort';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window — not remembered */ }
}
function readSort(): { key: SortKey; dir: 1 | -1 } {
  try {
    const v = JSON.parse(readStored(SORT_KEY) || 'null') as { key?: unknown; dir?: unknown } | null;
    if (v && SORT_KEYS.includes(v.key as SortKey) && (v.dir === 1 || v.dir === -1)) return { key: v.key as SortKey, dir: v.dir };
  } catch { /* fall through */ }
  return { key: 'next_due', dir: 1 };
}

/** Compare two checks by one column. Empty dates go last whichever way it's sorted. */
function compare(a: PremisesCheck, b: PremisesCheck, key: SortKey, dir: 1 | -1): number {
  const byDate = (x: string | null, y: string | null) => {
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? -dir : x > y ? dir : 0;
  };
  let r = 0;
  if (key === 'title') r = a.title.localeCompare(b.title) * dir;
  else if (key === 'last_done') r = byDate(a.last_done_on, b.last_done_on);
  else if (key === 'next_due') r = byDate(a.next_due, b.next_due);
  else r = (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dir || byDate(a.next_due, b.next_due);
  return r || a.title.localeCompare(b.title);
}

export default function PremisesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: 'checks' | 'meters' | 'documents' = rawTab === 'meters' || rawTab === 'documents' ? rawTab : 'checks';
  const [meta, setMeta] = useState<PremisesMeta | null>(null);
  const [checks, setChecks] = useState<PremisesCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<string>(() => readStored(PLACE_KEY) || 'all');
  const [sort, setSort] = useState(readSort);
  const [search, setSearch] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingLists, setEditingLists] = useState(false);

  const loadMeta = useCallback(async () => {
    const res = await api.get<{ data: PremisesMeta }>('/premises/meta');
    setMeta(res.data);
  }, []);
  const loadChecks = useCallback(async () => {
    const res = await api.get<{ data: PremisesCheck[] }>(`/premises/checks${showRetired ? '?include_retired=1' : ''}`);
    setChecks(res.data);
  }, [showRetired]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([loadMeta(), loadChecks()])
      .then(() => { if (live) setError(null); })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load the register'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [loadMeta, loadChecks]);

  // A remembered place that has since gone falls back to All.
  const activePlaces = useMemo(() => (meta?.places ?? []).filter(p => !p.retired_at), [meta]);
  const placeFilter = place === 'all' || activePlaces.some(p => p.id === place) ? place : 'all';

  function pickPlace(id: string) { setPlace(id); writeStored(PLACE_KEY, id); }
  function sortBy(key: SortKey) {
    const next = { key, dir: (sort.key === key ? -sort.dir : 1) as 1 | -1 };
    setSort(next);
    writeStored(SORT_KEY, JSON.stringify(next));
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return checks.filter(c =>
      (placeFilter === 'all' || c.place_id === placeFilter)
      && (!onlyAttention || c.status === 'overdue' || c.status === 'due_soon')
      && (!onlyMine || (!!meta?.my_person_id && c.owner_person_id === meta.my_person_id))
      && (!q || c.title.toLowerCase().includes(q) || (c.contractor_name ?? '').toLowerCase().includes(q)));
  }, [checks, placeFilter, onlyAttention, onlyMine, search, meta]);

  const counts = useMemo(() => {
    const live = visible.filter(c => !c.retired_at);
    return {
      overdue: live.filter(c => c.status === 'overdue').length,
      soon: live.filter(c => c.status === 'due_soon').length,
      ok: live.filter(c => c.status === 'ok').length,
      notSet: live.filter(c => c.status === 'no_date').length,
    };
  }, [visible]);

  const groups = useMemo(() => {
    const byHeading = new Map<string, { name: string; sort: number; rows: PremisesCheck[] }>();
    for (const c of visible) {
      const g = byHeading.get(c.heading_id) ?? { name: c.heading_name, sort: c.heading_sort, rows: [] };
      g.rows.push(c);
      byHeading.set(c.heading_id, g);
    }
    return [...byHeading.entries()]
      .sort((a, b) => a[1].sort - b[1].sort || a[1].name.localeCompare(b[1].name))
      .map(([id, g]) => ({ id, name: g.name, rows: [...g.rows].sort((a, b) => compare(a, b, sort.key, sort.dir)) }));
  }, [visible, sort]);

  const th = (key: SortKey | null, text: string) => (
    <th className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500 px-3 py-2 whitespace-nowrap">
      {key ? (
        <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1 hover:text-gray-800 uppercase">
          {text}
          <span className="text-[10px]">{sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
        </button>
      ) : text}
    </th>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Premises &amp; compliance</h1>
          <p className="text-sm text-gray-500">Checks, certificates and renewals for the buildings, the yard and the company.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {meta?.can.admin && (
            <button type="button" onClick={() => setEditingLists(true)}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">Places &amp; headings</button>
          )}
          {meta?.can.manage && (
            <button type="button" onClick={() => setAdding(true)}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">+ Add a check</button>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([['checks', 'Checks'], ['meters', 'Meter readings'], ['documents', 'Documents']] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setSearchParams(id === 'checks' ? {} : { tab: id }, { replace: true })}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === id ? 'border-ooosh-600 text-ooosh-700 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'meters' ? <MetersPanel /> : tab === 'documents' ? (
        meta ? <DocumentsPanel meta={meta} /> : <p className="text-sm text-gray-500">Loading…</p>
      ) : (<>
      {/* Places */}
      <div className="flex flex-wrap gap-2 mb-3">
        {[{ id: 'all', name: 'All' }, ...activePlaces].map(p => (
          <button key={p.id} type="button" onClick={() => pickPlace(p.id)} aria-pressed={placeFilter === p.id}
            className={`px-3 py-1 rounded-full text-sm border ${placeFilter === p.id
              ? 'bg-ooosh-600 border-ooosh-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search checks or contractors"
          className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[200px]" aria-label="Search" />
        <label className="inline-flex items-center gap-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={onlyAttention} onChange={e => setOnlyAttention(e.target.checked)} /> Overdue or due soon
        </label>
        <label className="inline-flex items-center gap-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} /> Mine
        </label>
        {meta?.can.manage && (
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} /> Show retired
          </label>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <span className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm"><b className="text-red-700 tabular-nums">{counts.overdue}</b> overdue</span>
        <span className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm"><b className="text-amber-700 tabular-nums">{counts.soon}</b> due soon</span>
        <span className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm"><b className="text-green-700 tabular-nums">{counts.ok}</b> up to date</span>
        {counts.notSet > 0 && (
          <span className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm"><b className="text-gray-700 tabular-nums">{counts.notSet}</b> not set up yet</span>
        )}
      </div>

      {error && <p className="text-sm text-red-700 mb-4">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-sm text-gray-600">
          {checks.length === 0 ? 'No checks yet.' : 'Nothing matches these filters.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm tabular-nums">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {th('title', 'Check')}
                {th(null, 'How often')}
                {th('last_done', 'Last done')}
                {th('next_due', 'Next due')}
                {th('status', 'Status')}
                {th(null, 'Looks after it')}
                {th(null, 'Current cert')}
              </tr>
            </thead>
            {groups.map(g => (
              <tbody key={g.id}>
                <tr className="bg-gray-50">
                  <td colSpan={7} className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-gray-500 border-y border-gray-200">{g.name}</td>
                </tr>
                {g.rows.map(c => {
                  const pill = statusPill(c);
                  return (
                    <tr key={c.id} onClick={() => navigate(`/operations/premises/checks/${c.id}`)}
                      className={`border-b border-gray-100 last:border-0 cursor-pointer hover:bg-ooosh-50 ${c.retired_at ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2">
                        <span className="font-medium text-gray-900">{c.title}</span>
                        {c.visibility !== 'all' && (
                          <span className="ml-2 text-[11px] text-gray-500 border border-gray-200 rounded px-1 whitespace-nowrap">{VISIBILITY_LABEL[c.visibility]}</span>
                        )}
                        <span className="block text-xs text-gray-500">
                          {[c.place_name, c.contractor_name, c.responsibility === 'landlord' ? "Landlord's" : null].filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{c.repeat_text}</td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDate(c.last_done_on)}</td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDate(c.next_due)}</td>
                      <td className="px-3 py-2"><span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${pill.cls}`}>{pill.text}</span></td>
                      <td className="px-3 py-2 text-gray-700">{c.owner_name ?? <span className="text-gray-400">Nobody yet</span>}</td>
                      <td className="px-3 py-2">
                        {c.current_file_key ? (
                          <button type="button" className="text-ooosh-600 hover:underline text-xs truncate max-w-[150px] inline-block align-bottom"
                            onClick={e => { e.stopPropagation(); void openR2Key(c.current_file_key!, c.current_file_name ?? undefined).catch(() => setError('Could not open that file')); }}>
                            {c.current_file_name ?? 'Open'}
                          </button>
                        ) : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      </>)}

      {adding && meta && (
        <CheckFormModal meta={meta} check={null} onClose={() => setAdding(false)}
          onSaved={saved => { setAdding(false); navigate(`/operations/premises/checks/${saved.id}`); }} />
      )}
      {editingLists && meta && (
        <PlacesHeadingsModal places={meta.places} headings={meta.headings}
          onClose={() => { setEditingLists(false); void loadChecks().catch(() => undefined); }}
          onChanged={loadMeta} />
      )}
    </div>
  );
}
