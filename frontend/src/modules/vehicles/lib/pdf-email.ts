/**
 * Condition-report PDF + email — client-side helpers.
 *
 * Since Jun 2026 the PDF build + per-recipient emailing happens fully
 * server-side via POST /api/vehicles/send-condition-report (the legacy
 * two-step /generate-pdf + /send-email round-trip shipped each 7-9MB
 * base64 PDF down to the phone and back up per driver). The legacy
 * backend endpoints are retained for pre-deploy tabs and
 * events/:id/regenerate-pdf; the email HTML lives in
 * backend/src/services/condition-report-email.ts.
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

export interface ConditionReportRecipient {
  driverName: string
  email: string | null
}

export interface ConditionReportSendResult {
  driverName: string
  success: boolean
  emailedTo?: string
  isFallback?: boolean
  filename?: string
  size?: number
  error?: string
}

/**
 * Generate AND email condition-report PDFs for one or more drivers in a
 * single server-side call (POST /api/vehicles/send-condition-report).
 *
 * Replaces the legacy generateConditionReportPdf + sendConditionReportEmail
 * round-trip per driver: the old flow downloaded each 7-9MB base64 PDF to
 * the phone and re-uploaded it as the email payload. Here the (~800px)
 * photo thumbnails go up once and the per-driver PDFs never leave the
 * server. The legacy functions stay for CollectionPage + sync-processors.
 */
export async function sendConditionReport(
  pdfData: PdfData,
  recipients: ConditionReportRecipient[],
  emailMeta?: {
    driverPresent?: boolean
    damageCount?: number
    fuelDifference?: string | null
    milesDriven?: number | null
  },
): Promise<ConditionReportSendResult[]> {
  console.log(`[pdf-email] Calling send-condition-report for ${recipients.length} recipient(s)...`)
  const response = await apiFetch('/send-condition-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pdfData, recipients, emailMeta }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Condition report send failed' }))
    const detail = (err as { details?: string }).details || ''
    const errorMsg = (err as { error?: string }).error || `Send failed: ${response.status}`
    console.error('[pdf-email] send-condition-report failed:', errorMsg, detail)
    throw new Error(detail ? `${errorMsg}: ${detail}` : errorMsg)
  }

  const result = await response.json() as { results: ConditionReportSendResult[] }
  return result.results
}
