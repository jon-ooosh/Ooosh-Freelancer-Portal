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
