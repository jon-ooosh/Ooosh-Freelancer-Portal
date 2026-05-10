/**
 * Mapping helpers for auto-creating issues into the OP `job_issues` table.
 *
 * Distinct from the legacy `issue-mapping.ts` which mapped to the
 * pre-Stage-3 R2-backed Vehicle Issues taxonomy. The OP table has a
 * narrower 6-category vocabulary (damaged | missing | broken | dispute
 * | breakdown | other) so most mappings collapse onto `damaged` or
 * `broken`. We carry the richer detail via `component_key` (stable
 * identifier used by the dedup engine) + `summary` (free-text).
 */

export type OpIssueCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'breakdown' | 'other';
export type OpIssueSeverity = 'low' | 'normal' | 'urgent';

/**
 * Stable identifier for "the same thing". Same item across multiple
 * prep sessions resolves to the same key, so the dedup engine matches
 * (vehicle, component_key, open) and appends a reflag event instead
 * of breeding duplicates.
 *
 * Keep curated keys for the high-volume prep items; fall through to a
 * normalised slug for the rest. Adding a new curated key is safe — the
 * slug for that item would have been unique anyway, so old + new key
 * coexist without collision.
 */
export function mapPrepItemToComponentKey(itemName: string): string {
  const lower = itemName.toLowerCase().trim();

  // Curated stable keys for the most common recurring items
  if (lower.includes('fire extinguisher')) return 'fire_extinguisher';
  if (lower.includes('bodywork')) return 'bodywork_panels';
  if (lower.includes('windscreen')) return 'windscreen';
  if (lower.includes('window')) return 'windows';
  if (lower.includes('mirror')) return 'wing_mirror';
  if (lower.includes('seat belt')) return 'seat_belts';
  if (lower.includes('seat')) return 'seats';
  if (lower.includes('tyre') || lower.includes('tire')) return 'tyres';
  if (lower.includes('wheel') || lower.includes('rim')) return 'wheels';
  if (lower.includes('brake')) return 'brakes';
  if (lower.includes('oil')) return 'oil';
  if (lower.includes('coolant')) return 'coolant';
  if (lower.includes('engine')) return 'engine';
  if (lower.includes('exhaust')) return 'exhaust';
  if (lower.includes('suspension')) return 'suspension';
  if (lower.includes('steering')) return 'steering';
  if (lower.includes('clutch') || lower.includes('gearbox')) return 'gearbox';
  if (lower.includes('light') || lower.includes('bulb')) return 'lights';
  if (lower.includes('battery')) return 'battery';
  if (lower.includes('eml') || lower.includes('warning light')) return 'warning_lights';
  if (lower.includes('heater') || lower.includes('ac') || lower.includes('air con')) return 'climate';
  if (lower.includes('door')) return 'doors';
  if (lower.includes('lock')) return 'locks';
  if (lower.includes('wiper')) return 'wipers';
  if (lower.includes('bumper')) return 'bumpers';

  // Fall through to a normalised slug. Strips non-alphanumeric, collapses
  // whitespace, lowercases. Bounded to 60 chars to stay under the DB cap.
  return lower
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'unknown';
}

/**
 * Map a prep item name → OP category. Most prep flags surface visible
 * damage (cosmetic / bodywork → `damaged`) or functional failure
 * (mechanical / electrical → `broken`). Anything missing-shaped maps
 * to `missing`. Everything else → `other`.
 */
export function mapPrepItemToOpCategory(itemName: string): OpIssueCategory {
  const lower = itemName.toLowerCase();

  // Functional failures — engine / brakes / electrical / etc.
  if (
    lower.includes('engine') || lower.includes('oil') || lower.includes('coolant') ||
    lower.includes('brake') || lower.includes('exhaust') || lower.includes('suspension') ||
    lower.includes('clutch') || lower.includes('gearbox') || lower.includes('steering') ||
    lower.includes('light') || lower.includes('bulb') || lower.includes('battery') ||
    lower.includes('eml') || lower.includes('warning') || lower.includes('wiper') ||
    lower.includes('heater') || lower.includes('ac') || lower.includes('air con') ||
    lower.includes('lock') || lower.includes('fire extinguisher')
  ) {
    return 'broken';
  }

  // Missing items
  if (lower.includes('missing') || lower.includes('absent')) {
    return 'missing';
  }

  // Visible damage — bodywork / interior / windows / mirrors / tyres
  if (
    lower.includes('dent') || lower.includes('scratch') || lower.includes('bumper') ||
    lower.includes('panel') || lower.includes('windscreen') || lower.includes('window') ||
    lower.includes('mirror') || lower.includes('door') || lower.includes('body') ||
    lower.includes('paint') || lower.includes('seat') || lower.includes('carpet') ||
    lower.includes('floor') || lower.includes('trim') || lower.includes('interior') ||
    lower.includes('dashboard') || lower.includes('upholstery') ||
    lower.includes('tyre') || lower.includes('tire') || lower.includes('wheel') ||
    lower.includes('clean') || lower.includes('dirty')
  ) {
    return 'damaged';
  }

  return 'other';
}

/**
 * Severity mapping. Inputs:
 * - Legacy prep severity labels: 'Critical' | 'Major' | 'Minor' | other
 * - Legacy NewIssuePage severity: 'Critical' | 'High' | 'Medium' | 'Low'
 * - Already-typed OP values: 'urgent' | 'normal' | 'low'
 */
export function mapSeverityToOpSeverity(severity: string | null | undefined): OpIssueSeverity {
  if (!severity) return 'normal';
  const s = severity.toLowerCase();
  if (s === 'urgent' || s === 'critical' || s === 'high' || s === 'major') return 'urgent';
  if (s === 'low' || s === 'minor') return 'low';
  // 'medium', 'normal', everything else → normal
  return 'normal';
}

/**
 * Map legacy NewIssuePage category enum to OP category. Used by
 * manual create from NewIssuePage; the prep / check-in auto-create
 * paths use mapPrepItemToOpCategory based on the item NAME, not the
 * category enum.
 */
export function mapLegacyCategoryToOpCategory(
  category: string | null | undefined,
  component?: string | null,
): OpIssueCategory {
  const c = (category || '').toLowerCase();
  // Mechanical / Electrical / Tyres & Wheels = functional → broken
  if (c.includes('mechanical') || c.includes('electrical') || c.includes('tyre')) {
    return 'broken';
  }
  // Bodywork / Interior = visible → damaged
  if (c.includes('bodywork') || c.includes('interior')) {
    return 'damaged';
  }
  // Other — refine by component if we can
  if (component) {
    const lower = component.toLowerCase();
    if (lower.includes('missing')) return 'missing';
  }
  return 'other';
}
