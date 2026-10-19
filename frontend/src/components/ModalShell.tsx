/**
 * ModalShell — a plain centred pop-up: dimmed backdrop, white panel, title,
 * close button. Escape and a click on the backdrop close it.
 *
 * Opens where you are looking, whatever you clicked on — the reason it exists
 * (a booking panel that opened at the top of a long calendar went unnoticed).
 * Content scrolls inside the backdrop on a short screen.
 */

import { useEffect, type ReactNode } from 'react';

export default function ModalShell({ title, subtitle, onClose, children, width = 'max-w-2xl' }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true"
        className={`w-full ${width} bg-white rounded-xl shadow-xl border border-gray-200`}>
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-gray-500">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 -mr-1 w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-xl leading-none">
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
