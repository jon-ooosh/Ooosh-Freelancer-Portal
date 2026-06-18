import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';
import { api } from '../../../../services/api';

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
                <FlagForm row={r} onFlagged={(vid) => markFlagged(key, vid)} />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function FlagForm({ row, onFlagged }: { row: RecentReturn; onFlagged: (violationId: string) => void }) {
  const namedDrivers = row.drivers.filter(d => d.driverId);
  const defaultDriver =
    namedDrivers.find(d => d.submitted)?.driverId || (namedDrivers.length === 1 ? namedDrivers[0].driverId! : '');
  const [severity, setSeverity] = useState<'serious' | 'minor'>('serious');
  const [driverId, setDriverId] = useState<string>(defaultDriver || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const type = severity === 'serious' ? 'parked_blocking' : 'left_without_telling_us';
      const res = await api.post<{ data: { violationId: string } }>('/ooh-return/violations', {
        job_id: row.jobId,
        vehicle_id: row.vehicleId,
        type,
        severity,
        driver_id: driverId || undefined,
        notes: notes.trim() || undefined,
      });
      onFlagged(res.data.violationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log');
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 ml-1 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSeverity('serious')}
          className={`px-2.5 py-1 text-xs rounded border ${
            severity === 'serious' ? 'border-red-400 bg-red-50 text-red-800' : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          Parked badly / blocked access
        </button>
        <button
          onClick={() => setSeverity('minor')}
          className={`px-2.5 py-1 text-xs rounded border ${
            severity === 'minor' ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          Didn't tell us where
        </button>
      </div>
      {namedDrivers.length > 1 && (
        <select
          value={driverId}
          onChange={e => setDriverId(e.target.value)}
          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
        >
          {namedDrivers.map(d => (
            <option key={d.assignmentId} value={d.driverId as string}>
              {d.driverName || 'Unnamed'}{d.submitted ? ' (confirmed)' : ''}
            </option>
          ))}
          <option value="">Whole hire / not sure</option>
        </select>
      )}
      <input
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Optional note…"
        className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="px-3 py-1.5 text-xs bg-red-600 text-white rounded font-medium hover:bg-red-700 disabled:opacity-50"
      >
        {busy ? 'Logging…' : 'Log parking issue'}
      </button>
    </div>
  );
}
