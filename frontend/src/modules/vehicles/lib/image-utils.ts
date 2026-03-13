/**
 * Shared image utilities — compression, conversion, etc.
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
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img

      // Scale down if needed
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
        reject(new Error('Could not get canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        blob => {
          if (blob) resolve(blob)
          else reject(new Error('Canvas toBlob failed'))
        },
        'image/jpeg',
        quality,
      )
    }

    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = URL.createObjectURL(file)
  })
}
