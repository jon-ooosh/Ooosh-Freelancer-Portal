/**
 * Expandable amber banner showing open issues for a vehicle.
 * Renders nothing if loading or no open issues.
 * Used in prep, check-in, and vehicle detail pages.
 */

import { useState, useMemo } from 'react'
import { useVehicleIssues } from '../../hooks/useVehicleIssues'
import { IssueCard } from './IssueCard'

interface VehicleIssuesBannerProps {
  vehicleReg: string
}

export function VehicleIssuesBanner({ vehicleReg }: VehicleIssuesBannerProps) {
  const { data: issues, isLoading } = useVehicleIssues(vehicleReg)
  const [expanded, setExpanded] = useState(false)

  const openIssues = useMemo(
    () => (issues || []).filter(i => i.status !== 'Resolved'),
    [issues],
  )

  // Don't render anything while loading or if no open issues
  if (isLoading || openIssues.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-600">⚠️</span>
          <span className="text-sm font-medium text-amber-800">
            {openIssues.length} open issue{openIssues.length !== 1 ? 's' : ''}
          </span>
        </div>
        <span className="text-xs text-amber-600">
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-amber-200 px-4 py-3">
          {openIssues.map(issue => (
            <IssueCard key={issue.id} issue={issue} compact />
          ))}
        </div>
      )}
    </div>
  )
}
