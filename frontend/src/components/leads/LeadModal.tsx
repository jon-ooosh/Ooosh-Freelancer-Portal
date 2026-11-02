/** The frame every Leads dialog sits in — matches the app's other modals. */
import type { ReactNode } from 'react';

export default function LeadModal({ title, onClose, children, footer, wide }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} my-8`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Close">×</button>
        </div>
        <div className="px-5 py-4 text-sm text-gray-700">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t bg-gray-50 rounded-b-xl">{footer}</div>}
      </div>
    </div>
  );
}
