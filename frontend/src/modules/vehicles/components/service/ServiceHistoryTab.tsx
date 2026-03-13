/**
 * ServiceHistoryTab — displays service, MOT, repair, insurance, and tax records
 * for a vehicle. Includes filtering, add/edit forms, and (future) AI extraction.
 */

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchServiceLog,
  createServiceLogRecord,
  updateServiceLogRecord,
  deleteServiceLogRecord,
} from '../../lib/service-log-api'
import type { ServiceType, ServiceLogRecord, CreateServiceLogParams } from '../../lib/service-log-api'
import ServiceRecordForm from './ServiceRecordForm'

const FILTER_OPTIONS: { value: ServiceType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'service', label: 'Service' },
  { value: 'repair', label: 'Repair' },
  { value: 'mot', label: 'MOT' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'tax', label: 'Tax' },
  { value: 'tyre', label: 'Tyres' },
  { value: 'other', label: 'Other' },
]

const TYPE_BADGE_COLORS: Record<string, string> = {
  service: 'bg-blue-100 text-blue-700',
  repair: 'bg-red-100 text-red-700',
  mot: 'bg-green-100 text-green-700',
  insurance: 'bg-purple-100 text-purple-700',
  tax: 'bg-amber-100 text-amber-700',
  tyre: 'bg-orange-100 text-orange-700',
  other: 'bg-gray-100 text-gray-600',
}

interface Props {
  vehicleId: string
  currentMileage?: number | null
}

export default function ServiceHistoryTab({ vehicleId, currentMileage }: Props) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<ServiceType | 'all'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ServiceLogRecord | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const queryKey = ['vehicle-service-log', vehicleId, filter]
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchServiceLog(vehicleId, {
      type: filter === 'all' ? undefined : filter,
      limit: 100,
    }),
  })

  const handleSave = useCallback(async (params: CreateServiceLogParams) => {
    if (editing) {
      await updateServiceLogRecord(vehicleId, editing.id, params)
    } else {
      await createServiceLogRecord(vehicleId, params)
    }
    await queryClient.invalidateQueries({ queryKey: ['vehicle-service-log', vehicleId] })
  }, [vehicleId, editing, queryClient])

  const handleDelete = useCallback(async (logId: string) => {
    setDeletingId(logId)
    try {
      await deleteServiceLogRecord(vehicleId, logId)
      await queryClient.invalidateQueries({ queryKey: ['vehicle-service-log', vehicleId] })
    } catch (err) {
      console.error('[ServiceHistoryTab] Delete error:', err)
    } finally {
      setDeletingId(null)
    }
  }, [vehicleId, queryClient])

  const records = data?.data || []
  const total = data?.total || 0

  return (
    <div className="space-y-3">
      {/* Header + Add button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Service History {total > 0 && <span className="text-gray-400">({total})</span>}
        </h3>
        <button
          type="button"
          onClick={() => { setEditing(null); setShowForm(true) }}
          className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white hover:bg-opacity-90"
        >
          + Add Record
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_OPTIONS.map(f => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === f.value
                ? 'bg-ooosh-navy text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="py-8 text-center text-sm text-gray-400">Loading service records...</div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
          Failed to load service records: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && records.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-200 py-8 text-center">
          <p className="text-sm text-gray-400">No service records yet</p>
          <button
            type="button"
            onClick={() => { setEditing(null); setShowForm(true) }}
            className="mt-2 text-xs font-medium text-blue-600 hover:underline"
          >
            Add the first record
          </button>
        </div>
      )}

      {/* Records list */}
      {records.map(record => {
        const isExpanded = expandedId === record.id
        return (
          <div
            key={record.id}
            className="rounded-lg border border-gray-200 bg-white"
          >
            {/* Summary row */}
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : record.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              {/* Type badge */}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${TYPE_BADGE_COLORS[record.serviceType] || TYPE_BADGE_COLORS.other}`}>
                {record.serviceType}
              </span>

              {/* Name + date */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{record.name}</p>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  {record.serviceDate && <span>{formatDisplayDate(record.serviceDate)}</span>}
                  {record.garage && <span>· {record.garage}</span>}
                </div>
              </div>

              {/* Cost */}
              {record.cost != null && (
                <span className="shrink-0 text-sm font-semibold text-gray-700">
                  {'\u00A3'}{record.cost.toFixed(2)}
                </span>
              )}

              {/* Expand chevron */}
              <svg
                className={`h-4 w-4 shrink-0 text-gray-300 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Expanded details */}
            {isExpanded && (
              <div className="border-t border-gray-100 px-4 py-3 space-y-2">
                {record.mileage != null && (
                  <DetailRow label="Mileage" value={record.mileage.toLocaleString()} />
                )}
                {record.status && (
                  <DetailRow label="Status" value={record.status} />
                )}
                {record.hirehopJob && (
                  <DetailRow label="HireHop Job" value={`#${record.hirehopJob}`} />
                )}
                {record.nextDueDate && (
                  <DetailRow label="Next Due" value={formatDisplayDate(record.nextDueDate)} />
                )}
                {record.nextDueMileage != null && (
                  <DetailRow label="Next Due Mileage" value={record.nextDueMileage.toLocaleString()} />
                )}
                {record.notes && (
                  <div>
                    <span className="text-xs font-medium text-gray-400">Notes</span>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{record.notes}</p>
                  </div>
                )}
                {record.aiSummary && (
                  <div className="rounded-lg bg-blue-50 p-2">
                    <span className="text-[10px] font-bold uppercase text-blue-500">AI Summary</span>
                    <p className="text-xs text-blue-700">{record.aiSummary}</p>
                  </div>
                )}
                {record.files && record.files.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-gray-400">Files</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {record.files.map((f, i) => (
                        <a
                          key={i}
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs text-blue-600 hover:bg-gray-200"
                        >
                          {f.name}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* Edit / Delete actions */}
                <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={() => { setEditing(record); setShowForm(true) }}
                    className="rounded px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={deletingId === record.id}
                    onClick={() => {
                      if (confirm('Delete this service record?')) {
                        handleDelete(record.id)
                      }
                    }}
                    className="rounded px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
                  >
                    {deletingId === record.id ? 'Deleting...' : 'Delete'}
                  </button>
                  {record.createdAt && (
                    <span className="ml-auto text-[10px] text-gray-300">
                      Added {formatDisplayDate(record.createdAt.split('T')[0]!)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Form modal */}
      {showForm && (
        <ServiceRecordForm
          vehicleId={vehicleId}
          currentMileage={currentMileage}
          editing={editing}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditing(null) }}
        />
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <span className="text-sm text-gray-700">{value}</span>
    </div>
  )
}

function formatDisplayDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}
