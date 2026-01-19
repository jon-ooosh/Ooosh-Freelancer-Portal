/**
 * Job Completion API Endpoint
 * 
 * POST /api/jobs/[id]/complete
 * 
 * Completes a delivery/collection job:
 * - Uploads signature image to Monday file column
 * - Uploads photo to Monday file column (for secure drops)
 * - Saves completion notes
 * - Updates status to "All done"
 * - Sets completion timestamp
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { 
  getJobById, 
  DC_COLUMNS,
  uploadBase64ImageToColumn,
  getBoardIds,
  mondayQuery
} from '@/lib/monday'

// =============================================================================
// TYPES
// =============================================================================

interface CompleteJobRequest {
  notes?: string
  signature?: string        // Base64 PNG of signature
  photo?: string           // Base64 PNG of photo
  customerPresent: boolean
}

// =============================================================================
// API HANDLER
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    // Check session
    const session = await getSessionUser()
    
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    // Parse request body
    let body: CompleteJobRequest
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request body' },
        { status: 400 }
      )
    }

    const { notes, signature, photo, customerPresent } = body

    // Validate required fields based on customerPresent
    if (customerPresent && !signature) {
      return NextResponse.json(
        { success: false, error: 'Signature is required when customer is present' },
        { status: 400 }
      )
    }

    if (!customerPresent && !photo) {
      return NextResponse.json(
        { success: false, error: 'Photo is required for secure drops (customer not present)' },
        { status: 400 }
      )
    }

    console.log(`Complete API: Processing completion for job ${jobId} by ${session.email}`)

    // Verify the job exists and is assigned to this user
    const job = await getJobById(jobId, session.email)

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found or not assigned to you' },
        { status: 404 }
      )
    }

    // Check if already completed
    if (job.completedAtDate) {
      return NextResponse.json(
        { success: false, error: 'This job has already been completed' },
        { status: 400 }
      )
    }

    const completedDate = new Date()
    const errors: string[] = []

    // 1. Upload signature if provided
    if (signature) {
      console.log(`Complete API: Uploading signature for job ${jobId}`)
      try {
        const signatureResult = await uploadBase64ImageToColumn(
          jobId,
          DC_COLUMNS.signature,
          signature,
          `signature-${jobId}-${Date.now()}.png`
        )
        
        if (!signatureResult.success) {
          console.error('Failed to upload signature:', signatureResult.error)
          errors.push(`Signature upload: ${signatureResult.error}`)
        }
      } catch (err) {
        console.error('Signature upload error:', err)
        errors.push('Signature upload failed')
      }
    }

    // 2. Upload photo if provided (for secure drops)
    if (photo) {
      console.log(`Complete API: Uploading photo for job ${jobId}`)
      try {
        const photoResult = await uploadBase64ImageToColumn(
          jobId,
          DC_COLUMNS.completionPhotos,
          photo,
          `delivery-photo-${jobId}-${Date.now()}.png`
        )
        
        if (!photoResult.success) {
          console.error('Failed to upload photo:', photoResult.error)
          errors.push(`Photo upload: ${photoResult.error}`)
        }
      } catch (err) {
        console.error('Photo upload error:', err)
        errors.push('Photo upload failed')
      }
    }

    // 3. Update completion fields (notes, timestamp, status)
    console.log(`Complete API: Updating completion fields for job ${jobId}`)
    try {
      const boardId = getBoardIds().deliveries
      const dateStr = completedDate.toISOString().split('T')[0]
      const hours = completedDate.getHours()
      const minutes = completedDate.getMinutes()
      
      // Add "SECURE DROP - Customer not present" prefix if applicable
      const finalNotes = customerPresent 
        ? (notes || '')
        : `⚠️ SECURE DROP - Customer not present\n\n${notes || ''}`.trim()

      const mutation = `
        mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(
            board_id: $boardId, 
            item_id: $itemId, 
            column_values: $columnValues
          ) {
            id
          }
        }
      `

      const columnValues = {
        [DC_COLUMNS.completionNotes]: finalNotes,
        [DC_COLUMNS.completedAtDate]: { date: dateStr },
        [DC_COLUMNS.completedAtTime]: { hour: hours, minute: minutes },
        [DC_COLUMNS.status]: { label: 'All done' },
      }

      await mondayQuery(mutation, { 
        boardId, 
        itemId: jobId, 
        columnValues: JSON.stringify(columnValues)
      })
    } catch (err) {
      console.error('Failed to update completion fields:', err)
      return NextResponse.json(
        { success: false, error: 'Failed to update job status' },
        { status: 500 }
      )
    }

    console.log(`Complete API: Job ${jobId} completed successfully`)

    // Return success, but include any file upload warnings
    return NextResponse.json({
      success: true,
      jobId,
      completedAt: completedDate.toISOString(),
      warnings: errors.length > 0 ? errors : undefined
    })

  } catch (error) {
    console.error('Complete API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to complete job' },
      { status: 500 }
    )
  }
}
