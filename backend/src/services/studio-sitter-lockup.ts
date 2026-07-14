/**
 * Studio-sitter end-of-day lock-up report (Rehearsals module, Phase E).
 *
 * The "Finish for the night" report a sitter submits when they lock the building
 * up. Configurable (template in system_settings), soft (warnings not gates), no
 * PDF. See docs/REHEARSALS-SPEC.md §4.
 *
 * Responsibilities:
 *   - read + parse the template / reference photos (system_settings, with a
 *     hardcoded fallback so the portal never breaks if the row is missing);
 *   - DERIVE "continuing tomorrow?" from the site's rehearsal schedule (a session
 *     at the studio the next day) — pre-filled + overridable, gates the
 *     end-of-booking deep-clean items;
 *   - submit: store answers, close the shift, post the free-text note into the
 *     shift handover thread (replyable), fire staff bell + email;
 *   - staff read-back: full answers + exceptions (off-expected) for the roster /
 *     Job Detail read-only view.
 */

import { query, getClient } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { emailService } from './email-service';

// ── Template types ──────────────────────────────────────────────────────────

export type LockupItemType = 'yesno' | 'text' | 'number';

export interface LockupItem {
  id: string;
  label: string;
  type: LockupItemType;
  /** The answer that means "all good". An off-expected answer is flagged. */
  expected?: string;
  /** Only asked / flagged when the studio is NOT in use the next day. */
  end_of_booking_only?: boolean;
}

export interface LockupTemplate {
  version: number;
  intro?: string;
  items: LockupItem[];
  notes_label?: string;
  lost_property_prompt?: string;
}

export interface LockupReferencePhoto {
  label: string;
  url: string;
}

// Hardcoded fallback — mirrors the migration-168 seed so the portal never breaks
// if the system_settings row is missing/corrupt. The DB row is authoritative.
const DEFAULT_TEMPLATE: LockupTemplate = {
  version: 1,
  intro:
    "Quick walk round before you lock up. Flag anything that isn't right — we'd rather know tonight than find out tomorrow.",
  items: [
    { id: 'rooms_tidy', label: 'Rehearsal rooms tidied and reset', type: 'yesno', expected: 'yes' },
    { id: 'our_gear_back', label: 'All Ooosh gear back in its place / nothing left out', type: 'yesno', expected: 'yes' },
    { id: 'heating_off', label: 'Heating / aircon / fans turned off', type: 'yesno', expected: 'yes' },
    { id: 'lights_off', label: 'Lights off in all rooms and common areas', type: 'yesno', expected: 'yes' },
    { id: 'taps_off', label: 'Taps off, no water left running', type: 'yesno', expected: 'yes' },
    { id: 'windows_closed', label: 'All windows closed and latched', type: 'yesno', expected: 'yes' },
    { id: 'back_doors_locked', label: 'Fire exits / back doors closed and bolted', type: 'yesno', expected: 'yes' },
    { id: 'front_door_locked', label: 'Front door locked', type: 'yesno', expected: 'yes' },
    { id: 'alarm_set', label: 'Alarm set', type: 'yesno', expected: 'yes' },
    { id: 'bins_out', label: 'Bins taken out / emptied', type: 'yesno', expected: 'yes', end_of_booking_only: true },
    { id: 'kitchen_clean', label: 'Kitchen / common areas cleaned down', type: 'yesno', expected: 'yes', end_of_booking_only: true },
    { id: 'nothing_left_by_band', label: 'Nothing left behind by the band (check for lost property)', type: 'yesno', expected: 'yes' },
  ],
  notes_label: 'Anything we need to know? Money owed, items taken, jobs for tomorrow, anything left undone.',
  lost_property_prompt: 'Found something a band left behind? Log it in Holding so we can get it back to them.',
};

function isLockupItem(x: unknown): x is LockupItem {
  return (
    !!x && typeof x === 'object' &&
    typeof (x as any).id === 'string' &&
    typeof (x as any).label === 'string' &&
    ['yesno', 'text', 'number'].includes((x as any).type)
  );
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
      items: parsed.items as LockupItem[],
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
 * evening; a room in use at all means don't deep-clean). Excludes lost/cancelled
 * + internal, includes speculative (a still-provisional booking tomorrow still
 * means the room's in use).
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

/** DERIVED default for the "continuing tomorrow?" question (overridable). */
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
  report_template_version: number | null;
  report_submitted_at: string | null;
  report_submitted_by: string | null;
}

async function loadOpenShift(date: string): Promise<ShiftRow | null> {
  const r = await query(
    `SELECT id, status, report_answers, report_template_version,
            report_submitted_at, report_submitted_by
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
  notes: string;
  continuing_tomorrow: boolean;
  continuing_overridden: boolean;
}

export interface LockupContext {
  date: string;
  template: LockupTemplate;
  reference_photos: LockupReferencePhoto[];
  continuing_tomorrow: boolean;   // derived (or the submitted value if already done)
  continuing_derived: boolean;    // what the schedule says, before any override
  submitted: (StoredReport & { submitted_at: string }) | null;
  has_shift: boolean;
}

/** Everything the portal lock-up sub-page needs on load. */
export async function getLockupContext(date: string): Promise<LockupContext> {
  const [template, reference_photos, derived, shift] = await Promise.all([
    getLockupTemplate(),
    getLockupReferencePhotos(),
    deriveContinuingTomorrow(date),
    loadOpenShift(date),
  ]);

  const stored: StoredReport | null =
    shift?.report_submitted_at && shift.report_answers
      ? {
          answers: shift.report_answers.answers ?? {},
          notes: String(shift.report_answers.notes ?? ''),
          continuing_tomorrow: shift.report_answers.continuing_tomorrow ?? derived,
          continuing_overridden: shift.report_answers.continuing_overridden ?? false,
        }
      : null;

  return {
    date,
    template,
    reference_photos,
    continuing_tomorrow: stored ? stored.continuing_tomorrow : derived,
    continuing_derived: derived,
    submitted: stored ? { ...stored, submitted_at: shift!.report_submitted_at! } : null,
    has_shift: !!shift,
  };
}

// ── Submit (POST) ───────────────────────────────────────────────────────────

export interface SubmitLockupInput {
  answers: Record<string, unknown>;
  notes: string;
  continuing_tomorrow: boolean;
}

export interface SubmitLockupResult {
  ok: boolean;
  shift_id: string;
  exceptions: LockupException[];
}

/**
 * Submit the lock-up report for one evening. Stores the answers, closes the
 * shift, posts the free-text note into the handover thread (replyable — the
 * Jotform-dead-end fix), and fires a staff bell + email. Idempotent-ish: a
 * re-submit overwrites the stored answers (staff can ask a sitter to correct).
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
  const notes = String(input.notes ?? '').trim().slice(0, 4000);
  const exceptions = computeExceptions(template, input.answers ?? {}, continuing);

  const payload = {
    answers: input.answers ?? {},
    notes,
    continuing_tomorrow: continuing,
    continuing_overridden: overridden,
  };

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
       SET report_answers = $1::jsonb,
           report_template_version = $2,
           report_submitted_by = $3,
           report_submitted_at = NOW(),
           status = 'closed',
           updated_at = NOW()
       WHERE id = $4`,
      [JSON.stringify(payload), template.version, sitterPersonId, shiftId]
    );

    // Post the free-text note (+ an exceptions line) into the handover thread so
    // staff can REPLY. Only when there's something to say.
    const threadLines: string[] = [];
    if (exceptions.length > 0) {
      threadLines.push(`🔒 Lock-up submitted — ${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} need attention:`);
      for (const e of exceptions) threadLines.push(`• ${e.label}: ${e.answer}`);
    } else {
      threadLines.push('🔒 Lock-up submitted — all clear.');
    }
    if (notes) {
      threadLines.push('');
      threadLines.push(notes);
    }
    await client.query(
      `INSERT INTO interactions (type, content, shift_id, created_by, author_name)
       VALUES ('note', $1, $2, NULL, $3)`,
      [threadLines.join('\n'), shiftId, sitterName]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Staff bell + email (best-effort — never fail the submit).
  notifyStaffOfLockup(date, shiftId, sitterName, exceptions, notes).catch((err) =>
    console.error('[studio-lockup] staff notify failed (non-fatal):', err)
  );

  return { ok: true, shift_id: shiftId, exceptions };
}

/** Bell to admins/managers + email to info@ that a lock-up landed. */
async function notifyStaffOfLockup(
  date: string,
  shiftId: string,
  sitterName: string,
  exceptions: LockupException[],
  notes: string,
): Promise<void> {
  const flagged = exceptions.length > 0;
  const title = flagged
    ? `🔒 Lock-up — ${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} need attention (${sitterName})`
    : `🔒 Lock-up submitted — all clear (${sitterName})`;
  const summaryLines = [
    ...exceptions.map((e) => `• ${e.label}: ${e.answer}`),
    ...(notes ? [notes] : []),
  ];
  const content = summaryLines.join('\n').slice(0, 400) || 'No issues flagged.';

  // Bell — admins + managers (they watch studio sitters). email_sent_at set so
  // the escalator doesn't ALSO email them (we email info@ directly below).
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

  // Email — info@ (mirrors the OOH / money / vehicle internal-alert routing).
  try {
    await emailService.send('studio_lockup_submitted', {
      to: 'info@oooshtours.co.uk',
      variables: {
        // Values are HTML-escaped by the template substituter — pass plain text.
        sitterName,
        date: formatLongDate(date),
        statusLine: flagged
          ? `${exceptions.length} item${exceptions.length !== 1 ? 's' : ''} flagged for attention`
          : 'All clear — nothing flagged',
        // Newline-joined; rendered with white-space:pre-line in the template.
        exceptionsText: exceptions.map((e) => `${e.label}: ${e.answer}`).join('\n'),
        notes: notes || '',
        rosterUrl: 'https://staff.oooshtours.co.uk/studio-sitters',
      },
    });
  } catch (err) {
    console.error('[studio-lockup] email send failed:', err);
  }
}

// ── Staff read-back ─────────────────────────────────────────────────────────

export interface ShiftReport {
  date: string;
  submitted: boolean;
  submitted_at: string | null;
  submitted_by_name: string | null;
  template: LockupTemplate;
  answers: Record<string, unknown>;
  notes: string;
  continuing_tomorrow: boolean;
  exceptions: LockupException[];
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
      date, submitted: false, submitted_at: null, submitted_by_name: null,
      template, answers: {}, notes: '', continuing_tomorrow: false, exceptions: [],
    };
  }
  const answers = row.report_answers.answers ?? {};
  const continuing = row.report_answers.continuing_tomorrow ?? false;
  return {
    date,
    submitted: true,
    submitted_at: row.report_submitted_at,
    submitted_by_name: String(row.submitter_name || '').trim() || null,
    template,
    answers,
    notes: String(row.report_answers.notes ?? ''),
    continuing_tomorrow: continuing,
    exceptions: computeExceptions(template, answers, continuing),
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
