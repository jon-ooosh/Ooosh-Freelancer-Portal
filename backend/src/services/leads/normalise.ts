/**
 * Normalise an act's name for comparison: lowercase, drop a leading "the",
 * strip punctuation. "The Wedding Present" → "wedding present".
 *
 * Used for exact org matching, the suppression key ("never show this band
 * again"), and the band-name job search.
 */
export function normaliseArtist(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
