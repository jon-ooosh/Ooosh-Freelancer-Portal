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
import { Check } from 'lucide-react'
import type { PortalFreelancerTask } from '@/lib/op-api'
import { cls } from '@/components/ui'

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
    <div className="mt-1">
      <p className={`${cls.sectionLabel} !text-[12px] mb-2`}>{heading}</p>
      <ul className="flex flex-col gap-2">
        {visible.map((t) => {
          const done = t.status === 'done'
          const busy = busyId === t.id
          // The design's checkbox: 26px r8; ticked green with a white check.
          const box = (
            <span className={`mt-px w-[26px] h-[26px] shrink-0 rounded-lg flex items-center justify-center ${
              done ? 'bg-hf-green text-white' : 'border-2 border-hf-dashed bg-white'}`}>
              {done && <Check size={16} strokeWidth={3} />}
            </span>
          )
          const text = (
            <span className="min-w-0 flex-1 text-left">
              <span className={`block text-[15px] ${done ? 'text-hf-muted line-through' : 'text-hf-ink'}`}>{t.title}</span>
              {t.detail && <span className="block text-[13px] text-hf-muted">{t.detail}</span>}
            </span>
          )

          if (t.taskType === 'van_prep') {
            return (
              <li key={t.id} className="flex flex-col gap-2.5 p-2.5 rounded-xl border border-hf-border bg-white">
                <div className="flex items-start gap-3">
                  {box}
                  {text}
                </div>
                {!done && (
                  <button type="button" disabled={busy} onClick={() => void openPrep(t.id)}
                    className="w-full min-h-[44px] px-4 rounded-xl text-[15px] font-semibold bg-hf-accent text-white hover:bg-hf-accent-pressed disabled:opacity-40">
                    {busy ? 'Opening...' : 'Open prep sheet'}
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
                className="w-full min-h-[48px] flex items-start gap-3 p-2.5 rounded-xl border border-hf-border bg-white hover:bg-hf-inset disabled:opacity-60 disabled:hover:bg-white">
                {box}
                {text}
                <span className="shrink-0 self-center text-[13px] text-hf-muted">
                  {busy ? '...' : done ? (t.doneByMe ? 'Tap to undo' : 'Done') : 'Tap when done'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-[13px] text-hf-error">{error}</p>}
    </div>
  )
}
