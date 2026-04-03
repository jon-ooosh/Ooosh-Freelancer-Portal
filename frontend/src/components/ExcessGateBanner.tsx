/**
 * ExcessGateBanner — Warning banner shown on Job Detail and Book Out screens
 * when excess is pending for a vehicle assignment.
 *
 * Not a hard block — shows a prominent warning with option for manager override.
 */
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { OverrideReason } from '../../../shared/types';

interface ExcessBlocker {
  type: string;
  assignmentId: string;
  excessId?: string;
  driverName: string | null;
  vehicleReg: string | null;
  amountRequired: number | null;
  excessStatus?: string;
  dispatchOverride?: boolean;
}

interface ExcessGateBannerProps {
  blockers: ExcessBlocker[];
  onOverrideComplete?: () => void;
  onNavigateToRequirements?: () => void;
  clientId?: string; // Organisation UUID — used to look up client balance on account
}

const OVERRIDE_REASONS: { value: OverrideReason; label: string }[] = [
  { value: 'client_on_credit', label: 'Client on credit terms' },
  { value: 'pre_auth_to_follow', label: 'Pre-auth to follow' },
  { value: 'ooosh_staff_vehicle', label: 'Ooosh staff vehicle' },
  { value: 'balance_on_account', label: 'Client has balance on account' },
  { value: 'other', label: 'Other (specify)' },
];

export default function ExcessGateBanner({ blockers, onOverrideComplete, onNavigateToRequirements, clientId }: ExcessGateBannerProps) {
  const user = useAuthStore((s) => s.user);
  const canOverride = user?.role === 'admin' || user?.role === 'manager';

  const [showOverrideForm, setShowOverrideForm] = useState<string | null>(null); // excessId being overridden
  const [overrideReason, setOverrideReason] = useState<OverrideReason>('client_on_credit');
  const [overrideNotes, setOverrideNotes] = useState('');
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideError, setOverrideError] = useState('');

  // Client balance on account
  const [clientBalance, setClientBalance] = useState<number>(0);

  useEffect(() => {
    if (!clientId) return;
    // Look up client balance using the org's xero_contact_id (via external_id_map)
    api.get<{ data: any[] }>(`/excess?xero_contact_id=${clientId}&status=rolled_over&limit=1`)
      .catch(() => null); // Non-essential, fail silently

    // Try the by-org endpoint which sums across all excess records for this org
    api.get<{ summary: { balance_held: number } }>(`/excess/by-org/${clientId}`)
      .then((res) => {
        const balance = res.summary?.balance_held || 0;
        if (balance > 0) setClientBalance(balance);
      })
      .catch(() => {}); // Non-essential
  }, [clientId]);

  // Filter to only excess-related blockers that haven't been overridden
  const excessBlockers = blockers.filter(
    (b) => b.type === 'excess_pending' && !b.dispatchOverride
  );

  if (excessBlockers.length === 0) return null;

  async function handleOverride(excessId: string) {
    if (overrideReason === 'other' && !overrideNotes.trim()) {
      setOverrideError('Please provide details for the override');
      return;
    }

    setOverrideLoading(true);
    setOverrideError('');
    try {
      await api.post(`/excess/${excessId}/override`, {
        reason: overrideReason,
        notes: overrideReason === 'other' ? overrideNotes : undefined,
      });
      setShowOverrideForm(null);
      setOverrideNotes('');
      onOverrideComplete?.();
    } catch (err: any) {
      setOverrideError(err.message || 'Failed to record override');
    } finally {
      setOverrideLoading(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-800">
            Insurance Excess Not Collected
          </h3>
          <div className="mt-2 space-y-2">
            {excessBlockers.map((blocker) => (
              <div key={blocker.assignmentId} className="flex items-center justify-between gap-4">
                <p className="text-sm text-amber-700">
                  <span className="font-medium">{blocker.driverName || 'Unknown driver'}</span>
                  {blocker.vehicleReg && <span> on {blocker.vehicleReg}</span>}
                  {blocker.amountRequired != null && (
                    <span> — <span className="font-semibold">£{Number(blocker.amountRequired).toFixed(2)}</span> pending</span>
                  )}
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canOverride && blocker.excessId && showOverrideForm !== blocker.excessId && (
                    <button
                      onClick={() => setShowOverrideForm(blocker.excessId!)}
                      className="text-xs font-medium text-amber-700 hover:text-amber-900 underline"
                    >
                      Override
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {clientBalance > 0 && (
            <div className="mt-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md">
              <p className="text-xs text-green-800">
                <span className="font-semibold">Client has £{clientBalance.toFixed(2)} on account</span> from previous hires — this can be applied against excess.
              </p>
            </div>
          )}

          {onNavigateToRequirements && (
            <button
              onClick={onNavigateToRequirements}
              className="mt-2 text-xs font-medium text-amber-700 hover:text-amber-900 underline"
            >
              Go to Job Requirements
            </button>
          )}

          {/* Override form */}
          {showOverrideForm && (
            <div className="mt-3 rounded-md border border-amber-200 bg-white p-3">
              <p className="text-xs font-medium text-gray-700 mb-2">Manager Override — Proceed without excess</p>
              <select
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value as OverrideReason)}
                className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 mb-2"
              >
                {OVERRIDE_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {overrideReason === 'other' && (
                <input
                  type="text"
                  value={overrideNotes}
                  onChange={(e) => setOverrideNotes(e.target.value)}
                  placeholder="Provide details..."
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 mb-2"
                />
              )}
              {overrideError && (
                <p className="text-xs text-red-600 mb-2">{overrideError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => handleOverride(showOverrideForm)}
                  disabled={overrideLoading}
                  className="px-3 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50"
                >
                  {overrideLoading ? 'Saving...' : 'Confirm Override'}
                </button>
                <button
                  onClick={() => { setShowOverrideForm(null); setOverrideError(''); }}
                  className="px-3 py-1 text-xs font-medium text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
