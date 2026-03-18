import { useEffect, useCallback, useRef, useState } from 'react'

interface PhotoLightboxProps {
  src: string
  alt: string
  onClose: () => void
}

/**
 * Full-screen photo lightbox overlay with pinch-to-zoom and double-tap-to-zoom.
 * Close via: tap backdrop (when not zoomed), X button, or Escape key.
 * Locks body scroll while open.
 */
export function PhotoLightbox({ src, alt, onClose }: PhotoLightboxProps) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const imgRef = useRef<HTMLDivElement>(null)

  // Pinch state
  const pinchRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    isPinching: false,
  })

  // Pan state
  const panRef = useRef({
    startX: 0,
    startY: 0,
    initialTranslateX: 0,
    initialTranslateY: 0,
    isPanning: false,
  })

  // Double-tap detection
  const lastTapRef = useRef(0)

  // Lock body scroll
  useEffect(() => {
    document.body.classList.add('overflow-hidden')
    return () => document.body.classList.remove('overflow-hidden')
  }, [])

  // Escape key closes
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const resetZoom = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const handleBackdropClick = useCallback(() => {
    if (scale > 1.05) {
      // If zoomed in, reset zoom instead of closing
      resetZoom()
    } else {
      onClose()
    }
  }, [scale, resetZoom, onClose])

  // ── Touch handlers for pinch-to-zoom and pan ──

  const getDistance = (t1: { clientX: number; clientY: number }, t2: { clientX: number; clientY: number }) => {
    const dx = t1.clientX - t2.clientX
    const dy = t1.clientY - t2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch start
      e.preventDefault()
      const dist = getDistance(e.touches[0]!, e.touches[1]!)
      pinchRef.current = {
        initialDistance: dist,
        initialScale: scale,
        isPinching: true,
      }
      panRef.current.isPanning = false
    } else if (e.touches.length === 1) {
      // Double-tap detection
      const now = Date.now()
      if (now - lastTapRef.current < 300) {
        // Double tap — toggle between 1x and 2.5x
        e.preventDefault()
        if (scale > 1.05) {
          resetZoom()
        } else {
          setScale(2.5)
          // Center zoom on tap point
          const rect = imgRef.current?.getBoundingClientRect()
          if (rect) {
            const tapX = e.touches[0]!.clientX - rect.left - rect.width / 2
            const tapY = e.touches[0]!.clientY - rect.top - rect.height / 2
            setTranslate({ x: -tapX * 1.5, y: -tapY * 1.5 })
          }
        }
        lastTapRef.current = 0
        return
      }
      lastTapRef.current = now

      // Pan start (only useful when zoomed)
      if (scale > 1.05) {
        panRef.current = {
          startX: e.touches[0]!.clientX,
          startY: e.touches[0]!.clientY,
          initialTranslateX: translate.x,
          initialTranslateY: translate.y,
          isPanning: true,
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, translate, resetZoom])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current.isPinching) {
      // Pinch move
      e.preventDefault()
      const dist = getDistance(e.touches[0]!, e.touches[1]!)
      const ratio = dist / pinchRef.current.initialDistance
      const newScale = Math.min(Math.max(pinchRef.current.initialScale * ratio, 1), 5)
      setScale(newScale)

      // Reset translate if zooming back to 1x
      if (newScale <= 1.05) {
        setTranslate({ x: 0, y: 0 })
      }
    } else if (e.touches.length === 1 && panRef.current.isPanning) {
      // Pan move
      e.preventDefault()
      const dx = e.touches[0]!.clientX - panRef.current.startX
      const dy = e.touches[0]!.clientY - panRef.current.startY
      setTranslate({
        x: panRef.current.initialTranslateX + dx,
        y: panRef.current.initialTranslateY + dy,
      })
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    pinchRef.current.isPinching = false
    panRef.current.isPanning = false

    // Snap to 1x if close
    if (scale < 1.05) {
      resetZoom()
    }
  }, [scale, resetZoom])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={handleBackdropClick}
    >
      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white active:bg-white/30"
        aria-label="Close"
      >
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Zoom hint */}
      {scale <= 1.05 && (
        <p className="absolute bottom-6 left-0 right-0 text-center text-xs text-white/50 pointer-events-none">
          Pinch or double-tap to zoom
        </p>
      )}

      {/* Image container with zoom + pan */}
      <div
        ref={imgRef}
        className="touch-none"
        onClick={e => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          src={src}
          alt={alt}
          className="max-h-[90vh] max-w-[95vw] object-contain select-none"
          draggable={false}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transition: pinchRef.current.isPinching || panRef.current.isPanning
              ? 'none'
              : 'transform 0.2s ease-out',
          }}
        />
      </div>
    </div>
  )
}
