/**
 * ⚠️ TEMPORARY DIAGNOSTIC ENDPOINT - DELETE AFTER USE ⚠️
 * 
 * GET /api/staff/hirehop-debug?job=15276
 * 
 * Returns the RAW response from HireHop's items_to_supply_list.php
 * so we can inspect whether headers/sections appear in the data.
 * 
 * Protected by staff PIN.
 */

import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  // Staff PIN auth
  const pin = request.headers.get('x-staff-pin')
  const staffPin = process.env.STAFF_PIN
  if (!staffPin || pin !== staffPin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const jobId = request.nextUrl.searchParams.get('job')
  if (!jobId) {
    return NextResponse.json({ error: 'Missing ?job= parameter' }, { status: 400 })
  }

  const token = process.env.HIREHOP_API_TOKEN
  const domain = process.env.HIREHOP_DOMAIN || 'hirehop.net'
  if (!token) {
    return NextResponse.json({ error: 'HIREHOP_API_TOKEN not set' }, { status: 500 })
  }

  try {
    const encodedToken = encodeURIComponent(token)
    const url = `https://${domain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`

    const response = await fetch(url)
    const responseText = await response.text()

    // Check for HTML error
    if (responseText.trim().startsWith('<')) {
      return NextResponse.json({
        error: 'HireHop returned HTML (auth failure?)',
        raw: responseText.substring(0, 500),
      }, { status: 502 })
    }

    // Parse and return the raw data
    const rawData = JSON.parse(responseText)
    const items = Array.isArray(rawData) ? rawData : (rawData.items || rawData)

    // Return with summary info
    return NextResponse.json({
      jobId,
      totalItems: Array.isArray(items) ? items.length : 'unknown',
      // All unique keys across all items (so we can see every field HireHop sends)
      allFieldsFound: Array.isArray(items)
        ? Array.from(new Set(items.flatMap((item: Record<string, unknown>) => Object.keys(item))))
        : [],
      // Raw items - the full unfiltered response
      rawItems: items,
    })
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}