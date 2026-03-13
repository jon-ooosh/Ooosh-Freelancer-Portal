/**
 * React Query hook for checklist settings.
 *
 * Fetches briefing and prep checklist items from the Monday.com Settings board.
 * Long staleTime (10min) since settings rarely change during a session.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchSettings } from '../lib/settings-api'
import type { SettingsData } from '../lib/settings-api'

export function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 10 * 60 * 1000,   // 10 min
    gcTime: 30 * 60 * 1000,      // 30 min
  })
}
