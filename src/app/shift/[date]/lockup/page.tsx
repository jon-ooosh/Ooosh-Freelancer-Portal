'use client'

/**
 * Studio Sitter — End-of-Day Lock-up Report ("Finish for the night")
 *
 * Route: /shift/[date]/lockup   (date = YYYY-MM-DD)
 *
 * The sitter's soft, configurable lock-up checklist (port of the Jotform).
 * Reached from a button at the bottom of the shift page. On submit: the shift
 * closes, the free-text note posts into the handover thread (replyable), and
 * staff get a bell + email. Off-expected answers are flagged ("N items need
 * attention"). "Continuing tomorrow?" is DERIVED from the studio schedule and
 * pre-filled (overridable); it hides the end-of-booking deep-clean items.
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { LockupItem } from '@/lib/op-api'

// Local mirror of the OP response (kept minimal — op-api owns the full types).
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
  reference_photos: { label: string; url: string }[]
  continuing_tomorrow: boolean
  continuing_derived: boolean
  submitted: {
    answers: Record<string, unknown>
    notes: string
    continuing_tomorrow: boolean
    submitted_at: string
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

const YESNO: { value: string; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'na', label: 'N/A' },
]

export default function LockupPage() {
  const params = useParams()
  const router = useRouter()
  const date = String(params?.date || '')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ctx, setCtx] = useState<LockupContext | null>(null)

  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [continuing, setContinuing] = useState<boolean | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState<{ exceptions: number } | null>(null)

  const fetchCtx = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}/lockup`)
      const data: LockupContext = await response.json()
      if (!response.ok || !data.success) {
        if (response.status === 401) { router.push('/login'); return }
        throw new Error(data.error || 'Failed to load the lock-up report')
      }
      setCtx(data)
      // Seed from a prior submission if present, else start fresh.
      const seed: Record<string, string> = {}
      if (data.submitted?.answers) {
        for (const [k, v] of Object.entries(data.submitted.answers)) seed[k] = String(v ?? '')
      }
      setAnswers(seed)
      setNotes(data.submitted?.notes ?? '')
      setContinuing(data.continuing_tomorrow)
    } catch (err) {
      console.error('Failed to load lock-up report:', err)
      setError(err instanceof Error ? err.message : 'Failed to load the lock-up report')
    } finally {
      setLoading(false)
    }
  }, [date, router])

  useEffect(() => {
    if (date) fetchCtx()
  }, [date, fetchCtx])

  const setAnswer = (id: string, value: string) => setAnswers((prev) => ({ ...prev, [id]: value }))

  // Items shown tonight: end-of-booking-only items drop out when continuing.
  const visibleItems = (ctx?.template.items ?? []).filter(
    (it) => !(it.end_of_booking_only && continuing)
  )

  const submit = useCallback(async () => {
    if (submitting || !ctx) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await fetch(`/api/studio-sitter/shifts/${date}/lockup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, notes: notes.trim(), continuing_tomorrow: continuing === true }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to submit')
      setDone({ exceptions: Array.isArray(data.exceptions) ? data.exceptions.length : 0 })
    } catch (err) {
      console.error('Failed to submit lock-up:', err)
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit the report')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, ctx, date, answers, notes, continuing])

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
          {notes.trim() && (
            <p className="mt-2 text-xs text-gray-500">Your note has been added to the handover thread.</p>
          )}
          <div className="mt-5 flex flex-col gap-2">
            <Link href={`/shift/${date}`} className="text-sm font-medium px-4 py-2.5 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-500 transition-colors">
              Back to shift
            </Link>
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 safe-top safe-bottom pb-24">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href={`/shift/${date}`}
            className="p-2 -ml-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            title="Back to shift"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-xl">🔒</span>
            <h1 className="text-lg font-semibold text-gray-900">Finish for the night</h1>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button onClick={fetchCtx} className="ml-2 underline hover:no-underline">Try again</button>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm animate-pulse">
            <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
            <div className="h-3 bg-gray-200 rounded w-1/2" />
          </div>
        ) : ctx && !ctx.has_shift ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
            This evening isn&apos;t set up as a shift yet — please contact the office before locking up.
          </div>
        ) : ctx ? (
          <>
            <div className="text-sm text-gray-500">{formatLongDate(ctx.date)}</div>

            {ctx.submitted && (
              <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-xs">
                Already submitted. You can update your answers and re-submit if something changed.
              </div>
            )}

            {ctx.template.intro && (
              <p className="text-sm text-gray-600 leading-relaxed">{ctx.template.intro}</p>
            )}

            {/* Reference photos */}
            {ctx.reference_photos.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">For reference</h2>
                <div className="grid grid-cols-2 gap-2">
                  {ctx.reference_photos.map((p, i) => (
                    <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                      <img src={p.url} alt={p.label} className="w-full h-28 object-cover rounded-lg border border-gray-200" />
                      {p.label && <p className="mt-1 text-[11px] text-gray-500 truncate">{p.label}</p>}
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* Continuing tomorrow? (derived, overridable) */}
            <section className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <p className="text-sm font-medium text-gray-900">Is the studio in use again tomorrow?</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {ctx.continuing_derived
                  ? 'Looks like there’s a session booked tomorrow — the end-of-night deep-clean items are hidden.'
                  : 'Looks like this is the last night — the deep-clean items are included below.'}
              </p>
              <div className="mt-3 flex gap-2">
                {[{ v: true, l: 'Yes, back tomorrow' }, { v: false, l: 'No, all done' }].map((opt) => (
                  <button
                    key={String(opt.v)}
                    type="button"
                    onClick={() => setContinuing(opt.v)}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${
                      continuing === opt.v
                        ? 'bg-ooosh-600 text-white border-ooosh-600'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </section>

            {/* Checklist */}
            <section className="space-y-2">
              {visibleItems.map((item) => {
                const val = answers[item.id] ?? ''
                const offExpected =
                  item.type === 'yesno' && item.expected !== undefined && val !== '' &&
                  val !== 'na' && val.toLowerCase() !== String(item.expected).toLowerCase()
                return (
                  <div
                    key={item.id}
                    className={`bg-white rounded-xl border p-3.5 shadow-sm ${offExpected ? 'border-amber-300 bg-amber-50/40' : 'border-gray-100'}`}
                  >
                    <p className="text-sm text-gray-900">{item.label}</p>
                    {item.type === 'yesno' ? (
                      <div className="mt-2 flex gap-2">
                        {YESNO.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => setAnswer(item.id, o.value)}
                            className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${
                              val === o.value
                                ? o.value === 'yes'
                                  ? 'bg-green-600 text-white border-green-600'
                                  : o.value === 'no'
                                    ? 'bg-red-500 text-white border-red-500'
                                    : 'bg-gray-500 text-white border-gray-500'
                                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        type={item.type === 'number' ? 'number' : 'text'}
                        value={val}
                        onChange={(e) => setAnswer(item.id, e.target.value)}
                        className="mt-2 w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-300"
                      />
                    )}
                  </div>
                )
              })}
            </section>

            {/* Notes */}
            <section className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <label className="text-sm font-medium text-gray-900">
                {ctx.template.notes_label || 'Anything we need to know?'}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Money owed, items taken, jobs for tomorrow, anything left undone…"
                className="mt-2 w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-300 resize-y min-h-[80px]"
              />
              {ctx.template.lost_property_prompt && (
                <p className="mt-2 text-xs text-gray-500">
                  {ctx.template.lost_property_prompt}{' '}
                  <Link href="/holding/lost-property" className="text-ooosh-600 hover:text-ooosh-500 underline">
                    Log lost property →
                  </Link>
                </p>
              )}
            </section>

            {submitError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{submitError}</div>
            )}
          </>
        ) : null}
      </main>

      {/* Sticky submit bar */}
      {ctx && ctx.has_shift && !loading && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-100 safe-bottom">
          <div className="max-w-lg mx-auto px-4 py-3">
            <button
              onClick={submit}
              disabled={submitting}
              className="w-full text-sm font-semibold px-4 py-3 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Submitting…' : '🔒 Submit & finish for the night'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
