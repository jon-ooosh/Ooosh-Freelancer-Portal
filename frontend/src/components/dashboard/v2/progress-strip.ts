/**
 * Frontend mirror of backend/src/services/job-progress-strip.ts.
 * Keep these types in sync if either side changes.
 */

export type ProgressStripStatus = 'todo' | 'wip' | 'done' | 'na' | 'prob';

export type ProgressStripCategory =
  | 'deprep' | 'client' | 'excess' | 'freelancer' | 'invoicing' | 'payment' | 'vehicle';

export type JobProgressStrip = Record<ProgressStripCategory, ProgressStripStatus>;

export type StripPhase = 'pre_hire' | 'post_hire';

export const STRIP_LABELS: Record<StripPhase, Record<ProgressStripCategory, string>> = {
  pre_hire: {
    deprep: 'Prep',
    client: 'Client',
    excess: 'Excess',
    freelancer: 'Freelancer',
    invoicing: 'Invoicing',
    payment: 'Payment',
    vehicle: 'Vehicle',
  },
  post_hire: {
    deprep: 'De-prep',
    client: 'Client',
    excess: 'Excess',
    freelancer: 'Freelancer',
    invoicing: 'Invoicing',
    payment: 'Payment',
    vehicle: 'Vehicle',
  },
};

const STRIP_KEYS: ProgressStripCategory[] = [
  'deprep', 'client', 'excess', 'freelancer', 'invoicing', 'payment', 'vehicle',
];

/** % completion (done / applicable). N/A slots excluded from denominator. */
export function stripPercent(strip: JobProgressStrip): { done: number; wip: number; total: number; pct: number } {
  let done = 0; let wip = 0; let total = 0;
  for (const k of STRIP_KEYS) {
    const s = strip[k];
    if (s === 'na') continue;
    total++;
    if (s === 'done') done++;
    else if (s === 'wip') wip++;
  }
  return { done, wip, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export const EMPTY_STRIP: JobProgressStrip = {
  deprep: 'na', client: 'na', excess: 'na', freelancer: 'na',
  invoicing: 'na', payment: 'na', vehicle: 'na',
};
