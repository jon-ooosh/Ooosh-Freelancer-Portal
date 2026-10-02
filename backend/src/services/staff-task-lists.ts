/**
 * Shared To Do lists — docs/TASKS-SPEC.md §7, To Do phase 3.
 *
 * A list (staff_task_lists, mig 258) holds items nobody owns yet: Shopping,
 * Building. An ITEM is an ordinary staff_tasks row with `list_id` set and no
 * `person_id`; "I'll take it" gives it an owner (staff-tasks.ts `takeTask`) and
 * it keeps the list it came from. A list can also hold repeating to-dos with
 * no owner — the bins, the recycling — whose occurrences are list items.
 *
 * Lists are SHARED: any staff member can add one, rename it, add to it, tick
 * or drop an item. WATCHERS get the nudges for dated items nobody has taken
 * (staff-notifications.ts `runListItemChase`).
 */

import { query } from '../config/database';

const MAX_NAME = 60;

function cleanName(raw: string): string {
  const name = raw?.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('A list needs a name');
  if (name.length > MAX_NAME) throw new Error(`Keep a list name under ${MAX_NAME} characters`);
  return name;
}

/** Two live lists called "Shopping" would split the shopping in two. */
async function assertNameFree(name: string, exceptId: string | null) {
  const r = await query(
    `SELECT 1 FROM staff_task_lists
      WHERE archived_at IS NULL AND lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [name, exceptId]
  );
  if (r.rows.length) throw new Error(`There’s already a list called “${name}”`);
}

/** Every live list, with how much is on it and whether I'm watching. */
export async function listLists(myPersonId: string | null) {
  const r = await query(
    `SELECT l.id, l.name, l.created_at,
            (SELECT COUNT(*)::int FROM staff_tasks t
              WHERE t.list_id = l.id AND t.status = 'open' AND t.person_id IS NULL) AS open_count,
            (SELECT COUNT(*)::int FROM staff_tasks t
              WHERE t.list_id = l.id AND t.status = 'open' AND t.person_id IS NOT NULL) AS taken_count,
            EXISTS (SELECT 1 FROM staff_task_list_watchers w
                     WHERE w.list_id = l.id AND w.person_id = $1::uuid) AS watching,
            COALESCE((
              SELECT array_agg(NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                                           COALESCE(p.last_name, '')), '') ORDER BY p.first_name)
                FROM staff_task_list_watchers w JOIN people p ON p.id = w.person_id
               WHERE w.list_id = l.id), '{}') AS watchers
       FROM staff_task_lists l
      WHERE l.archived_at IS NULL
      ORDER BY lower(l.name)`,
    [myPersonId]
  );
  return r.rows;
}

export async function createList(rawName: string, userId: string) {
  const name = cleanName(rawName);
  await assertNameFree(name, null);
  const r = await query(
    `INSERT INTO staff_task_lists (name, created_by) VALUES ($1, $2) RETURNING id, name`,
    [name, userId]
  );
  return r.rows[0];
}

export async function renameList(id: string, rawName: string) {
  const name = cleanName(rawName);
  await assertNameFree(name, id);
  const r = await query(
    `UPDATE staff_task_lists SET name = $2 WHERE id = $1 AND archived_at IS NULL RETURNING id, name`,
    [id, name]
  );
  if (!r.rows.length) throw new Error('List not found');
  return r.rows[0];
}

/**
 * Archive — only once it's empty. An archived list with open items would
 * strand them: nobody sees the list, so nobody sees the items.
 */
export async function archiveList(id: string) {
  const busy = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM staff_tasks WHERE list_id = $1 AND status = 'open' AND person_id IS NULL) AS items,
       (SELECT COUNT(*)::int FROM staff_task_series WHERE list_id = $1 AND status = 'active') AS repeating`,
    [id]
  );
  const { items, repeating } = busy.rows[0];
  if (items || repeating) {
    const parts = [items ? `${items} item${items === 1 ? '' : 's'}` : null,
                   repeating ? `${repeating} repeating to-do${repeating === 1 ? '' : 's'}` : null].filter(Boolean);
    throw new Error(`It still has ${parts.join(' and ')} — tick, drop or stop them first`);
  }
  const r = await query(
    `UPDATE staff_task_lists SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id`,
    [id]
  );
  if (!r.rows.length) throw new Error('List not found');
  return { id };
}

/** Watch or stop watching — a person's own choice. */
export async function setWatching(listId: string, personId: string, on: boolean) {
  const list = await query('SELECT id FROM staff_task_lists WHERE id = $1 AND archived_at IS NULL', [listId]);
  if (!list.rows.length) throw new Error('List not found');
  if (on) {
    await query(
      `INSERT INTO staff_task_list_watchers (list_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [listId, personId]
    );
  } else {
    await query(`DELETE FROM staff_task_list_watchers WHERE list_id = $1 AND person_id = $2`, [listId, personId]);
  }
  return { listId, watching: on };
}
