/**
 * Photo upload — sends captured photos to R2 via our Netlify function proxy.
 *
 * All storage logic is isolated here. When migrating away from R2,
 * only this file needs to change.
 */

import type { CapturedPhoto, DamageItem } from '../types/vehicle-event'
import { apiUrl } from '../config/api-config'

interface UploadResult {
  url: string
  key: string
  bucket: string
}

/**
 * Upload a single photo to R2.
 * @param photo - The captured photo blob
 * @param eventId - The Monday.com event item ID (used as folder)
 * @param vehicleReg - Vehicle registration (used in path for readability)
 */
export async function uploadPhoto(
  photo: CapturedPhoto,
  eventId: string,
  vehicleReg: string,
): Promise<UploadResult> {
  const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()

  // Path: events/{eventId}/{reg}/{angle}.jpg
  // e.g. events/12345/RO71JYA/front_left.jpg
  const key = `events/${eventId}/${safeReg}/${photo.angle}.jpg`

  const formData = new FormData()
  formData.append('file', photo.blob, `${photo.angle}.jpg`)
  formData.append('key', key)

  const response = await fetch(apiUrl('/upload-photo'), {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error((err as { error?: string }).error || `Upload failed: ${response.status}`)
  }

  return response.json() as Promise<UploadResult>
}

/**
 * Upload all photos for an event, with progress callback.
 * Returns the folder URL for the event's photo set.
 */
export async function uploadAllPhotos(
  photos: CapturedPhoto[],
  eventId: string,
  vehicleReg: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ folderKey: string; uploadedCount: number; failedCount: number }> {
  const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
  const folderKey = `events/${eventId}/${safeReg}`

  let completed = 0
  let failedCount = 0

  // Upload sequentially to avoid overwhelming the function
  for (const photo of photos) {
    try {
      await uploadPhoto(photo, eventId, vehicleReg)
      completed++
    } catch (err) {
      console.error(`Failed to upload ${photo.angle}:`, err)
      failedCount++
      completed++
    }
    onProgress?.(completed, photos.length)
  }

  return {
    folderKey,
    uploadedCount: completed - failedCount,
    failedCount,
  }
}

/**
 * Upload damage photos for all damage items.
 * Key pattern: events/{eventId}/{reg}/damage/{damageId}/{index}.jpg
 */
export async function uploadDamagePhotos(
  damageItems: DamageItem[],
  eventId: string,
  vehicleReg: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ uploadedCount: number; failedCount: number }> {
  const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
  const allPhotos: Array<{ damageId: string; index: number; photo: CapturedPhoto }> = []

  for (const item of damageItems) {
    for (let i = 0; i < item.photos.length; i++) {
      allPhotos.push({ damageId: item.id, index: i, photo: item.photos[i]! })
    }
  }

  if (allPhotos.length === 0) {
    return { uploadedCount: 0, failedCount: 0 }
  }

  let completed = 0
  let failedCount = 0

  for (const { damageId, index, photo } of allPhotos) {
    const key = `events/${eventId}/${safeReg}/damage/${damageId}/${index}.jpg`
    const formData = new FormData()
    formData.append('file', photo.blob, `damage_${index}.jpg`)
    formData.append('key', key)

    try {
      const response = await fetch(apiUrl('/upload-photo'), {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      completed++
    } catch (err) {
      console.error(`Failed to upload damage photo ${damageId}/${index}:`, err)
      failedCount++
      completed++
    }
    onProgress?.(completed, allPhotos.length)
  }

  return {
    uploadedCount: completed - failedCount,
    failedCount,
  }
}

/**
 * Upload photos for an issue.
 * Key pattern: issues/{vehicleReg}/{issueId}/{index}.jpg
 * Returns array of public URLs for the uploaded photos.
 */
export async function uploadIssuePhotos(
  photos: Blob[],
  issueId: string,
  vehicleReg: string,
): Promise<{ urls: string[]; failedCount: number }> {
  const safeReg = vehicleReg.replace(/\s+/g, '-').toUpperCase()
  const r2PublicBase = import.meta.env.VITE_R2_PUBLIC_URL || ''
  const urls: string[] = []
  let failedCount = 0

  for (let i = 0; i < photos.length; i++) {
    const key = `issues/${safeReg}/${issueId}/${i}.jpg`
    const formData = new FormData()
    formData.append('file', photos[i]!, `issue_${i}.jpg`)
    formData.append('key', key)

    try {
      const response = await fetch(apiUrl('/upload-photo'), {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      urls.push(r2PublicBase ? `${r2PublicBase}/${key}` : key)
    } catch (err) {
      console.error(`Failed to upload issue photo ${i}:`, err)
      failedCount++
    }
  }

  return { urls, failedCount }
}
