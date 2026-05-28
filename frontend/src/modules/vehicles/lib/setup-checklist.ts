/**
 * New-vehicle setup checklist — the off-system jobs that are easy to forget when
 * onboarding a van (add to insurance policy, TTS360, HireHop, log dates, etc.).
 *
 * The canonical item list lives here. Completion state is stored per-vehicle in
 * `fleet_vehicles.setup_checklist` (migration 089). An EMPTY stored array means
 * "no checklist started" (legacy vehicles) and is NOT treated as pending — only
 * a non-empty list with unticked items counts as "setup pending".
 */

import type { SetupChecklistItem } from '../types/vehicle'

export const DEFAULT_SETUP_ITEMS: { key: string; label: string }[] = [
  { key: 'added_insurance', label: 'Added to fleet insurance policy' },
  { key: 'added_tts360', label: 'Added to TTS360' },
  { key: 'added_tracker', label: 'Added to Traccar tracker' },
  { key: 'mot_logged', label: 'MOT date logged' },
  { key: 'tax_logged', label: 'Tax date logged' },
  { key: 'v5_received', label: 'V5 received' },
  { key: 'service_plan', label: 'Service plan set up' },
  { key: 'added_hirehop', label: 'Added to HireHop' },
]

/** A fresh, all-unticked checklist for a brand-new vehicle. */
export function buildDefaultChecklist(): SetupChecklistItem[] {
  return DEFAULT_SETUP_ITEMS.map(i => ({ key: i.key, label: i.label, done: false }))
}

/**
 * Merge a stored checklist with the canonical defaults: keeps stored done-state
 * by key, picks up any new default items added since, and preserves any custom
 * stored items not in the defaults (forward-compatible).
 */
export function mergeChecklist(stored: SetupChecklistItem[] | undefined | null): SetupChecklistItem[] {
  const storedList = Array.isArray(stored) ? stored : []
  if (storedList.length === 0) return []
  const byKey = new Map(storedList.map(i => [i.key, i]))
  const merged: SetupChecklistItem[] = DEFAULT_SETUP_ITEMS.map(d => {
    const existing = byKey.get(d.key)
    return existing
      ? { key: d.key, label: d.label, done: !!existing.done, doneAt: existing.doneAt ?? null, doneBy: existing.doneBy ?? null }
      : { key: d.key, label: d.label, done: false }
  })
  // Keep any stored items that aren't in the canonical defaults
  for (const s of storedList) {
    if (!DEFAULT_SETUP_ITEMS.some(d => d.key === s.key)) merged.push(s)
  }
  return merged
}

/** A vehicle is "setup pending" when its checklist has been started and has unticked items. */
export function isSetupPending(checklist: SetupChecklistItem[] | undefined | null): boolean {
  const list = Array.isArray(checklist) ? checklist : []
  return list.length > 0 && list.some(i => !i.done)
}

/** { done, total } counts for a started checklist (0/0 when not started). */
export function checklistProgress(checklist: SetupChecklistItem[] | undefined | null): { done: number; total: number } {
  const list = mergeChecklist(checklist)
  return { done: list.filter(i => i.done).length, total: list.length }
}
