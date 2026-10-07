/**
 * Phase 5 — Contact research. Ported from `contact_researcher.py`, reworked
 * Oct 2026 (TOUR-FINDER-SPEC §18).
 *
 * Claude + the web-search tool finds contacts for COLD leads (bands we already
 * hold don't need a web search). What we want, in order (jon, Oct 2026): the
 * band's MANAGEMENT, the BAND directly, their TOUR MANAGER. Booking agents
 * and promoters are a last resort — they rarely book a tour's worth of vans and
 * backline, so they're only returned when nothing better exists.
 *
 * Starting points: the act's official site and socials (`links.ts` —
 * Ticketmaster + MusicBrainz), stored on `leads.external_links`.
 *
 * Tracking (migration 277): every attempt stamps `researched_at` and
 * `research_status` ('found' | 'none' | 'failed'). A lead that came back empty
 * is NOT retried on every run (it used to eat the per-run cap and starve newer
 * leads) — only after RETRY_AFTER_DAYS, or on demand via `researchLead()`
 * ("Research again"). Contacts staff added by hand (`manual: true`) always
 * survive a re-research. Capped per run (`lead_contact_research_cap`).
 */
import { getAnthropicClient, isAnthropicConfigured, CLAUDE_SONNET_MODEL } from '../../config/anthropic';
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { fetchArtistLinks, describeLinks, ArtistLinks } from './links';
import { logLeadEvent } from './events';

const MODEL_ID = CLAUDE_SONNET_MODEL;
/** An empty or failed result is tried again by a run only after this long. */
const RETRY_AFTER_DAYS = 30;

const SYSTEM_PROMPT = `You are a contact researcher for OOOSH Tours, a UK company that hires splitter vans and backline equipment to touring bands. The people who book a whole UK tour's worth of vans and backline are the band's MANAGEMENT, the BAND itself, or their TOUR MANAGER. Find those.

## Who to find (in priority order)
1. Management — the artist's manager or management company (name + email). Best of all.
2. The band directly — an official contact email on their website or in their social bios (e.g. band@, hello@, info@ on the band's own domain).
3. Tour manager / production manager — often credited on socials, tour posters or crew pages.
4. ONLY if you find none of the above: a booking agent. Never return promoters or venue contacts — they are not useful to OOOSH.

## Where to look (start with any links you are given — they are the band's own)
1. The band's official website — Contact / Management / Booking / About pages, site footer.
2. Social bios — Instagram, Facebook, X/Twitter, Bandcamp, Linktree (bios often say "mgmt: …" or give an email).
3. Their record label's artist page, which sometimes names management.
4. General web search — "[band] management", "[band] manager email", "[band] tour manager".

## For each contact found, return:
- contact_type: "manager", "band", "tour_manager", "booking_agent" or "general"
- contact_name: the person's name, or the company name if that's all there is
- contact_email, contact_phone: if found
- source: where you found it (e.g. "official website contact page", "Instagram bio")
- confidence: "high" (a direct email for the right person), "medium" (a company or general address), "low" (unsure)

## Response format — return ONLY a JSON object, no commentary:
{
  "artist_name": "exact name as provided",
  "contacts": [ { "contact_type": "manager", "contact_name": "Jane Smith (Big Mgmt)", "contact_email": "jane@bigmgmt.com", "contact_phone": null, "source": "official website", "confidence": "high" } ],
  "notes": "a sentence on what you found — or what you checked if you found nothing"
}

Never invent an email address. If you find nothing, return an empty contacts array and say in notes what you checked.`;

export interface Contact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
  /** Added by staff — kept through any re-research. */
  manual?: boolean;
}

interface LeadRow {
  id: string;
  artist_name: string;
  tm_artist_id: string | null;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  origin_country: string | null;
  client_tier: number | null;
  contacts: Contact[] | null;
  external_links: ArtistLinks | null;
}

const LEAD_SELECT = `id, artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues,
  origin_country, client_tier, contacts, external_links`;

function parseJson(text: string): { contacts?: Contact[]; notes?: string } | null {
  let t = text.trim();
  if (t.startsWith('```')) t = t.split('\n').filter((l) => !l.trim().startsWith('```')).join('\n');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

function ymd(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function askClaude(lead: LeadRow, links: ArtistLinks): Promise<{ contacts: Contact[]; notes: string }> {
  const client = getAnthropicClient();
  const context = `This artist has ${lead.uk_date_count} UK date(s)` +
    (lead.first_date ? ` from ${ymd(lead.first_date)} to ${ymd(lead.last_date) ?? '?'}` : '') +
    `, playing venues including: ${(lead.venues ?? []).slice(0, 5).join(', ')}. ` +
    `Origin: ${lead.origin_country ?? 'Unknown'}.`;
  const linkLines = describeLinks(links);

  const response = await client.messages.create(
    {
      model: MODEL_ID,
      // Headroom for thinking as well as the JSON — thinking counts towards
      // max_tokens on Sonnet 5.5.
      max_tokens: 8000,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 } as never],
      messages: [{
        role: 'user',
        content: `Find the management, band and tour manager contacts for: ${lead.artist_name}\n\nContext: ${context}\n\n`
          + (linkLines ? `The band's own links (start here):\n${linkLines}\n\n` : 'No official links are known — search for the band\'s website and socials first.\n\n')
          + 'Return the results as JSON.',
      }],
    },
    { timeout: 90_000 }, // a hung web search must not wedge the whole run
  );

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  const parsed = parseJson(text);
  const contacts = (parsed?.contacts ?? []).filter((c) => c && (c.contact_email || c.contact_name || c.contact_phone));
  return { contacts, notes: parsed?.notes ?? '' };
}

/** Staff-added contacts first, then researched ones not already there (by email). */
function mergeContacts(existing: Contact[] | null, found: Contact[]): Contact[] {
  const manual = (existing ?? []).filter((c) => c.manual);
  const seen = new Set(manual.map((c) => c.contact_email?.trim().toLowerCase()).filter(Boolean) as string[]);
  const fresh = found.filter((c) => {
    const e = c.contact_email?.trim().toLowerCase();
    if (!e) return true;
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  return [...manual, ...fresh];
}

type Outcome = { status: 'found' | 'none' | 'failed'; contactsFound: number; error?: string };

/** Research one lead and record the outcome. Never throws. */
async function researchRow(lead: LeadRow, opts: { userId?: string | null; runId?: string | null } = {}): Promise<Outcome> {
  try {
    // Links: re-use what we have, fetch if we never have.
    let links: ArtistLinks = lead.external_links ?? {};
    if (Object.keys(links).length === 0 && lead.tm_artist_id) {
      links = await fetchArtistLinks(lead.tm_artist_id);
    }
    const { contacts, notes } = await askClaude(lead, links);
    const merged = mergeContacts(lead.contacts, contacts);
    const status: Outcome['status'] = contacts.length > 0 ? 'found' : 'none';
    await query(
      `UPDATE leads SET contacts = $2, external_links = $3, researched_at = NOW(), research_status = $4,
         reasoning = COALESCE(reasoning, '') || CASE WHEN $5 <> '' THEN E'\\n[Research] ' || $5 ELSE '' END,
         updated_at = NOW()
       WHERE id = $1`,
      [lead.id, JSON.stringify(merged), JSON.stringify(links), status, notes],
    );
    const types = Array.from(new Set(contacts.map((c) => c.contact_type.replace('_', ' '))));
    await logLeadEvent(lead.id, 'researched', {
      detail: contacts.length ? `${contacts.length} contact(s) — ${types.join(', ')}` : 'Nothing found',
      userId: opts.userId ?? null, runId: opts.runId ?? null,
    });
    return { status, contactsFound: contacts.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[leads/research] %s failed:', lead.artist_name, msg);
    await query(
      `UPDATE leads SET researched_at = NOW(), research_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [lead.id],
    ).catch(() => {});
    await logLeadEvent(lead.id, 'research_failed', { detail: msg.slice(0, 300), userId: opts.userId ?? null });
    return { status: 'failed', contactsFound: 0, error: msg };
  }
}

/**
 * "Research again" on one lead — staff-triggered, whatever its history.
 * Runs in the background (a web search can take a minute); the caller marks the
 * lead 'running' first so the page can show it.
 */
export async function researchLead(leadId: string, userId: string | null): Promise<Outcome | null> {
  if (!isAnthropicConfigured()) return null;
  const r = await query(`SELECT ${LEAD_SELECT} FROM leads WHERE id = $1`, [leadId]);
  if (!r.rows[0]) return null;
  return researchRow(r.rows[0] as LeadRow, { userId });
}

export interface ResearchSummary {
  researched: number;
  contactsFound: number;
  withContacts: number;
  nothingFound: number;
  failed: number;
  lastError?: string;
}

export async function researchContacts(): Promise<ResearchSummary> {
  const s: ResearchSummary = { researched: 0, contactsFound: 0, withContacts: 0, nothingFound: 0, failed: 0 };
  if (!isAnthropicConfigured()) return s;

  const minScore = Number((await getSystemSetting('lead_min_relevance_score')) ?? 6) || 6;
  const cap = Number((await getSystemSetting('lead_contact_research_cap')) ?? 40) || 40;

  // Cold, unmatched, good enough, still open, no contacts yet — and either never
  // researched, or researched without luck long enough ago to try again.
  // Soonest tours first among equal scores: they're the ones to act on now.
  const result = await query(
    `SELECT ${LEAD_SELECT}
       FROM leads
      WHERE match_confidence <> 'exact'
        AND status IN ('new', 'reviewing')
        AND relevance_score >= $1
        AND (contacts IS NULL OR contacts = '[]'::jsonb)
        AND first_date >= CURRENT_DATE
        AND (researched_at IS NULL
             OR (research_status IN ('none', 'failed') AND researched_at < NOW() - ($3::int * INTERVAL '1 day')))
      ORDER BY relevance_score DESC, first_date ASC
      LIMIT $2`,
    [minScore, cap, RETRY_AFTER_DAYS],
  );

  for (const lead of result.rows as LeadRow[]) {
    const o = await researchRow(lead);
    s.researched += 1;
    if (o.status === 'found') { s.withContacts += 1; s.contactsFound += o.contactsFound; }
    else if (o.status === 'none') s.nothingFound += 1;
    else { s.failed += 1; s.lastError = o.error; } // surfaced in the run strip so a broken web-search tool is diagnosable
  }

  console.log('[leads/research] done:', s);
  return s;
}
