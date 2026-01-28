'use client'

/**
 * Job Completion Page
 * 
 * Allows drivers to complete a delivery/collection with:
 * - Interactive equipment checklist with tickboxes
 * - Notes field
 * - Photo capture with compression
 * - Client email input for delivery notes (equipment jobs only)
 * - Signature capture (when customer present)
 * - Offline detection
 * 
 * Section order:
 * 1. Job summary
 * 2. Equipment checklist
 * 3. Notes
 * 4. Customer not present toggle
 * 5. Photos
 * 6. Client email (for delivery notes)
 * 7. Signature (when customer present)
 * 8. Complete button
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
  whatIsIt?: 'equipment' | 'vehicle'  // Equipment or A vehicle - for filtering
  date?: string
  time?: string
  venueName?: string
  hhRef?: string
  clientEmail?: string  // Pre-filled client email from Monday
}

interface EquipmentItem {
  id: string
  name: string
  quantity: number
  category?: string
  categoryId?: number
  isVirtual?: boolean
  barcode?: string
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_PHOTOS = 5
const MAX_IMAGE_DIMENSION = 1200  // Max width or height in pixels
const JPEG_QUALITY = 0.8         // 80% quality
const MAX_CLIENT_EMAILS = 3      // Maximum number of client email recipients

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

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email.trim())
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
              <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
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
          <div className="w-full py-3 px-4 bg-purple-500 text-white rounded-lg font-medium text-center hover:bg-purple-600 transition-colors flex items-center justify-center gap-2">
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
// CLIENT EMAIL INPUT COMPONENT
// =============================================================================

interface ClientEmailInputProps {
  emails: string[]
  onEmailsChange: (emails: string[]) => void
  dontSend: boolean
  onDontSendChange: (dontSend: boolean) => void
  jobType: 'delivery' | 'collection'
}

function ClientEmailInput({ 
  emails, 
  onEmailsChange, 
  dontSend, 
  onDontSendChange,
  jobType 
}: ClientEmailInputProps) {
  const [emailErrors, setEmailErrors] = useState<Record<number, string>>({})

  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...emails]
    newEmails[index] = value
    onEmailsChange(newEmails)

    // Clear error when user starts typing
    if (emailErrors[index]) {
      const newErrors = { ...emailErrors }
      delete newErrors[index]
      setEmailErrors(newErrors)
    }
  }

  const handleEmailBlur = (index: number) => {
    const email = emails[index]?.trim()
    if (email && !isValidEmail(email)) {
      setEmailErrors(prev => ({ ...prev, [index]: 'Please enter a valid email' }))
    }
  }

  const addEmailField = () => {
    if (emails.length < MAX_CLIENT_EMAILS) {
      onEmailsChange([...emails, ''])
    }
  }

  const removeEmailField = (index: number) => {
    if (emails.length > 1) {
      const newEmails = emails.filter((_, i) => i !== index)
      onEmailsChange(newEmails)
      
      // Clean up errors
      const newErrors = { ...emailErrors }
      delete newErrors[index]
      setEmailErrors(newErrors)
    }
  }

  const typeLabel = jobType === 'delivery' ? 'Delivery Note' : 'Collection Confirmation'

  return (
    <div className="space-y-3">
      {/* Don't send checkbox */}
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={dontSend}
          onChange={(e) => onDontSendChange(e.target.checked)}
          className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
        />
        <span className="text-sm text-gray-700">Don't send {typeLabel.toLowerCase()} to client</span>
      </label>

      {/* Email inputs (hidden when don't send is checked) */}
      {!dontSend && (
        <div className="space-y-2">
          {emails.map((email, index) => (
            <div key={index} className="flex gap-2">
              <div className="flex-1">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => handleEmailChange(index, e.target.value)}
                  onBlur={() => handleEmailBlur(index)}
                  placeholder={index === 0 ? "Client email address" : "Additional email"}
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 ${
                    emailErrors[index] ? 'border-red-300 bg-red-50' : 'border-gray-300'
                  }`}
                />
                {emailErrors[index] && (
                  <p className="text-red-500 text-xs mt-1">{emailErrors[index]}</p>
                )}
              </div>
              {emails.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeEmailField(index)}
                  className="px-2 text-gray-400 hover:text-red-500 transition-colors"
                  title="Remove email"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}

          {/* Add another email button */}
          {emails.length < MAX_CLIENT_EMAILS && (
            <button
              type="button"
              onClick={addEmailField}
              className="text-sm text-purple-600 hover:text-purple-700 font-medium flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add another email
            </button>
          )}

          {/* Info text */}
          <p className="text-xs text-gray-500">
            {jobType === 'delivery' 
              ? 'A PDF delivery note with equipment list will be emailed to the client.'
              : 'A collection confirmation email will be sent to the client.'
            }
          </p>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// EQUIPMENT LIST WITH TICKBOXES COMPONENT
// =============================================================================

interface EquipmentChecklistProps {
  hhRef: string
  whatIsIt?: 'equipment' | 'vehicle'
  isDelivery: boolean
}

function EquipmentChecklist({ hhRef, whatIsIt, isDelivery }: EquipmentChecklistProps) {
  const [items, setItems] = useState<EquipmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true) // Default expanded on completion page
  
  // Track checked counts for each item (keyed by item id + index for uniqueness)
  const [checkedCounts, setCheckedCounts] = useState<Record<string, number>>({})

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
        
        // Initialize checked counts to 0 for all items
        const initialCounts: Record<string, number> = {}
        ;(data.items || []).forEach((item: EquipmentItem, index: number) => {
          initialCounts[`${item.id}-${index}`] = 0
        })
        setCheckedCounts(initialCounts)
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
  }, [hhRef, whatIsIt])

  // Handle incrementing/decrementing check count for an item
  const handleCheckToggle = (itemKey: string, quantity: number, increment: boolean) => {
    setCheckedCounts(prev => {
      const currentCount = prev[itemKey] || 0
      let newCount: number
      
      if (increment) {
        newCount = Math.min(currentCount + 1, quantity)
      } else {
        newCount = Math.max(currentCount - 1, 0)
      }
      
      return { ...prev, [itemKey]: newCount }
    })
  }

  // Toggle all checks for an item (for single-quantity items or quick toggle)
  const handleToggleAll = (itemKey: string, quantity: number) => {
    setCheckedCounts(prev => {
      const currentCount = prev[itemKey] || 0
      // If all checked, uncheck all. Otherwise, check all.
      const newCount = currentCount >= quantity ? 0 : quantity
      return { ...prev, [itemKey]: newCount }
    })
  }

  // Calculate totals for summary
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)
  const totalChecked = Object.entries(checkedCounts).reduce((sum, [key, count]) => {
    const index = parseInt(key.split('-').pop() || '0')
    const item = items[index]
    return sum + Math.min(count, item?.quantity || 0)
  }, 0)

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-4">
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📋</span> Equipment {isDelivery ? 'to Deliver' : 'to Collect'}
        </h3>
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
      <div className="bg-white rounded-xl shadow-sm p-4">
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📋</span> Equipment {isDelivery ? 'to Deliver' : 'to Collect'}
        </h3>
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-4">
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span>📋</span> Equipment {isDelivery ? 'to Deliver' : 'to Collect'}
        </h3>
        <p className="text-gray-500 text-sm italic">No equipment items found</p>
      </div>
    )
  }

  const PREVIEW_COUNT = 8
  const hasMoreItems = items.length > PREVIEW_COUNT
  const displayItems = expanded ? items : items.slice(0, PREVIEW_COUNT)

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <span>📋</span> Equipment {isDelivery ? 'to Deliver' : 'to Collect'}
          <span className="text-sm font-normal text-gray-500">
            ({items.length} item{items.length !== 1 ? 's' : ''})
          </span>
        </h3>
        {/* Progress indicator */}
        <span className={`text-sm font-medium px-2 py-1 rounded-full ${
          totalChecked === totalItems 
            ? 'bg-green-100 text-green-700' 
            : totalChecked > 0
              ? 'bg-amber-100 text-amber-700'
              : 'bg-gray-100 text-gray-500'
        }`}>
          {totalChecked}/{totalItems} ✓
        </span>
      </div>

      {/* Filter indicator */}
      {whatIsIt === 'equipment' && (
        <p className="text-xs text-gray-400 mb-3">
          Showing equipment only (vehicles filtered out)
        </p>
      )}

      <p className="text-sm text-gray-500 mb-3">
        Tap to check off each item as you {isDelivery ? 'load/deliver' : 'collect'} it
      </p>

      <div className="space-y-1">
        {displayItems.map((item, index) => {
          const itemKey = `${item.id}-${index}`
          const checkedCount = checkedCounts[itemKey] || 0
          const isFullyChecked = checkedCount >= item.quantity
          const isPartiallyChecked = checkedCount > 0 && checkedCount < item.quantity
          
          return (
            <div 
              key={itemKey} 
              className={`flex items-center gap-3 py-2 px-2 rounded-lg border-b border-gray-50 last:border-0 transition-colors ${
                isFullyChecked ? 'bg-gray-50' : ''
              }`}
            >
              {/* Checkbox/Counter area */}
              <div className="flex-shrink-0">
                {item.quantity <= 5 ? (
                  // Individual checkboxes for small quantities
                  <div className="flex gap-1">
                    {Array.from({ length: item.quantity }).map((_, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          // Toggle this specific checkbox
                          const newCount = i < checkedCount ? i : i + 1
                          setCheckedCounts(prev => ({ ...prev, [itemKey]: newCount }))
                        }}
                        className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                          i < checkedCount
                            ? 'bg-green-500 border-green-500 text-white'
                            : 'border-gray-300 hover:border-green-400'
                        }`}
                        title={i < checkedCount ? 'Uncheck' : 'Check'}
                      >
                        {i < checkedCount && (
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  // Counter for larger quantities
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleCheckToggle(itemKey, item.quantity, false)}
                      disabled={checkedCount === 0}
                      className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold"
                    >
                      −
                    </button>
                    <span className={`min-w-[3rem] text-center text-sm font-medium ${
                      isFullyChecked ? 'text-green-600' : isPartiallyChecked ? 'text-amber-600' : 'text-gray-500'
                    }`}>
                      {checkedCount}/{item.quantity}
                    </span>
                    <button
                      onClick={() => handleCheckToggle(itemKey, item.quantity, true)}
                      disabled={checkedCount >= item.quantity}
                      className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>

              {/* Item details */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm transition-all ${
                  isFullyChecked 
                    ? 'text-gray-400 line-through' 
                    : 'text-gray-900'
                }`}>
                  {item.name}
                </p>
                {item.category && (
                  <p className="text-gray-400 text-xs truncate">{item.category}</p>
                )}
              </div>

              {/* Quantity badge (for items with qty > 5, already shown in counter) */}
              {item.quantity <= 5 && item.quantity > 1 && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                  isFullyChecked 
                    ? 'bg-green-100 text-green-600' 
                    : 'bg-gray-100 text-gray-500'
                }`}>
                  ×{item.quantity}
                </span>
              )}

              {/* Quick toggle all button for items with quantity > 1 */}
              {item.quantity > 1 && (
                <button
                  onClick={() => handleToggleAll(itemKey, item.quantity)}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    isFullyChecked
                      ? 'text-gray-400 hover:text-gray-600'
                      : 'text-purple-600 hover:bg-purple-50'
                  }`}
                  title={isFullyChecked ? 'Uncheck all' : 'Check all'}
                >
                  {isFullyChecked ? 'Undo' : 'All'}
                </button>
              )}
            </div>
          )
        })}
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

      {/* Partial completion warning */}
      {totalChecked > 0 && totalChecked < totalItems && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-amber-800 text-sm flex items-start gap-2">
            <span className="flex-shrink-0">⚠️</span>
            <span>
              <strong>{totalItems - totalChecked} item{totalItems - totalChecked !== 1 ? 's' : ''} not checked.</strong>
              {' '}If anything is missing or different, please add a note below.
            </span>
          </p>
        </div>
      )}

      {/* All checked success message */}
      {totalChecked === totalItems && totalItems > 0 && (
        <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-green-800 text-sm flex items-center gap-2">
            <span>✅</span>
            <span>All {totalItems} items checked off!</span>
          </p>
        </div>
      )}
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

  // Client email state
  const [clientEmails, setClientEmails] = useState<string[]>([''])
  const [dontSendClientEmail, setDontSendClientEmail] = useState(false)

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

        const fetchedJob = data.job || null
        setJob(fetchedJob)

        // Pre-fill client email if available
        if (fetchedJob?.clientEmail) {
          setClientEmails([fetchedJob.clientEmail])
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
  }, [jobId, router])

  // Check if form is valid
  // Customer present: signature required, photos optional
  // Customer not present: at least 1 photo required, no signature needed
  const isValid = customerPresent 
    ? signature !== null 
    : photos.length >= 1

  // Check if client emails are valid (if sending)
  const hasValidClientEmails = dontSendClientEmail || 
    clientEmails.some(email => email.trim() && isValidEmail(email.trim()))

  // Handle form submission
  const handleSubmit = async () => {
    if (!isValid || !job || !isOnline) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      // Filter out empty/invalid emails
      const validEmails = dontSendClientEmail 
        ? [] 
        : clientEmails.filter(email => email.trim() && isValidEmail(email.trim()))

      const response = await fetch(`/api/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          signature: customerPresent ? signature : null,
          photos: photos.length > 0 ? photos : undefined,
          customerPresent,
          // Client email data (for next phase - API will use these)
          clientEmails: validEmails,
          sendClientEmail: !dontSendClientEmail && validEmails.length > 0,
        }),
      })

      // Handle timeout/HTML responses gracefully
      const contentType = response.headers.get('content-type') || ''
      
      if (!contentType.includes('application/json')) {
        // Server returned HTML (likely a timeout error page)
        // The completion may have still succeeded on the server
        console.warn('Server returned non-JSON response (possible timeout)')
        
        if (response.status >= 500 || !response.ok) {
          // Show a friendly message that acknowledges uncertainty
          throw new Error(
            'The server took too long to respond. Your completion may have been saved - please check the job status before trying again.'
          )
        }
      }

      // Try to parse JSON response
      let data
      try {
        data = await response.json()
      } catch (parseError) {
        // JSON parse failed - likely HTML response from timeout
        console.error('Failed to parse response:', parseError)
        throw new Error(
          'The server took too long to respond. Your completion may have been saved - please check the job status before trying again.'
        )
      }

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
          <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
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
  const typeLabel = isDelivery ? 'Delivery' : 'Collection'
  const typeIcon = isDelivery ? '📦' : '🚚'

  // Only show client email section for equipment jobs (not vehicles, for now)
  const showClientEmailSection = job.whatIsIt === 'equipment' || !job.whatIsIt

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

        {/* Equipment Checklist with Tickboxes */}
        {job.hhRef && (
          <EquipmentChecklist 
            hhRef={job.hhRef} 
            whatIsIt={job.whatIsIt}
            isDelivery={isDelivery}
          />
        )}

        {/* Notes */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span>📝</span> Notes
          </h3>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any notes about this delivery/collection... (e.g., items missing, access issues, customer requests)"
            className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none"
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
              <div className={`w-11 h-6 rounded-full transition-colors ${!customerPresent ? 'bg-purple-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${!customerPresent ? 'translate-x-5' : ''}`}></div>
              </div>
            </div>
          </label>
        </div>

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

        {/* Client Email Section (for equipment jobs) */}
        {showClientEmailSection && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>📧</span> {isDelivery ? 'Delivery Note' : 'Collection Confirmation'}
            </h3>
            <p className="text-sm text-gray-500 mb-3">
              {isDelivery 
                ? 'Send a delivery note with equipment list to the client'
                : 'Send a collection confirmation to the client'
              }
            </p>
            <ClientEmailInput
              emails={clientEmails}
              onEmailsChange={setClientEmails}
              dontSend={dontSendClientEmail}
              onDontSendChange={setDontSendClientEmail}
              jobType={job.type}
            />
          </div>
        )}

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

        {/* Submit Error */}
        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-700 text-sm">{submitError}</p>
            {submitError.includes('may have been saved') && (
              <Link 
                href={`/job/${jobId}`}
                className="inline-block mt-2 text-sm text-purple-600 hover:text-purple-700 font-medium"
              >
                → Check job status
              </Link>
            )}
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