/**
 * Hardcoded vehicle prep checklist — migrated from JotForm (form 210983914308055).
 *
 * All vehicle types currently share the same checklist. The `vehicleType` param
 * is reserved for future per-type filtering (e.g. Panel vans skip Passenger Area).
 *
 * When the in-app settings page is built, this config will be replaced by a
 * database-backed source — the rest of the app consumes the same ChecklistItem
 * interface and won't need changes.
 */

import type { ChecklistItem, DetailPrompt } from '../lib/settings-api'

// ── Reusable detail prompts ──

const FLUID_TOPUP: Record<string, DetailPrompt> = {
  'Topped up': {
    label: 'Approx. amount added?',
    type: 'options',
    choices: ['< 500ml', '~500ml', '~1L', '~1.5L', '~2L', '2L+', 'Full refill'],
  },
}

const HEADLIGHT_BULB_REPLACED: Record<string, DetailPrompt> = {
  'Replaced bulb(s) & now all working': {
    label: 'Which bulb(s)?',
    type: 'multi',
    choices: [
      'Front L — Main', 'Front L — Dipped', 'Front L — Fog', 'Front L — DRL',
      'Front R — Main', 'Front R — Dipped', 'Front R — Fog', 'Front R — DRL',
    ],
  },
}

const INDICATOR_BULB_REPLACED: Record<string, DetailPrompt> = {
  'Replaced bulb(s) & now all working': {
    label: 'Which bulb(s)?',
    type: 'multi',
    choices: [
      'Front left', 'Front right', 'Rear left', 'Rear right', 'Side marker',
    ],
  },
}

const REAR_LIGHT_BULB_REPLACED: Record<string, DetailPrompt> = {
  'Replaced bulb(s) & now all working': {
    label: 'Which bulb(s)?',
    type: 'multi',
    choices: [
      'Rear L — Tail/Brake', 'Rear L — Indicator', 'Rear L — Reverse', 'Rear L — Fog',
      'Rear R — Tail/Brake', 'Rear R — Indicator', 'Rear R — Reverse', 'Rear R — Fog',
      'Number plate',
    ],
  },
}

const WIPER_REPLACED: Record<string, DetailPrompt> = {
  'Replaced wiper(s) & now all working': {
    label: 'Which wiper(s)?',
    type: 'multi',
    choices: ['Driver side', 'Passenger side', 'Rear'],
  },
}

const FIXED_ISSUE: Record<string, DetailPrompt> = {
  'Fixed & now all working': {
    label: 'What was fixed?',
    type: 'options',
    choices: ['Loose connection', 'Replaced fuse', 'Replaced socket', 'Reset / reboot', 'Other'],
  },
}

const REPLACED_PRESENT: Record<string, DetailPrompt> = {
  'Replaced & now all present': {
    label: 'What was replaced?',
    type: 'text',
  },
}

const REPLACED_PRESENT_SINGLE: Record<string, DetailPrompt> = {
  'Replaced & now present': {
    label: 'What was replaced?',
    type: 'text',
  },
}

// ── Section definitions ──

interface PrepSection {
  name: string
  items: ChecklistItem[]
}

const VEHICLE_EXTERIOR: ChecklistItem[] = [
  {
    name: 'Bodywork',
    inputType: 'options',
    options: ['Washed and clean', 'To be cleaned'],
    flagValues: ['To be cleaned'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Windscreen',
    inputType: 'options',
    options: ['Ok', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Other glass',
    inputType: 'options',
    options: ['Ok', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Wingmirrors',
    inputType: 'options',
    options: ['Ok', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Doors and locks (inc deadlocks)',
    inputType: 'options',
    options: ['All working fine', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Orange side marker lights',
    inputType: 'options',
    options: ['All working fine', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Spare wheel',
    inputType: 'options',
    options: ['Present & tagged', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  // Tyre measurements — 4 wheels × (PSI + tread depth)
  {
    name: 'Front left tyre pressure',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'PSI',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Front left tyre tread depth',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'mm',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Front right tyre pressure',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'PSI',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Front right tyre tread depth',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'mm',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Rear left tyre pressure',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'PSI',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Rear left tyre tread depth',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'mm',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Rear right tyre pressure',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'PSI',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
  {
    name: 'Rear right tyre tread depth',
    inputType: 'number',
    options: [],
    flagValues: [],
    notes: '',
    unit: 'mm',
    section: 'Vehicle Exterior',
    detailPrompts: {},
  },
]

const ENGINE: ChecklistItem[] = [
  {
    name: 'Oil level',
    inputType: 'options',
    options: ['Ok', 'Topped up', 'Problem'],
    flagValues: ['Problem'],
    notes: 'Should be 1/2 full',
    unit: '',
    section: 'Engine',
    detailPrompts: FLUID_TOPUP,
  },
  {
    name: 'Water / coolant level',
    inputType: 'options',
    options: ['Ok', 'Topped up', 'Problem'],
    flagValues: ['Problem'],
    notes: 'At the half way rim',
    unit: '',
    section: 'Engine',
    detailPrompts: FLUID_TOPUP,
  },
  {
    name: 'Screen wash level',
    inputType: 'options',
    options: ['Ok', 'Topped up', 'Problem'],
    flagValues: ['Problem'],
    notes: 'At least half full',
    unit: '',
    section: 'Engine',
    detailPrompts: FLUID_TOPUP,
  },
  {
    name: 'Ad Blue level',
    inputType: 'options',
    options: ['Ok', 'Topped up', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: 'Please fill',
    unit: '',
    section: 'Engine',
    detailPrompts: FLUID_TOPUP,
  },
]

const FRONT_CAB: ChecklistItem[] = [
  {
    name: 'Indicators',
    inputType: 'options',
    options: ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: INDICATOR_BULB_REPLACED,
  },
  {
    name: 'Headlights',
    inputType: 'options',
    options: ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: HEADLIGHT_BULB_REPLACED,
  },
  {
    name: 'Rear lights',
    inputType: 'options',
    options: ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REAR_LIGHT_BULB_REPLACED,
  },
  {
    name: 'Windscreen wipers',
    inputType: 'options',
    options: ['Tested & working', 'Replaced wiper(s) & now all working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: WIPER_REPLACED,
  },
  {
    name: 'Front stereo',
    inputType: 'options',
    options: ['Tested & working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Horn',
    inputType: 'options',
    options: ['Tested & working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Heating & AC',
    inputType: 'options',
    options: ['Tested & working', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Electric windows',
    inputType: 'options',
    options: ['Tested & working', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Power sockets — 240v & 12v (cab)',
    inputType: 'options',
    options: ['Tested & all working ok', 'Fixed & now all working', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: FIXED_ISSUE,
  },
  {
    name: 'Fire extinguisher',
    inputType: 'options',
    options: ['Present', 'Problem'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Scraper & de-icer',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Spare bulbs, torch',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Info stickers (height, AdBlue top up etc)',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Ooosh info pack',
    inputType: 'options',
    options: ['Present', 'Replaced & now present', 'N/A'],
    flagValues: [],
    notes: 'Insurance, V5, breakdown info, accident info, vehicle use guide',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT_SINGLE,
  },
  {
    name: 'Tools & jack',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Fuel can & triangle',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Hi vis jackets',
    inputType: 'options',
    options: ['Present', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Front seat belts',
    inputType: 'options',
    options: ['All working ok', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Windows & windscreen wiped and clean',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Storage compartments & door storage empty & clean',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'All surfaces, controls and seats wiped & hoovered',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
  {
    name: 'Floor hoovered & mopped (cab)',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Front Cab',
    detailPrompts: {},
  },
]

const PASSENGER_AREA: ChecklistItem[] = [
  {
    name: 'Seats are',
    inputType: 'options',
    options: ['Around a table', 'Forward-facing', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Seat belts',
    inputType: 'options',
    options: ['Tested & all working ok', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Entertainment (TV / wifi / PS4 etc)',
    inputType: 'options',
    options: ['Tested & all working ok', 'Fixed & now all working', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: FIXED_ISSUE,
  },
  {
    name: 'Remotes for entertainment',
    inputType: 'options',
    options: ['All present & tested', 'Replaced & now all present', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: REPLACED_PRESENT,
  },
  {
    name: 'Power sockets — 240v & 12v (passenger)',
    inputType: 'options',
    options: ['Tested & all working ok', 'Fixed & now all working', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: FIXED_ISSUE,
  },
  {
    name: 'Interior lights',
    inputType: 'options',
    options: ['Tested & all working ok', 'Fixed & now all working', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: FIXED_ISSUE,
  },
  {
    name: 'Dustpan & brush present',
    inputType: 'options',
    options: ['Yes', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Windows wiped and clean',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'All surfaces wiped & hoovered',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Soft bunk hoovered & clean',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Table and cupholders wiped & clean',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
  {
    name: 'Floor hoovered & mopped (passenger)',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Passenger Area',
    detailPrompts: {},
  },
]

const BOOT: ChecklistItem[] = [
  {
    name: 'Loading lights',
    inputType: 'options',
    options: ['Tested & all working ok', 'Fixed & now all working', 'N/A'],
    flagValues: [],
    notes: '',
    unit: '',
    section: 'Boot',
    detailPrompts: FIXED_ISSUE,
  },
  {
    name: 'Floor hoovered & mopped (boot)',
    inputType: 'options',
    options: ['All clean', 'Problem', 'N/A'],
    flagValues: ['Problem'],
    notes: '',
    unit: '',
    section: 'Boot',
    detailPrompts: {},
  },
]

// ── All sections in order ──

const ALL_SECTIONS: PrepSection[] = [
  { name: 'Vehicle Exterior', items: VEHICLE_EXTERIOR },
  { name: 'Engine', items: ENGINE },
  { name: 'Front Cab', items: FRONT_CAB },
  { name: 'Passenger Area', items: PASSENGER_AREA },
  { name: 'Boot', items: BOOT },
]

/**
 * Get all prep checklist items as a flat array.
 * @param _vehicleType - reserved for future per-type filtering
 */
export function getPrepChecklist(_vehicleType: string): ChecklistItem[] {
  // Future: filter sections/items by vehicle type (e.g. Panel vans skip Passenger Area)
  return ALL_SECTIONS.flatMap(s => s.items)
}

/**
 * Get prep checklist items grouped by section.
 * @param _vehicleType - reserved for future per-type filtering
 */
export function getPrepSections(_vehicleType: string): PrepSection[] {
  // Future: filter sections by vehicle type
  return ALL_SECTIONS
}
