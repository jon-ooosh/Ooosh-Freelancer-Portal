/**
 * Staff Calendar notifications (Phase C follow-up).
 *
 * See docs/STAFF-CALENDAR-SPEC.md §11.
 *
 * TWO LAYERS, deliberately:
 *
 *   1. IN-APP, IMMEDIATELY. Uses the existing notifications table and the bell
 *      already in the nav, deeplinked via action_url. Free, instant, and it
 *      costs nothing to send one per event.
 *
 *   2. AN EMAIL PER REQUEST, because the bell alone gets missed (jon, Sep 2026
 *      — the original digest-only design was mine and it was wrong for how he
 *      actually works: a bell you have to be looking at is not an alert).
 *
 *   3. A DAILY DIGEST as the backstop, and only when something is STILL
 *      waiting. That means it now lists things that were already emailed and
 *      not acted on — which is exactly the useful signal, not a duplicate.
 *
 * Every send is best-effort and swallowed. A notification failing must never
 * roll back the request it was announcing.
 */

import { query } from '../config/database';
import { emailService } from './email-service';

const STAFF_URL = '/staff/admin';

function fmtH(min: number): string {
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  const sign = min < 0 ? '-' : '';
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/**
 * Everyone who can decide these. Admin only for now — one chokepoint (spec §11).
 *
 * PREFERS admins who are also employees, which excludes service and
 * integration logins: System Service holds 'admin' so automated writes are
 * authorised, but it does not read a notification bell and should not receive
 * a daily email.
 *
 * FALLS BACK to every active admin if that set is empty. Notifying nobody is a
 * far worse failure than notifying a service account — requests would pile up
 * unseen and silently, which is exactly the problem this exists to solve. The
 * fallback logs why so the cause is visible rather than mysterious.
 */
async function approverUserIds(): Promise<{ id: string; email: string }[]> {
  const employed = await query(
    `SELECT u.id, u.email
       FROM users u
       JOIN staff_employment se ON se.person_id = u.person_id
      WHERE u.role = 'admin'
        AND u.is_active = true
        AND se.employment_status = 'employed'`);
  if (employed.rows.length > 0) return employed.rows;

  const all = await query(
    `SELECT id, email FROM users WHERE role = 'admin' AND is_active = true`);
  if (all.rows.length > 0) {
    console.warn(
      '[staff-notifications] no admin has an employment record — falling back to all ' +
      `${all.rows.length} active admin(s). Set one up on /staff/admin to silence this.`);
  }
  return all.rows;
}

async function notify(
  userId: string, type: string, title: string, content: string,
  entityType: string, entityId: string, actionUrl: string,
  priority: 'low' | 'normal' | 'high' = 'normal'
) {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, type, title, content, entityType, entityId, actionUrl, priority]
  ).catch(e => console.error('[staff-notifications] notify failed:', e));
}

// ── Something needs the approver ────────────────────────────────────────────

export async function notifyLeaveRequested(requestId: string) {
  try {
    const r = await query(
      `SELECT r.id, r.leave_type, r.total_minutes, r.request_note,
              r.start_date::text AS start_date, r.end_date::text AS end_date,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_leave_requests r JOIN people p ON p.id = r.person_id
        WHERE r.id = $1`, [requestId]);
    const q = r.rows[0];
    if (!q) return;
    const range = q.start_date === q.end_date
      ? fmtDate(q.start_date) : `${fmtDate(q.start_date)} – ${fmtDate(q.end_date)}`;
    const what = q.leave_type === 'holiday' ? 'holiday' : q.leave_type === 'toil' ? 'TOIL' : 'unpaid leave';
    for (const u of await approverUserIds()) {
      await notify(u.id, 'follow_up',
        `${q.name} has requested ${what}`,
        `${range} · ${fmtH(Number(q.total_minutes))}`,
        'staff_leave_request', q.id, STAFF_URL);
    }
    await emailApprovers(
      `${q.name} has requested ${what}`,
      `${esc(q.name)} has requested ${esc(what)}`,
      [
        `<strong>${esc(range)}</strong> — ${fmtH(Number(q.total_minutes))}`,
        ...(q.request_note ? [`<span style="color:#64748b;">“${esc(q.request_note)}”</span>`] : []),
      ],
      STAFF_URL);
  } catch (e) { console.error('[staff-notifications] leave requested:', e); }
}

export async function notifyOvertimeLogged(entryId: string) {
  try {
    const r = await query(
      `SELECT e.id, e.minutes, e.reason, e.work_date::text AS work_date,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_overtime_entries e JOIN people p ON p.id = e.person_id
        WHERE e.id = $1`, [entryId]);
    const q = r.rows[0];
    if (!q) return;
    for (const u of await approverUserIds()) {
      await notify(u.id, 'follow_up',
        `${q.name} logged ${fmtH(Number(q.minutes))} overtime`,
        `${fmtDate(q.work_date)} — ${q.reason}`,
        'staff_overtime_entry', q.id, STAFF_URL);
    }
    await emailApprovers(
      `${q.name} logged ${fmtH(Number(q.minutes))} overtime`,
      `${esc(q.name)} logged ${fmtH(Number(q.minutes))} overtime`,
      [
        `<strong>${esc(fmtDate(q.work_date))}</strong> — ${fmtH(Number(q.minutes))}`,
        `<span style="color:#64748b;">${esc(q.reason)}</span>`,
      ],
      STAFF_URL);
  } catch (e) { console.error('[staff-notifications] overtime logged:', e); }
}

/**
 * Email the approver about one new request.
 *
 * Deliberately separate from the digest: this fires immediately, the digest
 * catches what is still outstanding the next morning.
 *
 * NOTE ON DELIVERY: with EMAIL_MODE=test (the default), a template only
 * reaches real recipients if its id is in EMAIL_LIVE_TEMPLATES. Both
 * staff_time_request and staff_time_digest need adding there, or these land
 * redirected/[TEST]-prefixed and look like nothing was sent.
 */
async function emailApprovers(subject: string, heading: string, lines: string[], linkPath: string) {
  const approvers = await approverUserIds();
  if (approvers.length === 0) return;

  const base = process.env.APP_BASE_URL || 'https://staff.oooshtours.co.uk';
  const body =
    `<h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">${esc(heading)}</h2>` +
    lines.map(l => `<p style="margin:0 0 8px;font-size:15px;color:#334155;line-height:1.6;">${l}</p>`).join('') +
    `<p style="margin:24px 0 0;"><a href="${base}${linkPath}" ` +
    `style="display:inline-block;padding:10px 18px;background:#7B5EA7;color:#fff;` +
    `border-radius:6px;text-decoration:none;font-size:15px;">Review and approve</a></p>`;

  for (const a of approvers) {
    await emailService.send('staff_time_request', {
      to: a.email, subjectOverride: subject, bodyHtmlOverride: body,
    }).catch(e => console.error('[staff-notifications] request email failed:', e));
  }
}

// ── The requester hears back ────────────────────────────────────────────────

/**
 * Tell someone what happened to their request.
 *
 * Easy to forget and the most-missed thing in systems like this: the person
 * who asked should not have to go and look.
 */
export async function notifyDecision(opts: {
  personId: string;
  kind: 'leave' | 'overtime';
  outcome: 'approved' | 'declined' | 'cancelled';
  summary: string;
  note?: string | null;
  entityId: string;
}) {
  try {
    const u = await query(
      `SELECT id FROM users WHERE person_id = $1 AND is_active = true LIMIT 1`, [opts.personId]);
    const userId = u.rows[0]?.id;
    if (!userId) return;   // no login — nothing to notify to
    const what = opts.kind === 'leave' ? 'Time off' : 'Overtime';
    await notify(userId, 'system',
      `${what} ${opts.outcome}: ${opts.summary}`,
      opts.note ?? '',
      opts.kind === 'leave' ? 'staff_leave_request' : 'staff_overtime_entry',
      opts.entityId, '/staff/me',
      opts.outcome === 'declined' ? 'high' : 'normal');
  } catch (e) { console.error('[staff-notifications] decision:', e); }
}

// ── The daily digest ────────────────────────────────────────────────────────

export interface DigestResult {
  pendingLeave: number;
  pendingOvertime: number;
  emailed: boolean;
  skippedReason?: string;
}

/**
 * One email a day, only when something is waiting.
 *
 * Returns what it found either way so the scheduler log says why it stayed
 * quiet — "nothing pending" is a result, not a failure.
 */
export async function runStaffTimeDigest(): Promise<DigestResult> {
  const [leave, overtime] = await Promise.all([
    query(
      `SELECT r.id, r.leave_type, r.total_minutes, r.request_note,
              r.start_date::text AS start_date, r.end_date::text AS end_date,
              r.requested_at,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_leave_requests r JOIN people p ON p.id = r.person_id
        WHERE r.status = 'pending'
        ORDER BY r.start_date`),
    query(
      `SELECT e.id, e.minutes, e.reason, e.work_date::text AS work_date,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_overtime_entries e JOIN people p ON p.id = e.person_id
        WHERE e.status = 'pending'
        ORDER BY e.work_date`),
  ]);

  const result: DigestResult = {
    pendingLeave: leave.rows.length,
    pendingOvertime: overtime.rows.length,
    emailed: false,
  };
  if (result.pendingLeave === 0 && result.pendingOvertime === 0) {
    result.skippedReason = 'nothing pending';
    return result;
  }

  const approvers = await approverUserIds();
  if (approvers.length === 0) {
    result.skippedReason = 'no active admin to send to';
    return result;
  }

  const rows: string[] = [];
  if (leave.rows.length > 0) {
    rows.push(`<h3 style="margin:20px 0 8px;font-size:15px;color:#1e293b;">Time off (${leave.rows.length})</h3>`);
    for (const q of leave.rows) {
      const range = q.start_date === q.end_date
        ? fmtDate(q.start_date) : `${fmtDate(q.start_date)} – ${fmtDate(q.end_date)}`;
      rows.push(
        `<p style="margin:0 0 8px;font-size:14px;color:#334155;line-height:1.5;">` +
        `<strong>${esc(q.name)}</strong> — ${esc(q.leave_type)} · ${esc(range)} · ${fmtH(Number(q.total_minutes))}` +
        (q.request_note ? `<br><span style="color:#64748b;">“${esc(q.request_note)}”</span>` : '') +
        `</p>`
      );
    }
  }
  if (overtime.rows.length > 0) {
    rows.push(`<h3 style="margin:20px 0 8px;font-size:15px;color:#1e293b;">Overtime (${overtime.rows.length})</h3>`);
    for (const q of overtime.rows) {
      rows.push(
        `<p style="margin:0 0 8px;font-size:14px;color:#334155;line-height:1.5;">` +
        `<strong>${esc(q.name)}</strong> — ${fmtH(Number(q.minutes))} on ${esc(fmtDate(q.work_date))}` +
        `<br><span style="color:#64748b;">${esc(q.reason)}</span></p>`
      );
    }
  }

  const total = result.pendingLeave + result.pendingOvertime;
  const base = process.env.APP_BASE_URL || 'https://staff.oooshtours.co.uk';
  const body =
    `<h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">` +
    `${total} thing${total === 1 ? '' : 's'} waiting for you</h2>` +
    rows.join('') +
    `<p style="margin:24px 0 0;"><a href="${base}${STAFF_URL}" ` +
    `style="display:inline-block;padding:10px 18px;background:#7B5EA7;color:#fff;` +
    `border-radius:6px;text-decoration:none;font-size:15px;">Review and approve</a></p>`;

  // Report what actually happened. Swallowing the failure AND reporting
  // emailed:true would make the scheduler log claim a send that never left.
  let sent = 0;
  for (const a of approvers) {
    const r = await emailService.send('staff_time_digest', {
      to: a.email,
      subjectOverride: `${total} staff time request${total === 1 ? '' : 's'} waiting`,
      bodyHtmlOverride: body,
    }).catch(e => {
      console.error('[staff-notifications] digest email failed:', e);
      return null;
    });
    if (r?.success) sent++;
  }
  result.emailed = sent > 0;
  if (sent === 0) result.skippedReason = 'every send failed — see the email log';
  return result;
}
