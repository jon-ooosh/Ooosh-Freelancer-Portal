'use client'

/**
 * Settings Page
 * 
 * Allows freelancers to:
 * - View their profile info (read-only)
 * - Manage notification preferences (mute/unmute)
 * - Log out
 */

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
  })
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
      setSuccess('Notifications muted')
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
      setSuccess('Notifications enabled')
      
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
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading settings...</p>
        </div>
      </div>
    )
  }

  // Helper to show spinner on specific button
  const isButtonSaving = (action: string) => saving && savingAction === action

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto p-4 space-y-6">
        
        {/* Success/Error Messages */}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {success}
          </div>
        )}
        
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Profile Section */}
        <section className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span>👤</span> Profile
          </h2>
          
          {user ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm text-gray-500">Name</p>
                <p className="font-medium text-gray-900">{user.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Email</p>
                <p className="font-medium text-gray-900">{user.email}</p>
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Contact Ooosh if your details need updating
              </p>
            </div>
          ) : (
            <p className="text-gray-500">Could not load profile</p>
          )}
        </section>

        {/* Notifications Section */}
        <section className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span>🔔</span> Notifications
          </h2>
          
          {/* Current Status */}
          {notifications?.globalMuteActive ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-amber-800">🔕 Notifications paused</p>
                  <p className="text-sm text-amber-600">
                    Until {formatMuteDate(notifications.globalMuteUntil)}
                  </p>
                </div>
                <button
                  onClick={handleUnmute}
                  disabled={saving}
                  className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {isButtonSaving('unmute') && (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  )}
                  Turn On
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-green-600">✓</span>
                <p className="font-medium text-green-800">Notifications are enabled</p>
              </div>
              <p className="text-sm text-green-600 mt-1">
                You&apos;ll receive emails for new jobs, changes, and cancellations
              </p>
            </div>
          )}

          {/* Mute Options */}
          {!notifications?.globalMuteActive && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 mb-3">Pause notifications:</p>
              
              <button
                onClick={() => handleMute('end_of_today')}
                disabled={saving}
                className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-gray-900">Until end of today</p>
                  <p className="text-sm text-gray-500">Resume tomorrow morning</p>
                </div>
                {isButtonSaving('end_of_today') && (
                  <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                )}
              </button>
              
              <button
                onClick={() => handleMute('7_days')}
                disabled={saving}
                className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-gray-900">For 7 days</p>
                  <p className="text-sm text-gray-500">Good for a week off</p>
                </div>
                {isButtonSaving('7_days') && (
                  <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                )}
              </button>
              
              <button
                onClick={() => setShowDatePicker(true)}
                disabled={saving}
                className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-gray-900">Until a specific date</p>
                  <p className="text-sm text-gray-500">Choose when to resume</p>
                </div>
                {isButtonSaving('specific_date') && (
                  <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                )}
              </button>
              
              <button
                onClick={() => setShowIndefiniteConfirm(true)}
                disabled={saving}
                className="w-full text-left px-4 py-3 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50 border border-red-200 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-red-700">⚠️ Until I turn back on</p>
                  <p className="text-sm text-red-600">You won&apos;t receive any job notifications</p>
                </div>
                {isButtonSaving('indefinite') && (
                  <div className="w-5 h-5 border-2 border-red-500 border-t-transparent rounded-full animate-spin"></div>
                )}
              </button>
            </div>
          )}
          
          {/* Per-job mutes info */}
          {notifications && notifications.mutedJobCount > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-sm text-gray-500">
                You also have {notifications.mutedJobCount} individual job{notifications.mutedJobCount !== 1 ? 's' : ''} muted.
                Manage these from each job&apos;s details page.
              </p>
            </div>
          )}
        </section>

        {/* Logout Section */}
        <section className="bg-white rounded-xl shadow-sm p-6">
          <button
            onClick={handleLogout}
            className="w-full text-center text-red-600 font-medium py-2 hover:text-red-700"
          >
            Log out
          </button>
        </section>

      </main>

      {/* Date Picker Modal */}
      {showDatePicker && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <h3 className="font-semibold text-gray-900 mb-4">Choose date</h3>
            <p className="text-sm text-gray-600 mb-4">
              Notifications will resume after this date
            </p>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowDatePicker(false)
                  setSelectedDate('')
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => selectedDate && handleMute('specific_date', selectedDate)}
                disabled={!selectedDate || saving}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isButtonSaving('specific_date') && (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                )}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Indefinite Confirmation Modal */}
      {showIndefiniteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <div className="text-center mb-4">
              <span className="text-4xl">⚠️</span>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2 text-center">Turn off all notifications?</h3>
            <p className="text-sm text-gray-600 mb-4 text-center">
              You won&apos;t receive any emails about new jobs, changes, or cancellations until you manually turn notifications back on.
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-amber-800 text-center">
                <strong>Important:</strong> You may miss time-sensitive job updates
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowIndefiniteConfirm(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleMute('indefinite')}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isButtonSaving('indefinite') && (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                )}
                Turn Off
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200">
        <div className="max-w-lg mx-auto px-4 py-2 flex justify-around">
          <Link href="/dashboard" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span className="text-xs mt-1">Jobs</span>
          </Link>
          <Link href="/earnings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs mt-1">Earnings</span>
          </Link>
          <Link href="/resources" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span className="text-xs mt-1">Resources</span>
          </Link>
          <Link href="/settings" className="flex flex-col items-center py-2 px-3 text-purple-600">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-xs mt-1">Settings</span>
          </Link>
        </div>
      </nav>
    </div>
  )
}