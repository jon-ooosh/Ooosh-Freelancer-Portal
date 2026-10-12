/**
 * The GPS tracker register — Fleet Map › Trackers.
 *
 * One row per physical unit (the numbered label on it), the van it is in now,
 * its IMEI and SIM, and what Traccar says about it. Fitting, moving and
 * removing a unit keeps its history (services/gps-trackers.ts).
 *
 * The checks at the top are warnings only: a unit Traccar has never heard of,
 * a Traccar device that isn't on the register, a unit still in a van that has
 * left the fleet.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../../config/route-paths'
import { useGpsTrackers, useRefreshTrackers } from '../../hooks/useGpsTrackers'
import { useTraccarDevices } from '../../hooks/useTraccar'
import { useVehicles } from '../../hooks/useVehicles'
import {
  createTracker, updateTracker, fitTracker, removeTracker, getTrackerHistory,
  type GpsTracker, type TrackerFitting, type TrackerStatus,
} from '../../lib/gps-trackers-api'
import { timeSince } from '../../types/traccar'
import type { TraccarDevice } from '../../types/traccar'
import { ukToday } from '../../../../lib/ukDate'

const normaliseReg = (s: string) => s.replace(/\s+/g, '').toUpperCase()

const STATUS_LABEL: Record<TrackerStatus, string> = {
  active: 'In service',
  faulty: 'Faulty',
  retired: 'Retired',
}

const inputCls = 'w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-300 focus:outline-none'
const btnPrimary = 'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50'
const btnPlain = 'rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50'

export function TrackersPanel() {
  const { data: trackers, isLoading, error } = useGpsTrackers()
  const { data: devices, isError: traccarFailed } = useTraccarDevices()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const deviceByImei = useMemo(() => {
    const m = new Map<string, TraccarDevice>()
    for (const d of devices || []) m.set(d.uniqueId, d)
    return m
  }, [devices])

  const fitted = trackers?.filter(t => t.vehicleReg) || []
  const spare = trackers?.filter(t => !t.vehicleReg && t.status === 'active') || []
  const outOfService = trackers?.filter(t => t.status !== 'active') || []

  // Warnings — informational only.
  const notInTraccar = devices ? (trackers || []).filter(t => t.status !== 'retired' && !deviceByImei.has(t.imei)) : []
  const notOnRegister = devices && trackers
    ? devices.filter(d => !trackers.some(t => t.imei === d.uniqueId))
    : []
  const inGoneVans = (trackers || []).filter(t => t.vehicleReg && t.vehicleActive === false)

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-lg bg-gray-100" />
  }
  if (error) {
    return <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Couldn't load the tracker register: {(error as Error).message}</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          {fitted.length} fitted · {spare.length} spare
          {outOfService.length > 0 && ` · ${outOfService.length} faulty / retired`}
        </p>
        {!adding && (
          <button type="button" className={btnPlain} onClick={() => setAdding(true)}>+ Add tracker</button>
        )}
      </div>

      {adding && <AddTrackerForm onDone={() => setAdding(false)} />}

      {(notInTraccar.length > 0 || notOnRegister.length > 0 || inGoneVans.length > 0 || traccarFailed) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {traccarFailed && <p>Couldn't reach Traccar, so the online/last-seen column is empty.</p>}
          {notInTraccar.map(t => (
            <p key={t.id}>Tracker {t.trackerNumber} (IMEI {t.imei}) isn't in Traccar — add it there with that IMEI as the identifier.</p>
          ))}
          {notOnRegister.map(d => (
            <p key={d.id}>Traccar has a device "{d.name}" (IMEI {d.uniqueId}) that isn't on this register.</p>
          ))}
          {inGoneVans.map(t => (
            <p key={t.id}>Tracker {t.trackerNumber} is still recorded in {t.vehicleReg}, which has left the fleet — recover it or remove it here.</p>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {(trackers || []).length === 0 && (
          <p className="p-4 text-center text-sm text-gray-400">No trackers on the register yet.</p>
        )}
        {(trackers || []).map(t => (
          <TrackerRow
            key={t.id}
            tracker={t}
            device={deviceByImei.get(t.imei)}
            open={openId === t.id}
            onToggle={() => setOpenId(openId === t.id ? null : t.id)}
          />
        ))}
      </div>
    </div>
  )
}

// ── One tracker ─────────────────────────────────────────────────────────────

function TrackerRow({ tracker: t, device, open, onToggle }: {
  tracker: GpsTracker
  device: TraccarDevice | undefined
  open: boolean
  onToggle: () => void
}) {
  const nameMismatch = device && t.vehicleReg && normaliseReg(device.name) !== normaliseReg(t.vehicleReg)

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        <span className="w-12 shrink-0 font-mono text-sm font-semibold text-gray-900">{t.trackerNumber}</span>
        <span className="min-w-0 flex-1">
          {t.vehicleReg ? (
            <span className="text-sm font-medium text-gray-900">{t.vehicleReg}</span>
          ) : (
            <span className="text-sm text-gray-400">Spare</span>
          )}
          {t.status !== 'active' && (
            <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${t.status === 'faulty' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
              {STATUS_LABEL[t.status]}
            </span>
          )}
          {t.notes && <span className="block truncate text-xs text-gray-400">{t.notes}</span>}
        </span>
        <span className="hidden w-44 shrink-0 text-xs text-gray-400 sm:block">
          <span className="block font-mono">{t.imei}</span>
          <span className="block font-mono">{t.iccid || 'SIM —'}</span>
        </span>
        <span className="w-28 shrink-0 text-right text-xs">
          {device ? (
            <span className="inline-flex items-center gap-1.5 text-gray-500">
              <span className={`inline-block h-2 w-2 rounded-full ${device.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}`} />
              {device.lastUpdate ? timeSince(device.lastUpdate) : device.status}
            </span>
          ) : (
            <span className="text-gray-300">Not in Traccar</span>
          )}
        </span>
      </button>
      {nameMismatch && (
        <p className="px-3 pb-2 text-[11px] text-gray-400">Traccar calls this unit "{device!.name}" — rename it there to {t.vehicleReg} so its own screens match.</p>
      )}
      {open && <TrackerDetail tracker={t} />}
    </div>
  )
}

function TrackerDetail({ tracker: t }: { tracker: GpsTracker }) {
  const refresh = useRefreshTrackers()
  const { data: vehicles } = useVehicles()
  const { data: trackers } = useGpsTrackers()
  const [history, setHistory] = useState<TrackerFitting[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [trackerNumber, setTrackerNumber] = useState(t.trackerNumber)
  const [imei, setImei] = useState(t.imei)
  const [iccid, setIccid] = useState(t.iccid || '')
  const [status, setStatus] = useState<TrackerStatus>(t.status)
  const [notes, setNotes] = useState(t.notes || '')

  const [vehicleId, setVehicleId] = useState('')
  const [moveDate, setMoveDate] = useState(ukToday())

  useEffect(() => {
    getTrackerHistory(t.id).then(setHistory).catch(() => setHistory([]))
  }, [t.id])

  // Vans that can take it: in the fleet, and without a tracker of their own.
  const vanOptions = useMemo(() => {
    const taken = new Map<string, string>()
    for (const x of trackers || []) if (x.vehicleId) taken.set(x.vehicleId, x.trackerNumber)
    return (vehicles || [])
      .filter(v => !v.isOldSold && v.id !== t.vehicleId)
      .sort((a, b) => a.reg.localeCompare(b.reg))
      .map(v => ({ id: v.id, reg: v.reg, takenBy: taken.get(v.id) }))
  }, [vehicles, trackers, t.vehicleId])

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      await refresh()
      setMessage({ ok: true, text: done })
      getTrackerHistory(t.id).then(setHistory).catch(() => {})
      return true
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Failed' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const detailsChanged = trackerNumber !== t.trackerNumber || imei !== t.imei
    || iccid !== (t.iccid || '') || status !== t.status || notes !== (t.notes || '')

  return (
    <div className="space-y-4 bg-gray-50 px-3 py-3">
      {/* Fit / move / remove */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t.vehicleReg ? `In ${t.vehicleReg}${t.fittedOn ? ` since ${t.fittedOn}` : ''}` : 'Not fitted'}
        </h4>
        {t.status !== 'retired' && (
          <div className="flex flex-wrap items-center gap-2">
            <select value={vehicleId} onChange={e => setVehicleId(e.target.value)} className="rounded border border-gray-200 px-2 py-1.5 text-sm">
              <option value="">{t.vehicleReg ? 'Move to…' : 'Fit to…'}</option>
              {vanOptions.map(v => (
                <option key={v.id} value={v.id} disabled={!!v.takenBy}>
                  {v.reg}{v.takenBy ? ` (has ${v.takenBy})` : ''}
                </option>
              ))}
            </select>
            <input type="date" value={moveDate} onChange={e => setMoveDate(e.target.value)} className="rounded border border-gray-200 px-2 py-1.5 text-sm" />
            <button
              type="button"
              className={btnPrimary}
              disabled={busy || !vehicleId || !moveDate}
              onClick={() => run(() => fitTracker(t.id, vehicleId, moveDate), 'Fitted').then(ok => { if (ok) setVehicleId('') })}
            >
              {t.vehicleReg ? 'Move' : 'Fit'}
            </button>
            {t.vehicleReg && (
              <button
                type="button"
                className={btnPlain}
                disabled={busy || !moveDate}
                onClick={() => {
                  if (window.confirm(`Take tracker ${t.trackerNumber} out of ${t.vehicleReg}?`)) {
                    run(() => removeTracker(t.id, moveDate), 'Removed — it is now a spare')
                  }
                }}
              >
                Take out
              </button>
            )}
            {t.vehicleId && (
              <Link to={vmPath(`/vehicles/${t.vehicleId}`)} className="text-xs text-blue-600 hover:underline">View van →</Link>
            )}
          </div>
        )}
      </div>

      {/* Details */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Details</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="text-xs text-gray-500">Number
            <input value={trackerNumber} onChange={e => setTrackerNumber(e.target.value)} className={inputCls} />
          </label>
          <label className="text-xs text-gray-500">IMEI
            <input value={imei} onChange={e => setImei(e.target.value)} className={`${inputCls} font-mono`} />
          </label>
          <label className="text-xs text-gray-500">SIM (ICCID)
            <input value={iccid} onChange={e => setIccid(e.target.value)} className={`${inputCls} font-mono`} />
          </label>
          <label className="text-xs text-gray-500">Status
            <select value={status} onChange={e => setStatus(e.target.value as TrackerStatus)} className={inputCls}>
              {(Object.keys(STATUS_LABEL) as TrackerStatus[]).map(s => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-xs text-gray-500">Notes
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </label>
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || !detailsChanged}
          onClick={() => run(() => updateTracker(t.id, { trackerNumber, imei, iccid: iccid || null, status, notes: notes || null }), 'Saved')}
        >
          Save details
        </button>
      </div>

      {message && (
        <p className={`text-xs ${message.ok ? 'text-green-700' : 'text-red-600'}`}>{message.text}</p>
      )}

      {/* History */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">History</h4>
        {history === null ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-gray-400">Never fitted.</p>
        ) : (
          <ul className="space-y-0.5 text-xs text-gray-600">
            {history.map((h, i) => (
              <li key={i}>
                <span className="font-medium">{h.vehicleReg}</span>
                {' — '}{h.fittedOn} → {h.removedOn || 'now'}
                {(h.fittedBy || h.removedBy) && (
                  <span className="text-gray-400">
                    {h.fittedBy && ` · fitted by ${h.fittedBy}`}
                    {h.removedBy && ` · removed by ${h.removedBy}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Add ─────────────────────────────────────────────────────────────────────

function AddTrackerForm({ onDone }: { onDone: () => void }) {
  const refresh = useRefreshTrackers()
  const { data: trackers } = useGpsTrackers()
  // Next free number: one past the highest numeric label.
  const nextNumber = useMemo(() => {
    const nums = (trackers || []).map(t => Number(t.trackerNumber)).filter(n => Number.isInteger(n))
    return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')
  }, [trackers])

  const [trackerNumber, setTrackerNumber] = useState(nextNumber)
  const [imei, setImei] = useState('')
  const [iccid, setIccid] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setBusy(true)
    setError('')
    try {
      await createTracker({ trackerNumber, imei, iccid: iccid || undefined, notes: notes || undefined })
      await refresh()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
      <h4 className="text-sm font-medium text-gray-900">Add a tracker</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs text-gray-500">Number (the label)
          <input value={trackerNumber} onChange={e => setTrackerNumber(e.target.value)} className={inputCls} />
        </label>
        <label className="text-xs text-gray-500">IMEI
          <input value={imei} onChange={e => setImei(e.target.value)} placeholder="15 digits" className={`${inputCls} font-mono`} />
        </label>
        <label className="text-xs text-gray-500">SIM (ICCID)
          <input value={iccid} onChange={e => setIccid(e.target.value)} className={`${inputCls} font-mono`} />
        </label>
        <label className="text-xs text-gray-500">Notes
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </label>
      </div>
      <p className="text-[11px] text-gray-400">Add it in Traccar too, with the IMEI as its identifier. Fit it to a van from its row once saved.</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={btnPrimary} disabled={busy || !trackerNumber || !imei} onClick={save}>Add</button>
        <button type="button" className={btnPlain} disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}
