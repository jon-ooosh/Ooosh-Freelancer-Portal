/**
 * Job Completion API Endpoint
 *
 * POST /api/jobs/[id]/complete
 *
 * Forwards the completion (notes, signature, photos) to the OP backend,
 * which uploads the artefacts, marks the job complete, and handles client
 * delivery-note / confirmation emails and staff alerts on its side.
 *
 * Validation (deliveries and collections — mode 'dc'):
 * - Customer present: signature required, photos optional (0-5)
 * - Customer not present: at least 1 photo required (up to 5), no signature
 * Van-only book-out, crew and People completions: no signature or photo rule
 * (Oct 2026 — crew and People complete with notes and optional photos).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { submitCompletionToOP, isOpClientError, OpApiError } from '@/lib/op-api'

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
  vanOnly?: boolean         // True for van-only book-out (no signature/photos required)
  staffName?: string        // Name of Ooosh staff member completing (for @oooshtours.co.uk users)
  mode?: 'dc' | 'crew' | 'people' // Which completion form was used (default 'dc')
  // What the freelancer ticked off the equipment list; OP puts it on the job's timeline.
  equipmentChecklist?: Array<{ name: string; quantity: number; checked: number }>
  sendHireNote?: boolean    // Crew only: send the client a note of what's on the hire
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

    const { notes, signature, photos, customerPresent, vanOnly, staffName, clientEmails, sendClientEmail,
      mode, equipmentChecklist, sendHireNote } = body

    // Only a delivery/collection hand-over needs a signature (or a photo when
    // nobody was there). Van-only, crew and People completions don't.
    if (!vanOnly && (mode ?? 'dc') === 'dc') {
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

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Session token missing' },
        { status: 401 }
      )
    }

    try {
      // Build FormData for the OP backend
      const formData = new FormData()
      formData.append('notes', notes || '')
      formData.append('customerPresent', String(customerPresent))
      if (staffName) formData.append('staffName', staffName)
      // Forward vanOnly so the OP backend skips the equipment delivery
      // note PDF + email — there's no equipment to acknowledge for a
      // van-only book-out (the vehicle condition report is the relevant
      // artefact and is sent separately by the OP book-out flow).
      if (vanOnly) formData.append('vanOnly', 'true')
      // Client emails: until Oct 2026 neither was forwarded, so the addresses a
      // freelancer typed were dropped and "Don't send" was ignored (HH 16665).
      const typedEmails = (clientEmails || []).map(e => e.trim()).filter(Boolean)
      if (typedEmails.length > 0) formData.append('clientEmails', typedEmails.join(','))
      if (sendClientEmail === false) formData.append('sendClientEmail', 'false')
      if (mode === 'crew' && sendHireNote) formData.append('sendHireNote', 'true')
      if (Array.isArray(equipmentChecklist) && equipmentChecklist.length > 0) {
        formData.append('equipmentChecklist', JSON.stringify(equipmentChecklist.slice(0, 300)))
      }

      // Convert base64 photos to blobs
      if (photos) {
        for (const photoBase64 of photos) {
          const match = photoBase64.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            const buffer = Buffer.from(match[2], 'base64')
            const blob = new Blob([buffer], { type: match[1] })
            formData.append('photos', blob, `photo-${Date.now()}.jpg`)
          }
        }
      }

      // Convert base64 signature to blob
      if (signature) {
        const match = signature.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          const buffer = Buffer.from(match[2], 'base64')
          const blob = new Blob([buffer], { type: match[1] })
          formData.append('signature', blob, `signature-${Date.now()}.png`)
        }
      }

      const result = await submitCompletionToOP(sessionToken, jobId, formData)
      return NextResponse.json({
        ...result,
        success: true,
        jobId,
        completedAt: new Date().toISOString(),
        backgroundProcessing: false,
      })
    } catch (opError) {
      // 4xx (already completed, validation error, not assigned to you) =
      // legit response — propagate without alerting.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        const code = ((opError as OpApiError).body as { code?: string } | undefined)?.code
        return NextResponse.json(
          { success: false, error: opError.message, ...(code ? { code } : {}) },
          { status }
        )
      }
      console.error('OP backend completion error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to submit completion. Please try again in a moment.' },
        { status: 502 }
      )
    }

  } catch (error) {
    console.error('Complete API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to complete job' },
      { status: 500 }
    )
  }
}