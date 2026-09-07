/**
 * Which files ride along with a cost when it's pushed to Xero, and what they're
 * called when they get there.
 *
 * Pure, so it can be tested without a database or a Xero token — the filename
 * collision this prevents is silent in Xero (a PUT to an existing attachment
 * name OVERWRITES it), so it must not be able to regress unnoticed.
 *
 * Lives apart from cost-xero-push.ts for exactly that reason; the push imports
 * it rather than owning it.
 */

/** One supporting document as stored in costs.supporting_documents (JSONB). */
export interface CostDocumentRow {
  r2_key?: string | null;
  filename?: string | null;
  content_type?: string | null;
}

/** The shape collectDocuments needs off a cost row. */
export interface DocumentSource {
  receipt_r2_key: string | null;
  receipt_filename: string | null;
  supporting_documents: CostDocumentRow[] | null;
}

export interface AttachableDocument {
  r2Key: string;
  filename: string;
  contentType: string;
}

/** Xero allows 10 attachments per invoice / bank transaction. */
export const MAX_XERO_ATTACHMENTS = 10;

/** Xero rejects path separators in an attachment name; keep it plain. */
export function sanitiseAttachmentName(name: string): string {
  const cleaned = name.replace(/[\\/\r\n]+/g, '-').trim();
  return (cleaned || 'document').slice(0, 200);
}

/** `receipt.pdf` + 1 → `receipt-1.pdf` (extension preserved). */
export function suffixFilename(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${n}`;
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

/**
 * Everything filed against a cost, in attach order: the main receipt first,
 * then supporting documents as staff added them.
 *
 * ⚠️ Xero keys an attachment by FILENAME — two files both called `receipt.pdf`
 * would silently overwrite each other on the same bill, so the second one would
 * simply not exist. Duplicates are renamed in the PAYLOAD only
 * (`receipt.pdf`, `receipt-1.pdf`); OP keeps whatever name staff uploaded. The
 * rename is deterministic (stable order in, same suffix out), so a re-sync
 * overwrites the same attachments rather than piling up new ones.
 */
export function collectDocuments(cost: DocumentSource): AttachableDocument[] {
  const raw: AttachableDocument[] = [];
  if (cost.receipt_r2_key && cost.receipt_filename) {
    raw.push({
      r2Key: cost.receipt_r2_key,
      filename: cost.receipt_filename,
      contentType: guessContentType(cost.receipt_filename),
    });
  }
  for (const doc of cost.supporting_documents || []) {
    if (!doc?.r2_key || !doc?.filename) continue;
    raw.push({
      r2Key: doc.r2_key,
      filename: doc.filename,
      contentType: doc.content_type || guessContentType(doc.filename),
    });
  }

  const seen = new Map<string, number>();
  return raw.slice(0, MAX_XERO_ATTACHMENTS).map((d) => {
    const safe = sanitiseAttachmentName(d.filename);
    const lower = safe.toLowerCase();
    const n = seen.get(lower) ?? 0;
    seen.set(lower, n + 1);
    return n === 0 ? { ...d, filename: safe } : { ...d, filename: suffixFilename(safe, n) };
  });
}

/** True when the cost has anything at all to attach. */
export function hasDocuments(cost: DocumentSource): boolean {
  return Boolean(cost.receipt_r2_key) || (cost.supporting_documents || []).some((d) => Boolean(d?.r2_key));
}

/** Content type from the extension; Xero needs one on every attachment. */
export function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'heic': return 'image/heic';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}
