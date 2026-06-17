import { useEffect, useState } from 'react';
import { api } from '../../services/api';

interface Props {
  jobId: string;
  onEdit: () => void;
  /** Bumped by the parent when the modal closes, to re-check for a newly-created plan. */
  refreshKey?: number;
}

interface Summary { hasPlan: boolean; nodeCount?: number; viewToken?: string; updatedAt?: string; editedBy?: string | null }

function relTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

/**
 * Surfaces on Job Overview once a rack plan with content exists, so staff know
 * one's been created (and can jump to edit / grab the client link). Hidden when
 * no plan exists — creation still starts from Tools → Rack Planner.
 */
export default function RackPlanOverviewCard({ jobId, onEdit, refreshKey }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ data: Summary }>(`/rack-plans/summary/${jobId}`)
      .then((r) => { if (!cancelled) setSummary(r.data); })
      .catch(() => { if (!cancelled) setSummary({ hasPlan: false }); });
    return () => { cancelled = true; };
  }, [jobId, refreshKey]);

  if (!summary?.hasPlan) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-lg">🎚️</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-800">Rack Plan</div>
          <div className="text-xs text-gray-500">
            {summary.nodeCount} item{summary.nodeCount === 1 ? '' : 's'} laid out
            {summary.updatedAt && (
              <span className="text-gray-400">
                {' · '}last edited {relTime(summary.updatedAt)}{summary.editedBy ? ` by ${summary.editedBy}` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {summary.viewToken && (
          <a className="px-3 py-1.5 text-sm rounded border border-ooosh-200 text-ooosh-700 hover:bg-ooosh-50"
            href={`/rack/${summary.viewToken}`} target="_blank" rel="noreferrer">View-only link ↗</a>
        )}
        <button onClick={onEdit}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">Edit rack plan</button>
      </div>
    </div>
  );
}
