/**
 * Add to Hire modal — link a mid-tour driver (hire form submitted but
 * no van) to one or more already-booked-out vans on the same job.
 *
 * Single-van job → checkbox pre-checked, just a confirmation step.
 * Multi-van job → multi-select picker.
 *
 * Backend: POST /api/hire-forms/:id/add-to-hire — updates the existing
 * assignment row for the first van, clones for any additional vans.
 * Each resulting assignment fires the standard post-book-out hook chain
 * (fresh hire agreement PDF + email per van).
 */
import { useState, useEffect } from 'react';
import { api } from '../services/api';

export interface AddToHireCandidate {
  vehicle_id: string;
  vehicle_reg: string;
  vehicle_type?: string | null;
  hire_end: string | null;
  return_overnight: boolean | null;
}

export interface AddToHireModalProps {
  assignmentId: string;
  driverName: string;
  driverEmail: string | null;
  candidates: AddToHireCandidate[];
  onClose: () => void;
  onSaved: () => void;
}

function fmtDate(d: string | null): string {
  if (!d) return 'TBC';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return 'TBC';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function AddToHireModal({
  assignmentId,
  driverName,
  driverEmail,
  candidates,
  onClose,
  onSaved,
}: AddToHireModalProps) {
  // Single-candidate case: auto-check. Multi-candidate: nothing checked
  // initially, force a deliberate pick.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    candidates.length === 1 ? new Set([candidates[0].vehicle_id]) : new Set()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Close on Escape — matches OohReturnModal / other modals
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  function toggle(vehicleId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      return next;
    });
  }

  async function handleSubmit() {
    if (selectedIds.size === 0) {
      setError('Pick at least one van.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post<{ data: unknown }>(
        `/hire-forms/${assignmentId}/add-to-hire`,
        { vehicle_ids: Array.from(selectedIds) }
      );
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add driver to hire';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  const selected = candidates.filter(c => selectedIds.has(c.vehicle_id));
  const isSingle = candidates.length === 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Add Driver to Hire</h2>
          <p className="text-sm text-gray-600 mt-1">
            {driverName}{driverEmail ? ` · ${driverEmail}` : ''}
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="text-sm text-gray-700">
            {isSingle ? (
              <>This van is currently out on the road. Adding the driver will set their hire start to <strong>now</strong> and email them the hire agreement PDF.</>
            ) : (
              <>Select the van(s) this driver is authorised to drive. The hire window for each van is inherited from the existing booking, and hire start is set to <strong>now</strong>.</>
            )}
          </div>

          <div className="space-y-2">
            {candidates.map(c => {
              const checked = selectedIds.has(c.vehicle_id);
              return (
                <label
                  key={c.vehicle_id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    checked ? 'border-ooosh-500 bg-ooosh-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(c.vehicle_id)}
                    disabled={saving}
                    className="mt-0.5 h-4 w-4 text-ooosh-600 rounded border-gray-300 focus:ring-ooosh-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900">
                      {c.vehicle_reg}
                      {c.vehicle_type ? <span className="text-gray-500 font-normal"> · {c.vehicle_type}</span> : null}
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      Hire ends: {fmtDate(c.hire_end)}
                      {c.return_overnight === true ? ' · 🌙 OOH return' : ''}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          {selected.length > 0 && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
              <div className="font-medium mb-1">What happens:</div>
              <ul className="list-disc list-inside space-y-0.5 text-blue-800">
                <li>Driver linked to {selected.map(s => s.vehicle_reg).join(', ')}</li>
                <li>Hire start set to now</li>
                <li>
                  {selected.length === 1 ? 'A hire agreement PDF' : `${selected.length} hire agreement PDFs (one per van)`} emailed to {driverEmail || 'driver / fallback contact'}
                </li>
                {selected.some(s => s.return_overnight === true) && (
                  <li>OOH return info email sent (van marked overnight)</li>
                )}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || selectedIds.size === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Adding…' : `Add to Hire${selectedIds.size > 1 ? ` (${selectedIds.size} vans)` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
