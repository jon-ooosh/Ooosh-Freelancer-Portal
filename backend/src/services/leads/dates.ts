/**
 * A DATE column as 'YYYY-MM-DD', whatever the server's timezone.
 *
 * node-postgres returns DATE as a JS Date at LOCAL midnight, so
 * `toISOString()` (UTC) moves it back a day on a server running UK summer time
 * — an enquiry made from a lead would start a day early. Read the local parts
 * instead. Strings pass through.
 */
export function dateOnly(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
