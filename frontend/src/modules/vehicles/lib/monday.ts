/**
 * Monday.com API client.
 * All requests go through our Netlify function proxy to keep the API token server-side.
 */

import { apiFetch } from '../config/api-config'

export interface MondayResponse<T = unknown> {
  data?: T
  errors?: Array<{ message: string; locations?: unknown[] }>
  account_id?: number
}

export async function mondayQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await apiFetch('/monday', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Monday.com API error: ${response.status}`)
  }

  const result = (await response.json()) as MondayResponse<T>

  if (result.errors?.length) {
    throw new Error(`Monday.com GraphQL error: ${result.errors[0]!.message}`)
  }

  if (!result.data) {
    throw new Error('Monday.com API returned no data')
  }

  return result.data
}

// Board IDs - populated from environment or config
export const BOARD_IDS = {
  fleet: import.meta.env.VITE_MONDAY_BOARD_FLEET || '4255233576',
  events: import.meta.env.VITE_MONDAY_BOARD_EVENTS || '18400365307',
  issues: import.meta.env.VITE_MONDAY_BOARD_ISSUES || '18400365329',
  settings: import.meta.env.VITE_MONDAY_BOARD_SETTINGS || '18400365348',
  hires: import.meta.env.VITE_MONDAY_BOARD_HIRES || '2431480012',
  driverHireForms: import.meta.env.VITE_MONDAY_BOARD_DRIVER_HIRE_FORMS || '841453886',
  dc: import.meta.env.VITE_MONDAY_BOARD_DC || '2028045828',
} as const
