import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * "Did you mean…?" box shown while CREATING a person or organisation. Fuzzy
 * match on the server (services/address-book-similar.ts). Warn-only — the form
 * still saves. Links open in a new tab so the half-filled form isn't lost.
 */
interface SimilarRecord { id: string; name: string; detail: string | null; reason: string }

export default function SimilarRecordsWarning({ type, params }: {
  type: 'person' | 'organisation';
  params: Record<string, string>;
}) {
  const [matches, setMatches] = useState<SimilarRecord[]>([]);
  const key = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ type, ...params });
      try {
        const r = await api.get<{ data: SimilarRecord[] }>(`/duplicates/similar?${qs}`);
        if (!cancelled) setMatches(r.data || []);
      } catch {
        if (!cancelled) setMatches([]);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, key]);

  if (matches.length === 0) return null;
  const base = type === 'person' ? '/people' : '/organisations';

  return (
    <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded text-xs">
      <p className="font-medium mb-1">Already in the address book? Check before creating:</p>
      <ul className="space-y-0.5">
        {matches.map((m) => (
          <li key={m.id}>
            <a href={`${base}/${m.id}`} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:text-amber-900">{m.name}</a>
            {m.detail && <span className="text-amber-700"> · {m.detail}</span>}
            <span className="text-amber-600"> ({m.reason.toLowerCase()})</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-amber-700">You can still save if this is someone new.</p>
    </div>
  );
}
