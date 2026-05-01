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

export type ProgressStripStatus = 'todo' | 'wip' | 'done' | 'na' | 'prob';

export type ProgressStripCategory =
  | 'deprep'
  | 'client'
  | 'excess'
  | 'freelancer'
  | 'invoicing'
  | 'payment'
  | 'vehicle';

export type JobProgressStrip = Record<ProgressStripCategory, ProgressStripStatus>;

export type StripPhase = 'pre_hire' | 'post_hire';

/** UI labels for each slot. Slot 0's label changes per phase (Prep / De-prep). */
export const STRIP_CATEGORY_LABELS: Record<StripPhase, Record<ProgressStripCategory, string>> = {
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
  if (!reqStatus) return 'na';
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
  na: 0,
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
    const strip: JobProgressStrip = {
      deprep: 'na', client: 'na', excess: 'na', freelancer: 'na',
      invoicing: 'na', payment: 'na', vehicle: 'na',
    };

    for (const cat of allCats) {
      const types = STRIP_MAPPING[phase][cat];
      if (types.length === 0) continue;
      let s: ProgressStripStatus = 'todo'; // mapped slot defaults to todo (not na) — slot exists, just nothing done
      let any = false;
      for (const t of types) {
        const rs = reqs[t];
        if (rs !== undefined) {
          s = any ? worstStatus(s, rs) : rs;
          any = true;
        }
      }
      // If no requirement of that type exists for the job, leave slot as todo
      // (the slot is meaningful for this phase, just not yet created). Future:
      // distinguish "no req" from "todo" by adding a separate state.
      strip[cat] = any ? s : 'todo';
    }

    out[jobId] = strip;
  }

  return out;
}
