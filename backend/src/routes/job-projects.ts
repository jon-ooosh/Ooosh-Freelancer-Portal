import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, authorize, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import {
  getProject, listProjects, createProjectFromJob, updateProject,
  addJobToProject, removeJobFromProject, projectJobCandidates, ProjectError,
} from '../services/job-projects';

// Job projects — "these jobs all belong to the same festival"
// (docs/JOB-PROJECTS-SPEC.md). Any staff member can make and manage one.
// All logic lives in services/job-projects.ts.
const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const uuid = z.string().uuid();
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable();
const projectFields = {
  name: z.string().min(1).max(200).optional(),
  client_id: uuid.optional().nullable(),
  lead_user_id: uuid.optional().nullable(),
  out_date: optDate,
  job_date: optDate,
  job_end: optDate,
  return_date: optDate,
};

/** A ProjectError is worded for a person and answered as-is; anything else is a 500. */
function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof ProjectError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[projects] ${what} failed:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// GET /api/job-projects?search= — for the "Add to a project" picker
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : null;
    res.json({ data: await listProjects(search) });
  } catch (err) { fail(res, err, 'list'); }
});

// POST /api/job-projects — a new project, starting from a job (which joins it)
router.post(
  '/',
  validate(z.object({ ...projectFields, name: z.string().min(1).max(200), from_job_id: uuid })),
  async (req: AuthRequest, res: Response) => {
    try {
      const { from_job_id, ...input } = req.body;
      const id = await createProjectFromJob(from_job_id, input, req.user!.id);
      await logAudit(req.user!.id, 'job_projects', id, 'create', null, req.body);
      res.status(201).json({ data: await getProject(id) });
    } catch (err) { fail(res, err, 'create'); }
  },
);

// GET /api/job-projects/:id — the panel: project, members, roll-ups
router.get('/:id', validate(z.object({ id: uuid }), 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const project = await getProject((req.params.id as string));
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ data: project });
  } catch (err) { fail(res, err, 'read'); }
});

// PATCH /api/job-projects/:id — name, client, lead, default dates
router.patch(
  '/:id',
  validate(z.object({ id: uuid }), 'params'),
  validate(z.object(projectFields)),
  async (req: AuthRequest, res: Response) => {
    try {
      await updateProject((req.params.id as string), req.body);
      await logAudit(req.user!.id, 'job_projects', (req.params.id as string), 'update', null, req.body);
      res.json({ data: await getProject((req.params.id as string)) });
    } catch (err) { fail(res, err, 'update'); }
  },
);

// GET /api/job-projects/:id/job-candidates?search= — jobs that could be added
router.get('/:id/job-candidates', validate(z.object({ id: uuid }), 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : null;
    res.json({ data: await projectJobCandidates((req.params.id as string), search) });
  } catch (err) { fail(res, err, 'candidates'); }
});

// POST /api/job-projects/:id/jobs { job_id } — add (or move) a job into this project
router.post(
  '/:id/jobs',
  validate(z.object({ id: uuid }), 'params'),
  validate(z.object({ job_id: uuid })),
  async (req: AuthRequest, res: Response) => {
    try {
      await addJobToProject((req.params.id as string), req.body.job_id, req.user!.id);
      await logAudit(req.user!.id, 'jobs', req.body.job_id, 'add_to_project', null, { job_project_id: (req.params.id as string) });
      res.json({ data: await getProject((req.params.id as string)) });
    } catch (err) { fail(res, err, 'add job'); }
  },
);

// DELETE /api/job-projects/jobs/:jobId — take a job out of its project
router.delete('/jobs/:jobId', validate(z.object({ jobId: uuid }), 'params'), async (req: AuthRequest, res: Response) => {
  try {
    await removeJobFromProject((req.params.jobId as string), req.user!.id);
    await logAudit(req.user!.id, 'jobs', (req.params.jobId as string), 'remove_from_project', null, null);
    res.json({ data: { ok: true } });
  } catch (err) { fail(res, err, 'remove job'); }
});

export default router;
