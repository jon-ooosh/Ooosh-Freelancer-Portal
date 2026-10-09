/**
 * "Leads to look at" — the ONE definition of which leads the dashboard
 * surfaces (Needs Attention, blue, self-hiding). Spec: TOUR-FINDER-SPEC.md §15.
 *
 * A lead shows while it is:
 *   - still 'new' — nobody has started an enquiry, dismissed it, or marked it
 *     contacted (those are the ways off the card) — and the tour has no open or
 *     booked job linked to it already (services/leads/tour-jobs.ts);
 *   - still sellable — its first UK date is beyond the same "too imminent"
 *     floor the search uses (lead_lookahead_min_weeks), so a lead ages off the
 *     card once it's too late to act, rather than lingering forever;
 *   - good enough — WARM leads (bands we know) at the normal minimum score
 *     (lead_min_relevance_score); COLD leads only at the higher
 *     lead_dashboard_min_score, so a big search doesn't flood the dashboard.
 *
 * Warm first, then best score, then soonest tour. `total` is the FULL count
 * (COUNT(*) OVER ()), not the LIMIT-ed row count.
 */
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { liveTourJobSql } from './tour-jobs';

export interface LeadAttentionItem {
  id: string;
  artist_name: string;
  stream: 'cold' | 'warm';
  relevance_score: number | null;
  first_date: string | null;
  origin_country: string | null;
  matched_org_name: string | null;
  client_history: { enquiries: number; booked: number; lost: number } | null;
}

async function num(key: string, fallback: number): Promise<number> {
  const raw = await getSystemSetting(key);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getLeadAttention(limit = 5): Promise<{ total: number; items: LeadAttentionItem[] }> {
  const minScore = await num('lead_min_relevance_score', 6);
  const coldMin = await num('lead_dashboard_min_score', 8);
  const minWeeks = await num('lead_lookahead_min_weeks', 3);

  const r = await query(
    `SELECT l.id, l.artist_name, l.stream, l.relevance_score, l.first_date, l.origin_country,
            o.name AS matched_org_name, l.client_history,
            COUNT(*) OVER ()::int AS total_count
       FROM leads l
       LEFT JOIN organisations o ON o.id = l.matched_organisation_id
      WHERE l.status = 'new'
        AND l.first_date >= CURRENT_DATE + ($3::int * 7)
        -- Already quoted or booked for this tour — nothing to look at.
        AND NOT ${liveTourJobSql('l')}
        AND (
          (l.stream = 'warm' AND l.relevance_score >= $1::numeric)
          OR (l.stream = 'cold' AND l.relevance_score >= $2::numeric)
        )
      ORDER BY (l.stream = 'warm') DESC, l.relevance_score DESC, l.first_date ASC
      LIMIT $4`,
    [minScore, coldMin, Math.round(minWeeks), limit],
  );
  return {
    total: r.rows[0] ? Number(r.rows[0].total_count) : 0,
    items: r.rows.map((row) => ({
      id: row.id,
      artist_name: row.artist_name,
      stream: row.stream,
      relevance_score: row.relevance_score,
      first_date: row.first_date ? new Date(row.first_date).toISOString().slice(0, 10) : null,
      origin_country: row.origin_country,
      matched_org_name: row.matched_org_name,
      client_history: row.client_history
        ? { enquiries: row.client_history.enquiries, booked: row.client_history.booked, lost: row.client_history.lost }
        : null,
    })),
  };
}
