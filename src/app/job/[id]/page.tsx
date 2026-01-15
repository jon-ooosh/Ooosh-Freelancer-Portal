'use client'

/**
 * Job Details Page
 * 
 * Displays full details for a single job.
 * Route: /job/[id]
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

// Job type from API
interface Job {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date?: string
  time?: string
  venueName?: string
  status: string
  hhRef?: string
  keyNotes?: string
  runGroup?: string
  agreedFeeOverride?: number
  completedAtDate?: string
  completionNotes?: string
}

export default function JobDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string

  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${jobId}`)
        const data = await response.json()

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        setJob(data.job)
      } catch (err) {
        console.error('Error fetching job:', err)
        setError(err instanceof Error ? err.message : 'Failed to load job')
      } finally {
        setLoading(false)
      }
    }

    if (jobId) {
      fetchJob()
    }
  }, [jobId, router])

  // Format date for display
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'TBC'
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  }

  // Format time for display
  const formatTime = (timeStr?: string) => {
    if (!timeStr) return 'TBC'
    return timeStr
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading job details...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Error</h1>
            <p className="text-gray-600 mb-6">{error}</p>
            <Link
              href="/dashboard"
              className="inline-block bg-orange-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-orange-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Job not found
  if (!job) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-gray-400 text-5xl mb-4">🔍</div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Job Not Found</h1>
            <p className="text-gray-600 mb-6">This job doesn&apos;t exist or isn&apos;t assigned to you.</p>
            <Link
              href="/dashboard"
              className="inline-block bg-orange-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-orange-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Job type display
  const isDelivery = job.type === 'delivery'
  const typeIcon = isDelivery ? '📦' : '🚚'
  const typeLabel = isDelivery ? 'DELIVERY' : 'COLLECTION'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="flex items-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <button
            onClick={() => window.location.reload()}
            className="text-gray-600 hover:text-gray-900 transition-colors"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto p-4">
        {/* Job Type & Venue */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-4">
          <div className="flex items-start gap-3 mb-4">
            <span className="text-3xl">{typeIcon}</span>
            <div>
              <span className="text-xs font-semibold text-orange-600 uppercase tracking-wide">
                {typeLabel}
              </span>
              <h1 className="text-xl font-bold text-gray-900 mt-1">
                {job.venueName || job.name}
              </h1>
            </div>
          </div>

          {/* Divider */}
          <hr className="my-4 border-gray-100" />

          {/* Date & Time */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-gray-400">📅</span>
              <div>
                <p className="text-sm text-gray-500">Date</p>
                <p className="font-medium text-gray-900">{formatDate(job.date)}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-gray-400">⏰</span>
              <div>
                <p className="text-sm text-gray-500">Arrive by</p>
                <p className="font-medium text-gray-900">{formatTime(job.time)}</p>
              </div>
            </div>

            {job.agreedFeeOverride && (
              <div className="flex items-center gap-3">
                <span className="text-gray-400">💷</span>
                <div>
                  <p className="text-sm text-gray-500">Agreed fee</p>
                  <p className="font-medium text-gray-900">£{job.agreedFeeOverride.toFixed(2)}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Key Notes */}
        {job.keyNotes && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-4">
            <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>📋</span> Key Notes
            </h2>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-gray-700 whitespace-pre-wrap">{job.keyNotes}</p>
            </div>
          </div>
        )}

        {/* HireHop Reference */}
        {job.hhRef && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-4">
            <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>🔗</span> Reference
            </h2>
            <p className="text-gray-600">
              HireHop Job: <span className="font-mono font-medium text-gray-900">#{job.hhRef}</span>
            </p>
          </div>
        )}

        {/* Status Badge */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3">Status</h2>
          <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
            job.status.toLowerCase().includes('done') || job.status.toLowerCase().includes('completed')
              ? 'bg-green-100 text-green-800'
              : job.status.toLowerCase().includes('arranged')
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-800'
          }`}>
            {job.status}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          {/* Add to Calendar - placeholder for now */}
          <button
            className="w-full bg-white border border-gray-200 text-gray-700 px-6 py-3 rounded-xl font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
            onClick={() => alert('Calendar export coming soon!')}
          >
            <span>📅</span> Add to Calendar
          </button>

          {/* Start Delivery/Collection - placeholder for now */}
          {!job.completedAtDate && (
            <button
              className="w-full bg-orange-500 text-white px-6 py-4 rounded-xl font-semibold hover:bg-orange-600 transition-colors flex items-center justify-center gap-2 text-lg"
              onClick={() => alert('Completion flow coming soon!')}
            >
              <span>▶️</span> Start {isDelivery ? 'Delivery' : 'Collection'}
            </button>
          )}

          {/* Show completed badge if already done */}
          {job.completedAtDate && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
              <span className="text-green-600 font-medium">
                ✅ Completed on {formatDate(job.completedAtDate)}
              </span>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
