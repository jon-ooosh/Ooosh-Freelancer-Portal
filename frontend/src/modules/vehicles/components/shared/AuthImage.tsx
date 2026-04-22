import { useEffect, useState } from 'react'
import { apiFetch } from '../../config/api-config'

/**
 * Image component that handles authenticated OP endpoints.
 *
 * The `<img src>` attribute does NOT carry Authorization headers — so a
 * straight `<img src="/api/vehicles/photo/...">` hits the OP backend with
 * no auth token and gets a 401. We detect `/api/` URLs, fetch them via
 * the authenticated apiFetch (which attaches the bearer token + handles
 * refresh), and expose the result as a blob: URL. All other sources
 * (blob:, data:, absolute https:) pass straight through.
 *
 * Cleans up its own object URLs on unmount / src change so long lists of
 * photos don't leak memory.
 */
export function AuthImage(
  props: React.ImgHTMLAttributes<HTMLImageElement> & { src?: string },
) {
  const { src, ...imgProps } = props
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(undefined)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!src) {
      setResolvedSrc(undefined)
      return
    }
    // Non-API URLs (blob:, data:, absolute http(s), relative static assets) —
    // browsers can load these without extra auth work.
    if (!src.startsWith('/api/')) {
      setResolvedSrc(src)
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setError(false)

    apiFetch(src, { method: 'GET' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setResolvedSrc(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  if (error) {
    return (
      <div
        className={imgProps.className || ''}
        style={{ ...imgProps.style, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', color: '#9ca3af', fontSize: 10 }}
      >
        image unavailable
      </div>
    )
  }

  return <img {...imgProps} src={resolvedSrc} />
}
