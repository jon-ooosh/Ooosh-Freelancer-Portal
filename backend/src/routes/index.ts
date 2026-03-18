import { Router } from 'express';
import healthRouter from './health';
import authRouter from './auth';
import peopleRouter from './people';
import organisationsRouter from './organisations';
import venuesRouter from './venues';
import interactionsRouter from './interactions';
import searchRouter from './search';
import filesRouter from './files';
import backupsRouter from './backups';
import usersRouter from './users';
import notificationsRouter from './notifications';
import dashboardRouter from './dashboard';
import duplicatesRouter from './duplicates';
import hirehopRouter from './hirehop';
import pipelineRouter from './pipeline';
import quotesRouter from './quotes';
import vehiclesRouter from './vehicles';
import emailRouter from './email';
import driversRouter from './drivers';
import assignmentsRouter from './assignments';
import excessRouter from './excess';
import hireFormsRouter from './hire-forms';
import webhooksRouter from './webhooks';
import driverVerificationRouter from './driver-verification';
import requirementsRouter from './requirements';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/people', peopleRouter);
router.use('/organisations', organisationsRouter);
router.use('/venues', venuesRouter);
router.use('/interactions', interactionsRouter);
router.use('/search', searchRouter);
router.use('/files', filesRouter);
router.use('/backups', backupsRouter);
router.use('/users', usersRouter);
router.use('/notifications', notificationsRouter);
router.use('/dashboard', dashboardRouter);
router.use('/duplicates', duplicatesRouter);
router.use('/hirehop', hirehopRouter);
router.use('/pipeline', pipelineRouter);
router.use('/quotes', quotesRouter);
router.use('/vehicles', vehiclesRouter);
router.use('/email', emailRouter);
router.use('/drivers', driversRouter);
router.use('/assignments', assignmentsRouter);
router.use('/excess', excessRouter);
router.use('/hire-forms', hireFormsRouter);
router.use('/requirements', requirementsRouter);
router.use('/webhooks', webhooksRouter);  // No JWT auth — uses export_key / API key
router.use('/driver-verification', driverVerificationRouter);  // Public-facing — hire form auth (not OP JWT)

// Alias: /api/jobs/:jobNumber → /api/driver-verification/validate-job/:jobNumber
// Needed because Netlify validate-job.js calls opFetch('/jobs/{jobId}')
router.get('/jobs/:jobNumber(\\d+)', (req, res, next) => {
  // Only handle if API key is present (don't interfere with future authenticated /jobs routes)
  if (req.headers['x-api-key']) {
    const jobNumber = (req.params as Record<string, string>).jobNumber;
    req.url = `/validate-job/${jobNumber}`;
    driverVerificationRouter(req, res, next);
  } else {
    next();
  }
});

export default router;
