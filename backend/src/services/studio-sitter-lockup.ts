/**
 * Studio-sitter end-of-day lock-up report (Rehearsals module, Phase E).
 *
 * The "Finish for the night" report a sitter submits when they lock the building
 * up. Configurable (template in system_settings), soft (warnings not gates), no
 * PDF. Ported from the studio Jotform (form 203154178314046). See
 * docs/REHEARSALS-SPEC.md §4.
 *
 * Template model (flat + section + per-item reference — jon's call):
 *   - items are a flat list; each carries an optional `section` label so the
 *     form renders "Upstairs" / "Downstairs" group headers by grouping;
 *   - each item can carry an optional `reference` ("what it should look like":
 *     text + photos, expandable inline).
 *
 * Answers stored on studio_sitter_shifts.report_answers as:
 *   { answers: {id: value},
 *     exception_notes: {id: {text, photos:[blob]}},   // per off-expected item ("why?")
 *     notes: {text, photos:[blob]},
 *     continuing_tomorrow, continuing_overridden }
 * photos are interaction-attachment blobs ({r2_key, filename, content_type,...}).
 */

import { query, getClient } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { emailService } from './email-service';
import { getPresignedDownloadUrl } from '../config/r2';

// ── Template types ──────────────────────────────────────────────────────────

export type LockupItemType = 'yesno' | 'text' | 'number';

export interface LockupReference {
  text?: string;
  photos: string[];  // R2 keys OR external URLs
}
export interface LockupItem {
  id: string;
  label: string;
  type: LockupItemType;
  section?: string;              // optional group header ("Upstairs" / "Downstairs")
  expected?: string;             // the "all good" answer; off-expected is flagged
  end_of_booking_only?: boolean; // hidden when the studio's in use tomorrow
  reference?: LockupReference;   // expandable "what it should look like"
}
export interface LockupTemplate {
  version: number;
  intro?: string;
  items: LockupItem[];
  notes_label?: string;
  lost_property_prompt?: string;
}
export interface LockupReferencePhoto { label: string; url: string; }

// Uploaded photo blob (same shape as interaction attachments).
export interface UploadedPhoto {
  r2_key: string;
  filename: string;
  content_type: string;
  size_bytes?: number;
}

// Jotform reference images (public form-asset URLs) — seed defaults; jon curates.
const REF_ROOM_1 = 'https://www.jotform.com/uploads/jonwood/form_files/IMG_3638.65b7945e03a2e5.97895687.jpg';
const REF_ROOM_2 = 'https://www.jotform.com/uploads/jonwood/form_files/IMG_2315.64f9b25b0a0af6.19275184.jpg';
const REF_ROOM_3 = 'https://www.jotform.com/uploads/jonwood/form_files/IMG_3635.65b795cd3a8a08.69909573.jpg';

/**
 * Canonical lock-up template — ported from the studio Jotform. This is the code
 * fallback AND the source the migration seed is generated from (keep them in
 * sync; the DB row is authoritative once seeded). Name-of-staff + date fields
 * are dropped (we know the logged-in sitter + the shift date). The Jotform's two
 * notes boxes collapse to per-exception "why?" notes + the final notes field.
 */
export const DEFAULT_TEMPLATE: LockupTemplate = {
  version: 1,
  intro:
    "Quick walk round before you lock up. Flag anything that isn't right — we'd rather know tonight than find out tomorrow.",
  items: [
    // ── Upstairs ─────────────────────────────────────────────────────────
    { id: 'clients_out_on_time', section: 'Upstairs', label: 'Were the clients out on time? (if not, note how late & why below)', type: 'yesno', expected: 'yes' },
    { id: 'clients_paid', section: 'Upstairs', label: 'Have the clients paid? (if so, note how below and put the card receipt in the till)', type: 'yesno', expected: 'yes' },
    { id: 'pas_amps_powered_down', section: 'Upstairs', label: "PAs, amps, client equipment / pedals etc powered down", type: 'yesno', expected: 'yes' },
    { id: 'litter_cleared', section: 'Upstairs', label: 'Cups / glasses / plates cleared away, all litter collected and bin bag changed', type: 'yesno', expected: 'yes' },
    { id: 'crockery_washed', section: 'Upstairs', label: 'All cups / crockery washed or loaded into the downstairs dishwasher', type: 'yesno', expected: 'yes' },
    { id: 'kitchen_replenished', section: 'Upstairs', label: 'Studio kitchens replenished for the morning (cups, plates, cutlery, kitchen roll, tea, coffee — note below if milk etc needed)', type: 'yesno', expected: 'yes' },
    { id: 'toilets_stocked', section: 'Upstairs', label: 'Toilets clean, with soap and toilet paper', type: 'yesno', expected: 'yes' },
    { id: 'upstairs_double_door', section: 'Upstairs', label: 'Upstairs double door locked and bolted', type: 'yesno', expected: 'yes' },
    { id: 'kitchen_toilet_windows', section: 'Upstairs', label: 'Kitchen and toilet windows closed', type: 'yesno', expected: 'yes' },
    { id: 'ac_off', section: 'Upstairs', label: 'All AC turned off', type: 'yesno', expected: 'yes' },
    { id: 'room_lights_off', section: 'Upstairs', label: "Room lights + LEDs off", type: 'yesno', expected: 'yes' },
    { id: 'kitchen_hall_lights_off', section: 'Upstairs', label: 'Kitchen, toilet and hallway / stairs lights off', type: 'yesno', expected: 'yes' },
    { id: 'foyer_light_off', section: 'Upstairs', label: 'Foyer light off', type: 'yesno', expected: 'yes' },
    { id: 'side_fire_exit_closed', section: 'Upstairs', label: 'Side fire exit at the bottom of the stairs closed', type: 'yesno', expected: 'yes' },
    { id: 'rooms_vacuumed_bins', section: 'Upstairs', label: 'Rooms clean, vacuumed and bins emptied / new bin bag', type: 'yesno', expected: 'yes', end_of_booking_only: true },
    { id: 'hired_kit_boxed', section: 'Upstairs', label: "All studio-hired mics, cables, 4-ways, DIs etc coiled, taped and put away in the box", type: 'yesno', expected: 'yes', end_of_booking_only: true },
    {
      id: 'backline_stored', section: 'Upstairs',
      label: 'Ooosh backline packed away and stored (shelves in the upstairs kitchen, or by the double doors / downstairs if from the warehouse)',
      type: 'yesno', expected: 'yes', end_of_booking_only: true,
      reference: { text: 'When the booking has ended, the rooms should be reset and gear stored like this:', photos: [REF_ROOM_1, REF_ROOM_2, REF_ROOM_3] },
    },
    // ── Downstairs ───────────────────────────────────────────────────────
    { id: 'computer_stereo_off', section: 'Downstairs', label: 'Computer, stereo and printer turned off', type: 'yesno', expected: 'yes' },
    { id: 'dishwasher_on', section: 'Downstairs', label: 'Dishwasher loaded with cups / plates from upstairs and down, tablet in, switched on', type: 'yesno', expected: 'yes' },
    { id: 'front_desk_tidy', section: 'Downstairs', label: 'Front desk clear and tidy', type: 'yesno', expected: 'yes' },
    { id: 'lift_returned', section: 'Downstairs', label: 'Lift returned to ground level and switched off', type: 'yesno', expected: 'yes' },
    { id: 'stockroom_lights_off', section: 'Downstairs', label: 'Stockroom lights off', type: 'yesno', expected: 'yes' },
    { id: 'thermostat_down', section: 'Downstairs', label: 'Downstairs thermostat turned down to 10', type: 'yesno', expected: 'yes' },
    { id: 'rear_fire_exit', section: 'Downstairs', label: 'Rear fire exit door checked', type: 'yesno', expected: 'yes' },
    { id: 'outside_containers_locked', section: 'Downstairs', label: 'Outside containers closed and locked', type: 'yesno', expected: 'yes' },
    { id: 'cupboard_gates_locked', section: 'Downstairs', label: 'Outdoor cupboard and both gates locked', type: 'yesno', expected: 'yes' },
    { id: 'vans_locked', section: 'Downstairs', label: 'All vans locked, nothing left outside', type: 'yesno', expected: 'yes' },
    { id: 'van_keys_safe', section: 'Downstairs', label: 'All van keys in the safe and the safe locked', type: 'yesno', expected: 'yes' },
    { id: 'downstairs_lights_off', section: 'Downstairs', label: 'Downstairs lights off', type: 'yesno', expected: 'yes' },
    // Front door LAST — hard to honestly tick until everything else is done.
    { id: 'front_door_locked', section: 'Downstairs', label: 'Front door padlocked and locked, key placed in the outside key cupboard', type: 'yesno', expected: 'yes' },
  ],
  notes_label: 'Anything we need to know? Money owed, items taken, jobs for tomorrow, anything left undone.',
  lost_property_prompt: 'Found something a band left behind? Log it here so we can get it back to them.',
};

function isLockupItem(x: unknown): x is LockupItem {
  return (
    !!x && typeof x === 'object' &&
    typeof (x as any).id === 'string' &&
    typeof (x as any).label === 'string' &&
    ['yesno', 'text', 'number'].includes((x as any).type)
  );
}

function coerceReference(x: any): LockupReference | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const photos = Array.isArray(x.photos) ? x.photos.filter((p: any) => typeof p === 'string') : [];
  const text = typeof x.text === 'string' ? x.text : undefined;
  if (photos.length === 0 && !text) return undefined;
  return { text, photos };
}

/** Read + parse the lock-up template (falls back to DEFAULT_TEMPLATE). */
export async function getLockupTemplate(): Promise<LockupTemplate> {
  const raw = await getSystemSetting('studio_sitter_lockup_template');
  if (!raw) return DEFAULT_TEMPLATE;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || !parsed.items.every(isLockupItem)) {
      return DEFAULT_TEMPLATE;
    }
    return {
      version: Number(parsed.version) || 1,
      intro: typeof parsed.intro === 'string' ? parsed.intro : undefined,
      items: (parsed.items as any[]).map((it) => ({
        id: it.id, label: it.label, type: it.type,
        section: typeof it.section === 'string' ? it.section : undefined,
        expected: typeof it.expected === 'string' ? it.expected : undefined,
        end_of_booking_only: it.end_of_booking_only === true || undefined,
        reference: coerceReference(it.reference),
      })),
      notes_label: typeof parsed.notes_label === 'string' ? parsed.notes_label : undefined,
      lost_property_prompt: typeof parsed.lost_property_prompt === 'string' ? parsed.lost_property_prompt : undefined,
    };
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

export async function getLockupReferencePhotos(): Promise<LockupReferencePhoto[]> {
  const raw = await getSystemSetting('studio_sitter_lockup_reference_photos');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p: any) => p && typeof p.url === 'string')
      .map((p: any) => ({ label: String(p.label ?? ''), url: String(p.url) }));
  } catch {
    return [];
  }
}

// ── "Continuing tomorrow?" derivation ───────────────────────────────────────

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * True if the studio has ANY rehearsal session on `date` — a rehearsal job whose
 * derived [first_session_date, last_session_date] window spans it (daytime OR
 * evening). Excludes lost/cancelled + internal, includes speculative.
 */
export async function isStudioInUseOn(date: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM jobs
     WHERE is_deleted = false
       AND pipeline_status NOT IN ('lost','cancelled')
       AND COALESCE(is_internal, false) = false
       AND hh_derived_flags->'rehearsal_detail'->'rooms' IS NOT NULL
       AND jsonb_array_length(hh_derived_flags->'rehearsal_detail'->'rooms') > 0
       AND (hh_derived_flags->'rehearsal_detail'->>'first_session_date') <= $1
       AND (hh_derived_flags->'rehearsal_detail'->>'last_session_date') >= $1
     LIMIT 1`,
    [date]
  );
  return r.rows.length > 0;
}

export async function deriveContinuingTomorrow(date: string): Promise<boolean> {
  return isStudioInUseOn(addDaysIso(date, 1));
}

// ── Exceptions (off-expected answers) ───────────────────────────────────────

export interface LockupException {
  id: string;
  label: string;
  answer: string;
  expected: string;
}

/** Items answered off-expected, respecting the end-of-booking gate. */
export function computeExceptions(
  template: LockupTemplate,
  answers: Record<string, unknown>,
  continuingTomorrow: boolean,
): LockupException[] {
  const out: LockupException[] = [];
  for (const item of template.items) {
    if (item.expected === undefined) continue;
    if (item.end_of_booking_only && continuingTomorrow) continue; // not asked tonight
    const raw = answers[item.id];
    if (raw === undefined || raw === null || raw === '') continue; // unanswered ≠ exception
    const answer = String(raw).trim().toLowerCase();
    if (answer === 'na' || answer === 'n/a') continue;            // not-applicable ≠ exception
    if (answer !== String(item.expected).trim().toLowerCase()) {
      out.push({ id: item.id, label: item.label, answer: String(raw), expected: item.expected });
    }
  }
  return out;
}

// ── Shift lookup ────────────────────────────────────────────────────────────

interface ShiftRow {
  id: string;
  status: string;
  report_answers: any | null;
  report_submitted_at: string | null;
}

async function loadOpenShift(date: string): Promise<ShiftRow | null> {
  const r = await query(
    `SELECT id, status, report_answers, report_submitted_at
     FROM studio_sitter_shifts
     WHERE shift_date = $1 AND status <> 'cancelled'
     LIMIT 1`,
    [date]
  );
  return r.rows[0] ?? null;
}

// ── Portal context (GET) ────────────────────────────────────────────────────

export interface StoredReport {
  answers: Record<string, unknown>;
  exception_notes: Record<string, { text: string; photos: UploadedPhoto[] }>;
  notes: { text: string; photos: UploadedPhoto[] };
  continuing_tomorrow: boolean;
  continuing_overridden: boolean;
}

export interface LockupContext {
  date: string;
  template: LockupTemplate;
  continuing_tomorrow: boolean;   // derived (or the submitted value if already done)
  continuing_derived: boolean;    // what the schedule says, before any override
  submitted: (StoredReport & { submitted_at: string }) | null;
  has_shift: boolean;
}

function normaliseStored(raw: any, derived: boolean): StoredReport {
  return {
    answers: raw?.answers ?? {},
    exception_notes: raw?.exception_notes ?? {},
    notes: {
      text: String(raw?.notes?.text ?? (typeof raw?.notes === 'string' ? raw.notes : '')),
      photos: Array.isArray(raw?.notes?.photos) ? raw.notes.photos : [],
    },
    continuing_tomorrow: raw?.continuing_tomorrow ?? derived,
    continuing_overridden: raw?.continuing_overridden ?? false,
  };
}

/** Presign any per-item reference photos stored as R2 keys (external URLs pass
 *  through) so the portal can render them. Mutates a copy of the template. */
async function presignReferencePhotos(template: LockupTemplate): Promise<LockupTemplate> {
  const items = await Promise.all(template.items.map(async (it) => {
    if (!it.reference?.photos?.length) return it;
    const photos = await Promise.all(it.reference.photos.map(async (p) => {
      if (typeof p === 'string' && p.startsWith('files/')) {
        try { return await getPresignedDownloadUrl(p); } catch { return p; }
      }
      return p;
    }));
    return { ...it, reference: { ...it.reference, photos } };
  }));
  return { ...template, items };
}

/** Everything the portal lock-up sub-page needs on load. */
export async function getLockupContext(date: string): Promise<LockupContext> {
  const [rawTemplate, derived, shift] = await Promise.all([
    getLockupTemplate(),
    deriveContinuingTomorrow(date),
    loadOpenShift(date),
  ]);
  const template = await presignReferencePhotos(rawTemplate);

  const stored: StoredReport | null =
    shift?.report_submitted_at && shift.report_answers ? normaliseStored(shift.report_answers, derived) : null;

  return {
    date,
    template,
    continuing_tomorrow: stored ? stored.continuing_tomorrow : derived,
    continuing_derived: derived,
    submitted: stored ? { ...stored, submitted_at: shift!.report_submitted_at! } : null,
    has_shift: !!shift,
  };
}

// ── Submit (POST) ───────────────────────────────────────────────────────────

export interface SubmitLockupInput {
  answers: Record<string, string>;
  exception_notes: Record<string, { text: string; photos: UploadedPhoto[] }>;
  notes: { text: string; photos: UploadedPhoto[] };
  continuing_tomorrow: boolean;
}

export interface SubmitLockupResult {
  ok: boolean;
  shift_id: string;
  exceptions: LockupException[];
}

/**
 * Submit the lock-up report for one evening. Stores answers + per-exception
 * "why?" notes/photos + final notes/photos, closes the shift, and posts a
 * summary (with all photos attached) into the handover thread — replyable, the
 * Jotform-dead-end fix. Fires a staff bell + email. Re-submit overwrites.
 */
export async function submitLockupReport(
  date: string,
  sitterPersonId: string,
  sitterName: string,
  input: SubmitLockupInput,
): Promise<SubmitLockupResult> {
  const template = await getLockupTemplate();
  const derived = await deriveContinuingTomorrow(date);
  const continuing = !!input.continuing_tomorrow;
  const overridden = continuing !== derived;
  const notesText = String(input.notes?.text ?? '').trim().slice(0, 4000);
  const exceptions = computeExceptions(template, input.answers ?? {}, continuing);

  // Keep exception_notes only for items that are actually exceptions this run.
  const exceptionIds = new Set(exceptions.map((e) => e.id));
  const exception_notes: Record<string, { text: string; photos: UploadedPhoto[] }> = {};
  for (const [id, v] of Object.entries(input.exception_notes ?? {})) {
    if (!exceptionIds.has(id)) continue;
    exception_notes[id] = { text: String(v?.text ?? '').trim().slice(0, 2000), photos: v?.photos ?? [] };
  }
  const notes = { text: notesText, photos: input.notes?.photos ?? [] };

  const payload = { answers: input.answers ?? {}, exception_notes, notes, continuing_tomorrow: continuing, continuing_overridden: overridden };

  // All photos (why + notes) attach to the single thread summary message.
  const allPhotos: UploadedPhoto[] = [
    ...Object.values(exception_notes).flatMap((v) => v.photos),
    ...notes.photos,
  ];

  const client = await getClient();
  let shiftId: string;
  try {
    await client.query('BEGIN');
    const shiftRes = await client.query(
      `SELECT id FROM studio_sitter_shifts WHERE shift_date = $1 AND status <> 'cancelled' LIMIT 1 FOR UPDATE`,
      [date]
    );
    if (shiftRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('No shift for this evening');
    }
    shiftId = shiftRes.rows[0].id;

    await client.query(
      `UPDATE studio_sitter_shifts
       SET report_answers = $1::jsonb, report_template_version = $2,
           report_submitted_by = $3, report_submitted_at = NOW(),
           status = 'closed', updated_at = NOW()
       WHERE id = $4`,
      [JSON.stringify(payload), template.version, sitterPersonId, shiftId]
    );

    // Build the thread summary (exceptions + their whys + the general notes).
    const lines: string[] = [];
    if (exceptions.length > 0) {
      lines.push(`🔒 Lock-up submitted — ${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} need attention:`);
      for (const e of exceptions) {
        const why = exception_notes[e.id]?.text;
        lines.push(`• ${e.label}: ${e.answer}${why ? ` — ${why}` : ''}`);
      }
    } else {
      lines.push('🔒 Lock-up submitted — all clear.');
    }
    if (notesText) { lines.push(''); lines.push(notesText); }

    await client.query(
      `INSERT INTO interactions (type, content, shift_id, created_by, author_name, files)
       VALUES ('note', $1, $2, NULL, $3, $4::jsonb)`,
      [lines.join('\n'), shiftId, sitterName, JSON.stringify(allPhotos)]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  notifyStaffOfLockup(date, shiftId, sitterName, exceptions, notesText).catch((err) =>
    console.error('[studio-lockup] staff notify failed (non-fatal):', err)
  );

  return { ok: true, shift_id: shiftId, exceptions };
}

/** Bell to admins/managers + email to info@ that a lock-up landed. */
async function notifyStaffOfLockup(
  date: string, shiftId: string, sitterName: string,
  exceptions: LockupException[], notes: string,
): Promise<void> {
  const flagged = exceptions.length > 0;
  const title = flagged
    ? `🔒 Lock-up — ${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} need attention (${sitterName})`
    : `🔒 Lock-up submitted — all clear (${sitterName})`;
  const content = [...exceptions.map((e) => `• ${e.label}: ${e.answer}`), ...(notes ? [notes] : [])]
    .join('\n').slice(0, 400) || 'No issues flagged.';

  try {
    const staff = await query(
      `SELECT id FROM users WHERE is_active = true AND role IN ('admin','manager','weekend_manager')`
    );
    for (const row of staff.rows) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, email_sent_at)
         VALUES ($1, 'system', $2, $3, 'studio_sitter_shifts', $4, '/studio-sitters', $5, NOW())`,
        [row.id, title, content, shiftId, flagged ? 'high' : 'low']
      );
    }
  } catch (err) {
    console.error('[studio-lockup] bell insert failed:', err);
  }

  try {
    await emailService.send('studio_lockup_submitted', {
      to: 'info@oooshtours.co.uk',
      variables: {
        sitterName,
        date: formatLongDate(date),
        statusLine: flagged
          ? `${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} flagged for attention`
          : 'All clear — nothing flagged',
        exceptionsText: exceptions.map((e) => `${e.label}: ${e.answer}`).join('\n'),
        notes: notes || '',
        rosterUrl: 'https://staff.oooshtours.co.uk/studio-sitters',
      },
    });
  } catch (err) {
    console.error('[studio-lockup] email send failed:', err);
  }
}

// ── Staff reply → email the sitter (so the thread isn't a dead-end) ──────────

/**
 * When a staff user replies on a shift handover thread, email the sitter rostered
 * to that evening (freelancers have no portal bell). Best-effort; a lookup miss
 * or send failure never blocks the reply. Skips if the replying staffer IS the
 * sitter (shared account) or the sitter has no email.
 */
export async function notifySitterOfStaffReply(
  shiftId: string, replyText: string, staffUserId: string,
): Promise<void> {
  const r = await query(
    `SELECT s.shift_date::text AS shift_date, p.first_name, p.email
     FROM studio_sitter_shifts s
     JOIN studio_sitter_shift_assignments a ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
     JOIN people p ON p.id = a.person_id
     WHERE s.id = $1 LIMIT 1`,
    [shiftId]
  );
  const row = r.rows[0];
  if (!row?.email) return;

  const sr = await query(
    `SELECT CONCAT(p.first_name, ' ', p.last_name) AS staff_name
     FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
    [staffUserId]
  );
  const staffName = String(sr.rows[0]?.staff_name || '').trim() || 'The Ooosh office';
  const dateIso = String(row.shift_date).slice(0, 10);

  await emailService.send('studio_shift_reply', {
    to: row.email,
    variables: {
      sitterFirstName: row.first_name || 'there',
      staffName,
      date: formatLongDate(dateIso),
      replyText: replyText.length > 1200 ? replyText.slice(0, 1200) + '…' : replyText,
      shiftUrl: `https://hireforms.oooshtours.co.uk/shift/${dateIso}`,
    },
  });
}

// ── Lost property → Holding module ──────────────────────────────────────────

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Log a lost-property item a sitter found, into the Holding module (kind =
 * lost_property). Owner unknown by default (staff link the client later); the
 * night's date + any band note go in for context. Returns the new held_item id.
 */
export async function logShiftLostProperty(
  date: string, sitterName: string,
  input: { description: string; found_location?: string; photos: UploadedPhoto[] },
): Promise<string> {
  const description = String(input.description || '').trim().slice(0, 500) || 'Lost property (details TBC)';
  const foundLocation = input.found_location ? String(input.found_location).trim().slice(0, 200) : null;
  const files = (input.photos || []).map((p) => ({
    r2_key: p.r2_key, filename: p.filename, content_type: p.content_type,
    size_bytes: p.size_bytes ?? null, uploaded_at: new Date().toISOString(),
  }));
  const res = await query(
    `INSERT INTO held_items (kind, status, owner_unknown, description, found_date, found_location_text, files, created_by, notes)
     VALUES ('lost_property', 'stored', true, $1, $2::date, $3, $4::jsonb, $5, $6)
     RETURNING id`,
    [description, date, foundLocation, JSON.stringify(files), SYSTEM_USER_ID,
     `Logged by studio sitter ${sitterName} during lock-up on ${date}.`]
  );
  return res.rows[0].id;
}

// ── Staff read-back ─────────────────────────────────────────────────────────

export interface ReadPhoto { url: string; filename: string; content_type: string | null; }
export interface ShiftReport {
  date: string;
  submitted: boolean;
  submitted_at: string | null;
  submitted_by_name: string | null;
  template: LockupTemplate;
  answers: Record<string, unknown>;
  exception_notes: Record<string, { text: string; photos: ReadPhoto[] }>;
  notes: { text: string; photos: ReadPhoto[] };
  continuing_tomorrow: boolean;
  exceptions: LockupException[];
}

/** Presign stored photo blobs for a staff read view (R2 keys → time-limited URLs). */
async function presignPhotos(photos: UploadedPhoto[] | undefined): Promise<ReadPhoto[]> {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  return Promise.all(photos.map(async (p) => {
    let url = p.r2_key;
    if (typeof p.r2_key === 'string' && p.r2_key.startsWith('files/')) {
      try { url = await getPresignedDownloadUrl(p.r2_key); } catch { /* keep raw */ }
    }
    return { url, filename: p.filename, content_type: p.content_type ?? null };
  }));
}

/** Full read-only report for the staff roster / Job Detail view. */
export async function getShiftReport(date: string): Promise<ShiftReport> {
  const template = await getLockupTemplate();
  const r = await query(
    `SELECT s.report_answers, s.report_submitted_at,
            CONCAT(p.first_name, ' ', p.last_name) AS submitter_name
     FROM studio_sitter_shifts s
     LEFT JOIN people p ON p.id = s.report_submitted_by
     WHERE s.shift_date = $1 AND s.status <> 'cancelled'
     LIMIT 1`,
    [date]
  );
  const row = r.rows[0];
  if (!row || !row.report_submitted_at || !row.report_answers) {
    return {
      date, submitted: false, submitted_at: null, submitted_by_name: null, template,
      answers: {}, exception_notes: {}, notes: { text: '', photos: [] }, continuing_tomorrow: false, exceptions: [],
    };
  }
  const stored = normaliseStored(row.report_answers, false);
  // Presign photos for read.
  const exception_notes: Record<string, { text: string; photos: ReadPhoto[] }> = {};
  for (const [id, v] of Object.entries(stored.exception_notes)) {
    exception_notes[id] = { text: v.text, photos: await presignPhotos(v.photos) };
  }
  const notes = { text: stored.notes.text, photos: await presignPhotos(stored.notes.photos) };
  return {
    date,
    submitted: true,
    submitted_at: row.report_submitted_at,
    submitted_by_name: String(row.submitter_name || '').trim() || null,
    template,
    answers: stored.answers,
    exception_notes,
    notes,
    continuing_tomorrow: stored.continuing_tomorrow,
    exceptions: computeExceptions(template, stored.answers, stored.continuing_tomorrow),
  };
}

// ── small helpers ───────────────────────────────────────────────────────────

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]}`;
}
