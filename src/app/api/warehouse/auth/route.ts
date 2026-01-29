/** 
 * Warehouse PIN Authentication API
 * 
 * Simple PIN verification for warehouse tablet access.
 * PIN is stored in WAREHOUSE_PIN environment variable.
 */

import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { pin } = await request.json()

    if (!pin || typeof pin !== 'string') {
      return NextResponse.json(
        { success: false, error: 'PIN required' },
        { status: 400 }
      )
    }

    const expectedPin = process.env.WAREHOUSE_PIN

    if (!expectedPin) {
      console.error('WAREHOUSE_PIN environment variable not set')
      return NextResponse.json(
        { success: false, error: 'System not configured' },
        { status: 500 }
      )
    }

    if (pin === expectedPin) {
      return NextResponse.json({ success: true })
    } else {
      return NextResponse.json(
        { success: false, error: 'Incorrect PIN' },
        { status: 401 }
      )
    }
  } catch (error) {
    console.error('Warehouse auth error:', error)
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    )
  }
}