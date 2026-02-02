/**
 * Staff Authentication API
 * 
 * POST /api/staff/auth
 * 
 * Verifies the staff PIN for access to staff-only features.
 * Similar to the warehouse PIN authentication.
 */

import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { pin } = await request.json()

    if (!pin) {
      return NextResponse.json(
        { success: false, error: 'PIN is required' },
        { status: 400 }
      )
    }

    const staffPin = process.env.STAFF_PIN

    if (!staffPin) {
      console.error('Staff Auth: STAFF_PIN environment variable not configured')
      return NextResponse.json(
        { success: false, error: 'Staff authentication not configured' },
        { status: 500 }
      )
    }

    if (pin === staffPin) {
      console.log('Staff Auth: PIN verified successfully')
      return NextResponse.json({ success: true })
    } else {
      console.log('Staff Auth: Invalid PIN attempt')
      return NextResponse.json(
        { success: false, error: 'Invalid PIN' },
        { status: 401 }
      )
    }
  } catch (error) {
    console.error('Staff Auth error:', error)
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    )
  }
}

/**
 * Helper function to verify staff PIN from request headers
 * Used by other staff API routes
 */
export function verifyStaffPin(request: NextRequest): boolean {
  const pin = request.headers.get('x-staff-pin')
  const staffPin = process.env.STAFF_PIN
  
  if (!staffPin) {
    console.error('Staff Auth: STAFF_PIN not configured')
    return false
  }
  
  return pin === staffPin
}