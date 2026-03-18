/**
 * FuelHistoryTab — fuel fill records + stats for a vehicle.
 */

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchFuelLog, createFuelRecord, deleteFuelRecord } from '../../lib/fuel-log-api'

interface Props {
  vehicleId: string
  currentMileage?: number | null
}

export default function FuelHistoryTab({ vehicleId, currentMileage }: Props) {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const queryKey = ['vehicle-fuel-log', vehicleId]
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchFuelLog(vehicleId, { limit: 100 }),
  })

  const handleSave = useCallback(async (params: {
    date: string; litres?: number | null; cost: number;
    mileage_at_fill?: number | null; full_tank?: boolean; notes?: string | null
  }) => {
    await createFuelRecord(vehicleId, params)
    await queryClient.invalidateQueries({ queryKey: ['vehicle-fuel-log', vehicleId] })
    // Also refresh mileage if provided
    if (params.mileage_at_fill) {
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    }
  }, [vehicleId, queryClient])

  const handleDelete = useCallback(async (fuelId: string) => {
    if (!confirm('Delete this fuel record?')) return
    setDeletingId(fuelId)
    try {
      await deleteFuelRecord(vehicleId, fuelId)
      await queryClient.invalidateQueries({ queryKey: ['vehicle-fuel-log', vehicleId] })
    } catch (err) {
      console.error('[FuelHistoryTab] Delete error:', err)
    } finally {
      setDeletingId(null)
    }
  }, [vehicleId, queryClient])

  const records = data?.data || []
  const stats = data?.stats

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Fuel Log</h3>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white hover:bg-opacity-90"
        >
          + Add Fuel
        </button>
      </div>

      {/* Stats summary */}
      {stats && stats.fillCount > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label="Total Fuel Cost" value={`\u00A3${stats.totalCost.toFixed(2)}`} />
          <StatCard label="Total Litres" value={stats.totalLitres.toFixed(1)} />
          <StatCard label="Fill Count" value={String(stats.fillCount)} />
          <StatCard label="Cost/Mile" value={stats.costPerMile != null ? `\u00A3${stats.costPerMile.toFixed(2)}` : '—'} />
        </div>
      )}

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading fuel records...</div>}
      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">Failed to load fuel records</div>}

      {!isLoading && !error && records.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-200 py-8 text-center">
          <p className="text-sm text-gray-400">No fuel records yet</p>
        </div>
      )}

      {records.map(record => (
        <div key={record.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">
                {'\u00A3'}{record.cost.toFixed(2)}
              </span>
              {record.litres != null && (
                <span className="text-xs text-gray-400">{record.litres}L</span>
              )}
              {record.fullTank && (
                <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-bold text-green-700">FULL</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              {record.date && <span>{formatDisplayDate(record.date)}</span>}
              {record.mileageAtFill != null && <span>· {record.mileageAtFill.toLocaleString()} mi</span>}
              {record.notes && <span>· {record.notes}</span>}
            </div>
          </div>
          <button
            type="button"
            disabled={deletingId === record.id}
            onClick={() => handleDelete(record.id)}
            className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      {/* Add fuel form */}
      {showForm && (
        <FuelForm
          currentMileage={currentMileage}
          onSave={async (params) => { await handleSave(params); setShowForm(false) }}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-[10px] font-medium text-gray-400">{label}</p>
    </div>
  )
}

function FuelForm({
  currentMileage,
  onSave,
  onClose,
}: {
  currentMileage?: number | null
  onSave: (params: { date: string; litres?: number | null; cost: number; mileage_at_fill?: number | null; full_tank?: boolean; notes?: string | null }) => Promise<void>
  onClose: () => void
}) {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]!)
  const [litres, setLitres] = useState('')
  const [cost, setCost] = useState('')
  const [mileage, setMileage] = useState('')
  const [fullTank, setFullTank] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!cost || !date) { setError('Date and cost required'); return }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        date,
        litres: litres ? parseFloat(litres) : null,
        cost: parseFloat(cost),
        mileage_at_fill: mileage ? parseInt(mileage, 10) : null,
        full_tank: fullTank,
        notes: notes.trim() || null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Add Fuel Record</h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:bg-gray-100">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Date *</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Cost ({'\u00A3'}) *</label>
              <input type="number" step="0.01" min="0" value={cost} onChange={e => setCost(e.target.value)}
                placeholder="0.00" autoFocus
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Litres</label>
              <input type="number" step="0.1" min="0" value={litres} onChange={e => setLitres(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Mileage</label>
              <input type="number" min="0" value={mileage} onChange={e => setMileage(e.target.value)}
                placeholder={currentMileage ? `Current: ${currentMileage.toLocaleString()}` : 'Optional'}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
            </div>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={fullTank} onChange={e => setFullTank(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600" />
            <span className="text-sm text-gray-600">Full tank fill</span>
          </label>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Notes</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-sm font-medium text-white hover:bg-opacity-90 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function formatDisplayDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return dateStr }
}
