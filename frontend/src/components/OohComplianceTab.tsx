/**
 * Driver OOH compliance panel (Driver Detail → "OOH" tab).
 *
 * Shows the driver's block status + parking-violation history, and the
 * suggest-and-confirm controls: manager can apply a block once the threshold is
 * crossed; admin can lift a block (a considered "another chance" decision).
 * Staff can dismiss a mis-attributed violation.
 *
 * Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.
 */
import { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface Violation {
  id: string;
  occurredOn: string | null;
  type: string;
  severity: string;
  notes: string | null;
  dismissed: boolean;
  jobId: string | null;
  hhJobNumber: number | null;
  vehicleReg: string | null;
  loggedByName: string | null;
  createdAt: string;
}
interface Compliance {
  driverId: string;
  blocked: boolean;
  blockedAt: string | null;
  blockReason: string | null;
  violationCount: number;
  threshold: number;
  violations: Violation[];
}

const TYPE_LABELS: Record<string, string> = {
  parked_blocking: 'Parked badly / blocked access',
  parked_outside_yard: 'Parked outside yard',
  left_without_telling_us: "Didn't tell us where it was left",
  other: 'Other',
};

export default function OohComplianceTab({ driverId }: { driverId: string }) {
  const role = useAuthStore(s => s.user?.role);
  const isManager = role === 'admin' || role === 'manager' || role === 'weekend_manager';
  const isAdmin = role === 'admin';

  const [data, setData] = useState<Compliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [showBlockForm, setShowBlockForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<{ data: Compliance }>(`/ooh-return/drivers/${driverId}/compliance`);
      setData(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OOH compliance');
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    load();
  }, [load]);

  async function block() {
    setBusy(true);
    try {
      await api.post(`/ooh-return/drivers/${driverId}/block`, { reason: blockReason.trim() || null });
      setShowBlockForm(false);
      setBlockReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to block');
    } finally {
      setBusy(false);
    }
  }

  async function unblock() {
    if (!confirm('Lift this driver\'s OOH block? They\'ll be able to return out of hours again.')) return;
    setBusy(true);
    try {
      await api.post(`/ooh-return/drivers/${driverId}/unblock`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to lift block');
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(id: string) {
    const reason = prompt('Reason for dismissing this violation? (optional)') ?? '';
    setBusy(true);
    try {
      await api.patch(`/ooh-return/violations/${id}/dismiss`, { reason });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return null;

  const overThreshold = data.violationCount >= data.threshold;

  return (
    <div className="space-y-5">
      {/* Status banner */}
      {data.blocked ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">🚫 Blocked from out-of-hours returns</p>
          <p className="text-sm text-red-700 mt-1">
            Since {data.blockedAt ? new Date(data.blockedAt).toLocaleDateString('en-GB') : '—'}
            {data.blockReason ? ` · ${data.blockReason}` : ''}
          </p>
          {isAdmin && (
            <button
              onClick={unblock}
              disabled={busy}
              className="mt-3 px-4 py-2 text-sm border border-red-300 bg-white text-red-700 rounded-lg font-medium hover:bg-red-100 disabled:opacity-50"
            >
              Lift block
            </button>
          )}
          {!isAdmin && <p className="text-xs text-red-600 mt-2">Only an admin can lift a block.</p>}
        </div>
      ) : (
        <div
          className={`rounded-lg border p-4 ${
            overThreshold ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'
          }`}
        >
          <p className={`font-medium ${overThreshold ? 'text-amber-900' : 'text-gray-700'}`}>
            {data.violationCount} parking {data.violationCount === 1 ? 'incident' : 'incidents'} on record
            {' '}(block suggested at {data.threshold})
          </p>
          {overThreshold && isManager && !showBlockForm && (
            <button
              onClick={() => setShowBlockForm(true)}
              disabled={busy}
              className="mt-3 px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
            >
              Block from OOH returns
            </button>
          )}
          {overThreshold && !isManager && (
            <p className="text-xs text-amber-700 mt-2">A manager can block this driver from OOH returns.</p>
          )}
          {showBlockForm && (
            <div className="mt-3 space-y-2">
              <textarea
                value={blockReason}
                onChange={e => setBlockReason(e.target.value)}
                placeholder="Reason (optional) — e.g. repeated gate-blocking, spoke to them on…"
                rows={2}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm resize-y"
              />
              <div className="flex gap-2">
                <button
                  onClick={block}
                  disabled={busy}
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? 'Blocking…' : 'Confirm block'}
                </button>
                <button
                  onClick={() => { setShowBlockForm(false); setBlockReason(''); }}
                  disabled={busy}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Violation history */}
      {data.violations.length === 0 ? (
        <p className="text-sm text-gray-500">No OOH parking issues recorded.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">History</p>
          {data.violations.map(v => (
            <div
              key={v.id}
              className={`rounded-lg border p-3 ${
                v.dismissed ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {TYPE_LABELS[v.type] || v.type}
                    {v.severity === 'serious' && !v.dismissed && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">serious</span>
                    )}
                    {v.dismissed && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">dismissed</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {v.occurredOn ? new Date(v.occurredOn).toLocaleDateString('en-GB') : '—'}
                    {v.vehicleReg ? ` · ${v.vehicleReg}` : ''}
                    {v.hhJobNumber ? ` · job #${v.hhJobNumber}` : ''}
                    {v.loggedByName ? ` · by ${v.loggedByName}` : ''}
                  </p>
                  {v.notes && <p className="text-sm text-gray-600 mt-1">{v.notes}</p>}
                </div>
                {!v.dismissed && (
                  <button
                    onClick={() => dismiss(v.id)}
                    disabled={busy}
                    className="text-xs text-gray-400 hover:text-gray-600 shrink-0"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
