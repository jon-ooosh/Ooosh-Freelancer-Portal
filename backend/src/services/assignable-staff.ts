/**
 * Who can be given something to do — THE definition, per CLAUDE.md's helper rule.
 *
 * Two pickers ask this question and, until now, answered it differently:
 *
 *   • To Do's "For" picker (staff-tasks.ts listAssignablePeople) went by ROLE,
 *     plus a hardcoded guard for the platform's own service account. That still
 *     offered the shared Front Desk login and the TEST account, and kept
 *     offering someone who had left while their login stayed active.
 *   • The job reminder picker went by a CURRENT employment record, which caught
 *     all three, but said nothing about role — so a freelancer login with an
 *     employment record would have been offered a job reminder it cannot open.
 *
 * Neither was wrong so much as partial, and two pickers disagreeing about who
 * exists is exactly the drift the helper rule exists to stop. The answer is
 * both tests at once:
 *
 *   active login  +  a staff role  +  a CURRENT employment record  +  not the
 *   service account
 *
 * Employment is what separates a person from a login: service, shared-terminal
 * and test accounts hold a role so automated writes are authorised, but nobody
 * is employed behind them and nobody reads their inbox. It is the same test
 * staff-notifications.ts uses to pick approvers, and the distinction
 * staff-employment.ts documents. Deliberately not a name or email match —
 * accounts get renamed and a hardcoded list rots silently.
 *
 * NOT a permission check. This is "who is a real colleague to offer in a
 * picker", not "who may do X" — that stays with authorize() and, for a task,
 * staff-tasks.ts assertCanTouch().
 */
import { query } from '../config/database';
import { STAFF_ROLES } from '../middleware/auth';

/**
 * The platform's own service account — same id as carnet-auto-email.ts and
 * gmail-ingestion.ts. It is an admin with a person row, so without this it
 * would read as somebody you could ask to do something.
 *
 * Redundant against the employment test below (nobody employed it), and kept
 * anyway: it states the intent, and it still holds if someone ever gives the
 * service account an employment record by mistake.
 */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface AssignableStaffRow {
  id: string;
  email: string | null;
  role: string;
  is_active: boolean;
  last_login: string | null;
  avatar_url: string | null;
  hh_user_id: number | null;
  person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
}

const SELECT_COLS = `u.id, u.email, u.role, u.is_active, u.last_login, u.avatar_url,
         u.hh_user_id, u.person_id, p.first_name, p.last_name, p.preferred_name`;

// Preferred name first so the picker sorts the way it reads (Jon, not Jonathan).
const ORDER = `ORDER BY COALESCE(NULLIF(p.preferred_name, ''), p.first_name), p.last_name`;

/**
 * Everyone who can be given something to do.
 *
 * Falls back to active staff-role logins when the employment test matches
 * NOBODY — the state the staff module was in mid-build, and the one a bad
 * migration could put it back into. An EMPTY picker, with staff unable to
 * assign anything to anyone, is a far worse failure than a slightly noisy
 * one, and the same reasoning staff-notifications.ts approverUserIds() uses.
 *
 * It does NOT fire when the table is half-populated — one record is enough to
 * engage the filter and hide everyone without one. That is why employment
 * records must be set up for the whole team, not some of it; the fallback is
 * a floor, not a safety net. `/staff/admin` is where they are created, and
 * this finds anyone missing one:
 *
 *   SELECT p.first_name, p.last_name, u.email
 *     FROM users u
 *     LEFT JOIN people p ON p.id = u.person_id
 *     LEFT JOIN staff_employment se ON se.person_id = u.person_id
 *    WHERE u.is_active = true AND se.person_id IS NULL;
 */
export async function listAssignableStaff(): Promise<AssignableStaffRow[]> {
  const roles = STAFF_ROLES as readonly string[];

  const r = await query(
    `SELECT ${SELECT_COLS}
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
      WHERE u.is_active = true
        AND u.role = ANY($1::text[])
        AND u.id <> $2::uuid
        AND EXISTS (SELECT 1 FROM staff_employment se
                     WHERE se.person_id = u.person_id
                       AND se.employment_status = 'employed')
      ${ORDER}`,
    [roles, SYSTEM_USER_ID]
  );
  if (r.rows.length > 0) return r.rows as AssignableStaffRow[];

  console.warn(
    '[assignable-staff] no active staff login has an employed staff_employment ' +
    'record — falling back to active staff roles. Set employment records up on ' +
    '/staff/admin to silence this.'
  );
  const fallback = await query(
    `SELECT ${SELECT_COLS}
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
      WHERE u.is_active = true
        AND u.role = ANY($1::text[])
        AND u.id <> $2::uuid
      ${ORDER}`,
    [roles, SYSTEM_USER_ID]
  );
  return fallback.rows as AssignableStaffRow[];
}

/**
 * The same set as people rather than logins, for anything keyed on `people`
 * (staff_tasks is person-owned; job_requirements is user-owned). Deduped,
 * because one person can hold more than one login.
 */
export async function listAssignablePeople(): Promise<
  { person_id: string; name: string | null }[]
> {
  const seen = new Set<string>();
  const out: { person_id: string; name: string | null }[] = [];
  for (const u of await listAssignableStaff()) {
    if (!u.person_id || seen.has(u.person_id)) continue;
    seen.add(u.person_id);
    const first = (u.preferred_name || u.first_name || '').trim();
    const last = (u.last_name || '').trim();
    out.push({ person_id: u.person_id, name: `${first} ${last}`.trim() || null });
  }
  return out;
}
