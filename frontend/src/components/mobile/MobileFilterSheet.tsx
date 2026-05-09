import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Bottom-sheet drawer for mobile filter overflow. The sticky header carries
 * the title + close button; the sticky footer carries the Apply button.
 * Body scrolls. Body lock prevents background scroll-through while open.
 *
 * The sheet only renders on mobile widths — the parent decides via Tailwind
 * (`md:hidden` on the trigger button) when to call it. Inside, this is just
 * a portal'd overlay.
 */
export interface MobileFilterSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  applyLabel?: string;
  onApply?: () => void;
  children: ReactNode;
}

export function MobileFilterSheet({
  open,
  onClose,
  title = 'Filters',
  applyLabel = 'Apply',
  onApply,
  children,
}: MobileFilterSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  function handleApply() {
    if (onApply) onApply();
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-xl max-h-[88vh] flex flex-col animate-slide-up shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 bg-gray-300 rounded-full" />
        </div>
        <div className="px-4 pb-3 flex items-center justify-between border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 -mr-1.5 hover:bg-gray-100 rounded"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">{children}</div>

        <div className="border-t border-gray-200 px-4 py-3 bg-white">
          <button
            onClick={handleApply}
            className="w-full bg-ooosh-600 text-white rounded-lg py-2.5 font-medium hover:bg-ooosh-700 transition-colors"
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
