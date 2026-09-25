/**
 * My To Do — staff_tasks routes. docs/STAFF-RECORDS-SPEC.md §6.
 *
 * NOT an admin module, unlike the rest of staff records: everybody manages
 * their own list, and since To Do phase 1 (docs/TASKS-SPEC.md) anyone can
 * give anyone a task. STAFF_ROLES, not STAFF_ADMIN_ROLES. The per-row check
 * lives in services/staff-tasks.ts (`assertCanTouch`), which is the only thing
 * separating "my list" from "everyone's list" — so routes here stay thin and
 * never hand-roll an ownership test.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  listTasks, createTask, updateTask, cancelTask, openTaskCount,
  personIdForUser, listTasksForSource, TASK_STATUSES,
  handBackTask, listAssignedByMe, listEveryone, listAssignablePeople,
} from '../services/staff-tasks';
import { STAFF_ADMIN_ROLES } from '../services/staff-employment';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.union([z.string().regex(DATE_RE), z.literal(''), z.null()]);

const createSchema = z.object({
  title: z.string().min(1).max(300),
  detail: z.string().max(4000).nullish(),
  dueDate: dateStr.optional(),
  nextChaseDate: dateStr.optional(),
  // Admin-only in the service; rejected there rather than here so one rule
  // covers every caller, including Phase 4's review actions.
  personId: z.string().regex(UUID_RE).optional(),
  // An action agreed at a review. Links the task to it (source_type
  // 'staff_review') — without this a review action was saved as a plain
  // manual to-do and never reached the follow-up email. Spec §22.
  reviewId: z.string().regex(UUID_RE).optional(),
  isPrivate: z.boolean().optional(),
  followUpOn: dateStr.optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  detail: z.string().max(4000).nullish(),
  dueDate: dateStr.optional(),
  nextChaseDate: dateStr.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  // Setter / admin only — enforced in the service, not here.
  personId: z.string().regex(UUID_RE).optional(),
  followUpOn: dateStr.optional(),
  isPrivate: z.boolean().optional(),
});

const handBackSchema = z.object({
  reason: z.string().min(1).max(1000),
});

// GET /api/staff-tasks/assigned — what I gave to other people
router.get('/assigned', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listAssignedByMe(req.user!.id) });
  } catch (err) {
    console.error('[staff-tasks] list assigned error:', err);
    res.status(500).json({ error: 'Failed to load the tasks you set' });
  }
});

// GET /api/staff-tasks/everyone — every open task, minus private ones
router.get('/everyone', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listEveryone(req.user!.id, req.user!.role) });
  } catch (err) {
    console.error('[staff-tasks] list everyone error:', err);
    res.status(500).json({ error: 'Failed to load everyone’s tasks' });
  }
});

// GET /api/staff-tasks/people — who a task can be given to
router.get('/people', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listAssignablePeople() });
  } catch (err) {
    console.error('[staff-tasks] people error:', err);
    res.status(500).json({ error: 'Failed to load people' });
  }
});

// GET /api/staff-tasks/mine?includeDone=true
router.get('/mine', async (req: AuthRequest, res: Response) => {
  try {
    const personId = await personIdForUser(req.user!.id);
    // A login not linked to a person isn't an error worth a 500 — My Time
    // already surfaces that state properly. Return an empty list and say so.
    if (!personId) { res.json({ data: [], linked: false }); return; }
    const data = await listTasks(personId, req.query.includeDone === 'true');
    // `me` lets the page tell my rows from ones I handed back (still listed,
    // greyed, in my recently finished).
    res.json({ data, linked: true, me: personId, counts: await openTaskCount(personId) });
  } catch (err) {
    console.error('[staff-tasks] list mine error:', err);
    res.status(500).json({ error: 'Failed to load your tasks' });
  }
});

// GET /api/staff-tasks/person/:personId — admin, somebody else's list
router.get('/person/:personId', authorize(...STAFF_ADMIN_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const personId = req.params.personId as string;
    if (!UUID_RE.test(personId)) { res.status(400).json({ error: 'personId must be a UUID' }); return; }
    res.json({ data: await listTasks(personId, req.query.includeDone === 'true') });
  } catch (err) {
    console.error('[staff-tasks] list person error:', err);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

// GET /api/staff-tasks/review/:reviewId — admin, every action a review
// produced, whoever owns it. The company's own actions are the ones most
// likely to lapse (spec §6.2), so they must show beside the reviewee's.
router.get('/review/:reviewId', authorize(...STAFF_ADMIN_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const reviewId = req.params.reviewId as string;
    if (!UUID_RE.test(reviewId)) { res.status(400).json({ error: 'reviewId must be a UUID' }); return; }
    res.json({ data: await listTasksForSource('staff_review', reviewId) });
  } catch (err) {
    console.error('[staff-tasks] list review actions error:', err);
    res.status(500).json({ error: 'Failed to load the review actions' });
  }
});

// POST /api/staff-tasks
router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;
    const task = await createTask(
      {
        title: body.title,
        detail: body.detail ?? null,
        dueDate: body.dueDate || null,
        // Passed through only when the caller said something — `undefined`
        // means "derive it", which is not the same as "never nudge me".
        nextChaseDate: body.nextChaseDate === undefined ? undefined : (body.nextChaseDate || null),
        personId: body.personId,
        isPrivate: body.isPrivate,
        followUpOn: body.followUpOn === undefined ? undefined : (body.followUpOn || null),
        ...(body.reviewId ? { sourceType: 'staff_review', sourceId: body.reviewId } : {}),
      },
      req.user!.id,
      req.user!.role
    );
    res.status(201).json({ data: task });
  } catch (err) {
    console.error('[staff-tasks] create error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add the task' });
  }
});

// PATCH /api/staff-tasks/:id — edit, tick, or re-open
router.patch('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'id must be a UUID' }); return; }
    const body = req.body as z.infer<typeof updateSchema>;
    const task = await updateTask(
      id,
      {
        title: body.title,
        detail: body.detail === undefined ? undefined : (body.detail ?? null),
        dueDate: body.dueDate === undefined ? undefined : (body.dueDate || null),
        nextChaseDate: body.nextChaseDate === undefined ? undefined : (body.nextChaseDate || null),
        status: body.status,
        personId: body.personId,
        followUpOn: body.followUpOn === undefined ? undefined : (body.followUpOn || null),
        isPrivate: body.isPrivate,
      },
      req.user!.id,
      req.user!.role
    );
    res.json({ data: task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update the task';
    // "Not found" covers both missing and not-yours on purpose: telling
    // somebody a task exists but isn't theirs is itself a small leak.
    res.status(msg === 'Task not found' ? 404 : 400).json({ error: msg });
  }
});

// POST /api/staff-tasks/:id/hand-back — the owner returns it to whoever set it
router.post('/:id/hand-back', validate(handBackSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'id must be a UUID' }); return; }
    const { reason } = req.body as z.infer<typeof handBackSchema>;
    res.json({ data: await handBackTask(id, reason, req.user!.id) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to hand the task back';
    res.status(msg === 'Task not found' ? 404 : 400).json({ error: msg });
  }
});

// DELETE /api/staff-tasks/:id — cancels, never deletes
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'id must be a UUID' }); return; }
    res.json({ data: await cancelTask(id, req.user!.id, req.user!.role) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to cancel the task';
    res.status(msg === 'Task not found' ? 404 : 400).json({ error: msg });
  }
});

export default router;
