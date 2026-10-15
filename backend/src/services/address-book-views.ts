/**
 * "Recently viewed" for the address book — per user, per record.
 *
 * THE place that writes address_book_views (migration 289). Only the person /
 * organisation detail pages record a view (they pass ?track_view=1 on their
 * GET); pickers and forms read the same endpoint and must not count.
 */
import { query } from '../config/database';

export type AddressBookEntity = 'person' | 'organisation';

/** Upsert "this user opened this record now". Never throws — a view log must not break the page. */
export async function recordAddressBookView(userId: string | undefined, entityType: AddressBookEntity, entityId: string): Promise<void> {
  if (!userId) return;
  try {
    await query(
      `INSERT INTO address_book_views (user_id, entity_type, entity_id, viewed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = NOW()`,
      [userId, entityType, entityId]
    );
  } catch (err) {
    console.error('[address-book-views] record failed:', err);
  }
}

/**
 * ORDER BY fragment: what `userParam` viewed most recently first, then the rest.
 * `idColumn` is the list's id column (`p.id` / `o.id`); `userParam` its $n.
 */
export function recentlyViewedOrderSql(entityType: AddressBookEntity, idColumn: string, userParam: string): string {
  return `(SELECT abv.viewed_at FROM address_book_views abv
            WHERE abv.user_id = ${userParam} AND abv.entity_type = '${entityType}'
              AND abv.entity_id = ${idColumn}) DESC NULLS LAST`;
}
