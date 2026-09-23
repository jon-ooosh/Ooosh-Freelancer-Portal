/**
 * Staff Calendar & Time — routes (Phase A).
 *
 * See docs/STAFF-CALENDAR-SPEC.md. One router serves the whole module: the
 * "who's in" calendar (A), leave requests (B), overtime and the bank (C) and
 * absence, return-to-work and the holiday reclaim (D).
 *
 * RBAC:
 *   * Calendar reads — STAFF_ROLES. The whole team needs to see who is in.
 *   * Employment / pattern / salary / review writes — admin only, via the
 *     STAFF_ADMIN_ROLES chokepoint in services/staff-employment.ts.
 *   * Absence — admin only, with no exceptions, because it is special-category
 *     data (§0.5).
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
  updateKeyData, revealNiNumber, recordReviewOutcome,
  listUnlinkedLogins, linkLoginToPerson,
  createPattern, listPatterns, createExceptions, listExceptions,
  addSalaryEntry, listSalaryHistory, upsertReview, listReviews,
} from '../services/staff-employment';
import {
  getBalance, getTeamBalances, syncEntitlement, postEntry, reverseEntry,
  ensureEntitlement, ensureEntitlementForAll,
  computeEntitlement, getPatternPeriods, getContractedWeek, getBreakdown, STATUTORY_WEEKS,
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
import {
  createAbsence, closeAbsence, cancelAbsence, recordRtw, reclaimLeaveDays,
  getReclaimCandidates, getAbsence, listAbsences, listRtwOutstanding,
  getAbsenceReport, ABSENCE_TYPES,
  type AbsenceType, type CreateAbsenceInput,
} from '../services/staff-absence';
import {
  notifyLeaveRequested, notifyOvertimeLogged, notifyDecision, notifyRtwDue,
} from '../services/staff-notifications';
import {
  getBankHolidaysInRange, getBankHolidays, getBankHolidayPolicy,
} from '../services/staff-settings';
import {
  listCompanyDays, listOccurrences, createCompanyDay, getCompanyDay,
  cancelCompanyDay, getCompanyReclaimCandidates, reclaimForCompanyDay,
} from '../services/staff-company-days';
import {
  listForRange, listBookableFreelancers, createBooking, recordResponse,
  markCompleted, cancelBooking, recordInvoice, getSpendSummary, getBooking,
  listNeedsClosing, closeOutBooking, withdrawBooking, amendBooking,
} from '../services/freelancer-days';
import { sendOfferEmail, sendCancellationEmail, sendUpdatedEmail } from '../services/freelancer-day-offer';

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
    // Bank holidays ride along as an ADDITIVE field. Under the current
    // `use_allowance` policy they are ordinary working days, so they are a
    // marker on the grid and nothing more — the calendar must not draw them
    // as time off, because no ledger entry ever paid for them.
    const { getCompanyDayOverlay } = await import('../services/staff-company-days');
    const [data, bankHolidays, bankHolidayPolicy, companyDays] = await Promise.all([
      getStaffCalendar(range.from, range.to, { isAdmin: isAdmin(req) }),
      getBankHolidaysInRange(range.from, range.to),
      getBankHolidayPolicy(),
      getCompanyDayOverlay(range.from, range.to),
    ]);
    res.json({
      data, range, bankHolidays, bankHolidayPolicy,
      companyDays: [...companyDays.values()].map(c => ({ date: c.date, label: c.label })),
    });
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

// GET /api/staff-calendar/unlinked-logins — logins with no staff record.
// Candidates for linking to an employee that was created against a different
// `people` row (see linkLoginToPerson).
router.get('/unlinked-logins', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listUnlinkedLogins() });
  } catch (err) {
    console.error('[staff-calendar] unlinked logins error:', err);
    res.status(500).json({ error: 'Failed to load logins' });
  }
});

// POST /api/staff-calendar/employees/:personId/link-login
router.post('/employees/:personId/link-login', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A login is required' }); return; }
  try {
    const r = await linkLoginToPerson(req.params.personId as string, parsed.data.userId);
    res.json({ data: r });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to link the login' });
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
    void notifyLeaveRequested(id);
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
    const r = await getRequest(req.params.id as string);
    if (r) void notifyDecision({ personId: r.personId, kind: 'leave', outcome: 'approved',
      summary: `${r.startDate}${r.endDate !== r.startDate ? ` – ${r.endDate}` : ''}`,
      note: r.decisionNote, entityId: r.id });
    res.json({ data: r });
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
    const r = await getRequest(req.params.id as string);
    if (r) void notifyDecision({ personId: r.personId, kind: 'leave', outcome: 'declined',
      summary: `${r.startDate}${r.endDate !== r.startDate ? ` – ${r.endDate}` : ''}`,
      note: r.decisionNote, entityId: r.id });
    res.json({ data: r });
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
  // Snap UP to the step rather than refusing. Bouncing someone back to fix 12
  // minutes into 15 is friction for no benefit — round it, and let the UI say
  // plainly that it did.
  const snapped = Math.ceil(minutes / MIN_INCREMENT) * MIN_INCREMENT;

  try {
    const id = await createOvertime({
      personId: target.personId,
      workDate: parsed.data.workDate,
      startTime: parsed.data.startTime ?? null,
      endTime: parsed.data.endTime ?? null,
      minutes: snapped,
      reason: parsed.data.reason,
    }, req.user!.id);
    void notifyOvertimeLogged(id);
    res.status(201).json({ data: await getOvertime(id) });
  } catch (err) {
    console.error('[staff-calendar] create overtime error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to log the overtime' });
  }
});

router.post('/overtime/:id/approve', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    await approveOvertime(req.params.id as string, req.body?.note ?? null, req.user!.id);
    const e = await getOvertime(req.params.id as string);
    if (e) void notifyDecision({ personId: e.personId, kind: 'overtime', outcome: 'approved',
      summary: `${e.minutes} min on ${e.workDate} — now in your bank`,
      note: e.decisionNote, entityId: e.id });
    res.json({ data: e });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to approve' });
  }
});

router.post('/overtime/:id/decline', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ note: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required when declining' }); return; }
  try {
    await declineOvertime(req.params.id as string, parsed.data.note, req.user!.id);
    const e = await getOvertime(req.params.id as string);
    if (e) void notifyDecision({ personId: e.personId, kind: 'overtime', outcome: 'declined',
      summary: `${e.minutes} min on ${e.workDate}`, note: e.decisionNote, entityId: e.id });
    res.json({ data: e });
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

// ── Absence (Phase D) ───────────────────────────────────────────────────────
//
// ADMIN ONLY, every route. Absence is special-category data under UK GDPR
// (spec §0.5) and the tier is deliberate — the module has one admin today, and
// widening it is an RBAC change, not a code change.
//
// Migration 215 removed the one exception there used to be, the self-recorded
// timed marker. It answered neither question this module exists to answer —
// it deducted nothing and was approved by nobody — so staff now have exactly
// two things to do here: log overtime, and request time off.
//
// Note that absence detail NEVER travels on the calendar endpoints for a
// non-admin: maskForViewer() strips it inside staff-day-status.ts. These
// routes are the only way the type or reason reaches a browser at all.

// GET /api/staff-calendar/absences?personId=&from=&to=&openOnly=&includeCancelled=
router.get('/absences', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({
      data: await listAbsences({
        personId: req.query.personId ? String(req.query.personId) : undefined,
        from: DATE_RE.test(String(req.query.from)) ? String(req.query.from) : undefined,
        to: DATE_RE.test(String(req.query.to)) ? String(req.query.to) : undefined,
        openOnly: req.query.openOnly === 'true',
        includeCancelled: req.query.includeCancelled === 'true',
      }),
      rtwOutstanding: await listRtwOutstanding(),
    });
  } catch (err) {
    console.error('[staff-calendar] list absences error:', err);
    res.status(500).json({ error: 'Failed to load absences' });
  }
});

// POST /api/staff-calendar/absences/:id/close — set the end date and price it.
router.post('/absences/:id/close', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ endDate: dateStr }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'An end date is required' }); return; }
  try {
    const a = await closeAbsence(req.params.id as string, parsed.data.endDate, req.user!.id);
    if (a.rtwRequired && !a.rtwCompletedAt) void notifyRtwDue(a.id);
    res.json({ data: a, reclaimCandidates: await getReclaimCandidates(a.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to close the absence' });
  }
});

// POST /api/staff-calendar/absences/:id/rtw — the return-to-work write-up.
router.post('/absences/:id/rtw', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    rtwDate: dateStr,
    fitToReturn: z.enum(['yes', 'yes_with_adjustments', 'no']),
    adjustments: z.string().max(2000).nullish(),
    notes: z.string().max(2000).nullish(),
    fitNoteReceived: z.boolean().optional(),
    fitNoteExpiry: dateStr.nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    res.json({ data: await recordRtw(req.params.id as string, parsed.data, req.user!.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save the return to work' });
  }
});

// POST /api/staff-calendar/absences/:id/reclaim — give back overtaken holiday.
router.post('/absences/:id/reclaim', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ dayIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Pick at least one day to reclaim' }); return; }
  try {
    const r = await reclaimLeaveDays(req.params.id as string, parsed.data.dayIds, req.user!.id);
    res.json({ data: { ...r, absence: await getAbsence(req.params.id as string) } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to reclaim those days' });
  }
});

// POST /api/staff-calendar/absences/:id/cancel — soft-cancel, reversing any debit.
router.post('/absences/:id/cancel', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required' }); return; }
  try {
    await cancelAbsence(req.params.id as string, parsed.data.reason, req.user!.id);
    res.json({ data: await getAbsence(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel the absence' });
  }
});

// GET /api/staff-calendar/absence-report?from=&to=&flagSpells=&flagMonths=
//
// By SPELL. Five one-day absences and one five-day absence are the same number
// of days and completely different signals (spec §7.6).
router.get('/absence-report', adminOnly, async (req: AuthRequest, res: Response) => {
  const range = resolveRange(req);
  if ('error' in range) { res.status(400).json({ error: range.error }); return; }
  try {
    const flagSpells = Number(req.query.flagSpells) || 3;
    const flagMonths = Number(req.query.flagMonths) || 3;
    res.json({
      data: await getAbsenceReport({ from: range.from, to: range.to, flagSpells, flagMonths }),
      rtwOutstanding: await listRtwOutstanding(),
      flagSpells, flagMonths,
    });
  } catch (err) {
    console.error('[staff-calendar] absence report error:', err);
    res.status(500).json({ error: 'Failed to build the absence report' });
  }
});

// ── Company days (spec §20) ─────────────────────────────────────────────────
//
// Days the company grants to EVERYONE that cost nobody any allowance. Reads
// are open to all staff — "is the office shut on the 27th" is a question the
// whole team has — writes are admin.

// GET /api/staff-calendar/company-days?year=
router.get('/company-days', async (req: AuthRequest, res: Response) => {
  try {
    const year = resolveYear(req);
    res.json({
      data: await listCompanyDays({ includeCancelled: req.query.includeCancelled === 'true' }),
      occurrences: await listOccurrences(year),
      year,
    });
  } catch (err) {
    console.error('[staff-calendar] company days error:', err);
    res.status(500).json({ error: 'Failed to load company days' });
  }
});

// POST /api/staff-calendar/company-days
router.post('/company-days', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    dayDate: dateStr,
    label: z.string().min(1).max(120),
    recurs: z.boolean().optional(),
    notes: z.string().max(500).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }

  try {
    const day = await createCompanyDay(parsed.data, req.user!.id);
    // Offered, never applied: anyone who had already booked the day off has
    // paid for something the company has now given them, and handing it back
    // is a decision a human makes (§20.3).
    res.status(201).json({ data: day, reclaimCandidates: await getCompanyReclaimCandidates(day.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add that day' });
  }
});

// GET /api/staff-calendar/company-days/:id — with what it has landed on.
router.get('/company-days/:id', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const day = await getCompanyDay(req.params.id as string);
    if (!day) { res.status(404).json({ error: 'Company day not found' }); return; }
    res.json({ data: day, reclaimCandidates: await getCompanyReclaimCandidates(day.id) });
  } catch (err) {
    console.error('[staff-calendar] company day error:', err);
    res.status(500).json({ error: 'Failed to load that day' });
  }
});

// POST /api/staff-calendar/company-days/:id/reclaim
router.post('/company-days/:id/reclaim', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ leaveDayIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Pick at least one day to give back' }); return; }
  try {
    const r = await reclaimForCompanyDay(req.params.id as string, parsed.data.leaveDayIds, req.user!.id);
    res.json({ data: { ...r, reclaimCandidates: await getCompanyReclaimCandidates(req.params.id as string) } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to give those days back' });
  }
});

// POST /api/staff-calendar/company-days/:id/cancel
router.post('/company-days/:id/cancel', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required' }); return; }
  try {
    await cancelCompanyDay(req.params.id as string, parsed.data.reason, req.user!.id);
    res.json({ data: await getCompanyDay(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel that day' });
  }
});

// ── Freelancer day bookings — "yard days" (Phase E, spec §9) ────────────────
//
// On THIS router rather than one of their own, because they exist to answer a
// staff-calendar question: have we got enough people in. Reads are open to the
// team for the same reason; writes are admin.
//
// Structurally separate from everything above — no ledger, no pattern, no
// entitlement (§9.1). The language is offered → accepted / declined, never
// "rostered": a decline is a response, not a penalty.

// GET /api/staff-calendar/freelancer-days?from=&to=
router.get('/freelancer-days', async (req: AuthRequest, res: Response) => {
  const range = resolveRange(req);
  if ('error' in range) { res.status(400).json({ error: range.error }); return; }
  try {
    res.json({
      data: await listForRange(range.from, range.to),
      range,
      spend: isAdmin(req) ? await getSpendSummary(range.from, range.to) : undefined,
    });
  } catch (err) {
    console.error('[staff-calendar] freelancer days error:', err);
    res.status(500).json({ error: 'Failed to load freelancer days' });
  }
});

// GET /api/staff-calendar/freelancer-days/bookable — who can be booked, + rates
router.get('/freelancer-days/bookable', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listBookableFreelancers() });
  } catch (err) {
    console.error('[staff-calendar] bookable freelancers error:', err);
    res.status(500).json({ error: 'Failed to load freelancers' });
  }
});

// POST /api/staff-calendar/freelancer-days
router.post('/freelancer-days', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    personId: z.string().uuid(),
    bookingDate: dateStr,
    durationType: z.enum(['full_day', 'half_day', 'hours']).optional(),
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
    rateType: z.enum(['day', 'half_day', 'hourly', 'fixed']).optional(),
    agreedRate: z.number().nonnegative().nullish(),
    notes: z.string().max(1000).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const booking = await createBooking(parsed.data, req.user!.id);
    // The row is the record; the email is a courtesy on top of it. A mail
    // failure must never lose the booking, so this is awaited for its RESULT
    // (so the UI can say nobody was told) but never throws.
    const offer = await sendOfferEmail(booking.id);
    res.status(201).json({ data: booking, offer });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to book that day' });
  }
});

// PATCH /api/staff-calendar/freelancer-days/:id — amend without cancel-and-rebook
//
// The rule lives in amendBooking: the DAY and the HOURS re-open the question;
// the rate and the notes do not. This route just decides which email follows
// from that, and never lets an email failure lose the amendment — the booking
// is the record, the mail is a courtesy on top of it.
router.patch('/freelancer-days/:id', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    bookingDate: dateStr.optional(),
    durationType: z.enum(['full_day', 'half_day', 'hours']).optional(),
    startTime: timeStr.nullish(),
    endTime: timeStr.nullish(),
    rateType: z.enum(['day', 'half_day', 'hourly', 'fixed']).optional(),
    agreedRate: z.number().nonnegative().nullish(),
    notes: z.string().max(1000).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const result = await amendBooking(req.params.id as string, parsed.data, req.user!.id);
    const notified = result.reoffered
      ? await sendOfferEmail(result.booking.id)
      : result.changedDetailsOnly
        ? await sendUpdatedEmail(result.booking.id)
        : { sent: false as const, why: 'not_offered' as const };
    res.json({ data: result.booking, reoffered: result.reoffered, notified });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to amend that booking' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/withdraw — they pulled out
router.post('/freelancer-days/:id/withdraw', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ note: z.string().max(500).nullish() }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    res.json({ data: await withdrawBooking(req.params.id as string, parsed.data.note ?? null) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record that' });
  }
});

// GET /api/staff-calendar/freelancer-days/needs-closing
// Passed and still unanswered — the list §9.4 decision 1 creates by refusing to
// auto-decline, and item 5 exists to clear. Unbounded by date on purpose: an
// offer from last March is exactly the one that should still be shouting.
router.get('/freelancer-days/needs-closing', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listNeedsClosing() });
  } catch (err) {
    console.error('[staff-calendar] needs-closing failed:', err);
    res.status(500).json({ error: 'Failed to load unanswered offers' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/close
router.post('/freelancer-days/:id/close', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ outcome: z.enum(['completed', 'lapsed']) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Say whether they came anyway or it did not happen' });
    return;
  }
  try {
    res.json({ data: await closeOutBooking(req.params.id as string, parsed.data.outcome, req.user!.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to close that out' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/resend-offer
// Without this, a bounced or mistyped address is a dead end: the booking sits
// `offered`, nobody has been asked, and there is no way to ask again short of
// cancelling and re-booking.
router.post('/freelancer-days/:id/resend-offer', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await sendOfferEmail(req.params.id as string, { resend: true }) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to send that' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/respond — accepted or declined
router.post('/freelancer-days/:id/respond', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    response: z.enum(['accepted', 'declined']),
    note: z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A response of accepted or declined is required' }); return; }
  try {
    res.json({ data: await recordResponse(req.params.id as string, parsed.data.response, parsed.data.note ?? null) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record that' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/complete
router.post('/freelancer-days/:id/complete', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await markCompleted(req.params.id as string) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to mark that done' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/cancel
router.post('/freelancer-days/:id/cancel', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A reason is required' }); return; }
  try {
    // Read the status BEFORE cancelling: afterwards the row says `cancelled`
    // and can no longer tell us whether they had agreed to come, which is the
    // difference between a note and an apology.
    const before = await getBooking(req.params.id as string);
    const data = await cancelBooking(req.params.id as string, parsed.data.reason, req.user!.id);
    const notified = before
      ? await sendCancellationEmail(data.id, parsed.data.reason, before.status)
      : { sent: false as const, why: 'gone' as const };
    res.json({ data, notified });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel' });
  }
});

// POST /api/staff-calendar/freelancer-days/:id/invoice
router.post('/freelancer-days/:id/invoice', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    received: z.boolean(),
    amount: z.number().nonnegative().nullish(),
    queried: z.boolean().optional(),
    queryNotes: z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    res.json({ data: await recordInvoice(req.params.id as string, parsed.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record the invoice' });
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
// PUT /api/staff-calendar/bank-holidays/:year — override a year's dates.
//
// Its own route rather than the generic settings PUT, which only ever UPDATEs
// an existing row: dates are computed for any year, so an override has to be
// creatable for a year nobody seeded. Sending an empty list clears the
// override and hands the year back to the arithmetic.
router.put('/bank-holidays/:year', adminOnly, async (req: AuthRequest, res: Response) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    res.status(400).json({ error: 'That is not a year' }); return;
  }
  const parsed = z.object({ dates: z.array(dateStr) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Dates must be YYYY-MM-DD' }); return; }

  const wrong = parsed.data.dates.filter(d => d.slice(0, 4) !== String(year));
  if (wrong.length > 0) {
    res.status(400).json({ error: `Not in ${year}: ${wrong.join(', ')}` }); return;
  }

  try {
    const { upsertSystemSetting } = await import('./system-settings');
    await upsertSystemSetting(
      `staff.bank_holidays.${year}`,
      [...new Set(parsed.data.dates)].sort().join(','),
      {
        label: `Bank holidays ${year} — OVERRIDE only. Leave empty and they are worked out automatically`,
        category: 'staff_time',
        sortOrder: 200 + (year - 2026),
      }
    );
    res.json({ data: await getBankHolidays(year), year, overridden: parsed.data.dates.length > 0 });
  } catch (err) {
    console.error('[staff-calendar] bank holiday override error:', err);
    res.status(500).json({ error: 'Failed to save those dates' });
  }
});

// GET /api/staff-calendar/bank-holidays?year= — the marked days for a year.
router.get('/bank-holidays', async (req: AuthRequest, res: Response) => {
  try {
    const year = resolveYear(req);
    res.json({
      data: await getBankHolidays(year),
      year,
      policy: await getBankHolidayPolicy(),
    });
  } catch (err) {
    console.error('[staff-calendar] bank holidays error:', err);
    res.status(500).json({ error: 'Failed to load bank holidays' });
  }
});

router.get('/me/balances', async (req: AuthRequest, res: Response) => {
  try {
    const personId = await personIdForUser(req.user!.id);
    if (!personId) { res.json({ data: null, hasStaffRecord: false }); return; }

    // A zero balance and "you are not set up as staff" look identical if both
    // report 0, and the second is the one that needs acting on. Distinguish
    // them explicitly so My Time can say which it is.
    const { query: dbQuery } = await import('../config/database');
    const emp = await dbQuery(
      `SELECT 1 FROM staff_employment WHERE person_id = $1 AND employment_status = 'employed'`,
      [personId]);
    if (emp.rows.length === 0) { res.json({ data: null, hasStaffRecord: false }); return; }

    const year = resolveYear(req);
    // Grant this year (or a future one) if the nightly sync has not run since
    // the code landed — otherwise next year reads 0m beside a line saying the
    // allowance is already set.
    await ensureEntitlement(personId, year);
    // Breakdowns, not just net figures. "1h banked" merges three different
    // facts for the overtime account — what was earned, what was taken as time
    // off, and what was paid out — and the merged number is the confusing one.
    const [holiday, overtime] = await Promise.all([
      getBreakdown(personId, 'holiday', year),
      getBreakdown(personId, 'overtime', year),
    ]);
    // balanceMinutes is kept ALONGSIDE the breakdown, deliberately. Dropping it
    // when the breakdown landed was a breaking change: any browser still
    // holding the previous JS bundle read balanceMinutes, got undefined, and
    // rendered "NaNh NaNm". A cached bundle is the normal state of affairs
    // right after a deploy, so response shapes here only ever gain fields.
    res.json({
      data: {
        personId, year,
        holiday: { ...holiday, balanceMinutes: holiday.availableMinutes },
        overtime: { ...overtime, balanceMinutes: overtime.availableMinutes },
      },
      hasStaffRecord: true,
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
    await ensureEntitlementForAll(year);
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

// GET /api/staff-calendar/attention
// The Staff page's "needs attention" list — every row derived, nothing stored.
// See services/staff-attention.ts for why this surface exists at all.
router.get('/attention', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const { getStaffAttention } = await import('../services/staff-attention');
    res.json({ data: await getStaffAttention() });
  } catch (err) {
    console.error('[staff-calendar] attention error:', err);
    res.status(500).json({ error: 'Failed to load the attention list' });
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

// ── My review — the staff-facing half (spec §5.3) ───────────────────────────
// NOT adminOnly: this is the one part of the staff-records module the reviewee
// themselves uses. Ownership is enforced in the service against person_id, and
// the read selects column by column so private_notes and manager_prep cannot
// leak by being added to the table later.

// GET /api/staff-calendar/me/review
router.get('/me/review', async (req: AuthRequest, res: Response) => {
  try {
    const personId = await personIdForUser(req.user!.id);
    if (!personId) { res.json({ data: null, questions: [], linked: false }); return; }
    const { getMyReview, getReviewQuestions } = await import('../services/staff-review-prep');
    const [review, questions] = await Promise.all([getMyReview(personId), getReviewQuestions()]);
    res.json({ data: review, questions, linked: true });
  } catch (err) {
    console.error('[staff-calendar] my review error:', err);
    res.status(500).json({ error: 'Failed to load your review' });
  }
});

// POST /api/staff-calendar/me/review/:reviewId/answers
router.post('/me/review/:reviewId/answers', async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    answers: z.array(z.object({ q: z.string().max(500), a: z.string().max(10000) })).max(40),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const personId = await personIdForUser(req.user!.id);
    if (!personId) { res.status(400).json({ error: 'Your login is not linked to a person record' }); return; }
    const { submitSelfAssessment } = await import('../services/staff-review-prep');
    const data = await submitSelfAssessment(req.params.reviewId as string, personId, parsed.data.answers);
    res.json({ data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save your answers';
    res.status(msg === 'Review not found' ? 404 : 400).json({ error: msg });
  }
});

// GET /api/staff-calendar/review-questions — the same set, for the admin side
router.get('/review-questions', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const { getReviewQuestions } = await import('../services/staff-review-prep');
    res.json({ data: await getReviewQuestions() });
  } catch (err) {
    console.error('[staff-calendar] review questions error:', err);
    res.status(500).json({ error: 'Failed to load the questions' });
  }
});

// POST /api/staff-calendar/employees/:personId/reviews/:reviewId/prep
router.post('/employees/:personId/reviews/:reviewId/prep', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    answers: z.array(z.object({ q: z.string().max(500), a: z.string().max(10000) })).max(40),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const { saveManagerPrep } = await import('../services/staff-review-prep');
    const data = await saveManagerPrep(
      req.params.reviewId as string, req.params.personId as string, parsed.data.answers);
    res.json({ data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save';
    res.status(msg === 'Review not found' ? 404 : 400).json({ error: msg });
  }
});

// ── Key data: NI + right to work (spec §3.2) ────────────────────────────────
// A separate endpoint from the employment save on purpose: a routine edit to
// somebody's job title must not be able to blank their NI number, and the NI
// write wants one audited path rather than being buried in a general upsert.

const keyDataSchema = z.object({
  // '' clears. Absent leaves it alone — the UI never round-trips the stored
  // value, so an omitted key genuinely means "not touched".
  niNumber: z.string().max(20).nullish(),
  rtwDocumentType: z.string().max(50).nullish(),
  rtwCheckedOn: z.union([dateStr, z.literal('')]).nullish(),
  rtwExpiresOn: z.union([dateStr, z.literal('')]).nullish(),
});

// PUT /api/staff-calendar/employees/:personId/key-data
router.put('/employees/:personId/key-data', adminOnly, async (req: AuthRequest, res: Response) => {
  const parsed = keyDataSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }

  // Refuse cleanly rather than 500 on a server with no ENCRYPTION_KEY, and
  // refuse BEFORE writing anything — a half-saved right-to-work check with a
  // silently dropped NI number would be worse than an error.
  const wantsNi = parsed.data.niNumber !== undefined
    && parsed.data.niNumber !== null
    && parsed.data.niNumber !== '';
  if (wantsNi) {
    const { isEncryptionConfigured } = await import('../services/encryption');
    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: 'Encryption is not configured on this server — cannot store an NI number.' });
      return;
    }
  }

  try {
    const rec = await updateKeyData(req.params.personId as string, parsed.data, req.user!.id);
    res.json({ data: rec });
  } catch (err) {
    console.error('[staff-calendar] key data error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save' });
  }
});

// GET /api/staff-calendar/employees/:personId/ni-number
// The ONLY way the number itself leaves the server. Audited on every call.
router.get('/employees/:personId/ni-number', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const value = await revealNiNumber(req.params.personId as string, req.user!.id);
    res.json({ data: { niNumber: value } });
  } catch (err) {
    console.error('[staff-calendar] ni reveal error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read' });
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
  probationEndDate: dateStr.nullish(),
  noticePeriodDays: z.number().int().min(0).max(365).nullish(),
  notes: z.string().nullish(),
  preferredName: z.string().max(100).nullish(),
  pronouns: z.string().max(40).nullish(),
  // Per-person review cadence (spec §5.6). NULL inherits the company setting,
  // exactly as bankHolidayPolicy and entitlementWeeks already do.
  reviewIntervalMonths: z.number().int().min(1).max(60).nullish(),
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

// Admin surface, so includePrivate = true. Anything staff-facing must call
// listReviews() without it — private_notes never leaves the server otherwise.
router.get('/employees/:personId/reviews', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listReviews(req.params.personId as string, true) });
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
    status: z.enum(['proposed', 'confirmed', 'completed', 'cancelled']).optional(),
    completedAt: z.string().nullish(),
    sharedSummary: z.string().max(20000).nullish(),
    privateNotes: z.string().max(20000).nullish(),
    outcome: z.string().max(4000).nullish(),
    nextReviewDue: dateStr.nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const { id, ...input } = parsed.data;
    const row = await upsertReview(id ?? null, req.params.personId as string, input, req.user!.id);
    res.json({ data: row });
  } catch (err) {
    console.error('[staff-calendar] review error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save the review' });
  }
});

// POST /api/staff-calendar/employees/:personId/reviews/:reviewId/complete
// Stamps the review, derives when the next one falls due from the person's own
// cadence, and — when a rise came out of it — writes the salary row and links
// the two. Pay is decided AFTER the meeting (spec §5.1), which is why it
// arrives here rather than on the review form.
router.post('/employees/:personId/reviews/:reviewId/complete', adminOnly, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    sharedSummary: z.string().max(20000).nullish(),
    privateNotes: z.string().max(20000).nullish(),
    outcome: z.string().max(4000).nullish(),
    newSalary: z.number().min(0).max(10_000_000).nullish(),
    salaryEffectiveFrom: dateStr.nullish(),
    salaryReason: z.string().max(500).nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const row = await recordReviewOutcome(
      req.params.reviewId as string,
      req.params.personId as string,
      parsed.data,
      req.user!.id
    );
    res.json({ data: row });
  } catch (err) {
    console.error('[staff-calendar] review complete error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to complete the review' });
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
