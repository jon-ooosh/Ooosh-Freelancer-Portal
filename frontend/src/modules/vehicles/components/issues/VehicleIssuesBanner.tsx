/**
 * Expandable amber banner showing open issues for a vehicle.
 *
 * Stage 3 (May 2026) — repointed from the legacy R2-blob useVehicleIssues
 * hook to the OP /api/problems/by-vehicle/:id endpoint. Caller now
 * passes the vehicle UUID (not reg) since that's the OP key. Renders
 * nothing while loading or when there are no open issues.
 *
 * Used on PrepPage at the top of the prep checklist as a "heads-up,
 * here's what's already flagged on this van" widget.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../config/api-config'

interface OpIssueRow {
  id: string
  category: string
  severity: 'low' | 'normal' | 'urgent'
  status: string
  summary: string
  hh_job_number: number | null
  updated_at: string
}

const TERMINAL = new Set(['resolved', 'written_off', 'cancelled'])

interface VehicleIssuesBannerProps {
  /** Vehicle UUID — fleet_vehicles.id, NOT the registration plate. */
  vehicleId: string
}

export function VehicleIssuesBanner({ vehicleId }: VehicleIssuesBannerProps) {
  const [expanded, setExpanded] = useState(false)

  const { data: issues = [], isLoading } = useQuery({
    queryKey: ['op-vehicle-issues-banner', vehicleId],
    enabled: Boolean(vehicleId),
    queryFn: async (): Promise<OpIssueRow[]> => {
      const resp = await apiFetch(`/api/problems/by-vehicle/${vehicleId}`)
      if (!resp.ok) throw new Error(`Failed to fetch issues: ${resp.status}`)
      const body = await resp.json() as { data: OpIssueRow[] }
      return body.data || []
    },
    staleTime: 60_000,
  })

  const openIssues = issues.filter(i => !TERMINAL.has(i.status))

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
            <a
              key={issue.id}
              href={`/operations/problems/${issue.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded border border-amber-200 bg-white px-2.5 py-2 text-xs hover:border-amber-400 hover:bg-amber-50/40"
            >
              <div className="flex items-start gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  issue.severity === 'urgent' ? 'bg-red-100 text-red-700' :
                  issue.severity === 'low' ? 'bg-gray-100 text-gray-600' :
                  'bg-amber-100 text-amber-700'
                }`}>
                  {issue.severity === 'urgent' ? '⚠ Urgent' : issue.severity === 'low' ? 'Low' : 'Normal'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900 truncate">{issue.summary}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    {issue.category}
                    {issue.hh_job_number ? ` · J-${issue.hh_job_number}` : ''}
                    {' · '}
                    {new Date(issue.updated_at).toLocaleDateString('en-GB')}
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
