import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { apiFetch } from '../config/api-config'
import { vmPath } from '../config/route-paths'
import { Link, useSearchParams } from 'react-router-dom'
import { useVehicles } from '../hooks/useVehicles'
import { useDriverHireForms } from '../hooks/useDriverHireForms'
import { createVehicleEvent } from '../lib/events-api'
import { fetchBookOutForVehicle, checkAlreadyCheckedIn } from '../lib/events-query'
import type { CheckInStatus } from '../lib/events-query'
import { fetchBookOutPhotos } from '../lib/photo-retrieval'
import { uploadAllPhotos, uploadDamagePhotos } from '../lib/photo-upload'
import { updateFleetHireStatus } from '../lib/fleet-status'
import { barcodeCheckin } from '../lib/hirehop-api'
import { getAllocations, saveAllocations } from '../lib/allocations-api'
import { getCollection } from '../lib/collection-api'
import type { CollectionData } from '../types/vehicle-event'
import { findDeviceByReg, getPositions } from '../lib/traccar-api'
import { knotsToMph } from '../types/traccar'
import type { IssueLocation } from '../types/issue'
import { withRetry } from '../lib/retry'
import { saveIssue } from '../lib/issues-r2-api'
import { generateConditionReportPdf, sendConditionReportEmail, blobToBase64, resizeImageForPdf } from '../lib/pdf-email'
import { PhotoComparison } from '../components/check-in/PhotoComparison'
import { PhotoLightbox } from '../components/shared/PhotoLightbox'
import { SignatureCapture } from '../components/book-out/SignatureCapture'
import type { SignatureCaptureHandle } from '../components/book-out/SignatureCapture'
import type { Vehicle } from '../types/vehicle'
import type {
  CheckInFormState,
  FuelLevel,
  CapturedPhoto,
  DamageItem,
} from '../types/vehicle-event'
import { FUEL_LEVELS, DAMAGE_LOCATIONS, REQUIRED_PHOTOS } from '../types/vehicle-event'
import { useFormAutosave } from '../hooks/useFormAutosave'
import { queueSubmission } from '../lib/offline-queue'
import { DraftResumePrompt } from '../components/shared/DraftResumePrompt'

interface OpResult {
  label: string
  success: boolean
  detail?: string
}

const TESTING_MODE = false

const STEPS = [
  'Select Vehicle',
  'Review Book-Out',
  'Current State',
  'Photos',
  'Damage Report',
  'Confirm',
] as const

const INITIAL_FORM: CheckInFormState = {
  vehicleId: null,
  vehicleReg: '',
  vehicleType: '',
  vehicleSimpleType: '',
  bookOutEventId: null,
  bookOutDate: null,
  bookOutMileage: null,
  bookOutFuelLevel: null,
  bookOutDriverName: null,
  bookOutHireHopJob: null,
  bookOutClientEmail: null,
  bookOutNotes: null,
  bookOutPhotos: new Map(),
  mileage: '',
  fuelLevel: null,
  photos: [],
  damageItems: [],
  driverPresent: true,
  signatureBlob: null,
}

export function CheckInPage() {
  const [searchParams] = useSearchParams()
  const { data: allVehicles, isLoading: vehiclesLoading } = useVehicles()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<CheckInFormState>(INITIAL_FORM)
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [opResults, setOpResults] = useState<OpResult[]>([])
  const [bookOutLoading, setBookOutLoading] = useState(false)
  const [checkInStatus, setCheckInStatus] = useState<CheckInStatus | null>(null)
  const signatureRef = useRef<SignatureCaptureHandle>(null)
  const [collectionData, setCollectionData] = useState<CollectionData | null>(null)
  const [queuedOffline, setQueuedOffline] = useState(false)

  // Form autosave
  const { save: autosave, clear: clearAutosave, draftLoaded, draftChecked, dismissDraft } = useFormAutosave({
    flowType: 'check-in',
    disabled: submitSuccess || queuedOffline,
  })

  // Autosave on every form/step change
  useEffect(() => {
    if (!draftChecked || submitSuccess || queuedOffline) return
    // Convert Map to plain object for IDB storage
    const bookOutPhotosObj: Record<string, string> = {}
    form.bookOutPhotos.forEach((v, k) => { bookOutPhotosObj[k] = v })
    autosave({
      step,
      formData: {
        vehicleId: form.vehicleId,
        vehicleReg: form.vehicleReg,
        vehicleType: form.vehicleType,
        vehicleSimpleType: form.vehicleSimpleType,
        bookOutEventId: form.bookOutEventId,
        bookOutDate: form.bookOutDate,
        bookOutMileage: form.bookOutMileage,
        bookOutFuelLevel: form.bookOutFuelLevel,
        bookOutDriverName: form.bookOutDriverName,
        bookOutHireHopJob: form.bookOutHireHopJob,
        bookOutClientEmail: form.bookOutClientEmail,
        bookOutNotes: form.bookOutNotes,
        bookOutPhotos: bookOutPhotosObj,
        mileage: form.mileage,
        fuelLevel: form.fuelLevel,
        damageItems: form.damageItems.map(d => ({
          id: d.id,
          location: d.location,
          severity: d.severity,
          description: d.description,
        })),
        driverPresent: form.driverPresent,
      },
      photos: form.photos,
      signatureBlob: form.signatureBlob,
      vehicleReg: form.vehicleReg,
    })
  }, [form, step, draftChecked, submitSuccess, queuedOffline, autosave])

  // Restore draft handler
  function handleResumeDraft() {
    if (!draftLoaded) return
    const d = draftLoaded.formData as Record<string, unknown>
    const photosObj = (d.bookOutPhotos as Record<string, string>) || {}
    setForm({
      vehicleId: (d.vehicleId as string) || null,
      vehicleReg: (d.vehicleReg as string) || '',
      vehicleType: (d.vehicleType as string) || '',
      vehicleSimpleType: (d.vehicleSimpleType as string) || '',
      bookOutEventId: (d.bookOutEventId as string) || null,
      bookOutDate: (d.bookOutDate as string) || null,
      bookOutMileage: (d.bookOutMileage as number) || null,
      bookOutFuelLevel: (d.bookOutFuelLevel as string) || null,
      bookOutDriverName: (d.bookOutDriverName as string) || null,
      bookOutHireHopJob: (d.bookOutHireHopJob as string) || null,
      bookOutClientEmail: (d.bookOutClientEmail as string) || null,
      bookOutNotes: (d.bookOutNotes as string) || null,
      bookOutPhotos: new Map(Object.entries(photosObj)),
      mileage: (d.mileage as string) || '',
      fuelLevel: (d.fuelLevel as FuelLevel) || null,
      photos: draftLoaded.photos,
      damageItems: ((d.damageItems as DamageItem[]) || []).map(di => ({
        ...di,
        photos: [], // Damage photos can't be restored from draft
      })),
      driverPresent: (d.driverPresent as boolean) ?? true,
      signatureBlob: draftLoaded.signatureBlob,
    })
    setStep(draftLoaded.step)
    dismissDraft()
  }

  // Fetch driver hire forms for this job (for hire dates, insurance, etc.)
  const { data: hireForms } = useDriverHireForms(form.bookOutHireHopJob || null)

  const vehicles = useMemo(
    () => (allVehicles || []).filter(v => !v.isOldSold),
    [allVehicles],
  )

  const preSelectedId = searchParams.get('vehicle')
  const preSelectedVehicle = preSelectedId
    ? vehicles.find(v => v.id === preSelectedId)
    : null

  if (preSelectedVehicle && !form.vehicleId) {
    selectVehicle(preSelectedVehicle)
  }

  function selectVehicle(v: Vehicle) {
    setForm(f => ({
      ...f,
      vehicleId: v.id,
      vehicleReg: v.reg,
      vehicleType: v.vehicleType,
      vehicleSimpleType: v.simpleType,
    }))
  }

  function updateForm<K extends keyof CheckInFormState>(
    key: K,
    value: CheckInFormState[K],
  ) {
    setForm(f => ({ ...f, [key]: value }))
  }

  const handlePhotoCapture = useCallback((photo: CapturedPhoto) => {
    setForm(f => ({
      ...f,
      photos: [...f.photos.filter(p => p.angle !== photo.angle), photo],
    }))
  }, [])

  const handlePhotoRemove = useCallback((angle: string) => {
    setForm(f => ({
      ...f,
      photos: f.photos.filter(p => p.angle !== angle),
    }))
  }, [])

  const handleFlagDamage = useCallback((angle: string) => {
    // Pre-populate a damage item for this angle's location
    const locationMap: Record<string, string> = {
      front_left: 'Front Left',
      front_right: 'Front Right',
      rear_left: 'Rear Left',
      rear_right: 'Rear Right',
      windscreen: 'Windscreen',
      interior_front: 'Interior',
      interior_rear: 'Interior',
      dashboard: 'Dashboard',
    }
    const location = locationMap[angle] || 'Front Left'

    setForm(f => {
      // Copy the triggering check-in photo into the damage item
      const triggeringPhoto = f.photos.find(p => p.angle === angle)
      const damagePhotos: CapturedPhoto[] = triggeringPhoto
        ? [{
            ...triggeringPhoto,
            angle: 'damage',
            label: `Damage - ${location}`,
            timestamp: Date.now(),
          }]
        : []

      return {
        ...f,
        damageItems: [
          ...f.damageItems,
          {
            id: `dmg_${Date.now()}`,
            location,
            severity: 'Minor' as const,
            description: '',
            photos: damagePhotos,
          },
        ],
      }
    })
    // Jump to damage step
    setStep(4)
  }, [])

  // Fetch book-out data + check-in status when vehicle is selected
  useEffect(() => {
    if (!form.vehicleReg || form.bookOutEventId !== null) return

    let cancelled = false
    setBookOutLoading(true)
    setCheckInStatus(null)

    async function loadBookOut() {
      try {
        // Run both queries in parallel
        const [bookOut, ciStatus] = await Promise.all([
          fetchBookOutForVehicle(form.vehicleReg),
          checkAlreadyCheckedIn(form.vehicleReg),
        ])
        if (cancelled) return

        setCheckInStatus(ciStatus)

        if (bookOut) {
          // Fetch photos from R2 + collection data (if exists)
          const [photos, collection] = await Promise.all([
            fetchBookOutPhotos(bookOut.id, form.vehicleReg),
            bookOut.hireHopJob
              ? getCollection(form.vehicleReg, bookOut.hireHopJob)
              : Promise.resolve(null),
          ])
          if (cancelled) return

          if (collection) {
            setCollectionData(collection)
          }

          setForm(f => ({
            ...f,
            bookOutEventId: bookOut.id,
            bookOutDate: bookOut.eventDate,
            bookOutMileage: bookOut.mileage,
            bookOutFuelLevel: bookOut.fuelLevel,
            bookOutDriverName: bookOut.driverName,
            bookOutHireHopJob: bookOut.hireHopJob,
            bookOutClientEmail: bookOut.clientEmail,
            bookOutNotes: bookOut.notes,
            bookOutPhotos: photos,
          }))
        } else {
          setForm(f => ({ ...f, bookOutEventId: '' })) // Empty string = "looked but none found"
        }
      } catch (err) {
        console.error('Failed to load book-out data:', err)
        if (!cancelled) {
          setForm(f => ({ ...f, bookOutEventId: '' }))
        }
      } finally {
        if (!cancelled) setBookOutLoading(false)
      }
    }

    loadBookOut()
    return () => { cancelled = true }
  }, [form.vehicleReg, form.bookOutEventId])

  // Get selected vehicle for hire status guard
  const selectedVehicleObj = useMemo(
    () => form.vehicleId ? vehicles.find(v => v.id === form.vehicleId) : null,
    [form.vehicleId, vehicles],
  )

  const hireStatusBlocked = selectedVehicleObj
    ? selectedVehicleObj.hireStatus !== '' && selectedVehicleObj.hireStatus !== 'On Hire' && selectedVehicleObj.hireStatus !== 'Collected'
    : false

  function canAdvance(): boolean {
    switch (STEPS[step]) {
      case 'Select Vehicle':
        return !!form.vehicleId && !hireStatusBlocked
      case 'Review Book-Out':
        return !bookOutLoading && !checkInStatus?.alreadyCheckedIn
      case 'Current State': {
        if (form.mileage.trim().length === 0 || form.fuelLevel === null) return false
        // Block if mileage is lower than book-out mileage
        const enteredMileage = parseInt(form.mileage, 10)
        if (form.bookOutMileage != null && !isNaN(enteredMileage) && enteredMileage < form.bookOutMileage) return false
        return true
      }
      case 'Photos':
        return TESTING_MODE || form.photos.length >= REQUIRED_PHOTOS.length
      case 'Damage Report':
        return true // Optional step
      case 'Confirm':
        return true
      default:
        return false
    }
  }

  async function handleSubmit() {
    setIsSubmitting(true)
    setUploadProgress(null)
    setOpResults([])

    try {
    const results: OpResult[] = []
    const mileageNum = parseInt(form.mileage, 10)

    // Total miles: book-out to base (full journey)
    const mileageDiff = form.bookOutMileage && !isNaN(mileageNum)
      ? mileageNum - form.bookOutMileage
      : null

    // Client-chargeable miles: book-out to collection (if collection data exists)
    // The drive from collection point back to base is not the client's responsibility
    const clientMilesDriven = collectionData && form.bookOutMileage
      ? collectionData.mileage - form.bookOutMileage
      : mileageDiff

    // ── Step 1: Create Monday.com Check In event ──
    setUploadProgress('Creating check-in event...')

    const eventResult = await withRetry(
      () =>
        createVehicleEvent({
          vehicleReg: form.vehicleReg,
          eventType: 'Check In',
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: form.fuelLevel,
          details: [
            form.bookOutDriverName ? `Returning driver: ${form.bookOutDriverName}` : null,
            form.bookOutHireHopJob ? `HireHop Job: ${form.bookOutHireHopJob}` : null,
            mileageDiff != null ? `Total miles (book-out to base): ${mileageDiff.toLocaleString()}` : null,
            collectionData ? `Client miles (book-out to collection): ${clientMilesDriven?.toLocaleString() ?? '?'}` : null,
            collectionData ? `Collection fuel: ${collectionData.fuelLevel} (by ${collectionData.collectedBy})` : null,
            `Photos: ${form.photos.length} captured`,
            form.damageItems.length > 0 ? `Damage items: ${form.damageItems.length}` : 'No new damage',
            !form.driverPresent ? 'Driver not present at check-in' : null,
          ]
            .filter(Boolean)
            .join('\n'),
          hireHopJob: form.bookOutHireHopJob || null,
          clientEmail: form.bookOutClientEmail || null,
          hireStatus: 'Prep Needed',
        }),
      'R2 event creation',
    )

    const eventId = eventResult.data?.id || `local_${Date.now()}`

    if (eventResult.success && !eventResult.data?.error) {
      results.push({ label: 'Event saved', success: true, detail: `Event ${eventId}` })
    } else {
      results.push({
        label: 'Event saved',
        success: false,
        detail: eventResult.data?.error || eventResult.error || 'Failed after 3 attempts',
      })
    }

    // ── Step 1b: Update Fleet Master status to "Prep Needed" ──
    if (form.vehicleId) {
      const fleetResult = await updateFleetHireStatus(form.vehicleId, 'Prep Needed')
      if (fleetResult.success) {
        results.push({ label: 'Fleet status', success: true, detail: 'Set to Prep Needed' })
      } else {
        results.push({ label: 'Fleet status', success: false, detail: fleetResult.error || 'Update failed' })
      }
    }

    // ── Step 2: Upload check-in photos to R2 ──
    if (form.photos.length > 0) {
      setUploadProgress(`Uploading photos (0/${form.photos.length})...`)
      const uploadResult = await withRetry(
        () =>
          uploadAllPhotos(
            form.photos,
            eventId,
            form.vehicleReg,
            (completed, total) => {
              setUploadProgress(`Uploading photos (${completed}/${total})...`)
            },
          ),
        'Photo upload to R2',
      )

      if (uploadResult.success && uploadResult.data) {
        const { uploadedCount, failedCount } = uploadResult.data
        if (failedCount === 0) {
          results.push({ label: 'Photo upload', success: true, detail: `${uploadedCount} photos uploaded` })
        } else {
          results.push({ label: 'Photo upload', success: false, detail: `${uploadedCount} uploaded, ${failedCount} failed` })
        }
      } else {
        results.push({ label: 'Photo upload', success: false, detail: uploadResult.error || 'Upload failed' })
      }
    }

    // ── Step 2b: Upload damage photos to R2 ──
    const hasDamagePhotos = form.damageItems.some(d => d.photos.length > 0)
    if (hasDamagePhotos) {
      setUploadProgress('Uploading damage photos...')
      const dmgUpload = await withRetry(
        () => uploadDamagePhotos(
          form.damageItems,
          eventId,
          form.vehicleReg,
          (completed, total) => {
            setUploadProgress(`Uploading damage photos (${completed}/${total})...`)
          },
        ),
        'Damage photo upload',
      )

      if (dmgUpload.success && dmgUpload.data) {
        const { uploadedCount, failedCount } = dmgUpload.data
        if (failedCount === 0 && uploadedCount > 0) {
          results.push({ label: 'Damage photos', success: true, detail: `${uploadedCount} uploaded` })
        } else if (failedCount > 0) {
          results.push({ label: 'Damage photos', success: false, detail: `${uploadedCount} uploaded, ${failedCount} failed` })
        }
      }
    }

    // ── Step 3: Create issues for damage items (Monday.com + R2) ──
    if (form.damageItems.length > 0) {
      setUploadProgress('Creating damage issues...')
      let issuesCreated = 0
      let issuesFailed = 0
      const checkInVehicle = vehicles.find(v => v.id === form.vehicleId)

      // Try to capture Traccar GPS location for the damage issues
      let issueLocation: IssueLocation | null = null
      try {
        const device = await findDeviceByReg(form.vehicleReg)
        if (device) {
          const positions = await getPositions(device.id)
          if (positions.length > 0) {
            const pos = positions[0]!
            issueLocation = {
              lat: pos.latitude,
              lng: pos.longitude,
              speed: knotsToMph(pos.speed),
              ignition: pos.attributes?.ignition,
              capturedAt: pos.fixTime,
            }
          }
        }
      } catch (err) {
        console.warn('[check-in] Failed to fetch Traccar location for issues:', err)
      }

      for (const damage of form.damageItems) {
        if (!damage.description.trim()) continue

        // R2 (source of truth for issues tracker)
        try {
          const r2Issue = {
            id: crypto.randomUUID(),
            vehicleReg: form.vehicleReg,
            vehicleId: form.vehicleId || '',
            vehicleMake: checkInVehicle?.make || '',
            vehicleModel: checkInVehicle?.model || '',
            vehicleType: checkInVehicle?.simpleType || form.vehicleSimpleType || '',
            mileageAtReport: form.mileage ? parseInt(form.mileage, 10) : null,
            hireHopJob: form.bookOutHireHopJob || null,
            location: issueLocation,
            category: 'Bodywork' as const,
            component: 'Bodywork panels' as const,
            severity: damage.severity === 'Critical' ? 'Critical' as const : damage.severity === 'Major' ? 'High' as const : 'Medium' as const,
            summary: `${damage.location}: ${damage.description}`.slice(0, 100),
            status: 'Open' as const,
            reportedBy: 'Check-in',
            reportedAt: new Date().toISOString(),
            reportedDuring: 'Check-in' as const,
            resolvedAt: null,
            photos: [] as string[],
            activity: [{
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              author: 'Check-in',
              action: 'Reported',
              note: damage.description,
            }],
          }
          const saveResult = await saveIssue(r2Issue)
          if (saveResult.success) {
            issuesCreated++
          } else {
            issuesFailed++
          }
        } catch (err) {
          issuesFailed++
          console.warn(`[check-in] Failed to save issue for ${damage.location}:`, err)
        }
      }

      if (issuesCreated > 0) {
        results.push({ label: 'Issues created', success: issuesFailed === 0, detail: `${issuesCreated} damage issue(s)${issuesFailed > 0 ? `, ${issuesFailed} failed` : ''}` })
      }
    }

    // ── Step 4: Generate check-in PDF ──
    setUploadProgress('Generating PDF...')
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()
    const selectedVehicle = vehicles.find(v => v.id === form.vehicleId)

    // Resize photos to thumbnails for PDF embedding (keeps payload under Netlify 6MB limit)
    const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
    const safeReg = form.vehicleReg.replace(/\s+/g, '-').toUpperCase()
    setUploadProgress('Preparing photos for PDF...')
    const photoResizePromises = form.photos.map(async (p) => {
      try {
        const base64 = await resizeImageForPdf(p.blob)
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        return { angle: p.angle, label: p.label, base64, r2Url }
      } catch {
        console.warn('Failed to resize photo for PDF:', p.angle)
        return null
      }
    })
    const photoBase64s = (await Promise.all(photoResizePromises)).filter(
      (p) => p !== null,
    ) as Array<{ angle: string; label: string; base64: string; r2Url?: string }>

    // Grab signature (only if driver is present)
    let signatureBase64: string | undefined
    if (form.driverPresent) {
      try {
        const sigBlob = await signatureRef.current?.getBlob()
        if (sigBlob) {
          signatureBase64 = await blobToBase64(sigBlob)
        }
      } catch {
        console.warn('Failed to convert signature to base64')
      }
    }

    // Convert damage item photos to resized base64 for PDF
    const damageItemsWithBase64 = await Promise.all(form.damageItems.map(async d => {
      const dmgPhotos: Array<{ base64: string; r2Url?: string }> = []
      for (const dp of d.photos) {
        try {
          const b64 = await resizeImageForPdf(dp.blob)
          dmgPhotos.push({ base64: b64 })
        } catch {
          console.warn('Failed to resize damage photo for PDF')
        }
      }
      return {
        location: d.location,
        severity: d.severity,
        description: d.description,
        photos: dmgPhotos,
      }
    }))

    const pdfResult = await withRetry(
      () =>
        generateConditionReportPdf({
          vehicleReg: form.vehicleReg,
          vehicleType: form.vehicleType,
          vehicleMake: selectedVehicle?.make,
          vehicleModel: selectedVehicle?.model,
          vehicleColour: selectedVehicle?.colour,
          driverName: form.bookOutDriverName || 'Unknown',
          clientEmail: form.bookOutClientEmail || undefined,
          hireHopJob: form.bookOutHireHopJob || undefined,
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: form.fuelLevel,
          eventDate,
          eventDateTime,
          photos: photoBase64s,
          briefingItems: [],
          signatureBase64,
          // Hire form data
          hireStartDate: hireForms?.[0]?.hireStart || undefined,
          hireEndDate: hireForms?.[0]?.hireEnd || undefined,
          allDrivers: hireForms?.map(hf => hf.driverName).filter(Boolean),
          // Check-in specific fields
          isCheckIn: true,
          bookOutMileage: form.bookOutMileage,
          bookOutFuelLevel: form.bookOutFuelLevel,
          bookOutDate: form.bookOutDate,
          driverPresent: form.driverPresent,
          damageItems: damageItemsWithBase64,
        }),
      'PDF generation',
    )

    if (pdfResult.success && pdfResult.data) {
      results.push({
        label: 'PDF report',
        success: true,
        detail: `${pdfResult.data.filename} (${Math.round(pdfResult.data.size / 1024)}KB)`,
      })
    } else {
      results.push({
        label: 'PDF report',
        success: false,
        detail: pdfResult.error || 'Generation failed',
      })
    }

    // ── Step 5: Send email ──
    const emailTo = form.bookOutClientEmail
    if (emailTo && pdfResult.success && pdfResult.data) {
      setUploadProgress('Sending email...')
      // Calculate fuel difference for email alert
      // When collection data exists, use collection fuel for client charge comparison
      // (the drive from collection point to base uses fuel that's not the client's responsibility)
      const clientFuelRef = collectionData?.fuelLevel || form.bookOutFuelLevel
      const clientFuelLabel = collectionData ? 'collection' : 'book-out'
      const fuelDiff = clientFuelRef && form.fuelLevel && clientFuelRef !== form.fuelLevel
        ? `${clientFuelRef} (${clientFuelLabel}) -> ${form.fuelLevel} (base)`
        : null

      const emailResult = await withRetry(
        () =>
          sendConditionReportEmail({
            to: emailTo,
            vehicleReg: form.vehicleReg,
            driverName: form.bookOutDriverName || 'Driver',
            eventDate,
            pdfBase64: pdfResult.data!.pdf,
            pdfFilename: pdfResult.data!.filename,
            isCheckIn: true,
            driverPresent: form.driverPresent,
            damageCount: form.damageItems.length,
            fuelDifference: fuelDiff,
            milesDriven: clientMilesDriven,
          }),
        'Email sending',
      )

      if (emailResult.success) {
        results.push({ label: 'Email sent', success: true, detail: `Sent to ${emailTo}` })
      } else {
        results.push({ label: 'Email sent', success: false, detail: emailResult.error || 'Failed' })
      }
    }

    // ── Step 6: Remove allocation from R2 (non-blocking) ──
    if (form.bookOutHireHopJob) {
      try {
        const jobId = parseInt(form.bookOutHireHopJob, 10)
        if (!isNaN(jobId)) {
          const currentAllocations = await getAllocations()
          const filtered = currentAllocations.filter(
            a => !(a.hireHopJobId === jobId && a.vehicleReg === form.vehicleReg),
          )
          if (filtered.length < currentAllocations.length) {
            await saveAllocations(filtered)
            results.push({
              label: 'Allocation cleared',
              success: true,
              detail: `Removed allocation for job #${jobId}`,
            })
          }
        }
      } catch (err) {
        console.warn('[check-in] Allocation removal failed:', err)
        results.push({
          label: 'Allocation cleared',
          success: false,
          detail: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    // ── Step 7: Return vehicle in HireHop (barcode check-in) ──
    if (form.bookOutHireHopJob) {
      const hhJobId = parseInt(form.bookOutHireHopJob, 10)
      if (!isNaN(hhJobId) && hhJobId > 0) {
        setUploadProgress('Returning vehicle in HireHop...')
        const hhResult = await barcodeCheckin(hhJobId, form.vehicleReg)
        if (hhResult.success) {
          results.push({ label: 'HireHop return', success: true, detail: `Vehicle returned on job #${hhJobId}` })
        } else {
          results.push({ label: 'HireHop return', success: false, detail: hhResult.error || 'Check-in failed' })
        }
      }
    }

    // ── Step 8: Send CO2 offset follow-up email ──
    // Sent immediately after check-in (previously used setTimeout which was
    // unreliable — browser navigation/tab close would kill the timer)
    // Use client miles for CO2 (not including return drive to base)
    const co2Miles = clientMilesDriven ?? mileageDiff
    if (emailTo && co2Miles != null && co2Miles > 0 && selectedVehicle?.co2PerKm) {
      setUploadProgress('Sending CO2 offset email...')
      try {
        const resp = await apiFetch('/send-co2-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: emailTo,
            vehicleReg: form.vehicleReg,
            totalMiles: co2Miles,
            co2PerKm: selectedVehicle.co2PerKm,
          }),
        })
        if (resp.ok) {
          console.log('[check-in] CO2 offset email sent successfully')
          results.push({ label: 'CO2 offset email', success: true, detail: `Sent to ${emailTo}` })
        } else {
          const errText = await resp.text()
          console.warn('[check-in] CO2 offset email failed:', errText)
          results.push({ label: 'CO2 offset email', success: false, detail: errText })
        }
      } catch (err) {
        console.warn('[check-in] CO2 offset email error:', err)
        results.push({
          label: 'CO2 offset email',
          success: false,
          detail: err instanceof Error ? err.message : 'Send failed',
        })
      }
    }

    setOpResults(results)
    setUploadProgress(null)
    setIsSubmitting(false)
    setSubmitSuccess(true)
    clearAutosave()
    } catch (err) {
      console.error('[check-in] handleSubmit crashed:', err)

      if (!navigator.onLine) {
        try {
          await queueSubmission({
            flowType: 'check-in',
            formData: {
              vehicleId: form.vehicleId,
              vehicleReg: form.vehicleReg,
              vehicleType: form.vehicleType,
              vehicleSimpleType: form.vehicleSimpleType,
              bookOutEventId: form.bookOutEventId,
              bookOutMileage: form.bookOutMileage,
              bookOutFuelLevel: form.bookOutFuelLevel,
              bookOutDriverName: form.bookOutDriverName,
              bookOutHireHopJob: form.bookOutHireHopJob,
              bookOutClientEmail: form.bookOutClientEmail,
              mileage: form.mileage,
              fuelLevel: form.fuelLevel,
              damageItems: form.damageItems.map(d => ({
                id: d.id,
                location: d.location,
                severity: d.severity,
                description: d.description,
              })),
              driverPresent: form.driverPresent,
            },
            photos: form.photos,
            signatureBlob: form.signatureBlob,
            vehicleReg: form.vehicleReg,
          })
          clearAutosave()
          setUploadProgress(null)
          setIsSubmitting(false)
          setQueuedOffline(true)
          return
        } catch (queueErr) {
          console.error('[check-in] Failed to queue offline:', queueErr)
        }
      }

      setUploadProgress(null)
      setIsSubmitting(false)
    }
  }

  // Queued offline screen
  if (queuedOffline) {
    return (
      <div className="space-y-6 px-4 py-6">
        <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
            <svg className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-blue-900">Saved for Sync</h2>
          <p className="mt-1 text-sm text-blue-700">
            {form.vehicleReg} check-in has been saved and will be submitted automatically when you&apos;re back online.
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            to={vmPath('/')}
            className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    )
  }

  // Draft resume prompt
  if (draftLoaded && draftChecked && !submitSuccess) {
    return (
      <DraftResumePrompt
        vehicleReg={draftLoaded.vehicleReg}
        savedAt={draftLoaded.savedAt}
        photoCount={draftLoaded.photos.length}
        step={draftLoaded.step}
        totalSteps={STEPS.length}
        onResume={handleResumeDraft}
        onDiscard={dismissDraft}
      />
    )
  }

  // Success screen
  if (submitSuccess) {
    const allOk = opResults.every(r => r.success)
    const anyFailed = opResults.some(r => !r.success)

    return (
      <div className="space-y-6 px-4 py-6">
        <div className={`rounded-lg border p-6 text-center ${
          allOk ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
        }`}>
          <div className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${
            allOk ? 'bg-green-100' : 'bg-amber-100'
          }`}>
            {allOk ? (
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            )}
          </div>
          <h2 className={`text-lg font-semibold ${allOk ? 'text-green-900' : 'text-amber-900'}`}>
            {allOk ? 'Check-In Complete' : 'Check-In Completed with Issues'}
          </h2>
          <p className={`mt-1 text-sm ${allOk ? 'text-green-700' : 'text-amber-700'}`}>
            {form.vehicleReg} checked in
          </p>
        </div>

        {opResults.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Operation Status</p>
            {opResults.map((r, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 rounded-lg border p-3 ${
                  r.success ? 'border-green-100 bg-green-50/50' : 'border-red-100 bg-red-50/50'
                }`}
              >
                {r.success ? (
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                )}
                <div>
                  <p className={`text-sm font-medium ${r.success ? 'text-green-800' : 'text-red-800'}`}>
                    {r.label}
                  </p>
                  {r.detail && (
                    <p className={`text-xs ${r.success ? 'text-green-600' : 'text-red-600'}`}>
                      {r.detail}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {anyFailed && (
              <p className="text-xs text-gray-400 text-center mt-2">
                Failed operations were retried 3 times.
              </p>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <button
            onClick={() => {
              setForm(INITIAL_FORM)
              setStep(0)
              setSubmitSuccess(false)
              setOpResults([])
            }}
            className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700"
          >
            New Check-In
          </button>
          <Link
            to={vmPath('/vehicles')}
            className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-center text-sm font-medium text-white"
          >
            Back to Fleet
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      {/* Header with progress */}
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <Link to={vmPath('/vehicles')} className="text-sm text-gray-500 hover:text-gray-700">
            &larr; Cancel
          </Link>
          <h1 className="text-base font-semibold text-ooosh-navy">Check In</h1>
          <span className="text-xs text-gray-400">
            {step + 1} / {STEPS.length}
          </span>
        </div>

        <div className="mt-2 flex gap-1">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-ooosh-navy' : 'bg-gray-200'
              }`}
            />
          ))}
        </div>

        <div className="mt-1.5 flex items-center justify-between">
          <p className="text-xs font-medium text-gray-500">{STEPS[step]}</p>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 active:bg-gray-50"
              >
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canAdvance()}
                className={`rounded-md px-3 py-1 text-xs font-medium text-white transition-colors ${
                  canAdvance()
                    ? 'bg-ooosh-navy active:bg-opacity-90'
                    : 'bg-gray-300 cursor-not-allowed'
                }`}
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white active:bg-green-700 disabled:bg-gray-300"
              >
                {isSubmitting ? (uploadProgress ? 'Processing...' : 'Saving...') : 'Complete'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {STEPS[step] === 'Select Vehicle' && (
          <StepSelectVehicle
            vehicles={vehicles}
            loading={vehiclesLoading}
            search={vehicleSearch}
            onSearchChange={setVehicleSearch}
            selectedId={form.vehicleId}
            onSelect={(v) => {
              selectVehicle(v)
              setStep(1)
            }}
            hireStatusBlocked={hireStatusBlocked}
            hireStatus={selectedVehicleObj?.hireStatus || ''}
          />
        )}

        {STEPS[step] === 'Review Book-Out' && (
          <StepReviewBookOut form={form} loading={bookOutLoading} checkInStatus={checkInStatus} hireForms={hireForms || []} collectionData={collectionData} />
        )}

        {STEPS[step] === 'Current State' && (
          <StepCurrentState form={form} onUpdate={updateForm} />
        )}

        {STEPS[step] === 'Photos' && (
          <PhotoComparison
            bookOutPhotos={form.bookOutPhotos}
            currentPhotos={form.photos}
            onCapture={handlePhotoCapture}
            onRemove={handlePhotoRemove}
            onFlagDamage={handleFlagDamage}
          />
        )}

        {STEPS[step] === 'Damage Report' && (
          <StepDamageReport
            items={form.damageItems}
            onChange={(items) => updateForm('damageItems', items)}
          />
        )}

        {STEPS[step] === 'Confirm' && (
          <StepConfirm
            form={form}
            signatureRef={signatureRef}
            driverPresent={form.driverPresent}
            onDriverPresentChange={(v) => updateForm('driverPresent', v)}
          />
        )}
      </div>

      {/* Navigation footer */}
      <div className="border-t border-gray-200 bg-white px-4 py-3">
        <div className="flex gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700 active:bg-gray-50"
            >
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance()}
              className={`flex-1 rounded-lg py-2.5 text-sm font-medium text-white transition-colors ${
                canAdvance()
                  ? 'bg-ooosh-navy active:bg-opacity-90'
                  : 'bg-gray-300 cursor-not-allowed'
              }`}
            >
              {STEPS[step] === 'Damage Report' && form.damageItems.length === 0
                ? 'Skip (No Damage)'
                : 'Next'}
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-medium text-white active:bg-green-700 disabled:bg-gray-300"
            >
              {isSubmitting ? (uploadProgress || 'Saving...') : 'Complete Check-In'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 1: Select Vehicle
 * ────────────────────────────────────────────── */

function StepSelectVehicle({
  vehicles,
  loading,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  hireStatusBlocked,
  hireStatus,
}: {
  vehicles: Vehicle[]
  loading: boolean
  search: string
  onSearchChange: (v: string) => void
  selectedId: string | null
  onSelect: (v: Vehicle) => void
  hireStatusBlocked: boolean
  hireStatus: string
}) {
  // Filter by search, then sort "On Hire" vehicles to the top
  const filtered = vehicles.filter(v => {
    if (!search) return true
    const term = search.toLowerCase()
    return `${v.reg} ${v.make} ${v.model} ${v.vehicleType}`.toLowerCase().includes(term)
  }).sort((a, b) => {
    const checkInStatuses = ['On Hire', 'Collected']
    const aOnHire = checkInStatuses.includes(a.hireStatus) ? 0 : 1
    const bOnHire = checkInStatuses.includes(b.hireStatus) ? 0 : 1
    return aOnHire - bOnHire
  })

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-100" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="Search by reg, make, model..."
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
        autoFocus
      />

      {/* Hire status warning */}
      {hireStatusBlocked && selectedId && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex gap-2">
            <svg className="h-5 w-5 shrink-0 text-amber-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">
                Vehicle status: {hireStatus}
              </p>
              <p className="mt-0.5 text-xs text-amber-600">
                Only vehicles currently &ldquo;On Hire&rdquo; or &ldquo;Collected&rdquo; can be checked in.
                This vehicle&rsquo;s status needs to change before it can be checked in.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(v => (
          <button
            key={v.id}
            onClick={() => onSelect(v)}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
              selectedId === v.id
                ? 'border-ooosh-navy bg-ooosh-navy/5 ring-1 ring-ooosh-navy'
                : 'border-gray-200 bg-white hover:border-gray-300 active:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
                <span className="ml-2 text-xs text-gray-400">{v.simpleType}</span>
                {v.hireStatus && (
                  <span className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    v.hireStatus === 'On Hire'
                      ? 'bg-blue-100 text-blue-700'
                      : v.hireStatus === 'Collected'
                        ? 'bg-purple-100 text-purple-700'
                        : v.hireStatus === 'Available'
                          ? 'bg-green-100 text-green-700'
                          : v.hireStatus === 'Prep Needed'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-gray-100 text-gray-600'
                  }`}>
                    {v.hireStatus}
                  </span>
                )}
              </div>
              {selectedId === v.id && (
                <svg className="h-5 w-5 text-ooosh-navy" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {v.make} {v.model && `· ${v.model}`} {v.colour && `· ${v.colour}`}
            </p>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-400">No vehicles found</p>
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 2: Review Book-Out State
 * ────────────────────────────────────────────── */

function StepReviewBookOut({
  form,
  loading,
  checkInStatus,
  hireForms,
  collectionData,
}: {
  form: CheckInFormState
  loading: boolean
  checkInStatus: CheckInStatus | null
  hireForms: import('../lib/driver-hire-api').DriverHireForm[]
  collectionData: CollectionData | null
}) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)

  if (loading) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Loading Book-Out Data...</h3>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      </div>
    )
  }

  if (!form.bookOutEventId) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Book-Out Data</h3>
        {checkInStatus?.alreadyCheckedIn && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <div className="flex gap-2">
              <svg className="h-5 w-5 shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">Already checked in</p>
                <p className="mt-0.5 text-xs text-red-600">
                  This vehicle was checked in on {checkInStatus.checkInDate || 'a recent date'}.
                  It cannot be checked in again until it is booked out.
                </p>
              </div>
            </div>
          </div>
        )}
        <div className="rounded-lg bg-amber-50 p-4 text-center">
          <p className="text-sm font-medium text-amber-800">No book-out record found</p>
          <p className="mt-1 text-xs text-amber-600">
            No previous book-out event was found for {form.vehicleReg}. You can still proceed with the check-in.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800">Book-Out Summary</h3>

      {/* Already checked in — blocking error */}
      {checkInStatus?.alreadyCheckedIn && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <div className="flex gap-2">
            <svg className="h-5 w-5 shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-800">Already checked in</p>
              <p className="mt-0.5 text-xs text-red-600">
                This vehicle was checked in on {checkInStatus.checkInDate || 'a recent date'}.
                It cannot be checked in again until it is booked out.
              </p>
            </div>
          </div>
        </div>
      )}

      {!checkInStatus?.alreadyCheckedIn && (
        <div className="rounded-lg bg-blue-50 p-3">
          <p className="text-xs font-medium text-blue-800">
            Reviewing data from the most recent book-out
          </p>
        </div>
      )}

      <div className="space-y-3">
        <SummaryRow label="Vehicle" value={`${form.vehicleReg} - ${form.vehicleType}`} />
        {form.bookOutDate && <SummaryRow label="Book-Out Date" value={form.bookOutDate} />}
        {form.bookOutDriverName && <SummaryRow label="Driver" value={form.bookOutDriverName} />}
        {form.bookOutHireHopJob && <SummaryRow label="HireHop Job" value={`#${form.bookOutHireHopJob}`} />}
        {hireForms.length > 0 && hireForms[0]?.hireStart && (
          <SummaryRow label="Hire Period" value={`${hireForms[0].hireStart} — ${hireForms[0]?.hireEnd || '?'}`} />
        )}
        {hireForms.length > 1 && (
          <SummaryRow label="All Drivers" value={hireForms.map(hf => hf.driverName).join(', ')} />
        )}
        <SummaryRow
          label="Mileage Out"
          value={form.bookOutMileage != null ? `${form.bookOutMileage.toLocaleString()} mi` : '-'}
        />
        <SummaryRow label="Fuel Out" value={form.bookOutFuelLevel || '-'} />
      </div>

      {/* Book-out notes */}
      {form.bookOutNotes && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
          <p className="text-xs font-medium text-blue-700 mb-1">Book-Out Notes</p>
          <p className="text-sm text-blue-900 whitespace-pre-wrap">{form.bookOutNotes}</p>
        </div>
      )}

      {/* Book-out photo thumbnails */}
      {form.bookOutPhotos.size > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-gray-500">Book-Out Photos</p>
          <div className="flex flex-wrap gap-2">
            {Array.from(form.bookOutPhotos.entries()).map(([angle, url]) => (
              <img
                key={angle}
                src={url}
                alt={angle}
                className="h-14 w-14 cursor-pointer rounded border border-gray-200 object-cover"
                loading="lazy"
                onClick={() => setLightbox({ src: url, alt: `Book-out: ${angle}` })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Collection data (if freelancer collected) */}
      {collectionData && (
        <div className="rounded-lg border-2 border-purple-200 bg-purple-50 p-4">
          <p className="text-xs font-semibold text-purple-800 uppercase mb-2">
            Freelancer Collection Report
          </p>
          <div className="space-y-1 text-sm">
            <SummaryRow label="Collected By" value={collectionData.collectedBy} />
            <SummaryRow label="Collection Date" value={new Date(collectionData.collectedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} />
            <SummaryRow label="Mileage at Collection" value={`${collectionData.mileage.toLocaleString()} mi`} />
            <SummaryRow label="Fuel at Collection" value={collectionData.fuelLevel} />
          </div>
          {collectionData.damageNotes && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2">
              <p className="text-xs font-medium text-amber-700">Client / Driver Notes</p>
              <p className="text-sm text-amber-900 whitespace-pre-wrap">{collectionData.damageNotes}</p>
            </div>
          )}
          <p className="mt-2 text-xs text-purple-600">
            Fuel charges will be calculated against the collection reading ({collectionData.fuelLevel}), not the base reading.
          </p>
        </div>
      )}

      {lightbox && (
        <PhotoLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 3: Current Vehicle State
 * ────────────────────────────────────────────── */

function StepCurrentState({
  form,
  onUpdate,
}: {
  form: CheckInFormState
  onUpdate: <K extends keyof CheckInFormState>(key: K, value: CheckInFormState[K]) => void
}) {
  const currentMileage = parseInt(form.mileage, 10)
  const mileageDiff = form.bookOutMileage && !isNaN(currentMileage)
    ? currentMileage - form.bookOutMileage
    : null

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Current Mileage <span className="text-red-500">*</span>
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={form.mileage}
          onChange={e => onUpdate('mileage', e.target.value)}
          placeholder="Current odometer reading"
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
          autoFocus
        />
        {/* Comparison with book-out */}
        {form.bookOutMileage != null && (
          <div className="mt-1.5 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-400">
                Book-out: {form.bookOutMileage.toLocaleString()} mi
              </span>
              {mileageDiff != null && mileageDiff >= 0 && (
                <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">
                  +{mileageDiff.toLocaleString()} mi driven
                </span>
              )}
            </div>
            {mileageDiff != null && mileageDiff < 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-2">
                <p className="text-xs font-medium text-red-700">
                  Mileage cannot be lower than book-out ({form.bookOutMileage.toLocaleString()} mi)
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Current Fuel Level <span className="text-red-500">*</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          {FUEL_LEVELS.map(level => (
            <button
              key={level}
              onClick={() => onUpdate('fuelLevel', level as FuelLevel)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                form.fuelLevel === level
                  ? 'border-ooosh-navy bg-ooosh-navy/5 text-ooosh-navy ring-1 ring-ooosh-navy'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
        {/* Comparison with book-out */}
        {form.bookOutFuelLevel && (
          <p className="mt-1.5 text-xs text-gray-400">
            Book-out fuel: {form.bookOutFuelLevel}
            {form.fuelLevel && form.fuelLevel !== form.bookOutFuelLevel && (
              <span className="ml-1 font-medium text-amber-600">
                (changed)
              </span>
            )}
          </p>
        )}
        {form.fuelLevel && (
          <div className="mt-3 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-3 rounded-full transition-all duration-300"
              style={{
                width: `${(FUEL_LEVELS.indexOf(form.fuelLevel) / (FUEL_LEVELS.length - 1)) * 100}%`,
                backgroundColor:
                  FUEL_LEVELS.indexOf(form.fuelLevel) <= 2
                    ? '#ef4444'
                    : FUEL_LEVELS.indexOf(form.fuelLevel) <= 4
                      ? '#f59e0b'
                      : '#22c55e',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 5: Damage Report
 * ────────────────────────────────────────────── */

function StepDamageReport({
  items,
  onChange,
}: {
  items: DamageItem[]
  onChange: (items: DamageItem[]) => void
}) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const fileInputRefs = useRef<Map<string, HTMLInputElement>>(new Map())

  const addItem = () => {
    onChange([
      ...items,
      {
        id: `dmg_${Date.now()}`,
        location: 'Front Left',
        severity: 'Minor',
        description: '',
        photos: [],
      },
    ])
  }

  const updateItem = (id: string, updates: Partial<DamageItem>) => {
    onChange(items.map(item => item.id === id ? { ...item, ...updates } : item))
  }

  const removeItem = (id: string) => {
    onChange(items.filter(item => item.id !== id))
  }

  const handleDamagePhotoCapture = async (damageId: string, file: File) => {
    const { compressImage } = await import('../lib/image-utils')
    const compressed = await compressImage(file, 1024, 0.7)
    const blobUrl = URL.createObjectURL(compressed)
    const newPhoto: CapturedPhoto = {
      angle: 'damage',
      label: `Damage photo`,
      blobUrl,
      blob: compressed,
      timestamp: Date.now(),
    }
    onChange(items.map(item =>
      item.id === damageId
        ? { ...item, photos: [...item.photos, newPhoto] }
        : item,
    ))
  }

  const removeDamagePhoto = (damageId: string, photoIdx: number) => {
    onChange(items.map(item =>
      item.id === damageId
        ? { ...item, photos: item.photos.filter((_, i) => i !== photoIdx) }
        : item,
    ))
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800">Damage Report</h3>

      {items.length === 0 && (
        <div className="rounded-lg bg-green-50 p-4 text-center">
          <p className="text-sm font-medium text-green-800">No damage flagged</p>
          <p className="mt-1 text-xs text-green-600">
            You can add damage items below or skip this step
          </p>
        </div>
      )}

      {items.map((item, index) => (
        <div key={item.id} className="rounded-lg border border-gray-200 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">Damage #{index + 1}</span>
            <button
              onClick={() => removeItem(item.id)}
              className="text-xs font-medium text-red-500 active:text-red-700"
            >
              Remove
            </button>
          </div>

          {/* Location */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Location</label>
            <select
              value={item.location}
              onChange={e => updateItem(item.id, { location: e.target.value })}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
            >
              {DAMAGE_LOCATIONS.map(loc => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>

          {/* Severity */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Severity</label>
            <div className="grid grid-cols-3 gap-2">
              {(['Minor', 'Major', 'Critical'] as const).map(sev => (
                <button
                  key={sev}
                  onClick={() => updateItem(item.id, { severity: sev })}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    item.severity === sev
                      ? sev === 'Critical'
                        ? 'border-red-500 bg-red-50 text-red-700 ring-1 ring-red-500'
                        : sev === 'Major'
                          ? 'border-amber-500 bg-amber-50 text-amber-700 ring-1 ring-amber-500'
                          : 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-500'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Description</label>
            <textarea
              value={item.description}
              onChange={e => updateItem(item.id, { description: e.target.value })}
              placeholder="Describe the damage..."
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
            />
          </div>

          {/* Damage Photos */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-600">Photos</label>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {item.photos.map((photo, pi) => (
                <div key={pi} className="relative shrink-0">
                  <img
                    src={photo.blobUrl}
                    alt={`Damage ${index + 1} photo ${pi + 1}`}
                    className="h-16 w-16 cursor-pointer rounded border border-gray-200 object-cover"
                    onClick={() => setLightbox({ src: photo.blobUrl, alt: `Damage ${index + 1} photo ${pi + 1}` })}
                  />
                  <button
                    onClick={() => removeDamagePhoto(item.id, pi)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {/* Add photo button */}
              <button
                onClick={() => {
                  const input = fileInputRefs.current.get(item.id)
                  input?.click()
                }}
                className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded border-2 border-dashed border-gray-300 bg-gray-50 active:bg-gray-100"
              >
                <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-[8px] font-medium text-gray-400">Add</span>
              </button>
              <input
                ref={el => {
                  if (el) fileInputRefs.current.set(item.id, el)
                }}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={async e => {
                  const file = e.target.files?.[0]
                  if (file) {
                    await handleDamagePhotoCapture(item.id, file)
                    e.target.value = ''
                  }
                }}
              />
            </div>
          </div>
        </div>
      ))}

      <button
        onClick={addItem}
        className="w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-center text-xs font-medium text-gray-500 active:bg-gray-50"
      >
        + Add Damage Item
      </button>

      {lightbox && (
        <PhotoLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 6: Confirm & Submit
 * ────────────────────────────────────────────── */

function StepConfirm({
  form,
  signatureRef,
  driverPresent,
  onDriverPresentChange,
}: {
  form: CheckInFormState
  signatureRef: React.RefObject<SignatureCaptureHandle | null>
  driverPresent: boolean
  onDriverPresentChange: (value: boolean) => void
}) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const currentMileage = parseInt(form.mileage, 10)
  const mileageDiff = form.bookOutMileage && !isNaN(currentMileage)
    ? currentMileage - form.bookOutMileage
    : null

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800">Review Check-In</h3>

      <div className="space-y-3">
        <SummaryRow label="Vehicle" value={`${form.vehicleReg} - ${form.vehicleType}`} />
        <SummaryRow
          label="Mileage"
          value={form.mileage
            ? `${parseInt(form.mileage, 10).toLocaleString()} mi${mileageDiff != null ? ` (+${mileageDiff.toLocaleString()})` : ''}`
            : '-'}
        />
        <SummaryRow label="Fuel" value={form.fuelLevel || '-'} />
        <SummaryRow label="Photos" value={`${form.photos.length} captured`} />
        <SummaryRow
          label="Damage"
          value={form.damageItems.length > 0
            ? `${form.damageItems.length} item(s) flagged`
            : 'None'}
        />
      </div>

      {form.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {form.photos.map(p => (
            <img
              key={p.angle}
              src={p.blobUrl}
              alt={p.label}
              className="h-14 w-14 cursor-pointer rounded border border-gray-200 object-cover"
              onClick={() => setLightbox({ src: p.blobUrl, alt: p.label })}
            />
          ))}
        </div>
      )}

      {/* Driver present toggle */}
      <div className="rounded-lg border border-gray-200 p-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">Driver present?</p>
            <p className="text-xs text-gray-400">Toggle off if vehicle was left unattended</p>
          </div>
          <button
            onClick={() => onDriverPresentChange(!driverPresent)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              driverPresent ? 'bg-ooosh-navy' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                driverPresent ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {driverPresent ? (
        <SignatureCapture ref={signatureRef} />
      ) : (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
          <div className="flex gap-2">
            <svg className="h-5 w-5 shrink-0 text-amber-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">Driver not present</p>
              <p className="mt-0.5 text-xs text-amber-600">
                Signature not required. The vehicle was left unattended for check-in.
              </p>
            </div>
          </div>
        </div>
      )}

      <p className="text-center text-xs text-gray-400">
        This will create a Check In event and set the vehicle to Prep Needed
      </p>

      {lightbox && (
        <PhotoLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-800">{value}</span>
    </div>
  )
}
