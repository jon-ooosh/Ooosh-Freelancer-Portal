import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface DriverLite {
  id: string;
  full_name: string;
  calculated_excess_amount: number | string | null;
  calculated_excess_basis: string | null;
  excess_locked: boolean;
}

interface Props {
  driver: DriverLite;
  onClose: () => void;
  onSaved: (updated: DriverLite) => void;
}

/**
 * Inline modal for editing a driver's individual excess liability
 * (drivers.calculated_excess_amount). This is the SOURCE OF TRUTH for the
 * /drivers display + the input to per-job excess calculation.
 *
 * Edits do NOT propagate to live job_excess records — staff bump per-job
 * excess on /money/excess if needed. Driver-level edits affect the next
 * job linkage only.
 *
 * Locking the value protects it from being overwritten when the driver
 * submits a future hire form (use for insurer-imposed manual overrides).
 */
export default function CalculatedExcessEditModal({ driver, onClose, onSaved }: Props) {
  const initialAmount = driver.calculated_excess_amount != null
    ? Number(driver.calculated_excess_amount).toFixed(2)
    : '';
  const [amount, setAmount] = useState<string>(initialAmount);
  const [basis, setBasis] = useState<string>(driver.calculated_excess_basis || '');
  const [locked, setLocked] = useState<boolean>(driver.excess_locked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Escape key closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setError('');
    const trimmed = amount.trim();
    let parsed: number | null = null;
    if (trimmed !== '') {
      const n = parseFloat(trimmed);
      if (isNaN(n) || n < 0) {
        setError('Amount must be a positive number, or empty to clear');
        return;
      }
      parsed = n;
    }

    setSaving(true);
    try {
      const res = await api.patch<{ data: DriverLite }>(
        `/drivers/${driver.id}/calculated-excess`,
        {
          calculated_excess_amount: parsed,
          calculated_excess_basis: basis.trim(),
          excess_locked: locked,
        }
      );
      onSaved(res.data);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h3 className="text-lg font-semibold">Edit Calculated Excess</h3>
          <p className="text-sm text-gray-500 mt-1">{driver.full_name}</p>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount (£)
            </label>
            <input
              type="number"
              min="0"
              step="50"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1200.00"
              className="w-full border rounded px-3 py-2 text-sm"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Standard floor is £1,200. Leave blank to clear (e.g. driver hasn't completed hire form).
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason / basis
            </label>
            <textarea
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              rows={2}
              placeholder="e.g. Standard £1,200 floor, or Insurer post-incident £1,800"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={locked}
                onChange={(e) => setLocked(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Lock this value</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Prevents future hire form submissions from auto-overwriting (use for insurer-imposed overrides).
                </span>
              </span>
            </label>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded text-xs">
            <strong>Note:</strong> This sets the driver's individual liability. Live job records are not auto-updated — edit per-job excess on the Money tab if needed.
          </div>
        </div>

        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
