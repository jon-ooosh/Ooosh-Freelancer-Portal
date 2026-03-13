import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { getDateUrgency } from '../types/vehicle'
import { useAllIssues } from '../hooks/useAllIssues'
import { useRecentEvents } from '../hooks/useRecentEvents'
import { useGoingOutJobs, useDueBackJobs } from '../hooks/useHireHopJobs'
import { useAllocations } from '../hooks/useAllocations'
import { useFleetWithHireStatus } from '../hooks/useFleetWithHireStatus'
import { HireHopJobCard } from '../components/dashboard/HireHopJobCard'
import { HireHopCacheStatus } from '../components/HireHopCacheStatus'
import { LowStockBanner } from '../components/stock/LowStockBanner'
import { IssueCard } from '../components/issues/IssueCard'
import { RecentActivityFeed } from '../components/dashboard/RecentActivityFeed'
import { extractVanRequirements } from '../lib/hirehop-api'

const quickActions = [
  { path: '/book-out', label: 'Book Out', description: 'Start a vehicle book-out', icon: '🚐' },
  { path: '/check-in', label: 'Check In', description: 'Return a vehicle', icon: '📋' },
  { path: '/prep', label: 'Prep', description: 'Prepare a vehicle', icon: '🔧' },
  { path: '/issues/new', label: 'Log Issue', description: 'Report a problem', icon: '⚠️' },
  { path: '/allocations', label: 'Allocations', description: 'Assign vans to jobs', icon: '📦' },
  { path: '/fleet-map', label: 'Fleet Map', description: 'Live GPS tracking', icon: '📍' },
]

export function HomePage() {
  const { vehicles: enrichedVehicles, stats, isLoading } = useFleetWithHireStatus()
  const { data: allIssues } = useAllIssues()
  const { data: recentEvents, isLoading: eventsLoading } = useRecentEvents(10)
  const { data: goingOutJobs, isLoading: goingOutLoading, error: goingOutError } = useGoingOutJobs()
  const { data: dueBackJobs, isLoading: dueBackLoading, error: dueBackError } = useDueBackJobs()
  const { data: allocations } = useAllocations()

  const openIssues = useMemo(
    () => (allIssues || []).filter(i => i.status !== 'Resolved'),
    [allIssues],
  )

  const openIssueCount = openIssues.length

  // Top issues for dashboard: sorted by severity (Critical > High > Medium > Low), then most recent
  const topOpenIssues = useMemo(() => {
    const severityOrder: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 }
    return [...openIssues]
      .sort((a, b) => {
        const sevCmp = (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
        return sevCmp !== 0 ? sevCmp : b.reportedAt.localeCompare(a.reportedAt)
      })
      .slice(0, 5)
  }, [openIssues])

  const prepQueue = useMemo(
    () => enrichedVehicles.filter(v => v.liveStatus === 'prep-needed' || v.liveStatus === 'returning'),
    [enrichedVehicles],
  )

  const onHire = useMemo(
    () => enrichedVehicles.filter(v => v.liveStatus === 'on-hire'),
    [enrichedVehicles],
  )

  // Sort going-out jobs by outDate, then job number — only van jobs
  const sortedGoingOut = useMemo(
    () => [...(goingOutJobs || [])]
      .filter(job => job.itemsFetchFailed || extractVanRequirements(job).length > 0)
      .sort((a, b) => {
        const dateCmp = a.outDate.localeCompare(b.outDate)
        return dateCmp !== 0 ? dateCmp : a.id - b.id
      }),
    [goingOutJobs],
  )

  // Sort due-back jobs by returnDate, then job number — only van jobs
  const sortedDueBack = useMemo(
    () => [...(dueBackJobs || [])]
      .filter(job => job.itemsFetchFailed || extractVanRequirements(job).length > 0)
      .sort((a, b) => {
        const dateCmp = a.returnDate.localeCompare(b.returnDate)
        return dateCmp !== 0 ? dateCmp : a.id - b.id
      }),
    [dueBackJobs],
  )

  // Compliance alerts — vehicles with overdue or soon-due dates
  const complianceAlerts = useMemo(() => {
    const activeVehicles = enrichedVehicles.filter(v => !v.isOldSold)
    const checks: { label: string; field: keyof typeof activeVehicles[0]; warningDays: number }[] = [
      { label: 'MOT', field: 'motDue', warningDays: 30 },
      { label: 'Tax', field: 'taxDue', warningDays: 30 },
      { label: 'Insurance', field: 'insuranceDue', warningDays: 30 },
      { label: 'TFL', field: 'tflDue', warningDays: 30 },
    ]

    const alerts: { vehicleId: string; reg: string; item: string; date: string; urgency: 'soon' | 'overdue' }[] = []

    for (const v of activeVehicles) {
      for (const check of checks) {
        const dateVal = v[check.field] as string | null
        if (!dateVal) continue
        const urgency = getDateUrgency(dateVal, check.warningDays)
        if (urgency === 'soon' || urgency === 'overdue') {
          alerts.push({ vehicleId: v.id, reg: v.reg, item: check.label, date: dateVal, urgency })
        }
      }
    }

    // Sort: overdue first, then by date ascending
    alerts.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'overdue' ? -1 : 1
      return a.date.localeCompare(b.date)
    })

    return alerts
  }, [enrichedVehicles])

  const overdueCount = complianceAlerts.filter(a => a.urgency === 'overdue').length
  const soonCount = complianceAlerts.filter(a => a.urgency === 'soon').length

  const allocationsList = allocations || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-ooosh-navy">Dashboard</h2>
        <HireHopCacheStatus />
      </div>

      {/* Fleet status summary */}
      {!isLoading && enrichedVehicles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Link to={vmPath('/vehicles')} className="rounded-lg border border-green-200 bg-green-50 p-3 text-center">
            <p className="text-2xl font-bold text-green-700">{stats.available}</p>
            <p className="text-xs font-medium text-green-600">Available</p>
          </Link>
          <Link to={vmPath('/vehicles?status=on-hire')} className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-center">
            <p className="text-2xl font-bold text-blue-700">{stats.onHire}</p>
            <p className="text-xs font-medium text-blue-600">On Hire</p>
          </Link>
          <Link to={vmPath('/prep')} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
            <p className="text-2xl font-bold text-amber-700">{stats.prepNeeded}</p>
            <p className="text-xs font-medium text-amber-600">Prep Needed</p>
          </Link>
          <Link to={vmPath('/issues')} className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
            <p className="text-2xl font-bold text-red-700">{openIssueCount}</p>
            <p className="text-xs font-medium text-red-600">Open Issues</p>
          </Link>
        </div>
      )}

      {/* Status mismatch warning */}
      {stats.mismatches > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
          <p className="text-xs font-medium text-orange-700">
            {stats.mismatches} vehicle{stats.mismatches > 1 ? 's have' : ' has'} a status
            mismatch between Fleet Master and HireHop.
          </p>
          <Link to={vmPath('/vehicles')} className="mt-1 text-xs font-medium text-orange-600 underline">
            View fleet →
          </Link>
        </div>
      )}

      {/* Low stock warning */}
      <LowStockBanner />

      {/* Compliance alerts */}
      {complianceAlerts.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
              Compliance Alerts
              {overdueCount > 0 && (
                <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                  {overdueCount} overdue
                </span>
              )}
              {soonCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                  {soonCount} due soon
                </span>
              )}
            </h3>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
            {complianceAlerts.slice(0, 8).map((alert, i) => {
              const diffDays = Math.ceil((new Date(alert.date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
              const daysText = diffDays < 0
                ? `${Math.abs(diffDays)}d overdue`
                : diffDays === 0 ? 'Today' : `${diffDays}d`
              return (
                <Link
                  key={`${alert.vehicleId}-${alert.item}-${i}`}
                  to={vmPath(`/vehicles/${alert.vehicleId}`)}
                  className={`flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 ${
                    alert.urgency === 'overdue' ? 'bg-red-50/50' : ''
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    alert.urgency === 'overdue' ? 'bg-red-500' : 'bg-amber-500'
                  }`} />
                  <span className="font-mono text-sm font-bold text-ooosh-navy">{alert.reg}</span>
                  <span className="text-sm text-gray-600">{alert.item}</span>
                  <span className="ml-auto text-xs text-gray-400">
                    {new Date(alert.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                  <span className={`text-[10px] font-bold ${
                    alert.urgency === 'overdue' ? 'text-red-600' : 'text-amber-600'
                  }`}>
                    {daysText}
                  </span>
                </Link>
              )
            })}
            {complianceAlerts.length > 8 && (
              <div className="px-3 py-2 text-center text-xs text-gray-400">
                +{complianceAlerts.length - 8} more alerts
              </div>
            )}
          </div>
        </section>
      )}

      {/* Quick actions */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Quick Actions
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {quickActions.map((action) => {
            const resolved = vmPath(action.path)
            const className = "flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md active:bg-gray-50"
            const content = (
              <>
                <span className="text-2xl">{action.icon}</span>
                <div>
                  <span className="block text-sm font-medium text-ooosh-navy">
                    {action.label}
                  </span>
                  <span className="block text-xs text-gray-500">
                    {action.description}
                  </span>
                </div>
              </>
            )
            return (
              <Link key={action.path} to={resolved} className={className}>
                {content}
              </Link>
            )
          })}
        </div>
      </section>

      {/* Going Out Today/Tomorrow — HireHop jobs */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
            Going Out Today / Tomorrow
          </h3>
          {sortedGoingOut.length > 0 && (
            <Link to={vmPath('/allocations')} className="text-xs font-medium text-blue-600">
              Manage →
            </Link>
          )}
        </div>

        {goingOutLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {goingOutError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <strong>HireHop error:</strong> {goingOutError instanceof Error ? goingOutError.message : 'Failed to load'}
          </div>
        )}

        {!goingOutLoading && !goingOutError && sortedGoingOut.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            No jobs going out today or tomorrow
          </div>
        )}

        {!goingOutLoading && sortedGoingOut.length > 0 && (
          <div className="space-y-2">
            {sortedGoingOut.map(job => (
              <HireHopJobCard
                key={job.id}
                job={job}
                allocations={allocationsList}
                dateMode="out"
              />
            ))}
          </div>
        )}
      </section>

      {/* Due Back Today/Tomorrow — HireHop jobs */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
            Due Back Today / Tomorrow
          </h3>
        </div>

        {dueBackLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {dueBackError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <strong>HireHop error:</strong> {dueBackError instanceof Error ? dueBackError.message : 'Failed to load'}
          </div>
        )}

        {!dueBackLoading && !dueBackError && sortedDueBack.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            No jobs due back today or tomorrow
          </div>
        )}

        {!dueBackLoading && sortedDueBack.length > 0 && (
          <div className="space-y-2">
            {sortedDueBack.map(job => (
              <HireHopJobCard
                key={job.id}
                job={job}
                allocations={allocationsList}
                dateMode="return"
              />
            ))}
          </div>
        )}
      </section>

      {/* Prep queue — live from Monday */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
            Needing Prep
          </h3>
          {prepQueue.length > 0 && (
            <Link to={vmPath('/prep')} className="text-xs font-medium text-blue-600">
              View all →
            </Link>
          )}
        </div>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {!isLoading && prepQueue.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            No vehicles awaiting prep
          </div>
        )}

        {!isLoading && prepQueue.length > 0 && (
          <div className="space-y-2">
            {prepQueue.slice(0, 5).map(v => (
              <Link
                key={v.id}
                to={vmPath('/prep')}
                className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50/50 p-3 active:bg-amber-100"
              >
                <div>
                  <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
                  <p className="text-xs text-gray-500">
                    {v.simpleType} · {v.make}
                    {v.model && ` · ${v.model}`}
                  </p>
                </div>
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  Prep Needed
                </span>
              </Link>
            ))}
            {prepQueue.length > 5 && (
              <Link
                to={vmPath('/prep')}
                className="block rounded-lg border border-gray-200 bg-white py-2 text-center text-xs font-medium text-gray-500 active:bg-gray-50"
              >
                +{prepQueue.length - 5} more — view all
              </Link>
            )}
          </div>
        )}
      </section>

      {/* On Hire summary */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Currently On Hire
        </h3>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {!isLoading && onHire.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            No vehicles currently on hire
          </div>
        )}

        {!isLoading && onHire.length > 0 && (
          <div className="space-y-2">
            {onHire.slice(0, 5).map(v => (
              <Link
                key={v.id}
                to={vmPath(`/vehicles/${v.id}`)}
                className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3 active:bg-gray-50"
              >
                <div>
                  <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
                  <p className="text-xs text-gray-500">
                    {v.simpleType} · {v.make}
                    {v.model && ` · ${v.model}`}
                  </p>
                  {v.activeJob && (
                    <p className="mt-0.5 text-[10px] text-blue-600">
                      Job #{v.activeJob.jobId} — {v.activeJob.jobName}
                      {v.activeJob.status && ` (${v.activeJob.status})`}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                    On Hire
                  </span>
                  {v.statusMismatch && (
                    <span className="inline-flex items-center rounded-full bg-orange-100 px-1.5 py-0.5 text-[9px] font-medium text-orange-600">
                      Mismatch
                    </span>
                  )}
                </div>
              </Link>
            ))}
            {onHire.length > 5 && (
              <Link
                to={vmPath('/vehicles')}
                className="block rounded-lg border border-gray-200 bg-white py-2 text-center text-xs font-medium text-gray-500 active:bg-gray-50"
              >
                +{onHire.length - 5} more — view fleet
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Recent Activity — global event feed from R2 */}
      <section>
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Recent Activity
        </h3>
        <RecentActivityFeed events={recentEvents || []} isLoading={eventsLoading} />
      </section>

      {/* Open Issues — from R2 issues index */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
            Open Issues
          </h3>
          {openIssueCount > 0 && (
            <Link to={vmPath('/issues')} className="text-xs font-medium text-blue-600">
              View all ({openIssueCount}) →
            </Link>
          )}
        </div>

        {topOpenIssues.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            No open issues
          </div>
        )}

        {topOpenIssues.length > 0 && (
          <div className="space-y-2">
            {topOpenIssues.map(issue => (
              <IssueCard key={issue.id} issue={issue} showVehicleReg compact />
            ))}
            {openIssueCount > 5 && (
              <Link
                to={vmPath('/issues')}
                className="block rounded-lg border border-gray-200 bg-white py-2 text-center text-xs font-medium text-gray-500 active:bg-gray-50"
              >
                +{openIssueCount - 5} more — view all issues
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
