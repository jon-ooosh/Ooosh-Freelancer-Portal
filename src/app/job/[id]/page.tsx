'use client'

/**
 * Job Details Page
 * 
 * Displays full details for a single job including venue information.
 * Route: /job/[id]
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

// =============================================================================
// TYPES
// =============================================================================

interface Job {
  id: string
  name: string
  type: 'delivery' | 'collection'
  whatIsIt?: 'equipment' | 'vehicle'  // Equipment or A vehicle
  date?: string
  time?: string
  venueName?: string
  venueId?: string
  status: string
  hhRef?: string
  keyNotes?: string
  runGroup?: string
  driverPay?: number
  completedAtDate?: string
  completionNotes?: string
}

interface Venue {
  id: string
  name: string
  address?: string
  whatThreeWords?: string
  contact1?: string
  contact2?: string
  phone?: string | null
  phone2?: string | null
  phoneHidden?: boolean
  phoneVisibleFrom?: string | null
  email?: string
  accessNotes?: string
  stageNotes?: string
}

interface JobApiResponse {
  success: boolean
  job?: Job
  venue?: Venue | null
  contactsVisible?: boolean
  error?: string
}

interface EquipmentItem {
  id: string
  name: string
  quantity: number
  category?: string
  categoryId?: number
  isVirtual?: boolean
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDate(dateStr?: string): string {
  if (!dateStr) return 'TBC'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

function formatTime(timeStr?: string): string {
  if (!timeStr) return 'TBC'
  return timeStr
}

function getGoogleMapsUrl(address?: string): string | null {
  if (!address) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}

function getWhat3WordsUrl(w3w?: string): string | null {
  if (!w3w) return null
  const words = w3w.replace(/^\/+/, '').trim()
  if (!words) return null
  return `https://what3words.com/${words}`
}

/**
 * Translate Monday.com status to user-friendly display
 */
function translateStatus(status: string): { label: string; style: string; icon: string } {
  const normalised = status.toLowerCase().trim()
  
  // Confirmed / Arranged
  if (normalised.includes('arranged')) {
    return { label: 'Confirmed', style: 'bg-green-100 text-green-800', icon: '✓' }
  }
  
  // In Progress / Working on it
  if (normalised.includes('working on it')) {
    return { label: 'In Progress', style: 'bg-blue-100 text-blue-800', icon: '🔄' }
  }
  
  // Completed / All done
  if (normalised.includes('done') || normalised.includes('completed')) {
    return { label: 'Completed', style: 'bg-gray-100 text-gray-600', icon: '✓' }
  }
  
  // Cancelled / Not needed
  if (normalised.includes('not needed') || normalised.includes('cancelled')) {
    return { label: 'Cancelled', style: 'bg-red-100 text-red-800', icon: '✗' }
  }
  
  // Default - show raw status
  return { label: status, style: 'bg-gray-100 text-gray-800', icon: '•' }
}

/**
 * Get the filter mode for HireHop items based on job's whatIsIt value
 */
function getFilterMode(whatIsIt?: 'equipment' | 'vehicle'): 'equipment' | 'vehicles' | 'all' {
  switch (whatIsIt) {
    case 'equipment':
      return 'equipment'  // Exclude vehicles and services
    case 'vehicle':
      return 'all'        // Show everything for vehicle deliveries
    default:
      return 'all'        // Unknown - show everything to be safe
  }
}

// =============================================================================
// SIMPLE EQUIPMENT LIST COMPONENT (Read-only, no tickboxes)
// =============================================================================

interface EquipmentListProps {
  hhRef: string
  whatIsIt?: 'equipment' | 'vehicle'
}

function EquipmentList({ hhRef, whatIsIt }: EquipmentListProps) {
  const [items, setItems] = useState<EquipmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    async function fetchItems() {
      try {
        // Determine filter based on job type
        const filterMode = getFilterMode(whatIsIt)
        const response = await fetch(`/api/hirehop/items/${hhRef}?filter=${filterMode}`)
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch equipment list')
        }

        setItems(data.items || [])
      } catch (err) {
        console.error('Error fetching equipment:', err)
        setError(err instanceof Error ? err.message : 'Failed to load equipment')
      } finally {
        setLoading(false)
      }
    }

    if (hhRef) {
      fetchItems()
    } else {
      setLoading(false)
      setError('No HireHop reference available')
    }
  }, [hhRef, whatIsIt])

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📦</span> Equipment List
        </h2>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-gray-200 rounded w-3/4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
          <div className="h-4 bg-gray-200 rounded w-2/3"></div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📦</span> Equipment List
        </h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📦</span> Equipment List
        </h2>
        <p className="text-gray-500 text-sm">No equipment items found for this job.</p>
      </div>
    )
  }

  const PREVIEW_COUNT = 5
  const hasMoreItems = items.length > PREVIEW_COUNT
  const displayItems = expanded ? items : items.slice(0, PREVIEW_COUNT)

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-gray-900 flex items-center gap-2">
          <span>📦</span> Equipment List
          <span className="text-sm font-normal text-gray-500">
            ({items.length} item{items.length !== 1 ? 's' : ''})
          </span>
        </h2>
      </div>

      {/* Filter indicator */}
      {whatIsIt === 'equipment' && (
        <p className="text-xs text-gray-400 mb-3">
          Showing equipment only (vehicles filtered out)
        </p>
      )}

      <div className="space-y-2">
        {displayItems.map((item, index) => (
          <div 
            key={item.id || index} 
            className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
          >
            <div className="flex-1">
              <p className="text-gray-900 text-sm">{item.name}</p>
              {item.category && (
                <p className="text-gray-400 text-xs">{item.category}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="bg-gray-100 text-gray-700 px-2 py-1 rounded text-sm font-medium">
                × {item.quantity}
              </span>
              {item.isVirtual && (
                <span className="text-xs text-gray-400" title="Virtual item">
                  (V)
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {hasMoreItems && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 w-full text-center text-sm font-medium text-purple-600 hover:text-purple-500 py-2 border-t border-gray-100"
        >
          {expanded 
            ? '▲ Show less' 
            : `▼ Show all ${items.length} items (+${items.length - PREVIEW_COUNT} more)`
          }
        </button>
      )}
    </div>
  )
}

// =============================================================================
// NOTIFICATION MUTE TOGGLE COMPONENT
// =============================================================================

function NotificationMuteToggle({ jobId }: { jobId: string }) {
  const [isMuted, setIsMuted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Fetch current mute status
  useEffect(() => {
    async function checkMuteStatus() {
      try {
        const res = await fetch('/api/settings/notifications')
        const data = await res.json()
        if (data.success && data.notifications) {
          setIsMuted(data.notifications.mutedJobIds?.includes(jobId) || false)
        }
      } catch (err) {
        console.error('Failed to check mute status:', err)
      } finally {
        setLoading(false)
      }
    }
    checkMuteStatus()
  }, [jobId])

  const toggleMute = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isMuted ? 'unmute_job' : 'mute_job',
          jobId,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setIsMuted(!isMuted)
      }
    } catch (err) {
      console.error('Failed to toggle mute:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return null // Don't show anything while loading
  }

  return (
    <button
      onClick={toggleMute}
      disabled={saving}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
        isMuted 
          ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
          : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200'
      }`}
    >
      {saving ? (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
      ) : (
        <span>{isMuted ? '🔕' : '🔔'}</span>
      )}
      {isMuted ? 'Notifications off for this job' : 'Notifications on'}
    </button>
  )
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function JobDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobId = params.id as string
  const runGroup = searchParams.get('run')

  const [job, setJob] = useState<Job | null>(null)
  const [venue, setVenue] = useState<Venue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // Multi-drop run state
  const [runJobs, setRunJobs] = useState<Job[]>([])
  const [runVenues, setRunVenues] = useState<Map<string, Venue>>(new Map())
  const [expandedStops, setExpandedStops] = useState<Set<string>>(new Set())
  const [loadingRun, setLoadingRun] = useState(false)

  // Fetch primary job
  useEffect(() => {
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${jobId}`)
        const data: JobApiResponse = await response.json()

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        setJob(data.job || null)
        setVenue(data.venue || null)
        
        // If this is a grouped run, fetch all jobs in the run
        if (runGroup && data.job?.date) {
          fetchRunJobs(runGroup, data.job.date)
        }
      } catch (err) {
        console.error('Error fetching job:', err)
        setError(err instanceof Error ? err.message : 'Failed to load job')
      } finally {
        setLoading(false)
      }
    }

    if (jobId) {
      fetchJob()
    }
  }, [jobId, router, runGroup])

  // Fetch all jobs in a run group
  const fetchRunJobs = async (group: string, date: string) => {
    setLoadingRun(true)
    try {
      const res = await fetch(`/api/jobs/run?group=${group}&date=${date}`)
      const data = await res.json()
      
      if (data.success && data.jobs) {
        setRunJobs(data.jobs)
        // Expand first stop by default
        if (data.jobs.length > 0) {
          setExpandedStops(new Set([data.jobs[0].id]))
        }
        // Fetch venues for all jobs
        if (data.venues) {
          setRunVenues(new Map(Object.entries(data.venues)))
        }
      }
    } catch (err) {
      console.error('Error fetching run jobs:', err)
    } finally {
      setLoadingRun(false)
    }
  }

  const toggleStopExpanded = (stopId: string) => {
    setExpandedStops(prev => {
      const newSet = new Set(prev)
      if (newSet.has(stopId)) {
        newSet.delete(stopId)
      } else {
        newSet.add(stopId)
      }
      return newSet
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading job details...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Error</h1>
            <p className="text-gray-600 mb-6">{error}</p>
            <Link
              href="/dashboard"
              className="inline-block bg-purple-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-purple-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-gray-400 text-5xl mb-4">🔍</div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Job Not Found</h1>
            <p className="text-gray-600 mb-6">This job doesn&apos;t exist or isn&apos;t assigned to you.</p>
            <Link
              href="/dashboard"
              className="inline-block bg-purple-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-purple-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isDelivery = job.type === 'delivery'
  const typeIcon = isDelivery ? '📦' : '📥'
  const typeLabel = isDelivery ? 'DELIVERY' : 'COLLECTION'
  const googleMapsUrl = getGoogleMapsUrl(venue?.address)
  const what3WordsUrl = getWhat3WordsUrl(venue?.whatThreeWords)
  const statusInfo = translateStatus(job.status)
  
  // Check if this is a multi-stop view
  const isMultiStop = runGroup && runJobs.length > 1

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="flex items-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <button
            onClick={() => window.location.reload()}
            className="text-gray-600 hover:text-gray-900 transition-colors"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto p-4 space-y-4">
        
        {/* Multi-stop header */}
        {isMultiStop && (
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
            <h2 className="font-semibold text-purple-800 mb-1">
              📦 Multi-drop Run ({runJobs.length} stops)
            </h2>
            <p className="text-sm text-purple-600">
              {formatDate(job.date)}
            </p>
          </div>
        )}

        {/* Single job or first stop header */}
        {!isMultiStop && (
          <>
            {/* Job Header */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex items-start gap-3 mb-4">
                <span className="text-3xl">{typeIcon}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-purple-600 uppercase tracking-wide">
                      {typeLabel}
                    </span>
                    {job.whatIsIt && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        job.whatIsIt === 'vehicle' 
                          ? 'bg-blue-100 text-blue-700' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {job.whatIsIt === 'vehicle' ? '🚐 Vehicle' : '🎸 Equipment'}
                      </span>
                    )}
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.style}`}>
                      <span>{statusInfo.icon}</span>
                      {statusInfo.label}
                    </span>
                  </div>
                  <h1 className="text-xl font-bold text-gray-900 mt-1">
                    {venue?.name || job.venueName || job.name}
                  </h1>
                </div>
              </div>

              <hr className="my-4 border-gray-100" />

              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-gray-400 w-6 text-center">📅</span>
                  <div>
                    <p className="text-sm text-gray-500">Date</p>
                    <p className="font-medium text-gray-900">{formatDate(job.date)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-gray-400 w-6 text-center">⏰</span>
                  <div>
                    <p className="text-sm text-gray-500">Arrive by</p>
                    <p className="font-medium text-gray-900">{formatTime(job.time)}</p>
                  </div>
                </div>

                {job.driverPay && job.driverPay > 0 && (
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400 w-6 text-center">💷</span>
                    <div>
                      <p className="text-sm text-gray-500">Agreed fee</p>
                      <p className="font-medium text-green-600">£{job.driverPay.toFixed(0)} + expenses</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Reference */}
            {job.hhRef && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span>🔗</span> Reference
                </h2>
                <p className="text-gray-600">
                  HireHop Job: <span className="font-mono font-medium text-gray-900">#{job.hhRef}</span>
                </p>
              </div>
            )}

            {/* Location */}
            {venue && (venue.address || venue.whatThreeWords) && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <span>📍</span> Location
                </h2>
                
                <div className="space-y-2">
                  {venue.address && (
                    <p className="text-gray-700">{venue.address}</p>
                  )}
                  
                  {venue.whatThreeWords && (
                    <p className="text-gray-500 text-sm font-mono">
                      ///{venue.whatThreeWords}
                    </p>
                  )}
                </div>
                
                <div className="mt-4 flex flex-wrap gap-3">
                  {googleMapsUrl && (
                    <a
                      href={googleMapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors font-medium text-sm"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      Google Maps
                    </a>
                  )}
                  
                  {what3WordsUrl && (
                    <a
                      href={what3WordsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 transition-colors font-medium text-sm"
                    >
                      <span className="font-bold">///</span>
                      What3Words
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Contact */}
            {venue && (venue.contact1 || venue.contact2 || venue.phone || venue.phone2 || venue.email) && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <span>👤</span> Contact
                  {venue.phoneHidden && venue.phoneVisibleFrom && (
                    <span className="text-xs font-normal text-gray-400 ml-2">
                      (phone visible from {venue.phoneVisibleFrom})
                    </span>
                  )}
                </h2>
                
                <div className="space-y-3">
                  {venue.contact1 && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 w-6 text-center">👤</span>
                      <span className="text-gray-700">{venue.contact1}</span>
                    </div>
                  )}
                  
                  {venue.contact2 && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 w-6 text-center">👤</span>
                      <span className="text-gray-700">{venue.contact2}</span>
                    </div>
                  )}
                  
                  {venue.phoneHidden ? (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 w-6 text-center">📞</span>
                      <span className="text-gray-400 italic">
                        Available from {venue.phoneVisibleFrom}
                      </span>
                    </div>
                  ) : (
                    <>
                      {venue.phone && (
                        <a
                          href={`tel:${venue.phone}`}
                          className="flex items-center gap-3 text-purple-600 hover:text-purple-700"
                        >
                          <span className="w-6 text-center">📞</span>
                          <span className="font-medium">{venue.phone}</span>
                        </a>
                      )}
                      
                      {venue.phone2 && (
                        <a
                          href={`tel:${venue.phone2}`}
                          className="flex items-center gap-3 text-purple-600 hover:text-purple-700"
                        >
                          <span className="w-6 text-center">📞</span>
                          <span className="font-medium">{venue.phone2}</span>
                        </a>
                      )}
                    </>
                  )}
                  
                  {venue.email && (
                    <a
                      href={`mailto:${venue.email}`}
                      className="flex items-center gap-3 text-purple-600 hover:text-purple-700"
                    >
                      <span className="w-6 text-center">✉️</span>
                      <span className="font-medium">{venue.email}</span>
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Equipment List - simple read-only with filtering */}
            {job.hhRef && (
              <EquipmentList hhRef={job.hhRef} whatIsIt={job.whatIsIt} />
            )}

            {/* Access Info */}
            {venue?.accessNotes && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span>🚪</span> Access Info
                </h2>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-gray-700 whitespace-pre-wrap">{venue.accessNotes}</p>
                </div>
              </div>
            )}

            {/* Key Notes */}
            {job.keyNotes && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span>📋</span> Key Notes
                </h2>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-gray-700 whitespace-pre-wrap">{job.keyNotes}</p>
                </div>
              </div>
            )}

            {/* Stage Notes */}
            {venue?.stageNotes && venue.stageNotes !== venue.accessNotes && (
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span>🎭</span> Stage Notes
                </h2>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-gray-700 whitespace-pre-wrap">{venue.stageNotes}</p>
                </div>
              </div>
            )}

            {/* Notification Toggle */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <span>🔔</span> Notifications
              </h2>
              <NotificationMuteToggle jobId={job.id} />
              <p className="text-xs text-gray-500 mt-2">
                Turn off to stop receiving email updates about this specific job
              </p>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3 pt-2">
              <button
                className="w-full bg-white border border-gray-200 text-gray-700 px-6 py-3 rounded-xl font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
                onClick={() => alert('Calendar export coming soon!')}
              >
                <span>📅</span> Add to Calendar
              </button>

              {!job.completedAtDate && (
                <Link
                  href={`/job/${job.id}/complete`}
                  className="w-full bg-purple-500 text-white px-6 py-4 rounded-xl font-semibold hover:bg-purple-600 transition-colors flex items-center justify-center gap-2 text-lg"
                >
                  <span>▶️</span> Start {isDelivery ? 'Delivery' : 'Collection'}
                </Link>
              )}

              {job.completedAtDate && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                  <span className="text-green-600 font-medium">
                    ✅ Completed on {formatDate(job.completedAtDate)}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* Multi-stop accordion view */}
        {isMultiStop && !loadingRun && (
          <div className="space-y-3">
            {runJobs.map((stopJob, index) => {
              const stopVenue = runVenues.get(stopJob.venueId || '') || null
              const isExpanded = expandedStops.has(stopJob.id)
              const stopStatusInfo = translateStatus(stopJob.status)
              
              return (
                <div key={stopJob.id} className="bg-white rounded-xl shadow-sm overflow-hidden">
                  {/* Stop header - always visible */}
                  <button
                    onClick={() => toggleStopExpanded(stopJob.id)}
                    className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center font-bold text-sm">
                        {index + 1}
                      </div>
                      <div className="text-left">
                        <p className="font-medium text-gray-900">
                          {stopVenue?.name || stopJob.venueName || stopJob.name}
                        </p>
                        <p className="text-sm text-gray-500">
                          {stopJob.time || 'TBC'} · {stopJob.type === 'delivery' ? 'Delivery' : 'Collection'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${stopStatusInfo.style}`}>
                        {stopStatusInfo.icon}
                      </span>
                      <svg 
                        className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
                        fill="none" 
                        stroke="currentColor" 
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  
                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-6 pb-4 border-t border-gray-100">
                      <div className="pt-4 space-y-4">
                        {/* Location */}
                        {stopVenue?.address && (
                          <div>
                            <p className="text-sm text-gray-500 mb-1">📍 Location</p>
                            <p className="text-gray-700">{stopVenue.address}</p>
                            {stopVenue.whatThreeWords && (
                              <p className="text-gray-500 text-sm font-mono mt-1">
                                ///{stopVenue.whatThreeWords}
                              </p>
                            )}
                            <div className="mt-2 flex gap-2">
                              {getGoogleMapsUrl(stopVenue.address) && (
                                <a
                                  href={getGoogleMapsUrl(stopVenue.address)!}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-blue-600 hover:underline"
                                >
                                  Open in Maps →
                                </a>
                              )}
                            </div>
                          </div>
                        )}
                        
                        {/* Contact */}
                        {(stopVenue?.contact1 || stopVenue?.phone) && (
                          <div>
                            <p className="text-sm text-gray-500 mb-1">👤 Contact</p>
                            {stopVenue.contact1 && <p className="text-gray-700">{stopVenue.contact1}</p>}
                            {stopVenue.phone && (
                              <a href={`tel:${stopVenue.phone}`} className="text-purple-600 hover:underline">
                                {stopVenue.phone}
                              </a>
                            )}
                          </div>
                        )}
                        
                        {/* Access Notes */}
                        {stopVenue?.accessNotes && (
                          <div>
                            <p className="text-sm text-gray-500 mb-1">🚪 Access</p>
                            <p className="text-gray-700 text-sm">{stopVenue.accessNotes}</p>
                          </div>
                        )}
                        
                        {/* Key Notes */}
                        {stopJob.keyNotes && (
                          <div>
                            <p className="text-sm text-gray-500 mb-1">📋 Notes</p>
                            <p className="text-gray-700 text-sm">{stopJob.keyNotes}</p>
                          </div>
                        )}
                        
                        {/* View full details link */}
                        <Link
                          href={`/job/${stopJob.id}`}
                          className="inline-block text-sm font-medium text-purple-600 hover:text-purple-500"
                        >
                          View full details →
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            
            {/* Total fee for run */}
            {runJobs.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm p-4 flex items-center justify-between">
                <span className="text-gray-600">Total agreed fee</span>
                <span className="font-bold text-green-600">
                  £{runJobs.reduce((sum, j) => sum + (j.driverPay || 0), 0).toFixed(0)}
                </span>
              </div>
            )}
          </div>
        )}

        {loadingRun && (
          <div className="text-center py-8">
            <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-gray-600">Loading run details...</p>
          </div>
        )}

      </main>
    </div>
  )
}