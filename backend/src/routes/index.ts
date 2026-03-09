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

export default router;
