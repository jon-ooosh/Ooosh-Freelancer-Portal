/**
 * PCN document helpers — the single place that knows how a PCN's documents are
 * stored (the `documents` JSONB array plus the legacy single `pcn_document_url`
 * pointer) and turns the notice pages into email attachments.
 *
 * Used by pcn-actions.ts + pcn-chase.ts so client emails carry the notice
 * front + back (the back page usually holds the issuer's payment methods —
 * see the "refer to the attached notice for payment options" line in the
 * client templates).
 */
import { getFromR2 } from '../config/r2';

export interface PcnDocumentEntry {
  r2_key: string;
  name?: string | null;
  kind?: string | null;
  comment?: string | null;
  uploaded_at?: string;
  uploaded_by?: string | null;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// Documents come back from pg as a parsed array (jsonb) but be defensive about
// a stringified column just in case.
export function parsePcnDocuments(documents: unknown): PcnDocumentEntry[] {
  if (!documents) return [];
  if (Array.isArray(documents)) return documents as PcnDocumentEntry[];
  if (typeof documents === 'string') {
    try { const p = JSON.parse(documents); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

const NOTICE_KINDS = new Set(['notice_front', 'notice_back']);

/**
 * The R2 keys for the notice pages we'd attach to a client email: every
 * `notice_front` / `notice_back` document, plus the legacy `pcn_document_url`,
 * deduped by key. Untyped legacy docs (kind missing) count as the notice.
 */
export function noticeDocumentKeys(pcn: {
  documents?: unknown;
  pcn_document_url?: string | null;
}): string[] {
  const keys: string[] = [];
  for (const d of parsePcnDocuments(pcn.documents)) {
    if (!d.r2_key) continue;
    if (!d.kind || NOTICE_KINDS.has(d.kind)) keys.push(d.r2_key);
  }
  if (pcn.pcn_document_url) keys.push(pcn.pcn_document_url);
  return [...new Set(keys)];
}

/**
 * Fetch the notice pages from R2 and shape them as email attachments.
 * Best-effort per page — a failed fetch is skipped, never throws.
 */
export async function collectNoticeAttachments(pcn: {
  documents?: unknown;
  pcn_document_url?: string | null;
  vehicle_reg?: string | null;
  reference?: string | null;
}): Promise<EmailAttachment[]> {
  const keys = noticeDocumentKeys(pcn);
  const attachments: EmailAttachment[] = [];
  let page = 0;
  for (const key of keys) {
    page += 1;
    try {
      const obj = await getFromR2(key);
      const bytes = await (obj.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      const isPdf = key.toLowerCase().endsWith('.pdf');
      const suffix = keys.length > 1 ? `-p${page}` : '';
      attachments.push({
        filename: `PCN-${pcn.vehicle_reg || 'notice'}-${pcn.reference || ''}${suffix}.${isPdf ? 'pdf' : 'jpg'}`.replace(/\s/g, ''),
        content: Buffer.from(bytes),
        contentType: isPdf ? 'application/pdf' : 'image/jpeg',
      });
    } catch { /* best-effort per page */ }
  }
  return attachments;
}
