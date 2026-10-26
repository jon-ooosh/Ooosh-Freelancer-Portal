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
import { sendConditionReport, blobToBase64, resizeImageForPdf } from '../lib/pdf-email'
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
import { FUEL_LEVELS, REQUIRED_PHOTOS, isFuelReduction } from '../types/vehicle-event'
import { useFormAutosave } from '../hooks/useFormAutosave'
import { queueSubmission } from '../lib/offline-queue'
import { DraftResumePrompt } from '../components/shared/DraftResumePrompt'
import { portalJobUrl } from '../lib/safe-url'
import { LoaderCircle } from 'lucide-react'
import { fl, StepHeader, StepTitle, StepFooter, Banner, SummaryRows, FuelMileageStep, plateText, CentredSpinner } from '../components/freelancer/ui'
import { VanConfirm, vanSubLine } from '../components/freelancer/VanConfirm'
import { DoneScreen, isBothJob } from '../components/freelancer/DoneScreen'

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
  // Staff-only data hooks — a freelancer collection session isn't allowed to
  // reach these endpoints (403 via the freelancer allowlist) and doesn't need
  // them: the van + job + customer come pre-filled from the resolve context.
  const { data: allAllocations } = useAllocations({ enabled: !isFreelancer })
  const [step, setStep] = useState(0)
  // The freelancer screens scroll the page, so each step starts at the top.
  useEffect(() => {
    if (isFreelancer) window.scrollTo(0, 0)
  }, [isFreelancer, step])
  const [form, setForm] = useState<CollectionFormState>(INITIAL_FORM)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [opResults, setOpResults] = useState<OpResult[]>([])
  const [bookOutMileage, setBookOutMileage] = useState<number | null>(null)
  const [bookOutFuelLevel, setBookOutFuelLevel] = useState<string | null>(null)
  // The book-out event's own date + job: the collection report only compares
  // against a book-out that belongs to THIS job (the van's latest book-out
  // event can be a stale one from a previous hire).
  const [bookOutDate, setBookOutDate] = useState<string | null>(null)
  const [bookOutJob, setBookOutJob] = useState<string | null>(null)
  const signatureRef = useRef<SignatureCaptureHandle>(null!)
  const [queuedOffline, setQueuedOffline] = useState(false)
  // The CUSTOMER signs for the van they hand back (jon, Oct 2026 — it used to be
  // an optional pad with nobody named). Nobody there: a short note instead.
  const [customerPresent, setCustomerPresent] = useState(true)
  const [absentNote, setAbsentNote] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Form autosave
  const { save: autosave, clear: clearAutosave, draftLoaded, draftChecked, dismissDraft, acceptDraft } = useFormAutosave({
    flowType: 'collection',
    disabled: submitSuccess || queuedOffline,
  })

  // Autosave on every form/step change
  useEffect(() => {
    if (!draftChecked || submitSuccess || queuedOffline) return
    // Don't save empty state before a vehicle is selected
    if (!form.vehicleId) return
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
    acceptDraft()
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

  // Driver hire forms for this job (staff only — see note above)
  const { data: hireForms } = useDriverHireForms(isFreelancer ? null : (form.hireHopJob || null))

  // Known issues for selected vehicle (staff only — see note above)
  const { data: vehicleIssues } = useVehicleIssues(isFreelancer ? undefined : (form.vehicleReg || undefined))
  const openIssues = useMemo(
    () => (vehicleIssues || []).filter(i => i.status !== 'Resolved'),
    [vehicleIssues],
  )

  // Freelancer auto-fill from context (mirrors BookOutPage). The checkin
  // resolve endpoint already identified the van that's out on this job and
  // put it in the session — but the allocations hook that normally drives
  // auto-select below is staff-only (gated off for freelancers), so without
  // this effect a freelancer sits on "Waiting for vehicle allocation"
  // forever even though the van is right there in freelancerContext.
  // Waits for the vehicles query so vehicleType/simpleType come through.
  const freelancerAutoSelectedRef = useRef(false)

  useEffect(() => {
    if (!isFreelancer) return
    if (!freelancerContext?.vehicleId || !freelancerContext?.vehicleReg) return
    if (freelancerAutoSelectedRef.current) return
    const ctxVehicle = vehicles.find(v => v.id === freelancerContext.vehicleId)
    if (!ctxVehicle) return // wait for vehicles list
    freelancerAutoSelectedRef.current = true
    // On a collection the "driver" on the interim assessment is the CUSTOMER
    // who had the van (from the hire form, via the resolve payload); the
    // freelancer is just the collection agent. Fall back to the freelancer's
    // own name if no customer hire form is linked — field stays editable.
    const customerName = freelancerContext.customerDriverName || ''
    const customerEmail = freelancerContext.customerDriverEmail || ''
    setForm(f => ({
      ...f,
      vehicleId: ctxVehicle.id,
      vehicleReg: ctxVehicle.reg,
      vehicleType: ctxVehicle.vehicleType,
      vehicleSimpleType: ctxVehicle.simpleType,
      hireHopJob: freelancerContext.jobId || f.hireHopJob,
      driverName: customerName || freelancerContext.driverName || f.driverName,
      clientEmail: customerEmail || f.clientEmail,
    }))
  }, [isFreelancer, freelancerContext, vehicles])

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
        setBookOutDate(bo.eventDate)
        setBookOutJob(bo.hireHopJob)
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
    setForm(f => {
      // Revoke the displaced photo's preview URL so retakes don't leak.
      const displaced = f.photos.find(p => p.angle === photo.angle)
      if (displaced?.blobUrl) URL.revokeObjectURL(displaced.blobUrl)
      return {
        ...f,
        photos: [...f.photos.filter(p => p.angle !== photo.angle), photo],
      }
    })
  }, [])

  const handlePhotoRemove = useCallback((angle: string) => {
    setForm(f => {
      const removed = f.photos.find(p => p.angle === angle)
      if (removed?.blobUrl) URL.revokeObjectURL(removed.blobUrl)
      return {
        ...f,
        photos: f.photos.filter(p => p.angle !== angle),
      }
    })
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
    setSubmitError(null)
    // Signed by the customer, or "not here" with a note: checked BEFORE anything
    // is written, so a missing signature never leaves half a collection behind.
    let sigBlob: Blob | null = null
    if (customerPresent) {
      sigBlob = signatureRef.current?.hasSignature() ? (await signatureRef.current.getBlob()) : null
      if (!sigBlob) {
        setSubmitError('Ask the customer to sign above, or switch on "Customer not here".')
        return
      }
    } else if (!absentNote.trim()) {
      setSubmitError('Customer not here: add a short note (where you found the keys, anything else we should know).')
      return
    }
    let signatureBase64: string | undefined
    if (sigBlob) {
      try {
        signatureBase64 = await blobToBase64(sigBlob)
      } catch {
        console.warn('Failed to convert signature to base64')
      }
    }
    // The absent-customer note rides with the client notes, so every record of
    // the collection (event, staff check-in data, report, offline queue) has it.
    const clientNotes = customerPresent
      ? form.damageNotes
      : [`Customer not present at collection: ${absentNote.trim()}`, form.damageNotes.trim()].filter(Boolean).join('\n')

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
            customerPresent ? 'Signed by the customer' : 'Customer not present',
            clientNotes ? `Client notes: ${clientNotes}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          hireHopJob: form.hireHopJob || null,
          clientEmail: form.clientEmail || null,
          hireStatus: 'Collected',
          // Stored with the event, so a regenerated report shows this signature
          // (it used to fall back to "Signed in person at book-out").
          signatureBase64: signatureBase64 ?? null,
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
    // Staff only. A freelancer's session may only set "On Hire", so this was
    // refused on every freelancer collection and the done screen went amber
    // ("something to check"). Their saved event already sets the van Not Ready.
    if (form.vehicleReg && !isFreelancer) {
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
      damageNotes: clientNotes,
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
    // Capture-time PDF thumbnail when present (CapturedPhoto.pdfBase64);
    // resize fallback for photos restored from pre-thumbnail drafts. When
    // falling back, resize one photo at a time — parallel resizing spiked
    // memory and could OOM the browser tab.
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = []
    for (const p of form.photos) {
      try {
        const base64 = p.pdfBase64 || (await resizeImageForPdf(p.blob))
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        photoBase64s.push({ angle: p.angle, label: p.label, base64, r2Url })
      } catch {
        console.warn('Failed to resize photo for PDF:', p.angle)
      }
    }

    // (The signature was read and checked at the top of handleSubmit.)

    // ── Steps 4+5: PDF + email — ONE server-side call. The server builds
    // the report and emails it directly; the multi-MB base64 PDF never
    // round-trips through the phone. Recipient: the customer only (with the
    // job-level address-book fallback when no email is on file). The
    // collecting freelancer no longer gets a copy (jon, Oct 2026) — the
    // report is filed against the van either way.
    setUploadProgress('Generating PDF & sending email...')
    const recipients: Array<{ driverName: string; email: string | null }> = []
    if (form.clientEmail || form.hireHopJob) {
      recipients.push({ driverName: form.driverName, email: form.clientEmail || null })
    }

    // Book-out -> collection comparison, only against a book-out that
    // belongs to this job (never a stale one from a previous hire).
    const bookOutIsThisJob = bookOutJob != null && String(bookOutJob) === String(form.hireHopJob)
    const boMileage = bookOutIsThisJob ? bookOutMileage : null
    const boFuel = bookOutIsThisJob ? bookOutFuelLevel : null
    const clientMiles = boMileage != null && !isNaN(mileageNum) ? mileageNum - boMileage : null
    const fuelDiff = isFuelReduction(boFuel, form.fuelLevel)
      ? `${boFuel} at book-out -> ${form.fuelLevel} at collection`
      : null

    if (recipients.length === 0) {
      results.push({
        label: 'Collection report',
        success: true,
        detail: 'Email skipped — no client email or job on file',
      })
    } else {
      const reportResult = await withRetry(
        () =>
          sendConditionReport(
            {
              eventId,
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
              // false = nobody there to sign; the report says so instead of
              // printing an empty signature box.
              driverPresent: customerPresent,
              isCheckIn: false,
              isCollection: true,
              bookOutMileage: boMileage,
              bookOutFuelLevel: boFuel,
              bookOutDate: bookOutIsThisJob ? bookOutDate : null,
              // Anything the client mentioned at collection — the point of
              // this report is "it was like this when we picked it up"
              bookOutNotes: clientNotes || undefined,
            },
            recipients,
            { fuelDifference: fuelDiff, milesDriven: clientMiles },
          ),
        'Collection PDF + email',
      )

      if (reportResult.success && reportResult.data) {
        for (const r of reportResult.data) {
          if (r.success) {
            const recipientNote = r.isFallback
              ? 'info@oooshtours.co.uk (no client email on file)'
              : r.emailedTo || 'recipient resolved by backend'
            results.push({
              label: 'Collection report',
              success: true,
              detail: `${r.filename || 'PDF'} sent to ${recipientNote}`,
            })
          } else {
            results.push({ label: 'Collection report', success: false, detail: r.error || 'PDF/email failed' })
          }
        }
      } else {
        results.push({
          label: 'Collection report',
          success: false,
          detail: reportResult.error || 'Failed after retries',
        })
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
              damageNotes: clientNotes,
            },
            photos: form.photos,
            // form.signatureBlob was never set, so a queued collection lost its
            // signature; the pad's own blob is what was drawn.
            signatureBlob: sigBlob ?? form.signatureBlob,
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
  if (queuedOffline && isFreelancer) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-5 py-10 text-center">
        <h1 className={fl.pageTitle}>Saved on this phone</h1>
        <p className="text-[16px] leading-[1.5] text-hf-body">
          {plateText(form.vehicleReg)}: the collection, photos and signature are saved and will send by themselves
          when you&apos;re back online. Keep this page open if you can.
        </p>
        {freelancerContext?.returnUrl && (
          <a href={freelancerContext.returnUrl} className={`${fl.btnPrimary} w-full`}>
            Back to the portal
          </a>
        )}
      </div>
    )
  }
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
        onDiscardAndGoBack={() => { dismissDraft(); window.history.back() }}
        look={isFreelancer ? 'freelancer' : undefined}
      />
    )
  }

  // ── Success Screen ──
  if (submitSuccess && isFreelancer) {
    const allOk = opResults.every(r => r.success)
    const plate = plateText(form.vehicleReg)
    const returnUrl = freelancerContext?.returnUrl ?? null
    const both = isBothJob(returnUrl)
    return (
      <DoneScreen
        allOk={allOk}
        title="Van collected"
        problemTitle="Collected, with something to check"
        message={allOk
          ? `${plate} is collected and its condition recorded. The warehouse does the full check-in when it's back.`
          : `${plate} is collected. Here's what happened:`}
        results={opResults}
        bothNote={both}
        continueLabel={both ? 'Go to the equipment checklist' : 'Back to the portal'}
        onContinue={returnUrl ? () => { window.location.href = returnUrl } : null}
      />
    )
  }
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
  if (vehiclesLoading && isFreelancer) {
    return <CentredSpinner text="Finding the van…" />
  }
  if (vehiclesLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-gray-500">Loading fleet data...</p>
      </div>
    )
  }

  // ── Freelancer: the same steps, in the portal look (FREELANCER-PORTAL-SPEC §11).
  // Step 0 (Vehicle & Job) is "Is this the van in front of you?"; the other three
  // are numbered 1 to 3. Every check is the page's own canAdvance / handleSubmit,
  // exactly as for staff below; only the drawing differs.
  if (isFreelancer) {
    if (STEPS[step] === 'Vehicle & Job') {
      return (
        <VanConfirm
          kindLabel={form.hireHopJob ? `Van collection · Job #${form.hireHopJob}` : 'Van collection'}
          reg={form.vehicleReg || freelancerContext?.vehicleReg || ''}
          title={freelancerContext?.vehicleMakeModel || null}
          sub={vanSubLine(vehicles.find(v => v.id === form.vehicleId))}
          backHref={portalJobUrl(freelancerContext?.returnUrl)}
          onYes={() => setStep(s => s + 1)}
          yesDisabled={!canAdvance()}
        >
          {!form.vehicleId && (
            <Banner tone="warning" title="We can't find this van yet">
              It needs allocating to your job. Call the office and we&apos;ll sort it.
            </Banner>
          )}
          {form.vehicleId && !form.driverName.trim() && (
            <div className={`${fl.card} flex flex-col gap-2 p-4`}>
              <label htmlFor="fl-name" className={fl.label}>Your name</label>
              <input
                id="fl-name"
                type="text"
                value={form.driverName}
                onChange={e => updateForm('driverName', e.target.value)}
                className={fl.input}
              />
            </div>
          )}
        </VanConfirm>
      )
    }

    const FL_STEPS = ['Vehicle State', 'Photos', 'Notes & Confirm'] as const
    const flIndex = Math.max(0, FL_STEPS.indexOf(STEPS[step] as typeof FL_STEPS[number]))
    const isLast = STEPS[step] === 'Notes & Confirm'
    const ready = canAdvance()
    const entered = parseInt(form.mileage, 10)
    const tooLow = bookOutMileage != null && !isNaN(entered) && entered < bookOutMileage
    const requiredTaken = form.photos.filter(p => REQUIRED_PHOTOS.some(r => r.angle === p.angle)).length
    // The Photos gate counts every photo (canAdvance above), so the label does too.
    const photosLeft = Math.max(0, REQUIRED_PHOTOS.length - form.photos.length)
    const fuelDropped = isFuelReduction(bookOutFuelLevel, form.fuelLevel)

    let nextLabel = 'Next'
    if (STEPS[step] === 'Vehicle State') {
      nextLabel = ready ? 'Next: photos'
        : !form.mileage.trim() ? 'Add the mileage'
        : tooLow ? 'Check the mileage'
        : 'Pick the fuel level'
    } else if (STEPS[step] === 'Photos') {
      nextLabel = ready ? 'Next: notes & sign' : `${photosLeft} photo${photosLeft === 1 ? '' : 's'} to go`
    }

    return (
      <div className="pb-36">
        <StepHeader
          exitHref={portalJobUrl(freelancerContext?.returnUrl)}
          title={`Collect · ${plateText(form.vehicleReg)}`}
          step={flIndex + 1}
          total={FL_STEPS.length}
        />
        <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 pt-4">
          {STEPS[step] === 'Vehicle State' && (
            <FuelMileageStep
              title="Fuel & mileage"
              mileage={form.mileage}
              onMileage={value => updateForm('mileage', value)}
              fuel={form.fuelLevel}
              onFuel={level => updateForm('fuelLevel', level)}
              reference={(bookOutMileage != null || bookOutFuelLevel) ? (
                <Banner tone="info" title="When it went out">
                  {[
                    bookOutMileage != null ? `${bookOutMileage.toLocaleString()} mi` : null,
                    bookOutFuelLevel ? `fuel ${bookOutFuelLevel}` : null,
                  ].filter(Boolean).join(' · ')}
                </Banner>
              ) : null}
              mileageError={tooLow
                ? `That's below the book-out reading (${bookOutMileage!.toLocaleString()} mi). Check the dashboard: it can't be lower.`
                : null}
            />
          )}

          {STEPS[step] === 'Photos' && (
            <>
              <StepTitle
                title="Photos"
                right={<span className="text-[15px] font-semibold text-hf-green-text tabular-nums">{requiredTaken} of {REQUIRED_PHOTOS.length}</span>}
              />
              <Banner tone="info">
                Photograph the van as you find it. These are compared with the book-out photos when it&apos;s checked in.
              </Banner>
              <PhotoCapture
                look="freelancer"
                photos={form.photos}
                onCapture={handlePhotoCapture}
                onRemove={handlePhotoRemove}
              />
            </>
          )}

          {STEPS[step] === 'Notes & Confirm' && (
            <>
              <StepTitle title="Notes & sign" />
              {fuelDropped && (
                <Banner tone="warning" title="Less fuel than it went out with">
                  Out at {bookOutFuelLevel} · now {form.fuelLevel}
                </Banner>
              )}
              <SummaryRows rows={[
                ['Mileage', (
                  <>
                    {isNaN(entered) ? '-' : `${entered.toLocaleString()} mi`}
                    {bookOutMileage != null && !isNaN(entered) && (
                      <span className="font-normal text-hf-muted"> ({entered - bookOutMileage >= 0 ? '+' : ''}{(entered - bookOutMileage).toLocaleString()})</span>
                    )}
                  </>
                )],
                ['Fuel', form.fuelLevel || '-'],
                ['Photos', `${form.photos.length} taken`],
              ]} />
              <div className={`${fl.card} flex flex-col gap-2 p-4`}>
                <label htmlFor="fl-damage" className={fl.label}>Any damage or problems?</label>
                <p className="text-[14px] text-hf-muted">Anything the customer mentioned: damage, warning lights, anything else.</p>
                <textarea
                  id="fl-damage"
                  rows={3}
                  value={form.damageNotes}
                  onChange={e => updateForm('damageNotes', e.target.value)}
                  placeholder="e.g. Customer mentioned a scrape on the rear bumper"
                  className={fl.input}
                />
              </div>

              {/* The customer signs for the van they hand back; if nobody's there,
                  a short note instead (jon, Oct 2026). */}
              <label className={`${fl.card} flex cursor-pointer items-center justify-between gap-3 p-4`}>
                <span className="flex flex-col">
                  <span className="text-[16px] font-semibold">Customer not here</span>
                  <span className="text-[14px] text-hf-muted">Add a short note instead of a signature</span>
                </span>
                <input
                  type="checkbox"
                  checked={!customerPresent}
                  onChange={e => { setCustomerPresent(!e.target.checked); setSubmitError(null) }}
                  className="h-6 w-6 flex-none accent-[#A75390]"
                />
              </label>

              {customerPresent ? (
                <SignatureCapture ref={signatureRef} look="freelancer" label="Customer's signature" hint="Hand the phone to the customer" />
              ) : (
                <div className={`${fl.card} flex flex-col gap-2 p-4`}>
                  <label htmlFor="fl-absent" className={fl.label}>Note for the office <span className="text-hf-error">*</span></label>
                  <p className="text-[14px] text-hf-muted">Where did you find the keys? Anything else we should know?</p>
                  <textarea
                    id="fl-absent"
                    rows={3}
                    value={absentNote}
                    onChange={e => { setAbsentNote(e.target.value); setSubmitError(null) }}
                    placeholder="e.g. Keys left with the venue's stage door, van parked in bay 4"
                    className={fl.input}
                  />
                </div>
              )}
              {submitError && <Banner tone="error">{submitError}</Banner>}
            </>
          )}
        </main>

        {isSubmitting && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
            <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl bg-white p-6 text-center">
              <LoaderCircle size={32} className="animate-spin text-hf-accent" />
              <p className="text-[15px] font-semibold">{uploadProgress || 'Sending…'}</p>
            </div>
          </div>
        )}

        <StepFooter
          onBack={() => setStep(s => s - 1)}
          backDisabled={isSubmitting}
          primary={isLast
            ? { label: 'Van collected', onClick: handleSubmit, disabled: isSubmitting, tone: 'green' }
            : { label: nextLabel, onClick: () => setStep(s => s + 1), disabled: !ready }}
        />
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
          // The job page, never the completion screen (see portalJobUrl).
          <a href={portalJobUrl(freelancerContext.returnUrl) ?? undefined} className="text-sm text-gray-500 hover:text-gray-700">
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
          customerPresent={customerPresent}
          onCustomerPresentChange={(present) => { setCustomerPresent(present); setSubmitError(null) }}
          absentNote={absentNote}
          onAbsentNoteChange={(note) => { setAbsentNote(note); setSubmitError(null) }}
        />
      )}

      {/* Navigation */}
      {submitError && step === STEPS.length - 1 && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</p>
      )}

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
  customerPresent,
  onCustomerPresentChange,
  absentNote,
  onAbsentNoteChange,
}: {
  form: CollectionFormState
  onUpdate: <K extends keyof CollectionFormState>(key: K, value: CollectionFormState[K]) => void
  signatureRef: React.RefObject<SignatureCaptureHandle>
  bookOutFuelLevel: string | null
  customerPresent: boolean
  onCustomerPresentChange: (present: boolean) => void
  absentNote: string
  onAbsentNoteChange: (note: string) => void
}) {
  // Only a reduction is worth flagging — more fuel coming back is fine.
  const fuelChanged = isFuelReduction(bookOutFuelLevel, form.fuelLevel)

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

      {/* Sign-off: the customer signs for the van they're handing back; if
          nobody's there, a short note instead (jon, Oct 2026). */}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3">
        <span>
          <span className="block text-sm font-medium text-gray-900">Customer not here</span>
          <span className="block text-xs text-gray-500">Add a short note instead of a signature</span>
        </span>
        <input
          type="checkbox"
          checked={!customerPresent}
          onChange={e => onCustomerPresentChange(!e.target.checked)}
          className="h-5 w-5"
        />
      </label>

      {customerPresent ? (
        <SignatureCapture ref={signatureRef} label="Customer's signature" />
      ) : (
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Note for the office <span className="text-red-600">*</span>
          </label>
          <p className="mb-2 text-xs text-gray-500">
            Where did you find the keys? Anything else we should know?
          </p>
          <textarea
            value={absentNote}
            onChange={e => onAbsentNoteChange(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="e.g. Keys left with the venue's stage door, van parked in bay 4"
          />
        </div>
      )}
    </div>
  )
}
