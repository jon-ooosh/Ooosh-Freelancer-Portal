/**
 * Business figures — enquiries, booking rates, reply and quote times
 * (docs/BUSINESS-FIGURES-SPEC.md, step 2). Admin only. Reads, never writes.
 *
 * One row per ENQUIRY:
 *   - a quote-option group counts once, as its lead (job-groups.ts nonLeadMemberIds),
 *     arriving when its first option did;
 *   - not counted: dismissed duds, internal jobs, re-opened bookings (a re-open is
 *     not a new enquiry), and Leads outreach (`cold_lead` — our approach, not theirs);
 *   - arrival = the earlier of when OP made the job and HireHop's own creation date
 *     (a job made in HireHop reaches OP up to 30 minutes later; an OP job pushed to
 *     HireHop gets HireHop's date at the push), then the client's first email if
 *     that came earlier still.
 *
 * Outcome from the shared outcome buckets (job-outcomes.ts); "not followed up" is
 * the 09:00 sweep's (jobs.auto_lost); an alternative quote the client didn't pick
 * is not an enquiry of its own.
 *
 * Reply time = office minutes from the client's first contact to OUR first email to
 * them: on the job's timeline, or in the unmatched queue to one of the job's contact
 * addresses (the first emails usually land there before the job exists). Emails are
 * read here, never attached to anything (the matching rule, email-and-notifications.md).
 * Quote time = to the first `Quote (N).pdf` sent (job_quote_versions.received_at,
 * Gmail's own time).
 */
import { query } from '../config/database';
import { JOB_OUTCOME_SQL, JOB_BOOKED_SQL } from './job-outcomes';
import { ALTERNATIVE_QUOTE_LOST_REASON, nonLeadMemberIds } from './job-groups';
import { fullDisplayName } from './display-name';
import { EnquiryRow, FiguresSummary, Outcome, londonDate, londonToUtcMs, officeMinutesBetween, summarise } from './business-figures-maths';
import { trackedSource } from './marketing-source';
import { returningClientSql } from './returning-client';

/** A client email this long before the enquiry was logged counts as its first contact. */
const CONTACT_BEFORE_DAYS = 3;
/** Our first email to them within this long counts as the reply. */
const REPLY_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;
/** OP has been in real use since about April 2026 (jon) — the earliest the page goes back by default. */
export const FIGURES_EARLIEST = '2026-04-01';

const OWN_DOMAIN = '@oooshtours.co.uk';
const ADDRESS_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const addressesIn = (s: string | null | undefined): string[] => (s ? (s.match(ADDRESS_RE) || []).map((a) => a.toLowerCase()) : []);
const isOurs = (a: string) => a.endsWith(OWN_DOMAIN);

export interface EnquiryFigures {
  from: string;
  to: string;
  officeHours: string;
  coverage: { enquiries: number; withChannel: number; withReply: number; withQuote: number; withOwner: number; earliestEmail: string | null };
  summary: FiguresSummary;
}

interface JobRow {
  id: string;
  group_id: string | null;
  outcome: Outcome | 'alt' | 'other';
  lost_reason: string | null;
  enquiry_source: string | null;
  likelihood: string | null;
  job_value: string | null;
  arrived: Date;
  req_types: string[] | null;
  has_vehicle: boolean | null;
  has_backline: boolean | null;
  has_rehearsal: boolean | null;
  m_first: string | null; m_last: string | null; m_pref: string | null;
  c_first: string | null; c_last: string | null; c_pref: string | null;
  returning: boolean;
  heard_about: string | null;
  ms_utm_source: string | null; ms_utm_medium: string | null; ms_gclid: string | null; ms_fbclid: string | null;
  ms_link_code: string | null; ms_referrer: string | null;
}


export async function buildEnquiryFigures(from: string, to: string): Promise<EnquiryFigures> {
  const fromMs = londonToUtcMs(from, 0);
  const toMs = londonToUtcMs(to, 24 * 60);       // end of the `to` day
  const skip = await nonLeadMemberIds();

  // ── The enquiries ────────────────────────────────────────────────────────
  const r = await query(
    `WITH base AS (
       SELECT j.*,
              COALESCE(
                (SELECT MIN(LEAST(g.created_at, COALESCE(g.created_date, g.created_at)))
                   FROM jobs g WHERE j.group_id IS NOT NULL AND g.group_id = j.group_id AND g.is_deleted = false),
                LEAST(j.created_at, COALESCE(j.created_date, j.created_at))) AS arrived
         FROM jobs j
        WHERE j.is_deleted = false
          AND COALESCE(j.is_internal, false) = false
          AND j.dismissed_at IS NULL
          AND j.reopened_from_job_id IS NULL
          AND j.enquiry_source IS DISTINCT FROM 'cold_lead'
          AND NOT (j.id = ANY($3::uuid[]))
     )
     SELECT j.id, j.group_id, j.lost_reason, j.enquiry_source, j.likelihood, j.job_value, j.arrived,
            CASE
              WHEN ${JOB_BOOKED_SQL} THEN 'booked'
              WHEN ${JOB_OUTCOME_SQL.cancelled} THEN 'cancelled'
              WHEN ${JOB_OUTCOME_SQL.lostOnly} AND j.lost_reason = '${ALTERNATIVE_QUOTE_LOST_REASON}' THEN 'alt'
              WHEN ${JOB_OUTCOME_SQL.lostOnly} AND COALESCE(j.auto_lost, false) THEN 'not_followed_up'
              WHEN ${JOB_OUTCOME_SQL.lostOnly} THEN 'lost'
              WHEN ${JOB_OUTCOME_SQL.open} THEN 'open'
              ELSE 'other'
            END AS outcome,
            ARRAY(SELECT DISTINCT jr.requirement_type FROM job_requirements jr WHERE jr.job_id = j.id) AS req_types,
            (j.hh_derived_flags->>'has_vehicle')::boolean AS has_vehicle,
            (j.hh_derived_flags->>'has_backline')::boolean AS has_backline,
            (j.hh_derived_flags->>'has_rehearsal')::boolean AS has_rehearsal,
            pm.first_name AS m_first, pm.last_name AS m_last, pm.preferred_name AS m_pref,
            pc.first_name AS c_first, pc.last_name AS c_last, pc.preferred_name AS c_pref,
            -- Returning: the client (or a contact on it) had already booked with us before this enquiry arrived.
            ${returningClientSql('j', 'j.arrived')} AS returning,
            ms.heard_about, ms.utm_source AS ms_utm_source, ms.utm_medium AS ms_utm_medium, ms.gclid AS ms_gclid,
            ms.fbclid AS ms_fbclid, ms.link_code AS ms_link_code, ms.referrer AS ms_referrer
       FROM base j
       LEFT JOIN job_marketing_source ms ON ms.job_id = j.id
       LEFT JOIN people pm ON pm.id = j.manager1_person_id
       LEFT JOIN users uc ON uc.id::text = j.created_by
       LEFT JOIN people pc ON pc.id = uc.person_id
      WHERE j.arrived >= $1 AND j.arrived < $2`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), skip],
  );
  const jobs = (r.rows as JobRow[]).filter((j) => j.outcome !== 'alt');
  const leadIds = jobs.map((j) => j.id);

  // Every option in a group answers for its lead (emails and quotes land on any of them).
  const leadOf = new Map<string, string>(leadIds.map((id) => [id, id]));
  const groupIds = jobs.filter((j) => j.group_id).map((j) => j.group_id as string);
  if (groupIds.length) {
    const members = await query(`SELECT id, group_id FROM jobs WHERE group_id = ANY($1::uuid[]) AND is_deleted = false`, [groupIds]);
    const leadByGroup = new Map(jobs.filter((j) => j.group_id).map((j) => [j.group_id as string, j.id]));
    for (const m of members.rows as Array<{ id: string; group_id: string }>) {
      const lead = leadByGroup.get(m.group_id);
      if (lead) leadOf.set(m.id, lead);
    }
  }
  const allIds = [...leadOf.keys()];

  // ── Who the client is, by email address ─────────────────────────────────
  const contacts = await query(
    `SELECT jc.job_id, lower(p.email) AS email FROM job_contacts jc JOIN people p ON p.id = jc.person_id
      WHERE jc.job_id = ANY($1::uuid[]) AND p.email IS NOT NULL
     UNION
     SELECT j.id, lower(p.email) FROM jobs j
       JOIN person_organisation_roles por ON por.organisation_id = j.client_id
       JOIN people p ON p.id = por.person_id
      WHERE j.id = ANY($1::uuid[]) AND COALESCE(por.status, 'active') = 'active' AND p.email IS NOT NULL
     UNION
     SELECT j.id, lower(o.email) FROM jobs j JOIN organisations o ON o.id = j.client_id
      WHERE j.id = ANY($1::uuid[]) AND o.email IS NOT NULL`,
    [leadIds],
  );
  const contactsOf = new Map<string, Set<string>>();
  for (const c of contacts.rows as Array<{ job_id: string; email: string }>) {
    for (const a of addressesIn(c.email)) {
      if (isOurs(a)) continue;
      const set = contactsOf.get(c.job_id) ?? new Set<string>();
      set.add(a);
      contactsOf.set(c.job_id, set);
    }
  }

  // ── Emails: on the jobs, and in the unmatched queue ─────────────────────
  type Mail = { at: number; inbound: boolean; from: string | null; to: string | null };
  const mailOf = new Map<string, Mail[]>();
  const jobMail = await query(
    `SELECT job_id, email_direction, email_from, email_to, COALESCE(message_at, created_at) AS at
       FROM interactions
      WHERE type = 'email' AND job_id = ANY($1::uuid[])
        AND detached_at IS NULL
        AND match_method IS DISTINCT FROM 'backfill_forced'`,   // a backfill's created_at is the run date
    [allIds],
  );
  for (const m of jobMail.rows as Array<{ job_id: string; email_direction: string | null; email_from: string | null; email_to: string | null; at: Date }>) {
    const lead = leadOf.get(m.job_id);
    if (!lead) continue;
    const list = mailOf.get(lead) ?? [];
    list.push({ at: new Date(m.at).getTime(), inbound: m.email_direction !== 'outbound', from: m.email_from, to: m.email_to });
    mailOf.set(lead, list);
  }

  const unmatched = await query(
    `SELECT email_from, email_to, email_direction, COALESCE(message_at, received_at) AS at
       FROM gmail_unmatched_inbound
      WHERE COALESCE(message_at, received_at) >= $1 AND COALESCE(message_at, received_at) < $2`,
    [new Date(fromMs - CONTACT_BEFORE_DAYS * DAY_MS).toISOString(), new Date(toMs + REPLY_WITHIN_DAYS * DAY_MS).toISOString()],
  );
  // Indexed by the CLIENT's address: who sent it (inbound) or who it went to (outbound).
  const unmatchedByClient = new Map<string, Mail[]>();
  for (const u of unmatched.rows as Array<{ email_from: string | null; email_to: string | null; email_direction: string | null; at: Date }>) {
    const fromAddrs = addressesIn(u.email_from);
    const outbound = u.email_direction ? u.email_direction === 'outbound' : fromAddrs.some(isOurs);
    const clientAddrs = (outbound ? addressesIn(u.email_to) : fromAddrs).filter((a) => !isOurs(a));
    const mail: Mail = { at: new Date(u.at).getTime(), inbound: !outbound, from: u.email_from, to: u.email_to };
    for (const a of clientAddrs) {
      const list = unmatchedByClient.get(a) ?? [];
      list.push(mail);
      unmatchedByClient.set(a, list);
    }
  }

  // ── Quotes sent ─────────────────────────────────────────────────────────
  const quotes = await query(
    `SELECT job_id, MIN(received_at) AS first_at FROM job_quote_versions WHERE job_id = ANY($1::uuid[]) GROUP BY job_id`,
    [allIds],
  );
  const firstQuote = new Map<string, number>();
  for (const q of quotes.rows as Array<{ job_id: string; first_at: Date }>) {
    const lead = leadOf.get(q.job_id);
    if (!lead) continue;
    const t = new Date(q.first_at).getTime();
    if (!firstQuote.has(lead) || t < (firstQuote.get(lead) as number)) firstQuote.set(lead, t);
  }

  // ── Who sent our reply ──────────────────────────────────────────────────
  const users = await query(
    `SELECT lower(u.email) AS email, p.first_name, p.last_name, p.preferred_name
       FROM users u LEFT JOIN people p ON p.id = u.person_id`,
  );
  const staffByEmail = new Map<string, string>();
  for (const u of users.rows as Array<{ email: string; first_name: string | null; last_name: string | null; preferred_name: string | null }>) {
    const name = fullDisplayName(u);
    if (name) staffByEmail.set(u.email, name);
  }
  const senderName = (fromHeader: string | null): string | null => {
    const addr = addressesIn(fromHeader).find(isOurs);
    if (!addr) return null;
    if (staffByEmail.has(addr)) return staffByEmail.get(addr) as string;
    if (addr.startsWith('info@')) return 'info@ (shared inbox)';
    return addr;
  };

  // ── One row per enquiry ─────────────────────────────────────────────────
  let earliestEmail: number | null = null;
  const rows: EnquiryRow[] = jobs.map((j) => {
    const arrival = new Date(j.arrived).getTime();
    const windowFrom = arrival - CONTACT_BEFORE_DAYS * DAY_MS;
    const mails: Mail[] = [...(mailOf.get(j.id) || [])];
    for (const a of contactsOf.get(j.id) || []) mails.push(...(unmatchedByClient.get(a) || []));
    for (const m of mails) if (earliestEmail === null || m.at < earliestEmail) earliestEmail = m.at;

    const firstInbound = mails.filter((m) => m.inbound && m.at >= windowFrom && m.at <= arrival + REPLY_WITHIN_DAYS * DAY_MS)
      .reduce<number | null>((min, m) => (min === null || m.at < min ? m.at : min), null);
    const firstContact = firstInbound !== null && firstInbound < arrival ? firstInbound : arrival;
    const reply = mails.filter((m) => !m.inbound && m.at > firstContact && m.at <= firstContact + REPLY_WITHIN_DAYS * DAY_MS)
      .sort((a, b) => a.at - b.at)[0] || null;
    const quoteAt = firstQuote.get(j.id) ?? null;

    const services: string[] = [];
    const req = j.req_types || [];
    if (req.includes('vehicle') || j.has_vehicle) services.push('vans');
    if (req.includes('backline') || j.has_backline) services.push('backline');
    if (req.includes('rehearsal') || j.has_rehearsal) services.push('rehearsals');

    const owner = fullDisplayName({ first_name: j.m_first, last_name: j.m_last, preferred_name: j.m_pref })
      || fullDisplayName({ first_name: j.c_first, last_name: j.c_last, preferred_name: j.c_pref }) || null;

    return {
      jobId: j.id,
      month: londonDate(arrival).slice(0, 7),
      outcome: j.outcome === 'other' ? 'open' : (j.outcome as Outcome),
      lostReason: j.lost_reason,
      channel: j.enquiry_source,
      likelihood: j.likelihood,
      value: j.job_value !== null ? Number(j.job_value) : null,
      services,
      owner,
      replyMinutes: reply ? officeMinutesBetween(firstContact, reply.at) : null,
      replyBy: reply ? senderName(reply.from) : null,
      quoteMinutes: quoteAt !== null && quoteAt >= firstContact ? officeMinutesBetween(firstContact, quoteAt) : null,
      heardAbout: j.heard_about,
      tracked: trackedSource({
        utm_source: j.ms_utm_source, utm_medium: j.ms_utm_medium, gclid: j.ms_gclid, fbclid: j.ms_fbclid,
        link_code: j.ms_link_code, referrer: j.ms_referrer,
      }),
      returning: !!j.returning,
    };
  });

  return {
    from, to,
    officeHours: '09:00–18:00 UK, every day',
    coverage: {
      enquiries: rows.length,
      withChannel: rows.filter((x) => x.channel).length,
      withReply: rows.filter((x) => x.replyMinutes !== null).length,
      withQuote: rows.filter((x) => x.quoteMinutes !== null).length,
      withOwner: rows.filter((x) => x.owner).length,
      earliestEmail: earliestEmail !== null ? londonDate(earliestEmail) : null,
    },
    summary: summarise(rows),
  };
}
