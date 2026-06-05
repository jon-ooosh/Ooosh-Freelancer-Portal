/**
 * Held-items section, reusable across detail pages.
 *
 * Reads from /api/holding/by-{person|org|job}/:id — surfaces what we're
 * temporarily holding for this entity (incoming deliveries, temp storage,
 * lost property). Open items first, then collapsible done/closed.
 *
 * Used on PersonDetailPage + OrganisationDetailPage ("Held Items" tab) and
 * on JobDetailPage (the "Held for Clients" strip). Read-only surfacing — the
 * full actions live on the Holding pages.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import type { HeldItem, HeldItemKind } from '../../../shared/types';

const TERMINAL = new Set(['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled']);

const STATUS_CHIP: Record<string, string> = {
  expected: 'bg-gray-100 text-gray-600', arrived: 'bg-blue-100 text-blue-700', stored: 'bg-blue-100 text-blue-700',
  client_notified: 'bg-amber-100 text-amber-700', collection_arranged: 'bg-amber-100 text-amber-700',
  collected: 'bg-green-100 text-green-700', given_to_client: 'bg-green-100 text-green-700', shipped_back: 'bg-green-100 text-green-700',
  disposed: 'bg-gray-100 text-gray-500', unclaimed: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-500',
};
const KIND_EMOJI: Record<HeldItemKind, string> = { incoming: '📦', temp_storage: '🗄️', lost_property: '🔍' };
const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB') : '');
const statusLabel = (s: string) => s.replace(/_/g, ' ');

const ENDPOINT_BY_TYPE: Record<string, string> = { person: 'by-person', organisation: 'by-org', job: 'by-job' };
// Lost property lives on a different nav page than incoming/temp.
const viewHref = (h: HeldItem) => (h.kind === 'lost_property' ? '/holding/lost-property' : '/holding');

export function HeldItemsSection({
  entityType,
  entityId,
  onCount,
  kinds,
  hideWhenEmpty,
  openOnly,
  heading,
}: {
  entityType: 'person' | 'organisation' | 'job';
  entityId: string;
  onCount?: (count: number) => void;
  kinds?: HeldItemKind[];          // restrict to certain kinds (e.g. lost_property nudge)
  hideWhenEmpty?: boolean;          // render nothing instead of an empty card
  openOnly?: boolean;              // drop the resolved section entirely
  heading?: string;                // optional heading rendered above the card (only when items exist)
}) {
  const [items, setItems] = useState<HeldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ data: HeldItem[] }>(`/holding/${ENDPOINT_BY_TYPE[entityType]}/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const filtered = (res.data || []).filter((i) => !kinds || kinds.includes(i.kind));
        setItems(filtered);
        if (onCount) onCount(filtered.filter((i) => !TERMINAL.has(i.status)).length);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, onCount, kinds]);

  if (loading) return hideWhenEmpty ? null : <div className="text-sm text-gray-500 text-center py-8">Loading…</div>;

  const open = items.filter((i) => !TERMINAL.has(i.status));
  const done = openOnly ? [] : items.filter((i) => TERMINAL.has(i.status));

  if (items.length === 0 || (openOnly && open.length === 0)) {
    if (hideWhenEmpty) return null;
    return <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">Nothing currently held.</div>;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      {heading && <h3 className="text-sm font-semibold text-gray-800 mb-3">{heading}</h3>}
      {open.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">Currently held ({open.length})</h3>
          <div className="space-y-2">{open.map((h) => <Row key={h.id} h={h} context={entityType} />)}</div>
        </div>
      )}
      {done.length > 0 && (
        <div className={open.length > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}>
          <button type="button" onClick={() => setShowDone((s) => !s)}
            className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-green-700 hover:text-green-800">
            <span>Resolved ({done.length})</span><span className="text-gray-400">{showDone ? 'Hide' : 'Show'}</span>
          </button>
          {showDone && <div className="space-y-2 mt-2">{done.map((h) => <Row key={h.id} h={h} context={entityType} />)}</div>}
        </div>
      )}
    </div>
  );
}

function Row({ h, context }: { h: HeldItem; context: string }) {
  const client = h.owner_person_name || h.owner_organisation_name || h.client_name_text;
  const sub = [
    h.storage_location_name || h.storage_location_text,
    context !== 'job' && h.hh_job_number ? `J-${h.hh_job_number}` : null,
    context === 'job' && client ? client : null,
    h.kind === 'lost_property' ? `found ${fmtDate(h.found_date)}` : (h.needed_by ? `needed ${fmtDate(h.needed_by)}` : null),
  ].filter(Boolean).join(' · ');
  return (
    <Link to={viewHref(h)} className="block rounded border border-gray-200 bg-gray-50/40 px-3 py-2 hover:border-ooosh-300 hover:bg-ooosh-50/40">
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">{KIND_EMOJI[h.kind]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">
            {h.description || 'Item'}
            {h.owner_unknown && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">❓ Unknown</span>}
          </div>
          {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
        </div>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${STATUS_CHIP[h.status] || 'bg-gray-100'}`}>{statusLabel(h.status)}</span>
      </div>
    </Link>
  );
}

export default HeldItemsSection;
