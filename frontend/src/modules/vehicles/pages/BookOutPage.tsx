import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useAuth } from '../hooks/useAuth'
import { useVehicles } from '../hooks/useVehicles'
import { createVehicleEvent } from '../lib/events-api'
import { uploadAllPhotos } from '../lib/photo-upload'
import { updateFleetHireStatus } from '../lib/fleet-status'
import { getAllocations, saveAllocations } from '../lib/allocations-api'
import { withRetry } from '../lib/retry'
import { generateConditionReportPdf, sendConditionReportEmail, blobToBase64, resizeImageForPdf } from '../lib/pdf-email'
import { PhotoCapture } from '../components/book-out/PhotoCapture'
import { TimeInput } from '../../../components/TimeInput'
import { SignatureCapture } from '../components/book-out/SignatureCapture'
import type { SignatureCaptureHandle } from '../components/book-out/SignatureCapture'
import type { Vehicle } from '../types/vehicle'
import type {
  BookOutFormState,
  FuelLevel,
  CapturedPhoto,
} from '../types/vehicle-event'
import { FUEL_LEVELS, REQUIRED_PHOTOS } from '../types/vehicle-event'
import { useSettings } from '../hooks/useSettings'
import { DEFAULT_CHECKLIST_SETTINGS } from '../config/default-checklist-settings'
import { useGoingOutJobs, useHireHopJob } from '../hooks/useHireHopJobs'
import { useAllocations } from '../hooks/useAllocations'
import { useDriverHireForms, useActiveHireForms } from '../hooks/useDriverHireForms'
import { updateDriverHireForm } from '../lib/driver-hire-api'
import { apiFetch } from '../config/api-config'
import { extractVanRequirements } from '../lib/hirehop-api'
import { fetchLastEventForVehicle } from '../lib/events-query'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useFormAutosave } from '../hooks/useFormAutosave'
import { clearFreelancerSession } from '../adapters/freelancer-session'
import { vehicleMatchesRequirement, getGearbox } from '../lib/van-matching'
import { getChecklistItems } from '../lib/settings-api'
import { queueSubmission } from '../lib/offline-queue'
import { DraftResumePrompt } from '../components/shared/DraftResumePrompt'
import type { ChecklistItem } from '../lib/settings-api'
import type { HireHopJob } from '../types/hirehop'

/** Per-operation result shown on the success/complete screen */
interface OpResult {
  label: string
  success: boolean
  detail?: string
}

// Testing mode: set to true to skip photo minimum requirement.
// Must stay false in production — book-out's required walkaround photos
// are the source of truth that check-in compares against.
const TESTING_MODE = false

const STEPS = [
  'Select Vehicle',
  'Driver & Hire',
  'Vehicle State',
  'Photos',
  'Briefing',
  'Confirm',
] as const

const INITIAL_FORM: BookOutFormState = {
  vehicleId: null,
  vehicleReg: '',
  vehicleType: '',
  vehicleSimpleType: '',
  driverName: '',
  selectedHireFormId: null,
  clientEmail: '',
  hireHopJob: '',
  mileage: '',
  fuelLevel: null,
  photos: [],
  briefingChecked: {},
  notes: '',
  signatureBlob: null,
}

export function BookOutPage() {
  const [searchParams] = useSearchParams()
  const { scope, freelancerContext } = useAuth()
  const isFreelancer = scope === 'freelancer'
  // Van & Driver soft book-out: Ooosh supplies the driver (one of our
  // freelancers) — no customer hire form, no customer signature, no customer
  // excess. The assignment row gets promoted to assignment_type='driven' at
  // submit time and the freelancer is recorded via freelancer_person_id.
  const explicitVand = searchParams.get('mode') === 'van_and_driver'
  const vandAssignmentParam = searchParams.get('assignment')
  // Auto-detected V&D — set once we've matched the vehicle+job to an
  // assignment whose slot is in van_and_driver mode. Lets the AllocationsPage
  // Book Out button (which doesn't pass `mode=`) still land users in the
  // right flow without each entry point having to compose the URL itself.
  const [autoVand, setAutoVand] = useState(false)
  const [autoVandAssignmentId, setAutoVandAssignmentId] = useState<string | null>(null)
  const isVanAndDriver = explicitVand || autoVand
  const { data: allVehicles, isLoading: vehiclesLoading } = useVehicles()
  const { data: settings } = useSettings()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<BookOutFormState>(INITIAL_FORM)
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [opResults, setOpResults] = useState<OpResult[]>([])
  const signatureRef = useRef<SignatureCaptureHandle>(null!)
  const isOnline = useOnlineStatus()
  const [lastKnownMileage, setLastKnownMileage] = useState<number | null>(null)
  const [queuedOffline, setQueuedOffline] = useState(false)

  // Form autosave to IndexedDB
  const { save: autosave, clear: clearAutosave, draftLoaded, draftChecked, dismissDraft } = useFormAutosave({
    flowType: 'book-out',
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
        driverName: form.driverName,
        clientEmail: form.clientEmail,
        hireHopJob: form.hireHopJob,
        mileage: form.mileage,
        fuelLevel: form.fuelLevel,
        briefingChecked: form.briefingChecked,
        notes: form.notes,
        hireStartDate: form.hireStartDate,
        hireEndDate: form.hireEndDate,
        hireStartTime: form.hireStartTime,
        hireEndTime: form.hireEndTime,
        excess: form.excess,
        ve103b: form.ve103b,
        returnOvernight: form.returnOvernight,
        allDrivers: form.allDrivers,
        hireFormEntries: form.hireFormEntries,
        allocationId: form.allocationId,
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
      driverName: (d.driverName as string) || '',
      clientEmail: (d.clientEmail as string) || '',
      hireHopJob: (d.hireHopJob as string) || '',
      mileage: (d.mileage as string) || '',
      fuelLevel: (d.fuelLevel as FuelLevel) || null,
      photos: draftLoaded.photos,
      briefingChecked: (d.briefingChecked as Record<string, boolean>) || {},
      notes: (d.notes as string) || '',
      signatureBlob: draftLoaded.signatureBlob,
      hireStartDate: (d.hireStartDate as string) || null,
      hireEndDate: (d.hireEndDate as string) || null,
      hireStartTime: (d.hireStartTime as string) || null,
      hireEndTime: (d.hireEndTime as string) || null,
      excess: (d.excess as string) || null,
      ve103b: (d.ve103b as string) || null,
      returnOvernight: (d.returnOvernight as string) || null,
      allDrivers: (d.allDrivers as string[]) || undefined,
      hireFormEntries: (d.hireFormEntries as BookOutFormState['hireFormEntries']) || undefined,
      allocationId: (d.allocationId as string) || null,
    })
    setStep(draftLoaded.step)
    dismissDraft()
  }

  // Fetch last known mileage when vehicle is selected
  useEffect(() => {
    if (!form.vehicleReg) {
      setLastKnownMileage(null)
      return
    }
    fetchLastEventForVehicle(form.vehicleReg).then(event => {
      setLastKnownMileage(event?.mileage ?? null)
    }).catch(() => setLastKnownMileage(null))
  }, [form.vehicleReg])

  // Freelancer auto-redirect after clean submit: hands them back to the
  // portal completion page once all submit tracks succeeded. Any failure
  // keeps them on the success screen so they can see what went wrong and
  // decide whether to hit Return to Portal manually. Session is cleared
  // before the hop so the browser doesn't carry a stale freelancer token.
  useEffect(() => {
    if (!submitSuccess) return
    if (!isFreelancer) return
    if (!freelancerContext?.returnUrl) return
    const allOk = opResults.length > 0 && opResults.every(r => r.success)
    if (!allOk) return
    const returnUrl = freelancerContext.returnUrl
    const t = window.setTimeout(() => {
      clearFreelancerSession()
      window.location.href = returnUrl
    }, 3000)
    return () => window.clearTimeout(t)
  }, [submitSuccess, isFreelancer, freelancerContext, opResults])

  // Filter to active fleet only (no old/sold)
  const vehicles = useMemo(
    () => (allVehicles || []).filter(v => !v.isOldSold),
    [allVehicles],
  )

  // V&D mode: seed mode + assignment ID into form state once V&D is
  // confirmed (either via URL ?mode= or via auto-detect from slot data).
  // The picker logic in StepDriverHire then loads the job's Ooosh crew
  // for the freelancer picker.
  const vandSeededRef = useRef(false)
  useEffect(() => {
    if (!isVanAndDriver) return
    if (vandSeededRef.current) return
    vandSeededRef.current = true
    setForm(f => ({
      ...f,
      mode: 'van_and_driver',
      vandAssignmentId: vandAssignmentParam || autoVandAssignmentId || null,
    }))
  }, [isVanAndDriver, vandAssignmentParam, autoVandAssignmentId])

  // Keep form.vandAssignmentId in sync if auto-detect resolves an assignment
  // ID after the initial seed (e.g. derived-flags fetch finishes after the
  // form has already been seeded with no assignment ID).
  useEffect(() => {
    if (!autoVandAssignmentId) return
    setForm(f => (f.vandAssignmentId ? f : { ...f, vandAssignmentId: autoVandAssignmentId }))
  }, [autoVandAssignmentId])

  // V&D auto-detect: when the URL doesn't explicitly say `mode=van_and_driver`
  // (e.g. coming from the Allocations page's Book Out link), check whether
  // the vehicle's slot on this job is in V&D mode. If so, switch to V&D
  // automatically. Self-drive jobs incur one extra fetch on entry, results
  // discarded — acceptable cost for "every entry point does the right thing".
  const vandDetectRef = useRef<string | null>(null)
  useEffect(() => {
    if (explicitVand) return  // URL forced it — nothing to detect
    if (autoVand) return       // Already detected
    const veh = searchParams.get('vehicle')
    const job = searchParams.get('job')
    if (!veh || !job) return
    const key = `${veh}|${job}`
    if (vandDetectRef.current === key) return
    vandDetectRef.current = key
    ;(async () => {
      try {
        // Fetch assignments for this HH job — staff-allocation rows from the
        // Allocations page only have hirehop_job_id set (job_id is NULL until
        // a hire form is submitted). For V&D jobs there's never a hire form,
        // so we look up via HH number and use it for the derived-flags
        // fetch when job_id is NULL.
        const assignResp = await apiFetch(`/api/assignments?hirehop_job_id=${encodeURIComponent(job)}`)
        if (!assignResp.ok) return
        const assignBody = await assignResp.json().catch(() => ({}))
        const rows = (assignBody.data as Array<{ id: string; vehicle_id: string | null; van_requirement_index: number | null; job_id: string | null; hirehop_job_id: number | null }>) || []
        const match = rows.find(r => r.vehicle_id === veh)
        if (!match) return
        // Prefer OP UUID if we have it; fall back to the HH number which
        // the derived-flags endpoint also accepts.
        const flagsLookupId = match.job_id || (match.hirehop_job_id ? String(match.hirehop_job_id) : job)
        const flagsResp = await apiFetch(`/api/hirehop/jobs/${encodeURIComponent(flagsLookupId)}/derived-flags`)
        if (!flagsResp.ok) return
        const flagsBody = await flagsResp.json().catch(() => ({}))
        const slots = (flagsBody?.flags?.vehicle_slots as Array<{ slot_index: number; mode: 'self_drive' | 'van_and_driver' }>) || []
        const slot = slots.find(s => s.slot_index === (match.van_requirement_index ?? 0))
        const slotIsVand = slot?.mode === 'van_and_driver'
        const allSlotsVand = slots.length > 0 && slots.every(s => s.mode === 'van_and_driver')
        if (slotIsVand || allSlotsVand) {
          setAutoVand(true)
          setAutoVandAssignmentId(match.id)
        }
      } catch (err) {
        // Detection failure is non-fatal — page just stays in self-drive
        // mode. URL ?mode=van_and_driver still forces V&D regardless.
        console.warn('[book-out] V&D auto-detect failed:', err)
      }
    })()
  }, [explicitVand, autoVand, searchParams])

  // Pre-select vehicle if coming from vehicle detail page or allocations
  const preSelectedId = searchParams.get('vehicle')
  const preSelectedVehicle = preSelectedId
    ? vehicles.find(v => v.id === preSelectedId)
    : null

  // Pre-select HireHop job if coming from allocations page or freelancer portal
  const preSelectedJobId = searchParams.get('job') || freelancerContext?.jobId || null
  const { data: preSelectedJobData } = useHireHopJob(
    preSelectedJobId && !form.hireHopJobData ? parseInt(preSelectedJobId, 10) : null,
  )

  // If pre-selected vehicle and form hasn't been set yet, auto-fill
  // When both vehicle and job are pre-selected (e.g. from allocations), skip to step 1
  if (preSelectedVehicle && !form.vehicleId) {
    selectVehicle(preSelectedVehicle)
    if (preSelectedJobId && step === 0) {
      setStep(1)
    }
  }

  // Allocations data — used for pre-selection from allocations page.
  // Disabled in freelancer mode: freelancer session has no access to the
  // allocations list and doesn't need it (the session JWT already scopes
  // us to a specific allocated vehicle — freelancerContext.vehicleId).
  const { data: allAllocations } = useAllocations({ enabled: !isFreelancer })

  // Track whether we've already auto-selected for the freelancer (prevent re-runs)
  const freelancerAutoSelectedRef = useRef(false)
  // Track whether we've already filled job data from pre-selected job
  const jobDataFilledRef = useRef(false)
  // Freelancer mode: driver must tap "yes this is my van" before we advance
  // past the pre-check. Pre-fills vehicle + driver + job from freelancerContext
  // so the wizard jumps straight to Vehicle State (mileage / fuel).
  const [freelancerVanConfirmed, setFreelancerVanConfirmed] = useState(false)

  // Freelancer auto-fill from context (no allocations lookup needed — the
  // resolve endpoint already told us the vehicle + job). Waits for the
  // vehicles query to populate so we can pick up vehicleType / simpleType
  // (needed by the briefing checklist).
  useEffect(() => {
    if (!isFreelancer) return
    if (!freelancerContext?.vehicleId || !freelancerContext?.vehicleReg) return
    if (freelancerAutoSelectedRef.current) return
    const ctxVehicle = vehicles.find(v => v.id === freelancerContext.vehicleId)
    if (!ctxVehicle) return // wait for vehicles list
    freelancerAutoSelectedRef.current = true
    // The freelancer is the DELIVERY person; the customer is the driver on
    // the hire agreement and on the condition-report PDF. Pre-fill the
    // form with the customer's name + email (from the hire form) — the
    // freelancer's identity is recorded separately as deliveredBy on the
    // event JSON. Falls back to freelancer name only if the customer
    // hasn't yet submitted their hire form (caller blocks submit before
    // the PDF goes out).
    const customerName = freelancerContext.customerDriverName || ''
    const customerEmail = freelancerContext.customerDriverEmail || ''
    setForm(f => ({
      ...f,
      vehicleId: ctxVehicle.id,
      vehicleReg: ctxVehicle.reg,
      vehicleType: ctxVehicle.vehicleType,
      vehicleSimpleType: ctxVehicle.simpleType,
      driverName: customerName || f.driverName,
      clientEmail: customerEmail || f.clientEmail,
      hireHopJob: freelancerContext.jobId || f.hireHopJob,
      allDrivers: [customerName || f.driverName].filter(Boolean),
    }))
  }, [isFreelancer, freelancerContext, vehicles])

  // If pre-selected job data arrived, auto-fill the HireHop job fields.
  // In freelancer mode the allocations lookup is disabled (we already have
  // vehicle + driver from freelancerContext), so we only pull the job
  // data itself (hireHopJob, hireHopJobData, clientEmail for the
  // condition-report email).
  if (preSelectedJobData && !jobDataFilledRef.current && preSelectedJobId) {
    jobDataFilledRef.current = true

    if (isFreelancer) {
      setForm(f => ({
        ...f,
        hireHopJob: String(preSelectedJobData.id),
        hireHopJobData: preSelectedJobData,
        clientEmail: preSelectedJobData.contactEmail || f.clientEmail,
      }))
    } else {
      // Find allocation for this job — first try matching pre-selected vehicle, then any vehicle
      let matchingAlloc = preSelectedVehicle
        ? (allAllocations || []).find(
            a => a.hireHopJobId === preSelectedJobData.id && a.vehicleId === preSelectedVehicle.id,
          )
        : null

      if (!matchingAlloc && !preSelectedVehicle) {
        matchingAlloc = (allAllocations || []).find(
          a => a.hireHopJobId === preSelectedJobData.id,
        ) ?? null
      }

      // If we found an allocation with a vehicle, auto-select that vehicle
      if (matchingAlloc && !form.vehicleId && !freelancerAutoSelectedRef.current) {
        const allocatedVehicle = vehicles.find(v => v.id === matchingAlloc!.vehicleId)
        if (allocatedVehicle) {
          freelancerAutoSelectedRef.current = true
          selectVehicle(allocatedVehicle)
          setStep(1)
        }
      }

      setForm(f => ({
        ...f,
        hireHopJob: String(preSelectedJobData.id),
        hireHopJobData: preSelectedJobData,
        clientEmail: preSelectedJobData.contactEmail || f.clientEmail,
        allocationId: matchingAlloc?.id ?? f.allocationId,
        driverName: matchingAlloc?.driverName || f.driverName,
      }))
    }
  }

  // Separate effect: auto-select vehicle from allocation when allocations arrive later
  // (handles race condition where job data loads before allocations)
  useEffect(() => {
    if (isFreelancer) return // Freelancer flow pre-fills from context, not allocations
    if (freelancerAutoSelectedRef.current) return // Already auto-selected
    if (!form.hireHopJobData || form.vehicleId) return // No job data yet, or vehicle already selected
    if (!allAllocations || allAllocations.length === 0) return // Allocations not loaded yet
    if (preSelectedVehicle) return // Vehicle was pre-selected via URL param

    const matchingAlloc = allAllocations.find(
      a => a.hireHopJobId === form.hireHopJobData!.id,
    )
    if (!matchingAlloc) return

    const allocatedVehicle = vehicles.find(v => v.id === matchingAlloc.vehicleId)
    if (!allocatedVehicle) return

    freelancerAutoSelectedRef.current = true
    selectVehicle(allocatedVehicle)
    setStep(1)
    setForm(f => ({
      ...f,
      allocationId: matchingAlloc.id,
      driverName: matchingAlloc.driverName || f.driverName,
    }))
  }, [isFreelancer, allAllocations, form.hireHopJobData, form.vehicleId, vehicles, preSelectedVehicle])

  function selectVehicle(v: Vehicle) {
    setForm(f => ({
      ...f,
      vehicleId: v.id,
      vehicleReg: v.reg,
      vehicleType: v.vehicleType,
      vehicleSimpleType: v.simpleType,
    }))
  }

  function updateForm<K extends keyof BookOutFormState>(
    key: K,
    value: BookOutFormState[K],
  ) {
    setForm(f => ({ ...f, [key]: value }))
  }

  const handlePhotoCapture = useCallback((photo: CapturedPhoto) => {
    // Dedupe by angle — required angles are fixed strings, extras now use
    // a unique `extra_<timestamp>` angle so retake-of-extra also lands on
    // the same key. Result: either pattern just replaces in place.
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

  const handlePhotoUpdate = useCallback(
    (angle: string, partial: Partial<Pick<CapturedPhoto, 'label'>>) => {
      setForm(f => ({
        ...f,
        photos: f.photos.map(p => (p.angle === angle ? { ...p, ...partial } : p)),
      }))
    },
    [],
  )

  // Briefing items: merge "All" + type-specific from R2 settings, defaults fallback
  const briefingItems: ChecklistItem[] = useMemo(() => {
    if (!form.vehicleSimpleType) return []
    const briefingMap = settings?.briefingItems && Object.keys(settings.briefingItems).length > 0
      ? settings.briefingItems
      : DEFAULT_CHECKLIST_SETTINGS.briefingItems
    return getChecklistItems(briefingMap, form.vehicleSimpleType)
  }, [form.vehicleSimpleType, settings])

  const allBriefingChecked =
    briefingItems.length > 0 &&
    briefingItems.every(item => form.briefingChecked[item.name])

  const requiredPhotoCount = REQUIRED_PHOTOS.length
  const capturedRequiredCount = form.photos.filter(p =>
    REQUIRED_PHOTOS.some(r => r.angle === p.angle),
  ).length

  // Step validation
  function canAdvance(): boolean {
    switch (STEPS[step]) {
      case 'Select Vehicle':
        return !!form.vehicleId
      case 'Driver & Hire':
        // V&D soft book-out: no customer hire form needed — Ooosh supplies
        // the freelancer driver. Just needs the freelancer picked (driverName
        // populated from the picker).
        if (isVanAndDriver) {
          return form.driverName.trim().length > 0
        }
        // Freelancer mode: must have at least one customer hire form on
        // file before we let the freelancer hand the van over. The hire
        // agreement comes from the customer's hire-form submission, not
        // from the freelancer's flow — without it the condition PDF lacks
        // a real driver name + email, and the post-book-out hire-form
        // PDF chain has nothing to send.
        if (isFreelancer) {
          const hasHireForm = (form.hireFormEntries?.length ?? 0) > 0
          return hasHireForm && form.driverName.trim().length > 0
        }
        return form.driverName.trim().length > 0
      case 'Vehicle State': {
        if (form.mileage.trim().length === 0 || form.fuelLevel === null) return false
        // Block if mileage is below last known reading
        const enteredMileage = parseInt(form.mileage, 10)
        if (lastKnownMileage != null && !isNaN(enteredMileage) && enteredMileage < lastKnownMileage) return false
        return true
      }
      case 'Photos':
        return TESTING_MODE || capturedRequiredCount >= requiredPhotoCount
      case 'Briefing':
        return allBriefingChecked
      case 'Confirm':
        return true
      default:
        return false
    }
  }

  async function handleSubmit() {
    // Require signature before submitting
    if (!signatureRef.current?.hasSignature()) {
      setSubmitError('Please provide a driver signature before completing the book-out.')
      return
    }

    setIsSubmitting(true)
    setSubmitError(null)
    setUploadProgress(null)
    setOpResults([])

    try {
    const results: OpResult[] = []
    const mileageNum = parseInt(form.mileage, 10)

    // Grab the signature up-front so it can be attached to the event.
    // The event record becomes the canonical source for regenerate-pdf
    // backfills later — we persist signature, briefing ticks, driver
    // name and raw notes as first-class fields (not just stuffed into
    // the `details` blob).
    let earlySignatureBase64: string | undefined
    try {
      const sigBlob = await signatureRef.current?.getBlob()
      if (sigBlob) earlySignatureBase64 = await blobToBase64(sigBlob)
    } catch {
      console.warn('Failed to capture signature for event save')
    }
    const tickedBriefingItems = briefingItems
      .filter(item => form.briefingChecked[item.name])
      .map(item => item.name)

    // ── Step 1: Create vehicle event (with retry) ──
    setUploadProgress('Creating event...')
    const eventResult = await withRetry(
      () =>
        createVehicleEvent({
          vehicleReg: form.vehicleReg,
          eventType: 'Book Out',
          mileage: isNaN(mileageNum) ? null : mileageNum,
          fuelLevel: form.fuelLevel,
          details: [
            `Driver: ${form.driverName}`,
            form.hireHopJob ? `HireHop Job: ${form.hireHopJob}` : null,
            `Photos: ${form.photos.length} captured`,
            `Briefing completed`,
            form.notes ? `Notes: ${form.notes}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          hireHopJob: form.hireHopJob || null,
          clientEmail: form.clientEmail || null,
          hireStatus: 'On Hire',
          driverName: form.driverName || null,
          notes: form.notes || null,
          briefingItems: tickedBriefingItems,
          signatureBase64: earlySignatureBase64 || null,
          // For freelancer deliveries: record who physically did the
          // walkaround. driverName is the customer (on the agreement);
          // deliveredBy is the freelancer.
          deliveredBy: isFreelancer ? freelancerContext?.driverName ?? null : null,
          // Persist per-photo labels so check-in's side-by-side can show
          // meaningful captions on optional extras (e.g. user-typed
          // "Pre-existing chip — driver side"). Required photos use their
          // built-in labels; extras default to "Extra Photo N" unless the
          // staff member tapped to edit.
          photoMeta: form.photos.map(p => ({ angle: String(p.angle), label: p.label })),
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

    // ── Step 1b: Update Fleet Master status to "On Hire" ──
    if (form.vehicleReg) {
      const fleetResult = await updateFleetHireStatus(form.vehicleReg, 'On Hire')
      if (fleetResult.success) {
        results.push({ label: 'Fleet status', success: true, detail: 'Set to On Hire' })
      } else {
        results.push({ label: 'Fleet status', success: false, detail: fleetResult.error || 'Update failed' })
      }
    }

    // ── Step 2: Upload photos to R2 (with retry per photo) ──
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
        results.push({ label: 'Photo upload', success: false, detail: uploadResult.error || 'Upload failed after 3 attempts' })
      }
    }

    // ── Step 3: Generate PDF condition report (with retry) ──
    setUploadProgress('Generating PDF...')
    const now = new Date()
    const eventDate = now.toISOString().split('T')[0]!
    const eventDateTime = now.toISOString()

    // Find the selected vehicle for extra detail
    const selectedVehicle = vehicles.find(v => v.id === form.vehicleId)

    // Resize photos to ~800px wide thumbnails for PDF embedding.
    // Full-res base64 (3-5MB each) exceeds Netlify's 6MB body limit with 8+ photos.
    // Resized JPEGs are ~50-80KB each, keeping the payload under 1MB.
    // R2 public URLs provide "View full size" links in the PDF.
    const safeReg = form.vehicleReg.replace(/\s+/g, '-').toUpperCase()
    const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
    setUploadProgress('Preparing photos for PDF...')
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = []
    let photoConvertFails = 0
    const photoResizePromises = form.photos.map(async (p) => {
      try {
        const base64 = await resizeImageForPdf(p.blob)
        const photoKey = `events/${eventId}/${safeReg}/${p.angle}.jpg`
        const r2Url = r2PublicBase ? `${r2PublicBase}/${photoKey}` : undefined
        return { angle: p.angle, label: p.label, base64, r2Url }
      } catch {
        photoConvertFails++
        console.warn('Failed to resize photo for PDF:', p.angle)
        return null
      }
    })
    const resizedPhotos = await Promise.all(photoResizePromises)
    for (const p of resizedPhotos) {
      if (p) photoBase64s.push(p)
    }
    if (photoConvertFails > 0) {
      results.push({
        label: 'Photo preparation',
        success: false,
        detail: `${photoConvertFails} of ${form.photos.length} photos failed to prepare for PDF`,
      })
    }

    // Reuse the signature we captured before the event was saved.
    // (Previously this re-read the canvas here — duplicate work.)
    const signatureBase64 = earlySignatureBase64

    // ── Run PDF/email and backend operations in parallel for speed ──
    // PDF+email chain depends on itself (PDF must finish before email sends).
    // HireHop checkout, allocation confirm, and hire form write-back are all
    // independent — they run concurrently with PDF/email to cut total time.
    setUploadProgress('Generating PDF & finalising...')

    const pdfData = {
      vehicleReg: form.vehicleReg,
      vehicleType: form.vehicleType,
      vehicleMake: selectedVehicle?.make,
      vehicleModel: selectedVehicle?.model,
      vehicleColour: selectedVehicle?.colour,
      driverName: form.driverName,
      clientEmail: form.clientEmail || undefined,
      hireHopJob: form.hireHopJob || undefined,
      mileage: form.mileage ? parseInt(form.mileage, 10) : null,
      fuelLevel: form.fuelLevel,
      eventDate,
      eventDateTime,
      photos: photoBase64s,
      briefingItems: briefingItems.filter(item => form.briefingChecked[item.name]).map(item => item.name),
      bookOutNotes: form.notes || undefined,
      signatureBase64,
      hireStartDate: form.hireStartDate || undefined,
      hireEndDate: form.hireEndDate || undefined,
      // Hire start time = book-out wall time (when the hire actually
      // begins, not the planned out_time). End time falls back via
      // backend resolveJobHireDates to jobs.end_time.
      hireStartTime: form.hireStartTime || undefined,
      hireEndTime: form.hireEndTime || undefined,
      allDrivers: form.allDrivers,
    }

    // Track: PDF generation → email → additional driver PDFs/emails
    const pdfEmailTrack = (async () => {
      const trackResults: typeof results = []

      const pdfResult = await withRetry(
        () => generateConditionReportPdf(pdfData),
        'PDF generation',
      )

      if (pdfResult.success && pdfResult.data) {
        trackResults.push({
          label: 'PDF report',
          success: true,
          detail: `${pdfResult.data.filename} (${Math.round(pdfResult.data.size / 1024)}KB)`,
        })
      } else {
        trackResults.push({
          label: 'PDF report',
          success: false,
          detail: pdfResult.error || 'Generation failed after 3 attempts',
        })
      }

      // Send email to primary (collecting) driver. We send even when
      // form.clientEmail is empty: the backend resolves a job-level
      // recipient via the address book and falls back to info@ with
      // an amber banner + timeline interaction if nothing's reachable.
      // Without the fallback, condition reports were silently dropped
      // for HH-synced sole-trader jobs that had no contact email.
      if (pdfResult.success && pdfResult.data) {
        const emailResult = await withRetry(
          () =>
            sendConditionReportEmail({
              to: form.clientEmail || null,
              vehicleReg: form.vehicleReg,
              driverName: form.driverName,
              eventDate,
              pdfBase64: pdfResult.data!.pdf,
              pdfFilename: pdfResult.data!.filename,
              hireHopJob: form.hireHopJob || null,
            }),
          'Email sending',
        )

        if (emailResult.success) {
          const isFallback = (emailResult.data as { isFallback?: boolean } | undefined)?.isFallback
          const detailRecipient = isFallback ? 'info@oooshtours.co.uk (no client email on file)' : form.clientEmail || 'recipient resolved by backend'
          trackResults.push({ label: `Email — ${form.driverName}`, success: true, detail: `Sent to ${detailRecipient}` })
        } else {
          trackResults.push({
            label: `Email — ${form.driverName}`,
            success: false,
            detail: emailResult.error || 'Send failed after 3 attempts',
          })
        }
      } else if (!pdfResult.success) {
        trackResults.push({
          label: `Email — ${form.driverName}`,
          success: false,
          detail: 'Skipped — PDF generation failed',
        })
      }

      // Generate PDFs and send emails for additional drivers on this job.
      // We include drivers without a clientEmail too — backend resolves
      // the job-level fallback (info@ + amber banner) so each customer's
      // condition report still lands somewhere staff can forward.
      const additionalDrivers = (form.hireFormEntries || []).filter(
        entry => entry.driverName !== form.driverName,
      )

      if (additionalDrivers.length > 0 && pdfResult.success) {
        for (let i = 0; i < additionalDrivers.length; i++) {
          const driver = additionalDrivers[i]!

          const driverPdfResult = await withRetry(
            () =>
              generateConditionReportPdf({
                ...pdfData,
                driverName: driver.driverName,
                clientEmail: driver.clientEmail || undefined,
              }),
            `PDF for ${driver.driverName}`,
          )

          if (driverPdfResult.success && driverPdfResult.data) {
            const driverEmailResult = await withRetry(
              () =>
                sendConditionReportEmail({
                  to: driver.clientEmail || null,
                  vehicleReg: form.vehicleReg,
                  driverName: driver.driverName,
                  eventDate,
                  pdfBase64: driverPdfResult.data!.pdf,
                  pdfFilename: driverPdfResult.data!.filename,
                  hireHopJob: form.hireHopJob || null,
                }),
              `Email to ${driver.driverName}`,
            )

            if (driverEmailResult.success) {
              const isFallback = (driverEmailResult.data as { isFallback?: boolean } | undefined)?.isFallback
              const detailRecipient = isFallback ? 'info@oooshtours.co.uk (no client email on file)' : driver.clientEmail || 'recipient resolved by backend'
              trackResults.push({
                label: `Email — ${driver.driverName}`,
                success: true,
                detail: `Sent to ${detailRecipient}`,
              })
            } else {
              trackResults.push({
                label: `Email — ${driver.driverName}`,
                success: false,
                detail: driverEmailResult.error || 'Send failed',
              })
            }
          } else {
            trackResults.push({
              label: `PDF — ${driver.driverName}`,
              success: false,
              detail: driverPdfResult.error || 'PDF generation failed',
            })
          }
        }
      }

      return trackResults
    })()

    // HireHop barcode checkout (auto-scan van reg into HH and trigger HH status 5)
    // was previously wired here as a parallel track. Removed 21 Apr 2026 —
    // the experiment never quite worked reliably and staff now advance HH
    // status manually. Future nice-to-have: re-enable once the write-back
    // behaviour is proven (see CLAUDE.md "Future nice-to-haves").

    // Track: Allocation confirm (independent)
    const allocationTrack = (async () => {
      if (!form.allocationId) return []
      try {
        const currentAllocations = await getAllocations()
        const updated = currentAllocations.map(a =>
          a.id === form.allocationId
            ? { ...a, status: 'confirmed' as const, confirmedAt: new Date().toISOString() }
            : a,
        )
        const saveResult = await saveAllocations(updated)
        if (saveResult.success) {
          return [{ label: 'Allocation confirmed', success: true, detail: '' }]
        }
        return [{ label: 'Allocation confirmed', success: false, detail: saveResult.error || 'Save failed' }]
      } catch {
        return [{ label: 'Allocation confirmed', success: false, detail: 'Failed to confirm' }]
      }
    })()

    // Track: Hire form write-back (independent)
    // VE103B ref is only written to the LEAD driver's entry (the one being booked out)
    // V&D soft book-out: skipped — no customer hire form to write back to.
    const writeBackTrack = (async () => {
      if (isVanAndDriver) return []
      const hireFormEntries = form.hireFormEntries || []
      if (hireFormEntries.length === 0) return []
      let writeBackOk = 0
      let writeBackFail = 0
      for (const entry of hireFormEntries) {
        const isLeadDriver = entry.driverName === form.driverName
        const wbResult = await updateDriverHireForm({
          hireFormItemId: entry.id,
          vehicleId: form.vehicleId || undefined,
          vehicleReg: form.vehicleReg,
          mileageOut: isNaN(mileageNum) ? undefined : mileageNum,
          startTime: form.hireStartTime || undefined,
          endTime: form.hireEndTime || undefined,
          ve103b: isLeadDriver ? (form.ve103b || undefined) : undefined,
          returnOvernight: form.returnOvernight || undefined,
        })
        if (wbResult.success) {
          writeBackOk++
        } else {
          writeBackFail++
          console.warn('[book-out] Write-back failed for', entry.driverName, ':', wbResult.error)
        }
      }
      if (writeBackFail === 0) {
        return [{
          label: 'Hire form write-back',
          success: true,
          detail: `${writeBackOk} driver form${writeBackOk > 1 ? 's' : ''} updated`,
        }]
      }
      return [{
        label: 'Hire form write-back',
        success: false,
        detail: `${writeBackOk} updated, ${writeBackFail} failed (column IDs may need configuring)`,
      }]
    })()

    // Track: VE103B certificate generation (independent, only if cert number entered)
    // V&D soft book-out: skipped — no VE103B for non-customer hires.
    const ve103bTrack = (async () => {
      if (isVanAndDriver) return []
      if (!form.ve103b || !form.hireFormEntries || form.hireFormEntries.length === 0) return []
      // Find the lead driver's assignment ID
      const leadEntry = form.hireFormEntries.find(e => e.driverName === form.driverName)
      if (!leadEntry) return []
      try {
        const response = await apiFetch('/api/ve103b/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignment_id: leadEntry.id,
            certificate_number: form.ve103b,
          }),
        })
        if (response.ok) {
          const data = await response.json()
          return [{
            label: 'VE103B certificate',
            success: true,
            detail: `${data.pdf_filename} — ${data.emailed ? 'emailed to office' : 'email failed'}`,
          }]
        }
        const err = await response.json().catch(() => ({ error: 'Unknown error' }))
        return [{
          label: 'VE103B certificate',
          success: false,
          detail: err.message || err.error || `Failed (${response.status})`,
        }]
      } catch (e) {
        return [{
          label: 'VE103B certificate',
          success: false,
          detail: e instanceof Error ? e.message : 'Generation failed',
        }]
      }
    })()

    // Track: V&D assignment promotion + book-out state transition
    // (independent, only fires in van_and_driver mode). Promotes the
    // assignment to assignment_type='driven', records the freelancer person
    // ID, and flips status to 'booked_out' with mileage/fuel.
    const vandPromotionTrack = (async () => {
      if (!isVanAndDriver) return []
      if (!form.vandAssignmentId) {
        return [{
          label: 'V&D assignment promotion',
          success: false,
          detail: 'Missing assignment ID — open V&D book-out from the Job Detail card',
        }]
      }
      try {
        const response = await apiFetch(`/api/assignments/${form.vandAssignmentId}/book-out`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mileage_out: isNaN(mileageNum) ? 0 : mileageNum,
            fuel_level_out: form.fuelLevel || 'unknown',
            assignment_type: 'driven',
            freelancer_person_id: form.vandFreelancerPersonId || null,
            hire_start: form.hireStartDate || null,
            hire_end: form.hireEndDate || null,
            start_time: form.hireStartTime || null,
            end_time: form.hireEndTime || null,
          }),
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          return [{
            label: 'V&D assignment booked out',
            success: false,
            detail: err.error || err.message || `Failed (${response.status})`,
          }]
        }
        const data = await response.json().catch(() => ({}))
        const warnings = (data.warnings as string[] | undefined) || []
        return [{
          label: 'V&D assignment booked out',
          success: true,
          detail: warnings.length > 0 ? `Warnings: ${warnings.join('; ')}` : 'Assignment promoted to driven, status=booked_out',
        }]
      } catch (e) {
        return [{
          label: 'V&D assignment booked out',
          success: false,
          detail: e instanceof Error ? e.message : 'Network error',
        }]
      }
    })()

    // Wait for all parallel tracks to complete
    const [pdfEmailResults, allocResults, wbResults, ve103bResults, vandResults] = await Promise.all([
      pdfEmailTrack,
      allocationTrack,
      writeBackTrack,
      ve103bTrack,
      vandPromotionTrack,
    ])
    results.push(...pdfEmailResults, ...allocResults, ...wbResults, ...ve103bResults, ...vandResults)

    setOpResults(results)
    setUploadProgress(null)
    setIsSubmitting(false)
    setSubmitSuccess(true)
    clearAutosave()
    } catch (err) {
      console.error('[book-out] handleSubmit crashed:', err)

      // If offline, queue the submission for later processing
      if (!navigator.onLine) {
        try {
          await queueSubmission({
            flowType: 'book-out',
            formData: {
              vehicleId: form.vehicleId,
              vehicleReg: form.vehicleReg,
              vehicleType: form.vehicleType,
              vehicleSimpleType: form.vehicleSimpleType,
              driverName: form.driverName,
              clientEmail: form.clientEmail,
              hireHopJob: form.hireHopJob,
              mileage: form.mileage,
              fuelLevel: form.fuelLevel,
              notes: form.notes,
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
          console.error('[book-out] Failed to queue offline submission:', queueErr)
        }
      }

      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred during submission. Please try again.')
      setUploadProgress(null)
      setIsSubmitting(false)
    }
  }

  // Freelancer mode: van-confirm gate. Driver must tap "yes this is my van"
  // before the wizard reveals itself. Protects against a stale token
  // pointing at a reallocated assignment, and gives them a cheap escape
  // hatch back to the portal if something looks wrong. Only renders
  // before a successful submit — after that the success screen takes over.
  if (isFreelancer && freelancerContext && !freelancerVanConfirmed && !submitSuccess && !queuedOffline) {
    return (
      <FreelancerVanConfirmScreen
        context={freelancerContext}
        onConfirm={() => {
          setFreelancerVanConfirmed(true)
          // Jump past the Select Vehicle + Driver & Hire steps — for D&C
          // deliveries the driver is the freelancer themselves and there
          // are no hire forms to pick. Vehicle State (mileage / fuel) is
          // the first thing they actually need to enter.
          const vehicleStateIdx = STEPS.indexOf('Vehicle State')
          setStep(vehicleStateIdx >= 0 ? vehicleStateIdx : 1)
        }}
      />
    )
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
            {form.vehicleReg} book-out has been saved and will be submitted automatically when you&apos;re back online.
          </p>
          <p className="mt-2 text-xs text-blue-600">
            Photos, signature, and all form data have been stored locally.
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
        onDiscardAndGoBack={() => { dismissDraft(); window.history.back() }}
      />
    )
  }

  // Success screen
  if (submitSuccess) {
    const allOk = opResults.every(r => r.success)
    const anyFailed = opResults.some(r => !r.success)

    return (
      <div className="space-y-6 px-4 py-6">
        {/* Header banner */}
        <div className={`rounded-lg border p-6 text-center ${
          allOk
            ? 'border-green-200 bg-green-50'
            : 'border-amber-200 bg-amber-50'
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
            {allOk ? 'Book-Out Complete' : 'Book-Out Completed with Issues'}
          </h2>
          <p className={`mt-1 text-sm ${allOk ? 'text-green-700' : 'text-amber-700'}`}>
            {form.vehicleReg} booked out to {form.driverName}
            {(form.allDrivers?.length || 0) > 1 && (
              <span className="block mt-0.5 text-xs opacity-75">
                Condition reports sent to {form.allDrivers!.length} drivers
              </span>
            )}
          </p>
        </div>

        {/* Per-operation results */}
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
                Failed operations were retried 3 times. Check your connection and try again if needed.
              </p>
            )}
          </div>
        )}
        <div className="flex gap-3">
          {isFreelancer && freelancerContext?.returnUrl ? (
            <button
              type="button"
              onClick={() => {
                clearFreelancerSession()
                window.location.href = freelancerContext.returnUrl!
              }}
              className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-center text-sm font-medium text-white"
            >
              Return to Portal
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  setForm(INITIAL_FORM)
                  setStep(0)
                  setSubmitSuccess(false)
                  setOpResults([])
                }}
                className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700"
              >
                New Book-Out
              </button>
              <Link
                to={vmPath('/vehicles')}
                className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-center text-sm font-medium text-white"
              >
                Back to Fleet
              </Link>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      {/* Header with progress */}
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          {isFreelancer && freelancerContext?.returnUrl ? (
            <a href={freelancerContext.returnUrl} className="text-sm text-gray-500 hover:text-gray-700">
              ← Back
            </a>
          ) : (
            <Link to={vmPath('/vehicles')} className="text-sm text-gray-500 hover:text-gray-700">
              ← Cancel
            </Link>
          )}
          <h1 className="text-base font-semibold text-ooosh-navy">Book Out</h1>
          <span className="text-xs text-gray-400">
            {step + 1} / {STEPS.length}
          </span>
        </div>

        {/* Progress bar */}
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

        {/* Step label + inline nav */}
        <div className="mt-1.5 flex items-center justify-between">
          <p className="text-xs font-medium text-gray-500">{STEPS[step]}</p>
          <div className="flex gap-2">
            {/* Swap vehicle — staff-only escape hatch for last-minute issues
                discovered mid-walkaround (cracked windscreen, won't start, etc).
                Discards photos / mileage / fuel / briefing for THIS van and
                returns to step 0 to pick a different van. Driver, hire form,
                hireHop job stay attached because the hire is unchanged.
                Not exposed to freelancer remote book-outs. */}
            {!isFreelancer && step > 0 && form.vehicleReg && (
              <button
                onClick={() => {
                  const ok = confirm(
                    `Swap from ${form.vehicleReg}?\n\nThis discards the walkaround in progress (photos, mileage, fuel, briefing). The driver and hire details stay attached — you'll just pick a different van.`
                  )
                  if (!ok) return
                  // Clear the autosaved draft so a refresh / re-entry
                  // doesn't restore the abandoned book-out for the old van.
                  clearAutosave()
                  // Reset van-specific fields. Keep driver / hire form /
                  // hireHop job / clientEmail since the hire itself isn't
                  // changing.
                  setForm(f => ({
                    ...f,
                    vehicleId: null,
                    vehicleReg: '',
                    vehicleType: '',
                    vehicleSimpleType: '',
                    mileage: '',
                    fuelLevel: null,
                    photos: [],
                    briefingChecked: {},
                    notes: '',
                    signatureBlob: null,
                  }))
                  setStep(0)
                }}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 active:bg-amber-100"
                title="Swap to a different vehicle (discards walkaround data for this van)"
              >
                Swap vehicle
              </button>
            )}
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
                {isSubmitting ? (uploadProgress ? 'Uploading...' : 'Saving...') : 'Complete'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Offline banner */}
      {!isOnline && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          <p className="text-xs font-medium text-amber-800">
            {isSubmitting
              ? 'You\'re offline — submission will resume automatically when connection returns'
              : 'No internet connection — submission requires connectivity'}
          </p>
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {STEPS[step] === 'Select Vehicle' && (
          <StepSelectVehicle
            vehicles={vehicles}
            loading={vehiclesLoading}
            search={vehicleSearch}
            onSearchChange={setVehicleSearch}
            selectedId={form.vehicleId}
            hireHopJob={form.hireHopJobData || null}
            onSelect={(v) => {
              selectVehicle(v)
              // Always auto-advance on tap — no need for two-step on mobile
              setStep(1)
            }}
          />
        )}

        {STEPS[step] === 'Driver & Hire' && (
          <StepDriverHire form={form} onUpdate={updateForm} isFreelancer={isFreelancer} isVanAndDriver={isVanAndDriver} />
        )}

        {STEPS[step] === 'Vehicle State' && (
          <StepVehicleState form={form} onUpdate={updateForm} lastKnownMileage={lastKnownMileage} />
        )}

        {STEPS[step] === 'Photos' && (
          <StepPhotos
            photos={form.photos}
            onCapture={handlePhotoCapture}
            onRemove={handlePhotoRemove}
            onUpdatePhoto={handlePhotoUpdate}
            requiredCount={requiredPhotoCount}
            capturedCount={capturedRequiredCount}
          />
        )}

        {STEPS[step] === 'Briefing' && (
          <StepBriefing
            items={briefingItems}
            checked={form.briefingChecked}
            vehicleType={form.vehicleSimpleType}
            notes={form.notes}
            onToggle={(itemName) =>
              updateForm('briefingChecked', {
                ...form.briefingChecked,
                [itemName]: !form.briefingChecked[itemName],
              })
            }
            onNotesChange={(notes) => updateForm('notes', notes)}
          />
        )}

        {STEPS[step] === 'Confirm' && (
          <StepConfirm
            form={form}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            error={submitError}
            signatureRef={signatureRef}
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
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-medium text-white active:bg-green-700 disabled:bg-gray-300"
            >
              {isSubmitting ? (uploadProgress || 'Saving...') : 'Complete Book-Out'}
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
  hireHopJob,
  onSelect,
}: {
  vehicles: Vehicle[]
  loading: boolean
  search: string
  onSearchChange: (v: string) => void
  selectedId: string | null
  hireHopJob: HireHopJob | null
  onSelect: (v: Vehicle) => void
}) {
  // Extract van requirements if a HireHop job is linked
  const requirements = useMemo(
    () => hireHopJob ? extractVanRequirements(hireHopJob) : [],
    [hireHopJob],
  )

  // Check if a vehicle matches any requirement from the linked job
  const isTypeMatch = useCallback((v: Vehicle) => {
    if (requirements.length === 0) return false
    return requirements.some(req => vehicleMatchesRequirement(v, req))
  }, [requirements])

  const filtered = useMemo(() => {
    let result = vehicles.filter(v => {
      if (!search) return true
      const term = search.toLowerCase()
      return `${v.reg} ${v.make} ${v.model} ${v.vehicleType}`.toLowerCase().includes(term)
    })

    // When a HireHop job is linked, sort: type matches first, then by reg
    if (requirements.length > 0) {
      result = result.sort((a, b) => {
        const aMatch = isTypeMatch(a) ? 0 : 1
        const bMatch = isTypeMatch(b) ? 0 : 1
        if (aMatch !== bMatch) return aMatch - bMatch
        return a.reg.localeCompare(b.reg)
      })
    }

    return result
  }, [vehicles, search, requirements, isTypeMatch])

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
      {/* Show van requirements from linked HireHop job */}
      {requirements.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5">
          <p className="text-xs font-medium text-blue-700">
            Job #{hireHopJob!.id} requires:
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {requirements.map((req, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800"
              >
                {req.quantity > 1 ? `${req.quantity}x ` : ''}{req.simpleType}
                {req.simpleType !== 'Panel' ? ` ${req.gearbox}` : ''}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-blue-600">Matching vehicles shown first</p>
        </div>
      )}

      <input
        type="text"
        placeholder="Search by reg, make, model..."
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
        autoFocus
      />

      <div className="space-y-2">
        {filtered.map(v => {
          const matched = isTypeMatch(v)
          const gearbox = getGearbox(v.vehicleType)

          return (
            <button
              key={v.id}
              onClick={() => onSelect(v)}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${
                selectedId === v.id
                  ? 'border-ooosh-navy bg-ooosh-navy/5 ring-1 ring-ooosh-navy'
                  : matched
                    ? 'border-green-200 bg-green-50/50 hover:border-green-300 active:bg-green-50'
                    : 'border-gray-200 bg-white hover:border-gray-300 active:bg-gray-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
                  <span className="text-xs text-gray-400">{v.simpleType}</span>
                  {gearbox !== 'unknown' && (
                    <span className="text-[10px] text-gray-400">({gearbox === 'auto' ? 'A' : 'M'})</span>
                  )}
                  {matched && (
                    <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
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
          )
        })}

        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-400">
            No vehicles found
          </p>
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 2: Driver & Hire details (enhanced with HireHop job picker)
 * ────────────────────────────────────────────── */

function StepDriverHire({
  form,
  onUpdate,
  isFreelancer,
  isVanAndDriver,
}: {
  form: BookOutFormState
  onUpdate: <K extends keyof BookOutFormState>(key: K, value: BookOutFormState[K]) => void
  isFreelancer: boolean
  isVanAndDriver: boolean
}) {
  const [showJobPicker, setShowJobPicker] = useState(false)
  const [localJobNum, setLocalJobNum] = useState(form.hireHopJob)
  const jobNumTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Freelancer sessions are scoped to one assignment + job — they don't
  // need (and aren't allowed) the going-out list or the full allocations
  // view. Disable those queries to avoid 403 noise.
  const { data: goingOutJobs } = useGoingOutJobs({ enabled: !isFreelancer })
  const { data: allocations } = useAllocations({ enabled: !isFreelancer })

  // Filter job list to only show jobs that need the selected vehicle type
  const filteredJobs = useMemo(() => {
    if (!goingOutJobs) return []
    // Only show jobs with a van requirement matching this vehicle's type + gearbox
    const vehicleGearbox = form.vehicleType ? getGearbox(form.vehicleType) : 'unknown'
    return goingOutJobs.filter(job => {
      const reqs = extractVanRequirements(job)
      if (reqs.length === 0) return job.itemsFetchFailed // show if items unknown
      return reqs.some(req => {
        if (req.simpleType !== form.vehicleSimpleType) return false
        if (req.simpleType === 'Panel') return true
        if (vehicleGearbox !== 'unknown' && vehicleGearbox !== req.gearbox) return false
        return true
      })
    })
  }, [goingOutJobs, form.vehicleSimpleType, form.vehicleType])

  // Fetch driver hire forms when a job number is entered.
  //
  // Freelancer mode: enabled — the OP backend now allows the freelancer
  // session JWT to read hire forms scoped to the freelancer's own job
  // (see backend/src/routes/hire-forms.ts GET /by-job + PATCH + generate-pdf).
  // We need this so the customer's hire form data flows onto the
  // condition-report PDF + email and the post-book-out write-back +
  // hire-agreement PDF chain can fire.
  //
  // V&D soft book-out: skipped — no customer hire form exists for these
  // hires (Ooosh supplies the driver). The freelancer picker below replaces
  // the customer driver selection.
  const { data: hireForms, isLoading: hireFormsLoading } = useDriverHireForms(
    isVanAndDriver ? null : (form.hireHopJob || null),
  )

  // Find allocation for this vehicle + selected job
  const currentAllocation = useMemo(() => {
    if (!form.hireHopJob || !form.vehicleId) return null
    return (allocations || []).find(
      a => a.hireHopJobId === parseInt(form.hireHopJob, 10) && a.vehicleId === form.vehicleId,
    )
  }, [allocations, form.hireHopJob, form.vehicleId])

  // Find expected allocation for this job (any vehicle)
  const jobAllocations = useMemo(() => {
    if (!form.hireHopJob) return []
    return (allocations || []).filter(a => a.hireHopJobId === parseInt(form.hireHopJob, 10))
  }, [allocations, form.hireHopJob])

  // Auto-populate from hire forms when they load
  const hireFormsAppliedRef = useRef<string | null>(null)
  if (hireForms && hireForms.length > 0 && hireFormsAppliedRef.current !== form.hireHopJob) {
    hireFormsAppliedRef.current = form.hireHopJob

    // Set all drivers list
    const allDriverNames = hireForms.map(hf => hf.driverName).filter(Boolean)
    onUpdate('allDrivers', allDriverNames)

    // Store full hire form entries for multi-driver PDF/email and write-back
    onUpdate('hireFormEntries', hireForms.map(hf => ({
      id: hf.id,
      driverName: hf.driverName,
      clientEmail: hf.clientEmail,
    })))

    // Set hire dates/times and extra fields from first form entry (same per job)
    // Fall back to the HH job's own dates when the hire form record didn't
    // populate them — better than printing "(pending hire form)" on the
    // condition PDF when the job clearly has dates in the system. The
    // backend has the same fallback (resolveJobHireDates) but applying it
    // here means the dates are visible on the form before submit.
    const firstForm = hireForms[0]!
    const fallbackStart = form.hireHopJobData?.outDate || form.hireHopJobData?.jobDate
    const fallbackEnd = form.hireHopJobData?.jobEndDate || form.hireHopJobData?.returnDate
    if (firstForm.hireStart) onUpdate('hireStartDate', firstForm.hireStart)
    else if (fallbackStart) onUpdate('hireStartDate', fallbackStart)
    if (firstForm.hireEnd) onUpdate('hireEndDate', firstForm.hireEnd)
    else if (fallbackEnd) onUpdate('hireEndDate', fallbackEnd)
    if (firstForm.startTime) onUpdate('hireStartTime', firstForm.startTime)
    if (firstForm.endTime) onUpdate('hireEndTime', firstForm.endTime)
    if (firstForm.excess) onUpdate('excess', firstForm.excess)
    if (firstForm.ve103b) onUpdate('ve103b', firstForm.ve103b)
    if (firstForm.returnOvernight) onUpdate('returnOvernight', firstForm.returnOvernight)

    // Auto-fill client email from hire form if not already set
    if (!form.clientEmail && firstForm.clientEmail) {
      onUpdate('clientEmail', firstForm.clientEmail)
    }

    // Auto-fill driver name if only one driver and name not already set
    if (!form.driverName && allDriverNames.length === 1) {
      onUpdate('driverName', allDriverNames[0]!)
    }
  }

  function handleSelectJob(job: HireHopJob) {
    // Reset hire forms tracking so they re-apply for new job
    hireFormsAppliedRef.current = null

    // Auto-fill from the job
    onUpdate('hireHopJob', String(job.id))
    onUpdate('hireHopJobData', job)

    // Always update client email — set to new job's email or clear it
    onUpdate('clientEmail', job.contactEmail || '')

    // Reset driver-related fields (will be re-populated from hire forms)
    onUpdate('driverName', '')
    onUpdate('allDrivers', undefined)
    onUpdate('hireFormEntries', undefined)
    onUpdate('hireStartDate', null)
    onUpdate('hireEndDate', null)
    onUpdate('hireStartTime', null)
    onUpdate('hireEndTime', null)
    onUpdate('excess', null)
    onUpdate('ve103b', null)
    onUpdate('returnOvernight', null)

    // Find allocation for this vehicle on this job
    const alloc = (allocations || []).find(
      a => a.hireHopJobId === job.id && a.vehicleId === form.vehicleId,
    )

    if (alloc) {
      onUpdate('allocationId', alloc.id)
      // Auto-fill driver name from allocation if present
      if (alloc.driverName) {
        onUpdate('driverName', alloc.driverName)
      }
    } else {
      onUpdate('allocationId', undefined)
    }

    setShowJobPicker(false)
  }

  function handleSelectDriver(driverName: string, hireFormId: string) {
    // Track the specific hire form by id, not just the name. Multiple
    // drivers on the same job can share a name (seen in the 22 Apr test
    // case: three "Mr Jonathan Mark Wood" rows with different emails)
    // and selecting by name alone highlighted all matching siblings.
    onUpdate('selectedHireFormId', hireFormId)
    onUpdate('driverName', driverName)
    const selectedForm = hireForms?.find(hf => hf.id === hireFormId)
    if (selectedForm?.clientEmail) {
      onUpdate('clientEmail', selectedForm.clientEmail)
    }
  }

  // Default start/end times to 09:00 when a job is selected and times aren't set
  const defaultTimesRef = useRef(false)
  if (form.hireHopJob && !form.hireStartTime && !form.hireEndTime && !defaultTimesRef.current) {
    defaultTimesRef.current = true
    onUpdate('hireStartTime', '09:00')
    onUpdate('hireEndTime', '09:00')
  }

  return (
    <div className="space-y-4">
      {/* Vehicle summary */}
      <div className="rounded-lg bg-gray-50 p-3">
        <p className="text-xs font-medium text-gray-400">Vehicle</p>
        <p className="font-mono text-sm font-bold text-ooosh-navy">{form.vehicleReg}</p>
        <p className="text-xs text-gray-500">{form.vehicleType}</p>
      </div>

      {/* HireHop job — picker + manual input */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          HireHop Job
        </label>

        {/* Job picker button / selected job display */}
        {form.hireHopJobData ? (
          <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-bold text-ooosh-navy">#{form.hireHopJobData.id}</span>
                <span className="ml-2 text-sm text-gray-700">
                  {form.hireHopJobData.company || form.hireHopJobData.contactName}
                </span>
              </div>
              <button
                onClick={() => {
                  onUpdate('hireHopJob', '')
                  onUpdate('hireHopJobData', null)
                  onUpdate('allocationId', undefined)
                  onUpdate('allDrivers', undefined)
                  onUpdate('hireFormEntries', undefined)
                  onUpdate('hireStartDate', null)
                  onUpdate('hireEndDate', null)
                  onUpdate('hireStartTime', null)
                  onUpdate('hireEndTime', null)
                  onUpdate('excess', null)
                  onUpdate('ve103b', null)
                  onUpdate('returnOvernight', null)
                  hireFormsAppliedRef.current = null
                }}
                className="text-xs font-medium text-blue-600"
              >
                Clear
              </button>
            </div>

            {/* Match indicator */}
            {currentAllocation ? (
              <div className="mt-1.5 flex items-center gap-1">
                <svg className="h-3.5 w-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs text-green-700">This van is allocated to this job</span>
              </div>
            ) : jobAllocations.length > 0 ? (
              <div className="mt-1.5 flex items-center gap-1">
                <svg className="h-3.5 w-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs text-amber-700">
                  Expected: {jobAllocations.map(a => a.vehicleReg).join(', ')}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {filteredJobs.length > 0 && !showJobPicker && (
              <button
                onClick={() => setShowJobPicker(true)}
                className="mb-2 w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm font-medium text-blue-700 active:bg-blue-100"
              >
                Select from upcoming jobs ({filteredJobs.length})
              </button>
            )}

            {showJobPicker && filteredJobs.length > 0 && (
              <div className="mb-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-500">Select a job</p>
                  <button
                    onClick={() => setShowJobPicker(false)}
                    className="text-xs text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
                {filteredJobs.map(job => (
                  <button
                    key={job.id}
                    onClick={() => handleSelectJob(job)}
                    className="flex w-full items-center justify-between rounded-lg border border-gray-200 p-2 text-left active:bg-gray-50"
                  >
                    <div>
                      <span className="text-sm font-bold text-ooosh-navy">#{job.id}</span>
                      <span className="ml-2 text-sm text-gray-600">
                        {job.company || job.contactName || job.jobName}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">{job.outDate}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Manual job # input — always available */}
        {!form.hireHopJobData && (
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={localJobNum}
            onChange={e => {
              const cleaned = e.target.value.replace(/\D/g, '')
              setLocalJobNum(cleaned)
              // Debounce the parent update to prevent re-render on each keystroke
              if (jobNumTimerRef.current) clearTimeout(jobNumTimerRef.current)
              jobNumTimerRef.current = setTimeout(() => {
                onUpdate('hireHopJob', cleaned)
                hireFormsAppliedRef.current = null
              }, 600)
            }}
            onBlur={() => {
              // Sync immediately on blur
              if (jobNumTimerRef.current) clearTimeout(jobNumTimerRef.current)
              if (localJobNum !== form.hireHopJob) {
                onUpdate('hireHopJob', localJobNum)
                hireFormsAppliedRef.current = null
              }
            }}
            placeholder="Or enter job # manually"
            className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
          />
        )}
      </div>

      {/* Driver selection — hire form based for self-drive, freelancer
          picker for Van & Driver soft book-out. */}
      {isVanAndDriver ? (
        <VandDriverPicker form={form} onUpdate={onUpdate} />
      ) : (
        <DriverSelection
          form={form}
          hireForms={hireForms || null}
          hireFormsLoading={hireFormsLoading}
          onSelectDriver={handleSelectDriver}
          onUpdate={onUpdate}
          isFreelancer={isFreelancer}
        />
      )}

      {/* Hire form fields — editable, auto-populated from the linked hire form */}
      {form.hireHopJob && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Hire Details</p>

          {/* Start/End Time + VE103b — staff only (freelancers don't need these) */}
          {!isFreelancer && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-600">
                      Start Time
                      {form.hireStartDate && (
                        <span className="ml-1.5 font-normal text-gray-400">
                          {formatShortDate(form.hireStartDate)}
                        </span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={() => onUpdate('hireStartTime', nowHHmm())}
                      className="text-[10px] font-medium text-ooosh-navy hover:underline"
                    >
                      Now
                    </button>
                  </div>
                  <TimeInput
                    value={form.hireStartTime || '09:00'}
                    onChange={v => onUpdate('hireStartTime', v || null)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-600">
                      End Time
                      {form.hireEndDate && (
                        <span className="ml-1.5 font-normal text-gray-400">
                          {formatShortDate(form.hireEndDate)}
                        </span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={() => onUpdate('hireEndTime', nowHHmm())}
                      className="text-[10px] font-medium text-ooosh-navy hover:underline"
                    >
                      Now
                    </button>
                  </div>
                  <TimeInput
                    value={form.hireEndTime || '09:00'}
                    onChange={v => onUpdate('hireEndTime', v || null)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">VE103b</label>
                <input
                  type="text"
                  value={form.ve103b || ''}
                  onChange={e => onUpdate('ve103b', e.target.value || null)}
                  placeholder="VE103b reference"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                />
              </div>
            </>
          )}

          <ReturnOvernightField
            value={form.returnOvernight || ''}
            onChange={val => onUpdate('returnOvernight', val || null)}
            hireEndDate={form.hireEndDate || null}
          />

          {form.excess && (
            <div className="text-xs text-gray-600">
              Excess: <strong>{form.excess}</strong>
              <span className="ml-1 text-gray-400">(read-only — calculated from hire form data)</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Van & Driver picker sub-component
 *
 * Used in soft book-out mode for jobs where Ooosh supplies the freelancer
 * driver (no customer hire form). Defaults to crew already assigned on the
 * job's quote_assignments where is_ooosh_crew=true; falls back to a free-text
 * driver name + email entry when no crew is assigned (or staff want to
 * override). On selection, populates form.driverName + form.clientEmail
 * (used as the condition-report PDF email recipient) + form.vandFreelancerPersonId
 * (PATCHed onto the assignment row at submit time).
 * ────────────────────────────────────────────── */

interface OooshCrewMember {
  person_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  mobile: string | null
  is_freelancer: boolean
  is_approved: boolean
  role: string | null
}

function VandDriverPicker({
  form,
  onUpdate,
}: {
  form: BookOutFormState
  onUpdate: <K extends keyof BookOutFormState>(key: K, value: BookOutFormState[K]) => void
}) {
  const [crew, setCrew] = useState<OooshCrewMember[] | null>(null)
  const [loadingCrew, setLoadingCrew] = useState(false)
  const [crewError, setCrewError] = useState<string | null>(null)
  const [showOverride, setShowOverride] = useState(false)
  const fetchedJobRef = useRef<string | null>(null)

  // Fetch Ooosh crew assigned on this job once a HireHop job number is set
  useEffect(() => {
    if (!form.hireHopJob) return
    if (fetchedJobRef.current === form.hireHopJob) return
    fetchedJobRef.current = form.hireHopJob
    setLoadingCrew(true)
    setCrewError(null)
    apiFetch(`/api/quotes/job/${form.hireHopJob}/ooosh-crew`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json = await r.json()
        setCrew((json.data as OooshCrewMember[]) || [])
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load crew'
        console.warn('[V&D picker] Failed to load crew:', msg)
        setCrewError(msg)
        setCrew([])
      })
      .finally(() => setLoadingCrew(false))
  }, [form.hireHopJob])

  function selectCrewMember(c: OooshCrewMember) {
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Freelancer'
    onUpdate('driverName', fullName)
    onUpdate('clientEmail', c.email || '')
    onUpdate('vandFreelancerPersonId', c.person_id)
    onUpdate('allDrivers', [fullName])
    setShowOverride(false)
  }

  function clearSelection() {
    onUpdate('driverName', '')
    onUpdate('clientEmail', '')
    onUpdate('vandFreelancerPersonId', null)
    onUpdate('allDrivers', undefined)
  }

  if (!form.hireHopJob) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
        <p className="text-sm text-amber-800">Select a HireHop job above to load Ooosh crew</p>
      </div>
    )
  }

  if (loadingCrew) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
        <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
        <p className="text-xs text-gray-500">Loading Ooosh crew on this job...</p>
      </div>
    )
  }

  const hasCrew = (crew?.length ?? 0) > 0

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          Freelancer driving (Van &amp; Driver) <span className="text-red-500">*</span>
        </label>

        {hasCrew && !showOverride && (
          <div className="space-y-1.5">
            {(crew || []).map(c => {
              const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Freelancer'
              const isSelected = form.vandFreelancerPersonId === c.person_id
              return (
                <button
                  key={c.person_id}
                  type="button"
                  onClick={() => selectCrewMember(c)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                    isSelected
                      ? 'border-green-400 bg-green-50 font-medium text-green-800 ring-1 ring-green-400'
                      : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                  }`}
                >
                  <div>
                    <span>{fullName}</span>
                    {c.role && <span className="ml-2 text-xs text-gray-400">({c.role})</span>}
                    {c.email && <span className="ml-2 text-xs text-gray-400">{c.email}</span>}
                  </div>
                  {isSelected && (
                    <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {!hasCrew && !showOverride && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
            <p className="mb-1.5 text-sm text-gray-600">No Ooosh crew assigned on this job yet</p>
            {crewError && (
              <p className="mb-2 text-xs text-red-600">Error: {crewError}</p>
            )}
            <p className="text-xs text-gray-500">Add a freelancer manually or assign crew first via Crew &amp; Transport</p>
          </div>
        )}

        {/* Override link — picks any freelancer, free-text fallback */}
        {!showOverride ? (
          <button
            type="button"
            onClick={() => setShowOverride(true)}
            className="mt-2 text-xs text-ooosh-navy underline"
          >
            {hasCrew ? '+ Different freelancer' : '+ Add freelancer manually'}
          </button>
        ) : (
          <div className="mt-2 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Freelancer name</label>
              <input
                type="text"
                value={form.driverName}
                onChange={e => onUpdate('driverName', e.target.value)}
                placeholder="Full name"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Email <span className="text-gray-400">(for condition report)</span>
              </label>
              <input
                type="email"
                value={form.clientEmail}
                onChange={e => onUpdate('clientEmail', e.target.value)}
                placeholder="freelancer@example.com"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
              />
            </div>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowOverride(false)}
                className="text-xs text-gray-500 underline"
              >
                Cancel
              </button>
              {(form.driverName || form.clientEmail) && (
                <button
                  type="button"
                  onClick={() => { clearSelection(); setShowOverride(false); }}
                  className="text-xs text-red-600 underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        {form.driverName && (
          <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <strong>{form.driverName}</strong>
            {form.clientEmail && <span className="ml-1">— {form.clientEmail}</span>}
            <p className="mt-1 text-xs text-blue-700">
              Condition report PDF will be emailed to the freelancer. No customer hire form needed for Van &amp; Driver hires.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Driver Selection sub-component
 * Shows drivers from hire forms (job-specific first, then cross-job fallback)
 * ────────────────────────────────────────────── */

function DriverSelection({
  form,
  hireForms,
  hireFormsLoading,
  onSelectDriver,
  onUpdate,
  isFreelancer,
}: {
  form: BookOutFormState
  hireForms: import('../lib/driver-hire-api').DriverHireForm[] | null
  hireFormsLoading: boolean
  onSelectDriver: (name: string, hireFormId: string) => void
  onUpdate: <K extends keyof BookOutFormState>(key: K, value: BookOutFormState[K]) => void
  isFreelancer: boolean
}) {
  // Determine if we need cross-job fallback. Freelancers never get the
  // cross-job fallback — their session is scoped to one job, and the
  // hire-forms backend would 403 the cross-job query anyway.
  const jobDrivers = (hireForms || []).filter(hf => hf.driverName)
  const needsFallback = !hireFormsLoading && hireForms !== null && jobDrivers.length === 0 && !isFreelancer

  // Fetch active hire forms (cross-job) only when needed
  const { data: activeForms, isLoading: activeFormsLoading } = useActiveHireForms(needsFallback)

  // No job selected — show message
  if (!form.hireHopJob) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
        <p className="text-sm text-gray-500">Select a HireHop job above to see registered drivers</p>
      </div>
    )
  }

  // Loading
  if (hireFormsLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
        <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
        <p className="text-xs text-gray-500">Loading registered drivers...</p>
      </div>
    )
  }

  // Drivers found for this job — show them
  if (jobDrivers.length > 0) {
    return (
      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Who is collecting? <span className="text-red-500">*</span>
          </label>
          <div className="space-y-1.5">
            {jobDrivers.map(hf => {
              const isSelected = form.selectedHireFormId
                ? form.selectedHireFormId === hf.id
                : false
              return (
              <button
                key={hf.id}
                onClick={() => onSelectDriver(hf.driverName, hf.id)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                  isSelected
                    ? 'border-green-400 bg-green-50 font-medium text-green-800 ring-1 ring-green-400'
                    : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                }`}
              >
                <div>
                  <span>{hf.driverName}</span>
                  {hf.clientEmail && (
                    <span className="ml-2 text-xs text-gray-400">{hf.clientEmail}</span>
                  )}
                </div>
                {isSelected && (
                  <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              )
            })}
          </div>
        </div>

        {/* Hire dates display */}
        {(form.hireStartDate || form.hireEndDate) && (
          <div className="flex flex-wrap gap-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
            {form.hireStartDate && (
              <span>Start: <strong>{formatShortDate(form.hireStartDate)}{form.hireStartTime ? ` ${form.hireStartTime}` : ''}</strong></span>
            )}
            {form.hireEndDate && (
              <span>End: <strong>{formatShortDate(form.hireEndDate)}{form.hireEndTime ? ` ${form.hireEndTime}` : ''}</strong></span>
            )}
          </div>
        )}

        {/* Client email — auto-filled from driver, editable */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Client Email</label>
          <input
            type="email"
            value={form.clientEmail}
            onChange={e => onUpdate('clientEmail', e.target.value)}
            placeholder="client@example.com"
            className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
          />
          <p className="mt-1 text-xs text-gray-400">For condition report email</p>
        </div>
      </div>
    )
  }

  // Freelancer mode + no hire forms on this job — clear "contact the
  // office" message. Don't show the cross-job fallback (irrelevant) and
  // don't surface a manual driver entry path (their session is scoped
  // and they shouldn't try to bypass the customer's hire-form flow).
  if (isFreelancer) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">
          Customer hire form not received yet
        </p>
        <p className="mt-2 text-sm text-amber-800 leading-relaxed">
          The customer for job #{form.hireHopJob} hasn't completed their hire
          form. Please contact the Ooosh office before continuing — they'll
          chase the customer and let you know when you can proceed.
        </p>
        <p className="mt-2 text-xs text-amber-700">
          The Driver &amp; Hire step can't be advanced until the hire form
          arrives.
        </p>
      </div>
    )
  }

  // No drivers for this job — show cross-job fallback
  const crossJobDrivers = (activeForms || []).filter(hf => hf.driverName)
  // Deduplicate by driver name
  const uniqueDrivers = crossJobDrivers.reduce((acc, hf) => {
    if (!acc.some(d => d.driverName === hf.driverName)) acc.push(hf)
    return acc
  }, [] as typeof crossJobDrivers)

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs font-medium text-amber-800">
          No hire forms received for job #{form.hireHopJob}
        </p>
        <p className="mt-1 text-xs text-amber-700">
          A completed hire form is required before book-out. Select a driver from another job below, or ensure the driver completes their hire form first.
        </p>
      </div>

      {activeFormsLoading ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
          <div className="mx-auto mb-2 h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-ooosh-navy" />
          <p className="text-xs text-gray-500">Loading drivers from other jobs...</p>
        </div>
      ) : uniqueDrivers.length > 0 ? (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Select from other jobs <span className="text-red-500">*</span>
          </label>
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {uniqueDrivers.map(hf => {
              const isSelected = form.selectedHireFormId === hf.id
              return (
              <button
                key={hf.id}
                onClick={() => {
                  onSelectDriver(hf.driverName, hf.id)
                  if (hf.clientEmail) onUpdate('clientEmail', hf.clientEmail)
                }}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                  isSelected
                    ? 'border-green-400 bg-green-50 font-medium text-green-800 ring-1 ring-green-400'
                    : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                }`}
              >
                <div>
                  <span>{hf.driverName}</span>
                  {hf.hireHopJob && (
                    <span className="ml-2 text-xs text-gray-400">Job #{hf.hireHopJob}</span>
                  )}
                </div>
                {isSelected && (
                  <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              )
            })}
          </div>

          {/* Client email */}
          {form.driverName && (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium text-gray-700">Client Email</label>
              <input
                type="email"
                value={form.clientEmail}
                onChange={e => onUpdate('clientEmail', e.target.value)}
                placeholder="client@example.com"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
              />
              <p className="mt-1 text-xs text-gray-400">For condition report email</p>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">
            No drivers with completed hire forms found. The driver must complete the hire form process before the vehicle can be booked out.
          </p>
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 3: Vehicle State (mileage + fuel)
 * ────────────────────────────────────────────── */

function StepVehicleState({
  form,
  onUpdate,
  lastKnownMileage,
}: {
  form: BookOutFormState
  onUpdate: <K extends keyof BookOutFormState>(key: K, value: BookOutFormState[K]) => void
  lastKnownMileage: number | null
}) {
  const enteredMileage = form.mileage ? parseInt(form.mileage, 10) : null
  const isBelowLast = lastKnownMileage != null && enteredMileage != null && !isNaN(enteredMileage) && enteredMileage < lastKnownMileage

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Mileage Reading <span className="text-red-500">*</span>
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={form.mileage}
          onChange={e => onUpdate('mileage', e.target.value)}
          placeholder="Current odometer reading"
          className={`w-full rounded-lg border px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-1 ${
            isBelowLast
              ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
              : 'border-gray-200 focus:border-ooosh-navy focus:ring-ooosh-navy'
          }`}
          autoFocus
        />
        {lastKnownMileage != null && (
          <p className="mt-1 text-xs text-gray-500">
            Last recorded: {lastKnownMileage.toLocaleString()} mi
          </p>
        )}
        {isBelowLast && (
          <p className="mt-1 text-xs font-medium text-red-600">
            Mileage cannot be lower than the last recorded reading ({lastKnownMileage!.toLocaleString()} mi)
          </p>
        )}
        {!lastKnownMileage && (
          <p className="mt-1 text-xs text-gray-400">Read from the dashboard display</p>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Fuel Level <span className="text-red-500">*</span>
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
        {/* Fuel gauge visual */}
        {form.fuelLevel && (
          <div className="mt-3 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-3 rounded-full bg-green-500 transition-all duration-300"
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
 * Step 4: Photos
 * ────────────────────────────────────────────── */

function StepPhotos({
  photos,
  onCapture,
  onRemove,
  onUpdatePhoto,
  requiredCount,
  capturedCount,
}: {
  photos: CapturedPhoto[]
  onCapture: (photo: CapturedPhoto) => void
  onRemove: (angle: string) => void
  onUpdatePhoto: (angle: string, partial: Partial<Pick<CapturedPhoto, 'label'>>) => void
  requiredCount: number
  capturedCount: number
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">
          Condition Photos
        </p>
        <span
          className={`text-xs font-medium ${
            capturedCount >= requiredCount ? 'text-green-600' : 'text-amber-600'
          }`}
        >
          {capturedCount} / {requiredCount} required
        </span>
      </div>

      <PhotoCapture
        photos={photos}
        onCapture={onCapture}
        onRemove={onRemove}
        onUpdate={onUpdatePhoto}
      />
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 5: Client Briefing Checklist
 * ────────────────────────────────────────────── */

function StepBriefing({
  items,
  checked,
  vehicleType,
  notes,
  onToggle,
  onNotesChange,
}: {
  items: ChecklistItem[]
  checked: Record<string, boolean>
  vehicleType: string
  notes: string
  onToggle: (itemName: string) => void
  onNotesChange: (notes: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-gray-400">
          No briefing items configured for {vehicleType || 'this vehicle type'}
        </p>
        <p className="mt-1 text-xs text-gray-300">
          Briefing items can be customised in Settings
        </p>
      </div>
    )
  }

  const allDone = items.every(item => checked[item.name])

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-blue-50 p-3">
        <p className="text-xs font-medium text-blue-800">
          Client Briefing — {vehicleType}
        </p>
        <p className="mt-0.5 text-xs text-blue-600">
          Confirm each item has been shown / explained to the driver
        </p>
      </div>

      <div className="space-y-2">
        {items.map(item => (
          <button
            key={item.name}
            onClick={() => onToggle(item.name)}
            className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
              checked[item.name]
                ? 'border-green-200 bg-green-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <div
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                checked[item.name]
                  ? 'border-green-500 bg-green-500'
                  : 'border-gray-300 bg-white'
              }`}
            >
              {checked[item.name] && (
                <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <span className={`text-sm ${checked[item.name] ? 'text-green-800' : 'text-gray-700'}`}>
                {item.name}
              </span>
              {item.notes && (
                <p className="mt-0.5 text-xs text-gray-400">{item.notes}</p>
              )}
            </div>
          </button>
        ))}
      </div>

      {allDone && (
        <div className="rounded-lg bg-green-50 p-3 text-center">
          <p className="text-xs font-medium text-green-700">✓ All briefing items confirmed</p>
        </div>
      )}

      {/* Free-text notes */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-gray-600">
          Any notes or observations?
        </label>
        <textarea
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          placeholder="Optional — anything the driver should know, or notes about the vehicle condition..."
          rows={3}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Step 6: Confirm & Submit
 * ────────────────────────────────────────────── */

function StepConfirm({
  form,
  error,
  signatureRef,
}: {
  form: BookOutFormState
  onSubmit: () => void
  isSubmitting: boolean
  error: string | null
  signatureRef: React.RefObject<SignatureCaptureHandle>
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800">Review Book-Out</h3>

      {/* Summary cards */}
      <div className="space-y-3">
        <SummaryRow label="Vehicle" value={`${form.vehicleReg} — ${form.vehicleType}`} />
        <SummaryRow label="Driver" value={form.driverName} />
        {form.clientEmail && <SummaryRow label="Email" value={form.clientEmail} />}
        {form.hireHopJob && <SummaryRow label="HireHop Job" value={`#${form.hireHopJob}`} />}
        {form.allDrivers && form.allDrivers.length > 1 && (
          <SummaryRow label="All Drivers" value={form.allDrivers.join(', ')} />
        )}
        {form.hireStartDate && <SummaryRow label="Hire Start" value={`${formatShortDate(form.hireStartDate)}${form.hireStartTime ? ` ${form.hireStartTime}` : ''}`} />}
        {form.hireEndDate && <SummaryRow label="Hire End" value={`${formatShortDate(form.hireEndDate)}${form.hireEndTime ? ` ${form.hireEndTime}` : ''}`} />}
        {form.excess && <SummaryRow label="Excess" value={form.excess} />}
        {form.ve103b && <SummaryRow label="VE103b" value={form.ve103b} />}
        {form.returnOvernight && <SummaryRow label="Return Overnight" value={form.returnOvernight} />}
        <SummaryRow label="Mileage" value={form.mileage ? `${parseInt(form.mileage, 10).toLocaleString()} mi` : '—'} />
        <SummaryRow label="Fuel" value={form.fuelLevel || '—'} />
        <SummaryRow label="Photos" value={`${form.photos.length} captured`} />
        {form.notes && <SummaryRow label="Notes" value={form.notes} />}
      </div>

      {/* Photo thumbnails */}
      {form.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {form.photos.map(p => (
            <img
              key={p.angle}
              src={p.blobUrl}
              alt={p.label}
              className="h-14 w-14 rounded border border-gray-200 object-cover"
            />
          ))}
        </div>
      )}

      {/* Signature capture — grabbed from canvas at submit time, no confirm step */}
      <SignatureCapture ref={signatureRef} />

      {error && (
        <div className="rounded-lg bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <p className="text-center text-xs text-gray-400">
        This will record the book-out and email the hire agreement(s) to the driver(s).
      </p>
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

/** Return Overnight field with collapsible explanation */
function ReturnOvernightField({
  value,
  onChange,
  hireEndDate,
}: {
  value: string
  onChange: (val: string) => void
  hireEndDate: string | null
}) {
  const [showHelp, setShowHelp] = useState(false)

  // Build dynamic explanation using hire end date
  const endDateFormatted = hireEndDate ? formatShortDate(hireEndDate) : 'the last hire date'
  const dayBeforeEnd = hireEndDate ? (() => {
    try {
      const d = new Date(hireEndDate + 'T00:00:00')
      d.setDate(d.getDate() - 1)
      return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
    } catch { return 'the day before' }
  })() : 'the day before'

  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <label className="block text-xs font-medium text-gray-600">Return Overnight</label>
        <button
          type="button"
          onClick={() => setShowHelp(!showHelp)}
          className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-bold text-gray-500 hover:bg-gray-300"
        >
          ?
        </button>
      </div>
      {showHelp && (
        <div className="mb-2 rounded-lg border border-blue-100 bg-blue-50 p-2.5 text-xs text-blue-800 leading-relaxed">
          This hire is due back by 9am on <strong>{endDateFormatted}</strong>. If they would like
          to return &ldquo;out of hours&rdquo; (i.e. between 5pm on <strong>{dayBeforeEnd}</strong> and
          9am on <strong>{endDateFormatted}</strong>) then that&apos;s usually fine &mdash; we just need to know
          in advance so we can send them info on how to do that (gate code, where to park, etc).
        </div>
      )}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
      >
        <option value="">— Select —</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </div>
  )
}

/** Format YYYY-MM-DD to short display: "3 Mar 2026" */
function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}

/** Current local time as "HH:mm" — for the Start Time / End Time "Now" buttons. */
function nowHHmm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ──────────────────────────────────────────────
 * Freelancer van-confirmation screen
 *
 * Shown on arrival from the portal, before the book-out wizard itself.
 * Surfaces the allocated van reg + make/model + job number so the driver
 * can sanity-check before starting the walkaround. Wrong van → "back to
 * portal" kicks them out to re-click the delivery card, which will mint
 * a fresh token (giving staff a chance to fix the allocation).
 * ────────────────────────────────────────────── */

function FreelancerVanConfirmScreen({
  context,
  onConfirm,
}: {
  context: {
    vehicleReg?: string
    vehicleMakeModel?: string
    jobId: string
    driverName?: string
    returnUrl: string | null
  }
  onConfirm: () => void
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Book-out · Confirm vehicle
        </p>
        <h1 className="mt-2 text-3xl font-bold text-ooosh-navy">
          {context.vehicleReg || 'Loading…'}
        </h1>
        {context.vehicleMakeModel && (
          <p className="mt-1 text-sm text-gray-700">{context.vehicleMakeModel}</p>
        )}
        <dl className="mt-5 space-y-2 border-t border-gray-100 pt-4 text-sm">
          {context.driverName && (
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Driver</dt>
              <dd className="text-gray-900">{context.driverName}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">HireHop job</dt>
            <dd className="font-mono text-gray-900">#{context.jobId}</dd>
          </div>
        </dl>
        <p className="mt-5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Check the reg matches the van you&apos;re taking. If it doesn&apos;t, go back to
          the portal &mdash; someone&apos;s mis-allocated and we can fix it.
        </p>
        <button
          type="button"
          onClick={onConfirm}
          className="mt-5 w-full rounded-lg bg-ooosh-navy py-3 text-base font-semibold text-white active:bg-opacity-90"
        >
          Yes, start book-out
        </button>
        {context.returnUrl && (
          <a
            href={context.returnUrl}
            className="mt-3 block w-full rounded-lg border border-gray-200 py-3 text-center text-sm font-medium text-gray-700"
          >
            Wrong van — back to portal
          </a>
        )}
      </div>
    </div>
  )
}
