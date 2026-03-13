/**
 * Settings API — fetches checklist settings from R2 storage.
 *
 * Settings are stored at `settings/checklists.json` in R2, managed via
 * the Settings > Checklists tab in the app.
 *
 * Data shape:
 *   briefingItems: { "All": [...], "Premium": [...], ... }
 *   prepItems:     { "All": [...], "Premium": [...], ... }
 *
 * Briefing items are simple checklists (checkbox per item).
 * Prep items support options, number inputs, text inputs, flag values,
 * detail prompts, and section grouping.
 */

import { apiFetch } from '../config/api-config'

// ── Public types ──

/**
 * Follow-up detail prompt shown after selecting a work-done option.
 *
 * - `type: 'text'` → free-text input with a label (original behaviour)
 * - `type: 'options'` → predefined pill picker (structured, analysable data)
 * - `type: 'multi'` → predefined pill picker allowing multiple selections
 */
export interface DetailPrompt {
  label: string              // Prompt label shown above the input (e.g. "Approx. amount added?")
  type: 'text' | 'options' | 'multi'
  choices?: string[]         // Predefined choices for 'options' / 'multi' types
}

export interface ChecklistItem {
  name: string                              // Item name = checklist label
  inputType: 'options' | 'number' | 'text'  // Derived from Value column
  options: string[]                         // For 'options' type: the choices
  flagValues: string[]                      // Options that trigger issue creation
  notes: string                             // Helper text under the item
  unit: string                              // For 'number' type: "PSI", "mm", etc.
  section: string                           // Section grouping: "Engine", "Exterior", etc.
  detailPrompts: Record<string, DetailPrompt>  // Maps option value → follow-up detail prompt
}

export interface SettingsData {
  /** Briefing checklist items keyed by vehicle type or "All" */
  briefingItems: Record<string, ChecklistItem[]>
  /** Prep checklist items keyed by vehicle type or "All" */
  prepItems: Record<string, ChecklistItem[]>
}

/**
 * Get merged checklist items: "All" items + type-specific items.
 * Returns items in order: All first, then type-specific additions.
 * De-duplicates by item name.
 */
export function getChecklistItems(
  itemsMap: Record<string, ChecklistItem[]>,
  vehicleType: string,
): ChecklistItem[] {
  const allItems = itemsMap['All'] || []
  const typeItems = itemsMap[vehicleType] || []
  const seen = new Set<string>()
  const merged: ChecklistItem[] = []
  for (const item of [...allItems, ...typeItems]) {
    if (!seen.has(item.name)) {
      seen.add(item.name)
      merged.push(item)
    }
  }
  return merged
}

/**
 * Get prep items grouped by section for a given vehicle type.
 * Merges "All" + type-specific items, then groups by section name.
 */
export function getPrepSections(
  itemsMap: Record<string, ChecklistItem[]>,
  vehicleType: string,
): { name: string; items: ChecklistItem[] }[] {
  const items = getChecklistItems(itemsMap, vehicleType)
  const sectionOrder: string[] = []
  const sectionMap: Record<string, ChecklistItem[]> = {}
  for (const item of items) {
    const section = item.section || 'General'
    if (!sectionMap[section]) {
      sectionOrder.push(section)
      sectionMap[section] = []
    }
    sectionMap[section]!.push(item)
  }
  return sectionOrder.map(name => ({ name, items: sectionMap[name]! }))
}

/**
 * Fetch all checklist settings from R2.
 */
export async function fetchSettings(): Promise<SettingsData> {
  try {
    console.log('[settings-api] Fetching settings from R2')
    const resp = await apiFetch('/get-checklist-settings')

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }

    const data = await resp.json() as SettingsData & { updatedAt?: string }
    console.log('[settings-api] Settings loaded from R2',
      data.updatedAt ? `(updated ${data.updatedAt})` : '')
    return { briefingItems: data.briefingItems || {}, prepItems: data.prepItems || {} }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Settings fetch failed'
    console.error('[settings-api] Failed to fetch settings:', errMsg)
    throw err
  }
}

/**
 * Save checklist settings to R2.
 */
export async function saveSettings(
  data: SettingsData,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/save-checklist-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, error: err.error || `HTTP ${resp.status}` }
    }
    return { success: true }
  } catch (err) {
    console.warn('[settings-api] Failed to save settings:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}
