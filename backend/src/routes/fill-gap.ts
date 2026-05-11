/**
 * Fill-a-Gap (Phase 1 — SQL matcher, no AI)
 *
 * When a job goes to `cancelled` (booked job fell through) or `lost`
 * (typically provisional → lost, but accepted for any lost job that had
 * dates set), this finds candidate `paused` / `new_enquiry` / `quoting`
 * jobs whose dates overlap and could take the freed slot.
 *
 * Phase 1 is deterministic — pure SQL + score arithmetic. Phase 2 will
 * layer Claude on top for ranked rationale + draft re-engagement emails.
 *
 * See CLAUDE.md → "Cancellation replacement-finder ('fill the gap')"
 * for the full design.
 */
import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { deriveFlags } from '../services/hh-requirement-derivation';
import type { HHLineItem } from '../services/hirehop-job-sync';

const router = Router();
router.use(authenticate);

// Candidate pipeline statuses we'll consider scanning. Provisional is
// excluded — provisional is "basically confirmed, waiting on £" per jon,
// not capacity-seeking. Confirmed+ obviously excluded too. Lost/cancelled
// excluded (would be silly to suggest a dead job).
const CANDIDATE_STATUSES = ['paused', 'new_enquiry', 'quoting'] as const;

// Hard cap on the candidate list — Phase 1 is a deterministic SQL match
// and 25 results is plenty for staff to scan. Phase 2 (AI) will tighten
// further.
const MAX_CANDIDATES = 25;

// ── Backline category buckets ───────────────────────────────────────────
// "Has any backline" is too coarse — a keys-only tour shouldn't appear as
// a top match for a drums-only freed slot. We split the HH backline
// categories into operational buckets (instruments by family + the
// non-instrument sound/light/staging groups) and score on bucket
// SET-OVERLAP, not on the binary "has_backline" flag.
//
// Source: CLAUDE.md HireHop category ranges. PA / DJ / Lighting / Power /
// Staging / Video already exist as arrays on the derivation engine but
// the instrument families (guitars / basses / drums / keys / woodwind /
// backline accessories) only live as comments there. Listing them
// inline here avoids polluting the wider DerivedFlags shape until other
// callers need them.
const BACKLINE_BUCKETS: Record<string, number[]> = {
  guitars:    [372, 373, 374, 375, 376, 377, 378],
  basses:     [379, 380, 381, 382, 383, 384],
  drums:      [385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398],
  keys:       [399, 400, 401, 402, 403, 404],
  woodwind:   [405],
  accessories:[406, 407, 408, 409, 410],
  pa:         [411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428],
  dj:         [429, 430, 431],
  lighting:   [432, 433, 434, 435, 436, 437, 438],
  power:      [439, 440, 441, 442, 443],
  staging:    [444, 445, 446, 447, 448],
  video:      [451, 452, 453],
};

const BUCKET_LABEL: Record<string, string> = {
  guitars: 'Guitars', basses: 'Basses', drums: 'Drums', keys: 'Keys',
  woodwind: 'Woodwind', accessories: 'Backline acc.',
  pa: 'PA/Sound', dj: 'DJ', lighting: 'Lighting', power: 'Power',
  staging: 'Staging', video: 'Video',
};

function extractBacklineBuckets(items: HHLineItem[] | null | undefined): string[] {
  if (!items || items.length === 0) return [];
  const present = new Set<string>();
  for (const item of items) {
    // Only count "real" stock items (kind:2, not virtual prompt parents)
    if (item.kind !== 2 || item.VIRTUAL) continue;
    const cat = Number(item.CATEGORY_ID);
    if (!cat) continue;
    for (const [bucket, ids] of Object.entries(BACKLINE_BUCKETS)) {
      if (ids.includes(cat)) {
        present.add(bucket);
        break;
      }
    }
  }
  return Array.from(present).sort();
}

interface JobRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  pipeline_status: string;
  job_date: string | null;
  job_end: string | null;
  job_value: number | string | null;
  line_items: HHLineItem[] | null;
  vehicle_slot_modes: Record<string, ('self_drive' | 'van_and_driver')[]> | null;
  manager_name: string | null;
  last_interaction_at: string | null;
  last_interaction_snippet: string | null;
}

function rowToFlags(row: JobRow) {
  // Defensive — pre-derivation jobs may have empty/missing line_items.
  // deriveFlags handles []; we just need to not crash on null.
  const items = Array.isArray(row.line_items) ? row.line_items : [];
  const slotModes = row.vehicle_slot_modes || {};
  return deriveFlags(items, slotModes);
}

function hireDays(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.max(1, Math.ceil((e - s) / (1000 * 60 * 60 * 24)));
}

function dateOverlapDays(
  aStart: string | null, aEnd: string | null,
  bStart: string | null, bEnd: string | null,
): number {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const start = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
  const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  if (end < start) return 0;
  return Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

// ── GET /api/fill-gap/:jobId/candidates ─────────────────────────────────

router.get('/:jobId/candidates', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    // 1. Load the freed-slot job. Must exist, must have dates.
    const freedResult = await query(
      `SELECT
         j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
         j.pipeline_status, j.job_date, j.job_end, j.job_value,
         j.line_items, j.vehicle_slot_modes,
         (SELECT p.first_name || ' ' || p.last_name FROM people p WHERE p.id = j.manager1_person_id) AS manager_name,
         NULL::timestamptz AS last_interaction_at,
         NULL::text AS last_interaction_snippet
       FROM jobs j
       WHERE j.id = $1 AND j.is_deleted = false`,
      [jobId]
    );

    if (freedResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const freed = freedResult.rows[0] as JobRow;

    if (!freed.job_date || !freed.job_end) {
      res.json({
        freed_slot: { ...buildSlotSummary(freed), warning: 'No dates set — cannot find replacements.' },
        candidates: [],
        totals: { paused: 0, open_enquiries: 0, total: 0 },
      });
      return;
    }

    // 2. Find candidates. Date overlap is the primary filter — we want
    // jobs whose window intersects the freed window. job_date IS NOT NULL
    // is implied by the overlap predicate but Postgres optimises better
    // with it stated. Future-facing: don't suggest jobs whose end is
    // already in the past.
    const candResult = await query(
      `SELECT
         j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
         j.pipeline_status, j.job_date, j.job_end, j.job_value,
         j.line_items, j.vehicle_slot_modes,
         (SELECT p.first_name || ' ' || p.last_name FROM people p WHERE p.id = j.manager1_person_id) AS manager_name,
         i.created_at AS last_interaction_at,
         i.content AS last_interaction_snippet
       FROM jobs j
       LEFT JOIN LATERAL (
         SELECT created_at, content
         FROM interactions
         WHERE job_id = j.id
         ORDER BY created_at DESC
         LIMIT 1
       ) i ON true
       WHERE j.is_deleted = false
         AND j.id != $1
         AND j.pipeline_status = ANY($2::text[])
         AND j.job_date IS NOT NULL
         AND j.job_end IS NOT NULL
         AND j.job_date <= $4::timestamptz
         AND j.job_end >= $3::timestamptz
         AND j.job_end >= CURRENT_DATE - INTERVAL '1 day'
       ORDER BY j.job_date ASC
       LIMIT 100`,
      [jobId, CANDIDATE_STATUSES, freed.job_date, freed.job_end]
    );

    const freedFlags = rowToFlags(freed);
    const freedBuckets = extractBacklineBuckets(freed.line_items);
    const freedHireDays = hireDays(freed.job_date, freed.job_end);

    const scored = (candResult.rows as JobRow[]).map(row => {
      const flags = rowToFlags(row);
      const candBuckets = extractBacklineBuckets(row.line_items);
      const candHireDays = hireDays(row.job_date, row.job_end);
      const overlap = dateOverlapDays(
        freed.job_date, freed.job_end,
        row.job_date, row.job_end,
      );
      const bucket: 'paused' | 'open_enquiry' =
        row.pipeline_status === 'paused' ? 'paused' : 'open_enquiry';

      // Vehicle match stays binary — a Premium LWB is broadly fungible
      // (any candidate needing a van benefits from a freed van slot).
      // Backline is the picky one: bucket-set overlap, not "any has any".
      const vehicleMatch = freedFlags.has_vehicle && flags.has_vehicle;
      const matchedBuckets = freedBuckets.filter(b => candBuckets.includes(b));
      const backlineMatch = matchedBuckets.length > 0;
      const rehearsalMatch = freedFlags.has_rehearsal && flags.has_rehearsal;
      // Bundle = van + at least one matching backline bucket. The
      // headline-value case jon flagged: van + backline on a long tour
      // is the best outcome. Without bucket-overlap a "bundle" was
      // firing on anything with any backline, which made keys-tour
      // candidates rank top for drums-tour gaps. Now it's specific.
      const bundleMatch = vehicleMatch && backlineMatch;

      // Score components (composite, normalised to ~100 at the end)
      let score = 0;
      const rationale: string[] = [];

      // Backline bucket overlap (replaces the old binary "backline match"
      // bonus). Scales with overlap count, caps at 3+ buckets so a giant
      // 8-bucket tour doesn't completely outrank a 2-bucket exact match.
      let backlineScore = 0;
      if (matchedBuckets.length >= 3) backlineScore = 25;
      else if (matchedBuckets.length === 2) backlineScore = 20;
      else if (matchedBuckets.length === 1) backlineScore = 12;

      if (bundleMatch) {
        // Bundle bonus is the +35 headline. The backline portion of it
        // scales with bucket overlap so a single-bucket bundle doesn't
        // get the same weight as a multi-bucket one.
        score += 25 + Math.min(15, matchedBuckets.length * 5);
        const bucketLabels = matchedBuckets.map(b => BUCKET_LABEL[b]).join(', ');
        rationale.push(`Van + backline bundle (${bucketLabels})`);
      } else if (vehicleMatch) {
        score += 25;
        rationale.push(`Vehicle match (${flags.vehicle_count} van${flags.vehicle_count !== 1 ? 's' : ''})`);
      } else if (backlineMatch) {
        score += backlineScore;
        const bucketLabels = matchedBuckets.map(b => BUCKET_LABEL[b]).join(', ');
        rationale.push(`Backline match (${bucketLabels})`);
      } else if (freedFlags.has_backline && flags.has_backline) {
        // Both have backline but ZERO bucket overlap — useful context
        // but not a score win. Surfaces in rationale so staff understand
        // why a "has backline" job scored low.
        rationale.push('Has backline but no category overlap');
      }

      if (rehearsalMatch) {
        score += 8;
        rationale.push('Rehearsal match');
      }

      // Date overlap — capped 30. Heavy overlap = the candidate fits
      // the freed window comfortably.
      const overlapScore = Math.min(30, overlap * 2);
      score += overlapScore;
      if (overlap > 0) {
        const pct = freedHireDays > 0 ? Math.round((overlap / freedHireDays) * 100) : 0;
        rationale.push(`${overlap}-day overlap (${pct}% of freed window)`);
      }

      // Tour-length bonus — longer hires preferred (more revenue per slot)
      const lengthScore = Math.min(15, Math.floor(candHireDays / 2));
      score += lengthScore;
      if (candHireDays >= 7) {
        rationale.push(`${candHireDays}-day hire`);
      }

      // Bucket priority — paused enquiries first
      if (bucket === 'paused') {
        score += 8;
        rationale.push('Paused enquiry');
      }

      // Job value (defensive: NUMERIC from pg comes back as string)
      const jobValue = Number(row.job_value || 0);
      const valueScore = Math.min(10, Math.floor(jobValue / 1000));
      score += valueScore;

      // Stale-interaction note — useful context for staff
      if (row.last_interaction_at) {
        const daysAgo = Math.floor(
          (Date.now() - new Date(row.last_interaction_at).getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysAgo <= 7) rationale.push(`Active (last contacted ${daysAgo}d ago)`);
        else if (daysAgo > 30) rationale.push(`Stale (last contacted ${daysAgo}d ago)`);
      }

      // Normalise to 0-100 — current max sums to ~106; clamp.
      const normalised = Math.min(100, score);

      return {
        job_id: row.id,
        hh_job_number: row.hh_job_number,
        job_name: row.job_name || 'Untitled',
        client_name: row.company_name || row.client_name || 'No client',
        manager_name: row.manager_name,
        pipeline_status: row.pipeline_status,
        bucket,
        dates: {
          job_date: row.job_date,
          job_end: row.job_end,
          hire_days: candHireDays,
        },
        hire_value_ex_vat: jobValue,
        flags: {
          has_vehicle: flags.has_vehicle,
          vehicle_count: flags.vehicle_count,
          vehicle_types: flags.vehicle_types,
          has_backline: flags.has_backline,
          backline_item_count: flags.backline_item_count,
          backline_buckets: candBuckets,
          has_rehearsal: flags.has_rehearsal,
        },
        match: {
          score: normalised,
          date_overlap_days: overlap,
          bundle_match: bundleMatch,
          vehicle_match: vehicleMatch,
          backline_match: backlineMatch,
          backline_matched_buckets: matchedBuckets,
          rehearsal_match: rehearsalMatch,
          rationale,
        },
        last_interaction_at: row.last_interaction_at,
        last_interaction_snippet: row.last_interaction_snippet
          ? row.last_interaction_snippet.slice(0, 160)
          : null,
      };
    });

    // Sort by score desc, then by job_date asc (closer dates first within
    // same score band — "imminent gaps first").
    scored.sort((a, b) => {
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      const ad = a.dates.job_date ? new Date(a.dates.job_date).getTime() : 0;
      const bd = b.dates.job_date ? new Date(b.dates.job_date).getTime() : 0;
      return ad - bd;
    });

    const limited = scored.slice(0, MAX_CANDIDATES);

    const totals = {
      paused: limited.filter(c => c.bucket === 'paused').length,
      open_enquiries: limited.filter(c => c.bucket === 'open_enquiry').length,
      total: limited.length,
      // Also report how many we found before truncating, so the UI can
      // show "showing top 25 of 47" if there's a long tail.
      total_before_cap: scored.length,
    };

    res.json({
      freed_slot: buildSlotSummary(freed),
      candidates: limited,
      totals,
    });
  } catch (error) {
    console.error('Fill-gap candidates error:', error);
    res.status(500).json({ error: 'Failed to load replacement candidates' });
  }
});

function buildSlotSummary(row: JobRow) {
  const flags = rowToFlags(row);
  const buckets = extractBacklineBuckets(row.line_items);
  return {
    job_id: row.id,
    hh_job_number: row.hh_job_number,
    job_name: row.job_name || 'Untitled',
    client_name: row.company_name || row.client_name || 'No client',
    pipeline_status: row.pipeline_status,
    manager_name: row.manager_name,
    dates: {
      job_date: row.job_date,
      job_end: row.job_end,
      hire_days: hireDays(row.job_date, row.job_end),
    },
    hire_value_ex_vat: Number(row.job_value || 0),
    flags: {
      has_vehicle: flags.has_vehicle,
      vehicle_count: flags.vehicle_count,
      vehicle_types: flags.vehicle_types,
      has_backline: flags.has_backline,
      backline_item_count: flags.backline_item_count,
      backline_buckets: buckets,
      has_rehearsal: flags.has_rehearsal,
    },
  };
}

export default router;
