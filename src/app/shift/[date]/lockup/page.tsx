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

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Camera, ChevronDown, Image as ImageIcon, Paperclip, X, Lock, Check, AlertTriangle, Plus } from 'lucide-react'
import type { LockupItem } from '@/lib/op-api'
import { cls, BackLink, Banner } from '@/components/ui'

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
    submitted_at?: string
  } | null
  has_shift: boolean
  /** What the shop till took tonight (null = no shift). */
  shop: {
    sales: number
    taken: number
    byTender: { tender: string; label: string; amount: number }[]
    onTheirBill: number
  } | null
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
    <div className="flex flex-wrap gap-1.5">
      {files.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg border border-hf-border bg-white text-[12px] text-hf-body">
          {f.type.startsWith('image/') ? <ImageIcon size={14} strokeWidth={1.8} /> : <Paperclip size={14} strokeWidth={1.8} />}
          <span className="max-w-[110px] truncate">{f.name}</span>
          <button type="button" onClick={() => onRemove(i)} className="w-7 h-7 flex items-center justify-center text-hf-muted hover:text-hf-error" aria-label="Remove">
            <X size={14} strokeWidth={2.2} />
          </button>
        </span>
      ))}
    </div>
  )
}

/** "+ Add photo": amber inside the Why? box, plain elsewhere. */
function AttachButton({ onFiles, tone = 'plain' }: { onFiles: (files: File[]) => void; tone?: 'plain' | 'amber' }) {
  const t = tone === 'amber'
    ? 'border-hf-amber-border text-hf-amber-text'
    : 'border-hf-control text-hf-body'
  return (
    <label className={`self-start inline-flex items-center gap-1.5 h-10 px-3 rounded-[10px] bg-white border-[1.5px] text-[14px] font-semibold cursor-pointer hover:bg-hf-inset ${t}`}>
      <Plus size={16} strokeWidth={2.2} /> Add photo
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
  // The "Anything we need to know?" text survives a refresh or a failed submit
  // until the report goes in. Per evening, this browser only; storage can be
  // unavailable (private mode), so every access is guarded.
  const notesDraftKey = `ooosh_sitter_lockup_notes_draft_${date}`
  const notesDraftReady = useRef(false)
  const [continuing, setContinuing] = useState<boolean | null>(null)
  const [openRef, setOpenRef] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState<{ exceptions: number } | null>(null)
  const [confirmUnanswered, setConfirmUnanswered] = useState(false)
  const [resubmitAt, setResubmitAt] = useState<string | null>(null)

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
      let notesSeed = data.submitted?.notes?.text ?? ''
      if (!notesSeed) {
        try { notesSeed = window.localStorage.getItem(notesDraftKey) ?? '' } catch { /* storage unavailable */ }
      }
      setNotesText(notesSeed)
      notesDraftReady.current = true
      setContinuing(data.continuing_tomorrow)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the lock-up report')
    } finally {
      setLoading(false)
    }
  }, [date, router, notesDraftKey])

  useEffect(() => { if (date) fetchCtx() }, [date, fetchCtx])

  useEffect(() => {
    if (!notesDraftReady.current) return
    try {
      if (notesText.trim()) window.localStorage.setItem(notesDraftKey, notesText)
      else window.localStorage.removeItem(notesDraftKey)
    } catch { /* storage unavailable */ }
  }, [notesText, notesDraftKey])

  const setAnswer = (id: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
    setConfirmUnanswered(false) // re-validate after any change
  }
  const toggleRef = (id: string) => setOpenRef((prev) => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  const isOffExpected = (item: LockupItem, val: string) =>
    item.type === 'yesno' && item.expected !== undefined && val !== '' &&
    val.toLowerCase() !== 'na' && val.toLowerCase() !== String(item.expected).toLowerCase()

  const visibleItems = (ctx?.template.items ?? []).filter((it) => !(it.end_of_booking_only && continuing))

  const unansweredCount = visibleItems.filter((it) => !String(answers[it.id] ?? '').trim()).length

  const submit = useCallback(async (allowResubmit = false) => {
    if (submitting || !ctx) return
    // Confirm-on-unanswered: first click just flags it, second click proceeds.
    const unanswered = visibleItems.filter((it) => !String(answers[it.id] ?? '').trim())
    if (unanswered.length > 0 && !confirmUnanswered) { setConfirmUnanswered(true); setSubmitError(null); return }
    setSubmitting(true); setSubmitError(null); setResubmitAt(null)
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
        continuing_tomorrow: continuing === true, allow_resubmit: allowResubmit,
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
      if (response.status === 409 && data.already_submitted) { setResubmitAt(String(data.submitted_at || '')); return }
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to submit')
      try { window.localStorage.removeItem(notesDraftKey) } catch { /* storage unavailable */ }
      setDone({ exceptions: Array.isArray(data.exceptions) ? data.exceptions.length : 0 })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit the report')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, ctx, visibleItems, answers, whyNotes, whyPhotos, itemNotes, itemPhotos, notesText, notesPhotos, continuing, confirmUnanswered, date, notesDraftKey])

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
      <div className="min-h-screen bg-hf-page safe-top safe-bottom flex items-center justify-center px-4">
        <div className={`max-w-lg w-full ${cls.card} p-6 text-center`}>
          <div className={`w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center ${done.exceptions > 0 ? 'bg-hf-amber-tile text-hf-amber-text' : 'bg-hf-green-tint text-hf-green-text'}`}>
            {done.exceptions > 0 ? <AlertTriangle size={26} strokeWidth={2} /> : <Check size={28} strokeWidth={2.4} />}
          </div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-hf-ink">Locked up. Thanks!</h1>
          <p className="mt-2 text-[15px] text-hf-body leading-[1.45]">
            {done.exceptions > 0
              ? `The office has been alerted about ${done.exceptions} thing${done.exceptions !== 1 ? 's that need' : ' that needs'} attention.`
              : 'All clear. The office has been notified you’ve finished for the night.'}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link href={`/shift/${date}`} className={`${cls.btnPrimary} w-full`}>Back to shift</Link>
            <Link href="/dashboard" className="h-11 flex items-center justify-center text-[15px] font-semibold text-hf-link hover:text-hf-link-hover">Back to jobs</Link>
          </div>
        </div>
      </div>
    )
  }

  const answeredCount = visibleItems.length - unansweredCount
  const yesNoBtn = 'h-[46px] rounded-[11px] text-[15px] transition-colors'
  let lastSection: string | undefined
  return (
    <div className="min-h-screen bg-hf-page safe-top pb-44">
      <header className="max-w-lg mx-auto px-2 pt-2 flex items-center justify-between">
        <div className="px-2.5"><BackLink href={`/shift/${date}`} label="Shift" /></div>
        {ctx && ctx.has_shift && !loading && (
          <span className="text-[14px] text-hf-muted pr-[18px] tabular">{answeredCount} of {visibleItems.length} answered</span>
        )}
      </header>

      <main className="max-w-lg mx-auto px-4 pt-1 flex flex-col gap-3.5">
        <div className="px-1 flex flex-col gap-1">
          <h1 className={cls.pageTitle}>Finish for the night</h1>
          {ctx && <p className="text-[16px] text-hf-muted">{formatLongDate(ctx.date)}</p>}
        </div>

        {error && (
          <Banner tone="error">
            {error}{' '}<button type="button" onClick={fetchCtx} className="underline font-semibold">Try again</button>
          </Banner>
        )}

        {loading ? (
          <div className={`${cls.card} p-4 animate-pulse`}><div className="h-5 bg-hf-track rounded w-2/3 mb-3" /><div className="h-3 bg-hf-track rounded w-1/2" /></div>
        ) : ctx && !ctx.has_shift ? (
          <Banner tone="warning">This evening isn&apos;t set up as a shift yet. Please contact the office before locking up.</Banner>
        ) : ctx ? (
          <>
            {ctx.submitted && <Banner tone="success">Already submitted. You can update your answers and re-submit if something changed.</Banner>}
            {ctx.template.intro && <p className="px-1 text-[15px] text-hf-body leading-[1.45]">{ctx.template.intro}</p>}

            {/* Tonight's till takings — the till records what WAS paid, so the
                checklist only asks about what wasn't ("any money outstanding?"). */}
            {ctx.shop && (
              <section className={`${cls.card} px-4 py-3.5 flex flex-col gap-0.5`}>
                <p className="text-[13px] font-bold uppercase tracking-[0.06em] text-hf-muted">Shop till tonight</p>
                {ctx.shop.sales === 0 ? (
                  <p className="text-[15px] text-hf-body leading-[1.45]">
                    Nothing sold through the till tonight.{' '}
                    <Link href={`/shift/${date}/till`} className={cls.link}>Open the till</Link> if you sold something.
                  </p>
                ) : (
                  <>
                    <p className="text-[17px] font-semibold text-hf-ink tabular">
                      {ctx.shop.sales} sale{ctx.shop.sales === 1 ? '' : 's'} · £{ctx.shop.taken.toFixed(2)} taken
                    </p>
                    <p className="text-[14px] text-hf-muted tabular">
                      {ctx.shop.byTender.map((t) => `${t.label} £${t.amount.toFixed(2)}`).join(' · ')}
                      {ctx.shop.onTheirBill > 0
                        ? `${ctx.shop.byTender.length ? ' · ' : ''}on bands' bills £${ctx.shop.onTheirBill.toFixed(2)}`
                        : ''}
                    </p>
                  </>
                )}
              </section>
            )}

            {/* Continuing tomorrow? (derived, overridable) */}
            <section className={`${cls.card} p-4 flex flex-col gap-2.5`}>
              <div className="flex flex-col gap-0.5">
                <p className="text-[16px] font-semibold text-hf-ink">Is the studio in use again tomorrow?</p>
                <p className="text-[14px] text-hf-muted leading-[1.4]">
                  {ctx.continuing_derived ? 'Looks like there’s a session booked tomorrow, so the end-of-night deep-clean items are hidden.' : 'Looks like this is the last night, so the deep-clean items are included below.'}
                </p>
              </div>
              <div className="bg-hf-track rounded-xl p-1 grid grid-cols-2 gap-1" role="radiogroup">
                {[{ v: true, l: 'Yes, back tomorrow' }, { v: false, l: 'No, all done' }].map((opt) => {
                  const on = continuing === opt.v
                  return (
                    <button key={String(opt.v)} type="button" role="radio" aria-checked={on} onClick={() => setContinuing(opt.v)}
                      className={`h-[42px] rounded-[9px] text-[15px] transition-colors ${on ? 'bg-white font-semibold text-hf-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'font-medium text-hf-muted'}`}>
                      {opt.l}
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Checklist (grouped by section) */}
            {visibleItems.map((item) => {
              const val = answers[item.id] ?? ''
              const off = isOffExpected(item, val)
              const showSection = item.section && item.section !== lastSection
              if (item.section) lastSection = item.section
              return (
                <div key={item.id} className="flex flex-col gap-3.5">
                  {showSection && (
                    <h2 className="pt-2 px-1 text-[20px] font-bold text-hf-ink">{item.section}</h2>
                  )}
                  <div className={`bg-white rounded-2xl px-4 py-3.5 flex flex-col gap-2.5 ${off ? 'border-[1.5px] border-hf-amber-border' : 'border border-hf-border'}`}>
                    <p className="text-[16px] leading-[1.35] text-hf-ink">{item.label}</p>

                    {/* Reference: "what it should look like" */}
                    {item.reference && (item.reference.photos.length > 0 || item.reference.text) && (
                      <div>
                        <button type="button" onClick={() => toggleRef(item.id)} aria-expanded={openRef.has(item.id)}
                          className="flex items-center gap-1.5 text-[14px] font-semibold text-hf-link hover:text-hf-link-hover">
                          <Camera size={16} strokeWidth={1.8} />
                          What it should look like
                          <ChevronDown size={16} strokeWidth={2} className={`transition-transform ${openRef.has(item.id) ? 'rotate-180' : ''}`} />
                        </button>
                        {openRef.has(item.id) && (
                          <div className="mt-2 rounded-xl bg-hf-inset border border-hf-divider p-2.5">
                            {item.reference.text && <p className="text-[14px] text-hf-body mb-2 leading-[1.4]">{item.reference.text}</p>}
                            <div className="grid grid-cols-3 gap-2">
                              {item.reference.photos.map((p, i) => (
                                <button key={i} type="button" onClick={() => setLightbox(p)} className="block" aria-label="View larger">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={p} alt="reference" loading="lazy" className="w-full h-20 object-cover rounded-lg border border-hf-border" />
                                </button>
                              ))}
                            </div>
                            <p className="text-[12px] text-hf-muted mt-1.5">Tap a photo to enlarge.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {item.type === 'yesno' ? (
                      <div className="grid grid-cols-3 gap-2">
                        {YESNO.map((o) => {
                          const on = val === o.value
                          const chosen = o.value === 'yes' ? 'bg-hf-green text-white font-semibold'
                            : o.value === 'no' ? 'bg-hf-error text-white font-semibold'
                              : 'bg-hf-body text-white font-semibold'
                          return (
                            <button key={o.value} type="button" onClick={() => setAnswer(item.id, o.value)} aria-pressed={on}
                              className={`${yesNoBtn} ${on ? chosen : 'bg-white border-[1.5px] border-hf-control text-hf-ink font-medium hover:bg-hf-inset'}`}>
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <input type={item.type === 'number' ? 'number' : 'text'} value={val} onChange={(e) => setAnswer(item.id, e.target.value)}
                        className={cls.input} />
                    )}

                    {/* note_prompt items: always-on note box. Otherwise the "why?" box on off-expected. */}
                    {item.note_prompt ? (
                      <div className="rounded-xl bg-hf-inset border border-hf-divider p-3 flex flex-col gap-2">
                        <label className="text-[14px] font-semibold text-hf-body">{item.note_prompt}</label>
                        <textarea value={itemNotes[item.id] ?? ''} onChange={(e) => setItemNotes((p) => ({ ...p, [item.id]: e.target.value }))}
                          rows={2} placeholder="Optional note..."
                          className={`${cls.input} !text-[15px] !py-2.5`} />
                        <AttachButton onFiles={(f) => setItemPhotos((p) => ({ ...p, [item.id]: [...(p[item.id] ?? []), ...f] }))} />
                        <FileChips files={itemPhotos[item.id] ?? []} onRemove={(i) => setItemPhotos((p) => ({ ...p, [item.id]: (p[item.id] ?? []).filter((_, idx) => idx !== i) }))} />
                      </div>
                    ) : off ? (
                      <div className="rounded-xl bg-hf-amber-bg p-3 flex flex-col gap-2">
                        <label className="text-[14px] font-semibold text-hf-amber-text">Why? Optional, but it helps</label>
                        <textarea value={whyNotes[item.id] ?? ''} onChange={(e) => setWhyNotes((p) => ({ ...p, [item.id]: e.target.value }))}
                          rows={2} placeholder="What happened / what's outstanding..."
                          className="w-full min-h-[52px] rounded-[10px] bg-white border-[1.5px] border-hf-amber-border px-3 py-2.5 text-[15px] text-hf-body placeholder:text-hf-placeholder outline-none focus:ring-4 focus:ring-hf-amber-tile" />
                        <AttachButton tone="amber" onFiles={(f) => setWhyPhotos((p) => ({ ...p, [item.id]: [...(p[item.id] ?? []), ...f] }))} />
                        <FileChips files={whyPhotos[item.id] ?? []} onRemove={(i) => setWhyPhotos((p) => ({ ...p, [item.id]: (p[item.id] ?? []).filter((_, idx) => idx !== i) }))} />
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}

            {/* Lost property → Holding */}
            <section className={`${cls.card} px-4 ${lpOpen || lpLogged.length > 0 || ctx.template.lost_property_prompt ? 'py-3.5' : 'min-h-[60px] py-2.5'} flex flex-col gap-2.5 justify-center`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[16px] font-semibold text-hf-ink">Lost property</span>
                {!lpOpen && (
                  <button type="button" onClick={() => setLpOpen(true)}
                    className="h-10 px-3.5 rounded-[10px] border-[1.5px] border-hf-control flex items-center gap-1 text-[14px] font-semibold text-hf-link hover:bg-hf-inset">
                    <Plus size={16} strokeWidth={2.2} /> Log an item
                  </button>
                )}
              </div>
              {ctx.template.lost_property_prompt && <p className="text-[14px] text-hf-muted -mt-1">{ctx.template.lost_property_prompt}</p>}
              {lpLogged.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {lpLogged.map((d, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[14px] text-hf-green-text"><Check size={15} strokeWidth={2.4} /> {d}</li>
                  ))}
                </ul>
              )}
              {lpOpen && (
                <div className="rounded-xl bg-hf-inset border border-hf-divider p-3 flex flex-col gap-2">
                  <input value={lpDesc} onChange={(e) => setLpDesc(e.target.value)} placeholder="What is it? (e.g. black jacket, phone charger)"
                    className={`${cls.input} !text-[15px] !py-2.5`} />
                  <input value={lpLocation} onChange={(e) => setLpLocation(e.target.value)} placeholder="Where did you find it? (optional)"
                    className={`${cls.input} !text-[15px] !py-2.5`} />
                  <AttachButton onFiles={(f) => setLpPhotos((p) => [...p, ...f])} />
                  <FileChips files={lpPhotos} onRemove={(i) => setLpPhotos((p) => p.filter((_, idx) => idx !== i))} />
                  {lpError && <p className="text-[13px] text-hf-error">{lpError}</p>}
                  <div className="flex gap-2">
                    <button type="button" onClick={submitLostProperty} disabled={lpSaving || !lpDesc.trim()}
                      className="h-11 px-4 rounded-xl bg-hf-accent text-white text-[15px] font-semibold hover:bg-hf-accent-pressed disabled:bg-hf-disabled">{lpSaving ? 'Logging...' : 'Log item'}</button>
                    <button type="button" onClick={() => { setLpOpen(false); setLpError(null) }}
                      className="h-11 px-4 rounded-xl border-[1.5px] border-hf-control text-[15px] font-semibold text-hf-body bg-white">Cancel</button>
                  </div>
                </div>
              )}
            </section>

            {/* Notes */}
            <section className={`${cls.card} p-4 flex flex-col gap-2`}>
              <label className="text-[16px] font-semibold text-hf-ink">{ctx.template.notes_label || 'Anything we need to know?'}</label>
              <textarea value={notesText} onChange={(e) => setNotesText(e.target.value)} rows={4}
                placeholder="Money owed, items taken, jobs for tomorrow, anything left undone..."
                className={`${cls.input} resize-y min-h-[88px]`} />
              <AttachButton onFiles={(f) => setNotesPhotos((p) => [...p, ...f])} />
              <FileChips files={notesPhotos} onRemove={(i) => setNotesPhotos((p) => p.filter((_, idx) => idx !== i))} />
            </section>

            {submitError && <Banner tone="error">{submitError}</Banner>}
          </>
        ) : null}
      </main>

      {ctx && ctx.has_shift && !loading && (
        <div className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-hf-border safe-bottom">
          <div className="max-w-lg mx-auto px-4 pt-3 pb-4 flex flex-col gap-2">
            {confirmUnanswered && unansweredCount > 0 && (
              <p className="text-[14px] text-hf-amber-text bg-hf-amber-bg border border-hf-amber-border rounded-[10px] px-3 py-2">
                {unansweredCount} item{unansweredCount !== 1 ? 's' : ''} still unanswered. Tap again to submit anyway.
              </p>
            )}
            <button type="button" onClick={() => submit()} disabled={submitting}
              className={`${cls.btnDark} w-full !h-14`}>
              {!submitting && <Lock size={18} strokeWidth={2} />}
              {submitting ? 'Submitting...' : confirmUnanswered && unansweredCount > 0 ? `Submit anyway (${unansweredCount} left)` : 'Submit & finish for the night'}
            </button>
          </div>
        </div>
      )}

      {/* Already-submitted guard — a stale tab can't silently overwrite + re-alert the office. */}
      {resubmitAt !== null && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setResubmitAt(null)}>
          <div className="max-w-sm w-full bg-white rounded-2xl p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-[17px] font-semibold text-hf-ink">Already submitted</h2>
            <p className="mt-2 text-[15px] text-hf-body leading-[1.45]">
              This shift was already submitted{resubmitAt ? ` at ${new Date(resubmitAt).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` : ''}. Re-submit and overwrite the previous answers?
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => { setResubmitAt(null); submit(true) }} disabled={submitting}
                className="h-12 rounded-xl bg-hf-accent text-white text-[15px] font-semibold hover:bg-hf-accent-pressed disabled:bg-hf-disabled">Re-submit</button>
              <button type="button" onClick={() => setResubmitAt(null)} className={cls.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Reference-photo lightbox — tap to enlarge (renders inline, never downloads). */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="reference" className="max-w-full max-h-full object-contain rounded" onClick={(e) => e.stopPropagation()} />
          <button type="button" onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-11 h-11 rounded-full bg-white/90 text-hf-ink flex items-center justify-center" aria-label="Close">
            <X size={20} strokeWidth={2.2} />
          </button>
        </div>
      )}
    </div>
  )
}
