import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A list page's search box, kept in the URL as `?q=` and debounced.
 *
 * - `search` is what's in the box (updates on every keystroke).
 * - `debouncedSearch` is what to actually query — it only changes once typing
 *   has paused for `delayMs`, so eight keystrokes make one request, not eight.
 * - The URL is updated with `replace` (no history entry per keystroke), so the
 *   search survives opening a record and pressing Back, and a link can be shared.
 *
 * Debouncing alone does NOT stop an older, slower reply overwriting a newer one —
 * callers must still ignore stale responses (see the request counter in
 * PeoplePage / OrganisationsPage).
 */
export function useUrlSearch(delayMs = 250) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = searchParams.get('q') || '';
  const [search, setSearch] = useState(urlQ);
  const [debouncedSearch, setDebouncedSearch] = useState(urlQ.trim());

  // Typing → wait for a pause → query + write the URL
  useEffect(() => {
    const t = setTimeout(() => {
      const q = search.trim();
      setDebouncedSearch(q);
      setSearchParams((prev) => {
        if ((prev.get('q') || '') === q) return prev;
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q); else next.delete('q');
        return next;
      }, { replace: true });
    }, delayMs);
    return () => clearTimeout(t);
  }, [search, delayMs, setSearchParams]);

  // URL changed from outside (nav link back to the bare page, browser Back/Forward)
  // → follow it. When we wrote the URL ourselves it already matches, so no-op.
  useEffect(() => {
    if (urlQ.trim() !== debouncedSearch) {
      setSearch(urlQ);
      setDebouncedSearch(urlQ.trim());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  return { search, setSearch, debouncedSearch };
}
