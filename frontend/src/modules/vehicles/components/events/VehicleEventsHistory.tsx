/**
 * Event History section for a vehicle — lists all book-outs, check-ins,
 * prep events etc. newest-first. Includes inline "Regenerate PDF" action
 * on Book Out and Check In events so staff can re-issue a condition
 * report for damage disputes or correct a mis-fired original.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchVehicleEvents, type EventIndexEntry } from '../../lib/events-query'
import { regenerateEventPdf } from '../../lib/events-api'
import { vmPath } from '../../config/route-paths'

interface Props {
  vehicleReg: string
  /** Vehicle UUID — used to deep-link a book-out/check-in into its full
   *  "life of a hire" comparison page (/vehicles/fleet/:id/hire/:hhJob). */
  vehicleId?: string
}

const EVENT_TYPE_BADGE: Record<string, string> = {
  'Book Out': 'bg-green-100 text-green-800',
  'Check In': 'bg-blue-100 text-blue-800',
  'Prep Completed': 'bg-amber-100 text-amber-800',
  'Collection': 'bg-purple-100 text-purple-800',
}

function formatEventDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function VehicleEventsHistory({ vehicleReg, vehicleId }: Props) {
  const { data, isLoading, error } = useQuery<EventIndexEntry[]>({
    queryKey: ['vehicle-events', vehicleReg],
    queryFn: () => fetchVehicleEvents(vehicleReg),
    enabled: !!vehicleReg,
  })

  const events = data || []

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Event History</h3>

      {isLoading && (
        <p className="py-4 text-center text-sm text-gray-400">Loading events…</p>
      )}

      {error && (
        <p className="py-4 text-center text-sm text-red-600">
          Failed to load events: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      )}

      {!isLoading && !error && events.length === 0 && (
        <p className="py-4 text-center text-sm text-gray-400">
          No events recorded yet. Event history will appear here once book-outs, check-ins, and prep events happen.
        </p>
      )}

      {events.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {events.map(ev => (
            <EventRow key={ev.id} event={ev} vehicleReg={vehicleReg} vehicleId={vehicleId} />
          ))}
        </ul>
      )}
    </div>
  )
}

function EventRow({ event, vehicleReg, vehicleId }: { event: EventIndexEntry; vehicleReg: string; vehicleId?: string }) {
  const [regenOpen, setRegenOpen] = useState(false)
  const badgeClass = EVENT_TYPE_BADGE[event.eventType] || 'bg-gray-100 text-gray-700'
  const isHireEvent = event.eventType === 'Book Out' || event.eventType === 'Check In'
  const canRegen = isHireEvent
  // Entry point to the full "life of a hire" comparison page (out vs back-in).
  const canViewHire = isHireEvent && !!vehicleId && !!event.hireHopJob

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
              {event.eventType}
            </span>
            <span className="text-sm text-gray-700">
              {formatEventDate(event.createdAt || event.eventDate)}
            </span>
            {event.hireHopJob && (
              <a
                href={`https://myhirehop.com/job.php?id=${event.hireHopJob}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                HH #{event.hireHopJob}
              </a>
            )}
            {event.opJobId && (
              <a
                href={`/jobs/${event.opJobId}`}
                className="text-xs text-purple-700 hover:underline"
              >
                OP Job
              </a>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
            {event.mileage != null && (
              <span>Mileage: <strong className="text-gray-700">{event.mileage.toLocaleString()}</strong></span>
            )}
            {event.fuelLevel && (
              <span>Fuel: <strong className="text-gray-700">{event.fuelLevel}</strong></span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canViewHire && (
            <Link
              to={vmPath(`/vehicles/${vehicleId}/hire/${event.hireHopJob}`)}
              className="rounded border border-ooosh-navy bg-white px-3 py-1 text-xs font-medium text-ooosh-navy hover:bg-ooosh-navy/5"
            >
              View hire →
            </Link>
          )}
          {canRegen && (
            <button
              type="button"
              onClick={() => setRegenOpen(true)}
              className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Regenerate {event.eventType} PDF
            </button>
          )}
        </div>
      </div>

      {regenOpen && (
        <RegenerateDialog
          event={event}
          vehicleReg={vehicleReg}
          onClose={() => setRegenOpen(false)}
        />
      )}
    </li>
  )
}

function RegenerateDialog({
  event,
  vehicleReg,
  onClose,
}: {
  event: EventIndexEntry
  vehicleReg: string
  onClose: () => void
}) {
  const isCheckIn = event.eventType === 'Check In'
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [showCorrections, setShowCorrections] = useState(false)
  const [corrections, setCorrections] = useState({
    driverName: '',
    bookOutMileage: '',
    bookOutFuelLevel: '',
    bookOutDate: '',
    mileage: '',
  })
  const [result, setResult] = useState<{
    success: boolean
    message: string
    downloadUrl?: string
    downloadName?: string
    needsBookOutMileage?: boolean
  } | null>(null)

  function setCorrection(field: keyof typeof corrections, value: string) {
    setCorrections(prev => ({ ...prev, [field]: value }))
  }

  async function run(mode: 'send' | 'download') {
    setBusy(true)
    setResult(null)

    // Only send non-empty corrections. Any correction implies a rebuild so it
    // takes effect even if a frozen PDF exists for this event.
    const overrides = Object.fromEntries(
      Object.entries(corrections).filter(([, v]) => v.trim() !== ''),
    ) as Record<string, string>
    const hasCorrections = Object.keys(overrides).length > 0

    const res = await regenerateEventPdf({
      eventId: event.id,
      vehicleReg,
      email: mode === 'send' ? (email.trim() || undefined) : undefined,
      skipEmail: mode === 'download',
      rebuild: hasCorrections || undefined,
      overrides: hasCorrections ? overrides : undefined,
    })
    setBusy(false)

    if (!res.success) {
      setResult({ success: false, message: res.error || 'Regenerate failed' })
      return
    }

    const parts: string[] = []
    if (res.source === 'stored') {
      parts.push('Served stored original report')
    } else {
      parts.push(`${res.photoCount ?? 0} photo${res.photoCount === 1 ? '' : 's'} included`)
      if (res.reconstruction) {
        parts.push(`${res.reconstruction.damageCount} damage item${res.reconstruction.damageCount === 1 ? '' : 's'}`)
      }
      if (!res.signatureFound) parts.push('no signature on file')
    }
    if (mode === 'send') {
      parts.push(res.emailSent ? `emailed to ${res.emailedTo}` : 'email failed')
    }

    // Reconstructed check-in where the book-out mileage couldn't be found —
    // prompt staff to enter it manually and regenerate.
    const needsBookOutMileage =
      res.source === 'reconstructed' &&
      !!res.reconstruction &&
      !res.reconstruction.bookOutMileageFound &&
      !corrections.bookOutMileage.trim()

    // Build a download URL from the base64 so the staff can grab the PDF
    // directly regardless of send/download mode.
    let downloadUrl: string | undefined
    if (res.pdf) {
      try {
        const byteChars = atob(res.pdf)
        const bytes = new Uint8Array(byteChars.length)
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'application/pdf' })
        downloadUrl = URL.createObjectURL(blob)
      } catch {
        // base64 decode failed — skip download link, email/send result still valid
      }
    }

    if (needsBookOutMileage) setShowCorrections(true)

    setResult({
      success: true,
      message: parts.join(' · '),
      downloadUrl,
      downloadName: res.filename,
      needsBookOutMileage,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold text-gray-900">Regenerate {event.eventType} PDF</h3>
        <p className="mb-4 text-xs text-gray-500">
          {vehicleReg} · {formatEventDate(event.createdAt || event.eventDate)}
          {event.hireHopJob && ` · HH #${event.hireHopJob}`}
        </p>

        <label className="mb-1 block text-xs font-medium text-gray-700">
          Email recipient (optional — leave blank to use stored client email)
        </label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="recipient@example.com"
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          disabled={busy}
        />

        <button
          type="button"
          onClick={() => setShowCorrections(v => !v)}
          className="mt-3 text-xs font-medium text-blue-700 hover:underline"
        >
          {showCorrections ? '− Hide manual corrections' : '+ Manual corrections (optional)'}
        </button>

        {showCorrections && (
          <div className="mt-2 space-y-2 rounded border border-gray-200 bg-gray-50 p-3">
            <p className="text-[11px] text-gray-500">
              For older records where some details weren&apos;t saved. Fill only what&apos;s
              missing — anything left blank keeps the auto-detected value. Saving a correction
              rebuilds the PDF.
            </p>
            <CorrectionField label="Driver name" value={corrections.driverName} onChange={v => setCorrection('driverName', v)} disabled={busy} />
            {isCheckIn && (
              <>
                <CorrectionField label="Book-out mileage" type="number" value={corrections.bookOutMileage} onChange={v => setCorrection('bookOutMileage', v)} disabled={busy} />
                <CorrectionField label="Book-out fuel (e.g. 7/8)" value={corrections.bookOutFuelLevel} onChange={v => setCorrection('bookOutFuelLevel', v)} disabled={busy} />
                <CorrectionField label="Book-out date" type="date" value={corrections.bookOutDate} onChange={v => setCorrection('bookOutDate', v)} disabled={busy} />
                <CorrectionField label="Check-in mileage" type="number" value={corrections.mileage} onChange={v => setCorrection('mileage', v)} disabled={busy} />
              </>
            )}
          </div>
        )}

        {result?.needsBookOutMileage && (
          <div className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">
            Book-out mileage couldn&apos;t be established automatically. Enter it under
            &ldquo;Manual corrections&rdquo; above and regenerate.
          </div>
        )}

        {result && (
          <div
            className={`mt-3 rounded p-2 text-xs ${
              result.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {result.message}
            {result.success && result.downloadUrl && result.downloadName && (
              <div className="mt-1">
                <a
                  href={result.downloadUrl}
                  download={result.downloadName}
                  className="font-medium text-blue-700 underline"
                >
                  Download PDF
                </a>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Close
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run('download')}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? '...' : 'Download only'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run('send')}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? '...' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CorrectionField({
  label,
  value,
  onChange,
  type = 'text',
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'number' | 'date'
  disabled?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-gray-600">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
      />
    </label>
  )
}
