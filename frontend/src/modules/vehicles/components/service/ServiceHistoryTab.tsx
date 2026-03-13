/**
 * ServiceHistoryTab — displays service, MOT, repair, insurance, and tax records
 * for a vehicle. Includes filtering, add/edit forms, and (future) AI extraction.
 */

import { useState, useCallback, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchServiceLog,
  createServiceLogRecord,
  updateServiceLogRecord,
  deleteServiceLogRecord,
  uploadServiceLogFile,
  deleteServiceLogFile,
} from '../../lib/service-log-api'
import { getAuthHeaders } from '../../config/api-config'
import type { ServiceType, ServiceLogRecord, CreateServiceLogParams } from '../../lib/service-log-api'
import ServiceRecordForm from './ServiceRecordForm'
import type { StagedFile } from './ServiceRecordForm'

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
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)
  const [deletingFileKey, setDeletingFileKey] = useState<string | null>(null)
  // Comment input for attaching files to existing records
  const [attachComment, setAttachComment] = useState('')
  const [showAttachComment, setShowAttachComment] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<string | null>(null)

  const queryKey = ['vehicle-service-log', vehicleId, filter]
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchServiceLog(vehicleId, {
      type: filter === 'all' ? undefined : filter,
      limit: 100,
    }),
  })

  const handleSave = useCallback(async (params: CreateServiceLogParams, stagedFiles?: StagedFile[]) => {
    if (editing) {
      await updateServiceLogRecord(vehicleId, editing.id, params)
    } else {
      const created = await createServiceLogRecord(vehicleId, params)
      // Upload staged files sequentially after record creation
      if (stagedFiles && stagedFiles.length > 0) {
        for (const sf of stagedFiles) {
          await uploadServiceLogFile(vehicleId, created.id, sf.file, sf.comment || undefined)
        }
      }
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

  const handleFileUpload = useCallback(async (logId: string, file: File, comment?: string) => {
    setUploadingFor(logId)
    try {
      await uploadServiceLogFile(vehicleId, logId, file, comment)
      await queryClient.invalidateQueries({ queryKey: ['vehicle-service-log', vehicleId] })
    } catch (err) {
      console.error('[ServiceHistoryTab] File upload error:', err)
      alert(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploadingFor(null)
      setShowAttachComment(null)
      setAttachComment('')
    }
  }, [vehicleId, queryClient])

  const handleFileDelete = useCallback(async (logId: string, key: string, fileName: string) => {
    if (!confirm(`Delete file "${fileName}"?`)) return
    setDeletingFileKey(key)
    try {
      await deleteServiceLogFile(vehicleId, logId, key)
      await queryClient.invalidateQueries({ queryKey: ['vehicle-service-log', vehicleId] })
    } catch (err) {
      console.error('[ServiceHistoryTab] File delete error:', err)
    } finally {
      setDeletingFileKey(null)
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
              {/* Date */}
              {record.serviceDate && (
                <span className="shrink-0 text-xs font-medium text-gray-400 tabular-nums">
                  {formatShortDate(record.serviceDate)}
                </span>
              )}

              {/* Type badge */}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${TYPE_BADGE_COLORS[record.serviceType] || TYPE_BADGE_COLORS.other}`}>
                {record.serviceType}
              </span>

              {/* Name + garage */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{record.name}</p>
                {record.garage && (
                  <p className="truncate text-xs text-gray-400">{record.garage}</p>
                )}
              </div>

              {/* Cost */}
              {record.cost != null && (
                <span className="shrink-0 text-sm font-semibold text-gray-700">
                  {'\u00A3'}{record.cost.toFixed(2)}
                </span>
              )}

              {/* File count indicator */}
              {record.files?.length > 0 && (
                <span className="shrink-0 text-[10px] text-gray-400" title={`${record.files.length} file${record.files.length > 1 ? 's' : ''}`}>
                  {'\uD83D\uDCCE'}{record.files.length}
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
                {/* Files section */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-400">
                      Files {record.files?.length ? `(${record.files.length})` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={uploadingFor === record.id}
                      onClick={() => {
                        setShowAttachComment(record.id)
                        setAttachComment('')
                      }}
                      className="text-[11px] font-medium text-blue-600 hover:underline disabled:opacity-50"
                    >
                      {uploadingFor === record.id ? 'Uploading...' : '+ Attach file'}
                    </button>
                  </div>
                  {/* Inline attach comment input */}
                  {showAttachComment === record.id && (
                    <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50/50 p-2 space-y-1.5">
                      <input
                        type="text"
                        value={attachComment}
                        onChange={e => setAttachComment(e.target.value)}
                        placeholder="Comment (optional) — e.g. MOT certificate, invoice"
                        className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
                        autoFocus
                      />
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            uploadTargetRef.current = record.id
                            fileInputRef.current?.click()
                          }}
                          className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
                        >
                          Choose file
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowAttachComment(null); setAttachComment('') }}
                          className="rounded px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {record.files && record.files.length > 0 ? (
                    <div className="space-y-1">
                      {record.files.map((f, i) => (
                        <div key={i} className="rounded bg-gray-50 px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs">
                              {f.type === 'image' ? '\uD83D\uDDBC\uFE0F' : f.type === 'document' ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}
                            </span>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const res = await fetch(`/api/files/download?key=${encodeURIComponent(f.url)}`, {
                                    headers: getAuthHeaders(),
                                  })
                                  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
                                  const blob = await res.blob()
                                  const contentType = res.headers.get('Content-Type') || ''
                                  // Images and PDFs: open in new tab for viewing
                                  if (contentType.startsWith('image/') || contentType === 'application/pdf') {
                                    const url = URL.createObjectURL(blob)
                                    window.open(url, '_blank')
                                    setTimeout(() => URL.revokeObjectURL(url), 60000)
                                  } else {
                                    // Other files: trigger download
                                    const url = URL.createObjectURL(blob)
                                    const a = document.createElement('a')
                                    a.href = url
                                    a.download = f.name
                                    a.click()
                                    URL.revokeObjectURL(url)
                                  }
                                } catch (err) {
                                  alert(err instanceof Error ? err.message : 'Failed to open file')
                                }
                              }}
                              className="min-w-0 flex-1 truncate text-xs text-blue-600 hover:underline text-left"
                            >
                              {f.name}
                            </button>
                            {f.size != null && (
                              <span className="shrink-0 text-[10px] text-gray-400">
                                {f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(0)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={deletingFileKey === f.url}
                              onClick={() => handleFileDelete(record.id, f.url, f.name)}
                              className="shrink-0 rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                              title="Delete file"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                          {f.comment && (
                            <p className="mt-0.5 ml-5 text-[11px] text-gray-500 italic">{f.comment}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    showAttachComment !== record.id && (
                      <p className="text-xs text-gray-300">No files attached</p>
                    )
                  )}
                </div>

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
                  <span className="ml-auto text-[10px] text-gray-300">
                    {record.createdByName && `by ${record.createdByName}`}
                    {record.createdByName && record.createdAt && ' · '}
                    {record.createdAt && formatDisplayDate(record.createdAt.split('T')[0]!)}
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          const logId = uploadTargetRef.current
          if (file && logId) {
            await handleFileUpload(logId, file, attachComment || undefined)
          }
          e.target.value = '' // reset so same file can be re-selected
          uploadTargetRef.current = null
        }}
      />

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

function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  } catch {
    return dateStr
  }
}

function formatDisplayDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}
