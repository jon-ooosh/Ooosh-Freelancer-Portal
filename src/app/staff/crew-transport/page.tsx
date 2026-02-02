'use client'

import { useState, useEffect, useCallback } from 'react'
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

interface FormData {
  // Core info
  hirehopJobNumber: string
  jobType: 'delivery' | 'collection' | 'crewed_job' | ''
  
  // Transport details
  transportMode: 'one_way' | 'there_and_back' | 'na' | ''
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  returnMethod: 'same_vehicle' | 'public_transport' | 'stays_overnight' | 'na' | ''
  returnTravelTimeMins: number
  returnTravelCost: number
  
  // Work details (for crewed jobs)
  workType: 'backline_tech' | 'general_assist' | 'load_in_out' | 'driving_only' | 'other' | ''
  workDurationHours: number
  workDescription: string
  
  // Scheduling
  jobDate: string
  calculationMode: 'hourly' | 'day_rate'
  numberOfDays: number
  earlyStartMinutes: number
  lateFinishMinutes: number
  
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
  
  // Add collection option
  addCollection: boolean
  collectionDate: string
}

interface CalculatedCosts {
  // What we charge client
  clientChargeLabour: number
  clientChargeFuel: number
  clientChargeExpenses: number
  clientChargeTotal: number
  
  // What we pay
  freelancerFee: number
  expectedFuelCost: number
  expectedOtherExpenses: number
  ourTotalCost: number
  
  // Margin
  ourMargin: number
  
  // Breakdown for display
  estimatedTimeMinutes: number
  estimatedTimeHours: number
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialFormData: FormData = {
  hirehopJobNumber: '',
  jobType: '',
  transportMode: '',
  destination: '',
  distanceMiles: 0,
  driveTimeMinutes: 0,
  returnMethod: '',
  returnTravelTimeMins: 0,
  returnTravelCost: 0,
  workType: '',
  workDurationHours: 0,
  workDescription: '',
  jobDate: new Date().toISOString().split('T')[0],
  calculationMode: 'hourly',
  numberOfDays: 1,
  earlyStartMinutes: 0,
  lateFinishMinutes: 0,
  tollsParking: 0,
  additionalCosts: 0,
  expenseArrangement: '',
  pdArrangement: 'no_pd',
  pdAmount: 0,
  expenseNotes: '',
  costingNotes: '',
  addCollection: false,
  collectionDate: '',
}

// =============================================================================
// CALCULATION FUNCTIONS
// =============================================================================

function calculateCosts(formData: FormData, settings: CostingSettings): CalculatedCosts {
  const {
    jobType,
    transportMode,
    distanceMiles,
    driveTimeMinutes,
    returnMethod,
    returnTravelTimeMins,
    returnTravelCost,
    workDurationHours,
    calculationMode,
    numberOfDays,
    earlyStartMinutes,
    lateFinishMinutes,
    tollsParking,
    additionalCosts,
    addCollection,
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

  // Markup multiplier
  const markupMultiplier = 1 + (expenseMarkupPercent / 100)

  // =========================================================================
  // DAY RATE MODE
  // =========================================================================
  if (calculationMode === 'day_rate') {
    // Fuel: (mileage × fuel price) / 5 (rough MPG conversion)
    const fuelCost = (distanceMiles * fuelPricePerLitre) / 5
    
    // Labour
    const freelancerFee = driverDayRate * numberOfDays
    const clientChargeLabour = freelancerFee * markupMultiplier
    
    // Expenses
    const totalExpenses = tollsParking + additionalCosts + returnTravelCost
    const clientChargeExpenses = totalExpenses * markupMultiplier
    
    // Fuel (client gets marked up)
    const clientChargeFuel = fuelCost * markupMultiplier
    
    const clientChargeTotal = clientChargeLabour + clientChargeFuel + clientChargeExpenses
    const ourTotalCost = freelancerFee + fuelCost + totalExpenses
    
    return {
      clientChargeLabour: Math.round(clientChargeLabour * 100) / 100,
      clientChargeFuel: Math.round(clientChargeFuel * 100) / 100,
      clientChargeExpenses: Math.round(clientChargeExpenses * 100) / 100,
      clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
      freelancerFee: Math.round(freelancerFee * 100) / 100,
      expectedFuelCost: Math.round(fuelCost * 100) / 100,
      expectedOtherExpenses: Math.round(totalExpenses * 100) / 100,
      ourTotalCost: Math.round(ourTotalCost * 100) / 100,
      ourMargin: Math.round((clientChargeTotal - ourTotalCost) * 100) / 100,
      estimatedTimeMinutes: numberOfDays * 8 * 60, // Assume 8hr days
      estimatedTimeHours: numberOfDays * 8,
    }
  }

  // =========================================================================
  // HOURLY MODE
  // =========================================================================
  
  // Calculate total drive time based on transport mode
  let totalDriveMinutes = 0
  let handoverOrUnload = 0
  
  if (transportMode === 'there_and_back' || addCollection) {
    // Round trip: drive time × 2 + unload time
    totalDriveMinutes = driveTimeMinutes * 2
    handoverOrUnload = unloadTimeMinutes
  } else if (transportMode === 'one_way') {
    // One way: drive time + return travel time (if public transport) + handover time
    totalDriveMinutes = driveTimeMinutes + (returnMethod === 'public_transport' ? returnTravelTimeMins : 0)
    handoverOrUnload = handoverTimeMinutes
  }
  
  // Add work duration for crewed jobs
  const workMinutes = jobType === 'crewed_job' ? workDurationHours * 60 : 0
  
  // Total time on job
  const totalMinutes = totalDriveMinutes + handoverOrUnload + workMinutes
  const totalHours = totalMinutes / 60
  
  // Out of hours calculations
  const normalMinutes = totalMinutes - earlyStartMinutes - lateFinishMinutes
  const outOfHoursMinutes = earlyStartMinutes + lateFinishMinutes
  
  // Freelancer pay calculation
  const normalHours = Math.max(0, normalMinutes) / 60
  const outOfHoursHrs = outOfHoursMinutes / 60
  
  let freelancerLabourPay = (normalHours * hourlyRateFreelancerDay) + (outOfHoursHrs * hourlyRateFreelancerNight)
  
  // Apply minimum hours threshold
  const minPay = minHoursThreshold * hourlyRateFreelancerDay
  if (freelancerLabourPay < minPay && totalHours > 0) {
    freelancerLabourPay = minPay
  }
  
  // Client charge for labour
  let clientLabourCharge = (normalHours * hourlyRateClientDay) + (outOfHoursHrs * hourlyRateClientNight)
  const minClientCharge = minHoursThreshold * hourlyRateClientDay
  if (clientLabourCharge < minClientCharge && totalHours > 0) {
    clientLabourCharge = minClientCharge
  }
  
  // Add admin cost
  clientLabourCharge += totalHours * adminCostPerHour
  
  // Fuel calculation
  // For there-and-back: miles × 2, for one-way: miles × 1 (or × 2 if collection added)
  const totalMiles = (transportMode === 'there_and_back' || addCollection) 
    ? distanceMiles * 2 
    : distanceMiles
  const fuelCost = (totalMiles * fuelPricePerLitre) / 5
  const clientFuelCharge = fuelCost // Fuel not marked up in hourly mode (per Jotform logic)
  
  // Other expenses
  const otherExpenses = tollsParking + additionalCosts + returnTravelCost
  const clientExpenseCharge = otherExpenses * markupMultiplier
  
  // Totals
  const clientChargeTotal = clientLabourCharge + clientFuelCharge + clientExpenseCharge
  const ourTotalCost = freelancerLabourPay + fuelCost + otherExpenses
  
  return {
    clientChargeLabour: Math.round(clientLabourCharge * 100) / 100,
    clientChargeFuel: Math.round(clientFuelCharge * 100) / 100,
    clientChargeExpenses: Math.round(clientExpenseCharge * 100) / 100,
    clientChargeTotal: Math.round(clientChargeTotal * 100) / 100,
    freelancerFee: Math.round(freelancerLabourPay * 100) / 100,
    expectedFuelCost: Math.round(fuelCost * 100) / 100,
    expectedOtherExpenses: Math.round(otherExpenses * 100) / 100,
    ourTotalCost: Math.round(ourTotalCost * 100) / 100,
    ourMargin: Math.round((clientChargeTotal - ourTotalCost) * 100) / 100,
    estimatedTimeMinutes: totalMinutes,
    estimatedTimeHours: Math.round(totalHours * 100) / 100,
  }
}

// =============================================================================
// WIZARD COMPONENT
// =============================================================================

function CrewTransportWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [settings, setSettings] = useState<CostingSettings | null>(null)
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [step, setStep] = useState(1)

  // Get job number from URL
  const jobNumber = searchParams.get('job') || ''

  // Check auth and load settings
  useEffect(() => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin) {
      router.push('/staff')
      return
    }

    // Load settings
    async function loadSettings() {
      try {
        const response = await fetch('/api/staff/settings', {
          headers: { 'x-staff-pin': pin! }
        })
        const data = await response.json()
        
        if (!response.ok) {
          if (response.status === 401) {
            sessionStorage.removeItem('staffPin')
            router.push('/staff')
            return
          }
          throw new Error(data.error || 'Failed to load settings')
        }
        
        setSettings(data.settings)
        
        // Pre-fill job number from URL
        if (jobNumber) {
          setFormData(prev => ({ ...prev, hirehopJobNumber: jobNumber }))
        }
      } catch (err) {
        console.error('Failed to load settings:', err)
        setError('Failed to load costing settings')
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
  }, [router, jobNumber])

  // Calculate costs whenever form data changes
  const costs = settings ? calculateCosts(formData, settings) : null

  // Update form field
  const updateField = useCallback(<K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }, [])

  // Handle save
  const handleSave = async () => {
    const pin = sessionStorage.getItem('staffPin')
    if (!pin || !costs) return

    setSaving(true)
    setError(null)

    try {
      const response = await fetch('/api/staff/crew-transport', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-pin': pin,
        },
        body: JSON.stringify({
          formData,
          costs,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save')
      }

      setSuccess(`Saved successfully! Item ID: ${data.itemId}`)
      
      // Optionally redirect or reset form
      // router.push('/staff/crew-transport/success')
    } catch (err) {
      console.error('Save error:', err)
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // Loading state
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

  // Calculate step validity
  const isStep1Valid = formData.jobType !== ''
  const isStep2Valid = formData.jobType === 'crewed_job' 
    ? true // Crewed jobs don't require transport 
    : formData.transportMode !== '' && formData.destination !== '' && formData.distanceMiles > 0
  const isStep3Valid = formData.jobType !== 'crewed_job' || formData.workType !== ''

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
          {formData.hirehopJobNumber && (
            <span className="text-sm text-gray-500">Job #{formData.hirehopJobNumber}</span>
          )}
        </div>
      </header>

      {/* Progress Steps */}
      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-8">
          {['Job Type', 'Transport', 'Work', 'Expenses', 'Review'].map((label, idx) => (
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
              <span className={`ml-2 text-sm ${step === idx + 1 ? 'text-blue-600 font-medium' : 'text-gray-500'}`}>
                {label}
              </span>
              {idx < 4 && <div className="w-8 h-0.5 bg-gray-200 mx-2" />}
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 pb-8">
        <div className="bg-white rounded-xl shadow-sm p-6">
          
          {/* Error/Success Messages */}
          {error && (
            <div className="mb-6 bg-red-50 text-red-600 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-6 bg-green-50 text-green-600 px-4 py-3 rounded-lg">
              {success}
            </div>
          )}

          {/* Step 1: Job Type */}
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">What type of job is this?</h2>
              
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700">
                  HireHop Job Number
                </label>
                <input
                  type="text"
                  value={formData.hirehopJobNumber}
                  onChange={(e) => updateField('hirehopJobNumber', e.target.value)}
                  placeholder="e.g. 15276"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { value: 'delivery', label: 'Delivery', icon: '📦', desc: 'Equipment going out' },
                  { value: 'collection', label: 'Collection', icon: '📥', desc: 'Equipment coming back' },
                  { value: 'crewed_job', label: 'Crewed Job', icon: '👷', desc: 'Transport + work on site' },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => updateField('jobType', option.value as FormData['jobType'])}
                    className={`p-6 rounded-xl border-2 text-left transition-all ${
                      formData.jobType === option.value
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-3xl">{option.icon}</span>
                    <h3 className="mt-2 font-semibold text-gray-900">{option.label}</h3>
                    <p className="text-sm text-gray-500">{option.desc}</p>
                  </button>
                ))}
              </div>

              {/* Add collection option for deliveries */}
              {formData.jobType === 'delivery' && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                  <label className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      checked={formData.addCollection}
                      onChange={(e) => updateField('addCollection', e.target.checked)}
                      className="w-5 h-5 text-blue-600 rounded"
                    />
                    <span className="text-gray-700">Add collection from same location?</span>
                  </label>
                  {formData.addCollection && (
                    <div className="mt-3">
                      <label className="block text-sm text-gray-600 mb-1">Collection Date</label>
                      <input
                        type="date"
                        value={formData.collectionDate}
                        onChange={(e) => updateField('collectionDate', e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Transport Details */}
          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Transport Details</h2>

              {formData.jobType === 'crewed_job' && (
                <div className="p-4 bg-yellow-50 rounded-lg text-yellow-800 text-sm">
                  For crewed jobs, transport is optional. Skip if they&apos;re making their own way.
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Transport Mode
                  </label>
                  <select
                    value={formData.transportMode}
                    onChange={(e) => updateField('transportMode', e.target.value as FormData['transportMode'])}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="">Select...</option>
                    <option value="one_way">One-way (drop or collect)</option>
                    <option value="there_and_back">There and back</option>
                    {formData.jobType === 'crewed_job' && <option value="na">N/A - No transport needed</option>}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Destination
                  </label>
                  <input
                    type="text"
                    value={formData.destination}
                    onChange={(e) => updateField('destination', e.target.value)}
                    placeholder="Venue or address"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
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
                </div>
              </div>

              {/* Return method (only for one-way) */}
              {formData.transportMode === 'one_way' && (
                <div className="border-t pt-6 mt-6">
                  <h3 className="font-medium text-gray-900 mb-4">Return Journey</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Return Method
                      </label>
                      <select
                        value={formData.returnMethod}
                        onChange={(e) => updateField('returnMethod', e.target.value as FormData['returnMethod'])}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select...</option>
                        <option value="public_transport">Public transport (train/bus)</option>
                        <option value="same_vehicle">Same vehicle (collection)</option>
                        <option value="stays_overnight">Stays with vehicle</option>
                      </select>
                    </div>

                    {formData.returnMethod === 'public_transport' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Return Travel Time (mins)
                          </label>
                          <input
                            type="number"
                            value={formData.returnTravelTimeMins || ''}
                            onChange={(e) => updateField('returnTravelTimeMins', parseFloat(e.target.value) || 0)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Return Travel Cost (£)
                          </label>
                          <input
                            type="number"
                            value={formData.returnTravelCost || ''}
                            onChange={(e) => updateField('returnTravelCost', parseFloat(e.target.value) || 0)}
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

          {/* Step 3: Work Details (primarily for crewed jobs) */}
          {step === 3 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {formData.jobType === 'crewed_job' ? 'Work Details' : 'Scheduling & Timing'}
              </h2>

              {formData.jobType === 'crewed_job' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Work Type
                    </label>
                    <select
                      value={formData.workType}
                      onChange={(e) => updateField('workType', e.target.value as FormData['workType'])}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="">Select...</option>
                      <option value="backline_tech">Backline Tech</option>
                      <option value="general_assist">General Assist</option>
                      <option value="load_in_out">Load-in/Load-out</option>
                      <option value="driving_only">Driving Only</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

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
                      Work Description
                    </label>
                    <textarea
                      value={formData.workDescription}
                      onChange={(e) => updateField('workDescription', e.target.value)}
                      placeholder="What will they be doing?"
                      rows={3}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                </div>
              )}

              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Scheduling</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Job Date
                    </label>
                    <input
                      type="date"
                      value={formData.jobDate}
                      onChange={(e) => updateField('jobDate', e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>

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
                  )}
                </div>
              </div>

              {/* Out of hours */}
              <div className="border-t pt-6">
                <h3 className="font-medium text-gray-900 mb-4">Out of Hours (optional)</h3>
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

          {/* Step 4: Expenses & Arrangements */}
          {step === 4 && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Expenses & Arrangements</h2>

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

          {/* Step 5: Review */}
          {step === 5 && costs && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Review & Save</h2>

              {/* Cost Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-sm text-green-600 font-medium">Client Charge</p>
                  <p className="text-2xl font-bold text-green-700">£{costs.clientChargeTotal.toFixed(2)}</p>
                  <div className="mt-2 text-xs text-green-600 space-y-1">
                    <p>Labour: £{costs.clientChargeLabour.toFixed(2)}</p>
                    <p>Fuel: £{costs.clientChargeFuel.toFixed(2)}</p>
                    <p>Expenses: £{costs.clientChargeExpenses.toFixed(2)}</p>
                  </div>
                </div>

                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-sm text-blue-600 font-medium">Freelancer Fee</p>
                  <p className="text-2xl font-bold text-blue-700">£{costs.freelancerFee.toFixed(2)}</p>
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

              {/* Job Summary */}
              <div className="border rounded-lg divide-y">
                <div className="px-4 py-3 bg-gray-50">
                  <h3 className="font-medium text-gray-900">Job Summary</h3>
                </div>
                <div className="px-4 py-3 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Job Type:</span>
                    <span className="ml-2 text-gray-900 capitalize">{formData.jobType.replace('_', ' ')}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">HireHop #:</span>
                    <span className="ml-2 text-gray-900">{formData.hirehopJobNumber || 'Not set'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Destination:</span>
                    <span className="ml-2 text-gray-900">{formData.destination || 'Not set'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Date:</span>
                    <span className="ml-2 text-gray-900">{formData.jobDate}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Calculation:</span>
                    <span className="ml-2 text-gray-900 capitalize">{formData.calculationMode.replace('_', ' ')}</span>
                  </div>
                  {formData.addCollection && (
                    <div className="col-span-2">
                      <span className="text-gray-500">+ Collection:</span>
                      <span className="ml-2 text-gray-900">{formData.collectionDate}</span>
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
                className="px-6 py-2 text-gray-600 hover:text-gray-800"
              >
                ← Back
              </button>
            ) : (
              <div />
            )}

            {step < 5 ? (
              <button
                onClick={() => setStep(step + 1)}
                disabled={
                  (step === 1 && !isStep1Valid) ||
                  (step === 2 && !isStep2Valid) ||
                  (step === 3 && !isStep3Valid)
                }
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save to Monday.com'}
              </button>
            )}
          </div>
        </div>

        {/* Live Cost Preview (floating) */}
        {costs && step > 1 && step < 5 && (
          <div className="fixed bottom-4 right-4 bg-white rounded-xl shadow-lg border p-4 max-w-xs">
            <p className="text-sm text-gray-500 mb-2">Live Preview</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Client:</span>
                <span className="ml-1 font-medium">£{costs.clientChargeTotal.toFixed(0)}</span>
              </div>
              <div>
                <span className="text-gray-500">Freelancer:</span>
                <span className="ml-1 font-medium">£{costs.freelancerFee.toFixed(0)}</span>
              </div>
            </div>
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