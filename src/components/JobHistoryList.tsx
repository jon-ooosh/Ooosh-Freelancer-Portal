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
import BottomNav from '@/components/BottomNav'
import { cls, BackLink, Banner, Chevron } from '@/components/ui'

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
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
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
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-3 flex flex-col gap-1">
        <BackLink href="/dashboard" label="Jobs" />
        <h1 className={cls.pageTitle}>{heading}</h1>
        {which === 'completed' && <p className="text-[16px] text-hf-muted">Last 30 days</p>}
      </header>

      <main className="max-w-lg mx-auto px-4 pt-4">
        {error && <Banner tone="error" className="mb-4">{error}</Banner>}
        {loading ? (
          <div className={`${cls.card} p-4 animate-pulse flex flex-col gap-3`}>
            <div className="h-4 bg-hf-track rounded w-2/3" />
            <div className="h-4 bg-hf-track rounded w-1/2" />
          </div>
        ) : jobs.length === 0 ? (
          <div className={`${cls.card} p-6 text-center text-[15px] text-hf-muted`}>{empty}</div>
        ) : (
          <ul className={`${cls.card} overflow-hidden`}>
            {jobs.map((job, i) => {
              const fee = job.freelancerFee ?? job.driverPay
              return (
                <li key={job.id}>
                  {i > 0 && <div className="h-px bg-hf-divider ml-4" />}
                  <Link
                    href={job.board === 'crew' ? `/job/${job.id}?board=crew` : `/job/${job.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-hf-inset"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[16px] font-semibold text-hf-ink">{title(job)}</span>
                      <span className="block text-[14px] text-hf-muted">
                        {formatDate(job.date)}
                        {which === 'completed' && job.completedAtDate ? ` · completed ${formatDate(job.completedAtDate)}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {fee ? <span className={cls.money}>£{Math.round(fee)}</span> : null}
                      <Chevron />
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </main>
      <BottomNav active="jobs" />
    </div>
  )
}
