import { useEffect, useRef, useState } from 'react';

/**
 * Tab row for the address-book detail pages (Organisation, Person).
 *
 * Main tabs always show. A "secondary" tab (Excess, Held Items, PCNs…) shows in
 * the main row only when it has something in it (`hasContent`) or has been
 * opened during this visit; otherwise it waits under "More", greyed but still
 * clickable — never hidden outright, so a tab you need to ADD the first thing
 * to (a rehearsal profile, say) is always one click away.
 *
 * A tab opened from "More" stays in the row for the rest of the visit (jon,
 * Oct 2026 — flipping between two of them shouldn't mean the menu each time).
 * "This visit" = this component's life: the detail pages are keyed by record id,
 * so leaving the page or opening another record starts the row afresh.
 *
 * The row scrolls sideways on a narrow screen; "More" sits outside the
 * scrolling strip so its menu isn't clipped.
 */
export interface EntityTab<K extends string> {
  key: K;
  label: string;
  secondary?: boolean;
  /** true = has rows, false = known empty, undefined = not known yet */
  hasContent?: boolean;
}

export default function EntityTabs<K extends string>({ tabs, active, onSelect }: {
  tabs: EntityTab<K>[];
  active: K;
  onSelect: (key: K) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Secondary tabs opened during this visit — they stay in the row (see above)
  const [revealed, setRevealed] = useState<Set<K>>(() => new Set([active]));

  // Covers a tab opened from More AND one opened by a ?tab= deep-link
  useEffect(() => {
    setRevealed((cur) => (cur.has(active) ? cur : new Set(cur).add(active)));
  }, [active]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [moreOpen]);

  const inRow = (t: EntityTab<K>) => !t.secondary || t.hasContent === true || t.key === active || revealed.has(t.key);
  const rowTabs = tabs.filter(inRow);
  const moreTabs = tabs.filter((t) => !inRow(t));

  return (
    <div className="border-b border-gray-200 mb-6 flex items-end gap-4">
      <nav className="flex gap-6 overflow-x-auto min-w-0 flex-1">
        {rowTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => onSelect(t.key)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
              active === t.key
                ? 'border-ooosh-600 text-ooosh-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {moreTabs.length > 0 && (
        <div className="relative flex-shrink-0" ref={moreRef}>
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="pb-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap"
            aria-expanded={moreOpen}
          >
            More {moreOpen ? '▴' : '▾'}
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20 w-52">
              {moreTabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => { setMoreOpen(false); onSelect(t.key); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-2"
                >
                  <span className={t.hasContent === false ? 'text-gray-400' : 'text-gray-700'}>{t.label}</span>
                  {t.hasContent === false && <span className="text-xs text-gray-300">none</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
