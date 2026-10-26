/**
 * House knowledge — THE way an AI drafting call reads Ooosh's own guides.
 *
 * docs/AI-KNOWLEDGE-SPEC.md §4 (Phase B, Oct 2026). A Staff Document an admin has
 * shared with Claude (`staff_documents.ai_shared`) and tagged with topics
 * (`ai_topics`) is read here, so the guidance staff read and the guidance Claude
 * follows are one approved, versioned text. Only the CURRENT version of an
 * APPROVED, ACTIVE document is ever returned — a draft or a retired document never
 * reaches a client email.
 *
 * Callers pass the topics their task needs (a chase: voice + chasing) and get back
 * the guides plus which version of each was used, so "why did it say that?" is
 * answerable. The hard rules stay in each caller's code and beat any guide.
 *
 * Never throws: a database problem means no guides, and the caller falls back to
 * its built-in wording rather than failing the draft.
 */
import { query } from '../config/database';

/** The drafting tasks a guide can apply to. Mirrors frontend/src/lib/aiTopics.ts. */
export const AI_TOPICS = ['voice', 'chasing', 'quoting_vans', 'quoting_general', 'client_questions'] as const;
export type AiTopic = typeof AI_TOPICS[number];

/** Above this many characters of guides in one call, admins should hear about it. */
const GUIDE_BUDGET_CHARS = 30000;

export interface HouseGuide {
  documentId: string;
  title: string;
  topics: string[];
  version: number;
  body: string;
}

export interface HouseGuides {
  guides: HouseGuide[];
  /** The guides add up to more than the budget — they are all still included. */
  overBudget: boolean;
}

export async function getGuidesFor(topics: readonly AiTopic[]): Promise<HouseGuides> {
  try {
    const r = await query(
      `SELECT d.id, d.title, d.ai_topics, v.version, v.body
         FROM staff_documents d
         JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = TRUE
        WHERE d.ai_shared = TRUE
          AND d.is_active = TRUE
          AND d.approval_status = 'approved'
          AND d.ai_topics && $1::text[]
          AND COALESCE(TRIM(v.body), '') <> ''
        ORDER BY d.title`,
      [topics as unknown as string[]],
    );
    const guides: HouseGuide[] = r.rows.map((row) => ({
      documentId: row.id,
      title: row.title,
      topics: row.ai_topics || [],
      version: Number(row.version),
      body: String(row.body).trim(),
    }));
    const total = guides.reduce((n, g) => n + g.body.length, 0);
    const overBudget = total > GUIDE_BUDGET_CHARS;
    if (overBudget) {
      console.warn(`[house-knowledge] guides for ${topics.join(', ')} are ${total} characters (budget ${GUIDE_BUDGET_CHARS}) — consider trimming them`);
    }
    return { guides, overBudget };
  } catch (error) {
    console.error('[house-knowledge] could not read guides:', error);
    return { guides: [], overBudget: false };
  }
}

/** True when one of the guides covers this topic (e.g. a shared voice guide exists). */
export function hasTopic(result: HouseGuides, topic: AiTopic): boolean {
  return result.guides.some((g) => g.topics.includes(topic));
}

/** The guides as one block of prompt text, each under its own title. */
export function guidesAsPromptText(result: HouseGuides): string {
  return result.guides
    .map((g) => `=== ${g.title} (Ooosh guide, version ${g.version}) ===\n${g.body}`)
    .join('\n\n');
}

/** "How we write to clients v3" — for recording which guides a draft used. */
export function guidesUsedSummary(result: HouseGuides): Array<{ documentId: string; title: string; version: number }> {
  return result.guides.map((g) => ({ documentId: g.documentId, title: g.title, version: g.version }));
}
