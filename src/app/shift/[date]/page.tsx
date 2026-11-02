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

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ShoppingCart, FileText, Image as ImageIcon, Paperclip, ChevronDown, Lock, X } from 'lucide-react'
import FreelancerTaskList from '@/components/FreelancerTaskList'
import type { PortalFreelancerTask } from '@/lib/op-api'
import { cls, IconTile, BackLink, Chevron, SectionLabel, Banner, Chip, ICON } from '@/components/ui'
import { ukToday } from '@/lib/ukDate'

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
  tasks?: PortalFreelancerTask[]
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

interface RecentNight {
  date: string
  entries: ThreadMessage[]
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
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-hf-link hover:text-hf-link-hover underline break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function FileIcon({ fileType, size = 18 }: { fileType: string | null; size?: number }) {
  const t = (fileType || '').toLowerCase()
  const Icon = t.includes('pdf') ? FileText
    : (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg')) ? ImageIcon
    : Paperclip
  return <Icon size={size} strokeWidth={1.8} className="flex-none" />
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

  // The typed note survives a refresh, a dropped connection or leaving the page
  // (a sitter once lost a note by tapping "Finish for the night" without
  // posting it). Per evening, in this browser only. Wrapped in try/catch —
  // storage can be unavailable (private mode) and the page must still work.
  const draftKey = `ooosh_sitter_handover_draft_${date}`
  const draftLoaded = useRef(false)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) setDraft(saved)
    } catch { /* storage unavailable */ }
    draftLoaded.current = true
  }, [draftKey])
  useEffect(() => {
    if (!draftLoaded.current) return
    try {
      if (draft.trim()) window.localStorage.setItem(draftKey, draft)
      else window.localStorage.removeItem(draftKey)
    } catch { /* storage unavailable */ }
  }, [draft, draftKey])

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

  // Recent handover — the last few nights' notes carried forward (read-only), so
  // a sitter arriving fresh sees prior context the per-night thread doesn't carry.
  const [recentNights, setRecentNights] = useState<RecentNight[]>([])
  const [recentOpen, setRecentOpen] = useState(false)

  const fetchRecent = useCallback(async () => {
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}/recent-handover`)
      const data = await response.json()
      if (response.ok && data.success) setRecentNights(data.nights || [])
    } catch (err) {
      console.error('Failed to load recent handover:', err)
    }
  }, [date])

  const postNote = useCallback(async (): Promise<boolean> => {
    const content = draft.trim()
    if ((!content && pendingFiles.length === 0) || posting) return false
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
      return true
    } catch (err) {
      console.error('Failed to post note:', err)
      setPostError(err instanceof Error ? err.message : 'Failed to post note')
      return false
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
      fetchRecent()
    }
  }, [date, fetchShift, fetchThread, fetchRecent])

  const envelope = shift ? formatEnvelope(shift.planned_start, shift.planned_end) : null
  const isConfirmed = shift?.assignment_status === 'confirmed'
  const isTonight = !!shift && shift.date === ukToday()
  // "Tonight, 6:00pm – 11:30pm"; another evening leads with its day.
  const heading = shift
    ? (isTonight
      ? (envelope ? `Tonight, ${envelope}` : 'Tonight')
      : (envelope ? `${formatLongDate(shift.date).split(' ')[0]}, ${envelope}` : formatLongDate(shift.date)))
    : ''

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-36">
      <header className="max-w-lg mx-auto px-2 pt-2">
        <div className="px-2.5">
          <BackLink href="/dashboard" label="Jobs" />
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-1 flex flex-col gap-4">
        {error && (
          <Banner tone="error">
            {error}{' '}
            <button type="button" onClick={fetchShift} className="underline font-semibold">Try again</button>
          </Banner>
        )}

        {loading ? (
          <div className={`${cls.card} p-4 animate-pulse`}>
            <div className="h-5 bg-hf-track rounded w-2/3 mb-3" />
            <div className="h-3 bg-hf-track rounded w-1/2" />
          </div>
        ) : shift ? (
          <>
            {/* Overview */}
            <section className="px-1 pb-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className={`${cls.kindLabel} text-kind-studio`}>Studio sitter</span>
                <Chip tone={isConfirmed ? 'green' : 'amber'}>{isConfirmed ? 'Confirmed' : 'Assigned'}</Chip>
              </div>
              <h1 className={cls.pageTitle}>{heading}</h1>
              <p className="text-[16px] text-hf-body">
                {formatLongDate(shift.date)}
                {shift.fee !== null && <span className="tabular"> · {formatFee(shift.fee)}</span>}
              </p>
              <p className="text-[15px] text-hf-muted leading-[1.45] mt-0.5">
                Look after the bands below, then lock up the whole building at the end of the night.
              </p>
            </section>

            {/* Shop till — price lookup any time, selling on the night */}
            <Link
              href={`/shift/${date}/till`}
              className={`${cls.card} min-h-[64px] px-4 py-3 flex items-center gap-3 hover:bg-hf-inset transition-colors`}
            >
              <IconTile kind="neutral"><ShoppingCart {...ICON} /></IconTile>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[16px] font-semibold text-hf-ink">Shop till</span>
                <span className="text-[14px] text-hf-muted">Look up a price, or sell strings, leads, gaffa...</span>
              </span>
              <Chevron />
            </Link>

            {/* Who's in tonight */}
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Who&apos;s in tonight</SectionLabel>
              {shift.jobs.length === 0 ? (
                <div className={`${cls.card} px-4 py-5 text-center text-[15px] text-hf-muted`}>
                  No rooms booked for this evening yet.
                </div>
              ) : (
                shift.jobs.map((job) => (
                  <div key={job.job_id} className={`${cls.card} px-4 py-3.5 flex flex-col gap-2.5`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[16px] font-semibold text-hf-ink">{job.label}</span>
                      {job.hh_job_number && (
                        <span className="text-[13px] text-hf-muted shrink-0 tabular">#{job.hh_job_number}</span>
                      )}
                    </div>
                    {job.rooms.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {job.rooms.map((room) => (
                          <span key={room} className="text-[13px] font-semibold bg-kind-studio-bg text-kind-studio rounded-full px-2.5 py-0.5">
                            {room}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Shared specs / stage plots */}
                    {job.files && job.files.length > 0 && (
                      <div className="border-t border-hf-divider pt-2.5 flex flex-col gap-1">
                        {job.files.map((file, idx) => (
                          <a
                            key={`${job.job_id}-${idx}`}
                            href={file.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[40px] flex items-center gap-2.5 text-[15px] font-semibold text-hf-link hover:text-hf-link-hover"
                          >
                            <FileIcon fileType={file.fileType} />
                            <span className="truncate">{file.name}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>

            {/* Recent handover — the last few nights, carried forward (read-only) */}
            {recentNights.length > 0 && (
              <section className={`${cls.card} overflow-hidden`}>
                <button type="button" onClick={() => setRecentOpen((o) => !o)} aria-expanded={recentOpen}
                  className="w-full h-14 px-4 flex items-center justify-between text-left">
                  <span className="text-[16px] font-semibold text-hf-ink">Recent handover</span>
                  <span className="flex items-center gap-1.5 text-[15px] text-hf-muted">
                    Last {recentNights.length} night{recentNights.length !== 1 ? 's' : ''}
                    <ChevronDown size={18} strokeWidth={2} className={`text-hf-chevron transition-transform ${recentOpen ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {recentOpen && (
                  <div className="px-4 pb-4 flex flex-col gap-4 border-t border-hf-divider pt-3">
                    {recentNights.map((night) => (
                      <div key={night.date}>
                        <p className="text-[13px] font-semibold text-hf-body mb-1.5">{formatLongDate(night.date)}</p>
                        <div className="flex flex-col gap-2">
                          {night.entries.map((m) => (
                            <div key={m.id} className={`rounded-xl px-3 py-2.5 ${m.from_staff ? 'bg-hf-tint' : 'bg-hf-inset border border-hf-divider'}`}>
                              <div className="flex items-center justify-between gap-2 mb-0.5">
                                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-hf-ink">
                                  {m.author}
                                  {m.from_staff && <OfficeBadge />}
                                </span>
                                <span className="text-[12px] text-hf-muted shrink-0">{formatMessageTime(m.created_at)}</span>
                              </div>
                              {m.content && m.content !== '(attachment)' && (
                                <p className="text-[14px] text-hf-body whitespace-pre-wrap break-words leading-[1.45]"><Linkified text={m.content} /></p>
                              )}
                              {m.files && m.files.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                  {m.files.map((file, idx) => (
                                    isImageFile(file) ? (
                                      <a key={`${m.id}-${idx}`} href={file.url} target="_blank" rel="noopener noreferrer">
                                        <img src={file.url} alt={file.name} className="w-16 h-16 rounded-lg border border-hf-border object-cover" />
                                      </a>
                                    ) : (
                                      <a key={`${m.id}-${idx}`} href={file.url} target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-lg border border-hf-border bg-white text-hf-link font-semibold">
                                        <FileIcon fileType={file.fileType} size={14} /> <span className="max-w-[120px] truncate">{file.name}</span>
                                      </a>
                                    )
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Tonight's tasks (STAFF-CALENDAR-SPEC §21) — hidden when there are none */}
            {shift.tasks && shift.tasks.some((t) => t.status !== 'cancelled') && (
              <section className={`${cls.card} p-4`}>
                <FreelancerTaskList tasks={shift.tasks} heading="Tasks tonight" />
              </section>
            )}

            {/* Handover notes (sitter ⇄ staff thread) */}
            <section className="flex flex-col gap-2.5">
              <div className="px-1 flex flex-col gap-0.5">
                <span className={cls.sectionLabel}>Handover notes</span>
                <span className="text-[14px] text-hf-muted">
                  For the next sitter or the office: jobs for tonight, money owed, things left undone.
                </span>
              </div>

              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-[14px] px-3.5 py-3 flex flex-col gap-1 ${
                    m.from_staff ? 'bg-hf-tint' : 'bg-white border border-hf-border'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[14px] font-semibold text-hf-ink">
                      {m.mine ? 'You' : m.author}
                      {m.from_staff && <OfficeBadge />}
                    </span>
                    <span className="text-[13px] text-hf-muted shrink-0">
                      {formatMessageTime(m.created_at)}
                    </span>
                  </div>
                  {m.content && m.content !== '(attachment)' && (
                    <p className="text-[15px] text-hf-body leading-[1.45] whitespace-pre-wrap break-words"><Linkified text={m.content} /></p>
                  )}
                  {m.files && m.files.length > 0 && (
                    <div className="mt-1 flex flex-col gap-1.5">
                      {m.files.map((file, idx) => (
                        isImageFile(file) ? (
                          <a key={`${m.id}-${idx}`} href={file.url} target="_blank" rel="noopener noreferrer" className="block">
                            <img src={file.url} alt={file.name}
                              className="max-w-[240px] max-h-[180px] rounded-lg border border-hf-border object-cover" />
                          </a>
                        ) : (
                          <a
                            key={`${m.id}-${idx}`}
                            href={file.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-[15px] font-semibold text-hf-link hover:text-hf-link-hover"
                          >
                            <FileIcon fileType={file.fileType} />
                            <span className="truncate">{file.name}</span>
                          </a>
                        )
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Composer */}
              <div className={`${cls.card} p-3 flex flex-col gap-2.5`}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add a note..."
                  rows={3}
                  className={`${cls.input} min-h-[72px] resize-y`}
                />
                {pendingFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {pendingFiles.map((p, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg border border-hf-border bg-hf-inset text-[13px] text-hf-body">
                        {p.preview
                          ? <img src={p.preview} alt={p.file.name} className="w-6 h-6 object-cover rounded" />
                          : <Paperclip size={14} strokeWidth={1.8} />}
                        <span className="max-w-[140px] truncate">{p.file.name}</span>
                        <button type="button" onClick={() => setPendingFiles((prev) => {
                          const found = prev[idx]
                          if (found?.preview) URL.revokeObjectURL(found.preview)
                          return prev.filter((_, i) => i !== idx)
                        })}
                          className="w-7 h-7 flex items-center justify-center rounded-md text-hf-muted hover:text-hf-error" aria-label={`Remove ${p.file.name}`}>
                          <X size={14} strokeWidth={2.2} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {(draft.trim() || pendingFiles.length > 0) && !posting && (
                  <p className="text-[13px] text-hf-amber-text">Not posted yet - tap Post note to send it.</p>
                )}
                {postError && <p className="text-[13px] text-hf-error">{postError}</p>}
                <div className="flex justify-between items-center gap-2.5">
                  {/* Native <label> + visually-hidden (NOT display:none) input so
                      the file picker opens on mobile — iOS/Android silently ignore
                      a programmatic .click() on a display:none input. */}
                  <label className="h-11 px-3.5 rounded-xl border-[1.5px] border-hf-control flex items-center gap-1.5 text-[15px] font-semibold text-hf-body hover:bg-hf-inset cursor-pointer">
                    <Paperclip size={18} strokeWidth={1.8} />
                    Attach
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
                    type="button"
                    onClick={postNote}
                    disabled={(!draft.trim() && pendingFiles.length === 0) || posting}
                    className="h-11 px-[18px] rounded-xl bg-hf-accent text-white text-[15px] font-semibold hover:bg-hf-accent-pressed disabled:bg-hf-disabled disabled:cursor-not-allowed transition-colors"
                  >
                    {posting ? 'Posting...' : 'Post note'}
                  </button>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </main>

      {/* Finish for the night → end-of-day lock-up report. Sticky at the foot. */}
      {!loading && shift && (
        <div className="fixed left-0 right-0 bottom-0 z-20 bg-gradient-to-t from-hf-page from-70% to-transparent safe-bottom">
          <div className="max-w-lg mx-auto px-4 pt-3.5 pb-4">
            <Link
              href={`/shift/${date}/lockup`}
              onClick={async (e) => {
                // An unposted handover note would otherwise be left behind here.
                if (!draft.trim() && pendingFiles.length === 0) return
                e.preventDefault()
                if (window.confirm("You've written a handover note but not posted it. Post it now?")) {
                  if (!(await postNote())) return // error shows under the note box
                }
                router.push(`/shift/${date}/lockup`)
              }}
              className={`${cls.btnDark} w-full !h-14`}
            >
              <Lock size={18} strokeWidth={2} />
              Finish for the night
            </Link>
            <p className="mt-1.5 text-center text-[13px] text-hf-muted">Quick lock-up checklist before you leave.</p>
          </div>
        </div>
      )}
    </div>
  )
}

/** Small OFFICE tag on a note from staff. */
function OfficeBadge() {
  return (
    <span className="text-[11px] font-bold uppercase tracking-[0.05em] bg-hf-accent text-white rounded-md px-1.5 py-px">
      Office
    </span>
  )
}
