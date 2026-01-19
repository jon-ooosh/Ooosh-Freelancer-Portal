/**
 * File Asset API Endpoint
 * 
 * GET /api/files/[assetId]
 * 
 * Returns a temporary public URL for a Monday.com asset.
 * The URL is a signed S3 link that expires in a few minutes,
 * so the client should use it immediately.
 * 
 * Requires authentication - only logged-in users can request file URLs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getAssetPublicUrl } from '@/lib/monday'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  try {
    // Get the asset ID from the URL
    const { assetId } = await params

    if (!assetId) {
      return NextResponse.json(
        { success: false, error: 'Asset ID is required' },
        { status: 400 }
      )
    }

    // Check session - user must be authenticated
    const session = await getSessionUser()
    
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    console.log(`Files API: Fetching public URL for asset ${assetId} (user: ${session.email})`)

    // Get the public URL from Monday.com
    const asset = await getAssetPublicUrl(assetId)

    if (!asset) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      assetId: asset.assetId,
      name: asset.name,
      publicUrl: asset.publicUrl
    })

  } catch (error) {
    console.error('Files API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch file' },
      { status: 500 }
    )
  }
}
