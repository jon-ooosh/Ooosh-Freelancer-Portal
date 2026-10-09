'use client'

/**
 * The list of things to do on a yard day or a sitter evening
 * (STAFF-CALENDAR-SPEC §21). Shared by the dashboard's yard-day card and the
 * shift page.
 *
 * A live list — staff can change it at any time, so it is read on every load.
 *  - An 'other' task: tap the row to tick it off; tap again to undo a mis-tap
 *    (only a tick made here — one the office made is theirs).
 *  - A van prep: "Open prep sheet" opens that van's prep in OP, no login
 *    needed. Saving the prep ticks the task off, so there is no tick button.
 */

import { useEffect, useState } from 'react'
import type { PortalFreelancerTask } from '@/lib/op-api'

export default function FreelancerTaskList({ tasks, heading = 'What we need a hand with' }: {
  tasks: PortalFreelancerTask[]
  heading?: string
}) {
  // Local copy so a tick shows straight away without reloading the page.
  const [items, setItems] = useState<PortalFreelancerTask[]>(tasks)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // A fresh read from the page replaces the local copy.
  useEffect(() => { setItems(tasks) }, [tasks])

  const visible = items.filter((t) => t.status !== 'cancelled')
  if (visible.length === 0) return null

  async function setDone(id: string, done: boolean) {
    setBusyId(id)
    setError('')
    try {
      const res = await fetch(`/api/freelancer-tasks/${id}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'That did not save')
      if (data.task) setItems((prev) => prev.map((t) => (t.id === id ? data.task : t)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save')
    } finally {
      setBusyId(null)
    }
  }

  // Same tab on purpose: a new tab opened after an await is eaten by popup
  // blockers, and Back returns them here when the prep is saved.
  async function openPrep(id: string) {
    setBusyId(id)
    setError('')
    try {
      const res = await fetch(`/api/freelancer-tasks/${id}/prep-link`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success || !data.url) throw new Error(data.error || 'Could not open the prep sheet')
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the prep sheet')
      setBusyId(null)
    }
  }

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{heading}</p>
      <ul className="space-y-2">
        {visible.map((t) => {
          const done = t.status === 'done'
          const busy = busyId === t.id
          const circle = (
            <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center text-xs ${
              done ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300 bg-white'}`}>
              {done ? '✓' : ''}
            </span>
          )
          const text = (
            <span className="min-w-0 flex-1 text-left">
              <span className={`block text-sm ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{t.title}</span>
              {t.detail && <span className="block text-xs text-gray-500">{t.detail}</span>}
            </span>
          )

          if (t.taskType === 'van_prep') {
            return (
              <li key={t.id} className="flex items-start gap-3 p-2 rounded-lg border border-gray-100">
                {circle}
                {text}
                {!done && (
                  <button type="button" disabled={busy} onClick={() => void openPrep(t.id)}
                    className="shrink-0 min-h-[44px] px-4 rounded-lg text-sm font-semibold bg-ooosh-600 text-white hover:bg-ooosh-500 disabled:opacity-40">
                    {busy ? 'Opening…' : 'Open prep sheet'}
                  </button>
                )}
              </li>
            )
          }

          // An 'other' task: the whole row is the tick. A tick the office made
          // (or anyone but them) cannot be undone from here.
          const canToggle = !done || t.doneByMe
          return (
            <li key={t.id}>
              <button type="button" disabled={busy || !canToggle}
                onClick={() => void setDone(t.id, !done)}
                aria-pressed={done}
                className="w-full min-h-[44px] flex items-start gap-3 p-2 rounded-lg border border-gray-100 hover:bg-gray-50 disabled:opacity-60 disabled:hover:bg-transparent">
                {circle}
                {text}
                <span className="shrink-0 self-center text-xs text-gray-400">
                  {busy ? '…' : done ? (t.doneByMe ? 'Tap to undo' : 'Done') : 'Tap when done'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
