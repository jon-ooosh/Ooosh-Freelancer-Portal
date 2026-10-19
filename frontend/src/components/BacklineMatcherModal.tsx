/**
 * BacklineMatcherModal — launches the Backline Matcher from the Job Detail
 * "🛠 Tools" dropdown with the job number pre-filled (so availability is
 * checked against the real hire dates). Native modal, not an iframe.
 */
import { useEffect } from 'react';
import BacklineMatcher from './BacklineMatcher';

export default function BacklineMatcherModal({
  hhJobNumber,
  onClose,
}: {
  hhJobNumber?: string | number | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-gray-50 rounded-2xl shadow-xl w-full max-w-2xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white rounded-t-2xl">
          <h2 className="text-lg font-semibold text-gray-900">🎸 Backline Matcher</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">
          <BacklineMatcher defaultJobNumber={hhJobNumber ? String(hhJobNumber) : undefined} />
        </div>
      </div>
    </div>
  );
}
