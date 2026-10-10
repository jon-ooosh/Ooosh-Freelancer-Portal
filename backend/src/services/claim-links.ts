/**
 * Possible-claim client links (docs/INCIDENT-CLAIMS-SPEC.md Phase 2).
 *
 * One tokenised link per recipient. The token is the credential and is kept
 * in the clear so a chase re-sends the SAME link (house convention). A link
 * works while its case is open / form_out and it hasn't been revoked.
 *
 * Privacy (spec D6/D7): a link only ever sees driver NAMES. A person proves
 * they were the driver with a 6-digit code emailed to the address on that
 * driver's record; only then do they get a short driver session and see their
 * own hire-form declaration answers.
 */
import crypto from 'crypto';
import { signFor, verifyFor } from './tokens';
import { query } from '../config/database';
import { uploadToR2 } from '../config/r2';
import { frontendLink } from '../config/app-urls';
import { logClaimEvent } from './incident-claims';
import { smsService, normaliseMsisdn } from './sms-service';
import { sanitiseDamageMarks, DamageMark } from './claim-form-fields';

export const OPEN_STAGES: ReadonlySet<string> = new Set(['open', 'form_out']);
const CODE_EXPIRY_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 30;
const DRIVER_SESSION_HOURS = 2;

export interface LinkRow {
  id: string;
  claim_id: string;
  token: string;
  recipient_name: string | null;
  recipient_email: string | null;
  driver_id: string | null;
  role: string;
  status: string;
  filled_as: string | null;
  filled_by_name: string | null;
  // joined from the case
  stage: string;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  job_id: string | null;
  hh_job_number: number | null;
}

/** The link + its case, or null for an unknown / revoked token or a deleted case. */
export async function resolveLink(token: string): Promise<LinkRow | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const r = await query(
    `SELECT l.id, l.claim_id, l.token, l.recipient_name, l.recipient_email, l.driver_id,
            l.role, l.status, l.filled_as, l.filled_by_name,
            c.stage, c.vehicle_id, c.vehicle_reg, c.job_id, c.hh_job_number
     FROM incident_claim_links l
     JOIN incident_claims c ON c.id = l.claim_id AND c.is_deleted = false
     WHERE l.token = $1 AND l.status <> 'revoked'`,
    [token],
  );
  return (r.rows[0] as LinkRow) || null;
}

/** "b***@example.com" — enough to recognise, not enough to harvest. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Drivers who could have been on this van on this hire — names + ids only. */
export async function driversOnVan(c: { vehicle_id: string | null; job_id: string | null; hh_job_number: number | null }) {
  if (!c.job_id && !c.hh_job_number) return [] as Array<{ id: string; name: string; email: string | null }>;
  const r = await query(
    `SELECT DISTINCT ON (d.id) d.id, d.full_name AS name, d.email
     FROM vehicle_hire_assignments vha
     JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.status <> 'cancelled'
       AND ($1::uuid IS NULL OR vha.vehicle_id = $1)
       AND ((vha.job_id IS NOT NULL AND vha.job_id = $2)
            OR (vha.job_id IS NULL AND $3::int IS NOT NULL AND vha.hirehop_job_id = $3))
     ORDER BY d.id`,
    [c.vehicle_id, c.job_id, c.hh_job_number],
  );
  return r.rows as Array<{ id: string; name: string; email: string | null }>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

/**
 * Create (or re-use) a link for one recipient and email it. An existing live
 * link to the same email on this case is re-sent rather than duplicated.
 */
export async function createAndSendLink(opts: {
  claimId: string;
  name: string | null;
  email: string;
  driverId?: string | null;
  personId?: string | null;
  role: 'driver' | 'contact' | 'forwarded';
  handedOffFrom?: string | null;
  createdBy: string | null;
  forwardedByName?: string | null;
}): Promise<{ linkId: string; reused: boolean; sent: boolean; error?: string }> {
  const email = opts.email.trim().toLowerCase();
  const existing = await query(
    `SELECT id, token FROM incident_claim_links
     WHERE claim_id = $1 AND lower(recipient_email) = $2 AND status NOT IN ('revoked')
     ORDER BY created_at DESC LIMIT 1`,
    [opts.claimId, email],
  );
  let linkId: string;
  let token: string;
  let reused = false;
  if (existing.rows[0]) {
    linkId = existing.rows[0].id;
    token = existing.rows[0].token;
    reused = true;
  } else {
    token = crypto.randomBytes(24).toString('base64url');
    const ins = await query(
      `INSERT INTO incident_claim_links
         (claim_id, token, recipient_name, recipient_email, driver_id, person_id, role, handed_off_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [opts.claimId, token, opts.name, email, opts.driverId ?? null, opts.personId ?? null, opts.role, opts.handedOffFrom ?? null, opts.createdBy],
    );
    linkId = ins.rows[0].id;
  }

  const sent = await sendLinkEmail(opts.claimId, token, email, opts.name, opts.forwardedByName ?? null);
  if (sent.success) {
    await query(`UPDATE incident_claim_links SET sent_at = NOW() WHERE id = $1`, [linkId]);
    // First send only (a resend is email-only): a text too, when we have their mobile (§21).
    if (!reused) {
      await sendLinkSms(opts.claimId, token, { driverId: opts.driverId ?? null, personId: opts.personId ?? null, name: opts.name }, 'claim_form_link');
    }
  }
  return { linkId, reused, sent: sent.success, error: sent.error };
}

/**
 * A link holder's mobile, as E.164: a driver's from their hire form, a contact's
 * from the address book (mobile, else international, else phone). Someone a
 * client forwarded the form to has only an email — null.
 */
export async function linkPhone(who: { driverId: string | null; personId: string | null }): Promise<string | null> {
  if (who.driverId) {
    const d = await query(`SELECT phone, phone_country FROM drivers WHERE id = $1`, [who.driverId]);
    return normaliseMsisdn(d.rows[0]?.phone, d.rows[0]?.phone_country)?.e164 || null;
  }
  if (who.personId) {
    const p = await query(`SELECT mobile, international_phone, phone FROM people WHERE id = $1`, [who.personId]);
    const r = p.rows[0];
    for (const n of [r?.mobile, r?.international_phone, r?.phone]) {
      const ok = normaliseMsisdn(n, null);
      if (ok) return ok.e164;
    }
  }
  return null;
}

/**
 * Text a link holder (best-effort: no number, SMS not set up, or a failed send
 * just means no text — the email has gone). Logged on the case timeline.
 */
export async function sendLinkSms(
  claimId: string,
  token: string,
  who: { driverId: string | null; personId: string | null; name: string | null },
  template: 'claim_form_link' | 'claim_form_reminder',
  extra: Record<string, string> = {},
): Promise<boolean> {
  try {
    if (!smsService.isConfigured()) return false;
    const to = await linkPhone(who);
    if (!to) return false;
    const c = await query(`SELECT vehicle_reg, hh_job_number FROM incident_claims WHERE id = $1`, [claimId]);
    const r = await smsService.send(template, {
      to,
      variables: {
        vehicleReg: c.rows[0]?.vehicle_reg || '',
        jobRef: c.rows[0]?.hh_job_number ? ` (#${c.rows[0].hh_job_number})` : '',
        formUrl: frontendLink(`/claim/${token}`),
        ...extra,
      },
    });
    if (r.success) {
      await logClaimEvent(claimId, null, 'sms_sent',
        `${template === 'claim_form_link' ? 'Form link' : 'Reminder'} texted to ${who.name || 'the recipient'}`);
    }
    return r.success;
  } catch (err) {
    console.error('[claim-links] SMS failed (non-fatal):', err);
    return false;
  }
}

export async function sendLinkEmail(
  claimId: string,
  token: string,
  email: string,
  name: string | null,
  forwardedByName: string | null,
): Promise<{ success: boolean; error?: string }> {
  const c = await query(`SELECT vehicle_reg, hh_job_number FROM incident_claims WHERE id = $1`, [claimId]);
  const reg = c.rows[0]?.vehicle_reg || 'our van';
  const hh = c.rows[0]?.hh_job_number;
  const url = frontendLink(`/claim/${token}`);
  const hi = name?.trim() ? name.trim().split(/\s+/)[0] : 'there';
  const { emailService } = await import('./email-service');
  const result = await emailService.sendRaw({
    to: email,
    subject: `Incident report — ${reg}${hh ? ` (#${hh})` : ''}`,
    variant: 'client',
    html: `
      <p>Hi ${escapeHtml(hi)},</p>
      ${forwardedByName ? `<p>${escapeHtml(forwardedByName)} has passed this on to you.</p>` : ''}
      <p>Thanks for letting us know about the incident involving our van <strong>${escapeHtml(reg)}</strong>${hh ? ` (job #${hh})` : ''}.
      Please fill in our incident form so we have everything we need.</p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background:#7B5EA7;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Open the incident form</a>
      </p>
      <p>You don't have to do it in one go — it saves as you go, and this same link brings you back to where you left off.
      If someone else is better placed to answer (the driver, say), you can pass it on from the form.</p>
      <p><strong>Please don't admit liability to anyone</strong>, and send us any letters you receive about the incident rather than replying to them.</p>
      <p>Thanks,<br>Ooosh! Tours</p>`,
  });
  return { success: result.success, error: result.success ? undefined : (result.error || 'Email failed') };
}

// ── Driver codes (spec D7) ──────────────────────────────────────────────────

function hashCode(linkId: string, code: string): string {
  return crypto.createHash('sha256').update(`${linkId}:${code}`).digest('hex');
}

export async function sendDriverCode(link: LinkRow, driverId: string): Promise<{ ok: boolean; status: number; error?: string; masked?: string }> {
  const drivers = await driversOnVan(link);
  const d = drivers.find((x) => x.id === driverId);
  if (!d) return { ok: false, status: 404, error: 'That driver is not on this van.' };
  if (!d.email) return { ok: false, status: 409, error: "We don't have an email for that driver — please call us and we'll help." };
  const recent = await query(
    `SELECT 1 FROM incident_claim_codes WHERE link_id = $1 AND created_at > NOW() - ($2 || ' seconds')::interval LIMIT 1`,
    [link.id, String(CODE_RESEND_SECONDS)],
  );
  if (recent.rows.length) return { ok: false, status: 429, error: 'A code was just sent — please wait a moment before asking for another.' };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await query(`UPDATE incident_claim_codes SET consumed_at = NOW() WHERE link_id = $1 AND consumed_at IS NULL`, [link.id]);
  await query(
    `INSERT INTO incident_claim_codes (link_id, driver_id, code_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
    [link.id, driverId, hashCode(link.id, code), String(CODE_EXPIRY_MINUTES)],
  );
  const { emailService } = await import('./email-service');
  const result = await emailService.sendRaw({
    to: d.email,
    subject: `Your code for the Ooosh incident form: ${code}`,
    variant: 'client',
    html: `
      <p>Hi ${escapeHtml(d.name.split(/\s+/)[0] || 'there')},</p>
      <p>Your code is</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${code}</p>
      <p>Enter it on the incident form to confirm you were driving. It expires in ${CODE_EXPIRY_MINUTES} minutes.</p>
      <p>If you didn't ask for this, you can ignore this email.</p>`,
  });
  if (!result.success) return { ok: false, status: 502, error: 'We could not send the code — please try again shortly.' };
  return { ok: true, status: 200, masked: maskEmail(d.email) };
}

export async function verifyDriverCode(link: LinkRow, driverId: string, code: string): Promise<{ ok: boolean; status: number; error?: string; session?: string }> {
  const r = await query(
    `SELECT id, driver_id, code_hash, attempts, expires_at FROM incident_claim_codes
     WHERE link_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [link.id],
  );
  const row = r.rows[0];
  if (!row || row.driver_id !== driverId || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 400, error: 'That code has expired — ask for a new one.' };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many tries — ask for a new code.' };
  const good = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(link.id, String(code).trim())));
  if (!good) {
    await query(`UPDATE incident_claim_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, status: 400, error: "That code doesn't match — check the email and try again." };
  }
  await query(`UPDATE incident_claim_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  const session = signFor(
    'claim_driver',
    { typ: 'claim_driver', link: link.id, claim: link.claim_id, driver: driverId },
    `${DRIVER_SESSION_HOURS}h`,
  );
  return { ok: true, status: 200, session };
}

/** The driver id a session proves for THIS link, or null. */
export function readDriverSession(link: LinkRow, header: string | undefined): string | null {
  if (!header) return null;
  const p = verifyFor<{ typ?: string; link?: string; claim?: string; driver?: string }>('claim_driver', header);
  if (!p || p.typ !== 'claim_driver' || p.link !== link.id || p.claim !== link.claim_id || !p.driver) return null;
  return p.driver;
}

// ── Damage marks + sketch (shared by the client form and the staff page) ────

export async function saveDamageMarks(
  claimId: string,
  rawMarks: unknown,
  pngBase64: string | null | undefined,
  actor: { userId: string | null; label: string },
): Promise<DamageMark[]> {
  const marks = sanitiseDamageMarks(rawMarks);
  let pngKey: string | null = null;
  if (pngBase64) {
    const png = Buffer.from(pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.length > 100 && png.length < 5_000_000 && png.subarray(1, 4).toString('ascii') === 'PNG') {
      pngKey = `claims/${claimId}/damage-marks-${Date.now()}.png`;
      await uploadToR2(pngKey, png, 'image/png');
    }
  }
  await query(
    `UPDATE incident_claims SET damage_marks = $2::jsonb,
            damage_marks_png_key = CASE WHEN $3::text IS NULL AND jsonb_array_length($2::jsonb) = 0 THEN NULL
                                        ELSE COALESCE($3::text, damage_marks_png_key) END,
            updated_at = NOW()
     WHERE id = $1`,
    [claimId, JSON.stringify(marks), pngKey],
  );
  await logClaimEvent(claimId, actor.userId, 'damage_marked', `${marks.length} damage mark${marks.length === 1 ? '' : 's'} saved (${actor.label})`);
  return marks;
}

export async function saveSketch(
  claimId: string,
  file: { buffer: Buffer; mimetype: string },
  actor: { userId: string | null; label: string },
): Promise<string> {
  const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
  const key = `claims/${claimId}/sketch-${Date.now()}.${ext}`;
  await uploadToR2(key, file.buffer, file.mimetype === 'image/png' ? 'image/png' : 'image/jpeg');
  await query(`UPDATE incident_claims SET sketch_key = $2, updated_at = NOW() WHERE id = $1`, [claimId, key]);
  await logClaimEvent(claimId, actor.userId, 'sketch_saved', `Sketch saved (${actor.label})`);
  return key;
}

/** Hire-form declaration answers for a driver, combined per spec §7.3. */
export async function hireFormDeclarations(driverId: string) {
  const dr = await query(
    `SELECT has_accidents, has_convictions, has_prosecution, has_disability, licence_points, licence_endorsements
     FROM drivers WHERE id = $1`,
    [driverId],
  );
  const x = dr.rows[0];
  if (!x) return null;
  const endorsements = Array.isArray(x.licence_endorsements) ? x.licence_endorsements : [];
  return {
    accidents: !!x.has_accidents,
    convictions: !!x.has_convictions || !!x.has_prosecution || Number(x.licence_points || 0) > 0 || endorsements.length > 0,
    disability: !!x.has_disability,
  };
}
