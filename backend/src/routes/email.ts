/**
 * Email Service API Routes
 *
 * Admin endpoints for email configuration, status, and audit log.
 */
import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { emailService } from '../services/email-service';
import { query } from '../config/database';

const router = Router();
router.use(authenticate);

/**
 * GET /api/email/status
 * Get email service status — configured, mode, available templates.
 */
router.get('/status', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    res.json({
      configured: emailService.isConfigured(),
      mode: emailService.getMode(),
      templates: emailService.getTemplateIds(),
    });
  } catch (err) {
    console.error('[email/status] Error:', err);
    res.status(500).json({ error: 'Failed to get email status' });
  }
});

/**
 * PUT /api/email/mode
 * Toggle email mode between test and live. Admin only.
 * Body: { mode: 'test' | 'live' }
 */
router.put('/mode', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { mode } = req.body;
    if (mode !== 'test' && mode !== 'live') {
      res.status(400).json({ error: 'Mode must be "test" or "live"' });
      return;
    }

    // Update the runtime env var (persists until server restart)
    process.env.EMAIL_MODE = mode;

    // Reset transporter in case config changed
    emailService.resetTransporter();

    console.log(`[Email] Mode changed to "${mode}" by ${req.user?.email}`);

    res.json({ mode, message: `Email mode set to ${mode}` });
  } catch (err) {
    console.error('[email/mode] Error:', err);
    res.status(500).json({ error: 'Failed to update email mode' });
  }
});

/**
 * POST /api/email/test
 * Send a test email to verify SMTP is working. Admin only.
 */
router.post('/test', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    if (!emailService.isConfigured()) {
      res.status(503).json({ error: 'SMTP not configured' });
      return;
    }

    // Verify connection first
    const verify = await emailService.verifyConnection();
    if (!verify.success) {
      res.status(503).json({ error: `SMTP connection failed: ${verify.error}` });
      return;
    }

    // Send a test email
    const result = await emailService.sendRaw({
      to: req.user?.email || 'admin@oooshtours.co.uk',
      subject: 'Ooosh Email Service Test',
      html: `
        <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Email Service Working</h2>
        <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
          This is a test email from the Ooosh Operations Platform email service.
        </p>
        <p style="margin:0;font-size:14px;color:#334155;">
          Sent at: ${new Date().toISOString()}
        </p>
      `,
      variant: 'internal',
    });

    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    console.error('[email/test] Error:', err);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

/**
 * GET /api/email/log
 * Get recent email audit log. Admin only.
 * Query params: ?limit=50&offset=0&status=sent|failed
 */
router.get('/log', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const statusFilter = req.query.status as string;

    let sql = `SELECT id, template_id, recipient, actual_recipient, subject, status, message_id, error_message, mode, created_at
               FROM email_log`;
    const params: unknown[] = [];

    if (statusFilter && (statusFilter === 'sent' || statusFilter === 'failed')) {
      sql += ` WHERE status = $1`;
      params.push(statusFilter);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM email_log';
    const countParams: unknown[] = [];
    if (statusFilter && (statusFilter === 'sent' || statusFilter === 'failed')) {
      countSql += ` WHERE status = $1`;
      countParams.push(statusFilter);
    }
    const countResult = await query(countSql, countParams);

    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('[email/log] Error:', err);
    res.status(500).json({ error: 'Failed to fetch email log' });
  }
});

/**
 * GET /api/email/broker-metrics
 * Get HireHop broker metrics. Admin only. (Convenience endpoint)
 */
router.get('/broker-metrics', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const { hhBroker } = await import('../services/hirehop-broker');
    res.json(hhBroker.getMetrics());
  } catch (err) {
    console.error('[email/broker-metrics] Error:', err);
    res.status(500).json({ error: 'Failed to get broker metrics' });
  }
});

export default router;
