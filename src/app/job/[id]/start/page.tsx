'use client'

/**
 * Delivery/Collection Start Page
 *
 * Quick wizard that asks "What are you delivering/collecting today?"
 * and routes the driver to the right flow:
 * - Van only → vehicle book-out (vehicle management app)
 * - Backline only → equipment checklist (/job/[id]/complete)
 * - Both → vehicle book-out first, then returns to /job/[id]/complete
 *
 * If the job has no HireHop reference, skips straight to /job/[id]/complete.
 *
 * Route: /job/[id]/start
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

// =============================================================================
// TYPES
// =============================================================================

interface JobSummary {
  id: string
  name: string
  type: 'delivery' | 'collection'
  hhRef?: string
  venueName?: string
  date?: string
  time?: string
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function StartDeliveryPage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string

  const [job, setJob] = useState<JobSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bookoutLoading, setBookoutLoading] = useState(false)
  const [bookoutError, setBookoutError] = useState<string | null>(null)

  // Fetch job summary
  useEffect(() => {
    async function fetchJob() {
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        const data = await res.json()

        if (!res.ok) {
          if (res.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        const fetchedJob = data.job as JobSummary

        // If no HireHop reference, skip wizard and go straight to completion
        if (!fetchedJob?.hhRef) {
          router.replace(`/job/${jobId}/complete`)
          return
        }

        setJob(fetchedJob)
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

  // Handle vehicle book-out
  const handleBookout = async (vanOnly: boolean) => {
    setBookoutLoading(true)
    setBookoutError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/bookout-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vanOnly }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to start book-out')
      }
      window.location.href = data.bookoutUrl
    } catch (err) {
      console.error('Book-out error:', err)
      setBookoutError(err instanceof Error ? err.message : 'Failed to start book-out')
      setBookoutLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-md mx-auto mt-20">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-red-500 text-4xl mb-4">⚠️</div>
            <p className="text-gray-600 mb-4">{error || 'Job not found'}</p>
            <Link
              href="/dashboard"
              className="inline-block bg-purple-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-purple-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isDelivery = job.type === 'delivery'

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center">
          <Link
            href={`/job/${jobId}`}
            className="flex items-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4 pt-8">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            What are you {isDelivery ? 'delivering' : 'collecting'} today?
          </h1>
          <p className="text-sm text-gray-500">
            This helps us run the right process for you
          </p>
        </div>

        <div className="space-y-3">
          {/* Van only */}
          <button
            onClick={() => handleBookout(true)}
            disabled={bookoutLoading}
            className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <span className="text-3xl">🚐</span>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">Van only</p>
              <p className="text-sm text-gray-500">Vehicle book-out process</p>
            </div>
            {bookoutLoading && (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            )}
          </button>

          {/* Backline only */}
          <Link
            href={`/job/${jobId}/complete`}
            className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-gray-200 bg-white hover:border-purple-400 hover:bg-purple-50 transition-colors text-left shadow-sm"
          >
            <span className="text-3xl">🎸</span>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">Backline only</p>
              <p className="text-sm text-gray-500">Equipment checklist &amp; sign-off</p>
            </div>
          </Link>

          {/* Both */}
          <button
            onClick={() => handleBookout(false)}
            disabled={bookoutLoading}
            className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-gray-200 bg-white hover:border-green-400 hover:bg-green-50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <span className="text-3xl">🚐🎸</span>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">Both</p>
              <p className="text-sm text-gray-500">Vehicle book-out, then equipment checklist</p>
            </div>
            {bookoutLoading && (
              <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
            )}
          </button>
        </div>

        {bookoutError && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-center">
            <p className="text-red-600 text-sm">{bookoutError}</p>
          </div>
        )}

        <div className="mt-6 text-center">
          <Link
            href={`/job/${jobId}`}
            className="text-gray-500 text-sm font-medium hover:text-gray-700 transition-colors"
          >
            Cancel
          </Link>
        </div>
      </main>
    </div>
  )
}
