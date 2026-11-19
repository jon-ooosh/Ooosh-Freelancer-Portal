/**
 * Marketing › Content — the social media planner (docs/BUSINESS-FIGURES-SPEC.md §8e).
 * Every staff login. Four views of the same posts: a month calendar, a board by status,
 * the undated ideas, and the content library (Drive links to photos / videos).
 * OP plans; Meta Business Suite schedules and posts. Backend: routes/marketing-content.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import { useIsPhone } from '../../hooks/useIsPhone';
import PostEditor, { searchJobs, searchOrgs, searchPeople } from './PostEditor';
import SearchPicker, { type PickerOption } from '../SearchPicker';
import {
  type Asset, type Post, ASSET_KINDS, STATUSES, assetKindOf, channelOf, formatLabel, statusOf,
} from './contentCopy';

type View = 'calendar' | 'board' | 'ideas' | 'library';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'board', label: 'Board' },
  { key: 'ideas', label: 'Ideas' },
  { key: 'library', label: 'Content library' },
];
const VIEW_KEY = 'marketing-content-view';
const errMsg = (e: unknown, fallback: string) => (e as { body?: { error?: string } })?.body?.error || (e as Error)?.message || fallback;

// ── Dates, done on plain YYYY-MM-DD strings in UTC arithmetic (no local-time drift) ──
function ymdOf(d: Date): string { return d.toISOString().slice(0, 10); }
function parseYmd(s: string): Date { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addDays(s: string, n: number): string { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymdOf(d); }
function monthGrid(month: string): string[] {
  // Monday-first weeks covering the whole month.
  const first = parseYmd(`${month}-01`);
  const start = addDays(`${month}-01`, -((first.getUTCDay() + 6) % 7));
  const nextMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const last = addDays(ymdOf(nextMonth), -1);
  const lastDow = (parseYmd(last).getUTCDay() + 6) % 7;
  const end = addDays(last, 6 - lastDow);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}
function shiftMonth(month: string, n: number): string {
  const d = parseYmd(`${month}-01`);
  return ymdOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))).slice(0, 7);
}
function monthName(month: string): string {
  return parseYmd(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function mondayOf(ymd: string): string { return addDays(ymd, -((parseYmd(ymd).getUTCDay() + 6) % 7)); }
function shortDay(ymd: string | null): string {
  if (!ymd) return '';
  return parseYmd(ymd).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function ChannelChips({ channels }: { channels: string[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {channels.map((c) => { const ch = channelOf(c); return ch ? <span key={c} className={`rounded border px-1 text-[10px] leading-4 ${ch.cls}`}>{ch.short}</span> : null; })}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = statusOf(status);
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function CalendarView({ refreshKey, onOpen, onNew }: { refreshKey: number; onOpen: (id: string) => void; onNew: (date: string) => void }) {
  const today = ukToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState('');
  const days = useMemo(() => monthGrid(month), [month]);

  useEffect(() => {
    setError('');
    api.get<{ data: Post[] }>(`/marketing-content/posts?view=calendar&from=${days[0]}&to=${days[days.length - 1]}`)
      .then((r) => setPosts(r.data))
      .catch((e) => setError(errMsg(e, 'Could not load the calendar')));
  }, [days, refreshKey]);

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts ?? []) if (p.publish_date) m.set(p.publish_date, [...(m.get(p.publish_date) ?? []), p]);
    return m;
  }, [posts]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50" aria-label="Previous month">‹</button>
        <h2 className="min-w-[10rem] text-center text-base font-semibold text-gray-900">{monthName(month)}</h2>
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50" aria-label="Next month">›</button>
        {month !== today.slice(0, 7) && <button type="button" onClick={() => setMonth(today.slice(0, 7))} className="text-sm text-ooosh-700 hover:underline">This month</button>}
        <span className="ml-auto hidden text-xs text-gray-500 sm:inline">Click a day to plan a post on it.</span>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto">
        <div className="grid min-w-[700px] grid-cols-7 overflow-hidden rounded-lg border border-gray-200 bg-gray-200 gap-px text-xs">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="bg-gray-50 px-2 py-1 font-semibold text-gray-600">{d}</div>)}
          {days.map((d) => {
            const inMonth = d.slice(0, 7) === month;
            const list = byDay.get(d) ?? [];
            return (
              <div key={d} role="button" tabIndex={0} onClick={() => onNew(d)} onKeyDown={(e) => { if (e.key === 'Enter') onNew(d); }}
                className={`min-h-[96px] cursor-pointer p-1 hover:bg-ooosh-50 ${inMonth ? 'bg-white' : 'bg-gray-50 text-gray-400'}`}>
                <div className={`mb-1 text-right ${d === today ? 'font-bold text-ooosh-700' : ''}`}>
                  {d === today ? <span className="rounded-full bg-ooosh-600 px-1.5 text-white">{Number(d.slice(8))}</span> : Number(d.slice(8))}
                </div>
                <div className="space-y-1">
                  {list.map((p) => (
                    <button key={p.id} type="button" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}
                      className={`block w-full rounded border-l-4 bg-white px-1 py-0.5 text-left shadow-sm hover:shadow ${statusOf(p.status).cls}`}
                      title={`${p.title} — ${statusOf(p.status).label}`}>
                      <span className="flex items-center gap-1"><span className="tabular-nums">{p.publish_time}</span><ChannelChips channels={p.channels} /></span>
                      <span className="block truncate font-medium">{p.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">{STATUSES.filter((s) => s.key !== 'dropped' && s.key !== 'idea').map((s) => <span key={s.key} className={`rounded-full px-2 py-0.5 ${s.cls}`}>{s.label}</span>)}</div>
    </div>
  );
}

// ── Coming up — the calendar on a phone ──────────────────────────────────────
/**
 * A week at a time, a day per row (jon, 18 Nov 2026: "a week, then options for the
 * following weeks"). ‹ › step a week; "Show the week after too" adds the next one below.
 */
function ComingUpView({ refreshKey, onOpen, onNew }: { refreshKey: number; onOpen: (id: string) => void; onNew: (date: string) => void }) {
  const today = ukToday();
  const thisMonday = mondayOf(today);
  const [start, setStart] = useState(thisMonday);
  const [weeks, setWeeks] = useState(1);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const end = addDays(start, weeks * 7 - 1);

  useEffect(() => {
    setError('');
    api.get<{ data: Post[] }>(`/marketing-content/posts?view=calendar&from=${start}&to=${end}`)
      .then((r) => setPosts(r.data))
      .catch((e) => setError(errMsg(e, 'Could not load the posts')));
  }, [start, end, refreshKey]);

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts ?? []) if (p.publish_date) m.set(p.publish_date, [...(m.get(p.publish_date) ?? []), p]);
    return m;
  }, [posts]);

  const step = (n: number) => { setStart(addDays(start, n * 7)); setWeeks(1); };
  const range = `${shortDay(start)} – ${shortDay(end)}`;

  async function copy(p: Post) {
    try {
      await navigator.clipboard.writeText([p.caption?.trim(), p.hashtags?.trim()].filter(Boolean).join('\n\n'));
      setCopied(p.id);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* blocked — the editor's own button explains */ }
  }

  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(start, i * 7));
  return (
    <div className="space-y-3 pb-20">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => step(-1)} className="rounded-lg border border-gray-300 px-3 py-1.5" aria-label="The week before">‹</button>
        <div className="flex-1 text-center">
          <div className="text-sm font-semibold text-gray-900">{start === thisMonday && weeks === 1 ? 'This week' : range}</div>
          {start === thisMonday && weeks === 1 ? <div className="text-xs text-gray-500">{range}</div>
            : <button type="button" onClick={() => { setStart(thisMonday); setWeeks(1); }} className="text-xs text-ooosh-700">Back to this week</button>}
        </div>
        <button type="button" onClick={() => step(1)} className="rounded-lg border border-gray-300 px-3 py-1.5" aria-label="The week after">›</button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!posts && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {posts && weekStarts.map((ws, wi) => (
        <div key={ws} className="space-y-1.5">
          {wi > 0 && <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Week of {shortDay(ws)}</h3>}
          {Array.from({ length: 7 }, (_, i) => addDays(ws, i)).map((d) => {
            const list = byDay.get(d) ?? [];
            const past = d < today;
            return (
              <div key={d} className={`rounded-lg border ${d === today ? 'border-ooosh-300 bg-ooosh-50' : 'border-gray-200 bg-white'} ${past ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm font-semibold text-gray-800">
                    {shortDay(d)}{d === today && <span className="ml-2 rounded-full bg-ooosh-600 px-2 py-0.5 text-[11px] font-medium text-white">Today</span>}
                    {list.length === 0 && <span className="ml-2 text-xs font-normal text-gray-400">nothing planned</span>}
                  </span>
                  <button type="button" onClick={() => onNew(d)} className="h-8 w-8 rounded-full border border-gray-300 text-lg leading-none text-gray-600" aria-label={`Plan a post on ${shortDay(d)}`}>+</button>
                </div>
                {list.length > 0 && (
                  <ul className="space-y-1.5 px-2 pb-2">
                    {list.map((p) => (
                      <li key={p.id} className="rounded-lg border border-gray-200 bg-white">
                        <button type="button" onClick={() => onOpen(p.id)} className="block w-full px-3 py-2 text-left">
                          <span className="flex items-center gap-1.5 text-xs text-gray-600">
                            <span className="tabular-nums font-medium">{p.publish_time}</span><ChannelChips channels={p.channels} />
                            <span className="ml-auto"><StatusPill status={p.status} /></span>
                          </span>
                          <span className="mt-1 block text-sm font-medium text-gray-900">{p.title}</span>
                          {(p.owner_name || p.format) && <span className="block text-xs text-gray-500">{[formatLabel(p.format), p.owner_name].filter(Boolean).join(' · ')}</span>}
                        </button>
                        {(p.caption || p.hashtags) && (
                          <div className="border-t border-gray-100 px-3 py-1.5">
                            <button type="button" onClick={() => void copy(p)} className="text-xs font-medium text-ooosh-700">
                              {copied === p.id ? 'Copied ✓' : 'Copy for Meta'}
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {posts && (
        <button type="button" onClick={() => setWeeks((w) => w + 1)} className="w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-sm text-gray-700">
          Show the week after too
        </button>
      )}
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────
function BoardCard({ p, onOpen, onMove }: { p: Post; onOpen: (id: string) => void; onMove: (p: Post, status: string) => void }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 text-xs shadow-sm">
      <button type="button" onClick={() => onOpen(p.id)} className="block w-full text-left">
        <span className="block font-medium text-gray-900 hover:text-ooosh-700">{p.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-gray-500">
          {p.publish_date ? `${shortDay(p.publish_date)} ${p.publish_time}` : 'No date'}
          <ChannelChips channels={p.channels} />
        </span>
        <span className="mt-0.5 block text-gray-500">
          {[formatLabel(p.format), p.owner_name, p.asset_count ? `${p.asset_count} file${p.asset_count === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
        </span>
      </button>
      <select value={p.status} onChange={(e) => onMove(p, e.target.value)} aria-label="Move to"
        className="mt-1 w-full rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-600">
        {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.key === p.status ? s.label : `→ ${s.label}`}</option>)}
      </select>
    </div>
  );
}

function BoardView({ refreshKey, onOpen, onChanged, isPhone }: { refreshKey: number; onOpen: (id: string) => void; onChanged: () => void; isPhone: boolean }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  // On a phone, one status at a time (six columns don't fit).
  const [phoneStatus, setPhoneStatus] = useState<string>('in_progress');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<{ data: Post[] }>('/marketing-content/posts?view=board')
      .then((r) => setPosts(r.data))
      .catch((e) => setError(errMsg(e, 'Could not load the board')));
  }, [refreshKey]);

  async function move(p: Post, status: string) {
    try {
      const r = await api.patch<{ data: Post }>(`/marketing-content/posts/${p.id}`, { status });
      setPosts((prev) => (prev ?? []).map((x) => (x.id === p.id ? { ...x, ...r.data } : x)));
      onChanged();
    } catch (e) { setError(errMsg(e, 'Could not move it')); }
  }

  const columns = STATUSES.filter((s) => s.key !== 'dropped');
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!posts && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {posts && isPhone && (
        <div className="space-y-2">
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
            {columns.map((c) => {
              const n = posts.filter((p) => p.status === c.key).length;
              return (
                <button key={c.key} type="button" onClick={() => setPhoneStatus(c.key)}
                  className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${phoneStatus === c.key ? 'bg-gray-800 text-white' : c.cls}`}>
                  {c.label} {n}
                </button>
              );
            })}
          </div>
          {posts.filter((p) => p.status === phoneStatus).length === 0
            ? <p className="py-4 text-center text-sm text-gray-500">Nothing at {statusOf(phoneStatus).label}.</p>
            : <div className="space-y-2">{posts.filter((p) => p.status === phoneStatus).map((p) => <BoardCard key={p.id} p={p} onOpen={onOpen} onMove={(x, st) => void move(x, st)} />)}</div>}
        </div>
      )}
      {posts && !isPhone && (
        <div className="overflow-x-auto">
          <div className="grid min-w-[1000px] grid-cols-6 gap-2">
            {columns.map((c) => {
              const list = posts.filter((p) => p.status === c.key);
              return (
                <div key={c.key} className="rounded-lg bg-gray-50 p-2">
                  <div className="mb-2 flex items-center justify-between"><StatusPill status={c.key} /><span className="text-xs text-gray-500">{list.length}</span></div>
                  <div className="space-y-2">
                    {list.map((p) => <BoardCard key={p.id} p={p} onOpen={onOpen} onMove={(x, st) => void move(x, st)} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-xs text-gray-500">Published posts drop off the board after 30 days; they stay on the calendar.</p>
    </div>
  );
}

// ── Ideas ─────────────────────────────────────────────────────────────────────
function IdeasView({ refreshKey, onOpen }: { refreshKey: number; onOpen: (id: string) => void }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<{ data: Post[] }>('/marketing-content/posts?view=ideas')
      .then((r) => setPosts(r.data))
      .catch((e) => setError(errMsg(e, 'Could not load the ideas')));
  }, [refreshKey]);
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!posts && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {posts && posts.length === 0 && <p className="text-sm text-gray-500">No ideas waiting. A post with no date lands here.</p>}
      {posts && posts.length > 0 && (
        <ul className="divide-y rounded-lg border border-gray-200 bg-white">
          {posts.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50">
                <span className="font-medium text-gray-900">{p.title}</span>
                <ChannelChips channels={p.channels} />
                {p.theme && <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-600">{p.theme}</span>}
                <span className="ml-auto text-xs text-gray-500">{[p.organisation_name, p.owner_name].filter(Boolean).join(' · ')}</span>
                <StatusPill status={p.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Content library ───────────────────────────────────────────────────────────
function LibraryView({ isPhone }: { isPhone: boolean }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState<{ title: string; url: string; kind: string; notes: string } | null>(null);
  const [tagOrg, setTagOrg] = useState<PickerOption | null>(null);
  const [tagJob, setTagJob] = useState<PickerOption | null>(null);
  const [tagCredit, setTagCredit] = useState<PickerOption | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    if (archived) q.set('archived', '1');
    api.get<{ data: Asset[] }>(`/marketing-content/assets?${q}`)
      .then((r) => setAssets(r.data))
      .catch((e) => setError(errMsg(e, 'Could not load the library')));
  }, [search, archived]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function add() {
    if (!adding) return;
    setError('');
    try {
      await api.post('/marketing-content/assets', {
        title: adding.title.trim(), url: adding.url.trim(), kind: adding.kind, notes: adding.notes.trim() || null,
        organisation_id: tagOrg?.value || null, job_id: tagJob?.value || null, credit_person_id: tagCredit?.value || null,
      });
      setAdding(null);
      setTagOrg(null); setTagJob(null); setTagCredit(null);
      load();
    } catch (e) { setError(errMsg(e, 'Could not add it')); }
  }
  async function setArchivedFor(a: Asset, value: boolean) {
    try { await api.patch(`/marketing-content/assets/${a.id}`, { archived: value }); load(); }
    catch (e) { setError(errMsg(e, 'Could not change it')); }
  }

  return (
    <div className="space-y-3">
      <p className="hidden text-sm text-gray-600 sm:block">Photos, videos and graphics we could post — each one a Google Drive link. Tag the band and the job so they're easy to find.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search (name, band, job number)…" className="w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        <label className="flex items-center gap-1 text-sm text-gray-600"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
        {!adding && <button type="button" onClick={() => setAdding({ title: '', url: '', kind: 'photo', notes: '' })} className="ml-auto rounded-lg bg-ooosh-600 px-3 py-1.5 text-sm text-white hover:bg-ooosh-700">+ Add content</button>}
      </div>
      {adding && (
        <div className="grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm sm:grid-cols-[1fr_1.4fr_auto]">
          <input className="rounded-lg border border-gray-300 px-3 py-2" placeholder="What it is (e.g. Ruby Road load-in, Brixton)" value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} />
          <input className="rounded-lg border border-gray-300 px-3 py-2" placeholder="https://drive.google.com/…" value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} />
          <select className="rounded-lg border border-gray-300 px-3 py-2" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })}>
            {ASSET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <div className="grid gap-2 sm:col-span-3 sm:grid-cols-3">
            <SearchPicker value={tagOrg} onChange={setTagOrg} loadOptions={searchOrgs} minChars={2} placeholder="The band (optional)…" />
            <SearchPicker value={tagJob} onChange={setTagJob} loadOptions={searchJobs} minChars={2} placeholder="Their job (optional)…" />
            <SearchPicker value={tagCredit} onChange={setTagCredit} loadOptions={searchPeople} minChars={2} placeholder="Who took it (optional)…" />
          </div>
          <input className="rounded-lg border border-gray-300 px-3 py-2 sm:col-span-2" placeholder="Notes (optional)" value={adding.notes} onChange={(e) => setAdding({ ...adding, notes: e.target.value })} />
          <span className="flex gap-2">
            <button type="button" onClick={add} className="rounded-lg bg-ooosh-600 px-3 py-2 text-white hover:bg-ooosh-700">Add</button>
            <button type="button" onClick={() => setAdding(null)} className="rounded-lg border border-gray-300 px-3 py-2 hover:bg-white">Cancel</button>
          </span>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!assets && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {assets && assets.length === 0 && <p className="text-sm text-gray-500">{archived ? 'Nothing archived.' : 'Nothing in the library yet.'}</p>}
      {assets && assets.length > 0 && isPhone && (
        <ul className="divide-y rounded-lg border border-gray-200 bg-white">
          {assets.map((a) => (
            <li key={a.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <a href={a.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-ooosh-700">{assetKindOf(a.kind).icon} {a.title}</a>
                <button type="button" onClick={() => void setArchivedFor(a, !a.archived_at)} className="shrink-0 text-xs text-gray-500">{a.archived_at ? 'Bring back' : 'Archive'}</button>
              </div>
              {a.source === 'sitter' && <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 text-[11px] text-amber-800">from a sitter</span>}
              <div className="mt-0.5 text-xs text-gray-500">
                {[a.organisation_name, a.job_number ? `#${a.job_number}` : null, a.credit_name ? `by ${a.credit_name}` : null, a.used_in ? `in ${a.used_in} post${a.used_in === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
              </div>
              {a.notes && <div className="text-xs text-gray-500">{a.notes}</div>}
            </li>
          ))}
        </ul>
      )}
      {assets && assets.length > 0 && !isPhone && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr><th className="px-3 py-2">Content</th><th className="px-3 py-2">Band / job</th><th className="px-3 py-2">Credit</th><th className="px-3 py-2">Added</th><th className="px-3 py-2 text-right">In posts</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y">
              {assets.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">
                    <a href={a.url} target="_blank" rel="noreferrer" className="text-ooosh-700 hover:underline">{assetKindOf(a.kind).icon} {a.title}</a>
                    {a.source === 'sitter' && <span className="ml-1 rounded bg-amber-100 px-1.5 text-[11px] text-amber-800">from a sitter</span>}
                    {a.notes && <span className="block text-xs text-gray-500">{a.notes}</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{[a.organisation_name, a.job_number ? `#${a.job_number}` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{a.credit_name || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{a.added_by_name || '—'}<br />{a.created_at ? new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.used_in || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => void setArchivedFor(a, !a.archived_at)} className="text-xs text-gray-500 hover:text-gray-800">{a.archived_at ? 'Bring back' : 'Archive'}</button>
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

// ── The tab ───────────────────────────────────────────────────────────────────
export default function ContentPlanner({ openPostId }: { openPostId?: string | null }) {
  const isPhone = useIsPhone();
  const [view, setViewState] = useState<View>(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.some((x) => x.key === v)) return v as View; } catch { /* storage blocked */ }
    return 'calendar';
  });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked */ } };
  const [editor, setEditor] = useState<{ id: string | null; date?: string | null } | null>(openPostId ? { id: openPostId } : null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [changed, setChanged] = useState(false);

  // A To Do link (…?tab=content&post=<id>) opens that post.
  useEffect(() => { if (openPostId) setEditor({ id: openPostId }); }, [openPostId]);

  const closeEditor = () => {
    setEditor(null);
    if (changed) { setRefreshKey((k) => k + 1); setChanged(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex max-w-full overflow-x-auto rounded-lg border border-gray-300 p-0.5 text-sm">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" onClick={() => setView(v.key)}
              className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-md ${view === v.key ? 'bg-gray-800 text-white' : 'text-gray-700 hover:bg-gray-50'}`}>
              {isPhone ? (v.key === 'calendar' ? 'Coming up' : v.key === 'library' ? 'Library' : v.label) : v.label}
            </button>
          ))}
        </div>
        {view !== 'library' && !isPhone && (
          <button type="button" onClick={() => setEditor({ id: null, date: null })} className="ml-auto rounded-lg bg-ooosh-600 px-3 py-1.5 text-sm text-white hover:bg-ooosh-700">
            + New post or idea
          </button>
        )}
      </div>

      {view === 'calendar' && !isPhone && <CalendarView refreshKey={refreshKey} onOpen={(id) => setEditor({ id })} onNew={(date) => setEditor({ id: null, date })} />}
      {view === 'calendar' && isPhone && <ComingUpView refreshKey={refreshKey} onOpen={(id) => setEditor({ id })} onNew={(date) => setEditor({ id: null, date })} />}
      {view === 'board' && <BoardView isPhone={isPhone} refreshKey={refreshKey} onOpen={(id) => setEditor({ id })} onChanged={() => { /* the board merged it in already */ }} />}
      {view === 'ideas' && <IdeasView refreshKey={refreshKey} onOpen={(id) => setEditor({ id })} />}
      {view === 'library' && <LibraryView isPhone={isPhone} />}

      {/* On a phone, "new" is a round button in the corner, always in reach. */}
      {isPhone && view !== 'library' && !editor && (
        <button type="button" onClick={() => setEditor({ id: null, date: null })} aria-label="New post or idea"
          className="fixed bottom-5 right-5 z-40 h-14 w-14 rounded-full bg-ooosh-600 text-3xl leading-none text-white shadow-lg hover:bg-ooosh-700">+</button>
      )}

      {editor && (
        <PostEditor key={editor.id ?? `new-${editor.date ?? ''}`} postId={editor.id} startDate={editor.date}
          onClose={closeEditor} onSaved={() => setChanged(true)} />
      )}
    </div>
  );
}
