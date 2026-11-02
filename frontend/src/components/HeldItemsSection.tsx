/**
 * Held-items section, reusable across detail pages.
 *
 * Reads from /api/holding/by-{person|org|job}/:id — surfaces what we're
 * temporarily holding for this entity (incoming deliveries, temp storage,
 * lost property). Open items first, then collapsible done/closed.
 *
 * Used on PersonDetailPage + OrganisationDetailPage ("Held Items" tab) and
 * on JobDetailPage (the "Held for Clients" strip).
 *
 * Rows deep-link into the item's own detail modal (`/holding?item=<id>`), and
 * with `actions` set they carry the ONE next physical step — receive it, or
 * hand it over — so a job screen doesn't have to bounce to another page for
 * the two things that actually happen in the warehouse. Everything else
 * (notify, ship back, dispose, relink) still lives on the Holding pages.
 */
import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { locationLabel } from './holding/format';
import { describeHeldCounts, heldCountClass } from './holding/counts';
import type { HeldItem, HeldItemKind } from '../../../shared/types';

const TERMINAL = new Set(['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled']);

const STATUS_CHIP: Record<string, string> = {
  expected: 'bg-gray-100 text-gray-600', arrived: 'bg-blue-100 text-blue-700', stored: 'bg-blue-100 text-blue-700',
  client_notified: 'bg-amber-100 text-amber-700', collection_arranged: 'bg-amber-100 text-amber-700',
  collected: 'bg-green-100 text-green-700', given_to_client: 'bg-green-100 text-green-700', shipped_back: 'bg-green-100 text-green-700',
  disposed: 'bg-gray-100 text-gray-500', unclaimed: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-500',
};
// temp_storage is folded into incoming (Aug 2026) — same icon, historical rows only.
const KIND_EMOJI: Record<HeldItemKind, string> = { incoming: '📦', temp_storage: '📦', lost_property: '🔍' };
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '');
const statusLabel = (s: string) => s.replace(/_/g, ' ');

const ENDPOINT_BY_TYPE: Record<string, string> = { person: 'by-person', organisation: 'by-org', job: 'by-job' };
// Lost property lives on a different nav page than incoming/temp. `?item=` opens
// that record's detail modal directly (HoldingPage already honours the param) —
// without it a click landed on a list of everything and you had to find it again.
const viewHref = (h: HeldItem) =>
  `${h.kind === 'lost_property' ? '/holding/lost-property' : '/holding'}?item=${h.id}`;

// The states where the thing is physically in the building and could be handed over.
const HERE_STATES = new Set(['arrived', 'stored', 'client_notified', 'collection_arranged']);

export function HeldItemsSection({
  entityType,
  entityId,
  onCount,
  kinds,
  hideWhenEmpty,
  openOnly,
  heading,
  bare,
  emptyHint,
  excludeJobId,
  actions,
  onChanged,
}: {
  entityType: 'person' | 'organisation' | 'job';
  entityId: string;
  onCount?: (count: number) => void;
  kinds?: readonly HeldItemKind[];  // restrict to certain kinds (e.g. lost_property nudge)
  hideWhenEmpty?: boolean;          // render nothing instead of an empty card
  openOnly?: boolean;              // drop the resolved section entirely
  heading?: string;                // optional heading rendered above the card (only when items exist)
  bare?: boolean;                  // no outer card wrapper (for embedding in another panel)
  emptyHint?: string;              // muted text shown when empty + not hideWhenEmpty
  excludeJobId?: string;           // drop items linked to this job (already shown elsewhere on the page)
  actions?: boolean;               // show the per-row next physical step (receive / hand over)
  onChanged?: () => void;          // an action changed something — let the parent re-derive (merch pip etc.)
}) {
  const [items, setItems] = useState<HeldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // An inline action mutated an item — re-read our own list, then let the parent
  // re-derive anything downstream (the merch pip is computed from these rows).
  const afterAction = useCallback(() => {
    setReloadKey((k) => k + 1);
    if (onChanged) onChanged();
  }, [onChanged]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ data: HeldItem[] }>(`/holding/${ENDPOINT_BY_TYPE[entityType]}/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const filtered = (res.data || []).filter((i) =>
          (!kinds || kinds.includes(i.kind)) && (!excludeJobId || i.job_id !== excludeJobId));
        setItems(filtered);
        if (onCount) onCount(filtered.filter((i) => !TERMINAL.has(i.status)).length);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, onCount, kinds, excludeJobId, reloadKey]);

  if (loading) return hideWhenEmpty ? null : <div className="text-sm text-gray-500 text-center py-8">Loading…</div>;

  const open = items.filter((i) => !TERMINAL.has(i.status));
  const done = openOnly ? [] : items.filter((i) => TERMINAL.has(i.status));

  if (items.length === 0 || (openOnly && open.length === 0)) {
    if (hideWhenEmpty) return null;
    const empty = emptyHint || 'Nothing currently held.';
    return bare
      ? <p className="text-sm text-gray-400">{empty}</p>
      : <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">{empty}</div>;
  }

  const inner = (
    <>
      {heading && <h3 className={bare ? 'text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2' : 'text-sm font-semibold text-gray-800 mb-3'}>{heading}</h3>}
      {open.length > 0 && (
        <div>
          {!heading && <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">Currently held ({open.length})</h3>}
          <div className="space-y-2">{open.map((h) => <Row key={h.id} h={h} context={entityType} actions={actions} onActed={afterAction} />)}</div>
        </div>
      )}
      {done.length > 0 && bare && (
        // Bare (job panel): show resolved inline, greyed — so "given to client" stays visible.
        <div className={open.length > 0 ? 'mt-2 space-y-2' : 'space-y-2'}>
          {done.map((h) => <Row key={h.id} h={h} context={entityType} />)}
        </div>
      )}
      {done.length > 0 && !bare && (
        <div className={open.length > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}>
          <button type="button" onClick={() => setShowDone((s) => !s)}
            className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-green-700 hover:text-green-800">
            <span>Resolved ({done.length})</span><span className="text-gray-400">{showDone ? 'Hide' : 'Show'}</span>
          </button>
          {showDone && <div className="space-y-2 mt-2">{done.map((h) => <Row key={h.id} h={h} context={entityType} />)}</div>}
        </div>
      )}
    </>
  );

  return bare ? inner : <div className="bg-white rounded-xl border border-gray-200 p-4">{inner}</div>;
}

function Row({ h, context, actions, onActed }: {
  h: HeldItem; context: string; actions?: boolean; onActed?: () => void;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
  const isTerminal = TERMINAL.has(h.status);
  const counts = describeHeldCounts(h);
  // For resolved rows, show the outcome (given/collected/shipped/disposed) rather than location.
  let outcome: string | null = null;
  if (h.status === 'given_to_client' || h.status === 'collected') {
    outcome = `${h.status === 'given_to_client' ? 'Given' : 'Collected'}${h.collected_by ? ` to ${h.collected_by}` : ''}${h.collected_at ? ` · ${fmtDate(h.collected_at)}` : ''}`;
  } else if (h.status === 'shipped_back') outcome = `Shipped back${h.collected_at ? ` · ${fmtDate(h.collected_at)}` : ''}`;
  else if (h.status === 'disposed') outcome = 'Disposed';
  const sub = isTerminal
    ? outcome
    : [
        locationLabel(h),
        context !== 'job' && h.hh_job_number ? `J-${h.hh_job_number}` : null,
        context === 'job' && client ? client : null,
        h.kind === 'lost_property' ? `found ${fmtDate(h.found_date)}` : (h.needed_by ? `needed ${fmtDate(h.needed_by)}` : null),
      ].filter(Boolean).join(' · ');

  // The one next physical step. Everything else stays on the Holding pages.
  const canReceive = !!actions && !isTerminal && h.status === 'expected';
  const canHandOver = !!actions && !isTerminal && HERE_STATES.has(h.status);

  async function handOver() {
    setBusy(true); setErr('');
    try {
      await api.post(`/holding/${h.id}/collected`, { collected_by: who || null });
      setConfirming(false);
      if (onActed) onActed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally { setBusy(false); }
  }

  return (
    <div className={`rounded border border-gray-200 px-3 py-2 ${isTerminal ? 'bg-gray-50 opacity-60' : 'bg-gray-50/40'}`}>
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">{KIND_EMOJI[h.kind]}</span>
        <Link to={viewHref(h)} className="min-w-0 flex-1 group">
          <div className="text-sm font-medium text-gray-900 truncate group-hover:text-ooosh-700">
            {h.description || 'Item'}
            {h.owner_unknown && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown</span>}
          </div>
          {/* Counts come from the columns, never the description — see holding/counts.ts */}
          {counts && !isTerminal && (
            <div className={`text-[11px] font-medium ${heldCountClass(counts.tone)}`}>{counts.text}</div>
          )}
          {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
        </Link>
        <div className="flex items-center gap-1.5 shrink-0">
          {canReceive && (
            <button type="button" onClick={() => navigate(`/holding/receipt/${h.id}`)}
              className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#7B5EA7] text-white hover:opacity-90">
              📦 Receive
            </button>
          )}
          {canHandOver && !confirming && (
            <button type="button" onClick={() => setConfirming(true)}
              className="px-2 py-0.5 rounded text-[10px] font-medium bg-green-600 text-white hover:bg-green-700">
              ✅ Hand over
            </button>
          )}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${STATUS_CHIP[h.status] || 'bg-gray-100'}`}>{statusLabel(h.status)}</span>
        </div>
      </div>

      {confirming && (
        <div className="mt-2 pt-2 border-t border-gray-200 flex flex-wrap items-center gap-2">
          <input autoFocus value={who} onChange={(e) => setWho(e.target.value)} placeholder="Collected by (optional)"
            className="flex-1 min-w-[140px] border border-gray-300 rounded px-2 py-1 text-xs" />
          <button type="button" onClick={handOver} disabled={busy}
            className="px-2.5 py-1 rounded text-xs font-medium bg-green-600 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Confirm'}
          </button>
          <button type="button" onClick={() => { setConfirming(false); setErr(''); }} className="text-xs text-gray-500">Cancel</button>
          {counts && counts.outstanding > 0 && (
            <p className="w-full text-[10px] text-amber-700">{counts.outstanding} still outstanding — handing over closes this record.</p>
          )}
          {err && <p className="w-full text-[10px] text-red-600">{err}</p>}
        </div>
      )}
    </div>
  );
}

export default HeldItemsSection;
