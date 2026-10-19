/**
 * One-off normalisation of historical prep tyre-tread readings.
 *
 * Background: staff entered tyre tread as whole numbers (e.g. "82" meaning
 * 8.2mm — the decimal point was dropped). This silently defeated the low-tread
 * auto-flag (82 > the 5mm threshold) and contributed to the RX24SZG blow-out
 * (Jun 2026), where a worn rear tyre went out on hire un-flagged.
 *
 * This script walks every prep session in R2 and divides any tyre TREAD value
 * (unit === 'mm') greater than the 10mm cap by 10, so "82" → 8.2. It is
 * SCOPED STRICTLY TO unit === 'mm' — PSI values (40–70) are NOT touched. Values
 * already ≤ 10 are left alone (already correct decimals).
 *
 * Usage:
 *   npx ts-node src/scripts/normalise-prep-tyre-tread.ts            # dry-run (default)
 *   npx ts-node src/scripts/normalise-prep-tyre-tread.ts --commit   # apply
 *   npx ts-node src/scripts/normalise-prep-tyre-tread.ts --reg=RX24SZG   # one vehicle
 *
 * Dry-run prints a before/after table for review before committing. Idempotent:
 * re-running after a commit is a no-op (all values are now ≤ 10).
 */

import { listR2Objects, getFromR2, uploadToR2 } from '../config/r2';

const COMMIT = process.argv.includes('--commit');
const REG_ARG = process.argv.find(a => a.startsWith('--reg='))?.split('=')[1]?.toUpperCase();
const CAP_MM = 10;

interface Change {
  key: string;
  reg: string;
  date: string;
  corner: string;
  before: string;
  after: string;
}

async function readJson(key: string): Promise<any | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text);
  } catch (err: any) {
    if (err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function writeJson(key: string, data: unknown): Promise<void> {
  await uploadToR2(key, Buffer.from(JSON.stringify(data)), 'application/json');
}

async function main() {
  console.log(`\n=== Prep tyre-tread normalisation ${COMMIT ? '(COMMIT)' : '(DRY RUN)'} ===`);
  if (REG_ARG) console.log(`Filtered to vehicle: ${REG_ARG}`);

  // List every full session document. Index files (_index.json) are skipped —
  // they don't carry tyre values.
  const prefix = REG_ARG ? `prep-sessions/${REG_ARG}/` : 'prep-sessions/';
  const objects = await listR2Objects(prefix);
  const sessionKeys = objects
    .map(o => o.Key as string)
    .filter(k => k && k.endsWith('.json') && !k.endsWith('_index.json'));

  console.log(`Found ${sessionKeys.length} prep session document(s).\n`);

  const changes: Change[] = [];
  let filesChanged = 0;

  for (const key of sessionKeys) {
    const data = await readJson(key);
    if (!data || !Array.isArray(data.sections)) continue;

    let mutated = false;
    const reg = data.vehicleReg || key.split('/')[1] || '?';
    const date = data.date || data.completedAt || '?';

    for (const sec of data.sections) {
      const items: any[] = Array.isArray(sec?.items) ? sec.items : [];
      for (const it of items) {
        // STRICT: only tread fields (unit === 'mm'). PSI is never touched.
        if (it?.unit !== 'mm') continue;
        const raw = it?.value;
        if (raw == null || raw === '') continue;
        const num = parseFloat(String(raw));
        if (!Number.isFinite(num)) continue;
        if (num > CAP_MM) {
          const after = num / 10;
          changes.push({
            key,
            reg,
            date,
            corner: String(it?.name || '?').replace(/\s*tyre tread depth\s*/i, '').trim(),
            before: String(raw),
            after: String(after),
          });
          it.value = String(after);
          mutated = true;
        }
      }
    }

    if (mutated) {
      filesChanged++;
      if (COMMIT) await writeJson(key, data);
    }
  }

  // Before/after table
  if (changes.length === 0) {
    console.log('No tread values over the cap — nothing to normalise.\n');
    return;
  }

  console.log('Reg       Date         Corner            Before  →  After');
  console.log('───────────────────────────────────────────────────────────');
  for (const c of changes) {
    console.log(
      `${c.reg.padEnd(9)} ${String(c.date).slice(0, 10).padEnd(12)} ${c.corner.padEnd(17)} ${c.before.padStart(6)}  →  ${c.after}`,
    );
  }
  console.log('───────────────────────────────────────────────────────────');
  console.log(`\n${changes.length} value(s) across ${filesChanged} session(s) ${COMMIT ? 'UPDATED' : 'would be updated'}.`);
  if (!COMMIT) console.log('Re-run with --commit to apply.\n');
  else console.log('Done.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Normalisation failed:', err);
    process.exit(1);
  });
