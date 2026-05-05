/**
 * Per-job dashboard progress strip mapping.
 *
 * The Today block on the dashboard renders a 7-slot progress strip per job
 * (De-prep · Client · Excess · Freelancer · Invoicing · Payment · Vehicle).
 * Each slot resolves to one status pip per job, derived from `job_requirements`
 * rows for that job.
 *
 * Two phases are tracked separately:
 *   - `pre_hire`  — used for jobs in "Going Out Today" (about to leave).
 *   - `post_hire` — used for jobs in "Returning Today" (back / coming back).
 *
 * ────────────────────────────────────────────────────────────────────────
 *  Extending for future modules (carnets, merch, vehicle damage follow-ups,
 *  etc.):
 *
 *  Option A — Add to an existing slot.
 *    If a new requirement type belongs alongside an existing concept (e.g.
 *    a `damage_review` post-hire requirement is conceptually part of the
 *    "Vehicle" slot), add its requirement_type string to the relevant slot
 *    array in STRIP_MAPPING. The slot's status will collapse to the WORST
 *    status across all matched requirements (todo > wip > prob > done > na).
 *
 *  Option B — Add a new slot.
 *    1. Add a key to `ProgressStripCategory` and an entry to
 *       `STRIP_CATEGORY_LABELS`.
 *    2. Add the slot to STRIP_MAPPING for the relevant phase (or both).
 *    3. Update the frontend `<ProgressStrip>` to render the new slot.
 *    4. Add a column to the future-module checklist (CLAUDE.md §11).
 *
 *  Slot status precedence (worst wins): prob > todo > wip > done > na.
 * ────────────────────────────────────────────────────────────────────────
 */

export type ProgressStripStatus = 'todo' | 'wip' | 'done' | 'prob';

export type ProgressStripCategory =
  | 'deprep'
  | 'client'
  | 'excess'
  | 'freelancer'
  | 'invoicing'
  | 'payment'
  | 'vehicle';

/**
 * Per-job strip is a partial map. A category is present iff the job has at
 * least one matching `job_requirements` row for that slot+phase. Missing
 * categories are NOT rendered — staff sees only the things this specific
 * job actually tracks.
 */
export type JobProgressStrip = Partial<Record<ProgressStripCategory, ProgressStripStatus>>;

export type StripPhase = 'pre_hire' | 'post_hire';

/** UI labels for each slot, per phase. Pre-hire labels match the underlying
 *  requirement so staff can read the strip at a glance: "Backline" = backline
 *  prep status, "Hire Form" = client's hire form returned, etc. Post-hire
 *  labels are kept generic for now (under separate review). */
export const STRIP_CATEGORY_LABELS: Record<StripPhase, Record<ProgressStripCategory, string>> = {
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

/**
 * Per-phase requirement-type mapping. Empty array means the slot is N/A for
 * that phase (renders as a grey "na" pip).
 */
export const STRIP_MAPPING: Record<StripPhase, Record<ProgressStripCategory, string[]>> = {
  pre_hire: {
    deprep: ['backline'],          // pre-hire backline prep
    client: ['hire_forms'],        // client hire form returned
    excess: ['excess'],            // excess collected up front
    freelancer: [],                // pre-hire freelancer status not in requirements yet
    invoicing: [],                 // n/a pre-hire (invoice fires post-hire)
    payment: [],                   // n/a pre-hire (deposit lives on Money tab)
    vehicle: ['vehicle'],          // van allocated + prepped
  },
  post_hire: {
    deprep: ['backline'],
    client: ['client_followup'],
    excess: ['excess_resolve'],
    freelancer: ['freelancer_followup'],
    invoicing: ['invoice'],
    payment: ['payment_reconcile'],
    vehicle: ['vehicle'],
  },
};

/**
 * Map a job_requirements row.status string to a strip status pip.
 * Worst-status precedence applies when multiple requirements feed one slot.
 */
function mapReqStatusToStrip(reqStatus: string | null | undefined): ProgressStripStatus {
  // A requirement row with no status string is unusual but treat as todo —
  // the requirement exists, it's just not done.
  if (!reqStatus) return 'todo';
  switch (reqStatus) {
    case 'done':
    case 'reconciled':
    case 'sent':
    case 'resolved':
      return 'done';
    case 'blocked':
    case 'problem':
    case 'declined':
      return 'prob';
    case 'not_started':
    case 'open':
    case 'pending':
    case 'needed':
    case 'not_invoiced':
    case 'outstanding':
    case 'not_contacted':
      return 'todo';
    case 'in_progress':
    case 'working_on_it':
    case 'awaiting_quote':
    case 'quoted':
    case 'generated':
    case 'chased':
      return 'wip';
    default:
      return 'todo';
  }
}

const STATUS_RANK: Record<ProgressStripStatus, number> = {
  done: 1,
  wip: 2,
  todo: 3,
  prob: 4,
};

function worstStatus(a: ProgressStripStatus, b: ProgressStripStatus): ProgressStripStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export interface RequirementRow {
  job_id: string;
  requirement_type: string;
  status: string | null;
  phase: StripPhase | string | null;
}

/**
 * Build progress strips for a set of jobs from their requirement rows.
 *
 * @param rows   — flat list of job_requirements rows, all phases mixed.
 * @param phases — per-job phase override. Caller decides which phase each job
 *                 should render for (e.g. a Going Out job → pre_hire, a
 *                 Returning job → post_hire). Falls back to pre_hire.
 */
export function buildProgressStrips(
  rows: RequirementRow[],
  phases: Record<string, StripPhase>,
): Record<string, JobProgressStrip> {
  const out: Record<string, JobProgressStrip> = {};

  // Index: jobId → phase → requirement_type → worst status seen
  const index: Record<string, Record<StripPhase, Record<string, ProgressStripStatus>>> = {};
  for (const row of rows) {
    const jobId = row.job_id;
    const phase = (row.phase === 'pre_hire' || row.phase === 'post_hire')
      ? row.phase
      : 'pre_hire';
    if (!index[jobId]) index[jobId] = { pre_hire: {}, post_hire: {} };
    const slot = index[jobId][phase];
    const status = mapReqStatusToStrip(row.status);
    const existing = slot[row.requirement_type];
    slot[row.requirement_type] = existing ? worstStatus(existing, status) : status;
  }

  const allCats: ProgressStripCategory[] = [
    'deprep', 'client', 'excess', 'freelancer', 'invoicing', 'payment', 'vehicle',
  ];

  for (const [jobId, phase] of Object.entries(phases)) {
    const reqs = index[jobId]?.[phase] ?? {};
    const strip: JobProgressStrip = {};

    // A slot only renders if at least one of its mapped requirement types
    // exists on the job (in the relevant phase). Empty mapping arrays are
    // skipped, and slots whose mapped types have no matching requirement
    // are omitted entirely — staff sees only what this specific job tracks.
    for (const cat of allCats) {
      const types = STRIP_MAPPING[phase][cat];
      if (types.length === 0) continue;
      let s: ProgressStripStatus | undefined;
      for (const t of types) {
        const rs = reqs[t];
        if (rs !== undefined) {
          s = s === undefined ? rs : worstStatus(s, rs);
        }
      }
      if (s !== undefined) strip[cat] = s;
    }

    out[jobId] = strip;
  }

  return out;
}
