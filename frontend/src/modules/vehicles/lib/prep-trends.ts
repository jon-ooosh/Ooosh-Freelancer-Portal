/**
 * Prep trends — per-corner tyre wear analysis + projection from prep history.
 *
 * Pure functions only. Takes the prep `sessions[]` array the history endpoint
 * already returns (newest-first) and produces a per-corner picture: current
 * tread, wear rate, and a forward projection to *actionable* thresholds —
 * 5mm (plan replacement) and 4mm (replace now), NOT the 1.6mm legal limit
 * (jon's call: we act long before legal, so projecting to legal is useless).
 *
 * Front and rear corners are computed independently — each from its OWN reading
 * history — so the natural "fronts wear slower than rears" difference falls out
 * of the data rather than being hard-coded. Display groups by axle.
 *
 * Tyre replacement is detected as a tread JUMP UP between consecutive preps
 * (a worn tyre can't gain depth), which resets the wear-rate baseline so a
 * fresh tyre doesn't inherit the old one's projection.
 *
 * Service-record cross-referencing is deliberately out of scope (Tier 3) —
 * prep forms are the only data source here.
 */

import type { PrepHistorySession } from './prep-history'
import { TYRE_TREAD_CAP_MM, TYRE_TREAD_RED_MM, TYRE_TREAD_AMBER_MM } from './tyre-sanity'

/** A jump UP of more than this between consecutive preps = a new/swapped tyre. */
const TREAD_RESET_JUMP_MM = 1.5

export type Corner = 'FL' | 'FR' | 'RL' | 'RR'
export type Axle = 'front' | 'rear'

const CORNER_AXLE: Record<Corner, Axle> = { FL: 'front', FR: 'front', RL: 'rear', RR: 'rear' }
const CORNER_LABEL: Record<Corner, string> = {
  FL: 'Front left', FR: 'Front right', RL: 'Rear left', RR: 'Rear right',
}

export interface TreadPoint {
  date: string
  mileage: number | null
  tread: number // normalised mm
  /** First point of a new-tyre segment (a reset was detected at this point). */
  isReset: boolean
}

export interface Projection {
  /** Miles still to run from current reading before hitting the threshold. */
  milesRemaining: number
  /** Absolute mileage at which the threshold is reached (current + remaining). */
  reachedAtMileage: number | null
  /** Estimated calendar date, ISO yyyy-mm-dd, from the vehicle's miles/day pace. */
  estimatedDate: string | null
}

export interface CornerTrend {
  corner: Corner
  axle: Axle
  label: string
  /** Chronological (oldest→newest) normalised tread points with a reading. */
  points: TreadPoint[]
  currentTread: number | null
  currentMileage: number | null
  /** mm of tread lost per mile across the current segment (>0 = wearing). */
  wearRatePerMile: number | null
  /** Number of tyre changes detected across the whole history. */
  resetCount: number
  lastResetDate: string | null
  /** Points contributing to the current wear-rate segment. */
  segmentPoints: number
  projectionTo5mm: Projection | null
  projectionTo4mm: Projection | null
  /** Colour band of the CURRENT tread vs the 5/4mm thresholds. */
  status: 'red' | 'amber' | 'green' | 'unknown'
}

export interface PrepTrends {
  corners: CornerTrend[]
  /** Vehicle-wide pace used for date projections (miles per day). */
  milesPerDay: number | null
  /** True if there's enough data (>=2 preps with tread) to say anything useful. */
  hasData: boolean
}

/** Historical preps stored tread ×10 ("82" = 8.2mm). Divide legacy figures down. */
function normaliseTread(value: number): number {
  return value > TYRE_TREAD_CAP_MM ? value / 10 : value
}

/** Parse a possibly-dirty tread string ("8.2", "8.2mm", "8") to a number, or null. */
function parseTread(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const num = Number(String(raw).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(num) || num <= 0) return null
  return normaliseTread(num)
}

function parseMileage(value: number | null | undefined): number | null {
  if (value == null) return null
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/** Find a corner's tread reading in one session via the prep item names. */
function readCornerTread(session: PrepHistorySession, corner: Corner): number | null {
  // Match the same item names the history grid uses ("Front left tyre tread depth").
  const names: Record<Corner, string[]> = {
    FL: ['front left tyre tread', 'fl tread', 'front left tread'],
    FR: ['front right tyre tread', 'fr tread', 'front right tread'],
    RL: ['rear left tyre tread', 'rl tread', 'rear left tread'],
    RR: ['rear right tyre tread', 'rr tread', 'rear right tread'],
  }
  const wanted = names[corner]
  for (const sec of session.sections || []) {
    for (const item of sec.items || []) {
      const n = item.name.toLowerCase()
      if (wanted.some(w => n.includes(w))) {
        return parseTread(item.value || item.detail)
      }
    }
  }
  return null
}

/**
 * Least-squares slope of tread (mm) against mileage. Returns mm lost per mile
 * (positive when wearing down). Needs >=2 points with distinct mileages.
 */
function wearRate(points: TreadPoint[]): number | null {
  const usable = points.filter(p => p.mileage != null)
  if (usable.length < 2) return null
  const n = usable.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of usable) {
    const x = p.mileage as number
    const y = p.tread
    sx += x; sy += y; sxx += x * x; sxy += x * y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom // mm per mile (negative as miles rise)
  const loss = -slope // flip so positive = wearing down
  return loss > 0 ? loss : null // not measurably wearing → no usable rate
}

function projectTo(
  threshold: number,
  currentTread: number | null,
  currentMileage: number | null,
  ratePerMile: number | null,
  milesPerDay: number | null,
): Projection | null {
  if (currentTread == null || ratePerMile == null || ratePerMile <= 0) return null
  if (currentTread <= threshold) {
    // Already at/below the threshold.
    return {
      milesRemaining: 0,
      reachedAtMileage: currentMileage,
      estimatedDate: new Date().toISOString().slice(0, 10),
    }
  }
  const milesRemaining = Math.round((currentTread - threshold) / ratePerMile)
  const reachedAtMileage = currentMileage != null ? currentMileage + milesRemaining : null
  let estimatedDate: string | null = null
  if (milesPerDay != null && milesPerDay > 0 && Number.isFinite(milesRemaining)) {
    const days = Math.round(milesRemaining / milesPerDay)
    // Guard against absurd projections (tiny wear rate → millions of days) that
    // overflow the JS Date and make toISOString() throw "Invalid time value".
    if (days >= 0 && days < 36500) {
      const d = new Date()
      d.setDate(d.getDate() + days)
      if (!Number.isNaN(d.getTime())) estimatedDate = d.toISOString().slice(0, 10)
    }
  }
  return { milesRemaining, reachedAtMileage, estimatedDate }
}

function bandFor(tread: number | null): CornerTrend['status'] {
  if (tread == null) return 'unknown'
  if (tread <= TYRE_TREAD_RED_MM) return 'red'
  if (tread <= TYRE_TREAD_AMBER_MM) return 'amber'
  return 'green'
}

/** Build the full per-corner trend picture from the prep sessions (newest-first). */
export function computePrepTrends(sessions: PrepHistorySession[]): PrepTrends {
  // Work chronologically (oldest → newest).
  const ordered = [...(sessions || [])].reverse()

  // Vehicle-wide pace from the mileage series (first vs last with a reading + date).
  const milePts = ordered
    .map(s => ({ date: s.date, mileage: parseMileage(s.mileage) }))
    .filter(p => p.mileage != null) as { date: string; mileage: number }[]
  let milesPerDay: number | null = null
  if (milePts.length >= 2) {
    const first = milePts[0]!
    const last = milePts[milePts.length - 1]!
    const days = (new Date(last.date).getTime() - new Date(first.date).getTime()) / 86400000
    const miles = last.mileage - first.mileage
    if (days > 0 && miles > 0) milesPerDay = miles / days
  }

  const corners = (['FL', 'FR', 'RL', 'RR'] as Corner[]).map((corner): CornerTrend => {
    // Build chronological tread points (with the session's mileage attached).
    const allPoints: TreadPoint[] = []
    for (const s of ordered) {
      const tread = readCornerTread(s, corner)
      if (tread == null) continue
      allPoints.push({ date: s.date, mileage: parseMileage(s.mileage), tread, isReset: false })
    }

    // Detect tyre changes (tread jumps UP) and mark segment boundaries.
    let resetCount = 0
    let lastResetDate: string | null = null
    let segmentStart = 0
    for (let i = 1; i < allPoints.length; i++) {
      if (allPoints[i]!.tread - allPoints[i - 1]!.tread > TREAD_RESET_JUMP_MM) {
        allPoints[i]!.isReset = true
        resetCount++
        lastResetDate = allPoints[i]!.date
        segmentStart = i
      }
    }

    const segment = allPoints.slice(segmentStart)
    const latest = allPoints.length ? allPoints[allPoints.length - 1]! : null
    const currentTread = latest?.tread ?? null
    const currentMileage = latest?.mileage ?? null
    const rate = wearRate(segment)

    return {
      corner,
      axle: CORNER_AXLE[corner],
      label: CORNER_LABEL[corner],
      points: allPoints,
      currentTread,
      currentMileage,
      wearRatePerMile: rate,
      resetCount,
      lastResetDate,
      segmentPoints: segment.length,
      projectionTo5mm: projectTo(TYRE_TREAD_AMBER_MM, currentTread, currentMileage, rate, milesPerDay),
      projectionTo4mm: projectTo(TYRE_TREAD_RED_MM, currentTread, currentMileage, rate, milesPerDay),
      status: bandFor(currentTread),
    }
  })

  const hasData = corners.some(c => c.points.length >= 2)
  return { corners, milesPerDay, hasData }
}

/** Convenience: wear rate expressed per 1,000 miles for display. */
export function ratePer1000(rate: number | null): number | null {
  return rate == null ? null : Math.round(rate * 1000 * 100) / 100
}
