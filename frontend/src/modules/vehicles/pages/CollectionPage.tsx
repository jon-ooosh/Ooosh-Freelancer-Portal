import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useAuth } from '../hooks/useAuth'
import { useVehicles } from '../hooks/useVehicles'
import { useAllocations } from '../hooks/useAllocations'
import { useHireHopJob } from '../hooks/useHireHopJobs'
import { useDriverHireForms } from '../hooks/useDriverHireForms'
import { useVehicleIssues } from '../hooks/useVehicleIssues'
import { createVehicleEvent } from '../lib/events-api'
import { fetchBookOutForVehicle } from '../lib/events-query'
import { uploadAllPhotos } from '../lib/photo-upload'
import { updateFleetHireStatus } from '../lib/fleet-status'
import { saveCollection } from '../lib/collection-api'
import { generateConditionReportPdf, sendConditionReportEmail, blobToBase64, resizeImageForPdf } from '../lib/pdf-email'
import { withRetry } from '../lib/retry'
import { PhotoCapture } from '../components/book-out/PhotoCapture'
import { SignatureCapture } from '../components/book-out/SignatureCapture'
import type { SignatureCaptureHandle } from '../components/book-out/SignatureCapture'
import type { Vehicle } from '../types/vehicle'
import type {
  CollectionFormState,
  CapturedPhoto,
  CollectionData,
} from '../types/vehicle-event'
import { FUEL_LEVELS, REQUIRED_PHOTOS } from '../types/vehicle-event'
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
  'Vehicle & Job',
  'Vehicle State',
  'Photos',
  'Notes & Confirm',
] as const

const INITIAL_FORM: CollectionFormState = {
  vehicleId: null,
  vehicleReg: '',
  vehicleType: '',
  vehicleSimpleType: '',
  hireHopJob: '',
  driverName: '',
  clientEmail: '',
  mileage: '',
  fuelLevel: null,
  photos: [],
  damageNotes: '',
  signatureBlob: null,
}

export function CollectionPage() {
  const { scope, freelancerContext } = useAuth()
  const isFreelancer = scope === 'freelancer'
  const { data: allVehicles, isLoading: vehiclesLoading } = useVehicles()
  const { data: allAllocations } = useAllocations()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<CollectionFormState>(INITIAL_FORM)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [opResults, setOpResults] = useState<OpResult[]>([])
  const [bookOutMileage, setBookOutMileage] = useState<number | null>(null)
  const [bookOutFuelLevel, setBookOutFuelLevel] = useState<string | null>(null)
  const signatureRef = useRef<SignatureCaptureHandle>(null!)
  const [queuedOffline, setQueuedOffline] = useState(false)

  // Form autosave
  const { save: autosave, clear: clearAutosave, draftLoaded, draftChecked, dismissDraft } = useFormAutosave({
    flowType: 'collection',
    disabled: submitSuccess || queuedOffline,
  })

  // Autosave on every form/step change
  useEffect(() => {
    if (!draftChecked || submitSuccess || queuedOffline) return
    autosave({
      step,
      formData: {
        vehicleId: form.vehicleId,
        vehicleReg: form.vehicleReg,
        vehicleType: form.vehicleType,
        vehicleSimpleType: form.vehicleSimpleType,
        hireHopJob: form.hireHopJob,
        driverName: form.driverName,
        clientEmail: form.clientEmail,
        mileage: form.mileage,
        fuelLevel: form.fuelLevel,
        damageNotes: form.damageNotes,
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
    setForm({
      vehicleId: (d.vehicleId as string) || null,
      vehicleReg: (d.vehicleReg as string) || '',
      vehicleType: (d.vehicleType as string) || '',
      vehicleSimpleType: (d.vehicleSimpleType as string) || '',
      hireHopJob: (d.hireHopJob as string) || '',
      driverName: (d.driverName as string) || '',
      clientEmail: (d.clientEmail as string) || '',
      mileage: (d.mileage as string) || '',
      fuelLevel: (d.fuelLevel as import('../types/vehicle-event').FuelLevel) || null,
      photos: draftLoaded.photos,
      damageNotes: (d.damageNotes as string) || '',
      signatureBlob: draftLoaded.signatureBlob,
    })
    setStep(draftLoaded.step)
    dismissDraft()
  }

  const vehicles = useMemo(
    () => (allVehicles || []).filter(v => !v.isOldSold),
    [allVehicles],
  )

  // Pre-select job from freelancer context
  const preSelectedJobId = freelancerContext?.jobId || null
  const { data: preSelectedJobData } = useHireHopJob(
    preSelectedJobId && !form.hireHopJob ? parseInt(preSelectedJobId, 10) : null,
  )

  // Driver hire forms for this job
  const { data: hireForms } = useDriverHireForms(form.hireHopJob || null)

  // Known issues for selected vehicle
  const { data: vehicleIssues } = useVehicleIssues(form.vehicleReg || undefined)
  const openIssues = useMemo(
    () => (vehicleIssues || []).filter(i => i.status !== 'Resolved'),
    [vehicleIssues],
  )

  // Auto-select vehicle from allocation
  const autoSelectedRef = useRef(false)

  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!preSelectedJobData || form.vehicleId) return
    if (!allAllocations || allAllocations.length === 0) return

    const matchingAlloc = allAllocations.find(
      a => a.hireHopJobId === preSelectedJobData.id,
    )
    if (!matchingAlloc) return

    const allocatedVehicle = vehicles.find(v => v.id === matchingAlloc.vehicleId)
    if (!allocatedVehicle) return

    autoSelectedRef.current = true
    selectVehicle(allocatedVehicle)

    setForm(f => ({
      ...f,
      hireHopJob: String(preSelectedJobData.id),
      clientEmail: preSelectedJobData.contactEmail || f.clientEmail,
      driverName: matchingAlloc.driverName || freelancerContext?.driverEmail || f.driverName,
    }))
  }, [allAllocations, preSelectedJobData, form.vehicleId, vehicles, freelancerContext])

  // Auto-fill job data when it arrives (separate from allocation)
  useEffect(() => {
    if (!preSelectedJobData || form.hireHopJob) return
    setForm(f => ({
      ...f,
      hireHopJob: String(preSelectedJobData.id),
      clientEmail: preSelectedJobData.contactEmail || f.clientEmail,
    }))
  }, [preSelectedJobData, form.hireHopJob])

  // Auto-fill driver name from hire forms
  useEffect(() => {
    if (!hireForms || hireForms.length === 0 || form.driverName) return
    const driverEmail = freelancerContext?.driverEmail
    if (driverEmail) {
      const match = hireForms.find(hf =>
        hf.clientEmail?.toLowerCase() === driverEmail.toLowerCase(),
      )
      if (match?.driverName) {
        setForm(f => ({ ...f, driverName: match.driverName }))
      }
    }
  }, [hireForms, form.driverName, freelancerContext])

  // Fetch book-out mileage for validation
  useEffect(() => {
    if (!form.vehicleReg) return
    let cancelled = false
    fetchBookOutForVehicle(form.vehicleReg).then(bo => {
      if (cancelled) return
      if (bo) {
        setBookOutMileage(bo.mileage)
        setBookOutFuelLevel(bo.fuelLevel)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [form.vehicleReg])

  function selectVehicle(v: Vehicle) {
    setForm(f => ({
      ...f,
      vehicleId: v.id,
      vehicleReg: v.reg,
      vehicleType: v.vehicleType,
      vehicleSimpleType: v.simpleType,
    }))
  }

  function updateForm<K extends keyof CollectionFormState>(
    key: K,
    value: CollectionFormState[K],
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

  function canAdvance(): boolean {
    switch (STEPS[step]) {
      case 'Vehicle & Job':
        return !!form.vehicleId && !!form.hireHopJob && !!form.driverName.trim()
      case 'Vehicle State': {
        if (!form.mileage.trim() || form.fuelLevel === null) return false
        const enteredMileage = parseInt(form.mileage, 10)
        if (bookOutMileage != null && !isNaN(enteredMileage) && enteredMileage < bookOutMileage) return false
        return true
      }
      case 'Photos':
        return TESTING_MODE || form.photos.length >= REQUIRED_PHOTOS.length
      case 'Notes & Confirm':
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

    // ── Step 1: Create Monday.com event ──
    setUploadProgress('Creating collection event...')
    const eventResult = await withRetry(
      () =>
        createVehicleEvent({
          vehicleReg: form.vehicleReg,
          eventType: 'Interim Check In',
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: form.fuelLevel,
          details: [
            `Collection by: ${form.driverName}`,
            `HireHop Job: ${form.hireHopJob}`,
            `Photos: ${form.photos.length} captured`,
            form.damageNotes ? `Client notes: ${form.damageNotes}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          hireHopJob: form.hireHopJob || null,
          clientEmail: form.clientEmail || null,
          hireStatus: 'Collected',
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

    // ── Step 1b: Update Fleet Master status to "Collected" ──
    if (form.vehicleReg) {
      const fleetResult = await updateFleetHireStatus(form.vehicleReg, 'Collected')
      if (fleetResult.success) {
        results.push({ label: 'Fleet status', success: true, detail: 'Set to Collected' })
      } else {
        results.push({ label: 'Fleet status', success: false, detail: fleetResult.error || 'Update failed' })
      }
    }

    // ── Step 2: Upload photos to R2 ──
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

    // ── Step 3: Save collection data to R2 (for staff check-in) ──
    setUploadProgress('Saving collection data...')
    const collectionData: CollectionData = {
      vehicleReg: form.vehicleReg,
      vehicleType: form.vehicleType,
      vehicleSimpleType: form.vehicleSimpleType,
      hireHopJob: form.hireHopJob,
      driverName: form.driverName,
      clientEmail: form.clientEmail,
      mileage: mileageNum,
      fuelLevel: form.fuelLevel!,
      damageNotes: form.damageNotes,
      collectedAt: new Date().toISOString(),
      collectedBy: form.driverName,
      eventId,
      photoAngles: form.photos.map(p => p.angle),
    }

    const saveResult = await saveCollection(collectionData)
    if (saveResult.success) {
      results.push({ label: 'Collection data saved', success: true, detail: 'For staff check-in' })
    } else {
      results.push({ label: 'Collection data saved', success: false, detail: saveResult.error || 'Save failed' })
    }

    // ── Step 4: Generate PDF ──
    setUploadProgress('Generating PDF...')
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()
    const selectedVehicle = vehicles.find(v => v.id === form.vehicleId)

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

    // Signature
    let signatureBase64: string | undefined
    try {
      const sigBlob = await signatureRef.current?.getBlob()
      if (sigBlob) {
        signatureBase64 = await blobToBase64(sigBlob)
      }
    } catch {
      console.warn('Failed to convert signature to base64')
    }

    const pdfResult = await withRetry(
      () =>
        generateConditionReportPdf({
          vehicleReg: form.vehicleReg,
          vehicleType: form.vehicleType,
          vehicleMake: selectedVehicle?.make,
          vehicleModel: selectedVehicle?.model,
          vehicleColour: selectedVehicle?.colour,
          driverName: form.driverName,
          clientEmail: form.clientEmail || undefined,
          hireHopJob: form.hireHopJob || undefined,
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: form.fuelLevel,
          eventDate,
          eventDateTime,
          photos: photoBase64s,
          briefingItems: [],
          signatureBase64,
          isCheckIn: false,
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

    // ── Step 5: Send email to client + freelancer ──
    if (pdfResult.success && pdfResult.data) {
      // Send to client
      if (form.clientEmail) {
        setUploadProgress('Sending email to client...')
        const clientEmailResult = await withRetry(
          () =>
            sendConditionReportEmail({
              to: form.clientEmail,
              vehicleReg: form.vehicleReg,
              driverName: form.driverName,
              eventDate,
              pdfBase64: pdfResult.data!.pdf,
              pdfFilename: pdfResult.data!.filename,
            }),
          'Client email',
        )

        if (clientEmailResult.success) {
          results.push({ label: 'Client email', success: true, detail: `Sent to ${form.clientEmail}` })
        } else {
          results.push({ label: 'Client email', success: false, detail: clientEmailResult.error || 'Failed' })
        }
      }

      // Send to freelancer (if they have an email)
      const freelancerEmail = freelancerContext?.driverEmail
      if (freelancerEmail && freelancerEmail !== form.clientEmail) {
        setUploadProgress('Sending email to driver...')
        const driverEmailResult = await withRetry(
          () =>
            sendConditionReportEmail({
              to: freelancerEmail,
              vehicleReg: form.vehicleReg,
              driverName: form.driverName,
              eventDate,
              pdfBase64: pdfResult.data!.pdf,
              pdfFilename: pdfResult.data!.filename,
            }),
          'Driver email',
        )

        if (driverEmailResult.success) {
          results.push({ label: 'Driver email', success: true, detail: `Sent to ${freelancerEmail}` })
        } else {
          results.push({ label: 'Driver email', success: false, detail: driverEmailResult.error || 'Failed' })
        }
      }
    }

    setOpResults(results)
    setUploadProgress(null)
    setIsSubmitting(false)
    setSubmitSuccess(true)
    clearAutosave()
    } catch (err) {
      console.error('[collection] handleSubmit crashed:', err)

      // If offline, queue for later
      if (!navigator.onLine) {
        try {
          await queueSubmission({
            flowType: 'collection',
            formData: {
              vehicleId: form.vehicleId,
              vehicleReg: form.vehicleReg,
              vehicleType: form.vehicleType,
              vehicleSimpleType: form.vehicleSimpleType,
              hireHopJob: form.hireHopJob,
              driverName: form.driverName,
              clientEmail: form.clientEmail,
              mileage: form.mileage,
              fuelLevel: form.fuelLevel,
              damageNotes: form.damageNotes,
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
          console.error('[collection] Failed to queue offline:', queueErr)
        }
      }

      setUploadProgress(null)
      setIsSubmitting(false)
    }
  }

  // ── Queued Offline Screen ──
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
            {form.vehicleReg} collection has been saved and will be submitted automatically when you&apos;re back online.
          </p>
        </div>
        <div className="flex gap-3">
          {isFreelancer && freelancerContext?.returnUrl ? (
            <a
              href={freelancerContext.returnUrl}
              className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
            >
              Return to Portal
            </a>
          ) : (
            <Link
              to={vmPath('/')}
              className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
            >
              Back to Dashboard
            </Link>
          )}
        </div>
      </div>
    )
  }

  // ── Draft Resume Prompt ──
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

  // ── Success Screen ──
  if (submitSuccess) {
    const allOk = opResults.every(r => r.success)

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
            {allOk ? 'Collection Complete' : 'Collection Completed with Issues'}
          </h2>
          <p className={`mt-1 text-sm ${allOk ? 'text-green-700' : 'text-amber-700'}`}>
            {form.vehicleReg} collected — condition recorded
          </p>
        </div>

        {opResults.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Operation Status</p>
            {opResults.map((r, i) => (
              <div key={i} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                r.success ? 'border-green-100 bg-green-50' : 'border-red-100 bg-red-50'
              }`}>
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
                  <span className="font-medium">{r.label}</span>
                  {r.detail && <span className="ml-1 text-gray-500">— {r.detail}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          {isFreelancer && freelancerContext?.returnUrl ? (
            <a
              href={freelancerContext.returnUrl}
              className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
            >
              Return to Portal
            </a>
          ) : (
            <Link
              to={vmPath('/')}
              className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
            >
              Back to Dashboard
            </Link>
          )}
        </div>
      </div>
    )
  }

  // ── Loading ──
  if (vehiclesLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-gray-500">Loading fleet data...</p>
      </div>
    )
  }

  // ── Step Rendering ──
  return (
    <div className="space-y-4 px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Vehicle Collection</h1>
          <p className="text-xs text-gray-500">Record vehicle condition at pickup</p>
        </div>
        {isFreelancer && freelancerContext?.returnUrl ? (
          <a href={freelancerContext.returnUrl} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </a>
        ) : (
          <Link to={vmPath('/')} className="text-sm text-gray-500 hover:text-gray-700">Cancel</Link>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex gap-1">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= step ? 'bg-ooosh-navy' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>
      <p className="text-xs font-medium text-gray-500">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>

      {/* Submitting overlay */}
      {isSubmitting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-72 rounded-xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
            <p className="text-sm font-medium text-gray-900">
              {uploadProgress || 'Submitting...'}
            </p>
          </div>
        </div>
      )}

      {/* Step Content */}
      {STEPS[step] === 'Vehicle & Job' && (
        <StepVehicleJob
          form={form}
          vehicles={vehicles}
          onSelectVehicle={selectVehicle}
          onUpdate={updateForm}
          openIssues={openIssues}
          isFreelancer={isFreelancer}
        />
      )}

      {STEPS[step] === 'Vehicle State' && (
        <StepVehicleState
          form={form}
          onUpdate={updateForm}
          bookOutMileage={bookOutMileage}
          bookOutFuelLevel={bookOutFuelLevel}
        />
      )}

      {STEPS[step] === 'Photos' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
            <p className="text-sm text-blue-800">
              Take photos of the vehicle as you find it at the collection point.
              These will be compared against the original book-out photos during check-in.
            </p>
          </div>
          <PhotoCapture
            photos={form.photos}
            onCapture={handlePhotoCapture}
            onRemove={handlePhotoRemove}
          />
          <p className="text-center text-xs text-gray-400">
            {form.photos.filter(p => REQUIRED_PHOTOS.some(r => r.angle === p.angle)).length} of {REQUIRED_PHOTOS.length} required photos taken
          </p>
        </div>
      )}

      {STEPS[step] === 'Notes & Confirm' && (
        <StepConfirm
          form={form}
          onUpdate={updateForm}
          signatureRef={signatureRef}
          bookOutFuelLevel={bookOutFuelLevel}
        />
      )}

      {/* Navigation */}
      <div className="flex gap-3 pt-2">
        {step > 0 && (
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={isSubmitting}
            className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-center font-semibold text-gray-700 disabled:opacity-50"
          >
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep(s => s + 1)}
            disabled={!canAdvance()}
            className="flex-1 rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white disabled:opacity-30"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex-1 rounded-lg bg-green-600 py-3 text-center font-semibold text-white disabled:opacity-50"
          >
            Submit Collection
          </button>
        )}
      </div>
    </div>
  )
}

// ── Step: Vehicle & Job ──
function StepVehicleJob({
  form,
  vehicles,
  onSelectVehicle,
  onUpdate,
  openIssues,
  isFreelancer,
}: {
  form: CollectionFormState
  vehicles: Vehicle[]
  onSelectVehicle: (v: Vehicle) => void
  onUpdate: <K extends keyof CollectionFormState>(key: K, value: CollectionFormState[K]) => void
  openIssues: Array<{ id: string; summary: string; severity: string; category: string; status: string }>
  isFreelancer: boolean
}) {
  const selectedVehicle = form.vehicleId
    ? vehicles.find(v => v.id === form.vehicleId)
    : null

  return (
    <div className="space-y-4">
      {/* Vehicle selection (auto-selected for freelancers, manual for staff) */}
      {selectedVehicle ? (
        <div className="rounded-lg border-2 border-green-300 bg-green-50 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-bold text-gray-900">{selectedVehicle.reg}</p>
              <p className="text-sm text-gray-600">{selectedVehicle.vehicleType}</p>
              <p className="text-xs text-gray-500">{selectedVehicle.make} {selectedVehicle.model} — {selectedVehicle.colour}</p>
            </div>
          </div>
          {!isFreelancer && (
            <button
              onClick={() => onSelectVehicle({ ...selectedVehicle, id: '' } as Vehicle)}
              className="mt-2 text-xs text-gray-500 underline"
            >
              Change vehicle
            </button>
          )}
        </div>
      ) : !isFreelancer ? (
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Select Vehicle</label>
          <p className="mb-3 text-xs text-gray-500">Choose the vehicle being collected</p>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {vehicles
              .filter(v => v.hireStatus === 'On Hire')
              .map(v => (
                <button
                  key={v.id}
                  onClick={() => onSelectVehicle(v)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-left active:bg-gray-50"
                >
                  <p className="font-semibold text-gray-900">{v.reg}</p>
                  <p className="text-xs text-gray-500">{v.vehicleType} — {v.make} {v.model}</p>
                </button>
              ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            Waiting for vehicle allocation... Please ensure the vehicle has been allocated to your job.
          </p>
        </div>
      )}

      {/* Known issues banner */}
      {form.vehicleReg && openIssues.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-start gap-2">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-blue-900">
                Heads up: {openIssues.length} known issue{openIssues.length > 1 ? 's' : ''}
              </p>
              <ul className="mt-1 space-y-0.5">
                {openIssues.slice(0, 5).map(issue => (
                  <li key={issue.id} className="text-xs text-blue-800">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                      issue.severity === 'Critical' ? 'bg-red-500' :
                      issue.severity === 'High' ? 'bg-orange-500' :
                      issue.severity === 'Medium' ? 'bg-yellow-500' : 'bg-gray-400'
                    }`} />
                    {issue.summary} <span className="text-blue-600">({issue.status})</span>
                  </li>
                ))}
                {openIssues.length > 5 && (
                  <li className="text-xs text-blue-600 italic">
                    + {openIssues.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Job info (read-only display) */}
      {form.hireHopJob && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-500 uppercase">Job Details</p>
          <p className="mt-1 text-sm text-gray-900">HireHop Job #{form.hireHopJob}</p>
          {form.driverName && (
            <p className="text-xs text-gray-600">Driver: {form.driverName}</p>
          )}
          {form.clientEmail && (
            <p className="text-xs text-gray-600">Client: {form.clientEmail}</p>
          )}
        </div>
      )}

      {/* Manual driver name entry (if not auto-filled) */}
      {!form.driverName && (
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Your Name</label>
          <input
            type="text"
            value={form.driverName}
            onChange={e => onUpdate('driverName', e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="Enter your name"
          />
        </div>
      )}
    </div>
  )
}

// ── Step: Vehicle State ──
function StepVehicleState({
  form,
  onUpdate,
  bookOutMileage,
  bookOutFuelLevel,
}: {
  form: CollectionFormState
  onUpdate: <K extends keyof CollectionFormState>(key: K, value: CollectionFormState[K]) => void
  bookOutMileage: number | null
  bookOutFuelLevel: string | null
}) {
  const enteredMileage = parseInt(form.mileage, 10)
  const mileageTooLow =
    bookOutMileage != null && !isNaN(enteredMileage) && enteredMileage < bookOutMileage

  return (
    <div className="space-y-6">
      {/* Reference: book-out state */}
      {(bookOutMileage != null || bookOutFuelLevel) && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-500 uppercase mb-1">Book-Out Reference</p>
          <div className="flex gap-4 text-sm">
            {bookOutMileage != null && (
              <span className="text-gray-700">Mileage: <strong>{bookOutMileage.toLocaleString()}</strong></span>
            )}
            {bookOutFuelLevel && (
              <span className="text-gray-700">Fuel: <strong>{bookOutFuelLevel}</strong></span>
            )}
          </div>
        </div>
      )}

      {/* Mileage */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Current Mileage
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={form.mileage}
          onChange={e => onUpdate('mileage', e.target.value)}
          className={`w-full rounded-lg border px-3 py-2.5 text-lg font-mono ${
            mileageTooLow ? 'border-red-300 bg-red-50' : 'border-gray-300'
          }`}
          placeholder="e.g. 45230"
        />
        {mileageTooLow && (
          <p className="mt-1 text-xs text-red-600">
            Mileage must be at least {bookOutMileage!.toLocaleString()} (book-out reading)
          </p>
        )}
      </div>

      {/* Fuel Level */}
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Fuel Level
        </label>
        <div className="grid grid-cols-3 gap-2">
          {FUEL_LEVELS.map(level => (
            <button
              key={level}
              onClick={() => onUpdate('fuelLevel', level)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                form.fuelLevel === level
                  ? 'border-ooosh-navy bg-ooosh-navy text-white'
                  : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step: Confirm ──
function StepConfirm({
  form,
  onUpdate,
  signatureRef,
  bookOutFuelLevel,
}: {
  form: CollectionFormState
  onUpdate: <K extends keyof CollectionFormState>(key: K, value: CollectionFormState[K]) => void
  signatureRef: React.RefObject<SignatureCaptureHandle>
  bookOutFuelLevel: string | null
}) {
  const fuelChanged = bookOutFuelLevel && form.fuelLevel && bookOutFuelLevel !== form.fuelLevel

  return (
    <div className="space-y-5">
      {/* Damage / client notes */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Damage or Notes from Client
        </label>
        <p className="mb-2 text-xs text-gray-500">
          Record anything the client mentioned — damage, issues, or special notes
        </p>
        <textarea
          value={form.damageNotes}
          onChange={e => onUpdate('damageNotes', e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          placeholder="e.g. Client reported a scrape on the rear bumper, oil warning light came on briefly..."
        />
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <p className="text-xs font-medium text-gray-500 uppercase mb-2">Collection Summary</p>
        <div className="space-y-1 text-sm">
          <p><span className="text-gray-500">Vehicle:</span> <strong>{form.vehicleReg}</strong> ({form.vehicleType})</p>
          <p><span className="text-gray-500">Job:</span> #{form.hireHopJob}</p>
          <p><span className="text-gray-500">Driver:</span> {form.driverName}</p>
          <p><span className="text-gray-500">Mileage:</span> {parseInt(form.mileage, 10).toLocaleString()}</p>
          <p><span className="text-gray-500">Fuel:</span> {form.fuelLevel}</p>
          <p><span className="text-gray-500">Photos:</span> {form.photos.length}</p>
          {form.damageNotes && (
            <p><span className="text-gray-500">Notes:</span> {form.damageNotes}</p>
          )}
        </div>
      </div>

      {/* Fuel warning */}
      {fuelChanged && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            <strong>Fuel difference:</strong> Book-out was {bookOutFuelLevel}, now {form.fuelLevel}
          </p>
        </div>
      )}

      {/* Signature */}
      <SignatureCapture ref={signatureRef} label="Collection Signature" />
    </div>
  )
}
