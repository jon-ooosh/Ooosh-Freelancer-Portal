/**
 * Dedupe nudge for the desktop create form. The mobile "Package arrived" flow
 * is search-first; the desktop modal isn't, so when staff enter a job number we
 * surface any items already logged against that job — "check you're not
 * duplicating". Informational only; never blocks the save.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import type { HeldItem } from '../../../../shared/types';

const TERMINAL = new Set(['collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled']);

export function DuplicateNudge({ hhJobNumber }: { hhJobNumber: string }) {
  const [items, setItems] = useState<HeldItem[]>([]);

  useEffect(() => {
    const n = hhJobNumber.trim();
    if (!n || !/^\d+$/.test(n)) { setItems([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.get<{ data: HeldItem[] }>(`/holding/by-job/${n}`)
        .then((r) => { if (!cancelled) setItems((r.data || []).filter((i) => !TERMINAL.has(i.status))); })
        .catch(() => { if (!cancelled) setItems([]); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [hhJobNumber]);

  if (items.length === 0) return null;
  return (
    <div className="border border-amber-200 bg-amber-50 rounded-lg p-2.5 text-xs text-amber-800">
      ⚠ {items.length} item{items.length === 1 ? '' : 's'} already logged for job #{hhJobNumber.trim()} — check you're not duplicating:
      <ul className="mt-1 list-disc pl-4 text-amber-700">
        {items.slice(0, 4).map((h) => (
          <li key={h.id}>{h.description || 'Item'}{h.box_count ? ` (${h.box_count} box${h.box_count === 1 ? '' : 'es'})` : ''} · {h.status.replace(/_/g, ' ')}</li>
        ))}
      </ul>
    </div>
  );
}
