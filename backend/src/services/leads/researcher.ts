/**
 * Phase 5 — Contact research. Ported from `contact_researcher.py`.
 *
 * Uses Claude + the web-search tool to find management / booking-agent contacts
 * for COLD leads only (unmatched / not an exact address-book hit) — bands we
 * already know don't need a web search, we hold their contacts. Capped per run
 * (`lead_contact_research_cap`, default 20) to bound spend.
 *
 * Contacts are stored on `leads.contacts` (jsonb). Web search returns free-form
 * results, so we keep the original tool's approach: ask for JSON in the reply,
 * parse with a fence/brace fallback.
 */
import { getAnthropicClient, isAnthropicConfigured } from '../../config/anthropic';
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';

const MODEL_ID = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are a music industry contact researcher for OOOSH Tours, a UK-based company that provides splitter van hire and backline equipment to touring bands.

Your task is to find management and booking agent contact details for a given artist.

## What to search for (in priority order):
1. Band's official website — "Contact", "Press", "Booking", "Management" pages
2. Social media bios — Instagram, Facebook, Twitter/X — often list management company or direct email
3. Music industry directories (bookingagentinfo.com, thehandbook.com)
4. MusicBrainz — free database with artist relationships
5. General web search — "[band name] booking agent email", "[band name] management contact"

## What to return, for each contact found:
- contact_type: "manager", "booking_agent", "tour_manager", or "general"
- contact_name: the person's name (if found)
- contact_email: their email (if found)
- contact_phone: phone (if found)
- source: where you found it (e.g. "band official website")
- confidence: "high" (direct email), "medium" (management company, no direct email), "low" (uncertain)

## Response format — return ONLY a JSON object, no commentary:
{
  "artist_name": "exact name as provided",
  "contacts": [ { "contact_type": "manager", "contact_name": "John Smith", "contact_email": "john@mgmt.com", "contact_phone": null, "source": "official website", "confidence": "high" } ],
  "notes": "any context about their management situation"
}

If you cannot find any contacts, return an empty contacts array with a note. Be honest about confidence — a management company name without a direct email is still useful (medium).`;

interface Contact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
}

interface LeadRow {
  id: string;
  artist_name: string;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  origin_country: string | null;
  client_tier: number | null;
}

function parseJson(text: string): { contacts?: Contact[]; notes?: string } | null {
  let t = text.trim();
  if (t.startsWith('```')) t = t.split('\n').filter((l) => !l.trim().startsWith('```')).join('\n');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

async function researchOne(lead: LeadRow): Promise<{ contacts: Contact[]; notes: string }> {
  const client = getAnthropicClient();
  const context = `This artist has ${lead.uk_date_count} UK date(s)` +
    (lead.first_date ? ` from ${lead.first_date} to ${lead.last_date ?? '?'}` : '') +
    `, playing venues including: ${(lead.venues ?? []).slice(0, 5).join(', ')}. ` +
    `Origin: ${lead.origin_country ?? 'Unknown'}. Tier ${lead.client_tier ?? '?'} lead.`;

  const response = await client.messages.create(
    {
      model: MODEL_ID,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as never],
      messages: [{
        role: 'user',
        content: `Research management and booking contact details for: ${lead.artist_name}\n\nContext: ${context}\n\nSearch their official website, social media, and music industry directories. Return the results as JSON.`,
      }],
    },
    { timeout: 90_000 }, // a hung web search must not wedge the whole run
  );

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  const parsed = parseJson(text);
  return { contacts: parsed?.contacts ?? [], notes: parsed?.notes ?? '' };
}

export interface ResearchSummary { researched: number; contactsFound: number; failed: number; lastError?: string; }

export async function researchContacts(): Promise<ResearchSummary> {
  if (!isAnthropicConfigured()) return { researched: 0, contactsFound: 0, failed: 0 };

  const minScore = Number((await getSystemSetting('lead_min_relevance_score')) ?? 6) || 6;
  const cap = Number((await getSystemSetting('lead_contact_research_cap')) ?? 20) || 20;

  // Cold, unmatched, above threshold, not yet researched (no contacts), still 'new'.
  const result = await query(
    `SELECT id, artist_name, uk_date_count, first_date, last_date, venues, origin_country, client_tier
       FROM leads
      WHERE match_confidence <> 'exact'
        AND status = 'new'
        AND relevance_score >= $1
        AND (contacts IS NULL OR contacts = '[]'::jsonb)
      ORDER BY relevance_score DESC
      LIMIT $2`,
    [minScore, cap],
  );
  const leads = result.rows as LeadRow[];
  const s: ResearchSummary = { researched: 0, contactsFound: 0, failed: 0 };

  for (const lead of leads) {
    try {
      const { contacts, notes } = await researchOne(lead);
      await query(
        `UPDATE leads SET contacts = $2, reasoning = COALESCE(reasoning, '') ||
           CASE WHEN $3 <> '' THEN E'\\n[Research] ' || $3 ELSE '' END,
           updated_at = NOW()
         WHERE id = $1`,
        [lead.id, JSON.stringify(contacts), notes],
      );
      s.researched += 1;
      s.contactsFound += contacts.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[leads/research] %s failed:', lead.artist_name, msg);
      s.failed += 1;
      s.lastError = msg; // surfaced in the run banner so a broken web-search tool is diagnosable
    }
  }

  console.log('[leads/research] done:', s);
  return s;
}
