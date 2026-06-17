/**
 * OOH return compliance capture — shown on the van check-in success screen.
 *
 * If the van just checked in was an out-of-hours return, asks "were the OOH
 * parking steps followed?" with a PRE-TICKED "yes" (assume fine). Unticking
 * reveals a two-choice severity flag (+ driver attribution picker when the van
 * had multiple drivers) that records an ooh_return_violations row.
 *
 * Renders nothing when the van wasn't an OOH return (fetch says isOoh=false),
 * so it's safe to mount unconditionally.
 *
 * Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.
 */
import { useEffect, useState } from 'react';
import { api } from '../services/api';

interface VanDriver {
  assignmentId: string;
  driverId: string | null;
  driverName: string | null;
  submitted: boolean;
  blocked: boolean;
}
interface Ctx {
  isOoh: boolean;
  jobId?: string;
  vehicleId?: string;
  drivers: VanDriver[];
  threshold: number;
}

export default function OohCheckInPrompt({
  reg,
  hhJobNumber,
}: {
  reg: string;
  hhJobNumber: number | null;
}) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [stepsFollowed, setStepsFollowed] = useState(true);
  const [severity, setSeverity] = useState<'serious' | 'minor'>('serious');
  const [driverId, setDriverId] = useState<string>(''); // '' = whole hire / not sure
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    blockSuggested: boolean;
    count: number;
    threshold: number;
    driverName: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ reg });
        if (hhJobNumber != null) params.set('hh_job_number', String(hhJobNumber));
        const res = await api.get<{ data: Ctx }>(`/ooh-return/check-in-context?${params.toString()}`);
        if (cancelled) return;
        setCtx(res.data);
        const ds = res.data.drivers;
        const submitter = ds.find(d => d.submitted && d.driverId);
        if (submitter?.driverId) setDriverId(submitter.driverId);
        else if (ds.length === 1 && ds[0].driverId) setDriverId(ds[0].driverId);
      } catch {
        /* swallow — the prompt just won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reg, hhJobNumber]);

  if (!ctx || !ctx.isOoh) return null;

  async function flag() {
    if (!ctx) return;
    setSubmitting(true);
    setError('');
    try {
      const type = severity === 'serious' ? 'parked_blocking' : 'left_without_telling_us';
      const res = await api.post<{
        data: { blockSuggested: boolean; driverViolationCount: number; threshold: number; driverId: string | null };
      }>('/ooh-return/violations', {
        reg,
        hh_job_number: hhJobNumber ?? undefined,
        type,
        severity,
        driver_id: driverId || undefined,
        notes: notes.trim() || undefined,
      });
      const driverName = ctx.drivers.find(d => d.driverId === res.data.driverId)?.driverName ?? null;
      setResult({
        blockSuggested: res.data.blockSuggested,
        count: res.data.driverViolationCount,
        threshold: res.data.threshold,
        driverName,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log');
    } finally {
      setSubmitting(false);
    }
  }

  // Logged confirmation
  if (result) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
        <p className="font-medium text-amber-900">⚠️ Parking issue logged for this OOH return.</p>
        {result.driverName ? (
          <p className="mt-1 text-amber-800">
            Recorded against <strong>{result.driverName}</strong> ({result.count} on record).
          </p>
        ) : (
          <p className="mt-1 text-amber-800">
            Recorded against the hire (no single driver attributed).
          </p>
        )}
        {result.blockSuggested && (
          <p className="mt-2 rounded bg-red-100 border border-red-200 p-2 text-red-800">
            🚫 {result.driverName || 'This driver'} has now reached {result.count} incidents
            (threshold {result.threshold}). Consider blocking them from OOH returns on their
            driver page.
          </p>
        )}
      </div>
    );
  }

  const multipleDrivers = ctx.drivers.filter(d => d.driverId).length > 1;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-sm font-medium text-gray-900">🌙 Out-of-hours return</p>
      <label className="mt-2 flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={stepsFollowed}
          onChange={e => setStepsFollowed(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-gray-700">
          OOH steps followed — parked considerately, didn't block the gates.
          <span className="block text-xs text-gray-400 mt-0.5">Untick to flag a problem.</span>
        </span>
      </label>

      {!stepsFollowed && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">What happened?</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setSeverity('serious')}
                className={`text-left px-3 py-2 text-sm rounded-lg border ${
                  severity === 'serious'
                    ? 'border-red-400 bg-red-50 text-red-800'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Parked badly / blocked access
              </button>
              <button
                type="button"
                onClick={() => setSeverity('minor')}
                className={`text-left px-3 py-2 text-sm rounded-lg border ${
                  severity === 'minor'
                    ? 'border-amber-400 bg-amber-50 text-amber-800'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Didn't tell us where they left it
              </button>
            </div>
          </div>

          {multipleDrivers && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Which driver?
              </label>
              <select
                value={driverId}
                onChange={e => setDriverId(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                {ctx.drivers
                  .filter(d => d.driverId)
                  .map(d => (
                    <option key={d.assignmentId} value={d.driverId as string}>
                      {d.driverName || 'Unnamed driver'}
                      {d.submitted ? ' (confirmed parking)' : ''}
                    </option>
                  ))}
                <option value="">Whole hire / not sure</option>
              </select>
            </div>
          )}

          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes (e.g. where it was left)…"
            rows={2}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm resize-y"
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="button"
            onClick={flag}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? 'Logging…' : 'Log parking issue'}
          </button>
        </div>
      )}
    </div>
  );
}
