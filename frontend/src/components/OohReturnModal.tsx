/**
 * Out-of-Hours Return modal — set / clear the return_overnight flag on a
 * vehicle hire assignment, optionally fire the info email.
 *
 * Opened from the moon pill on each Drivers & Vehicles assignment card.
 * Per-van logic — the email send touches every driver on the van (not
 * just the row clicked).
 */
import { useState } from 'react';
import { api } from '../services/api';

export interface OohReturnModalProps {
  assignmentId: string;
  vehicleReg: string;
  current: boolean | null;
  infoSentAt: string | null;
  driverEmails: string[];
  onClose: () => void;
  onSaved: () => void;
}

export default function OohReturnModal({
  assignmentId,
  vehicleReg,
  current,
  infoSentAt,
  driverEmails,
  onClose,
  onSaved,
}: OohReturnModalProps) {
  const [value, setValue] = useState<'yes' | 'no' | 'unset'>(
    current === true ? 'yes' : current === false ? 'no' : 'unset'
  );
  const [sendNow, setSendNow] = useState<boolean>(!infoSentAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Block enforcement: set when the toggle 409s because the driver is blocked.
  const [blocked, setBlocked] = useState<{ driverName: string | null; canOverride: boolean } | null>(null);

  async function handleSave(override = false) {
    setSaving(true);
    setError('');
    try {
      const body = {
        return_overnight: value === 'yes' ? true : value === 'no' ? false : null,
        send_email_now: value === 'yes' && sendNow,
        override: override || undefined,
      };
      await api.patch<{ success: boolean }>(`/ooh-return/assignments/${assignmentId}/toggle`, body);
      onSaved();
      onClose();
    } catch (err) {
      const e = err as { status?: number; code?: string; details?: { driverName?: string | null; canOverride?: boolean } };
      if (e.status === 409 && e.code === 'driver_blocked') {
        setBlocked({
          driverName: e.details?.driverName ?? null,
          canOverride: !!e.details?.canOverride,
        });
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            🌙 Out-of-Hours Return — {vehicleReg}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Per-van setting. Email goes to all drivers on this van.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Returning out of hours?
            </label>
            <div className="flex gap-2">
              {(['yes', 'no', 'unset'] as const).map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setValue(opt)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border ${
                    value === opt
                      ? 'border-ooosh-navy bg-ooosh-navy text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {opt === 'yes' ? 'Yes' : opt === 'no' ? 'No' : 'Not set'}
                </button>
              ))}
            </div>
          </div>

          {value === 'yes' && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-2">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendNow}
                  onChange={e => setSendNow(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-blue-900">
                  Send the OOH info email now
                  {infoSentAt && (
                    <span className="block text-xs text-blue-700 mt-0.5">
                      Last sent: {new Date(infoSentAt).toLocaleString('en-GB')}. Tick to resend.
                    </span>
                  )}
                </span>
              </label>
              {sendNow && driverEmails.length > 0 && (
                <p className="text-xs text-blue-700">
                  Will email: {driverEmails.join(', ')}
                </p>
              )}
              {sendNow && driverEmails.length === 0 && (
                <p className="text-xs text-amber-700">
                  No driver emails on file — email won't be sent. Add the driver email first.
                </p>
              )}
            </div>
          )}

          {blocked && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 space-y-2">
              <p className="font-medium">
                🚫 {blocked.driverName || 'This driver'} has lost OOH return privileges
                (repeated inconsiderate parking).
              </p>
              {blocked.canOverride ? (
                <p className="text-red-700">
                  As a manager you can override this for this hire. The block stays in place —
                  to lift it permanently, use the driver's page.
                </p>
              ) : (
                <p className="text-red-700">
                  Only a manager can override this. Otherwise, set this return to "No".
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-5 py-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          {blocked && blocked.canOverride ? (
            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={saving}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Override & allow OOH'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleSave(false)}
              disabled={saving}
              className="px-4 py-2 text-sm bg-ooosh-navy text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
