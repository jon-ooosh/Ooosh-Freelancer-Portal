/**
 * Vehicle issues surface banner — re-surfaces open issues with a
 * matching `surface_on` value in the workflow they're tagged for.
 *
 * Reads from /api/problems/by-vehicle/:id and filters client-side
 * to open + surface_on = <prop>. Renders nothing if no matches.
 *
 * Mounted at the top of:
 *   - CheckInPage          (surfaceOn='vehicle_check_in')
 *   - AllocationsPage row  (surfaceOn='next_hire') — future
 *   - BookOutPage          (surfaceOn='next_book_out') — future
 *   - Job close-out modal  (surfaceOn='job_close_out') — future
 *
 * Distinct from the existing VehicleIssuesBanner which is a generic
 * "any open issues on this van" widget. This one is opt-in per issue
 * via the `surface_on` field staff sets at creation time, so the
 * prompts are deliberate not noisy.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../config/api-config'

interface OpIssueRow {
  id: string
  category: string
  severity: 'low' | 'normal' | 'urgent'
  status: string
  surface_on: string | null
  summary: string
  hh_job_number: number | null
  updated_at: string
}

const TERMINAL = new Set(['resolved', 'written_off', 'cancelled'])

interface Props {
  /** Vehicle UUID (fleet_vehicles.id) — NOT the registration plate. */
  vehicleId: string
  /** Which surface_on value to filter for. */
  surfaceOn: 'vehicle_check_in' | 'next_hire' | 'next_book_out' | 'job_close_out'
  /** Optional title override; defaults based on surfaceOn. */
  title?: string
}

const DEFAULT_TITLES: Record<Props['surfaceOn'], string> = {
  vehicle_check_in: 'Open issues to review at check-in',
  next_hire: 'Open issues to review before next hire',
  next_book_out: 'Open issues to review before book-out',
  job_close_out: 'Open issues to resolve before close-out',
}

export function VehicleIssuesSurfaceBanner({ vehicleId, surfaceOn, title }: Props) {
  const [expanded, setExpanded] = useState(true)

  const { data: issues = [], isLoading } = useQuery({
    queryKey: ['op-vehicle-issues-surface', vehicleId, surfaceOn],
    enabled: Boolean(vehicleId),
    queryFn: async (): Promise<OpIssueRow[]> => {
      const resp = await apiFetch(`/api/problems/by-vehicle/${vehicleId}`)
      if (!resp.ok) throw new Error(`Failed to fetch issues: ${resp.status}`)
      const body = await resp.json() as { data: OpIssueRow[] }
      return body.data || []
    },
    staleTime: 60_000,
  })

  const surfaced = issues.filter(i => !TERMINAL.has(i.status) && i.surface_on === surfaceOn)
  if (isLoading || surfaced.length === 0) return null

  const heading = title || DEFAULT_TITLES[surfaceOn]
  // Urgent-severity surfaced issues bump the banner colour to red so
  // staff can't miss them on a busy form. Otherwise the standard
  // amber-warning treatment.
  const hasUrgent = surfaced.some(i => i.severity === 'urgent')

  return (
    <div className={`rounded-lg border ${hasUrgent ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className={hasUrgent ? 'text-red-600' : 'text-amber-600'}>
            {hasUrgent ? '🚨' : '⚠️'}
          </span>
          <span className={`text-sm font-medium ${hasUrgent ? 'text-red-800' : 'text-amber-800'}`}>
            {surfaced.length} {heading.toLowerCase()}
          </span>
        </div>
        <span className={`text-xs ${hasUrgent ? 'text-red-600' : 'text-amber-600'}`}>
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>

      {expanded && (
        <div className={`space-y-2 border-t px-4 py-3 ${hasUrgent ? 'border-red-200' : 'border-amber-200'}`}>
          {surfaced.map(issue => (
            <a
              key={issue.id}
              href={`/operations/problems/${issue.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`block rounded border bg-white px-2.5 py-2 text-xs hover:bg-opacity-90 ${
                hasUrgent ? 'border-red-200 hover:border-red-400' : 'border-amber-200 hover:border-amber-400'
              }`}
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
