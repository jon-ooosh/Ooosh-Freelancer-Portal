/**
 * The social media planner — Marketing › Content (docs/BUSINESS-FIGURES-SPEC.md §8e,
 * jon 18 Nov 2026). Every read and write of marketing_posts / marketing_assets /
 * marketing_hashtag_sets goes through here.
 *
 * OP PLANS; Meta Business Suite schedules and posts. A post is one piece of content on one
 * or more channels; with no date it's an idea. Never deleted ('dropped'). Content (photos,
 * videos, graphics) lives in Google Drive and is kept here as links, in a library posts pick
 * from. A post's owner gets a To Do two days before it goes out if it isn't approved yet.
 *
 * Dates: a post's time is a UK wall-clock time. It goes in as (publish_date, publish_time)
 * and comes out the same way, converted in SQL — never through JS Date / toISOString.
 */
import { query } from '../config/database';
import { cancelTask, createTask, listTasksForSource } from './staff-tasks';
import { SHORT_LINK_BASE } from './marketing-links';
import { ukDatePlus, ukToday } from './uk-date';

export const POST_CHANNELS = ['instagram', 'facebook', 'newsletter', 'blog'] as const;
export const POST_FORMATS = ['reel', 'carousel', 'image', 'story', 'video', 'text', 'newsletter', 'article'] as const;
export const POST_STATUSES = ['idea', 'in_progress', 'review', 'approved', 'scheduled', 'published', 'dropped'] as const;
export const ASSET_KINDS = ['photo', 'video', 'graphic', 'other'] as const;
/** Still needs work — the owner is reminded while a post is one of these. */
export const NOT_READY = ['idea', 'in_progress', 'review'];
/** How many days before a post goes out its owner is reminded (jon: two). */
export const REMIND_DAYS_BEFORE = 2;

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export class ContentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const NAME = (a: string) => `NULLIF(TRIM(CONCAT_WS(' ', COALESCE(NULLIF(${a}.preferred_name, ''), ${a}.first_name), ${a}.last_name)), '')`;

const POST_SELECT = `
  SELECT mp.id, mp.title, mp.channels, mp.format, mp.caption, mp.hashtags, mp.theme, mp.status,
         to_char(mp.publish_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS publish_date,
         to_char(mp.publish_at AT TIME ZONE 'Europe/London', 'HH24:MI') AS publish_time,
         mp.owner_person_id, ${NAME('op')} AS owner_name,
         mp.job_id, j.hh_job_number AS job_number, COALESCE(j.job_name, j.client_name) AS job_name,
         mp.organisation_id, o.name AS organisation_name,
         mp.credit_person_id, ${NAME('cp')} AS credit_name,
         mp.tracked_link_id, ml.code AS tracked_link_code,
         mp.live_url, mp.notes, mp.status_changed_at, mp.created_at, mp.updated_at,
         (SELECT COUNT(*)::int FROM marketing_post_assets pa WHERE pa.post_id = mp.id) AS asset_count
    FROM marketing_posts mp
    LEFT JOIN people op ON op.id = mp.owner_person_id
    LEFT JOIN jobs j ON j.id = mp.job_id
    LEFT JOIN organisations o ON o.id = mp.organisation_id
    LEFT JOIN people cp ON cp.id = mp.credit_person_id
    LEFT JOIN marketing_links ml ON ml.id = mp.tracked_link_id`;

const ASSET_SELECT = `
  SELECT a.id, a.title, a.url, a.kind, a.notes, a.source, a.archived_at, a.created_at,
         a.credit_person_id, ${NAME('cp')} AS credit_name,
         a.job_id, j.hh_job_number AS job_number, COALESCE(j.job_name, j.client_name) AS job_name,
         a.organisation_id, o.name AS organisation_name,
         COALESCE(${NAME('ap')}, ${NAME('up')}) AS added_by_name,
         (SELECT COUNT(*)::int FROM marketing_post_assets pa WHERE pa.asset_id = a.id) AS used_in
    FROM marketing_assets a
    LEFT JOIN people cp ON cp.id = a.credit_person_id
    LEFT JOIN jobs j ON j.id = a.job_id
    LEFT JOIN organisations o ON o.id = a.organisation_id
    LEFT JOIN people ap ON ap.id = a.added_by_person_id
    LEFT JOIN users u ON u.id = a.added_by_user_id
    LEFT JOIN people up ON up.id = u.person_id`;

function withLink<T extends { tracked_link_code?: string | null }>(row: T): T & { tracked_link_url: string | null } {
  return { ...row, tracked_link_url: row.tracked_link_code ? SHORT_LINK_BASE + row.tracked_link_code : null };
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export type PostView = { view: 'calendar'; from: string; to: string } | { view: 'board' } | { view: 'ideas' };

/**
 * Calendar: posts dated in [from, to] (UK days), dropped left out. Board: everything not
 * dropped and not published more than 30 days ago. Ideas: no date, not dropped.
 */
export async function listPosts(v: PostView) {
  let where: string;
  const params: unknown[] = [];
  if (v.view === 'calendar') {
    params.push(v.from, v.to);
    where = `mp.publish_at IS NOT NULL AND mp.status <> 'dropped'
             AND (mp.publish_at AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date`;
  } else if (v.view === 'ideas') {
    where = `mp.publish_at IS NULL AND mp.status <> 'dropped'`;
  } else {
    where = `mp.status <> 'dropped' AND NOT (mp.status = 'published' AND mp.status_changed_at < NOW() - INTERVAL '30 days')`;
  }
  const r = await query(`${POST_SELECT} WHERE ${where} ORDER BY mp.publish_at NULLS LAST, mp.created_at DESC LIMIT 500`, params);
  return r.rows.map(withLink);
}

export async function getPost(id: string) {
  const r = await query(`${POST_SELECT} WHERE mp.id = $1`, [id]);
  if (!r.rows[0]) return null;
  const assets = await query(
    `${ASSET_SELECT} JOIN marketing_post_assets pa ON pa.asset_id = a.id AND pa.post_id = $1 ORDER BY pa.added_at`,
    [id],
  );
  return { ...withLink(r.rows[0]), assets: assets.rows };
}

export interface PostInput {
  title?: string;
  publish_date?: string | null;   // YYYY-MM-DD (UK); null = an idea
  publish_time?: string | null;   // HH:MM (UK); defaults to 18:00
  channels?: string[];
  format?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  theme?: string | null;
  status?: string;
  owner_person_id?: string | null;
  job_id?: string | null;
  organisation_id?: string | null;
  credit_person_id?: string | null;
  tracked_link_id?: string | null;
  live_url?: string | null;
  notes?: string | null;
  asset_ids?: string[];
}

const FIELDS = ['title', 'channels', 'format', 'caption', 'hashtags', 'theme', 'status', 'owner_person_id', 'job_id',
  'organisation_id', 'credit_person_id', 'tracked_link_id', 'live_url', 'notes'] as const;

const tidy = (v: unknown) => (typeof v === 'string' ? (v.trim() || null) : v);

export async function createPost(input: PostInput, userId: string) {
  if (!input.title?.trim()) throw new ContentError('Give the post a name');
  const publishAt = input.publish_date ? [input.publish_date, input.publish_time || '18:00'] : null;
  const r = await query(
    `INSERT INTO marketing_posts (title, publish_at, channels, format, caption, hashtags, theme, status, owner_person_id,
                                  job_id, organisation_id, credit_person_id, tracked_link_id, live_url, notes, created_by, updated_by)
     VALUES ($1, CASE WHEN $2::date IS NULL THEN NULL ELSE ($2::date + $3::time) AT TIME ZONE 'Europe/London' END,
             $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
     RETURNING id`,
    [input.title.trim(), publishAt?.[0] ?? null, publishAt?.[1] ?? '18:00', input.channels ?? [], tidy(input.format) ?? null,
      tidy(input.caption) ?? null, tidy(input.hashtags) ?? null, tidy(input.theme) ?? null,
      input.status || (input.publish_date ? 'in_progress' : 'idea'), input.owner_person_id || null, input.job_id || null,
      input.organisation_id || null, input.credit_person_id || null, input.tracked_link_id || null,
      tidy(input.live_url) ?? null, tidy(input.notes) ?? null, userId],
  );
  const id = r.rows[0].id as string;
  if (input.asset_ids) await setPostAssets(id, input.asset_ids);
  await syncPostReminder(id);
  return getPost(id);
}

/** Change a post — only the fields sent. */
export async function updatePost(id: string, input: PostInput, userId: string) {
  const before = await query(`SELECT status FROM marketing_posts WHERE id = $1`, [id]);
  if (!before.rows[0]) throw new ContentError('Post not found', 404);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of FIELDS) {
    if (input[f] === undefined) continue;
    if (f === 'title' && !String(input.title || '').trim()) throw new ContentError('Give the post a name');
    vals.push(f === 'channels' ? input.channels : (tidy(input[f]) ?? null));
    sets.push(`${f} = $${vals.length}`);
  }
  if (input.publish_date !== undefined) {
    if (input.publish_date) {
      vals.push(input.publish_date, input.publish_time || '18:00');
      sets.push(`publish_at = ($${vals.length - 1}::date + $${vals.length}::time) AT TIME ZONE 'Europe/London'`);
    } else {
      sets.push('publish_at = NULL');
    }
  }
  if (input.status !== undefined && input.status !== before.rows[0].status) sets.push('status_changed_at = NOW()');
  if (sets.length) {
    vals.push(userId, id);
    await query(`UPDATE marketing_posts SET ${sets.join(', ')}, updated_by = $${vals.length - 1}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  }
  if (input.asset_ids) await setPostAssets(id, input.asset_ids);
  await syncPostReminder(id);
  return getPost(id);
}

/** The post's content: exactly these library items, in this order of adding. */
async function setPostAssets(postId: string, assetIds: string[]): Promise<void> {
  const ids = Array.from(new Set(assetIds));
  await query(`DELETE FROM marketing_post_assets WHERE post_id = $1 AND NOT (asset_id = ANY($2::uuid[]))`, [postId, ids]);
  for (const a of ids) {
    await query(`INSERT INTO marketing_post_assets (post_id, asset_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [postId, a]);
  }
}

/** Themes already used, most used first — the theme box's suggestions. */
export async function listThemes(): Promise<string[]> {
  const r = await query(
    `SELECT theme FROM marketing_posts WHERE theme IS NOT NULL AND status <> 'dropped' GROUP BY theme ORDER BY COUNT(*) DESC, theme LIMIT 30`,
  );
  return r.rows.map((x) => x.theme as string);
}

// ── The owner's reminder (To Do) ─────────────────────────────────────────────

/**
 * One open To Do for a post's owner while it goes out within REMIND_DAYS_BEFORE days and
 * isn't approved yet; cancelled when it's approved / scheduled / published / dropped, moved
 * further out, or the owner changes. Never throws — the post is saved either way.
 */
export async function syncPostReminder(postId: string): Promise<void> {
  try {
    const r = await query(
      `SELECT title, status, owner_person_id,
              to_char(publish_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS publish_date,
              to_char(publish_at AT TIME ZONE 'Europe/London', 'HH24:MI') AS publish_time,
              to_char(publish_at AT TIME ZONE 'Europe/London', 'Dy FMDD Mon "at" HH24:MI') AS publish_label
         FROM marketing_posts WHERE id = $1`,
      [postId],
    );
    const p = r.rows[0] as { title: string; status: string; owner_person_id: string | null; publish_date: string | null; publish_label: string | null } | undefined;
    const open = (await listTasksForSource('marketing_post', postId) as Array<{ id: string; status: string; person_id: string; title: string }>)
      .filter((t) => t.status === 'open');
    const wanted = !!p && !!p.owner_person_id && !!p.publish_date && NOT_READY.includes(p.status)
      && p.publish_date >= ukToday() && p.publish_date <= ukDatePlus(REMIND_DAYS_BEFORE);
    // "Get it approved: "Ruby Road van shot" goes out Thu 19 Nov at 19:30"
    const title = p ? `Get it approved: "${p.title}" goes out ${p.publish_label || ''}`.trim() : '';
    if (wanted && open.length === 1 && open[0].person_id === p!.owner_person_id && open[0].title === title) return;
    for (const t of open) await cancelTask(t.id, SYSTEM_USER_ID, 'admin');
    if (!wanted) return;
    await createTask({
      title, dueDate: ukToday(), personId: p!.owner_person_id!, sourceType: 'marketing_post', sourceId: postId,
    }, SYSTEM_USER_ID, 'admin');
  } catch (err) {
    console.error(`[marketing-content] reminder for ${postId} not set (non-fatal):`, err);
  }
}

/**
 * Daily: every post coming into the reminder window gets its To Do, and every open
 * reminder is re-checked — so one whose day has gone by is closed rather than left
 * hanging. Never throws per post.
 */
export async function runPostReminders(): Promise<number> {
  const r = await query(
    `SELECT id FROM marketing_posts
      WHERE (owner_person_id IS NOT NULL AND publish_at IS NOT NULL AND status = ANY($1::text[])
             AND (publish_at AT TIME ZONE 'Europe/London')::date BETWEEN $2::date AND $3::date)
         OR id IN (SELECT source_id FROM staff_tasks WHERE source_type = 'marketing_post' AND status = 'open')`,
    [NOT_READY, ukToday(), ukDatePlus(REMIND_DAYS_BEFORE)],
  );
  for (const row of r.rows) await syncPostReminder(row.id);
  return r.rows.length;
}

// ── The content library ──────────────────────────────────────────────────────

export async function listAssets(opts: { search?: string; archived?: boolean } = {}) {
  const params: unknown[] = [];
  const where: string[] = [opts.archived ? 'a.archived_at IS NOT NULL' : 'a.archived_at IS NULL'];
  if (opts.search?.trim()) {
    params.push(`%${opts.search.trim()}%`);
    where.push(`(a.title ILIKE $1 OR a.notes ILIKE $1 OR o.name ILIKE $1 OR CAST(j.hh_job_number AS TEXT) ILIKE $1)`);
  }
  const r = await query(`${ASSET_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 300`, params);
  return r.rows;
}

export interface AssetInput {
  title?: string;
  url?: string;
  kind?: string;
  credit_person_id?: string | null;
  job_id?: string | null;
  organisation_id?: string | null;
  notes?: string | null;
}

export function checkUrl(url: string): string {
  const u = url.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) throw new ContentError('The link must start with https:// (a Google Drive share link, say)');
  return u;
}

export async function createAsset(input: AssetInput, by: { userId?: string | null; personId?: string | null; source?: 'staff' | 'sitter' }) {
  if (!input.title?.trim()) throw new ContentError('Say what it is');
  const url = checkUrl(input.url || '');
  const r = await query(
    `INSERT INTO marketing_assets (title, url, kind, credit_person_id, job_id, organisation_id, notes, source, added_by_user_id, added_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [input.title.trim(), url, input.kind || 'photo', input.credit_person_id || null, input.job_id || null,
      input.organisation_id || null, tidy(input.notes) ?? null, by.source || 'staff', by.userId || null, by.personId || null],
  );
  return (await query(`${ASSET_SELECT} WHERE a.id = $1`, [r.rows[0].id])).rows[0];
}

export async function updateAsset(id: string, input: AssetInput & { archived?: boolean }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of ['title', 'kind', 'credit_person_id', 'job_id', 'organisation_id', 'notes'] as const) {
    if (input[f] === undefined) continue;
    vals.push(tidy(input[f]) ?? null);
    sets.push(`${f} = $${vals.length}`);
  }
  if (input.url !== undefined) { vals.push(checkUrl(input.url)); sets.push(`url = $${vals.length}`); }
  if (input.archived !== undefined) sets.push(input.archived ? 'archived_at = NOW()' : 'archived_at = NULL');
  if (!sets.length) return (await query(`${ASSET_SELECT} WHERE a.id = $1`, [id])).rows[0] || null;
  vals.push(id);
  const r = await query(`UPDATE marketing_assets SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
  if (!r.rows[0]) throw new ContentError('Not found', 404);
  return (await query(`${ASSET_SELECT} WHERE a.id = $1`, [id])).rows[0];
}

/** Tracked links to pick for a post's call to action (the Links tab manages them). */
export async function listLinkChoices() {
  const r = await query(`SELECT id, code, label, destination FROM marketing_links WHERE is_active = true ORDER BY created_at DESC LIMIT 200`);
  return r.rows.map((l) => ({ ...l, short_url: SHORT_LINK_BASE + l.code }));
}

// ── Saved hashtag sets ───────────────────────────────────────────────────────

export async function listHashtagSets() {
  return (await query(`SELECT id, name, tags FROM marketing_hashtag_sets ORDER BY name`)).rows;
}

export async function saveHashtagSet(name: string, tags: string, userId: string) {
  if (!name.trim() || !tags.trim()) throw new ContentError('A set needs a name and some hashtags');
  await query(
    `INSERT INTO marketing_hashtag_sets (name, tags, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET tags = EXCLUDED.tags`,
    [name.trim(), tags.trim(), userId],
  );
  return listHashtagSets();
}

export async function deleteHashtagSet(id: string) {
  await query(`DELETE FROM marketing_hashtag_sets WHERE id = $1`, [id]);
  return listHashtagSets();
}
