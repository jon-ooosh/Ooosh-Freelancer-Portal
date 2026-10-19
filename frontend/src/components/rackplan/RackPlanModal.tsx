import { useEffect } from 'react';
import RackPlanTab from './RackPlanTab';

interface Props {
  jobId: string;
  onClose: () => void;
}

/** Full-screen modal housing the Rack Planner canvas (launched from Job Tools). */
export default function RackPlanModal({ jobId, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-lg shadow-xl w-full h-full max-w-[1400px] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">🎚️ Rack Planner</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
        </div>
        <div className="flex-1 min-h-0 p-3">
          <RackPlanTab jobId={jobId} />
        </div>
      </div>
    </div>
  );
}
