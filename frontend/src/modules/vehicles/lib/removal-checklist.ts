/**
 * Vehicle removal checklist — the off-system jobs that are easy to forget when
 * a van LEAVES the fleet (mirror of the new-vehicle setup checklist). Some of
 * these land days apart in real life — notably the DVLA confirmation, which
 * usually arrives 1–2 weeks after notifying — so the checklist is seeded when
 * a vehicle is marked sold and stays editable afterwards.
 *
 * Completion state is stored per-vehicle in `fleet_vehicles.removal_checklist`
 * (migration 103). Shape mirrors setup_checklist: { key, label, done, doneAt,
 * doneBy }. Visible to ALL staff (operational, not a finance concern).
 */

import type { SetupChecklistItem } from '../types/vehicle'

export const DEFAULT_REMOVAL_ITEMS: { key: string; label: string }[] = [
  { key: 'removed_hirehop', label: 'Removed from HireHop' },
  { key: 'removed_tts360', label: 'Removed from TTS360' },
  { key: 'removed_insurers', label: 'Removed from insurers' },
  { key: 'notified_dvla', label: 'Notified DVLA' },
  { key: 'dvla_confirmed', label: 'Received DVLA confirmation (1–2 weeks after notifying)' },
]

/** A fresh, all-unticked removal checklist — seeded when a vehicle is sold. */
export function buildDefaultRemovalChecklist(): SetupChecklistItem[] {
  return DEFAULT_REMOVAL_ITEMS.map(i => ({ key: i.key, label: i.label, done: false }))
}

/**
 * Merge a stored removal checklist with the canonical defaults: keeps stored
 * done-state by key, picks up any new default items added since, and preserves
 * any custom stored items not in the defaults (forward-compatible).
 */
export function mergeRemovalChecklist(stored: SetupChecklistItem[] | undefined | null): SetupChecklistItem[] {
  const storedList = Array.isArray(stored) ? stored : []
  if (storedList.length === 0) return []
  const byKey = new Map(storedList.map(i => [i.key, i]))
  const merged: SetupChecklistItem[] = DEFAULT_REMOVAL_ITEMS.map(d => {
    const existing = byKey.get(d.key)
    return existing
      ? { key: d.key, label: d.label, done: !!existing.done, doneAt: existing.doneAt ?? null, doneBy: existing.doneBy ?? null }
      : { key: d.key, label: d.label, done: false }
  })
  for (const s of storedList) {
    if (!DEFAULT_REMOVAL_ITEMS.some(d => d.key === s.key)) merged.push(s)
  }
  return merged
}

/** { done, total } counts for a started removal checklist (0/0 when not started). */
export function removalProgress(checklist: SetupChecklistItem[] | undefined | null): { done: number; total: number } {
  const list = mergeRemovalChecklist(checklist)
  return { done: list.filter(i => i.done).length, total: list.length }
}

/** A removal checklist is "incomplete" when started and has unticked items. */
export function isRemovalIncomplete(checklist: SetupChecklistItem[] | undefined | null): boolean {
  const list = Array.isArray(checklist) ? checklist : []
  return list.length > 0 && list.some(i => !i.done)
}
