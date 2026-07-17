/**
 * Phase 4 — Address-book matching (the remarketing core).
 *
 * For each scored lead, match the artist name against `organisations` using
 * pg_trgm fuzzy similarity (the gin(name gin_trgm_ops) index already exists):
 *   - EXACT  → normalised names equal → link the org, stream = 'warm'
 *   - PARTIAL → similar-but-not-equal above the threshold → store "could this
 *     be [Org]?" candidates for a human to confirm/reject. Stays 'cold' until
 *     confirmed.
 *   - NONE   → cold lead.
 *
 * An exact/confirmed match pulls the band's OP history (job count, last hire,
 * do-not-hire, working terms) into the lead's AI summary — turning "cold lead"
 * into "band you've worked with N times is touring again".
 */
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';

/** Normalise a name for exact comparison: lowercase, drop leading "the", strip punctuation. */
export function normaliseArtist(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface MatchCandidate {
  id: string;
  name: string;
  type: string | null;
  similarity: number;
}

export interface WarmSummary {
  job_count: number;
  last_job_date: string | null;
  do_not_hire: boolean;
  working_terms: string | null;
}

async function partialThreshold(): Promise<number> {
  const raw = await getSystemSetting('lead_partial_match_threshold');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0.4;
}

/** Candidate orgs by trigram similarity (uses the gin index via the `%` operator). */
async function findCandidates(artistName: string): Promise<MatchCandidate[]> {
  const r = await query(
    `SELECT id, name, type, similarity(name, $1) AS sim
       FROM organisations
      WHERE is_deleted = false AND name % $1
      ORDER BY sim DESC
      LIMIT 8`,
    [artistName],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    type: (row.type as string | null) ?? null,
    similarity: Number(row.sim),
  }));
}

/** History summary for a matched band org — powers the AI summary + warm display. */
export async function getWarmSummary(orgId: string): Promise<WarmSummary> {
  const jobs = await query(
    `SELECT COUNT(DISTINCT j.id)::int AS job_count,
            MAX(COALESCE(j.job_date, j.out_date)) AS last_job_date
       FROM jobs j
       LEFT JOIN job_organisations jo ON jo.job_id = j.id
      WHERE jo.organisation_id = $1 OR j.client_id = $1`,
    [orgId],
  );
  const org = await query(
    `SELECT do_not_hire, working_terms_type FROM organisations WHERE id = $1`,
    [orgId],
  );
  const lastRaw = jobs.rows[0]?.last_job_date;
  return {
    job_count: jobs.rows[0]?.job_count ?? 0,
    last_job_date: lastRaw ? new Date(lastRaw).toISOString().slice(0, 10) : null,
    do_not_hire: Boolean(org.rows[0]?.do_not_hire),
    working_terms: (org.rows[0]?.working_terms_type as string | null) ?? null,
  };
}

/** Compose the warm-lead summary line appended to the org's AI Summary panel. */
export function composeWarmSummary(artistName: string, tour: { uk_date_count: number; first_date: string | null; last_date: string | null }, hist: WarmSummary): string {
  const bits: string[] = [];
  bits.push(`${artistName} detected touring the UK — ${tour.uk_date_count} date(s)` +
    (tour.first_date ? ` from ${tour.first_date}${tour.last_date ? ` to ${tour.last_date}` : ''}` : '') + '.');
  if (hist.job_count > 0) {
    bits.push(`Worked with us ${hist.job_count} time(s)${hist.last_job_date ? `, last ${hist.last_job_date}` : ''}.`);
  } else {
    bits.push('No prior hires on record (matched by name — confirm this is the same act).');
  }
  if (hist.do_not_hire) bits.push('⚠ Flagged Do Not Hire.');
  if (hist.working_terms) bits.push(`Working terms: ${hist.working_terms}.`);
  return bits.join(' ');
}

export interface MatchResult {
  match_confidence: 'exact' | 'partial' | 'none';
  matched_organisation_id: string | null;
  stream: 'cold' | 'warm';
  candidates: MatchCandidate[];
}

/** Decide the match for an artist name (no DB writes — caller persists). */
export async function matchArtist(artistName: string): Promise<MatchResult> {
  const candidates = await findCandidates(artistName);
  const target = normaliseArtist(artistName);

  const exact = candidates.find((c) => normaliseArtist(c.name) === target);
  if (exact) {
    return { match_confidence: 'exact', matched_organisation_id: exact.id, stream: 'warm', candidates: [exact] };
  }

  const threshold = await partialThreshold();
  const partials = candidates.filter((c) => c.similarity >= threshold).slice(0, 4);
  if (partials.length > 0) {
    return { match_confidence: 'partial', matched_organisation_id: null, stream: 'cold', candidates: partials };
  }

  return { match_confidence: 'none', matched_organisation_id: null, stream: 'cold', candidates: [] };
}

/**
 * Prepend a dated, sourced Lead-Finder block to a band org's AI Summary panel.
 * Prepend (not clobber) so repeat detections accumulate a touring history.
 * `today` passed in so the caller controls the stamp (backend runtime supplies it).
 */
export async function appendOrgSummary(orgId: string, summary: string, today: string): Promise<void> {
  const block = `[Lead Finder ${today}] ${summary}`;
  await query(
    `UPDATE organisations
        SET ai_summary = $2 || CASE WHEN ai_summary IS NULL OR ai_summary = '' THEN '' ELSE E'\\n\\n' || ai_summary END,
            updated_at = NOW()
      WHERE id = $1`,
    [orgId, block],
  );
}

export interface MatchRunSummary { processed: number; exact: number; partial: number; none: number; enriched: number; }

/**
 * Apply matching to all as-yet-unmatched `new` leads and persist the result.
 * Exact matches enrich the band org's AI Summary once (they flip to 'exact'
 * and drop out of this query on the next run). 'none' leads are cheap to
 * re-attempt each run and never enrich.
 */
export async function runMatching(): Promise<MatchRunSummary> {
  const today = new Date().toISOString().slice(0, 10);
  const leads = await query(
    `SELECT id, artist_name, uk_date_count, first_date, last_date
       FROM leads
      WHERE status = 'new' AND matched_organisation_id IS NULL AND match_confidence = 'none'`,
  );

  const s: MatchRunSummary = { processed: 0, exact: 0, partial: 0, none: 0, enriched: 0 };

  for (const lead of leads.rows) {
    s.processed += 1;
    const m = await matchArtist(lead.artist_name as string);

    await query(
      `UPDATE leads SET match_confidence = $2, matched_organisation_id = $3,
         match_candidates = $4, stream = $5, updated_at = NOW()
       WHERE id = $1`,
      [lead.id, m.match_confidence, m.matched_organisation_id, JSON.stringify(m.candidates), m.stream],
    );

    if (m.match_confidence === 'exact' && m.matched_organisation_id) {
      s.exact += 1;
      try {
        const hist = await getWarmSummary(m.matched_organisation_id);
        const summary = composeWarmSummary(lead.artist_name as string, {
          uk_date_count: lead.uk_date_count as number,
          first_date: lead.first_date ? new Date(lead.first_date).toISOString().slice(0, 10) : null,
          last_date: lead.last_date ? new Date(lead.last_date).toISOString().slice(0, 10) : null,
        }, hist);
        await query(`UPDATE leads SET ai_summary = $2 WHERE id = $1`, [lead.id, summary]);
        await appendOrgSummary(m.matched_organisation_id, summary, today);
        s.enriched += 1;
      } catch (err) {
        console.error('[leads/match] enrichment failed for org %s:', m.matched_organisation_id, err);
      }
    } else if (m.match_confidence === 'partial') {
      s.partial += 1;
    } else {
      s.none += 1;
    }
  }

  console.log('[leads/match] done:', s);
  return s;
}
