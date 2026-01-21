'use client' 

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// =============================================================================
// TYPES (matching API response)
// =============================================================================

interface OrganisedJob {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  time?: string
  venueName?: string
  driverPay?: number
  runGroup?: string
  hhRef?: string
  keyNotes?: string
  completedAtDate?: string
}

interface GroupedRun {
  isGrouped: true
  runGroup: string
  date: string
  jobs: OrganisedJob[]
  totalFee: number
  jobCount: number
}

interface SingleJob extends OrganisedJob {
  isGrouped: false
}

type DisplayItem = GroupedRun | SingleJob

interface JobsApiResponse {
  success: boolean
  user?: {
    id: string
    name: string
    email: string
  }
  today?: DisplayItem[]
  upcoming?: DisplayItem[]
  completed?: DisplayItem[]
  cancelled?: DisplayItem[]
  error?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format a date string for display (e.g., "Friday 29 Nov")
 */
function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`
}

/**
 * Format a time string for display (e.g., "10:00 AM")
 */
function formatTime(timeStr: string | undefined): string {
  if (!timeStr) return ''
  
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match) return timeStr
  
  const hours = parseInt(match[1])
  const minutes = match[2]
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  
  return `${displayHours}:${minutes} ${ampm}`
}

/**
 * Format currency for display
 */
function formatFee(amount: number | undefined): string {
  if (amount === undefined || amount === null) return ''
  return `£${amount.toFixed(0)}`
}

/**
 * Get the first name from a full name
 */
function getFirstName(fullName: string): string {
  return fullName.split(' ')[0] || fullName
}

/**
 * Strip DEL/COL prefix and get clean venue name
 */
function getDisplayName(name: string, venueName?: string): string {
  if (venueName) return venueName
  return name.replace(/^(DEL|COL)\s*[-:]\s*/i, '').trim()
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Job Card Component - displays a single job or grouped run
 */
function JobCard({ item, showStartButton = true }: { item: DisplayItem; showStartButton?: boolean }) {
  if (item.isGrouped) {
    // Multi-drop run card
    const firstJob = item.jobs[0]
    const isCompleted = item.jobs.every(j => j.completedAtDate)
    
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
              <span className="text-purple-600">📦</span>
            </div>
            <div>
              <p className="font-medium text-gray-900">
                Multi-drop Run ({item.jobCount} stops)
              </p>
              <p className="text-sm text-gray-500">
                {formatDate(item.date)}
                {firstJob?.time && ` · ${formatTime(firstJob.time)}`}
              </p>
            </div>
          </div>
          {item.totalFee > 0 && (
            <span className="text-sm font-medium text-green-600">
              {formatFee(item.totalFee)}
            </span>
          )}
        </div>
        
        {/* Show stop previews */}
        <div className="mt-3 pl-13 space-y-1">
          {item.jobs.slice(0, 3).map((job, idx) => (
            <p key={job.id} className="text-xs text-gray-500">
              {idx + 1}. {getDisplayName(job.name, job.venueName)}
            </p>
          ))}
          {item.jobs.length > 3 && (
            <p className="text-xs text-gray-400">
              +{item.jobs.length - 3} more stops
            </p>
          )}
        </div>
        
        {/* Action buttons */}
        <div className="mt-3 flex justify-between items-center">
          <Link 
            href={`/job/${firstJob?.id}?run=${item.runGroup}`} 
            className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500"
          >
            View details →
          </Link>
          {showStartButton && !isCompleted && (
            <Link 
              href={`/job/${firstJob?.id}/complete`} 
              className="text-sm font-medium text-green-600 hover:text-green-500 flex items-center gap-1"
            >
              <span>▶</span> Start run
            </Link>
          )}
        </div>
      </div>
    )
  }
  
  // Single job card
  const isDelivery = item.type === 'delivery'
  const isCompleted = !!item.completedAtDate
  
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
            isDelivery ? 'bg-blue-100' : 'bg-orange-100'
          }`}>
            <span className={isDelivery ? 'text-blue-600' : 'text-orange-600'}>
              {isDelivery ? '📦' : '🚚'}
            </span>
          </div>
          <div>
            <p className="font-medium text-gray-900">
              {isDelivery ? 'Delivery' : 'Collection'} - {getDisplayName(item.name, item.venueName)}
            </p>
            <p className="text-sm text-gray-500">
              {formatDate(item.date)}
              {item.time && ` · ${formatTime(item.time)}`}
            </p>
          </div>
        </div>
         {item.driverPay !== undefined && item.driverPay > 0 && (
          <span className="text-sm font-medium text-green-600">
            {formatFee(item.driverPay)}
          </span>
        )}
      </div>
      
      {/* Action buttons */}
      <div className="mt-3 flex justify-between items-center">
        <Link 
          href={`/job/${item.id}`} 
          className="text-sm font-medium text-ooosh-600 hover:text-ooosh-500"
        >
          View details →
        </Link>
        {showStartButton && !isCompleted && (
          <Link 
            href={`/job/${item.id}/complete`} 
            className="text-sm font-medium text-green-600 hover:text-green-500 flex items-center gap-1"
          >
            <span>▶</span> Start {isDelivery ? 'delivery' : 'collection'}
          </Link>
        )}
      </div>
    </div>
  )
}

/**
 * Empty State Component
 */
function EmptyState({ message }: { message: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
      <div className="text-gray-400 mb-2">
        <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
      <p className="text-gray-500 text-sm">{message}</p>
    </div>
  )
}

/**
 * Loading Skeleton Component
 */
function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm animate-pulse">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gray-200 rounded-lg" />
            <div className="flex-1">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// MAIN DASHBOARD PAGE
// =============================================================================

export default function DashboardPage() {
  const router = useRouter()
  
  // State
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  
  // User info
  const [userName, setUserName] = useState<string>('')
  
  // Job data
  const [todayJobs, setTodayJobs] = useState<DisplayItem[]>([])
  const [upcomingJobs, setUpcomingJobs] = useState<DisplayItem[]>([])
  const [completedJobs, setCompletedJobs] = useState<DisplayItem[]>([])
  const [cancelledJobs, setCancelledJobs] = useState<DisplayItem[]>([])

  /**
   * Fetch jobs from the API
   */
  const fetchJobs = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    try {
      const response = await fetch('/api/jobs')
      const data: JobsApiResponse = await response.json()
      
      if (!response.ok || !data.success) {
        if (response.status === 401) {
          router.push('/login')
          return
        }
        throw new Error(data.error || 'Failed to load jobs')
      }
      
      // Update user info
      if (data.user) {
        setUserName(getFirstName(data.user.name))
      }
      
      // Update job lists
      setTodayJobs(data.today || [])
      setUpcomingJobs(data.upcoming || [])
      setCompletedJobs(data.completed || [])
      setCancelledJobs(data.cancelled || [])
      setLastUpdated(new Date())
      
    } catch (err) {
      console.error('Failed to fetch jobs:', err)
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [router])

  // Fetch jobs on mount
  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  /**
   * Handle refresh button click
   */
  const handleRefresh = () => {
    fetchJobs()
  }

  /**
   * Handle logout
   */
  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/login')
    } catch (error) {
      console.error('Logout failed:', error)
      setLoggingOut(false)
    }
  }

  /**
   * Format "last updated" time
   */
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
              {/* Logo */}
              <div className="w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden">
                <img 
                  src="/ooosh-tours-logo-small.png" 
                  alt="Ooosh Tours" 
                  className="w-full h-full object-contain"
                />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-gray-900">
                  {userName ? `Welcome back` : 'Dashboard'}
                </h1>
                <p className="text-sm text-gray-500">
                  {userName || 'Loading...'}
                </p>
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
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                title="Logout"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Last updated: {formatLastUpdated()}</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        
        {/* Error Banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button 
              onClick={handleRefresh}
              className="ml-2 underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* Today Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center">
            <span className="mr-2">📅</span>
            Today
            {todayJobs.length > 0 && (
              <span className="ml-2 text-ooosh-600">({todayJobs.length})</span>
            )}
          </h2>
          
          {loading ? (
            <LoadingSkeleton />
          ) : todayJobs.length > 0 ? (
            <div className="space-y-3">
              {todayJobs.map((item) => (
                <JobCard key={item.isGrouped ? `run-${item.runGroup}-${item.date}` : item.id} item={item} />
              ))}
            </div>
          ) : (
            <EmptyState message="No jobs scheduled for today" />
          )}
        </section>

        {/* Upcoming Section */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center">
            <span className="mr-2">📆</span>
            Upcoming
            {upcomingJobs.length > 0 && (
              <span className="ml-2 text-ooosh-600">({upcomingJobs.length})</span>
            )}
          </h2>
          
          {loading ? (
            <LoadingSkeleton />
          ) : upcomingJobs.length > 0 ? (
            <div className="space-y-3">
              {upcomingJobs.map((item) => (
                <JobCard key={item.isGrouped ? `run-${item.runGroup}-${item.date}` : item.id} item={item} />
              ))}
            </div>
          ) : (
            <EmptyState message="No upcoming jobs in the next 30 days" />
          )}
        </section>

        {/* Completed Section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center">
              <span className="mr-2">✅</span>
              Completed
              {completedJobs.length > 0 && (
                <span className="ml-2 text-ooosh-600">({completedJobs.length})</span>
              )}
            </h2>
            {completedJobs.length > 0 && (
              <a href="/completed" className="text-xs font-medium text-ooosh-600 hover:text-ooosh-500">
                View all →
              </a>
            )}
          </div>
          
          {loading ? (
            <div className="bg-gray-100 rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/2 mx-auto" />
            </div>
          ) : completedJobs.length > 0 ? (
            <div className="space-y-3">
              {/* Show first 2 completed jobs - no start button for completed */}
              {completedJobs.slice(0, 2).map((item) => (
                <JobCard 
                  key={item.isGrouped ? `run-${item.runGroup}-${item.date}` : item.id} 
                  item={item} 
                  showStartButton={false}
                />
              ))}
              {completedJobs.length > 2 && (
                <p className="text-center text-sm text-gray-500">
                  +{completedJobs.length - 2} more completed jobs
                </p>
              )}
            </div>
          ) : (
            <div className="bg-gray-100 rounded-xl p-4 text-center">
              <p className="text-gray-500 text-sm">No completed jobs in the last 30 days</p>
            </div>
          )}
        </section>

        {/* Cancelled Section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center">
              <span className="mr-2">❌</span>
              Cancelled
              {cancelledJobs.length > 0 && (
                <span className="ml-2 text-gray-400">({cancelledJobs.length})</span>
              )}
            </h2>
            {cancelledJobs.length > 0 && (
              <a href="/cancelled" className="text-xs font-medium text-ooosh-600 hover:text-ooosh-500">
                View all →
              </a>
            )}
          </div>
          
          {loading ? (
            <div className="bg-gray-100 rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/2 mx-auto" />
            </div>
          ) : cancelledJobs.length > 0 ? (
            <div className="bg-gray-100 rounded-xl p-4 text-center">
              <p className="text-gray-500 text-sm">
                {cancelledJobs.length} cancelled job{cancelledJobs.length !== 1 ? 's' : ''} in the last 30 days
              </p>
            </div>
          ) : (
            <div className="bg-gray-100 rounded-xl p-4 text-center">
              <p className="text-gray-500 text-sm">No cancelled jobs</p>
            </div>
          )}
        </section>

      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom">
        <div className="max-w-lg mx-auto px-4 py-2 flex justify-around">
          <Link href="/dashboard" className="flex flex-col items-center py-2 px-3 text-ooosh-600">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
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
          <Link href="/settings" className="flex flex-col items-center py-2 px-3 text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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