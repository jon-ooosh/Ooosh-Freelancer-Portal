/**
 * Business figures — admin only (docs/BUSINESS-FIGURES-SPEC.md).
 *
 *   GET /enquiries?from=YYYY-MM-DD&to=YYYY-MM-DD   booking rates, reply and quote times
 *
 * Reads only. Defaults: from the later of 12 months ago and when OP came into use
 * (April 2026), to today.
 */
import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { buildEnquiryFigures, FIGURES_EARLIEST } from '../services/business-figures';
import { ukDatePlus, ukToday } from '../services/uk-date';

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

router.get('/enquiries', async (req: AuthRequest, res: Response) => {
  try {
    const today = ukToday();
    const yearAgo = ukDatePlus(-365);
    const from = isDate(req.query.from) ? req.query.from : (yearAgo > FIGURES_EARLIEST ? yearAgo : FIGURES_EARLIEST);
    const to = isDate(req.query.to) && req.query.to <= today ? req.query.to : today;
    if (from > to) {
      res.status(400).json({ error: 'The start date is after the end date.' });
      return;
    }
    res.json({ data: await buildEnquiryFigures(from, to) });
  } catch (err) {
    console.error('[business-figures] enquiries:', err);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

export default router;
