/**
 * Freelancer Onboarding — Phase A (invite backend).
 *
 * Staff invite a freelancer (existing address-book person OR a brand-new
 * name+email shell), which mints a tokenised application and emails the intro
 * + form link. The public apply form + review/approve flow are later phases.
 *
 * See docs/FREELANCER-ONBOARDING-SPEC.md.
 */
import { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { logAudit } from '../middleware/audit';
import { getFrontendUrl } from '../config/app-urls';
import { emailService } from '../services/email-service';

const router = Router();

// Anyone on the team can input a potential freelancer + send an invite.
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function formUrlFor(token: string): string {
  return `${getFrontendUrl()}/freelancer-apply/${token}`;
}

// ── POST /api/freelancers/invite ───────────────────────────────────────────
// Body: { person_id } OR { first_name, last_name, email }.
// Creates/links the person (flagged is_freelancer + status='invited'), opens a
// freelancer_applications row, and emails the intro + form link.
const inviteSchema = z
  .object({
    person_id: z.string().uuid().optional(),
    first_name: z.string().min(1).max(255).optional(),
    last_name: z.string().min(1).max(255).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(50).optional().nullable(),
    send_email: z.boolean().optional().default(true),
  })
  .refine(
    (v) => v.person_id || (v.first_name && v.last_name),
    { message: 'Provide person_id, or first_name + last_name for a new freelancer.' }
  );

router.post('/invite', async (req: AuthRequest, res: Response) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid invite payload' });
    return;
  }
  const { person_id, first_name, last_name, email, phone, send_email } = parsed.data;

  try {
    let person: { id: string; first_name: string; last_name: string; preferred_name: string | null; email: string | null };

    if (person_id) {
      // Existing address-book person → flag as an invited freelancer.
      const existing = await query(
        'SELECT id, first_name, last_name, preferred_name, email, is_approved FROM people WHERE id = $1 AND is_deleted = false',
        [person_id]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Person not found' });
        return;
      }
      const updated = await query(
        `UPDATE people
            SET is_freelancer = true,
                freelancer_status = 'invited',
                freelancer_removed_at = NULL,
                freelancer_removed_reason = NULL,
                updated_at = NOW()
          WHERE id = $1
        RETURNING id, first_name, last_name, preferred_name, email`,
        [person_id]
      );
      person = updated.rows[0];
      await logAudit(req.user!.id, 'people', person.id, 'update', existing.rows[0], updated.rows[0]);
    } else {
      // Brand-new freelancer — create a lightweight shell person.
      const created = await query(
        `INSERT INTO people (first_name, last_name, email, phone, is_freelancer, freelancer_status, created_by)
         VALUES ($1, $2, $3, $4, true, 'invited', $5)
         RETURNING id, first_name, last_name, preferred_name, email`,
        [first_name, last_name, email?.toLowerCase() ?? null, phone ?? null, req.user!.id]
      );
      person = created.rows[0];
      await logAudit(req.user!.id, 'people', person.id, 'create', null, person);
    }

    // Open the application + mint the gated link.
    const token = mintToken();
    const appResult = await query(
      `INSERT INTO freelancer_applications (person_id, form_token, status, invited_by)
       VALUES ($1, $2, 'invited', $3)
       RETURNING *`,
      [person.id, token, req.user!.id]
    );
    const application = appResult.rows[0];
    await logAudit(req.user!.id, 'freelancer_applications', application.id, 'create', null, application);

    const formUrl = formUrlFor(token);

    // Email the intro + form link (respects test-mode routing).
    let emailResult: { success: boolean; skipped?: boolean; error?: string } = { success: false, skipped: true };
    if (send_email && person.email) {
      const r = await emailService.send('freelancer_invite', {
        to: person.email,
        variables: {
          firstName: person.preferred_name || person.first_name || 'there',
          formUrl,
        },
      });
      emailResult = { success: r.success, error: r.error };
    } else if (send_email && !person.email) {
      emailResult = { success: false, skipped: true, error: 'No email on file — copy the link and send it manually.' };
    }

    res.status(201).json({
      application,
      person_id: person.id,
      form_url: formUrl,
      email_result: emailResult,
    });
  } catch (error) {
    console.error('Freelancer invite error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/freelancers/applications/:id/resend ──────────────────────────
// Re-send the invite email for an existing invitation (token unchanged).
router.post('/applications/:id/resend', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT fa.id, fa.form_token, fa.status,
              p.first_name, p.preferred_name, p.email
         FROM freelancer_applications fa
         JOIN people p ON p.id = fa.person_id
        WHERE fa.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const app = result.rows[0];
    if (!['invited', 'more_info'].includes(app.status)) {
      res.status(409).json({ error: `Application is '${app.status}' — the form link is no longer live.` });
      return;
    }

    const formUrl = formUrlFor(app.form_token);
    if (!app.email) {
      res.json({ email_result: { success: false, skipped: true, error: 'No email on file.' }, form_url: formUrl });
      return;
    }
    const r = await emailService.send('freelancer_invite', {
      to: app.email,
      variables: { firstName: app.preferred_name || app.first_name || 'there', formUrl },
    });
    res.json({ email_result: { success: r.success, error: r.error }, form_url: formUrl });
  } catch (error) {
    console.error('Freelancer resend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/freelancers/applications ──────────────────────────────────────
// Pending review queue (invited / applied / more_info). Newest first.
router.get('/applications', async (req: AuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const statusFilter = status
      ? 'AND fa.status = $1'
      : "AND fa.status IN ('invited','applied','more_info')";
    const params = status ? [status] : [];

    const result = await query(
      `SELECT fa.id, fa.person_id, fa.status, fa.invited_at, fa.submitted_at,
              p.first_name, p.last_name, p.preferred_name, p.email
         FROM freelancer_applications fa
         JOIN people p ON p.id = fa.person_id
        WHERE p.is_deleted = false ${statusFilter}
        ORDER BY fa.submitted_at DESC NULLS LAST, fa.invited_at DESC
        LIMIT 200`,
      params
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Freelancer applications list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
