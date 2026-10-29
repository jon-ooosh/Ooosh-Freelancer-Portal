/**
 * The drafting tasks a Staff Document shared with Claude can apply to.
 * Mirrors AI_TOPICS in backend/src/services/house-knowledge.ts — change both.
 * docs/AI-KNOWLEDGE-SPEC.md §4.
 */
export const AI_TOPICS = ['voice', 'chasing', 'quoting_vans', 'quoting_general', 'client_questions'] as const;
export type AiTopic = typeof AI_TOPICS[number];

export const AI_TOPIC_LABELS: Record<AiTopic, { label: string; hint: string }> = {
  voice: { label: 'Our voice', hint: 'How we write to clients. Read for every email Claude drafts — replaces the built-in voice.' },
  chasing: { label: 'Chasing a quote', hint: 'Read when Claude drafts a chase.' },
  quoting_vans: { label: 'Quoting vans', hint: 'Read when Claude drafts a van quote (not built yet).' },
  quoting_general: { label: 'Quoting (general)', hint: 'Read for any quote Claude drafts (not built yet).' },
  client_questions: { label: 'Client questions', hint: 'Answers to the questions clients ask (not used yet).' },
};
