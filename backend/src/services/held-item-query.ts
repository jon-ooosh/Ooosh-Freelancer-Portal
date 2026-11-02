/**
 * The one SELECT every "held item" surface reads.
 *
 * It carries two derived pairs so no consumer ever re-derives them:
 *   next_chase_due / chase_state — the lost-property chase ladder
 *   next_action    / action_due  — "what does this need from a human, and when"
 *
 * This lives in a service rather than in routes/holding.ts because the dashboard
 * reads it too (On Today + the unlinked bucket). Re-deriving the action CASE in
 * a second place is exactly the drift this module has been bitten by before —
 * import this instead. Callers can append plain `WHERE h.…` clauses, or wrap it
 * (`SELECT * FROM (…) q`) to filter on the derived columns.
 */
// Shared SELECT with the joined display fields the frontend expects.
//
// Two derived pairs live here so every surface agrees:
//   next_chase_due / chase_state — the lost-property chase ladder
//   next_action    / action_due  — "what does this item need from me, and when"
//
// The chase expressions are computed once in a LATERAL so the action CASE can
// reference them without restating the logic (and so callers can keep appending
// plain `WHERE h.…` clauses).
export const HELD_ITEM_SELECT = `
  SELECT h.*,
         (p.first_name || ' ' || p.last_name)      AS owner_person_name,
         o.name                                    AS owner_organisation_name,
         loc.name                                  AS storage_location_name,
         j.job_name                                AS job_name,
         fv.reg                                    AS found_vehicle_reg,
         (rbp.first_name || ' ' || rbp.last_name)  AS received_by_name,
         (SELECT COUNT(*)::int FROM interactions i WHERE i.held_item_id = h.id) AS discussion_count,
         ch.next_chase_due,
         ch.chase_state,
         -- ── Next action ─────────────────────────────────────────────────
         -- One question per row: what does this need from a human? Ordered by
         -- precedence, not by kind — you cannot chase an owner you have not
         -- identified, and a passed review date outranks routine waiting.
         -- Consumed by the Holding page's action strip + filter, and (later)
         -- the dashboard bucket. Keep this and action_due in step.
         CASE
           WHEN h.status IN ('collected','given_to_client','shipped_back','disposed','cancelled') THEN 'none'
           WHEN h.owner_unknown THEN 'link_owner'
           WHEN h.hold_until IS NOT NULL AND h.hold_until <= CURRENT_DATE THEN 'decide'
           WHEN h.dispose_after IS NOT NULL AND h.dispose_after <= CURRENT_DATE THEN 'decide'
           WHEN h.kind = 'lost_property' THEN 'chase_owner'
           WHEN h.status = 'expected' THEN 'receive'
           ELSE 'hand_over'
         END                                       AS next_action,
         CASE
           WHEN h.status IN ('collected','given_to_client','shipped_back','disposed','cancelled') THEN NULL
           -- Unlinked items are ranked by age: the longer a mystery box sits,
           -- the colder the trail.
           WHEN h.owner_unknown THEN COALESCE(h.found_date, h.created_at::date)
           WHEN h.hold_until IS NOT NULL AND h.hold_until <= CURRENT_DATE THEN h.hold_until
           WHEN h.dispose_after IS NOT NULL AND h.dispose_after <= CURRENT_DATE THEN h.dispose_after
           WHEN h.kind = 'lost_property' THEN ch.next_chase_due
           WHEN h.status = 'expected' THEN COALESCE(h.expected_date, h.needed_by)
           ELSE COALESCE(h.needed_by, h.hold_until)
         END                                       AS action_due
  FROM held_items h
  LEFT JOIN people p              ON p.id = h.owner_person_id
  LEFT JOIN organisations o       ON o.id = h.owner_organisation_id
  LEFT JOIN held_item_locations loc ON loc.id = h.storage_location_id
  LEFT JOIN jobs j                ON j.id = h.job_id
  LEFT JOIN fleet_vehicles fv     ON fv.id = h.found_vehicle_id
  LEFT JOIN users rb              ON rb.id = h.received_by
  LEFT JOIN people rbp            ON rbp.id = rb.person_id
  -- Chase derivation — single source of truth; mirrors the daily scan in
  -- services/holding-reminders.ts so the list, detail card and review queue
  -- can never disagree about "what's due".
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN h.kind <> 'lost_property'
          OR h.status IN ('collected','shipped_back','disposed','cancelled')
          OR (h.owner_person_id IS NULL AND h.owner_organisation_id IS NULL)
          OR h.found_date IS NULL THEN NULL
        WHEN h.expected_collection_date IS NOT NULL AND h.expected_collection_date >= CURRENT_DATE
          THEN h.expected_collection_date
        ELSE GREATEST(
          (h.found_date + INTERVAL '7 days')::date,
          COALESCE((h.last_chased_at + INTERVAL '7 days')::date, (h.found_date + INTERVAL '7 days')::date)
        )
      END AS next_chase_due,
      CASE
        WHEN h.kind <> 'lost_property' THEN NULL
        WHEN h.status IN ('collected','shipped_back','disposed','cancelled')
          OR (h.owner_person_id IS NULL AND h.owner_organisation_id IS NULL)
          OR h.found_date IS NULL THEN 'none'
        WHEN h.expected_collection_date IS NOT NULL AND h.expected_collection_date >= CURRENT_DATE THEN 'paused'
        WHEN GREATEST(
          (h.found_date + INTERVAL '7 days')::date,
          COALESCE((h.last_chased_at + INTERVAL '7 days')::date, (h.found_date + INTERVAL '7 days')::date)
        ) <= CURRENT_DATE THEN 'due'
        ELSE 'scheduled'
      END AS chase_state
  ) ch ON TRUE
`;
