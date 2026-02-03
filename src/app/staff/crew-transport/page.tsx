'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

// =============================================================================
// TYPES
// =============================================================================

interface CostingSettings {
  fuelPricePerLitre: number
  expenseMarkupPercent: number
  adminCostPerHour: number
  handoverTimeMinutes: number
  unloadTimeMinutes: number
  minHoursThreshold: number
  hourlyRateFreelancerDay: number
  hourlyRateFreelancerNight: number
  hourlyRateClientDay: number
  hourlyRateClientNight: number
  driverDayRate: number
  expenseVarianceThreshold: number
}

interface JobInfo {
  id: string
  name: string
  clientName: string
  hireStartDate: string
  hireEndDate: string
}

interface Venue {
  id: string
  name: string
  distance: number | null
  driveTime: number | null
}

interface FormData {
  // Core info
  hirehopJobNumber: string
  clientName: string
  jobType: 'delivery' | 'collection' | 'crewed_job' | ''
  whatIsIt: 'vehicle' | 'equipment' | 'people' | ''
  
  // Dates and times
  jobDate: string
  arrivalTime: string
  addCollection: boolean
  collectionDate: string
  collectionArrivalTime: string
  
  // Transport details
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  
  // Venue tracking
  selectedVenueId: string | null
  isNewVenue: boolean
  originalVenueDistance: number | null
  originalVenueDriveTime: number | null
  
  // Return/travel method (for vehicle jobs only)
  travelMethod: 'public_transport' | 'own_way' | ''
  travelTimeMins: number
  travelCost: number
  
  // Work details (for crewed jobs only)
  workType: string
  workTypeOther: string
  workDurationHours: number
  workDescription: string
  
  // Scheduling
  calculationMode: 'hourly' | 'day_rate'
  numberOfDays: number
  earlyStartMinutes: number
  lateFinishMinutes: number
  
  // Overridable settings
  dayRateOverride: number | null
  applyMinHours: boolean
  
  // Additional costs
  tollsParking: number
  additionalCosts: number
  
  // Expense arrangements
  expenseArrangement: 'all_in_fixed' | 'fee_plus_reimbursed' | 'dry_hire_actuals' | ''
  pdArrangement: 'no_pd' | 'we_pay' | 'client_pays_direct' | 'in_fee' | ''
  pdAmount: number
  expenseNotes: string
  
  // Notes
  costingNotes: string
}

interface CalculatedCosts {
  clientChargeLabour: number
  clientChargeFuel: number
  clientChargeExpenses: number
  clientChargeTotal: number
  clientChargeTotalRounded: number  // NEW: Rounded to nearest £1
  freelancerFee: number
  freelancerFeeRounded: number
  expectedFuelCost: number
  expectedOtherExpenses: number
  ourTotalCost: number
  ourMargin: number
  estimatedTimeMinutes: number
  estimatedTimeHours: number
}

interface SaveResult {
  success: boolean
  itemId?: string
  itemName?: string
  board?: string
  collectionItemId?: string
  collectionItemName?: string
  error?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Round to nearest £5 with £1 tolerance (for freelancer fee)
 */
function roundToNearestFive(amount: number): number {
  const lower = Math.floor(amount / 5) * 5
  if (amount - lower <= 1) {
    return lower
  }
  return lower + 5
}

/**
 * Format a date string (YYYY-MM-DD) to UK format with ordinal
 */
function formatDateUK(dateStr: string): string {
  if (!dateStr) return ''
  
  const date = new Date(dateStr + 'T00:00:00')
  if (isNaN(date.getTime())) return dateStr
  
  const day = date.getDate()
  const month = date.toLocaleDateString('en-GB', { month: 'long' })
  const year = date.getFullYear()
  
  const ordinal = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
  }
  
  return `${ordinal(day)} ${month} ${year}`
}

/**
 * Format time from 24h to 12h format
 */
function formatTime12h(time: string): string {
  if (!time) return ''
  const [hours, minutes] = time.split(':')
  const h = parseInt(hours)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${minutes}${ampm}`
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialFormData: FormData = {
  hirehopJobNumber: '',
  clientName: '',
  jobType: '',
  whatIsIt: '',
  jobDate: '',
  arrivalTime: '',
  addCollection: false,
  collectionDate: '',
  collectionArrivalTime: '',
  destination: '',
  distanceMiles: 0,
  driveTimeMinutes: 0,
  selectedVenueId: null,
  isNewVenue: false,
  originalVenueDistance: null,
  originalVenueDriveTime: null,
  travelMethod: '',
  travelTimeMins: 0,
  travelCost: 0,
  workType: '',
  workTypeOther: '',
  workDurationHours: 0,
  workDescription: '',
  calculationMode: 'hourly',
  numberOfDays: 1,
  earlyStartMinutes: 0,
  lateFinishMinutes: 0,
  dayRateOverride: null,
  applyMinHours: true,
  tollsParking: 0,
  additionalCosts: 0,
  expenseArrangement: '',
  pdArrangement: 'no_pd',
  pdAmount: 0,
  expenseNotes: '',
  costingNotes: '',
}

// Work type options matching Monday board
const WORK_TYPE_OPTIONS = [
  { value: 'backline_tech', label: 'Backline Tech' },
  { value: 'general_assist', label: 'General Assist' },
  { value: 'load_in', label: 'Load-in' },
  { value: 'load_out', label: 'Load-out' },
  { value: 'set_up', label: 'Set-up' },
  { value: 'pack_down', label: 'Pack-down' },
  { value: 'engineer_foh', label: 'Engineer - FOH' },
  { value: 'engineer_mons', label: 'Engineer - mons' },
  { value: 'driving_only', label: 'Driving Only' },
  { value: 'other', label: 'Other' },
]

// =============================================================================
// CALCULATION FUNCTIONS
// =============================================================================

function calculateCosts(formData: FormData, settings: CostingSettings): CalculatedCosts {
  const {
    jobType,
    whatIsIt,
    distanceMiles,
    driveTimeMinutes,
    travelMethod,
    travelTimeMins,
    travelCost,
    workDurationHours,
    calculationMode,
    numberOfDays,
    earlyStartMinutes,
    lateFinishMinutes,
    tollsParking,
    additionalCosts,
    addCollection,
    dayRateOverride,
    applyMinHours,
  } = formData

  const {
    fuelPricePerLitre,
    expenseMarkupPercent,
    adminCostPerHour,
    handoverTimeMinutes,
    unloadTimeMinutes,
    minHoursThreshold,
    hourlyRateFreelancerDay,
    hourlyRateFreelancerNight,
    hourlyRateClientDay,
    hourlyRateClientNight,
    driverDayRate,
  } = settings

  const markupMultiplier = 1 + (expenseMarkupPercent / 100)
  const effectiveDayRate = dayRateOverride !== null ? dayRateOverride : driverDayRate
  const isVehicle = whatIsIt === 'vehicle'
  const isThereAndBack = !isVehicle || addCollection

  // =========================================================================
  // DAY RATE MODE
  // =========================================================================
  if (calculationMode === 'day_rate') {
    const fuelCost = (distanceMiles * fuelPricePerLitre) / 5
    const freelancerFee = effectiveDayRate * numberOfDays
    const freelancerFeeRounded = roundToNearestFive(freelancerFee)
    const clientChargeLabour = freelancerFeeRounded * markupMultiplier
    const totalExpenses = tollsParking + additionalCosts + travelCost
    const clientChargeExpenses = totalExpenses * markupMultiplier
    const clientChargeFuel = fuelCost * markupMultiplier
    const clientChargeTotal = clientChargeLabour + clientChargeFuel + clientChargeExpenses
    const clientChargeTotalRounded = Math.round(clientChargeTotal)  // Round to nearest £1
    const ourTotalCost = freelancerFeeRounded + fuelCost + totalExpenses
    
    return {
      clientChargeLabour: Math.round(clientChargeLabour * 100) / 100,
      clientChargeFuel: Math.round(clientChargeFuel * 100) / 100,
      clientChargeExpenses: Math.round(clientChargeExpenses * 100) / 100,
      clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
      clientChargeTotalRounded,
      freelancerFee: Math.round(freelancerFee * 100) / 100,
      freelancerFeeRounded,
      expectedFuelCost: Math.round(fuelCost * 100) / 100,
      expectedOtherExpenses: Math.round(totalExpenses * 100) / 100,
      ourTotalCost: Math.round(ourTotalCost * 100) / 100,
      ourMargin: Math.round((clientChargeTotalRounded - ourTotalCost) * 100) / 100,
      estimatedTimeMinutes: numberOfDays * 8 * 60,
      estimatedTimeHours: numberOfDays * 8,
    }
  }

  // =========================================================================
  // HOURLY MODE
  // =========================================================================
  
  let totalDriveMinutes = 0
  let handlingTime = 0
  
  if (isThereAndBack) {
    totalDriveMinutes = driveTimeMinutes * 2
    handlingTime = unloadTimeMinutes
  } else {
    totalDriveMinutes = driveTimeMinutes + (travelMethod === 'public_transport' ? travelTimeMins : 0)
    handlingTime = handoverTimeMinutes
  }
  
  const workMinutes = jobType === 'crewed_job' ? workDurationHours * 60 : 0
  
  const totalMinutes = totalDriveMinutes + handlingTime + workMinutes
  const totalHours = totalMinutes / 60
  
  const normalMinutes = totalMinutes - earlyStartMinutes - lateFinishMinutes
  const outOfHoursMinutes = earlyStartMinutes + lateFinishMinutes
  
  const normalHours = Math.max(0, normalMinutes) / 60
  const outOfHoursHrs = outOfHoursMinutes / 60
  
  let freelancerLabourPay = (normalHours * hourlyRateFreelancerDay) + (outOfHoursHrs * hourlyRateFreelancerNight)
  
  if (applyMinHours) {
    const minPay = minHoursThreshold * hourlyRateFreelancerDay
    if (freelancerLabourPay < minPay && totalHours > 0) {
      freelancerLabourPay = minPay
    }
  }
  
  const freelancerFeeRounded = roundToNearestFive(freelancerLabourPay)
  
  let clientLabourCharge = (normalHours * hourlyRateClientDay) + (outOfHoursHrs * hourlyRateClientNight)
  
  if (applyMinHours) {
    const minClientCharge = minHoursThreshold * hourlyRateClientDay
    if (clientLabourCharge < minClientCharge && totalHours > 0) {
      clientLabourCharge = minClientCharge
    }
  }
  
  clientLabourCharge += totalHours * adminCostPerHour
  
  const totalMiles = isThereAndBack ? distanceMiles * 2 : distanceMiles
  const fuelCost = (totalMiles * fuelPricePerLitre) / 5
  const clientFuelCharge = fuelCost
  
  const otherExpenses = tollsParking + additionalCosts + travelCost
  const clientExpenseCharge = otherExpenses * markupMultiplier
  
  const clientChargeTotal = clientLabourCharge + clientFuelCharge + clientExpenseCharge
  const clientChargeTotalRounded = Math.round(clientChargeTotal)  // Round to nearest £1
  const ourTotalCost = freelancerFeeRounded + fuelCost + otherExpenses
  
  return {
    clientChargeLabour: Math.round(clientLabourCharge * 100) / 100,
    clientChargeFuel: Math.round(clientFuelCharge * 100) / 100,
    clientChargeExpenses: Math.round(clientExpenseCharge * 100) / 100,
    clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
    clientChargeTotalRounded,
    freelancerFee: Math.round(freelancerLabourPay * 100) / 100,
    freelancerFeeRounded,
    expectedFuelCost: Math.round(fuelCost * 100) / 100,
    expectedOtherExpenses: Math.round(otherExpenses * 100) / 100,
    ourTotalCost: Math.round(ourTotalCost * 100) / 100,
    ourMargin: Math.round((clientChargeTotalRounded - ourTotalCost) * 100) / 100,
    estimatedTimeMinutes: totalMinutes,
    estimatedTimeHours: Math.round(totalHours * 100) / 100,
  }
}

// =============================================================================
// VENUE DROPDOWN COMPONENT
// =============================================================================

interface VenueDropdownProps {
  value: string
  venues: Venue[]
  loading: boolean
  onSelect: (venue: Venue | null, isNew: boolean, newName?: string) => void
}

function VenueDropdown({ value, venues, loading, onSelect }: VenueDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Update search term when value changes externally
  useEffect(() => {
    setSearchTerm(value)
  }, [value])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Filter venues based on search term
  const filteredVenues = venues.filter(venue =>
    venue.name.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 10)  // Limit to 10 results for performance

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setSearchTerm(newValue)
    setIsOpen(true)
    // When typing, clear the selection
    onSelect(null, false, newValue)
  }

  const handleSelectVenue = (venue: Venue) => {
    setSearchTerm(venue.name)
    setIsOpen(false)
    onSelect(venue, false)
  }

  const handleAddNew = () => {
    setIsOpen(false)
    onSelect(null, true, searchTerm)
  }

  const showAddNew = searchTerm.length > 0 && 
    !venues.some(v => v.name.toLowerCase() === searchTerm.toLowerCase())

  return (
    <div ref={dropdownRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={searchTerm}
        onChange={handleInputChange}
        onFocus={() => setIsOpen(true)}
        placeholder={loading ? 'Loading venues...' : 'Search or enter venue name...'}
        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
        disabled={loading}
      />
      
      {isOpen && !loading && (searchTerm.length > 0 || venues.length > 0) && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {filteredVenues.length > 0 && (
            <>
              {filteredVenues.map(venue => (
                <button
                  key={venue.id}
                  type="button"
                  onClick={() => handleSelectVenue(venue)}
                  className="w-full px-4 py-2 text-left hover:bg-gray-100 flex justify-between items-center"
                >
                  <span className="font-medium text-gray-900">{venue.name}</span>
                  {(venue.distance || venue.driveTime) && (
                    <span className="text-xs text-gray-500">
                      {venue.distance && `${venue.distance}mi`}
                      {venue.distance && venue.driveTime && ' · '}
                      {venue.driveTime && `${venue.driveTime}min`}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          
          {showAddNew && (
            <button
              type="button"
              onClick={handleAddNew}
              className="w-full px-4 py-2 text-left hover:bg-blue-50 text-blue-600 border-t border-gray-100 flex items-center gap-2"
            >
              <span className="text-lg">➕</span>
              <span>Add &quot;{searchTerm}&quot; as new venue</span>
            </button>
          )}
          
          {filteredVenues.length === 0 && !showAddNew && searchTerm.length > 0 && (
            <div className="px-4 py-2 text-gray-500 text-sm">
              No venues found
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// WIZARD COMPONENT
// =============================================================================

function CrewTransportWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [loading, setLoading] = useState(true)
  const [loadingJob, setLoadingJob] = useState(false)
  const [loadingVenues, setLoadingVenues] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null)
  const [settings, setSettings] = useState<CostingSettings | null>(null)
  const [settingsSource, setSettingsSource] = useState<string>('')
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null)
  const [venues, setVenues] = useState<Venue[]>([])
  const [step, setStep] = useState(1)

  const jobNumberFromUrl = searchParams.get('job') || ''

  // Fetch venues from Monday.com
  const fetchVenues = useCallback(async () => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin) return

    setLoadingVenues(true)
    try {
      const response = await fetch('/api/staff/venues', {
        headers: { 'x-staff-pin': pin }
      })
      const data = await response.json()
      
      if (data.success && data.venues) {
        setVenues(data.venues)
        console.log(`Loaded ${data.venues.length} venues`)
      }
    } catch (err) {
      console.error('Failed to fetch venues:', err)
    } finally {
      setLoadingVenues(false)
    }
  }, [])

  // Fetch job info from Q&H board
  const fetchJobInfo = useCallback(async (jobNum: string) => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin || !jobNum) return

    setLoadingJob(true)
    try {
      const response = await fetch(`/api/staff/crew-transport?jobNumber=${jobNum}`, {
        headers: { 'x-staff-pin': pin }
      })
      const data = await response.json()
      
      if (data.success && data.jobInfo) {
        setJobInfo(data.jobInfo)
        setFormData(prev => ({
          ...prev,
          clientName: data.jobInfo.clientName || '',
          jobDate: prev.jobDate || data.jobInfo.hireStartDate || '',
          collectionDate: prev.collectionDate || data.jobInfo.hireEndDate || '',
        }))
      }
    } catch (err) {
      console.error('Failed to fetch job info:', err)
    } finally {
      setLoadingJob(false)
    }
  }, [])

  // Check auth and load settings + venues
  useEffect(() => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin) {
      const currentUrl = window.location.href
      sessionStorage.setItem('staffReturnUrl', currentUrl)
      router.push('/staff')
      return
    }

    async function loadSettings() {
      try {
        const response = await fetch('/api/staff/settings', {
          headers: { 'x-staff-pin': pin! }
        })
        const data = await response.json()
        
        if (!response.ok) {
          if (response.status === 401) {
            sessionStorage.removeItem('staffPin')
            const currentUrl = window.location.href
            sessionStorage.setItem('staffReturnUrl', currentUrl)
            router.push('/staff')
            return
          }
          throw new Error(data.error || 'Failed to load settings')
        }
        
        setSettings(data.settings)
        setSettingsSource(data.source)
        
        if (data.source === 'defaults') {
          setError('⚠️ Could not load settings from Monday.com - using defaults. Please populate the D&C Settings board.')
        }
      } catch (err) {
        console.error('Failed to load settings:', err)
        setError('Failed to load costing settings. Please check the D&C Settings board is populated.')
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
    fetchVenues()
  }, [router, fetchVenues])

  // Pre-fill job number from URL
  useEffect(() => {
    if (jobNumberFromUrl && !formData.hirehopJobNumber) {
      console.log('Pre-filling job number from URL:', jobNumberFromUrl)
      setFormData(prev => ({ ...prev, hirehopJobNumber: jobNumberFromUrl }))
      fetchJobInfo(jobNumberFromUrl)
    }
  }, [jobNumberFromUrl, formData.hirehopJobNumber, fetchJobInfo])

  const costs = settings ? calculateCosts(formData, settings) : null

  const updateField = useCallback(<K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }, [])

  const handleJobNumberBlur = () => {
    if (formData.hirehopJobNumber && formData.hirehopJobNumber !== jobInfo?.id) {
      fetchJobInfo(formData.hirehopJobNumber)
    }
  }

  // Handle venue selection
  const handleVenueSelect = (venue: Venue | null, isNew: boolean, newName?: string) => {
    if (venue) {
      // Selected existing venue - auto-fill distance and time
      setFormData(prev => ({
        ...prev,
        destination: venue.name,
        selectedVenueId: venue.id,
        isNewVenue: false,
        distanceMiles: venue.distance || prev.distanceMiles,
        driveTimeMinutes: venue.driveTime || prev.driveTimeMinutes,
        originalVenueDistance: venue.distance,
        originalVenueDriveTime: venue.driveTime,
      }))
    } else if (isNew && newName) {
      // Adding new venue
      setFormData(prev => ({
        ...prev,
        destination: newName,
        selectedVenueId: null,
        isNewVenue: true,
        originalVenueDistance: null,
        originalVenueDriveTime: null,
      }))
    } else if (newName !== undefined) {
      // Just typing, not selected yet
      setFormData(prev => ({
        ...prev,
        destination: newName,
        selectedVenueId: null,
        isNewVenue: false,
        originalVenueDistance: null,
        originalVenueDriveTime: null,
      }))
    }
  }

  const handleSave = async () => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin || !costs) return

    setSaving(true)
    setError(null)
    setSaveResult(null)

    try {
      // Prepare form data with venue change tracking
      const dataToSave = {
        ...formData,
        // Track if distance/time changed from original venue values
        venueDistanceChanged: formData.selectedVenueId !== null && 
          formData.originalVenueDistance !== null &&
          formData.distanceMiles !== formData.originalVenueDistance,
        venueDriveTimeChanged: formData.selectedVenueId !== null && 
          formData.originalVenueDriveTime !== null &&
          formData.driveTimeMinutes !== formData.originalVenueDriveTime,
      }

      const costsToSave = {
        clientChargeTotal: costs.clientChargeTotalRounded,  // Use rounded value
        freelancerFee: costs.freelancerFeeRounded,
        expectedFuelCost: costs.expectedFuelCost,
        expectedOtherExpenses: costs.expectedOtherExpenses,
        ourMargin: costs.ourMargin,
      }

      const response = await fetch('/api/staff/crew-transport', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-pin': pin,
        },
        body: JSON.stringify({ formData: dataToSave, costs: costsToSave }),
      })

      const data: SaveResult = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save')
      }

      setSaveResult(data)
      
      let message = '✅ '
      if (data.board === 'dc') {
        message += `Created on D&C Board: ${data.itemName}`
        if (data.collectionItemName) {
          message += ` + Collection: ${data.collectionItemName}`
        }
      } else if (data.board === 'crewed_jobs') {
        message += `Created on Crewed Jobs Board: ${data.itemName}`
      } else {
        message += `Saved successfully: ${data.itemName}`
      }
      
      // Add venue info to success message
      if (formData.isNewVenue) {
        message += ' (New venue added to database)'
      } else if (dataToSave.venueDistanceChanged || dataToSave.venueDriveTimeChanged) {
        message += ' (Venue distance/time updated)'
      }
      
      setSuccess(message)
    } catch (err) {
      console.error('Save error:', err)
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleStartNew = () => {
    setFormData(initialFormData)
    setJobInfo(null)
    setSuccess(null)
    setSaveResult(null)
    setError(null)
    setStep(1)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading wizard...</p>
        </div>
      </div>
    )
  }

  // Step configuration based on job type
  const isCrewedJob = formData.jobType === 'crewed_job'
  const isDC = formData.jobType === 'delivery' || formData.jobType === 'collection'
  const totalSteps = isCrewedJob ? 5 : 4
  const stepLabels = isCrewedJob 
    ? ['Job', 'Transport', 'Work', 'Expenses', 'Review']
    : ['Job', 'Transport', 'Expenses', 'Review']

  // Validation
  const isStep1Valid = formData.jobType !== '' && 
                       formData.jobDate !== '' && 
                       (isCrewedJob || formData.whatIsIt !== '')
  const isStep2Valid = formData.destination !== '' && formData.distanceMiles > 0
  const isStep3Valid = !isCrewedJob || formData.workType !== ''

  // Derived state for UI
  const isVehicle = formData.whatIsIt === 'vehicle'
  const needsTravelQuestion = isDC && isVehicle

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => router.push('/staff')}
              className="text-gray-500 hover:text-gray-700"
            >
              ← Back
            </button>
            <h1 className="text-xl font-bold text-gray-900">Crew & Transport Costing</h1>
          </div>
          {(formData.hirehopJobNumber || jobInfo) && (
            <div className="text-right">
              <span className="text-sm font-medium text-gray-900">
                Job #{formData.hirehopJobNumber}
              </span>
              {jobInfo?.clientName && (
                <p className="text-sm text-gray-500">{jobInfo.clientName}</p>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Progress Steps */}
      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-8">
          {stepLabels.map((label, idx) => (
            <div key={label} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step > idx + 1
                    ? 'bg-green-500 text-white'
                    : step === idx + 1
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-600'
                }`}
              >
                {step > idx + 1 ? '✓' : idx + 1}
              </div>
              <span className={`ml-2 text-sm hidden sm:inline ${step === idx + 1 ? 'text-blue-600 font-medium' : 'text-gray-500'}`}>
                {label}
              </span>
              {idx < totalSteps - 1 && <div className="w-4 sm:w-8 h-0.5 bg-gray-200 mx-2" />}
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 pb-8">
        <div className="bg-white rounded-xl shadow-sm p-6">
          
          {settingsSource === 'defaults' && (
            <div className="mb-6 bg-yellow-50 text-yellow-800 px-4 py-3 rounded-lg text-sm">
              ⚠️ Using default settings. Please populate the D&C Settings board for accurate calculations.
            </div>
          )}
          
          {error && !error.includes('defaults') && (
            <div className="mb-6 bg-red-50 text-red-600 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}
          
          {success && (
            <div className="mb-6 bg-green-50 text-green-700 px-4 py-3 rounded-lg">
              <p className="font-medium">{success}</p>
              {saveResult && (
                <div className="mt-2 text-sm">
                  <p>
                    {saveResult.board === 'dc' ? '📦 D&C Board' : '👷 Crewed Jobs Board'}
                    {' → '}
                    Item ID: {saveResult.itemId}
                  </p>
                  {saveResult.collectionItemId && (
                    <p>📥 Collection → Item ID: {saveResult.collectionItemId}</p>
                  )}
                </div>
              )}
              <button
                onClick={handleStartNew}
                className="mt-3 text-sm text-green-800 underline hover:no-underline"
              >
                Create another quote →
              </button>
            </div>
          )}

          {/* ================================================================
              STEP 1: JOB DETAILS
              ================================================================ */}
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">What are we doing?</h2>
              
              {/* Job number and client */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    HireHop Job Number
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={formData.hirehopJobNumber}
                      onChange={(e) => updateField('hirehopJobNumber', e.target.value)}
                      onBlur={handleJobNumberBlur}
                      placeholder="e.g. 15276"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                    {loadingJob && (
                      <div className="absolute right-3 top-2.5">
                        <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Client
                  </label>
                  <input
                    type="text"
                    value={formData.clientName || jobInfo?.clientName || ''}
                    onChange={(e) => updateField('clientName', e.target.value)}
                    placeholder="Auto-filled from job"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-gray-50"
                    readOnly
                  />
                </div>
              </div>

              {/* Job type selection */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { value: 'delivery', label: 'Delivery', icon: '📦', desc: 'Taking something out' },
                  { value: 'collection', label: 'Collection', icon: '📥', desc: 'Bringing something back' },
                  { value: 'crewed_job', label: 'Crewed Job', icon: '👷', desc: 'Work on site (± transport)' },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      updateField('jobType', option.value as FormData['jobType'])
                      if (option.value === 'crewed_job') {
                        updateField('whatIsIt', '')
                      }
                      if (option.value === 'collection' && jobInfo?.hireEndDate && !formData.jobDate) {
                        updateField('jobDate', jobInfo.hireEndDate)
                      }
                      if (option.value === 'delivery' && jobInfo?.hireStartDate && !formData.jobDate) {
                        updateField('jobDate', jobInfo.hireStartDate)
                      }
                    }}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${
                      formData.jobType === option.value
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-2xl">{option.icon}</span>
                    <h3 className="mt-1 font-semibold text-gray-900">{option.label}</h3>
                    <p className="text-xs text-gray-500">{option.desc}</p>
                  </button>
                ))}
              </div>

              {/* What is it? - Only for Delivery/Collection */}
              {isDC && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    What is it?
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: 'vehicle', label: 'A Vehicle', icon: '🚐', hint: 'Driver returns separately' },
                      { value: 'equipment', label: 'Equipment', icon: '🎸', hint: 'Driver returns with van' },
                      { value: 'people', label: 'People', icon: '👥', hint: 'Driver returns with van' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        onClick={() => updateField('whatIsIt', option.value as FormData['whatIsIt'])}
                        className={`p-3 rounded-lg border-2 text-center transition-all ${
                          formData.whatIsIt === option.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <span className="text-xl">{option.icon}</span>
                        <p className="text-sm font-medium text-gray-900 mt-1">{option.label}</p>
                        <p className="text-xs text-gray-500">{option.hint}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Board indicator */}
              {formData.jobType && (
                <div className={`text-sm px-3 py-2 rounded-lg ${
                  isCrewedJob 
                    ? 'bg-purple-50 text-purple-700' 
                    : 'bg-blue-50 text-blue-700'
                }`}>
                  {isCrewedJob 
                    ? '👷 This will be saved to the Crewed Jobs board'
                    : '📦 This will be saved to the D&C board'
                  }
                </div>
              )}

              {/* Dates and times */}
              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">When?</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {formData.jobType === 'delivery' ? 'Delivery Date' : 
                       formData.jobType === 'collection' ? 'Collection Date' : 
                       'Job Date'}
                    </label>
                    <input
                      type="date"
                      value={formData.jobDate}
                      onChange={(e) => updateField('jobDate', e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                    {jobInfo?.hireStartDate && formData.jobDate !== jobInfo.hireStartDate && (
                      <p className="text-xs text-gray-500 mt-1">
                        Hire starts: {formatDateUK(jobInfo.hireStartDate)}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Arrive by (optional)
                    </label>
                    <input
                      type="time"
                      value={formData.arrivalTime}
                      onChange={(e) => updateField('arrivalTime', e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>

                  {formData.jobType === 'delivery' && (
                    <>
                      <div className="md:col-span-2">
                        <label className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            checked={formData.addCollection}
                            onChange={(e) => updateField('addCollection', e.target.checked)}
                            className="w-4 h-4 text-blue-600 rounded"
                          />
                          <span className="text-sm font-medium text-gray-700">
                            Add collection from same location
                          </span>
                        </label>
                        {formData.addCollection && (
                          <p className="text-xs text-blue-600 mt-1 ml-6">
                            ℹ️ This will create 2 items on the D&C board
                          </p>
                        )}
                      </div>

                      {formData.addCollection && (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                              Collection Date
                            </label>
                            <input
                              type="date"
                              value={formData.collectionDate}
                              onChange={(e) => updateField('collectionDate', e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                            />
                            {jobInfo?.hireEndDate && formData.collectionDate !== jobInfo.hireEndDate && (
                              <p className="text-xs text-gray-500 mt-1">
                                Hire ends: {formatDateUK(jobInfo.hireEndDate)}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                              Collection arrive by (optional)
                            </label>
                            <input
                              type="time"
                              value={formData.collectionArrivalTime}
                              onChange={(e) => updateField('collectionArrivalTime', e.target.value)}
                              className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                            />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              STEP 2: TRANSPORT DETAILS
              ================================================================ */}
          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Transport Details</h2>

              {isCrewedJob && (
                <div className="p-4 bg-yellow-50 rounded-lg text-yellow-800 text-sm">
                  💡 For crewed jobs where they make their own way, set distance to 0.
                </div>
              )}

              {isDC && (
                <div className={`p-3 rounded-lg text-sm ${
                  isVehicle ? 'bg-orange-50 text-orange-700' : 'bg-green-50 text-green-700'
                }`}>
                  {isVehicle ? (
                    formData.jobType === 'delivery' 
                      ? formData.addCollection
                        ? '🚐 Vehicle delivery + collection: Driver returns by transport after delivery, travels there by transport for collection'
                        : '🚐 Vehicle delivery: Driver will need to get home after dropping off'
                      : '🚐 Vehicle collection: Driver will need to get there first'
                  ) : (
                    '📦 Equipment/People: Driver goes there and back with the van'
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Destination
                  </label>
                  <VenueDropdown
                    value={formData.destination}
                    venues={venues}
                    loading={loadingVenues}
                    onSelect={handleVenueSelect}
                  />
                  {formData.selectedVenueId && (
                    <p className="text-xs text-green-600 mt-1">
                      ✓ Selected from venues database
                    </p>
                  )}
                  {formData.isNewVenue && formData.destination && (
                    <p className="text-xs text-blue-600 mt-1">
                      ➕ Will be added to venues database on save
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Distance (miles, one-way)
                  </label>
                  <input
                    type="number"
                    value={formData.distanceMiles || ''}
                    onChange={(e) => updateField('distanceMiles', parseFloat(e.target.value) || 0)}
                    placeholder="From Google Maps"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                  {formData.selectedVenueId && formData.originalVenueDistance !== null && 
                   formData.distanceMiles !== formData.originalVenueDistance && (
                    <p className="text-xs text-orange-600 mt-1">
                      ⚠️ Changed from {formData.originalVenueDistance}mi - venue will be updated
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Drive Time (minutes, one-way)
                  </label>
                  <input
                    type="number"
                    value={formData.driveTimeMinutes || ''}
                    onChange={(e) => updateField('driveTimeMinutes', parseFloat(e.target.value) || 0)}
                    placeholder="From Google Maps"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                  {formData.selectedVenueId && formData.originalVenueDriveTime !== null && 
                   formData.driveTimeMinutes !== formData.originalVenueDriveTime && (
                    <p className="text-xs text-orange-600 mt-1">
                      ⚠️ Changed from {formData.originalVenueDriveTime}min - venue will be updated
                    </p>
                  )}
                </div>
              </div>

              {needsTravelQuestion && (
                <div className="border-t pt-6 mt-6">
                  <h3 className="font-medium text-gray-900 mb-2">
                    {formData.jobType === 'delivery' 
                      ? 'How does the driver get home?' 
                      : 'How does the driver get there?'}
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">
                    {formData.jobType === 'delivery'
                      ? 'After dropping off the vehicle'
                      : 'To pick up the vehicle'}
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Travel Method
                      </label>
                      <select
                        value={formData.travelMethod}
                        onChange={(e) => updateField('travelMethod', e.target.value as FormData['travelMethod'])}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select...</option>
                        <option value="public_transport">Public transport (we pay)</option>
                        <option value="own_way">Gets a lift / own way</option>
                      </select>
                    </div>

                    {formData.travelMethod === 'public_transport' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Travel Time (mins)
                          </label>
                          <input
                            type="number"
                            value={formData.travelTimeMins || ''}
                            onChange={(e) => updateField('travelTimeMins', parseFloat(e.target.value) || 0)}
                            placeholder="Journey time"
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Ticket Cost (£)
                          </label>
                          <input
                            type="number"
                            value={formData.travelCost || ''}
                            onChange={(e) => updateField('travelCost', parseFloat(e.target.value) || 0)}
                            placeholder="Train/bus fare"
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================================================================
              STEP 3: WORK DETAILS (Crewed Jobs only)
              ================================================================ */}
          {step === 3 && isCrewedJob && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Work Details</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Work Type
                  </label>
                  <select
                    value={formData.workType}
                    onChange={(e) => updateField('workType', e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="">Select...</option>
                    {WORK_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {formData.workType === 'other' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Describe the work
                    </label>
                    <input
                      type="text"
                      value={formData.workTypeOther}
                      onChange={(e) => updateField('workTypeOther', e.target.value)}
                      placeholder="What are they doing?"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Work Duration (hours)
                  </label>
                  <input
                    type="number"
                    value={formData.workDurationHours || ''}
                    onChange={(e) => updateField('workDurationHours', parseFloat(e.target.value) || 0)}
                    placeholder="Time on site"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Additional Notes
                  </label>
                  <textarea
                    value={formData.workDescription}
                    onChange={(e) => updateField('workDescription', e.target.value)}
                    placeholder="Any specific details about the work..."
                    rows={2}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Rate Calculation</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Calculation Mode
                    </label>
                    <select
                      value={formData.calculationMode}
                      onChange={(e) => updateField('calculationMode', e.target.value as FormData['calculationMode'])}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="hourly">Hourly rate</option>
                      <option value="day_rate">Day rate</option>
                    </select>
                  </div>

                  {formData.calculationMode === 'day_rate' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Number of Days
                        </label>
                        <input
                          type="number"
                          value={formData.numberOfDays || ''}
                          onChange={(e) => updateField('numberOfDays', parseInt(e.target.value) || 1)}
                          min={1}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Day Rate (£) 
                          <span className="text-gray-400 font-normal ml-1">
                            {settings && `Default: £${settings.driverDayRate}`}
                          </span>
                        </label>
                        <input
                          type="number"
                          value={formData.dayRateOverride ?? settings?.driverDayRate ?? ''}
                          onChange={(e) => {
                            const val = e.target.value
                            updateField('dayRateOverride', val ? parseFloat(val) : null)
                          }}
                          placeholder={settings ? `${settings.driverDayRate}` : '180'}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                        />
                        <p className="text-xs text-gray-500 mt-1">Override for this quote only</p>
                      </div>
                    </>
                  )}

                  {formData.calculationMode === 'hourly' && (
                    <div>
                      <label className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          checked={formData.applyMinHours}
                          onChange={(e) => updateField('applyMinHours', e.target.checked)}
                          className="w-4 h-4 text-blue-600 rounded"
                        />
                        <span className="text-sm font-medium text-gray-700">
                          Apply minimum hours ({settings?.minHoursThreshold || 5}hr)
                        </span>
                      </label>
                      <p className="text-xs text-gray-500 mt-1 ml-6">
                        Ensures freelancer gets at least {settings?.minHoursThreshold || 5} hours pay
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Out of Hours (optional)</h3>
                <p className="text-sm text-gray-500 mb-4">Extra pay for work before 8am or after 11pm</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Early Start (minutes before 8am)
                    </label>
                    <input
                      type="number"
                      value={formData.earlyStartMinutes || ''}
                      onChange={(e) => updateField('earlyStartMinutes', parseFloat(e.target.value) || 0)}
                      placeholder="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Late Finish (minutes after 11pm)
                    </label>
                    <input
                      type="number"
                      value={formData.lateFinishMinutes || ''}
                      onChange={(e) => updateField('lateFinishMinutes', parseFloat(e.target.value) || 0)}
                      placeholder="0"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              STEP 3/4: EXPENSES
              ================================================================ */}
          {((step === 3 && !isCrewedJob) || (step === 4 && isCrewedJob)) && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Expenses & Arrangements</h2>

              {!isCrewedJob && (
                <div className="p-4 bg-gray-50 rounded-lg">
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={formData.applyMinHours}
                      onChange={(e) => updateField('applyMinHours', e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Apply minimum hours ({settings?.minHoursThreshold || 5}hr call)
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Ensures freelancer gets at least {settings?.minHoursThreshold || 5} hours pay even for shorter jobs
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tolls / Parking / Crossings (£)
                  </label>
                  <input
                    type="number"
                    value={formData.tollsParking || ''}
                    onChange={(e) => updateField('tollsParking', parseFloat(e.target.value) || 0)}
                    placeholder="0"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Other Additional Costs (£)
                  </label>
                  <input
                    type="number"
                    value={formData.additionalCosts || ''}
                    onChange={(e) => updateField('additionalCosts', parseFloat(e.target.value) || 0)}
                    placeholder="0"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Expense Arrangement</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      How are expenses handled?
                    </label>
                    <select
                      value={formData.expenseArrangement}
                      onChange={(e) => updateField('expenseArrangement', e.target.value as FormData['expenseArrangement'])}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="">Select...</option>
                      <option value="all_in_fixed">Fixed fee - all in</option>
                      <option value="fee_plus_reimbursed">Fee + expenses reimbursed</option>
                      <option value="dry_hire_actuals">Dry hire + actuals at end</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Per Diem (PD) Arrangement
                    </label>
                    <select
                      value={formData.pdArrangement}
                      onChange={(e) => updateField('pdArrangement', e.target.value as FormData['pdArrangement'])}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="no_pd">No PD</option>
                      <option value="we_pay">We pay freelancer</option>
                      <option value="client_pays_direct">Client pays direct</option>
                      <option value="in_fee">Included in fee</option>
                    </select>
                  </div>

                  {formData.pdArrangement !== 'no_pd' && formData.pdArrangement !== '' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        PD Amount (£/day)
                      </label>
                      <input
                        type="number"
                        value={formData.pdAmount || ''}
                        onChange={(e) => updateField('pdAmount', parseFloat(e.target.value) || 0)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Expense Notes
                </label>
                <textarea
                  value={formData.expenseNotes}
                  onChange={(e) => updateField('expenseNotes', e.target.value)}
                  placeholder="Any special arrangements..."
                  rows={2}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                />
              </div>
            </div>
          )}

          {/* ================================================================
              FINAL STEP: REVIEW
              ================================================================ */}
          {step === totalSteps && costs && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Review & Save</h2>

              {/* Board destination */}
              <div className={`text-sm px-4 py-3 rounded-lg flex items-center gap-2 ${
                isCrewedJob 
                  ? 'bg-purple-50 text-purple-700 border border-purple-200' 
                  : 'bg-blue-50 text-blue-700 border border-blue-200'
              }`}>
                <span className="text-lg">{isCrewedJob ? '👷' : '📦'}</span>
                <span>
                  {isCrewedJob 
                    ? 'Will save to Crewed Jobs board'
                    : `Will save to D&C board${formData.addCollection ? ' (2 items: delivery + collection)' : ''}`
                  }
                </span>
              </div>

              {/* Cost Summary Cards - UPDATED for delivery + collection */}
              {formData.addCollection ? (
                // Show separate costs for delivery and collection
                <div className="space-y-4">
                  {/* Delivery costs */}
                  <div className="border rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                      <span>📦</span> Delivery ({formatDateUK(formData.jobDate)})
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-green-50 rounded-lg p-3">
                        <p className="text-xs text-green-600 font-medium">Client Charge</p>
                        <p className="text-xl font-bold text-green-700">£{costs.clientChargeTotalRounded}</p>
                      </div>
                      <div className="bg-blue-50 rounded-lg p-3">
                        <p className="text-xs text-blue-600 font-medium">Freelancer Fee</p>
                        <p className="text-xl font-bold text-blue-700">£{costs.freelancerFeeRounded}</p>
                      </div>
                    </div>
                  </div>

                  {/* Collection costs */}
                  <div className="border rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                      <span>📥</span> Collection ({formatDateUK(formData.collectionDate)})
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-green-50 rounded-lg p-3">
                        <p className="text-xs text-green-600 font-medium">Client Charge</p>
                        <p className="text-xl font-bold text-green-700">£{costs.clientChargeTotalRounded}</p>
                      </div>
                      <div className="bg-blue-50 rounded-lg p-3">
                        <p className="text-xs text-blue-600 font-medium">Freelancer Fee</p>
                        <p className="text-xl font-bold text-blue-700">£{costs.freelancerFeeRounded}</p>
                      </div>
                    </div>
                  </div>

                  {/* Combined totals */}
                  <div className="bg-gray-100 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 mb-3">Combined Total (Both Legs)</h3>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <p className="text-xs text-gray-500">Client Total</p>
                        <p className="text-xl font-bold text-gray-900">£{costs.clientChargeTotalRounded * 2}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Freelancer Total</p>
                        <p className="text-xl font-bold text-gray-900">£{costs.freelancerFeeRounded * 2}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Our Margin</p>
                        <p className="text-xl font-bold text-purple-700">£{costs.ourMargin * 2}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                // Single job cost display - UPDATED: rounded client charge, no "(Calc → rounded)"
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-green-50 rounded-xl p-4">
                    <p className="text-sm text-green-600 font-medium">Client Charge</p>
                    <p className="text-2xl font-bold text-green-700">£{costs.clientChargeTotalRounded}</p>
                    <div className="mt-2 text-xs text-green-600 space-y-1">
                      <p>Labour: £{costs.clientChargeLabour.toFixed(2)}</p>
                      <p>Fuel: £{costs.clientChargeFuel.toFixed(2)}</p>
                      <p>Expenses: £{costs.clientChargeExpenses.toFixed(2)}</p>
                    </div>
                  </div>

                  <div className="bg-blue-50 rounded-xl p-4">
                    <p className="text-sm text-blue-600 font-medium">Freelancer Fee</p>
                    <p className="text-2xl font-bold text-blue-700">£{costs.freelancerFeeRounded}</p>
                    <div className="mt-2 text-xs text-blue-600 space-y-1">
                      <p>Est. time: {costs.estimatedTimeHours.toFixed(1)} hours</p>
                    </div>
                  </div>

                  <div className="bg-purple-50 rounded-xl p-4">
                    <p className="text-sm text-purple-600 font-medium">Our Margin</p>
                    <p className="text-2xl font-bold text-purple-700">£{costs.ourMargin.toFixed(2)}</p>
                    <div className="mt-2 text-xs text-purple-600">
                      <p>Total cost: £{costs.ourTotalCost.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Job Summary */}
              <div className="border rounded-lg divide-y">
                <div className="px-4 py-3 bg-gray-50">
                  <h3 className="font-medium text-gray-900">Job Summary</h3>
                </div>
                <div className="px-4 py-3 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Type:</span>
                    <span className="ml-2 text-gray-900 capitalize">
                      {formData.jobType.replace('_', ' ')}
                      {isDC && formData.whatIsIt && ` (${formData.whatIsIt})`}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">HireHop #:</span>
                    <span className="ml-2 text-gray-900">{formData.hirehopJobNumber || 'Not set'}</span>
                  </div>
                  {(jobInfo?.clientName || formData.clientName) && (
                    <div>
                      <span className="text-gray-500">Client:</span>
                      <span className="ml-2 text-gray-900">{formData.clientName || jobInfo?.clientName}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-500">Destination:</span>
                    <span className="ml-2 text-gray-900">{formData.destination || 'Not set'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Date:</span>
                    <span className="ml-2 text-gray-900">
                      {formatDateUK(formData.jobDate)}
                      {formData.arrivalTime && ` @ ${formatTime12h(formData.arrivalTime)}`}
                    </span>
                  </div>
                  {formData.addCollection && (
                    <div>
                      <span className="text-gray-500">+ Collection:</span>
                      <span className="ml-2 text-gray-900">
                        {formatDateUK(formData.collectionDate)}
                        {formData.collectionArrivalTime && ` @ ${formatTime12h(formData.collectionArrivalTime)}`}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Costing Notes (internal)
                </label>
                <textarea
                  value={formData.costingNotes}
                  onChange={(e) => updateField('costingNotes', e.target.value)}
                  placeholder="Any notes about this quote..."
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                />
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between mt-8 pt-6 border-t">
            {step > 1 ? (
              <button
                onClick={() => setStep(step - 1)}
                disabled={!!success}
                className="px-6 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50"
              >
                ← Back
              </button>
            ) : (
              <div />
            )}

            {step < totalSteps ? (
              <button
                onClick={() => setStep(step + 1)}
                disabled={
                  (step === 1 && !isStep1Valid) ||
                  (step === 2 && !isStep2Valid) ||
                  (step === 3 && isCrewedJob && !isStep3Valid)
                }
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving || !!success}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : success ? 'Saved ✓' : 'Save to Monday.com'}
              </button>
            )}
          </div>
        </div>

        {/* Live Cost Preview */}
        {costs && step > 1 && step < totalSteps && (
          <div className="fixed bottom-4 right-4 bg-white rounded-xl shadow-lg border p-4 max-w-xs">
            <p className="text-sm text-gray-500 mb-2">Live Preview</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Client:</span>
                <span className="ml-1 font-medium">£{costs.clientChargeTotalRounded}</span>
              </div>
              <div>
                <span className="text-gray-500">Freelancer:</span>
                <span className="ml-1 font-medium">£{costs.freelancerFeeRounded}</span>
              </div>
            </div>
            {formData.addCollection && (
              <p className="text-xs text-blue-600 mt-1">× 2 (delivery + collection)</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// MAIN PAGE WITH SUSPENSE
// =============================================================================

export default function CrewTransportPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <CrewTransportWizard />
    </Suspense>
  )
} 