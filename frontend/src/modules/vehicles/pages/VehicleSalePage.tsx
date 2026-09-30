/**
 * Vehicle sale page — /vehicles/fleet/:id/sale (docs/VEHICLE-SALES-SPEC.md §5).
 *
 * One page per van: starts the sale (admin), then holds its stage, price,
 * description and chosen photos. The van itself is untouched — it stays active
 * and hireable (D2). Vehicle facts shown here are LIVE; only the photos are
 * chosen and kept (D4–D5). A Problem logged on the van after the photos were
 * last confirmed shows as a banner until someone looks (D6).
 *
 * Rules live in the backend (services/vehicle-sales.ts); this page only hides
 * what the viewer's role can't do.
 */

import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { hasManagerRole } from '../../../lib/roles'
import { prepareImage } from '../../../lib/imageNormalise'
import { vmPath } from '../config/route-paths'
import { apiFetch } from '../config/api-config'
import { useVehicle } from '../hooks/useVehicles'
import { getOpAuthState } from '../adapters/auth-adapter'
import { fetchVehicleEvents, type EventIndexEntry } from '../lib/events-query'
import {
  SALE_STAGES,
  saleStageLabel,
  fetchSaleForVehicle,
  startSale,
  updateSale,
  addEventPhotos,
  confirmSalePhotos,
  reorderSalePhotos,
  labelSalePhoto,
  removeSalePhoto,
  uploadSalePhoto,
  salePhotoUrl,
  fetchSaleLinks,
  createSaleLink,
  updateSaleLink,
  revokeSaleLink,
  saleLinkUrl,
  fetchSalesContact,
  saveSalesContact,
  DEFAULT_LINK_SWITCHES,
  LINK_SWITCH_LABELS,
  type LinkSwitches,
  type SaleLink,
  type SaleView,
  type VatBasis,
} from '../lib/vehicle-sales'
import type { Vehicle } from '../types/vehicle'

// ── Formatting (range-checked: a bad value renders '—', never throws) ──────

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtMoney(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: n % 1 === 0 ? 0 : 2 })
}

function daysSince(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000))
}

function prettifyAngle(angle: string): string {
  const s = angle.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A dashboard / odometer shot shows the mileage on the day — flag it (§5.3). */
function isDashboardShot(text: string | null | undefined): boolean {
  return !!text && /dash|odometer|mileage|clock/i.test(text)
}

// ── Page ───────────────────────────────────────────────────────────────────

export function VehicleSalePage() {
  const { id } = useParams()
  // Keyed on the id so nothing carries across vans (frontend.md, detail pages).
  return <SaleContent key={id} vehicleId={id ?? ''} />
}

function SaleContent({ vehicleId }: { vehicleId: string }) {
  const { data: vehicle, isLoading: vehicleLoading } = useVehicle(vehicleId)
  const opAuth = getOpAuthState()
  const isAdmin = opAuth?.userRole === 'admin'
  const isManager = hasManagerRole(opAuth?.userRole)
  const queryClient = useQueryClient()

  const saleQuery = useQuery({
    queryKey: ['vehicle-sale', vehicleId],
    queryFn: () => fetchSaleForVehicle(vehicleId),
    enabled: !!vehicleId,
  })

  /** Every write returns the fresh sale — drop it straight into the cache. */
  const applySale = (sale: SaleView | null) => {
    queryClient.setQueryData(['vehicle-sale', vehicleId], sale)
    queryClient.invalidateQueries({ queryKey: ['vehicle-sales', 'open'] })
  }

  if (vehicleLoading || saleQuery.isLoading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 w-40 rounded bg-gray-200" /><div className="h-40 rounded-lg bg-gray-100" /></div>
  }
  if (!vehicle) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
        Vehicle not found. <Link to={vmPath('/vehicles')} className="underline">Back to the fleet</Link>
      </div>
    )
  }

  const sale = saleQuery.data ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to={vmPath(`/vehicles/${vehicle.id}`)} className="text-sm text-ooosh-blue hover:underline">
            {vehicle.reg}
          </Link>
          <h1 className="text-xl font-bold text-ooosh-navy">Sale — {vehicle.reg}</h1>
          <p className="text-xs text-gray-500">{[vehicle.make, vehicle.model].filter(Boolean).join(' ')}</p>
        </div>
        {sale && (
          <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-800">
            For sale · {saleStageLabel(sale.status)}
          </span>
        )}
      </div>

      {saleQuery.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not load the sale.</div>
      )}

      {!sale && !saleQuery.isError && (
        vehicle.isOldSold ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
            This van has already left the fleet.
          </div>
        ) : isAdmin ? (
          <StartSaleForm vehicleId={vehicle.id} onStarted={applySale} />
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
            This van isn't for sale. An admin can start the sales process.
          </div>
        )
      )}

      {sale && (
        <>
          <SaleHeaderCard sale={sale} isAdmin={isAdmin} isManager={isManager} onSaved={applySale} vehicleId={vehicle.id} />
          <RecheckBanner sale={sale} onSaved={applySale} />
          <DescriptionCard sale={sale} onSaved={applySale} />
          <ShareLinksCard sale={sale} isManager={isManager} />
          <KeyFactsCard vehicle={vehicle} />
          <ChosenPhotos sale={sale} onSaved={applySale} />
          <AddPhotos sale={sale} vehicle={vehicle} onSaved={applySale} />
        </>
      )}
    </div>
  )
}

// ── Start ──────────────────────────────────────────────────────────────────

function StartSaleForm({ vehicleId, onStarted }: { vehicleId: string; onStarted: (s: SaleView) => void }) {
  const [price, setPrice] = useState('')
  const [vat, setVat] = useState<VatBasis>('plus')
  const [hold, setHold] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const sale = await startSale({
        vehicleId,
        askingPrice: price.trim() ? Number(price) : null,
        vatBasis: vat,
        holdFromHire: hold || null,
      })
      onStarted(sale)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Start sales process</h3>
      <p className="mt-1 text-xs text-gray-500">
        The van stays active and hireable — it just gets a "For sale" flag. You can change all of this later.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium text-gray-600">
          Asking price (£)
          <input type="number" min="0" step="50" value={price} onChange={e => setPrice(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </label>
        <label className="text-xs font-medium text-gray-600">
          VAT
          <select value={vat} onChange={e => setVat(e.target.value as VatBasis)}
            className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
            <option value="plus">+VAT</option>
            <option value="inc">inc. VAT</option>
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Try not to hire it after
          <input type="date" value={hold} onChange={e => setHold(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <button type="button" onClick={submit} disabled={busy}
        className="mt-3 rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
        {busy ? 'Starting…' : 'Start sales process'}
      </button>
    </div>
  )
}

// ── Header: stage, price, hold date, withdraw / mark sold ──────────────────

function SaleHeaderCard({ sale, isAdmin, isManager, onSaved, vehicleId }: {
  sale: SaleView; isAdmin: boolean; isManager: boolean; onSaved: (s: SaleView | null) => void; vehicleId: string
}) {
  const [editing, setEditing] = useState(false)
  const [price, setPrice] = useState(sale.askingPrice != null ? String(sale.askingPrice) : '')
  const [vat, setVat] = useState<VatBasis>(sale.vatBasis)
  const [hold, setHold] = useState(sale.holdFromHire ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<SaleView | null>) {
    setBusy(true)
    setError(null)
    try {
      onSaved(await fn())
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveFigures() {
    const ok = await run(() => updateSale(sale.id, {
      askingPrice: price.trim() ? Number(price) : null,
      vatBasis: vat,
      holdFromHire: hold || null,
    }))
    if (ok) setEditing(false)
  }

  async function withdraw() {
    const reason = window.prompt(`Withdraw ${sale.reg} from sale? The van stays in the fleet.\n\nReason (optional):`)
    if (reason === null) return
    // A withdrawn sale is closed — the page goes back to "not for sale".
    await run(async () => { await updateSale(sale.id, { status: 'withdrawn', closedReason: reason }); return null })
  }

  const days = daysSince(sale.startedAt)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
        {SALE_STAGES.map(s => (
          <button key={s.value} type="button" disabled={busy || sale.status === s.value}
            onClick={() => run(() => updateSale(sale.id, { status: s.value }))}
            className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
              sale.status === s.value ? 'bg-white text-ooosh-navy shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {!editing ? (
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-gray-400">Asking price</div>
            <div className="font-semibold text-gray-900">
              {fmtMoney(sale.askingPrice)} {sale.askingPrice != null && <span className="text-xs font-normal text-gray-500">{sale.vatBasis === 'plus' ? '+VAT' : 'inc. VAT'}</span>}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Try not to hire it after</div>
            <div className="text-gray-900">{fmtDate(sale.holdFromHire)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400">On sale</div>
            <div className="text-gray-900">
              {days != null ? `${days} day${days === 1 ? '' : 's'}` : '—'}
              {sale.startedByName && <span className="text-xs text-gray-500"> · started by {sale.startedByName}</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-gray-600">
            Asking price (£)
            <input type="number" min="0" step="50" value={price} onChange={e => setPrice(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </label>
          <label className="text-xs font-medium text-gray-600">
            VAT
            <select value={vat} onChange={e => setVat(e.target.value as VatBasis)}
              className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
              <option value="plus">+VAT</option>
              <option value="inc">inc. VAT</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Try not to hire it after
            <input type="date" value={hold} onChange={e => setHold(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </label>
        </div>
      )}

      {sale.bookedBeyondHold && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Booked until {fmtDate(sale.bookedUntil)} — past the "try not to hire it after" date of {fmtDate(sale.holdFromHire)}.
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        {isAdmin && !editing && (
          <button type="button" onClick={() => {
            // Start from the saved figures, not whatever was typed last time.
            setPrice(sale.askingPrice != null ? String(sale.askingPrice) : '')
            setVat(sale.vatBasis)
            setHold(sale.holdFromHire ?? '')
            setEditing(true)
          }}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            Edit price &amp; dates
          </button>
        )}
        {isAdmin && editing && (
          <>
            <button type="button" onClick={saveFigures} disabled={busy}
              className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditing(false)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600">Cancel</button>
          </>
        )}
        <div className="flex-1" />
        {isManager && (
          <Link to={vmPath(`/vehicles/${vehicleId}/settings?sell=1`)}
            className="rounded-lg border border-green-300 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50">
            Mark sold…
          </Link>
        )}
        {isAdmin && (
          <button type="button" onClick={withdraw} disabled={busy}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
            Withdraw from sale
          </button>
        )}
      </div>
    </div>
  )
}

// ── Photo re-check (D6) ────────────────────────────────────────────────────

function RecheckBanner({ sale, onSaved }: { sale: SaleView; onSaved: (s: SaleView) => void }) {
  const [busy, setBusy] = useState(false)
  if (sale.recheck.length === 0) return null

  async function confirm() {
    setBusy(true)
    try {
      onSaved(await confirmSalePhotos(sale.id))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">Check the sale photos</p>
      <p className="mt-0.5 text-xs text-amber-800">
        {sale.recheck.length === 1 ? 'A Problem has' : `${sale.recheck.length} Problems have`} been logged on this van since the photos were chosen.
        If any shows on a photo, swap it for a new one.
      </p>
      <ul className="mt-2 space-y-1">
        {sale.recheck.map(p => (
          <li key={p.id} className="text-xs text-amber-900">
            <a href={`/operations/problems/${p.id}`} className="underline">{p.summary || 'Problem'}</a>
            <span className="text-amber-700"> · {p.reflagged ? 're-flagged' : 'logged'} {fmtDate(p.when)}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={confirm} disabled={busy}
        className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50">
        {busy ? 'Saving…' : 'Photos still OK'}
      </button>
    </div>
  )
}

// ── Description ────────────────────────────────────────────────────────────

function DescriptionCard({ sale, onSaved }: { sale: SaleView; onSaved: (s: SaleView) => void }) {
  const [text, setText] = useState(sale.description ?? '')
  const [busy, setBusy] = useState(false)
  const dirty = text !== (sale.description ?? '')

  async function save() {
    setBusy(true)
    try {
      onSaved(await updateSale(sale.id, { description: text }))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Description</h3>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
        placeholder="What a buyer should know — spec, condition, extras…"
        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
      {dirty && (
        <button type="button" onClick={save} disabled={busy}
          className="mt-2 rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save description'}
        </button>
      )}
    </div>
  )
}

// ── Key facts (live) ───────────────────────────────────────────────────────

function KeyFactsCard({ vehicle }: { vehicle: Vehicle }) {
  const rows: Array<[string, string]> = [
    ['Make / model', [vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'],
    ['Colour', vehicle.colour || '—'],
    ['Seats', vehicle.seats != null ? String(vehicle.seats) : '—'],
    ['First registered', fmtDate(vehicle.dateFirstReg)],
    ['Fuel', vehicle.fuelType || '—'],
    ['Gearbox', vehicle.gearbox === 'auto' ? 'Automatic' : vehicle.gearbox === 'manual' ? 'Manual' : '—'],
    ['Mileage', vehicle.currentMileage != null ? `${vehicle.currentMileage.toLocaleString('en-GB')} mi` : '—'],
    ['MOT due', fmtDate(vehicle.motDue)],
    ['Tax due', fmtDate(vehicle.taxDue)],
    ['Last service', fmtDate(vehicle.lastServiceDate)],
  ]
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Key facts</h3>
        <span className="text-[11px] text-gray-400">Live from the vehicle record</span>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-gray-100 py-1 text-sm">
            <dt className="text-gray-500">{k}</dt>
            <dd className="text-right text-gray-900">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-gray-400">
        Service and MOT history are on the van's{' '}
        <Link to={vmPath(`/vehicles/${vehicle.id}?tab=service`)} className="underline">History tab</Link>.
      </p>
    </div>
  )
}

// ── Chosen photos ──────────────────────────────────────────────────────────

function ChosenPhotos({ sale, onSaved }: { sale: SaleView; onSaved: (s: SaleView) => void }) {
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<SaleView>) {
    setBusy(true)
    try {
      onSaved(await fn())
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function move(index: number, delta: number) {
    const ids = sale.photos.map(p => p.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void run(() => reorderSalePhotos(sale.id, ids))
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Sale photos ({sale.photos.length})</h3>
        {sale.photosConfirmedAt && (
          <span className="text-[11px] text-gray-400">Checked {fmtDate(sale.photosConfirmedAt)}</span>
        )}
      </div>
      {sale.photos.length === 0 ? (
        <p className="text-sm text-gray-500">No photos yet — pick some from recent book-outs below, or take new ones.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {sale.photos.map((p, i) => (
            <div key={p.id} className="rounded border border-gray-200 p-1.5">
              <img src={salePhotoUrl(p.r2Key)} alt={p.label ?? 'Sale photo'} loading="lazy"
                className="aspect-[4/3] w-full rounded object-cover" />
              <input
                defaultValue={p.label ?? ''}
                placeholder="Label"
                onBlur={e => {
                  const v = e.target.value.trim()
                  if (v !== (p.label ?? '')) void run(() => labelSalePhoto(sale.id, p.id, v || null))
                }}
                className="mt-1 w-full rounded border border-gray-200 px-1.5 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
              />
              {isDashboardShot(p.label) && (
                <p className="mt-0.5 text-[10px] text-amber-700">Shows the mileage on the day it was taken.</p>
              )}
              <div className="mt-1 flex gap-1">
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)}
                  className="rounded border border-gray-200 px-1.5 text-xs text-gray-600 disabled:opacity-30" aria-label="Move earlier">←</button>
                <button type="button" disabled={busy || i === sale.photos.length - 1} onClick={() => move(i, 1)}
                  className="rounded border border-gray-200 px-1.5 text-xs text-gray-600 disabled:opacity-30" aria-label="Move later">→</button>
                <div className="flex-1" />
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm('Remove this photo from the sale?')) void run(() => removeSalePhoto(sale.id, p.id)) }}
                  className="rounded border border-red-200 px-1.5 text-xs text-red-600 disabled:opacity-30">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Adding photos: recent book-outs / check-ins, or new ones ───────────────

const PICKER_EVENT_TYPES = new Set(['Book Out', 'Check In'])

function AddPhotos({ sale, vehicle, onSaved }: { sale: SaleView; vehicle: Vehicle; onSaved: (s: SaleView) => void }) {
  const [shown, setShown] = useState(3)
  const [uploading, setUploading] = useState<string | null>(null)

  const eventsQuery = useQuery({
    queryKey: ['vehicle-events', vehicle.reg],
    queryFn: () => fetchVehicleEvents(vehicle.reg),
    enabled: !!vehicle.reg,
  })

  const events = useMemo(() => {
    const list = (eventsQuery.data ?? []).filter(e => PICKER_EVENT_TYPES.has(e.eventType))
    return list.sort((a, b) => (b.eventDate || b.createdAt || '').localeCompare(a.eventDate || a.createdAt || ''))
  }, [eventsQuery.data])

  const chosenKeys = useMemo(() => new Set(sale.photos.map(p => p.r2Key)), [sale.photos])

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    // Capture the files BEFORE resetting the input (frontend.md, file inputs).
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    // One at a time — keep one decoded image in memory (vehicles-bookout.md).
    for (let i = 0; i < files.length; i++) {
      setUploading(`Uploading ${i + 1} of ${files.length}…`)
      try {
        const prepared = await prepareImage(files[i])
        onSaved(await uploadSalePhoto(sale.id, prepared.blob, prepared.filename, null))
      } catch (err) {
        alert(`${files[i].name}: ${(err as Error).message}`)
      }
    }
    setUploading(null)
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Add photos</h3>
        <label className={`cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
          {uploading ?? 'Take / upload new photos'}
          <input type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
        </label>
      </div>

      {eventsQuery.isLoading && <p className="text-sm text-gray-400">Loading recent book-outs…</p>}
      {!eventsQuery.isLoading && events.length === 0 && (
        <p className="text-sm text-gray-500">No book-out or check-in photos on record for this van.</p>
      )}

      {events.slice(0, shown).map((ev, i) => (
        <EventPhotoPicker key={ev.id} event={ev} reg={vehicle.reg} saleId={sale.id}
          chosenKeys={chosenKeys} defaultOpen={i === 0} onSaved={onSaved} />
      ))}

      {events.length > shown && (
        <button type="button" onClick={() => setShown(n => n + 3)}
          className="text-xs font-medium text-ooosh-blue hover:underline">
          Load older ({events.length - shown} more)
        </button>
      )}
    </div>
  )
}

interface ListedPhoto { angle: string; key: string }

function EventPhotoPicker({ event, reg, saleId, chosenKeys, defaultOpen, onSaved }: {
  event: EventIndexEntry; reg: string; saleId: string; chosenKeys: Set<string>; defaultOpen: boolean
  onSaved: (s: SaleView) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const prefix = `events/${event.id}/${reg.replace(/\s+/g, '-').toUpperCase()}/`

  // Only list (and so only download thumbnails) once the event is opened.
  const photosQuery = useQuery({
    queryKey: ['event-photos', prefix],
    queryFn: async () => {
      const resp = await apiFetch(`/list-photos?prefix=${encodeURIComponent(prefix)}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as { photos: ListedPhoto[] }
      return data.photos || []
    },
    enabled: open,
  })

  function toggle(key: string) {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function labelFor(p: ListedPhoto): string {
    return p.key.includes('/damage/') ? 'Damage detail' : prettifyAngle(p.angle)
  }

  async function addPicked() {
    const photos = (photosQuery.data ?? [])
      .filter(p => picked.has(p.key))
      .map(p => ({ r2Key: p.key, sourceEventId: event.id, label: labelFor(p) }))
    if (photos.length === 0) return
    setBusy(true)
    try {
      onSaved(await addEventPhotos(saleId, photos))
      setPicked(new Set())
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-gray-200">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50">
        <span>
          <span className="font-medium text-gray-900">{event.eventType}</span>
          <span className="text-gray-500"> · {fmtDate(event.eventDate || event.createdAt)}</span>
          {event.mileage != null && <span className="text-gray-400"> · {event.mileage.toLocaleString('en-GB')} mi</span>}
        </span>
        <span className="text-xs text-gray-400">{open ? 'Hide' : 'Show photos'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-3">
          {photosQuery.isLoading && <p className="text-xs text-gray-400">Loading photos…</p>}
          {photosQuery.isError && <p className="text-xs text-red-600">Could not list photos for this event.</p>}
          {photosQuery.data && photosQuery.data.length === 0 && <p className="text-xs text-gray-500">No photos on this event.</p>}
          {photosQuery.data && photosQuery.data.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photosQuery.data.map(p => {
                  const already = chosenKeys.has(p.key)
                  const isPicked = picked.has(p.key)
                  return (
                    <button key={p.key} type="button" disabled={already} onClick={() => toggle(p.key)}
                      className={`relative overflow-hidden rounded border-2 text-left ${
                        already ? 'border-green-400 opacity-60' : isPicked ? 'border-ooosh-blue' : 'border-transparent'
                      }`}>
                      <img src={salePhotoUrl(p.key)} alt={labelFor(p)} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                      <span className="block truncate bg-white px-1 text-[10px] text-gray-600">{labelFor(p)}</span>
                      {isDashboardShot(p.angle) && !already && (
                        <span className="absolute left-1 top-1 rounded bg-amber-100 px-1 text-[9px] text-amber-800">old mileage</span>
                      )}
                      {already && <span className="absolute right-1 top-1 rounded bg-green-600 px-1 text-[9px] text-white">Added</span>}
                      {isPicked && <span className="absolute right-1 top-1 rounded bg-ooosh-blue px-1 text-[9px] text-white">✓</span>}
                    </button>
                  )
                })}
              </div>
              <button type="button" onClick={addPicked} disabled={busy || picked.size === 0}
                className="mt-2 rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                {busy ? 'Adding…' : `Add ${picked.size || ''} photo${picked.size === 1 ? '' : 's'} to the sale`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Share links (Phase 2, §6) ──────────────────────────────────────────────

function ShareLinksCard({ sale, isManager }: { sale: SaleView; isManager: boolean }) {
  const queryClient = useQueryClient()
  const linksKey = ['sale-links', sale.id]
  const { data: links, isLoading } = useQuery({ queryKey: linksKey, queryFn: () => fetchSaleLinks(sale.id) })
  const [name, setName] = useState('')
  const [switches, setSwitches] = useState<LinkSwitches>(DEFAULT_LINK_SWITCHES)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)

  async function run(fn: () => Promise<SaleLink[]>) {
    setBusy(true)
    setError(null)
    try {
      queryClient.setQueryData(linksKey, await fn())
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    if (!name.trim()) { setError('Who is this link for?'); return }
    if (await run(() => createSaleLink(sale.id, name.trim(), switches))) {
      setName('')
      setSwitches(DEFAULT_LINK_SWITCHES)
    }
  }

  async function copy(link: SaleLink) {
    const url = saleLinkUrl(link.token)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(link.id)
      setTimeout(() => setCopied(c => (c === link.id ? null : c)), 2000)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  const live = (links ?? []).filter(l => !l.revokedAt)
  const revoked = (links ?? []).filter(l => l.revokedAt)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Share links</h3>
        <p className="text-xs text-gray-500">
          One link per buyer. Each shows the photos, description and vehicle details, plus whichever
          extras you tick. Details stay live; the link stops working if you revoke it or the sale ends.
        </p>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading links…</p>}
      {live.length === 0 && !isLoading && <p className="text-sm text-gray-500">No links yet.</p>}

      {live.map(link => (
        <div key={link.id} className="rounded border border-gray-200 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-900">{link.recipientName}</p>
              <p className="text-[11px] text-gray-500">
                Made {fmtDate(link.createdAt)}{link.createdByName ? ` by ${link.createdByName}` : ''} ·{' '}
                {link.viewCount > 0
                  ? `opened ${link.viewCount}× · last ${fmtDate(link.lastViewedAt)}`
                  : 'not opened yet'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => copy(link)}
                className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
                {copied === link.id ? 'Copied ✓' : 'Copy link'}
              </button>
              <a href={`${saleLinkUrl(link.token)}?preview=1`} target="_blank" rel="noreferrer"
                className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Preview
              </a>
              <button type="button" disabled={busy}
                onClick={() => {
                  if (window.confirm(`Revoke the link for ${link.recipientName}? It will stop working straight away.`)) {
                    void run(() => revokeSaleLink(sale.id, link.id))
                  }
                }}
                className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                Revoke
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LINK_SWITCH_LABELS.map(({ key, label }) => (
              <button key={key} type="button" disabled={busy}
                onClick={() => void run(() => updateSaleLink(sale.id, link.id, { [key]: !link[key] }))}
                title={link[key] ? `Showing — click to hide from ${link.recipientName}` : `Hidden — click to show ${link.recipientName}`}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${
                  link[key] ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-400 line-through'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="rounded border border-dashed border-gray-300 p-3">
        <p className="mb-2 text-xs font-medium text-gray-600">New link</p>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Who is it for? e.g. Van Monster, Dave (client)"
          className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {LINK_SWITCH_LABELS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={switches[key]}
                onChange={e => setSwitches(sw => ({ ...sw, [key]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
        {!switches.showDamageHistory && (
          <p className="mt-1 text-[11px] text-amber-700">
            Damage history hidden — fine for a dealer, but a private buyer should normally see it.
          </p>
        )}
        <button type="button" onClick={create} disabled={busy}
          className="mt-2 rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Create link'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <p className="text-[11px] text-gray-400">
        Damage history shows each Problem's summary exactly as it was written — check the preview before sending.
      </p>

      {revoked.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowRevoked(v => !v)} className="text-xs text-gray-500 hover:underline">
            {showRevoked ? 'Hide' : 'Show'} revoked links ({revoked.length})
          </button>
          {showRevoked && (
            <ul className="mt-1 space-y-0.5">
              {revoked.map(l => (
                <li key={l.id} className="text-xs text-gray-400">
                  {l.recipientName} — revoked {fmtDate(l.revokedAt)} · opened {l.viewCount}×
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SalesContactLine canEdit={isManager} />
    </div>
  )
}

/** Q7 — the contact shown at the foot of every sale page, for every van. */
function SalesContactLine({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient()
  const { data: contact } = useQuery({ queryKey: ['vehicle-sales-contact'], queryFn: fetchSalesContact })
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await saveSalesContact(text)
      queryClient.setQueryData(['vehicle-sales-contact'], text.trim())
      setEditing(false)
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-gray-100 pt-2 text-xs">
      <span className="text-gray-500">Contact shown to buyers (all vans): </span>
      {!editing ? (
        <>
          <span className={contact ? 'whitespace-pre-line text-gray-800' : 'text-amber-700'}>
            {contact || 'none set — buyers won\'t see who to call'}
          </span>
          {canEdit && (
            <button type="button" onClick={() => { setText(contact ?? ''); setEditing(true) }}
              className="ml-2 text-ooosh-blue hover:underline">Edit</button>
          )}
        </>
      ) : (
        <div className="mt-1 space-y-1">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            placeholder="e.g. name · phone · email"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none" />
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy}
              className="rounded bg-ooosh-navy px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditing(false)}
              className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

