'use client'

/**
 * The list of things to do on a yard day or a sitter evening
 * (STAFF-CALENDAR-SPEC §21). Shared by the dashboard's yard-day card and the
 * shift page.
 *
 * A live list — staff can change it at any time, so it is read on every load.
 * An 'other' task has a Done button; a van prep is ticked off by saving the
 * prep sheet for that van, so it shows a hint instead of a button.
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

  async function markDone(id: string) {
    setBusyId(id)
    setError('')
    try {
      const res = await fetch(`/api/freelancer-tasks/${id}/done`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'That did not save')
      if (data.task) setItems((prev) => prev.map((t) => (t.id === id ? data.task : t)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{heading}</p>
      <ul className="space-y-2">
        {visible.map((t) => {
          const done = t.status === 'done'
          return (
            <li key={t.id} className="flex items-start gap-3">
              <span className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-xs ${
                done ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300'}`}>
                {done ? '✓' : ''}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{t.title}</p>
                {t.detail && <p className="text-xs text-gray-500">{t.detail}</p>}
                {!done && t.taskType === 'van_prep' && (
                  <p className="text-xs text-gray-400">Ticks itself off when the prep sheet is saved</p>
                )}
              </div>
              {!done && t.taskType === 'other' && (
                <button
                  type="button"
                  disabled={busyId === t.id}
                  onClick={() => void markDone(t.id)}
                  className="shrink-0 min-h-[44px] px-4 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  {busyId === t.id ? '…' : 'Done'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
