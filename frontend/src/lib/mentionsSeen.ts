import { api } from '../services/api';

/**
 * The page a mention sits on is open — mark MY mention bells for this record
 * read (the dot goes), not done: seeing a question is not answering it
 * (jon, Oct 2026). Replying or reacting in the thread is what marks it done,
 * server-side. The bell refreshes itself over the socket.
 *
 * Call it only where the mention is actually on screen — the timeline tab,
 * the problem's thread — not merely because the record was opened.
 * Best-effort: a failure leaves the dot, which is what happened before.
 */
export type MentionAnchor = 'jobs' | 'people' | 'organisations' | 'venues' | 'job_issues';

export function markMentionsSeen(entityType: MentionAnchor, entityId: string): void {
  api.post('/notifications/seen', { entity_type: entityType, entity_id: entityId }).catch(() => {});
}
