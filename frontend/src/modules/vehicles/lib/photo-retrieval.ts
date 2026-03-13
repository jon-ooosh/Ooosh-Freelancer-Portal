/**
 * Photo Retrieval — fetches book-out photo URLs from R2 for check-in comparison.
 */

import { apiUrl } from '../config/api-config'

export interface BookOutPhoto {
  angle: string
  url: string
  key: string
}

/**
 * Fetch book-out photos for a given event and vehicle.
 * Returns a map of angle -> URL for easy lookup during comparison.
 */
export async function fetchBookOutPhotos(
  eventId: string,
  vehicleReg: string,
): Promise<Map<string, string>> {
  const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
  const prefix = `events/${eventId}/${safeReg}/`

  try {
    const response = await fetch(`${apiUrl('/list-photos')}?prefix=${encodeURIComponent(prefix)}`)

    if (!response.ok) {
      console.warn('[photo-retrieval] List photos failed:', response.status)
      return new Map()
    }

    const data = await response.json() as { photos: BookOutPhoto[] }
    const photoMap = new Map<string, string>()

    for (const photo of data.photos || []) {
      if (photo.angle) {
        photoMap.set(photo.angle, photo.url)
      }
    }

    console.log('[photo-retrieval] Found', photoMap.size, 'book-out photos for', vehicleReg)
    return photoMap
  } catch (err) {
    console.warn('[photo-retrieval] Failed to fetch book-out photos:', err)
    return new Map()
  }
}
