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
    const freedHireDays = hireDays(freed.job_date, freed.job_end);

    const scored = (candResult.rows as JobRow[]).map(row => {
      const flags = rowToFlags(row);
      const candHireDays = hireDays(row.job_date, row.job_end);
      const overlap = dateOverlapDays(
        freed.job_date, freed.job_end,
        row.job_date, row.job_end,
      );
      const bucket: 'paused' | 'open_enquiry' =
        row.pipeline_status === 'paused' ? 'paused' : 'open_enquiry';

      // Resource match flags
      const vehicleMatch = freedFlags.has_vehicle && flags.has_vehicle;
      const backlineMatch = freedFlags.has_backline && flags.has_backline;
      const rehearsalMatch = freedFlags.has_rehearsal && flags.has_rehearsal;
      // Bundle: both jobs have BOTH van + backline. The high-value case
      // jon flagged — bundling van + backline on a long tour is the best
      // outcome.
      const bundleMatch = vehicleMatch && backlineMatch;

      // Score components (composite, normalised to ~100 at the end)
      let score = 0;
      const rationale: string[] = [];

      if (bundleMatch) {
        score += 35;
        rationale.push('Van + backline bundle match');
      } else if (vehicleMatch) {
        score += 25;
        rationale.push(`Vehicle match (${flags.vehicle_count} van${flags.vehicle_count !== 1 ? 's' : ''})`);
      } else if (backlineMatch) {
        score += 15;
        rationale.push('Backline match');
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
          has_rehearsal: flags.has_rehearsal,
        },
        match: {
          score: normalised,
          date_overlap_days: overlap,
          bundle_match: bundleMatch,
          vehicle_match: vehicleMatch,
          backline_match: backlineMatch,
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
      has_rehearsal: flags.has_rehearsal,
    },
  };
}

export default router;
