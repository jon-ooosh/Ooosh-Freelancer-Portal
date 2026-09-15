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
const ABSENCE_URL = '/staff/absence';

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
  entityType: string,
  /**
   * The row this is ABOUT, or null when it is about no single row — a year-end
   * summary, say. It is a uuid column, so anything else is rejected, and the
   * insert below is deliberately non-fatal: passing a year here once meant the
   * email went out and the bell entry silently never appeared.
   */
  entityId: string | null,
  actionUrl: string,
  priority: 'low' | 'normal' | 'high' = 'normal'
) {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, type, title, content, entityType, entityId, actionUrl, priority]
  ).catch(e => console.error(`[staff-notifications] notify failed (${type}, ${entityType}):`, e));
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
 * DELIVERY: production runs EMAIL_MODE=live over Resend and has done since
 * mid-2026, so every registered template sends for real to the real recipient.
 * EMAIL_LIVE_TEMPLATES is the TEST-mode allowlist and is ignored entirely when
 * the mode is live — a new template needs nothing added to it. See
 * .claude/rules/email-and-notifications.md, which says so explicitly.
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

// ── Return to work (spec §7.3) ──────────────────────────────────────────────

/**
 * A sickness absence just closed and needs the return-to-work write-up.
 *
 * In-app AND email, like every other alert in this module — a bell you have to
 * be looking at is not an alert.
 */
export async function notifyRtwDue(absenceId: string) {
  try {
    const r = await query(
      `SELECT a.id, a.end_date::text AS end_date,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_absences a JOIN people p ON p.id = a.person_id
        WHERE a.id = $1`, [absenceId]);
    const q = r.rows[0];
    if (!q) return;

    for (const u of await approverUserIds()) {
      await notify(u.id, 'follow_up',
        `Return-to-work due for ${q.name}`,
        `Back on ${fmtDate(q.end_date)} — record the conversation`,
        'staff_absence', q.id, ABSENCE_URL);
    }
    await emailApprovers(
      `Return-to-work due for ${q.name}`,
      `${esc(q.name)} is back from sickness`,
      [
        `Returned <strong>${esc(fmtDate(q.end_date))}</strong>.`,
        'Record the return-to-work conversation: date, fit to return, any adjustments.',
      ],
      ABSENCE_URL);
  } catch (e) { console.error('[staff-notifications] rtw due:', e); }
}

export interface RtwChaseResult {
  outstanding: number;
  chased: number;
}

/**
 * Chase outstanding return-to-work records ONCE, after `chaseDays` (spec §7.3).
 *
 * Once, not daily: rtw_chased_at records that it fired. A nag that repeats
 * every morning gets filtered, and then the one that mattered is filtered too.
 */
export async function runRtwChase(chaseDays?: number): Promise<RtwChaseResult> {
  const { listRtwOutstanding, markRtwChased } = await import('./staff-absence');
  const { getRtwChaseDays } = await import('./staff-settings');
  const days = chaseDays ?? await getRtwChaseDays();
  const outstanding = await listRtwOutstanding();
  const due = outstanding.filter(a => a.daysWaiting >= days && !a.chasedAt);

  for (const a of due) {
    for (const u of await approverUserIds()) {
      await notify(u.id, 'follow_up',
        `Return-to-work still outstanding for ${a.personName}`,
        `Back on ${fmtDate(a.endDate)} — ${a.daysWaiting} days ago`,
        'staff_absence', a.id, ABSENCE_URL, 'high');
    }
    await emailApprovers(
      `Return-to-work still outstanding for ${a.personName}`,
      `${esc(a.personName)} returned ${esc(fmtDate(a.endDate))} and the conversation is not recorded`,
      [`That is <strong>${a.daysWaiting} days</strong> ago. This is the only reminder.`],
      ABSENCE_URL);
    await markRtwChased(a.id);
  }

  return { outstanding: outstanding.length, chased: due.length };
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

// ── Year-end overtime cash-out (spec §6.3, §17.2) ───────────────────────────

export interface CashOutReminderResult {
  sent: boolean;
  year: number;
  people: { personId: string; name: string; minutes: number }[];
  totalMinutes: number;
  skippedReason?: string;
}

/**
 * Remind whoever runs payroll that banked overtime needs paying out — and
 * DO NOT pay it out.
 *
 * The sweep itself stays a button. This is deliberate and it is the platform's
 * own rule: "never silently move money — surface a recomputed figure and let a
 * human decide" (CLAUDE.md). A cron that debits seven people's banks and
 * creates a payroll obligation while nobody is looking is exactly the thing
 * that rule exists to prevent, and the failure mode is expensive: the ledger
 * is append-only, so an unwanted sweep is corrected with reversing entries
 * rather than undone.
 *
 * What the scheduler removes is the "I forgot" failure, which is the one that
 * actually bites. §17.2 has banked overtime paid in DECEMBER's payroll, so the
 * real deadline is whenever that payroll closes — earlier than 31 December and
 * much earlier than 1 January. The reminder goes out on
 * `staff.overtime_cashout_reminder_day` with every figure already computed, so
 * running the sweep is one click on a number someone has read.
 *
 * WHY IT CHECKS DAILY THROUGH DECEMBER rather than using an annual cron: same
 * reasoning as runEntitlementSync. A server down on the 8th would otherwise
 * skip the year entirely. `staff.overtime_cashout_reminded_year` is stamped
 * once it sends, which is what stops it going out every morning until New Year
 * — the same lesson as rtw_chased_at.
 */
export async function runCashOutReminder(today = new Date()): Promise<CashOutReminderResult> {
  const year = today.getUTCFullYear();
  const empty: CashOutReminderResult = { sent: false, year, people: [], totalMinutes: 0 };

  const { getCashOutReminderDay, getOvertimeYearEnd } = await import('./staff-settings');
  const { getSystemSetting, setSystemSetting } = await import('../routes/system-settings');

  if (today.getUTCMonth() !== 11) {
    return { ...empty, skippedReason: 'not December' };
  }
  const fromDay = await getCashOutReminderDay();
  if (today.getUTCDate() < fromDay) {
    return { ...empty, skippedReason: `before ${fromDay} December` };
  }
  if ((await getSystemSetting('staff.overtime_cashout_reminded_year')) === String(year)) {
    return { ...empty, skippedReason: 'already sent this year' };
  }

  // 'expire' is available and not advised (§6.3). If anyone ever sets it,
  // reminding them to pay out would be wrong.
  if ((await getOvertimeYearEnd()) !== 'cash_out') {
    return { ...empty, skippedReason: 'policy is not cash_out' };
  }

  // Read through staff-balance, never a SUM of the ledger here.
  const { getBalance } = await import('./staff-balance');
  const staff = await query(
    `SELECT se.person_id, (p.first_name || ' ' || p.last_name) AS name
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed' AND p.is_deleted = false
      ORDER BY p.first_name, p.last_name`
  );

  const people: { personId: string; name: string; minutes: number }[] = [];
  for (const row of staff.rows) {
    const bal = await getBalance(row.person_id, 'overtime', year);
    if (bal.balanceMinutes > 0) {
      people.push({ personId: row.person_id, name: row.name, minutes: bal.balanceMinutes });
    }
  }

  if (people.length === 0) {
    // Nothing banked is a result, not a failure — and it still counts as
    // handled for the year, so this does not re-check every morning.
    await setSystemSetting('staff.overtime_cashout_reminded_year', String(year));
    return { ...empty, skippedReason: 'nobody has anything banked' };
  }

  const totalMinutes = people.reduce((s, p) => s + p.minutes, 0);

  for (const u of await approverUserIds()) {
    await notify(u.id, 'follow_up',
      `Banked overtime needs paying out before ${year} closes`,
      `${people.length} ${people.length === 1 ? 'person has' : 'people have'} ${fmtH(totalMinutes)} between them`,
      'staff_overtime_entry', null, STAFF_URL, 'high');
  }

  await emailApprovers(
    `Banked overtime to pay out before ${year} closes`,
    `Banked overtime at the end of ${year}`,
    [
      `Hours already worked cannot be forfeited, so the bank is <strong>paid out</strong> rather than expired.`,
      `This wants to land in <strong>December's payroll</strong>, so it needs doing before that closes.`,
      ...people.map(p => `<strong>${esc(p.name)}</strong> — ${fmtH(p.minutes)}`),
      `<strong>Total: ${fmtH(totalMinutes)}</strong>`,
      `Nothing has been posted. Run the year-end cash-out on the Staff page when you are happy with the figures.`,
    ],
    STAFF_URL);

  await setSystemSetting('staff.overtime_cashout_reminded_year', String(year));
  return { sent: true, year, people, totalMinutes };
}

/**
 * Say what the nightly entitlement sync actually did.
 *
 * Only called when something changed, so it is never a "nothing happened"
 * email. It matters most on the first run of a new leave year, where it is the
 * confirmation that everybody's allowance landed — and on a mid-year hours
 * change, where someone's balance moved without them asking for it and the
 * ledger line should not be the only trace.
 */
export async function notifyEntitlementPosted(result: {
  year: number;
  changed: { personId: string; name: string; postedMinutes: number; reason: string }[];
  failed: { personId: string; name: string; error: string }[];
}) {
  try {
    if (result.changed.length === 0 && result.failed.length === 0) return;

    const lines = [
      ...result.changed.map(c =>
        `<strong>${esc(c.name)}</strong> — ${c.postedMinutes > 0 ? '+' : ''}${fmtH(c.postedMinutes)} (${esc(c.reason.toLowerCase())})`),
      ...result.failed.map(f =>
        `<span style="color:#b91c1c;"><strong>${esc(f.name)}</strong> — could not be calculated: ${esc(f.error)}</span>`),
    ];
    const headline = result.failed.length > 0
      ? `Holiday entitlement for ${result.year} — ${result.failed.length} could not be calculated`
      : `Holiday entitlement posted for ${result.year}`;

    for (const u of await approverUserIds()) {
      await notify(u.id, result.failed.length > 0 ? 'follow_up' : 'system',
        headline,
        `${result.changed.length} updated${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}`,
        'staff_employment', null, STAFF_URL,
        result.failed.length > 0 ? 'high' : 'normal');
    }
    await emailApprovers(headline, headline, lines, STAFF_URL);
  } catch (e) { console.error('[staff-notifications] entitlement posted:', e); }
}
