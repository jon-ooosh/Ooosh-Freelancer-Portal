import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthedFileUrl } from '../hooks/useAuthedFileUrl';
import { EntitySearch } from '../components/holding/EntitySearch';
import { JobNumberField, type JobMatch } from '../components/holding/JobNumberField';
import { NotifyClientModal } from '../components/holding/NotifyClientModal';
import { HeldItemForm } from '../components/holding/HeldItemForm';
import { HeldItemPicker, HandoverFlow } from '../components/holding/HeldItemPicker';
import { describeHeldCounts, heldCountClass, isPartiallyArrived } from '../components/holding/counts';
import { locationLabel, locationLabelOrDash } from '../components/holding/format';
import { ChaseReviewPanel } from '../components/holding/ChaseReviewPanel';
import ThreadView from '../components/messaging/ThreadView';
import { MentionComposer } from '../components/messaging/MentionComposer';
import { useAttachments } from '../components/messaging/Attachments';
import type { HeldItem, HeldItemKind, HeldItemLocation, HeldItemNextAction } from '../../../shared/types';
import { openR2Key } from '../lib/openAuthedFile';

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
// Derived server-side (services/held-item-query.ts) so the strip, the table and
// the dashboard all read ONE definition of "what does this need".
// Strip order is WORKFLOW order (commonest first), deliberately NOT the
// server-side precedence order in services/held-item-query.ts — that decides
// which single action a row gets; this decides how the buckets read
// left-to-right. Changing one does not imply changing the other.
const ACTION_BUCKETS: { id: HeldItemNextAction; label: string; emoji: string; accent: string }[] = [
  { id: 'hand_over',   label: 'To hand over',   emoji: '📦', accent: 'border-blue-300 bg-blue-50 text-blue-900' },
  { id: 'receive',     label: 'Awaiting arrival', emoji: '⏳', accent: 'border-slate-300 bg-slate-50 text-slate-800' },
  { id: 'chase_owner', label: 'Chase owner',    emoji: '📨', accent: 'border-purple-300 bg-purple-50 text-purple-900' },
  { id: 'link_owner',  label: 'Needs linking',  emoji: '❓', accent: 'border-amber-300 bg-amber-50 text-amber-900' },
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
// overrides it. Every column is sortable — text keys compare with localeCompare,
// dates/numbers numerically, and a null ALWAYS sinks to the bottom regardless of
// direction (an item with no date isn't "the earliest").
type SortKey =
  | 'description' | 'client' | 'hh_job_number' | 'boxes' | 'location' | 'status'
  | 'action_due' | 'found_date' | 'last_chased_at' | 'escalation_level'
  | 'next_chase_due' | 'expected_collection_date';

function sortVal(h: HeldItem, key: SortKey): string | number | null {
  switch (key) {
    case 'description': return h.description?.trim() || null;
    case 'client': return (h.owner_person_name || h.owner_organisation_name || h.client_name_text)?.trim() || null;
    case 'hh_job_number': return h.hh_job_number ?? null;
    // Sort Boxes by what was DECLARED, not by the "3 of 5" display string —
    // a predictable numeric order beats an alphabetical one over rendered text.
    case 'boxes': return h.box_count ?? null;
    case 'location': return locationLabel(h) || null;
    case 'status': return h.status || null;
    case 'escalation_level': return h.escalation_level ?? 0;
    default: {
      const v = h[key] as string | null | undefined;
      return v ? Date.parse(v) : null;
    }
  }
}

function compareSortVals(a: string | number, b: string | number): number {
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a).localeCompare(String(b), 'en-GB', { sensitivity: 'base', numeric: true });
  }
  return a - b;
}
function PhotoThumb({ photoKey, onOpen }: { photoKey: string; onOpen: () => void }) {
  // Held-item photos are full-size phone shots. Closing the modal before one
  // landed used to leave the fetch running and then leak its object URL — the
  // revoke ran while the local was still empty.
  const { ref, url: src } = useAuthedFileUrl(photoKey);
  return src
    ? <img ref={ref} src={src} onClick={onOpen} className="w-20 h-20 object-cover rounded-lg border border-slate-200 cursor-pointer hover:opacity-90" alt="" />
    : <div ref={ref} className="w-20 h-20 rounded-lg bg-slate-100 animate-pulse" />;
}
const FOUND_IN_LABEL: Record<string, string> = {
  van: 'Van', rehearsal: 'Rehearsal room', backline: 'Backline', elsewhere: 'Somewhere else',
};

function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-slate-800 flex-1 min-w-0 mr-3">{title}</h3>
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
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        const d = compareSortVals(va, vb);
        return sort.dir === 'asc' ? d : -d;
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
          <p className="text-sm text-slate-500">Things we're holding that aren't ours.</p>
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
            <SortTh label="Item" k="description" />
            <SortTh label="Client" k="client" />
            {showChaseCols ? (
              <>
                <SortTh label="Found" k="found_date" />
                <SortTh label="Last contacted" k="last_chased_at" />
                <SortTh label="Chases" k="escalation_level" />
                <SortTh label="Expected collection" k="expected_collection_date" />
              </>
            ) : (
              <>
                <SortTh label="Job" k="hh_job_number" />
                <SortTh label="Boxes" k="boxes" />
                <SortTh label="Location" k="location" />
              </>
            )}
            <SortTh label="Next action" k="action_due" />
            <SortTh label="Status" k="status" />
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
// One window per item, read like a record card (Oct 2026 tidy-up). It used to
// edit five different ways — the title and box counts saved on blur, the dates
// saved on pick, the owner/job opened a form at the bottom of the window and
// the location hid behind a "Move" button — and several of those failed
// silently (the owner/job one 500'd for twelve days unnoticed). Now each card
// reads cleanly and has one Edit → Save / Cancel, and a failed save says so on
// the card. Actions: ONE main button for the next step, the everyday ones
// beside it, the rare and destructive ones under "More".

// Bigger text and hit targets than the list's xs styling, which read as spindly.
const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#7B5EA7] hover:opacity-90 disabled:opacity-50';
const btnSecondary = 'px-4 py-2 rounded-lg text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const btnDanger = 'px-4 py-2 rounded-lg text-sm font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50';
const btnLink = 'text-sm font-medium text-[#7B5EA7] hover:underline disabled:opacity-50';
const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

// Lost-property chase tiers — the same words as ChaseReviewPanel.
const chaseTierLabel = (lvl: number) => (lvl <= 0 ? '1st chase' : lvl === 1 ? '2nd chase' : 'final notice');

type DetailMsg = { text: string; ok: boolean } | null;

function DetailModal({ id, locations, onClose, onChange }: { id: string; locations: HeldItemLocation[]; onClose: () => void; onChange: () => void }) {
  const navigate = useNavigate();
  const [h, setH] = useState<HeldItem | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<DetailMsg>(null);
  // Lifted out of the card so the "Link owner" main button can open it.
  const [whoEditing, setWhoEditing] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [openAction, setOpenAction] = useState<null | 'collect' | 'ship' | 'shortfall'>(null);

  const load = useCallback(async () => { setH((await api.get<{ data: HeldItem }>(`/holding/${id}`)).data); }, [id]);
  useEffect(() => { load(); }, [load]);
  const refresh = useCallback(() => { load(); onChange(); }, [load, onChange]);

  async function action(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg(null);
    try { await fn(); await load(); onChange(); } catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Failed', ok: false }); } finally { setBusy(''); }
  }
  if (!h) return <Modal title="Held item" onClose={onClose}><p className="text-slate-400">Loading…</p></Modal>;

  const isOpen = !['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'].includes(h.status);
  const isLost = h.kind === 'lost_property';
  const collectLabel = isLost ? '✅ Collected' : '✅ Given to client';
  // The one main button — what the item's next action asks for. An unknown
  // owner comes first, as it does in the server's next_action precedence.
  const primary: 'link' | 'book_in' | 'collect' =
    h.owner_unknown ? 'link' : (!isLost && h.status === 'expected') ? 'book_in' : 'collect';
  const canNotify = ['expected', 'arrived', 'stored', 'client_notified'].includes(h.status);
  // Two different outcomes for a delivery that isn't complete:
  //  - nothing turned up at all  → cancel the record outright ("Won't arrive")
  //  - some turned up, rest isn't coming → CORRECT the expected count so the
  //    shortfall stops reading as outstanding ("Nothing more coming"). That's
  //    an update, not a cancellation: what's here is still ours to hand over.
  //    Previously only the first existed, and only while the item was still
  //    `expected` — so a part-arrived delivery had no way to be closed off at all.
  const canWontArrive = h.kind === 'incoming' && !h.received_count && h.status === 'expected';
  const canShortfall = !isLost && isPartiallyArrived(h);

  async function viewPhoto(key: string) {
    try {
      await openR2Key(key);
    } catch { setMsg({ text: 'Could not open photo.', ok: false }); }
  }

  // This EMAILS the client (the tier's template) — it was labelled "Log chase"
  // with no confirmation, which undersold what one click did.
  function sendChase() {
    if (!h) return;
    const tier = chaseTierLabel(h.escalation_level);
    if (!confirm(`Email the client the ${tier} now?`)) return;
    action('chase', async () => {
      const r = await api.post<{ notified_to: string }>(`/holding/${id}/chase`, {});
      setMsg({ text: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} sent to ${r.notified_to}.`, ok: true });
    });
  }

  return (
    <Modal
      title={isOpen
        ? <EditableTitle item={h} onChange={refresh} onError={(text) => setMsg({ text, ok: false })} />
        : (h.description || KIND_LABEL[h.kind])}
      onClose={onClose}
    >
      <div className="space-y-4 text-sm">
        {/* Where it stands: status, kind, and what it needs next. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={`px-2.5 py-1 rounded-md text-xs font-semibold capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span>
          <span className="text-slate-500">{KIND_EMOJI[h.kind]} {KIND_LABEL[h.kind]}</span>
          {isOpen && h.next_action && h.next_action !== 'none' && (
            <span className="text-slate-500">Next: <ActionDueCell item={h} /></span>
          )}
        </div>

        <WhoCard item={h} editing={whoEditing}
          onEdit={() => setWhoEditing(true)} onCancel={() => setWhoEditing(false)}
          onSaved={() => { setWhoEditing(false); refresh(); }} />

        {isLost
          ? <FoundCard item={h} locations={locations} isOpen={isOpen} onSaved={refresh} />
          : <DeliveryCard item={h} locations={locations} isOpen={isOpen} onSaved={refresh} />}

        {h.notes && (
          <div>
            <p className={labelCls}>Notes</p>
            <p className="text-slate-700 whitespace-pre-line">{h.notes}</p>
          </div>
        )}

        {/* Photos — inline thumbnails */}
        {(h.photos || []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {h.photos.map((p, idx) => <PhotoThumb key={idx} photoKey={p.url} onOpen={() => viewPhoto(p.url)} />)}
          </div>
        )}

        {msg && <p className={msg.ok ? 'text-green-700' : 'text-red-600'}>{msg.text}</p>}

        {/* Actions — when one inline action is open, the rest hide so the
            "next step" isn't surrounded by unrelated buttons. */}
        {isOpen && (
          <div className="pt-4 border-t space-y-3">
            {openAction === 'collect' && <CollectForm id={id} kind={h.kind} busy={busy} onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'ship' && <ShipBackForm id={id} busy={busy} onClose={() => setOpenAction(null)} onAction={action} />}
            {openAction === 'shortfall' && (
              <ShortfallForm item={h} busy={busy} onClose={() => setOpenAction(null)}
                onDone={() => { setOpenAction(null); setMsg({ text: 'Expected count corrected.', ok: true }); load(); onChange(); }} />
            )}
            {openAction === null && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {primary === 'link' && (
                    <button className={btnPrimary} onClick={() => setWhoEditing(true)}>🔗 Link owner</button>
                  )}
                  {primary === 'book_in' && (
                    <button className={btnPrimary} onClick={() => navigate(`/holding/receipt/${h.id}`)}
                      title="Count the boxes, add a photo and say where they are">📦 Book it in</button>
                  )}
                  <button disabled={!!busy} onClick={() => setOpenAction('collect')}
                    className={primary === 'collect' ? btnPrimary : btnSecondary}>{collectLabel}</button>
                  {canNotify && (
                    <button disabled={!!busy} onClick={() => setNotifyOpen(true)} className={btnSecondary}>✉ Notify client</button>
                  )}
                  <button disabled={!!busy} onClick={() => setOpenAction('ship')} className={btnSecondary}>📮 Ship back</button>
                  {isLost && (
                    <button disabled={!!busy} onClick={sendChase} className={btnSecondary}>📨 Send {chaseTierLabel(h.escalation_level)}</button>
                  )}
                  <button onClick={() => setMoreOpen((o) => !o)} className={`${btnLink} ml-auto px-1`}>More {moreOpen ? '▴' : '▾'}</button>
                </div>
                {moreOpen && (
                  <div className="flex flex-wrap gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
                    {canShortfall && (
                      <button disabled={!!busy} onClick={() => setOpenAction('shortfall')} className={btnSecondary}>📦 Nothing more coming</button>
                    )}
                    {canWontArrive && (
                      <button disabled={!!busy} onClick={() => { if (confirm("Mark this as not arriving? It'll drop off the prep checklist.")) action('cancel', async () => { await api.put(`/holding/${id}`, { status: 'cancelled' }); onClose(); }); }}
                        className={btnSecondary}>✕ Won't arrive</button>
                    )}
                    <button disabled={!!busy} onClick={() => { if (confirm('Mark as disposed?')) action('dispose', async () => { await api.post(`/holding/${id}/dispose`, {}); onClose(); }); }}
                      className={btnDanger}>🗑 Dispose</button>
                  </div>
                )}
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
          onSent={(n) => { setNotifyOpen(false); setMsg({ text: n > 0 ? `Sent to ${n} recipient${n === 1 ? '' : 's'}.` : 'Marked notified.', ok: true }); load(); onChange(); }} />
      )}
    </Modal>
  );
}

/** A titled section of the item window, with its Edit link top-right. */
function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One label + value pair inside a card. */
function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <div className="text-slate-800 mt-0.5">{children}</div>
    </div>
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
    <div className="w-full border border-amber-200 bg-amber-50/60 rounded-lg p-3 space-y-3">
      <p className="text-sm text-amber-900">
        Only <strong>{here}</strong> of <strong>{was}</strong> turned up. Marking {here} as the full amount —
        the {was - here} outstanding stop showing as expected, and the {here} here still needs handing over.
      </p>
      <div>
        <label className={labelCls}>Why? (optional — posts to this item's discussion)</label>
        <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="e.g. client shipped the rest direct to the venue"
          className={inputCls} />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSecondary}>Cancel</button>
        <button onClick={submit} disabled={saving || !!busy}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
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
      <h4 className="text-sm font-semibold text-slate-700 mb-2">Discussion</h4>
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

/**
 * Who & which job. The job number comes first: enter it and the backend links
 * the job and — when no client is given — takes the job's client too
 * (resolveJobContext in routes/holding.ts). Editable on a FINISHED item as
 * well: a box handed over while on a mistyped job number must still be
 * movable to the right job (job 16648 → 16649, Oct 2026).
 */
function WhoCard({ item, editing, onEdit, onCancel, onSaved }: {
  item: HeldItem; editing: boolean; onEdit: () => void; onCancel: () => void; onSaved: () => void;
}) {
  const client = item.owner_person_name || item.owner_organisation_name || item.client_name_text;
  // A person AND their band/company: show both rather than silently drop one.
  const alsoOrg = item.owner_person_name && item.owner_organisation_name ? item.owner_organisation_name : null;
  return (
    <Card title="Who & which job"
      action={!editing && <button onClick={onEdit} className={btnLink}>{client || item.hh_job_number ? 'Edit' : '🔗 Link'}</button>}>
      {editing ? <WhoForm item={item} onCancel={onCancel} onSaved={onSaved} /> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Info label="Client">
            {client
              ? <>{client}{alsoOrg && <span className="text-slate-500"> · {alsoOrg}</span>}</>
              : (item.owner_unknown ? <span className="text-amber-700">❓ Unknown</span> : '—')}
          </Info>
          <Info label="Job">
            {item.hh_job_number
              ? (item.job_id
                  ? <Link to={`/jobs/${item.job_id}`} title="Opens the job in the operations portal" className="text-ooosh-600 hover:underline">
                      #{item.hh_job_number}{item.job_name ? ` · ${item.job_name}` : ''} →
                    </Link>
                  : <>#{item.hh_job_number} <span className="text-xs text-slate-500">(not linked in OP)</span></>)
              : '—'}
          </Info>
        </div>
      )}
    </Card>
  );
}

/**
 * The owner can be an organisation, a person, a typed name, or a mix. The form
 * shows only the boxes in use (or the organisation search when there's none)
 * and offers the rest as links — it used to show all three at once with no
 * hint which one counted.
 */
function WhoForm({ item, onCancel, onSaved }: { item: HeldItem; onCancel: () => void; onSaved: () => void }) {
  const [hh, setHh] = useState(item.hh_job_number ? String(item.hh_job_number) : '');
  const [job, setJob] = useState<JobMatch | null>(null);
  const [org, setOrg] = useState({ id: item.owner_organisation_id, name: item.owner_organisation_name || '' });
  const [person, setPerson] = useState({ id: item.owner_person_id, name: item.owner_person_name || '' });
  const [text, setText] = useState(item.client_name_text || '');
  const [show, setShow] = useState(() => {
    const any = !!(item.owner_organisation_id || item.owner_person_id || item.client_name_text);
    return { org: !!item.owner_organisation_id || !any, person: !!item.owner_person_id, text: !!item.client_name_text };
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const hasOwner = !!(org.id || person.id || text.trim());
  const current = (person.name || org.name || text).trim().toLowerCase();
  const jobClient = job?.client_name?.trim() || '';
  // An owner already filled in WINS over the job's client on save, so a new
  // job number alone doesn't change the client — say so, and offer the swap.
  const offerJobClient = !!jobClient && hasOwner && jobClient.toLowerCase() !== current;

  function takeJobClient() {
    setOrg({ id: null, name: '' }); setPerson({ id: null, name: '' }); setText('');
    setShow({ org: true, person: false, text: false });
  }

  async function save() {
    setSaving(true); setErr('');
    try {
      await api.post(`/holding/${item.id}/link`, {
        edit: true,
        owner_organisation_id: org.id, owner_person_id: person.id,
        client_name_text: text.trim() || null,
        hh_job_number: hh.trim() ? Number(hh) : null,
      });
      onSaved();
    } catch (e) {
      setErr(`Couldn't save — ${e instanceof Error ? e.message : 'please try again'}.`);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <JobNumberField value={hh} onChange={setHh} onResolved={setJob} foundSuffix=""
        idleHint="Leave it empty if there's no job." />
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700">Client</p>
        {show.org && <EntitySearch kind="organisations" label="Band / company" value={org.name} onPick={(pid, name) => setOrg({ id: pid, name })} />}
        {show.person && <EntitySearch kind="people" label="Person" value={person.name} onPick={(pid, name) => setPerson({ id: pid, name })} />}
        {show.text && (
          <div>
            <label className={labelCls}>Name, if they're not in the address book</label>
            <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {!show.org && <button type="button" className={btnLink} onClick={() => setShow((s) => ({ ...s, org: true }))}>+ Band / company</button>}
          {!show.person && <button type="button" className={btnLink} onClick={() => setShow((s) => ({ ...s, person: true }))}>+ Person</button>}
          {!show.text && <button type="button" className={btnLink} onClick={() => setShow((s) => ({ ...s, text: true }))}>+ Just type a name</button>}
          {offerJobClient && <button type="button" className={btnLink} onClick={takeJobClient}>Use the job's client ({jobClient})</button>}
        </div>
        {!hasOwner && (
          <p className="text-xs text-slate-500">
            {jobClient ? `No client given — it'll take the job's: ${jobClient}.` : "No client given — it'll show as ❓ Unknown."}
          </p>
        )}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={saving} className={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/** What happened to a finished item — who took it, how it went back, when it was binned. */
function OutcomeInfo({ item }: { item: HeldItem }) {
  return (
    <>
      {item.collected_at && (
        <Info label={item.kind === 'lost_property' ? 'Collected' : 'Handed over'}>
          {fmtDate(item.collected_at)}{item.collected_by ? ` by ${item.collected_by}` : ''}
        </Info>
      )}
      {item.return_method && <Info label="Shipped back">{item.return_method}{item.tracking_number ? ` · ${item.tracking_number}` : ''}</Info>}
      {item.disposed_at && <Info label="Disposed">{fmtDate(item.disposed_at)}</Info>}
    </>
  );
}

/**
 * The delivery: how many boxes, the dates and where it's sitting. Counts read
 * through describeHeldCounts (the one count vocabulary). The description is
 * NOT here — it's the window's editable title, because a "Details > Description"
 * block repeating the title verbatim was pure duplication.
 */
function DeliveryCard({ item, locations, isOpen, onSaved }: {
  item: HeldItem; locations: HeldItemLocation[]; isOpen: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const counts = describeHeldCounts(item);
  return (
    <Card title="Delivery"
      action={isOpen && !editing && <button onClick={() => setEditing(true)} className={btnLink}>Edit</button>}>
      {editing
        ? <DeliveryForm item={item} locations={locations} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />
        : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
            <Info label="Boxes">{counts ? <span className={`font-medium ${heldCountClass(counts.tone)}`}>{counts.text}</span> : '—'}</Info>
            {/* Empty fields that can't apply yet stay off the card — an "Expected —"
                on a box that simply turned up, a "Location —" on one still on its way. */}
            {item.kind === 'incoming' && (item.expected_date || item.status === 'expected') &&
              <Info label="Expected">{fmtDate(item.expected_date)}</Info>}
            <Info label="Needed by">{fmtDate(item.needed_by)}</Info>
            {item.hold_until && <Info label="Hold until / review">{fmtDate(item.hold_until)}</Info>}
            {(item.status !== 'expected' || locationLabel(item)) && <Info label="Location">{locationLabelOrDash(item)}</Info>}
            {item.status !== 'expected' && item.arrived_at && (
              <Info label="Arrived">{fmtDate(item.arrived_at)}{item.received_by_name ? ` by ${item.received_by_name}` : ''}</Info>
            )}
            {item.import_charge_flag && <Info label="Import charge"><span className="capitalize">{item.import_charge_flag}</span></Info>}
            <OutcomeInfo item={item} />
          </div>
        )}
    </Card>
  );
}

function DeliveryForm({ item, locations, onCancel, onSaved }: {
  item: HeldItem; locations: HeldItemLocation[]; onCancel: () => void; onSaved: () => void;
}) {
  const dateStr = (v: string | null) => (v ? v.slice(0, 10) : '');
  const numStr = (v: number | null) => (v == null ? '' : String(v));
  const [f, setF] = useState({
    box_count: numStr(item.box_count), received_count: numStr(item.received_count),
    expected_date: dateStr(item.expected_date), needed_by: dateStr(item.needed_by), hold_until: dateStr(item.hold_until),
  });
  const [loc, setLoc] = useState({ id: item.storage_location_id || '', text: item.storage_location_text || '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    // Only what changed goes up.
    const patch: Record<string, unknown> = {};
    for (const k of ['box_count', 'received_count'] as const) {
      const raw = f[k].trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== null && (!Number.isInteger(next) || next < 0)) { setErr('Box counts must be whole numbers.'); return; }
      if (next !== item[k]) patch[k] = next;
    }
    for (const k of ['expected_date', 'needed_by', 'hold_until'] as const) {
      if (f[k] !== dateStr(item[k])) patch[k] = f[k] || null;
    }
    Object.assign(patch, locationPatch(item, loc, locations));
    // Boxes typed in on an EXPECTED delivery means it's arrived — book it in
    // (the PUT stamps when and who), as the receipt page does. Otherwise the
    // count changed but the item still read "Awaiting arrival".
    if (item.status === 'expected' && typeof patch.received_count === 'number' && patch.received_count > 0) {
      patch.status = 'stored';
    }
    if (Object.keys(patch).length === 0) { onCancel(); return; }
    setSaving(true); setErr('');
    try {
      await api.put(`/holding/${item.id}`, patch);
      onSaved();
    } catch (e) {
      setErr(`Couldn't save — ${e instanceof Error ? e.message : 'please try again'}.`);
      setSaving(false);
    }
  }

  const num = (k: 'box_count' | 'received_count', label: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input type="number" min="0" className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );
  const date = (k: 'expected_date' | 'needed_by' | 'hold_until', label: string, hint?: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input type="date" className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {num('box_count', 'Boxes expected')}
        {num('received_count', 'Boxes here')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {item.kind === 'incoming' && date('expected_date', 'Expected')}
        {date('needed_by', 'Needed by')}
        {/* A parkable "deal with this by X" date — holding-reminders.ts nudges the team 3 days out. */}
        {date('hold_until', 'Hold until / review', 'Reminds the team 3 days before.')}
      </div>
      <LocationFields item={item} locations={locations} value={loc} onChange={setLoc} />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={saving} className={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/**
 * Lost property: where it was found, where it is now, and the chase clock. The
 * chase figures are the backend's (next_chase_due / chase_state) so this card,
 * the list and the daily scanner all agree.
 */
function FoundCard({ item, locations, isOpen, onSaved }: {
  item: HeldItem; locations: HeldItemLocation[]; isOpen: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const paused = item.chase_state === 'paused';
  const where = item.found_vehicle_reg || item.found_location_text;
  return (
    <Card title="Found & chasing"
      action={isOpen && !editing && <button onClick={() => setEditing(true)} className={btnLink}>Edit</button>}>
      {editing
        ? <FoundForm item={item} locations={locations} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />
        : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
            <Info label="Found in">{item.found_in ? `${FOUND_IN_LABEL[item.found_in]}${where ? ` (${where})` : ''}` : '—'}</Info>
            <Info label="Found on">{fmtDate(item.found_date)}</Info>
            <Info label="Location">{locationLabelOrDash(item)}</Info>
            {isOpen && (
              <>
                <Info label="Last contacted">{item.last_chased_at ? fmtDate(item.last_chased_at) : 'Not yet'}</Info>
                <Info label="Next chase">
                  {item.next_chase_due
                    ? <span className={paused ? 'text-blue-600' : ''}>{paused ? `Paused until ${fmtDate(item.next_chase_due)}` : fmtDate(item.next_chase_due)}</span>
                    : '—'}
                </Info>
                <Info label="Chases sent">{item.escalation_level || 0}</Info>
              </>
            )}
            {item.expected_collection_date && <Info label="Client collecting on">{fmtDate(item.expected_collection_date)}</Info>}
            <OutcomeInfo item={item} />
          </div>
        )}
    </Card>
  );
}

function FoundForm({ item, locations, onCancel, onSaved }: {
  item: HeldItem; locations: HeldItemLocation[]; onCancel: () => void; onSaved: () => void;
}) {
  const original = item.expected_collection_date ? item.expected_collection_date.slice(0, 10) : '';
  const [loc, setLoc] = useState({ id: item.storage_location_id || '', text: item.storage_location_text || '' });
  const [collect, setCollect] = useState(original);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    const patch: Record<string, unknown> = locationPatch(item, loc, locations);
    if (collect !== original) patch.expected_collection_date = collect || null;
    if (Object.keys(patch).length === 0) { onCancel(); return; }
    setSaving(true); setErr('');
    try {
      await api.put(`/holding/${item.id}`, patch);
      onSaved();
    } catch (e) {
      setErr(`Couldn't save — ${e instanceof Error ? e.message : 'please try again'}.`);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <LocationFields item={item} locations={locations} value={loc} onChange={setLoc} />
      <div className="sm:w-1/2">
        <label className={labelCls}>Client collecting on</label>
        <input type="date" className={inputCls} value={collect} onChange={(e) => setCollect(e.target.value)} />
        <p className="text-xs text-slate-500 mt-1">The date they've said they'll come — chases pause until it passes.</p>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={saving} className={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/**
 * Where it's kept, for the edit forms. The item's current location stays in
 * the list even if it has since been retired from the picklist — a <select>
 * whose value matches no option renders blank, and would save that blank over
 * the real location.
 */
function LocationFields({ item, locations, value, onChange }: {
  item: HeldItem; locations: HeldItemLocation[];
  value: { id: string; text: string }; onChange: (v: { id: string; text: string }) => void;
}) {
  const known = locations.some((l) => l.id === value.id);
  const somewhereElse = locations.find((l) => l.id === value.id)?.name === 'Somewhere else';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={labelCls}>Location</label>
        <select className={inputCls} value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })}>
          <option value="">—</option>
          {value.id && !known && <option value={value.id}>{item.storage_location_name || 'Current location'}</option>}
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {somewhereElse && (
        <div>
          <label className={labelCls}>Where?</label>
          <input className={inputCls} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/** The location fields that changed, ready for PUT /holding/:id (empty when nothing did). */
function locationPatch(item: HeldItem, loc: { id: string; text: string }, locations: HeldItemLocation[]): Record<string, unknown> {
  const nextId = loc.id || null;
  const somewhereElse = locations.find((l) => l.id === loc.id)?.name === 'Somewhere else';
  const nextText = loc.text.trim() || null;
  if (nextId !== (item.storage_location_id || null)) {
    return { storage_location_id: nextId, storage_location_text: somewhereElse ? nextText : null };
  }
  if (somewhereElse && nextText !== (item.storage_location_text || null)) {
    return { storage_location_text: nextText };
  }
  return {};
}

/**
 * The modal heading, editable in place — the item's description IS its title,
 * so there's no reason to show it twice. Borderless until you hover or focus it,
 * so it still reads as a heading rather than a form field. Saves on blur; an
 * empty value clears to null and falls back to the kind as a placeholder.
 * A failed save puts the old title back and says so in the window.
 */
function EditableTitle({ item, onChange, onError }: { item: HeldItem; onChange: () => void; onError: (msg: string) => void }) {
  const [val, setVal] = useState(item.description ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(item.description ?? ''); }, [item.description]);
  async function save() {
    const next = val.trim();
    if (next === (item.description ?? '').trim()) return;
    setSaving(true);
    try { await api.put(`/holding/${item.id}`, { description: next || null }); onChange(); }
    catch (e) {
      setVal(item.description ?? '');
      onError(`Couldn't rename — ${e instanceof Error ? e.message : 'please try again'}.`);
    }
    finally { setSaving(false); }
  }
  return (
    <input
      value={val}
      disabled={saving}
      placeholder={KIND_LABEL[item.kind]}
      title="Click to rename"
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-full font-semibold text-slate-800 bg-transparent rounded px-1 -mx-1 py-0.5
                 border border-transparent hover:border-slate-200 hover:bg-slate-50
                 focus:border-slate-300 focus:bg-white focus:outline-none disabled:opacity-60"
    />
  );
}

/** Handed over / collected — who took it. */
function CollectForm({ id, kind, busy, onClose, onAction }: {
  id: string; kind: HeldItemKind; busy: string; onClose: () => void; onAction: (l: string, fn: () => Promise<void>) => void;
}) {
  const [who, setWho] = useState('');
  return (
    <div className="w-full border border-slate-200 rounded-lg p-3 flex flex-wrap items-center gap-2">
      <input autoFocus className="flex-1 min-w-[180px] border border-slate-300 rounded-lg px-3 py-2 text-sm"
        placeholder={kind === 'lost_property' ? 'Collected by (name)' : 'Given to (name)'}
        value={who} onChange={(e) => setWho(e.target.value)} />
      <button onClick={onClose} className={btnSecondary}>Cancel</button>
      <button disabled={!!busy} className={btnPrimary}
        onClick={() => onAction('collected', async () => { await api.post(`/holding/${id}/collected`, { collected_by: who || null }); })}>Confirm</button>
    </div>
  );
}

/** Posted back — method, tracking, and whether the client gets the tracking by email. */
function ShipBackForm({ id, busy, onClose, onAction }: {
  id: string; busy: string; onClose: () => void; onAction: (l: string, fn: () => Promise<void>) => void;
}) {
  const [method, setMethod] = useState('');
  const [tracking, setTracking] = useState('');
  const [notify, setNotify] = useState(true);
  return (
    <div className="w-full border border-slate-200 rounded-lg p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Postage method</label>
          <input autoFocus className={inputCls} placeholder="e.g. Royal Mail Tracked 48" value={method} onChange={(e) => setMethod(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Tracking #</label>
          <input className={inputCls} value={tracking} onChange={(e) => setTracking(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-700 mr-auto">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the tracking to the client
        </label>
        <button onClick={onClose} className={btnSecondary}>Cancel</button>
        <button disabled={!method.trim() || !!busy} className={btnPrimary}
          onClick={() => onAction('ship', async () => { await api.post(`/holding/${id}/ship-back`, { return_method: method, tracking_number: tracking || null, notify }); })}>Confirm</button>
      </div>
    </div>
  );
}
