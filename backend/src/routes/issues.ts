/**
 * Platform Issues Tracker
 *
 * Lightweight internal tracker under Operations → Issues. Anyone logged in
 * can log a bug, feature request, question, or see the backlog. Admins and
 * managers triage status.
 *
 * On issue creation we fire an email alert to jon@oooshtours.co.uk so
 * issues don't get lost during the go-live period.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { emailService } from '../services/email-service';

const router = Router();
router.use(authenticate);

const ALERT_RECIPIENT = 'jon@oooshtours.co.uk';

// Staff roles (everyone who isn't a freelancer) — the whole team needs to
// log and see issues during bedding-in.
const STAFF_ROLES = ['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager'] as const;

// Only admin/manager can change workflow fields
const TRIAGE_ROLES = ['admin', 'manager'] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function categoryLabel(c: string): string {
  return {
    bug: 'Bug',
    feature_request: 'Feature request',
    question: 'Question',
    roadmap: 'Roadmap',
    other: 'Other',
  }[c] || c;
}

function severityLabel(s: string): string {
  return {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'URGENT',
  }[s] || s;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(10000).optional().nullable(),
  category: z.enum(['bug', 'feature_request', 'question', 'roadmap', 'other']).optional(),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  area: z.string().trim().max(50).optional().nullable(),
  page_url: z.string().trim().max(1000).optional().nullable(),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).max(300).optional(),
  description: z.string().trim().max(10000).optional().nullable(),
  category: z.enum(['bug', 'feature_request', 'question', 'roadmap', 'other']).optional(),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  status: z.enum(['new', 'seen', 'in_progress', 'done', 'deferred', 'wont_fix']).optional(),
  area: z.string().trim().max(50).optional().nullable(),
  page_url: z.string().trim().max(1000).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  resolution_notes: z.string().trim().max(10000).optional().nullable(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

// ── List ────────────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, category, area, search, mine, limit = '200' } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status && typeof status === 'string') {
      // Comma-separated list of statuses
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) {
        params.push(statuses);
        conditions.push(`i.status = ANY($${params.length})`);
      }
    }

    if (category && typeof category === 'string') {
      params.push(category);
      conditions.push(`i.category = $${params.length}`);
    }

    if (area && typeof area === 'string') {
      params.push(area);
      conditions.push(`i.area = $${params.length}`);
    }

    if (search && typeof search === 'string') {
      params.push(`%${search}%`);
      conditions.push(`(i.title ILIKE $${params.length} OR i.description ILIKE $${params.length})`);
    }

    if (mine === 'true' && req.user) {
      params.push(req.user.id);
      conditions.push(`i.created_by = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(Math.min(parseInt(limit as string) || 200, 500));

    const sql = `
      SELECT
        i.*,
        reporter.email  AS reporter_email,
        CONCAT(rp.first_name, ' ', rp.last_name) AS reporter_name,
        assignee.email  AS assignee_email,
        CONCAT(ap.first_name, ' ', ap.last_name) AS assignee_name,
        (SELECT COUNT(*) FROM platform_issue_comments c WHERE c.issue_id = i.id) AS comment_count
      FROM platform_issues i
      LEFT JOIN users reporter ON reporter.id = i.created_by
      LEFT JOIN people rp      ON rp.id = reporter.person_id
      LEFT JOIN users assignee ON assignee.id = i.assigned_to
      LEFT JOIN people ap      ON ap.id = assignee.person_id
      ${whereClause}
      ORDER BY
        CASE i.status
          WHEN 'new' THEN 1
          WHEN 'seen' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'deferred' THEN 4
          WHEN 'done' THEN 5
          WHEN 'wont_fix' THEN 6
          ELSE 99
        END,
        CASE i.severity
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
          ELSE 99
        END,
        i.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);

    // Stats for the dashboard-style header
    const statsResult = await query(`
      SELECT status, COUNT(*)::int AS count
      FROM platform_issues
      GROUP BY status
    `);
    const stats: Record<string, number> = {};
    for (const row of statsResult.rows) {
      stats[row.status] = row.count;
    }

    res.json({ data: result.rows, stats });
  } catch (err) {
    console.error('List issues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get one (with comments) ─────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const issueResult = await query(
      `
      SELECT
        i.*,
        reporter.email  AS reporter_email,
        CONCAT(rp.first_name, ' ', rp.last_name) AS reporter_name,
        assignee.email  AS assignee_email,
        CONCAT(ap.first_name, ' ', ap.last_name) AS assignee_name
      FROM platform_issues i
      LEFT JOIN users reporter ON reporter.id = i.created_by
      LEFT JOIN people rp      ON rp.id = reporter.person_id
      LEFT JOIN users assignee ON assignee.id = i.assigned_to
      LEFT JOIN people ap      ON ap.id = assignee.person_id
      WHERE i.id = $1
      `,
      [id]
    );

    if (!issueResult.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const commentsResult = await query(
      `
      SELECT c.*, u.email AS author_email,
        CONCAT(p.first_name, ' ', p.last_name) AS author_name
      FROM platform_issue_comments c
      LEFT JOIN users  u ON u.id = c.author_id
      LEFT JOIN people p ON p.id = u.person_id
      WHERE c.issue_id = $1
      ORDER BY c.created_at ASC
      `,
      [id]
    );

    res.json({ data: { ...issueResult.rows[0], comments: commentsResult.rows } });
  } catch (err) {
    console.error('Get issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

router.post('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const data = parse.data;

    const insert = await query(
      `
      INSERT INTO platform_issues
        (title, description, category, severity, area, page_url, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        data.title,
        data.description ?? null,
        data.category ?? 'bug',
        data.severity ?? 'normal',
        data.area ?? null,
        data.page_url ?? null,
        req.user!.id,
      ]
    );

    const issue = insert.rows[0];

    // Fire-and-forget email alert
    const reporterName = req.user!.email; // name may not be on the JWT — use email for identification
    const frontendBase = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';
    emailService
      .send('platform_issue_reported', {
        to: ALERT_RECIPIENT,
        variables: {
          title: issue.title,
          description: issue.description || '(no description)',
          categoryLabel: categoryLabel(issue.category),
          severityLabel: severityLabel(issue.severity),
          area: issue.area || '—',
          pageUrl: issue.page_url || '—',
          reporterName,
          issueUrl: `${frontendBase}/operations/issues/${issue.id}`,
        },
      })
      .catch(err => console.error('[issues] alert email failed:', err));

    res.status(201).json({ data: issue });
  } catch (err) {
    console.error('Create issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────
// Everyone can edit their OWN issue's description/title/page_url/area.
// Only admin/manager can change status, severity, assigned_to, resolution_notes.

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parse = updateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const existing = await query(`SELECT * FROM platform_issues WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const current = existing.rows[0];
    const isTriage = TRIAGE_ROLES.includes(req.user!.role as (typeof TRIAGE_ROLES)[number]);
    const isOwner = current.created_by === req.user!.id;

    // Triage-only fields
    const triageFields = ['status', 'severity', 'assigned_to', 'resolution_notes'] as const;
    const attemptedTriageFields = triageFields.filter(f => parse.data[f] !== undefined);
    if (attemptedTriageFields.length && !isTriage) {
      res.status(403).json({ error: 'Only admin/manager can change status, severity, assignment, or resolution notes' });
      return;
    }

    // Non-triage fields require ownership (or triage)
    const contentFields = ['title', 'description', 'category', 'area', 'page_url'] as const;
    const attemptedContentFields = contentFields.filter(f => parse.data[f] !== undefined);
    if (attemptedContentFields.length && !isOwner && !isTriage) {
      res.status(403).json({ error: 'You can only edit issues you created' });
      return;
    }

    // Build SET clause
    const setClauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(parse.data)) {
      if (value === undefined) continue;
      params.push(value);
      setClauses.push(`${key} = $${params.length}`);
    }

    // Auto-set resolved_at when flipping to done/wont_fix
    if (parse.data.status) {
      if (['done', 'wont_fix'].includes(parse.data.status) && !current.resolved_at) {
        setClauses.push(`resolved_at = NOW()`);
      } else if (!['done', 'wont_fix'].includes(parse.data.status) && current.resolved_at) {
        setClauses.push(`resolved_at = NULL`);
      }
    }

    if (!setClauses.length) {
      res.json({ data: current });
      return;
    }

    params.push(id);
    const result = await query(
      `UPDATE platform_issues SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Update issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────
// Admin only — keeps the audit trail intact by default. Comments cascade.

router.delete('/:id', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM platform_issues WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Comments ────────────────────────────────────────────────────────────────

router.post('/:id/comments', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parse = commentSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const issueCheck = await query(`SELECT id FROM platform_issues WHERE id = $1`, [id]);
    if (!issueCheck.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const result = await query(
      `
      INSERT INTO platform_issue_comments (issue_id, author_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [id, req.user!.id, parse.data.body]
    );

    // Bump the issue's updated_at
    await query(`UPDATE platform_issues SET updated_at = NOW() WHERE id = $1`, [id]);

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin: seed known issues from the CLAUDE.md roadmap ─────────────────────
// Idempotent: dedupes by exact title match. No email alerts fire.

const SEED_ISSUES: Array<{
  title: string;
  description: string;
  category: string;
  severity: string;
  area: string;
  status?: string;
}> = [
  // ── Security / correctness — urgent ─────────────────────────────────
  {
    title: 'Payment portal API key auth is vulnerable to prefix-only match',
    description: '`authenticateFlexible` only matches the first 8 chars of the key against `key_prefix`. Any string starting with `ppk_live` authenticates. Needs full-key hash comparison.',
    category: 'bug', severity: 'urgent', area: 'money',
  },
  {
    title: 'Stripe pre-auth expiry scheduler missing',
    description: 'OP trusts stored pre_auth status indefinitely, but Stripe auto-voids after ~7 days. Need a daily scanner that flips records older than 4 days to expired and alerts staff to re-take.',
    category: 'bug', severity: 'high', area: 'excess',
  },
  {
    title: 'Refund path does not unwind excess record',
    description: 'payment-event with payment_type=refund records the payment but does not flip excess_status back from pre_auth/taken. Staff must manually mark reimbursed on Money tab.',
    category: 'bug', severity: 'high', area: 'excess',
  },
  {
    title: 'Split-capture of pre-auths produces odd aggregates',
    description: "Portal's capture fires payment_type=excess and on pre_auth records amount_taken is REPLACED not added. Fine in common case, breaks for partial captures.",
    category: 'bug', severity: 'high', area: 'excess',
  },
  {
    title: 'Rolled-over balance does not link previous job',
    description: "Recording payment with method=rolled_over updates the current job's excess but does not mark the previous job as rolled_over. Two-step manual process today.",
    category: 'bug', severity: 'normal', area: 'excess',
  },
  {
    title: "Express 'trust proxy' setting not enabled",
    description: "Backend logs ValidationError about X-Forwarded-For. Everything looks like it's from 127.0.0.1 so rate limits apply globally. Fix: app.set('trust proxy', 1).",
    category: 'bug', severity: 'high', area: 'other',
  },

  // ── Portal / Monday migration ───────────────────────────────────────
  {
    title: 'D&C venue connect-column parser broken on Monday migration',
    description: "--refresh-venues reports 'no Monday venue link' on items that do have a venue link via connect_boards6. JSON extraction not finding linkedPulseIds[0].linkedPulseId.",
    category: 'bug', severity: 'high', area: 'portal',
  },
  {
    title: 'Unassigned-deliveries chaser not yet built',
    description: 'Overdue-completion chaser is live, but the equivalent "unassigned delivery approaching" reminder is still TODO.',
    category: 'feature_request', severity: 'normal', area: 'portal',
  },
  {
    title: 'Remove Monday.com fallback from portal + hire form app',
    description: 'After 1-2 weeks of clean OP operation, drop the Monday.com fallback code paths in the freelancer portal and the standalone hire form app.',
    category: 'roadmap', severity: 'normal', area: 'portal',
    status: 'deferred',
  },
  {
    title: 'Freelancer invoice vs expected cost comparison',
    description: 'Overcharge flagging when a freelancer invoices more than the agreed rate. Nice-to-have, post go-live.',
    category: 'feature_request', severity: 'low', area: 'portal',
  },

  // ── Vehicles / Hire forms / Drivers ─────────────────────────────────
  {
    title: 'Allocations UI should be van-centric not per-driver',
    description: 'One card per hire-form assignment misrepresents the model where N drivers share one van. Needs rebuild so each van slot has one card with drivers nested.',
    category: 'feature_request', severity: 'high', area: 'vehicles',
  },
  {
    title: 'Allocations does not recognise booked-out state',
    description: 'Still offers "Book Out" on assignments already booked_out and they do not appear in the "Due Back" list. Needs rawStatus-aware branching.',
    category: 'bug', severity: 'normal', area: 'vehicles',
  },
  {
    title: 'Dashboard driver pills all render blue',
    description: 'Going Out Today / Coming Back widgets render every driver-name pill blue. Should use deriveDriverStatus (green/amber/blue/red).',
    category: 'bug', severity: 'normal', area: 'dashboard',
  },
  {
    title: 'Nav dropdown hidden under Leaflet map on Fleet Map',
    description: 'z-50 on header not sufficient, Leaflet map still overlays dropdown. Low priority.',
    category: 'bug', severity: 'low', area: 'vehicles',
  },
  {
    title: 'Vehicle swap mid-hire has no formal flow',
    description: 'Changing vehicle_id on an assignment silently replaces the van with no PDF regen, driver email, or audit reason. Phase D3 spec exists — needs building.',
    category: 'feature_request', severity: 'high', area: 'vehicles',
  },
  {
    title: 'Hard book-out gate on vehicle prep status + admin override',
    description: "Current gate only enforces referral + excess as amber warnings. fleet_vehicles.hire_status='Available' observed but not enforced. Add hard block with manager override + reason.",
    category: 'feature_request', severity: 'normal', area: 'vehicles',
  },
  {
    title: 'Hire forms only wired into Job Detail',
    description: 'Needs wiring into BookOutPage, AllocationsPage, CheckInPage, CollectionPage so they share the same data source.',
    category: 'feature_request', severity: 'normal', area: 'hire_forms',
  },
  {
    title: 'Snapshot PDF button missing from Insurance Referral panel',
    description: 'Backend service driver-snapshot-pdf.ts built; just needs UI button on DriverDetailPage to trigger + download/attach.',
    category: 'feature_request', severity: 'normal', area: 'drivers',
  },
  {
    title: 'Mid-tour driver badge missing on Fleet + Job Detail',
    description: "Drivers who submit hire forms mid-tour aren't visually flagged on Fleet on-hire cards or Job Detail Drivers tab.",
    category: 'feature_request', severity: 'normal', area: 'vehicles',
  },
  {
    title: 'VE103B not tested end-to-end via real book-out',
    description: 'Certificate generation built and tested standalone but not exercised through the full book-out flow yet.',
    category: 'question', severity: 'normal', area: 'vehicles',
  },
  {
    title: 'Remove R2 allocation writes (R2 becomes read-only fallback)',
    description: 'Part of Phase D allocations migration. R2 still holds historical allocation data; current writes should stop.',
    category: 'roadmap', severity: 'low', area: 'vehicles',
    status: 'deferred',
  },
  {
    title: 'DVSA MOT History API + DVLA Tax API integration',
    description: 'Auto-populate MOT expiry + tax status from government APIs. MOT API key applied for. DVLA deferred.',
    category: 'feature_request', severity: 'low', area: 'vehicles',
    status: 'deferred',
  },
  {
    title: 'Mileage-based service threshold notifications',
    description: 'Add to daily compliance check — alert when vehicle within configurable miles of next_service_due.',
    category: 'feature_request', severity: 'low', area: 'vehicles',
  },
  {
    title: 'Vehicle book-out / check-in HireHop auto-push',
    description: 'Previously wired via barcodeCheckout to push van reg into HH + flip HH status to 5. Never quite worked reliably — deferred. Staff currently advance HH status manually.',
    category: 'feature_request', severity: 'normal', area: 'vehicles',
    status: 'deferred',
  },
  {
    title: 'Mobile book-out + check-in handoff via QR code',
    description: 'After desktop setup, staff switch to mobile for walkaround. Plan: short-lived magic-link token rendered as QR, mobile redeems to staff JWT + deep-link.',
    category: 'feature_request', severity: 'normal', area: 'vehicles',
    status: 'deferred',
  },

  // ── Money / Excess UI ───────────────────────────────────────────────
  {
    title: 'Excess email tense wrong in some contexts',
    description: '"finishes" vs "finished" depends on whether email fires on payment (future) vs reimbursement (past). Currently inconsistent.',
    category: 'bug', severity: 'low', area: 'excess',
  },
  {
    title: 'Real Ooosh logo in email header',
    description: 'Logo in R2 at assets/ooosh-logo.png, needs public URL wired into base email layout. Currently placeholder.',
    category: 'feature_request', severity: 'low', area: 'other',
  },
  {
    title: 'Global financial dashboard at /money/overview',
    description: 'Deposits pending, balances outstanding, excess held — aggregate view replacing Stream 6 dashboard widget.',
    category: 'feature_request', severity: 'normal', area: 'money',
  },
  {
    title: 'Staff-facing card payments from Money tab (Phase F)',
    description: "Stripe integration in OP so staff can take card payments directly instead of walking to the terminal. PaymentIntent + embedded checkout + webhook + auto-record.",
    category: 'feature_request', severity: 'low', area: 'money',
    status: 'deferred',
  },

  // ── Cancellations ───────────────────────────────────────────────────
  {
    title: 'HH invoice creation on cancellation',
    description: 'Auto-create invoice for retained cancellation fee via billing_deposit_save.php. Currently manual.',
    category: 'feature_request', severity: 'normal', area: 'money',
  },
  {
    title: 'Early return calculator frontend integration (clause 7.3)',
    description: 'Backend built, UI not yet wired up.',
    category: 'feature_request', severity: 'normal', area: 'pipeline',
  },
  {
    title: 'Partial cancellation / scope reduction',
    description: 'Future — reduce scope of a job rather than full cancel. Currently only full-cancel is supported.',
    category: 'roadmap', severity: 'low', area: 'pipeline',
    status: 'deferred',
  },

  // ── Requirements / Prep / Returns ───────────────────────────────────
  {
    title: 'Multi-issue support on damage_review requirements',
    description: 'Currently one damage_review per job. Should support multiple (one per issue) using custom_label, e.g. "Scratched bumper GX17DHN", "Missing XLR cable".',
    category: 'feature_request', severity: 'normal', area: 'requirements',
  },
  {
    title: 'Chase date notifications on post-hire requirements',
    description: 'Daily scheduler should scan due_date on post_hire requirements and fire bell notifications when due.',
    category: 'feature_request', severity: 'normal', area: 'requirements',
  },
  {
    title: 'Build Sub-Hires module (OP-only)',
    description: "HH's PO/shortage method is too clumsy for custom items. Need job_subhires table + lifecycle: need → sourcing → ordered → received → returned.",
    category: 'feature_request', severity: 'normal', area: 'requirements',
    status: 'deferred',
  },
  {
    title: 'Build Incoming Deliveries + Lost Property module',
    description: 'OP-only — client sends stuff / items found post-hire. Tables + UI + disposal reminders for lost property.',
    category: 'feature_request', severity: 'normal', area: 'requirements',
    status: 'deferred',
  },
  {
    title: 'Build Rehearsals module',
    description: 'Detection is HH-derived (cat 450). Management needs: studio sitter assignment, room prep, handover, setup specs, sound files.',
    category: 'feature_request', severity: 'normal', area: 'requirements',
    status: 'deferred',
  },

  // ── Inbox / Notifications ───────────────────────────────────────────
  {
    title: 'Staff working calendar integration with escalation',
    description: 'Escalation currently defaults to 08:00-18:00 Mon-Fri. Tie into real staff schedules when built.',
    category: 'feature_request', severity: 'low', area: 'inbox',
  },
  {
    title: 'Group mentions (@warehouse, @office)',
    description: 'Mention a role/team not just individuals. Needs a concept of team groups + expansion at notification creation time.',
    category: 'feature_request', severity: 'low', area: 'inbox',
  },

  // ── Transport ops ───────────────────────────────────────────────────
  {
    title: 'Arrangement pills → dashboard + prep checklist integration',
    description: 'Surface client_introduction / tolls / accommodation / flights statuses on Dashboard widgets + auto-create as job requirements.',
    category: 'feature_request', severity: 'normal', area: 'transport_ops',
  },
  {
    title: 'Run group pricing (combined run total)',
    description: 'Individual prices crossed through, single run total displayed when quotes are grouped into a run.',
    category: 'feature_request', severity: 'low', area: 'transport_ops',
  },

  // ── Address book / CRM ──────────────────────────────────────────────
  {
    title: 'Saved filters / smart lists on People + Organisations',
    description: 'Save filter combinations as named views (e.g. "London promoters", "Bands without management link").',
    category: 'feature_request', severity: 'low', area: 'address_book',
  },
  {
    title: 'Bulk tagging on address book',
    description: 'Select multiple orgs/people, apply tag in one click. Useful for campaign prep.',
    category: 'feature_request', severity: 'low', area: 'address_book',
  },
  {
    title: 'Export filtered address book to CSV',
    description: 'For mailouts or spreadsheet work.',
    category: 'feature_request', severity: 'low', area: 'address_book',
  },
  {
    title: 'Bulk file import from Monday.com for freelancer docs',
    description: 'DVLA / licence / passport scans on Monday need migrating to R2 + people.files. ~50 freelancers × 2-4 files. Manual/desktop flow documented.',
    category: 'roadmap', severity: 'normal', area: 'address_book',
    status: 'deferred',
  },

  // ── Security / infrastructure ──────────────────────────────────────
  {
    title: 'Field-level encryption for PII (DVLA, passport)',
    description: 'Application-level AES-256-GCM encryption with key in env var. Encrypted fields stored as encrypted_<name>. GDPR alignment.',
    category: 'feature_request', severity: 'high', area: 'other',
  },
  {
    title: 'RBAC on PUT endpoints for people + organisations',
    description: 'Currently any authenticated user can edit. Should restrict to admin/manager for certain fields.',
    category: 'feature_request', severity: 'normal', area: 'auth',
  },
  {
    title: 'Data retention / expiry policy for PII',
    description: 'GDPR compliance — define retention periods + automated purge for stale DVLA/passport records.',
    category: 'feature_request', severity: 'normal', area: 'other',
  },
];

router.post('/admin/seed', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    let inserted = 0;
    let skipped = 0;

    for (const item of SEED_ISSUES) {
      const existing = await query(
        `SELECT id FROM platform_issues WHERE title = $1`,
        [item.title]
      );
      if (existing.rows.length) {
        skipped++;
        continue;
      }

      await query(
        `
        INSERT INTO platform_issues
          (title, description, category, severity, status, area, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          item.title,
          item.description,
          item.category,
          item.severity,
          item.status || 'seen',
          item.area,
          req.user!.id,
        ]
      );
      inserted++;
    }

    res.json({ inserted, skipped, total: SEED_ISSUES.length });
  } catch (err) {
    console.error('Seed issues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
