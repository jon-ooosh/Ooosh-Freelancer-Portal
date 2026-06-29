import { useEffect, useState } from 'react';
import { api } from '../services/api';
import OohFlagForm from './OohFlagForm';

/**
 * Job Detail "Out-of-hours returns" panel (Drivers & Vehicles tab). Lists the
 * OOH-flagged vans on this job with a flag / un-flag affordance per van, so the
 * manager who spots a badly-parked van can log it (or clear a mistaken flag)
 * straight from the job. Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.
 *
 * Self-fetching; renders nothing when the job has no OOH-flagged vans.
 */

interface VanDriver {
  assignmentId: string;
  driverId: string | null;
  driverName: string | null;
  submitted: boolean;
  blocked: boolean;
}
interface JobReturn {
  jobId: string;
  vehicleId: string;
  vehicleReg: string;
  returnedAt: string | null;
  submitted: boolean;
  drivers: VanDriver[];
  existingViolationId: string | null;
}

export default function JobOohReturns({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<JobReturn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: JobReturn[] }>(`/ooh-return/job/${jobId}/returns`);
        if (!cancelled) setRows(res.data);
      } catch {
        /* swallow — panel just won't show */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!loaded || rows.length === 0) return null;

  function markFlagged(key: string, violationId: string) {
    setRows(prev => prev.map(r => (`${r.jobId}:${r.vehicleId}` === key ? { ...r, existingViolationId: violationId } : r)));
    setOpenKey(null);
  }

  async function clearFlag(key: string, violationId: string) {
    setClearing(key);
    try {
      await api.patch(`/ooh-return/violations/${violationId}/dismiss`, { reason: 'Cleared from job' });
      setRows(prev => prev.map(r => (`${r.jobId}:${r.vehicleId}` === key ? { ...r, existingViolationId: null } : r)));
    } catch {
      /* leave as-is on failure */
    } finally {
      setClearing(null);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
      <div className="flex items-center gap-2 mb-1">
        <span aria-hidden>🌙</span>
        <h4 className="text-sm font-semibold text-gray-900">Out-of-hours returns</h4>
      </div>
      <p className="text-xs text-gray-500 mb-2">Flag anything left badly — even if you didn't check it in.</p>
      <div>
        {rows.map(r => {
          const key = `${r.jobId}:${r.vehicleId}`;
          return (
            <div key={key} className="border-t py-2.5 first:border-t-0" style={{ borderColor: 'var(--op-border)' }}>
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
                  <span className="text-sm font-medium text-gray-900">{r.vehicleReg}</span>
                  {r.returnedAt && (
                    <span className="text-xs text-gray-500"> · back {new Date(r.returnedAt).toLocaleDateString('en-GB')}</span>
                  )}
                </span>
                {r.existingViolationId ? (
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-700">⚠️ Flagged</span>
                    <button
                      onClick={() => clearFlag(key, r.existingViolationId as string)}
                      disabled={clearing === key}
                      className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
                    >
                      {clearing === key ? 'Clearing…' : 'Clear'}
                    </button>
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
    </div>
  );
}
