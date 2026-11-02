'use client'

/**
 * Settings Page (Oct 2026 refresh, design 2h)
 *
 * The "Job emails" status and the ways to pause them live in ONE card, so it
 * is clear what is being paused (design behaviour change 5).
 *
 * Allows freelancers to:
 * - View their profile info (read-only)
 * - Manage notification preferences (mute/unmute)
 * - Log out
 */

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Check, BellOff, AlertTriangle } from 'lucide-react'
import BottomNav from '@/components/BottomNav'
import { cls, Banner, Chevron, PageSpinner } from '@/components/ui'
import { ukToday } from '@/lib/ukDate'

// =============================================================================
// TYPES
// =============================================================================

interface NotificationSettings {
  globalMuteActive: boolean
  globalMuteUntil: string | null
  mutedJobIds: string[]
  mutedJobCount: number
}

interface UserInfo {
  id: string
  name: string
  email: string
}

// =============================================================================
// HELPERS
// =============================================================================

function formatMuteDate(dateStr: string | null): string {
  if (!dateStr) return ''
  
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  
  // Check if it's far in the future (indefinite)
  const yearsFromNow = (date.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000)
  if (yearsFromNow > 5) {
    return 'indefinitely'
  }
  
  // Check if it's tomorrow (meaning "end of today")
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  const dateOnly = new Date(date)
  dateOnly.setHours(0, 0, 0, 0)
  
  if (dateOnly.getTime() === tomorrow.getTime()) {
    return 'end of today'
  }
  
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  }).replace(',', '')
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function SettingsPage() {
  const router = useRouter()
  
  // State
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingAction, setSavingAction] = useState<string | null>(null) // Track which button is saving
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  
  // User info
  const [user, setUser] = useState<UserInfo | null>(null)
  
  // Notification settings
  const [notifications, setNotifications] = useState<NotificationSettings | null>(null)
  
  // Modal states
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showIndefiniteConfirm, setShowIndefiniteConfirm] = useState(false)
  const [selectedDate, setSelectedDate] = useState('')

  // ===========================================
  // FETCH SETTINGS
  // ===========================================
  
  const fetchSettings = useCallback(async () => {
    try {
      // Fetch user info from jobs API (it includes user data)
      const userRes = await fetch('/api/jobs')
      const userData = await userRes.json()
      
      if (!userRes.ok) {
        if (userRes.status === 401) {
          router.push('/login')
          return
        }
        throw new Error(userData.error || 'Failed to fetch user')
      }
      
      if (userData.user) {
        setUser(userData.user)
      }
      
      // Fetch notification settings
      const notifRes = await fetch('/api/settings/notifications')
      const notifData = await notifRes.json()
      
      if (notifRes.ok && notifData.success) {
        setNotifications(notifData.notifications)
      }
      
    } catch (err) {
      console.error('Failed to fetch settings:', err)
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // Clear success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  // ===========================================
  // MUTE ACTIONS
  // ===========================================

  const handleMute = async (muteType: '7_days' | 'end_of_today' | 'specific_date' | 'indefinite', date?: string) => {
    setSaving(true)
    setSavingAction(muteType)
    setError(null)
    setSuccess(null)
    
    try {
      const body: Record<string, string> = {
        action: 'mute_global',
        muteType,
      }
      if (date) {
        body.muteUntilDate = date
      }
      
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      
      const data = await res.json()
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to update settings')
      }
      
      // Refresh settings
      await fetchSettings()
      setSuccess('Job emails paused')
      setShowDatePicker(false)
      setShowIndefiniteConfirm(false)
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mute notifications')
    } finally {
      setSaving(false)
      setSavingAction(null)
    }
  }

  const handleUnmute = async () => {
    setSaving(true)
    setSavingAction('unmute')
    setError(null)
    setSuccess(null)
    
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unmute_global' }),
      })
      
      const data = await res.json()
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to update settings')
      }
      
      await fetchSettings()
      setSuccess('Job emails are back on')
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable notifications')
    } finally {
      setSaving(false)
      setSavingAction(null)
    }
  }

  // ===========================================
  // LOGOUT
  // ===========================================

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/login')
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  // ===========================================
  // RENDER
  // ===========================================

  if (loading) {
    return <PageSpinner label="Loading settings..." />
  }

  // Helper to show spinner on specific button
  const isButtonSaving = (action: string) => saving && savingAction === action

  const initials = (user?.name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')

  const spinner = <span className="w-5 h-5 border-2 border-hf-accent border-t-transparent rounded-full animate-spin" />

  // One pause option: a full-width row in the Job emails card.
  // Called as a function, not used as a component, so React doesn't remount it each render.
  const pauseRow = ({ title, sub, onClick, action, danger = false }: {
    title: string; sub: string; onClick: () => void; action: string; danger?: boolean
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="w-full min-h-[56px] px-4 py-2 flex items-center justify-between text-left hover:bg-hf-inset disabled:opacity-50"
    >
      <span className="flex flex-col">
        <span className={`text-[16px] font-medium ${danger ? 'text-hf-error' : 'text-hf-ink'}`}>{title}</span>
        <span className="text-[14px] text-hf-muted">{sub}</span>
      </span>
      {isButtonSaving(action) ? spinner : <Chevron />}
    </button>
  )
  const divider = <div className="h-px bg-hf-divider mx-4" />

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-6 pb-2">
        <h1 className={cls.pageTitle}>Settings</h1>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-3 flex flex-col gap-[18px]">
        {/* Success/Error Messages */}
        {success && (
          <Banner tone="success" className="flex items-center gap-2"><Check size={18} strokeWidth={2.4} />{success}</Banner>
        )}
        {error && <Banner tone="error">{error}</Banner>}

        {/* Profile (read-only) */}
        <div className="flex flex-col gap-2">
          <section className={`${cls.card} p-4 flex items-center gap-3.5`}>
            {user ? (
              <>
                <div className="w-12 h-12 rounded-full bg-hf-tint text-hf-tint-text flex items-center justify-center text-[18px] font-bold flex-none">
                  {initials || '?'}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[17px] font-semibold text-hf-ink truncate">{user.name}</span>
                  <span className="text-[15px] text-hf-muted truncate">{user.email}</span>
                </div>
              </>
            ) : (
              <p className="text-hf-muted text-[15px]">Could not load your details</p>
            )}
          </section>
          <p className="text-[14px] text-hf-muted px-1">Need to change these? Get in touch with Ooosh.</p>
        </div>

        {/* Job emails: the status and the ways to pause them, in one card */}
        <section className={`${cls.card} flex flex-col overflow-hidden`}>
          <div className="px-4 py-3.5 flex items-start gap-3">
            <div className="flex-1 flex flex-col gap-0.5">
              <span className="text-[17px] font-semibold text-hf-ink">Job emails</span>
              <span className="text-[14px] text-hf-muted">
                {notifications?.globalMuteActive
                  ? `Paused until ${formatMuteDate(notifications.globalMuteUntil)}`
                  : 'New jobs, changes and cancellations'}
              </span>
            </div>
            {notifications?.globalMuteActive ? (
              <span className="inline-flex items-center gap-1.5 text-[14px] font-bold bg-hf-amber-bg text-hf-amber-text rounded-full px-2.5 py-1">
                <BellOff size={15} strokeWidth={2.2} />Paused
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[14px] font-bold bg-hf-green-tint text-hf-green-text rounded-full px-2.5 py-1">
                <Check size={15} strokeWidth={2.6} />On
              </span>
            )}
          </div>

          {notifications?.globalMuteActive ? (
            <div className="px-4 pb-4">
              <button type="button" onClick={handleUnmute} disabled={saving} className={`${cls.btnPrimary} w-full`}>
                {isButtonSaving('unmute') && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Turn job emails back on
              </button>
            </div>
          ) : (
            <>
              {divider}
              <div className={`${cls.sectionLabel} !tracking-[0.06em] px-4 pt-3 pb-1`}>Pause job emails</div>
              {pauseRow({ title: "Until end of today", sub: "Back on tomorrow morning", action: "end_of_today", onClick: () => handleMute('end_of_today') })}
              {divider}
              {pauseRow({ title: "For 7 days", sub: "Good for a week off", action: "7_days", onClick: () => handleMute('7_days') })}
              {divider}
              {pauseRow({ title: "Until a date", sub: "Pick when to switch back on", action: "specific_date", onClick: () => setShowDatePicker(true) })}
              {divider}
              {pauseRow({ title: "Until I turn them back on", sub: "You could miss urgent job changes", action: "indefinite", danger: true, onClick: () => setShowIndefiniteConfirm(true) })}
            </>
          )}

          {/* Per-job mutes info */}
          {notifications && notifications.mutedJobCount > 0 && (
            <>
              {divider}
              <p className="px-4 py-3 text-[14px] text-hf-muted">
                You also have {notifications.mutedJobCount} individual job{notifications.mutedJobCount !== 1 ? 's' : ''} muted.
                Manage these from each job&apos;s details page.
              </p>
            </>
          )}
        </section>

        {/* Logout */}
        <button
          type="button"
          onClick={handleLogout}
          className="h-[54px] rounded-[14px] bg-white border border-hf-border text-[16px] font-semibold text-hf-error hover:bg-hf-inset"
        >
          Log out
        </button>
      </main>

      {/* Date Picker Modal */}
      {showDatePicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[18px] p-5 w-full max-w-sm flex flex-col gap-4">
            <div>
              <h3 className="text-[18px] font-semibold text-hf-ink">Pause until</h3>
              <p className="text-[15px] text-hf-muted mt-1">Job emails switch back on after this date</p>
            </div>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              min={ukToday()}
              className={`${cls.input} h-[52px]`}
            />
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setShowDatePicker(false)
                  setSelectedDate('')
                }}
                className={cls.btnSecondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => selectedDate && handleMute('specific_date', selectedDate)}
                disabled={!selectedDate || saving}
                className={`${cls.btnPrimary} !h-[50px] !rounded-xl !text-[16px]`}
              >
                {isButtonSaving('specific_date') && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Pause
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Indefinite Confirmation Modal */}
      {showIndefiniteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[18px] p-5 w-full max-w-sm flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="w-12 h-12 rounded-full bg-hf-amber-bg text-hf-amber-text flex items-center justify-center"><AlertTriangle size={24} strokeWidth={2} /></span>
              <h3 className="text-[18px] font-semibold text-hf-ink">Turn off all job emails?</h3>
              <p className="text-[15px] text-hf-body leading-[1.45]">
                You won&apos;t receive any emails about new jobs, changes or cancellations until you turn them back on yourself.
              </p>
            </div>
            <Banner tone="warning" className="text-center"><strong>Important:</strong> you may miss time-sensitive job updates.</Banner>
            <div className="grid grid-cols-2 gap-2.5">
              <button type="button" onClick={() => setShowIndefiniteConfirm(false)} className={cls.btnSecondary}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleMute('indefinite')}
                disabled={saving}
                className="inline-flex items-center justify-center gap-2 h-[50px] rounded-xl bg-hf-error text-white text-[16px] font-semibold disabled:opacity-50"
              >
                {isButtonSaving('indefinite') && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Turn off
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav active="settings" />
    </div>
  )
}
