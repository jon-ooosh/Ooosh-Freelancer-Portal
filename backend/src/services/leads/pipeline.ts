/**
 * Lead Finder pipeline orchestrator.
 *
 * Runs collect → detect → score as one background job, writing progress/counts
 * to `lead_runs`. Guards against concurrent runs. Triggered manually from the
 * Leads page (POST /api/leads/run); a scheduled trigger lands in a later slice.
 */
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { resetTicketmasterCallBudget, getTicketmasterCallCount } from './ticketmaster';
import { collectAll } from './collector';
import { detectTours } from './detector';
import { scoreLeads } from './scorer';
import { runMatching } from './matcher';
import { researchContacts } from './researcher';

async function num(key: string, fallback: number): Promise<number> {
  const raw = await getSystemSetting(key);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function isRunActive(): Promise<boolean> {
  // Stale guard: a run 'running' for >30 min is a zombie (the pipeline is an
  // in-process setImmediate, so a server restart mid-run orphans the row). Don't
  // let it block new runs forever.
  const r = await query(
    `SELECT 1 FROM lead_runs WHERE status = 'running' AND started_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
  );
  return r.rows.length > 0;
}

/** Mark any orphaned 'running' runs as failed. Called at boot (a restart kills
 *  the in-process pipeline) and by the manual "Stop" action. */
export async function sweepZombieLeadRuns(reason = 'Interrupted (server restart)'): Promise<number> {
  const r = await query(
    `UPDATE lead_runs SET status = 'failed', error = $1, finished_at = NOW() WHERE status = 'running'`,
    [reason],
  );
  if (r.rowCount) console.log('[leads] swept %d stuck run(s): %s', r.rowCount, reason);
  return r.rowCount ?? 0;
}

export async function createRun(triggeredBy: string | null, trigger: 'manual' | 'scheduled'): Promise<string> {
  const r = await query(
    `INSERT INTO lead_runs (triggered_by, trigger, status) VALUES ($1, $2, 'running') RETURNING id`,
    [triggeredBy, trigger],
  );
  return r.rows[0].id as string;
}

/** Run the full pipeline for an already-created run row. Never throws. */
export async function runPipeline(runId: string): Promise<void> {
  try {
    resetTicketmasterCallBudget();

    const minLeadWeeks = await num('lead_lookahead_min_weeks', 3);
    const maxWeeks = await num('lead_lookahead_max_weeks', 17);
    const tourMinDates = await num('lead_tour_min_dates', 3);
    const tourWindowWeeks = await num('lead_tour_window_weeks', 6);

    const collection = await collectAll(maxWeeks);
    const detection = await detectTours(runId, { minLeadWeeks, maxWeeks, tourMinDates, tourWindowWeeks });
    const scoring = await scoreLeads();
    const matching = await runMatching();
    const research = await researchContacts();

    await query(
      `UPDATE lead_runs SET status = 'complete', finished_at = NOW(), counts = $2 WHERE id = $1`,
      [runId, JSON.stringify({ collection, detection, scoring, matching, research, tmCalls: getTicketmasterCallCount() })],
    );
    console.log('[leads/pipeline] run %s complete', runId);
  } catch (err) {
    console.error('[leads/pipeline] run %s failed:', runId, err);
    await query(
      `UPDATE lead_runs SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`,
      [runId, err instanceof Error ? err.message : String(err)],
    ).catch(() => {});
  }
}

/** Run ONLY the address-book match + contact research against existing leads —
 *  no Ticketmaster crawl. Fast way to (re)process leads already found. */
export async function runProcessExisting(runId: string): Promise<void> {
  try {
    const matching = await runMatching();
    const research = await researchContacts();
    await query(
      `UPDATE lead_runs SET status = 'complete', finished_at = NOW(), counts = $2 WHERE id = $1`,
      [runId, JSON.stringify({ mode: 'process_existing', matching, research })],
    );
    console.log('[leads/pipeline] process-existing run %s complete', runId);
  } catch (err) {
    console.error('[leads/pipeline] process-existing run %s failed:', runId, err);
    await query(
      `UPDATE lead_runs SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`,
      [runId, err instanceof Error ? err.message : String(err)],
    ).catch(() => {});
  }
}
