/**
 * MOT history tab — DVSA's record of every MOT on this van.
 *
 * Reads the last fetch from OP (refreshed weekly, Mon 07:30) with a
 * "Refresh from DVSA" button. A refresh can move the van's MOT Due date
 * FORWARD when DVSA knows of a later pass; it never moves it back — an
 * earlier DVSA date shows here as a warning instead.
 * See docs/VEHICLE-SALES-SPEC.md §3.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMotHistory, refreshMotHistory, type MotTest } from '../../lib/mot-history'

interface Props {
  vehicleId: string
}

/** '2026-09-02' → '2 Sep 2026'. Range-checked: a bad value renders '—', never throws. */
function fmtDate(d: string | null): string {
  if (!d) return '—'
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDateTime(d: string | null): string {
  if (!d) return '—'
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const DEFECT_STYLE: Record<string, string> = {
  DANGEROUS: 'bg-red-100 text-red-800',
  MAJOR: 'bg-red-50 text-red-700',
  FAIL: 'bg-red-50 text-red-700',
  MINOR: 'bg-amber-50 text-amber-700',
  ADVISORY: 'bg-gray-100 text-gray-600',
}

function TestCard({ test }: { test: MotTest }) {
  const passed = test.result === 'PASSED'
  const unit = test.odometerUnit === 'KM' ? 'km' : 'mi'
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {passed ? 'PASS' : test.result === 'FAILED' ? 'FAIL' : test.result}
        </span>
        <span className="text-sm font-medium text-gray-900">{fmtDate(test.completedDate)}</span>
        <span className="text-xs text-gray-500">
          {test.odometer != null
            ? `${test.odometer.toLocaleString('en-GB')} ${unit}`
            : 'Mileage not read'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
        {passed && test.expiryDate && <span>Expires {fmtDate(test.expiryDate)}</span>}
        {test.testNumber && <span>Test no. {test.testNumber}</span>}
        {test.location && <span>{test.location}</span>}
      </div>
      {test.defects.length > 0 && (
        <ul className="mt-2 space-y-1">
          {test.defects.map((d, i) => {
            const type = d.dangerous ? 'DANGEROUS' : (d.type ?? '')
            return (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 rounded px-1 py-0.5 font-medium ${DEFECT_STYLE[type] ?? 'bg-gray-100 text-gray-600'}`}>
                  {type ? type.charAt(0) + type.slice(1).toLowerCase() : 'Note'}
                </span>
                <span className="text-gray-700">{d.text ?? '—'}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function MotHistoryTab({ vehicleId }: Props) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mot-history', vehicleId],
    queryFn: () => fetchMotHistory(vehicleId),
  })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const view = await refreshMotHistory(vehicleId)
      queryClient.setQueryData(['mot-history', vehicleId], view)
      // A refresh can move MOT Due forward — reload the vehicle so Key Dates shows it.
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      setRefreshError((err as Error).message)
      queryClient.invalidateQueries({ queryKey: ['mot-history', vehicleId] })
    } finally {
      setRefreshing(false)
    }
  }

  if (isLoading) return <div className="py-6 text-center text-sm text-gray-400">Loading MOT history…</div>
  if (isError || !data) return <div className="py-6 text-center text-sm text-red-500">Could not load MOT history.</div>

  const summary = data.summary
  const tests = summary?.tests ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">
          {data.fetchedAt ? <>From DVSA · updated {fmtDateTime(data.fetchedAt)}</> : 'Not fetched from DVSA yet'}
        </div>
        {data.configured && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh from DVSA'}
          </button>
        )}
      </div>

      {!data.configured && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          DVSA isn't set up on this server yet, so MOT history can't be fetched.
        </div>
      )}

      {(refreshError || data.lastError) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {refreshError || data.lastError}
          {!refreshError && data.lastAttemptAt && (
            <span className="block text-xs text-amber-600">Last tried {fmtDateTime(data.lastAttemptAt)}</span>
          )}
        </div>
      )}

      {summary?.hasOutstandingRecall === 'Yes' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          DVSA reports an <strong>outstanding manufacturer recall</strong> on this van.
        </div>
      )}

      {data.comparison === 'earlier' && summary?.dvsaMotDue && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          DVSA says the MOT expires <strong>{fmtDate(summary.dvsaMotDue)}</strong>, but OP has{' '}
          <strong>{fmtDate(data.motDue)}</strong>. OP won't move the date back on its own — check which is right
          and correct MOT Due on the Details tab if needed.
        </div>
      )}

      {summary && tests.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600">
          No MOT tests yet{summary.dvsaMotDue ? <> — first MOT due {fmtDate(summary.dvsaMotDue)}.</> : '.'}
        </div>
      )}

      {tests.map((t, i) => <TestCard key={t.testNumber ?? i} test={t} />)}
    </div>
  )
}
