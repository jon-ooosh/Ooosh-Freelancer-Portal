/**
 * "GPS Tracker" row on the vehicle page — which numbered tracker is in this
 * van, from the register (Fleet Map › Trackers is where the rest lives).
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../../config/route-paths'
import { useGpsTrackers, useRefreshTrackers } from '../../hooks/useGpsTrackers'
import { fitTracker, removeTracker } from '../../lib/gps-trackers-api'

export function VehicleTrackerRow({ vehicleId }: { vehicleId: string }) {
  const { data: trackers, isLoading } = useGpsTrackers()
  const refresh = useRefreshTrackers()
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const fitted = trackers?.find(t => t.vehicleId === vehicleId) || null
  const spares = (trackers || []).filter(t => !t.vehicleId && t.status === 'active')

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
      setEditing(false)
      setChoice('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-gray-100 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">GPS Tracker</span>
        {editing ? (
          <div className="flex items-center gap-2">
            {fitted ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => removeTracker(fitted.id))}
                className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                {busy ? '...' : `Take ${fitted.trackerNumber} out`}
              </button>
            ) : (
              <>
                <select
                  value={choice}
                  onChange={e => setChoice(e.target.value)}
                  className="rounded border border-gray-200 px-2 py-1 text-sm"
                >
                  <option value="">{spares.length ? 'Spare tracker…' : 'No spare trackers'}</option>
                  {spares.map(t => <option key={t.id} value={t.id}>{t.trackerNumber}</option>)}
                </select>
                <button
                  type="button"
                  disabled={busy || !choice}
                  onClick={() => act(() => fitTracker(choice, vehicleId))}
                  className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? '...' : 'Fit'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => { setEditing(false); setError('') }}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">
              {isLoading ? '…' : fitted ? `#${fitted.trackerNumber}` : 'Not fitted'}
            </span>
            {fitted?.fittedOn && <span className="text-xs text-gray-400">since {fitted.fittedOn}</span>}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              Edit
            </button>
          </div>
        )}
      </div>
      {editing && (
        <p className="mt-1 text-right text-[11px] text-gray-400">
          {fitted ? `Moving it to another van? ` : `Not on the list? `}
          <Link to={vmPath('/fleet-map?tab=trackers')} className="text-blue-600 hover:underline">Manage trackers →</Link>
        </p>
      )}
      {error && <p className="mt-1 text-right text-xs text-red-600">{error}</p>}
    </div>
  )
}
