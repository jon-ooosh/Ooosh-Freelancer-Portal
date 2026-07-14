'use client'

/**
 * Studio Sitter Shift Detail Page
 *
 * Route: /shift/[date]   (date = YYYY-MM-DD)
 *
 * One evening's detail for a rostered studio sitter — the whole-building night:
 * envelope times, the per-night fee, who's in each room (with each job's shared
 * specs / stage plots), and the sitter ⇄ staff handover thread. The end-of-day
 * lock-up report lands in a later slice.
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

interface ThreadMessage {
  id: string
  content: string
  created_at: string
  author: string
  from_staff: boolean
  mine: boolean
  files: SharedFile[]
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

/** ISO timestamp → "Thu 10 Jul, 5:32pm" (short, for handover messages). */
function formatMessageTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const h = d.getHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  const hh = h % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}, ${hh}:${mm}${ampm}`
}

/** Render text with bare URLs turned into clickable links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-ooosh-600 hover:text-ooosh-500 underline break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function fileIcon(fileType: string | null): string {
  const t = (fileType || '').toLowerCase()
  if (t.includes('pdf')) return '📄'
  if (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg')) return '🖼️'
  return '📎'
}

function isImageFile(file: { name: string; fileType: string | null }): boolean {
  if ((file.fileType || '').toLowerCase().startsWith('image/')) return true
  return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name || '')
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

  // Handover thread
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<{ file: File; preview: string | null }[]>([])
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const fetchThread = useCallback(async () => {
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}/thread`)
      const data = await response.json()
      if (response.ok && data.success) {
        setMessages(data.messages || [])
      }
    } catch (err) {
      console.error('Failed to load handover notes:', err)
    }
  }, [date])

  const postNote = useCallback(async () => {
    const content = draft.trim()
    if ((!content && pendingFiles.length === 0) || posting) return
    setPosting(true)
    setPostError(null)
    try {
      // Always multipart (content + any files); the browser sets the boundary.
      const fd = new FormData()
      fd.append('content', content)
      pendingFiles.forEach((p) => fd.append('files', p.file, p.file.name))
      const response = await fetch(`/api/studio-sitter/shifts/${date}/thread`, {
        method: 'POST',
        body: fd,
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to post note')
      }
      setMessages((prev) => [...prev, data.message])
      setDraft('')
      pendingFiles.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview) })
      setPendingFiles([])
    } catch (err) {
      console.error('Failed to post note:', err)
      setPostError(err instanceof Error ? err.message : 'Failed to post note')
    } finally {
      setPosting(false)
    }
  }, [draft, pendingFiles, posting, date])

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
    if (date) {
      fetchShift()
      fetchThread()
    }
  }, [date, fetchShift, fetchThread])

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

            {/* Handover notes (sitter ⇄ staff thread) */}
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Handover notes
              </h2>
              <p className="text-xs text-gray-400 mb-3">
                Anything the next sitter or the office needs to know — jobs for tonight, money owed,
                things left undone.
              </p>

              {messages.length > 0 && (
                <div className="space-y-2 mb-3">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-xl border p-3 shadow-sm ${
                        m.from_staff
                          ? 'bg-ooosh-50 border-ooosh-100'
                          : 'bg-white border-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs font-semibold text-gray-700">
                          {m.mine ? 'You' : m.author}
                          {m.from_staff && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-ooosh-100 text-ooosh-700 font-medium uppercase tracking-wide">
                              Ooosh office
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-gray-400 shrink-0">
                          {formatMessageTime(m.created_at)}
                        </span>
                      </div>
                      {m.content && m.content !== '(attachment)' && (
                        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words"><Linkified text={m.content} /></p>
                      )}
                      {m.files && m.files.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {m.files.map((file, idx) => (
                            isImageFile(file) ? (
                              <a key={`${m.id}-${idx}`} href={file.url} target="_blank" rel="noopener noreferrer" className="block">
                                <img src={file.url} alt={file.name}
                                  className="max-w-[240px] max-h-[180px] rounded border border-gray-200 object-cover" />
                              </a>
                            ) : (
                              <a
                                key={`${m.id}-${idx}`}
                                href={file.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-sm text-ooosh-600 hover:text-ooosh-500"
                              >
                                <span>{fileIcon(file.fileType)}</span>
                                <span className="truncate">{file.name}</span>
                              </a>
                            )
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Composer */}
              <div className="bg-white rounded-xl border border-gray-100 p-3 shadow-sm">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add a note…"
                  rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-300 resize-y min-h-[64px]"
                />
                {pendingFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {pendingFiles.map((p, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-gray-200 bg-gray-50 text-xs text-gray-700">
                        {p.preview
                          ? <img src={p.preview} alt={p.file.name} className="w-6 h-6 object-cover rounded" />
                          : <span>📎</span>}
                        <span className="max-w-[140px] truncate">{p.file.name}</span>
                        <button type="button" onClick={() => setPendingFiles((prev) => {
                          const found = prev[idx]
                          if (found?.preview) URL.revokeObjectURL(found.preview)
                          return prev.filter((_, i) => i !== idx)
                        })}
                          className="hover:text-red-600" aria-label={`Remove ${p.file.name}`}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                {postError && <p className="text-xs text-red-600 mt-1">{postError}</p>}
                <div className="mt-2 flex justify-between items-center">
                  {/* Native <label> + visually-hidden (NOT display:none) input so
                      the file picker opens on mobile — iOS/Android silently ignore
                      a programmatic .click() on a display:none input. */}
                  <label className="text-sm px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 cursor-pointer">
                    📎 Attach
                    <input type="file" multiple accept="image/*,application/pdf" className="sr-only"
                      onChange={(e) => {
                        // Capture the FileList into a concrete array NOW — reading
                        // e.target.files inside the deferred setState updater would
                        // see it already emptied by the reset below.
                        const selected = e.target.files ? Array.from(e.target.files) : []
                        e.target.value = ''
                        if (selected.length) {
                          setPendingFiles((prev) => [
                            ...prev,
                            ...selected.map((f) => ({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null })),
                          ])
                        }
                      }} />
                  </label>
                  <button
                    onClick={postNote}
                    disabled={(!draft.trim() && pendingFiles.length === 0) || posting}
                    className="text-sm font-medium px-4 py-2 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {posting ? 'Posting…' : 'Post note'}
                  </button>
                </div>
              </div>
            </section>

            {/* Finish for the night → end-of-day lock-up report */}
            <section className="pt-2">
              <Link
                href={`/shift/${date}/lockup`}
                className="flex items-center justify-center gap-2 w-full text-sm font-semibold px-4 py-3 rounded-xl bg-ooosh-600 text-white hover:bg-ooosh-500 transition-colors shadow-sm"
              >
                🔒 Finish for the night
              </Link>
              <p className="mt-2 text-center text-xs text-gray-400">
                Quick lock-up checklist before you leave.
              </p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
