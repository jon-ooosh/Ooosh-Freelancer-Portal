'use client'

/**
 * MuteBanner
 *
 * Sticky red banner across the top of every authenticated portal page.
 * Surfaces the global notification mute state with an inline Resume action.
 *
 * Hidden when:
 *   - User is not authenticated (GET /api/settings/notifications returns 401)
 *   - No global mute is active
 *   - Settings fetch fails for any other reason (fail-quiet — banner is a
 *     surfacing aid, not a critical UI)
 *
 * Note: this controls only "informational" notifications (new allocations,
 * date/time/venue changes). Completion chase emails always send regardless
 * of mute state — that's enforced server-side in the completion-chaser.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface NotificationSettings {
  globalMuteActive: boolean
  globalMuteUntil: string | null
}

function formatPauseLabel(dateStr: string | null): string {
  if (!dateStr) return 'paused'

  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return 'paused'

  // Far-future sentinel = "indefinitely"
  const yearsFromNow = (date.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000)
  if (yearsFromNow > 5) {
    return 'paused indefinitely'
  }

  // "End of today" — date is tomorrow at 00:00
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  const dateOnly = new Date(date)
  dateOnly.setHours(0, 0, 0, 0)
  if (dateOnly.getTime() === tomorrow.getTime()) {
    return 'paused until tomorrow'
  }

  const formatted = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
  return `paused until ${formatted}`
}

export function MuteBanner() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [resuming, setResuming] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/notifications', { cache: 'no-store' })
      if (!res.ok) {
        setSettings(null)
        return
      }
      const data = await res.json()
      if (data?.success && data?.notifications) {
        setSettings({
          globalMuteActive: !!data.notifications.globalMuteActive,
          globalMuteUntil: data.notifications.globalMuteUntil ?? null,
        })
      } else {
        setSettings(null)
      }
    } catch {
      setSettings(null)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleResume = async () => {
    if (resuming) return
    setResuming(true)
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unmute_global' }),
      })
      if (res.ok) {
        setSettings(null)
      }
    } catch {
      // fail-quiet; user can retry from Settings
    } finally {
      setResuming(false)
    }
  }

  if (!settings?.globalMuteActive) return null

  const label = formatPauseLabel(settings.globalMuteUntil)

  return (
    <div className="sticky top-0 z-50 bg-red-600 text-white shadow-md">
      <div className="max-w-lg mx-auto px-4 py-2 flex items-center justify-between gap-3">
        <Link
          href="/settings"
          className="flex items-center gap-2 text-sm font-medium hover:underline min-w-0"
        >
          <span aria-hidden="true">🔕</span>
          <span className="truncate">Notifications {label}</span>
        </Link>
        <button
          type="button"
          onClick={handleResume}
          disabled={resuming}
          className="shrink-0 bg-white/20 hover:bg-white/30 disabled:opacity-50 px-3 py-1.5 rounded-md text-sm font-semibold min-h-[36px]"
        >
          {resuming ? '…' : 'Resume'}
        </button>
      </div>
    </div>
  )
}
