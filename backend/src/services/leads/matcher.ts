/**
 * Phase 4 — Address-book matching (the remarketing core).
 *
 * For each lead, look for the act in the address book three ways:
 *   1. BAND ORG BY NAME — pg_trgm similarity against `organisations` (gin index):
 *        EXACT  (normalised names equal) → link the org, stream = 'warm'.
 *        PARTIAL (similar, above the threshold) → "could this be [Org]?".
 *   2. JOBS NAMED AFTER THE BAND — catches acts booked under their management /
 *      agency company rather than a band org of their own (the Wedding Present
 *      case). Whole-word search of `jobs.job_name`, grouped by the job's client
 *      org → "could this be [Mgmt Org] — 3 jobs named 'Wedding Present…'?".
 *      Always a suggestion, never an automatic match: a management company books
 *      many acts, so a human confirms.
 *   3. KNOWN CONTACTS (`linkKnownContacts`) — after research, any researched
 *      contact whose email is already a person in the address book. Exact email
 *      only. Flags the lead; doesn't make it warm (an agent we know may book a
 *      hundred acts — it says "we know who to call", not "this is our client").
 *
 * A matched lead gets its client history (`history.ts`) — enquiries, bookings,
 * losses and why, retros — which the scorer then weighs. Rejected suggestions
 * are remembered per lead (`rejected_org_ids`) and never offered again.
 */
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { normaliseArtist } from './normalise';
import { getClientHistory, describeHistory, bandNameRegex, ClientHistory } from './history';

export { normaliseArtist };

export interface MatchCandidate {
  id: string;
  name: string;
  type: string | null;
  /** pg_trgm similarity for org-name candidates; null for job-name ones. */
  similarity: number | null;
  via: 'org_name' | 'job_name';
  /** Job-name candidates: how many of this org's jobs are named after the band. */
  job_count?: number;
  sample_job_name?: string | null;
}

async function partialThreshold(): Promise<number> {
  const raw = await getSystemSetting('lead_partial_match_threshold');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0.4;
}

/** Candidate orgs by trigram similarity (uses the gin index via the `%` operator). */
export async function findOrgNameCandidates(artistName: string): Promise<MatchCandidate[]> {
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
    via: 'org_name' as const,
  }));
}

/** Client orgs of jobs named after the band (whole-word match on job_name). */
export async function findJobNameCandidates(artistName: string): Promise<MatchCandidate[]> {
  const regex = bandNameRegex(artistName);
  if (!regex) return [];
  const r = await query(
    `SELECT o.id, o.name, o.type, COUNT(DISTINCT j.id)::int AS job_count,
            (ARRAY_AGG(j.job_name ORDER BY j.job_date DESC NULLS LAST))[1] AS sample_job_name
       FROM jobs j
       JOIN organisations o ON o.id = j.client_id AND o.is_deleted = false
      WHERE j.is_deleted = false AND j.job_name ~* $1::text
      GROUP BY o.id, o.name, o.type
      ORDER BY job_count DESC
      LIMIT 4`,
    [regex],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    type: (row.type as string | null) ?? null,
    similarity: null,
    via: 'job_name' as const,
    job_count: row.job_count as number,
    sample_job_name: (row.sample_job_name as string | null) ?? null,
  }));
}

/** Compose the lead's summary line: the tour, then what OP knows. Also prepended to the org's AI Summary. */
export function composeLeadSummary(
  artistName: string,
  tour: { uk_date_count: number; first_date: string | null; last_date: string | null },
  hist: ClientHistory | null,
): string {
  const tourLine = `${artistName} detected touring the UK — ${tour.uk_date_count} date(s)` +
    (tour.first_date ? ` from ${tour.first_date}${tour.last_date ? ` to ${tour.last_date}` : ''}` : '') + '.';
  return hist ? `${tourLine} ${describeHistory(hist)}` : tourLine;
}

export interface MatchResult {
  match_confidence: 'exact' | 'partial' | 'none';
  matched_organisation_id: string | null;
  match_via: 'org_name' | null;
  stream: 'cold' | 'warm';
  candidates: MatchCandidate[];
}

/** Decide the match for an artist name (no DB writes — caller persists). */
export async function matchArtist(artistName: string, rejectedOrgIds: string[] = []): Promise<MatchResult> {
  const rejected = new Set(rejectedOrgIds);
  const orgCandidates = (await findOrgNameCandidates(artistName)).filter((c) => !rejected.has(c.id));
  const target = normaliseArtist(artistName);

  const exact = orgCandidates.find((c) => normaliseArtist(c.name) === target);
  if (exact) {
    return { match_confidence: 'exact', matched_organisation_id: exact.id, match_via: 'org_name', stream: 'warm', candidates: [exact] };
  }

  const threshold = await partialThreshold();
  const partials = orgCandidates.filter((c) => (c.similarity ?? 0) >= threshold).slice(0, 4);
  const seen = new Set(partials.map((c) => c.id));
  const jobNamed = (await findJobNameCandidates(artistName)).filter((c) => !rejected.has(c.id) && !seen.has(c.id));
  // Job-name hits first: several jobs named after the band is stronger evidence
  // than a similar-looking org name.
  const candidates = [...jobNamed, ...partials].slice(0, 5);
  if (candidates.length > 0) {
    return { match_confidence: 'partial', matched_organisation_id: null, match_via: null, stream: 'cold', candidates };
  }

  return { match_confidence: 'none', matched_organisation_id: null, match_via: null, stream: 'cold', candidates: [] };
}

/**
 * Prepend a dated, sourced Lead-Finder block to an org's AI Summary panel.
 * Prepend (not clobber) so repeat detections accumulate a touring history.
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

function iso(d: unknown): string | null {
  if (!d) return null;
  const x = new Date(d as string);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

/**
 * Link a lead to an org as its warm match and compute its history. Used by the
 * matcher (exact hit), "Confirm" on a suggestion, and "Add to address book".
 * Clears history_scored_at so the scorer re-scores it with the history in view.
 * Stream stays cold for a band staff just created — they're in the address
 * book now, but there's no relationship to remarket yet.
 */
export async function linkLeadToOrg(
  leadId: string,
  orgId: string,
  via: 'org_name' | 'job_name' | 'created',
  opts: { enrichOrg: boolean },
): Promise<void> {
  const lead = await query(
    `SELECT id, artist_name, uk_date_count, first_date, last_date FROM leads WHERE id = $1`,
    [leadId],
  );
  const l = lead.rows[0];
  if (!l) return;
  const hist = await getClientHistory(orgId, { matchVia: via, artistName: l.artist_name });
  const summary = composeLeadSummary(l.artist_name, {
    uk_date_count: l.uk_date_count, first_date: iso(l.first_date), last_date: iso(l.last_date),
  }, hist);
  await query(
    `UPDATE leads SET matched_organisation_id = $2, match_confidence = 'exact', match_via = $3,
       stream = $4, client_history = $5, ai_summary = $6, history_scored_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [leadId, orgId, via, via === 'created' ? 'cold' : 'warm', hist ? JSON.stringify(hist) : null, summary],
  );
  if (opts.enrichOrg) await appendOrgSummary(orgId, summary, new Date().toISOString().slice(0, 10));
}

export interface MatchRunSummary { processed: number; exact: number; partial: number; none: number; enriched: number; historyRefreshed: number; }

/**
 * Apply matching to every open, as-yet-unlinked lead (none OR partial — a
 * partial is re-checked so new job-name suggestions can join it) and persist.
 * Then refresh the history snapshot on leads already linked, so a warm lead's
 * picture keeps up with jobs won or lost since it was matched.
 */
export async function runMatching(): Promise<MatchRunSummary> {
  const leads = await query(
    `SELECT id, artist_name, rejected_org_ids
       FROM leads
      WHERE status IN ('new', 'reviewing') AND matched_organisation_id IS NULL`,
  );

  const s: MatchRunSummary = { processed: 0, exact: 0, partial: 0, none: 0, enriched: 0, historyRefreshed: 0 };

  for (const lead of leads.rows) {
    s.processed += 1;
    const m = await matchArtist(lead.artist_name as string, (lead.rejected_org_ids as string[] | null) ?? []);

    if (m.match_confidence === 'exact' && m.matched_organisation_id) {
      s.exact += 1;
      try {
        await linkLeadToOrg(lead.id, m.matched_organisation_id, 'org_name', { enrichOrg: true });
        s.enriched += 1;
      } catch (err) {
        console.error('[leads/match] linking failed for org %s:', m.matched_organisation_id, err);
      }
      continue;
    }

    await query(
      `UPDATE leads SET match_confidence = $2, match_candidates = $3, updated_at = NOW() WHERE id = $1`,
      [lead.id, m.match_confidence, JSON.stringify(m.candidates)],
    );
    if (m.match_confidence === 'partial') s.partial += 1;
    else s.none += 1;
  }

  // Keep linked leads' history current (cheap — SQL only, no AI).
  const linked = await query(
    `SELECT id, artist_name, matched_organisation_id, match_via
       FROM leads
      WHERE status IN ('new', 'reviewing', 'contacted') AND matched_organisation_id IS NOT NULL`,
  );
  for (const l of linked.rows) {
    try {
      const hist = await getClientHistory(l.matched_organisation_id, { matchVia: l.match_via, artistName: l.artist_name });
      await query(`UPDATE leads SET client_history = $2 WHERE id = $1`, [l.id, hist ? JSON.stringify(hist) : null]);
      s.historyRefreshed += 1;
    } catch (err) {
      console.error('[leads/match] history refresh failed for lead %s:', l.id, err);
    }
  }

  console.log('[leads/match] done:', s);
  return s;
}

export interface KnownContact {
  person_id: string;
  name: string;
  email: string;
  orgs: string | null;
  job_count: number;
}

/**
 * Flag researched contacts that are already people in the address book
 * (exact email match only). Rewrites `known_contacts` on every lead that has
 * researched contacts.
 */
export async function linkKnownContacts(): Promise<{ leadsWithKnown: number }> {
  const r = await query(
    `SELECT l.id AS lead_id, p.id AS person_id, p.email,
            CONCAT(COALESCE(NULLIF(p.preferred_name, ''), p.first_name), ' ', p.last_name) AS name,
            (SELECT STRING_AGG(DISTINCT o.name, ', ')
               FROM person_organisation_roles por
               JOIN organisations o ON o.id = por.organisation_id AND o.is_deleted = false
              WHERE por.person_id = p.id AND por.status = 'active') AS orgs,
            (SELECT COUNT(DISTINCT jc.job_id)::int
               FROM job_contacts jc JOIN jobs j ON j.id = jc.job_id AND j.is_deleted = false
              WHERE jc.person_id = p.id) AS job_count
       FROM leads l
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(l.contacts) = 'array' THEN l.contacts ELSE '[]'::jsonb END
       ) c
       JOIN people p ON LOWER(p.email) = LOWER(NULLIF(TRIM(c->>'contact_email'), '')) AND p.is_deleted = false
      WHERE l.status NOT IN ('dismissed', 'not_relevant')`,
  );
  const byLead = new Map<string, KnownContact[]>();
  for (const row of r.rows) {
    const list = byLead.get(row.lead_id) ?? [];
    if (!list.some((k) => k.person_id === row.person_id)) {
      list.push({
        person_id: row.person_id, name: String(row.name).trim(), email: row.email,
        orgs: row.orgs ?? null, job_count: row.job_count ?? 0,
      });
    }
    byLead.set(row.lead_id, list);
  }
  // Reset everyone first (a person deleted / email changed drops off), then set.
  await query(
    `UPDATE leads SET known_contacts = '[]'::jsonb
      WHERE known_contacts <> '[]'::jsonb AND status NOT IN ('dismissed', 'not_relevant')`,
  );
  for (const [leadId, list] of byLead) {
    await query(`UPDATE leads SET known_contacts = $2 WHERE id = $1`, [leadId, JSON.stringify(list)]);
  }
  return { leadsWithKnown: byLead.size };
}
