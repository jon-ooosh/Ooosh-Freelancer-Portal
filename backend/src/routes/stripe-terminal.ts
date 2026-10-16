/**
 * Card reader (Stripe Terminal) — docs/STRIPE-TERMINAL-SPEC.md, Phases 0–1.
 *
 *   GET  /terminal/access                     may I use the reader? which mode? (never 403s — the Money tab asks it)
 *   GET  /terminal/readers                    readers for the current mode, online first
 *   POST /terminal/jobs/:jobId/pay            send a hire payment to a reader (body: amount, payment_type, reader_id, notes)
 *   GET  /terminal/sessions/:id?check=1       the payment's state (check=1 asks Stripe, not just OP)
 *   POST /terminal/sessions/:id/retry         Try again after a decline — the SAME PaymentIntent
 *   POST /terminal/sessions/:id/cancel        clear the reader and cancel the PaymentIntent
 *   POST /terminal/sessions/:id/simulate      test mode only: tap a pretend card (body: outcome approve|decline)
 *   GET  /terminal/excess/:excessId/options   what the excess Manage modal may offer: payment, pre-auth (with the reason when not)
 *   GET  /terminal/sessions/:id/receipt       who "Send receipt?" pre-ticks
 *   POST /terminal/sessions/:id/receipt       answer it (body: recipients [{email,name}] | skip: true)
 *
 * Everything but /access is gated on `system_settings.stripe_terminal_roles`
 * (admin only while testing — jon, 16 Oct 2026), so hiding the option in the UI is
 * not the only thing keeping it from staff.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  canUseTerminal, getTerminalMode, isModeConfigured, listReaders, startTerminalPayment,
  readSession, retrySession, cancelSession, simulateTap, TerminalError,
  sendTerminalReceipt, defaultReceiptRecipients, excessReaderOptions,
} from '../services/stripe-terminal';

const router = Router();
router.use(authenticate);

const fail = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof TerminalError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[terminal] ${fallback}:`, err);
  res.status(500).json({ error: err instanceof Error ? err.message : fallback });
};

async function requireTerminalAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await canUseTerminal(req.user?.role)) { next(); return; }
    res.status(403).json({ error: 'The card reader is not switched on for your login yet.' });
  } catch (err) {
    fail(res, err, 'access check failed');
  }
}

router.get('/access', async (req: AuthRequest, res: Response) => {
  try {
    const enabled = await canUseTerminal(req.user?.role);
    const mode = await getTerminalMode();
    res.json({ data: { enabled, mode, configured: enabled ? isModeConfigured(mode) : undefined } });
  } catch (err) {
    fail(res, err, 'Failed to read card reader access');
  }
});

router.get('/readers', requireTerminalAccess, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listReaders() });
  } catch (err) {
    fail(res, err, 'Failed to list readers');
  }
});

const paySchema = z.object({
  amount: z.number().min(1).max(50000),
  payment_type: z.enum(['deposit', 'balance', 'excess', 'excess_preauth']),
  reader_id: z.string().min(1).max(100),
  notes: z.string().max(1000).optional(),
  // Required for excess / excess_preauth — the record the money or pre-auth lands on.
  excess_id: z.string().uuid().optional(),
});

router.post('/jobs/:jobId/pay', requireTerminalAccess, validate(paySchema), async (req: AuthRequest, res: Response) => {
  try {
    const session = await startTerminalPayment({
      jobId: req.params.jobId as string,
      amount: req.body.amount,
      paymentType: req.body.payment_type,
      readerId: req.body.reader_id,
      notes: req.body.notes || null,
      userId: req.user!.id,
      excessId: req.body.excess_id || null,
    });
    res.json({ data: session });
  } catch (err) {
    fail(res, err, 'Failed to send the payment to the reader');
  }
});

router.get('/excess/:excessId/options', requireTerminalAccess, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await excessReaderOptions(req.params.excessId as string) });
  } catch (err) {
    fail(res, err, 'Failed to read the card reader options');
  }
});

router.get('/sessions/:id', requireTerminalAccess, async (req: AuthRequest, res: Response) => {
  try {
    const session = await readSession(req.params.id as string, req.query.check === '1');
    if (!session) { res.status(404).json({ error: 'Payment not found' }); return; }
    res.json({ data: session });
  } catch (err) {
    fail(res, err, 'Failed to read the payment');
  }
});

router.post('/sessions/:id/retry', requireTerminalAccess, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await retrySession(req.params.id as string) });
  } catch (err) {
    fail(res, err, 'Failed to resend the payment');
  }
});

router.post('/sessions/:id/cancel', requireTerminalAccess, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await cancelSession(req.params.id as string) });
  } catch (err) {
    fail(res, err, 'Failed to cancel the payment');
  }
});

const simulateSchema = z.object({ outcome: z.enum(['approve', 'decline']) });

router.post('/sessions/:id/simulate', requireTerminalAccess, validate(simulateSchema), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await simulateTap(req.params.id as string, req.body.outcome) });
  } catch (err) {
    fail(res, err, 'Failed to simulate the card');
  }
});

router.get('/sessions/:id/receipt', requireTerminalAccess, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: { default_emails: await defaultReceiptRecipients(req.params.id as string) } });
  } catch (err) {
    fail(res, err, 'Failed to read the receipt recipients');
  }
});

const receiptSchema = z.object({
  recipients: z.array(z.object({
    email: z.string().email().max(255),
    name: z.string().max(255).nullable().optional(),
  })).max(10).optional(),
  skip: z.boolean().optional(),
}).refine((v) => v.skip === true || (v.recipients && v.recipients.length > 0), {
  message: 'Pick at least one recipient, or choose No receipt',
});

router.post('/sessions/:id/receipt', requireTerminalAccess, validate(receiptSchema), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await sendTerminalReceipt(req.params.id as string, {
      recipients: req.body.recipients || null,
      skip: req.body.skip === true,
    }) });
  } catch (err) {
    fail(res, err, 'Failed to send the receipt');
  }
});

export default router;
