/**
 * Asset URL API Endpoint
 * 
 * GET /api/files/asset-url?id=123 - Get the temporary public URL for a Monday.com asset
 * GET /api/files/asset-url?id=123&redirect=true - Redirect directly to the file
 * 
 * Monday.com asset URLs are temporary and expire, so we fetch a fresh one each time.
 * Security: Requires authenticated session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getAssetPublicUrl } from '@/lib/monday'

export async function GET(request: NextRequest) {
  try {
    // Check session
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const assetId = searchParams.get('id')
    const redirect = searchParams.get('redirect') === 'true'

    if (!assetId) {
      return NextResponse.json(
        { success: false, error: 'Asset ID is required' },
        { status: 400 }
      )
    }

    console.log('Files API: Fetching public URL for asset', assetId)

    const asset = await getAssetPublicUrl(assetId)

    if (!asset || !asset.publicUrl) {
      return NextResponse.json(
        { success: false, error: 'Asset not found or URL unavailable' },
        { status: 404 }
      )
    }

    // If redirect mode, send the user straight to the file
    if (redirect) {
      return NextResponse.redirect(asset.publicUrl)
    }

    return NextResponse.json({
      success: true,
      assetId: asset.assetId,
      name: asset.name,
      url: asset.publicUrl,
    })

  } catch (error) {
    console.error('Files API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch asset URL' },
      { status: 500 }
    )
  }
}