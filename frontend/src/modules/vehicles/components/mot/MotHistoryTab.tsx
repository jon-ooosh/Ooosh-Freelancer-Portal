/**
 * MOT history tab — DVSA's record of every MOT on this van.
 *
 * Reads the last fetch from OP (refreshed daily, 07:30) with a "Refresh from
 * DVSA" button. DVSA's expiry IS the van's MOT Due date (services/dvsa-mot.ts
 * decideMotDue). A date typed by hand only stands until the next check, flagged
 * meanwhile — never "keep the later one", which would make alerts fire late.
 * Advisories on the LATEST test can be marked done / noted (§18) — DVSA's
 * record is never changed; the fleet board's chip counts only unmarked ones.
 * See docs/VEHICLE-SALES-SPEC.md §3, §16, §17 and §18.
 */

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchMotHistory, refreshMotHistory, applyDvsaMotDate, advisoryKeys, markAdvisory,
  type MotTest, type AdvisoryMark, type AdvisoryState,
} from '../../lib/mot-history'
import { MotFlags } from './MotFlags'
import type { Vehicle } from '../../types/vehicle'

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

/** Marking the latest test's advisories — absent on older tests. */
interface Marking {
  marks: AdvisoryMark[]
  busyKey: string | null
  onMark: (defectKey: string, state: AdvisoryState | null, note: string | null) => void
}

/**
 * One advisory's mark: "Done" / "Noted" buttons (with an optional note), or
 * the mark itself — who, when, note — with Undo.
 */
function AdvisoryMarkControl({ defectKey, marking }: { defectKey: string; marking: Marking }) {
  const [picking, setPicking] = useState<AdvisoryState | null>(null)
  const [note, setNote] = useState('')
  const mark = marking.marks.find((m) => m.defectKey === defectKey)
  const busy = marking.busyKey === defectKey
  // Saved (or undone) — close the note box so Undo doesn't reopen it half-filled.
  useEffect(() => { setPicking(null); setNote('') }, [mark?.markedAt])
  const btn = 'rounded border px-1.5 py-px text-[11px] font-medium disabled:opacity-50'

  if (mark) {
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`rounded px-1.5 py-px font-medium ${mark.state === 'done' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
          {mark.state === 'done' ? '✓ Done' : 'Noted'}
        </span>
        {mark.note && <span className="text-gray-700">{mark.note}</span>}
        <span className="text-gray-400">{mark.markedBy ?? '—'}, {fmtDate(mark.markedAt)}</span>
        <button type="button" disabled={busy} onClick={() => marking.onMark(defectKey, null, null)}
          className="text-gray-400 underline hover:text-gray-600 disabled:opacity-50">
          {busy ? 'Saving…' : 'Undo'}
        </button>
      </span>
    )
  }

  if (picking) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
          placeholder={picking === 'done' ? 'What was done? (optional)' : 'Note (optional)'}
          onKeyDown={(e) => { if (e.key === 'Enter') marking.onMark(defectKey, picking, note.trim() || null) }}
          className="w-56 rounded border border-gray-300 px-1.5 py-0.5 text-xs"
        />
        <button type="button" disabled={busy} onClick={() => marking.onMark(defectKey, picking, note.trim() || null)}
          className={`${btn} border-gray-700 bg-gray-800 text-white hover:bg-gray-700`}>
          {busy ? 'Saving…' : picking === 'done' ? 'Mark done' : 'Mark noted'}
        </button>
        <button type="button" onClick={() => { setPicking(null); setNote('') }} className="text-[11px] text-gray-500 underline">
          Cancel
        </button>
      </span>
    )
  }

  return (
    <span className="flex gap-1">
      <button type="button" onClick={() => setPicking('done')}
        title="Dealt with — fixed, replaced or checked"
        className={`${btn} border-green-300 bg-white text-green-800 hover:bg-green-50`}>Done</button>
      <button type="button" onClick={() => setPicking('noted')}
        title="Seen — not fixed yet"
        className={`${btn} border-blue-300 bg-white text-blue-800 hover:bg-blue-50`}>Noted</button>
    </span>
  )
}

function TestCard({ test, marking }: { test: MotTest; marking?: Marking }) {
  const passed = test.result === 'PASSED'
  const unit = test.odometerUnit === 'KM' ? 'km' : 'mi'
  const keys = advisoryKeys(test)
  const openCount = marking
    ? keys.filter((k) => k !== null && !marking.marks.some((m) => m.defectKey === k)).length
    : null
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
      {marking && openCount !== null && keys.some((k) => k !== null) && (
        <div className={`mt-2 text-xs font-medium ${openCount === 0 ? 'text-green-700' : 'text-gray-600'}`}>
          {openCount === 0 ? '✓ Every advisory marked done or noted' : `${openCount} advisor${openCount === 1 ? 'y' : 'ies'} not yet marked`}
        </div>
      )}
      {test.defects.length > 0 && (
        <ul className="mt-2 space-y-1">
          {test.defects.map((d, i) => {
            const type = d.dangerous ? 'DANGEROUS' : (d.type ?? '')
            const key = keys[i]
            return (
              <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
                <span className={`shrink-0 rounded px-1 py-0.5 font-medium ${DEFECT_STYLE[type] ?? 'bg-gray-100 text-gray-600'}`}>
                  {type ? type.charAt(0) + type.slice(1).toLowerCase() : 'Note'}
                </span>
                <span className="min-w-0 flex-1 text-gray-700">{d.text ?? '—'}</span>
                {marking && key && <AdvisoryMarkControl defectKey={key} marking={marking} />}
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
  const [markBusy, setMarkBusy] = useState<string | null>(null)

  async function handleMark(defectKey: string, state: AdvisoryState | null, note: string | null) {
    if (!data?.latestTestKey) return
    setMarkBusy(defectKey)
    try {
      const view = await markAdvisory(vehicleId, { testKey: data.latestTestKey, defectKey, state, note })
      queryClient.setQueryData(['mot-history', vehicleId], view)
      // The fleet board's advisory chip counts only unmarked ones.
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert((err as Error).message)
      queryClient.invalidateQueries({ queryKey: ['mot-history', vehicleId] })
    } finally {
      setMarkBusy(null)
    }
  }

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
          DVSA says the MOT expires <strong>{fmtDate(summary.dvsaMotDue)}</strong>, but MOT Due was typed in by hand as{' '}
          <strong>{fmtDate(data.motDue)}</strong>. DVSA's date replaces it at the next check (07:30) — or use it now
          under Details › Key Dates.
        </div>
      )}

      {summary && tests.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600">
          No MOT tests yet{summary.dvsaMotDue ? <> — first MOT due {fmtDate(summary.dvsaMotDue)}.</> : '.'}
        </div>
      )}

      {tests.map((t, i) => (
        <TestCard
          key={t.testNumber ?? i}
          test={t}
          marking={i === 0 && data.latestTestKey
            ? { marks: data.advisoryMarks ?? [], busyKey: markBusy, onMark: handleMark }
            : undefined}
        />
      ))}
    </div>
  )
}

/**
 * One line under Details › Key Dates › MOT Due (VEHICLE-SALES-SPEC §16).
 *
 * The MOT Due date IS DVSA's (services/dvsa-mot.ts decideMotDue). This says so,
 * or — when a date typed by hand differs from DVSA's (it stands only until the
 * next check) — says that loudly, with a one-click "Use DVSA date". Reads the
 * van's own cached DVSA fields, so it costs no request.
 */
export function MotDvsaNote({ vehicle }: { vehicle: Vehicle }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  if (!vehicle.dvsaCheckedAt) return null

  const manual = vehicle.motDueSource === 'manual' && !!vehicle.dvsaMotDue && vehicle.motDue !== vehicle.dvsaMotDue

  async function useDvsa() {
    setBusy(true)
    try {
      await applyDvsaMotDate(vehicle.id)
      await queryClient.invalidateQueries({ queryKey: ['vehicles'] })
      await queryClient.invalidateQueries({ queryKey: ['mot-history', vehicle.id] })
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`border-b border-gray-100 py-1 text-[11px] ${manual ? 'text-amber-800' : 'text-gray-400'}`}>
      {manual ? (
        <>
          ⚠ Typed in by hand — DVSA says <strong>{fmtDate(vehicle.dvsaMotDue ?? null)}</strong>. DVSA's date replaces
          it at the next check (07:30).{' '}
          <button type="button" onClick={useDvsa} disabled={busy}
            className="ml-1 rounded border border-amber-400 bg-white px-1.5 py-px font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50">
            {busy ? 'Saving…' : 'Use DVSA date'}
          </button>
        </>
      ) : vehicle.dvsaMotDue ? (
        <>✓ From DVSA (checked {fmtDateTime(vehicle.dvsaCheckedAt)})</>
      ) : (
        <>DVSA has no MOT date for this van (checked {fmtDateTime(vehicle.dvsaCheckedAt)})</>
      )}
      <MotFlags v={vehicle} className="ml-1.5" />
    </div>
  )
}
