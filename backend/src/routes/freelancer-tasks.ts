/**
 * Freelancer tasks — staff side. docs/STAFF-CALENDAR-SPEC.md §21.
 *
 * Tasks on a freelancer's day booking (staff calendar) or a studio sitter's
 * evening (Operations › Rehearsals). Thin wrappers: every rule lives in
 * services/freelancer-tasks.ts.
 *
 * STAFF_ROLES throughout, like booking the day itself — giving a freelancer
 * something to do is the whole team's job.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import {
  TaskOwner, listTasks, createTask, updateTask, cancelTask, setDoneByStaff,
  getOwnerContext, changesSinceNotified, sendTasksUpdate,
} from '../services/freelancer-tasks';

const router = Router();
router.use(authenticate, authorize(...STAFF_ROLES));

const ownerSchema = z.union([
  z.object({ bookingId: z.string().uuid(), shiftId: z.undefined().optional() }),
  z.object({ shiftId: z.string().uuid(), bookingId: z.undefined().optional() }),
]);

function readOwner(src: unknown): TaskOwner | null {
  const p = ownerSchema.safeParse(src);
  if (!p.success) return null;
  return 'bookingId' in p.data && p.data.bookingId
    ? { kind: 'booking', id: p.data.bookingId }
    : { kind: 'shift', id: (p.data as { shiftId: string }).shiftId };
}

const fail = (res: Response, err: unknown, fallback: string) =>
  res.status(400).json({ error: err instanceof Error ? err.message : fallback });

// GET /api/freelancer-tasks?bookingId= | ?shiftId=
router.get('/', async (req: AuthRequest, res: Response) => {
  const owner = readOwner({
    bookingId: typeof req.query.bookingId === 'string' ? req.query.bookingId : undefined,
    shiftId: typeof req.query.shiftId === 'string' ? req.query.shiftId : undefined,
  });
  if (!owner) { res.status(400).json({ error: 'Give a bookingId or a shiftId' }); return; }
  try {
    const ctx = await getOwnerContext(owner);
    if (!ctx) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      data: await listTasks(owner),
      owner: {
        date: ctx.date,
        live: ctx.live,
        hasPerson: !!ctx.person,
        hasEmail: !!ctx.person?.email,
        lastNotifiedAt: ctx.lastNotifiedAt,
        changesSinceNotified: await changesSinceNotified(owner, ctx.lastNotifiedAt),
      },
    });
  } catch (err) {
    console.error('[freelancer-tasks] list error:', err);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

const taskBody = z.object({
  taskType: z.enum(['van_prep', 'other']),
  vehicleId: z.string().uuid().nullish(),
  jobId: z.string().uuid().nullish(),
  hhJobNumber: z.number().int().positive().nullish(),
  description: z.string().max(500).nullish(),
});

// POST /api/freelancer-tasks  { bookingId | shiftId, taskType, vehicleId?, jobId? | hhJobNumber?, description? }
router.post('/', async (req: AuthRequest, res: Response) => {
  const owner = readOwner({ bookingId: req.body?.bookingId, shiftId: req.body?.shiftId });
  const body = taskBody.safeParse(req.body);
  if (!owner) { res.status(400).json({ error: 'Give a bookingId or a shiftId' }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    res.status(201).json({ data: await createTask(owner, body.data, req.user!.id) });
  } catch (err) { fail(res, err, 'Failed to add that task'); }
});

// PATCH /api/freelancer-tasks/:id  { vehicleId?, jobId? | hhJobNumber?, description? }
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const body = taskBody.omit({ taskType: true }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    res.json({ data: await updateTask(String(req.params.id), body.data) });
  } catch (err) { fail(res, err, 'Failed to change that task'); }
});

// POST /api/freelancer-tasks/:id/cancel — soft-cancel (never a delete)
router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await cancelTask(String(req.params.id)) });
  } catch (err) { fail(res, err, 'Failed to remove that task'); }
});

// POST /api/freelancer-tasks/:id/done  { done: boolean }
router.post('/:id/done', async (req: AuthRequest, res: Response) => {
  const done = req.body?.done !== false;
  try {
    res.json({ data: await setDoneByStaff(String(req.params.id), done, req.user!.id) });
  } catch (err) { fail(res, err, 'Failed to update that task'); }
});

// POST /api/freelancer-tasks/send-update  { bookingId | shiftId }
// Staff decide when the freelancer needs telling — never an email per change.
router.post('/send-update', async (req: AuthRequest, res: Response) => {
  const owner = readOwner({ bookingId: req.body?.bookingId, shiftId: req.body?.shiftId });
  if (!owner) { res.status(400).json({ error: 'Give a bookingId or a shiftId' }); return; }
  try {
    const result = await sendTasksUpdate(owner);
    if (result.sent) { res.json({ data: result }); return; }
    const why: Record<string, string> = {
      gone: 'That no longer exists',
      not_live: 'That day is not live any more',
      past: 'That day has gone',
      nobody: 'Nobody is on that evening yet',
      no_email: 'We have no email address for them',
      failed: 'The email did not send — try again',
    };
    res.status(result.why === 'failed' ? 502 : 409).json({ error: why[result.why] ?? 'Not sent', data: result });
  } catch (err) {
    console.error('[freelancer-tasks] send-update error:', err);
    res.status(500).json({ error: 'Failed to send the update' });
  }
});

export default router;
