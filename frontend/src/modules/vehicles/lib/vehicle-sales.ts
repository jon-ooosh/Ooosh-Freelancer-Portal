/**
 * Client wrapper for /api/vehicle-sales (docs/VEHICLE-SALES-SPEC.md).
 *
 * Mirrors backend/src/services/vehicle-sales.ts (THE definition) — every rule
 * (who may change what, which photos are allowed) is enforced there; the UI
 * only hides what a role can't do.
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../config/api-config'
import { getOpAuthState } from '../adapters/auth-adapter'

export type OpenSaleStatus = 'preparing' | 'listed' | 'under_offer'
export type SaleStatus = OpenSaleStatus | 'sold' | 'withdrawn'
export type VatBasis = 'plus' | 'inc'

export const SALE_STAGES: Array<{ value: OpenSaleStatus; label: string }> = [
  { value: 'preparing', label: 'Preparing' },
  { value: 'listed', label: 'Listed' },
  { value: 'under_offer', label: 'Under offer' },
]

export function saleStageLabel(status: SaleStatus): string {
  if (status === 'sold') return 'Sold'
  if (status === 'withdrawn') return 'Withdrawn'
  return SALE_STAGES.find(s => s.value === status)?.label ?? status
}

export interface SalePhoto {
  id: string
  r2Key: string
  source: 'event' | 'upload'
  sourceEventId: string | null
  label: string | null
  sortOrder: number
}

export interface RecheckProblem {
  id: string
  summary: string
  category: string | null
  status: string
  when: string
  reflagged: boolean
}

export interface SaleView {
  id: string
  vehicleId: string
  reg: string
  status: SaleStatus
  askingPrice: number | null
  vatBasis: VatBasis
  description: string | null
  holdFromHire: string | null
  photosConfirmedAt: string | null
  startedBy: string | null
  startedByName: string | null
  startedAt: string
  closedAt: string | null
  closedReason: string | null
  photos: SalePhoto[]
  recheck: RecheckProblem[]
  bookedUntil: string | null
  bookedBeyondHold: boolean
}

export interface OpenSaleSummary {
  id: string
  vehicleId: string
  reg: string
  status: OpenSaleStatus
  holdFromHire: string | null
  bookedUntil: string | null
  bookedBeyondHold: boolean
}

const BASE = '/api/vehicle-sales'

async function readJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const body = await resp.json() as { data: T }
  return body.data
}

function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return apiFetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(r => readJson<T>(r))
}

export const fetchOpenSales = () => apiFetch(`${BASE}/open`).then(r => readJson<OpenSaleSummary[]>(r))
export const fetchSaleForVehicle = (vehicleId: string) =>
  apiFetch(`${BASE}/by-vehicle/${vehicleId}`).then(r => readJson<SaleView | null>(r))

export const startSale = (input: { vehicleId: string; askingPrice: number | null; vatBasis: VatBasis; holdFromHire: string | null }) =>
  send<SaleView>('', 'POST', input)

export const updateSale = (saleId: string, patch: Partial<{
  status: SaleStatus; description: string | null; askingPrice: number | null
  vatBasis: VatBasis; holdFromHire: string | null; closedReason: string
}>) => send<SaleView>(`/${saleId}`, 'PATCH', patch)

export const addEventPhotos = (saleId: string, photos: Array<{ r2Key: string; sourceEventId: string; label: string | null }>) =>
  send<SaleView>(`/${saleId}/photos`, 'POST', { photos })

export const confirmSalePhotos = (saleId: string) => send<SaleView>(`/${saleId}/photos/confirm`, 'POST', {})
export const reorderSalePhotos = (saleId: string, ids: string[]) => send<SaleView>(`/${saleId}/photos/order`, 'PUT', { ids })
export const labelSalePhoto = (saleId: string, photoId: string, label: string | null) =>
  send<SaleView>(`/${saleId}/photos/${photoId}`, 'PATCH', { label })
export const removeSalePhoto = (saleId: string, photoId: string) => send<SaleView>(`/${saleId}/photos/${photoId}`, 'DELETE')

export async function uploadSalePhoto(saleId: string, file: Blob, filename: string, label: string | null): Promise<SaleView> {
  const form = new FormData()
  form.append('file', file, filename)
  if (label) form.append('label', label)
  const resp = await apiFetch(`${BASE}/${saleId}/photos/upload`, { method: 'POST', body: form })
  return readJson<SaleView>(resp)
}

/** Public-bucket display URL for a sale photo (book-out or uploaded). */
const R2_PUBLIC_URL = (import.meta.env.VITE_R2_PUBLIC_URL as string | undefined) || ''
export function salePhotoUrl(r2Key: string): string {
  return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : `/api/vehicles/photo/${encodeURIComponent(r2Key)}`
}

/**
 * Every open sale, keyed by vehicle id — for the "For sale" pills on the fleet
 * board, Allocations and Book-out. One small request, shared via the cache.
 *
 * Never runs in a FREELANCER session (Book-out is freelancer-reachable): the
 * route is staff-only, and a refused call would send apiFetch off to refresh
 * the token. No pill for freelancers — it's a staff planning aid.
 */
export function useOpenSalesByVehicle(): Map<string, OpenSaleSummary> {
  const isFreelancer = getOpAuthState()?.scope === 'freelancer'
  const { data } = useQuery({
    queryKey: ['vehicle-sales', 'open'],
    queryFn: fetchOpenSales,
    staleTime: 60 * 1000,
    enabled: !isFreelancer,
  })
  const map = new Map<string, OpenSaleSummary>()
  for (const s of data ?? []) map.set(s.vehicleId, s)
  return map
}

// ── Share links (Phase 2) ──────────────────────────────────────────────────

export interface LinkSwitches {
  showPrice: boolean
  showServiceHistory: boolean
  showMotHistory: boolean
  showMileageHistory: boolean
  showDamageHistory: boolean
}

/** Same defaults as the backend (§6.2) — damage ON, mileage OFF. */
export const DEFAULT_LINK_SWITCHES: LinkSwitches = {
  showPrice: true,
  showServiceHistory: true,
  showMotHistory: true,
  showMileageHistory: false,
  showDamageHistory: true,
}

export const LINK_SWITCH_LABELS: Array<{ key: keyof LinkSwitches; label: string }> = [
  { key: 'showPrice', label: 'Price' },
  { key: 'showServiceHistory', label: 'Service history' },
  { key: 'showMotHistory', label: 'MOT history' },
  { key: 'showMileageHistory', label: 'Mileage history' },
  { key: 'showDamageHistory', label: 'Damage history' },
]

export interface SaleLink extends LinkSwitches {
  id: string
  token: string
  recipientName: string
  createdAt: string
  createdByName: string | null
  revokedAt: string | null
  viewCount: number
  lastViewedAt: string | null
}

export const fetchSaleLinks = (saleId: string) =>
  apiFetch(`${BASE}/${saleId}/links`).then(r => readJson<SaleLink[]>(r))
export const createSaleLink = (saleId: string, recipientName: string, switches: LinkSwitches) =>
  send<SaleLink[]>(`/${saleId}/links`, 'POST', { recipientName, switches })
export const updateSaleLink = (saleId: string, linkId: string, switches: Partial<LinkSwitches>) =>
  send<SaleLink[]>(`/${saleId}/links/${linkId}`, 'PATCH', { switches })
export const revokeSaleLink = (saleId: string, linkId: string) =>
  send<SaleLink[]>(`/${saleId}/links/${linkId}`, 'DELETE')

/** The buyer's URL — the public page lives in the main app, outside /vehicles. */
export function saleLinkUrl(token: string): string {
  return `${window.location.origin}/van/${token}`
}

/** Q7 — the contact line on every sale page (system_settings, admin/manager to edit). */
export async function fetchSalesContact(): Promise<string> {
  const resp = await apiFetch('/api/system-settings?category=vehicle_sales')
  if (!resp.ok) return ''
  const body = await resp.json() as { data?: Array<{ key: string; value: string | null }> }
  return body.data?.find(s => s.key === 'vehicle_sales_contact')?.value ?? ''
}

export async function saveSalesContact(value: string): Promise<void> {
  const resp = await apiFetch('/api/system-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { vehicle_sales_contact: value.trim() || null } }),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
}
