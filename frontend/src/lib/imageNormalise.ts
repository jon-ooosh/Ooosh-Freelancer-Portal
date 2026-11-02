/**
 * Photo preparation for upload — THE place to turn "whatever a phone gives us"
 * into a JPEG we can store, show and embed in a PDF.
 *
 * Ported from the hire-form app (ooosh-driver-verification- src/POA1Page.js),
 * which learned the hard way that iPhones hand over HEIC — sometimes labelled
 * .jpg — which most browsers can't decode:
 *   1. read the photo's original capture time (EXIF) BEFORE anything else —
 *      canvas compression throws it away (docs/INCIDENT-CLAIMS-SPEC.md §10.3)
 *   2. detect HEIC by type, extension AND magic bytes
 *   3. convert HEIC → JPEG with heic2any, loaded only when needed
 *   4. compress + make a small PDF thumbnail in one decode (vehicle module's
 *      compressImageWithThumb)
 * If a step fails the original goes up untouched, without a thumbnail —
 * better a big photo than no photo.
 */
import { compressImageWithThumb } from '../modules/vehicles/lib/image-utils';

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1'];

export async function isHeic(file: Blob & { name?: string }): Promise<boolean> {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif')) return true;
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    // 'ftyp' at bytes 4–7, then the brand — catches HEIC labelled as .jpg.
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return HEIC_BRANDS.includes(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]));
    }
  } catch { /* unreadable — fall back to the checks above */ }
  return false;
}

/** The photo's original capture time as ISO, or null. Never throws. */
export async function readTakenAt(file: Blob): Promise<string | null> {
  try {
    const exifr = (await import('exifr')).default;
    const tags = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const d: unknown = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* no EXIF, or a format exifr can't read */ }
  return null;
}

export interface PreparedImage {
  blob: Blob;
  filename: string;
  thumb: Blob | null;
  takenAt: string | null;
}

export async function prepareImage(file: File, opts: { maxDimension?: number; thumbWidth?: number } = {}): Promise<PreparedImage> {
  const takenAt = await readTakenAt(file);
  let source: Blob = file;
  try {
    if (await isHeic(file)) {
      const heic2any = (await import('heic2any')).default;
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      source = Array.isArray(out) ? out[0] : out;
    }
    const { blob, pdfBase64 } = await compressImageWithThumb(source, opts.maxDimension ?? 2048, 0.85, opts.thumbWidth ?? 400, 0.7);
    const thumb = pdfBase64 ? await (await fetch(pdfBase64)).blob() : null;
    return { blob, filename: file.name.replace(/\.[^.]+$/, '') + '.jpg', thumb, takenAt };
  } catch {
    return { blob: file, filename: file.name, thumb: null, takenAt };
  }
}
