/**
 * Shared display helpers for held items.
 */

/**
 * Human label for where a held item is stored. The "Somewhere else" picklist
 * option keeps the real detail in `storage_location_text` ("storage room 2"),
 * so when that's the chosen location we surface the typed text rather than the
 * unhelpful "Somewhere else".
 */
export function locationLabel(h: { storage_location_name?: string | null; storage_location_text?: string | null }): string {
  const name = h.storage_location_name?.trim();
  const text = h.storage_location_text?.trim();
  if (text && (!name || name.toLowerCase() === 'somewhere else')) return text;
  return name || text || '';
}

/** Same as locationLabel but yields '—' when nothing is set (for table cells). */
export function locationLabelOrDash(h: { storage_location_name?: string | null; storage_location_text?: string | null }): string {
  return locationLabel(h) || '—';
}
