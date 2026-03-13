/**
 * Fleet-wide issues list — filterable by status, severity, category, and vehicle.
 * Sorted: Critical first, then by reportedAt descending.
 */

import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useAllIssues } from '../hooks/useAllIssues'
import { IssueCard } from '../components/issues/IssueCard'
import {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
} from '../config/issue-options'
import type { IssueCategory, IssueSeverity, IssueStatus } from '../types/issue'

/** Severity sort order — Critical first */
const SEVERITY_ORDER: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 }

export function IssuesPage() {
  const { data: allIssues, isLoading } = useAllIssues()

  // Filters
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all')
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = useState<IssueCategory | 'all'>('all')
  const [search, setSearch] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const filtered = useMemo(() => {
    if (!allIssues) return []

    return allIssues
      .filter(issue => {
        // "All" view shows everything; resolved-only shows just resolved; otherwise hide resolved
        if (!showAll && !showResolved && issue.status === 'Resolved') return false
        if (showResolved && issue.status !== 'Resolved') return false

        // Status filter
        if (statusFilter !== 'all' && issue.status !== statusFilter) return false

        // Severity filter
        if (severityFilter !== 'all' && issue.severity !== severityFilter) return false

        // Category filter
        if (categoryFilter !== 'all' && issue.category !== categoryFilter) return false

        // Search by vehicle reg or summary
        if (search) {
          const term = search.toLowerCase()
          const searchable = `${issue.vehicleReg} ${issue.summary} ${issue.component}`.toLowerCase()
          if (!searchable.includes(term)) return false
        }

        return true
      })
      .sort((a, b) => {
        // Critical first
        const sevA = SEVERITY_ORDER[a.severity] ?? 99
        const sevB = SEVERITY_ORDER[b.severity] ?? 99
        if (sevA !== sevB) return sevA - sevB

        // Then by reportedAt descending
        return b.reportedAt.localeCompare(a.reportedAt)
      })
  }, [allIssues, statusFilter, severityFilter, categoryFilter, search, showResolved, showAll])

  const openCount = useMemo(
    () => (allIssues || []).filter(i => i.status !== 'Resolved').length,
    [allIssues],
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-ooosh-navy">Issues</h2>
          {!isLoading && (
            <p className="text-xs text-gray-500">{openCount} open issue{openCount !== 1 ? 's' : ''}</p>
          )}
        </div>
        <Link
          to={vmPath('/issues/new')}
          className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-navy/90 active:bg-ooosh-navy/80"
        >
          Log Issue
        </Link>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by reg, summary, component..."
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />

      {/* Filter pills */}
      <div className="space-y-2">
        {/* Status filter */}
        <div className="flex flex-wrap gap-1.5">
          <FilterPill
            label="All"
            active={showAll && statusFilter === 'all'}
            onClick={() => { setShowAll(true); setShowResolved(false); setStatusFilter('all') }}
          />
          <FilterPill
            label="All open"
            active={!showAll && statusFilter === 'all' && !showResolved}
            onClick={() => { setShowAll(false); setStatusFilter('all'); setShowResolved(false) }}
          />
          {ISSUE_STATUSES.filter(s => s !== 'Resolved').map(s => (
            <FilterPill
              key={s}
              label={s}
              active={statusFilter === s && !showAll}
              onClick={() => { setShowAll(false); setStatusFilter(s); setShowResolved(false) }}
            />
          ))}
          <FilterPill
            label="Resolved"
            active={showResolved && !showAll}
            onClick={() => { setShowAll(false); setShowResolved(true); setStatusFilter('all') }}
          />
        </div>

        {/* Severity + Category filters */}
        <div className="flex flex-wrap gap-1.5">
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as IssueSeverity | 'all')}
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-blue-300 focus:outline-none"
          >
            <option value="all">All severities</option>
            {ISSUE_SEVERITIES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as IssueCategory | 'all')}
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-blue-300 focus:outline-none"
          >
            <option value="all">All categories</option>
            {ISSUE_CATEGORIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm text-gray-400">
            {(allIssues || []).length === 0
              ? 'No issues logged yet'
              : 'No issues match your filters'}
          </p>
          {(allIssues || []).length === 0 && (
            <Link
              to={vmPath('/issues/new')}
              className="mt-2 inline-block text-sm font-medium text-ooosh-blue hover:underline"
            >
              Log your first issue →
            </Link>
          )}
        </div>
      )}

      {/* Issue list */}
      {!isLoading && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map(issue => (
            <IssueCard key={issue.id} issue={issue} showVehicleReg />
          ))}
        </div>
      )}
    </div>
  )
}

/** Small filter pill button */
function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-ooosh-navy text-white'
          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  )
}
