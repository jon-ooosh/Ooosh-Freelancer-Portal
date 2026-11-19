/**
 * The staff "How do I…?" guides (help/README.md). Each guide is a folder under
 * /help/guides: a `guide.json` in a fixed shape plus its screenshots. They live in the
 * repo, not the database, so a guide changes in the same PR as the screen it describes;
 * `scripts/check-help-coverage.mjs` fails a PR that touches a guide's `covers` files and
 * leaves the guide alone.
 *
 * Everything is bundled at build time (no request, nothing to go stale between deploys).
 */
export interface GuideStep {
  text: string;
  detail?: string;
  /** A screenshot file in the guide's folder. */
  image?: string;
  /** Who does this step, when it isn't everyone ("Manager"). */
  who?: string;
  /** Where the step happens: 'job' / 'job:money' (needs a job to link to) or an absolute path. */
  open?: string;
  /** Another guide that carries on from here. */
  see?: string;
}
export interface Guide {
  slug: string;
  /** The question staff would ask, as a task: "Keep a client's overpayment for their next hire". */
  title: string;
  area: string;
  who: string;
  /** YYYY-MM-DD — the last time the steps and screenshots were checked against the app. */
  checked: string;
  summary: string;
  useWhen: string[];
  notWhen: Array<{ text: string; see?: string }>;
  steps: GuideStep[];
  next: string[];
  wrong: Array<{ problem: string; fix: string }>;
  related?: string[];
  /** App routes this guide is about — the "?" button offers it on those pages. */
  routes: string[];
  keywords?: string[];
  /** Code the guide describes (globs from the repo root) — for the PR check, not the page. */
  covers: string[];
}

const files = import.meta.glob('../../../help/guides/*/guide.json', { eager: true, import: 'default' }) as Record<string, Omit<Guide, 'slug'>>;
const images = import.meta.glob('../../../help/guides/*/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const slugOf = (path: string) => path.split('/').slice(-2, -1)[0];

export const GUIDES: Guide[] = Object.entries(files)
  .map(([path, g]) => ({ ...g, slug: slugOf(path) }))
  .sort((a, b) => a.area.localeCompare(b.area) || a.title.localeCompare(b.title));

// Who sees Help (the ? in the header and the /help pages). Admins only while the first
// guides are written (jon, 19 Nov 2026); to release it to everyone, list the staff roles
// here or return true. Nothing in a guide is private - this is "not ready", not a lock.
const HELP_ROLES = ['admin'];
export const canSeeHelp = (role: string | null | undefined): boolean => !!role && HELP_ROLES.includes(role);

export const guideBySlug = (slug: string | undefined): Guide | null => GUIDES.find((g) => g.slug === slug) ?? null;

export function guideImage(slug: string, file: string | undefined): string | null {
  if (!file) return null;
  const hit = Object.entries(images).find(([path]) => path.endsWith(`/guides/${slug}/${file}`));
  return hit ? hit[1] : null;
}

/** '/jobs/:id' matches '/jobs/abc' — segment by segment, ':x' matching anything. */
function routeMatches(pattern: string, pathname: string): boolean {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  return p.length === a.length && p.every((seg, i) => seg.startsWith(':') || seg === a[i]);
}

/** The guides about the page someone is on. */
export const guidesForPath = (pathname: string): Guide[] =>
  GUIDES.filter((g) => g.routes.some((r) => routeMatches(r, pathname)));

/** A plain search: every word typed must appear somewhere in the guide. */
export function searchGuides(q: string): Guide[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return GUIDES;
  return GUIDES.filter((g) => {
    const hay = [g.title, g.summary, g.area, ...(g.keywords ?? []), ...g.useWhen, ...g.steps.map((s) => s.text), ...g.wrong.map((w) => w.problem)]
      .join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Where a step's "Open …" link goes. A job step needs a job: the "?" button passes the
 * page the guide was opened from (`?from=/jobs/<id>`), and a guide opened from the Help
 * page has none — then the step shows no link rather than a wrong one.
 */
export function stepLink(open: string | undefined, from: string | null): { to: string; label: string } | null {
  if (!open) return null;
  if (open.startsWith('/')) return { to: open, label: 'Open this page' };
  const m = /^\/jobs\/([0-9a-f-]{36})/i.exec(from || '');
  if (!m) return null;
  if (open === 'job:money') return { to: `/jobs/${m[1]}?tab=money`, label: 'Open this job\'s Money tab' };
  if (open === 'job') return { to: `/jobs/${m[1]}`, label: 'Open this job' };
  return null;
}

export const guideDate = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
