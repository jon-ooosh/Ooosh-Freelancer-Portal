/**
 * The Staff Documents attached to the "you're approved" email (jon, Nov 2026;
 * migration 340, docs/FREELANCER-PORTAL-SPEC.md §8). THE definition: the
 * approval email (routes/freelancers.ts sendApprovalEmail) asks this.
 *
 * Why: the "Getting started" guide lived only in the portal's Resources, so a
 * new freelancer had to work out the portal before they could read how to use
 * it. A document ticked "Attach to the 'you're approved' email" goes with the
 * email instead.
 *
 * - A document is attached while it is live (active + approved), shared with
 *   freelancers and ticked, and its CURRENT version is an uploaded file (a
 *   written-only document has nothing to attach). A new version is picked up
 *   by the next email with no other change.
 * - At most MAX_TOTAL_BYTES in all; anything over is left off and logged.
 * - Never fails the email: a file that can't be fetched is left off, the
 *   email still goes, and its wording only names what is attached.
 */
import { query } from '../config/database';
import { getFromR2 } from '../config/r2';
import type { EmailAttachment } from './email-service';

/** Keep the email well inside what mail servers accept. */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function contentTypeOf(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  return ({
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  } as Record<string, string>)[ext] || 'application/octet-stream';
}

async function readR2(key: string): Promise<Buffer> {
  const obj = await getFromR2(key);
  const chunks: Buffer[] = [];
  for await (const chunk of obj.Body as NodeJS.ReadableStream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** "A", "A and B", "A, B and C". */
export function joinTitles(titles: string[]): string {
  if (titles.length <= 1) return titles[0] || '';
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** The files to attach (oldest document first) and their titles, for the email's wording. */
export async function approvalEmailDocuments(): Promise<{ files: EmailAttachment[]; titles: string[] }> {
  const r = await query(
    `SELECT d.title, v.file_r2_key, v.file_name
       FROM staff_documents d
       JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
      WHERE d.attach_to_approval_email = true
        AND d.shareable_with_freelancers = true
        AND d.is_active = true AND d.approval_status = 'approved'
        AND v.file_r2_key IS NOT NULL
      ORDER BY d.created_at, d.title`,
  );
  const files: EmailAttachment[] = [];
  const titles: string[] = [];
  let total = 0;
  for (const row of r.rows as Array<{ title: string; file_r2_key: string; file_name: string | null }>) {
    try {
      const content = await readR2(row.file_r2_key);
      if (total + content.length > MAX_TOTAL_BYTES) {
        console.warn(`[approval-email] "${row.title}" left off: the attachments would pass ${MAX_TOTAL_BYTES} bytes`);
        continue;
      }
      total += content.length;
      const filename = row.file_name || `${row.title}.pdf`;
      files.push({ filename, content, contentType: contentTypeOf(filename) });
      titles.push(row.title);
    } catch (err) {
      console.error(`[approval-email] couldn't fetch "${row.title}" (${row.file_r2_key}); sending without it:`, err);
    }
  }
  return { files, titles };
}
