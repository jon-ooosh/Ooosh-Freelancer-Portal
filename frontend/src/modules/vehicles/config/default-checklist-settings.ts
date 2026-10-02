/**
 * Default checklist settings — used to seed R2 on first load.
 *
 * Contains all briefing + prep items that were previously hardcoded.
 * Once saved to R2, the app reads from R2 and this file is only used
 * as a fallback if R2 returns empty.
 */

import type { ChecklistItem, DetailPrompt, SettingsData } from '../lib/settings-api'

// ── Reusable detail prompts ──

/**
 * Fluid level items: the READING is the answer, the ACTION is the detail.
 *
 * The old shape asked one question ("Ok / Topped up / Problem") and so
 * conflated two facts — what the level was, and what was done about it. A van
 * topped up every single prep looked identical to one topped up once, and the
 * level it was found at was never recorded at all. Splitting them is what makes
 * a drinking van visible.
 *
 * Levels ascend left to right so the pills read like a gauge. `Empty` and
 * `Overfull` both flag: one is a leak or a burn, the other risks seals and the
 * cat. A quarter does not flag — that is a normal top-up, not a fault.
 *
 * IMPORTANT — three places downstream read the word "Topped up" to count a
 * top-up, deduct stock and show fluid history. They read it out of the DETAIL
 * now (and still out of the answer, for prep sessions recorded before this
 * change). Keep the "Topped up …" prefix on these choices or they go quiet:
 *   - lib/stock-consumption.ts      (deducts oil/coolant/screenwash from stock)
 *   - backend services/vehicle-forecast.ts  (the "drinking oil" watch flag)
 *   - components/prep/PrepHistoryTab.tsx    (fluids topped, per session)
 */
const FLUID_LEVELS = ['Empty', '¼', '½', '¾', 'Full', 'Overfull', 'Problem']

/** Levels that raise an issue. A quarter is a top-up, not a fault. */
const FLUID_LEVEL_FLAGS = ['Empty', 'Overfull', 'Problem']

// "Full refill" is spelled exactly so — parseFluidAmount() in types/stock.ts
// matches that literal to deduct a full container's worth.
const FLUID_TOPUP_CHOICES = [
  'No — left as is',
  'Topped up < 500ml', 'Topped up ~500ml', 'Topped up ~1L',
  'Topped up ~1.5L', 'Topped up ~2L', 'Topped up 2L+',
  'Topped up — Full refill',
]

// Only reachable from 'Overfull' — the one level where the fix is taking fluid
// OUT. Draining deliberately does NOT touch stock; nothing was consumed.
const FLUID_DRAIN_CHOICES = [
  'No — left as is',
  'Drained off ~500ml', 'Drained off ~1L', 'Drained off 1L+',
]

const TOPUP_PROMPT: DetailPrompt = {
  label: 'Adjusted?',
  type: 'options',
  choices: FLUID_TOPUP_CHOICES,
}

const FLUID_ADJUSTMENT: Record<string, DetailPrompt> = {
  'Empty': TOPUP_PROMPT,
  '¼': TOPUP_PROMPT,
  '½': TOPUP_PROMPT,
  '¾': TOPUP_PROMPT,
  // No prompt on 'Full' — nothing to do at full, and offering one invites
  // staff to record the level AFTER topping up instead of as found.
  'Overfull': { label: 'Adjusted?', type: 'options', choices: FLUID_DRAIN_CHOICES },
  'Problem': { label: "What's the problem?", type: 'text' },
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

// Tread-measurement instruction. Shared so the live-form normaliser
// (PrepPage) can recognise + apply the canonical wording.
export const TREAD_NOTE = 'Measure all 3 points across the tyre width and enter the LOWEST.'

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
  // "To be cleaned" is deliberately NOT a flag value — a van awaiting an
  // external wash is a carwash to-do, not a fault, so it must not spawn a
  // Problems-register issue. It instead sets the vehicle's "needs external
  // wash" marker (see PrepPage completion handler). Auto-cleared when a
  // later prep records "Washed and clean".
  item('Bodywork', 'Vehicle Exterior', ['Washed and clean', 'To be cleaned'], []),
  item('Windscreen', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Other glass', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Wingmirrors', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem']),
  item('Doors and locks (inc deadlocks)', 'Vehicle Exterior', ['All working fine', 'Problem'], ['Problem']),
  item('Orange side marker lights', 'Vehicle Exterior', ['All working fine', 'Problem'], ['Problem']),
  item('Spare wheel', 'Vehicle Exterior', ['Present & tagged', 'Problem'], ['Problem']),
  item('Front left tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Front left tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm', notes: TREAD_NOTE }),
  item('Front right tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Front right tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm', notes: TREAD_NOTE }),
  item('Rear left tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Rear left tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm', notes: TREAD_NOTE }),
  item('Rear right tyre pressure', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'PSI' }),
  item('Rear right tyre tread depth', 'Vehicle Exterior', [], [], { inputType: 'number', unit: 'mm', notes: TREAD_NOTE }),
  // Tyre walls — the outward (kerb side) and inward (chassis side) faces both
  // need eyeballing for cracks, bulges and damage that don't show in tread depth.
  item('Exterior tyre walls OK?', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem'], { notes: 'Outward-facing wall of each tyre — check for cracks, bulges, splits.' }),
  item('Interior tyre walls OK?', 'Vehicle Exterior', ['Ok', 'Problem'], ['Problem'], { notes: 'Inward-facing (chassis side) wall of each tyre — check for cracks, bulges, splits.' }),

  // Engine
  item('Oil level', 'Engine', FLUID_LEVELS, FLUID_LEVEL_FLAGS, { notes: 'Level AS FOUND, before any top-up. Should be at least 1/2.', detailPrompts: FLUID_ADJUSTMENT }),
  item('Water / coolant level', 'Engine', FLUID_LEVELS, FLUID_LEVEL_FLAGS, { notes: 'Level AS FOUND, before any top-up. Should be at the half way rim.', detailPrompts: FLUID_ADJUSTMENT }),
  item('Screen wash level', 'Engine', FLUID_LEVELS, FLUID_LEVEL_FLAGS, { notes: 'Level AS FOUND, before any top-up. Should be at least half full.', detailPrompts: FLUID_ADJUSTMENT }),
  // N/A stays on AdBlue — some vans genuinely aren't fitted with it, and that
  // is an answer, not a fault.
  item('Ad Blue level', 'Engine', [...FLUID_LEVELS, 'N/A'], FLUID_LEVEL_FLAGS, { notes: 'Level AS FOUND, before any top-up. Please fill.', detailPrompts: FLUID_ADJUSTMENT }),

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
  // "N/A" covers vans that legitimately aren't fitted with an extinguisher —
  // a non-flag option, so it records the answer without raising a false issue.
  item('Fire extinguisher', 'Front Cab', ['Present', 'Problem', 'N/A'], ['Problem']),
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

// ── Live-form normaliser ──
//
// The live prep form reads its checklist from R2 (`settings/checklists.json`),
// falling back to DEFAULT_CHECKLIST_SETTINGS only when R2 is empty.
//
// AS OF SEPT 2026 PROD'S R2 COPY IS EMPTY and the live form runs on the
// defaults above, so editing them IS enough. (This comment previously said the
// opposite. It was checked on 18 Sep 2026 — `update-fluid-checklist-items.ts`
// found no object at that key — and corrected.)
//
// That can change the moment anyone presses Save on Settings > Checklists:
// from then on R2 wins and edits to the defaults above stop reaching the form.
// So do NOT rely on either state. This normaliser is applied to whatever
// prepMap the form ends up using, guaranteeing the safety-critical tyre
// content is present regardless of R2 state — and it is the right home for
// anything else that MUST be on the form no matter what R2 holds.
//
// Idempotent + minimally invasive: only adds the wall tickboxes if absent, and
// only sets the tread note when the item has no note (won't clobber a custom
// one set via the Checklists settings editor).
const EXTERIOR_WALL_NAME = 'Exterior tyre walls OK?'
const INTERIOR_WALL_NAME = 'Interior tyre walls OK?'

export function ensureTyreChecklistContent(
  prepMap: Record<string, ChecklistItem[]>,
): Record<string, ChecklistItem[]> {
  const out: Record<string, ChecklistItem[]> = {}
  for (const [key, list] of Object.entries(prepMap)) {
    const items = [...list]

    // Fire extinguisher (and any "not fitted" item): N/A must be a selectable,
    // NON-flag option. Some vans were never fitted with an extinguisher, so
    // "N/A" is a legitimate answer, not a problem. Prod's R2 checklist predates
    // the default fix, so normalise here: guarantee 'N/A' is in options and
    // strip it out of flagValues if a stale config has it flagging. Runs on
    // every list (not gated on tyre content). Idempotent.
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      if (it.name.toLowerCase().includes('fire extinguisher') && it.inputType === 'options') {
        const options = it.options.includes('N/A') ? it.options : [...it.options, 'N/A']
        const flagValues = it.flagValues.filter(v => v.toLowerCase() !== 'n/a')
        if (options !== it.options || flagValues.length !== it.flagValues.length) {
          items[i] = { ...it, options, flagValues }
        }
      }
    }

    const hasTread = items.some(i => i.unit === 'mm' && i.name.toLowerCase().includes('tread'))
    // Only touch lists that actually carry the tyre tread items.
    if (!hasTread) {
      out[key] = items
      continue
    }

    // Canonical tread wording where none is set.
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      if (it.unit === 'mm' && it.name.toLowerCase().includes('tread') && !it.notes) {
        items[i] = { ...it, notes: TREAD_NOTE }
      }
    }

    // Ensure both wall tickboxes exist, inserted after the last tyre item.
    const wallSection = items.find(i => i.unit === 'mm')?.section || 'Vehicle Exterior'
    const toAdd: ChecklistItem[] = []
    if (!items.some(i => i.name === EXTERIOR_WALL_NAME)) {
      toAdd.push(item(EXTERIOR_WALL_NAME, wallSection, ['Ok', 'Problem'], ['Problem'], {
        notes: 'Outward-facing wall of each tyre — check for cracks, bulges, splits.',
      }))
    }
    if (!items.some(i => i.name === INTERIOR_WALL_NAME)) {
      toAdd.push(item(INTERIOR_WALL_NAME, wallSection, ['Ok', 'Problem'], ['Problem'], {
        notes: 'Inward-facing (chassis side) wall of each tyre — check for cracks, bulges, splits.',
      }))
    }
    if (toAdd.length > 0) {
      let lastTyreIdx = -1
      for (let i = 0; i < items.length; i++) {
        if (items[i]!.unit === 'mm' || items[i]!.unit === 'PSI') lastTyreIdx = i
      }
      if (lastTyreIdx >= 0) {
        items.splice(lastTyreIdx + 1, 0, ...toAdd)
      } else {
        items.push(...toAdd)
      }
    }

    out[key] = items
  }
  return out
}

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
