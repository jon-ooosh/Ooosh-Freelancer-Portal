/**
 * Frontend mirror of backend/src/services/job-progress-strip.ts.
 * Keep these types in sync if either side changes.
 */

export type ProgressStripStatus = 'todo' | 'wip' | 'done' | 'prob';

export type ProgressStripCategory =
  | 'deprep' | 'client' | 'excess' | 'freelancer' | 'invoicing' | 'payment' | 'vehicle';

/**
 * Partial map — a category is present iff the job has at least one matching
 * requirement for it. Missing categories don't render.
 */
export type JobProgressStrip = Partial<Record<ProgressStripCategory, ProgressStripStatus>>;

export type StripPhase = 'pre_hire' | 'post_hire';

export const STRIP_LABELS: Record<StripPhase, Record<ProgressStripCategory, string>> = {
  pre_hire: {
    deprep: 'Backline',
    client: 'Hire Form',
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

export const STRIP_ORDER: ProgressStripCategory[] = [
  'deprep', 'client', 'excess', 'freelancer', 'invoicing', 'payment', 'vehicle',
];

/** % completion based on the slots actually present on the strip. */
export function stripPercent(strip: JobProgressStrip): { done: number; wip: number; total: number; pct: number } {
  let done = 0; let wip = 0; let total = 0;
  for (const k of STRIP_ORDER) {
    const s = strip[k];
    if (s === undefined) continue;
    total++;
    if (s === 'done') done++;
    else if (s === 'wip') wip++;
  }
  return { done, wip, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export const EMPTY_STRIP: JobProgressStrip = {};
