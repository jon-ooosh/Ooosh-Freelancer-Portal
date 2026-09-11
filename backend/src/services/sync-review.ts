/**
 * Sync Review Queue helpers
 *
 * Shared by the HireHop CONTACT sync (`hirehop-sync.ts`) and the HireHop JOB
 * sync (`hirehop-job-sync.ts`). Both create organisations from HireHop data,
 * so both need the same "does this look like a real company?" heuristic and
 * the same dedupe-aware queue writer.
 *
 * Extracted Aug 2026: the contact sync had a `possible_band` guard rail since
 * the Stream C cleanup work, but the JOB sync — which auto-creates one org per
 * distinct HH `COMPANY` string — had none. That's how ~20 useless orgs
 * ("WOH26 / ARTHUR VEROCAI", "WOH26 / Lush Life / Aja Monet", …) accumulated
 * silently when a colleague used HireHop's company field as a notes field.
 */

/**
 * Queue an entity for manual review, deduping on (entity + review_type) so a
 * repeating sync doesn't stack identical pending rows.
 *
 * Returns true when a NEW row was written (callers increment their own
 * `reviewsFlagged` counters off this), false when an equivalent pending review
 * already existed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function flagForReview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbClient: any,
  params: {
    entity_type: string;
    entity_id: string | null;
    external_id: string;
    review_type: string;
    summary: string;
    details?: Record<string, unknown>;
  }
): Promise<boolean> {
  const existing = await dbClient.query(
    `SELECT id FROM sync_review_queue
     WHERE entity_type = $1 AND external_id = $2 AND review_type = $3 AND status = 'pending'`,
    [params.entity_type, params.external_id, params.review_type]
  );
  if (existing.rows.length > 0) return false;

  await dbClient.query(
    `INSERT INTO sync_review_queue (entity_type, entity_id, external_id, review_type, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.entity_type,
      params.entity_id,
      params.external_id,
      params.review_type,
      params.summary,
      JSON.stringify(params.details || {}),
    ]
  );
  return true;
}

/**
 * Company-word heuristic. A name carrying one of these tokens is almost
 * certainly a real trading entity; anything else imported as type='client'
 * from HireHop is worth a human glance (it's often a band, an artist, a
 * festival-stage-band string, or a note someone typed into the wrong box).
 *
 * Deliberately loose — it only decides whether to raise a REVIEW, never
 * whether to create the org. False positives cost one dismissable queue row.
 */
const COMPANY_WORDS =
  /\b(ltd|limited|group|inc|llc|plc|services|productions|consulting|management|agency)\b/i;

export function looksLikeCompanyName(name: string): boolean {
  return COMPANY_WORDS.test(name);
}
