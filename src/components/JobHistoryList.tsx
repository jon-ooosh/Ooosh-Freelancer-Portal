'use client'

/**
 * The "View all" lists behind the dashboard's Completed and Cancelled sections
 * (Oct 2026 — both links used to lead to pages that didn't exist). Reads the
 * same /api/jobs the dashboard does, so it covers the same window: the last 30
 * days of completed jobs, and the cancelled ones the dashboard counts.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface HistoryJob {
  id: string
  board?: 'dc' | 'crew'
  type?: 'delivery' | 'collection'
  date?: string
  venueName?: string
  name?: string
  driverPay?: number
  freelancerFee?: number
  completedAtDate?: string
  workType?: string
}

type Item = (HistoryJob & { isGrouped: false }) | { isGrouped: true; jobs: HistoryJob[] }

function formatDate(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function title(job: HistoryJob): string {
  const kind = job.board === 'crew'
    ? (job.workType || 'Crew')
    : job.type === 'collection' ? 'Collection' : 'Delivery'
  const place = job.venueName || job.name || ''
  return place ? `${kind} - ${place}` : kind
}

export default function JobHistoryList({ which }: { which: 'completed' | 'cancelled' }) {
  const router = useRouter()
  const [jobs, setJobs] = useState<HistoryJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/jobs')
        const data = await res.json()
        if (!res.ok) {
          if (res.status === 401) { router.push('/login'); return }
          throw new Error(data.error || 'Failed to load jobs')
        }
        const items: Item[] = data[which] || []
        // A multi-drop run is one row per stop here: each stop is its own job page.
        const flat = items.flatMap((it) => (it.isGrouped ? it.jobs : [it]))
        flat.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        setJobs(flat)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load jobs')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [router, which])

  const heading = which === 'completed' ? 'Completed jobs' : 'Cancelled jobs'
  const empty = which === 'completed' ? 'No completed jobs in the last 30 days.' : 'No cancelled jobs.'

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/dashboard" className="p-2 -ml-2 text-gray-600 hover:text-gray-900 transition-colors" title="Back to jobs">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{heading}</h1>
            {which === 'completed' && <p className="text-sm text-gray-500">Last 30 days</p>}
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse space-y-3">
            <div className="h-4 bg-gray-200 rounded w-2/3" />
            <div className="h-4 bg-gray-200 rounded w-1/2" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-6 text-center text-sm text-gray-500">{empty}</div>
        ) : (
          <ul className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100 overflow-hidden">
            {jobs.map((job) => {
              const fee = job.freelancerFee ?? job.driverPay
              return (
                <li key={job.id}>
                  <Link
                    href={job.board === 'crew' ? `/job/${job.id}?board=crew` : `/job/${job.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900">{title(job)}</span>
                      <span className="block text-xs text-gray-500">
                        {formatDate(job.date)}
                        {which === 'completed' && job.completedAtDate ? ` · completed ${formatDate(job.completedAtDate)}` : ''}
                      </span>
                    </span>
                    {fee ? <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">£{Math.round(fee)}</span> : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
