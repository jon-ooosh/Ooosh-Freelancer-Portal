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

/**
 * The portal's JOB page for a book-out / check-in. `returnUrl` is the portal's
 * /job/{id}/complete[?vanOnly=true]: where a FINISHED van step goes. Every
 * "back", "wrong van" and "cancel" link used it too, so a freelancer who backed
 * out landed on "Van Book-Out Complete — All Done" and could complete the job
 * with no van moved (Oct 2026). Those links go to the job page instead.
 * Anything that isn't that shape comes back unchanged (still made safe).
 */
export function portalJobUrl(returnUrl: string | null | undefined): string | null {
  const safe = safeReturnUrl(returnUrl)
  if (!safe) return null
  const u = new URL(safe)
  const m = u.pathname.match(/^(\/job\/[^/]+)\/complete\/?$/)
  if (!m) return safe
  u.pathname = m[1]
  u.search = ''
  u.hash = ''
  return u.toString()
}
