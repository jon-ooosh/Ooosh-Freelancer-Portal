/**
 * Website enquiry intake — POST /api/enquiry-intake
 *
 * Server-to-server endpoint the Ooosh website enquiry form's Cloudflare Worker
 * POSTs to (after Turnstile verification). Turns a website enquiry into a
 * fully-linked OP pipeline enquiry:
 *   1. Search the address book for the enquirer by email (exact).
 *   2. Search for the org by the form's "company" (exact normalised name).
 *   3. Create person / org as needed; link them via person_organisation_roles.
 *   4. Create the OP-native enquiry (via the shared createPipelineEnquiry helper,
 *      attributed to SYSTEM_USER_ID) with the enquirer as the primary job contact.
 *
 * Creates an OP enquiry ONLY — it never pushes to HireHop (that's a separate,
 * explicit staff action). The Worker keeps sending its Resend notification email
 * regardless; the endpoint returns { id, url } so the Worker can drop a
 * deep-link into that email straight to the new OP record.
 *
 * Auth: API key (X-API-Key, or Authorization: Bearer <key>), service='enquiry_form'.
 * NOT staff-JWT — so it lives in its own router, outside the pipeline router's
 * global authenticate + authorize(...STAFF_ROLES) gate.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../config/database';
import { verifyApiKey } from '../middleware/api-key';
import { getFrontendUrl } from '../config/app-urls';
import { createPipelineEnquiry, EnquiryValidationError } from '../services/pipeline-enquiry';

const router = Router();

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Website forms attract bots + double-submits. Turnstile at the Worker is the
// real spam gate; this is a cheap belt-and-braces per-IP cap.
const intakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── API key auth (service-scoped) ───────────────────────────────────────────
async function authenticateEnquiryIntake(req: Request, res: Response, next: () => void): Promise<void> {
  const headerKey = req.header('X-API-Key');
  const authHeader = req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const apiKey = headerKey || bearer;

  if (!apiKey) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  const row = await verifyApiKey(apiKey);
  if (!row) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  if (row.service !== 'enquiry_form') {
    res.status(403).json({ error: 'API key not authorised for enquiry intake' });
    return;
  }
  next();
}

// ── Payload from the Worker (gatherFormData shape) ──────────────────────────
const addressSchema = z.object({
  line1: z.string().optional().nullable(),
  line2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  postcode: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
}).partial();

const intakeSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional().nullable(),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  phone_code: z.string().optional().nullable(),
  phone_number: z.string().optional().nullable(),
  enquiry: z.string().optional().nullable(),
  enquiry_types: z.array(z.string()).optional().nullable(),
  van_styles: z.array(z.string()).optional().nullable(),
  gearbox: z.array(z.string()).optional().nullable(),
  travelling_to: z.string().optional().nullable(),
  seating: z.string().optional().nullable(),
  backline_travelling_to: z.string().optional().nullable(),
  rehearsal_rooms: z.array(z.string()).optional().nullable(),
  rehearsal_equipment: z.array(z.string()).optional().nullable(),
  delivery_address: addressSchema.optional().nullable(),
  collection_address: addressSchema.optional().nullable(),
  same_as_delivery: z.boolean().optional().nullable(),
  start_date: z.string().optional().nullable(),
  start_time: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  end_time: z.string().optional().nullable(),
  mailing_list: z.boolean().optional().nullable(),
  file_names: z.array(z.string()).optional().nullable(),
  files: z.array(z.any()).optional().nullable(),
}).passthrough();

type IntakePayload = z.infer<typeof intakeSchema>;

// Website enquiry-type label → OP service_type (only the three that map to
// requirement chains; delivery/collection/other are captured in notes).
const SERVICE_TYPE_MAP: Record<string, 'self_drive_van' | 'backline' | 'rehearsal'> = {
  'van hire': 'self_drive_van',
  'backline hire': 'backline',
  'rehearsals': 'rehearsal',
};

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] || full.trim(), last: parts.slice(1).join(' ') };
}

function formatAddress(a?: z.infer<typeof addressSchema> | null): string | null {
  if (!a) return null;
  const bits = [a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean);
  return bits.length ? bits.join(', ') : null;
}

// Pack the rich form detail that has no first-class OP home into a readable
// internal-notes block so nothing the client told us is lost.
function buildNotesBlock(p: IntakePayload): string {
  const lines: string[] = ['— Website enquiry —'];
  if (p.enquiry_types?.length) lines.push(`Enquiring about: ${p.enquiry_types.join(', ')}`);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  else if (p.phone_number) lines.push(`Phone: ${[p.phone_code, p.phone_number].filter(Boolean).join(' ')}`);
  if (p.van_styles?.length) lines.push(`Van style(s): ${p.van_styles.join(', ')}`);
  if (p.gearbox?.length) lines.push(`Gearbox: ${p.gearbox.join(', ')}`);
  if (p.travelling_to) lines.push(`Van travelling to: ${p.travelling_to}`);
  if (p.seating) lines.push(`Seating: ${p.seating}`);
  if (p.backline_travelling_to) lines.push(`Backline travelling to: ${p.backline_travelling_to}`);
  if (p.rehearsal_rooms?.length) lines.push(`Rehearsal room(s): ${p.rehearsal_rooms.join(', ')}`);
  if (p.rehearsal_equipment?.length) lines.push(`Rehearsal equipment: ${p.rehearsal_equipment.join(', ')}`);
  const del = formatAddress(p.delivery_address);
  if (del) lines.push(`Delivery address: ${del}`);
  const col = formatAddress(p.collection_address);
  if (col) lines.push(`Collection address: ${p.same_as_delivery ? '(same as delivery)' : col}`);
  if (p.file_names?.length) lines.push(`Attached files (in the notification email): ${p.file_names.join(', ')}`);
  if (p.mailing_list) lines.push('Opted in to mailing list.');
  return lines.join('\n');
}

router.post('/', intakeLimiter, authenticateEnquiryIntake, async (req: Request, res: Response) => {
  let payload: IntakePayload;
  try {
    payload = intakeSchema.parse(req.body);
  } catch (err) {
    res.status(422).json({ error: 'Validation failed', details: err instanceof z.ZodError ? err.errors : undefined });
    return;
  }

  try {
    const email = payload.email.trim().toLowerCase();
    const companyName = payload.company?.trim() || null;
    const { first, last } = splitName(payload.name);
    const phone = payload.phone?.trim() || [payload.phone_code, payload.phone_number].filter(Boolean).join(' ').trim() || null;

    // ── 1. Resolve / create person (exact email) ───────────────────────────
    let personId: string;
    let personOutcome: 'existing' | 'created';
    const personLookup = await query(
      `SELECT id FROM people
       WHERE LOWER(email) = $1 AND is_deleted = false
       ORDER BY updated_at DESC LIMIT 1`,
      [email]
    );
    if (personLookup.rows.length > 0) {
      personId = personLookup.rows[0].id;
      personOutcome = 'existing';
    } else {
      const created = await query(
        `INSERT INTO people (first_name, last_name, email, phone, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [first, last, email, phone, 'Created from website enquiry form.', SYSTEM_USER_ID]
      );
      personId = created.rows[0].id;
      personOutcome = 'created';
    }

    // ── 2. Resolve / create org ────────────────────────────────────────────
    // Exact normalised-name match → link. No match → create a new 'client' org.
    // Multiple exact matches → leave unlinked (don't guess), client_name kept.
    // No company given → fall back to the person's name (sole-trader shape).
    const orgName = companyName || payload.name.trim();
    let orgId: string | null = null;
    let orgOutcome: 'existing' | 'created' | 'unlinked' = 'unlinked';

    const orgLookup = await query(
      `SELECT id FROM organisations
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND is_deleted = false
       LIMIT 2`,
      [orgName]
    );
    if (orgLookup.rows.length === 1) {
      orgId = orgLookup.rows[0].id;
      orgOutcome = 'existing';
    } else if (orgLookup.rows.length === 0) {
      const created = await query(
        `INSERT INTO organisations (name, type, notes, created_by)
         VALUES ($1, 'client', $2, $3) RETURNING id`,
        [orgName, 'Created from website enquiry form.', SYSTEM_USER_ID]
      );
      orgId = created.rows[0].id;
      orgOutcome = 'created';
    }
    // else: 2+ exact matches → orgId stays null (ambiguous), orgOutcome 'unlinked'

    // ── 3. Link person ↔ org (active role) if not already linked ────────────
    if (orgId) {
      const existingLink = await query(
        `SELECT id FROM person_organisation_roles
         WHERE person_id = $1 AND organisation_id = $2 AND status = 'active' LIMIT 1`,
        [personId, orgId]
      );
      if (existingLink.rows.length === 0) {
        await query(
          `INSERT INTO person_organisation_roles (person_id, organisation_id, role, status)
           VALUES ($1, $2, 'General Contact', 'active')`,
          [personId, orgId]
        );
      }
    }

    // ── 4. Dedup guard — same email in new_enquiry in the last 15 min ───────
    // Guards against double-submits / Worker retries without touching the form.
    const recent = await query(
      `SELECT j.id FROM jobs j
       JOIN job_contacts jc ON jc.job_id = j.id
       WHERE jc.person_id = $1
         AND j.pipeline_status = 'new_enquiry'
         AND j.enquiry_source = 'web_form'
         AND j.created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY j.created_at DESC LIMIT 1`,
      [personId]
    );
    if (recent.rows.length > 0) {
      const id = recent.rows[0].id;
      res.status(200).json({
        id, url: `${getFrontendUrl()}/jobs/${id}`,
        duplicate: true, person: personOutcome, org: orgOutcome,
      });
      return;
    }

    // ── 5. Map service types + build the enquiry ────────────────────────────
    const serviceTypes = Array.from(new Set(
      (payload.enquiry_types || [])
        .map(t => SERVICE_TYPE_MAP[t.trim().toLowerCase()])
        .filter((t): t is 'self_drive_van' | 'backline' | 'rehearsal' => Boolean(t))
    ));

    const job = await createPipelineEnquiry(
      {
        client_name: orgName,
        client_id: orgId,
        details: payload.enquiry?.trim() || null,
        notes: buildNotesBlock(payload),
        enquiry_source: 'web_form',
        likelihood: 'warm',
        job_date: payload.start_date || null,
        job_end: payload.end_date || null,
        start_time: payload.start_time || null,
        end_time: payload.end_time || null,
        service_types: serviceTypes.length ? serviceTypes : null,
        contact_person_ids: [personId],
        primary_contact_person_id: personId,
      },
      SYSTEM_USER_ID
    );

    const id = job.id as string;
    res.status(201).json({
      id,
      url: `${getFrontendUrl()}/jobs/${id}`,
      person: personOutcome,
      org: orgOutcome,
    });
  } catch (error) {
    if (error instanceof EnquiryValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[enquiry-intake] failed:', error);
    res.status(500).json({ error: 'Failed to create enquiry' });
  }
});

export default router;
