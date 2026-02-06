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
  minClientCharge: number
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
  address: string | null
  distance: number | null
  driveTime: number | null
  travelTime: number | null
  ticketCost: number | null
  tollsParking: number | null
}

// Expense item for the expense system
interface ExpenseItem {
  id: string
  category: 'fuel' | 'parking' | 'tolls' | 'transport_out' | 'transport_back' | 'hotel' | 'pd' | 'other'
  label: string
  amount: number
  included: boolean
  description?: string
  isAutoCalculated?: boolean
  pdDays?: number
}

interface FormData {
  hirehopJobNumber: string
  clientName: string
  jobType: 'delivery' | 'collection' | 'crewed_job' | ''
  whatIsIt: 'vehicle' | 'equipment' | 'people' | ''
  jobDate: string
  jobFinishDate: string
  isMultiDay: boolean
  arrivalTime: string
  addCollection: boolean
  collectionDate: string
  collectionArrivalTime: string
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  selectedVenueId: string | null
  isNewVenue: boolean
  originalVenueDistance: number | null
  originalVenueDriveTime: number | null
  originalVenueTravelTime: number | null
  originalVenueTicketCost: number | null
  originalVenueTollsParking: number | null
  travelMethod: 'public_transport' | 'own_way' | ''
  travelTimeMins: number
  travelCost: number
  workType: string
  workTypeOther: string
  workDurationHours: number
  workDescription: string
  calculationMode: 'hourly' | 'day_rate'
  numberOfDays: number
  earlyStartMinutes: number
  lateFinishMinutes: number
  dayRateOverride: number | null
  applyMinHours: boolean
  // Setup work extension (D&C jobs)
  includesSetupWork: boolean
  setupWorkDescription: string
  setupExtraTimeHours: number
  setupFixedPremium: number
  // OOH manual override
  oohManualOverride: boolean
  expenses: ExpenseItem[]
  expenseNotes: string
  costingNotes: string
  // HireHop integration
  addDeliveryToHireHop: boolean
  addCollectionToHireHop: boolean
  addCrewToHireHop: boolean
}

interface CalculatedCosts {
  clientChargeLabour: number
  clientChargeFuel: number
  clientChargeExpenses: number
  clientChargeTotal: number
  clientChargeTotalRounded: number
  freelancerFee: number
  freelancerFeeRounded: number
  expectedFuelCost: number
  expensesIncluded: number
  expensesNotIncluded: number
  ourTotalCost: number
  ourMargin: number
  estimatedTimeMinutes: number
  estimatedTimeHours: number
  // Auto-calculated OOH values (for display)
  autoEarlyStartMinutes: number
  autoLateFinishMinutes: number
  departureTimeMinutes: number
  finishTimeMinutes: number
}

interface SaveResult {
  success: boolean
  itemId?: string
  itemName?: string
  board?: string
  venueId?: string
  collectionItemId?: string
  collectionItemName?: string
  error?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function roundToNearestFive(amount: number): number {
  const lower = Math.floor(amount / 5) * 5
  if (amount - lower <= 1) return lower
  return lower + 5
}

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

function formatTime12h(time: string): string {
  if (!time) return ''
  const [hours, minutes] = time.split(':')
  const h = parseInt(hours)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${minutes}${ampm}`
}

function formatMinutesAsTime(mins: number): string {
  if (mins < 0) mins += 1440
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')}${ampm}`
}

function formatDurationHM(minutes: number): string {
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function normalizeTimeInput(value: string): string {
  if (!value) return ''
  const cleaned = value.replace(/[^\d:]/g, '')
  if (/^\d{2}:\d{2}$/.test(cleaned)) return cleaned
  if (/^\d{1,2}$/.test(cleaned)) {
    const hour = parseInt(cleaned)
    if (hour >= 0 && hour <= 23) return hour.toString().padStart(2, '0') + ':00'
  }
  if (/^\d{3,4}$/.test(cleaned)) {
    const hour = cleaned.length === 3 ? parseInt(cleaned[0]) : parseInt(cleaned.slice(0, 2))
    const mins = cleaned.length === 3 ? cleaned.slice(1) : cleaned.slice(2)
    if (hour >= 0 && hour <= 23 && parseInt(mins) >= 0 && parseInt(mins) <= 59) {
      return hour.toString().padStart(2, '0') + ':' + mins.padStart(2, '0')
    }
  }
  if (/^\d{1,2}:\d{1}$/.test(cleaned)) {
    const [hourStr, minStr] = cleaned.split(':')
    const hour = parseInt(hourStr)
    const mins = parseInt(minStr) * 10
    if (hour >= 0 && hour <= 23 && mins >= 0 && mins <= 50) {
      return hour.toString().padStart(2, '0') + ':' + mins.toString().padStart(2, '0')
    }
  }
  return ''
}

function getAddressSnippet(address: string | null, maxLength: number = 60): string {
  if (!address) return ''
  const firstLine = address.split('\n')[0].trim()
  if (firstLine.length <= maxLength) return firstLine
  return firstLine.substring(0, maxLength) + '...'
}

function calculateDaysBetween(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 1
  const start = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 1
  const diffTime = end.getTime() - start.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
  return Math.max(1, diffDays)
}

function generateExpenseId(): string {
  return `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

// =============================================================================
// INITIAL STATE
// =============================================================================

// All expenses default to unchecked. Fuel auto-checks when a venue with distance is selected.
const createInitialExpenses = (): ExpenseItem[] => [
  { id: generateExpenseId(), category: 'fuel', label: 'Fuel', amount: 0, included: false, isAutoCalculated: true },
  { id: generateExpenseId(), category: 'parking', label: 'Parking', amount: 0, included: false },
  { id: generateExpenseId(), category: 'tolls', label: 'Tolls / Crossings', amount: 0, included: false },
  { id: generateExpenseId(), category: 'transport_out', label: 'Transport (outbound)', amount: 0, included: false },
  { id: generateExpenseId(), category: 'transport_back', label: 'Transport (return)', amount: 0, included: false },
  { id: generateExpenseId(), category: 'hotel', label: 'Hotel', amount: 0, included: false },
  { id: generateExpenseId(), category: 'pd', label: 'Per Diem (PD)', amount: 0, included: false, pdDays: 1 },
]

const initialFormData: FormData = {
  hirehopJobNumber: '',
  clientName: '',
  jobType: '',
  whatIsIt: '',
  jobDate: '',
  jobFinishDate: '',
  isMultiDay: false,
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
  originalVenueTravelTime: null,
  originalVenueTicketCost: null,
  originalVenueTollsParking: null,
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
  includesSetupWork: false,
  setupWorkDescription: '',
  setupExtraTimeHours: 0,
  setupFixedPremium: 0,
  oohManualOverride: false,
  expenses: createInitialExpenses(),
  expenseNotes: '',
  costingNotes: '',
  // HireHop integration - default to checked
  addDeliveryToHireHop: true,
  addCollectionToHireHop: true,
  addCrewToHireHop: true,
}

const WORK_TYPE_OPTIONS = [
  { value: 'backline_tech', label: 'Backline Tech' },
  { value: 'general_assist', label: 'General Assist' },
  { value: 'engineer_foh', label: 'Engineer - FOH' },
  { value: 'engineer_mons', label: 'Engineer - mons' },
  { value: 'driving_only', label: 'Driving Only' },
  { value: 'other', label: 'Other' },
]

// Standard expense categories (always shown in breakdown)
const STANDARD_EXPENSE_CATEGORIES = ['fuel', 'parking', 'tolls', 'transport_out', 'transport_back', 'hotel', 'pd']

// =============================================================================
// CALCULATION FUNCTIONS
// =============================================================================

function calculateAutoOOH(
  arrivalTime: string,
  driveTimeMinutes: number,
  totalEngagedMinutes: number,
  isVehicle: boolean,
  jobType: string,
  travelMethod: string,
  travelTimeMins: number,
): { earlyStartMinutes: number; lateFinishMinutes: number; departureTime: number; finishTime: number } {
  if (!arrivalTime || totalEngagedMinutes <= 0) {
    return { earlyStartMinutes: 0, lateFinishMinutes: 0, departureTime: 0, finishTime: 0 }
  }

  const [h, m] = arrivalTime.split(':').map(Number)
  const arrivalMins = h * 60 + m

  // Journey to venue: how long does it take to get there?
  let journeyToVenue = driveTimeMinutes
  // For vehicle collections where driver takes public transport TO the venue
  if (isVehicle && jobType === 'collection' && travelMethod === 'public_transport' && travelTimeMins > 0) {
    journeyToVenue = travelTimeMins
  }

  const departureTime = arrivalMins - journeyToVenue
  const finishTime = departureTime + totalEngagedMinutes

  const OOH_START = 8 * 60   // 8:00 AM = 480 minutes
  const OOH_END = 23 * 60    // 11:00 PM = 1380 minutes

  const earlyStartMinutes = Math.max(0, OOH_START - departureTime)
  const lateFinishMinutes = Math.max(0, finishTime - OOH_END)

  return { earlyStartMinutes, lateFinishMinutes, departureTime, finishTime }
}

function calculateCosts(formData: FormData, settings: CostingSettings): CalculatedCosts {
  const {
    jobType, whatIsIt, distanceMiles, driveTimeMinutes, travelMethod, travelTimeMins,
    workDurationHours, calculationMode, numberOfDays,
    addCollection, dayRateOverride, applyMinHours, expenses,
    includesSetupWork, setupExtraTimeHours, setupFixedPremium,
    arrivalTime, oohManualOverride, earlyStartMinutes: manualEarlyStart, lateFinishMinutes: manualLateFinish,
  } = formData

  const {
    fuelPricePerLitre, expenseMarkupPercent, adminCostPerHour, handoverTimeMinutes,
    unloadTimeMinutes, minHoursThreshold, minClientCharge, hourlyRateFreelancerDay,
    hourlyRateFreelancerNight, hourlyRateClientDay, hourlyRateClientNight, driverDayRate,
  } = settings

  const markupMultiplier = 1 + (expenseMarkupPercent / 100)
  const effectiveDayRate = dayRateOverride !== null ? dayRateOverride : driverDayRate
  const isVehicle = whatIsIt === 'vehicle'
  const isThereAndBack = !isVehicle || addCollection
  const isDC = jobType === 'delivery' || jobType === 'collection'

  const totalMiles = isThereAndBack ? distanceMiles * 2 : distanceMiles
  const fuelCost = (totalMiles * fuelPricePerLitre) / 5

  const expensesIncluded = expenses
    .filter(e => e.included && e.category !== 'fuel')
    .reduce((sum, e) => sum + (e.category === 'pd' && e.pdDays ? e.amount * e.pdDays : e.amount), 0)

  const expensesNotIncluded = expenses
    .filter(e => !e.included && e.category !== 'fuel')
    .reduce((sum, e) => sum + (e.category === 'pd' && e.pdDays ? e.amount * e.pdDays : e.amount), 0)

  const fuelExpense = expenses.find(e => e.category === 'fuel')
  const fuelIncluded = fuelExpense?.included ?? true

  // -------------------------------------------------------------------------
  // DAY RATE MODE
  // -------------------------------------------------------------------------
  if (calculationMode === 'day_rate') {
    let freelancerFee = effectiveDayRate * numberOfDays
    // Add setup fixed premium to freelancer (D&C jobs with setup work)
    if (isDC && includesSetupWork && setupFixedPremium > 0) {
      freelancerFee += setupFixedPremium
    }
    const freelancerFeeRounded = roundToNearestFive(freelancerFee)
    let clientChargeLabour = freelancerFeeRounded * markupMultiplier
    // Setup premium already in freelancerFee, markup already applied via multiplier
    const clientChargeExpenses = expensesIncluded * markupMultiplier
    const clientChargeFuel = fuelIncluded ? fuelCost * markupMultiplier : 0
    const clientChargeTotal = clientChargeLabour + clientChargeFuel + clientChargeExpenses
    const clientChargeTotalRounded = Math.max(minClientCharge || 0, Math.round(clientChargeTotal))
    const ourTotalCost = freelancerFeeRounded + fuelCost + expensesIncluded

    return {
      clientChargeLabour: Math.round(clientChargeLabour * 100) / 100,
      clientChargeFuel: Math.round(clientChargeFuel * 100) / 100,
      clientChargeExpenses: Math.round(clientChargeExpenses * 100) / 100,
      clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
      clientChargeTotalRounded,
      freelancerFee: Math.round(freelancerFee * 100) / 100,
      freelancerFeeRounded,
      expectedFuelCost: Math.round(fuelCost * 100) / 100,
      expensesIncluded: Math.round(expensesIncluded * 100) / 100,
      expensesNotIncluded: Math.round(expensesNotIncluded * 100) / 100,
      ourTotalCost: Math.round(ourTotalCost * 100) / 100,
      ourMargin: Math.round((clientChargeTotalRounded - ourTotalCost) * 100) / 100,
      estimatedTimeMinutes: numberOfDays * 8 * 60,
      estimatedTimeHours: numberOfDays * 8,
      autoEarlyStartMinutes: 0,
      autoLateFinishMinutes: 0,
      departureTimeMinutes: 0,
      finishTimeMinutes: 0,
    }
  }

  // -------------------------------------------------------------------------
  // HOURLY MODE
  // -------------------------------------------------------------------------
  let totalDriveMinutes = 0
  let handlingTime = 0

  if (isThereAndBack) {
    totalDriveMinutes = driveTimeMinutes * 2
    handlingTime = unloadTimeMinutes
  } else {
    totalDriveMinutes = driveTimeMinutes + (travelMethod === 'public_transport' ? travelTimeMins : 0)
    handlingTime = handoverTimeMinutes
  }

  // Work time: crewed jobs use workDurationHours, D&C jobs use setupExtraTimeHours
  const workMinutes = jobType === 'crewed_job' ? workDurationHours * 60 : 0
  const setupMinutes = (isDC && includesSetupWork) ? setupExtraTimeHours * 60 : 0
  const totalMinutes = totalDriveMinutes + handlingTime + workMinutes + setupMinutes
  const totalHours = totalMinutes / 60

  // ---- Auto-calculate OOH from arrival time ----
  let earlyStartMinutes = 0
  let lateFinishMinutes = 0
  let departureTimeMinutes = 0
  let finishTimeMinutes = 0

  if (oohManualOverride) {
    // Use manual values
    earlyStartMinutes = manualEarlyStart
    lateFinishMinutes = manualLateFinish
  } else if (arrivalTime && driveTimeMinutes > 0) {
    // Auto-calculate from arrival time
    const ooh = calculateAutoOOH(
      arrivalTime, driveTimeMinutes, totalMinutes,
      isVehicle, jobType, travelMethod, travelTimeMins
    )
    earlyStartMinutes = ooh.earlyStartMinutes
    lateFinishMinutes = ooh.lateFinishMinutes
    departureTimeMinutes = ooh.departureTime
    finishTimeMinutes = ooh.finishTime
  }

  const normalMinutes = totalMinutes - earlyStartMinutes - lateFinishMinutes
  const outOfHoursMinutes = earlyStartMinutes + lateFinishMinutes
  const normalHours = Math.max(0, normalMinutes) / 60
  const outOfHoursHrs = outOfHoursMinutes / 60

  let freelancerLabourPay = (normalHours * hourlyRateFreelancerDay) + (outOfHoursHrs * hourlyRateFreelancerNight)

  // Add setup fixed premium to freelancer (D&C jobs with setup work)
  if (isDC && includesSetupWork && setupFixedPremium > 0) {
    freelancerLabourPay += setupFixedPremium
  }

  if (applyMinHours) {
    const minPay = minHoursThreshold * hourlyRateFreelancerDay
    if (freelancerLabourPay < minPay && totalHours > 0) freelancerLabourPay = minPay
  }

  const freelancerFeeRounded = roundToNearestFive(freelancerLabourPay)

  let clientLabourCharge = (normalHours * hourlyRateClientDay) + (outOfHoursHrs * hourlyRateClientNight)

  if (applyMinHours) {
    const minClientChargeLab = minHoursThreshold * hourlyRateClientDay
    if (clientLabourCharge < minClientChargeLab && totalHours > 0) clientLabourCharge = minClientChargeLab
  }

  clientLabourCharge += totalHours * adminCostPerHour

  // Add setup fixed premium to client with markup
  if (isDC && includesSetupWork && setupFixedPremium > 0) {
    clientLabourCharge += setupFixedPremium * markupMultiplier
  }

  const clientFuelCharge = fuelIncluded ? fuelCost : 0
  const clientExpenseCharge = expensesIncluded * markupMultiplier

  const clientChargeTotal = clientLabourCharge + clientFuelCharge + clientExpenseCharge
  const clientChargeTotalRounded = Math.max(minClientCharge || 0, Math.round(clientChargeTotal))
  const ourTotalCost = freelancerFeeRounded + fuelCost + expensesIncluded

  return {
    clientChargeLabour: Math.round(clientLabourCharge * 100) / 100,
    clientChargeFuel: Math.round(clientFuelCharge * 100) / 100,
    clientChargeExpenses: Math.round(clientExpenseCharge * 100) / 100,
    clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
    clientChargeTotalRounded,
    freelancerFee: Math.round(freelancerLabourPay * 100) / 100,
    freelancerFeeRounded,
    expectedFuelCost: Math.round(fuelCost * 100) / 100,
    expensesIncluded: Math.round(expensesIncluded * 100) / 100,
    expensesNotIncluded: Math.round(expensesNotIncluded * 100) / 100,
    ourTotalCost: Math.round(ourTotalCost * 100) / 100,
    ourMargin: Math.round((clientChargeTotalRounded - ourTotalCost) * 100) / 100,
    estimatedTimeMinutes: totalMinutes,
    estimatedTimeHours: Math.round(totalHours * 100) / 100,
    autoEarlyStartMinutes: earlyStartMinutes,
    autoLateFinishMinutes: lateFinishMinutes,
    departureTimeMinutes,
    finishTimeMinutes,
  }
}

function generateExpenseBreakdown(expenses: ExpenseItem[], fuelCost: number): string {
  const included = expenses.filter(e => e.included)
  const notIncluded = expenses.filter(e => !e.included)
  const lines: string[] = []

  // --- INCLUDED section ---
  lines.push('INCLUDED IN QUOTE:')
  const fuelExpense = expenses.find(e => e.category === 'fuel')
  
  // Always show fuel in whichever section it belongs to
  if (fuelExpense?.included) {
    lines.push(`- Fuel: £${fuelCost.toFixed(2)}`)
  }

  // Show all standard categories that are included (even if £0)
  for (const exp of included.filter(e => e.category !== 'fuel' && e.category !== 'other')) {
    if (exp.category === 'pd' && exp.pdDays && exp.pdDays > 1 && exp.amount > 0) {
      lines.push(`- ${exp.label}: £${exp.amount}/day × ${exp.pdDays} days = £${(exp.amount * exp.pdDays).toFixed(2)}`)
    } else {
      lines.push(`- ${exp.label}: £${exp.amount.toFixed(2)}`)
    }
  }

  // Show "other" items that are included
  for (const exp of included.filter(e => e.category === 'other')) {
    lines.push(`- Other (${exp.description || 'unspecified'}): £${exp.amount.toFixed(2)}`)
  }

  const includedTotal = included.filter(e => e.category !== 'fuel')
    .reduce((sum, e) => sum + (e.category === 'pd' && e.pdDays ? e.amount * e.pdDays : e.amount), 0)
    + (fuelExpense?.included ? fuelCost : 0)
  if (includedTotal > 0) lines.push(`Total included: £${includedTotal.toFixed(2)}`)

  // --- NOT INCLUDED section ---
  lines.push('')
  lines.push('NOT INCLUDED (client pays separately if incurred):')

  if (!fuelExpense?.included) {
    lines.push(`- Fuel: £${fuelCost.toFixed(2)}`)
  }

  // Show all standard categories that are NOT included (even if £0)
  for (const exp of notIncluded.filter(e => e.category !== 'fuel' && e.category !== 'other')) {
    if (exp.category === 'pd' && exp.pdDays && exp.pdDays > 1 && exp.amount > 0) {
      lines.push(`- ${exp.label}: £${exp.amount}/day × ${exp.pdDays} days = £${(exp.amount * exp.pdDays).toFixed(2)}`)
    } else {
      lines.push(`- ${exp.label}: £${exp.amount.toFixed(2)}`)
    }
  }

  // Show "other" items that are not included
  for (const exp of notIncluded.filter(e => e.category === 'other')) {
    lines.push(`- Other (${exp.description || 'unspecified'}): £${exp.amount.toFixed(2)}`)
  }

  return lines.join('\n')
}

// =============================================================================
// TIME INPUT COMPONENT
// =============================================================================

function TimeInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [localValue, setLocalValue] = useState(value)
  useEffect(() => { setLocalValue(value) }, [value])

  const handleBlur = () => {
    const normalized = normalizeTimeInput(localValue)
    if (normalized !== localValue) {
      setLocalValue(normalized)
      onChange(normalized)
    }
  }

  return (
    <input
      type="text"
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value)
        if (/^\d{2}:\d{2}$/.test(e.target.value)) onChange(e.target.value)
      }}
      onBlur={handleBlur}
      placeholder={placeholder || 'HH:MM'}
      className={className || 'w-full px-4 py-2 border border-gray-300 rounded-lg'}
    />
  )
}

// =============================================================================
// VENUE DROPDOWN COMPONENT
// =============================================================================

function VenueDropdown({ value, venues, loading, onSelect }: { value: string; venues: Venue[]; loading: boolean; onSelect: (venue: Venue | null, isNew: boolean, newName?: string) => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState(value)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setSearchTerm(value) }, [value])
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filteredVenues = venues.filter(v => v.name.toLowerCase().includes(searchTerm.toLowerCase())).slice(0, 10)
  const showAddNew = searchTerm.length > 0 && !venues.some(v => v.name.toLowerCase() === searchTerm.toLowerCase())

  return (
    <div ref={dropdownRef} className="relative">
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => { setSearchTerm(e.target.value); setIsOpen(true); onSelect(null, false, e.target.value) }}
        onFocus={() => setIsOpen(true)}
        placeholder={loading ? 'Loading venues...' : 'Search or enter venue name...'}
        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
        disabled={loading}
      />
      {isOpen && !loading && (searchTerm.length > 0 || venues.length > 0) && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {filteredVenues.map(venue => (
            <button key={venue.id} type="button" onClick={() => { setSearchTerm(venue.name); setIsOpen(false); onSelect(venue, false) }}
              className="w-full px-4 py-2 text-left hover:bg-gray-100 border-b border-gray-50">
              <div className="flex justify-between items-start">
                <span className="font-medium text-gray-900">{venue.name}</span>
                {(venue.distance || venue.driveTime) && (
                  <span className="text-xs text-gray-500 ml-2 whitespace-nowrap">
                    {venue.distance && `${venue.distance}mi`}{venue.distance && venue.driveTime && ' · '}{venue.driveTime && `${venue.driveTime}min`}
                  </span>
                )}
              </div>
              {venue.address && <p className="text-xs text-gray-500 mt-0.5 truncate">📍 {getAddressSnippet(venue.address)}</p>}
            </button>
          ))}
          {showAddNew && (
            <button type="button" onClick={() => { setIsOpen(false); onSelect(null, true, searchTerm) }}
              className="w-full px-4 py-2 text-left hover:bg-blue-50 text-blue-600 border-t border-gray-100 flex items-center gap-2">
              <span className="text-lg">➕</span><span>Add &quot;{searchTerm}&quot; as new venue</span>
            </button>
          )}
          {filteredVenues.length === 0 && !showAddNew && searchTerm.length > 0 && (
            <div className="px-4 py-2 text-gray-500 text-sm">No venues found</div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// EXPENSE ROW COMPONENT
// =============================================================================

function ExpenseRow({ expense, fuelCost, numberOfDays, onChange, onRemove }: { expense: ExpenseItem; fuelCost?: number; numberOfDays: number; onChange: (e: ExpenseItem) => void; onRemove?: () => void }) {
  const isOther = expense.category === 'other'
  const isPD = expense.category === 'pd'
  const isFuel = expense.category === 'fuel'

  useEffect(() => {
    if (isPD && expense.pdDays !== numberOfDays) onChange({ ...expense, pdDays: numberOfDays })
  }, [isPD, numberOfDays, expense, onChange])

  const displayAmount = isFuel ? (fuelCost || 0) : expense.amount
  const pdTotal = isPD && expense.pdDays ? expense.amount * expense.pdDays : expense.amount

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <label className="flex items-center">
        <input type="checkbox" checked={expense.included} onChange={(e) => onChange({ ...expense, included: e.target.checked })} className="w-4 h-4 text-blue-600 rounded" />
      </label>
      <div className="flex-1 min-w-0">
        {isOther ? (
          <input type="text" value={expense.description || ''} onChange={(e) => onChange({ ...expense, description: e.target.value })}
            placeholder="Description..." className="w-full px-2 py-1 text-sm border border-gray-200 rounded" />
        ) : (
          <span className={`text-sm ${expense.included ? 'text-gray-900' : 'text-gray-400'}`}>{expense.label}</span>
        )}
      </div>
      <div className="w-28">
        {isFuel ? (
          <div className="px-2 py-1 text-sm text-gray-500 bg-gray-50 rounded text-right">£{displayAmount.toFixed(2)}</div>
        ) : isPD ? (
          <div className="flex items-center gap-1">
            <span className="text-gray-500 text-sm">£</span>
            <input type="number" value={expense.amount || ''} onChange={(e) => onChange({ ...expense, amount: parseFloat(e.target.value) || 0 })}
              placeholder="0" min="0" className="w-16 px-2 py-1 text-sm border border-gray-200 rounded text-right" />
            <span className="text-gray-500 text-xs">/day</span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span className="text-gray-500 text-sm">£</span>
            <input type="number" value={expense.amount || ''} onChange={(e) => onChange({ ...expense, amount: parseFloat(e.target.value) || 0 })}
              placeholder="0" min="0" className="w-20 px-2 py-1 text-sm border border-gray-200 rounded text-right" />
          </div>
        )}
      </div>
      {isPD && expense.amount > 0 && expense.pdDays && expense.pdDays > 1 && (
        <div className="text-xs text-gray-500 w-24 text-right">× {expense.pdDays} = £{pdTotal.toFixed(0)}</div>
      )}
      {isFuel && <div className="text-xs text-gray-400 w-24">(auto)</div>}
      {isOther && onRemove && (
        <button type="button" onClick={onRemove} className="text-red-500 hover:text-red-700 text-sm px-2">✕</button>
      )}
    </div>
  )
}

// =============================================================================
// OOH INFO DISPLAY COMPONENT
// =============================================================================

function OOHDisplay({ costs, formData, settings, onToggleOverride, onChangeEarly, onChangeLate }: {
  costs: CalculatedCosts
  formData: FormData
  settings: CostingSettings
  onToggleOverride: () => void
  onChangeEarly: (v: number) => void
  onChangeLate: (v: number) => void
}) {
  const hasArrivalTime = !!formData.arrivalTime && formData.driveTimeMinutes > 0
  const hasOOH = costs.autoEarlyStartMinutes > 0 || costs.autoLateFinishMinutes > 0
  const isManual = formData.oohManualOverride

  if (isManual) {
    return (
      <div className="border-t pt-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-gray-900">Out of Hours (manual)</h3>
          <button type="button" onClick={onToggleOverride} className="text-sm text-blue-600 hover:text-blue-800">Switch to auto-calculate →</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Early Start (minutes before 8am)</label>
            <input type="number" value={formData.earlyStartMinutes || ''} onChange={(e) => onChangeEarly(parseFloat(e.target.value) || 0)} placeholder="0" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Late Finish (minutes after 11pm)</label>
            <input type="number" value={formData.lateFinishMinutes || ''} onChange={(e) => onChangeLate(parseFloat(e.target.value) || 0)} placeholder="0" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
          </div>
        </div>
      </div>
    )
  }

  // Auto-calculated mode
  return (
    <div className="border-t pt-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-gray-900">Out of Hours</h3>
        <button type="button" onClick={onToggleOverride} className="text-sm text-gray-500 hover:text-gray-700">Override manually →</button>
      </div>
      {!hasArrivalTime ? (
        <p className="text-sm text-gray-400 italic">Enter arrival time and drive time to auto-calculate out of hours.</p>
      ) : hasOOH ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
          <p className="text-sm font-medium text-amber-800">⏰ Out of hours detected</p>
          {costs.autoEarlyStartMinutes > 0 && (
            <p className="text-sm text-amber-700">
              Departs {formatMinutesAsTime(costs.departureTimeMinutes)} → {formatDurationHM(costs.autoEarlyStartMinutes)} before 8am
            </p>
          )}
          {costs.autoLateFinishMinutes > 0 && (
            <p className="text-sm text-amber-700">
              Finishes ~{formatMinutesAsTime(costs.finishTimeMinutes)} → {formatDurationHM(costs.autoLateFinishMinutes)} after 11pm
            </p>
          )}
          <p className="text-xs text-amber-600 mt-1">Night rate applied to {formatDurationHM(costs.autoEarlyStartMinutes + costs.autoLateFinishMinutes)} of out-of-hours time</p>
        </div>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-sm text-green-700">
            ✓ Within standard hours ({formatMinutesAsTime(costs.departureTimeMinutes)} – ~{formatMinutesAsTime(costs.finishTimeMinutes)})
          </p>
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
  const [selectedVenueAddress, setSelectedVenueAddress] = useState<string | null>(null)
  const [step, setStep] = useState(1)

  const jobNumberFromUrl = searchParams.get('job') || ''

  const fetchVenues = useCallback(async () => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin) return
    setLoadingVenues(true)
    try {
      const response = await fetch('/api/staff/venues', { headers: { 'x-staff-pin': pin } })
      const data = await response.json()
      if (data.success && data.venues) { setVenues(data.venues); console.log(`Loaded ${data.venues.length} venues`) }
    } catch (err) { console.error('Failed to fetch venues:', err) }
    finally { setLoadingVenues(false) }
  }, [])

  const fetchJobInfo = useCallback(async (jobNum: string) => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin || !jobNum) return
    setLoadingJob(true)
    try {
      const response = await fetch(`/api/staff/crew-transport?jobNumber=${jobNum}`, { headers: { 'x-staff-pin': pin } })
      const data = await response.json()
      if (data.success && data.jobInfo) {
        setJobInfo(data.jobInfo)
        setFormData(prev => ({
          ...prev,
          clientName: data.jobInfo.clientName || '',
          jobDate: prev.jobDate || data.jobInfo.hireStartDate || '',
          jobFinishDate: prev.jobFinishDate || data.jobInfo.hireEndDate || '',
          collectionDate: prev.collectionDate || data.jobInfo.hireEndDate || '',
        }))
      }
    } catch (err) { console.error('Failed to fetch job info:', err) }
    finally { setLoadingJob(false) }
  }, [])

  useEffect(() => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin) { sessionStorage.setItem('staffReturnUrl', window.location.href); router.push('/staff'); return }

    async function loadSettings() {
      try {
        const response = await fetch('/api/staff/settings', { headers: { 'x-staff-pin': pin! } })
        const data = await response.json()
        if (!response.ok) {
          if (response.status === 401) { sessionStorage.removeItem('staffPin'); sessionStorage.setItem('staffReturnUrl', window.location.href); router.push('/staff'); return }
          throw new Error(data.error || 'Failed to load settings')
        }
        setSettings(data.settings)
        setSettingsSource(data.source)
        if (data.source === 'defaults') setError('⚠️ Could not load settings from Monday.com - using defaults.')
      } catch (err) { console.error('Failed to load settings:', err); setError('Failed to load costing settings.') }
      finally { setLoading(false) }
    }
    loadSettings()
    fetchVenues()
  }, [router, fetchVenues])

  useEffect(() => {
    if (jobNumberFromUrl && !formData.hirehopJobNumber) {
      setFormData(prev => ({ ...prev, hirehopJobNumber: jobNumberFromUrl }))
      fetchJobInfo(jobNumberFromUrl)
    }
  }, [jobNumberFromUrl, formData.hirehopJobNumber, fetchJobInfo])

  // Auto-calculate numberOfDays for multi-day jobs
  useEffect(() => {
    if (formData.isMultiDay && formData.jobDate && formData.jobFinishDate) {
      const days = calculateDaysBetween(formData.jobDate, formData.jobFinishDate)
      if (days !== formData.numberOfDays) setFormData(prev => ({ ...prev, numberOfDays: days }))
    }
  }, [formData.isMultiDay, formData.jobDate, formData.jobFinishDate, formData.numberOfDays])

  const costs = settings ? calculateCosts(formData, settings) : null
  const updateField = useCallback(<K extends keyof FormData>(field: K, value: FormData[K]) => { setFormData(prev => ({ ...prev, [field]: value })) }, [])

  const handleVenueSelect = (venue: Venue | null, isNew: boolean, newName?: string) => {
    if (venue) {
      const hasDistance = (venue.distance ?? 0) > 0
      setSelectedVenueAddress(venue.address)
      setFormData(prev => ({
        ...prev, destination: venue.name, selectedVenueId: venue.id, isNewVenue: false,
        distanceMiles: venue.distance ?? 0, driveTimeMinutes: venue.driveTime ?? 0,
        travelTimeMins: venue.travelTime ?? 0, travelCost: venue.ticketCost ?? 0,
        expenses: prev.expenses.map(exp =>
          exp.category === 'tolls' ? { ...exp, amount: venue.tollsParking ?? 0 } :
          exp.category === 'fuel' ? { ...exp, included: hasDistance } : exp
        ),
        originalVenueDistance: venue.distance, originalVenueDriveTime: venue.driveTime,
        originalVenueTravelTime: venue.travelTime, originalVenueTicketCost: venue.ticketCost, originalVenueTollsParking: venue.tollsParking,
      }))
    } else if (isNew && newName) {
      setSelectedVenueAddress(null)
      setFormData(prev => ({
        ...prev, destination: newName, selectedVenueId: null, isNewVenue: true,
        distanceMiles: 0, driveTimeMinutes: 0, travelTimeMins: 0, travelCost: 0,
        expenses: prev.expenses.map(exp =>
          exp.category === 'tolls' ? { ...exp, amount: 0 } :
          exp.category === 'fuel' ? { ...exp, included: false } : exp
        ),
        originalVenueDistance: null, originalVenueDriveTime: null, originalVenueTravelTime: null,
        originalVenueTicketCost: null, originalVenueTollsParking: null,
      }))
    } else if (newName !== undefined) {
      setSelectedVenueAddress(null)
      setFormData(prev => ({
        ...prev, destination: newName, selectedVenueId: null, isNewVenue: false,
        distanceMiles: 0, driveTimeMinutes: 0, travelTimeMins: 0, travelCost: 0,
        expenses: prev.expenses.map(exp =>
          exp.category === 'tolls' ? { ...exp, amount: 0 } :
          exp.category === 'fuel' ? { ...exp, included: false } : exp
        ),
        originalVenueDistance: null, originalVenueDriveTime: null, originalVenueTravelTime: null,
        originalVenueTicketCost: null, originalVenueTollsParking: null,
      }))
    }
  }

  const updateExpense = useCallback((updated: ExpenseItem) => {
    setFormData(prev => ({ ...prev, expenses: prev.expenses.map(exp => exp.id === updated.id ? updated : exp) }))
  }, [])

  const addOtherExpense = useCallback(() => {
    setFormData(prev => ({ ...prev, expenses: [...prev.expenses, { id: generateExpenseId(), category: 'other', label: 'Other', amount: 0, included: true, description: '' }] }))
  }, [])

  const removeExpense = useCallback((id: string) => {
    setFormData(prev => ({ ...prev, expenses: prev.expenses.filter(exp => exp.id !== id) }))
  }, [])

  const handleSave = async () => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin || !costs) return
    setSaving(true); setError(null); setSaveResult(null)

    try {
      const tollsExpense = formData.expenses.find(e => e.category === 'tolls')
      const tollsParking = tollsExpense?.amount || 0
      const fuelExpense = formData.expenses.find(e => e.category === 'fuel')

      const dataToSave = {
        ...formData, tollsParking,
        expenseBreakdown: generateExpenseBreakdown(formData.expenses, costs.expectedFuelCost),
        expensesIncludedTotal: costs.expensesIncluded + (fuelExpense?.included ? costs.expectedFuelCost : 0),
        expensesNotIncludedTotal: costs.expensesNotIncluded + (!fuelExpense?.included ? costs.expectedFuelCost : 0),
        // Use the auto-calculated OOH values (or manual if overridden) for writing to Monday
        earlyStartMinutes: formData.oohManualOverride ? formData.earlyStartMinutes : costs.autoEarlyStartMinutes,
        lateFinishMinutes: formData.oohManualOverride ? formData.lateFinishMinutes : costs.autoLateFinishMinutes,
        venueDistanceChanged: formData.selectedVenueId !== null && ((formData.originalVenueDistance === null && formData.distanceMiles > 0) || (formData.originalVenueDistance !== null && formData.distanceMiles !== formData.originalVenueDistance)),
        venueDriveTimeChanged: formData.selectedVenueId !== null && ((formData.originalVenueDriveTime === null && formData.driveTimeMinutes > 0) || (formData.originalVenueDriveTime !== null && formData.driveTimeMinutes !== formData.originalVenueDriveTime)),
        venuePublicTransportTimeChanged: formData.selectedVenueId !== null && ((formData.originalVenueTravelTime === null && formData.travelTimeMins > 0) || (formData.originalVenueTravelTime !== null && formData.travelTimeMins !== formData.originalVenueTravelTime)),
        venuePublicTransportCostChanged: formData.selectedVenueId !== null && ((formData.originalVenueTicketCost === null && formData.travelCost > 0) || (formData.originalVenueTicketCost !== null && formData.travelCost !== formData.originalVenueTicketCost)),
        venueTollsParkingChanged: formData.selectedVenueId !== null && ((formData.originalVenueTollsParking === null && tollsParking > 0) || (formData.originalVenueTollsParking !== null && tollsParking !== formData.originalVenueTollsParking)),
      }

      const costsToSave = {
        clientChargeTotal: costs.clientChargeTotalRounded, freelancerFee: costs.freelancerFeeRounded,
        expectedFuelCost: costs.expectedFuelCost, expensesIncluded: costs.expensesIncluded,
        expensesNotIncluded: costs.expensesNotIncluded, ourMargin: costs.ourMargin,
      }

      const response = await fetch('/api/staff/crew-transport', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-staff-pin': pin },
        body: JSON.stringify({ formData: dataToSave, costs: costsToSave }),
      })
      const data: SaveResult = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save')

      setSaveResult(data)
      let message = '✅ '
      if (data.board === 'dc') {
        message += `Created on D&C Board: ${data.itemName}`
        if (data.collectionItemName) message += ` + Collection: ${data.collectionItemName}`
      } else if (data.board === 'crewed_jobs') {
        message += `Created on Crewed Jobs Board: ${data.itemName}`
      }
     if (formData.isNewVenue) message += ' (New venue added)'
      setSuccess(message)

      // =========================================================================
      // HIREHOP INTEGRATION - Add labour items to HireHop quote
      // =========================================================================
      if (formData.hirehopJobNumber) {
        const hirehopItems: Array<{
          type: 'delivery' | 'collection' | 'crew'
          price: number
          date?: string
          time?: string
          venue?: string
        }> = []

        if (isDC) {
          if (formData.addDeliveryToHireHop) {
            hirehopItems.push({
              type: formData.jobType === 'collection' ? 'collection' : 'delivery',
              price: costs.clientChargeTotalRounded,
              date: formData.jobDate,
              time: formData.arrivalTime,
              venue: formData.destination,
            })
          }
          if (formData.addCollection && formData.addCollectionToHireHop) {
            hirehopItems.push({
              type: 'collection',
              price: costs.clientChargeTotalRounded,
              date: formData.collectionDate,
              time: formData.collectionArrivalTime,
              venue: formData.destination,
            })
          }
        }

        if (isCrewedJob && formData.addCrewToHireHop) {
          hirehopItems.push({
            type: 'crew',
            price: costs.clientChargeTotalRounded,
            date: formData.jobDate,
            time: formData.arrivalTime,
            venue: formData.destination,
          })
        }

        if (hirehopItems.length > 0) {
          try {
            console.log('Adding items to HireHop:', hirehopItems)
            const hhResponse = await fetch('/api/staff/hirehop-items', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-staff-pin': pin },
              body: JSON.stringify({ jobId: formData.hirehopJobNumber, items: hirehopItems }),
            })
            const hhData = await hhResponse.json()
            if (hhData.success) {
              setSuccess(prev => prev + ' + HireHop updated')
            } else if (hhData.partial) {
              setSuccess(prev => prev + ' (HireHop: partial)')
            } else {
              console.error('HireHop error:', hhData.error)
            }
          } catch (hhErr) {
            console.error('HireHop API error:', hhErr)
          }
        }
      }
    } catch (err) { console.error('Save error:', err); setError(err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  const handleStartNew = () => {
    setFormData({ ...initialFormData, expenses: createInitialExpenses() })
    setJobInfo(null); setSuccess(null); setSaveResult(null); setError(null); setSelectedVenueAddress(null); setStep(1)
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading wizard...</p>
      </div>
    </div>
  )

  const isCrewedJob = formData.jobType === 'crewed_job'
  const isDC = formData.jobType === 'delivery' || formData.jobType === 'collection'
  const totalSteps = isCrewedJob ? 5 : 4
  const stepLabels = isCrewedJob ? ['Job', 'Transport', 'Work', 'Expenses', 'Review'] : ['Job', 'Transport', 'Expenses', 'Review']

  const isStep1Valid = formData.jobType !== '' && formData.jobDate !== '' && (isCrewedJob || formData.whatIsIt !== '')
  const isStep2Valid = isCrewedJob ? true : (formData.destination !== '' && formData.distanceMiles >= 0)
  const isStep3Valid = !isCrewedJob || formData.workType !== ''

  const isVehicle = formData.whatIsIt === 'vehicle'
  const needsTravelQuestion = isDC && isVehicle
  const calculatedDays = formData.isMultiDay && formData.jobDate && formData.jobFinishDate ? calculateDaysBetween(formData.jobDate, formData.jobFinishDate) : 1

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button onClick={() => router.push('/staff')} className="text-gray-500 hover:text-gray-700">← Back</button>
            <h1 className="text-xl font-bold text-gray-900">Crew & Transport Costing</h1>
          </div>
          {(formData.hirehopJobNumber || jobInfo) && (
            <div className="text-right">
              <span className="text-sm font-medium text-gray-900">Job #{formData.hirehopJobNumber}</span>
              {jobInfo?.clientName && <p className="text-sm text-gray-500">{jobInfo.clientName}</p>}
            </div>
          )}
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-8">
          {stepLabels.map((label, idx) => (
            <div key={label} className="flex items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${step > idx + 1 ? 'bg-green-500 text-white' : step === idx + 1 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
                {step > idx + 1 ? '✓' : idx + 1}
              </div>
              <span className={`ml-2 text-sm hidden sm:inline ${step === idx + 1 ? 'text-blue-600 font-medium' : 'text-gray-500'}`}>{label}</span>
              {idx < totalSteps - 1 && <div className="w-4 sm:w-8 h-0.5 bg-gray-200 mx-2" />}
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 pb-8">
        <div className="bg-white rounded-xl shadow-sm p-6">
          {settingsSource === 'defaults' && <div className="mb-6 bg-yellow-50 text-yellow-800 px-4 py-3 rounded-lg text-sm">⚠️ Using default settings. Please populate the D&C Settings board.</div>}
          {error && !error.includes('defaults') && <div className="mb-6 bg-red-50 text-red-600 px-4 py-3 rounded-lg">{error}</div>}
          {success && (
            <div className="mb-6 bg-green-50 text-green-700 px-4 py-3 rounded-lg">
              <p className="font-medium">{success}</p>
              {saveResult && <p className="mt-2 text-sm">{saveResult.board === 'dc' ? '📦 D&C Board' : '👷 Crewed Jobs Board'} → Item ID: {saveResult.itemId}</p>}
              <button onClick={handleStartNew} className="mt-3 text-sm text-green-800 underline hover:no-underline">Create another quote →</button>
            </div>
          )}

          {/* ============================================================= */}
          {/* STEP 1: JOB DETAILS                                           */}
          {/* ============================================================= */}
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">What are we doing?</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">HireHop Job Number</label>
                  <div className="relative">
                    <input type="text" value={formData.hirehopJobNumber} onChange={(e) => updateField('hirehopJobNumber', e.target.value)}
                      onBlur={() => { if (formData.hirehopJobNumber && formData.hirehopJobNumber !== jobInfo?.id) fetchJobInfo(formData.hirehopJobNumber) }}
                      placeholder="e.g. 15276" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
                    {loadingJob && <div className="absolute right-3 top-2.5"><div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div></div>}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Client</label>
                  <input type="text" value={formData.clientName || jobInfo?.clientName || ''} readOnly placeholder="Auto-filled from job" className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-gray-50" />
                </div>
              </div>

              {/* Job type selection - updated descriptions */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { value: 'delivery', label: 'Delivery', icon: '📦', desc: 'Taking something out (may include setup)' },
                  { value: 'collection', label: 'Collection', icon: '📥', desc: 'Bringing something back (may include pack-down)' },
                  { value: 'crewed_job', label: 'Crewed Job', icon: '👷', desc: 'Freelancer stays on site to work the event' },
                ].map((option) => (
                  <button key={option.value} onClick={() => {
                    // Reset calculation-relevant state when job type changes
                    setFormData(prev => ({
                      ...prev,
                      jobType: option.value as FormData['jobType'],
                      addCollection: false,
                      whatIsIt: option.value === 'crewed_job' ? '' as const : prev.whatIsIt,
                      calculationMode: option.value === 'crewed_job' ? 'day_rate' as const : 'hourly' as const,
                      travelMethod: '' as const,
                      travelTimeMins: 0,
                      travelCost: 0,
                      includesSetupWork: false,
                      setupWorkDescription: '',
                      setupExtraTimeHours: 0,
                      setupFixedPremium: 0,
                      oohManualOverride: false,
                      earlyStartMinutes: 0,
                      lateFinishMinutes: 0,
                      jobDate: option.value === 'collection' && jobInfo?.hireEndDate && !prev.jobDate ? jobInfo.hireEndDate :
                               (option.value === 'delivery' || option.value === 'crewed_job') && jobInfo?.hireStartDate && !prev.jobDate ? jobInfo.hireStartDate :
                               prev.jobDate,
                    }))
                  }} className={`p-4 rounded-xl border-2 text-left transition-all ${formData.jobType === option.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <span className="text-2xl">{option.icon}</span>
                    <h3 className="mt-1 font-semibold text-gray-900">{option.label}</h3>
                    <p className="text-xs text-gray-500">{option.desc}</p>
                  </button>
                ))}
              </div>

              {/* What is it? (D&C only) */}
              {isDC && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">What is it?</label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: 'vehicle', label: 'A Vehicle', icon: '🚐', hint: 'Driver returns separately' },
                      { value: 'equipment', label: 'Equipment', icon: '🎸', hint: 'Driver returns with van' },
                      { value: 'people', label: 'People', icon: '👥', hint: 'Driver returns with van' },
                    ].map((option) => (
                      <button key={option.value} onClick={() => updateField('whatIsIt', option.value as FormData['whatIsIt'])}
                        className={`p-3 rounded-lg border-2 text-center transition-all ${formData.whatIsIt === option.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                        <span className="text-xl">{option.icon}</span>
                        <p className="text-sm font-medium text-gray-900 mt-1">{option.label}</p>
                        <p className="text-xs text-gray-500">{option.hint}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Setup work toggle (D&C only) */}
              {isDC && formData.whatIsIt && (
                <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                  <label className="flex items-center space-x-2">
                    <input type="checkbox" checked={formData.includesSetupWork} onChange={(e) => updateField('includesSetupWork', e.target.checked)} className="w-4 h-4 text-blue-600 rounded" />
                    <span className="text-sm font-medium text-gray-700">
                      {formData.jobType === 'delivery' ? 'Includes setup work on site' : 'Includes pack-down work on site'}
                    </span>
                  </label>
                  {formData.includesSetupWork && (
                    <div className="ml-6 space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                        <input type="text" value={formData.setupWorkDescription} onChange={(e) => updateField('setupWorkDescription', e.target.value)}
                          placeholder={formData.jobType === 'delivery' ? 'e.g. Set up PA in main hall, see stage plot' : 'e.g. Pack down backline from stage'} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Extra time (hours)</label>
                          <input type="number" value={formData.setupExtraTimeHours || ''} onChange={(e) => updateField('setupExtraTimeHours', parseFloat(e.target.value) || 0)}
                            placeholder="0" min="0" step="0.5" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          <p className="text-xs text-gray-400 mt-1">Added to hourly calculation</p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Fixed premium (£)</label>
                          <input type="number" value={formData.setupFixedPremium || ''} onChange={(e) => updateField('setupFixedPremium', parseFloat(e.target.value) || 0)}
                            placeholder="0" min="0" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          <p className="text-xs text-gray-400 mt-1">Flat fee added to both freelancer &amp; client</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Board indicator */}
              {formData.jobType && (
                <div className={`text-sm px-3 py-2 rounded-lg ${isCrewedJob ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'}`}>
                  {isCrewedJob ? '👷 This will be saved to the Crewed Jobs board' : '📦 This will be saved to the D&C board'}
                </div>
              )}

              {/* When? section */}
              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">When?</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {formData.jobType === 'delivery' ? 'Delivery Date' : formData.jobType === 'collection' ? 'Collection Date' : formData.isMultiDay ? 'Start Date' : 'Job Date'}
                    </label>
                    <input type="date" value={formData.jobDate} onChange={(e) => updateField('jobDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    {/* Date change hint: show if date differs from Q&H board */}
                    {formData.jobType === 'delivery' && jobInfo?.hireStartDate && formData.jobDate && formData.jobDate !== jobInfo.hireStartDate && (
                      <p className="text-xs text-amber-600 mt-1">⚠️ Hire starts: {formatDateUK(jobInfo.hireStartDate)}</p>
                    )}
                    {formData.jobType === 'collection' && jobInfo?.hireEndDate && formData.jobDate && formData.jobDate !== jobInfo.hireEndDate && (
                      <p className="text-xs text-amber-600 mt-1">⚠️ Hire ends: {formatDateUK(jobInfo.hireEndDate)}</p>
                    )}
                    {formData.jobType === 'crewed_job' && jobInfo?.hireStartDate && formData.jobDate && formData.jobDate !== jobInfo.hireStartDate && (
                      <p className="text-xs text-amber-600 mt-1">⚠️ Hire starts: {formatDateUK(jobInfo.hireStartDate)}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Arrive by (optional)</label>
                    <TimeInput value={formData.arrivalTime} onChange={(v) => updateField('arrivalTime', v)} placeholder="e.g. 11 or 11:30" />
                  </div>

                  {/* Multi-day toggle (crewed jobs) */}
                  {isCrewedJob && (
                    <>
                      <div className="md:col-span-2">
                        <label className="flex items-center space-x-2">
                          <input type="checkbox" checked={formData.isMultiDay} onChange={(e) => { updateField('isMultiDay', e.target.checked); if (e.target.checked) updateField('calculationMode', 'day_rate') }} className="w-4 h-4 text-blue-600 rounded" />
                          <span className="text-sm font-medium text-gray-700">Multi-day job</span>
                        </label>
                      </div>
                      {formData.isMultiDay && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Finish Date</label>
                          <input type="date" value={formData.jobFinishDate} onChange={(e) => updateField('jobFinishDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          {formData.jobDate && formData.jobFinishDate && <p className="text-xs text-blue-600 mt-1">📅 {calculatedDays} day{calculatedDays !== 1 ? 's' : ''} (used for day rate)</p>}
                          {/* Hire end date hint */}
                          {jobInfo?.hireEndDate && formData.jobFinishDate && formData.jobFinishDate !== jobInfo.hireEndDate && (
                            <p className="text-xs text-amber-600 mt-1">⚠️ Hire ends: {formatDateUK(jobInfo.hireEndDate)}</p>
                          )}
                          {/* Finish before start validation */}
                          {formData.jobDate && formData.jobFinishDate && formData.jobFinishDate < formData.jobDate && (
                            <p className="text-xs text-red-600 mt-1">⚠️ Finish date is before start date — is this right?</p>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Add collection (delivery only) */}
                  {formData.jobType === 'delivery' && (
                    <>
                      <div className="md:col-span-2">
                        <label className="flex items-center space-x-2">
                          <input type="checkbox" checked={formData.addCollection} onChange={(e) => updateField('addCollection', e.target.checked)} className="w-4 h-4 text-blue-600 rounded" />
                          <span className="text-sm font-medium text-gray-700">Add collection from same location</span>
                        </label>
                        {formData.addCollection && <p className="text-xs text-blue-600 mt-1 ml-6">ℹ️ This will create 2 items on the D&C board</p>}
                      </div>
                      {formData.addCollection && (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Collection Date</label>
                            <input type="date" value={formData.collectionDate} onChange={(e) => updateField('collectionDate', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                            {/* Date hint for collection */}
                            {jobInfo?.hireEndDate && formData.collectionDate && formData.collectionDate !== jobInfo.hireEndDate && (
                              <p className="text-xs text-amber-600 mt-1">⚠️ Hire ends: {formatDateUK(jobInfo.hireEndDate)}</p>
                            )}
                            {/* Collection before delivery validation */}
                            {formData.jobDate && formData.collectionDate && formData.collectionDate < formData.jobDate && (
                              <p className="text-xs text-red-600 mt-1">⚠️ Collection date is before delivery date — is this right?</p>
                            )}
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Collection arrive by (optional)</label>
                            <TimeInput value={formData.collectionArrivalTime} onChange={(v) => updateField('collectionArrivalTime', v)} placeholder="e.g. 14 or 14:30" />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================= */}
          {/* STEP 2: TRANSPORT                                              */}
          {/* ============================================================= */}
          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Transport Details</h2>
              {isCrewedJob && <div className="p-4 bg-yellow-50 rounded-lg text-yellow-800 text-sm">💡 For crew-only jobs with no transport, leave destination blank or set distance to 0.</div>}
              {isDC && (
                <div className={`p-3 rounded-lg text-sm ${isVehicle ? 'bg-orange-50 text-orange-700' : 'bg-green-50 text-green-700'}`}>
                  {isVehicle ? (formData.jobType === 'delivery' ? (formData.addCollection ? '🚐 Vehicle delivery + collection' : '🚐 Vehicle delivery: Driver will need to get home') : '🚐 Vehicle collection: Driver will need to get there') : '📦 Equipment/People: Driver goes there and back with the van'}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Destination {isCrewedJob && <span className="text-gray-400 font-normal">(optional for crew-only)</span>}</label>
                  <VenueDropdown value={formData.destination} venues={venues} loading={loadingVenues} onSelect={handleVenueSelect} />
                  {formData.selectedVenueId && <p className="text-xs text-green-600 mt-1">✓ Selected from venues database</p>}
                  {formData.isNewVenue && formData.destination && <p className="text-xs text-blue-600 mt-1">➕ Will be added to venues database on save</p>}
                  {selectedVenueAddress && <p className="text-xs text-gray-500 mt-1">📍 {getAddressSnippet(selectedVenueAddress, 80)}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Distance (miles, one-way)</label>
                  <input type="number" value={formData.distanceMiles === 0 ? '0' : formData.distanceMiles || ''} onChange={(e) => updateField('distanceMiles', parseFloat(e.target.value) || 0)} placeholder="From Google Maps" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  {/* Venue field indicators for distance */}
                  {formData.selectedVenueId && formData.originalVenueDistance !== null && formData.distanceMiles === formData.originalVenueDistance && formData.distanceMiles > 0 && (
                    <p className="text-xs text-green-600 mt-1">✓ From venue database</p>
                  )}
                  {formData.selectedVenueId && formData.originalVenueDistance === null && formData.distanceMiles > 0 && (
                    <p className="text-xs text-blue-600 mt-1">➕ Will be saved to venue</p>
                  )}
                  {formData.selectedVenueId && formData.originalVenueDistance !== null && formData.distanceMiles !== formData.originalVenueDistance && (
                    <p className="text-xs text-orange-600 mt-1">⚠️ Changed from {formData.originalVenueDistance}mi — venue will be updated</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Drive Time (minutes, one-way)</label>
                  <input type="number" value={formData.driveTimeMinutes || ''} onChange={(e) => updateField('driveTimeMinutes', parseFloat(e.target.value) || 0)} placeholder="From Google Maps" min="0" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  {/* Venue field indicators for drive time */}
                  {formData.selectedVenueId && formData.originalVenueDriveTime !== null && formData.driveTimeMinutes === formData.originalVenueDriveTime && formData.driveTimeMinutes > 0 && (
                    <p className="text-xs text-green-600 mt-1">✓ From venue database</p>
                  )}
                  {formData.selectedVenueId && formData.originalVenueDriveTime === null && formData.driveTimeMinutes > 0 && (
                    <p className="text-xs text-blue-600 mt-1">➕ Will be saved to venue</p>
                  )}
                  {formData.selectedVenueId && formData.originalVenueDriveTime !== null && formData.driveTimeMinutes !== formData.originalVenueDriveTime && (
                    <p className="text-xs text-orange-600 mt-1">⚠️ Changed from {formData.originalVenueDriveTime}min — venue will be updated</p>
                  )}
                </div>
              </div>

              {needsTravelQuestion && (
                <div className="border-t pt-6 mt-6">
                  <h3 className="font-medium text-gray-900 mb-2">{formData.jobType === 'delivery' ? 'How does the driver get home?' : 'How does the driver get there?'}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Travel Method</label>
                      <select value={formData.travelMethod} onChange={(e) => updateField('travelMethod', e.target.value as FormData['travelMethod'])} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                        <option value="">Select...</option>
                        <option value="public_transport">Public transport (we pay)</option>
                        <option value="own_way">Gets a lift / own way</option>
                      </select>
                    </div>
                    {formData.travelMethod === 'public_transport' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Travel Time (mins)</label>
                          <input type="number" value={formData.travelTimeMins || ''} onChange={(e) => updateField('travelTimeMins', parseFloat(e.target.value) || 0)} placeholder="Journey time" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          {/* Venue field indicators for travel time */}
                          {formData.selectedVenueId && formData.originalVenueTravelTime !== null && formData.travelTimeMins === formData.originalVenueTravelTime && formData.travelTimeMins > 0 && (
                            <p className="text-xs text-green-600 mt-1">✓ From venue database</p>
                          )}
                          {formData.selectedVenueId && formData.originalVenueTravelTime === null && formData.travelTimeMins > 0 && (
                            <p className="text-xs text-blue-600 mt-1">➕ Will be saved to venue</p>
                          )}
                          {formData.selectedVenueId && formData.originalVenueTravelTime !== null && formData.travelTimeMins !== formData.originalVenueTravelTime && (
                            <p className="text-xs text-orange-600 mt-1">⚠️ Changed from {formData.originalVenueTravelTime}min — venue will be updated</p>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Ticket Cost (£)</label>
                          <input type="number" value={formData.travelCost || ''} onChange={(e) => updateField('travelCost', parseFloat(e.target.value) || 0)} placeholder="Train/bus fare" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                          {/* Venue field indicators for ticket cost */}
                          {formData.selectedVenueId && formData.originalVenueTicketCost !== null && formData.travelCost === formData.originalVenueTicketCost && formData.travelCost > 0 && (
                            <p className="text-xs text-green-600 mt-1">✓ From venue database</p>
                          )}
                          {formData.selectedVenueId && formData.originalVenueTicketCost === null && formData.travelCost > 0 && (
                            <p className="text-xs text-blue-600 mt-1">➕ Will be saved to venue</p>
                          )}
                          {formData.selectedVenueId && formData.originalVenueTicketCost !== null && formData.travelCost !== formData.originalVenueTicketCost && (
                            <p className="text-xs text-orange-600 mt-1">⚠️ Changed from £{formData.originalVenueTicketCost} — venue will be updated</p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================================================= */}
          {/* STEP 3: WORK (Crewed only)                                     */}
          {/* ============================================================= */}
          {step === 3 && isCrewedJob && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Work Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Work Type</label>
                  <select value={formData.workType} onChange={(e) => updateField('workType', e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                    <option value="">Select...</option>
                    {WORK_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                {formData.workType === 'other' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Describe the work</label>
                    <input type="text" value={formData.workTypeOther} onChange={(e) => updateField('workTypeOther', e.target.value)} placeholder="What are they doing?" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  </div>
                )}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Additional Notes</label>
                  <textarea value={formData.workDescription} onChange={(e) => updateField('workDescription', e.target.value)} placeholder="Any specific details..." rows={2} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Rate Calculation</h3>
                {formData.isMultiDay && formData.calculationMode === 'hourly' && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">⚠️ Hourly rate is unusual for multi-day jobs. Consider using Day Rate instead.</div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Calculation Mode</label>
                    <select value={formData.calculationMode} onChange={(e) => updateField('calculationMode', e.target.value as FormData['calculationMode'])} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                      <option value="day_rate">Day rate</option>
                      <option value="hourly">Hourly rate</option>
                    </select>
                  </div>
                  {formData.calculationMode === 'hourly' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Work Duration (hours)</label>
                        <input type="number" value={formData.workDurationHours || ''} onChange={(e) => updateField('workDurationHours', parseFloat(e.target.value) || 0)} placeholder="Time on site" min="0" step="0.5" className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                      </div>
                      <div>
                        <label className="flex items-center space-x-2 mt-6">
                          <input type="checkbox" checked={formData.applyMinHours} onChange={(e) => updateField('applyMinHours', e.target.checked)} className="w-4 h-4 text-blue-600 rounded" />
                          <span className="text-sm font-medium text-gray-700">Apply min hours ({settings?.minHoursThreshold || 5}hr)</span>
                        </label>
                      </div>
                    </>
                  )}
                  {formData.calculationMode === 'day_rate' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Number of Days {formData.isMultiDay && <span className="text-gray-400 font-normal">(from dates)</span>}</label>
                        <input type="number" value={formData.numberOfDays || ''} onChange={(e) => updateField('numberOfDays', parseInt(e.target.value) || 1)} min={1} className={`w-full px-4 py-2 border border-gray-300 rounded-lg ${formData.isMultiDay ? 'bg-gray-50' : ''}`} />
                        {formData.isMultiDay && formData.numberOfDays !== calculatedDays && <p className="text-xs text-amber-600 mt-1">⚠️ Dates suggest {calculatedDays} days</p>}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Day Rate (£) <span className="text-gray-400 font-normal">{settings && `Default: £${settings.driverDayRate}`}</span></label>
                        <input type="number" value={formData.dayRateOverride ?? settings?.driverDayRate ?? ''} onChange={(e) => updateField('dayRateOverride', e.target.value ? parseFloat(e.target.value) : null)} placeholder={settings ? `${settings.driverDayRate}` : '180'} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                        <p className="text-xs text-gray-500 mt-1">Override for this quote only</p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* OOH auto-calculated display (crewed jobs, hourly mode only) */}
              {formData.calculationMode === 'hourly' && costs && settings && (
                <OOHDisplay
                  costs={costs}
                  formData={formData}
                  settings={settings}
                  onToggleOverride={() => updateField('oohManualOverride', !formData.oohManualOverride)}
                  onChangeEarly={(v) => updateField('earlyStartMinutes', v)}
                  onChangeLate={(v) => updateField('lateFinishMinutes', v)}
                />
              )}
            </div>
          )}

          {/* ============================================================= */}
          {/* STEP 3/4: EXPENSES                                             */}
          {/* ============================================================= */}
          {((step === 3 && !isCrewedJob) || (step === 4 && isCrewedJob)) && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Expenses</h2>
              <p className="text-sm text-gray-500">Check the box to include in the quote. Unchecked items will be listed as &quot;client pays separately&quot;.</p>

              {!isCrewedJob && (
                <div className="p-4 bg-gray-50 rounded-lg">
                  <label className="flex items-center space-x-2">
                    <input type="checkbox" checked={formData.applyMinHours} onChange={(e) => updateField('applyMinHours', e.target.checked)} className="w-4 h-4 text-blue-600 rounded" />
                    <span className="text-sm font-medium text-gray-700">Apply minimum hours ({settings?.minHoursThreshold || 5}hr call)</span>
                  </label>
                </div>
              )}

              {/* OOH auto-calculated display for D&C jobs */}
              {isDC && costs && settings && (
                <OOHDisplay
                  costs={costs}
                  formData={formData}
                  settings={settings}
                  onToggleOverride={() => updateField('oohManualOverride', !formData.oohManualOverride)}
                  onChangeEarly={(v) => updateField('earlyStartMinutes', v)}
                  onChangeLate={(v) => updateField('lateFinishMinutes', v)}
                />
              )}

              <div className="border rounded-lg divide-y">
                <div className="px-4 py-3 bg-gray-50 flex items-center gap-3">
                  <div className="w-4"></div>
                  <div className="flex-1 text-sm font-medium text-gray-700">Category</div>
                  <div className="w-28 text-sm font-medium text-gray-700 text-right">Amount</div>
                  <div className="w-24"></div>
                </div>
                <div className="px-4">
                  {formData.expenses.map((expense) => (
                    <ExpenseRow key={expense.id} expense={expense} fuelCost={costs?.expectedFuelCost} numberOfDays={formData.numberOfDays}
                      onChange={updateExpense} onRemove={expense.category === 'other' ? () => removeExpense(expense.id) : undefined} />
                  ))}
                </div>
                <div className="px-4 py-3">
                  <button type="button" onClick={addOtherExpense} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
                    <span>➕</span> Add other expense
                  </button>
                </div>
              </div>

              {costs && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-green-50 rounded-lg">
                    <p className="text-sm text-green-700 font-medium">Included in Quote</p>
                    <p className="text-xl font-bold text-green-800">£{(costs.expensesIncluded + (formData.expenses.find(e => e.category === 'fuel')?.included ? costs.expectedFuelCost : 0)).toFixed(2)}</p>
                  </div>
                  <div className="p-4 bg-gray-100 rounded-lg">
                    <p className="text-sm text-gray-600 font-medium">Client Pays Separately</p>
                    <p className="text-xl font-bold text-gray-700">£{(costs.expensesNotIncluded + (!formData.expenses.find(e => e.category === 'fuel')?.included ? costs.expectedFuelCost : 0)).toFixed(2)}</p>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Expense Notes</label>
                <textarea value={formData.expenseNotes} onChange={(e) => updateField('expenseNotes', e.target.value)} placeholder="Any special arrangements..." rows={2} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
              </div>
            </div>
          )}

          {/* ============================================================= */}
          {/* FINAL STEP: REVIEW                                             */}
          {/* ============================================================= */}
          {step === totalSteps && costs && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Review & Save</h2>

              <div className={`text-sm px-4 py-3 rounded-lg flex items-center gap-2 ${isCrewedJob ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}>
                <span className="text-lg">{isCrewedJob ? '👷' : '📦'}</span>
                <span>{isCrewedJob ? 'Will save to Crewed Jobs board' : `Will save to D&C board${formData.addCollection ? ' (2 items)' : ''}`}</span>
              </div>

{/* HireHop Integration Checkboxes */}
              {formData.hirehopJobNumber && (
                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <p className="text-sm font-medium text-gray-700">Add to HireHop Quote</p>
                  {isDC && (
                    <>
                      <label className="flex items-center space-x-3">
                        <input
                          type="checkbox"
                          checked={formData.addDeliveryToHireHop}
                          onChange={(e) => updateField('addDeliveryToHireHop', e.target.checked)}
                          className="w-4 h-4 text-blue-600 rounded"
                        />
                        <span className="text-sm text-gray-700">
                          Add {formData.jobType === 'collection' ? 'collection' : 'delivery'} to HireHop (£{costs.clientChargeTotalRounded})
                        </span>
                      </label>
                      {formData.addCollection && (
                        <label className="flex items-center space-x-3">
                          <input
                            type="checkbox"
                            checked={formData.addCollectionToHireHop}
                            onChange={(e) => updateField('addCollectionToHireHop', e.target.checked)}
                            className="w-4 h-4 text-blue-600 rounded"
                          />
                          <span className="text-sm text-gray-700">
                            Add collection to HireHop (£{costs.clientChargeTotalRounded})
                          </span>
                        </label>
                      )}
                    </>
                  )}
                  {isCrewedJob && (
                    <label className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        checked={formData.addCrewToHireHop}
                        onChange={(e) => updateField('addCrewToHireHop', e.target.checked)}
                        className="w-4 h-4 text-blue-600 rounded"
                      />
                      <span className="text-sm text-gray-700">
                        Add crew item to HireHop (£{costs.clientChargeTotalRounded})
                      </span>
                    </label>
                  )}
                  <p className="text-xs text-gray-500">Labour items will be added to job #{formData.hirehopJobNumber}</p>
                </div>
              )}

              {settings && settings.minClientCharge > 0 && costs.clientChargeTotal < settings.minClientCharge && (
                <div className="text-sm px-4 py-3 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
                  ⬆️ Client charge bumped to minimum £{settings.minClientCharge} (calculated: £{Math.round(costs.clientChargeTotal)})
                </div>
              )}

              {/* OOH summary on review */}
              {(costs.autoEarlyStartMinutes > 0 || costs.autoLateFinishMinutes > 0) && (
                <div className="text-sm px-4 py-3 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
                  ⏰ Out of hours: {costs.autoEarlyStartMinutes > 0 && `${formatDurationHM(costs.autoEarlyStartMinutes)} early start`}{costs.autoEarlyStartMinutes > 0 && costs.autoLateFinishMinutes > 0 && ' + '}{costs.autoLateFinishMinutes > 0 && `${formatDurationHM(costs.autoLateFinishMinutes)} late finish`}
                </div>
              )}

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
                  <p className="mt-2 text-xs text-blue-600">Est. time: {costs.estimatedTimeHours.toFixed(1)} hours</p>
                </div>
                <div className="bg-purple-50 rounded-xl p-4">
                  <p className="text-sm text-purple-600 font-medium">Our Margin</p>
                  <p className="text-2xl font-bold text-purple-700">£{costs.ourMargin.toFixed(2)}</p>
                  <p className="mt-2 text-xs text-purple-600">Total cost: £{costs.ourTotalCost.toFixed(2)}</p>
                </div>
              </div>

              {/* Delivery + Collection dual breakdown */}
              {formData.addCollection && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-blue-200 rounded-xl p-4 bg-blue-50/50">
                    <p className="text-sm font-medium text-blue-700 mb-1">📦 Delivery</p>
                    <p className="text-xs text-blue-600">{formatDateUK(formData.jobDate)}{formData.arrivalTime && ` @ ${formatTime12h(formData.arrivalTime)}`}</p>
                    <div className="mt-2 text-sm">
                      <p>Client: <span className="font-medium">£{costs.clientChargeTotalRounded}</span></p>
                      <p>Freelancer: <span className="font-medium">£{costs.freelancerFeeRounded}</span></p>
                    </div>
                  </div>
                  <div className="border border-orange-200 rounded-xl p-4 bg-orange-50/50">
                    <p className="text-sm font-medium text-orange-700 mb-1">📥 Collection</p>
                    <p className="text-xs text-orange-600">{formatDateUK(formData.collectionDate)}{formData.collectionArrivalTime && ` @ ${formatTime12h(formData.collectionArrivalTime)}`}</p>
                    <div className="mt-2 text-sm">
                      <p>Client: <span className="font-medium">£{costs.clientChargeTotalRounded}</span></p>
                      <p>Freelancer: <span className="font-medium">£{costs.freelancerFeeRounded}</span></p>
                    </div>
                  </div>
                  <div className="md:col-span-2 bg-gray-100 rounded-lg p-3 text-sm text-center">
                    <span className="font-medium">Combined totals:</span> Client £{costs.clientChargeTotalRounded * 2} · Freelancer £{costs.freelancerFeeRounded * 2} · Margin £{(costs.ourMargin * 2).toFixed(2)}
                  </div>
                </div>
              )}

              <div className="border rounded-lg divide-y">
                <div className="px-4 py-3 bg-gray-50"><h3 className="font-medium text-gray-900">Job Summary</h3></div>
                <div className="px-4 py-3 grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Type:</span> <span className="ml-2 text-gray-900 capitalize">{formData.jobType.replace('_', ' ')}{isDC && formData.whatIsIt && ` (${formData.whatIsIt})`}{formData.includesSetupWork && (formData.jobType === 'delivery' ? ' + setup' : ' + pack-down')}</span></div>
                  <div><span className="text-gray-500">HireHop #:</span> <span className="ml-2 text-gray-900">{formData.hirehopJobNumber || 'Not set'}</span></div>
                  {formData.clientName && <div><span className="text-gray-500">Client:</span> <span className="ml-2 text-gray-900">{formData.clientName}</span></div>}
                  {formData.destination && <div><span className="text-gray-500">Destination:</span> <span className="ml-2 text-gray-900">{formData.destination}</span></div>}
                  <div><span className="text-gray-500">{formData.addCollection ? 'Delivery:' : 'Date:'}</span> <span className="ml-2 text-gray-900">{formatDateUK(formData.jobDate)}{formData.arrivalTime && ` @ ${formatTime12h(formData.arrivalTime)}`}</span></div>
                  {formData.addCollection && formData.collectionDate && (
                    <div><span className="text-gray-500">Collection:</span> <span className="ml-2 text-gray-900">{formatDateUK(formData.collectionDate)}{formData.collectionArrivalTime && ` @ ${formatTime12h(formData.collectionArrivalTime)}`}</span></div>
                  )}
                  {isCrewedJob && formData.isMultiDay && formData.jobFinishDate && (
                    <div><span className="text-gray-500">Finish:</span> <span className="ml-2 text-gray-900">{formatDateUK(formData.jobFinishDate)} ({formData.numberOfDays} days)</span></div>
                  )}
                  {formData.includesSetupWork && formData.setupWorkDescription && (
                    <div className="col-span-2"><span className="text-gray-500">Setup:</span> <span className="ml-2 text-gray-900">{formData.setupWorkDescription}</span></div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Costing Notes (internal)</label>
                <textarea value={formData.costingNotes} onChange={(e) => updateField('costingNotes', e.target.value)} placeholder="Any notes about this quote..." rows={3} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-8 pt-6 border-t">
            {step > 1 ? <button onClick={() => setStep(step - 1)} disabled={!!success} className="px-6 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50">← Back</button> : <div />}
            {step < totalSteps ? (
              <button onClick={() => setStep(step + 1)} disabled={(step === 1 && !isStep1Valid) || (step === 2 && !isStep2Valid) || (step === 3 && isCrewedJob && !isStep3Valid)}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">Continue →</button>
            ) : (
              <button onClick={handleSave} disabled={saving || !!success} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                {saving ? 'Saving...' : success ? 'Saved ✓' : 'Save to Monday.com'}
              </button>
            )}
          </div>
        </div>

        {/* Live preview floating panel - hidden on mobile to avoid overlapping Continue button */}
        {costs && step > 1 && step < totalSteps && (
          <div className="hidden md:block fixed bottom-4 right-4 bg-white rounded-xl shadow-lg border p-4 max-w-xs">
            <p className="text-sm text-gray-500 mb-2">Live Preview</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-gray-500">Client:</span> <span className="ml-1 font-medium">£{costs.clientChargeTotalRounded}</span></div>
              <div><span className="text-gray-500">Freelancer:</span> <span className="ml-1 font-medium">£{costs.freelancerFeeRounded}</span></div>
            </div>
            {formData.addCollection && <p className="text-xs text-blue-600 mt-1">× 2 (delivery + collection)</p>}
          </div>
        )}
      </div>
    </div>
  )
}

export default function CrewTransportPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="text-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div><p className="mt-4 text-gray-600">Loading...</p></div></div>}>
      <CrewTransportWizard />
    </Suspense>
  )
}