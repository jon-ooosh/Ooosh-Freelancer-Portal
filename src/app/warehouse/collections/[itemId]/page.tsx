'use client' 

/**
 * Warehouse Collection Completion Page
 * 
 * Shows equipment list for client to review, captures signature,
 * and optionally sends delivery note PDF via email.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Image from 'next/image'

interface EquipmentItem {
  id: string
  name: string
  quantity: number
}

interface JobDetails {
  id: string
  name: string
  hireStartDate: string
  clientName: string
  clientEmail: string
  hhRef: string
  items: EquipmentItem[]
}

export default function CollectionCompletePage() {
  const router = useRouter()
  const params = useParams()
  const itemId = params.itemId as string

  // Job data
  const [job, setJob] = useState<JobDetails | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  // Form state
  const [clientName, setClientName] = useState('')
  const [emails, setEmails] = useState<string[]>([''])
  const [sendEmail, setSendEmail] = useState(true)
  const [signatureData, setSignatureData] = useState<string | null>(null)

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Signature canvas
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)

  // Fetch job details
  const fetchJob = useCallback(async () => {
    const pin = sessionStorage.getItem('warehouse_pin')

    if (!pin) {
      router.push('/warehouse')
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/warehouse/collections/${itemId}`, {
        headers: { 'x-warehouse-pin': pin },
      })

      if (response.status === 401) {
        sessionStorage.removeItem('warehouse_pin')
        router.push('/warehouse')
        return
      }

      const data = await response.json()

      if (!data.success) {
        setError(data.error || 'Failed to load job details')
        return
      }

      setJob(data.job)
      setClientName(data.job.clientName || '')

      // Pre-fill email if available
      if (data.job.clientEmail) {
        setEmails([data.job.clientEmail])
      }
    } catch (err) {
      console.error('Failed to fetch job:', err)
      setError('Failed to load job details')
    } finally {
      setIsLoading(false)
    }
  }, [itemId, router])

  useEffect(() => {
    fetchJob()
  }, [fetchJob])

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * 2
    canvas.height = rect.height * 2
    ctx.scale(2, 2)

    // Set drawing style
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Fill with white background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)
  }, [job])

  // Drawing functions
  function getCoordinates(e: React.TouchEvent | React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()

    if ('touches' in e) {
      const touch = e.touches[0]
      if (!touch) return null
      return {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      }
    } else {
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
    }
  }

  function startDrawing(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault()
    const coords = getCoordinates(e)
    if (!coords) return

    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return

    setIsDrawing(true)
    ctx.beginPath()
    ctx.moveTo(coords.x, coords.y)
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    if (!isDrawing) return
    e.preventDefault()

    const coords = getCoordinates(e)
    if (!coords) return

    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return

    ctx.lineTo(coords.x, coords.y)
    ctx.stroke()
    setHasSignature(true)
  }

  function stopDrawing() {
    setIsDrawing(false)
  }

  function clearSignature() {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)
    setHasSignature(false)
    setSignatureData(null)
  }

  function captureSignature(): string | null {
    const canvas = canvasRef.current
    if (!canvas || !hasSignature) return null

    return canvas.toDataURL('image/png')
  }

  // Email handling
  function addEmail() {
    if (emails.length < 3) {
      setEmails([...emails, ''])
    }
  }

  function removeEmail(index: number) {
    if (emails.length > 1) {
      setEmails(emails.filter((_, i) => i !== index))
    }
  }

  function updateEmail(index: number, value: string) {
    const newEmails = [...emails]
    newEmails[index] = value
    setEmails(newEmails)
  }

  // Submit
  async function handleSubmit() {
    if (!hasSignature) {
      setSubmitError('Please capture a signature')
      return
    }

    const signature = captureSignature()
    if (!signature) {
      setSubmitError('Failed to capture signature')
      return
    }

    // Validate emails if sending
    const validEmails = sendEmail ? emails.filter(e => e.trim() && e.includes('@')) : []
    if (sendEmail && validEmails.length === 0) {
      setSubmitError('Please enter at least one valid email address')
      return
    }

    const pin = sessionStorage.getItem('warehouse_pin')
    if (!pin) {
      router.push('/warehouse')
      return
    }

    setIsSubmitting(true)
    setSubmitError('')

    try {
      const response = await fetch(`/api/warehouse/collections/${itemId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-warehouse-pin': pin,
        },
        body: JSON.stringify({
          signatureBase64: signature,
          clientName: clientName.trim() || job?.clientName || 'Customer',
          clientEmails: validEmails,
          sendEmail: sendEmail && validEmails.length > 0,
          jobName: job?.name || '',
          hireStartDate: job?.hireStartDate || '',
          hhRef: job?.hhRef || '',
          items: job?.items || [],
        }),
      })

      const data = await response.json()

      if (!data.success) {
        setSubmitError(data.error || 'Failed to complete collection')
        return
      }

      // Success! Redirect to collections list with success message
      router.push('/warehouse/collections?completed=true')
    } catch (err) {
      console.error('Submit error:', err)
      setSubmitError('Failed to complete collection. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    } catch {
      return dateStr
    }
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading job details...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !job) {
    return (
      <div className="min-h-screen bg-gray-100 p-4">
        <div className="max-w-2xl mx-auto bg-white rounded-xl p-6 text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Error Loading Job</h1>
          <p className="text-gray-600 mb-4">{error || 'Job not found'}</p>
          <button
            onClick={() => router.push('/warehouse/collections')}
            className="text-purple-600 underline"
          >
            Back to collections
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 pb-8">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-4">
          <button
            onClick={() => router.push('/warehouse/collections')}
            className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-gray-800 truncate">{job.name}</h1>
            <p className="text-sm text-gray-500">Collection Sign-off</p>
          </div>
          <Image src="/ooosh-tours-logo-small.png" alt="Ooosh" width={36} height={36} />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Job info */}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Hire Start Date</p>
              <p className="font-medium text-gray-800">{formatDate(job.hireStartDate)}</p>
            </div>
            {job.hhRef && (
              <div>
                <p className="text-gray-500">HireHop Ref</p>
                <p className="font-medium text-gray-800">{job.hhRef}</p>
              </div>
            )}
          </div>
        </div>

        {/* Equipment list */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-purple-50 border-b border-purple-100">
            <h2 className="font-semibold text-purple-800">📦 Equipment ({job.items.length} items)</h2>
          </div>
          <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
            {job.items.length === 0 ? (
              <p className="p-4 text-gray-500 text-center">No equipment items found</p>
            ) : (
              job.items.map((item, index) => (
                <div key={item.id || index} className="px-4 py-3 flex justify-between items-center">
                  <span className="text-gray-800">{item.name}</span>
                  <span className="text-gray-600 font-medium bg-gray-100 px-2 py-1 rounded">
                    ×{item.quantity}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Client name (editable) */}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            👤 Collected by
          </label>
          <input
            type="text"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Enter name of person collecting"
            className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            Edit if someone other than {job.clientName || 'the contact'} is collecting
          </p>
        </div>

        {/* Email section */}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-gray-700">📧 Send delivery note</label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span className="text-sm text-gray-600">Send email</span>
            </label>
          </div>

          {sendEmail && (
            <div className="space-y-2">
              {emails.map((email, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => updateEmail(index, e.target.value)}
                    placeholder="Email address"
                    className="flex-1 px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  {emails.length > 1 && (
                    <button
                      onClick={() => removeEmail(index)}
                      className="p-3 text-red-500 hover:bg-red-50 rounded-lg"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}

              {emails.length < 3 && (
                <button
                  onClick={addEmail}
                  className="text-sm text-purple-600 hover:text-purple-700"
                >
                  + Add another email
                </button>
              )}
            </div>
          )}
        </div>

        {/* Signature */}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-gray-700">✍️ Signature</label>
            {hasSignature && (
              <button
                onClick={clearSignature}
                className="text-sm text-red-500 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>

          <div className="border-2 border-dashed border-gray-300 rounded-lg overflow-hidden bg-white">
            <canvas
              ref={canvasRef}
              className="w-full h-40 touch-none cursor-crosshair"
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
            />
          </div>
          <p className="mt-2 text-xs text-gray-400 text-center">
            Sign above to confirm collection of equipment
          </p>
        </div>

        {/* Error message */}
        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-red-700">{submitError}</p>
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || !hasSignature}
          className="w-full bg-purple-600 text-white py-4 rounded-xl font-semibold text-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors shadow-lg"
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Processing...
            </span>
          ) : (
            '✅ Complete Collection'
          )}
        </button>
      </main>
    </div>
  )
}