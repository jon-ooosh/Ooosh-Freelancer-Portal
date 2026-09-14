/**
 * Staff Calendar & Time — routes (Phase A).
 *
 * See docs/STAFF-CALENDAR-SPEC.md. Phase A serves the read-only "who's in"
 * calendar plus the admin screens that set up employment records and working
 * patterns. Leave, overtime and absence arrive in Phases B–D.
 *
 * RBAC:
 *   * Calendar reads — STAFF_ROLES. The whole team needs to see who is in.
 *   * Employment / pattern / salary / review writes — admin only, via the
 *     STAFF_ADMIN_ROLES chokepoint in services/staff-employment.ts.
 *
 * MASKING (spec §0.5): every calendar response passes through
 * getStaffCalendar(), which strips special-category detail for non-admin
 * viewers inside the service. Routes never hand back an unmasked shape.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import {
  getStaffCalendar, getTodaySummary, addDaysYmd, DATE_RE,
} from '../services/staff-day-status';
import {
  STAFF_ADMIN_ROLES, upsertEmployment, getEmployeeRecord, listEmployees, getStaffRoster,
  createPattern, listPatterns, createExceptions, listExceptions,
  addSalaryEntry, listSalaryHistory, upsertReview, listReviews,
} from '../services/staff-employment';
import {
  getBalance, getTeamBalances, syncEntitlement, postEntry, reverseEntry,
  computeEntitlement, getPatternPeriods, getContractedWeek, STATUTORY_WEEKS,
  type LedgerAccount,
} from '../services/staff-balance';
import {
  createRequest, approveRequest, declineRequest, withdrawRequest, cancelRequest,
  getRequest, listRequests, getImpact, countPending,
  type LeaveType, type LeaveStatus, type DayPortion, type DaySpec,
} from '../services/staff-leave';
import {
  createEntry as createOvertime, approveEntry as approveOvertime,
  declineEntry as declineOvertime, cancelEntry as cancelOvertime,
  listEntries as listOvertime, getEntry as getOvertime, countPendingOvertime,
  cashOut, yearEndCashOut, getPayrollReport, payrollCsv, recordBatch,
  minutesBetween, MIN_INCREMENT, type OvertimeStatus,
} from '../services/staff-overtime';

const router = Router();
router.use(authenticate, authorize(...STAFF_ROLES));

const adminOnly = authorize(...STAFF_ADMIN_ROLES);

const dateStr = z.string().regex(DATE_RE, 'expected YYYY-MM-DD');
const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:MM');

function isAdmin(req: AuthRequest): boolean {
  return req.user?.role === 'admin';
}

/** Resolve a from/to window, defaulting to the next 28 days, capped at a year. */
function resolveRange(req: AuthRequest): { from: string; to: string } | { error: string } {
  const today = new Date().toISOString().slice(0, 10);
  const from = DATE_RE.test(String(req.query.from)) ? String(req.query.from) : today;
  const to = DATE_RE.test(String(req.query.to)) ? String(req.query.to) : addDaysYmd(from, 27);
  if (to < from) return { error: '`to` must be on or after `from`' };
  // A calendar read builds one row per person per day; an unbounded range is
  // an easy accidental DoS from a mistyped URL.
  if (to > addDaysYmd(from, 366)) return { error: 'Range cannot exceed 366 days' };
  return { from, to };
}

// ── Calendar reads (all staff) ──────────────────────────────────────────────

// GET /api/staff-calendar/calendar?from=&to= — the global who's-in calendar
router.get('/calendar', async (req: AuthRequest, res: Response) => {
  const range = resolveRange(req);
  if ('error' in range) { res.status(400).json({ error: range.error }); return; }
  try {
    const data = await getStaffCalendar(range.from, range.to, { isAdmin: isAdmin(req) });
    res.json({ data, range });
  } catch (err) {
    console.error('[staff-calendar] calendar error:', err);
    res.status(500).json({ error: 'Failed to load staff calendar' });
  }
});

// GET /api/staff-calendar/today — the dashboard strip
router.get('/today', async (req: AuthRequest, res: Response) => {
  const date = DATE_RE.test(String(req.query.date))
    ? String(req.query.date)
    : new Date().toISOString().slice(0, 10);
  try {
    res.json({ data: await getTodaySummary(date, isAdmin(req)) });
  } catch (err) {
    console.error('[staff-calendar] today error:', err);
    res.status(500).json({ error: "Failed to load today's staffing" });
  }
});

// GET /api/staff-calendar/me?from=&to= — my own calendar
router.get('/me', async (req: AuthRequest, res: Response) => {
  const range = resolveRange(req);
  if ('error' in range) { res.status(400).json({ error: range.error }); return; }
  try {
    const personId = await personIdForUser(req.user!.id);
    if (!personId) { res.json({ data: null, range }); return; }
    // Own record: the viewer is always entitled to their own detail.
    const [me] = await getStaffCalendar(range.from, range.to, { isAdmin: true, personId });
    res.json({ data: me ?? null, range });
  } catch (err) {
    console.error('[staff-calendar] me error:', err);
    res.status(500).json({ error: 'Failed to load your calendar' });
  }
});

// ── Unified staff roster (manager tier) ─────────────────────────────────────

// GET /api/staff-calendar/roster
// Everyone with an account OR an employment record. Manager tier, because the
// account half of this page replaces the Team Members list in Settings, which
// managers can already reach. Employment, hours and card fields are admin-only
// and are omitted from the response for anyone else (see getStaffRoster).
router.get('/roster', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getStaffRoster(isAdmin(req)) });
  } catch (err) {
    console.error('[staff-calendar] roster error:', err);
    res.status(500).json({ error: 'Failed to load the staff list' });
  }
});

// ── Leave requests (Phase B2) ───────────────────────────────────────────────
//
// Staff request their own; admin can request on someone's behalf and is the
// only one who decides. Every check is a WARNING except double-booking and
// requesting days someone is not contracted to work, which corrupt data
// rather than merely inconveniencing anyone.

// A day can be a whole day, a half, or an actual period ("leaving at 15:00").
// The string form is kept so an older client sending {"2027-07-09":"am"} still
// works; the object form carries the times.
const daySpecSchema = z.union([
  z.enum(['full', 'am', 'pm']),
  z.object({
    portion: z.enum(['full', 'am', 'pm', 'hours']),
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
  }),
]);
const halfDaysSchema = z.record(z.string().regex(DATE_RE), daySpecSchema).optional();

/** Resolve the person a leave action is about, and whether the caller may act. */
async function resolveLeaveTarget(req: AuthRequest, bodyPersonId?: string) {
  const own = await personIdForUser(req.user!.id);
  const personId = bodyPersonId ?? own;
  if (!personId) return { error: 'No staff record is linked to your login' as const };
  if (personId !== own && !isAdmin(req)) {
    return { error: 'You can only request leave for yourself' as const };
  }
  return { personId, own };
}

// GET /api/staff-calendar/leave/impact?personId=&from=&to=&type=
// Shown to the REQUESTER before submitting as well as to the approver — the
// best clash is the one that never gets requested (spec §5.2).
router.get('/leave/impact', async (req: AuthRequest, res: Response) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || from);
  const type = String(req.query.type || 'holiday') as LeaveType;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) { res.status(400).json({ error: 'from and to must be YYYY-MM-DD' }); return; }
  if (!['holiday', 'toil', 'unpaid'].includes(type)) { res.status(400).json({ error: 'Unknown leave type' }); return; }

  const target = await resolveLeaveTarget(req, req.query.personId ? String(req.query.personId) : undefined);
  if ('error' in target) { res.status(403).json({ error: target.error }); return; }
  try {
    const halfDays = req.query.halfDays ? JSON.parse(String(req.query.halfDays)) : {};
    res.json({ data: await getImpact(target.personId, from, to, type, halfDays,
      req.query.excludeRequestId ? String(req.query.excludeRequestId) : undefined) });
  } catch (err) {
    console.error('[staff-calendar] impact error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to work out the impact' });
  }
});

// GET /api/staff-calendar/leave?status=&personId=&from=&to=
// Non-admins see only their own, whatever they ask for.
router.get('/leave', async (req: AuthRequest, res: Response) => {
  try {
    const own = await personIdForUser(req.user!.id);
    const requested = req.query.personId ? String(req.query.personId) : undefined;
    const personId = isAdmin(req) ? requested : (own ?? '__none__');
    const status = req.query.status ? String(req.query.status) as LeaveStatus : undefined;
    res.json({
      data: await listRequests({
        personId, status,
        from: DATE_RE.test(String(req.query.from)) ? String(req.query.from) : undefined,
        to: DATE_RE.test(String(req.query.to)) ? String(req.query.to) : undefined,
      }),
      pendingCount: isAdmin(req) ? await countPending() : undefined,
    });
  } catch (err) {
    console.error('[staff-calendar] list leave error:', err);
    res.status(500).json({ error: 'Failed to load leave requests' });
  }
});

// POST /api/staff-calendar/leave
router.post('/leave', async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    personId: z.string().uuid().optional(),
    leaveType: z.enum(['holiday', 'toil', 'unpaid']),
    startDate: dateStr,
    endDate: dateStr,
    halfDays: halfDaysSchema,
    note: z.string().max(1000).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }

  const target = await resolveLeaveTarget(req, parsed.data.personId);
  if ('error' in target) { res.status(403).json({ error: target.error }); return; }
  try {
    const id = await createRequest({
      personId: target.personId,
      leaveType: parsed.data.leaveType,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      halfDays: parsed.data.halfDays as Record<string, DayPortion | DaySpec> | undefined,
      note: parsed.data.note ?? null,
    }, req.user!.id);
    res.status(201).json({ data: await getRequest(id) });
  } catch (err) {
    console.error('[staff-calendar] create leave error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit the request' });
  }
});

// GET /api/staff-calendar/leave/:id — the approval surface (spec §11).
// Carries the impact alongside the request, so approving is never a guess.
router.get('/leave/:id', async (req: AuthRequest, res: Response) => {
  try {
    const request = await getRequest(req.params.id as string);
    if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
    const own = await personIdForUser(req.user!.id);
    if (!isAdmin(req) && request.personId !== own) {
      res.status(403).json({ error: 'Insufficient permissions' }); return;
    }
    // Rebuild the FULL day spec, not just the portion — a timed period needs
    // its times back or the impact would re-price it as a half day.
    const halfDays = Object.fromEntries(
      request.days.filter(d => d.portion !== 'full').map(d =>
        [d.date, { portion: d.portion, startTime: d.startTime, endTime: d.endTime }]));
    const impact = await getImpact(
      request.personId, request.startDate, request.endDate, request.leaveType,
      halfDays, request.id
    );
    res.json({ data: { request, impact } });
  } catch (err) {
    console.error('[staff-calendar] leave detail error:', err);
    res.status(500).json({ error: 'Failed to load the request' });
  }
});

// POST /api/staff-calendar/leave/:id/approve
router.post('/leave/:id/approve', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    await approveRequest(req.params.id as string, req.body?.note ?? null, req.user!.id);
    res.json({ data: await getRequest(req.params.id as string) });
  } catch (err) {
    console.error('[staff-calendar] approve error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to approve' });
  }
});

// POST /api/staff-calendar/leave/:id/decline
router.post('/leave/:id/decline', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ note: z.string().min(1).max(1000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required when declining' }); return; }
  try {
    await declineRequest(req.params.id as string, parsed.data.note, req.user!.id);
    res.json({ data: await getRequest(req.params.id as string) });
  } catch (err) {
    console.error('[staff-calendar] decline error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to decline' });
  }
});

// POST /api/staff-calendar/leave/:id/withdraw — the requester pulls their own.
router.post('/leave/:id/withdraw', async (req: AuthRequest, res: Response) => {
  try {
    const own = await personIdForUser(req.user!.id);
    if (!own) { res.status(403).json({ error: 'No staff record is linked to your login' }); return; }
    await withdrawRequest(req.params.id as string, own);
    res.json({ data: await getRequest(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to withdraw' });
  }
});

// POST /api/staff-calendar/leave/:id/cancel — admin cancels an APPROVED request
// and the time goes back, as a visible cancellation entry rather than a hole.
router.post('/leave/:id/cancel', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ reason: z.string().min(1).max(1000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required when cancelling' }); return; }
  try {
    await cancelRequest(req.params.id as string, parsed.data.reason, req.user!.id);
    res.json({ data: await getRequest(req.params.id as string) });
  } catch (err) {
    console.error('[staff-calendar] cancel error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel' });
  }
});

// ── Overtime (Phase C) ──────────────────────────────────────────────────────
//
// Logged by staff in 5-minute steps, approved by admin, and credited to the
// BANK. Nothing is decided at approval about whether it becomes time off or
// pay — that choice is made later, by taking TOIL leave or by a cash-out
// (spec §6.2).

// GET /api/staff-calendar/overtime?status=&personId=&from=&to=
router.get('/overtime', async (req: AuthRequest, res: Response) => {
  try {
    const own = await personIdForUser(req.user!.id);
    const personId = isAdmin(req)
      ? (req.query.personId ? String(req.query.personId) : undefined)
      : (own ?? '__none__');
    res.json({
      data: await listOvertime({
        personId,
        status: req.query.status ? String(req.query.status) as OvertimeStatus : undefined,
        from: DATE_RE.test(String(req.query.from)) ? String(req.query.from) : undefined,
        to: DATE_RE.test(String(req.query.to)) ? String(req.query.to) : undefined,
      }),
      pendingCount: isAdmin(req) ? await countPendingOvertime() : undefined,
    });
  } catch (err) {
    console.error('[staff-calendar] list overtime error:', err);
    res.status(500).json({ error: 'Failed to load overtime' });
  }
});

// POST /api/staff-calendar/overtime — log some. Either give times, or minutes.
router.post('/overtime', async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    personId: z.string().uuid().optional(),
    workDate: dateStr,
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
    minutes: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }

  const target = await resolveLeaveTarget(req, parsed.data.personId);
  if ('error' in target) { res.status(403).json({ error: target.error }); return; }

  // Times are the friendlier way in; minutes are the fallback for "I did about
  // 40 minutes" where nobody remembers the clock.
  let minutes = parsed.data.minutes ?? 0;
  if (!minutes && parsed.data.startTime && parsed.data.endTime) {
    minutes = minutesBetween(parsed.data.startTime, parsed.data.endTime);
  }
  if (!minutes || minutes <= 0) {
    res.status(400).json({ error: 'Give either a start and end time, or a number of minutes' }); return;
  }
  if (minutes % MIN_INCREMENT !== 0) {
    res.status(400).json({ error: `Overtime is logged in ${MIN_INCREMENT}-minute steps` }); return;
  }

  try {
    const id = await createOvertime({
      personId: target.personId,
      workDate: parsed.data.workDate,
      startTime: parsed.data.startTime ?? null,
      endTime: parsed.data.endTime ?? null,
      minutes,
      reason: parsed.data.reason,
    }, req.user!.id);
    res.status(201).json({ data: await getOvertime(id) });
  } catch (err) {
    console.error('[staff-calendar] create overtime error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to log the overtime' });
  }
});

router.post('/overtime/:id/approve', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    await approveOvertime(req.params.id as string, req.body?.note ?? null, req.user!.id);
    res.json({ data: await getOvertime(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to approve' });
  }
});

router.post('/overtime/:id/decline', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ note: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required when declining' }); return; }
  try {
    await declineOvertime(req.params.id as string, parsed.data.note, req.user!.id);
    res.json({ data: await getOvertime(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to decline' });
  }
});

router.post('/overtime/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const own = await personIdForUser(req.user!.id);
    if (!own) { res.status(403).json({ error: 'No staff record is linked to your login' }); return; }
    await cancelOvertime(req.params.id as string, own);
    res.json({ data: await getOvertime(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel' });
  }
});

// POST /api/staff-calendar/employees/:personId/cash-out — pay banked overtime.
// The one hard limit in the module: you cannot pay out more than is banked,
// because the consequence is paying for hours nobody worked.
router.post('/employees/:personId/cash-out', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    minutes: z.number().int().positive(),
    effectiveDate: dateStr,
    note: z.string().max(500).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const entry = await cashOut(req.params.personId as string, parsed.data.minutes,
      parsed.data.effectiveDate, parsed.data.note ?? null, req.user!.id);
    res.status(201).json({ data: entry });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to pay out' });
  }
});

// POST /api/staff-calendar/year-end-cashout — the 31 Dec sweep, run by hand
// until the scheduler picks it up. Idempotent: a second run finds nothing.
router.post('/year-end-cashout', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ year: z.number().int().min(2000).max(2200) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A year is required' }); return; }
  try {
    res.json({ data: await yearEndCashOut(parsed.data.year, req.user!.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to run the sweep' });
  }
});

// ── Payroll report (spec §12.1) ─────────────────────────────────────────────

router.get('/payroll', adminOnly, async (req: AuthRequest, res: Response) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) { res.status(400).json({ error: 'from and to must be YYYY-MM-DD' }); return; }
  try {
    const rows = await getPayrollReport(from, to);
    if (req.query.format === 'csv') {
      await recordBatch(from, to, req.user!.id);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ooosh-payroll-${from}-to-${to}.csv"`);
      res.send(payrollCsv(rows, from, to));
      return;
    }
    res.json({ data: rows, period: { from, to } });
  } catch (err) {
    console.error('[staff-calendar] payroll error:', err);
    res.status(500).json({ error: 'Failed to build the payroll report' });
  }
});

// ── My balances ─────────────────────────────────────────────────────────────
// Both accounts for the logged-in user in one call, so the booking form can
// show what is available BEFORE dates are picked — the thing that lets someone
// choose between holiday and TOIL rather than guess.
router.get('/me/balances', async (req: AuthRequest, res: Response) => {
  try {
    const personId = await personIdForUser(req.user!.id);
    if (!personId) { res.json({ data: null }); return; }
    const year = resolveYear(req);
    const [holiday, overtime] = await Promise.all([
      getBalance(personId, 'holiday', year),
      getBalance(personId, 'overtime', year),
    ]);
    res.json({
      data: {
        personId, year,
        holiday: { balanceMinutes: holiday.balanceMinutes, nominalDayMinutes: holiday.nominalDayMinutes },
        overtime: { balanceMinutes: overtime.balanceMinutes, nominalDayMinutes: overtime.nominalDayMinutes },
      },
    });
  } catch (err) {
    console.error('[staff-calendar] my balances error:', err);
    res.status(500).json({ error: 'Failed to load your balances' });
  }
});

// ── Balances & the ledger (admin) ───────────────────────────────────────────
//
// Every figure here is derived from staff_ledger_entries by
// services/staff-balance.ts. There is no balance column anywhere and no other
// caller may SUM that table (spec §4.1).

const ACCOUNTS = ['holiday', 'overtime'] as const;

function resolveYear(req: AuthRequest): number {
  const y = Number(req.query.year);
  return Number.isInteger(y) && y >= 2000 && y <= 2200 ? y : new Date().getUTCFullYear();
}

// GET /api/staff-calendar/balances?year= — the whole team, for the overview
router.get('/balances', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const year = resolveYear(req);
    res.json({ data: await getTeamBalances(year), year });
  } catch (err) {
    console.error('[staff-calendar] balances error:', err);
    res.status(500).json({ error: 'Failed to load balances' });
  }
});

// GET /api/staff-calendar/employees/:personId/balance?account=&year=
// Returns the number AND every entry behind it — the explainable balance is
// the whole reason a derived figure beats a stored one (spec §0.2).
router.get('/employees/:personId/balance', async (req: AuthRequest, res: Response) => {
  const account = String(req.query.account || 'holiday') as LedgerAccount;
  if (!ACCOUNTS.includes(account)) { res.status(400).json({ error: 'Unknown account' }); return; }
  try {
    const personId = req.params.personId as string;
    // Own balance or admin. Everyone is entitled to see their own working out.
    if (!isAdmin(req) && (await personIdForUser(req.user!.id)) !== personId) {
      res.status(403).json({ error: 'Insufficient permissions' }); return;
    }
    res.json({ data: await getBalance(personId, account, resolveYear(req)) });
  } catch (err) {
    console.error('[staff-calendar] balance error:', err);
    res.status(500).json({ error: 'Failed to load the balance' });
  }
});

// GET /api/staff-calendar/employees/:personId/entitlement-preview?year=
// What they WOULD be granted, with the segment working, without posting it.
router.get('/employees/:personId/entitlement-preview', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const personId = req.params.personId as string;
    const year = resolveYear(req);
    const { query: dbQuery } = await import('../config/database');
    const emp = await dbQuery(
      `SELECT start_date::text AS start_date, end_date::text AS end_date, entitlement_weeks
         FROM staff_employment WHERE person_id = $1`, [personId]);
    if (!emp.rows[0]) { res.status(404).json({ error: 'No employment record' }); return; }

    const patterns = await getPatternPeriods(personId, year);
    const week = await getContractedWeek(personId, `${year}-12-31`)
      ?? await getContractedWeek(personId, `${year}-01-01`);
    const weeks = emp.rows[0].entitlement_weeks != null
      ? Number(emp.rows[0].entitlement_weeks) : STATUTORY_WEEKS;

    res.json({
      data: {
        ...computeEntitlement({
          year, weeks,
          employedFrom: emp.rows[0].start_date,
          employedTo: emp.rows[0].end_date,
          patterns,
          nominalDayMinutes: week?.nominalDayMinutes ?? null,
        }),
        weeks,
        nominalDayMinutes: week?.nominalDayMinutes ?? null,
        weeklyMinutes: week?.weeklyMinutes ?? null,
      },
      year,
    });
  } catch (err) {
    console.error('[staff-calendar] entitlement preview error:', err);
    res.status(500).json({ error: 'Failed to work out the entitlement' });
  }
});

// POST /api/staff-calendar/employees/:personId/entitlement — grant or top up.
// Idempotent: posts only the difference from what is already granted, so
// re-running after an hours change tops up the delta rather than doubling.
router.post('/employees/:personId/entitlement', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ year: z.number().int().min(2000).max(2200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A year is required' }); return; }
  try {
    const result = await syncEntitlement(req.params.personId as string, parsed.data.year, req.user!.id);
    res.json({ data: result });
  } catch (err) {
    console.error('[staff-calendar] entitlement error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to grant the entitlement' });
  }
});

// POST /api/staff-calendar/employees/:personId/ledger — a manual adjustment.
// Deliberately limited to adjustment/correction: bookings and accruals are
// posted by the flows that own them (Phases B2 and C), never typed in by hand.
router.post('/employees/:personId/ledger', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    account: z.enum(['holiday', 'overtime']),
    leaveYear: z.number().int().min(2000).max(2200),
    entryType: z.enum(['adjustment', 'correction']),
    minutes: z.number().int(),
    effectiveDate: dateStr,
    note: z.string().min(1).max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  if (parsed.data.minutes === 0) { res.status(400).json({ error: 'An adjustment of zero does nothing' }); return; }
  try {
    // Stamp 'manual' explicitly. syncEntitlement only ever counts source_type
    // 'system', so a hand-typed adjustment is never swallowed by a
    // recalculation — but leaving it null made that safety implicit rather
    // than stated, and unfilterable in reports later.
    const entry = await postEntry(
      { personId: req.params.personId as string, ...parsed.data, sourceType: 'manual' },
      req.user!.id
    );
    res.status(201).json({ data: entry });
  } catch (err) {
    console.error('[staff-calendar] ledger post error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to post the entry' });
  }
});

// POST /api/staff-calendar/ledger/:entryId/reverse — undo one entry.
// The ONLY way to undo anything: the table refuses UPDATE and DELETE outright.
router.post('/ledger/:entryId/reverse', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ note: z.string().min(1).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required' }); return; }
  try {
    const entry = await reverseEntry(req.params.entryId as string, parsed.data.note, req.user!.id);
    res.status(201).json({ data: entry });
  } catch (err) {
    console.error('[staff-calendar] reverse error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to reverse the entry' });
  }
});

// ── Employee directory (admin) ──────────────────────────────────────────────

// GET /api/staff-calendar/employees
router.get('/employees', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listEmployees() });
  } catch (err) {
    console.error('[staff-calendar] employees error:', err);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

// GET /api/staff-calendar/employees/:personId
router.get('/employees/:personId', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const rec = await getEmployeeRecord(req.params.personId as string);
    if (!rec) { res.status(404).json({ error: 'No employment record for this person' }); return; }
    res.json({ data: rec });
  } catch (err) {
    console.error('[staff-calendar] employee error:', err);
    res.status(500).json({ error: 'Failed to load employee' });
  }
});

const employmentSchema = z.object({
  startDate: dateStr,
  endDate: dateStr.nullish(),
  employmentStatus: z.enum(['employed', 'left']).optional(),
  jobTitle: z.string().max(200).nullish(),
  department: z.string().max(50).nullish(),
  bankHolidayPolicy: z.enum(['use_allowance', 'granted']).nullish(),
  entitlementWeeks: z.number().min(0).max(52).nullish(),
  notes: z.string().nullish(),
});

// PUT /api/staff-calendar/employees/:personId
router.put('/employees/:personId', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = employmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const row = await upsertEmployment(req.params.personId as string, parsed.data, req.user!.id);
    res.json({ data: row });
  } catch (err) {
    console.error('[staff-calendar] upsert employment error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save employment record' });
  }
});

// ── Working patterns ────────────────────────────────────────────────────────

// GET /api/staff-calendar/employees/:personId/patterns — own record or admin
router.get('/employees/:personId/patterns', async (req: AuthRequest, res: Response) => {
  try {
    const personId = req.params.personId as string;
    if (!isAdmin(req) && (await personIdForUser(req.user!.id)) !== personId) {
      res.status(403).json({ error: 'Insufficient permissions' }); return;
    }
    res.json({ data: await listPatterns(personId) });
  } catch (err) {
    console.error('[staff-calendar] patterns error:', err);
    res.status(500).json({ error: 'Failed to load working patterns' });
  }
});

const patternSchema = z.object({
  effectiveFrom: dateStr,
  cycleWeeks: z.union([z.literal(1), z.literal(2)]).optional(),
  notes: z.string().nullish(),
  days: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    cycleWeek: z.number().int().min(1).max(2).optional(),
    isWorking: z.boolean(),
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
    breakMinutes: z.number().int().min(0).max(480).optional(),
  })).min(1).max(14),
});

// POST /api/staff-calendar/employees/:personId/patterns
// Creates a NEW pattern effective from a date and closes the previous one.
// There is deliberately no PUT — a pattern is never edited in place (spec §0.3).
router.post('/employees/:personId/patterns', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = patternSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const { effectiveFrom, cycleWeeks, notes, days } = parsed.data;
    const created = await createPattern(
      req.params.personId as string, effectiveFrom, days, { cycleWeeks, notes }, req.user!.id
    );
    res.status(201).json({ data: created });
  } catch (err) {
    console.error('[staff-calendar] create pattern error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save working pattern' });
  }
});

// ── Pattern exceptions / swaps ──────────────────────────────────────────────

// GET /api/staff-calendar/employees/:personId/exceptions?from=&to=
router.get('/employees/:personId/exceptions', async (req: AuthRequest, res: Response) => {
  const range = resolveRange(req);
  if ('error' in range) { res.status(400).json({ error: range.error }); return; }
  try {
    const personId = req.params.personId as string;
    if (!isAdmin(req) && (await personIdForUser(req.user!.id)) !== personId) {
      res.status(403).json({ error: 'Insufficient permissions' }); return;
    }
    res.json({ data: await listExceptions(personId, range.from, range.to) });
  } catch (err) {
    console.error('[staff-calendar] exceptions error:', err);
    res.status(500).json({ error: 'Failed to load pattern exceptions' });
  }
});

const exceptionSchema = z.object({
  legs: z.array(z.object({
    personId: z.string().uuid(),
    date: dateStr,
    isWorking: z.boolean(),
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
    breakMinutes: z.number().int().min(0).max(480).optional(),
    reason: z.string().max(500).nullish(),
  })).min(1).max(4),
});

// POST /api/staff-calendar/exceptions
// One leg = an ad-hoc change; two = a self-swap; four = a person-to-person
// swap. Admin-created and auto-approved in v1 (spec §8.3) — the two-party
// consent workflow is deliberately not built.
router.post('/exceptions', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = exceptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const rows = await createExceptions(parsed.data.legs, req.user!.id, true);
    res.status(201).json({ data: rows });
  } catch (err) {
    console.error('[staff-calendar] create exception error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save the change' });
  }
});

// ── Salary & reviews (admin) ────────────────────────────────────────────────

router.get('/employees/:personId/salary', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listSalaryHistory(req.params.personId as string) });
  } catch (err) {
    console.error('[staff-calendar] salary error:', err);
    res.status(500).json({ error: 'Failed to load salary history' });
  }
});

router.post('/employees/:personId/salary', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    annualAmount: z.number().min(0),
    effectiveFrom: dateStr,
    reason: z.string().max(500).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const row = await addSalaryEntry(
      req.params.personId as string, parsed.data.annualAmount,
      parsed.data.effectiveFrom, parsed.data.reason ?? null, req.user!.id
    );
    res.status(201).json({ data: row });
  } catch (err) {
    console.error('[staff-calendar] add salary error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record the salary change' });
  }
});

router.get('/employees/:personId/reviews', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listReviews(req.params.personId as string) });
  } catch (err) {
    console.error('[staff-calendar] reviews error:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

router.post('/employees/:personId/reviews', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    id: z.string().uuid().nullish(),
    reviewType: z.enum(['quarterly', 'annual', 'probation', 'ad_hoc']).optional(),
    scheduledFor: dateStr,
    completedAt: z.string().nullish(),
    notes: z.string().nullish(),
    outcome: z.string().nullish(),
    nextReviewDue: dateStr.nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const { id, ...rest } = parsed.data;
    const row = await upsertReview(id ?? null, req.params.personId as string, rest, req.user!.id);
    if (!row) { res.status(404).json({ error: 'Review not found' }); return; }
    res.json({ data: row });
  } catch (err) {
    console.error('[staff-calendar] review error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save the review' });
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** users.person_id — the link between the logged-in user and their staff record. */
async function personIdForUser(userId: string): Promise<string | null> {
  const { query } = await import('../config/database');
  const r = await query('SELECT person_id FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.person_id ?? null;
}

export default router;
