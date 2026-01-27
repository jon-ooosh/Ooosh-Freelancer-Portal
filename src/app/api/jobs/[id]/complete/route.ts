/** 
 * Job Completion API Endpoint
 * 
 * POST /api/jobs/[id]/complete
 * 
 * Completes a delivery/collection job:
 * - Uploads signature image to Monday file column (when customer present)
 * - Uploads photo(s) to Monday file column (required when customer not present, optional otherwise)
 * - Saves completion notes
 * - Updates status to "All done!"
 * - Sets completion timestamp
 * - Sends driver notes alert to staff if notes were provided
 * 
 * Validation:
 * - Customer present: signature required, photos optional (0-5)
 * - Customer not present: at least 1 photo required (up to 5), no signature
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { 
  getJobById, 
  DC_COLUMNS,
  uploadBase64ImageToColumn,
  getBoardIds,
  mondayQuery,
  getRelatedUpcomingJobs,
  getFreelancerNameByEmail
} from '@/lib/monday'
import { sendDriverNotesAlert } from '@/lib/email'

// =============================================================================
// TYPES
// =============================================================================

interface CompleteJobRequest {
  notes?: string
  signature?: string        // Base64 PNG of signature (required when customer present)
  photos?: string[]         // Array of base64 images (required when customer not present)
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

    const { notes, signature, photos, customerPresent } = body

    // Validate required fields based on customerPresent
    if (customerPresent && !signature) {
      return NextResponse.json(
        { success: false, error: 'Signature is required when customer is present' },
        { status: 400 }
      )
    }

    if (!customerPresent && (!photos || photos.length === 0)) {
      return NextResponse.json(
        { success: false, error: 'At least one photo is required when customer is not present' },
        { status: 400 }
      )
    }

    // Validate photo count (max 5)
    if (photos && photos.length > 5) {
      return NextResponse.json(
        { success: false, error: 'Maximum 5 photos allowed' },
        { status: 400 }
      )
    }

    console.log(`Complete API: Processing completion for job ${jobId} by ${session.email}`)
    console.log(`Complete API: customerPresent=${customerPresent}, signature=${!!signature}, photos=${photos?.length || 0}, hasNotes=${!!(notes && notes.trim())}`)

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

    // 1. Upload signature if provided (customer present)
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

    // 2. Upload photos if provided
    if (photos && photos.length > 0) {
      console.log(`Complete API: Uploading ${photos.length} photo(s) for job ${jobId}`)
      
      for (let i = 0; i < photos.length; i++) {
        try {
          const photoResult = await uploadBase64ImageToColumn(
            jobId,
            DC_COLUMNS.completionPhotos,
            photos[i],
            `delivery-photo-${jobId}-${Date.now()}-${i + 1}.jpg`
          )
          
          if (!photoResult.success) {
            console.error(`Failed to upload photo ${i + 1}:`, photoResult.error)
            errors.push(`Photo ${i + 1} upload: ${photoResult.error}`)
          }
        } catch (err) {
          console.error(`Photo ${i + 1} upload error:`, err)
          errors.push(`Photo ${i + 1} upload failed`)
        }
      }
    }

    // 3. Update completion fields (notes, timestamp, status)
    console.log(`Complete API: Updating completion fields for job ${jobId}`)
    try {
      const boardId = getBoardIds().deliveries
      const dateStr = completedDate.toISOString().split('T')[0]
      const hours = completedDate.getHours()
      const minutes = completedDate.getMinutes()
      
      // Add "Customer not present" prefix if applicable
      const finalNotes = customerPresent 
        ? (notes || '')
        : `Customer not present\n\n${notes || ''}`.trim()

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
        [DC_COLUMNS.completionNotes]: finalNotes || (customerPresent ? '' : 'Customer not present'),
        [DC_COLUMNS.completedAtDate]: { date: dateStr },
        [DC_COLUMNS.completedAtTime]: { hour: hours, minute: minutes },
        [DC_COLUMNS.status]: { label: 'All done!' },
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

    // 4. Send driver notes alert if notes were provided
    // Only send if there are actual notes (not just "Customer not present")
    const actualNotes = notes?.trim()
    if (actualNotes) {
      console.log(`Complete API: Sending driver notes alert for job ${jobId}`)
      try {
        // Get driver name
        const driverName = await getFreelancerNameByEmail(session.email) || session.email

        // Find related upcoming jobs (same venue or same HH ref)
        const relatedJobs = await getRelatedUpcomingJobs(
          jobId,
          job.venueId,
          job.hhRef
        )

        // Build final notes (include "Customer not present" prefix if applicable)
        const notesForEmail = customerPresent 
          ? actualNotes
          : `Customer not present\n\n${actualNotes}`

        // Send the alert email
        const emailResult = await sendDriverNotesAlert(
          driverName,
          {
            id: job.id,
            name: job.name,
            type: job.type,
            date: job.date || '',
            venue: job.venueName || job.name,
          },
          notesForEmail,
          relatedJobs
        )

        if (!emailResult.success) {
          console.error('Failed to send driver notes alert:', emailResult.error)
          // Don't fail the whole request, just log the error
          errors.push(`Driver notes alert: ${emailResult.error}`)
        } else {
          console.log(`Complete API: Driver notes alert sent successfully`)
        }
      } catch (err) {
        console.error('Error sending driver notes alert:', err)
        // Don't fail the whole request
        errors.push('Driver notes alert failed')
      }
    }

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