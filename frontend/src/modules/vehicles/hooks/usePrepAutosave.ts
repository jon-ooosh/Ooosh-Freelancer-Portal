/**
 * localStorage autosave hook for vehicle prep sessions.
 *
 * Saves all form state except photo Blobs (which cannot be serialized).
 * On resume, checklist answers, notes, and flagged item descriptions are
 * restored but photos need to be re-captured.
 */

import { useRef, useCallback } from 'react'
import type { FuelLevel } from '../types/vehicle-event'

const STORAGE_PREFIX = 'prep_progress_'
const DEBOUNCE_MS = 500

export interface SavedPrepState {
  vehicleReg: string
  savedAt: number
  preparedBy: string
  mileage: string
  fuelLevel: FuelLevel | null
  responses: Record<string, string>
  sectionNotes: Record<string, string>
  flaggedItems: Array<{
    itemName: string
    selectedOption: string
    severity: 'Critical' | 'Major' | 'Minor'
    description: string
    // photos NOT saved — Blob objects cannot survive JSON serialization
  }>
  responseDetails: Record<string, string>
  prepStartedAt: string | null
  overallStatus: string
}

function getKey(vehicleReg: string): string {
  return `${STORAGE_PREFIX}${vehicleReg}`
}

export function usePrepAutosave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback((vehicleReg: string, state: SavedPrepState) => {
    // Debounce writes
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(getKey(vehicleReg), JSON.stringify(state))
      } catch (err) {
        console.warn('[prep-autosave] Failed to save:', err)
      }
    }, DEBOUNCE_MS)
  }, [])

  const load = useCallback((vehicleReg: string): SavedPrepState | null => {
    try {
      const raw = localStorage.getItem(getKey(vehicleReg))
      if (!raw) return null
      return JSON.parse(raw) as SavedPrepState
    } catch {
      return null
    }
  }, [])

  const clear = useCallback((vehicleReg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    try {
      localStorage.removeItem(getKey(vehicleReg))
    } catch {
      // Ignore
    }
  }, [])

  const hasSaved = useCallback((vehicleReg: string): boolean => {
    try {
      return localStorage.getItem(getKey(vehicleReg)) !== null
    } catch {
      return false
    }
  }, [])

  return { save, load, clear, hasSaved }
}
