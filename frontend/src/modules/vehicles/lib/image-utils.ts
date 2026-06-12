/**
 * Shared image utilities — compression, conversion, etc.
 *
 * Memory rules (see CLAUDE.md "Book-out/check-in photo memory convention"):
 * decode via object URL and revoke immediately after the canvas draw; never
 * hold more than one decoded bitmap alive at a time.
 */

/**
 * Compress an image to a target max dimension and JPEG quality.
 * Strips EXIF by drawing to canvas (which doesn't preserve metadata).
 */
export async function compressImage(
  file: File,
  maxDimension: number = 2048,
  quality: number = 0.85,
): Promise<Blob> {
  const { blob } = await compressImageWithThumb(file, maxDimension, quality, 0)
  return blob
}

/**
 * Compress an image AND produce an ~800px JPEG base64 thumbnail for PDF
 * embedding in ONE decode pass.
 *
 * Why: the submit flow used to re-decode every full-size blob at submit time
 * to build PDF thumbnails (sequential, ~3-5s per photo on a phone — the
 * dominant cost of the 2-minute book-out submit, validated against the
 * 10 Jun 2026 journal). Doing the thumbnail at capture time piggybacks on
 * the decode we already have to do, so submit skips the whole stage.
 *
 * The thumbnail is drawn from the already-downscaled main canvas (not the
 * original), so peak memory is unchanged from the previous single-output
 * version. Pass thumbMaxWidth=0 to skip the thumbnail.
 */
export async function compressImageWithThumb(
  file: File | Blob,
  maxDimension: number = 2048,
  quality: number = 0.85,
  thumbMaxWidth: number = 800,
  thumbQuality: number = 0.7,
): Promise<{ blob: Blob; pdfBase64?: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Hold the object URL so we can revoke it the moment decoding is done.
    // Without this, the full-resolution original stays pinned in memory —
    // a real OOM risk on phones with high-megapixel cameras.
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      let { width, height } = img

      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round(height * (maxDimension / width))
          width = maxDimension
        } else {
          width = Math.round(width * (maxDimension / height))
          height = maxDimension
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('Could not get canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      // Original is now drawn into the canvas — release the source bytes.
      URL.revokeObjectURL(objectUrl)

      canvas.toBlob(
        blob => {
          if (!blob) {
            reject(new Error('Canvas toBlob failed'))
            return
          }

          if (!thumbMaxWidth || width <= 0) {
            resolve({ blob })
            return
          }

          // Thumbnail from the main canvas (already downscaled — cheap).
          const scale = Math.min(1, thumbMaxWidth / width)
          const tw = Math.round(width * scale)
          const th = Math.round(height * scale)
          const thumbCanvas = document.createElement('canvas')
          thumbCanvas.width = tw
          thumbCanvas.height = th
          const tctx = thumbCanvas.getContext('2d')
          if (!tctx) {
            resolve({ blob })
            return
          }
          tctx.drawImage(canvas, 0, 0, tw, th)
          thumbCanvas.toBlob(
            thumbBlob => {
              if (!thumbBlob) {
                resolve({ blob })
                return
              }
              const reader = new FileReader()
              reader.onload = () => resolve({ blob, pdfBase64: reader.result as string })
              reader.onerror = () => resolve({ blob })
              reader.readAsDataURL(thumbBlob)
            },
            'image/jpeg',
            thumbQuality,
          )
        },
        'image/jpeg',
        quality,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image'))
    }
    img.src = objectUrl
  })
}
