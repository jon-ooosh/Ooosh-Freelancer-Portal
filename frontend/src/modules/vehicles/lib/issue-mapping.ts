/**
 * Mapping helpers for auto-creating issues from prep/check-in items.
 *
 * Maps prep checklist item names to issue categories and components,
 * and Monday severity labels to our issue severity levels.
 */

import type { IssueCategory, IssueComponent, IssueSeverity } from '../types/issue'

/**
 * Map a prep checklist item name to an issue category.
 */
export function mapPrepItemToCategory(itemName: string): IssueCategory {
  const lower = itemName.toLowerCase()

  // Tyres & Wheels
  if (lower.includes('tyre') || lower.includes('tire') || lower.includes('wheel') || lower.includes('rim')) {
    return 'Tyres & Wheels'
  }

  // Mechanical
  if (
    lower.includes('oil') || lower.includes('coolant') || lower.includes('engine') ||
    lower.includes('brake') || lower.includes('exhaust') || lower.includes('suspension') ||
    lower.includes('gearbox') || lower.includes('steering') || lower.includes('clutch')
  ) {
    return 'Mechanical'
  }

  // Electrical
  if (
    lower.includes('light') || lower.includes('bulb') || lower.includes('battery') ||
    lower.includes('eml') || lower.includes('warning light') || lower.includes('wiper') ||
    lower.includes('heater') || lower.includes('ac') || lower.includes('air con') ||
    lower.includes('entertainment') || lower.includes('radio') || lower.includes('speaker')
  ) {
    return 'Electrical'
  }

  // Bodywork
  if (
    lower.includes('dent') || lower.includes('scratch') || lower.includes('bumper') ||
    lower.includes('panel') || lower.includes('windscreen') || lower.includes('window') ||
    lower.includes('mirror') || lower.includes('door') || lower.includes('lock') ||
    lower.includes('body') || lower.includes('paint')
  ) {
    return 'Bodywork'
  }

  // Interior
  if (
    lower.includes('seat') || lower.includes('carpet') || lower.includes('floor') ||
    lower.includes('trim') || lower.includes('interior') || lower.includes('dashboard') ||
    lower.includes('upholstery')
  ) {
    return 'Interior'
  }

  return 'Other'
}

/**
 * Map a prep checklist item name to a specific component.
 */
export function mapPrepItemToComponent(itemName: string): IssueComponent {
  const lower = itemName.toLowerCase()

  if (lower.includes('tyre') || lower.includes('tire')) return 'Tyres'
  if (lower.includes('wheel') || lower.includes('rim')) return 'Wheels/Rims'
  if (lower.includes('oil') || lower.includes('coolant') || lower.includes('engine')) return 'Engine'
  if (lower.includes('brake')) return 'Brakes'
  if (lower.includes('exhaust')) return 'Exhaust'
  if (lower.includes('suspension')) return 'Suspension'
  if (lower.includes('steering')) return 'Steering'
  if (lower.includes('gearbox') || lower.includes('clutch')) return 'Gearbox'
  if (lower.includes('light') || lower.includes('bulb')) return 'Lights'
  if (lower.includes('battery')) return 'Battery'
  if (lower.includes('eml') || lower.includes('warning light')) return 'EML'
  if (lower.includes('heater') || lower.includes('ac') || lower.includes('air con')) return 'Heating/AC'
  if (lower.includes('entertainment') || lower.includes('radio') || lower.includes('speaker')) return 'Entertainment'
  if (lower.includes('window')) return 'Windows'
  if (lower.includes('windscreen')) return 'Windscreen'
  if (lower.includes('door')) return 'Doors'
  if (lower.includes('lock')) return 'Locks'
  if (lower.includes('bumper')) return 'Bumpers'
  if (lower.includes('panel') || lower.includes('body') || lower.includes('paint') || lower.includes('dent') || lower.includes('scratch')) return 'Bodywork panels'
  if (lower.includes('seat')) return 'Seats'
  if (lower.includes('floor') || lower.includes('carpet')) return 'Floor'
  if (lower.includes('trim') || lower.includes('interior') || lower.includes('dashboard') || lower.includes('upholstery')) return 'Interior trim'

  return 'Other'
}

/**
 * Map Monday.com severity labels to our issue severity levels.
 */
export function mapMondaySeverityToIssueSeverity(severity: string): IssueSeverity {
  switch (severity) {
    case 'Critical': return 'Critical'
    case 'Major': return 'High'
    case 'Minor': return 'Medium'
    default: return 'Medium'
  }
}
