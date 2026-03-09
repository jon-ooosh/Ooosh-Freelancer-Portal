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

export default router;
