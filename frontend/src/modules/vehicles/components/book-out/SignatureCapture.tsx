import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'

export interface SignatureCaptureHandle {
  /** Export the current canvas as a PNG blob, or null if nothing drawn */
  getBlob: () => Promise<Blob | null>
  /** Whether the pad has any strokes */
  hasSignature: () => boolean
}

interface SignatureCaptureProps {
  onClear?: () => void
  /** Label shown above the pad. Defaults to "Driver Signature". */
  label?: string
}

/**
 * Touch/mouse signature capture pad.
 * Parent grabs the signature via ref.getBlob() at submit time.
 */
export const SignatureCapture = forwardRef<SignatureCaptureHandle, SignatureCaptureProps>(
  function SignatureCapture({ onClear, label = 'Driver Signature' }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [isDrawing, setIsDrawing] = useState(false)
    const [hasStrokes, setHasStrokes] = useState(false)

    // Expose getBlob + hasSignature to parent via ref
    useImperativeHandle(ref, () => ({
      getBlob: () => {
        return new Promise<Blob | null>((resolve) => {
          const canvas = canvasRef.current
          if (!canvas || !hasStrokes) { resolve(null); return }
          canvas.toBlob((blob) => resolve(blob), 'image/png')
        })
      },
      hasSignature: () => hasStrokes,
    }), [hasStrokes])

    // Setup canvas context
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas resolution to match display size
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)

      // Style
      ctx.strokeStyle = '#1b2a4e'
      ctx.lineWidth = 2.5
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // White background
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, rect.width, rect.height)

      // Baseline hint
      ctx.strokeStyle = '#e5e7eb'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(20, rect.height - 20)
      ctx.lineTo(rect.width - 20, rect.height - 20)
      ctx.stroke()

      // Reset stroke style
      ctx.strokeStyle = '#1b2a4e'
      ctx.lineWidth = 2.5
    }, [])

    const getPoint = useCallback((e: React.TouchEvent | React.MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()

      if ('touches' in e) {
        const touch = e.touches[0]
        if (!touch) return null
        return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
      }
      return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top }
    }, [])

    const startDrawing = useCallback((e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault()
      const point = getPoint(e)
      if (!point) return

      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return

      ctx.beginPath()
      ctx.moveTo(point.x, point.y)
      setIsDrawing(true)
      setHasStrokes(true)
    }, [getPoint])

    const draw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault()
      if (!isDrawing) return

      const point = getPoint(e)
      if (!point) return

      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return

      ctx.lineTo(point.x, point.y)
      ctx.stroke()
    }, [isDrawing, getPoint])

    const stopDrawing = useCallback((e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault()
      setIsDrawing(false)
    }, [])

    const handleClear = useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const rect = canvas.getBoundingClientRect()

      // Clear and redraw background
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, rect.width, rect.height)

      // Redraw baseline
      ctx.strokeStyle = '#e5e7eb'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(20, rect.height - 20)
      ctx.lineTo(rect.width - 20, rect.height - 20)
      ctx.stroke()

      // Reset
      ctx.strokeStyle = '#1b2a4e'
      ctx.lineWidth = 2.5

      setHasStrokes(false)
      onClear?.()
    }, [onClear])

    return (
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">
          {label}
        </label>
        <p className="text-xs text-gray-400">
          Sign with your finger or stylus below
        </p>

        <div className={`rounded-lg border-2 overflow-hidden ${
          hasStrokes ? 'border-green-300' : 'border-gray-300'
        } bg-white`}>
          <canvas
            ref={canvasRef}
            className="w-full touch-none"
            style={{ height: '140px' }}
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
          />
        </div>

        {hasStrokes && (
          <button
            onClick={handleClear}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 text-xs font-medium text-gray-600 active:bg-gray-50"
          >
            Clear & Re-sign
          </button>
        )}
      </div>
    )
  }
)
