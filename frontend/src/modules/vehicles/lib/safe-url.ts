/**
 * A return / start link taken from the URL is attacker-controllable. Rendered
 * as an <a href>, `javascript:…` would run in OP's origin, where a staff login
 * sits in storage — anyone could mail a staff member a crafted book-out,
 * collection or prep link. Only plain http(s) addresses are kept.
 * (Security audit brief, Oct 2026.)
 */
export function safeReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}
