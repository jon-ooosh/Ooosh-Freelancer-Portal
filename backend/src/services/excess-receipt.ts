/**
 * excess-receipt.ts — attach a receipt scan to an excess record.
 *
 * Single source of truth for "a receipt scan arrived for this excess". Does two
 * things so the scan is both tracked on the excess AND discoverable where staff
 * look for it (the job's Files tab):
 *   1. Sets receipt_url / receipt_uploaded_at / receipt_required=false on job_excess.
 *   2. Appends a FileAttachment to the linked job's `files` JSONB.
 *
 * Called by POST /api/excess/:id/receipt (this-device upload) and the
 * /api/mobile-upload/:token side-effect (phone QR handoff).
 */
import { query } from '../config/database';

function fileType(key: string): 'image' | 'document' | 'other' {
  const lower = key.toLowerCase();
  if (/\.(jpg|jpeg|png|heic|webp|gif)$/.test(lower)) return 'image';
  if (lower.endsWith('.pdf')) return 'document';
  return 'other';
}

export async function attachExcessReceipt(opts: {
  excessId: string;
  key: string;
  filename?: string;
  uploadedBy: string | null;
  via?: string; // e.g. 'phone' — appended to the audit note
}): Promise<{ jobId: string | null }> {
  const { excessId, key, filename, uploadedBy, via } = opts;

  const cur = await query(`SELECT job_id, notes FROM job_excess WHERE id = $1`, [excessId]);
  if (cur.rows.length === 0) {
    throw new Error('Excess record not found');
  }
  const jobId: string | null = cur.rows[0].job_id;

  const dateStr = new Date().toISOString().split('T')[0];
  const note = `[${dateStr}] Receipt scan attached${via ? ` (via ${via})` : ''}.`;
  const newNotes = cur.rows[0].notes ? `${cur.rows[0].notes}\n${note}` : note;

  await query(
    `UPDATE job_excess SET
      receipt_url         = $1,
      receipt_uploaded_at = NOW(),
      receipt_required    = FALSE,
      notes               = $2,
      updated_at          = NOW()
    WHERE id = $3`,
    [key, newNotes, excessId]
  );

  // Surface the receipt on the job's Files tab — where staff expect to find it.
  if (jobId) {
    const attachment = {
      name: filename || 'Excess receipt',
      label: 'Excess receipt',
      url: key,
      type: fileType(key),
      uploaded_at: new Date().toISOString(),
      uploaded_by: uploadedBy || 'system',
    };
    await query(
      `UPDATE jobs SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify([attachment]), jobId]
    );
  }

  return { jobId };
}
