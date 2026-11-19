/**
 * Places and headings for Premises & compliance — admins only, no deploy
 * needed (docs/PREMISES-COMPLIANCE-SPEC.md §1.3–1.4). Rename, reorder, add,
 * retire. A place or heading with checks still under it can't be retired:
 * the server says how many to move first.
 */
import { useState } from 'react';
import { api } from '../../services/api';
import { Taxon } from './premisesCopy';

function TaxonList({ kind, title, items, onChanged, onError }: {
  kind: 'places' | 'headings';
  title: string;
  items: Taxon[];
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); onError(null);
    try { await fn(); await onChanged(); } catch (err) { onError(err instanceof Error ? err.message : 'Could not save that'); }
    finally { setBusy(false); }
  }

  /** Swap with the neighbour — two writes, each a plain sort_order. */
  function move(i: number, dir: -1 | 1) {
    const a = items[i], b = items[i + dir];
    if (!a || !b) return;
    void run(async () => {
      await api.patch(`/premises/${kind}/${a.id}`, { sort_order: b.sort_order });
      await api.patch(`/premises/${kind}/${b.id}`, { sort_order: a.sort_order === b.sort_order ? a.sort_order + dir : a.sort_order });
    });
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-900 mb-2">{title}</h4>
      <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
        {items.map((t, i) => (
          <li key={t.id} className="flex items-center gap-2 px-2 py-1.5">
            <input value={names[t.id] ?? t.name} disabled={busy || !!t.retired_at}
              onChange={e => setNames(prev => ({ ...prev, [t.id]: e.target.value }))}
              onBlur={() => {
                const v = (names[t.id] ?? t.name).trim();
                if (v && v !== t.name) void run(() => api.patch(`/premises/${kind}/${t.id}`, { name: v }));
              }}
              aria-label={`Name of ${t.name}`}
              className={`flex-1 min-w-0 px-2 py-1 text-sm border border-transparent hover:border-gray-200 focus:border-gray-300 rounded ${t.retired_at ? 'text-gray-400 line-through' : ''}`} />
            <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)}
              className="px-1.5 text-gray-500 disabled:opacity-30" aria-label={`Move ${t.name} up`}>↑</button>
            <button type="button" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)}
              className="px-1.5 text-gray-500 disabled:opacity-30" aria-label={`Move ${t.name} down`}>↓</button>
            <button type="button" disabled={busy}
              onClick={() => void run(() => api.patch(`/premises/${kind}/${t.id}`, { retired: !t.retired_at }))}
              className="text-xs text-gray-500 hover:text-gray-800 w-20 text-right">
              {t.retired_at ? 'Bring back' : 'Retire'}
            </button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2 mt-2" onSubmit={e => {
        e.preventDefault();
        const v = adding.trim();
        if (!v) return;
        void run(async () => { await api.post(`/premises/${kind}`, { name: v }); setAdding(''); });
      }}>
        <input value={adding} onChange={e => setAdding(e.target.value)} maxLength={100} disabled={busy}
          placeholder={kind === 'places' ? 'Add a place…' : 'Add a heading…'}
          className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded" />
        <button type="submit" disabled={busy || !adding.trim()}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">Add</button>
      </form>
    </div>
  );
}

export default function PlacesHeadingsModal({ places, headings, onClose, onChanged }: {
  places: Taxon[];
  headings: Taxon[];
  onClose: () => void;
  /** Reload the page's lists — the modal stays open and shows the new ones. */
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Places and headings</h3>
        <div className="grid sm:grid-cols-2 gap-6">
          <TaxonList kind="places" title="Places" items={places} onChanged={onChanged} onError={setError} />
          <TaxonList kind="headings" title="Headings" items={headings} onChanged={onChanged} onError={setError} />
        </div>
        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end mt-5">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Done</button>
        </div>
      </div>
    </div>
  );
}
