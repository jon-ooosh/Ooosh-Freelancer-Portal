import { query } from '../config/database';

/**
 * Promote the pre-hire excess requirement to 'done' when the job_excess
 * record is covered. Coverage = terminal state, or amount_taken >= required.
 * Forward-only: does not un-do a 'done' status if coverage is later lost
 * (handled via manual status change).
 *
 * Pass a transaction client to run inside an existing transaction.
 */
export async function syncExcessRequirementStatus(
  jobId: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  const run = client
    ? (text: string, params: unknown[]) => client.query(text, params)
    : (text: string, params: unknown[]) => query(text, params);

  await run(
    `UPDATE job_requirements
     SET status = 'done', updated_at = NOW()
     WHERE job_id = $1
       AND requirement_type = 'excess'
       AND phase = 'pre_hire'
       AND status IN ('not_started', 'in_progress')
       AND EXISTS (
         SELECT 1 FROM job_excess je
         WHERE je.job_id = $1
           AND (
             je.excess_status IN ('waived','rolled_over','not_required','reimbursed','fully_claimed','partially_reimbursed')
             OR (COALESCE(je.excess_amount_required, 0) > 0
                 AND COALESCE(je.excess_amount_taken, 0) >= je.excess_amount_required)
           )
       )`,
    [jobId],
  );
}
