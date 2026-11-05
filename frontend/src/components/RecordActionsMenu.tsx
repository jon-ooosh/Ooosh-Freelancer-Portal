import { useEffect, useRef, useState } from 'react';

/**
 * The "⋯" menu on an address-book record's header — the rare, heavier actions
 * (Merge, Delete) that used to sit as full buttons next to Edit.
 */
export interface RecordAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
  title?: string;
}

/**
 * `floating`: for a menu inside a scrolling box (a table row in an
 * overflow-x-auto wrapper), where a dropdown positioned inside the box would be
 * clipped. The dropdown is placed on the page under the button instead, and
 * closes on scroll. Default unchanged.
 */
export default function RecordActionsMenu({ actions, floating = false }: { actions: RecordAction[]; floating?: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    // A floating menu stays where it was drawn, so scrolling closes it.
    const onScroll = () => setOpen(false);
    if (floating) window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      if (floating) window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, floating]);

  const toggle = () => {
    if (!open && floating && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPlace({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  if (actions.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="px-2.5 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors leading-none"
        aria-label="More actions"
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <div
          className={`${floating ? 'fixed w-56 z-40' : 'absolute right-0 top-full mt-1 w-48 z-20'} bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-left whitespace-normal`}
          style={floating && place ? { top: place.top, right: place.right } : undefined}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              title={a.title}
              onClick={() => { setOpen(false); a.onClick(); }}
              className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${a.danger ? 'text-red-600' : 'text-gray-700'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
