/**
 * Reusable issue card — used in fleet-wide lists, vehicle detail, and banners.
 * Shows summary, status/severity/category badges, and relative time.
 */

import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { SEVERITY_STYLES, STATUS_STYLES, CATEGORY_STYLES } from '../../config/issue-options'
import type { VehicleIssue, IssueIndexEntry, IssueSeverity, IssueStatus, IssueCategory } from '../../types/issue'

type IssueData = VehicleIssue | IssueIndexEntry

interface IssueCardProps {
  issue: IssueData
  /** Show vehicle reg prominently (for fleet-wide lists) */
  showVehicleReg?: boolean
  /** Compact mode — smaller text, fewer badges (for banners) */
  compact?: boolean
}

function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}>
      {children}
    </span>
  )
}

function formatRelativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
  } catch {
    return dateStr
  }
}

export function IssueCard({ issue, showVehicleReg, compact }: IssueCardProps) {
  const linkTo = `/issues/${encodeURIComponent(issue.vehicleReg)}/${issue.id}`
  const severity = issue.severity as IssueSeverity
  const status = issue.status as IssueStatus
  const category = issue.category as IssueCategory

  if (compact) {
    return (
      <Link
        to={linkTo}
        className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 active:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          {showVehicleReg && (
            <span className="mr-2 font-mono text-xs font-bold text-ooosh-navy">{issue.vehicleReg}</span>
          )}
          <span className="text-sm text-gray-700">{issue.summary}</span>
        </div>
        <Badge className={SEVERITY_STYLES[severity] || 'bg-gray-100 text-gray-600'}>
          {severity}
        </Badge>
      </Link>
    )
  }

  return (
    <Link
      to={linkTo}
      className="block rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md active:bg-gray-50"
    >
      {/* Top row: vehicle reg (optional) + summary */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {showVehicleReg && (
            <span className="mr-2 font-mono text-sm font-bold text-ooosh-navy">{issue.vehicleReg}</span>
          )}
          <span className="text-sm font-medium text-gray-900">{issue.summary}</span>
        </div>
      </div>

      {/* Badge row */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge className={STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'}>
          {status}
        </Badge>
        <Badge className={SEVERITY_STYLES[severity] || 'bg-gray-100 text-gray-600'}>
          {severity}
        </Badge>
        <Badge className={CATEGORY_STYLES[category] || 'bg-gray-100 text-gray-600'}>
          {category}
        </Badge>
      </div>

      {/* Timestamp */}
      <p className="mt-1.5 text-[11px] text-gray-400">
        {formatRelativeTime(issue.reportedAt)}
        {issue.component && <span> · {issue.component}</span>}
      </p>
    </Link>
  )
}
