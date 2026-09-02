import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { EntitySearch } from '../components/holding/EntitySearch';
import { NotifyClientModal } from '../components/holding/NotifyClientModal';
import { HeldItemForm } from '../components/holding/HeldItemForm';
import { HeldItemPicker, HandoverFlow } from '../components/holding/HeldItemPicker';
import { describeHeldCounts, heldCountClass, isPartiallyArrived } from '../components/holding/counts';
import { locationLabelOrDash } from '../components/holding/format';
import { ChaseReviewPanel } from '../components/holding/ChaseReviewPanel';
import ThreadView from '../components/messaging/ThreadView';
import { MentionComposer } from '../components/messaging/MentionComposer';
import { useAttachments } from '../components/messaging/Attachments';
import type { HeldItem, HeldItemKind, HeldItemLocation, HeldItemNextAction } from '../../../shared/types';

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

// One page, two kinds. `temp_storage` is folded into `incoming` (Aug 2026) —
// historical rows still carry it, so it maps to the same filter + label.
// The kind split that survives is "does the client know we've got it?":
//   incoming      → they sent it / left it with us  → ends in a handover
//   lost_property → we found it                     → ends in collection or
//                                                     disposal, chase ladder
type KindFilter = 'all' | 'incoming' | 'lost_property';
const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'incoming', label: '📦 Held for a client' },
  { id: 'lost_property', label: '🔍 Lost property' },
];
const matchesKind = (h: HeldItem, f: KindFilter) =>
  f === 'all' || (f === 'incoming' ? h.kind !== 'lost_property' : h.kind === 'lost_property');

const STATUS_COLOUR: Record<string, string> = {
  expected: 'bg-slate-100 text-slate-600',
  arrived: 'bg-blue-100 text-blue-800',
  stored: 'bg-blue-100 text-blue-800',
  client_notified: 'bg-amber-100 text-amber-800',
  collection_arranged: 'bg-amber-100 text-amber-800',
  collected: 'bg-green-100 text-green-700',
  given_to_client: 'bg-green-100 text-green-700',
  shipped_back: 'bg-green-100 text-green-700',
  disposed: 'bg-slate-200 text-slate-500',
  unclaimed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-500',
};
const statusLabel = (s: string) => s.replace(/_/g, ' ');
const KIND_LABEL: Record<HeldItemKind, string> = {
  incoming: 'Held for a client', temp_storage: 'Held for a client', lost_property: 'Lost property',
};
const KIND_EMOJI: Record<HeldItemKind, string> = {
  incoming: '📦', temp_storage: '📦', lost_property: '🔍',
};

// ── Next action — the organising principle of the page ──────────────────────
// Derived server-side (routes/holding.ts) so the strip, the table and any
// future dashboard bucket read ONE definition of "what does this need".
const ACTION_BUCKETS: { id: HeldItemNextAction; label: string; emoji: string; accent: string }[] = [
  { id: 'link_owner',  label: 'Needs linking',  emoji: '❓', accent: 'border-amber-300 bg-amber-50 text-amber-900' },
  { id: 'receive',     label: 'Awaiting arrival', emoji: '⏳', accent: 'border-slate-300 bg-slate-50 text-slate-800' },
  { id: 'hand_over',   label: 'To hand over',   emoji: '📦', accent: 'border-blue-300 bg-blue-50 text-blue-900' },
  { id: 'chase_owner', label: 'Chase owner',    emoji: '📨', accent: 'border-purple-300 bg-purple-50 text-purple-900' },
  { id: 'decide',      label: "Time's up",      emoji: '🕑', accent: 'border-red-300 bg-red-50 text-red-900' },
];
const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  ACTION_BUCKETS.map((b) => [b.id, b.label]),
);

// Colour the due date by urgency — overdue red, today/tomorrow amber, else quiet.
function ActionDueCell({ item }: { item: HeldItem }) {
  const action = item.next_action;
  if (!action || action === 'none') return <span className="text-slate-300">—</span>;
  const label = ACTION_LABEL[action] || action;
  if (!item.action_due) return <span className="text-slate-600">{label}</span>;
  const days = Math.floor((new Date(item.action_due).getTime() - Date.now()) / 86400000);
  // link_owner ranks by AGE (how long the trail's been cold), so its date is a
  // "found/logged on" not a deadline — render it as an age, never as overdue.
  if (action === 'link_owner') {
    return <span className="text-amber-700">{label} <span className="text-xs text-slate-500">· {Math.max(0, -days)}d old</span></span>;
  }
  // A lost-property chase paused by a client-given collection date isn't
  // overdue — it's waiting on them. Preserves the signal the old dedicated
  // "next chase due" column carried.
  if (action === 'chase_owner' && item.chase_state === 'paused') {
    return <span className="text-blue-600" title="Paused — client gave a collection date">{label} <span className="text-xs">· ⏸ {fmtDate(item.action_due)}</span></span>;
  }
  const cls = days < 0 ? 'text-red-600 font-medium' : days <= 1 ? 'text-amber-700 font-medium' : 'text-slate-600';
  return <span className={cls}>{label} <span className="text-xs font-normal">· {fmtDate(item.action_due)}</span></span>;
}

// ── Table sorting ───────────────────────────────────────────────────────────
// Default order is the server's (action_due asc, resolved last); a header click
// overrides it.
type SortKey = 'action_due' | 'found_date' | 'last_chased_at' | 'escalation_level' | 'next_chase_due' | 'expected_collection_date';
function sortVal(h: HeldItem, key: SortKey): number | null {
  if (key === 'escalation_level') return h.escalation_level ?? 0;
  const v = h[key] as string | null | undefined;
  return v ? Date.parse(v) : null;
}
function PhotoThumb({ photoKey, onOpen }: { photoKey: string; onOpen: () => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    api.blob(`/files/download?key=${encodeURIComponent(photoKey)}`)
      .then(({ blob }) => { url = URL.createObjectURL(blob); setSrc(url); })
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [photoKey]);
  return src
    ? <img src={src} onClick={onOpen} className="w-20 h-20 object-cover rounded-lg border border-slate-200 cursor-pointer hover:opacity-90" alt="" />
    : <div className="w-20 h-20 rounded-lg bg-slate-100 animate-pulse" />;
}
const FOUND_IN_LABEL: Record<string, string> = {
  van: 'Van', rehearsal: 'Rehearsal room', backline: 'Backline', elsewhere: 'Somewhere else',
};

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
/**
 * Holding — one page for everything we're keeping that isn't ours.
 *
 * Organised by NEXT ACTION, not by kind: the strip at the top is the triage
 * answer ("what needs doing"), the table below is the find-a-thing answer.
 * Kind is a filter + a row icon, never a separate page.
 *
 * `/holding/lost-property` still resolves — it mounts this same page with the
 * lost-property filter pre-applied. That route can never be removed: the daily
 * chase digest's `?review=1` link is already sitting in staff inboxes and on
 * historical notification rows.
 *
 * One fetch drives everything; filtering is client-side so the strip counts
 * stay stable while a filter is applied (tens of open rows — see the note on
 * GET /holding in routes/holding.ts).
 */
export default function HoldingPage({ defaultKind }: { defaultKind?: KindFilter }) {
  const [items, setItems] = useState<HeldItem[]>([]);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  // The two physical actions — receiving and handing over — used to exist only
  // on the mobile /quick page, so backfilling an arrived delivery meant leaving
  // this page entirely. Same shared components as /quick.
  const [receiving, setReceiving] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // null = server order (next action due, resolved last).
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (showDone) qs.set('include_done', 'true');
      const r = await api.get<{ data: HeldItem[] }>(`/holding?${qs.toString()}`);
      setItems(r.data);
    } finally { setLoading(false); }
  }, [showDone]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  const [searchParams, setSearchParams] = useSearchParams();

  // Filters live in the URL so every bucket + kind view is linkable (and the
  // legacy /holding/lost-property route just seeds the kind).
  const kindFilter: KindFilter = (searchParams.get('kind') as KindFilter) || defaultKind || 'all';
  const actionFilter = searchParams.get('action') as HeldItemNextAction | null;
  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Deep-link: ?item=<id> (from a discussion @mention, the hold-until nudge, or
  // a job/person/org panel row) pre-opens that item's detail modal.
  const itemParam = searchParams.get('item');
  useEffect(() => { if (itemParam) setDetailId(itemParam); }, [itemParam]);
  const closeDetail = useCallback(() => {
    setDetailId(null);
    if (searchParams.has('item')) {
      const next = new URLSearchParams(searchParams);
      next.delete('item');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const inKind = items.filter((i) => matchesKind(i, kindFilter));
  const openInKind = inKind.filter((i) => i.next_action && i.next_action !== 'none');
  const bucketCount = (id: HeldItemNextAction) => openInKind.filter((i) => i.next_action === id).length;

  const q = search.trim().toLowerCase();
  const rows = inKind.filter((h) => {
    if (actionFilter && h.next_action !== actionFilter) return false;
    if (!q) return true;
    return [h.description, h.owner_person_name, h.owner_organisation_name, h.client_name_text, h.notes,
      h.hh_job_number ? `#${h.hh_job_number}` : null]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });

  // Server already orders by "when does this need me"; a header click overrides.
  // Nulls always sink to the bottom regardless of direction.
  const sortedRows = sort
    ? [...rows].sort((a, b) => {
        const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
        if (va === vb) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return sort.dir === 'asc' ? va - vb : vb - va;
      })
    : rows;

  const showChaseCols = kindFilter === 'lost_property';
  // The chase review queue is the "chase owner" bucket's action surface.
  const showChasePanel = kindFilter === 'lost_property' || actionFilter === 'chase_owner' || searchParams.get('review') === '1';

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <th onClick={() => setSort((s) => (s && s.key === k && s.dir === 'asc' ? { key: k, dir: 'desc' } : { key: k, dir: 'asc' }))}
      className="text-left px-3 py-2 cursor-pointer select-none hover:text-slate-700 whitespace-nowrap">
      {label}{sort?.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Holding</h1>
          <p className="text-sm text-slate-500">Things we're keeping that aren't ours.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setReceiving(true)} className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50">
            📦 Receive delivery
          </button>
          <button onClick={() => setHandingOver(true)} className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50">
            ✅ Hand over
          </button>
          <button onClick={() => setCreating(true)} className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">
            + Log Item
          </button>
        </div>
      </div>

      {/* Action strip — what needs doing, at a glance. Click to filter. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        {ACTION_BUCKETS.map((b) => {
          const n = bucketCount(b.id);
          const active = actionFilter === b.id;
          return (
            <button key={b.id} onClick={() => setParam('action', active ? null : b.id)}
              className={`text-left border rounded-xl px-3 py-2 transition-colors ${
                n === 0 ? 'border-slate-200 bg-white text-slate-400' : b.accent
              } ${active ? 'ring-2 ring-[#7B5EA7] ring-offset-1' : ''}`}>
              <div className="text-xl font-bold leading-tight">{n}</div>
              <div className="text-xs font-medium leading-tight">{b.emoji} {b.label}</div>
            </button>
          );
        })}
      </div>

      {showChasePanel && <ChaseReviewPanel defaultOpen={searchParams.get('review') === '1'} onChanged={load} />}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* `setParam('kind', k.id)` always writes the param, including 'all' —
            deleting it would fall back to the route's defaultKind, so
            "Everything" would be unselectable on /holding/lost-property. */}
        <div className="flex gap-1">
          {KIND_FILTERS.map((k) => (
            <button key={k.id} onClick={() => setParam('kind', k.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                kindFilter === k.id ? 'bg-[#7B5EA7] text-white border-[#7B5EA7]' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}>
              {k.label}
            </button>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description / client / job # / notes…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
        <span className="text-xs text-slate-400">{openInKind.length} open</span>
        {(actionFilter || search) && (
          <button onClick={() => { setParam('action', null); setSearch(''); }} className="text-xs text-[#7B5EA7] font-medium">Clear filters</button>
        )}
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs"><tr>
            <th className="text-left px-3 py-2">Item</th>
            <th className="text-left px-3 py-2">Client</th>
            {showChaseCols ? (
              <>
                <SortTh label="Found" k="found_date" />
                <SortTh label="Last contacted" k="last_chased_at" />
                <SortTh label="Chases" k="escalation_level" />
                <SortTh label="Expected collection" k="expected_collection_date" />
              </>
            ) : (
              <>
                <th className="text-left px-3 py-2">Job</th>
                <th className="text-left px-3 py-2">Boxes</th>
                <th className="text-left px-3 py-2">Location</th>
              </>
            )}
            <SortTh label="Next action" k="action_due" />
            <th className="text-left px-3 py-2">Status</th>
          </tr></thead>
          <tbody>
            {sortedRows.map((h) => {
              const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
              const counts = describeHeldCounts(h);
              return (
                <tr key={h.id} onClick={() => setDetailId(h.id)} className="border-t hover:bg-slate-50 cursor-pointer">
                  <td className="px-3 py-2 font-medium text-slate-800">
                    <span className="mr-1">{KIND_EMOJI[h.kind]}</span>
                    {h.description || <span className="text-slate-400 italic">No description</span>}
                    {!!h.discussion_count && (
                      <span className="ml-1.5 text-xs text-slate-400" title={`${h.discussion_count} discussion note${h.discussion_count === 1 ? '' : 's'}`}>💬 {h.discussion_count}</span>
                    )}
                    {h.kind === 'lost_property' && h.found_in && (
                      <span className="block text-xs font-normal text-slate-400">
                        {FOUND_IN_LABEL[h.found_in]}{h.found_vehicle_reg ? ` · ${h.found_vehicle_reg}` : (h.found_location_text ? ` · ${h.found_location_text}` : '')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {h.owner_unknown
                      ? <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown</span>
                      : (client || <span className="text-slate-400">—</span>)}
                  </td>
                  {showChaseCols ? (
                    <>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.found_date)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{h.last_chased_at ? fmtDate(h.last_chased_at) : <span className="text-slate-400">Not yet</span>}</td>
                      <td className="px-3 py-2 text-center">{h.escalation_level || 0}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{h.expected_collection_date ? fmtDate(h.expected_collection_date) : <span className="text-slate-400">—</span>}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2">{h.hh_job_number ? `#${h.hh_job_number}` : '—'}</td>
                      <td className="px-3 py-2">
                        {counts
                          ? <span className={`font-medium ${heldCountClass(counts.tone)}`} title={counts.text}>{counts.short}</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2">{locationLabelOrDash(h)}</td>
                    </>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap"><ActionDueCell item={h} /></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span></td>
                </tr>
              );
            })}
            {sortedRows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                {loading ? 'Loading…' : actionFilter || search ? 'Nothing matching those filters.' : 'Nothing held right now.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && <CreateModal kindFilter={kindFilter} locations={locations} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {receiving && <ReceiveModal locations={locations} onClose={() => setReceiving(false)} onSaved={() => { setReceiving(false); load(); }} />}
      {handingOver && (
        <Modal title="Hand over an item" onClose={() => setHandingOver(false)}>
          <HandoverFlow compact onDone={() => { setHandingOver(false); load(); }} />
        </Modal>
      )}
      {detailId && <DetailModal id={detailId} locations={locations} onClose={closeDetail} onChange={load} />}
    </div>
  );
}

// ════════════════════════ RECEIVE / CREATE ════════════════════════
/**
 * Receive a delivery — search first (so an expected one gets booked in against
 * its existing record rather than duplicated), falling through to a fresh log
 * with "it's already here" pre-ticked. Mirrors /quick's Package-arrived tile.
 */
function ReceiveModal({ locations, onClose, onSaved }: { locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'search' | 'create'>('search');

  if (mode === 'create') {
    return (
      <Modal title="Log a delivery that's already here" onClose={onClose}>
        <HeldItemForm variant="desktop" kinds={['incoming']} locations={locations} arrivedDefault
          onDone={onSaved} onCancel={() => setMode('search')} />
      </Modal>
    );
  }

  return (
    <Modal title="Receive a delivery" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">
          Is it already expected? Search by job #, client or description — pick it to book it in.
          If nobody told us it was coming, log it as new.
        </p>
        <HeldItemPicker compact kinds={['incoming', 'temp_storage']}
          placeholder="Search expected deliveries…"
          emptyHint="Nothing matching — log it as new below."
          onPick={(h) => navigate(`/holding/receipt/${h.id}`)} />
        <button onClick={() => setMode('create')}
          className="w-full border-2 border-dashed border-slate-300 rounded-lg py-2.5 text-sm text-slate-600 font-medium hover:bg-slate-50">
          + Not listed — log a delivery that's already here
        </button>
      </div>
    </Modal>
  );
}

// Thin wrapper around the shared HeldItemForm (also used by the mobile /quick
// launcher) so the desktop + mobile capture flows can never drift apart.
function CreateModal({ kindFilter, locations, onClose, onSaved }: {
  kindFilter: KindFilter; locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void;
}) {
  // Offer both kinds unless the page is already filtered to one — logging is
  // where the "is this held-for-a-client or lost property?" question gets
  // answered, and on the unfiltered view staff should still get the choice.
  // `temp_storage` is deliberately not offered (folded into `incoming`).
  const kinds: HeldItemKind[] =
    kindFilter === 'lost_property' ? ['lost_property']
    : kindFilter === 'incoming' ? ['incoming']
    : ['incoming', 'lost_property'];
  return (
    <Modal title="Log an item" onClose={onClose}>
      <HeldItemForm variant="desktop" kinds={kinds} locations={locations} onDone={onSaved} onCancel={onClose} />
    </Modal>
  );
}

// ════════════════════════ DETAIL ════════════════════════
function DetailModal({ id, locations, onClose, onChange }: { id: string; locations: HeldItemLocation[]; onClose: () => void; onChange: () => void }) {
  const [h, setH] = useState<HeldItem | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [openAction, setOpenAction] = useState<null | 'collect' | 'ship' | 'location' | 'shortfall'>(null);

  const load = useCallback(async () => { setH((await api.get<{ data: HeldItem }>(`/holding/${id}`)).data); }, [id]);
  useEffect(() => { load(); }, [load]);

  async function action(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg('');
    try { await fn(); await load(); onChange(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  if (!h) return <Modal title="Held item" onClose={onClose}><p className="text-slate-400">Loading…</p></Modal>;

  const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
  const isOpen = !['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'].includes(h.status);

  async function viewPhoto(key: string) {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { setMsg('Could not open photo.'); }
  }

  return (
    <Modal title={h.description || KIND_LABEL[h.kind]} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span>
          <span className="text-xs text-slate-400">{KIND_LABEL[h.kind]}</span>
          {h.owner_unknown && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown owner</span>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Client" value={client || (h.owner_unknown ? 'Unknown' : '—')} />
          <div>
            <p className="text-xs text-slate-400">Job (HH #)</p>
            {h.hh_job_number
              ? (h.job_id
                  ? <Link to={`/jobs/${h.job_id}`} title="Opens the job in the operations portal" className="text-ooosh-600 hover:underline">#{h.hh_job_number} · open job in OP →</Link>
                  : <p className="text-slate-800">#{h.hh_job_number} <span className="text-xs text-slate-400">(not linked in OP)</span></p>)
              : <p className="text-slate-800">—</p>}
          </div>
          {h.kind !== 'lost_property' && (() => {
            const c = describeHeldCounts(h);
            return <Field label="Boxes" plain className={c ? heldCountClass(c.tone) : ''} value={c ? c.text : '—'} />;
          })()}
          {/* Dates (expected / needed-by / hold-until) are editable in the
              Dates section below. Here we just show the arrival log once it's in. */}
          {h.kind !== 'lost_property' && h.status !== 'expected' && h.arrived_at &&
            <Field label="Arrived" value={`${fmtDate(h.arrived_at)}${h.received_by_name ? ` by ${h.received_by_name}` : ''}`} />}
          {h.kind === 'lost_property' && <Field label="Found in" value={h.found_in ? `${FOUND_IN_LABEL[h.found_in]}${h.found_vehicle_reg ? ` (${h.found_vehicle_reg})` : (h.found_location_text ? ` (${h.found_location_text})` : '')}` : '—'} />}
          {h.kind === 'lost_property' && <Field label="Found date" value={fmtDate(h.found_date)} />}
          <Field label="Location" value={locationLabelOrDash(h)} />
          {h.import_charge_flag && <Field label="Import charge" value={h.import_charge_flag} />}
          {h.collected_at && <Field label="Collected" value={`${fmtDate(h.collected_at)}${h.collected_by ? ` by ${h.collected_by}` : ''}`} />}
          {h.return_method && <Field label="Shipped back" value={`${h.return_method}${h.tracking_number ? ` · ${h.tracking_number}` : ''}`} />}
        </div>

        {h.notes && <p className="text-slate-600"><span className="text-xs text-slate-400">Notes: </span>{h.notes}</p>}

        {/* Photos — inline thumbnails */}
        {(h.photos || []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {h.photos.map((p, idx) => <PhotoThumb key={idx} photoKey={p.url} onOpen={() => viewPhoto(p.url)} />)}
          </div>
        )}

        {msg && <p className="text-red-600">{msg}</p>}

        {/* Details — editable description + box counts (not locked to first input) */}
        {isOpen && <DetailsSection item={h} onChange={() => { load(); onChange(); }} />}

        {/* Chase & collection (lost property) */}
        {h.kind === 'lost_property' && isOpen && <ChaseCollectionSection item={h} onChange={() => { load(); onChange(); }} />}

        {/* Dates — editable for deliveries + temp storage (lost property uses
            its own chase/collection dates above). */}
        {(h.kind === 'incoming' || h.kind === 'temp_storage') && isOpen &&
          <DatesSection item={h} onChange={() => { load(); onChange(); }} />}

        {/* Link / backfill owner */}
        {isOpen && (
          <div>
            <button onClick={() => setLinkOpen((v) => !v)} className="text-xs text-[#7B5EA7] font-medium">
              {h.owner_unknown ? '🔗 Link owner / job' : '✎ Change owner / job'}
            </button>
            {linkOpen && <LinkForm item={h} onDone={() => { setLinkOpen(false); load(); onChange(); }} />}
          </div>
        )}

        {/* Actions — when one inline action is open, the rest hide so the
            "next step" isn't surrounded by unrelated buttons. */}
        {isOpen && (
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {openAction === 'collect' && <CollectButton id={id} kind={h.kind} busy={busy} open onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'ship' && <ShipBackButton id={id} busy={busy} open onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'location' && <LocationButton id={id} locations={locations} current={h.storage_location_id} open onClose={() => setOpenAction(null)} onDone={() => { load(); onChange(); }} />}
            {openAction === 'shortfall' && (
              <ShortfallForm item={h} busy={busy} onClose={() => setOpenAction(null)}
                onDone={() => { setOpenAction(null); setMsg('Expected count corrected.'); load(); onChange(); }} />
            )}
            {openAction === null && (
              <>
                {(h.status === 'expected' || h.status === 'arrived' || h.status === 'stored' || h.status === 'client_notified') && (
                  <button disabled={!!busy} onClick={() => setNotifyOpen(true)}
                    className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">✉ Notify client</button>
                )}
                <CollectButton id={id} kind={h.kind} busy={busy} onOpen={() => setOpenAction('collect')} onAction={action} />
                <ShipBackButton id={id} busy={busy} onOpen={() => setOpenAction('ship')} onAction={action} />
                {/* Two different outcomes for a delivery that isn't complete:
                    - nothing turned up at all  → cancel the record outright
                    - some turned up, rest isn't coming → CORRECT the expected
                      count so the shortfall stops reading as outstanding. That's
                      an update, not a cancellation: what's here is still ours to
                      hand over. Previously only the first existed, and only while
                      the item was still `expected` — so a part-arrived delivery
                      had no way to be closed off at all. */}
                {h.kind === 'incoming' && !h.received_count && h.status === 'expected' && (
                  <button disabled={!!busy} onClick={() => { if (confirm("Mark this as not arriving? It'll drop off the prep checklist.")) action('cancel', async () => { await api.put(`/holding/${id}`, { status: 'cancelled' }); onClose(); }); }}
                    className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-lg text-xs">✕ Won't arrive</button>
                )}
                {h.kind !== 'lost_property' && isPartiallyArrived(h) && (
                  <button disabled={!!busy} onClick={() => setOpenAction('shortfall')}
                    className="px-3 py-1.5 bg-white border border-amber-300 text-amber-700 rounded-lg text-xs">📦 Nothing more coming</button>
                )}
                {h.kind === 'lost_property' && (
                  <button disabled={!!busy} onClick={() => action('chase', async () => { await api.post(`/holding/${id}/chase`, {}); setMsg('Chase logged (escalation bumped).'); })}
                    className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs">📨 Log chase (lvl {h.escalation_level})</button>
                )}
                <button disabled={!!busy} onClick={() => { if (confirm('Mark as disposed?')) action('dispose', async () => { await api.post(`/holding/${id}/dispose`, {}); onClose(); }); }}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs">🗑 Dispose</button>
                <LocationButton id={id} locations={locations} current={h.storage_location_id} onOpen={() => setOpenAction('location')} onDone={() => { load(); onChange(); }} />
              </>
            )}
          </div>
        )}

        {/* Discussion — internal @mentionable thread on this item. Separate
            from the client-facing "Notify client". Mentions fire bell/email
            per each user's notification preference. */}
        <HeldItemDiscussion heldItemId={id} />
      </div>
      {notifyOpen && (
        <NotifyClientModal item={h} onClose={() => setNotifyOpen(false)}
          onSent={(n) => { setNotifyOpen(false); setMsg(n > 0 ? `Sent to ${n} recipient${n === 1 ? '' : 's'}.` : 'Marked notified.'); load(); onChange(); }} />
      )}
    </Modal>
  );
}

/**
 * "Nothing more coming" — correct a short delivery's expected count down to what
 * actually arrived, so the shortfall stops reading as outstanding while what IS
 * here stays open to hand over. An UPDATE, not a cancellation.
 *
 * The optional note goes into the item's discussion thread (not just the notes
 * field) so "why did 2 boxes never show up?" is answerable later, and anyone
 * @mentioned on the thread sees it. The declared figure is preserved on `notes`
 * either way — the correction shouldn't quietly erase what we were told.
 */
function ShortfallForm({ item, busy, onClose, onDone }: {
  item: HeldItem; busy: string; onClose: () => void; onDone: () => void;
}) {
  const here = item.received_count ?? 0;
  const was = item.box_count ?? 0;
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setSaving(true); setErr('');
    try {
      const trail = `[${new Date().toLocaleDateString('en-GB')}] Expected count corrected ${was} → ${here} (nothing more coming).`;
      await api.put(`/holding/${item.id}`, {
        box_count: here,
        notes: item.notes ? `${item.notes}\n${trail}` : trail,
      });
      const trimmed = note.trim();
      if (trimmed) {
        // Best-effort — the count correction is the important bit; a failed
        // note shouldn't leave staff thinking nothing saved.
        await api.post('/interactions', {
          type: 'note',
          content: `📦 Nothing more coming — expected count corrected ${was} → ${here}.\n${trimmed}`,
          held_item_id: item.id,
        }).catch((e) => console.warn('Shortfall note failed:', e));
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setSaving(false);
    }
  }

  return (
    <div className="w-full border border-amber-200 bg-amber-50/60 rounded-lg p-3 space-y-2">
      <p className="text-xs text-amber-900">
        Only <strong>{here}</strong> of <strong>{was}</strong> turned up. Marking {here} as the full amount —
        the {was - here} outstanding stop showing as expected, and the {here} here still needs handing over.
      </p>
      <div>
        <label className="text-xs text-slate-500 block mb-0.5">Why? (optional — posts to this item's discussion)</label>
        <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="e.g. client shipped the rest direct to the venue"
          className="w-full border border-slate-300 rounded px-2 py-1 text-xs" />
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !!busy}
          className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs disabled:opacity-50">
          {saving ? 'Saving…' : 'Confirm'}
        </button>
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-600">Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, value, plain, className }: { label: string; value: string; plain?: boolean; className?: string }) {
  return <div><p className="text-xs text-slate-400">{label}</p><p className={`${plain ? 'text-slate-800' : 'text-slate-800 capitalize'} ${className || ''}`}>{value}</p></div>;
}

// Internal @mentionable discussion thread on a held item. Reuses the shared
// messaging primitives (same as IssueDetailPage). Mentions fire the standard
// mention notification (bell + email per the @-mentioned user's preference)
// with a deep-link back to this item. Distinct from "Notify client" — this is
// staff-to-staff, never reaches the client.
interface DiscussionRow { id: string; parent_interaction_id: string | null; created_at: string }
function HeldItemDiscussion({ heldItemId }: { heldItemId: string }) {
  const [rows, setRows] = useState<DiscussionRow[]>([]);
  const [comment, setComment] = useState('');
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const attach = useAttachments();

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: DiscussionRow[] }>(`/interactions?held_item_id=${heldItemId}&limit=100`);
      setRows(r.data);
    } catch { /* non-fatal — thread just stays empty */ }
  }, [heldItemId]);
  useEffect(() => { load(); }, [load]);

  async function post() {
    const trimmed = comment.trim();
    if (!trimmed && attach.pending.length === 0) return;  // allow attachment-only posts
    setPosting(true);
    try {
      await api.post('/interactions', {
        type: 'note',
        content: trimmed || '(attachment)',
        held_item_id: heldItemId,
        attachments: attach.payload(),
        mentioned_user_ids: mentionedIds,
      });
      setComment(''); setMentionedIds([]); attach.clear();
      load();
    } catch (e) { console.error('Held-item note failed:', e); }
    finally { setPosting(false); }
  }

  // Top-level comments only; each <ThreadView> fetches + renders its own replies.
  const topComments = rows
    .filter((r) => !r.parent_interaction_id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div className="pt-3 border-t">
      <h4 className="text-xs font-semibold text-slate-500 mb-2">Discussion</h4>
      <div className="space-y-2">
        {topComments.length === 0 && <p className="text-xs text-slate-400 italic">No notes yet. Add one below — @mention a colleague to ping them.</p>}
        {topComments.map((c) => (
          <div key={c.id} className="border border-slate-200 rounded-lg p-2 bg-slate-50/40">
            <ThreadView interactionId={c.id} onReplied={load} />
          </div>
        ))}
      </div>
      <div className="mt-3">
        <MentionComposer
          value={comment}
          onChange={setComment}
          mentionedIds={mentionedIds}
          onMentionedIdsChange={setMentionedIds}
          attach={attach}
          placeholder="Add a note… (type @ to mention, paste images to attach)"
          rows={2}
          disabled={posting}
          footer={
            <div className="flex justify-between items-center mt-2 gap-2">
              <label className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-700">
                📎 Attach file
                <input type="file" multiple className="hidden"
                  onChange={(e) => { if (e.target.files) attach.addFiles(e.target.files); e.target.value = ''; }} />
              </label>
              <button onClick={post}
                disabled={(!comment.trim() && attach.pending.length === 0) || posting || attach.hasInFlight}
                className="px-3 py-1.5 text-xs bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">
                {posting ? 'Posting…' : attach.hasInFlight ? 'Uploading…' : 'Post note'}
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
}

const dstr = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : null);

// Lost property: two timers (last contacted / next chase due) + defer control.
function ChaseCollectionSection({ item, onChange }: { item: HeldItem; onChange: () => void }) {
  const [date, setDate] = useState(item.expected_collection_date ? item.expected_collection_date.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  // Read the backend-computed chase fields so this card, the list and the daily
  // scanner all agree.
  const paused = item.chase_state === 'paused';
  const nextDue = item.next_chase_due
    ? (paused ? `Paused until ${dstr(item.next_chase_due)}` : (dstr(item.next_chase_due) || '—'))
    : '—';

  async function save(val: string | null) {
    setSaving(true);
    try { await api.put(`/holding/${item.id}`, { expected_collection_date: val }); onChange(); }
    finally { setSaving(false); }
  }

  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50/50">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><p className="text-slate-400">Last contacted</p><p className="text-slate-700">{dstr(item.last_chased_at) || 'Not yet'}</p></div>
        <div><p className="text-slate-400">Next chase due</p><p className={paused ? 'text-blue-600' : 'text-slate-700'}>{nextDue}</p></div>
        <div><p className="text-slate-400">Chases sent</p><p className="text-slate-700">{item.escalation_level || 0}</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
        <label className="text-xs text-slate-500">Expected collection date:</label>
        <input type="date" className="border border-slate-300 rounded px-2 py-1 text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
        <button disabled={saving || !date} onClick={() => save(date)} className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded disabled:opacity-40">Save (pause chases)</button>
        {item.expected_collection_date && <button disabled={saving} onClick={() => { setDate(''); save(null); }} className="text-xs text-slate-500">clear</button>}
      </div>
      <p className="text-[11px] text-slate-400">Set a date the client's said they'll collect — chases pause until it passes.</p>
    </div>
  );
}

// Temp storage: hold-until date (staff reminded 3 days before).
// Editable description + box counts — so a held item isn't locked to its
// first input. Description applies to all kinds; box counts only to deliveries
// / temp storage (lost property has no declared quantity).
function DetailsSection({ item, onChange }: { item: HeldItem; onChange: () => void }) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 space-y-2">
      <p className="text-xs font-semibold text-slate-500">Details</p>
      <InlineText label="Description" value={item.description} field="description" itemId={item.id} onChange={onChange} />
      {item.kind !== 'lost_property' && (
        <div className="grid grid-cols-2 gap-3">
          <InlineNumber label="Boxes expected" value={item.box_count} field="box_count" itemId={item.id} onChange={onChange} />
          <InlineNumber label="Received" value={item.received_count} field="received_count" itemId={item.id} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

// Inline text field — saves on blur, clears to null when emptied.
function InlineText({ label, value, field, itemId, onChange }: {
  label: string; value: string | null | undefined; field: 'description'; itemId: string; onChange: () => void;
}) {
  const [val, setVal] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(value ?? ''); }, [value]);
  async function save() {
    const next = val.trim();
    if (next === (value ?? '').trim()) return;
    setSaving(true);
    try { await api.put(`/holding/${itemId}`, { [field]: next || null }); onChange(); }
    finally { setSaving(false); }
  }
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-0.5">{label}</label>
      <input value={val} disabled={saving} onChange={(e) => setVal(e.target.value)} onBlur={save}
        className="border border-slate-300 rounded px-2 py-1 text-xs w-full" />
    </div>
  );
}

// Inline non-negative integer field — saves on blur, clears to null when emptied.
function InlineNumber({ label, value, field, itemId, onChange }: {
  label: string; value: number | null | undefined; field: 'box_count' | 'received_count'; itemId: string; onChange: () => void;
}) {
  const asStr = (v: number | null | undefined) => (v == null ? '' : String(v));
  const [val, setVal] = useState(asStr(value));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(asStr(value)); }, [value]);
  async function save() {
    const trimmed = val.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (Number.isNaN(next) || next < 0)) { setVal(asStr(value)); return; }
    if (asStr(next) === asStr(value)) return;
    setSaving(true);
    try { await api.put(`/holding/${itemId}`, { [field]: next }); onChange(); }
    finally { setSaving(false); }
  }
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-0.5">{label}</label>
      <input type="number" min="0" value={val} disabled={saving} onChange={(e) => setVal(e.target.value)} onBlur={save}
        className="border border-slate-300 rounded px-2 py-1 text-xs w-full" />
    </div>
  );
}

// Editable dates for delivery + temp-storage items. Lost property uses its own
// chase/collection dates instead. Backend PUT already accepts all of these.
// "Hold until / review" crosses delivery + temp storage — a parkable "deal with
// this by X" date that fires a staff reminder 3 days out (holding-reminders.ts).
function DatesSection({ item, onChange }: { item: HeldItem; onChange: () => void }) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 space-y-2">
      <p className="text-xs font-semibold text-slate-500">Dates</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {item.kind === 'incoming' && (
          <InlineDate label="Expected" value={item.expected_date} field="expected_date" itemId={item.id} onChange={onChange} />
        )}
        <InlineDate label="Needed by" value={item.needed_by} field="needed_by" itemId={item.id} onChange={onChange} />
        <InlineDate label="Hold until / review" value={item.hold_until} field="hold_until" itemId={item.id} onChange={onChange}
          hint="Reminds the team 3 days before." />
      </div>
    </div>
  );
}

// One inline date field — saves on pick (native date inputs fire onChange on a
// complete date). Clearing sends null.
function InlineDate({ label, value, field, itemId, onChange, hint }: {
  label: string;
  value: string | null | undefined;
  field: 'expected_date' | 'needed_by' | 'hold_until';
  itemId: string;
  onChange: () => void;
  hint?: string;
}) {
  const current = value ? value.slice(0, 10) : '';
  const [val, setVal] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(value ? value.slice(0, 10) : ''); }, [value]);

  async function save(next: string) {
    if (next === current) return;
    setSaving(true);
    try { await api.put(`/holding/${itemId}`, { [field]: next || null }); onChange(); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <label className="text-xs text-slate-400 block mb-0.5">{label}</label>
      <div className="flex items-center gap-1">
        <input type="date" value={val} disabled={saving}
          onChange={(e) => { setVal(e.target.value); save(e.target.value); }}
          className="border border-slate-300 rounded px-2 py-1 text-xs w-full" />
        {val && <button disabled={saving} onClick={() => { setVal(''); save(''); }} className="text-slate-400 hover:text-slate-600 text-xs px-1" title="Clear">×</button>}
      </div>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function LinkForm({ item, onDone }: { item: HeldItem; onDone: () => void }) {
  const [org, setOrg] = useState({ id: item.owner_organisation_id, name: item.owner_organisation_name || '' });
  const [person, setPerson] = useState({ id: item.owner_person_id, name: item.owner_person_name || '' });
  const [clientText, setClientText] = useState(item.client_name_text || '');
  const [hh, setHh] = useState(item.hh_job_number ? String(item.hh_job_number) : '');
  const [saving, setSaving] = useState(false);
  return (
    <div className="border border-slate-200 rounded-lg p-3 mt-2 space-y-2">
      <div className="flex items-end gap-1">
        <div className="flex-1"><EntitySearch kind="organisations" label="Client / band" value={org.name} onPick={(id, name) => setOrg({ id, name })} /></div>
        {(org.id || org.name) && <button type="button" onClick={() => setOrg({ id: null, name: '' })} className="text-xs text-slate-400 hover:text-slate-600 pb-2" title="Clear">✕</button>}
      </div>
      <div className="flex items-end gap-1">
        <div className="flex-1"><EntitySearch kind="people" label="Person" value={person.name} onPick={(id, name) => setPerson({ id, name })} /></div>
        {(person.id || person.name) && <button type="button" onClick={() => setPerson({ id: null, name: '' })} className="text-xs text-slate-400 hover:text-slate-600 pb-2" title="Clear">✕</button>}
      </div>
      <div><label className="block text-xs text-slate-500 mb-1">Or a name</label><input className={inputCls} value={clientText} onChange={(e) => setClientText(e.target.value)} /></div>
      <div><label className="block text-xs text-slate-500 mb-1">HireHop job # <span className="text-slate-400">(clear to unlink)</span></label><input className={inputCls} type="number" value={hh} onChange={(e) => setHh(e.target.value)} /></div>
      <div className="flex justify-end">
        <button disabled={saving} onClick={async () => {
          setSaving(true);
          try {
            await api.post(`/holding/${item.id}/link`, {
              edit: true,
              owner_organisation_id: org.id, owner_person_id: person.id,
              client_name_text: clientText.trim() || null, hh_job_number: hh ? Number(hh) : null,
            });
            onDone();
          } finally { setSaving(false); }
        }} className="text-xs bg-[#7B5EA7] text-white px-3 py-1.5 rounded-lg disabled:opacity-50">Save</button>
      </div>
    </div>
  );
}

function CollectButton({ id, kind, busy, open, onOpen, onClose, onAction }: { id: string; kind: HeldItemKind; busy: string; open?: boolean; onOpen?: () => void; onClose?: () => void; onAction: (l: string, fn: () => Promise<void>) => void }) {
  const [who, setWho] = useState('');
  const label = kind === 'incoming' ? '✅ Given to client' : '✅ Collected';
  if (!open) return <button disabled={!!busy} onClick={onOpen} className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs">{label}</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <input autoFocus className="border border-slate-300 rounded px-2 py-1 text-xs flex-1 min-w-[140px]" placeholder="Collected/received by (name)" value={who} onChange={(e) => setWho(e.target.value)} />
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button className="text-xs bg-green-600 text-white px-3 py-1 rounded" onClick={() => onAction('collected', async () => { await api.post(`/holding/${id}/collected`, { collected_by: who || null }); })}>Confirm</button>
    </div>
  );
}

function ShipBackButton({ id, busy, open, onOpen, onClose, onAction }: { id: string; busy: string; open?: boolean; onOpen?: () => void; onClose?: () => void; onAction: (l: string, fn: () => Promise<void>) => void }) {
  const [method, setMethod] = useState('');
  const [tracking, setTracking] = useState('');
  const [notify, setNotify] = useState(true);
  if (!open) return <button disabled={!!busy} onClick={onOpen} className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">📮 Ship back</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <input autoFocus className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Postage method" value={method} onChange={(e) => setMethod(e.target.value)} />
      <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
      <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> email client</label>
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button disabled={!method.trim()} className="text-xs bg-slate-700 text-white px-3 py-1 rounded disabled:opacity-40" onClick={() => onAction('ship', async () => { await api.post(`/holding/${id}/ship-back`, { return_method: method, tracking_number: tracking || null, notify }); })}>Confirm</button>
    </div>
  );
}

function LocationButton({ id, locations, current, open, onOpen, onClose, onDone }: { id: string; locations: HeldItemLocation[]; current: string | null; open?: boolean; onOpen?: () => void; onClose?: () => void; onDone: () => void }) {
  const [loc, setLoc] = useState(current || '');
  const [text, setText] = useState('');
  const somewhereElse = locations.find((l) => l.id === loc)?.name === 'Somewhere else';
  if (!open) return <button onClick={onOpen} className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-lg text-xs">📍 Move</button>;
  return (
    <div className="w-full border border-slate-200 rounded-lg p-2 flex flex-wrap items-center gap-2">
      <select className="border border-slate-300 rounded px-2 py-1 text-xs" value={loc} onChange={(e) => setLoc(e.target.value)}>
        <option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      {somewhereElse && <input className="border border-slate-300 rounded px-2 py-1 text-xs" placeholder="Where?" value={text} onChange={(e) => setText(e.target.value)} />}
      <button className="text-xs text-slate-500" onClick={onClose}>cancel</button>
      <button className="text-xs bg-[#7B5EA7] text-white px-3 py-1 rounded" onClick={async () => { await api.put(`/holding/${id}`, { storage_location_id: loc || null, storage_location_text: somewhereElse ? (text || null) : null }); onClose?.(); onDone(); }}>Save</button>
    </div>
  );
}
