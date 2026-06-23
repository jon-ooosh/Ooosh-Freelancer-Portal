import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';
import { api } from '../../../../services/api';
import OohFlagForm from '../../../OohFlagForm';

/**
 * "Recent OOH returns" — the retro-flag surface (Part 2 of
 * docs/OOH-SMS-AND-COMPLIANCE-SPEC.md). Lists out-of-hours returns from the last
 * few days so whoever spots a badly-parked van can flag it even if they weren't
 * the one who checked it in. Self-fetching; hidden entirely when there's nothing.
 */

interface VanDriver {
  assignmentId: string;
  driverId: string | null;
  driverName: string | null;
  submitted: boolean;
  blocked: boolean;
}
interface RecentReturn {
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  vehicleId: string;
  vehicleReg: string;
  returnedAt: string | null;
  submitted: boolean;
  drivers: VanDriver[];
  existingViolationId: string | null;
}

export default function OohReturns(_props: DashboardSectionProps) {
  const [rows, setRows] = useState<RecentReturn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: RecentReturn[] }>('/ooh-return/recent-returns?days=3');
        if (!cancelled) setRows(res.data);
      } catch {
        /* swallow — section just won't show */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || rows.length === 0) return null;

  function markFlagged(key: string, violationId: string) {
    setRows(prev => prev.map(r => (`${r.jobId}:${r.vehicleId}` === key ? { ...r, existingViolationId: violationId } : r)));
    setOpenKey(null);
  }

  return (
    <Card as="section">
      <SectionHd
        eyebrow="Out of hours"
        title="Recent OOH returns"
        sub="Flag anything left badly — even if you didn't check it in"
      />
      <div>
        {rows.map(r => {
          const key = `${r.jobId}:${r.vehicleId}`;
          return (
            <div key={key} className="border-t py-2.5 px-1 -mx-1" style={{ borderColor: 'var(--op-border)' }}>
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap ${
                    r.submitted ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                  }`}
                  title={r.submitted ? 'Driver confirmed parking via the form' : 'No parking confirmation submitted'}
                >
                  {r.submitted ? 'Confirmed' : 'Unconfirmed'}
                </span>
                <span className="flex-1 min-w-0">
                  <Link to={`/jobs/${r.jobId}`} className="text-sm font-medium text-gray-900 hover:underline">
                    {r.vehicleReg}
                  </Link>
                  <span className="text-xs text-gray-500">
                    {r.hhJobNumber ? ` · job #${r.hhJobNumber}` : ''}
                    {r.returnedAt ? ` · back ${new Date(r.returnedAt).toLocaleDateString('en-GB')}` : ''}
                  </span>
                </span>
                {r.existingViolationId ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-700 whitespace-nowrap">
                    ⚠️ Flagged
                  </span>
                ) : openKey === key ? (
                  <button onClick={() => setOpenKey(null)} className="text-xs text-gray-400 hover:text-gray-600">
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={() => setOpenKey(key)}
                    className="text-xs font-medium px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                  >
                    Flag issue
                  </button>
                )}
              </div>
              {openKey === key && !r.existingViolationId && (
                <OohFlagForm row={r} onFlagged={(vid) => markFlagged(key, vid)} />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
