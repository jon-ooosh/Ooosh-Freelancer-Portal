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
const SETTINGS_URL = '/settings';

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
async function emailApprovers(
  subject: string, heading: string, lines: string[], linkPath: string,
  // "Review and approve" is right for a leave request and wrong for "nobody has
  // confirmed for tomorrow", which is not a decision anybody is being asked to
  // make. Defaulted, so every existing caller is untouched.
  linkLabel = 'Review and approve',
) {
  const approvers = await approverUserIds();
  if (approvers.length === 0) return;

  const base = process.env.APP_BASE_URL || 'https://staff.oooshtours.co.uk';
  const body =
    `<h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">${esc(heading)}</h2>` +
    lines.map(l => `<p style="margin:0 0 8px;font-size:15px;color:#334155;line-height:1.6;">${l}</p>`).join('') +
    `<p style="margin:24px 0 0;"><a href="${base}${linkPath}" ` +
    `style="display:inline-block;padding:10px 18px;background:#7B5EA7;color:#fff;` +
    `border-radius:6px;text-decoration:none;font-size:15px;">${esc(linkLabel)}</a></p>`;

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

// ── Chasing an unanswered yard-day offer (spec §9.4) ───────────────────────

export interface OfferChaseResult {
  /** Offers still unanswered for a day that has not happened yet. */
  outstanding: number;
  /** Freelancers nudged once, today. */
  chased: number;
  /** Day-before alerts raised to admin, today. */
  alerted: number;
  /** Passed and still unanswered — the list waiting to be closed out. */
  needsClosing: number;
}

const CALENDAR_URL = '/staff/calendar';

/**
 * Two legs, one runner, each firing at most once per booking.
 *
 * LEG 1 — a nudge to the freelancer, `chaseDays` after we asked. Same email,
 * same link, one extra line. `offer_chased_at` stamps it so it cannot repeat:
 * a reminder that arrives every morning gets filtered, and then the one that
 * mattered is filtered with it — the same lesson as `rtw_chased_at`.
 *
 * LEG 2 — the day before, still nothing: the alert goes to ADMIN, not to them
 * (§9.4 decision 2). Two emails is a reminder; three is nagging somebody who
 * does not work for us, and by then it is our problem to solve rather than
 * their question to answer.
 *
 * NEITHER LEG EVER CHANGES A STATUS. An unanswered offer is never auto-declined
 * (§9.4 decision 1) — somebody who has not replied may still be planning to
 * turn up, and quietly removing them is the worse error.
 */
export async function runFreelancerOfferChase(chaseDays?: number): Promise<OfferChaseResult> {
  const { sendOfferEmail } = await import('./freelancer-day-offer');
  const { getOfferChaseDays } = await import('./staff-settings');
  const days = chaseDays ?? await getOfferChaseDays();

  // ── Leg 1: nudge them, once ──
  // Only bookings somebody was actually told about. `offer_email_sent_at IS
  // NULL` means the send failed, or it was a backdated record that is never
  // emailed at all — chasing a person about an email they never received reads
  // as gibberish. Those are the resend button's job, not this runner's.
  const due = await query(
    `SELECT id FROM freelancer_day_bookings
      WHERE status = 'offered'
        AND offer_email_sent_at IS NOT NULL
        AND offer_chased_at IS NULL
        AND booking_date >= CURRENT_DATE
        AND offer_email_sent_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  let chased = 0;
  for (const row of due.rows) {
    const result = await sendOfferEmail(row.id as string, { resend: true });
    // Stamp ONLY when it actually went. Stamping a failed send would burn the
    // single chase this booking gets, and nobody would ever know it had.
    if (result.sent) {
      await query(`UPDATE freelancer_day_bookings SET offer_chased_at = NOW() WHERE id = $1`, [row.id]);
      chased++;
    }
  }

  // ── Leg 2: tell US, the day before ──
  const tomorrow = await query(
    `SELECT b.id, b.booking_date::text AS booking_date,
            TRIM(COALESCE(NULLIF(p.preferred_name, ''), p.first_name, '') || ' '
                 || COALESCE(p.last_name, '')) AS person_name
       FROM freelancer_day_bookings b
       JOIN people p ON p.id = b.person_id
      WHERE b.status = 'offered'
        AND b.admin_alerted_at IS NULL
        AND b.booking_date = CURRENT_DATE + 1`);
  let alerted = 0;
  for (const row of tomorrow.rows) {
    const who = String(row.person_name || '').trim() || 'A freelancer';
    for (const u of await approverUserIds()) {
      await notify(u.id, 'follow_up',
        `${who} has not confirmed for tomorrow`,
        `Offered a yard day on ${fmtDate(row.booking_date)} and has not replied`,
        'freelancer_day_booking', row.id as string, CALENDAR_URL, 'high');
    }
    await emailApprovers(
      `${who} has not confirmed for tomorrow`,
      `Nobody has confirmed for ${fmtDate(row.booking_date)}`,
      [`<strong>${esc(who)}</strong> was offered the day and has not answered. We have already nudged them once.`,
       'They have not declined, so they may still turn up — nothing has been changed either way. This is the last automatic reminder, and it comes to you rather than to them.'],
      CALENDAR_URL, 'Open the calendar');
    await query(`UPDATE freelancer_day_bookings SET admin_alerted_at = NOW() WHERE id = $1`, [row.id]);
    alerted++;
  }

  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'offered' AND booking_date >= CURRENT_DATE) AS outstanding,
       COUNT(*) FILTER (WHERE status = 'offered' AND booking_date <  CURRENT_DATE) AS needs_closing
     FROM freelancer_day_bookings`);

  return {
    outstanding: Number(counts.rows[0].outstanding),
    needsClosing: Number(counts.rows[0].needs_closing),
    chased,
    alerted,
  };
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

  // WHICH year is being chased. In December it is this one. In January it is
  // LAST one — because the sweep does not close a year, it just empties it at
  // a moment in time. Somebody who takes half their bank as TOIL, cashes the
  // rest out on the 20th and then works a long night on New Year's Eve has
  // banked minutes against a leave year that has already been swept, and
  // nothing would ever look at them again: the year is gone from My Time's
  // default view and the December reminder has stamped itself as done.
  //
  // So a closed year with a positive balance keeps being chased until it is
  // actually zero. That also covers the ordinary case of the sweep simply not
  // getting run before the 31st, which jon is relaxed about — people use the
  // bank up over a quiet Christmas either way.
  const month = today.getUTCMonth();
  const target = month === 11 ? year : year - 1;
  const stampKey = 'staff.overtime_cashout_reminded_year';

  if (month === 11) {
    const fromDay = await getCashOutReminderDay();
    if (today.getUTCDate() < fromDay) {
      return { ...empty, year: target, skippedReason: `before ${fromDay} December` };
    }
  } else if (month === 0) {
    // A few days' grace in January before nagging about a year just ended.
    if (today.getUTCDate() < 5) {
      return { ...empty, year: target, skippedReason: 'early January grace period' };
    }
  } else {
    return { ...empty, year: target, skippedReason: 'not December or January' };
  }

  // The stamp records year AND phase, so December's send does not silence
  // January's follow-up on the same leave year.
  const phase = month === 11 ? 'dec' : 'jan';
  const stamp = `${target}:${phase}`;
  if ((await getSystemSetting(stampKey)) === stamp) {
    return { ...empty, year: target, skippedReason: 'already sent for this year and phase' };
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
    const bal = await getBalance(row.person_id, 'overtime', target);
    if (bal.balanceMinutes > 0) {
      people.push({ personId: row.person_id, name: row.name, minutes: bal.balanceMinutes });
    }
  }

  if (people.length === 0) {
    // Nothing banked is a result, not a failure — and it still counts as
    // handled, so this does not re-check every morning.
    await setSystemSetting(stampKey, stamp);
    return { ...empty, year: target, skippedReason: 'nobody has anything banked' };
  }

  const totalMinutes = people.reduce((s, p) => s + p.minutes, 0);

  const title = phase === 'dec'
    ? `Banked overtime to pay out before ${target} closes`
    : `${target} still has banked overtime left over`;

  for (const u of await approverUserIds()) {
    await notify(u.id, 'follow_up', title,
      `${people.length} ${people.length === 1 ? 'person has' : 'people have'} ${fmtH(totalMinutes)} between them`,
      'staff_overtime_entry', null, STAFF_URL, 'high');
  }

  await emailApprovers(title, title,
    [
      phase === 'dec'
        ? `Hours already worked cannot be forfeited, so the bank is <strong>paid out</strong> rather than expired. This wants to land in <strong>December's payroll</strong>, so it needs doing before that closes — though anyone who would rather take the time off over a quiet Christmas still can.`
        : `This is what is left in the ${target} bank after the sweep — most likely overtime worked between the cash-out and New Year, which accrues to ${target} and would otherwise sit there unseen. Run the sweep again for ${target}; it is idempotent and picks up exactly this.`,
      ...people.map(p => `<strong>${esc(p.name)}</strong> — ${fmtH(p.minutes)}`),
      `<strong>Total: ${fmtH(totalMinutes)}</strong>`,
      `Nothing has been posted. Run the year-end cash-out on the Staff page when you are happy with the figures.`,
    ],
    STAFF_URL);

  await setSystemSetting(stampKey, stamp);
  return { sent: true, year: target, people, totalMinutes };
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

// ── The annual company-days prompt (spec §20.4 Q2) ──────────────────────────

export interface CompanyDaysReviewResult {
  sent: boolean;
  year: number;
  recurring: string[];
  oneOffs: number;
  skippedReason?: string;
}

/**
 * Once a year, ask what next year's company days are.
 *
 * jon's answer to §20.4 Q2: Christmas Day recurs and looks after itself, but
 * the ad-hoc ones — "we're shutting the Friday before the bank holiday" — are
 * exactly what nobody remembers until someone turns up to an empty building.
 * So the recurring rows need no action and this prompt exists for the rest.
 *
 * Runs through the configured month (November by default) rather than on one
 * date, and stamps the year once sent — same reasoning as the cash-out
 * reminder: an annual cron that falls on a day the server is down simply never
 * happens, and a reminder with nowhere to record itself nags every morning.
 */
export async function runCompanyDaysReview(today = new Date()): Promise<CompanyDaysReviewResult> {
  const nextYear = today.getUTCFullYear() + 1;
  const empty: CompanyDaysReviewResult = { sent: false, year: nextYear, recurring: [], oneOffs: 0 };

  const { getSystemSetting, setSystemSetting } = await import('../routes/system-settings');
  const reviewMonth = Number(await getSystemSetting('staff.company_days_review_month')) || 11;

  if (today.getUTCMonth() + 1 !== reviewMonth) {
    return { ...empty, skippedReason: 'not the review month' };
  }
  if ((await getSystemSetting('staff.company_days_reviewed_year')) === String(nextYear)) {
    return { ...empty, skippedReason: 'already asked for this year' };
  }

  const { listCompanyDays, listOccurrences } = await import('./staff-company-days');
  const all = await listCompanyDays();
  const recurring = all.filter(d => d.recurs);
  const nextYearOccurrences = await listOccurrences(nextYear);
  const oneOffs = nextYearOccurrences.filter(
    o => !recurring.some(r => r.id === o.companyDayId)).length;

  const fmt = (d: string) => fmtDate(d);
  for (const u of await approverUserIds()) {
    await notify(u.id, 'follow_up',
      `Company days for ${nextYear}`,
      recurring.length > 0
        ? `${recurring.length} recurring day${recurring.length === 1 ? '' : 's'} carry over automatically — add any one-offs`
        : 'Nothing is set up yet for next year',
      'staff_employment', null, SETTINGS_URL);
  }

  await emailApprovers(
    `Company days for ${nextYear}`,
    `Company days for ${nextYear}`,
    [
      'A yearly check, so nobody turns up to a building that is shut.',
      recurring.length > 0
        ? `These recur and need <strong>no action</strong>: ${recurring.map(r => `${esc(r.label)} (${esc(fmt(r.dayDate).replace(/ \\d{4}$/, ''))})`).join(', ')}.`
        : 'No recurring company days are set up.',
      oneOffs > 0
        ? `${oneOffs} one-off day${oneOffs === 1 ? ' is' : 's are'} already set for ${nextYear}.`
        : `No one-off days are set for ${nextYear} yet.`,
      'Add any extras — a Christmas closure, a day around a bank holiday — on the Settings page. They cost nobody any allowance, and anyone who has already booked one off gets it handed back.',
    ],
    SETTINGS_URL);

  await setSystemSetting('staff.company_days_reviewed_year', String(nextYear));
  return { sent: true, year: nextYear, recurring: recurring.map(r => r.label), oneOffs };
}

// ── Staff records: the daily chases ─────────────────────────────────────────

/**
 * My To Do — nudge about an outstanding task, and RE-ARM.
 *
 * Phase 3 shipped this as a one-shot stamp and that was wrong. `rtw_chased_at`
 * is once-only because a return-to-work conversation is a one-time event; a
 * to-do is an open-ended commitment, and one nudge followed by eternal silence
 * is exactly the evaporation spec §6 exists to prevent.
 *
 * So this follows the pipeline chaser instead (services/auto-chase-runner.ts):
 * fire when `next_chase_date` comes round, then push it forward by the
 * interval while the task stays open. NULL means never — a someday-maybe item
 * opts out, and finishing or dropping a task clears the date entirely.
 *
 * Bell only. The Step-7 escalation scheduler turns it into email per the
 * recipient's own preferences, so nothing is hand-rolled here.
 */
export async function runTaskChase(): Promise<{ chased: number }> {
  const { getTaskChaseDays } = await import('./staff-settings');
  const intervalDays = await getTaskChaseDays();

  const due = await query(
    `SELECT t.id, t.title, t.due_date::text AS due_date, u.id AS user_id
       FROM staff_tasks t
       JOIN users u ON u.person_id = t.person_id AND u.is_active = true
      WHERE t.status = 'open'
        AND t.next_chase_date IS NOT NULL
        AND t.next_chase_date <= CURRENT_DATE`
  );

  let chased = 0;
  for (const row of due.rows) {
    // Re-arm FIRST. A duplicate nudge tomorrow is worse than a missed one
    // today, and this runs daily so the cadence self-corrects either way.
    // Same order as the staff-documents reminders.
    await query(
      `UPDATE staff_tasks
          SET chased_at = NOW(),
              next_chase_date = (CURRENT_DATE + ($2 || ' days')::interval)::date
        WHERE id = $1`,
      [row.id, String(intervalDays)]
    );
    const when = row.due_date
      ? (row.due_date < new Date().toISOString().slice(0, 10)
          ? `was due ${fmtDate(row.due_date)}`
          : `is due ${fmtDate(row.due_date)}`)
      : 'has no date on it';
    await notify(
      row.user_id,
      'staff_task_due',
      'A to-do needs you',
      `“${esc(row.title)}” ${when}.`,
      'staff_tasks',
      row.id,
      '/me?tab=todo',
      'normal'
    );
    chased++;
  }

  if (chased) console.log(`[staff-notifications] task chase: nudged ${chased}`);
  return { chased };
}

/**
 * A staff document is about to expire — passport, visa, certificate.
 *
 * Reads `expires_on`, the expiry printed ON the document (mig 234), NOT a
 * derived review window. The derived kind — "we want a new DVLA check every
 * twelve months" — is Phase 6 and deliberately separate: they answer different
 * questions and must not be collapsed into one rule (spec §1.2).
 *
 * Once per document, stamped. Changing the expiry clears the stamp, because a
 * renewed passport is a new document.
 *
 * Goes to the admins, not the person: these are records WE hold and the
 * staff member cannot see them.
 */
export async function runDocumentExpiryChase(): Promise<{ chased: number }> {
  const { getDocumentExpiryLeadDays } = await import('./staff-settings');
  const lead = await getDocumentExpiryLeadDays();

  const due = await query(
    `SELECT f.id, f.label, f.expires_on::text AS expires_on, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_record_files f
       JOIN people p ON p.id = f.person_id
      WHERE f.deleted_at IS NULL
        AND f.expires_on IS NOT NULL
        AND f.expiry_chased_at IS NULL
        AND f.expires_on <= (CURRENT_DATE + ($1 || ' days')::interval)::date`,
    [String(lead)]
  );
  if (!due.rows.length) return { chased: 0 };

  const admins = await approverUserIds();
  let chased = 0;
  for (const row of due.rows) {
    await query('UPDATE staff_record_files SET expiry_chased_at = NOW() WHERE id = $1', [row.id]);
    const expired = row.expires_on < new Date().toISOString().slice(0, 10);
    for (const admin of admins) {
      await notify(
        admin.id,
        'staff_document_expiring',
        expired ? 'A staff document has expired' : 'A staff document is expiring',
        `${esc(row.person_name || 'Somebody')}’s “${esc(row.label)}” ` +
        `${expired ? 'expired' : 'expires'} ${fmtDate(row.expires_on)}.`,
        'staff_record_files',
        row.id,
        `${STAFF_URL}?person=${row.person_id}&tab=records`,
        expired ? 'high' : 'normal'
      );
    }
    chased++;
  }

  console.log(`[staff-notifications] document expiry: flagged ${chased}`);
  return { chased };
}

/**
 * Somebody's review is coming round (spec §5.6).
 *
 * Cadence is per person — `staff_employment.review_interval_months`, falling
 * back to the company setting, the same shape `entitlement_weeks` already uses.
 *
 * Due FROM: the last completed review's `next_review_due` if it has one, else
 * the completion date plus the interval, else — for somebody never reviewed —
 * their employment start date plus the interval. That last case is the one
 * that matters: a person nobody has ever reviewed is exactly who a reminder
 * system is for, and keying only off previous reviews would miss them forever.
 *
 * Skipped when a review is already booked (status proposed/confirmed): being
 * told to arrange something already in the diary is noise. One nudge per
 * cycle, stamped on staff_employment and cleared when a review is booked or
 * completed.
 */
export async function runReviewDueScan(): Promise<{ flagged: number }> {
  const { getReviewLeadDays } = await import('./staff-settings');
  const { listReviewsDue } = await import('./staff-employment');
  const lead = await getReviewLeadDays();

  // THE definition lives in staff-employment.ts so this scan and the Staff
  // page's attention list cannot drift. onlyUnchased keeps this to one nudge
  // per person per cycle; the page wants them all, chased or not.
  const due = await listReviewsDue({ onlyUnchased: true, withinDays: lead });
  if (!due.length) return { flagged: 0 };

  const admins = await approverUserIds();
  let flagged = 0;
  for (const row of due) {
    await query(
      'UPDATE staff_employment SET review_due_chased_at = NOW() WHERE person_id = $1',
      [row.person_id]
    );
    for (const admin of admins) {
      await notify(
        admin.id,
        'staff_review_due',
        'A staff review is due',
        `${esc(row.person_name || 'Somebody')}’s review is due ${fmtDate(row.due_on)}. ` +
        'Agree a date with them, then record it on the Staff page.',
        'people',
        row.person_id,
        `${STAFF_URL}?person=${row.person_id}&tab=reviews`,
        'normal'
      );
    }
    flagged++;
  }

  if (flagged) console.log(`[staff-notifications] review due: flagged ${flagged}`);
  return { flagged };
}

/**
 * "Your review is booked" — to the person being reviewed, with the prep
 * questions attached (spec §5.2/§5.3).
 *
 * Bell rather than a hand-rolled email: the Step-7 escalation scheduler turns
 * it into email per the recipient's own preferences, so this respects whatever
 * they have chosen instead of overriding it.
 *
 * Called once per review, from sendReviewInvite(), which owns the stamp that
 * keeps it once.
 */
export async function notifyStaffReviewBooked(
  userId: string, reviewId: string, scheduledFor: string
): Promise<void> {
  await notify(
    userId,
    'staff_review_booked',
    'Your review is booked',
    `${fmtDate(scheduledFor)}. There are a few questions to think about beforehand — ` +
    'have a look when you get a minute, and I will have answered the same ones.',
    'staff_reviews',
    reviewId,
    '/me?tab=review',
    'normal'
  );
}
