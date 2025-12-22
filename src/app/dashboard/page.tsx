'use client'

import { useState, useEffect } from 'react'

// =============================================================================
// TODO: PLACEHOLDER DATA
// The job cards in the "Upcoming" section are placeholder/mock data for UI 
// demonstration only. Replace with real API calls to /api/jobs once working.
// =============================================================================

export default function DashboardPage() {
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  const [userName, setUserName] = useState('Freelancer')

  useEffect(() => {
    // TODO: Fetch user info and jobs from API
    // For now, showing placeholder state
    setLoading(false)
  }, [])

  const handleRefresh = () => {
    setLoading(true)
    // TODO: Refetch jobs from API
    setTimeout(() => {
      setLastUpdated(new Date())
      setLoading(false)
    }, 500)
  }

  const formatLastUpdated = () => {
    const now = new Date()
    const diff = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000 / 60)
    if (diff < 1) return 'Just now'
    if (diff === 1) return '1 min ago'
    return `${diff} mins ago`
  }

  return (
    <div className="min-h-screen bg-gray-50 safe-top safe-bottom pb-20">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-ooosh-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-lg font-bold">O</span>
              </div>
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Welcome back</h1>
                <p className="text-sm text-gray-500">{userName}</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                title="Refresh"
              >
                <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <a
                href="/settings"
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title="Settings"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </a>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Last updated: {formatLastUpdated()}</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        
        {/* Today Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center">
            <span className="mr-2">📅</span>
            Today
          </h2>
          
          {/* Empty state */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
            <div className="text-gray-400 mb-2">
              <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-gray-500 text-sm">No jobs scheduled for today</p>
          </div>
        </section>

        {/* Upcoming Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center">
            <span className="mr-2">📆</span>
            Upcoming
          </h2>
          
          {/* =================================================================
              TODO: PLACEHOLDER JOB CARDS
              These are hardcoded examples for UI demonstration.
              Replace with real data from API once /api/jobs endpoint is built.
              ================================================================= */}
          <div className="space-y-3">
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <span className="text-blue-600">📦</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Delivery - O2 Arena</p>
                    <p className="text-sm text-gray-500">Friday 29 Nov · 6:00 PM</p>
                  </div>
                </div>
                <span className="text-sm font-medium text-green-600">£85</span>
              </div>
              <div className="mt-3 flex justify-end">
                <a href="#" className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500">
                  View details →
                </a>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center">
                    <span className="text-orange-600">🚚</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Collection - Brighton Dome</p>
                    <p className="text-sm text-gray-500">Saturday 30 Nov · 10:00 AM</p>
                  </div>
                </div>
                <span className="text-sm font-medium text-green-600">£75</span>
              </div>
              <div className="mt-3 flex justify-end">
                <a href="#" className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500">
                  View details →
                </a>
              </div>
            </div>
          </div>
          {/* END PLACEHOLDER JOB CARDS */}
        </section>

        {/* Completed Section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center">
              <span className="mr-2">✅</span>
              Completed
            </h2>
            <a href="#" className="text-xs font-medium text-ooosh-600 hover:text-ooosh-500">
              View all →
            </a>
          </div>
          
          <div className="bg-gray-100 rounded-xl p-4 text-center">
            <p className="text-gray-500 text-sm">No completed jobs in the last 30 days</p>
          </div>
        </section>

        {/* Cancelled Section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center">
              <span className="mr-2">❌</span>
              Cancelled
            </h2>
            <a href="#" className="text-xs font-medium text-ooosh-600 hover:text-ooosh-500">
              View all →
            </a>
          </div>
          
          <div className="bg-gray-100 rounded-xl p-4 text-center">
            <p className="text-gray-500 text-sm">No cancelled jobs</p>
          </div>
        </section>

      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom">
        <div className="max-w-lg mx-auto px-4 py-2 flex justify-around">
          <a href="/dashboard" className="flex flex-col items-center py-2 px-3 text-ooosh-600">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span className="text-xs mt-1">Jobs</span>
          </a>
          <a href="/earnings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs mt-1">Earnings</span>
          </a>
          <a href="/settings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-xs mt-1">Settings</span>
          </a>
        </div>
      </nav>
    </div>
  )
}
