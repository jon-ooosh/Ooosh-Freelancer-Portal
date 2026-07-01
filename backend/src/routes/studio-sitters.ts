/**
 * Studio Sitter roster — routes (Rehearsals module, Phase B).
 *
 * The roster is a site-evening view: one row per night that needs cover (derived
 * from rehearsal jobs) plus any manual-override shifts. Staff assign / reassign /
 * bulk-assign approved freelancers (Studio-Sitter-tagged surfaced first), and can
 * force cover on a daytime day. See docs/REHEARSALS-SPEC.md.
 *
 * All endpoints are STAFF_ROLES (day-to-day ops).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import {
  getRoster, getJobCoverage, assignSitter, unassignSitter,
  assignMany, createManualShift, removeManualCover, listSitters,
  getDefaultSitterFee, setDefaultSitterFee,
} from '../services/studio-sitter';

const router = Router();
router.use(authenticate, authorize(...STAFF_ROLES));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.string().regex(DATE_RE, 'expected YYYY-MM-DD');

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// GET /api/studio-sitters/roster?from=&to= — one row per evening in range
router.get('/roster', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = DATE_RE.test(String(req.query.from)) ? String(req.query.from) : today;
    const to = DATE_RE.test(String(req.query.to)) ? String(req.query.to) : addDaysIso(from, 14);
    if (to < from) { res.status(400).json({ error: 'to must be on or after from' }); return; }
    const rows = await getRoster(from, to);
    res.json({ data: rows, range: { from, to } });
  } catch (err) {
    console.error('[studio-sitters] roster error:', err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

// GET /api/studio-sitters/sitters — approved freelancers (Studio Sitter first)
router.get('/sitters', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listSitters() });
  } catch (err) {
    console.error('[studio-sitters] sitters error:', err);
    res.status(500).json({ error: 'Failed to load sitters' });
  }
});

// GET /api/studio-sitters/job/:jobId/coverage — per-evening coverage for a job
router.get('/job/:jobId/coverage', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getJobCoverage(req.params.jobId as string) });
  } catch (err) {
    console.error('[studio-sitters] coverage error:', err);
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});

// POST /api/studio-sitters/assign — assign or reassign a sitter to an evening
const assignSchema = z.object({ date: dateStr, person_id: z.string().uuid() });
router.post('/assign', async (req: AuthRequest, res: Response) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const shiftId = await assignSitter(parsed.data.date, parsed.data.person_id, req.user?.id ?? null);
    res.json({ data: { shift_id: shiftId } });
  } catch (err) {
    console.error('[studio-sitters] assign error:', err);
    res.status(500).json({ error: 'Failed to assign sitter' });
  }
});

// POST /api/studio-sitters/unassign — clear the sitter from an evening
const unassignSchema = z.object({ date: dateStr });
router.post('/unassign', async (req: AuthRequest, res: Response) => {
  const parsed = unassignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    await unassignSitter(parsed.data.date);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[studio-sitters] unassign error:', err);
    res.status(500).json({ error: 'Failed to unassign sitter' });
  }
});

// POST /api/studio-sitters/bulk-assign — one person over selected dates, or every
// unassigned needed night in [from,to] when no explicit dates are given.
const bulkSchema = z.object({
  person_id: z.string().uuid(),
  dates: z.array(dateStr).min(1).max(400).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
router.post('/bulk-assign', async (req: AuthRequest, res: Response) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const { person_id, dates, from, to } = parsed.data;
  try {
    let targets: string[];
    if (dates && dates.length > 0) {
      targets = dates;
    } else if (from && to) {
      if (to < from) { res.status(400).json({ error: 'to must be on or after from' }); return; }
      const roster = await getRoster(from, to);
      targets = roster.filter((r) => r.needs_sitter && !r.assignee).map((r) => r.date);
    } else {
      res.status(400).json({ error: 'Provide dates[] or from/to' });
      return;
    }
    const count = await assignMany(targets, person_id, req.user?.id ?? null);
    res.json({ data: { assigned: count } });
  } catch (err) {
    console.error('[studio-sitters] bulk-assign error:', err);
    res.status(500).json({ error: 'Failed to bulk-assign' });
  }
});

// POST /api/studio-sitters/remove-cover — delete a manual-override cover shift
router.post('/remove-cover', async (req: AuthRequest, res: Response) => {
  const parsed = unassignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const removed = await removeManualCover(parsed.data.date);
    if (!removed) { res.status(404).json({ error: 'No manual cover to remove on that date' }); return; }
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[studio-sitters] remove-cover error:', err);
    res.status(500).json({ error: 'Failed to remove cover' });
  }
});

// GET /api/studio-sitters/default-fee — current default per-night sitter fee
router.get('/default-fee', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: { fee: await getDefaultSitterFee() } });
  } catch (err) {
    console.error('[studio-sitters] default-fee get error:', err);
    res.status(500).json({ error: 'Failed to read default fee' });
  }
});

// PUT /api/studio-sitters/default-fee — set/clear the default fee (manager+)
const feeSchema = z.object({ fee: z.number().nonnegative().nullable() });
router.put('/default-fee', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  const parsed = feeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid fee' }); return; }
  try {
    await setDefaultSitterFee(parsed.data.fee);
    res.json({ data: { fee: parsed.data.fee } });
  } catch (err) {
    console.error('[studio-sitters] default-fee put error:', err);
    res.status(500).json({ error: 'Failed to set default fee' });
  }
});

// POST /api/studio-sitters/manual — force cover on a day not auto-flagged (daytime override)
const manualSchema = z.object({ date: dateStr, reason: z.string().max(500).optional() });
router.post('/manual', async (req: AuthRequest, res: Response) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const shiftId = await createManualShift(parsed.data.date, parsed.data.reason ?? null, req.user?.id ?? null);
    res.json({ data: { shift_id: shiftId } });
  } catch (err) {
    console.error('[studio-sitters] manual error:', err);
    res.status(500).json({ error: 'Failed to add cover' });
  }
});

export default router;
