/**
 * Shared font loader for pdf-lib PDFs.
 *
 * Loads Roboto TTFs bundled in backend/src/services/fonts/ and caches the
 * buffers in memory. Roboto covers the full Unicode range we need — WinAnsi
 * StandardFonts crash on characters like "✓" (U+2713), em-dashes, curly
 * quotes, ellipses etc., which freelance staff routinely type into notes.
 *
 * The build script (package.json) copies the .ttf files into dist/ so prod
 * resolves them at runtime. If the files are missing (e.g. in a test env),
 * callers fall back to StandardFonts on their own.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

let cachedFonts: { regular: Buffer; bold: Buffer } | null = null;

export function loadRobotoFonts(): { regular: Buffer; bold: Buffer } | null {
  if (cachedFonts) return cachedFonts;

  const fontsDir = join(__dirname, 'fonts');
  const regularPath = join(fontsDir, 'Roboto-Regular.ttf');
  const boldPath = join(fontsDir, 'Roboto-Bold.ttf');

  if (existsSync(regularPath) && existsSync(boldPath)) {
    cachedFonts = {
      regular: readFileSync(regularPath),
      bold: readFileSync(boldPath),
    };
    return cachedFonts;
  }
  return null;
}
