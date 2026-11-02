/** Search history — every run, newest first, with a jump to the leads each one found. */
import type { LeadRun } from './leadTypes';
import { fmtDate } from './leadTypes';
import LeadModal from './LeadModal';

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SearchHistoryModal({ runs, loading, onClose, onShowBatch }: {
  runs: LeadRun[];
  loading: boolean;
  onClose: () => void;
  onShowBatch: (runId: string) => void;
}) {
  return (
    <LeadModal wide title="Search history" onClose={onClose}>
      {loading ? (
        <div className="text-gray-400 py-6 text-center">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="text-gray-400 py-6 text-center">No searches yet.</div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase text-gray-400">
              <tr>
                <th className="px-2 py-1.5 text-left">When</th>
                <th className="px-2 py-1.5 text-left">What</th>
                <th className="px-2 py-1.5 text-right">Found</th>
                <th className="px-2 py-1.5 text-right">Researched</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((r) => {
                const c = r.counts;
                const reprocess = c?.mode === 'process_existing';
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="text-gray-900">{when(r.started_at)}</div>
                      <div className="text-xs text-gray-400">{r.triggered_by_name ?? (r.trigger === 'scheduled' ? 'Scheduled' : '—')}</div>
                    </td>
                    <td className="px-2 py-2">
                      {r.status === 'failed' ? (
                        <span className="text-red-700">Failed — {r.error || 'unknown error'}</span>
                      ) : r.status === 'running' ? (
                        <span className="text-blue-700">Running…</span>
                      ) : reprocess ? (
                        <span className="text-gray-600">Re-processed existing leads (match, score, research)</span>
                      ) : (
                        <span className="text-gray-600">
                          Search{c?.window ? `: tours starting ${fmtDate(c.window.from)} – ${fmtDate(c.window.to)}` : ''}
                          {c?.custom_window ? <span className="text-xs text-gray-400"> (custom)</span> : null}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right text-gray-700">{reprocess ? '—' : (r.leads_found ?? 0)}</td>
                    <td className="px-2 py-2 text-right text-gray-700">
                      {c?.research ? `${c.research.researched}${c.research.withContacts != null ? ` (${c.research.withContacts} ✓)` : ''}` : '—'}
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {(r.leads_found ?? 0) > 0 && (
                        <button onClick={() => onShowBatch(r.id)} className="text-xs text-[#7B5EA7] hover:underline">Show these leads →</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </LeadModal>
  );
}
