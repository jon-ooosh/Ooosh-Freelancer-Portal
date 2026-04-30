/**
 * Staff Settings API
 *
 * GET /api/staff/settings — Fetch transport calculator settings.
 *
 * Source of truth: Ooosh Operations Platform's `calculator_settings`
 * table, fetched via the dedicated `GET /api/portal/staff/calculator-settings`
 * endpoint (protected by `PORTAL_STAFF_API_KEY`).
 *
 * History: this endpoint used to read from Monday.com's "D&C Settings"
 * board (id 18398014955). Repointed to OP on 30 Apr 2026 — that board
 * is now stale, OP's `calculator_settings` is the canonical source.
 *
 * Auth: requires the staff PIN header (`x-staff-pin`) just like before
 * — no user-facing change in how the staff Crew & Transport page calls
 * this. The OP API key is server-side only and never reaches the
 * browser.
 */

import { NextRequest, NextResponse } from 'next/server'

// =============================================================================
// DEFAULT VALUES
// Used when:
//   - OP backend is unreachable (network error / OP down)
//   - PORTAL_STAFF_API_KEY isn't configured (and we're degrading gracefully)
//   - A specific key isn't yet in OP's `calculator_settings` table
// These mirror OP's seed values in migration 007 + the legacy Monday defaults
// for `expenseVarianceThreshold` (not currently in OP).
// =============================================================================
const DEFAULT_SETTINGS = {
  hourlyRateFreelancerDay: 18,
  hourlyRateFreelancerNight: 25,
  hourlyRateClientDay: 33,
  hourlyRateClientNight: 45,
  adminCostPerHour: 5,
  driverDayRate: 180,
  expenseMarkupPercent: 10,
  minHoursThreshold: 5,
  minClientCharge: 0,
  expenseVarianceThreshold: 10,
  handoverTimeMinutes: 15,
  unloadTimeMinutes: 30,
  fuelPricePerLitre: 1.45,
}

interface CostingSettings {
  fuelPricePerLitre: number
  expenseMarkupPercent: number
  adminCostPerHour: number
  handoverTimeMinutes: number
  unloadTimeMinutes: number
  minHoursThreshold: number
  minClientCharge: number
  hourlyRateFreelancerDay: number
  hourlyRateFreelancerNight: number
  hourlyRateClientDay: number
  hourlyRateClientNight: number
  driverDayRate: number
  expenseVarianceThreshold: number
}

/** Merge OP-supplied values with defaults — drops `undefined` from OP and
 *  fills any missing keys from `DEFAULT_SETTINGS`. */
function withDefaults(opSettings: Partial<Record<keyof CostingSettings, number | undefined>>): CostingSettings {
  const out = { ...DEFAULT_SETTINGS } as unknown as Record<string, number>
  for (const [k, v] of Object.entries(opSettings)) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      out[k] = v
    }
  }
  return out as unknown as CostingSettings
}

// =============================================================================
// GET HANDLER
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Verify staff PIN (also accept hub auth marker for Staff Hub sessions)
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    const HUB_AUTH_MARKER = '__HUB_AUTH__'

    if (!staffPin || (pin !== staffPin && pin !== HUB_AUTH_MARKER)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const opUrl = process.env.OP_BACKEND_URL
    const apiKey = process.env.PORTAL_STAFF_API_KEY

    if (!opUrl || !apiKey) {
      console.warn('Staff settings: OP_BACKEND_URL or PORTAL_STAFF_API_KEY not configured — serving defaults')
      return NextResponse.json({
        success: true,
        settings: DEFAULT_SETTINGS,
        source: 'defaults',
      })
    }

    try {
      const url = `${opUrl.replace(/\/$/, '')}/api/portal/staff/calculator-settings`
      const response = await fetch(url, {
        headers: { 'x-portal-staff-key': apiKey },
        // Calculator settings change rarely — let Netlify cache for 60s.
        next: { revalidate: 60 },
      })
      if (!response.ok) {
        throw new Error(`OP responded ${response.status}`)
      }
      const data = await response.json() as {
        success: boolean
        settings: Partial<Record<keyof CostingSettings, number | undefined>>
      }
      const settings = withDefaults(data.settings || {})
      return NextResponse.json({
        success: true,
        settings,
        source: 'op',
      })
    } catch (err) {
      // OP unreachable / errored — degrade to defaults so the staff
      // Crew & Transport calculator stays usable.
      console.error('Staff settings: OP fetch failed, using defaults:', err)
      return NextResponse.json({
        success: true,
        settings: DEFAULT_SETTINGS,
        source: 'defaults',
        error: err instanceof Error ? err.message : 'OP fetch failed',
      })
    }
  } catch (error) {
    console.error('Settings API error:', error)
    return NextResponse.json({
      success: true,
      settings: DEFAULT_SETTINGS,
      source: 'defaults',
      error: error instanceof Error ? error.message : 'Failed to load settings',
    })
  }
}
