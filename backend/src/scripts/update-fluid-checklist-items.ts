/**
 * One-shot migration for the four fluid items on the vehicle prep checklist.
 *
 * WHY A SCRIPT AND NOT A CODE CHANGE:
 *   The live prep checklist is NOT in this repo. It lives in R2 at
 *   `settings/checklists.json` and is edited through Settings > Checklists.
 *   `frontend/src/modules/vehicles/config/default-checklist-settings.ts` only
 *   seeds an EMPTY R2, so changing it alone changes nothing in production.
 *
 *   The Settings page does have a "Restore defaults" button, but that replaces
 *   the WHOLE checklist with the code defaults and would throw away every item
 *   staff have added or tuned since. This script edits only the four fluid
 *   items and leaves everything else exactly as it is.
 *
 * WHAT IT CHANGES:
 *   Oil / Water-coolant / Screen wash / Ad Blue move from a single conflated
 *   question ("Ok / Topped up / Problem") to a level reading as the ANSWER
 *   plus the action taken as the DETAIL. See default-checklist-settings.ts for
 *   the full reasoning — this file mirrors the values defined there.
 *
 * SAFETY:
 *   Dry-run by default; pass --commit to write. Writes a timestamped backup of
 *   the existing settings blob to R2 first, so a bad run is one copy away from
 *   being undone.
 *
 *   Re-running is safe: an item already carrying the new options is left alone.
 *
 * Usage (from backend/):
 *   npx tsx src/scripts/update-fluid-checklist-items.ts              # dry run
 *   npx tsx src/scripts/update-fluid-checklist-items.ts --commit     # apply
 */
import { getFromR2, uploadToR2 } from '../config/r2';

const SETTINGS_KEY = 'settings/checklists.json';

interface DetailPrompt {
  label: string;
  type: 'text' | 'options' | 'multi';
  choices?: string[];
}
interface ChecklistItem {
  name: string;
  inputType: 'options' | 'number' | 'text';
  options: string[];
  flagValues: string[];
  notes: string;
  unit: string;
  section: string;
  detailPrompts: Record<string, DetailPrompt>;
}
interface SettingsData {
  briefingItems?: Record<string, ChecklistItem[]>;
  prepItems?: Record<string, ChecklistItem[]>;
  updatedAt?: string;
}

// ── Mirrors default-checklist-settings.ts — keep the two in step ──
const FLUID_LEVELS = ['Empty', '¼', '½', '¾', 'Full', 'Overfull', 'Problem'];
const FLUID_LEVEL_FLAGS = ['Empty', 'Overfull', 'Problem'];

const FLUID_TOPUP_CHOICES = [
  'No — left as is',
  'Topped up < 500ml', 'Topped up ~500ml', 'Topped up ~1L',
  'Topped up ~1.5L', 'Topped up ~2L', 'Topped up 2L+',
  'Topped up — Full refill',
];
const FLUID_DRAIN_CHOICES = [
  'No — left as is',
  'Drained off ~500ml', 'Drained off ~1L', 'Drained off 1L+',
];

const TOPUP_PROMPT: DetailPrompt = {
  label: 'Adjusted?', type: 'options', choices: FLUID_TOPUP_CHOICES,
};
const FLUID_ADJUSTMENT: Record<string, DetailPrompt> = {
  'Empty': TOPUP_PROMPT,
  '¼': TOPUP_PROMPT,
  '½': TOPUP_PROMPT,
  '¾': TOPUP_PROMPT,
  'Overfull': { label: 'Adjusted?', type: 'options', choices: FLUID_DRAIN_CHOICES },
  'Problem': { label: "What's the problem?", type: 'text' },
};

/** The four items to convert, by exact name, with their new helper text. */
const FLUID_ITEMS: Record<string, { notes: string; allowNA?: boolean }> = {
  'Oil level': { notes: 'Level AS FOUND, before any top-up. Should be at least 1/2.' },
  'Water / coolant level': { notes: 'Level AS FOUND, before any top-up. Should be at the half way rim.' },
  'Screen wash level': { notes: 'Level AS FOUND, before any top-up. Should be at least half full.' },
  // N/A stays — some vans genuinely aren't fitted with AdBlue.
  'Ad Blue level': { notes: 'Level AS FOUND, before any top-up. Please fill.', allowNA: true },
};

async function readSettings(): Promise<SettingsData | null> {
  try {
    const resp = await getFromR2(SETTINGS_KEY);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as SettingsData;
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function main() {
  const commit = process.argv.includes('--commit');
  console.log(commit ? '── APPLYING ──' : '── DRY RUN (pass --commit to apply) ──');

  const settings = await readSettings();
  if (!settings) {
    console.log(
      `No settings found at ${SETTINGS_KEY}. Nothing to migrate — the app is still ` +
      `falling back to the code defaults, which already carry the new fluid items.`
    );
    return;
  }

  const prepItems = settings.prepItems || {};
  let changed = 0;
  let alreadyDone = 0;

  for (const [vehicleType, items] of Object.entries(prepItems)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const spec = FLUID_ITEMS[item.name];
      if (!spec) continue;

      const wanted = spec.allowNA ? [...FLUID_LEVELS, 'N/A'] : [...FLUID_LEVELS];
      if (JSON.stringify(item.options) === JSON.stringify(wanted)) {
        alreadyDone++;
        console.log(`  = [${vehicleType}] ${item.name} — already converted, left alone`);
        continue;
      }

      console.log(`  ~ [${vehicleType}] ${item.name}`);
      console.log(`      options : ${JSON.stringify(item.options)}`);
      console.log(`             -> ${JSON.stringify(wanted)}`);
      console.log(`      flags   : ${JSON.stringify(item.flagValues)} -> ${JSON.stringify(FLUID_LEVEL_FLAGS)}`);
      console.log(`      notes   : ${JSON.stringify(item.notes)} -> ${JSON.stringify(spec.notes)}`);

      item.inputType = 'options';
      item.options = wanted;
      item.flagValues = [...FLUID_LEVEL_FLAGS];
      item.notes = spec.notes;
      item.detailPrompts = JSON.parse(JSON.stringify(FLUID_ADJUSTMENT));
      changed++;
    }
  }

  console.log(`\n${changed} item(s) to change, ${alreadyDone} already converted.`);

  if (!changed) {
    console.log('Nothing to do.');
    return;
  }
  if (!commit) {
    console.log('Dry run — nothing written. Re-run with --commit to apply.');
    return;
  }

  // Backup first — one copy away from undo.
  const backupKey = `settings/checklists.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const original = await readSettings();
  await uploadToR2(backupKey, Buffer.from(JSON.stringify(original)), 'application/json');
  console.log(`Backed up existing settings to ${backupKey}`);

  settings.updatedAt = new Date().toISOString();
  await uploadToR2(SETTINGS_KEY, Buffer.from(JSON.stringify(settings)), 'application/json');
  console.log(`Wrote ${SETTINGS_KEY} — ${changed} fluid item(s) converted.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  });
