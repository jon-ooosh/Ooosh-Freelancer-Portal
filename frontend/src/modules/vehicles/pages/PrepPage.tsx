import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { apiFetch } from '../config/api-config'
import { Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useQueryClient } from '@tanstack/react-query'
import { useVehicles } from '../hooks/useVehicles'
import { usePrepAutosave } from '../hooks/usePrepAutosave'
import { useSettings } from '../hooks/useSettings'
import { getPrepSections as getPrepSectionsFromSettings } from '../lib/settings-api'
import type { ChecklistItem, DetailPrompt } from '../lib/settings-api'
import { DEFAULT_CHECKLIST_SETTINGS } from '../config/default-checklist-settings'
import { createVehicleEvent } from '../lib/events-api'
import { fetchLastEventForVehicle } from '../lib/events-query'
import { fetchLastPrepSession, extractTyreValues } from '../lib/prep-history'
import { updateFleetHireStatus } from '../lib/fleet-status'
import { uploadAllPhotos } from '../lib/photo-upload'
import { withRetry } from '../lib/retry'
import { saveIssue } from '../lib/issues-r2-api'
import { mapPrepItemToCategory, mapPrepItemToComponent, mapMondaySeverityToIssueSeverity } from '../lib/issue-mapping'
import { getStock } from '../lib/stock-api'
import { recordPrepConsumption } from '../lib/stock-api'
import { buildConsumptionTransactions } from '../lib/stock-consumption'
import { VehicleIssuesBanner } from '../components/issues/VehicleIssuesBanner'
import { SignatureCapture } from '../components/book-out/SignatureCapture'
import type { SignatureCaptureHandle } from '../components/book-out/SignatureCapture'
import type { Vehicle } from '../types/vehicle'
import type { CapturedPhoto } from '../types/vehicle-event'
import { FUEL_LEVELS } from '../types/vehicle-event'
import type { FuelLevel } from '../types/vehicle-event'

// ── Types ──

interface OpResult {
  label: string
  success: boolean
  detail?: string
}

interface FlaggedItem {
  itemName: string
  selectedOption: string
  severity: 'Critical' | 'Major' | 'Minor'
  description: string
  photos: CapturedPhoto[]
}

interface PrepSection {
  name: string
  items: ChecklistItem[]
}

// Overall prep status options
const OVERALL_STATUS_OPTIONS = [
  { value: 'Ready for hire', colour: 'green' },
  { value: 'Needs minor attention', colour: 'amber' },
  { value: 'Needs urgent attention', colour: 'red' },
  { value: 'Not ready', colour: 'red' },
] as const

type Phase = 'queue' | 'prepping' | 'complete'

export function PrepPage() {
  const queryClient = useQueryClient()
  const { data: allVehicles, isLoading: vehiclesLoading } = useVehicles()
  const { data: settings } = useSettings()
  const autosave = usePrepAutosave()
  const signatureRef = useRef<SignatureCaptureHandle | null>(null)

  const [phase, setPhase] = useState<Phase>('queue')
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null)

  // Header fields
  const [preparedBy, setPreparedBy] = useState('')
  const [mileage, setMileage] = useState('')
  const [fuelLevel, setFuelLevel] = useState<FuelLevel | null>(null)

  // Previous values for pre-fill / validation
  const [previousMileage, setPreviousMileage] = useState<number | null>(null)
  const [previousFuelLevel, setPreviousFuelLevel] = useState<string | null>(null)
  const [previousTyreValues, setPreviousTyreValues] = useState<Record<string, string>>({})

  // Responses: item name -> selected value (option text, number as string, or free text)
  const [responses, setResponses] = useState<Record<string, string>>({})
  // Section notes: section name -> notes text
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>({})
  // Flagged items
  const [flaggedItems, setFlaggedItems] = useState<FlaggedItem[]>([])
  // Overall status
  const [overallStatus, setOverallStatus] = useState('')
  // Response follow-up details: item name -> detail text
  const [responseDetails, setResponseDetails] = useState<Record<string, string>>({})
  // Collapsible sections
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})

  // Testing mode: ?testing in URL enables submitting without all items answered
  const [testingMode] = useState(() => new URLSearchParams(window.location.search).has('testing'))
  // Validation state
  const [showValidation, setShowValidation] = useState(false)
  const [validationToast, setValidationToast] = useState(false)

  // Silent time tracking
  const [prepStartedAt, setPrepStartedAt] = useState<string | null>(null)

  // Submit state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [opResults, setOpResults] = useState<OpResult[]>([])

  // All active vehicles (not old/sold), split into "needs prep" and "other"
  const activeVehicles = useMemo(
    () => (allVehicles || []).filter(v => !v.isOldSold),
    [allVehicles],
  )
  const prepQueue = useMemo(
    () => activeVehicles.filter(v => v.hireStatus === 'Prep Needed'),
    [activeVehicles],
  )
  const otherVehicles = useMemo(
    () => activeVehicles.filter(v => v.hireStatus !== 'Prep Needed'),
    [activeVehicles],
  )

  // Get prep checklist sections from R2 settings (fallback to defaults)
  const sections: PrepSection[] = useMemo(() => {
    if (!selectedVehicle) return []
    const prepMap = settings?.prepItems && Object.keys(settings.prepItems).length > 0
      ? settings.prepItems
      : DEFAULT_CHECKLIST_SETTINGS.prepItems
    return getPrepSectionsFromSettings(prepMap, selectedVehicle.simpleType)
  }, [selectedVehicle, settings])

  // Flat list of all items
  const prepItems: ChecklistItem[] = useMemo(
    () => sections.flatMap(s => s.items),
    [sections],
  )

  // Count completed items (any response = completed)
  const completedCount = prepItems.filter(item => responses[item.name] !== undefined && responses[item.name] !== '').length
  const totalCount = prepItems.length
  const allAnswered = totalCount > 0 && completedCount === totalCount

  // Mileage validation
  const mileageNum = parseInt(mileage, 10)
  const mileageTooLow = previousMileage != null && !isNaN(mileageNum) && mileageNum < previousMileage

  // Can submit: (all answered OR testing mode) + overall status + name + mileage valid
  const canSubmit = (testingMode || allAnswered) && overallStatus !== '' && preparedBy.trim() !== '' && !mileageTooLow

  // ── Autosave effect ──
  useEffect(() => {
    if (!selectedVehicle || phase !== 'prepping') return
    autosave.save(selectedVehicle.reg, {
      vehicleReg: selectedVehicle.reg,
      savedAt: Date.now(),
      preparedBy,
      mileage,
      fuelLevel,
      responses,
      responseDetails,
      prepStartedAt,
      sectionNotes,
      flaggedItems: flaggedItems.map(f => ({
        itemName: f.itemName,
        selectedOption: f.selectedOption,
        severity: f.severity,
        description: f.description,
      })),
      overallStatus,
    })
  }, [selectedVehicle, phase, preparedBy, mileage, fuelLevel, responses, responseDetails, prepStartedAt, sectionNotes, flaggedItems, overallStatus, autosave])

  // ── Handlers ──

  const setResponse = useCallback((itemName: string, value: string) => {
    setResponses(r => ({ ...r, [itemName]: value }))
  }, [])

  const setResponseDetail = useCallback((itemName: string, value: string) => {
    setResponseDetails(d => ({ ...d, [itemName]: value }))
  }, [])

  // Clear validation highlights when all items are answered
  useEffect(() => {
    if (showValidation && allAnswered) {
      setShowValidation(false)
    }
  }, [showValidation, allAnswered])

  const setSectionNote = useCallback((sectionName: string, value: string) => {
    setSectionNotes(n => ({ ...n, [sectionName]: value }))
  }, [])

  const toggleSection = useCallback((sectionName: string) => {
    setCollapsedSections(c => ({ ...c, [sectionName]: !c[sectionName] }))
  }, [])

  const handleFlagItem = useCallback((itemName: string, selectedOption: string) => {
    setFlaggedItems(prev => {
      const existing = prev.find(f => f.itemName === itemName)
      if (existing) {
        return prev.map(f =>
          f.itemName === itemName ? { ...f, selectedOption } : f,
        )
      }
      return [...prev, {
        itemName,
        selectedOption,
        severity: 'Minor' as const,
        description: '',
        photos: [],
      }]
    })
  }, [])

  const updateFlaggedItem = useCallback((itemName: string, updates: Partial<FlaggedItem>) => {
    setFlaggedItems(prev =>
      prev.map(f => f.itemName === itemName ? { ...f, ...updates } : f),
    )
  }, [])

  const removeFlaggedItem = useCallback((itemName: string) => {
    setFlaggedItems(prev => prev.filter(f => f.itemName !== itemName))
  }, [])

  async function handleStartPrep(vehicle: Vehicle) {
    // Check for saved progress first
    const saved = autosave.load(vehicle.reg)
    if (saved) {
      const age = Date.now() - saved.savedAt
      const ageStr = age < 3600000
        ? `${Math.round(age / 60000)} minutes`
        : `${Math.round(age / 3600000)} hours`
      const resume = confirm(
        `You have saved progress for ${vehicle.reg} from ${ageStr} ago. Resume where you left off?`,
      )
      if (resume) {
        setSelectedVehicle(vehicle)
        setPreparedBy(saved.preparedBy)
        setMileage(saved.mileage)
        setFuelLevel(saved.fuelLevel)
        setResponses(saved.responses)
        setResponseDetails(saved.responseDetails || {})
        setPrepStartedAt(saved.prepStartedAt || new Date().toISOString())
        setSectionNotes(saved.sectionNotes)
        setFlaggedItems(saved.flaggedItems.map(f => ({ ...f, photos: [] })))
        setOverallStatus(saved.overallStatus)
        setCollapsedSections({})
        setPhase('prepping')
      } else {
        autosave.clear(vehicle.reg)
        initFreshPrep(vehicle)
      }
    } else {
      initFreshPrep(vehicle)
    }

    // Fetch previous data for pre-fill (non-blocking)
    loadPreviousData(vehicle.reg)
  }

  function initFreshPrep(vehicle: Vehicle) {
    setSelectedVehicle(vehicle)
    setResponses({})
    setResponseDetails({})
    setPrepStartedAt(new Date().toISOString())
    setSectionNotes({})
    setFlaggedItems([])
    setOverallStatus('')
    setCollapsedSections({})
    setMileage('')
    setFuelLevel(null)
    setPreparedBy('')
    setShowValidation(false)
    setPhase('prepping')

    // Create "Prep Started" event (fire-and-forget)
    createVehicleEvent({
      vehicleReg: vehicle.reg,
      eventType: 'Prep Started',
      details: `Prep started for ${vehicle.simpleType} ${vehicle.reg}`,
    }).catch(err => {
      console.warn('[prep] Failed to create Prep Started event:', err)
    })
  }

  async function loadPreviousData(vehicleReg: string) {
    try {
      const [lastEvent, lastPrep] = await Promise.all([
        fetchLastEventForVehicle(vehicleReg),
        fetchLastPrepSession(vehicleReg),
      ])

      if (lastEvent?.mileage != null) {
        setPreviousMileage(lastEvent.mileage)
      }
      if (lastEvent?.fuelLevel) {
        setPreviousFuelLevel(lastEvent.fuelLevel)
      }
      if (lastPrep) {
        setPreviousTyreValues(extractTyreValues(lastPrep))
      }
    } catch (err) {
      console.warn('[prep] Failed to load previous data:', err)
    }
  }

  async function handleCompletePrep() {
    if (!selectedVehicle) return

    // Validation: if not testing mode and items incomplete, highlight and scroll
    if (!testingMode && !allAnswered) {
      setShowValidation(true)
      setValidationToast(true)
      setTimeout(() => setValidationToast(false), 3000)

      // Expand all sections with incomplete items
      const expandUpdates: Record<string, boolean> = {}
      for (const section of sections) {
        if (section.items.some(i => !responses[i.name])) {
          expandUpdates[section.name] = false
        }
      }
      setCollapsedSections(c => ({ ...c, ...expandUpdates }))

      // Scroll to first unanswered item
      const firstUnanswered = prepItems.find(item => !responses[item.name])
      if (firstUnanswered) {
        setTimeout(() => {
          document.getElementById(`prep-item-${firstUnanswered.name}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 150)
      }
      return
    }

    if (!canSubmit) return

    setIsSubmitting(true)
    setUploadProgress(null)
    setOpResults([])
    const results: OpResult[] = []

    const completedAt = new Date().toISOString()
    const actualStartedAt = prepStartedAt || completedAt
    const durationMinutes = Math.round(
      (new Date(completedAt).getTime() - new Date(actualStartedAt).getTime()) / 60000,
    )
    const parsedMileage = parseInt(mileage, 10)

    // Capture signature
    signatureRef.current?.getBlob()

    // Step 1: Create "Prep Completed" event on Monday
    setUploadProgress('Creating prep event...')
    const flagSummary = flaggedItems.length > 0
      ? `Flagged items: ${flaggedItems.map(f => f.itemName).join(', ')}`
      : ''
    const eventResult = await withRetry(
      () =>
        createVehicleEvent({
          vehicleReg: selectedVehicle.reg,
          eventType: 'Prep Completed',
          mileage: isNaN(parsedMileage) ? null : parsedMileage,
          fuelLevel: fuelLevel,
          details: [
            `Prepared by: ${preparedBy}`,
            `Status: ${overallStatus}`,
            `Checklist: ${completedCount}/${totalCount} items`,
            `Duration: ${durationMinutes} min`,
            flagSummary || null,
          ].filter(Boolean).join('\n'),
        }),
      'R2 event creation',
    )

    const eventId = eventResult.data?.id || `local_${Date.now()}`
    if (eventResult.success && !eventResult.data?.error) {
      results.push({ label: 'Event saved', success: true, detail: 'Prep Completed recorded' })
    } else {
      results.push({
        label: 'Event saved',
        success: false,
        detail: eventResult.data?.error || eventResult.error || 'Failed after 3 attempts',
      })
    }

    // Step 2: Upload flagged item photos to R2
    const allFlaggedPhotos = flaggedItems.flatMap(f => f.photos)
    if (allFlaggedPhotos.length > 0) {
      setUploadProgress(`Uploading photos (0/${allFlaggedPhotos.length})...`)
      const uploadResult = await withRetry(
        () =>
          uploadAllPhotos(
            allFlaggedPhotos,
            eventId,
            selectedVehicle.reg,
            (completed, total) => {
              setUploadProgress(`Uploading photos (${completed}/${total})...`)
            },
          ),
        'Photo uploads',
      )
      if (uploadResult.success) {
        results.push({ label: 'Photo uploads', success: true, detail: `${allFlaggedPhotos.length} uploaded` })
      } else {
        results.push({ label: 'Photo uploads', success: false, detail: uploadResult.error || 'Upload failed' })
      }
    }

    // Step 3: Create Issues for each flagged item (Monday.com + R2)
    if (flaggedItems.length > 0) {
      setUploadProgress('Creating issues...')
      for (const flagged of flaggedItems) {
        // R2 (source of truth for the issues tracker)
        try {
          const r2Issue = {
            id: crypto.randomUUID(),
            vehicleReg: selectedVehicle.reg,
            vehicleId: selectedVehicle.id,
            vehicleMake: selectedVehicle.make,
            vehicleModel: selectedVehicle.model,
            vehicleType: selectedVehicle.simpleType || selectedVehicle.vehicleType,
            mileageAtReport: mileage ? parseInt(mileage, 10) : null,
            hireHopJob: null,
            category: mapPrepItemToCategory(flagged.itemName),
            component: mapPrepItemToComponent(flagged.itemName),
            severity: mapMondaySeverityToIssueSeverity(flagged.severity),
            summary: `${flagged.itemName}: ${flagged.selectedOption}`,
            status: 'Open' as const,
            reportedBy: preparedBy || 'Prep',
            reportedAt: new Date().toISOString(),
            reportedDuring: 'Prep' as const,
            resolvedAt: null,
            photos: [] as string[],
            activity: [{
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              author: preparedBy || 'Prep',
              action: 'Reported',
              note: flagged.description || '',
            }],
          }
          await saveIssue(r2Issue).catch(err =>
            console.warn(`[prep] Failed to save R2 issue for ${flagged.itemName}:`, err),
          )
        } catch (err) {
          console.warn(`[prep] Failed to build R2 issue for ${flagged.itemName}:`, err)
        }
      }
      results.push({
        label: 'Issues created',
        success: true,
        detail: `${flaggedItems.length} issue${flaggedItems.length !== 1 ? 's' : ''} logged`,
      })
    }

    // Step 4: Save prep session JSON to R2
    setUploadProgress('Saving prep data...')
    try {
      const prepSessionData = {
        vehicleReg: selectedVehicle.reg,
        vehicleType: selectedVehicle.simpleType,
        vehicleId: selectedVehicle.id,
        preparedBy,
        mileage: isNaN(parsedMileage) ? null : parsedMileage,
        fuelLevel,
        date: new Date().toISOString().slice(0, 10),
        startedAt: actualStartedAt,
        completedAt,
        durationMinutes,
        eventId,
        overallStatus,
        sections: sections.map(sec => ({
          name: sec.name,
          items: sec.items.map(item => ({
            name: item.name,
            inputType: item.inputType,
            value: responses[item.name] || '',
            detail: responseDetails[item.name] || undefined,
            unit: item.unit || undefined,
            flagged: flaggedItems.some(f => f.itemName === item.name),
          })),
          notes: sectionNotes[sec.name] || '',
        })),
        flaggedItems: flaggedItems.map(f => ({
          checklistItem: f.itemName,
          selectedOption: f.selectedOption,
          severity: f.severity,
          description: f.description,
          photoKeys: f.photos.map(p => `events/${eventId}/${selectedVehicle.reg}/${p.angle}_${p.timestamp}.jpg`),
        })),
      }

      const resp = await apiFetch('/save-prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleReg: selectedVehicle.reg,
          eventId,
          data: prepSessionData,
        }),
      })

      if (resp.ok) {
        results.push({ label: 'Prep data saved', success: true, detail: 'Stored to R2' })
      } else {
        results.push({ label: 'Prep data saved', success: false, detail: 'R2 save failed' })
      }
    } catch (err) {
      console.warn('[prep] Failed to save prep data to R2:', err)
      results.push({ label: 'Prep data saved', success: false, detail: 'R2 save error' })
    }

    // Step 5: Record stock consumption (non-blocking — don't fail the prep)
    try {
      setUploadProgress('Recording stock usage...')
      const stockData = await getStock()
      if (stockData.items.length > 0) {
        const prepResponses = prepItems.map(item => ({
          name: item.name,
          value: responses[item.name] || '',
          detail: responseDetails[item.name] || undefined,
        }))
        const consumptionTxns = buildConsumptionTransactions(prepResponses, stockData.items, {
          vehicleReg: selectedVehicle.reg,
          prepEventId: eventId,
          preparedBy: preparedBy || 'Prep',
        })
        if (consumptionTxns.length > 0) {
          const stockResult = await recordPrepConsumption(consumptionTxns)
          if (stockResult.success) {
            results.push({ label: 'Stock updated', success: true, detail: `${stockResult.consumed} item${stockResult.consumed !== 1 ? 's' : ''} deducted` })
          } else {
            results.push({ label: 'Stock updated', success: false, detail: stockResult.error || 'Failed' })
          }
        }
      }
    } catch (err) {
      console.warn('[prep] Failed to record stock consumption:', err)
      // Non-blocking — stock tracking shouldn't prevent prep completion
    }

    // Step 6: Update Fleet Master status
    setUploadProgress('Updating fleet status...')
    const newStatus =
      overallStatus === 'Ready for hire' || overallStatus === 'Needs minor attention'
        ? 'Available'
        : 'Not Ready'

    const fleetResult = await updateFleetHireStatus(selectedVehicle.id, newStatus)
    if (fleetResult.success) {
      results.push({ label: 'Fleet status', success: true, detail: `Set to ${newStatus}` })
    } else {
      results.push({ label: 'Fleet status', success: false, detail: fleetResult.error || 'Update failed' })
    }

    // Clear autosave + invalidate cache
    autosave.clear(selectedVehicle.reg)
    await queryClient.invalidateQueries({ queryKey: ['vehicles'] })

    setOpResults(results)
    setUploadProgress(null)
    setIsSubmitting(false)
    setPhase('complete')
  }

  function handleReset() {
    if (selectedVehicle) {
      autosave.clear(selectedVehicle.reg)
    }
    setPhase('queue')
    setSelectedVehicle(null)
    setResponses({})
    setResponseDetails({})
    setPrepStartedAt(null)
    setSectionNotes({})
    setFlaggedItems([])
    setOverallStatus('')
    setOpResults([])
    setShowValidation(false)
    setPreviousMileage(null)
    setPreviousFuelLevel(null)
    setPreviousTyreValues({})
  }

  // ── Complete screen ──
  if (phase === 'complete') {
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
            {allOk ? 'Prep Complete' : 'Prep Completed with Issues'}
          </h2>
          <p className={`mt-1 text-sm ${allOk ? 'text-green-700' : 'text-amber-700'}`}>
            {selectedVehicle?.reg} — {overallStatus}
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
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleReset}
            className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700"
          >
            Back to Queue
          </button>
          <Link
            to={vmPath('/vehicles')}
            className="flex-1 rounded-lg bg-ooosh-navy py-2.5 text-center text-sm font-medium text-white"
          >
            View Fleet
          </Link>
        </div>
      </div>
    )
  }

  // ── Prepping screen (rich form) ──
  if (phase === 'prepping' && selectedVehicle) {
    return (
      <div className="flex min-h-[calc(100vh-8rem)] flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                if (confirm('Stop prep and return to queue? Your progress has been auto-saved.')) {
                  setPhase('queue')
                  setSelectedVehicle(null)
                  setPreviousMileage(null)
                  setPreviousFuelLevel(null)
                  setPreviousTyreValues({})
                }
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              &larr; Cancel
            </button>
            <h1 className="text-base font-semibold text-ooosh-navy">Vehicle Prep</h1>
            <span className="text-xs text-gray-400">
              {completedCount}/{totalCount}
              {testingMode && completedCount < totalCount && (
                <span className="text-amber-500"> ({totalCount - completedCount} skipped)</span>
              )}
            </span>
          </div>

          {/* Progress bar */}
          <div className="mt-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-1.5 rounded-full bg-ooosh-navy transition-all duration-300"
              style={{ width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Vehicle info card — matching fleet page layout */}
        <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-ooosh-navy">{selectedVehicle.reg}</h2>
              <p className="mt-0.5 text-sm text-gray-500">
                {selectedVehicle.model || selectedVehicle.vehicleType}
              </p>
              <p className="text-xs text-gray-400">
                {selectedVehicle.make}
                {selectedVehicle.colour && ` · ${selectedVehicle.colour}`}
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {selectedVehicle.simpleType}
            </span>
          </div>
        </div>

        {/* Open issues banner */}
        <div className="px-4 pt-3">
          <VehicleIssuesBanner vehicleReg={selectedVehicle.reg} />
        </div>

        {/* Validation toast */}
        {validationToast && (
          <div className="fixed top-16 left-4 right-4 z-50 rounded-lg bg-red-600 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg">
            Please complete highlighted items
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {/* Testing mode banner */}
          {testingMode && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
              <svg className="h-4 w-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-xs font-medium text-amber-700">
                Testing mode — items are optional
              </span>
            </div>
          )}

          {/* Header fields */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Prep Details</h3>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Prepared by *</label>
              <input
                type="text"
                value={preparedBy}
                onChange={e => setPreparedBy(e.target.value)}
                placeholder="Your name"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Mileage</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={mileage}
                  onChange={e => setMileage(e.target.value)}
                  placeholder={previousMileage != null ? `Prev: ${previousMileage.toLocaleString()}` : 'Current miles'}
                  className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 ${
                    mileageTooLow
                      ? 'border-red-300 focus:border-red-300 focus:ring-red-300'
                      : 'border-gray-200 focus:border-blue-300 focus:ring-blue-300'
                  }`}
                />
                {mileageTooLow && (
                  <p className="mt-1 text-xs text-red-500">
                    Cannot be lower than previous ({previousMileage!.toLocaleString()} mi)
                  </p>
                )}
                {previousMileage != null && !mileageTooLow && (
                  <p className="mt-1 text-xs text-gray-400">
                    Previous: {previousMileage.toLocaleString()} mi
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Fuel Level</label>
                <select
                  value={fuelLevel || ''}
                  onChange={e => setFuelLevel((e.target.value || null) as FuelLevel | null)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                >
                  <option value="">Select...</option>
                  {FUEL_LEVELS.map(lvl => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>
                {previousFuelLevel && fuelLevel && (() => {
                  const prevIdx = FUEL_LEVELS.indexOf(previousFuelLevel as FuelLevel)
                  const currIdx = FUEL_LEVELS.indexOf(fuelLevel)
                  if (prevIdx >= 0 && currIdx >= 0 && Math.abs(currIdx - prevIdx) > 2) {
                    return (
                      <p className="mt-1 text-xs text-amber-600">
                        Significantly different from previous ({previousFuelLevel})
                      </p>
                    )
                  }
                  return null
                })()}
                {previousFuelLevel && !fuelLevel && (
                  <p className="mt-1 text-xs text-gray-400">
                    Previous: {previousFuelLevel}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Checklist sections */}
          {sections.map(section => (
            <PrepSectionComponent
              key={section.name}
              section={section}
              responses={responses}
              responseDetails={responseDetails}
              flaggedItems={flaggedItems}
              previousTyreValues={previousTyreValues}
              recommendedTyrePsiFront={selectedVehicle.recommendedTyrePsiFront}
              recommendedTyrePsiRear={selectedVehicle.recommendedTyrePsiRear}
              sectionNotes={sectionNotes[section.name] || ''}
              collapsed={collapsedSections[section.name] || false}
              showValidation={showValidation}
              onResponse={setResponse}
              onResponseDetail={setResponseDetail}
              onFlag={handleFlagItem}
              onUpdateFlag={updateFlaggedItem}
              onRemoveFlag={removeFlaggedItem}
              onSectionNote={(note) => setSectionNote(section.name, note)}
              onToggleCollapse={() => toggleSection(section.name)}
            />
          ))}

          {prepItems.length === 0 && (
            <div className="rounded-lg bg-amber-50 p-4 text-center">
              <p className="text-sm font-medium text-amber-800">No prep checklist items configured</p>
            </div>
          )}

          {/* Overall status */}
          {totalCount > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Overall Status</h3>
              <p className="text-xs text-gray-500">Van is:</p>
              <div className="grid grid-cols-2 gap-2">
                {OVERALL_STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setOverallStatus(opt.value)}
                    className={`rounded-lg border px-3 py-2.5 text-xs font-medium text-left transition-colors ${
                      overallStatus === opt.value
                        ? opt.colour === 'green'
                          ? 'border-green-400 bg-green-50 text-green-800 ring-1 ring-green-400'
                          : opt.colour === 'amber'
                            ? 'border-amber-400 bg-amber-50 text-amber-800 ring-1 ring-amber-400'
                            : 'border-red-400 bg-red-50 text-red-800 ring-1 ring-red-400'
                        : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                    }`}
                  >
                    {opt.value}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Signature */}
          {totalCount > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Signature</h3>
              <SignatureCapture ref={signatureRef} label="Your Signature" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 bg-white px-4 py-3">
          <button
            onClick={handleCompletePrep}
            disabled={!canSubmit || isSubmitting}
            className={`w-full rounded-lg py-2.5 text-sm font-medium text-white transition-colors ${
              canSubmit && !isSubmitting
                ? 'bg-green-600 active:bg-green-700'
                : 'bg-gray-300 cursor-not-allowed'
            }`}
          >
            {isSubmitting
              ? (uploadProgress || 'Completing...')
              : canSubmit
                ? !allAnswered
                  ? `Complete Prep (${totalCount - completedCount} skipped)`
                  : 'Complete Prep'
                : !preparedBy.trim()
                  ? 'Enter your name to continue'
                  : !testingMode && !allAnswered
                    ? `${totalCount - completedCount} item${totalCount - completedCount !== 1 ? 's' : ''} remaining`
                    : mileageTooLow
                      ? 'Fix mileage to continue'
                      : 'Select overall status'}
          </button>
        </div>
      </div>
    )
  }

  // ── Queue screen ──
  return (
    <div className="space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ooosh-navy">Prep Queue</h2>
          <p className="text-xs text-gray-400">Select a vehicle to begin prep</p>
        </div>
        {prepQueue.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            {prepQueue.length} awaiting prep
          </span>
        )}
      </div>

      {vehiclesLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {/* Prep Needed vehicles — shown first with amber highlight */}
      {!vehiclesLoading && prepQueue.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide">Prep Needed</p>
          {prepQueue.map(v => (
            <VehiclePrepCard key={v.id} vehicle={v} onStartPrep={handleStartPrep} />
          ))}
        </div>
      )}

      {/* All other active vehicles — can still start prep on any */}
      {!vehiclesLoading && otherVehicles.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {prepQueue.length > 0 ? 'Other Vehicles' : 'All Vehicles'}
          </p>
          {otherVehicles.map(v => (
            <VehiclePrepCard key={v.id} vehicle={v} onStartPrep={handleStartPrep} />
          ))}
        </div>
      )}

      {!vehiclesLoading && activeVehicles.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-800">No vehicles found</p>
          <p className="mt-1 text-xs text-gray-400">Check your Fleet Management board</p>
        </div>
      )}

      <div className="pt-2">
        <Link
          to={vmPath('/vehicles')}
          className="block rounded-lg border border-gray-200 bg-white py-2.5 text-center text-sm font-medium text-gray-600 active:bg-gray-50"
        >
          View Fleet
        </Link>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Prep Section — collapsible group of items
 * ────────────────────────────────────────────── */

function PrepSectionComponent({
  section,
  responses,
  responseDetails,
  flaggedItems,
  previousTyreValues,
  recommendedTyrePsiFront,
  recommendedTyrePsiRear,
  sectionNotes,
  collapsed,
  showValidation,
  onResponse,
  onResponseDetail,
  onFlag,
  onUpdateFlag,
  onRemoveFlag,
  onSectionNote,
  onToggleCollapse,
}: {
  section: PrepSection
  responses: Record<string, string>
  responseDetails: Record<string, string>
  flaggedItems: FlaggedItem[]
  previousTyreValues: Record<string, string>
  recommendedTyrePsiFront: number | null
  recommendedTyrePsiRear: number | null
  sectionNotes: string
  collapsed: boolean
  showValidation: boolean
  onResponse: (itemName: string, value: string) => void
  onResponseDetail: (itemName: string, value: string) => void
  onFlag: (itemName: string, selectedOption: string) => void
  onUpdateFlag: (itemName: string, updates: Partial<FlaggedItem>) => void
  onRemoveFlag: (itemName: string) => void
  onSectionNote: (note: string) => void
  onToggleCollapse: () => void
}) {
  const completedInSection = section.items.filter(
    item => responses[item.name] !== undefined && responses[item.name] !== '',
  ).length

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      {/* Section header */}
      <button
        onClick={onToggleCollapse}
        className="flex w-full items-center justify-between bg-gray-50 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-semibold text-gray-800">{section.name}</span>
          {showValidation && completedInSection < section.items.length && (
            <span className="text-xs text-red-500 font-medium">
              ({section.items.length - completedInSection} incomplete)
            </span>
          )}
        </div>
        <span className={`text-xs font-medium ${
          completedInSection === section.items.length
            ? 'text-green-600'
            : 'text-gray-400'
        }`}>
          {completedInSection}/{section.items.length}
        </span>
      </button>

      {/* Section items */}
      {!collapsed && (
        <div className="divide-y divide-gray-100 bg-white">
          {section.items.map(item => (
            <PrepItemRow
              key={item.name}
              item={item}
              value={responses[item.name] || ''}
              responseDetail={responseDetails[item.name] || ''}
              previousValue={previousTyreValues[item.name]}
              recommendedTyrePsi={
                item.name.toLowerCase().startsWith('rear')
                  ? recommendedTyrePsiRear
                  : recommendedTyrePsiFront
              }
              flagged={flaggedItems.find(f => f.itemName === item.name) || null}
              showValidation={showValidation}
              onResponse={(value) => {
                onResponse(item.name, value)
                // Flag logic: option-based flagValues + auto-flag tyre depth ≤ 3mm
                if (item.flagValues.includes(value)) {
                  onFlag(item.name, value)
                } else if (item.unit === 'mm') {
                  const num = parseFloat(value)
                  if (!isNaN(num) && num > 0 && num <= 3) {
                    onFlag(item.name, `${value}mm — below safe minimum`)
                  } else {
                    onRemoveFlag(item.name)
                  }
                } else {
                  onRemoveFlag(item.name)
                }
                // Clear detail if new option has no prompt
                if (!item.detailPrompts[value]) {
                  onResponseDetail(item.name, '')
                }
              }}
              onResponseDetail={(detail) => onResponseDetail(item.name, detail)}
              onUpdateFlag={(updates) => onUpdateFlag(item.name, updates)}
            />
          ))}

          {/* Section notes */}
          <div className="px-4 py-3">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Notes for {section.name}
            </label>
            <textarea
              value={sectionNotes}
              onChange={e => onSectionNote(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Prep Item Row — renders based on input type
 * with photo capture on flagged items
 * ────────────────────────────────────────────── */

function PrepItemRow({
  item,
  value,
  responseDetail,
  previousValue,
  recommendedTyrePsi,
  flagged,
  showValidation,
  onResponse,
  onResponseDetail,
  onUpdateFlag,
}: {
  item: ChecklistItem
  value: string
  responseDetail: string
  previousValue?: string
  recommendedTyrePsi: number | null
  flagged: FlaggedItem | null
  showValidation: boolean
  onResponse: (value: string) => void
  onResponseDetail: (detail: string) => void
  onUpdateFlag: (updates: Partial<FlaggedItem>) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isIncomplete = showValidation && !value
  const gridCols = item.options.length <= 3 ? 'grid-cols-2' : 'grid-cols-3'

  async function handlePhotoCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !flagged) return
    try {
      const { compressImage } = await import('../lib/image-utils')
      const compressed = await compressImage(file, 1024, 0.7)
      const blobUrl = URL.createObjectURL(compressed)
      const newPhoto: CapturedPhoto = {
        angle: 'other',
        label: `Flag photo - ${item.name}`,
        blobUrl,
        blob: compressed,
        timestamp: Date.now(),
      }
      onUpdateFlag({ photos: [...flagged.photos, newPhoto] })
    } catch (err) {
      console.warn('[prep] Failed to process photo:', err)
    }
    e.target.value = ''
  }

  return (
    <div
      id={`prep-item-${item.name}`}
      className={`px-4 py-3 space-y-2 ${isIncomplete ? 'border-l-4 border-red-400 bg-red-50/30' : ''}`}
    >
      {/* Item label */}
      <div>
        <p className="text-sm font-medium text-gray-800">{item.name}</p>
        {item.notes && (
          <p className="text-xs text-gray-400 mt-0.5">{item.notes}</p>
        )}
      </div>

      {/* Input based on type — Options: aligned grid */}
      {item.inputType === 'options' && (
        <>
          <div className={`grid ${gridCols} gap-1.5`}>
            {item.options.map(opt => {
              const isSelected = value === opt
              const isFlagOption = item.flagValues.includes(opt)

              return (
                <button
                  key={opt}
                  onClick={() => onResponse(opt)}
                  className={`rounded-lg px-2 py-2 text-xs font-medium text-center transition-colors ${
                    isSelected
                      ? isFlagOption
                        ? 'bg-amber-500 text-white ring-1 ring-amber-600'
                        : 'bg-green-500 text-white ring-1 ring-green-600'
                      : isFlagOption
                        ? 'border border-amber-200 bg-amber-50 text-amber-700 active:bg-amber-100'
                        : 'border border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                  }`}
                >
                  {isFlagOption && !isSelected && '! '}
                  {opt}
                </button>
              )
            })}
          </div>

          {/* Follow-up detail input for work-done options */}
          {value && item.detailPrompts[value] && (
            <DetailInput
              prompt={item.detailPrompts[value]}
              value={responseDetail}
              onChange={onResponseDetail}
            />
          )}
        </>
      )}

      {/* Number input */}
      {item.inputType === 'number' && (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={value}
              onChange={e => onResponse(e.target.value)}
              placeholder={previousValue ? `Prev: ${previousValue}` : `Enter ${item.unit || 'value'}`}
              className="w-32 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
            {item.unit && (
              <span className="text-xs font-medium text-gray-500">{item.unit}</span>
            )}
          </div>
          {item.unit === 'PSI' && recommendedTyrePsi != null && (
            <p className="mt-1 text-xs text-blue-500">Recommended: {recommendedTyrePsi} PSI</p>
          )}
          {/* Tyre pressure: "Had to adjust?" toggle — tracks pump-ups for wear analysis */}
          {item.unit === 'PSI' && value && (
            <button
              onClick={() => onResponseDetail(responseDetail === 'Pressure adjusted' ? '' : 'Pressure adjusted')}
              className={`mt-1.5 flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                responseDetail === 'Pressure adjusted'
                  ? 'bg-amber-500 text-white ring-1 ring-amber-600'
                  : 'border border-gray-200 bg-white text-gray-500 active:bg-gray-50'
              }`}
            >
              {responseDetail === 'Pressure adjusted' ? '✓ ' : ''}
              Pressure adjusted
            </button>
          )}
          {/* Tyre depth: yellow warning at ≤5mm, red at ≤3mm */}
          {item.unit === 'mm' && value && (() => {
            const depth = parseFloat(value)
            if (!isNaN(depth) && depth > 0 && depth <= 3) {
              return (
                <p className="mt-1 text-xs font-bold text-red-600 bg-red-50 rounded px-2 py-0.5">
                  Below legal minimum (1.6mm) — replace urgently
                </p>
              )
            }
            if (!isNaN(depth) && depth > 3 && depth <= 5) {
              return (
                <p className="mt-1 text-xs font-semibold text-amber-600 bg-amber-50 rounded px-2 py-0.5">
                  Getting low — plan replacement soon
                </p>
              )
            }
            return null
          })()}
          {previousValue && !value && (
            <p className="mt-1 text-xs text-gray-400">Previous: {previousValue} {item.unit}</p>
          )}
        </div>
      )}

      {/* Text input */}
      {item.inputType === 'text' && (
        <textarea
          value={value}
          onChange={e => onResponse(e.target.value)}
          placeholder="Enter details..."
          rows={2}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      )}

      {/* Flag panel — shown when a flagged option is selected or auto-flagged */}
      {flagged && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-xs font-semibold text-amber-800">Issue flagged — {flagged.selectedOption}</span>
          </div>

          {/* Auto-flag tyre depth warning */}
          {item.unit === 'mm' && (
            <p className="text-xs font-bold text-red-600 bg-red-50 rounded px-2 py-1">
              Tyre tread below safe limit — replace urgently
            </p>
          )}

          <div>
            <label className="block text-xs font-medium text-amber-700 mb-1">Severity</label>
            <div className="flex gap-1.5">
              {(['Minor', 'Major', 'Critical'] as const).map(sev => (
                <button
                  key={sev}
                  onClick={() => onUpdateFlag({ severity: sev })}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    flagged.severity === sev
                      ? sev === 'Critical'
                        ? 'bg-red-500 text-white'
                        : sev === 'Major'
                          ? 'bg-amber-500 text-white'
                          : 'bg-yellow-500 text-white'
                      : 'border border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-amber-700 mb-1">Description (optional)</label>
            <textarea
              value={flagged.description}
              onChange={e => onUpdateFlag({ description: e.target.value })}
              placeholder="Describe the issue..."
              rows={2}
              className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-gray-700 placeholder:text-gray-400 focus:border-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-300"
            />
          </div>

          {/* Photo capture */}
          <div>
            <label className="block text-xs font-medium text-amber-700 mb-1">Photos (optional)</label>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {flagged.photos.map((photo, pi) => (
                <div key={pi} className="relative shrink-0">
                  <img
                    src={photo.blobUrl}
                    alt={`Issue photo ${pi + 1}`}
                    className="h-16 w-16 rounded border border-amber-200 object-cover"
                  />
                  <button
                    onClick={() => {
                      const updatedPhotos = flagged.photos.filter((_, i) => i !== pi)
                      onUpdateFlag({ photos: updatedPhotos })
                    }}
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
                onClick={() => fileInputRef.current?.click()}
                className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded border-2 border-dashed border-amber-300 bg-amber-50 active:bg-amber-100"
              >
                <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-[8px] font-medium text-amber-500">Add</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handlePhotoCapture}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Detail Input — renders the right input type
 * for follow-up detail prompts (text / options / multi-select)
 * ────────────────────────────────────────────── */

function DetailInput({
  prompt,
  value,
  onChange,
}: {
  prompt: DetailPrompt
  value: string
  onChange: (val: string) => void
}) {
  // Free text input
  if (prompt.type === 'text') {
    return (
      <div className="mt-1.5">
        <label className="block text-xs text-gray-500 mb-0.5">{prompt.label}</label>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Enter details..."
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>
    )
  }

  const choices = prompt.choices || []

  // Single-select options
  if (prompt.type === 'options') {
    return (
      <div className="mt-1.5">
        <label className="block text-xs text-gray-500 mb-0.5">{prompt.label}</label>
        <div className="flex flex-wrap gap-1">
          {choices.map(choice => (
            <button
              key={choice}
              onClick={() => onChange(choice)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                value === choice
                  ? 'bg-blue-500 text-white ring-1 ring-blue-600'
                  : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-50'
              }`}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Multi-select options
  if (prompt.type === 'multi') {
    const selected = value ? value.split(', ').filter(Boolean) : []

    function toggleChoice(choice: string) {
      if (selected.includes(choice)) {
        onChange(selected.filter(s => s !== choice).join(', '))
      } else {
        onChange([...selected, choice].join(', '))
      }
    }

    return (
      <div className="mt-1.5">
        <label className="block text-xs text-gray-500 mb-0.5">
          {prompt.label}
          <span className="text-gray-400 font-normal ml-1">(select all that apply)</span>
        </label>
        <div className="flex flex-wrap gap-1">
          {choices.map(choice => (
            <button
              key={choice}
              onClick={() => toggleChoice(choice)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                selected.includes(choice)
                  ? 'bg-blue-500 text-white ring-1 ring-blue-600'
                  : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-50'
              }`}
            >
              {selected.includes(choice) && '✓ '}
              {choice}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return null
}

/* ──────────────────────────────────────────────
 * Vehicle Prep Card (queue screen)
 * ────────────────────────────────────────────── */

function VehiclePrepCard({
  vehicle,
  onStartPrep,
}: {
  vehicle: Vehicle
  onStartPrep: (v: Vehicle) => void
}) {
  const dmgColor =
    vehicle.damageStatus === 'ALL GOOD'
      ? 'text-green-600'
      : vehicle.damageStatus.includes('REPAIR') || vehicle.damageStatus.includes('NEEDED')
        ? 'text-red-600'
        : 'text-amber-600'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-ooosh-navy">{vehicle.reg}</span>
            {vehicle.hireStatus && (
              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                vehicle.hireStatus === 'Prep Needed'
                  ? 'bg-amber-100 text-amber-700'
                  : vehicle.hireStatus === 'Available'
                    ? 'bg-green-100 text-green-700'
                    : vehicle.hireStatus === 'On Hire'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-600'
              }`}>
                {vehicle.hireStatus}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            {vehicle.simpleType} · {vehicle.make} {vehicle.model && `· ${vehicle.model}`}
          </p>
          {vehicle.colour && (
            <p className="mt-0.5 text-xs text-gray-400">{vehicle.colour}</p>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex gap-3">
          {vehicle.damageStatus && (
            <span className={`text-xs font-medium ${dmgColor}`}>
              {vehicle.damageStatus}
            </span>
          )}
        </div>
        <button
          onClick={() => onStartPrep(vehicle)}
          className="rounded-lg bg-ooosh-navy px-4 py-1.5 text-xs font-medium text-white active:bg-opacity-90"
        >
          Start Prep
        </button>
      </div>
    </div>
  )
}
