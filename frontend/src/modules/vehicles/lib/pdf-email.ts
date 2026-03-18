/**
 * PDF generation and email sending — client-side helpers.
 *
 * Calls Netlify functions to generate PDFs and send emails.
 * All server-side logic is in netlify/functions/generate-pdf.mts
 * and netlify/functions/send-email.mts
 */

import { apiFetch } from '../config/api-config'

interface PdfData {
  vehicleReg: string
  vehicleType: string
  vehicleMake?: string
  vehicleModel?: string
  vehicleColour?: string
  driverName: string
  clientEmail?: string
  hireHopJob?: string
  mileage: number | null
  fuelLevel: string | null
  eventDate: string
  eventDateTime: string   // Full ISO datetime for timestamp on PDF
  // Photos with base64 image data for embedding in PDF + optional R2 URL for clickable links
  photos: Array<{ angle: string; label: string; base64: string; r2Url?: string }>
  briefingItems: string[]
  bookOutNotes?: string       // Free-text notes from book-out
  signatureBase64?: string  // PNG data URI of driver signature
  // Future: from Driver Hire Forms
  hireStartDate?: string
  hireEndDate?: string
  allDrivers?: string[]
  // Check-in specific fields
  isCheckIn?: boolean
  bookOutMileage?: number | null
  bookOutFuelLevel?: string | null
  bookOutDate?: string | null
  driverPresent?: boolean
  damageItems?: Array<{
    location: string
    severity: string
    description: string
    photos?: Array<{ base64: string; r2Url?: string }>
  }>
}

interface PdfResult {
  pdf: string         // base64
  size: number
  filename: string
}

/**
 * Generate a condition report PDF on the server.
 */
export async function generateConditionReportPdf(data: PdfData): Promise<PdfResult> {
  console.log('[pdf-email] Calling generate-pdf function...')
  const response = await apiFetch('/generate-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'PDF generation failed' }))
    const detail = (err as { details?: string }).details || ''
    const errorMsg = (err as { error?: string }).error || `PDF failed: ${response.status}`
    console.error('[pdf-email] PDF generation failed:', errorMsg, detail)
    throw new Error(detail ? `${errorMsg}: ${detail}` : errorMsg)
  }

  const result = await response.json() as PdfResult
  console.log('[pdf-email] PDF generated:', result.filename, result.size, 'bytes')
  return result
}

/**
 * Convert a Blob to a base64 data URI string (e.g. "data:image/jpeg;base64,...")
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Resize an image blob to a smaller version suitable for PDF embedding.
 * Uses OffscreenCanvas to scale down to maxWidth (default 800px),
 * producing ~50-80KB JPEG instead of 3-5MB originals.
 * Falls back to original base64 on older devices without OffscreenCanvas support.
 */
export async function resizeImageForPdf(
  blob: Blob,
  maxWidth = 800,
  quality = 0.7,
): Promise<string> {
  // Fallback for older devices (pre-iOS 16.4, very old Android)
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    console.warn('[resizeImageForPdf] OffscreenCanvas not supported, using original image')
    return blobToBase64(blob)
  }

  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxWidth / bitmap.width)
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return blobToBase64(resizedBlob)
}

/**
 * Send the condition report email with PDF attachment.
 */
export async function sendConditionReportEmail(params: {
  to: string
  vehicleReg: string
  driverName: string
  eventDate: string
  pdfBase64: string
  pdfFilename: string
  isCheckIn?: boolean
  driverPresent?: boolean
  // Check-in alert data
  damageCount?: number
  fuelDifference?: string | null  // e.g. "Full -> 3/8"
  milesDriven?: number | null
}): Promise<{ messageId: string }> {
  console.log('[pdf-email] Calling send-email function to:', params.to)
  // Use ASCII-safe subject line (no em-dashes)
  const reportType = params.isCheckIn ? 'Check-In Report' : 'Condition Report'
  const subject = `Vehicle ${reportType} - ${params.vehicleReg} - ${formatDateShort(params.eventDate)}`
  const response = await apiFetch('/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: params.to,
      subject,
      html: buildEmailHtml({
        ...params,
        isCheckIn: params.isCheckIn,
        driverPresent: params.driverPresent,
        damageCount: params.damageCount,
        fuelDifference: params.fuelDifference,
        milesDriven: params.milesDriven,
      }),
      pdfBase64: params.pdfBase64,
      pdfFilename: params.pdfFilename,
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Email failed' }))
    const detail = (err as { details?: string }).details || ''
    const errorMsg = (err as { error?: string }).error || `Email failed: ${response.status}`
    console.error('[pdf-email] Email send failed:', errorMsg, detail)
    throw new Error(detail ? `${errorMsg}: ${detail}` : errorMsg)
  }

  const result = await response.json() as { messageId: string }
  console.log('[pdf-email] Email sent, messageId:', result.messageId)
  return result
}

/**
 * Build the HTML email body for the condition report.
 */
function buildEmailHtml(params: {
  vehicleReg: string
  driverName: string
  eventDate: string
  isCheckIn?: boolean
  driverPresent?: boolean
  damageCount?: number
  fuelDifference?: string | null
  milesDriven?: number | null
}): string {
  const date = formatDateShort(params.eventDate)

  if (params.isCheckIn) {
    return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #1b2a4e; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; font-size: 20px; margin: 0;">Vehicle Check-In Report</h1>
        <p style="color: #b4bed2; font-size: 13px; margin: 8px 0 0;">Return Record</p>
      </div>

      <div style="padding: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Hi ${params.driverName},
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please find attached the vehicle check-in report for <strong>${params.vehicleReg}</strong>,
          recorded on <strong>${date}</strong>.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          This report documents the condition of the vehicle at the end of the hire,
          including any changes from the original book-out condition.
        </p>${params.milesDriven != null ? `
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Total miles driven: <strong>${params.milesDriven.toLocaleString()} miles</strong>
        </p>` : ''}${params.damageCount && params.damageCount > 0 ? `
        <div style="margin: 0 0 16px; padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;">
          <p style="margin: 0; font-size: 14px; color: #991b1b;">
            <strong>Damage Reported:</strong> ${params.damageCount} damage item${params.damageCount > 1 ? 's' : ''} ${params.damageCount > 1 ? 'were' : 'was'} recorded during this check-in.
            Please review the attached PDF report for full details and photographs.
          </p>
        </div>` : ''}${params.fuelDifference ? `
        <div style="margin: 0 0 16px; padding: 12px; background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 6px;">
          <p style="margin: 0; font-size: 14px; color: #92400e;">
            <strong>Fuel Difference:</strong> The vehicle was returned with a different fuel level than at book-out (${params.fuelDifference}).
          </p>
        </div>` : ''}${params.driverPresent === false ? `
        <p style="margin: 0 0 16px; padding: 12px; background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 13px; color: #92400e;">
          <strong>Note:</strong> The driver was not present at the time of check-in.
          The vehicle was inspected without the driver in attendance.
        </p>` : ''}
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please review the attached PDF and contact us if you have any queries.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Thank you for choosing Ooosh Tours!
        </p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #374151;">
          If you have any questions, please call us on <strong>+44 (0) 1273 911382</strong>
          or email <a href="mailto:info@oooshtours.co.uk" style="color: #1b2a4e;">info@oooshtours.co.uk</a>.
        </p>
      </div>

      <div style="padding: 16px 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">
          Ooosh Tours Ltd
        </p>
        <p style="margin: 4px 0 0; font-size: 11px; color: #d1d5db;">
          This is an automated message. Please do not reply directly to this email.
        </p>
      </div>
    </div>
    `
  }

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #1b2a4e; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; font-size: 20px; margin: 0;">Vehicle Condition Report</h1>
        <p style="color: #b4bed2; font-size: 13px; margin: 8px 0 0;">Book-Out Record</p>
      </div>

      <div style="padding: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Hi ${params.driverName},
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please find attached the vehicle condition report for <strong>${params.vehicleReg}</strong>,
          recorded on <strong>${date}</strong>.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          This report documents the condition of the vehicle at the start of the hire,
          including mileage, fuel level, and condition photographs.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please review the attached PDF and contact us if you have any questions.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          We hope you have a great tour!
        </p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #374151;">
          If you have any problems, please call us on <strong>+44 (0) 1273 911382</strong>
          or email <a href="mailto:info@oooshtours.co.uk" style="color: #1b2a4e;">info@oooshtours.co.uk</a>.
          If you have an out-of-hours emergency our number is <strong>+44 (0) 333 2079654</strong>.
        </p>
      </div>

      <div style="padding: 16px 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">
          Ooosh Tours Ltd
        </p>
        <p style="margin: 4px 0 0; font-size: 11px; color: #d1d5db;">
          This is an automated message. Please do not reply directly to this email.
        </p>
      </div>
    </div>
  `
}

function formatDateShort(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}
