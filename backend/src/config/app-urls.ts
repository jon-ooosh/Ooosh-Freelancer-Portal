/**
 * Front-end URL resolution.
 *
 * All code that builds URLs pointing at the staff web app (for links inside
 * emails, bell notification action_urls and similar) should use
 * {@link getFrontendUrl} so the resulting href is always well-formed.
 *
 * Historical gotcha: FRONTEND_URL on the server was briefly set to
 * `https://49.13.158.66/` (IP + trailing slash), which combined with
 * action_urls like `/jobs/abc` produced `https://49.13.158.66//jobs/abc`
 * — double slash, IP rather than domain, mixed-content cert warning, broken.
 * Stripping the trailing slash here means that edge is defused even if the
 * env var is set untidily. The default is the real production domain, so
 * the absence of the env var on a new dev machine still gives a usable link.
 */
export function getFrontendUrl(): string {
  const raw = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';
  return raw.replace(/\/+$/, '');
}

/**
 * Join {@link getFrontendUrl} with a path that may or may not have a
 * leading slash. Always produces exactly one slash between host and path.
 */
export function frontendLink(path: string): string {
  const base = getFrontendUrl();
  if (!path) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}
