/** 
 * Job Completion API Endpoint
 * 
 * POST /api/jobs/[id]/complete
 * 
 * FAST SYNCHRONOUS OPERATIONS (~8 seconds):
 * - Uploads signature image to Monday file column (when customer present)
 * - Uploads photo(s) to Monday file column
 * - Saves completion notes
 * - Updates status to "All done!"
 * - Sets completion timestamp
 * - Returns success to user immediately
 * 
 * BACKGROUND OPERATIONS (triggered async, user doesn't wait):
 * - Fetch mirror data (client name, venue)
 * - Send client delivery note (PDF) or collection confirmation
 * - Send driver notes alert to staff
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
  getFreelancerNameByEmail
} from '@/lib/monday'

// =============================================================================
// TYPES
// =============================================================================

interface CompleteJobRequest {
  notes?: string
  signature?: string        // Base64 PNG of signature (required when customer present)
  photos?: string[]         // Array of base64 images (required when customer not present)
  customerPresent: boolean
  clientEmails?: string[]   // Array of client email addresses to send delivery note/confirmation
  sendClientEmail?: boolean // Whether to send client email
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

    const { notes, signature, photos, customerPresent, clientEmails, sendClientEmail } = body

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
    console.log(`Complete API: customerPresent=${customerPresent}, signature=${!!signature}, photos=${photos?.length || 0}`)

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

    // =========================================================================
    // PHASE 1: FAST SYNCHRONOUS OPERATIONS (user waits for these)
    // =========================================================================

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

    console.log(`Complete API: Job ${jobId} marked complete - triggering background processing`)

    // =========================================================================
    // PHASE 2: TRIGGER BACKGROUND PROCESSING (user doesn't wait)
    // =========================================================================
    
    // Get driver name for background function
    let driverName = session.email
    try {
      driverName = await getFreelancerNameByEmail(session.email) || session.email
    } catch {
      // Non-critical
    }

    // Fire off background function - don't await!
    const backgroundPayload = {
      jobId,
      jobName: job.name,
      jobType: job.type,
      jobDate: job.date || completedDate.toISOString(),
      jobHhRef: job.hhRef,
      jobVenueId: job.venueId,
      jobVenueAddress: job.venueAddress,
      driverEmail: session.email,
      driverName,
      notes: notes?.trim() || null,
      customerPresent,
      clientEmails: clientEmails || [],
      sendClientEmail: sendClientEmail || false,
      completedAt: completedDate.toISOString(),
      signatureBase64: customerPresent ? signature : null,
      photos: photos || [],
    }

    // Trigger background function (fire and forget)
    triggerBackgroundProcessing(backgroundPayload).catch(err => {
      // Log but don't fail - the main completion succeeded
      console.error('Failed to trigger background processing:', err)
    })

    // =========================================================================
    // RETURN SUCCESS IMMEDIATELY
    // =========================================================================

    console.log(`Complete API: Returning success for job ${jobId}`)

    return NextResponse.json({
      success: true,
      jobId,
      completedAt: completedDate.toISOString(),
      warnings: errors.length > 0 ? errors : undefined,
      backgroundProcessing: true, // Indicate that emails etc are processing in background
    })

  } catch (error) {
    console.error('Complete API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to complete job' },
      { status: 500 }
    )
  }
}

// =============================================================================
// BACKGROUND TRIGGER
// =============================================================================

interface BackgroundPayload {
  jobId: string
  jobName: string
  jobType: 'delivery' | 'collection'
  jobDate: string
  jobHhRef?: string
  jobVenueId?: string
  jobVenueAddress?: string
  driverEmail: string
  driverName: string
  notes: string | null
  customerPresent: boolean
  clientEmails: string[]
  sendClientEmail: boolean
  completedAt: string
  signatureBase64: string | null
  photos: string[]
}

/**
 * Trigger the background function to handle:
 * - Mirror data fetch
 * - Client emails (with PDF for deliveries)
 * - Driver notes alerts
 * 
 * This is fire-and-forget - we don't await the result
 */
async function triggerBackgroundProcessing(payload: BackgroundPayload): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
  const backgroundSecret = process.env.BACKGROUND_FUNCTION_SECRET || process.env.MONDAY_WEBHOOK_SECRET
  
  if (!backgroundSecret) {
    console.warn('No BACKGROUND_FUNCTION_SECRET configured, skipping background processing')
    return
  }

  const backgroundUrl = `${appUrl.replace(/\/$/, '')}/.netlify/functions/completion-background`
  
  console.log(`Complete API: Triggering background function at ${backgroundUrl}`)

  // Fire and forget - don't await
  fetch(backgroundUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Background-Secret': backgroundSecret,
    },
    body: JSON.stringify(payload),
  }).then(response => {
    if (!response.ok) {
      console.error(`Background function returned ${response.status}`)
    } else {
      console.log('Background function triggered successfully')
    }
  }).catch(err => {
    console.error('Failed to call background function:', err)
  })
}