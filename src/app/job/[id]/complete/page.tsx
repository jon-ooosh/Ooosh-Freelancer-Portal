'use client'

/**
 * Job Completion Page
 * 
 * Allows drivers to complete a delivery/collection with:
 * - Review of equipment list
 * - Notes field
 * - Signature capture OR photo for secure drops
 * 
 * Route: /job/[id]/complete
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

// =============================================================================
// TYPES
// =============================================================================

interface Job {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date?: string
  time?: string
  venueName?: string
  hhRef?: string
}

interface EquipmentItem {
  id: string
  name: string
  quantity: number
  category?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDate(dateStr?: string): string {
  if (!dateStr) return 'TBC'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

/**
 * Strip DEL/COL prefix from job name and combine with venue
 */
function formatJobTitle(jobName: string, venueName?: string): string {
  // Strip "DEL: ", "COL: ", "DEL - ", "COL - " prefixes (case insensitive)
  const cleanedName = jobName.replace(/^(DEL|COL)\s*[-:]\s*/i, '').trim()
  
  if (!venueName) return cleanedName
  
  // If cleaned name equals venue name, just show venue
  if (cleanedName.toLowerCase() === venueName.toLowerCase()) {
    return venueName
  }
  
  // Otherwise show "Job Name - Venue"
  return `${cleanedName} - ${venueName}`
}

// =============================================================================
// SIGNATURE CANVAS COMPONENT
// =============================================================================

interface SignatureCanvasProps {
  onSignatureChange: (dataUrl: string | null) => void
}

function SignatureCanvas({ onSignatureChange }: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)

  // Get position from mouse or touch event
  const getPosition = useCallback((e: MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    if ('touches' in e) {
      const touch = e.touches[0]
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY
      }
    } else {
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      }
    }
  }, [])

  // Start drawing
  const startDrawing = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    setIsDrawing(true)
    const pos = getPosition(e.nativeEvent)
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
  }, [getPosition])

  // Draw
  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return
    e.preventDefault()

    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return

    const pos = getPosition(e.nativeEvent)
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    setHasSignature(true)
  }, [isDrawing, getPosition])

  // Stop drawing
  const stopDrawing = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false)
      // Export signature as data URL
      const canvas = canvasRef.current
      if (canvas && hasSignature) {
        const dataUrl = canvas.toDataURL('image/png')
        onSignatureChange(dataUrl)
      }
    }
  }, [isDrawing, hasSignature, onSignatureChange])

  // Clear signature
  const clearSignature = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setHasSignature(false)
    onSignatureChange(null)
  }, [onSignatureChange])

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    // Set up canvas
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }, [])

  return (
    <div className="space-y-2">
      <div className="border-2 border-gray-300 rounded-lg overflow-hidden bg-white">
        <canvas
          ref={canvasRef}
          width={600}
          height={200}
          className="w-full touch-none cursor-crosshair"
          style={{ height: '150px' }}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
        />
      </div>
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">Sign above using finger or mouse</p>
        <button
          type="button"
          onClick={clearSignature}
          className="text-sm text-red-600 hover:text-red-700 font-medium"
        >
          Clear
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// PHOTO CAPTURE COMPONENT
// =============================================================================

interface PhotoCaptureProps {
  onPhotoChange: (dataUrl: string | null) => void
  photo: string | null
}

function PhotoCapture({ onPhotoChange, photo }: PhotoCaptureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Convert to base64
    const reader = new FileReader()
    reader.onload = () => {
      onPhotoChange(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const clearPhoto = () => {
    onPhotoChange(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      {photo ? (
        <div className="relative">
          <img 
            src={photo} 
            alt="Delivery photo" 
            className="w-full h-48 object-cover rounded-lg border border-gray-200"
          />
          <button
            type="button"
            onClick={clearPhoto}
            className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full hover:bg-red-600"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center bg-gray-50">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="mt-2 text-sm text-gray-600">Photo required for secure drops</p>
          <p className="text-xs text-gray-500">Take a photo of where items were left</p>
        </div>
      )}
      
      <div className="flex gap-2">
        <label className="flex-1 cursor-pointer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="w-full py-3 px-4 bg-ooosh-500 text-white rounded-lg font-medium text-center hover:bg-ooosh-600 transition-colors flex items-center justify-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {photo ? 'Retake Photo' : 'Take Photo'}
          </div>
        </label>
      </div>
    </div>
  )
}

// =============================================================================
// EQUIPMENT LIST COMPONENT
// =============================================================================

function EquipmentList({ hhRef }: { hhRef: string }) {
  const [items, setItems] = useState<EquipmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchItems() {
      try {
        const response = await fetch(`/api/hirehop/items/${hhRef}`)
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
    }
  }, [hhRef])

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-4 bg-gray-200 rounded w-3/4"></div>
        <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        <div className="h-4 bg-gray-200 rounded w-2/3"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
        <p className="text-red-700 text-sm">{error}</p>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p className="text-gray-500 text-sm italic">No equipment items found</p>
    )
  }

  return (
    <div className="space-y-1 max-h-64 overflow-y-auto">
      {items.map((item, index) => (
        <div 
          key={item.id || index} 
          className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
        >
          <span className="text-gray-700 text-sm">{item.name}</span>
          <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-sm font-medium">
            × {item.quantity}
          </span>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function CompletePage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string

  // Job data
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [notes, setNotes] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [customerPresent, setCustomerPresent] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Fetch job data
  useEffect(() => {
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${jobId}`)
        const data = await response.json()

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        setJob(data.job || null)
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
  }, [jobId, router])

  // Check if form is valid
  const isValid = customerPresent ? signature !== null : photo !== null

  // Handle form submission
  const handleSubmit = async () => {
    if (!isValid || !job) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      const response = await fetch(`/api/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          signature: customerPresent ? signature : null,
          photo: !customerPresent ? photo : null,
          customerPresent,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to complete job')
      }

      // Success! Redirect to job page with success message
      router.push(`/job/${jobId}?completed=true`)
    } catch (err) {
      console.error('Error completing job:', err)
      setSubmitError(err instanceof Error ? err.message : 'Failed to complete job')
    } finally {
      setSubmitting(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-ooosh-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !job) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-xl shadow-sm p-6 text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Error</h1>
            <p className="text-gray-600 mb-6">{error || 'Job not found'}</p>
            <Link
              href="/dashboard"
              className="inline-block bg-ooosh-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-ooosh-600 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isDelivery = job.type === 'delivery'
  const typeLabel = isDelivery ? 'Delivery' : 'Collection'
  const typeIcon = isDelivery ? '📦' : '🚚'

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center">
          <Link
            href={`/job/${jobId}`}
            className="flex items-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Cancel
          </Link>
          <h1 className="flex-1 text-center font-semibold text-gray-900">
            Complete {typeLabel}
          </h1>
          <div className="w-16"></div> {/* Spacer for centering */}
        </div>
      </header>

      <main className="max-w-lg mx-auto p-4 space-y-4">
        
        {/* Job Summary */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{typeIcon}</span>
            <div>
              <h2 className="font-semibold text-gray-900">
                {formatJobTitle(job.name, job.venueName)}
              </h2>
              <p className="text-sm text-gray-500">{formatDate(job.date)}</p>
            </div>
          </div>
        </div>

        {/* Equipment List */}
        {job.hhRef && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>📋</span> Equipment {isDelivery ? 'Delivered' : 'Collected'}
            </h3>
            <EquipmentList hhRef={job.hhRef} />
          </div>
        )}

        {/* Notes */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span>📝</span> Notes
          </h3>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any notes about this delivery/collection..."
            className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-ooosh-500 focus:border-ooosh-500 resize-none"
            rows={3}
          />
        </div>

        {/* Customer Present Toggle */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="font-medium text-gray-900">Customer not present</span>
              <p className="text-sm text-gray-500">Secure drop - photo required instead of signature</p>
            </div>
            <div className="relative">
              <input
                type="checkbox"
                checked={!customerPresent}
                onChange={(e) => setCustomerPresent(!e.target.checked)}
                className="sr-only"
              />
              <div className={`w-11 h-6 rounded-full transition-colors ${!customerPresent ? 'bg-ooosh-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${!customerPresent ? 'translate-x-5' : ''}`}></div>
              </div>
            </div>
          </label>
        </div>

        {/* Signature OR Photo */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          {customerPresent ? (
            <>
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <span>✍️</span> Client Signature
              </h3>
              <p className="text-sm text-gray-500 mb-3">
                Please ask the client to sign below to confirm receipt
              </p>
              <SignatureCanvas onSignatureChange={setSignature} />
            </>
          ) : (
            <>
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <span>📸</span> Delivery Photo
              </h3>
              <p className="text-sm text-gray-500 mb-3">
                Take a photo showing where items were left
              </p>
              <PhotoCapture onPhotoChange={setPhoto} photo={photo} />
            </>
          )}
        </div>

        {/* Submit Error */}
        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-700 text-sm">{submitError}</p>
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={!isValid || submitting}
          className={`w-full py-4 rounded-xl font-semibold text-lg flex items-center justify-center gap-2 transition-colors ${
            isValid && !submitting
              ? 'bg-green-500 text-white hover:bg-green-600'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {submitting ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Completing...
            </>
          ) : (
            <>
              <span>✓</span>
              Complete {typeLabel}
            </>
          )}
        </button>

        {!isValid && (
          <p className="text-center text-sm text-gray-500">
            {customerPresent 
              ? 'Please capture client signature above'
              : 'Please take a photo of the delivery location'
            }
          </p>
        )}

      </main>
    </div>
  )
}
