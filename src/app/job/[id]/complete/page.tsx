'use client'

/**
 * Job Completion Page
 * 
 * Allows drivers to complete a delivery/collection with:
 * - Review of equipment list
 * - Notes field
 * - Signature capture (when customer present)
 * - Photo capture with compression (required when customer not present, optional otherwise)
 * - Offline detection
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
// CONSTANTS
// =============================================================================

const MAX_PHOTOS = 5
const MAX_IMAGE_DIMENSION = 1200  // Max width or height in pixels
const JPEG_QUALITY = 0.8         // 80% quality
const TARGET_FILE_SIZE = 200000  // ~200KB target

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
  const cleanedName = jobName.replace(/^(DEL|COL)\s*[-:]\s*/i, '').trim()
  
  if (!venueName) return cleanedName
  if (cleanedName.toLowerCase() === venueName.toLowerCase()) {
    return venueName
  }
  return `${cleanedName} - ${venueName}`
}

/**
 * Compress an image to target size
 * Resizes to max 1200px and converts to JPEG at 80% quality
 */
async function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // Calculate new dimensions
      let { width, height } = img
      
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        if (width > height) {
          height = Math.round((height * MAX_IMAGE_DIMENSION) / width)
          width = MAX_IMAGE_DIMENSION
        } else {
          width = Math.round((width * MAX_IMAGE_DIMENSION) / height)
          height = MAX_IMAGE_DIMENSION
        }
      }

      // Create canvas and draw resized image
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Could not get canvas context'))
        return
      }

      // Use better quality scaling
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, width, height)

      // Convert to JPEG
      const compressedDataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
      
      // Log compression results
      const originalSize = Math.round(dataUrl.length * 0.75 / 1024) // Approximate KB
      const compressedSize = Math.round(compressedDataUrl.length * 0.75 / 1024)
      console.log(`Image compressed: ${originalSize}KB → ${compressedSize}KB (${width}x${height})`)
      
      resolve(compressedDataUrl)
    }
    
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

// =============================================================================
// OFFLINE DETECTION HOOK
// =============================================================================

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true)

  useEffect(() => {
    // Set initial state
    setIsOnline(navigator.onLine)

    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
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

  const stopDrawing = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false)
      const canvas = canvasRef.current
      if (canvas && hasSignature) {
        const dataUrl = canvas.toDataURL('image/png')
        onSignatureChange(dataUrl)
      }
    }
  }, [isDrawing, hasSignature, onSignatureChange])

  const clearSignature = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setHasSignature(false)
    onSignatureChange(null)
  }, [onSignatureChange])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

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
// MULTI-PHOTO CAPTURE COMPONENT
// =============================================================================

interface PhotoCaptureProps {
  photos: string[]
  onPhotosChange: (photos: string[]) => void
  required: boolean
}

function PhotoCapture({ photos, onPhotosChange, required }: PhotoCaptureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [compressing, setCompressing] = useState(false)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    // Check if we'd exceed max photos
    const remainingSlots = MAX_PHOTOS - photos.length
    if (remainingSlots <= 0) {
      alert(`Maximum ${MAX_PHOTOS} photos allowed`)
      return
    }

    setCompressing(true)

    try {
      const newPhotos: string[] = []
      const filesToProcess = Array.from(files).slice(0, remainingSlots)

      for (const file of filesToProcess) {
        // Read file as data URL
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(new Error('Failed to read file'))
          reader.readAsDataURL(file)
        })

        // Compress the image
        const compressed = await compressImage(dataUrl)
        newPhotos.push(compressed)
      }

      onPhotosChange([...photos, ...newPhotos])
    } catch (error) {
      console.error('Error processing photos:', error)
      alert('Failed to process one or more photos')
    } finally {
      setCompressing(false)
      // Reset input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const removePhoto = (index: number) => {
    const newPhotos = photos.filter((_, i) => i !== index)
    onPhotosChange(newPhotos)
  }

  return (
    <div className="space-y-3">
      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            <div key={index} className="relative aspect-square">
              <img 
                src={photo} 
                alt={`Photo ${index + 1}`} 
                className="w-full h-full object-cover rounded-lg border border-gray-200"
              />
              <button
                type="button"
                onClick={() => removePhoto(index)}
                className="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center hover:bg-red-600 shadow-md"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add photo button or placeholder */}
      {photos.length < MAX_PHOTOS && (
        <div className={`border-2 border-dashed rounded-lg p-4 text-center ${
          required && photos.length === 0 ? 'border-orange-300 bg-orange-50' : 'border-gray-300 bg-gray-50'
        }`}>
          {compressing ? (
            <div className="py-4">
              <div className="w-8 h-8 border-4 border-ooosh-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
              <p className="text-sm text-gray-600">Compressing photo...</p>
            </div>
          ) : (
            <>
              <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <p className="mt-2 text-sm text-gray-600">
                {photos.length === 0 
                  ? (required ? 'At least 1 photo required' : 'Photos optional')
                  : `${photos.length}/${MAX_PHOTOS} photos`
                }
              </p>
            </>
          )}
        </div>
      )}

      {/* Add photo button */}
      {photos.length < MAX_PHOTOS && !compressing && (
        <label className="block cursor-pointer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="w-full py-3 px-4 bg-ooosh-500 text-white rounded-lg font-medium text-center hover:bg-ooosh-600 transition-colors flex items-center justify-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {photos.length === 0 ? 'Add Photo' : 'Add Another Photo'}
          </div>
        </label>
      )}

      {photos.length >= MAX_PHOTOS && (
        <p className="text-center text-sm text-gray-500">Maximum {MAX_PHOTOS} photos reached</p>
      )}
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
// OFFLINE BANNER COMPONENT
// =============================================================================

function OfflineBanner() {
  return (
    <div className="bg-red-500 text-white px-4 py-2 text-center text-sm font-medium">
      <span className="mr-2">📡</span>
      You are offline. Please reconnect to complete this job.
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
  const isOnline = useOnlineStatus()

  // Job data
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [notes, setNotes] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [photos, setPhotos] = useState<string[]>([])
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
  // Customer present: signature required, photos optional
  // Customer not present: at least 1 photo required, no signature needed
  const isValid = customerPresent 
    ? signature !== null 
    : photos.length >= 1

  // Handle form submission
  const handleSubmit = async () => {
    if (!isValid || !job || !isOnline) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      const response = await fetch(`/api/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          signature: customerPresent ? signature : null,
          photos: photos.length > 0 ? photos : undefined,
          customerPresent,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to complete job')
      }

      // Show warnings if any
      if (data.warnings && data.warnings.length > 0) {
        console.warn('Completion warnings:', data.warnings)
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
      {/* Offline banner */}
      {!isOnline && <OfflineBanner />}

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
          <div className="w-16"></div>
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
              <p className="text-sm text-gray-500">Photo required instead of signature</p>
            </div>
            <div className="relative">
              <input
                type="checkbox"
                checked={!customerPresent}
                onChange={(e) => {
                  setCustomerPresent(!e.target.checked)
                  // Clear signature when switching to customer not present
                  if (e.target.checked) {
                    setSignature(null)
                  }
                }}
                className="sr-only"
              />
              <div className={`w-11 h-6 rounded-full transition-colors ${!customerPresent ? 'bg-ooosh-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${!customerPresent ? 'translate-x-5' : ''}`}></div>
              </div>
            </div>
          </label>
        </div>

        {/* Signature (when customer present) */}
        {customerPresent && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>✍️</span> Client Signature
              <span className="text-red-500 text-sm">*required</span>
            </h3>
            <p className="text-sm text-gray-500 mb-3">
              Please ask the client to sign below to confirm receipt
            </p>
            <SignatureCanvas onSignatureChange={setSignature} />
          </div>
        )}

        {/* Photos */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span>📸</span> Photos
            {!customerPresent && <span className="text-red-500 text-sm">*required</span>}
            {customerPresent && <span className="text-gray-400 text-sm">(optional)</span>}
          </h3>
          <p className="text-sm text-gray-500 mb-3">
            {customerPresent 
              ? 'Optionally add photos of the delivery/collection'
              : 'Take at least one photo showing where items were left'
            }
          </p>
          <PhotoCapture 
            photos={photos} 
            onPhotosChange={setPhotos} 
            required={!customerPresent}
          />
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
          disabled={!isValid || submitting || !isOnline}
          className={`w-full py-4 rounded-xl font-semibold text-lg flex items-center justify-center gap-2 transition-colors ${
            isValid && !submitting && isOnline
              ? 'bg-green-500 text-white hover:bg-green-600'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {submitting ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Completing...
            </>
          ) : !isOnline ? (
            <>
              <span>📡</span>
              Offline - Cannot Submit
            </>
          ) : (
            <>
              <span>✓</span>
              Complete {typeLabel}
            </>
          )}
        </button>

        {!isValid && isOnline && (
          <p className="text-center text-sm text-gray-500">
            {customerPresent 
              ? 'Please capture client signature above'
              : 'Please take at least one photo'
            }
          </p>
        )}

      </main>
    </div>
  )
}
