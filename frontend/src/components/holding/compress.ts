/**
 * Client-side image compression for held-item photos. These get attached to
 * client emails (delivery / lost-property notifications), so a raw 3-8 MB phone
 * photo would bloat the email and R2. Downscale to a long edge of ~1600px at
 * JPEG 0.8 (typically 200-500 KB) - plenty for evidence.
 *
 * Memory-safe per the codebase convention: decode via an object URL, revoke it
 * straight after the canvas draw, keep only one bitmap alive at a time. Falls
 * back to the original file if anything goes wrong (compression is best-effort).
 */
const MAX_EDGE = 1600;
const QUALITY = 0.8;

export async function compressImage(file: File): Promise<File> {
  // Only attempt for raster images; pass everything else (incl. HEIC the
  // browser can't decode) straight through.
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { width, height } = img;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    // Already small enough — don't re-encode (avoids quality loss for no gain).
    if (scale === 1 && file.size < 600_000) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size) return file;  // no gain — keep original
    const name = file.name.replace(/\.(png|webp|bmp|tiff?|heic|heif)$/i, '.jpg');
    return new File([blob], name.endsWith('.jpg') || name.endsWith('.jpeg') ? name : `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
