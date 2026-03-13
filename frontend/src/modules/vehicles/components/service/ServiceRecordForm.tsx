/**
 * ServiceRecordForm — create/edit form for service, MOT, repair, insurance, tax records.
 *
 * Two modes: "manual" entry and (future) "AI extract" from uploaded document.
 * Opens as a slide-up panel on mobile / modal on desktop.
 */

import { useState } from 'react'
import type { ServiceType, CreateServiceLogParams, ServiceLogRecord } from '../../lib/service-log-api'

const SERVICE_TYPES: { value: ServiceType; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'repair', label: 'Repair' },
  { value: 'mot', label: 'MOT' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'tax', label: 'Tax' },
  { value: 'tyre', label: 'Tyres' },
  { value: 'other', label: 'Other' },
]

const STATUS_OPTIONS = ['Done', 'Pending', 'Booked', 'Cancelled']

interface Props {
  vehicleId: string
  currentMileage?: number | null
  editing?: ServiceLogRecord | null
  onSave: (params: CreateServiceLogParams) => Promise<void>
  onClose: () => void
}

export default function ServiceRecordForm({ currentMileage, editing, onSave, onClose }: Props) {
  const [serviceType, setServiceType] = useState<ServiceType>(editing?.serviceType as ServiceType || 'service')
  const [name, setName] = useState(editing?.name || '')
  const [serviceDate, setServiceDate] = useState(editing?.serviceDate || new Date().toISOString().split('T')[0]!)
  const [mileage, setMileage] = useState(editing?.mileage?.toString() || '')
  const [cost, setCost] = useState(editing?.cost?.toString() || '')
  const [status, setStatus] = useState(editing?.status || 'Done')
  const [garage, setGarage] = useState(editing?.garage || '')
  const [hirehopJob, setHirehopJob] = useState(editing?.hirehopJob || '')
  const [notes, setNotes] = useState(editing?.notes || '')
  const [nextDueDate, setNextDueDate] = useState(editing?.nextDueDate || '')
  const [nextDueMileage, setNextDueMileage] = useState(editing?.nextDueMileage?.toString() || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mileage sanity check — warn if lower than current (for service records, don't block)
  const mileageNum = mileage ? parseInt(mileage, 10) : null
  const mileageWarning = mileageNum && currentMileage && mileageNum < currentMileage
    ? `Current mileage is ${currentMileage.toLocaleString()}. This entry is ${(currentMileage - mileageNum).toLocaleString()} miles lower — is this a backdated record?`
    : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Description is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave({
        name: name.trim(),
        service_type: serviceType,
        service_date: serviceDate || null,
        mileage: mileageNum,
        cost: cost ? parseFloat(cost) : null,
        status,
        garage: garage.trim() || null,
        hirehop_job: hirehopJob.trim() || null,
        notes: notes.trim() || null,
        next_due_date: nextDueDate || null,
        next_due_mileage: nextDueMileage ? parseInt(nextDueMileage, 10) : null,
        files: editing?.files || [],
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">
            {editing ? 'Edit Record' : 'Add Service Record'}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Type */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Type</label>
            <div className="flex flex-wrap gap-1.5">
              {SERVICE_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setServiceType(t.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    serviceType === t.value
                      ? 'bg-ooosh-navy text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Description *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Annual service, MOT pass, Front tyre replacement"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              autoFocus
            />
          </div>

          {/* Date + Cost row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Date</label>
              <input
                type="date"
                value={serviceDate}
                onChange={e => setServiceDate(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Cost ({'\u00A3'})</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={cost}
                onChange={e => setCost(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Mileage */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Mileage at time of work</label>
            <input
              type="number"
              min="0"
              value={mileage}
              onChange={e => setMileage(e.target.value)}
              placeholder={currentMileage ? `Current: ${currentMileage.toLocaleString()}` : 'Odometer reading'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
            />
            {mileageWarning && (
              <p className="mt-1 text-xs text-amber-600">{mileageWarning}</p>
            )}
          </div>

          {/* Garage + Status row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Garage / Workshop</label>
              <input
                type="text"
                value={garage}
                onChange={e => setGarage(e.target.value)}
                placeholder="e.g. Kwik Fit Wandsworth"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              >
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Next due (conditional on type) */}
          {(serviceType === 'mot' || serviceType === 'service' || serviceType === 'insurance' || serviceType === 'tax') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Next Due Date</label>
                <input
                  type="date"
                  value={nextDueDate}
                  onChange={e => setNextDueDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>
              {serviceType === 'service' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Next Due Mileage</label>
                  <input
                    type="number"
                    min="0"
                    value={nextDueMileage}
                    onChange={e => setNextDueMileage(e.target.value)}
                    placeholder="e.g. 120000"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* HireHop ref */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">HireHop Job #</label>
            <input
              type="text"
              value={hirehopJob}
              onChange={e => setHirehopJob(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional details..."
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-sm font-medium text-white hover:bg-opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editing ? 'Update' : 'Save Record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
