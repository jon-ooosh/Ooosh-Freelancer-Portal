/**
 * Staff Documents & Training — module API.
 *
 * Staff (STAFF_ROLES): read their own assignments + the reference library, view
 * a document, and complete (tick / sign) an assignment.
 * Admin (MANAGER_ROLES): manage the document library — create, version, target,
 * and read the completion matrix.
 *
 * Signatures + snapshot PDFs live in private R2 under files/staff-documents/…
 * (served via the authenticated /api/files/download allowlist, which already
 * covers the files/ prefix).
 *
 * See docs/STAFF-DOCUMENTS-SPEC.md.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query, getClient } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { logAudit } from '../middleware/audit';
import { isR2Configured, uploadToR2, getFromR2 } from '../config/r2';
import {
  syncDocumentAssignments,
  renderDocumentBody,
} from '../services/staff-documents';
import { generateStaffDocumentPdf } from '../services/staff-document-pdf';
import { emailService } from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';

const router = Router();
router.use(authenticate);

// Bell + immediate email (the approval flow wants both). email_sent_at is
// stamped so the Step-7 escalation scheduler doesn't re-email.
async function emailAndBell(
  userId: string, title: string, content: string, documentId: string,
  actionUrl: string, priority: 'low' | 'normal' | 'high' = 'normal',
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, email_sent_at)
     VALUES ($1, 'follow_up', $2, $3, 'staff_documents', $4, $5, $6, NOW())`,
    [userId, title, content, documentId, actionUrl, priority],
  ).catch((e) => console.error('[staff-documents] bell failed:', e));
  try {
    const u = await query(`SELECT u.email, p.first_name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`, [userId]);
    if (u.rows[0]?.email) {
      await emailService.sendRaw({
        to: u.rows[0].email,
        subject: title,
        html: `<p>Hi ${u.rows[0].first_name || ''},</p><p>${content}</p><p><a href="${getFrontendUrl()}${actionUrl}">Open in Ooosh</a></p>`,
      });
    }
  } catch (e) { console.error('[staff-documents] email failed:', e); }
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function getUserDisplay(userId: string): Promise<{ name: string; last4: string | null; email: string }> {
  const r = await query(
    `SELECT u.email, u.cot_card_last4, p.first_name, p.last_name
       FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0] || {};
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email || '';
  return { name, last4: row.cot_card_last4 || null, email: row.email || '' };
}

function isManager(role?: string): boolean {
  return role === 'admin' || role === 'manager' || role === 'weekend_manager';
}

// ════════════════════════════════════════════════════════════════════════
// STAFF — my documents
// ════════════════════════════════════════════════════════════════════════

// GET /api/staff-documents/mine — the caller's to-do / completed / library
router.get('/mine', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const assignments = await query(
      `SELECT a.id, a.status, a.assigned_at, a.expires_at, a.current_completion_id,
              d.id AS document_id, d.slug, d.title, d.category, d.completion_mode, d.tick_label,
              v.version, c.pdf_r2_key, c.completed_at
         FROM staff_document_assignments a
         JOIN staff_documents d ON d.id = a.document_id
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
         LEFT JOIN staff_document_completions c ON c.id = a.current_completion_id
        WHERE a.user_id = $1 AND d.is_active = true
        ORDER BY (a.status = 'pending') DESC, a.expires_at NULLS LAST, d.title`,
      [userId],
    );
    const todo = assignments.rows.filter((r) => r.status === 'pending' || r.status === 'lapsed');
    const completed = assignments.rows.filter((r) => r.status === 'completed');

    // Reference library: active, read-only, everyone-visible docs.
    const library = await query(
      `SELECT d.id, d.slug, d.title, d.category, v.version
         FROM staff_documents d
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
        WHERE d.is_active = true AND d.approval_status = 'approved'
          AND d.completion_mode = 'read_only' AND d.visibility = 'everyone'
        ORDER BY d.category, d.title`,
    );
    res.json({ data: { todo, completed, library: library.rows } });
  } catch (error) {
    console.error('[staff-documents] mine error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/staff-documents/:id/view — a document + current version, rendered for the caller
router.get('/:id/view', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const docRes = await query(
      `SELECT d.id, d.slug, d.title, d.category, d.completion_mode, d.tick_label, d.visibility,
              d.approval_status, d.created_by,
              v.id AS version_id, v.version, v.body, v.file_r2_key, v.file_name
         FROM staff_documents d
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
        WHERE d.id = $1 AND d.is_active = true`,
      [req.params.id],
    );
    const doc = docRes.rows[0];
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }

    const assignRes = await query(
      `SELECT id, status, expires_at, current_completion_id FROM staff_document_assignments
        WHERE document_id = $1 AND user_id = $2`,
      [doc.id, userId],
    );
    const assignment = assignRes.rows[0] || null;

    // Visibility check.
    const mgr = isManager(req.user!.role);
    const isAuthor = doc.created_by === userId;
    // Unapproved (draft / pending) documents are only visible to their author + managers.
    if (doc.approval_status !== 'approved' && !mgr && !isAuthor) {
      res.status(404).json({ error: 'Document not found' }); return;
    }
    let allowed = doc.visibility === 'everyone' || mgr || isAuthor || !!assignment;
    if (doc.visibility === 'owner_admin') allowed = mgr || isAuthor || !!assignment;
    if (!allowed) { res.status(403).json({ error: 'Not available to you' }); return; }

    const me = await getUserDisplay(userId);
    res.json({
      data: {
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        category: doc.category,
        completion_mode: doc.completion_mode,
        tick_label: doc.tick_label,
        version: doc.version,
        version_id: doc.version_id,
        file_r2_key: doc.file_r2_key,
        file_name: doc.file_name,
        body: renderDocumentBody(doc.body, { name: me.name, last4: me.last4 }),
        assignment,
      },
    });
  } catch (error) {
    console.error('[staff-documents] view error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const completeSchema = z.object({
  agreed: z.literal(true),
  signature: z.string().optional().nullable(), // data URL (png base64) — required for sign mode
});

// POST /api/staff-documents/assignments/:id/complete — tick / sign (own assignment)
router.post('/assignments/:id/complete', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const parse = completeSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { signature } = parse.data;
    const userId = req.user!.id;

    const aRes = await query(
      `SELECT a.id, a.user_id, a.document_id,
              d.completion_mode, d.tick_label, d.title, d.review_interval_months,
              v.id AS version_id, v.version, v.body
         FROM staff_document_assignments a
         JOIN staff_documents d ON d.id = a.document_id
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
        WHERE a.id = $1`,
      [req.params.id],
    );
    const a = aRes.rows[0];
    if (!a) { res.status(404).json({ error: 'Assignment not found' }); return; }
    if (a.user_id !== userId) { res.status(403).json({ error: 'Not your assignment' }); return; }
    if (a.completion_mode === 'read_only') { res.status(400).json({ error: 'This document does not require completion' }); return; }
    if (!a.version_id) { res.status(409).json({ error: 'Document has no current version' }); return; }

    const mode: 'tick' | 'sign' = a.completion_mode;
    if (mode === 'sign' && (!signature || !signature.startsWith('data:image'))) {
      res.status(400).json({ error: 'A signature is required to sign this document' });
      return;
    }

    const me = await getUserDisplay(userId);
    const now = new Date();
    const ts = now.getTime();

    // Signature + snapshot PDF → R2 (best-effort; a missing R2 doesn't block completion).
    let signatureKey: string | null = null;
    let pdfKey: string | null = null;
    let signaturePng: Buffer | null = null;
    if (mode === 'sign' && signature) {
      signaturePng = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (isR2Configured()) {
        try {
          signatureKey = await uploadToR2(
            `files/staff-documents/${userId}/${a.id}/signature-${ts}.png`, signaturePng, 'image/png');
        } catch (e) { console.error('[staff-documents] signature upload failed:', e); }
      }
    }
    if (isR2Configured()) {
      try {
        const pdf = await generateStaffDocumentPdf({
          documentTitle: a.title,
          version: a.version,
          bodyText: renderDocumentBody(a.body, { name: me.name, last4: me.last4 }),
          completedByName: me.name,
          completedAt: now,
          mode,
          tickLabel: a.tick_label,
          signaturePng,
          ip: req.ip || null,
        });
        pdfKey = await uploadToR2(
          `files/staff-documents/${userId}/${a.id}/agreement-${ts}.pdf`, Buffer.from(pdf), 'application/pdf');
      } catch (e) { console.error('[staff-documents] snapshot PDF failed:', e); }
    }

    await client.query('BEGIN');
    const compRes = await client.query(
      `INSERT INTO staff_document_completions
         (assignment_id, version_id, user_id, mode, completed_by_name, completed_at,
          signature_r2_key, pdf_r2_key, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [a.id, a.version_id, userId, mode, me.name, now,
       signatureKey, pdfKey, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)],
    );
    const completionId = compRes.rows[0].id;
    const expiresAt = a.review_interval_months
      ? new Date(now.getFullYear(), now.getMonth() + Number(a.review_interval_months), now.getDate())
      : null;
    await client.query(
      `UPDATE staff_document_assignments
          SET status = 'completed', current_completion_id = $2, expires_at = $3,
              chase_sent_at = NULL, escalated_at = NULL, review_reminder_sent_at = NULL
        WHERE id = $1`,
      [a.id, completionId, expiresAt],
    );
    await client.query('COMMIT');

    await logAudit(userId, 'staff_document_assignments', a.id, 'update',
      null, { document_id: a.document_id, mode }).catch(() => {});

    res.json({ data: { completion_id: completionId, pdf_r2_key: pdfKey, expires_at: expiresAt } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[staff-documents] complete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/staff-documents/completions/:id/pdf — signed snapshot, own only
// (managers may fetch any). Ownership is enforced here — the generic
// /api/files/download is prefix-gated only, so we never hand a staff member a
// raw key to someone else's signed copy.
router.get('/completions/:id/pdf', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT pdf_r2_key, user_id FROM staff_document_completions WHERE id = $1`,
      [req.params.id],
    );
    const c = r.rows[0];
    if (!c || !c.pdf_r2_key) { res.status(404).json({ error: 'Not found' }); return; }
    if (c.user_id !== req.user!.id && !isManager(req.user!.role)) {
      res.status(403).json({ error: 'Not available to you' });
      return;
    }
    const obj = await getFromR2(c.pdf_r2_key);
    const chunks: Buffer[] = [];
    for await (const chunk of obj.Body as NodeJS.ReadableStream) chunks.push(Buffer.from(chunk as Uint8Array));
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.concat(chunks));
  } catch (error) {
    console.error('[staff-documents] completion pdf error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// ADMIN — document library management (MANAGER_ROLES)
// ════════════════════════════════════════════════════════════════════════

// GET /api/staff-documents — list all documents + completion stats
router.get('/', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT d.*, v.version AS current_version,
              COALESCE(s.pending, 0)   AS pending_count,
              COALESCE(s.completed, 0) AS completed_count,
              COALESCE(s.lapsed, 0)    AS lapsed_count
         FROM staff_documents d
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
         LEFT JOIN (
           SELECT document_id,
                  COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'lapsed')    AS lapsed
             FROM staff_document_assignments GROUP BY document_id
         ) s ON s.document_id = d.id
        ORDER BY (d.approval_status = 'pending_approval') DESC, d.is_active DESC, d.category, d.title`,
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[staff-documents] list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const createSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/, 'lowercase-hyphen only'),
  title: z.string().trim().min(1).max(200),
  category: z.enum(['policy', 'agreement', 'training', 'official_doc', 'contract', 'other']).default('policy'),
  completion_mode: z.enum(['read_only', 'tick', 'sign']).default('read_only'),
  tick_label: z.string().trim().max(200).nullable().optional(),
  visibility: z.enum(['everyone', 'assignees', 'owner_admin']).default('assignees'),
  target_type: z.enum(['all_staff', 'role', 'list', 'cot_card_holders']).default('list'),
  target_roles: z.array(z.string()).nullable().optional(),
  target_user_ids: z.array(z.string().uuid()).nullable().optional(),
  chase_interval_days: z.number().int().positive().nullable().optional(),
  escalate_after_days: z.number().int().positive().nullable().optional(),
  review_interval_months: z.number().int().positive().nullable().optional(),
  // initial version content:
  body: z.string().nullable().optional(),
  file_r2_key: z.string().nullable().optional(),
  file_name: z.string().max(200).nullable().optional(),
  save_as_draft: z.boolean().optional(),
});

// POST /api/staff-documents — create a document + its first version.
// Any staff member may create; managers publish immediately (unless they save a
// draft), everyone else lands as a draft to build up and then submit for approval.
router.post('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const d = parse.data;
    if (!d.body && !d.file_r2_key) { res.status(400).json({ error: 'Provide a body or an uploaded file' }); return; }

    const mgr = isManager(req.user!.role);
    const approvalStatus = mgr ? (d.save_as_draft ? 'draft' : 'approved') : 'draft';

    await client.query('BEGIN');
    const docRes = await client.query(
      `INSERT INTO staff_documents
         (slug, title, category, completion_mode, tick_label, visibility, target_type,
          target_roles, target_user_ids, chase_interval_days, escalate_after_days,
          review_interval_months, created_by, approval_status,
          approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [d.slug, d.title, d.category, d.completion_mode, d.tick_label || null, d.visibility,
       d.target_type, d.target_roles || null, d.target_user_ids || null,
       d.chase_interval_days || null, d.escalate_after_days || null, d.review_interval_months || null,
       req.user!.id, approvalStatus,
       approvalStatus === 'approved' ? req.user!.id : null,
       approvalStatus === 'approved' ? new Date() : null],
    );
    const doc = docRes.rows[0];
    await client.query(
      `INSERT INTO staff_document_versions (document_id, version, body, file_r2_key, file_name, change_note, is_current, created_by)
       VALUES ($1, 1, $2, $3, $4, 'Initial version', true, $5)`,
      [doc.id, d.body || null, d.file_r2_key || null, d.file_name || null, req.user!.id],
    );
    await client.query('COMMIT');

    await logAudit(req.user!.id, 'staff_documents', doc.id, 'create', null, { slug: doc.slug }).catch(() => {});
    // Materialise assignments (idempotent; no-op for read-only).
    await syncDocumentAssignments(doc.id).catch((e) => console.error('[staff-documents] initial sync failed:', e));
    res.status(201).json({ data: doc });
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A document with that slug already exists' });
      return;
    }
    console.error('[staff-documents] create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.enum(['policy', 'agreement', 'training', 'official_doc', 'contract', 'other']).optional(),
  completion_mode: z.enum(['read_only', 'tick', 'sign']).optional(),
  tick_label: z.string().trim().max(200).nullable().optional(),
  visibility: z.enum(['everyone', 'assignees', 'owner_admin']).optional(),
  target_type: z.enum(['all_staff', 'role', 'list', 'cot_card_holders']).optional(),
  target_roles: z.array(z.string()).nullable().optional(),
  target_user_ids: z.array(z.string().uuid()).nullable().optional(),
  chase_interval_days: z.number().int().positive().nullable().optional(),
  escalate_after_days: z.number().int().positive().nullable().optional(),
  review_interval_months: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
});

// PATCH /api/staff-documents/:id — update config. Managers: any document.
// Non-managers: only their own draft/pending document.
router.patch('/:id', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = patchSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const fields = parse.data;

    const cur = await query(`SELECT created_by, approval_status FROM staff_documents WHERE id = $1`, [req.params.id]);
    if (!cur.rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    if (!isManager(req.user!.role)) {
      if (cur.rows[0].created_by !== req.user!.id) { res.status(403).json({ error: 'Not your document' }); return; }
      if (cur.rows[0].approval_status === 'approved') {
        res.status(403).json({ error: 'Approved documents can only be edited by a manager' }); return;
      }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      vals.push(v === undefined ? null : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const r = await query(
      `UPDATE staff_documents SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    await logAudit(req.user!.id, 'staff_documents', String(req.params.id), 'update', null, fields).catch(() => {});
    // Targeting / mode may have changed — re-materialise (idempotent, additive).
    await syncDocumentAssignments(String(req.params.id)).catch((e) => console.error('[staff-documents] patch sync failed:', e));
    res.json({ data: r.rows[0] });
  } catch (error) {
    console.error('[staff-documents] patch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const versionSchema = z.object({
  body: z.string().nullable().optional(),
  file_r2_key: z.string().nullable().optional(),
  file_name: z.string().max(200).nullable().optional(),
  change_note: z.string().max(1000).nullable().optional(),
});

// POST /api/staff-documents/:id/versions — publish a new version (supersedes).
// Managers: any. Non-managers: only their own draft/pending document.
router.post('/:id/versions', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const parse = versionSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const v = parse.data;
    if (!v.body && !v.file_r2_key) { res.status(400).json({ error: 'Provide a body or an uploaded file' }); return; }

    const docRes = await query(`SELECT id, completion_mode, created_by, approval_status FROM staff_documents WHERE id = $1`, [req.params.id]);
    if (!docRes.rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    if (!isManager(req.user!.role)) {
      if (docRes.rows[0].created_by !== req.user!.id) { res.status(403).json({ error: 'Not your document' }); return; }
      if (docRes.rows[0].approval_status === 'approved') {
        res.status(403).json({ error: 'Approved documents can only be versioned by a manager' }); return;
      }
    }

    await client.query('BEGIN');
    const nextRes = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM staff_document_versions WHERE document_id = $1`,
      [req.params.id],
    );
    const nextVersion = nextRes.rows[0].next;
    await client.query(`UPDATE staff_document_versions SET is_current = false WHERE document_id = $1`, [req.params.id]);
    const insRes = await client.query(
      `INSERT INTO staff_document_versions (document_id, version, body, file_r2_key, file_name, change_note, is_current, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *`,
      [req.params.id, nextVersion, v.body || null, v.file_r2_key || null, v.file_name || null, v.change_note || null, req.user!.id],
    );
    // Re-flag completed assignments back to pending — the document changed.
    const reflag = await client.query(
      `UPDATE staff_document_assignments
          SET status = 'pending', expires_at = NULL, current_completion_id = NULL,
              chase_sent_at = NULL, escalated_at = NULL, review_reminder_sent_at = NULL
        WHERE document_id = $1 AND status = 'completed'
        RETURNING user_id`,
      [req.params.id],
    );
    await client.query('COMMIT');

    // Notify re-flagged users (best-effort).
    for (const row of reflag.rows) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
         VALUES ($1, 'follow_up', $2, $3, 'staff_documents', $4, '/staff/documents', 'normal')`,
        [row.user_id, 'A document was updated — please review again',
         'A document you previously completed has a new version. Please review it again in your Staff Documents.',
         req.params.id],
      ).catch(() => {});
    }
    await logAudit(req.user!.id, 'staff_documents', String(req.params.id), 'update', null, { version: nextVersion }).catch(() => {});
    res.status(201).json({ data: insRes.rows[0], reflagged: reflag.rows.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[staff-documents] version error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/staff-documents/:id/sync — manually re-materialise assignments
router.post('/:id/sync', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const created = await syncDocumentAssignments(String(req.params.id));
    res.json({ data: { created } });
  } catch (error) {
    console.error('[staff-documents] sync error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/staff-documents/:id/matrix — who's completed / pending / lapsed
router.get('/:id/matrix', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT a.id, a.status, a.assigned_at, a.expires_at, a.chase_sent_at, a.escalated_at,
              a.current_completion_id AS completion_id,
              u.id AS user_id, u.email, p.first_name, p.last_name,
              c.completed_at, c.pdf_r2_key, c.mode
         FROM staff_document_assignments a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN people p ON p.id = u.person_id
         LEFT JOIN staff_document_completions c ON c.id = a.current_completion_id
        WHERE a.document_id = $1
        ORDER BY (a.status = 'pending') DESC, p.first_name, p.last_name`,
      [req.params.id],
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[staff-documents] matrix error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// AUTHORING WORKFLOW — draft → submit → approve/reject (two-stage)
// ════════════════════════════════════════════════════════════════════════

// GET /api/staff-documents/authored — documents the caller created (any status),
// with completion stats. Powers the "My proposals" list in My Documents.
router.get('/authored', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT d.*, v.version AS current_version,
              COALESCE(s.pending, 0) AS pending_count, COALESCE(s.completed, 0) AS completed_count, COALESCE(s.lapsed, 0) AS lapsed_count
         FROM staff_documents d
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
         LEFT JOIN (
           SELECT document_id,
                  COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'lapsed')    AS lapsed
             FROM staff_document_assignments GROUP BY document_id
         ) s ON s.document_id = d.id
        WHERE d.created_by = $1
        ORDER BY d.created_at DESC`,
      [req.user!.id],
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[staff-documents] authored error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/staff-documents/:id/raw — current version's RAW content (placeholders
// intact) for editing / new-version pre-fill. Author or manager only.
router.get('/:id/raw', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT d.created_by, v.version, v.body, v.file_r2_key, v.file_name
         FROM staff_documents d
         LEFT JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
        WHERE d.id = $1`,
      [req.params.id],
    );
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (!isManager(req.user!.role) && row.created_by !== req.user!.id) {
      res.status(403).json({ error: 'Not available to you' }); return;
    }
    res.json({ data: { version: row.version, body: row.body, file_r2_key: row.file_r2_key, file_name: row.file_name } });
  } catch (error) {
    console.error('[staff-documents] raw error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/staff-documents/:id/submit — draft → pending_approval; notify managers.
router.post('/:id/submit', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT id, title, created_by, approval_status FROM staff_documents WHERE id = $1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    if (!isManager(req.user!.role) && doc.created_by !== req.user!.id) { res.status(403).json({ error: 'Not your document' }); return; }
    if (doc.approval_status !== 'draft') { res.status(409).json({ error: 'Only a draft can be submitted for approval' }); return; }

    await query(`UPDATE staff_documents SET approval_status = 'pending_approval', submitted_at = NOW(), updated_at = NOW() WHERE id = $1`, [doc.id]);
    const creator = await getUserDisplay(doc.created_by);
    const mgrs = await query(`SELECT id FROM users WHERE is_active = true AND role IN ('admin', 'manager', 'weekend_manager')`);
    for (const m of mgrs.rows) {
      if (m.id === req.user!.id) continue;
      await emailAndBell(m.id, `Document awaiting approval: ${doc.title}`,
        `${creator.name || 'A staff member'} has proposed the staff document “${doc.title}” — it needs your approval before it goes out.`,
        doc.id, '/staff/documents/admin', 'high');
    }
    await logAudit(req.user!.id, 'staff_documents', doc.id, 'update', null, { submitted: true }).catch(() => {});
    res.json({ data: { approval_status: 'pending_approval' } });
  } catch (error) {
    console.error('[staff-documents] submit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/staff-documents/:id/approve — MANAGER: → approved, materialise, notify creator.
router.post('/:id/approve', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT id, title, created_by, approval_status FROM staff_documents WHERE id = $1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    if (doc.approval_status === 'approved') { res.status(409).json({ error: 'Already approved' }); return; }

    await query(`UPDATE staff_documents SET approval_status = 'approved', approved_by = $2, approved_at = NOW(), review_notes = NULL, updated_at = NOW() WHERE id = $1`, [doc.id, req.user!.id]);
    await syncDocumentAssignments(doc.id).catch((e) => console.error('[staff-documents] approve sync failed:', e));
    if (doc.created_by && doc.created_by !== req.user!.id) {
      await emailAndBell(doc.created_by, `Approved: ${doc.title}`,
        `Your staff document “${doc.title}” has been approved and is now live.`, doc.id, '/staff/documents');
    }
    await logAudit(req.user!.id, 'staff_documents', doc.id, 'update', null, { approved: true }).catch(() => {});
    res.json({ data: { approval_status: 'approved' } });
  } catch (error) {
    console.error('[staff-documents] approve error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const rejectSchema = z.object({ reason: z.string().trim().max(1000).optional() });

// POST /api/staff-documents/:id/reject — MANAGER: → draft, notify creator with reason.
router.post('/:id/reject', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const reason = rejectSchema.safeParse(req.body).data?.reason || '';
    const r = await query(`SELECT id, title, created_by FROM staff_documents WHERE id = $1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }

    await query(`UPDATE staff_documents SET approval_status = 'draft', review_notes = $2, submitted_at = NULL, updated_at = NOW() WHERE id = $1`, [doc.id, reason || null]);
    if (doc.created_by && doc.created_by !== req.user!.id) {
      await emailAndBell(doc.created_by, `Changes requested: ${doc.title}`,
        `Your staff document “${doc.title}” needs changes before it can go out.${reason ? ' Note: ' + reason : ''}`,
        doc.id, '/staff/documents');
    }
    await logAudit(req.user!.id, 'staff_documents', doc.id, 'update', null, { rejected: true }).catch(() => {});
    res.json({ data: { approval_status: 'draft' } });
  } catch (error) {
    console.error('[staff-documents] reject error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
