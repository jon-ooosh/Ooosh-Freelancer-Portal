/**
 * Prep history view for a vehicle — shows timeline of all preps with key data.
 * Highlights mileage trends, tyre data, and fluid top-ups.
 *
 * Used in VehicleDetailPage as a tab or section.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../../config/api-config'
import type { PrepHistorySession } from '../../lib/prep-history'

interface PrepHistoryTabProps {
  vehicleReg: string
}

async function fetchPrepHistory(vehicleReg: string, limit: number): Promise<{
  sessions: PrepHistorySession[]
  total: number
}> {
  const resp = await fetch(
    `${apiUrl('/get-prep-history')}?vehicleReg=${encodeURIComponent(vehicleReg)}&limit=${limit}`,
  )
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json() as Promise<{ sessions: PrepHistorySession[]; total: number }>
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

/** Extract a specific value from a prep session's sections */
function findItem(session: PrepHistorySession, itemName: string): string | null {
  for (const sec of session.sections || []) {
    for (const item of sec.items || []) {
      if (item.name.toLowerCase().includes(itemName.toLowerCase())) {
        return item.value || item.detail || null
      }
    }
  }
  return null
}

/** Extract all tyre data from a session */
function getTyreData(session: PrepHistorySession): {
  flPsi: string | null; frPsi: string | null; rlPsi: string | null; rrPsi: string | null
  flTread: string | null; frTread: string | null; rlTread: string | null; rrTread: string | null
} {
  return {
    flPsi: findItem(session, 'FL PSI') || findItem(session, 'Front Left PSI'),
    frPsi: findItem(session, 'FR PSI') || findItem(session, 'Front Right PSI'),
    rlPsi: findItem(session, 'RL PSI') || findItem(session, 'Rear Left PSI'),
    rrPsi: findItem(session, 'RR PSI') || findItem(session, 'Rear Right PSI'),
    flTread: findItem(session, 'FL tread') || findItem(session, 'Front Left tread'),
    frTread: findItem(session, 'FR tread') || findItem(session, 'Front Right tread'),
    rlTread: findItem(session, 'RL tread') || findItem(session, 'Rear Left tread'),
    rrTread: findItem(session, 'RR tread') || findItem(session, 'Rear Right tread'),
  }
}

/** Check if a fluid was topped up in this session */
function getFluidStatus(session: PrepHistorySession): string[] {
  const topped: string[] = []
  const fluidNames = ['Oil level', 'Water level', 'Screen wash', 'Ad Blue', 'AdBlue']
  for (const sec of session.sections || []) {
    for (const item of sec.items || []) {
      if (fluidNames.some(f => item.name.toLowerCase().includes(f.toLowerCase()))) {
        if (item.value?.toLowerCase().includes('topped') || item.value?.toLowerCase().includes('top')) {
          topped.push(item.name.replace(' level', ''))
        }
      }
    }
  }
  return topped
}

/** Get notes/problems from a session */
function getProblems(session: PrepHistorySession): string[] {
  const problems: string[] = []
  for (const sec of session.sections || []) {
    if (sec.notes && sec.notes.trim()) {
      problems.push(sec.notes.trim())
    }
    for (const item of sec.items || []) {
      if (item.value?.toLowerCase().includes('problem') || item.value?.toLowerCase() === 'n/a') {
        const desc = item.detail || item.name
        problems.push(desc)
      }
    }
  }
  return problems
}

export function PrepHistoryTab({ vehicleReg }: PrepHistoryTabProps) {
  const [limit, setLimit] = useState(10)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['prep-history', vehicleReg, limit],
    queryFn: () => fetchPrepHistory(vehicleReg, limit),
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 rounded-lg bg-gray-100" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load prep history
      </div>
    )
  }

  const sessions = data?.sessions || []
  const total = data?.total || 0

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
        No prep history for this vehicle
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Mileage trend summary */}
      {sessions.length >= 2 && (() => {
        const mileages = sessions
          .filter(s => s.mileage != null)
          .map(s => ({ date: s.date, mileage: s.mileage! }))
        if (mileages.length >= 2) {
          const latest = mileages[0]!
          const oldest = mileages[mileages.length - 1]!
          const diff = latest.mileage - oldest.mileage
          const days = Math.max(1, (new Date(latest.date).getTime() - new Date(oldest.date).getTime()) / (1000 * 60 * 60 * 24))
          const avgPerWeek = Math.round((diff / days) * 7)
          return (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              <span className="font-medium">{diff.toLocaleString('en-GB')} miles</span> over {mileages.length} preps
              {avgPerWeek > 0 && <span className="ml-1">({avgPerWeek.toLocaleString('en-GB')}/week avg)</span>}
            </div>
          )
        }
        return null
      })()}

      {/* Session cards */}
      {sessions.map((session, i) => {
        const tyres = getTyreData(session)
        const fluidsTopped = getFluidStatus(session)
        const problems = getProblems(session)
        const hasTyreData = Object.values(tyres).some(v => v != null)
        const isImported = (session as unknown as Record<string, unknown>).source === 'import'

        return (
          <div key={i} className="rounded-lg border border-gray-200 bg-white p-3">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900">{formatDate(session.date)}</span>
                {isImported && (
                  <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-400">
                    Imported
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                {session.preparedBy && (
                  <span>{session.preparedBy}</span>
                )}
                {session.overallStatus && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    session.overallStatus.toLowerCase().includes('attention') || session.overallStatus.toLowerCase().includes('problem')
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {session.overallStatus}
                  </span>
                )}
              </div>
            </div>

            {/* Key metrics */}
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {session.mileage != null && (
                <div>
                  <span className="text-gray-400">Mileage </span>
                  <span className="font-medium text-gray-700">{session.mileage.toLocaleString('en-GB')}</span>
                </div>
              )}
              {session.fuelLevel && (
                <div>
                  <span className="text-gray-400">Fuel </span>
                  <span className="font-medium text-gray-700">{session.fuelLevel}</span>
                </div>
              )}
              {fluidsTopped.length > 0 && (
                <div>
                  <span className="text-gray-400">Topped up </span>
                  <span className="font-medium text-amber-600">{fluidsTopped.join(', ')}</span>
                </div>
              )}
            </div>

            {/* Tyre data */}
            {hasTyreData && (
              <div className="mt-2 grid grid-cols-4 gap-1 text-[10px]">
                <div className="text-center">
                  <div className="text-gray-400">FL</div>
                  {tyres.flPsi && <div className="font-medium text-gray-700">{tyres.flPsi} PSI</div>}
                  {tyres.flTread && <div className="text-gray-500">{tyres.flTread}mm</div>}
                </div>
                <div className="text-center">
                  <div className="text-gray-400">FR</div>
                  {tyres.frPsi && <div className="font-medium text-gray-700">{tyres.frPsi} PSI</div>}
                  {tyres.frTread && <div className="text-gray-500">{tyres.frTread}mm</div>}
                </div>
                <div className="text-center">
                  <div className="text-gray-400">RL</div>
                  {tyres.rlPsi && <div className="font-medium text-gray-700">{tyres.rlPsi} PSI</div>}
                  {tyres.rlTread && <div className="text-gray-500">{tyres.rlTread}mm</div>}
                </div>
                <div className="text-center">
                  <div className="text-gray-400">RR</div>
                  {tyres.rrPsi && <div className="font-medium text-gray-700">{tyres.rrPsi} PSI</div>}
                  {tyres.rrTread && <div className="text-gray-500">{tyres.rrTread}mm</div>}
                </div>
              </div>
            )}

            {/* Problems */}
            {problems.length > 0 && (
              <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
                {problems.slice(0, 3).map((p, j) => (
                  <div key={j}>{p}</div>
                ))}
                {problems.length > 3 && <div className="text-amber-500">+{problems.length - 3} more</div>}
              </div>
            )}
          </div>
        )
      })}

      {/* Load more */}
      {sessions.length < total && (
        <button
          type="button"
          onClick={() => setLimit(l => l + 20)}
          className="w-full rounded-lg border border-gray-200 bg-white py-2 text-xs font-medium text-gray-500 hover:bg-gray-50"
        >
          Load more ({total - sessions.length} remaining)
        </button>
      )}
    </div>
  )
}
