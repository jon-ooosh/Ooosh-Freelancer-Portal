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

export default function RecordActionsMenu({ actions }: { actions: RecordAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors leading-none"
        aria-label="More actions"
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20 w-48">
          {actions.map((a) => (
            <button
              key={a.label}
              title={a.title}
              onClick={() => { setOpen(false); a.onClick(); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${a.danger ? 'text-red-600' : 'text-gray-700'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
