/**
 * Default checklist settings — used to seed R2 on first load.
 *
 * Contains all briefing + prep items that were previously hardcoded.
 * Once saved to R2, the app reads from R2 and this file is only used
 * as a fallback if R2 returns empty.
 */

import type { ChecklistItem, DetailPrompt, SettingsData } from '../lib/settings-api'

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

// ── Helper ──
function item(
  name: string,
  section: string,
  options: string[],
  flagValues: string[],
  extra?: { inputType?: 'number' | 'text'; unit?: string; notes?: string; detailPrompts?: Record<string, DetailPrompt> },
): ChecklistItem {
  return {
    name,
    inputType: extra?.inputType || 'options',
    options: extra?.inputType === 'number' || extra?.inputType === 'text' ? [] : options,
    flagValues,
    notes: extra?.notes || '',
    unit: extra?.unit || '',
    section,
    detailPrompts: extra?.detailPrompts || {},
  }
}

// ── Briefing items (from Monday.com board screenshots) ──

const BRIEFING_ALL: ChecklistItem[] = [
  item("I've shown client QR codes to access our online guides/help", '', [], []),
  item("I've shown client how to put the lights on in the boot", '', [], []),
]

const BRIEFING_PREMIUM: ChecklistItem[] = [
  item("I've shown client how to use the deadlocks", '', [], []),
  item("I've shown client how to turn on TV/Apple TV & where remotes are", '', [], []),
  item("I've shown client where the wifi password is (in info pack and through QR code)", '', [], []),
  item("I've shown client where the power & reversing horn switches are (above central front passenger seat)", '', [], []),
]

const BRIEFING_BASIC: ChecklistItem[] = [
  item("I've shown client how to use the TV/DVD player", '', [], []),
  item("I've shown client where the power & light switches are (by side of steering wheel)", '', [], []),
]

const BRIEFING_PANEL: ChecklistItem[] = []

const BRIEFING_VITO: ChecklistItem[] = [
  item("I've explained to client about the reversing sensors / camera", '', [], []),
]

// ── Prep items (from prep-checklist.ts) ──

const PREP_ALL: ChecklistItem[] = [
  // Vehicle Exterior
  item('Bodywork', 'Vehicle Exterior', ['Washed and clean', 'To be cleaned'], ['To be cleaned']),
  item('Windscreen', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Other glass', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Wingmirrors', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Doors and locks (inc deadlocks)', 'Vehicle Exterior', ['All working fine', 'Problem'], ['Problem']),
  item('Orange side marker lights', 'Vehicle Exterior', ['All working fine', 'Problem'], ['Problem']),
  item('Spare wheel', 'Vehicle Exterior', ['Present & tagged', 'Problem'], ['Problem']),
  item('Front left tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Front left tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm' }),
  item('Front right tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Front right tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm' }),
  item('Rear left tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Rear left tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm' }),
  item('Rear right tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Rear right tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm' }),

  // Engine
  item('Oil level', 'Engine', ['Ok', 'Topped up', 'Problem'], ['Problem'], { notes: 'Should be 1/2 full', detailPrompts: FLUID_TOPUP }),
  item('Water / coolant level', 'Engine', ['Ok', 'Topped up', 'Problem'], ['Problem'], { notes: 'At the half way rim', detailPrompts: FLUID_TOPUP }),
  item('Screen wash level', 'Engine', ['Ok', 'Topped up', 'Problem'], ['Problem'], { notes: 'At least half full', detailPrompts: FLUID_TOPUP }),
  item('Ad Blue level', 'Engine', ['Ok', 'Topped up', 'Problem', 'N/A'], ['Problem'], { notes: 'Please fill', detailPrompts: FLUID_TOPUP }),

  // Front Cab
  item('Indicators', 'Front Cab', ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'], ['Problem'], { detailPrompts: INDICATOR_BULB_REPLACED }),
  item('Headlights', 'Front Cab', ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'], ['Problem'], { detailPrompts: HEADLIGHT_BULB_REPLACED }),
  item('Rear lights', 'Front Cab', ['Tested & working', 'Replaced bulb(s) & now all working', 'Problem'], ['Problem'], { detailPrompts: REAR_LIGHT_BULB_REPLACED }),
  item('Windscreen wipers', 'Front Cab', ['Tested & working', 'Replaced wiper(s) & now all working', 'Problem'], ['Problem'], { detailPrompts: WIPER_REPLACED }),
  item('Front stereo', 'Front Cab', ['Tested & working', 'Problem'], ['Problem']),
  item('Horn', 'Front Cab', ['Tested & working', 'Problem'], ['Problem']),
  item('Heating & AC', 'Front Cab', ['Tested & working', 'Problem', 'N/A'], ['Problem']),
  item('Electric windows', 'Front Cab', ['Tested & working', 'Problem'], ['Problem']),
  item('Power sockets — 240v & 12v (cab)', 'Front Cab', ['Tested & all working ok', 'Fixed & now all working', 'N/A'], [], { detailPrompts: FIXED_ISSUE }),
  item('Fire extinguisher', 'Front Cab', ['Present', 'Problem'], ['Problem']),
  item('Scraper & de-icer', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Spare bulbs, torch', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Info stickers (height, AdBlue top up etc)', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Ooosh info pack', 'Front Cab', ['Present', 'Replaced & now present', 'N/A'], [], { notes: 'Insurance, V5, breakdown info, accident info, vehicle use guide', detailPrompts: REPLACED_PRESENT_SINGLE }),
  item('Tools & jack', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Fuel can & triangle', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Hi vis jackets', 'Front Cab', ['Present', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Front seat belts', 'Front Cab', ['All working ok', 'Problem', 'N/A'], ['Problem']),
  item('Windows & windscreen wiped and clean', 'Front Cab', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('Storage compartments & door storage empty & clean', 'Front Cab', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('All surfaces, controls and seats wiped & hoovered', 'Front Cab', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('Floor hoovered & mopped (cab)', 'Front Cab', ['All clean', 'Problem', 'N/A'], ['Problem']),

  // Passenger Area
  item('Seats are', 'Passenger Area', ['Around a table', 'Forward-facing', 'N/A'], []),
  item('Seat belts', 'Passenger Area', ['Tested & all working ok', 'Problem', 'N/A'], ['Problem']),
  item('Entertainment (TV / wifi / PS4 etc)', 'Passenger Area', ['Tested & all working ok', 'Fixed & now all working', 'N/A'], [], { detailPrompts: FIXED_ISSUE }),
  item('Remotes for entertainment', 'Passenger Area', ['All present & tested', 'Replaced & now all present', 'N/A'], [], { detailPrompts: REPLACED_PRESENT }),
  item('Power sockets — 240v & 12v (passenger)', 'Passenger Area', ['Tested & all working ok', 'Fixed & now all working', 'N/A'], [], { detailPrompts: FIXED_ISSUE }),
  item('Interior lights', 'Passenger Area', ['Tested & all working ok', 'Fixed & now all working', 'N/A'], [], { detailPrompts: FIXED_ISSUE }),
  item('Dustpan & brush present', 'Passenger Area', ['Yes', 'Problem', 'N/A'], ['Problem']),
  item('Windows wiped and clean', 'Passenger Area', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('All surfaces wiped & hoovered', 'Passenger Area', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('Soft bunk hoovered & clean', 'Passenger Area', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('Table and cupholders wiped & clean', 'Passenger Area', ['All clean', 'Problem', 'N/A'], ['Problem']),
  item('Floor hoovered & mopped (passenger)', 'Passenger Area', ['All clean', 'Problem', 'N/A'], ['Problem']),

  // Boot
  item('Loading lights', 'Boot', ['Tested & all working ok', 'Fixed & now all working', 'N/A'], [], { detailPrompts: FIXED_ISSUE }),
  item('Floor hoovered & mopped (boot)', 'Boot', ['All clean', 'Problem', 'N/A'], ['Problem']),
]

// ── Combined default settings ──

export const DEFAULT_CHECKLIST_SETTINGS: SettingsData = {
  briefingItems: {
    All: BRIEFING_ALL,
    Premium: BRIEFING_PREMIUM,
    Basic: BRIEFING_BASIC,
    Panel: BRIEFING_PANEL,
    Vito: BRIEFING_VITO,
  },
  prepItems: {
    All: PREP_ALL,
  },
}
