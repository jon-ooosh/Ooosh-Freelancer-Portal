'use client'

/**
 * Reads a barcode with the phone's camera — the sitter till's Scan button
 * (src/app/shift/[date]/till/page.tsx).
 *
 * iPhones' Safari has no built-in barcode reader, so this uses the
 * `barcode-detector` ponyfill (the ZXing reader, compiled to WebAssembly) on
 * every phone: one reader to test, not two. Its engine file is served by the
 * portal itself (public/zxing/, copied at build by scripts/copy-zxing-wasm.cjs),
 * never fetched from a CDN, and only loaded when the camera is opened.
 *
 * A code must be read twice in a row before it counts: a 1D barcode glimpsed
 * at an angle can misread once, and a misread here would ring up the wrong item.
 * The camera is switched off the moment a code is accepted or the sheet closes.
 */

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

// Shop packs carry EAN / UPC; the rest cover labels HireHop or a supplier prints.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar'] as const
const FRAME_GAP_MS = 150
/** This many failed reads in a row means the reader itself didn't start (no signal for its engine). */
const MAX_READ_ERRORS = 20

export default function CameraBarcodeScanner({ onCode, onClose }: {
  onCode: (code: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  // The parent re-renders while the camera runs; the loop always calls the newest handler.
  const onCodeRef = useRef(onCode)
  onCodeRef.current = onCode

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }

    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser can't use the camera here. Type the item's name in the search box instead.")
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (e) {
        const name = (e as DOMException | undefined)?.name
        setProblem(name === 'NotAllowedError'
          ? "The camera is blocked for this site. Allow it in your phone's settings for your browser, then try again. Or type the item's name in the search box."
          : "The camera didn't start. Close this and try again, or type the item's name in the search box.")
        return
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }

      const video = videoRef.current
      if (!video) { stop(); return }
      video.srcObject = stream
      await video.play().catch(() => { /* muted + playsInline, so this only fails if closed already */ })

      let detector: { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> }
      try {
        const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill')
        prepareZXingModule({
          overrides: {
            locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `/zxing/${path}` : prefix + path),
          },
        })
        detector = new BarcodeDetector({ formats: [...FORMATS] })
      } catch {
        setProblem("The barcode reader didn't load. Check your signal and try again, or type the item's name in the search box.")
        stop()
        return
      }
      if (stopped) return
      setReady(true)

      let last = ''
      let errors = 0
      const tick = async () => {
        if (stopped) return
        try {
          if (video.readyState >= 2) {
            const found = await detector.detect(video)
            errors = 0
            const code = found.map((b) => (b.rawValue || '').trim()).find(Boolean) || ''
            if (code && code === last && !stopped) {
              stop()
              try { navigator.vibrate?.(60) } catch { /* not every phone vibrates */ }
              onCodeRef.current(code)
              return
            }
            last = code
          }
        } catch {
          errors += 1
          if (errors >= MAX_READ_ERRORS) {
            setProblem("The barcode reader didn't start. Check your signal and try again, or type the item's name in the search box.")
            stop()
            return
          }
        }
        timer = setTimeout(tick, FRAME_GAP_MS)
      }
      tick()
    })()

    return stop
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Scan a barcode">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-[17px] font-semibold">Scan a barcode</span>
        <button type="button" onClick={onClose} aria-label="Close the camera"
          className="h-11 w-11 rounded-full bg-white/15 flex items-center justify-center active:bg-white/25">
          <X size={22} strokeWidth={2} />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted />
        {!problem && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* A wide box: 1D barcodes are wide and short. */}
            <div className="h-[28%] w-[82%] rounded-2xl border-[3px] border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}
        {problem && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="rounded-2xl bg-white p-5 text-[16px] leading-[1.45] text-hf-ink">
              <p>{problem}</p>
              <button type="button" onClick={onClose}
                className="mt-4 h-[50px] w-full rounded-xl bg-hf-accent text-white text-[16px] font-semibold">
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {!problem && (
        <p className="px-6 py-5 text-center text-[16px] text-white">
          {ready ? 'Hold the barcode inside the box, about a hand’s width away.' : 'Starting the camera…'}
        </p>
      )}
    </div>
  )
}
