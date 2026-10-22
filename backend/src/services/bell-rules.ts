/**
 * THE rule for every bell that asks somebody to do something (jon, Oct 2026).
 *
 * A bell is a copy of a fact at the moment it happened. One that ASKS for
 * something ("New issue", "Storage invoice due", "A to-do needs you") is
 * stamped with a key (`notifications.resolve_key`, migration 308), and the
 * key's rule here says, in SQL, when the bell is STILL NEEDED. Once that stops
 * being true the bell is retired — read and done, greyed in the dropdown,
 * hidden in the Inbox — by `retireDoneBells()` in notification-resolve.ts:
 *
 *   - straight away, from the code that finished the thing
 *     (`retireDoneBells('problem_open', issueId)`), and
 *   - on a 5-minute sweep (`sweepDoneBells()`), which catches every other
 *     path, including ones added later. That is the point of ONE rule per key
 *     rather than a "clear the bell" call in every place that can finish it:
 *     a forgotten call only delays the bell, it never strands it.
 *
 * Writing a rule:
 *   - `stillWaiting` is a SQL boolean over the bell row, aliased `n`
 *     (n.entity_type, n.entity_id, n.user_id, n.created_at). It is checked
 *     per bell, so a rule can be per-recipient through n.user_id.
 *   - Use EXISTS / NOT EXISTS. The sweep retires `NOT (stillWaiting)`; a NULL
 *     answer keeps the bell, so a rule that can be NULL fails safe but never
 *     retires anything — make it a plain true/false.
 *   - A deleted row counts as done (EXISTS goes false), which is what we want.
 *   - Only bells that ask for something get a key. An FYI bell ("Issue
 *     resolved") is done when it is read, and must never carry one.
 *   - Never a `$n` parameter in a rule: the sweep owns the parameters.
 *
 * Leave / overtime / WFH requests and @mentions are wired directly instead
 * (staff-notifications.ts retire…Bells, notification-resolve.ts
 * resolveMyThreadMentions) — they predate this file and are instant in their
 * one service.
 */

export interface BellRule {
  /** One line: what the bell asks for, and when that is done. */
  about: string;
  /** SQL boolean over the bell row `n`: TRUE while the thing still needs doing. */
  stillWaiting: string;
}

export const BELL_RULES = {
} as const satisfies Record<string, BellRule>;

export type BellKey = keyof typeof BELL_RULES;
