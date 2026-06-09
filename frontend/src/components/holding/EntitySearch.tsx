/**
 * Live org / person picker used by the Holding capture forms (desktop modal +
 * mobile quick log). Debounced search against /organisations or /people; on
 * pick returns the id + display name. Shared so both surfaces behave identically.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';

export function EntitySearch({ kind, value, label, compact, onPick }: {
  kind: 'organisations' | 'people';
  value: string;
  label: string;
  compact?: boolean;
  onPick: (id: string | null, name: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const inputCls = compact
    ? 'w-full border border-slate-300 rounded-xl px-4 py-3 text-base'
    : 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm';

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<Record<string, string>> }>(`/${kind}?search=${encodeURIComponent(q)}&limit=8`);
        setResults(r.data.map((x) => ({ id: x.id, name: kind === 'people' ? `${x.first_name || ''} ${x.last_name || ''}`.trim() : x.name })));
        setOpen(true);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [q, kind]);

  return (
    <div className="relative">
      <label className={`block ${compact ? 'text-sm text-slate-500' : 'text-xs font-medium text-slate-500'} mb-1`}>{label}</label>
      {value ? (
        <div className="flex items-center gap-2 border border-slate-300 rounded-lg px-3 py-2 bg-slate-50">
          <span className="text-sm flex-1">{value}</span>
          <button type="button" onClick={() => { onPick(null, ''); setQ(''); }} className="text-xs text-red-500">clear</button>
        </div>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind}…`} className={inputCls} />
          {open && results.length > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow max-h-48 overflow-y-auto">
              {results.map((r) => (
                <button type="button" key={r.id} onClick={() => { onPick(r.id, r.name); setOpen(false); }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50">{r.name}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
