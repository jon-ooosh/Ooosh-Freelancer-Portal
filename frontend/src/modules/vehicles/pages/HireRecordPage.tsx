/**
 * HireRecordPage — the "life of a hire" view.
 *
 * Pairs a van's Book Out and Check In events for one HireHop job and shows
 * them side by side: mileage & fuel deltas, walkaround photos (out vs back-in)
 * by angle, and notes. Deep-linkable so staff can pull it up later in the day
 * (or days later) when discussing damage / under-fuelling with a client or
 * repair shop.
 *
 * Route: /vehicles/fleet/:id/hire/:hhJob
 */

import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { apiFetch } from '../config/api-config'
import { useVehicle } from '../hooks/useVehicles'
import { fetchVehicleEvents, type EventIndexEntry } from '../lib/events-query'

const R2_PUBLIC_URL = import.meta.env.VITE_R2_PUBLIC_URL || ''

interface EventDetail {
  id: string
  eventDate: string
  createdAt?: string
  mileage: number | null
  fuelLevel: string | null
  notes?: string | null
  details?: string | null
  driverName?: string | null
  clientEmail?: string | null
  photoMeta?: Array<{ angle: string; label: string }> | null
}

interface EventPhotos {
  /** Walkaround photos by angle slug → public image URL. */
  byAngle: Map<string, string>
  /** Damage detail photos (public URLs), flat list. */
  damage: string[]
}

function safeRegOf(reg: string): string {
  return reg.replace(/\s+/g, '-').toUpperCase()
}

function prettifyAngle(angle: string): string {
  const s = angle.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function fetchEventDetail(vehicleReg: string, eventId: string): Promise<EventDetail | null> {
  const params = new URLSearchParams({ vehicleReg, eventId })
  const res = await apiFetch(`/get-events?${params}`)
  if (!res.ok) return null
  const data = await res.json() as { event?: EventDetail | null }
  return data.event || null
}

async function fetchEventPhotos(vehicleReg: string, eventId: string): Promise<EventPhotos> {
  const prefix = `events/${eventId}/${safeRegOf(vehicleReg)}/`
  const byAngle = new Map<string, string>()
  const damage: string[] = []
  try {
    const res = await apiFetch(`/list-photos?prefix=${encodeURIComponent(prefix)}`)
    if (!res.ok) return { byAngle, damage }
    const data = await res.json() as { photos: Array<{ angle: string; key: string }> }
    for (const p of data.photos || []) {
      if (!p.key) continue
      const publicUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${p.key}` : `/api/vehicles/photo/${encodeURIComponent(p.key)}`
      // Damage photos live under .../damage/{id}/{i}.jpg — keep them separate
      // from the walkaround angle set.
      if (p.key.includes('/damage/')) {
        damage.push(publicUrl)
      } else if (p.angle) {
        byAngle.set(p.angle, publicUrl)
      }
    }
  } catch {
    // best-effort — render whatever we got
  }
  return { byAngle, damage }
}

export function HireRecordPage() {
  const { id, hhJob } = useParams<{ id: string; hhJob: string }>()
  const { data: vehicle, isLoading: vehicleLoading } = useVehicle(id)
  const reg = vehicle?.reg || ''
  const [lightbox, setLightbox] = useState<string | null>(null)

  // All events for this van, narrowed to the requested hire (HH job).
  const { data: events, isLoading: eventsLoading } = useQuery<EventIndexEntry[]>({
    queryKey: ['vehicle-events', reg],
    queryFn: () => fetchVehicleEvents(reg),
    enabled: !!reg,
  })

  const { bookOut, checkIn } = useMemo(() => {
    const forJob = (events || []).filter(e => String(e.hireHopJob || '') === String(hhJob || ''))
    // Index is newest-first; take the most recent of each type.
    return {
      bookOut: forJob.find(e => e.eventType === 'Book Out') || null,
      checkIn: forJob.find(e => e.eventType === 'Check In') || null,
    }
  }, [events, hhJob])

  const opJobId = bookOut?.opJobId || checkIn?.opJobId || null

  // Full details + photos for each side.
  const { data: bookOutDetail } = useQuery({
    queryKey: ['hire-event-detail', reg, bookOut?.id],
    queryFn: () => fetchEventDetail(reg, bookOut!.id),
    enabled: !!reg && !!bookOut?.id,
  })
  const { data: checkInDetail } = useQuery({
    queryKey: ['hire-event-detail', reg, checkIn?.id],
    queryFn: () => fetchEventDetail(reg, checkIn!.id),
    enabled: !!reg && !!checkIn?.id,
  })
  const { data: bookOutPhotos } = useQuery({
    queryKey: ['hire-event-photos', reg, bookOut?.id],
    queryFn: () => fetchEventPhotos(reg, bookOut!.id),
    enabled: !!reg && !!bookOut?.id,
  })
  const { data: checkInPhotos } = useQuery({
    queryKey: ['hire-event-photos', reg, checkIn?.id],
    queryFn: () => fetchEventPhotos(reg, checkIn!.id),
    enabled: !!reg && !!checkIn?.id,
  })

  const loading = vehicleLoading || eventsLoading

  // Angle label lookup, preferring the labels saved on each event.
  const angleLabels = useMemo(() => {
    const m = new Map<string, string>()
    for (const meta of [...(bookOutDetail?.photoMeta || []), ...(checkInDetail?.photoMeta || [])]) {
      if (meta?.angle && meta?.label) m.set(meta.angle, meta.label)
    }
    return m
  }, [bookOutDetail, checkInDetail])

  // Union of angles across both walkarounds, book-out order first.
  const angles = useMemo(() => {
    const out = bookOutPhotos?.byAngle || new Map()
    const back = checkInPhotos?.byAngle || new Map()
    const ordered: string[] = []
    for (const a of out.keys()) ordered.push(a)
    for (const a of back.keys()) if (!ordered.includes(a)) ordered.push(a)
    return ordered
  }, [bookOutPhotos, checkInPhotos])

  const milesDriven = bookOut?.mileage != null && checkIn?.mileage != null
    ? checkIn.mileage - bookOut.mileage
    : null

  return (
    <div className="space-y-4">
      <Link to={vmPath(`/vehicles/${id}`)} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to {reg || 'vehicle'}
      </Link>

      {loading && (
        <div className="animate-pulse space-y-3">
          <div className="h-8 w-48 rounded bg-gray-200" />
          <div className="h-32 rounded-lg bg-gray-100" />
        </div>
      )}

      {!loading && !bookOut && !checkIn && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
          No book-out or check-in events found for {reg} on hire #{hhJob}.
        </div>
      )}

      {!loading && (bookOut || checkIn) && (
        <>
          {/* Header */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-xl font-bold text-ooosh-navy">{reg} — Hire #{hhJob}</h2>
                <p className="text-sm text-gray-500">
                  {vehicle?.vehicleType || vehicle?.simpleType}
                  {bookOutDetail?.driverName ? ` · ${bookOutDetail.driverName}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {hhJob && (
                  <a href={`https://myhirehop.com/job.php?id=${hhJob}`} target="_blank" rel="noopener noreferrer"
                     className="rounded border border-gray-300 px-2.5 py-1 font-medium text-blue-600 hover:bg-gray-50">
                    HireHop #{hhJob}
                  </a>
                )}
                {opJobId && (
                  <a href={`/jobs/${opJobId}`} className="rounded border border-gray-300 px-2.5 py-1 font-medium text-purple-700 hover:bg-gray-50">
                    OP Job
                  </a>
                )}
                <Link to={vmPath(`/issues/new?vehicle=${id}`)}
                      className="rounded border border-gray-300 px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-50">
                  Log issue
                </Link>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Out: <strong className="text-gray-700">{formatDateTime(bookOut?.createdAt || bookOut?.eventDate)}</strong>
              {' · '}
              Back: <strong className="text-gray-700">{checkIn ? formatDateTime(checkIn.createdAt || checkIn.eventDate) : 'still out'}</strong>
            </div>
          </div>

          {/* State comparison */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StateCard
              title="Booked Out"
              accent="border-green-200"
              mileage={bookOut?.mileage ?? null}
              fuel={bookOut?.fuelLevel ?? null}
              notes={bookOutDetail?.notes || null}
            />
            <StateCard
              title="Checked In"
              accent="border-blue-200"
              mileage={checkIn?.mileage ?? null}
              fuel={checkIn?.fuelLevel ?? null}
              notes={checkInDetail?.notes || null}
              empty={!checkIn ? 'Not yet checked in' : undefined}
            />
          </div>

          {/* Deltas */}
          {checkIn && (
            <div className="flex flex-wrap gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm">
              <span className="text-gray-500">Miles driven:{' '}
                <strong className="text-gray-800">{milesDriven != null ? milesDriven.toLocaleString() : '—'}</strong>
              </span>
              {bookOut?.fuelLevel && checkIn?.fuelLevel && bookOut.fuelLevel !== checkIn.fuelLevel && (
                <span className="text-gray-500">Fuel change:{' '}
                  <strong className="text-amber-700">{bookOut.fuelLevel} → {checkIn.fuelLevel}</strong>
                </span>
              )}
            </div>
          )}

          {/* Damage photos (from check-in) */}
          {(checkInPhotos?.damage.length || 0) > 0 && (
            <div className="rounded-lg border border-red-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-600">Damage Photos (Check-In)</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {checkInPhotos!.damage.map((url, i) => (
                  <button key={i} type="button" onClick={() => setLightbox(url)}
                          className="aspect-square overflow-hidden rounded border border-gray-200">
                    <img src={url} alt={`Damage ${i + 1}`} className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Walkaround photo comparison */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Walkaround — Out vs Back In
            </h3>
            {angles.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-400">No walkaround photos on file for this hire.</p>
            ) : (
              <div className="space-y-3">
                {angles.map(angle => (
                  <div key={angle} className="rounded-lg border border-gray-100 p-2">
                    <p className="mb-1.5 text-xs font-medium text-gray-500">{angleLabels.get(angle) || prettifyAngle(angle)}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <ComparePhoto label="Out" url={bookOutPhotos?.byAngle.get(angle)} onOpen={setLightbox} />
                      <ComparePhoto label="Back" url={checkInPhotos?.byAngle.get(angle)} onOpen={setLightbox} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Full size" className="max-h-full max-w-full rounded" onClick={e => e.stopPropagation()} />
          <button type="button" onClick={() => setLightbox(null)}
                  className="absolute right-4 top-4 rounded-full bg-white/90 px-3 py-1 text-sm font-medium text-gray-800">
            Close
          </button>
        </div>
      )}
    </div>
  )
}

function StateCard({
  title, accent, mileage, fuel, notes, empty,
}: {
  title: string
  accent: string
  mileage: number | null
  fuel: string | null
  notes: string | null
  empty?: string
}) {
  return (
    <div className={`rounded-lg border-2 bg-white p-4 ${accent}`}>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {empty ? (
        <p className="py-2 text-sm text-gray-400">{empty}</p>
      ) : (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-xs font-medium text-gray-400">Mileage:</span>
            <span className="tabular-nums text-gray-800">{mileage != null ? mileage.toLocaleString() : '—'}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-xs font-medium text-gray-400">Fuel:</span>
            <span className="text-gray-800">{fuel || '—'}</span>
          </div>
          {notes && (
            <div className="pt-1">
              <span className="text-xs font-medium text-gray-400">Notes</span>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ComparePhoto({ label, url, onOpen }: { label: string; url?: string; onOpen: (url: string) => void }) {
  return (
    <div>
      <p className="mb-0.5 text-[10px] font-medium uppercase text-gray-400">{label}</p>
      {url ? (
        <button type="button" onClick={() => onOpen(url)} className="block aspect-[4/3] w-full overflow-hidden rounded border border-gray-200">
          <img src={url} alt={label} className="h-full w-full object-cover" loading="lazy" />
        </button>
      ) : (
        <div className="flex aspect-[4/3] w-full items-center justify-center rounded border border-dashed border-gray-200 text-[11px] text-gray-300">
          No photo
        </div>
      )}
    </div>
  )
}
