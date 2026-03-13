/**
 * HireHopJobCard — compact card showing a HireHop job with allocation status.
 *
 * Used on the dashboard ("Going Out" / "Due Back" sections) and on the AllocationsPage.
 * Shows: job number, company, van type needed, allocation status, date.
 */

import { Link } from 'react-router-dom'
import { vmPath } from '../../config/route-paths'
import { extractVanRequirements } from '../../lib/hirehop-api'
import { formatVanType } from '../../lib/van-matching'
import type { HireHopJob, VanAllocation, VanRequirement } from '../../types/hirehop'

interface HireHopJobCardProps {
  job: HireHopJob
  allocations: VanAllocation[]
  /** Which date to show — 'out' for going-out cards, 'return' for due-back cards */
  dateMode: 'out' | 'return'
}

export function HireHopJobCard({ job, allocations, dateMode }: HireHopJobCardProps) {
  const requirements = extractVanRequirements(job)
  const jobAllocations = allocations.filter(a => a.hireHopJobId === job.id)

  // Count total vans needed and how many are assigned
  const totalVansNeeded = requirements.reduce((sum, r) => sum + r.quantity, 0)
  const assignedCount = jobAllocations.length

  const dateStr = dateMode === 'out' ? job.outDate : job.returnDate
  const dateLabel = dateMode === 'out' ? 'Out' : 'Return'

  // Format date for display
  const displayDate = formatDisplayDate(dateStr)

  return (
    <Link
      to={vmPath(`/allocations?job=${job.id}`)}
      className="block rounded-lg border border-gray-200 bg-white p-3 active:bg-gray-50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* Job number + company */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-ooosh-navy">#{job.id}</span>
            <span className="truncate text-sm text-gray-700">{job.company || job.contactName || job.jobName}</span>
          </div>

          {/* Van requirements */}
          <div className="mt-1 flex flex-wrap gap-1">
            {requirements.map((req, i) => (
              <VanRequirementBadge key={i} requirement={req} />
            ))}
            {requirements.length === 0 && !job.itemsFetchFailed && (
              <span className="text-xs text-gray-400">No van items</span>
            )}
            {requirements.length === 0 && job.itemsFetchFailed && (
              <span className="text-xs text-amber-500">Items unavailable</span>
            )}
          </div>

          {/* Allocation status */}
          <div className="mt-1.5">
            <AllocationStatusBadge
              totalNeeded={totalVansNeeded}
              assigned={assignedCount}
              allocations={jobAllocations}
            />
          </div>
        </div>

        {/* Date */}
        <div className="shrink-0 text-right">
          <p className="text-[10px] font-medium uppercase text-gray-400">{dateLabel}</p>
          <p className="text-xs font-medium text-gray-600">{displayDate}</p>
        </div>
      </div>
    </Link>
  )
}

/** Badge showing van type needed, e.g. "1x Premium auto" */
function VanRequirementBadge({ requirement }: { requirement: VanRequirement }) {
  const label = formatVanType(requirement.simpleType, requirement.gearbox)
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
      {requirement.quantity > 1 ? `${requirement.quantity}x ` : ''}{label}
    </span>
  )
}

/** Badge showing allocation status — Unassigned (red), Partial (amber), All Assigned (green) */
function AllocationStatusBadge({
  totalNeeded,
  assigned,
  allocations,
}: {
  totalNeeded: number
  assigned: number
  allocations: VanAllocation[]
}) {
  if (totalNeeded === 0) return null

  if (assigned === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
        Unassigned
      </span>
    )
  }

  const allConfirmed = allocations.every(a => a.status === 'confirmed')

  if (assigned >= totalNeeded && allConfirmed) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
        Confirmed
      </span>
    )
  }

  if (assigned >= totalNeeded) {
    // All assigned but some are soft
    const regs = allocations.map(a => a.vehicleReg).join(', ')
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
        Soft: {regs}
      </span>
    )
  }

  // Partially assigned
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
      {assigned}/{totalNeeded} assigned
    </span>
  )
}

/** Format YYYY-MM-DD to a short display format */
function formatDisplayDate(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return '—'
  const date = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow'

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
