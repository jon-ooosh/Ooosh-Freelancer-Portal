/**
 * Freelancer Onboarding — invite (Phase A) + apply (Phase B).
 *
 * Staff invite a freelancer (existing address-book person OR a brand-new
 * name+email shell), which mints a tokenised application and emails the intro
 * + form link. The freelancer then reaches the PUBLIC apply form via that
 * token, fills it out, and the submission ENRICHES the same person + fires an
 * "all good?" alert to info@.
 *
 * Public apply endpoints (GET /apply/:token, POST /apply/:token/upload,
 * POST /apply/:token/submit) sit BEFORE the JWT auth gate, rate-limited —
 * the token IS the gate (mirrors the carnet client form). Token validity is
 * status-bound: usable while 'invited' / 'more_info', rejected once
 * 'applied' / 'approved' / 'declined'.
 *
 * See docs/FREELANCER-ONBOARDING-SPEC.md.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { logAudit } from '../middleware/audit';
import { getFrontendUrl } from '../config/app-urls';
import { emailService } from '../services/email-service';
import { uploadToR2 } from '../config/r2';

const router = Router();

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Statuses where the tokenised form link is still live.
const LIVE_TOKEN_STATUSES = ['invited', 'more_info'];

// Which T&Cs / GDPR text the freelancer agreed to (bump when the text changes).
const TCS_VERSION = 'v1-2026-07';

// Consent text shown on the apply form (GDPR + working T&Cs, incl. payment terms).
const FREELANCER_TERMS = `Ooosh Tours Ltd — Freelancer Data & Working Terms

1. Who we are. Ooosh Tours Ltd ("Ooosh", "we") is the data controller for the
information you provide on this form. We collect it to assess you as a potential
freelance crew member (driving, backline, sound, lighting, tour management,
studio sitting, warehouse and related work) and, if we work together, to arrange
and pay for that work.

2. What we collect and why. Your contact details, date of birth and home
address (to identify you and, where relevant, add you to our vehicle insurance);
your driving licence details and DVLA record (to confirm you're legally able to
drive our vehicles); your emergency contact; your skills and references; and any
documents you upload (licence, DVLA summary, passport, public liability
insurance, CV). We only use this to vet, insure, assign and pay you.

3. How long we keep it. For as long as you remain an active freelancer with us,
and for a reasonable period afterwards to meet our legal, insurance and
accounting obligations. You can ask us to review or remove your data at any time
by emailing info@oooshtours.co.uk.

4. Sharing. We share what's necessary with our motor insurer (to add you to
cover), and we do not sell your data or use it for marketing.

5. Payment terms. Freelance work is offered on an ad-hoc basis — being on our
books does not guarantee work. Rates are agreed per job before you start. You
invoice us for work completed; we pay to the schedule set out at the time of
booking. You are responsible for your own tax and National Insurance (you
confirm you are eligible to work in the UK and, where you've given one, your UTR
is correct).

6. Your responsibilities. You'll keep your details, licence and documents
up to date, tell us promptly of any change that affects your ability to drive or
work (points, medical conditions, expired documents), and follow our on-the-day
instructions and health & safety requirements.

7. Your rights. You have the right to access, correct or erase your data, and to
object to or restrict its processing. Contact info@oooshtours.co.uk. You can also
complain to the ICO (ico.org.uk).

By signing below you confirm the information you've given is true and complete to
the best of your knowledge, you've read and agree to the above, and you consent
to us processing your data for the purposes described.`;

function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function formUrlFor(token: string): string {
  return `${getFrontendUrl()}/freelancer-apply/${token}`;
}

function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  // Accept YYYY-MM-DD from a date picker; reject anything else.
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC — apply form (token, no JWT). MUST be before the auth gate.
// ════════════════════════════════════════════════════════════════════════

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per document
});

// Resolve a token → live application + linked person, or a reason it's closed.
async function loadTokenApplication(token: string): Promise<
  | { ok: true; app: Record<string, unknown>; person: Record<string, unknown> }
  | { ok: false; code: number; message: string }
> {
  const result = await query(
    `SELECT fa.id AS app_id, fa.status, fa.form_token, fa.submitted_at,
            p.id AS person_id, p.first_name, p.last_name, p.preferred_name, p.email,
            p.phone, p.mobile, p.date_of_birth, p.home_address,
            p.emergency_contact_name, p.emergency_contact_phone, p.skills,
            p.licence_number, p.licence_issued_by, p.licence_expiry, p.licence_passed_date,
            p.passport_expiry, p.day_rate_note
       FROM freelancer_applications fa
       JOIN people p ON p.id = fa.person_id
      WHERE fa.form_token = $1`,
    [token]
  );
  if (result.rows.length === 0) {
    return { ok: false, code: 404, message: 'This link is not valid.' };
  }
  const row = result.rows[0];
  if (!LIVE_TOKEN_STATUSES.includes(row.status)) {
    return { ok: false, code: 410, message: 'This application form is no longer open.' };
  }
  return { ok: true, app: row, person: row };
}

// GET /api/freelancers/apply/:token — form context + validity + any pre-fill.
router.get('/apply/:token', publicLimiter, async (req: Request, res: Response) => {
  try {
    const loaded = await loadTokenApplication(String(req.params.token));
    if (!loaded.ok) {
      res.status(loaded.code).json({ error: loaded.message });
      return;
    }
    const p = loaded.person;
    res.json({
      data: {
        valid: true,
        terms: FREELANCER_TERMS,
        tcs_version: TCS_VERSION,
        prefill: {
          first_name: p.first_name || '',
          last_name: p.last_name || '',
          preferred_name: p.preferred_name || '',
          email: p.email || '',
          phone: p.phone || '',
          mobile: p.mobile || '',
          date_of_birth: p.date_of_birth ? new Date(p.date_of_birth as string).toISOString().slice(0, 10) : '',
          home_address: p.home_address || '',
          emergency_contact_name: p.emergency_contact_name || '',
          emergency_contact_phone: p.emergency_contact_phone || '',
          skills: Array.isArray(p.skills) ? p.skills : [],
          licence_number: p.licence_number || '',
          licence_issued_by: p.licence_issued_by || '',
          licence_expiry: p.licence_expiry ? new Date(p.licence_expiry as string).toISOString().slice(0, 10) : '',
          licence_passed_date: p.licence_passed_date ? new Date(p.licence_passed_date as string).toISOString().slice(0, 10) : '',
          passport_expiry: p.passport_expiry ? new Date(p.passport_expiry as string).toISOString().slice(0, 10) : '',
          day_rate_note: p.day_rate_note || '',
        },
      },
    });
  } catch (error) {
    console.error('[freelancers] apply context error:', error);
    res.status(500).json({ error: 'Could not load the form.' });
  }
});

// POST /api/freelancers/apply/:token/upload — one document at a time (multipart).
// Returns an R2 ref the frontend collects and includes in the final submit.
router.post('/apply/:token/upload', publicLimiter, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const loaded = await loadTokenApplication(String(req.params.token));
    if (!loaded.ok) {
      res.status(loaded.code).json({ error: loaded.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file received.' });
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
    if (!allowed.includes(req.file.mimetype)) {
      res.status(400).json({ error: 'Please upload an image or PDF.' });
      return;
    }
    const label = textOrNull(req.body?.label) || 'Document';
    const labelSlug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'doc';
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
    const personId = loaded.person.person_id as string;
    const key = `files/freelancers/${personId}/${labelSlug}-${crypto.randomUUID()}.${ext}`;
    await uploadToR2(key, req.file.buffer, req.file.mimetype);
    res.json({
      data: {
        r2_key: key,
        label,
        filename: req.file.originalname,
        content_type: req.file.mimetype,
        size_bytes: req.file.size,
      },
    });
  } catch (error) {
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 15 MB).' : 'Upload failed.' });
      return;
    }
    console.error('[freelancers] apply upload error:', error);
    res.status(500).json({ error: 'Could not upload the file.' });
  }
});

// POST /api/freelancers/apply/:token/submit — enrich the person, fire the alert.
router.post('/apply/:token/submit', publicLimiter, async (req: Request, res: Response) => {
  try {
    const loaded = await loadTokenApplication(String(req.params.token));
    if (!loaded.ok) {
      res.status(loaded.code).json({ error: loaded.message });
      return;
    }
    const app = loaded.app;
    const personId = app.person_id as string;
    const appId = app.app_id as string;
    const b = req.body || {};

    // ── Validate the essentials ─────────────────────────────────────────
    const firstName = textOrNull(b.first_name);
    const lastName = textOrNull(b.last_name);
    if (!firstName || !lastName) {
      res.status(400).json({ error: 'Please enter your first and last name.' });
      return;
    }
    const email = textOrNull(b.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (!b.accepted) {
      res.status(400).json({ error: 'Please read and accept the terms.' });
      return;
    }
    if (!b.signature || !String(b.signature).startsWith('data:image')) {
      res.status(400).json({ error: 'Please sign in the box.' });
      return;
    }

    const skills: string[] = Array.isArray(b.skills)
      ? b.skills.filter((s: unknown) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
      : [];
    const isDriving = skills.some((s) => /driv/i.test(s));

    const documents: { r2_key: string; label: string; filename: string; content_type?: string }[] =
      Array.isArray(b.documents)
        ? b.documents
            .filter((d: { r2_key?: string }) => d && typeof d.r2_key === 'string' && d.r2_key.startsWith('files/freelancers/'))
            .map((d: { r2_key: string; label?: string; filename?: string; content_type?: string }) => ({
              r2_key: d.r2_key,
              label: textOrNull(d.label) || 'Document',
              filename: textOrNull(d.filename) || 'document',
              content_type: d.content_type,
            }))
        : [];
    const hasDvlaDoc = documents.some((d) => /dvla/i.test(d.label));
    const hasPliDoc = documents.some((d) => /\bpli\b|public liab/i.test(d.label));

    // ── Signature → R2 ──────────────────────────────────────────────────
    let signatureKey: string | null = null;
    try {
      const buf = Buffer.from(String(b.signature).split(',')[1] || '', 'base64');
      signatureKey = `files/freelancers/${personId}/signature-${Date.now()}.png`;
      await uploadToR2(signatureKey, buf, 'image/png');
    } catch (e) {
      console.error('[freelancers] signature upload failed:', e);
      signatureKey = null;
    }

    // ── Structured payloads for the application record ──────────────────
    const insuranceAnswers = (b.insurance_answers && typeof b.insurance_answers === 'object') ? b.insurance_answers : {};
    const references = Array.isArray(b.references)
      ? b.references.filter((r: { name?: string }) => r && (r.name || (r as { company?: string }).company))
      : [];
    // Everything the freelancer answered, kept verbatim for audit / re-render.
    const submission = {
      preferred_name: textOrNull(b.preferred_name),
      looking_for: b.looking_for ?? null,               // tour / local / uk / uk_eu
      utr: textOrNull(b.utr),
      eligible_to_work: b.eligible_to_work === true,
      passport_valid_18mo: b.passport_valid_18mo ?? null,
      driving: isDriving
        ? {
            confidence: b.driving_confidence ?? null,   // 3.5t/7m, pax/equip/both
            licence_address: textOrNull(b.licence_address),
          }
        : null,
      anything_else: textOrNull(b.anything_else),
      expected_day_rate: textOrNull(b.expected_day_rate),
    };
    const dayRateNote = [textOrNull(b.expected_day_rate), textOrNull(b.anything_else)]
      .filter(Boolean)
      .join(' — ') || null;

    // ── Files: append the uploaded documents to people.files ────────────
    const nowIso = new Date().toISOString();
    const fileEntries = documents.map((d) => ({
      name: d.filename,
      url: d.r2_key,
      type: d.content_type === 'application/pdf' ? 'document' : 'image',
      label: d.label,
      tag: d.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      uploaded_at: nowIso,
      uploaded_by: 'freelancer-application',
    }));

    // ── Enrich the person (COALESCE so empties never wipe existing data) ─
    await query(
      `UPDATE people SET
         first_name              = COALESCE($2, first_name),
         last_name               = COALESCE($3, last_name),
         preferred_name          = COALESCE($4, preferred_name),
         email                   = COALESCE($5, email),
         phone                   = COALESCE($6, phone),
         mobile                  = COALESCE($7, mobile),
         date_of_birth           = COALESCE($8::date, date_of_birth),
         home_address            = COALESCE($9, home_address),
         emergency_contact_name  = COALESCE($10, emergency_contact_name),
         emergency_contact_phone = COALESCE($11, emergency_contact_phone),
         skills                  = CASE WHEN array_length($12::text[], 1) IS NULL THEN skills ELSE $12::text[] END,
         licence_number          = COALESCE($13, licence_number),
         licence_issued_by       = COALESCE($14, licence_issued_by),
         licence_expiry          = COALESCE($15::date, licence_expiry),
         licence_passed_date     = COALESCE($16::date, licence_passed_date),
         dvla_check_date         = COALESCE($17::date, dvla_check_date),
         passport_expiry         = COALESCE($18::date, passport_expiry),
         pli_expiry              = COALESCE($19::date, pli_expiry),
         day_rate_note           = COALESCE($20, day_rate_note),
         files                   = COALESCE(files, '[]'::jsonb) || $21::jsonb,
         freelancer_status       = 'applied',
         is_freelancer           = true,
         updated_at              = NOW()
       WHERE id = $1`,
      [
        personId,
        firstName,
        lastName,
        textOrNull(b.preferred_name),
        email ? email.toLowerCase() : null,
        textOrNull(b.phone),
        textOrNull(b.mobile),
        isoDateOrNull(b.date_of_birth),
        textOrNull(b.home_address),
        textOrNull(b.emergency_contact_name),
        textOrNull(b.emergency_contact_phone),
        skills,
        isDriving ? textOrNull(b.licence_number) : null,
        isDriving ? textOrNull(b.licence_issued_by) : null,
        isDriving ? isoDateOrNull(b.licence_expiry) : null,
        isDriving ? isoDateOrNull(b.licence_passed_date) : null,
        hasDvlaDoc ? nowIso.slice(0, 10) : null,
        isoDateOrNull(b.passport_expiry),
        hasPliDoc ? isoDateOrNull(b.pli_expiry) : null,
        dayRateNote,
        JSON.stringify(fileEntries),
      ]
    );

    // ── Store the application record + flip to 'applied' ────────────────
    await query(
      `UPDATE freelancer_applications SET
         status            = 'applied',
         submitted_at      = NOW(),
         submission        = $2,
         insurance_answers = $3,
         "references"      = $4,
         signature_r2_key  = COALESCE($5, signature_r2_key),
         tcs_version       = $6,
         updated_at        = NOW()
       WHERE id = $1`,
      [
        appId,
        JSON.stringify(submission),
        JSON.stringify(insuranceAnswers),
        JSON.stringify(references),
        signatureKey,
        TCS_VERSION,
      ]
    );

    // ── Timeline note on the person ─────────────────────────────────────
    const displayName = `${firstName} ${lastName}`;
    await query(
      `INSERT INTO interactions (person_id, type, content, created_by, source)
       VALUES ($1, 'note', $2, $3, 'system')`,
      [personId, `📝 Freelancer application submitted by ${displayName}.`, SYSTEM_USER_ID]
    ).catch((e) => console.error('[freelancers] timeline note failed:', e));

    // ── Fire the "this person wants to work for us — all good?" alert ────
    emailService
      .send('freelancer_application_received', {
        to: 'info@oooshtours.co.uk',
        variables: {
          name: displayName,
          skills: skills.length ? skills.join(', ') : '—',
          reviewUrl: `${getFrontendUrl()}/people/${personId}`,
        },
      })
      .catch((e) => console.error('[freelancers] application-received alert failed:', e));

    res.json({ data: { ok: true } });
  } catch (error) {
    console.error('[freelancers] apply submit error:', error);
    res.status(500).json({ error: 'Could not submit the form. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// STAFF — everything below requires a JWT. Anyone on the team can invite.
// ════════════════════════════════════════════════════════════════════════
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

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
    if (!LIVE_TOKEN_STATUSES.includes(app.status)) {
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
