'use client'

/**
 * Studio Sitter Shift Detail Page
 *
 * Route: /shift/[date]   (date = YYYY-MM-DD)
 *
 * One evening's detail for a rostered studio sitter — the whole-building night:
 * envelope times, the per-night fee, and who's in each room (with each job's
 * shared specs / stage plots). Read-only in this slice; the handover thread and
 * end-of-day lock-up report land in later slices.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

// =============================================================================
// TYPES (mirror the OP portal response)
// =============================================================================

interface SharedFile {
  name: string
  url: string
  fileType: string | null
}

interface ShiftJob {
  job_id: string
  hh_job_number: number | null
  label: string
  rooms: string[]
  files?: SharedFile[]
}

interface ShiftDetail {
  success: boolean
  date: string
  planned_start: string | null
  planned_end: string | null
  status: string
  fee: number | null
  assignment_status: string | null
  jobs: ShiftJob[]
  error?: string
}

// =============================================================================
// HELPERS
// =============================================================================

function formatLongDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (isNaN(date.getTime())) return dateStr
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`
}

/** SQL TIME ("17:00:00" / "17:00") → "5:00pm". Returns '' for null/unparseable. */
function formatTime(timeStr: string | null): string {
  if (!timeStr) return ''
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match) return ''
  const hours = parseInt(match[1], 10)
  const minutes = match[2]
  const ampm = hours >= 12 ? 'pm' : 'am'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes}${ampm}`
}

function formatEnvelope(start: string | null, end: string | null): string | null {
  const s = formatTime(start)
  const e = formatTime(end)
  if (s && e) return `${s} – ${e}`
  if (s) return `from ${s}`
  if (e) return `until ${e}`
  return null
}

function formatFee(amount: number | null): string {
  if (amount === null || amount === undefined) return ''
  return `£${amount.toFixed(0)}`
}

function fileIcon(fileType: string | null): string {
  const t = (fileType || '').toLowerCase()
  if (t.includes('pdf')) return '📄'
  if (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg')) return '🖼️'
  return '📎'
}

// =============================================================================
// PAGE
// =============================================================================

export default function ShiftDetailPage() {
  const params = useParams()
  const router = useRouter()
  const date = String(params?.date || '')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shift, setShift] = useState<ShiftDetail | null>(null)

  const fetchShift = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}`)
      const data: ShiftDetail = await response.json()
      if (!response.ok || !data.success) {
        if (response.status === 401) {
          router.push('/login')
          return
        }
        throw new Error(data.error || 'Failed to load shift')
      }
      setShift(data)
    } catch (err) {
      console.error('Failed to fetch shift:', err)
      setError(err instanceof Error ? err.message : 'Failed to load shift')
    } finally {
      setLoading(false)
    }
  }, [date, router])

  useEffect(() => {
    if (date) fetchShift()
  }, [date, fetchShift])

  const envelope = shift ? formatEnvelope(shift.planned_start, shift.planned_end) : null
  const isConfirmed = shift?.assignment_status === 'confirmed'

  return (
    <div className="min-h-screen bg-gray-50 safe-top safe-bottom pb-10">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href="/dashboard"
            className="p-2 -ml-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            title="Back to dashboard"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-xl">🎸</span>
            <h1 className="text-lg font-semibold text-gray-900">Studio Shift</h1>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button onClick={fetchShift} className="ml-2 underline hover:no-underline">
              Try again
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          </div>
        ) : shift ? (
          <>
            {/* Overview card */}
            <section className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-base font-semibold text-gray-900">{formatLongDate(shift.date)}</p>
                  {envelope && <p className="text-sm text-gray-500 mt-0.5">{envelope}</p>}
                </div>
                {shift.fee !== null && (
                  <span className="text-lg font-semibold text-green-600">{formatFee(shift.fee)}</span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span
                  className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
                    isConfirmed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {isConfirmed ? 'Confirmed' : 'Assigned'}
                </span>
              </div>
              <p className="mt-4 text-xs text-gray-500 leading-relaxed">
                You&apos;re looking after the band(s) below for the evening and locking up the whole
                building at the end of the night.
              </p>
            </section>

            {/* Who's in tonight */}
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Who&apos;s in tonight
              </h2>
              {shift.jobs.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-100 p-4 text-center text-sm text-gray-500">
                  No rooms booked for this evening yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {shift.jobs.map((job) => (
                    <div key={job.job_id} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-gray-900">{job.label}</p>
                        {job.hh_job_number && (
                          <span className="text-xs text-gray-400 shrink-0">#{job.hh_job_number}</span>
                        )}
                      </div>
                      {job.rooms.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {job.rooms.map((room) => (
                            <span
                              key={room}
                              className="inline-block text-xs px-2 py-0.5 rounded-full bg-ooosh-50 text-ooosh-700 border border-ooosh-100"
                            >
                              {room}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Shared specs / stage plots */}
                      {job.files && job.files.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <p className="text-xs font-medium text-gray-500 mb-2">Shared files</p>
                          <div className="space-y-1.5">
                            {job.files.map((file, idx) => (
                              <a
                                key={`${job.job_id}-${idx}`}
                                href={file.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-sm text-ooosh-600 hover:text-ooosh-500"
                              >
                                <span>{fileIcon(file.fileType)}</span>
                                <span className="truncate">{file.name}</span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
