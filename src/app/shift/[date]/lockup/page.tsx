'use client'

/**
 * Studio Sitter — End-of-Day Lock-up Report ("Finish for the night")
 *
 * Route: /shift/[date]/lockup   (date = YYYY-MM-DD)
 *
 * Ported from the studio Jotform: sectioned checklist (Upstairs / Downstairs),
 * per-item "what it should look like" reference, a "why?" note + photos on any
 * off-expected answer, notes + photos, DERIVED "continuing tomorrow?" (hides the
 * end-of-booking deep-clean items), and lost-property capture straight into
 * Holding. Soft — flags, never blocks.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { LockupItem } from '@/lib/op-api'

interface LockupContext {
  success: boolean
  date: string
  template: {
    version: number
    intro?: string
    items: LockupItem[]
    notes_label?: string
    lost_property_prompt?: string
  }
  continuing_tomorrow: boolean
  continuing_derived: boolean
  submitted: {
    answers: Record<string, unknown>
    exception_notes: Record<string, { text: string }>
    item_notes: Record<string, { text: string }>
    notes: { text: string }
  } | null
  has_shift: boolean
  error?: string
}

function formatLongDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (isNaN(date.getTime())) return dateStr
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`
}

const YESNO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'na', label: 'N/A' },
]

// A little file-chip row (shared by why-boxes, notes, lost property).
function FileChips({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {files.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-[11px] text-gray-600">
          {f.type.startsWith('image/') ? '🖼️' : '📎'}<span className="max-w-[110px] truncate">{f.name}</span>
          <button type="button" onClick={() => onRemove(i)} className="hover:text-red-600" aria-label="Remove">×</button>
        </span>
      ))}
    </div>
  )
}

function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  return (
    <label className="inline-block text-xs px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 cursor-pointer mt-1.5">
      📎 Add photo
      <input type="file" multiple accept="image/*,application/pdf" className="sr-only"
        onChange={(e) => {
          const picked = e.target.files ? Array.from(e.target.files) : []
          e.target.value = ''
          if (picked.length) onFiles(picked)
        }} />
    </label>
  )
}

export default function LockupPage() {
  const params = useParams()
  const router = useRouter()
  const date = String(params?.date || '')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ctx, setCtx] = useState<LockupContext | null>(null)

  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [whyNotes, setWhyNotes] = useState<Record<string, string>>({})
  const [whyPhotos, setWhyPhotos] = useState<Record<string, File[]>>({})
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({})
  const [itemPhotos, setItemPhotos] = useState<Record<string, File[]>>({})
  const [notesText, setNotesText] = useState('')
  const [notesPhotos, setNotesPhotos] = useState<File[]>([])
  const [continuing, setContinuing] = useState<boolean | null>(null)
  const [openRef, setOpenRef] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState<{ exceptions: number } | null>(null)

  // Lost property
  const [lpOpen, setLpOpen] = useState(false)
  const [lpDesc, setLpDesc] = useState('')
  const [lpLocation, setLpLocation] = useState('')
  const [lpPhotos, setLpPhotos] = useState<File[]>([])
  const [lpSaving, setLpSaving] = useState(false)
  const [lpError, setLpError] = useState<string | null>(null)
  const [lpLogged, setLpLogged] = useState<string[]>([])

  const fetchCtx = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}/lockup`)
      const data: LockupContext = await response.json()
      if (!response.ok || !data.success) {
        if (response.status === 401) { router.push('/login'); return }
        throw new Error(data.error || 'Failed to load the lock-up report')
      }
      setCtx(data)
      const seed: Record<string, string> = {}
      if (data.submitted?.answers) for (const [k, v] of Object.entries(data.submitted.answers)) seed[k] = String(v ?? '')
      setAnswers(seed)
      const seedWhy: Record<string, string> = {}
      if (data.submitted?.exception_notes) for (const [k, v] of Object.entries(data.submitted.exception_notes)) seedWhy[k] = String(v?.text ?? '')
      setWhyNotes(seedWhy)
      const seedItem: Record<string, string> = {}
      if (data.submitted?.item_notes) for (const [k, v] of Object.entries(data.submitted.item_notes)) seedItem[k] = String(v?.text ?? '')
      setItemNotes(seedItem)
      setNotesText(data.submitted?.notes?.text ?? '')
      setContinuing(data.continuing_tomorrow)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the lock-up report')
    } finally {
      setLoading(false)
    }
  }, [date, router])

  useEffect(() => { if (date) fetchCtx() }, [date, fetchCtx])

  const setAnswer = (id: string, value: string) => setAnswers((prev) => ({ ...prev, [id]: value }))
  const toggleRef = (id: string) => setOpenRef((prev) => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  const isOffExpected = (item: LockupItem, val: string) =>
    item.type === 'yesno' && item.expected !== undefined && val !== '' &&
    val.toLowerCase() !== 'na' && val.toLowerCase() !== String(item.expected).toLowerCase()

  const visibleItems = (ctx?.template.items ?? []).filter((it) => !(it.end_of_booking_only && continuing))

  const submit = useCallback(async () => {
    if (submitting || !ctx) return
    setSubmitting(true); setSubmitError(null)
    try {
      // exception_notes: only for currently-off-expected items WITHOUT a
      // note_prompt (those use the always-on item_notes box instead).
      const exceptionNotes: Record<string, string> = {}
      for (const it of visibleItems) {
        if (!it.note_prompt && isOffExpected(it, answers[it.id] ?? '') && (whyNotes[it.id] || '').trim()) {
          exceptionNotes[it.id] = whyNotes[it.id].trim()
        }
      }
      // item_notes: always-on notes on note_prompt items (any answer).
      const itemNotesPayload: Record<string, string> = {}
      for (const it of visibleItems) {
        if (it.note_prompt && (itemNotes[it.id] || '').trim()) {
          itemNotesPayload[it.id] = itemNotes[it.id].trim()
        }
      }
      const fd = new FormData()
      fd.append('payload', JSON.stringify({
        answers, exception_notes: exceptionNotes, item_notes: itemNotesPayload, notes: notesText.trim(),
        continuing_tomorrow: continuing === true,
      }))
      for (const it of visibleItems) {
        if (it.note_prompt) {
          for (const f of itemPhotos[it.id] ?? []) fd.append(`item_${it.id}`, f, f.name)
        } else if (isOffExpected(it, answers[it.id] ?? '')) {
          for (const f of whyPhotos[it.id] ?? []) fd.append(`why_${it.id}`, f, f.name)
        }
      }
      for (const f of notesPhotos) fd.append('notes_photo', f, f.name)

      const response = await fetch(`/api/studio-sitter/shifts/${date}/lockup`, { method: 'POST', body: fd })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to submit')
      setDone({ exceptions: Array.isArray(data.exceptions) ? data.exceptions.length : 0 })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit the report')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, ctx, visibleItems, answers, whyNotes, whyPhotos, itemNotes, itemPhotos, notesText, notesPhotos, continuing, date])

  const submitLostProperty = useCallback(async () => {
    if (lpSaving || !lpDesc.trim()) return
    setLpSaving(true); setLpError(null)
    try {
      const fd = new FormData()
      fd.append('description', lpDesc.trim())
      if (lpLocation.trim()) fd.append('found_location', lpLocation.trim())
      for (const f of lpPhotos) fd.append('photo', f, f.name)
      const response = await fetch(`/api/studio-sitter/shifts/${date}/lost-property`, { method: 'POST', body: fd })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to log')
      setLpLogged((prev) => [...prev, lpDesc.trim()])
      setLpDesc(''); setLpLocation(''); setLpPhotos([]); setLpOpen(false)
    } catch (err) {
      setLpError(err instanceof Error ? err.message : 'Failed to log lost property')
    } finally {
      setLpSaving(false)
    }
  }, [lpSaving, lpDesc, lpLocation, lpPhotos, date])

  // ── Success screen ────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="min-h-screen bg-gray-50 safe-top safe-bottom flex items-center justify-center px-4">
        <div className="max-w-lg w-full bg-white rounded-2xl border border-gray-100 p-6 shadow-sm text-center">
          <div className="text-4xl mb-3">{done.exceptions > 0 ? '⚠️' : '✅'}</div>
          <h1 className="text-lg font-semibold text-gray-900">Locked up — thanks!</h1>
          <p className="mt-2 text-sm text-gray-600">
            {done.exceptions > 0
              ? `The office has been alerted about ${done.exceptions} thing${done.exceptions !== 1 ? 's' : ''} that need attention.`
              : 'All clear. The office has been notified you’ve finished for the night.'}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link href={`/shift/${date}`} className="text-sm font-medium px-4 py-2.5 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-500 transition-colors">Back to shift</Link>
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">Back to dashboard</Link>
          </div>
        </div>
      </div>
    )
  }

  let lastSection: string | undefined
  return (
    <div className="min-h-screen bg-gray-50 safe-top safe-bottom pb-24">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link href={`/shift/${date}`} className="p-2 -ml-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors" title="Back to shift">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <div className="flex items-center gap-2"><span className="text-xl">🔒</span><h1 className="text-lg font-semibold text-gray-900">Finish for the night</h1></div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}<button onClick={fetchCtx} className="ml-2 underline hover:no-underline">Try again</button>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm animate-pulse"><div className="h-5 bg-gray-200 rounded w-2/3 mb-3" /><div className="h-3 bg-gray-200 rounded w-1/2" /></div>
        ) : ctx && !ctx.has_shift ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">This evening isn&apos;t set up as a shift yet — please contact the office before locking up.</div>
        ) : ctx ? (
          <>
            <div className="text-sm text-gray-500">{formatLongDate(ctx.date)}</div>
            {ctx.submitted && <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-xs">Already submitted. You can update your answers and re-submit if something changed.</div>}
            {ctx.template.intro && <p className="text-sm text-gray-600 leading-relaxed">{ctx.template.intro}</p>}

            {/* Continuing tomorrow? (derived, overridable) */}
            <section className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <p className="text-sm font-medium text-gray-900">Is the studio in use again tomorrow?</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {ctx.continuing_derived ? 'Looks like there’s a session booked tomorrow — the end-of-night deep-clean items are hidden.' : 'Looks like this is the last night — the deep-clean items are included below.'}
              </p>
              <div className="mt-3 flex gap-2">
                {[{ v: true, l: 'Yes, back tomorrow' }, { v: false, l: 'No, all done' }].map((opt) => (
                  <button key={String(opt.v)} type="button" onClick={() => setContinuing(opt.v)}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${continuing === opt.v ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>{opt.l}</button>
                ))}
              </div>
            </section>

            {/* Checklist (grouped by section) */}
            <section className="space-y-2">
              {visibleItems.map((item) => {
                const val = answers[item.id] ?? ''
                const off = isOffExpected(item, val)
                const showSection = item.section && item.section !== lastSection
                if (item.section) lastSection = item.section
                return (
                  <div key={item.id}>
                    {showSection && (
                      <h2 className="text-lg font-bold text-gray-800 mt-6 mb-2">{item.section}</h2>
                    )}
                    <div className={`bg-white rounded-xl border p-3.5 shadow-sm ${off ? 'border-amber-300 bg-amber-50/40' : 'border-gray-100'}`}>
                      <p className="text-sm text-gray-900">{item.label}</p>

                      {/* Reference: "what it should look like" */}
                      {item.reference && (item.reference.photos.length > 0 || item.reference.text) && (
                        <div className="mt-1.5">
                          <button type="button" onClick={() => toggleRef(item.id)} className="text-xs text-ooosh-600 hover:text-ooosh-500">
                            {openRef.has(item.id) ? '▾' : '▸'} 📷 What it should look like
                          </button>
                          {openRef.has(item.id) && (
                            <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-2">
                              {item.reference.text && <p className="text-xs text-gray-600 mb-2">{item.reference.text}</p>}
                              <div className="grid grid-cols-3 gap-2">
                                {item.reference.photos.map((p, i) => (
                                  <button key={i} type="button" onClick={() => setLightbox(p)} className="block" aria-label="View larger">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={p} alt="reference" loading="lazy" className="w-full h-20 object-cover rounded border border-gray-200" />
                                  </button>
                                ))}
                              </div>
                              <p className="text-[11px] text-gray-400 mt-1.5">Tap a photo to enlarge.</p>
                            </div>
                          )}
                        </div>
                      )}

                      {item.type === 'yesno' ? (
                        <div className="mt-2 flex gap-2">
                          {YESNO.map((o) => (
                            <button key={o.value} type="button" onClick={() => setAnswer(item.id, o.value)}
                              className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${val === o.value
                                ? o.value === 'yes' ? 'bg-green-600 text-white border-green-600'
                                  : o.value === 'no' ? 'bg-red-500 text-white border-red-500'
                                    : 'bg-gray-500 text-white border-gray-500'
                                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>{o.label}</button>
                          ))}
                        </div>
                      ) : (
                        <input type={item.type === 'number' ? 'number' : 'text'} value={val} onChange={(e) => setAnswer(item.id, e.target.value)}
                          className="mt-2 w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-300" />
                      )}

                      {/* note_prompt items: always-on note box. Otherwise the "why?" box on off-expected. */}
                      {item.note_prompt ? (
                        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
                          <label className="text-xs font-medium text-gray-600">{item.note_prompt}</label>
                          <textarea value={itemNotes[item.id] ?? ''} onChange={(e) => setItemNotes((p) => ({ ...p, [item.id]: e.target.value }))}
                            rows={2} placeholder="Optional note…"
                            className="mt-1 w-full text-sm border border-gray-200 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-ooosh-200" />
                          <AttachButton onFiles={(f) => setItemPhotos((p) => ({ ...p, [item.id]: [...(p[item.id] ?? []), ...f] }))} />
                          <FileChips files={itemPhotos[item.id] ?? []} onRemove={(i) => setItemPhotos((p) => ({ ...p, [item.id]: (p[item.id] ?? []).filter((_, idx) => idx !== i) }))} />
                        </div>
                      ) : off ? (
                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                          <label className="text-xs font-medium text-amber-800">Why? (optional, but helpful)</label>
                          <textarea value={whyNotes[item.id] ?? ''} onChange={(e) => setWhyNotes((p) => ({ ...p, [item.id]: e.target.value }))}
                            rows={2} placeholder="What happened / what's outstanding…"
                            className="mt-1 w-full text-sm border border-amber-200 rounded-lg p-2 bg-white focus:outline-none focus:ring-2 focus:ring-amber-200" />
                          <AttachButton onFiles={(f) => setWhyPhotos((p) => ({ ...p, [item.id]: [...(p[item.id] ?? []), ...f] }))} />
                          <FileChips files={whyPhotos[item.id] ?? []} onRemove={(i) => setWhyPhotos((p) => ({ ...p, [item.id]: (p[item.id] ?? []).filter((_, idx) => idx !== i) }))} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </section>

            {/* Lost property → Holding */}
            <section className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <p className="text-sm font-medium text-gray-900">Lost property</p>
              {ctx.template.lost_property_prompt && <p className="text-xs text-gray-500 mt-0.5">{ctx.template.lost_property_prompt}</p>}
              {lpLogged.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {lpLogged.map((d, i) => <li key={i} className="text-xs text-green-700">✓ {d}</li>)}
                </ul>
              )}
              {lpOpen ? (
                <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-2.5">
                  <input value={lpDesc} onChange={(e) => setLpDesc(e.target.value)} placeholder="What is it? (e.g. black jacket, phone charger)"
                    className="w-full text-sm border border-gray-200 rounded-lg p-2 bg-white" />
                  <input value={lpLocation} onChange={(e) => setLpLocation(e.target.value)} placeholder="Where did you find it? (optional)"
                    className="mt-2 w-full text-sm border border-gray-200 rounded-lg p-2 bg-white" />
                  <AttachButton onFiles={(f) => setLpPhotos((p) => [...p, ...f])} />
                  <FileChips files={lpPhotos} onRemove={(i) => setLpPhotos((p) => p.filter((_, idx) => idx !== i))} />
                  {lpError && <p className="text-xs text-red-600 mt-1">{lpError}</p>}
                  <div className="mt-2 flex gap-2">
                    <button onClick={submitLostProperty} disabled={lpSaving || !lpDesc.trim()}
                      className="text-sm px-3 py-1.5 rounded-lg bg-ooosh-600 text-white disabled:opacity-40">{lpSaving ? 'Logging…' : 'Log item'}</button>
                    <button onClick={() => { setLpOpen(false); setLpError(null) }} className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setLpOpen(true)} className="mt-2 text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-ooosh-600 hover:bg-gray-50">＋ Log lost property</button>
              )}
            </section>

            {/* Notes */}
            <section className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <label className="text-sm font-medium text-gray-900">{ctx.template.notes_label || 'Anything we need to know?'}</label>
              <textarea value={notesText} onChange={(e) => setNotesText(e.target.value)} rows={4}
                placeholder="Money owed, items taken, jobs for tomorrow, anything left undone…"
                className="mt-2 w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-300 resize-y min-h-[80px]" />
              <AttachButton onFiles={(f) => setNotesPhotos((p) => [...p, ...f])} />
              <FileChips files={notesPhotos} onRemove={(i) => setNotesPhotos((p) => p.filter((_, idx) => idx !== i))} />
            </section>

            {submitError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{submitError}</div>}
          </>
        ) : null}
      </main>

      {ctx && ctx.has_shift && !loading && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-100 safe-bottom">
          <div className="max-w-lg mx-auto px-4 py-3">
            <button onClick={submit} disabled={submitting}
              className="w-full text-sm font-semibold px-4 py-3 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {submitting ? 'Submitting…' : '🔒 Submit & finish for the night'}
            </button>
          </div>
        </div>
      )}

      {/* Reference-photo lightbox — tap to enlarge (renders inline, never downloads). */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="reference" className="max-w-full max-h-full object-contain rounded" onClick={(e) => e.stopPropagation()} />
          <button type="button" onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/90 text-gray-800 text-lg leading-none flex items-center justify-center" aria-label="Close">×</button>
        </div>
      )}
    </div>
  )
}
