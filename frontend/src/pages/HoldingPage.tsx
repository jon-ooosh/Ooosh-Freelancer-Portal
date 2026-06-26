import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { EntitySearch } from '../components/holding/EntitySearch';
import { NotifyClientModal } from '../components/holding/NotifyClientModal';
import { HeldItemForm } from '../components/holding/HeldItemForm';
import { locationLabelOrDash } from '../components/holding/format';
import { ChaseReviewPanel } from '../components/holding/ChaseReviewPanel';
import ThreadView from '../components/messaging/ThreadView';
import { MentionComposer } from '../components/messaging/MentionComposer';
import { useAttachments } from '../components/messaging/Attachments';
import type { HeldItem, HeldItemKind, HeldItemLocation } from '../../../shared/types';

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');
const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

type View = 'held' | 'lost_property';
const VIEW_KINDS: Record<View, HeldItemKind[]> = {
  held: ['incoming', 'temp_storage'],
  lost_property: ['lost_property'],
};

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
  incoming: 'Delivery', temp_storage: 'Temp storage', lost_property: 'Lost property',
};

// ── Lost-property list sorting + chase-due rendering ─────────────────────────
type SortKey = 'found_date' | 'last_chased_at' | 'escalation_level' | 'next_chase_due' | 'expected_collection_date';
function sortVal(h: HeldItem, key: SortKey): number | null {
  if (key === 'escalation_level') return h.escalation_level ?? 0;
  const v = h[key] as string | null | undefined;
  return v ? Date.parse(v) : null;
}
// Colour-coded next-chase cell — reads the backend-computed chase_state so the
// list agrees with the detail card and the daily chase scanner.
function NextChaseCell({ item }: { item: HeldItem }) {
  if (!item.next_chase_due || !item.chase_state || item.chase_state === 'none') return <span className="text-slate-300">—</span>;
  const d = fmtDate(item.next_chase_due);
  if (item.chase_state === 'due') return <span className="text-red-600 font-medium" title="Due a chase">{d}</span>;
  if (item.chase_state === 'paused') return <span className="text-blue-600" title="Paused — client gave a collection date">⏸ {d}</span>;
  return <span className="text-slate-600">{d}</span>;
}

// Inline photo thumbnail — authenticated blob fetch (download endpoint needs the JWT header)
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
export default function HoldingPage({ view }: { view: View }) {
  const [items, setItems] = useState<HeldItem[]>([]);
  const [locations, setLocations] = useState<HeldItemLocation[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Lost-property list defaults to "what needs chasing now" at the top.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'next_chase_due', dir: 'asc' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (showDone) qs.set('include_done', 'true');
      if (search.trim()) qs.set('search', search.trim());
      const r = await api.get<{ data: HeldItem[] }>(`/holding?${qs.toString()}`);
      setItems(r.data);
    } finally { setLoading(false); }
  }, [showDone, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ data: HeldItemLocation[] }>('/holding/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link: ?item=<id> (e.g. from a discussion @mention notification)
  // pre-opens that held item's detail modal. Clear it again on close so a
  // refresh doesn't keep re-opening.
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

  const kinds = VIEW_KINDS[view];
  const rows = items.filter((i) => kinds.includes(i.kind) && (!unknownOnly || i.owner_unknown));
  const openCount = items.filter((i) => kinds.includes(i.kind) && !['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled'].includes(i.status)).length;

  // Sorting is lost-property only (held keeps its needed-by server order). Nulls
  // always sink to the bottom regardless of direction.
  const sortedRows = view === 'lost_property'
    ? [...rows].sort((a, b) => {
        const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
        if (va === vb) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return sort.dir === 'asc' ? va - vb : vb - va;
      })
    : rows;

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <th onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }))}
      className="text-left px-3 py-2 cursor-pointer select-none hover:text-slate-700 whitespace-nowrap">
      {label}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold text-slate-800">{view === 'held' ? 'Held for Clients' : 'Lost Property'}</h1>
        <button onClick={() => setCreating(true)} className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium">
          {view === 'held' ? '+ Log Item' : '+ Log Lost Property'}
        </button>
      </div>

      {view === 'lost_property' && <ChaseReviewPanel defaultOpen={searchParams.get('review') === '1'} onChanged={load} />}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description / client / job # / notes…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={unknownOnly} onChange={(e) => setUnknownOnly(e.target.checked)} /> Unknown owner</label>
        <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
        <span className="text-xs text-slate-400">{openCount} open</span>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs"><tr>
            <th className="text-left px-3 py-2">Item</th>
            <th className="text-left px-3 py-2">Client</th>
            {view === 'held' ? (
              <>
                <th className="text-left px-3 py-2">Job</th>
                <th className="text-left px-3 py-2">Boxes</th>
                <th className="text-left px-3 py-2">Needed by</th>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">Status</th>
              </>
            ) : (
              <>
                <SortTh label="Found" k="found_date" />
                <SortTh label="Last contacted" k="last_chased_at" />
                <SortTh label="Chases" k="escalation_level" />
                <SortTh label="Next chase due" k="next_chase_due" />
                <SortTh label="Expected collection" k="expected_collection_date" />
                <th className="text-left px-3 py-2">Status</th>
              </>
            )}
          </tr></thead>
          <tbody>
            {sortedRows.map((h) => {
              const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
              const received = h.received_count != null && h.box_count != null ? `${h.received_count}/${h.box_count}` : (h.box_count != null ? String(h.box_count) : '—');
              return (
                <tr key={h.id} onClick={() => setDetailId(h.id)} className="border-t hover:bg-slate-50 cursor-pointer">
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {h.description || <span className="text-slate-400 italic">No description</span>}
                    {view === 'held' && <span className="ml-1 text-xs text-slate-400">· {KIND_LABEL[h.kind]}</span>}
                    {!!h.discussion_count && (
                      <span className="ml-1.5 text-xs text-slate-400" title={`${h.discussion_count} discussion note${h.discussion_count === 1 ? '' : 's'}`}>💬 {h.discussion_count}</span>
                    )}
                    {view === 'lost_property' && h.found_in && (
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
                  {view === 'held' ? (
                    <>
                      <td className="px-3 py-2">{h.hh_job_number ? `#${h.hh_job_number}` : '—'}</td>
                      <td className="px-3 py-2">{received}</td>
                      <td className="px-3 py-2">{fmtDate(h.needed_by)}</td>
                      <td className="px-3 py-2">{locationLabelOrDash(h)}</td>
                      <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span></td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.found_date)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{h.last_chased_at ? fmtDate(h.last_chased_at) : <span className="text-slate-400">Not yet</span>}</td>
                      <td className="px-3 py-2 text-center">{h.escalation_level || 0}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><NextChaseCell item={h} /></td>
                      <td className="px-3 py-2 whitespace-nowrap">{h.expected_collection_date ? fmtDate(h.expected_collection_date) : <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLOUR[h.status] || 'bg-slate-100'}`}>{statusLabel(h.status)}</span></td>
                    </>
                  )}
                </tr>
              );
            })}
            {sortedRows.length === 0 && <tr><td colSpan={view === 'held' ? 7 : 8} className="px-3 py-8 text-center text-slate-400">{loading ? 'Loading…' : 'Nothing here.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && <CreateModal view={view} locations={locations} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {detailId && <DetailModal id={detailId} locations={locations} onClose={closeDetail} onChange={load} />}
    </div>
  );
}

// ════════════════════════ CREATE ════════════════════════
// Thin wrapper around the shared HeldItemForm (also used by the mobile /quick
// launcher) so the desktop + mobile capture flows can never drift apart.
function CreateModal({ view, locations, onClose, onSaved }: { view: View; locations: HeldItemLocation[]; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal title={view === 'held' ? 'Log Held Item' : 'Log Lost Property'} onClose={onClose}>
      <HeldItemForm variant="desktop" kinds={VIEW_KINDS[view]} locations={locations} onDone={onSaved} onCancel={onClose} />
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
  const [openAction, setOpenAction] = useState<null | 'collect' | 'ship' | 'location'>(null);

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
          {h.kind !== 'lost_property' && <Field label="Boxes" value={h.received_count != null && h.box_count != null ? `${h.received_count}/${h.box_count}` : (h.box_count != null ? String(h.box_count) : '—')} />}
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
            {openAction === null && (
              <>
                {(h.status === 'expected' || h.status === 'arrived' || h.status === 'stored' || h.status === 'client_notified') && (
                  <button disabled={!!busy} onClick={() => setNotifyOpen(true)}
                    className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs">✉ Notify client</button>
                )}
                <CollectButton id={id} kind={h.kind} busy={busy} onOpen={() => setOpenAction('collect')} onAction={action} />
                <ShipBackButton id={id} busy={busy} onOpen={() => setOpenAction('ship')} onAction={action} />
                {h.kind === 'incoming' && h.status === 'expected' && (
                  <button disabled={!!busy} onClick={() => { if (confirm("Mark this as not arriving? It'll drop off the prep checklist.")) action('cancel', async () => { await api.put(`/holding/${id}`, { status: 'cancelled' }); onClose(); }); }}
                    className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 rounded-lg text-xs">✕ Won't arrive</button>
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

function Field({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-slate-400">{label}</p><p className="text-slate-800 capitalize">{value}</p></div>;
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
      <EntitySearch kind="organisations" label="Client / band" value={org.name} onPick={(id, name) => setOrg({ id, name })} />
      <EntitySearch kind="people" label="Person" value={person.name} onPick={(id, name) => setPerson({ id, name })} />
      <div><label className="block text-xs text-slate-500 mb-1">Or a name</label><input className={inputCls} value={clientText} onChange={(e) => setClientText(e.target.value)} /></div>
      <div><label className="block text-xs text-slate-500 mb-1">HireHop job #</label><input className={inputCls} type="number" value={hh} onChange={(e) => setHh(e.target.value)} /></div>
      <div className="flex justify-end">
        <button disabled={saving} onClick={async () => {
          setSaving(true);
          try {
            await api.post(`/holding/${item.id}/link`, {
              owner_organisation_id: org.id, owner_person_id: person.id,
              client_name_text: clientText || null, hh_job_number: hh ? Number(hh) : null,
            });
            onDone();
          } finally { setSaving(false); }
        }} className="text-xs bg-[#7B5EA7] text-white px-3 py-1.5 rounded-lg disabled:opacity-50">Save link</button>
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
