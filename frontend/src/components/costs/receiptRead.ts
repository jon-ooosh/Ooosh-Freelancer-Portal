/**
 * Getting a receipt in: the photo, the AI's read of it, and the network around
 * both. Shared by the laptop capture form (CostCaptureModal.tsx) and the phone
 * receipt page (pages/ReceiptCapturePage.tsx), so the two read a receipt the
 * same way (docs/design/cost-capture-redesign/DECISIONS.md, PR 3).
 */
import { api, isNoReply } from '../../services/api';
import { prepareImage } from '../../lib/imageNormalise';

/** What POST /costs/extract answers (services/cost-receipt-extract.ts). */
export interface ExtractedReceipt {
  supplier: string | null;
  cost_date: string | null;
  due_date: string | null;
  amount_gross: number | null;
  amount_vat: number | null;
  amount_net: number | null;
  vat_treatment: 'standard' | 'no_vat';
  invoice_number: string | null;
  job_number: string | null;
  vehicle_reg: string | null;
  mileage: number | null;
  service_type: 'service' | 'repair' | 'mot' | 'insurance' | 'tax' | 'tyre' | 'other' | null;
  description: string | null;
  category_code: string | null;
  confidence: 'high' | 'medium' | 'low';
  lines?: Array<{ description: string | null; amount_gross: number; amount_vat: number; category_code: string | null }>;
  supplier_matched?: { from: string; to: string };
  xero_contact_id?: string | null;
  supplier_suggestion?: { name: string; xero_contact_id: string };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, and run it again only when the server never answered (a phone
 * losing signal at the pump, a deploy restart): `isNoReply` in services/api.ts.
 * A real answer, even a refusal, is returned or thrown at once. Offline, it
 * waits for the connection (up to a minute) before the next go. Use it ONLY for
 * calls that are safe to repeat: reads, the AI read, an upload, re-attaching the
 * same photo. A save that creates something must look before it repeats.
 */
export async function retryOnNoReply<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isNoReply(e) || i >= attempts) throw e;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 60000);
          window.addEventListener('online', () => { clearTimeout(t); setTimeout(resolve, 500); }, { once: true });
        });
      } else {
        await wait(1500 * 2 ** (i - 1));
      }
    }
  }
}

/**
 * A photo ready to upload: HEIC (iPhones) converted to JPEG, shrunk to at most
 * 2048px on its long side, through THE photo helper (lib/imageNormalise.ts).
 * A receipt's text stays readable at that size; a 10MB original no longer goes
 * up, to R2, to the AI and to Xero. A PDF, or anything that isn't an image,
 * goes up as it is, and so does a photo the helper can't handle.
 */
export async function preparePhoto(file: File): Promise<File> {
  const looksLikeImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
  if (!looksLikeImage) return file;
  const p = await prepareImage(file);
  if (p.blob === file) return file;
  return new File([p.blob], p.filename, { type: p.blob.type || 'image/jpeg', lastModified: Date.now() });
}

/** Upload a file to the private bucket (as an attachment), asking again if the reply was lost. */
export async function uploadReceiptFile(file: File): Promise<{ r2_key: string; filename: string }> {
  return retryOnNoReply(() => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('attachment_only', 'true');
    return api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
  });
}

/** The AI's read of a receipt or invoice. Throws with the server's reason. */
export async function readReceipt(file: File): Promise<ExtractedReceipt> {
  const res = await retryOnNoReply(() => {
    const fd = new FormData();
    fd.append('file', file);
    return api.upload<{ data: ExtractedReceipt }>('/costs/extract', fd);
  }, 2);
  return res.data;
}

/** The reader's "not configured" (no API key) is not a bug: say what to do instead. */
export function readErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('not configured') ? 'AI extraction isn\'t enabled on the server yet — fill in the form manually.' : msg;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The amounts the AI read, as the form holds them. The document is
 * authoritative on VAT: no VAT shown → No VAT, never an assumed 20%. When VAT IS
 * shown, its actual figures are kept; only a VAT that really is 20% of net snaps
 * to the 20% mode, otherwise all three stay verbatim in Manual (recomputing at a
 * forced 20% mangled correct reads of non-20% documents). VAT-bearing but
 * incomplete figures are derived at 20% from the gross. Null = nothing read.
 */
export function amountsFromRead(ex: ExtractedReceipt): { vatMode: 'vat20' | 'none' | 'manual'; gross: string; vat: string; net: string } | null {
  const { amount_gross: gross, amount_vat: vat, amount_net: net } = ex;
  if (ex.vat_treatment === 'standard' && vat != null && vat > 0 && net != null && gross != null) {
    const is20 = Math.abs(vat - round2(net * 0.2)) <= 0.02;
    return { vatMode: is20 ? 'vat20' : 'manual', gross: gross.toFixed(2), vat: vat.toFixed(2), net: net.toFixed(2) };
  }
  if (ex.vat_treatment === 'standard' && gross != null) {
    const derivedNet = round2(gross / 1.2);
    return { vatMode: 'vat20', gross: String(gross), vat: round2(gross - derivedNet).toFixed(2), net: derivedNet.toFixed(2) };
  }
  const total = gross ?? net;
  if (total == null) return null;
  return { vatMode: 'none', gross: total.toFixed(2), vat: '0.00', net: total.toFixed(2) };
}
