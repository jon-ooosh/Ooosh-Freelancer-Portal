/**
 * Sync processors — replay queued offline submissions.
 *
 * Each processor takes the stored form data and photos, and runs the same
 * server operations that the page submission handler would (Monday event,
 * photo upload, fleet status, PDF, email, etc.).
 *
 * These are designed to be resilient: each operation is independent and
 * failures are logged but don't block subsequent operations.
 */

import { createVehicleEvent } from './events-api'
import { uploadAllPhotos } from './photo-upload'
import { updateFleetHireStatus } from './fleet-status'
import { saveCollection } from './collection-api'
import { generateConditionReportPdf, sendConditionReportEmail, blobToBase64 } from './pdf-email'
import { withRetry } from './retry'
import type { CapturedPhoto, CollectionData } from '../types/vehicle-event'

/**
 * Process a queued book-out submission.
 * Returns true if critical operations succeed (Monday event + photos).
 */
export async function processBookOutSubmission(
  formData: Record<string, unknown>,
  photos: CapturedPhoto[],
  signatureBlob: Blob | null,
): Promise<boolean> {
  const vehicleReg = formData.vehicleReg as string
  const vehicleId = formData.vehicleId as string | null
  const driverName = formData.driverName as string
  const hireHopJob = formData.hireHopJob as string
  const clientEmail = formData.clientEmail as string
  const mileage = formData.mileage as string
  const fuelLevel = formData.fuelLevel as string | null
  const notes = formData.notes as string
  const mileageNum = parseInt(mileage, 10)

  let criticalSuccess = true

  // Step 1: Create Monday event
  const eventResult = await withRetry(
    () =>
      createVehicleEvent({
        vehicleReg,
        eventType: 'Book Out',
        mileage: isNaN(mileageNum) ? null : mileageNum,
        fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
        details: [
          `Driver: ${driverName}`,
          hireHopJob ? `HireHop Job: ${hireHopJob}` : null,
          `Photos: ${photos.length} captured`,
          `Briefing completed`,
          notes ? `Notes: ${notes}` : null,
          '(Synced from offline queue)',
        ]
          .filter(Boolean)
          .join('\n'),
        hireHopJob: hireHopJob || null,
        clientEmail: clientEmail || null,
        hireStatus: 'On Hire',
      }),
    'Offline sync: Monday event',
  )

  const eventId = eventResult.data?.id || `local_${Date.now()}`
  if (!eventResult.success) {
    console.error('[sync] Monday event creation failed for', vehicleReg)
    criticalSuccess = false
  }

  // Step 2: Update fleet status
  if (vehicleId) {
    await updateFleetHireStatus(vehicleId, 'On Hire')
  }

  // Step 3: Upload photos
  if (photos.length > 0) {
    const uploadResult = await withRetry(
      () => uploadAllPhotos(photos, eventId, vehicleReg),
      'Offline sync: Photo upload',
    )
    if (!uploadResult.success) {
      console.error('[sync] Photo upload failed for', vehicleReg)
      criticalSuccess = false
    }
  }

  // Step 4: PDF + Email (best-effort)
  try {
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()

    const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
    const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = []
    for (const p of photos) {
      try {
        const base64 = await blobToBase64(p.blob)
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        photoBase64s.push({ angle: p.angle, label: p.label, base64, r2Url })
      } catch {
        // Skip failed photo conversions
      }
    }

    let signatureBase64: string | undefined
    if (signatureBlob) {
      try {
        signatureBase64 = await blobToBase64(signatureBlob)
      } catch {
        // Skip
      }
    }

    const pdfResult = await withRetry(
      () =>
        generateConditionReportPdf({
          vehicleReg,
          vehicleType: formData.vehicleType as string,
          driverName,
          clientEmail: clientEmail || undefined,
          hireHopJob: hireHopJob || undefined,
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
          eventDate,
          eventDateTime,
          photos: photoBase64s,
          briefingItems: [],
          signatureBase64,
        }),
      'Offline sync: PDF generation',
    )

    if (pdfResult.success && pdfResult.data && clientEmail) {
      await withRetry(
        () =>
          sendConditionReportEmail({
            to: clientEmail,
            vehicleReg,
            driverName,
            eventDate,
            pdfBase64: pdfResult.data!.pdf,
            pdfFilename: pdfResult.data!.filename,
          }),
        'Offline sync: Email',
      )
    }
  } catch (err) {
    console.warn('[sync] PDF/email failed for', vehicleReg, err)
    // Non-critical — don't mark as failed
  }

  console.info(`[sync] Book-out processed for ${vehicleReg}: critical=${criticalSuccess}`)
  return criticalSuccess
}

/**
 * Process a queued collection submission.
 */
export async function processCollectionSubmission(
  formData: Record<string, unknown>,
  photos: CapturedPhoto[],
  signatureBlob: Blob | null,
): Promise<boolean> {
  const vehicleReg = formData.vehicleReg as string
  const vehicleId = formData.vehicleId as string | null
  const driverName = formData.driverName as string
  const hireHopJob = formData.hireHopJob as string
  const clientEmail = formData.clientEmail as string
  const mileage = formData.mileage as string
  const fuelLevel = formData.fuelLevel as string | null
  const damageNotes = formData.damageNotes as string
  const mileageNum = parseInt(mileage, 10)

  let criticalSuccess = true

  // Step 1: Monday event
  const eventResult = await withRetry(
    () =>
      createVehicleEvent({
        vehicleReg,
        eventType: 'Interim Check In',
        mileage: isNaN(mileageNum) ? null : mileageNum,
        fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
        details: [
          `Collection by: ${driverName}`,
          `HireHop Job: ${hireHopJob}`,
          `Photos: ${photos.length} captured`,
          damageNotes ? `Client notes: ${damageNotes}` : null,
          '(Synced from offline queue)',
        ]
          .filter(Boolean)
          .join('\n'),
        hireHopJob: hireHopJob || null,
        clientEmail: clientEmail || null,
        hireStatus: 'Collected',
      }),
    'Offline sync: Collection Monday event',
  )

  const eventId = eventResult.data?.id || `local_${Date.now()}`
  if (!eventResult.success) criticalSuccess = false

  // Step 2: Fleet status
  if (vehicleId) {
    await updateFleetHireStatus(vehicleId, 'Collected')
  }

  // Step 3: Photos
  if (photos.length > 0) {
    const uploadResult = await withRetry(
      () => uploadAllPhotos(photos, eventId, vehicleReg),
      'Offline sync: Collection photo upload',
    )
    if (!uploadResult.success) criticalSuccess = false
  }

  // Step 4: Save collection data to R2
  const collectionData: CollectionData = {
    vehicleReg,
    vehicleType: formData.vehicleType as string,
    vehicleSimpleType: formData.vehicleSimpleType as string,
    hireHopJob,
    driverName,
    clientEmail,
    mileage: mileageNum,
    fuelLevel: fuelLevel as CollectionData['fuelLevel'],
    damageNotes,
    collectedAt: new Date().toISOString(),
    collectedBy: driverName,
    eventId,
    photoAngles: photos.map(p => p.angle),
  }

  const saveResult = await saveCollection(collectionData)
  if (!saveResult.success) criticalSuccess = false

  // Step 5: PDF + email (best-effort)
  try {
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()

    const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
    const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = []
    for (const p of photos) {
      try {
        const base64 = await blobToBase64(p.blob)
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        photoBase64s.push({ angle: p.angle, label: p.label, base64, r2Url })
      } catch { /* skip */ }
    }

    let signatureBase64: string | undefined
    if (signatureBlob) {
      try { signatureBase64 = await blobToBase64(signatureBlob) } catch { /* skip */ }
    }

    const pdfResult = await withRetry(
      () =>
        generateConditionReportPdf({
          vehicleReg,
          vehicleType: formData.vehicleType as string,
          driverName,
          clientEmail: clientEmail || undefined,
          hireHopJob: hireHopJob || undefined,
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
          eventDate,
          eventDateTime,
          photos: photoBase64s,
          briefingItems: [],
          signatureBase64,
          isCheckIn: false,
        }),
      'Offline sync: Collection PDF',
    )

    if (pdfResult.success && pdfResult.data && clientEmail) {
      await withRetry(
        () =>
          sendConditionReportEmail({
            to: clientEmail,
            vehicleReg,
            driverName,
            eventDate,
            pdfBase64: pdfResult.data!.pdf,
            pdfFilename: pdfResult.data!.filename,
          }),
        'Offline sync: Collection email',
      )
    }
  } catch {
    // Non-critical
  }

  console.info(`[sync] Collection processed for ${vehicleReg}: critical=${criticalSuccess}`)
  return criticalSuccess
}

/**
 * Process a queued check-in submission.
 */
export async function processCheckInSubmission(
  formData: Record<string, unknown>,
  photos: CapturedPhoto[],
  signatureBlob: Blob | null,
): Promise<boolean> {
  const vehicleReg = formData.vehicleReg as string
  const vehicleId = formData.vehicleId as string | null
  const mileage = formData.mileage as string
  const fuelLevel = formData.fuelLevel as string | null
  const mileageNum = parseInt(mileage, 10)
  const damageItems = (formData.damageItems as Array<{ description: string; location: string; severity: string }>) || []

  let criticalSuccess = true

  // Step 1: Monday event
  const eventResult = await withRetry(
    () =>
      createVehicleEvent({
        vehicleReg,
        eventType: 'Check In',
        mileage: isNaN(mileageNum) ? null : mileageNum,
        fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
        details: [
          `Photos: ${photos.length} captured`,
          damageItems.length > 0 ? `Damage items: ${damageItems.length}` : 'No damage reported',
          '(Synced from offline queue)',
        ].join('\n'),
        hireHopJob: (formData.bookOutHireHopJob as string) || null,
        clientEmail: (formData.bookOutClientEmail as string) || null,
        hireStatus: 'Prep Needed',
      }),
    'Offline sync: Check-in Monday event',
  )

  const eventId = eventResult.data?.id || `local_${Date.now()}`
  if (!eventResult.success) criticalSuccess = false

  // Step 2: Fleet status
  if (vehicleId) {
    await updateFleetHireStatus(vehicleId, 'Prep Needed')
  }

  // Step 3: Photos
  if (photos.length > 0) {
    const uploadResult = await withRetry(
      () => uploadAllPhotos(photos, eventId, vehicleReg),
      'Offline sync: Check-in photo upload',
    )
    if (!uploadResult.success) criticalSuccess = false
  }

  // Step 4: PDF + email (best-effort)
  try {
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()

    const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
    const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = []
    for (const p of photos) {
      try {
        const base64 = await blobToBase64(p.blob)
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        photoBase64s.push({ angle: p.angle, label: p.label, base64, r2Url })
      } catch { /* skip */ }
    }

    let signatureBase64: string | undefined
    if (signatureBlob) {
      try { signatureBase64 = await blobToBase64(signatureBlob) } catch { /* skip */ }
    }

    const clientEmail = formData.bookOutClientEmail as string | null
    const driverName = formData.bookOutDriverName as string || 'Unknown'

    const pdfResult = await withRetry(
      () =>
        generateConditionReportPdf({
          vehicleReg,
          vehicleType: formData.vehicleType as string,
          driverName,
          clientEmail: clientEmail || undefined,
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: fuelLevel as import('../types/vehicle-event').FuelLevel | null,
          eventDate,
          eventDateTime,
          photos: photoBase64s,
          briefingItems: [],
          signatureBase64,
          isCheckIn: true,
          damageItems: damageItems.map(d => ({
            location: d.location,
            severity: d.severity as 'Critical' | 'Major' | 'Minor',
            description: d.description,
          })),
        }),
      'Offline sync: Check-in PDF',
    )

    if (pdfResult.success && pdfResult.data && clientEmail) {
      await withRetry(
        () =>
          sendConditionReportEmail({
            to: clientEmail,
            vehicleReg,
            driverName,
            eventDate,
            pdfBase64: pdfResult.data!.pdf,
            pdfFilename: pdfResult.data!.filename,
          }),
        'Offline sync: Check-in email',
      )
    }
  } catch {
    // Non-critical
  }

  console.info(`[sync] Check-in processed for ${vehicleReg}: critical=${criticalSuccess}`)
  return criticalSuccess
}
