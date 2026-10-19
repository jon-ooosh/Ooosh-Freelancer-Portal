import { useState } from 'react';
import { api } from '../services/api';

/**
 * Shared "flag a bad OOH return" form. Used by the dashboard "Recent OOH returns"
 * section and the Job Detail "Out-of-hours returns" panel — same severity choice,
 * same attribution picker, same POST. Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.
 */

export interface OohFlaggableDriver {
  assignmentId: string;
  driverId: string | null;
  driverName: string | null;
  submitted: boolean;
}

export interface OohFlaggableReturn {
  jobId: string;
  vehicleId: string;
  drivers: OohFlaggableDriver[];
}

export default function OohFlagForm({
  row,
  onFlagged,
}: {
  row: OohFlaggableReturn;
  onFlagged: (violationId: string) => void;
}) {
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
