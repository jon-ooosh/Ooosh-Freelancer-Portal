'use client'

/**
 * Job Completion Page
 *
 * Three forms (Oct 2026):
 * - Delivery / collection ('dc', below): checklist, signature or photo, client note.
 * - Crew job ('crew', the job's boardType): notes, optional photos, and an
 *   opt-in "what's on the hire" note to the client. No signature.
 * - People job ('people', ?mode=people from Start, or a job booked as People):
 *   notes and an optional photo. No signature.
 *
 * Allows drivers to complete a delivery/collection with:
 * - Interactive equipment checklist with tickboxes
 * - Notes field
 * - Photo capture with compression
 * - Client email input for delivery notes (equipment jobs only)
 * - Signature capture (when customer present)
 * - Offline detection
 * 
 * Section order (Oct 2026 refresh, design 2c):
 * 1. Equipment checklist
 * 2. Sign-off: signature, or "Customer not here" + photo (photos optional otherwise)
 * 3. Who gets the delivery note / collection confirmation
 * 4. Your name (Ooosh staff) + notes
 * 5. Complete button, in a sticky footer
 * 
 * Route: /job/[id]/complete
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Check, Minus, Plus, X, Camera, WifiOff, AlertTriangle, Truck, ChevronDown, ChevronUp } from 'lucide-react'
import { ukToday, shortUkDate } from '@/lib/ukDate'
import { cls, BackLink, Banner, PageSpinner } from '@/components/ui'

// =============================================================================
// TYPES
// =============================================================================

interface Job {
  id: string
  name: string
  type: 'delivery' | 'collection'
  whatIsIt?: 'equipment' | 'vehicle' | 'people'  // Equipment or A vehicle - for filtering
  date?: string
  time?: string
  venueName?: string
  hhRef?: string
  clientEmail?: string | null  // Client contact on file (OP's recipient rule) — used when there are no contacts to pick
  clientContacts?: ClientContact[]  // People on this job who can receive the delivery note
  completedAtDate?: string | null
  // Crew and People work: YYYY-MM-DD it can be completed from (its last day)
  completeFrom?: string | null
  // Has the van leg really happened? (the van-only screen)
  vanLegDone?: boolean
}

/** A client contact the delivery note can go to (OP: resolveJobEmailContacts) */
interface ClientContact {
  personId: string
  name: string
  email: string
  role: string | null
  isPrimary: boolean
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
 * Strip the DEL/COL/CREW prefix from job name and combine with venue
 */
function formatJobTitle(jobName: string, venueName?: string): string {
  const cleanedName = jobName.replace(/^(DEL|COL|CREW)\s*[-:]\s*/i, '').trim()
  
  if (!venueName) return cleanedName
  if (cleanedName.toLowerCase() === venueName.toLowerCase()) {
    return venueName
  }
  return `${cleanedName} - ${venueName}`
}

/**
 * Get the filter mode for HireHop items based on job's whatIsIt value
 */
function getFilterMode(whatIsIt?: 'equipment' | 'vehicle' | 'people'): 'equipment' | 'vehicles' | 'all' {
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
 * Resizes to max 1200px and converts to JPEG at 80% quality.
 *
 * Decodes from an object URL (revoked the moment the draw completes) rather
 * than a base64 data URL. Reading the file to a data URL first builds a
 * ~1.33x-size base64 copy of the full-resolution original in the JS heap and
 * holds it through decode — a real OOM risk on phones with high-megapixel
 * cameras. This keeps the source bytes referenced by the blob only.
 */
async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
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
        URL.revokeObjectURL(objectUrl)
        reject(new Error('Could not get canvas context'))
        return
      }

      // Use better quality scaling
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, width, height)
      // Original is now drawn into the canvas — release the source bytes.
      URL.revokeObjectURL(objectUrl)

      // Convert to JPEG
      const compressedDataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)

      const compressedSize = Math.round((compressedDataUrl.length * 0.75) / 1024) // Approximate KB
      console.log(`Image compressed: ${width}x${height}, ~${compressedSize}KB`)

      resolve(compressedDataUrl)
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image'))
    }
    img.src = objectUrl
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
        // The pad shows on the page's warm inset colour, so the canvas itself
        // is transparent. The signature still goes to OP on WHITE, exactly as
        // before the refresh: it's drawn onto a white copy for the export.
        const out = document.createElement('canvas')
        out.width = canvas.width
        out.height = canvas.height
        const octx = out.getContext('2d')
        if (octx) {
          octx.fillStyle = '#ffffff'
          octx.fillRect(0, 0, out.width, out.height)
          octx.drawImage(canvas, 0, 0)
          onSignatureChange(out.toDataURL('image/png'))
        } else {
          onSignatureChange(canvas.toDataURL('image/png'))
        }
      }
    }
  }, [isDrawing, hasSignature, onSignatureChange])

  const clearSignature = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasSignature(false)
    onSignatureChange(null)
  }, [onSignatureChange])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#1d1a1c'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }, [])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-center">
        <span className="text-[14px] font-semibold text-hf-body">Signature</span>
        <button
          type="button"
          onClick={clearSignature}
          className="text-[14px] font-semibold text-hf-link hover:text-hf-link-hover"
        >
          Clear
        </button>
      </div>
      <div className="relative rounded-xl border-[1.5px] border-dashed border-hf-dashed bg-hf-inset overflow-hidden">
        <canvas
          ref={canvasRef}
          width={600}
          height={200}
          className="relative z-10 block w-full touch-none cursor-crosshair"
          style={{ height: '200px' }}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
        />
        {!hasSignature && (
          <span className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[14px] text-hf-muted">
            Sign with your finger
          </span>
        )}
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
        // Compress directly from the File — compressImage decodes via an
        // object URL, avoiding a full-resolution base64 copy in memory first.
        const compressed = await compressImage(file)
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
    <div className="flex flex-col gap-3">
      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            <div key={index} className="relative aspect-square">
              <img 
                src={photo} 
                alt={`Photo ${index + 1}`} 
                className="w-full h-full object-cover rounded-xl border border-hf-border"
              />
              <button
                type="button"
                onClick={() => removePhoto(index)}
                aria-label={`Remove photo ${index + 1}`}
                className="absolute -top-2 -right-2 bg-hf-ink text-white w-7 h-7 rounded-full flex items-center justify-center shadow-md hover:bg-black"
              >
                <X size={15} strokeWidth={2.4} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state: says whether a photo is needed */}
      {photos.length === 0 && (
        <div className={`rounded-xl border-[1.5px] border-dashed px-4 py-4 text-center ${
          required ? 'border-hf-amber-border bg-hf-amber-bg' : 'border-hf-dashed bg-hf-inset'
        }`}>
          {compressing ? (
            <div className="py-2">
              <div className="w-7 h-7 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin mx-auto mb-2"></div>
              <p className="text-[14px] text-hf-muted">Compressing photo...</p>
            </div>
          ) : (
            <>
              <Camera size={26} strokeWidth={1.6} className={`mx-auto ${required ? 'text-hf-amber-text' : 'text-hf-placeholder'}`} />
              <p className={`mt-1.5 text-[14px] ${required ? 'text-hf-amber-text font-semibold' : 'text-hf-muted'}`}>
                {required ? 'At least 1 photo required' : 'Photos optional'}
              </p>
            </>
          )}
        </div>
      )}

      {photos.length > 0 && compressing && (
        <div className="flex items-center gap-2 text-[14px] text-hf-muted">
          <div className="w-5 h-5 border-2 border-hf-tint border-t-hf-accent rounded-full animate-spin"></div>
          Compressing photo...
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
          <div className={`${cls.btnSecondary} w-full`}>
            <Camera size={18} strokeWidth={1.9} />
            {photos.length === 0 ? 'Add photo' : `Add another photo (${photos.length}/${MAX_PHOTOS})`}
          </div>
        </label>
      )}

      {photos.length >= MAX_PHOTOS && (
        <p className="text-center text-[14px] text-hf-muted">Maximum {MAX_PHOTOS} photos reached</p>
      )}
    </div>
  )
}

// =============================================================================
// CLIENT EMAIL INPUT COMPONENT
// =============================================================================

interface ClientEmailInputProps {
  contacts: ClientContact[]
  selectedContactEmails: string[]
  onToggleContact: (email: string) => void
  emails: string[]
  onEmailsChange: (emails: string[]) => void
  dontSend: boolean
  onDontSendChange: (dontSend: boolean) => void
  // 'hire' = a crew job's opt-in "what's on the hire" note (Oct 2026): the box
  // is "Send…" (ticked = send) instead of "Don't send…".
  jobType: 'delivery' | 'collection' | 'hire'
}

function ClientEmailInput({ 
  contacts,
  selectedContactEmails,
  onToggleContact,
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

  // Who it's going to, so the driver can see the address they've chosen.
  const goingTo = Array.from(new Set([
    ...selectedContactEmails,
    ...emails.map((e) => e.trim()).filter((e) => e && isValidEmail(e)),
  ]))

  return (
    <div className="flex flex-col gap-2.5">
      {jobType === 'hire' && (
        /* Crew: opt-in */
        <ToggleRow
          checked={!dontSend}
          onChange={(on) => onDontSendChange(!on)}
          title="Send the client a note of what's on the hire"
          sub="A PDF of the equipment on the hire"
        />
      )}

      {/* Job contacts to pick (same list as the warehouse collection page) */}
      {!dontSend && contacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {contacts.map((c) => {
            const selected = selectedContactEmails.includes(c.email)
            const tag = c.isPrimary ? 'lead' : c.role
            return (
              <button
                key={c.personId}
                type="button"
                onClick={() => onToggleContact(c.email)}
                aria-pressed={selected}
                title={c.email}
                className={`min-h-[40px] max-w-full px-3.5 py-1.5 rounded-full border-[1.5px] text-[15px] flex items-center gap-1.5 text-left transition-colors ${
                  selected
                    ? 'bg-hf-tint border-hf-accent text-hf-tint-text font-semibold'
                    : 'bg-white border-hf-control text-hf-body font-medium hover:bg-hf-inset'
                }`}
              >
                {selected && <Check size={16} strokeWidth={2.4} className="flex-none" />}
                <span className="truncate">{c.name}{tag ? ` · ${tag}` : ''}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Email inputs (hidden when don't send is checked) */}
      {!dontSend && (
        <div className="flex flex-col gap-2">
          {emails.map((email, index) => (
            <div key={index} className="flex gap-2">
              <div className="flex-1">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => handleEmailChange(index, e.target.value)}
                  onBlur={() => handleEmailBlur(index)}
                  placeholder={index === 0 ? (contacts.length > 0 ? "Another email (optional)" : "Client email address (optional)") : "Additional email"}
                  className={`${cls.input} h-12 !py-0 ${emailErrors[index] ? '!border-hf-error' : ''}`}
                />
                {emailErrors[index] && (
                  <p className="text-hf-error text-[13px] mt-1">{emailErrors[index]}</p>
                )}
              </div>
              {emails.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeEmailField(index)}
                  className="w-11 h-12 flex items-center justify-center text-hf-muted hover:text-hf-error transition-colors"
                  title="Remove email"
                >
                  <X size={20} strokeWidth={2} />
                </button>
              )}
            </div>
          ))}

          {/* Add another email button */}
          {emails.length < MAX_CLIENT_EMAILS && (
            <button
              type="button"
              onClick={addEmailField}
              className="self-start min-h-[36px] text-[15px] font-semibold text-hf-link hover:text-hf-link-hover flex items-center gap-1"
            >
              <Plus size={16} strokeWidth={2.4} />
              Add another email
            </button>
          )}

          {goingTo.length > 0 && (
            <p className="text-[14px] text-hf-body break-words">
              Sending to {goingTo.join(', ')}
            </p>
          )}

          {/* Info text */}
          <p className="text-[13px] leading-[1.45] text-hf-muted">
            {jobType === 'delivery' 
              ? 'A PDF delivery note with the equipment list goes to the people chosen above. If nobody is chosen, it goes to the client contact we have on file.'
              : jobType === 'hire'
                ? 'A PDF listing the equipment on the hire goes to the people chosen above. If nobody is chosen, it goes to the client contact we have on file.'
                : 'A collection confirmation email goes to the people chosen above. If nobody is chosen, it goes to the client contact we have on file.'
            }
          </p>
        </div>
      )}

      {jobType !== 'hire' && (
        /* Don't send */
        <CheckRow
          checked={dontSend}
          onChange={onDontSendChange}
          label={`Don't send ${typeLabel.toLowerCase()} to client`}
        />
      )}
    </div>
  )
}

// =============================================================================
// SMALL CONTROLS (toggle row, checkbox row, card)
// =============================================================================

/** A white card section (design: r16, 1px warm border, 16px padding). */
function Section({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={`${cls.card} p-4 flex flex-col gap-2.5`}>
      {(title || aside) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h3 className="text-[16px] font-semibold text-hf-ink">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </div>
  )
}

/** Switch row on the inset colour (design: "Customer not here"). A real checkbox underneath. */
function ToggleRow({ checked, onChange, title, sub }: { checked: boolean; onChange: (on: boolean) => void; title: string; sub?: string }) {
  return (
    <label className="min-h-[56px] rounded-xl bg-hf-inset px-3.5 py-2.5 flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <span className="flex-1 flex flex-col gap-0.5">
        <span className="text-[16px] font-semibold text-hf-ink">{title}</span>
        {sub && <span className="text-[14px] text-hf-muted">{sub}</span>}
      </span>
      <span
        aria-hidden
        className={`relative flex-none w-[46px] h-[28px] rounded-full transition-colors peer-focus-visible:ring-4 peer-focus-visible:ring-hf-tint ${checked ? 'bg-hf-accent' : 'bg-hf-toggle-off'}`}
      >
        <span className={`absolute top-[3px] left-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform ${checked ? 'translate-x-[18px]' : ''}`} />
      </span>
    </label>
  )
}

/** Checkbox row: 26px r8 box (design's ticked green / unticked dashed-grey). */
function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <label className="min-h-[44px] flex items-center gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <span aria-hidden className={`flex-none w-[26px] h-[26px] rounded-lg flex items-center justify-center peer-focus-visible:ring-4 peer-focus-visible:ring-hf-tint ${
        checked ? 'bg-hf-green text-white' : 'bg-white border-2 border-hf-dashed'}`}>
        {checked && <Check size={16} strokeWidth={3} />}
      </span>
      <span className="text-[15px] text-hf-body">{label}</span>
    </label>
  )
}

// =============================================================================
// EQUIPMENT LIST WITH TICKBOXES COMPONENT
// =============================================================================

/** One line of the equipment checklist as sent with the completion (OP puts it on the job timeline). */
interface ChecklistLine {
  name: string
  quantity: number
  checked: number
}

interface EquipmentChecklistProps {
  hhRef: string
  /** The OP job this list is shown on: the kit-list route checks it is the freelancer's. */
  quoteId: string
  whatIsIt?: 'equipment' | 'vehicle' | 'people'
  isDelivery: boolean
  /** Told every time a tick changes, so the page can send the ticks with the completion. */
  onChange?: (lines: ChecklistLine[]) => void
}

function EquipmentChecklist({ hhRef, quoteId, whatIsIt, isDelivery, onChange }: EquipmentChecklistProps) {
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
        const response = await fetch(`/api/hirehop/items/${encodeURIComponent(hhRef)}?job=${encodeURIComponent(quoteId)}&filter=${filterMode}`)
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
  }, [hhRef, quoteId, whatIsIt])

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

  // Report the ticks up (Oct 2026: they're saved now, not just a screen aid).
  useEffect(() => {
    onChange?.(items.map((item, index) => ({
      name: item.name,
      quantity: item.quantity,
      checked: Math.min(checkedCounts[`${item.id}-${index}`] || 0, item.quantity),
    })))
  }, [items, checkedCounts, onChange])

  // Calculate totals for summary
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)
  const totalChecked = Object.entries(checkedCounts).reduce((sum, [key, count]) => {
    const index = parseInt(key.split('-').pop() || '0')
    const item = items[index]
    return sum + Math.min(count, item?.quantity || 0)
  }, 0)

  const heading = 'Equipment checklist'

  if (loading) {
    return (
      <Section title={heading}>
        <div className="animate-pulse flex flex-col gap-2">
          <div className="h-4 bg-hf-track rounded w-3/4"></div>
          <div className="h-4 bg-hf-track rounded w-1/2"></div>
          <div className="h-4 bg-hf-track rounded w-2/3"></div>
        </div>
      </Section>
    )
  }

  if (error) {
    return (
      <Section title={heading}>
        <Banner tone="error">{error}</Banner>
      </Section>
    )
  }

  if (items.length === 0) {
    return (
      <Section title={heading}>
        <p className="text-[15px] text-hf-muted">No equipment items found</p>
      </Section>
    )
  }

  const PREVIEW_COUNT = 8
  const hasMoreItems = items.length > PREVIEW_COUNT
  const displayItems = expanded ? items : items.slice(0, PREVIEW_COUNT)
  const pct = totalItems > 0 ? Math.round((totalChecked / totalItems) * 100) : 0

  return (
    <div className={`${cls.card} flex flex-col overflow-hidden`}>
      <div className="px-4 pt-3.5 pb-2.5 flex justify-between items-baseline gap-3">
        <h3 className="text-[16px] font-semibold text-hf-ink">{heading}</h3>
        {/* Progress indicator */}
        <span className={`text-[14px] font-semibold tabular whitespace-nowrap ${totalChecked > 0 ? 'text-hf-green-text' : 'text-hf-muted'}`}>
          {totalChecked} of {totalItems} ticked
        </span>
      </div>

      <p className="px-4 pb-2.5 text-[14px] leading-[1.4] text-hf-muted">
        Tick every item you&apos;ve {isDelivery ? 'handed over' : 'collected'}, or leave them all unticked if you didn&apos;t check.
      </p>

      {/* Filter indicator */}
      {whatIsIt === 'equipment' && (
        <p className="px-4 pb-2.5 text-[13px] text-hf-placeholder">
          Showing equipment only (vehicles filtered out)
        </p>
      )}

      <div className="h-1.5 mx-4 mb-1.5 rounded-full bg-hf-track overflow-hidden" aria-hidden>
        <div className="h-full bg-hf-green transition-[width]" style={{ width: `${pct}%` }} />
      </div>

      <div className="flex flex-col">
        {displayItems.map((item, index) => {
          const itemKey = `${item.id}-${index}`
          const checkedCount = checkedCounts[itemKey] || 0
          const isFullyChecked = checkedCount >= item.quantity
          const isPartiallyChecked = checkedCount > 0 && checkedCount < item.quantity
          
          return (
            <div 
              key={itemKey} 
              className="min-h-[52px] px-4 py-2 flex items-center gap-3 border-t border-hf-divider"
            >
              {/* The box ticks the whole line (and un-ticks it). A line of more
                  than one keeps a counter on the right for part-quantities. */}
              <button
                type="button"
                onClick={() => {
                  if (item.quantity === 1) {
                    setCheckedCounts(prev => ({ ...prev, [itemKey]: checkedCount >= 1 ? 0 : 1 }))
                  } else {
                    handleToggleAll(itemKey, item.quantity)
                  }
                }}
                className={`flex-none w-[26px] h-[26px] rounded-lg flex items-center justify-center transition-colors ${
                  isFullyChecked
                    ? 'bg-hf-green text-white'
                    : isPartiallyChecked
                      ? 'bg-hf-green-tint text-hf-green-text border-2 border-hf-green'
                      : 'bg-white border-2 border-hf-dashed hover:border-hf-green'
                }`}
                title={isFullyChecked ? 'Uncheck' : 'Check'}
                aria-label={`${isFullyChecked ? 'Untick' : 'Tick'} ${item.name}`}
              >
                {isFullyChecked && <Check size={16} strokeWidth={3} />}
                {isPartiallyChecked && <Minus size={16} strokeWidth={3} />}
              </button>

              {/* Item details */}
              <div className="flex-1 min-w-0">
                <p className="text-[16px] text-hf-ink leading-[1.3]">
                  {item.name}
                </p>
                {item.category && (
                  <p className="text-hf-placeholder text-[13px] truncate">{item.category}</p>
                )}
              </div>

              {item.quantity > 1 ? (
                <div className="flex-none flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleCheckToggle(itemKey, item.quantity, false)}
                    disabled={checkedCount === 0}
                    className="w-8 h-8 rounded-full bg-hf-track text-hf-body flex items-center justify-center disabled:opacity-30"
                    title="Remove one"
                    aria-label={`One fewer ${item.name}`}
                  >
                    <Minus size={16} strokeWidth={2.4} />
                  </button>
                  <span className={`min-w-[3rem] text-center text-[15px] tabular ${
                    isFullyChecked ? 'text-hf-green-text font-semibold' : isPartiallyChecked ? 'text-hf-amber-text font-semibold' : 'text-hf-muted'
                  }`}>
                    {checkedCount > 0 ? `${checkedCount}/${item.quantity}` : `×${item.quantity}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCheckToggle(itemKey, item.quantity, true)}
                    disabled={checkedCount >= item.quantity}
                    className="w-8 h-8 rounded-full bg-hf-track text-hf-body flex items-center justify-center disabled:opacity-30"
                    title="Add one"
                    aria-label={`One more ${item.name}`}
                  >
                    <Plus size={16} strokeWidth={2.4} />
                  </button>
                </div>
              ) : (
                <span className="flex-none text-[15px] text-hf-muted tabular">×{item.quantity}</span>
              )}
            </div>
          )
        })}
      </div>

      {hasMoreItems && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="min-h-[48px] w-full flex items-center justify-center gap-1 text-[15px] font-semibold text-hf-link hover:text-hf-link-hover border-t border-hf-divider"
        >
          {expanded 
            ? <><ChevronUp size={18} strokeWidth={2} />Show less</>
            : <><ChevronDown size={18} strokeWidth={2} />Show all {items.length} items (+{items.length - PREVIEW_COUNT} more)</>
          }
        </button>
      )}

      {/* Partial completion warning */}
      {totalChecked > 0 && totalChecked < totalItems && (
        <div className="px-4 pb-4 pt-1 border-t border-hf-divider">
          <Banner tone="warning" className="mt-3">
            <strong>{totalItems - totalChecked} item{totalItems - totalChecked !== 1 ? 's' : ''} not ticked.</strong>
            {' '}If anything is missing or different, please add a note below.
          </Banner>
        </div>
      )}

      {/* All checked */}
      {totalChecked === totalItems && totalItems > 0 && (
        <div className="px-4 pb-4 pt-1 border-t border-hf-divider">
          <Banner tone="success" className="mt-3">
            All {totalItems} items ticked off.
          </Banner>
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
    <div className="sticky top-0 z-20 bg-hf-error text-white px-4 py-2.5 text-center text-[14px] font-semibold flex items-center justify-center gap-2">
      <WifiOff size={16} strokeWidth={2.2} />
      You are offline. Please reconnect to complete this job.
    </div>
  )
}

/** "‹ Back" on the left, the page's title on the right (design 2c). */
function PageHeader({ backHref, title }: { backHref: string; title: string }) {
  return (
    <header className="max-w-lg mx-auto px-2 pt-2 safe-top flex items-center justify-between">
      <div className="px-2.5"><BackLink href={backHref} label="Back" /></div>
      <h1 className="pr-4 text-[16px] font-semibold text-hf-ink">{title}</h1>
    </header>
  )
}

// =============================================================================
// VAN-ONLY CONFIRMATION COMPONENT
// =============================================================================

function VanOnlyConfirmation({
  job, jobId, isDelivery, isOnline, onComplete
}: {
  job: Job
  jobId: string
  isDelivery: boolean
  isOnline: boolean
  onComplete: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Oct 2026: every back button on the van screens used to land here, and "All
  // Done" completed the job (stopping the reminders) whether or not a van had
  // gone out or been collected. Now the button only shows once OP has the
  // book-out / collection, and OP refuses it otherwise.
  const vanDone = job.vanLegDone === true
  const alreadyDone = !!job.completedAtDate
  const stepName = isDelivery ? 'book-out' : 'collection'

  const handleConfirm = async () => {
    if (!isOnline) return
    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch(`/api/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: isDelivery ? 'Van book-out completed (van only)' : 'Van collected (van only)',
          customerPresent: false,
          vanOnly: true,
        }),
      })

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        if (response.status >= 500 || !response.ok) {
          throw new Error(
            'The server took too long to respond. Your completion may have been saved - please check the job status.'
          )
        }
      }

      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(
          'The server took too long to respond. Your completion may have been saved - please check the job status.'
        )
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to complete job')
      }

      onComplete()
    } catch (err) {
      console.error('Error completing van-only job:', err)
      setError(err instanceof Error ? err.message : 'Failed to complete job')
    } finally {
      setSubmitting(false)
    }
  }

  const title = `Complete ${isDelivery ? 'delivery' : 'collection'}`

  return (
    <div className="min-h-screen bg-hf-page pb-10">
      {!isOnline && <OfflineBanner />}

      <PageHeader backHref={`/job/${jobId}`} title={title} />

      <main className="max-w-lg mx-auto px-4 pt-6 flex flex-col gap-4">
        <div className="text-center flex flex-col items-center gap-2 mb-2">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${
            alreadyDone || vanDone ? 'bg-hf-green-tint text-hf-green-text' : 'bg-kind-van-bg text-kind-van'}`}>
            {alreadyDone || vanDone ? <Check size={30} strokeWidth={2.2} /> : <Truck size={30} strokeWidth={1.8} />}
          </div>
          <h2 className="text-[22px] font-bold tracking-[-0.02em] text-hf-ink">
            {alreadyDone
              ? 'Job complete'
              : vanDone
                ? (isDelivery ? 'Van booked out' : 'Van collected')
                : (isDelivery ? 'Van not booked out yet' : 'Van not collected yet')}
          </h2>
          <p className="text-[16px] text-hf-body">
            {formatJobTitle(job.name, job.venueName)}
          </p>
          {job.date && (
            <p className="text-[14px] text-hf-muted">{formatDate(job.date)}</p>
          )}
        </div>

        {alreadyDone ? (
          <div className={`${cls.card} p-5 text-center text-[16px] text-hf-body`}>
            This job is already marked complete. Nothing more to do.
          </div>
        ) : vanDone ? (
          <div className={`${cls.card} p-5 text-center`}>
            <p className="text-[16px] text-hf-body mb-1.5">
              The van {stepName} for this {isDelivery ? 'delivery' : 'collection'} is on the system.
            </p>
            <p className="text-[14px] text-hf-muted">
              Tap below to mark this job as done.
            </p>
          </div>
        ) : (
          <Banner tone="warning">
            <p className="mb-1.5">
              We can&apos;t see a van {stepName} for this job on the system yet, so it can&apos;t be marked done.
            </p>
            <p className="text-[14px]">
              If you&apos;ve only just finished it, wait a moment and refresh. Otherwise go back and start the {stepName} again.
            </p>
          </Banner>
        )}

        {error && (
          <Banner tone="error">
            <p>{error}</p>
            {error.includes('may have been saved') && (
              <Link
                href={`/job/${jobId}`}
                className={`inline-block mt-2 ${cls.link}`}
              >
                Check job status
              </Link>
            )}
          </Banner>
        )}

        {alreadyDone ? (
          <Link
            href={`/job/${jobId}`}
            className={`${cls.btnSecondary} w-full !h-[54px]`}
          >
            Back to the job
          </Link>
        ) : vanDone ? (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || !isOnline}
            className={`${cls.btnGreen} w-full`}
          >
            {submitting ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Completing...
              </>
            ) : !isOnline ? (
              <>
                <WifiOff size={18} strokeWidth={2.2} />
                Offline - can&apos;t submit
              </>
            ) : (
              <>
                <Check size={20} strokeWidth={2.4} />
                All done
              </>
            )}
          </button>
        ) : (
          <div className="flex flex-col gap-2.5">
            <Link
              href={`/job/${jobId}/start`}
              className={`${cls.btnPrimary} w-full`}
            >
              Start the {stepName} again
            </Link>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={`${cls.btnSecondary} w-full`}
            >
              Refresh
            </button>
            <Link
              href={`/job/${jobId}`}
              className="min-h-[44px] flex items-center justify-center text-[16px] font-semibold text-hf-muted hover:text-hf-body"
            >
              Back to the job
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function CompletePage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobId = params.id as string
  const isOnline = useOnlineStatus()
  const vanOnly = searchParams.get('vanOnly') === 'true'

  // Job data
  const [job, setJob] = useState<Job | null>(null)
  // The job's board from OP: 'crew' decides the crew form.
  const [boardType, setBoardType] = useState<string | null>(null)
  // The equipment ticks, sent with the completion (OP puts them on the timeline)
  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
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
  const [selectedContactEmails, setSelectedContactEmails] = useState<string[]>([])
  const [dontSendClientEmail, setDontSendClientEmail] = useState(false)
  const toggleContactEmail = (email: string) =>
    setSelectedContactEmails(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email])

  // Ooosh staff name (shown when logged in as @oooshtours.co.uk)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [staffName, setStaffName] = useState('')
  const isOooshStaff = userEmail?.endsWith('@oooshtours.co.uk') ?? false

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
        setBoardType(data.boardType || null)
        // A crew job's client note is opt-in (the delivery note is opt-out).
        if (data.boardType === 'crew') setDontSendClientEmail(true)

        // Capture user email for Ooosh staff detection
        if (data.userEmail) {
          setUserEmail(data.userEmail)
        }

        // Default recipient: the lead contact if the job has contacts to pick
        // from (they come lead-first), else pre-fill the contact on file.
        const contacts: ClientContact[] = fetchedJob?.clientContacts || []
        if (contacts.length > 0) {
          setSelectedContactEmails([contacts[0].email])
        } else if (fetchedJob?.clientEmail) {
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

  // Which form: crew from the job itself; People from Start (?mode=people) or
  // a job booked as People; ?mode=dc when a People job's driver picked another
  // option on Start. Everything else is a delivery/collection hand-over.
  const modeParam = searchParams.get('mode')
  const mode: 'dc' | 'crew' | 'people' = boardType === 'crew'
    ? 'crew'
    : modeParam === 'people' || modeParam === 'dc'
      ? modeParam
      : job?.whatIsIt === 'people' ? 'people' : 'dc'

  // Check if form is valid
  // Delivery/collection — customer present: signature required, photos optional;
  // customer not present: at least 1 photo required, no signature needed.
  // Crew and People: always (notes and photos are optional).
  const isValid = mode !== 'dc'
    ? true
    : customerPresent
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
      // Ticked contacts + any typed addresses, deduped
      const validEmails = dontSendClientEmail 
        ? [] 
        : Array.from(new Set([
            ...selectedContactEmails,
            ...clientEmails.map(email => email.trim()).filter(email => email && isValidEmail(email)),
          ]))

      const response = await fetch(`/api/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          notes,
          signature: mode === 'dc' && customerPresent ? signature : null,
          photos: photos.length > 0 ? photos : undefined,
          // Only a hand-over has a customer to be present or not.
          customerPresent: mode === 'dc' ? customerPresent : true,
          // What was ticked off (delivery/collection only)
          ...(mode === 'dc' && checklist.length > 0 ? { equipmentChecklist: checklist } : {}),
          // Crew: the opt-in "what's on the hire" note
          ...(mode === 'crew' ? { sendHireNote: !dontSendClientEmail } : {}),
          // Extra client addresses typed here. Blank is fine: OP sends to the
          // client contact on file (resolveClientEmailTarget). sendClientEmail
          // is false ONLY when "Don't send" is ticked.
          clientEmails: validEmails,
          sendClientEmail: !dontSendClientEmail,
          // Ooosh staff name (for @oooshtours.co.uk users)
          ...(isOooshStaff && staffName.trim() ? { staffName: staffName.trim() } : {}),
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
    return <PageSpinner />
  }

  // Error state
  if (error || !job) {
    return (
      <div className="min-h-screen bg-hf-page px-4 pt-10">
        <div className="max-w-lg mx-auto">
          <div className={`${cls.card} p-6 text-center flex flex-col items-center gap-3`}>
            <div className="w-14 h-14 rounded-2xl bg-red-50 text-hf-error flex items-center justify-center">
              <AlertTriangle size={28} strokeWidth={1.9} />
            </div>
            <h1 className="text-[20px] font-bold text-hf-ink">Something went wrong</h1>
            <p className="text-[15px] text-hf-muted">{error || 'Job not found'}</p>
            <Link href="/dashboard" className={`${cls.btnPrimary} w-full mt-2`}>
              Back to jobs
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isDelivery = job.type === 'delivery'
  const typeLabel = mode === 'dc' ? (isDelivery ? 'Delivery' : 'Collection') : 'Job'
  // Crew / People completed before the last day: a warning, not a block (the
  // job page only offers Complete from the last day; a link can still land here).
  const earlyFor = mode !== 'dc' && job.completeFrom && ukToday() < job.completeFrom
    ? job.completeFrom
    : null

  // Van-only confirmation: simple "All done?" screen after vehicle book-out
  if (vanOnly) {
    return (
      <VanOnlyConfirmation
        job={job}
        jobId={jobId}
        isDelivery={isDelivery}
        isOnline={isOnline}
        onComplete={() => router.push(`/job/${jobId}?completed=true`)}
      />
    )
  }

  // Only show client email section for equipment jobs (not vehicles, for now);
  // a crew job has its own opt-in hire note below, a People job none.
  const showClientEmailSection = mode === 'dc' && (job.whatIsIt === 'equipment' || !job.whatIsIt)

  const title = `Complete ${typeLabel.toLowerCase()}`
  const photosRequired = mode === 'dc' && !customerPresent

  return (
    <div className="min-h-screen bg-hf-page pb-[170px]">
      {/* Offline banner */}
      {!isOnline && <OfflineBanner />}

      {/* Header */}
      <PageHeader backHref={`/job/${jobId}`} title={title} />

      <main className="max-w-lg mx-auto px-4 pt-2 flex flex-col gap-3.5">
        
        {/* Which job this is */}
        <p className="px-1 text-[14px] text-hf-muted">
          <span className="font-semibold text-hf-body">{formatJobTitle(job.name, job.venueName)}</span>
          {' · '}{formatDate(job.date)}
        </p>

        {earlyFor && (
          <Banner tone="warning">
            This job runs until {shortUkDate(earlyFor)}. Only mark it complete once your last day is done.
          </Banner>
        )}

        {/* Equipment Checklist with Tickboxes (hand-overs only) */}
        {mode === 'dc' && job.hhRef && (
          <EquipmentChecklist 
            hhRef={job.hhRef} 
            quoteId={job.id}
            whatIsIt={job.whatIsIt}
            isDelivery={isDelivery}
            onChange={setChecklist}
          />
        )}

        {/* Sign-off (hand-overs): the client's signature, or "Customer not
            here" and a photo of where it was left. Photos are optional otherwise. */}
        {mode === 'dc' && (
          <div className={`${cls.card} p-4 flex flex-col gap-3.5`}>
            {customerPresent && (
              <>
                <p className="text-[14px] text-hf-muted -mb-1">
                  Ask the client to sign to confirm they&apos;ve {isDelivery ? 'received everything' : 'handed everything back'}.
                </p>
                <SignatureCanvas onSignatureChange={setSignature} />
              </>
            )}
            <ToggleRow
              checked={!customerPresent}
              onChange={(notHere) => {
                setCustomerPresent(!notHere)
                // Clear signature when switching to customer not present
                if (notHere) {
                  setSignature(null)
                }
              }}
              title="Customer not here"
              sub="Take a photo instead of a signature"
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[14px] font-semibold text-hf-body">
                  {photosRequired ? 'Photo of where you left it' : 'Photos'}
                </span>
                <span className={`text-[13px] font-semibold ${photosRequired ? 'text-hf-amber-text' : 'text-hf-placeholder'}`}>
                  {photosRequired ? 'Required' : 'Optional'}
                </span>
              </div>
              {photosRequired && (
                <p className="text-[14px] text-hf-muted">Take at least one photo showing where items were left</p>
              )}
              <PhotoCapture 
                photos={photos} 
                onPhotosChange={setPhotos} 
                required={photosRequired}
              />
            </div>
          </div>
        )}

        {/* Client Email Section (for equipment jobs) */}
        {showClientEmailSection && (
          <Section title={isDelivery ? 'Send the delivery note to' : 'Send the collection confirmation to'}>
            <ClientEmailInput
              contacts={job.clientContacts || []}
              selectedContactEmails={selectedContactEmails}
              onToggleContact={toggleContactEmail}
              emails={clientEmails}
              onEmailsChange={setClientEmails}
              dontSend={dontSendClientEmail}
              onDontSendChange={setDontSendClientEmail}
              jobType={job.type}
            />
          </Section>
        )}

        {/* Crew: the opt-in "what's on the hire" note */}
        {mode === 'crew' && job.hhRef && (
          <Section title="Equipment on hire">
            <ClientEmailInput
              contacts={job.clientContacts || []}
              selectedContactEmails={selectedContactEmails}
              onToggleContact={toggleContactEmail}
              emails={clientEmails}
              onEmailsChange={setClientEmails}
              dontSend={dontSendClientEmail}
              onDontSendChange={setDontSendClientEmail}
              jobType="hire"
            />
          </Section>
        )}

        {/* Your name (only for @oooshtours.co.uk users) + notes */}
        <div className={`${cls.card} p-4 flex flex-col gap-1.5`}>
          {isOooshStaff && (
            <>
              <label htmlFor="staff-name" className="text-[14px] font-semibold text-hf-body">Your name</label>
              <input
                id="staff-name"
                type="text"
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
                placeholder="Enter your name"
                className={`${cls.input} h-[52px] !py-0 !text-[17px]`}
              />
              <p className="text-[13px] text-hf-muted mb-2">So we know who completed this job</p>
            </>
          )}
          <label htmlFor="completion-notes" className="text-[14px] font-semibold text-hf-body">Notes</label>
          <textarea
            id="completion-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={mode === 'dc'
              ? 'Missing items, access issues, anything the office should know...'
              : 'Anything the office should know about the job? (optional)'}
            className={`${cls.input} resize-none leading-[1.4]`}
            rows={3}
          />
        </div>

        {/* Photos (crew and People: optional) */}
        {mode !== 'dc' && (
          <Section title="Photos" aside={<span className="text-[13px] font-semibold text-hf-placeholder">Optional</span>}>
            <p className="text-[14px] text-hf-muted -mt-1">Add a photo if it helps the office</p>
            <PhotoCapture 
              photos={photos} 
              onPhotosChange={setPhotos} 
              required={false}
            />
          </Section>
        )}

        {/* Submit Error */}
        {submitError && (
          <Banner tone="error">
            <p>{submitError}</p>
            {submitError.includes('may have been saved') && (
              <Link 
                href={`/job/${jobId}`}
                className={`inline-block mt-2 ${cls.link}`}
              >
                Check job status
              </Link>
            )}
          </Banner>
        )}
      </main>

      {/* Sticky footer: the Complete button */}
      {/* The fade sits ABOVE a solid strip, so the hint and button never sit over the form. */}
      <div className="fixed inset-x-0 bottom-0 z-20 pointer-events-none">
        <div className="h-6 bg-gradient-to-t from-hf-page to-transparent" />
        <div className="bg-hf-page">
        <div className="max-w-lg mx-auto px-4 pt-1 pb-[max(20px,env(safe-area-inset-bottom))] pointer-events-auto">
          {mode === 'dc' && !isValid && isOnline && (
            <p className="text-center text-[14px] text-hf-muted mb-2">
              {customerPresent 
                ? 'Please capture the client signature above'
                : 'Please take at least one photo'
              }
            </p>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid || submitting || !isOnline}
            className={`${cls.btnGreen} w-full !h-14`}
          >
            {submitting ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Completing...
              </>
            ) : !isOnline ? (
              <>
                <WifiOff size={18} strokeWidth={2.2} />
                Offline - can&apos;t submit
              </>
            ) : (
              <>
                <Check size={20} strokeWidth={2.4} />
                {title}
              </>
            )}
          </button>
        </div>
        </div>
      </div>
    </div>
  )
}
