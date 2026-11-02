/**
 * Earnings API Endpoint
 *
 * GET /api/earnings?period=this_month|last_month|tax_year|last_tax_year
 *
 * The freelancer's invoices (as the office linked them in Costs) and their
 * finished work for the period, from OP (services/freelancer-earnings.ts,
 * FREELANCER-PORTAL-SPEC §5.2). Read-only.
 *
 * Requires authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getEarningsFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

const PERIODS = ['this_month', 'last_month', 'tax_year', 'last_tax_year']

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    const asked = request.nextUrl.searchParams.get('period') || ''
    const period = PERIODS.includes(asked) ? asked : undefined

    try {
      const data = await getEarningsFromOP(sessionToken, period)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP earnings error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load your earnings. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Earnings API error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load earnings' }, { status: 500 })
  }
}
