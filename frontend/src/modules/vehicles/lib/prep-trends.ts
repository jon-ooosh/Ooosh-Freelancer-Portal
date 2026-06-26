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
 * Tyre replacement is detected two ways, both of which reset the wear-rate
 * baseline so a fresh tyre doesn't inherit the old one's projection:
 *   1. a tread JUMP UP between consecutive preps (a worn tyre can't gain depth)
 *   2. a service record that fitted new tyres (passed in as `tyreEvents`, derived
 *      + classified server-side so the panel and the AI narrator agree)
 *
 * When a replacement is newer than the latest tread reading, the current reading
 * is the OLD tyre, so the corner reports "awaiting reading" rather than showing a
 * stale low figure as if the new tyre were already worn.
 */

import type { PrepHistorySession } from './prep-history'
import { TYRE_TREAD_CAP_MM, TYRE_TREAD_RED_MM, TYRE_TREAD_AMBER_MM } from './tyre-sanity'

/** A jump UP of more than this between consecutive preps = a new/swapped tyre. */
const TREAD_RESET_JUMP_MM = 1.5

/**
 * Minimum wear rate (mm lost per mile) we treat as a real, measurable signal.
 * 0.05 mm per 1,000 miles. Below this the least-squares slope is indistinguishable
 * from measurement noise on near-flat tread readings — a tyre with effectively no
 * wear would otherwise "read" a rate of ~0.000001 mm/mile (which rounds to "0 mm /
 * 1,000 mi" on screen) yet still divide into a projection of hundreds of thousands
 * of miles: the trillion-mile "to the sun and back" bug. Below the floor we report
 * no usable rate, so the wear rate shows "not enough data" and projections show "—".
 */
const MIN_WEAR_RATE_PER_MILE = 0.00005

/** Cap on how far ahead we'll project. Beyond this it's noise, not a forecast. */
const MAX_PROJECTION_MILES = 150_000

export type Corner = 'FL' | 'FR' | 'RL' | 'RR'
export type Axle = 'front' | 'rear'

/** A tyre replacement detected in a service record (classified server-side). */
export interface TyreServiceEvent {
  date: string | null
  mileage: number | null
  corners: Corner[]
  description: string
}

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
  /** Where the most recent reset came from — a tread jump ('prep') or a service record. */
  lastResetSource: 'prep' | 'service' | null
  /** A replacement was logged AFTER the latest reading — current reading is the old tyre. */
  awaitingReadingAfterChange: boolean
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
  return loss >= MIN_WEAR_RATE_PER_MILE ? loss : null // below the noise floor → no usable rate
}

function projectTo(
  threshold: number,
  currentTread: number | null,
  currentMileage: number | null,
  ratePerMile: number | null,
  milesPerDay: number | null,
): Projection | null {
  if (currentTread == null || ratePerMile == null || ratePerMile < MIN_WEAR_RATE_PER_MILE) return null
  if (currentTread <= threshold) {
    // Already at/below the threshold.
    return {
      milesRemaining: 0,
      reachedAtMileage: currentMileage,
      estimatedDate: new Date().toISOString().slice(0, 10),
    }
  }
  const milesRemaining = Math.round((currentTread - threshold) / ratePerMile)
  // Defence-in-depth: a wear rate that scrapes past the floor on a near-flat
  // series can still yield an implausibly distant date. Beyond this horizon the
  // projection isn't a useful planning signal — show "—" rather than a number.
  if (milesRemaining > MAX_PROJECTION_MILES) return null
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
export function computePrepTrends(
  sessions: PrepHistorySession[],
  tyreEvents: TyreServiceEvent[] = [],
): PrepTrends {
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

    // Reset boundaries: a new tyre resets the wear baseline. Two sources — a tread
    // JUMP UP between preps, or a service record that fitted new tyres on this corner.
    const resetSource = new Map<number, 'prep' | 'service'>()
    for (let i = 1; i < allPoints.length; i++) {
      if (allPoints[i]!.tread - allPoints[i - 1]!.tread > TREAD_RESET_JUMP_MM) resetSource.set(i, 'prep')
    }
    let changedAfter = false
    for (const e of tyreEvents.filter(ev => ev.corners.includes(corner))) {
      let idx = -1
      for (let i = 0; i < allPoints.length; i++) {
        const p = allPoints[i]!
        const byMileage = e.mileage != null && p.mileage != null && p.mileage >= e.mileage
        const byDate = e.mileage == null && e.date != null && p.date >= e.date
        if (byMileage || byDate) { idx = i; break }
      }
      if (idx >= 0) { if (!resetSource.has(idx)) resetSource.set(idx, 'service') }
      else if (allPoints.length > 0) changedAfter = true // tyre fitted since the last reading
    }
    for (const i of resetSource.keys()) allPoints[i]!.isReset = true

    const resetIdxs = [...resetSource.keys()].sort((a, b) => a - b)
    const segmentStart = resetIdxs.length ? resetIdxs[resetIdxs.length - 1]! : 0
    const resetCount = resetSource.size + (changedAfter ? 1 : 0)
    let lastResetDate: string | null = null
    let lastResetSource: 'prep' | 'service' | null = null
    if (changedAfter) {
      const ev = tyreEvents.filter(e => e.corners.includes(corner)).slice(-1)[0]
      lastResetDate = ev?.date ?? null
      lastResetSource = 'service'
    } else if (resetIdxs.length) {
      const li = resetIdxs[resetIdxs.length - 1]!
      lastResetDate = allPoints[li]!.date
      lastResetSource = resetSource.get(li)!
    }

    // A replacement newer than every reading → the latest reading is the OLD tyre;
    // report unknown rather than showing a stale low figure on a fresh tyre.
    const segment = changedAfter ? [] : allPoints.slice(segmentStart)
    const latest = changedAfter || !allPoints.length ? null : allPoints[allPoints.length - 1]!
    const currentTread = latest?.tread ?? null
    const currentMileage = latest?.mileage ?? null
    const rate = changedAfter ? null : wearRate(segment)

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
      lastResetSource,
      awaitingReadingAfterChange: changedAfter,
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
